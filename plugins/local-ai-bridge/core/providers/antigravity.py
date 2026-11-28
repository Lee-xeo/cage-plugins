"""Native Antigravity CLI (`agy`) adapter using bidirectional `stream-json` over stdin/stdout."""

from __future__ import annotations

import getpass
import json
import os
import re
import stat
from pathlib import Path
from typing import Any

from ..security import resolve_cli_command, sanitize_diagnostic, write_private_temp_file
from .base import (
    AIProvider,
    ModelInfo,
    ProviderStatus,
    TaskHandle,
    TurnRequest,
    TurnResult,
    run_quick_command,
    spawn_cli,
    stream_process_lines,
)

_AGY_NPM_ENTRIES = (
    "node_modules/@google/antigravity-cli/bin/agy.js",
    "node_modules/antigravity-cli/bin/agy.js",
)

_AGY_EFFORTS = ["low", "medium", "high", "xhigh", "max"]

# Antigravity enforces Deny > Ask > Allow in its permission engine, overriding user local Allow rules.
# Note: this is a CLI policy deny-list (NOT an OS-level read-only filesystem sandbox); `agy` currently
# exposes no separate CLI flag to disable workspace customization discovery, `run_workflow`, or user-global
# hooks, so restricted modes pre-verify the full workspace-to-repository-root discovery chain and fail closed.
_AGY_READONLY_SETTINGS: dict[str, Any] = {
    "agentMode": "plan",
    "toolPermission": "request-review",
    "allowNonWorkspaceAccess": False,
    "permissions": {
        "deny": [
            "write_file(*)",
            "command(*)",
            "mcp(*)",
            "execute_url(*)",
            "download_url(*)",
            "read_url(*)",
        ]
    },
}

_AGY_WORKSPACE_WRITE_SETTINGS: dict[str, Any] = {
    "toolPermission": "request-review",
    "allowNonWorkspaceAccess": False,
    "permissions": {
        "deny": [
            "command(*)",
            "mcp(*)",
            "execute_url(*)",
            "download_url(*)",
        ]
    },
}

# Official Antigravity customization discovery folders and VCS repository boundary markers:
# https://antigravity.google/docs/customization-discovery?tab=cli#workspace-folders-and-parent-directories
_VCS_ROOT_MARKERS = (".git", ".hg", ".svn", ".jj", ".sl")
_CUSTOMIZATION_DOT_DIRS = (".agents", ".agent", "_agents", "_agent", ".gemini", ".antigravity")
_AUTOMATION_CONFIG_FILES = ("hooks.json", "mcp_config.json", "plugins.json")

AGY_DEFAULT_DESTINATION = (
    "Google Antigravity / Gemini / GCP service configured in host agy CLI (recipient not verified by plugin)"
)
AGY_FULL_DESTINATION = (
    "Determined by host agy CLI configuration and enabled MCP/web tools (recipient not verified by plugin)"
)


def _is_symlink_or_reparse(st: os.stat_result) -> bool:
    attrs = getattr(st, "st_file_attributes", 0)
    return stat.S_ISLNK(st.st_mode) or bool(attrs & 0x400)


def _format_scope_prefix(scan_dir: Path, workspace: Path) -> str:
    if scan_dir == workspace:
        return ""
    try:
        rel_up = workspace.relative_to(scan_dir)
        return "../" * len(rel_up.parts)
    except ValueError:
        return "<parent>/"


def _resolve_candidate_usernames(env: dict[str, str] | None = None) -> list[str]:
    names: list[str] = []
    sources = [env or {}, os.environ]
    for src in sources:
        for key in ("USER", "USERNAME"):
            val = str(src.get(key) or "").strip()
            if val and val not in names:
                names.append(val)
    try:
        os_user = getpass.getuser().strip()
        if os_user and os_user not in names:
            names.append(os_user)
    except Exception:
        pass
    return names


def _scan_customization_root(
    base_dir: Path,
    prefix: str,
    repo_root: Path,
    env: dict[str, str] | None,
    blocked: list[str],
    unverified: list[str],
    allow_personal_redirect: bool = True,
) -> None:
    for dot_name in _CUSTOMIZATION_DOT_DIRS:
        dot_dir = base_dir / dot_name
        try:
            dot_st = os.lstat(dot_dir)
        except FileNotFoundError:
            continue
        except OSError:
            unverified.append(f"{prefix}{dot_name} (unreadable)")
            continue

        if _is_symlink_or_reparse(dot_st):
            blocked.append(f"{prefix}{dot_name} (symlink)")
            continue
        if not stat.S_ISDIR(dot_st.st_mode):
            continue

        for cfg_name in _AUTOMATION_CONFIG_FILES:
            cfg_path = dot_dir / cfg_name
            try:
                os.lstat(cfg_path)
                blocked.append(f"{prefix}{dot_name}/{cfg_name}")
            except FileNotFoundError:
                pass
            except OSError:
                unverified.append(f"{prefix}{dot_name}/{cfg_name} (unreadable)")

        wf_dir = dot_dir / "workflows"
        try:
            wf_st = os.lstat(wf_dir)
            if _is_symlink_or_reparse(wf_st):
                blocked.append(f"{prefix}{dot_name}/workflows/ (symlink)")
            elif stat.S_ISDIR(wf_st.st_mode):
                if any(True for _ in wf_dir.iterdir()):
                    blocked.append(f"{prefix}{dot_name}/workflows/")
        except FileNotFoundError:
            pass
        except OSError:
            unverified.append(f"{prefix}{dot_name}/workflows/ (unreadable)")

        plugins_dir = dot_dir / "plugins"
        try:
            pl_st = os.lstat(plugins_dir)
            if _is_symlink_or_reparse(pl_st):
                blocked.append(f"{prefix}{dot_name}/plugins/ (symlink)")
            elif stat.S_ISDIR(pl_st.st_mode):
                children = sorted(plugins_dir.iterdir())
                for child in children:
                    child_label = f"{prefix}{dot_name}/plugins/{child.name}"
                    try:
                        ch_st = os.lstat(child)
                    except OSError:
                        unverified.append(f"{child_label} (unreadable)")
                        continue
                    if _is_symlink_or_reparse(ch_st):
                        blocked.append(f"{child_label} (symlink)")
                        continue
                    if not stat.S_ISDIR(ch_st.st_mode):
                        continue
                    matched_specific = False
                    for sub in ("hooks.json", "hooks/hooks.json", "mcp_config.json"):
                        cand = child / sub
                        try:
                            os.lstat(cand)
                            blocked.append(f"{child_label}/{sub}")
                            matched_specific = True
                        except FileNotFoundError:
                            pass
                        except OSError:
                            unverified.append(f"{child_label}/{sub} (unreadable)")
                            matched_specific = True
                    c_wf = child / "workflows"
                    try:
                        c_wf_st = os.lstat(c_wf)
                        if _is_symlink_or_reparse(c_wf_st) or (
                            stat.S_ISDIR(c_wf_st.st_mode) and any(True for _ in c_wf.iterdir())
                        ):
                            blocked.append(f"{child_label}/workflows/")
                            matched_specific = True
                    except FileNotFoundError:
                        pass
                    except OSError:
                        unverified.append(f"{child_label}/workflows/ (unreadable)")
                        matched_specific = True
                    if not matched_specific:
                        # Workspace plugins load enabled by default in `agy` and can bundle custom agents/MCP/hooks.
                        blocked.append(f"{child_label}/")
        except FileNotFoundError:
            pass
        except OSError:
            unverified.append(f"{prefix}{dot_name}/plugins/ (unreadable)")

        # Official personal_customization_dir redirect in `.gemini/config.json`
        if allow_personal_redirect and dot_name == ".gemini":
            gcfg_path = dot_dir / "config.json"
            try:
                g_st = os.lstat(gcfg_path)
            except FileNotFoundError:
                continue
            except OSError:
                unverified.append(f"{prefix}.gemini/config.json (unreadable)")
                continue

            if _is_symlink_or_reparse(g_st) or not stat.S_ISREG(g_st.st_mode) or g_st.st_size > 65536:
                unverified.append(f"{prefix}.gemini/config.json (unverified)")
                continue
            try:
                g_data = json.loads(gcfg_path.read_text(encoding="utf-8"))
            except Exception:
                unverified.append(f"{prefix}.gemini/config.json (invalid JSON)")
                continue
            if not isinstance(g_data, dict):
                unverified.append(f"{prefix}.gemini/config.json (invalid schema)")
                continue
            raw_pdir = g_data.get("personal_customization_dir")
            if raw_pdir is not None:
                if not isinstance(raw_pdir, str) or not raw_pdir.strip():
                    unverified.append(f"{prefix}.gemini/config.json#personal_customization_dir")
                    continue
                usernames = _resolve_candidate_usernames(env)
                if "{user}" in raw_pdir and not usernames:
                    unverified.append(f"{prefix}.gemini/config.json#personal_customization_dir (unknown user)")
                    continue
                expanded_list = (
                    [raw_pdir.replace("{user}", u) for u in usernames]
                    if "{user}" in raw_pdir
                    else [raw_pdir]
                )
                seen_targets: set[Path] = set()
                for expanded in expanded_list:
                    for anchor in (repo_root, base_dir):
                        cand_root = Path(expanded) if Path(expanded).is_absolute() else (anchor / expanded)
                        if cand_root in seen_targets:
                            continue
                        seen_targets.add(cand_root)
                        try:
                            p_st = os.lstat(cand_root)
                        except FileNotFoundError:
                            continue
                        except OSError:
                            unverified.append(f"{prefix}.gemini/config.json#personal_customization_dir (unreadable)")
                            continue
                        if _is_symlink_or_reparse(p_st):
                            blocked.append(f"{prefix}.gemini/config.json#personal_customization_dir (symlink)")
                            continue
                        if stat.S_ISDIR(p_st.st_mode):
                            _scan_customization_root(
                                cand_root,
                                f"{prefix}<personal>/",
                                repo_root,
                                env,
                                blocked,
                                unverified,
                                allow_personal_redirect=False,
                            )


def inspect_antigravity_workspace_automations(
    project_dir: str,
    env: dict[str, str] | None = None,
) -> tuple[list[str], list[str]]:
    """
    Inspect the full workspace-to-repository-root customization loading chain used by `agy`:
    - Walks from `project_dir` upward through every parent folder up to the repository root
      (`.git`, `.hg`, `.svn`, `.jj`, `.sl`). If not inside a repository, checks `project_dir`
      and fails closed if parent repository boundaries cannot be verified.
    - Checks `.agents/`, `.agent/`, `_agents/`, `_agent/`, `.gemini/`, `.antigravity/` for
      hooks, MCP configs, plugins/manifests, workflows, and `.gemini/config.json` personal redirects.
    Returns `(blocked_entries, unverified_entries)`.
    """
    if not project_dir:
        return [], ["active project directory is not set"]
    try:
        workspace = Path(project_dir).resolve(strict=True)
    except OSError:
        return [], ["active project directory cannot be resolved"]
    if not workspace.is_dir():
        return [], ["active project directory is not a directory"]

    chain: list[Path] = []
    cur = workspace
    while True:
        chain.append(cur)
        if cur.parent == cur:
            break
        cur = cur.parent

    outermost_repo_root: Path | None = None
    boundary_unverified: list[str] = []
    for anc in chain:
        found_at_level = False
        for marker in _VCS_ROOT_MARKERS:
            try:
                os.lstat(anc / marker)
                found_at_level = True
                break
            except FileNotFoundError:
                continue
            except OSError:
                if outermost_repo_root is None:
                    boundary_unverified.append("parent directory repository boundary could not be verified")
                break
        if found_at_level:
            outermost_repo_root = anc
        if boundary_unverified:
            break

    if boundary_unverified and outermost_repo_root is None:
        return [], boundary_unverified

    if outermost_repo_root is not None:
        stop_idx = chain.index(outermost_repo_root)
        scan_dirs = chain[: stop_idx + 1]
        effective_repo_root = outermost_repo_root
    else:
        scan_dirs = [workspace]
        effective_repo_root = workspace

    blocked: list[str] = []
    unverified: list[str] = []
    for scan_dir in scan_dirs:
        prefix = _format_scope_prefix(scan_dir, workspace)
        _scan_customization_root(
            scan_dir,
            prefix=prefix,
            repo_root=effective_repo_root,
            env=env,
            blocked=blocked,
            unverified=unverified,
        )
    # Deduplicate while preserving discovery order
    dedup_blocked = list(dict.fromkeys(blocked))
    dedup_unverified = list(dict.fromkeys(unverified))
    return dedup_blocked, dedup_unverified


def detect_project_hook_configs(
    project_dir: str,
    env: dict[str, str] | None = None,
) -> list[str]:
    """Return all blocked or unverified workspace/ancestor Antigravity automation entries."""
    blocked, unverified = inspect_antigravity_workspace_automations(project_dir, env=env)
    return [*blocked, *unverified]


def parse_agy_models_output(text: str) -> list[ModelInfo]:
    """Parse `agy models` tab-separated output (`<id>\t<Display Name>`)."""
    models: list[ModelInfo] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.lower().startswith("fetching"):
            continue
        if "\t" in line:
            mid, display = line.split("\t", 1)
            mid = mid.strip()
            display = display.strip() or mid
        else:
            parts = line.split(None, 1)
            mid = parts[0].strip()
            display = parts[1].strip() if len(parts) > 1 else mid
        if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$", mid):
            continue
        models.append(
            ModelInfo(
                id=mid,
                display_name=display,
                is_default=(len(models) == 0),
                efforts=list(_AGY_EFFORTS),
            )
        )
    return models


class AntigravityProvider(AIProvider):
    id = "antigravity"
    display_name = "Antigravity CLI (agy)"
    service_destination = AGY_DEFAULT_DESTINATION
    read_only_isolation = "policy-deny-best-effort"
    read_only_boundary = (
        "Best-effort CLI policy deny list (--settings denying write_file, command, mcp, *_url; "
        "allowNonWorkspaceAccess=false) plus pre-flight verification from the active folder up to the "
        "repository root (blocking workspace/parent hooks, MCP configs, plugins, workflows, and personal "
        "customization redirects, and stopping if the loading scope cannot be verified). "
        "NOT an OS-level read-only filesystem sandbox; agy still runs in the active project directory and "
        "has no separate CLI flag to disable run_workflow or user-global ~/.gemini hooks."
    )
    capabilities = ("read-only", "workspace-write", "full-access", "multi-turn", "model-discovery", "reasoning-effort")

    def describe_destination(
        self,
        mode: str = "read-only",
        env: dict[str, str] | None = None,
    ) -> str:
        if mode == "full-access":
            return AGY_FULL_DESTINATION
        return AGY_DEFAULT_DESTINATION

    def _resolve_cmd(self, bin_override: str | None = None, project_dir: str = "") -> list[str] | None:
        return resolve_cli_command(
            "agy",
            "AI_BRIDGE_AGY_BIN",
            policy_override=bin_override,
            npm_rel_entries=_AGY_NPM_ENTRIES,
            project_dir=project_dir,
        )

    def probe(
        self,
        bin_override: str | None = None,
        env: dict[str, str] | None = None,
        project_dir: str = "",
    ) -> ProviderStatus:
        cmd = self._resolve_cmd(bin_override, project_dir=project_dir)
        if not cmd:
            return ProviderStatus(
                available=False,
                error="Antigravity CLI (`agy`) not found (on Windows, point to agy.exe or its JS entry).",
            )
        code, out, err = run_quick_command([*cmd, "--version"], timeout=5.0, env=env)
        if code != 0:
            return ProviderStatus(
                available=False,
                binary_path=cmd[-1],
                error=sanitize_diagnostic((err or out or "Failed to query agy version.").strip()[:200], project_dir),
            )
        version = (out or err).strip().splitlines()[0] if (out or err).strip() else "unknown"
        # `agy` has no offline auth-check subcommand; report None (unverified) instead of assuming True.
        return ProviderStatus(
            available=True,
            authenticated=None,
            account_summary="Host Antigravity CLI (cached local login, unverified)",
            version=version,
            binary_path=cmd[-1],
        )

    def list_models(
        self,
        bin_override: str | None = None,
        env: dict[str, str] | None = None,
        project_dir: str = "",
    ) -> list[ModelInfo]:
        cmd = self._resolve_cmd(bin_override, project_dir=project_dir)
        if not cmd:
            raise RuntimeError("Antigravity CLI (`agy`) is not installed.")
        code, out, err = run_quick_command([*cmd, "models"], timeout=15.0, env=env)
        models = parse_agy_models_output(out)
        if code != 0 and not models:
            raise RuntimeError(
                sanitize_diagnostic((err or out or f"agy models exited with code {code}").strip()[:300], project_dir)
            )
        return models

    def _build_argv(
        self,
        cmd_prefix: list[str] | str,
        req: TurnRequest,
        settings_path: str | None = None,
    ) -> list[str]:
        prefix = [cmd_prefix] if isinstance(cmd_prefix, str) else list(cmd_prefix)
        argv = [
            *prefix,
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
        ]
        if req.mode == "full-access":
            argv.append("--dangerously-skip-permissions")
        elif req.mode == "workspace-write":
            argv.extend(["--mode", "accept-edits", "--disable-slash-commands"])
            if settings_path:
                argv.extend(["--settings", settings_path])
        else:
            argv.extend(["--mode", "plan", "--disable-slash-commands"])
            if settings_path:
                argv.extend(["--settings", settings_path])
        if req.model:
            argv.extend(["--model", req.model])
        if req.effort:
            argv.extend(["--effort", req.effort])
        if req.provider_session_id:
            argv.extend(["--conversation", req.provider_session_id])
        return argv

    def run_turn(self, req: TurnRequest, handle: TaskHandle) -> TurnResult:
        cmd = self._resolve_cmd(req.bin_override, project_dir=req.project_dir)
        if not cmd:
            return TurnResult(ok=False, error="Antigravity CLI (`agy`) is not installed on this computer.")

        # Refuse restricted runs when workspace or ancestor (up to repository root) customization
        # configs are present or cannot be verified, because `agy` walks parent folders up to the
        # repo root and exposes no CLI flag to disable workspace hooks, plugins, MCP, or workflows.
        if req.mode in ("read-only", "workspace-write"):
            blocked_entries, unverified_entries = inspect_antigravity_workspace_automations(
                req.project_dir,
                env=req.env,
            )
            if unverified_entries:
                listed_u = ", ".join(unverified_entries[:5])
                return TurnResult(
                    ok=False,
                    error=(
                        f"Stopping Antigravity {req.mode} task because workspace/parent customization scope "
                        f"could not be verified ({listed_u})."
                    ),
                )
            if blocked_entries:
                listed_b = ", ".join(blocked_entries[:5])
                return TurnResult(
                    ok=False,
                    error=(
                        f"Refusing to run Antigravity in {req.mode} mode because workspace or parent "
                        f"repository customization entries ({listed_b}) would be loaded by agy CLI and "
                        "cannot be disabled via CLI flags. Inspect/remove those entries or explicitly "
                        "unlock full-access mode."
                    ),
                )

        temp_settings_file: Path | None = None
        try:
            if req.mode == "read-only":
                temp_settings_file = write_private_temp_file(
                    json.dumps(_AGY_READONLY_SETTINGS, ensure_ascii=False),
                    prefix="agy-ro-",
                    suffix=".json",
                )
            elif req.mode == "workspace-write":
                temp_settings_file = write_private_temp_file(
                    json.dumps(_AGY_WORKSPACE_WRITE_SETTINGS, ensure_ascii=False),
                    prefix="agy-rw-",
                    suffix=".json",
                )

            argv = self._build_argv(
                cmd,
                req,
                settings_path=str(temp_settings_file) if temp_settings_file else None,
            )
            stdin_payload = json.dumps(
                {"event": "user", "message": {"content": req.prompt}},
                ensure_ascii=False,
            ) + "\n"

            handle.emit_activity("launching", "starting_antigravity", f"mode={req.mode}")
            try:
                proc = spawn_cli(argv, cwd=req.project_dir, env=req.env)
            except OSError as exc:
                return TurnResult(
                    ok=False,
                    error=sanitize_diagnostic(f"Could not start Antigravity CLI: {exc}", req.project_dir),
                )

            state: dict[str, Any] = {
                "conversation_id": req.provider_session_id,
                "chunks": [],
                "final_response": "",
                "result_status": "",
                "error": "",
                "usage": None,
            }

            def _on_line(raw: str) -> None:
                line = raw.strip()
                if not line or not line.startswith("{"):
                    return
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    return

                cid = ev.get("conversation_id")
                if isinstance(cid, str) and cid:
                    state["conversation_id"] = cid
                    handle.set_provider_session_id(cid)

                ev_name = ev.get("event")
                if ev_name == "init":
                    init_info = ev.get("init") or {}
                    model_used = init_info.get("model")
                    handle.emit_activity("init", "session_ready", str(model_used) if model_used else None)
                elif ev_name == "step_update":
                    su = ev.get("step_update") or {}
                    su_cid = su.get("conversation_id")
                    if isinstance(su_cid, str) and su_cid:
                        state["conversation_id"] = su_cid
                        handle.set_provider_session_id(su_cid)
                    step_type = str(su.get("step_type") or "step")
                    step_state = str(su.get("state") or "")
                    text_delta = su.get("text_delta")
                    if isinstance(text_delta, str) and text_delta:
                        state["chunks"].append(text_delta)
                        handle.append_delta(text_delta)
                    if isinstance(su.get("usage"), dict):
                        state["usage"] = su["usage"]
                    activity = "composing_answer" if step_type == "agent_response" else step_type
                    handle.emit_activity(f"{step_type}_{step_state.lower()}", activity)
                elif ev_name == "result":
                    res = ev.get("result") or {}
                    res_cid = res.get("conversation_id")
                    if isinstance(res_cid, str) and res_cid:
                        state["conversation_id"] = res_cid
                        handle.set_provider_session_id(res_cid)
                    status = str(res.get("status") or "").upper()
                    state["result_status"] = status
                    if isinstance(res.get("usage"), dict):
                        state["usage"] = res["usage"]
                    if isinstance(res.get("response"), str):
                        state["final_response"] = res["response"]
                    if status and status != "SUCCESS":
                        state["error"] = sanitize_diagnostic(
                            str(res.get("error") or f"Antigravity finished with status {status}."),
                            req.project_dir,
                        )
                    handle.emit_activity("result", "finishing", status or None)
                elif ev_name == "error":
                    state["error"] = sanitize_diagnostic(
                        str(ev.get("error") or ev.get("message") or "Antigravity CLI error."),
                        req.project_dir,
                    )

            code, stderr_tail, timed_out = stream_process_lines(
                proc,
                handle,
                on_stdout_line=_on_line,
                stdin_text=stdin_payload,
                timeout_seconds=req.timeout_seconds,
            )
        finally:
            if temp_settings_file:
                temp_settings_file.unlink(missing_ok=True)

        if handle.cancel_event.is_set():
            return TurnResult(
                ok=False,
                error="Task cancelled by user.",
                provider_session_id=state["conversation_id"],
            )
        if timed_out:
            return TurnResult(
                ok=False,
                error="Antigravity task timed out.",
                provider_session_id=state["conversation_id"],
            )

        answer = (state["final_response"] or "".join(state["chunks"])).strip()
        stderr_text = sanitize_diagnostic("".join(stderr_tail).strip(), req.project_dir)

        if state["error"]:
            return TurnResult(
                ok=False,
                answer=answer,
                error=state["error"],
                provider_session_id=state["conversation_id"],
                usage=state["usage"],
            )
        if code != 0:
            return TurnResult(
                ok=False,
                answer=answer,
                error=stderr_text[-600:] if stderr_text else f"Antigravity CLI exited with code {code}.",
                provider_session_id=state["conversation_id"],
                usage=state["usage"],
            )
        if state["result_status"] and state["result_status"] != "SUCCESS":
            return TurnResult(
                ok=False,
                answer=answer,
                error=f"Antigravity ended with status {state['result_status']}.",
                provider_session_id=state["conversation_id"],
                usage=state["usage"],
            )
        return TurnResult(
            ok=True,
            answer=answer or "(No text reply produced.)",
            provider_session_id=state["conversation_id"],
            usage=state["usage"],
        )
