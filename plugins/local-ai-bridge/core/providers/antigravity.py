"""Native Antigravity CLI (`agy`) adapter using bidirectional `stream-json` over stdin/stdout."""

from __future__ import annotations

import json
import re
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
# exposes no separate deny rule for `run_workflow` or user-global hooks, so we also pre-check project hooks.
_AGY_READONLY_SETTINGS: dict[str, Any] = {
    "toolPermission": "request-review",
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
    "permissions": {
        "deny": [
            "command(*)",
            "mcp(*)",
            "execute_url(*)",
            "download_url(*)",
        ]
    },
}

_PROJECT_HOOK_RELATIVE_PATHS = (
    ".agents/hooks.json",
    ".agent/hooks.json",
    ".gemini/hooks.json",
    ".antigravity/hooks.json",
)

_PROJECT_WORKFLOW_RELATIVE_DIRS = (
    ".agents/workflows",
    ".agent/workflows",
    ".gemini/workflows",
    ".antigravity/workflows",
)


def _dir_has_entries(path: Path) -> bool:
    if path.is_symlink():
        return True
    if not path.is_dir():
        return False
    try:
        return any(True for _ in path.iterdir())
    except OSError:
        return True


def detect_project_hook_configs(project_dir: str) -> list[str]:
    """
    Detect workspace-scoped Antigravity hook configs and workflow directories that `agy`
    cannot disable via CLI flags.
    """
    if not project_dir:
        return []
    base = Path(project_dir)
    found: list[str] = []
    for rel in _PROJECT_HOOK_RELATIVE_PATHS:
        cand = base / rel
        if cand.exists() or cand.is_symlink():
            found.append(rel)
    for rel in _PROJECT_WORKFLOW_RELATIVE_DIRS:
        cand = base / rel
        if _dir_has_entries(cand):
            found.append(f"{rel}/")
    plugins_dir = base / ".agents" / "plugins"
    if plugins_dir.is_dir():
        try:
            for child in sorted(plugins_dir.iterdir()):
                for sub in ("hooks.json", "hooks/hooks.json"):
                    cand = child / sub
                    if cand.exists() or cand.is_symlink():
                        found.append(f".agents/plugins/{child.name}/{sub}")
                wf_dir = child / "workflows"
                if _dir_has_entries(wf_dir):
                    found.append(f".agents/plugins/{child.name}/workflows/")
        except OSError:
            pass
    return found


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
    service_destination = "Google Antigravity service (via host agy CLI)"
    read_only_isolation = "policy-deny-best-effort"
    read_only_boundary = (
        "Best-effort CLI policy deny list (--settings denying write_file, command, mcp, *_url) "
        "plus pre-flight blocking of workspace hooks and workflows (.agents/hooks.json, .agents/workflows/). "
        "NOT an OS-level read-only filesystem sandbox; agy still runs in the active project directory and "
        "has no separate deny rule for run_workflow or user-global hooks/workflows."
    )
    capabilities = ("read-only", "workspace-write", "full-access", "multi-turn", "model-discovery", "reasoning-effort")

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
            argv.append("--disable-slash-commands")
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

        # Refuse restricted runs when workspace hook configs or workflow directories are present
        # because `agy` has no CLI flag to disable project lifecycle hooks or workspace workflows.
        if req.mode in ("read-only", "workspace-write"):
            hook_files = detect_project_hook_configs(req.project_dir)
            if hook_files:
                listed = ", ".join(hook_files[:5])
                return TurnResult(
                    ok=False,
                    error=(
                        f"Refusing to run Antigravity in {req.mode} mode because this project contains "
                        f"workspace hook/workflow entries ({listed}) that agy CLI cannot disable via flags. "
                        "Inspect/remove those project entries or explicitly unlock full-access mode."
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
