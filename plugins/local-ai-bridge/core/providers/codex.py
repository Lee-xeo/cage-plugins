"""Native Codex CLI adapter (`codex app-server --stdio` for models, `codex exec` for tasks)."""

from __future__ import annotations

import json
import os
import queue
import re
import sys
import threading
import time
from typing import Any

from ..security import resolve_cli_command, sanitize_diagnostic
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
    terminate_process_tree,
)

_CODEX_NPM_ENTRIES = ("node_modules/@openai/codex/bin/codex.js",)

_CODEX_ACTIVITIES = {
    "agent_message": "composing_answer",
    "reasoning": "reasoning",
    "command_execution": "running_command",
    "file_change": "editing_files",
    "mcp_tool_call": "calling_tool",
    "collab_tool_call": "consulting_agent",
    "web_search": "searching",
    "todo_list": "planning",
}


def _classify_codex_error(text: str) -> str:
    if not text:
        return ""
    if re.search(r"401 unauthorized|not logged in|authentication|required login|invalid api key", text, re.I):
        return "Codex authentication failed. Run `codex login` on the host machine."
    if re.search(r"rate limit|429|usage limit|quota exceeded", text, re.I):
        return "Codex reported a rate or usage limit."
    if re.search(r"model.{0,120}(?:not supported|not found|unavailable|does not exist)", text, re.I):
        return "The requested Codex model is unavailable for this account."
    if re.search(r"unrecognized (?:subcommand|argument)|unexpected argument", text, re.I):
        return "Installed Codex CLI version does not support one of the required flags."
    return ""


CODEX_READONLY_DESTINATION = "OpenAI Codex service (via host Codex CLI with --ignore-user-config)"
CODEX_UNVERIFIED_CONFIG_DESTINATION = (
    "Determined by host Codex CLI configuration (recipient not verified by plugin)"
)


class CodexProvider(AIProvider):
    id = "codex"
    display_name = "Codex CLI"
    service_destination = CODEX_READONLY_DESTINATION
    read_only_isolation = "os-sandbox"
    read_only_boundary = (
        "OS-level read-only sandbox (--sandbox read-only) with --ignore-user-config, "
        "--ignore-rules, untrusted project config override, disabled hooks/plugins/apps, "
        "and web_search disabled."
    )
    capabilities = ("read-only", "workspace-write", "full-access", "multi-turn", "model-discovery", "reasoning-effort")

    def describe_destination(
        self,
        mode: str = "read-only",
        env: dict[str, str] | None = None,
    ) -> str:
        # workspace-write and full-access omit --ignore-user-config so Codex loads the user's
        # config.toml (which may point to a corporate relay or non-OpenAI model_provider).
        if mode in ("workspace-write", "full-access"):
            return CODEX_UNVERIFIED_CONFIG_DESTINATION
        check_env = env if env is not None else os.environ
        if any(str(check_env.get(k) or "").strip() for k in ("OPENAI_BASE_URL", "OPENAI_API_BASE")):
            return CODEX_UNVERIFIED_CONFIG_DESTINATION
        return CODEX_READONLY_DESTINATION

    def _resolve_cmd(self, bin_override: str | None = None, project_dir: str = "") -> list[str] | None:
        return resolve_cli_command(
            "codex",
            "AI_BRIDGE_CODEX_BIN",
            policy_override=bin_override,
            npm_rel_entries=_CODEX_NPM_ENTRIES,
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
                error="Codex CLI not found (on Windows, point to codex.exe or its npm codex.js entry).",
            )
        code, out, err = run_quick_command([*cmd, "--version"], timeout=5.0, env=env)
        if code != 0:
            return ProviderStatus(
                available=False,
                binary_path=cmd[-1],
                error=sanitize_diagnostic((err or out or "Failed to query Codex version.").strip()[:200], project_dir),
            )
        version = (out or err).strip().splitlines()[0] if (out or err).strip() else "unknown"

        # Check real login status rather than assuming authenticated=True
        auth_state: bool | None = None
        account_summary: str | None = None
        auth_err: str | None = None
        l_code, l_out, l_err = run_quick_command([*cmd, "login", "status"], timeout=5.0, env=env)
        combined = f"{l_out}\n{l_err}".strip()
        if l_code == 0 and re.search(r"logged in", combined, re.I):
            auth_state = True
            if re.search(r"chatgpt", combined, re.I):
                account_summary = "Host Codex CLI (ChatGPT login)"
            elif re.search(r"api\s*key", combined, re.I):
                account_summary = "Host Codex CLI (API key)"
            else:
                account_summary = "Host Codex CLI (logged-in account)"
        elif re.search(r"not logged in|unauthorized|login required", combined, re.I):
            auth_state = False
            account_summary = "Not logged in"
            auth_err = "Codex CLI is not logged in. Run `codex login` on the host machine."

        return ProviderStatus(
            available=True,
            authenticated=auth_state,
            account_summary=account_summary,
            version=version,
            binary_path=cmd[-1],
            error=auth_err,
        )

    def list_models(
        self,
        bin_override: str | None = None,
        env: dict[str, str] | None = None,
        project_dir: str = "",
    ) -> list[ModelInfo]:
        cmd = self._resolve_cmd(bin_override, project_dir=project_dir)
        if not cmd:
            raise RuntimeError("Codex CLI is not installed.")
        proc = spawn_cli(
            [*cmd, "app-server", "--stdio", "--disable", "hooks", "--disable", "plugins", "--disable", "apps"],
            env=env,
        )
        line_q: queue.Queue[str | None] = queue.Queue()
        stderr_tail: list[str] = []

        def _drain_stderr() -> None:
            try:
                assert proc.stderr is not None
                for line in proc.stderr:
                    stderr_tail.append(line)
                    if len(stderr_tail) > 40:
                        del stderr_tail[:-40]
            except Exception:
                pass

        def _reader() -> None:
            try:
                assert proc.stdout is not None
                for line in proc.stdout:
                    line_q.put(line)
            except Exception:
                pass
            finally:
                line_q.put(None)

        t_err = threading.Thread(target=_drain_stderr, daemon=True)
        t_out = threading.Thread(target=_reader, daemon=True)
        t_err.start()
        t_out.start()

        def _send(obj: dict[str, Any]) -> None:
            assert proc.stdin is not None
            proc.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
            proc.stdin.flush()

        models: list[ModelInfo] = []
        preferred_model: str | None = None
        preferred_effort: str | None = None
        req_id = 1
        seen_cursors: set[str] = set()
        completed = False
        timed_out = False
        deadline = time.monotonic() + 15.0

        try:
            _send(
                {
                    "id": req_id,
                    "method": "initialize",
                    "params": {"clientInfo": {"name": "local-ai-bridge", "version": "0.1.0"}},
                }
            )
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    timed_out = True
                    break
                try:
                    raw = line_q.get(timeout=min(0.25, remaining))
                except queue.Empty:
                    continue
                if raw is None:
                    break
                raw = raw.strip()
                if not raw.startswith("{"):
                    continue
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if "method" in msg:
                    continue
                if msg.get("id") != req_id:
                    continue
                if msg.get("error"):
                    err_text = str(msg["error"].get("message") or msg["error"])
                    raise RuntimeError(
                        _classify_codex_error(err_text)
                        or sanitize_diagnostic(f"Codex model discovery error: {err_text}", project_dir)
                    )
                result = msg.get("result") or {}
                if req_id == 1:
                    _send({"method": "initialized"})
                    req_id += 1
                    _send({"id": req_id, "method": "config/read", "params": {}})
                elif req_id == 2:
                    cfg = result.get("config") or {}
                    preferred_model = cfg.get("model")
                    preferred_effort = cfg.get("model_reasoning_effort")
                    req_id += 1
                    _send({"id": req_id, "method": "model/list", "params": {"includeHidden": False}})
                else:
                    for item in result.get("data") or []:
                        if not isinstance(item, dict) or item.get("hidden"):
                            continue
                        mid = str(item.get("model") or item.get("id") or "").strip()
                        if not mid:
                            continue
                        efforts = [
                            str(e.get("reasoningEffort"))
                            for e in (item.get("supportedReasoningEfforts") or [])
                            if isinstance(e, dict) and e.get("reasoningEffort")
                        ]
                        models.append(
                            ModelInfo(
                                id=mid,
                                display_name=str(item.get("displayName") or mid),
                                is_default=bool(item.get("isDefault")),
                                efforts=efforts,
                                default_effort=item.get("defaultReasoningEffort"),
                            )
                        )
                    next_cursor = result.get("nextCursor")
                    if not next_cursor or next_cursor in seen_cursors:
                        completed = True
                        break
                    seen_cursors.add(str(next_cursor))
                    req_id += 1
                    _send(
                        {
                            "id": req_id,
                            "method": "model/list",
                            "params": {"cursor": next_cursor, "includeHidden": False},
                        }
                    )
        finally:
            terminate_process_tree(proc)
            t_err.join(timeout=1.0)

        if not completed:
            stderr_text = sanitize_diagnostic("".join(stderr_tail).strip(), project_dir)
            if timed_out:
                raise RuntimeError("Codex model discovery timed out.")
            classified = _classify_codex_error(stderr_text)
            raise RuntimeError(
                classified or (stderr_text[-400:] if stderr_text else "Codex exited before returning models.")
            )

        if preferred_model:
            for m in models:
                if m.id == preferred_model:
                    for other in models:
                        other.is_default = other is m
                    if preferred_effort and preferred_effort in m.efforts:
                        m.default_effort = preferred_effort
                    break
        return models

    def _build_argv(
        self,
        cmd_prefix: list[str] | str,
        req: TurnRequest,
        platform_name: str | None = None,
    ) -> list[str]:
        prefix = [cmd_prefix] if isinstance(cmd_prefix, str) else list(cmd_prefix)
        plat = platform_name or sys.platform
        if req.mode == "full-access":
            sandbox_mode = "danger-full-access"
        elif req.mode == "workspace-write":
            sandbox_mode = "workspace-write"
        else:
            sandbox_mode = "read-only"

        common = [
            "--json",
            "--skip-git-repo-check",
            "-c",
            'approval_policy="never"',
        ]
        if req.mode == "read-only":
            common.extend(
                [
                    "--ignore-user-config",
                    "--ignore-rules",
                    "--disable",
                    "hooks",
                    "--disable",
                    "plugins",
                    "--disable",
                    "apps",
                    "-c",
                    'web_search="disabled"',
                    "-c",
                    "project_root_markers=[]",
                ]
            )
            if req.project_dir:
                common.extend(
                    [
                        "-c",
                        f"projects={{ {json.dumps(req.project_dir)} = {{ trust_level = \"untrusted\" }} }}",
                    ]
                )
            if plat == "win32":
                common.extend(["-c", 'windows.sandbox="unelevated"'])
        elif req.mode == "workspace-write":
            common.extend(["--disable", "hooks", "--disable", "plugins", "--disable", "apps"])
            if plat == "win32":
                common.extend(["-c", 'windows.sandbox="unelevated"'])
        # full-access keeps user plugins/apps/browser tools enabled

        if req.model:
            common.extend(["--model", req.model])
        if req.effort:
            common.extend(["-c", f'model_reasoning_effort="{req.effort}"'])

        if req.provider_session_id:
            return [
                *prefix,
                "exec",
                "resume",
                *common,
                "-c",
                f'sandbox_mode="{sandbox_mode}"',
                req.provider_session_id,
                "-",
            ]
        return [
            *prefix,
            "exec",
            "--sandbox",
            sandbox_mode,
            *common,
            "-",
        ]

    def run_turn(self, req: TurnRequest, handle: TaskHandle) -> TurnResult:
        cmd = self._resolve_cmd(req.bin_override, project_dir=req.project_dir)
        if not cmd:
            return TurnResult(ok=False, error="Codex CLI is not installed on this computer.")

        argv = self._build_argv(cmd, req)
        handle.emit_activity("launching", "starting_codex", f"mode={req.mode}")
        try:
            proc = spawn_cli(argv, cwd=req.project_dir, env=req.env)
        except OSError as exc:
            return TurnResult(ok=False, error=sanitize_diagnostic(f"Could not start Codex CLI: {exc}", req.project_dir))

        state: dict[str, Any] = {
            "thread_id": req.provider_session_id,
            "answer": "",
            "error": "",
            "usage": None,
            "turn_completed": False,
        }

        def _on_line(raw: str) -> None:
            line = raw.strip()
            if not line or not line.startswith("{"):
                return
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                return
            ev_type = ev.get("type")
            if ev_type == "thread.started":
                tid = ev.get("thread_id")
                if isinstance(tid, str) and tid:
                    state["thread_id"] = tid
                    handle.set_provider_session_id(tid)
                handle.emit_activity("thread_started", "session_ready")
            elif ev_type == "turn.started":
                handle.emit_activity("turn_started", "thinking")
            elif ev_type in ("item.started", "item.updated", "item.completed"):
                item = ev.get("item") or {}
                item_type = str(item.get("type") or "")
                act = _CODEX_ACTIVITIES.get(item_type, "processing")
                detail = None
                if item_type == "command_execution" and isinstance(item.get("command"), str):
                    detail = item["command"][:120]
                handle.emit_activity(ev_type.replace(".", "_"), act, detail)
                if ev_type == "item.completed" and item_type == "agent_message":
                    text = item.get("text")
                    if isinstance(text, str) and text.strip():
                        state["answer"] = text
                        handle.append_delta(text)
            elif ev_type == "turn.completed":
                state["turn_completed"] = True
                if isinstance(ev.get("usage"), dict):
                    state["usage"] = ev["usage"]
                handle.emit_activity("turn_completed", "finishing")
            elif ev_type == "turn.failed":
                err_obj = ev.get("error") or {}
                msg = str(err_obj.get("message") or err_obj or "Codex turn failed.")
                state["error"] = _classify_codex_error(msg) or sanitize_diagnostic(msg, req.project_dir)
                handle.emit_activity("turn_failed", "error", state["error"])
            elif ev_type == "error":
                msg = str(ev.get("message") or "Codex CLI error.")
                state["error"] = _classify_codex_error(msg) or sanitize_diagnostic(msg, req.project_dir)

        code, stderr_tail, timed_out = stream_process_lines(
            proc,
            handle,
            on_stdout_line=_on_line,
            stdin_text=req.prompt,
            timeout_seconds=req.timeout_seconds,
        )

        if handle.cancel_event.is_set():
            return TurnResult(ok=False, error="Task cancelled by user.", provider_session_id=state["thread_id"])
        if timed_out:
            return TurnResult(ok=False, error="Codex task timed out.", provider_session_id=state["thread_id"])

        stderr_text = sanitize_diagnostic("".join(stderr_tail).strip(), req.project_dir)
        if state["error"]:
            return TurnResult(
                ok=False,
                answer=state["answer"],
                error=state["error"],
                provider_session_id=state["thread_id"],
                usage=state["usage"],
            )
        if code != 0:
            classified = _classify_codex_error(stderr_text)
            return TurnResult(
                ok=False,
                answer=state["answer"],
                error=classified or (stderr_text[-600:] if stderr_text else f"Codex exited with code {code}."),
                provider_session_id=state["thread_id"],
                usage=state["usage"],
            )
        return TurnResult(
            ok=True,
            answer=state["answer"] or "(No text reply produced.)",
            provider_session_id=state["thread_id"],
            usage=state["usage"],
        )
