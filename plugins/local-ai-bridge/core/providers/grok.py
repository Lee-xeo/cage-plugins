"""Native Grok CLI adapter (`grok models`, `grok --prompt-file ... --output-format streaming-messages-json`)."""

from __future__ import annotations

import json
import re
import uuid
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

_GROK_NPM_ENTRIES = (
    "node_modules/@xai-official/grok/bin/grok.js",
    "node_modules/@xai-official/grok/bin/grok.mjs",
    "node_modules/@xai/grok/bin/grok.js",
    "node_modules/grok/bin/grok.js",
)

# Hard read-only tool allowlist and blocklist covering both @xai-official/grok 1.0.46 (`run_terminal_cmd`)
# and newer releases (`run_terminal_command`).
_GROK_READONLY_TOOLS = "read_file,list_dir,grep"
_GROK_READONLY_DISALLOWED = (
    "run_terminal_cmd,run_terminal_command,kill_command_or_subagent,get_command_or_subagent_output,"
    "monitor,write,search_replace,use_tool,search_tool,workflow,"
    "image_gen,image_edit,image_to_video,reference_to_video"
)
_GROK_WORKSPACE_WRITE_DISALLOWED = (
    "run_terminal_cmd,run_terminal_command,kill_command_or_subagent,get_command_or_subagent_output,"
    "monitor,use_tool,search_tool,workflow,"
    "image_gen,image_edit,image_to_video,reference_to_video"
)

# Official Grok CLI `--deny` built-in rule prefixes (verified against @xai-official/grok 1.0.46 & 1.0.92).
_GROK_READONLY_DENIES = (
    "Bash(*)",
    "Edit(*)",
    "Write(*)",
    "MCPTool(*)",
    "WebFetch(*)",
    "WebSearch(*)",
)
_GROK_WORKSPACE_WRITE_DENIES = (
    "Bash(*)",
    "MCPTool(*)",
    "WebFetch(*)",
    "WebSearch(*)",
)

_AUTH_ERR_RE = re.compile(
    r"not authenticated|not logged in|please log in|unauthorized|401|api key|grok login",
    re.IGNORECASE,
)


def parse_grok_models_output(text: str) -> tuple[list[ModelInfo], bool | None]:
    """Parse `grok models` stdout into ModelInfo entries and auth hint."""
    authenticated: bool | None = None
    if _AUTH_ERR_RE.search(text):
        authenticated = False

    models: list[ModelInfo] = []
    default_id: str | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        m_def = re.match(r"^Default model:\s*(\S+)", line, re.I)
        if m_def:
            default_id = m_def.group(1).strip()
            continue
        m_item = re.match(r"^[*•-]\s+([A-Za-z0-9._/@:-]+)(?:\s+\(([^)]+)\))?", line)
        if m_item:
            mid = m_item.group(1).strip()
            note = (m_item.group(2) or "").lower()
            is_def = line.startswith("*") or "default" in note or (default_id == mid)
            models.append(
                ModelInfo(
                    id=mid,
                    display_name=mid,
                    is_default=is_def,
                    efforts=["low", "medium", "high"],
                )
            )
    if models and authenticated is None:
        authenticated = True
    return models, authenticated


def _extract_text_from_event(ev: dict[str, Any]) -> tuple[str, bool]:
    """Extract text content and whether it is a delta chunk from Grok streaming JSON events."""
    for key in ("delta", "text_delta", "content_delta"):
        val = ev.get(key)
        if isinstance(val, str) and val:
            return val, True
        if isinstance(val, dict) and isinstance(val.get("text"), str):
            return val["text"], True

    if ev.get("type") == "content_block_delta":
        delta = ev.get("delta") or {}
        if isinstance(delta.get("text"), str):
            return delta["text"], True

    update = ev.get("update") if isinstance(ev.get("update"), dict) else None
    if update:
        content = update.get("content")
        if isinstance(content, dict) and isinstance(content.get("text"), str):
            return content["text"], True
        if isinstance(update.get("text"), str):
            return update["text"], True

    if isinstance(ev.get("result"), str) and ev["result"]:
        return ev["result"], False
    if isinstance(ev.get("response"), str) and ev["response"]:
        return ev["response"], False

    msg = ev.get("message") if isinstance(ev.get("message"), dict) else ev
    if msg.get("role") == "assistant":
        content = msg.get("content")
        if isinstance(content, str) and content:
            return content, False
        if isinstance(content, list):
            parts = [
                str(block.get("text"))
                for block in content
                if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
            ]
            if parts:
                return "".join(parts), False
    return "", False


class GrokProvider(AIProvider):
    id = "grok"
    display_name = "Grok CLI"
    service_destination = "xAI Grok service (via host Grok CLI)"
    read_only_isolation = "cli-tool-restricted"
    read_only_boundary = (
        "CLI tool allowlist (read_file, list_dir, grep) plus --disallowed-tools, "
        "--deny Bash/Edit/Write/MCPTool/WebFetch/WebSearch, --no-subagents, and --disable-web-search. "
        "Enforced at the CLI tool/permission layer, not an OS filesystem sandbox."
    )
    capabilities = ("read-only", "workspace-write", "full-access", "multi-turn", "model-discovery", "reasoning-effort")

    def _resolve_cmd(self, bin_override: str | None = None, project_dir: str = "") -> list[str] | None:
        return resolve_cli_command(
            "grok",
            "AI_BRIDGE_GROK_BIN",
            policy_override=bin_override,
            npm_rel_entries=_GROK_NPM_ENTRIES,
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
                error="Grok CLI not found (on Windows, point to grok.exe or its JS entry).",
            )
        code, out, err = run_quick_command([*cmd, "--version"], timeout=5.0, env=env)
        if code != 0:
            return ProviderStatus(
                available=False,
                binary_path=cmd[-1],
                error=sanitize_diagnostic((err or out or "Failed to query Grok version.").strip()[:200], project_dir),
            )
        version = (out or err).strip().splitlines()[0] if (out or err).strip() else "unknown"
        _, m_out, m_err = run_quick_command([*cmd, "models"], timeout=5.0, env=env)
        _, auth = parse_grok_models_output(f"{m_out}\n{m_err}")
        auth_err = "Grok CLI is not authenticated. Run `grok login` on the host machine." if auth is False else None
        account_summary = (
            "Host Grok CLI (logged-in account)" if auth is True else ("Not logged in" if auth is False else "Host Grok CLI (unverified)")
        )
        return ProviderStatus(
            available=True,
            authenticated=auth,
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
            raise RuntimeError("Grok CLI is not installed.")
        code, out, err = run_quick_command([*cmd, "models"], timeout=10.0, env=env)
        combined = f"{out}\n{err}"
        models, auth = parse_grok_models_output(combined)
        if not models and auth is False:
            raise RuntimeError("Grok CLI is not authenticated. Run `grok login` on the host machine.")
        if code != 0 and not models:
            raise RuntimeError(
                sanitize_diagnostic((err or out or f"grok models exited with code {code}").strip()[:300], project_dir)
            )
        return models

    def _build_argv(
        self,
        cmd_prefix: list[str] | str,
        req: TurnRequest,
        session_uuid: str,
        is_resume: bool,
        prompt_file_path: str,
    ) -> list[str]:
        prefix = [cmd_prefix] if isinstance(cmd_prefix, str) else list(cmd_prefix)
        if req.mode == "full-access":
            perm_mode = "bypassPermissions"
        elif req.mode == "workspace-write":
            perm_mode = "acceptEdits"
        else:
            perm_mode = "plan"

        argv = [
            *prefix,
            "--cwd",
            req.project_dir,
            "--output-format",
            "streaming-messages-json",
            "--include-partial-messages",
            "--permission-mode",
            perm_mode,
        ]
        if req.mode == "read-only":
            argv.extend(
                [
                    "--disable-web-search",
                    "--no-subagents",
                    "--tools",
                    _GROK_READONLY_TOOLS,
                    "--disallowed-tools",
                    _GROK_READONLY_DISALLOWED,
                ]
            )
            for rule in _GROK_READONLY_DENIES:
                argv.extend(["--deny", rule])
        elif req.mode == "workspace-write":
            argv.extend(
                [
                    "--disable-web-search",
                    "--no-subagents",
                    "--disallowed-tools",
                    _GROK_WORKSPACE_WRITE_DISALLOWED,
                ]
            )
            for rule in _GROK_WORKSPACE_WRITE_DENIES:
                argv.extend(["--deny", rule])
        elif req.mode == "full-access":
            argv.append("--always-approve")

        if is_resume:
            argv.extend(["--resume", session_uuid])
        else:
            argv.extend(["--session-id", session_uuid])
        if req.model:
            argv.extend(["--model", req.model])
        if req.effort:
            argv.extend(["--reasoning-effort", req.effort])
        # Always pass prompt via a private file to avoid CLI arg length limits and shell/batch escaping issues.
        argv.extend(["--prompt-file", prompt_file_path])
        return argv

    def run_turn(self, req: TurnRequest, handle: TaskHandle) -> TurnResult:
        cmd = self._resolve_cmd(req.bin_override, project_dir=req.project_dir)
        if not cmd:
            return TurnResult(ok=False, error="Grok CLI is not installed on this computer.")

        session_uuid = req.provider_session_id or str(uuid.uuid4())
        is_resume = bool(req.provider_session_id)
        handle.set_provider_session_id(session_uuid)

        temp_prompt_file: Path | None = None
        try:
            temp_prompt_file = write_private_temp_file(req.prompt, prefix="grok-prompt-", suffix=".txt")
            argv = self._build_argv(cmd, req, session_uuid, is_resume, str(temp_prompt_file))
            handle.emit_activity("launching", "starting_grok", f"mode={req.mode}")
            try:
                proc = spawn_cli(argv, cwd=req.project_dir, env=req.env)
            except OSError as exc:
                return TurnResult(
                    ok=False,
                    error=sanitize_diagnostic(f"Could not start Grok CLI: {exc}", req.project_dir),
                )

            state: dict[str, Any] = {
                "session_id": session_uuid,
                "delta_chunks": [],
                "final_answer": "",
                "plain_lines": [],
                "error": "",
                "usage": None,
            }

            def _on_line(raw: str) -> None:
                line = raw.strip()
                if not line:
                    return
                if not line.startswith("{"):
                    if _AUTH_ERR_RE.search(line):
                        state["error"] = "Grok CLI is not authenticated. Run `grok login` on the host machine."
                    else:
                        state["plain_lines"].append(line)
                    return
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    state["plain_lines"].append(line)
                    return

                sid = ev.get("session_id") or ev.get("sessionId")
                if isinstance(sid, str) and sid:
                    state["session_id"] = sid
                    handle.set_provider_session_id(sid)

                ev_type = str(ev.get("type") or ev.get("event") or "")
                subtype = str(ev.get("subtype") or "")
                if ev_type == "error" or ev.get("is_error") or (ev_type == "result" and subtype == "error"):
                    err_val = ev.get("error") or ev.get("message") or ev.get("result") or "Grok returned an error."
                    if isinstance(err_val, dict):
                        err_val = err_val.get("message") or json.dumps(err_val, ensure_ascii=False)
                    err_str = str(err_val)
                    state["error"] = (
                        "Grok CLI is not authenticated. Run `grok login` on the host machine."
                        if _AUTH_ERR_RE.search(err_str)
                        else sanitize_diagnostic(err_str, req.project_dir)
                    )
                    handle.emit_activity("error", "error", state["error"])
                    return

                if isinstance(ev.get("usage"), dict):
                    state["usage"] = ev["usage"]

                if "tool" in ev_type.lower():
                    tool_obj = ev.get("tool")
                    tool_name = (tool_obj.get("name") if isinstance(tool_obj, dict) else None) or ev.get("name")
                    handle.emit_activity("tool_use", "calling_tool", str(tool_name) if tool_name else None)
                elif "thinking" in ev_type.lower():
                    handle.emit_activity("thinking", "reasoning")

                text, is_delta = _extract_text_from_event(ev)
                if text:
                    if is_delta:
                        state["delta_chunks"].append(text)
                        handle.append_delta(text)
                        handle.emit_activity("streaming", "composing_answer")
                    else:
                        state["final_answer"] = text
                        handle.emit_activity("message", "composing_answer")

            code, stderr_tail, timed_out = stream_process_lines(
                proc,
                handle,
                on_stdout_line=_on_line,
                timeout_seconds=req.timeout_seconds,
            )
        finally:
            if temp_prompt_file:
                temp_prompt_file.unlink(missing_ok=True)

        if handle.cancel_event.is_set():
            return TurnResult(ok=False, error="Task cancelled by user.", provider_session_id=state["session_id"])
        if timed_out:
            return TurnResult(ok=False, error="Grok task timed out.", provider_session_id=state["session_id"])

        stderr_text = sanitize_diagnostic("".join(stderr_tail).strip(), req.project_dir)
        answer = (
            state["final_answer"]
            or "".join(state["delta_chunks"]).strip()
            or "\n".join(state["plain_lines"]).strip()
        )

        if state["error"]:
            return TurnResult(
                ok=False,
                answer=answer,
                error=state["error"],
                provider_session_id=state["session_id"],
                usage=state["usage"],
            )
        if code != 0:
            if _AUTH_ERR_RE.search(stderr_text):
                err_msg = "Grok CLI is not authenticated. Run `grok login` on the host machine."
            else:
                err_msg = stderr_text[-600:] if stderr_text else f"Grok exited with code {code}."
            return TurnResult(
                ok=False,
                answer=answer,
                error=err_msg,
                provider_session_id=state["session_id"],
                usage=state["usage"],
            )

        return TurnResult(
            ok=True,
            answer=answer or "(No text reply produced.)",
            provider_session_id=state["session_id"],
            usage=state["usage"],
        )
