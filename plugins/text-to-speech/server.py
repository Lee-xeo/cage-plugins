#!/usr/bin/env python3
"""Standard stdio MCP server for multi-protocol text-to-speech and video voiceovers."""

from __future__ import annotations

import json
import os
import pathlib
import sys
from typing import Any, Dict, List, Optional

# Ensure sibling modules resolve reliably regardless of working directory.
_HERE = pathlib.Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from batch import run_batch
from protocols import (
    EXTENSION_FORMATS,
    PROTOCOL_CATALOG,
    HttpTransport,
    SynthesisRequest,
    TTSError,
    default_http_transport,
    load_profiles,
    summarize_profiles,
    synthesize,
)

SERVER_INFO = {"name": "text-to-speech", "version": "0.1.0"}
MAX_TEXT_FILE_BYTES = 256 * 1024


def load_tools() -> List[Dict[str, Any]]:
    tools_path = _HERE / "tools.json"
    raw = json.loads(tools_path.read_text(encoding="utf-8"))
    return raw["tools"] if isinstance(raw, dict) else raw


def resolve_project_path(project_dir: pathlib.Path, rel_path: str) -> pathlib.Path:
    """Resolve a relative path strictly inside project_dir, blocking traversal and symlink escapes."""
    if not isinstance(rel_path, str) or not rel_path.strip():
        raise TTSError("Path must be a non-empty relative path inside the project directory.")
    if "\x00" in rel_path:
        raise TTSError("Path contains invalid NUL characters.")

    raw = pathlib.Path(rel_path.strip())
    if raw.is_absolute() or raw.drive:
        raise TTSError(f"Absolute paths are not allowed ('{rel_path}'); pass a path relative to the project directory.")

    root = project_dir.resolve()
    candidate = root / raw

    # Reject explicit '..' traversal components before resolving.
    if ".." in raw.parts:
        raise TTSError(f"Path traversal ('..') is not allowed: '{rel_path}'")

    # Verify every existing prefix stays inside root (prevents symlink escape).
    probe = candidate
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    resolved_probe = probe.resolve()
    try:
        resolved_probe.relative_to(root)
    except ValueError as exc:
        raise TTSError(f"Path escapes the active project directory: '{rel_path}'") from exc

    resolved_candidate = candidate.resolve(strict=False)
    try:
        resolved_candidate.relative_to(root)
    except ValueError as exc:
        raise TTSError(f"Path escapes the active project directory: '{rel_path}'") from exc

    return resolved_candidate


class TTSServer:
    """Stateful MCP request dispatcher bound to an active project directory."""

    def __init__(
        self,
        project_dir: pathlib.Path,
        env: Optional[Dict[str, str]] = None,
        transport: HttpTransport = default_http_transport,
    ) -> None:
        self.project_dir = project_dir.resolve()
        self.env = dict(os.environ if env is None else env)
        self.transport = transport
        self.tools = load_tools()

    def _profiles(self) -> Dict[str, Dict[str, Any]]:
        return load_profiles(self.env, self.project_dir)

    def call_tool(self, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        if not isinstance(args, dict):
            args = {}
        try:
            if name == "tts_list_protocols":
                payload = {
                    "protocols": PROTOCOL_CATALOG,
                    "notes": [
                        "For long or multi-line narration, save text to a project file and pass text_file to tts_synthesize or use tts_synthesize_batch.",
                        "All output files are written relative to the active project directory.",
                    ],
                }
                return _ok_json(payload)

            if name == "tts_list_profiles":
                profiles = self._profiles()
                return _ok_json({
                    "profiles": summarize_profiles(profiles),
                    "profiles_file": self.env.get("TTS_PROFILES_PATH", "") or None,
                })

            if name == "tts_synthesize":
                return _ok_json(self._handle_synthesize(args))

            if name == "tts_synthesize_batch":
                return _ok_json(self._handle_batch(args))

            return _err_text(f"Unknown tool: {name}")
        except TTSError as exc:
            return _err_text(str(exc))
        except Exception as exc:
            return _err_text(f"Unexpected error: {exc}")

    def _handle_synthesize(self, args: Dict[str, Any]) -> Dict[str, Any]:
        output_rel = args.get("output_path")
        output_file = resolve_project_path(self.project_dir, str(output_rel or ""))

        text = args.get("text")
        text_file = args.get("text_file")
        if text and text_file:
            raise TTSError("Provide either 'text' or 'text_file', not both.")
        if text_file:
            src_path = resolve_project_path(self.project_dir, str(text_file))
            if not src_path.is_file():
                raise TTSError(f"Text file not found: {text_file}")
            if src_path.stat().st_size > MAX_TEXT_FILE_BYTES:
                raise TTSError(f"Text file exceeds {MAX_TEXT_FILE_BYTES // 1024} KB limit; split into segments and use tts_synthesize_batch.")
            text = src_path.read_text(encoding="utf-8")
        if not isinstance(text, str) or not text.strip():
            raise TTSError("Either non-empty 'text' or 'text_file' is required.")

        profiles = self._profiles()
        prof_name = str(args.get("profile") or "default").strip()
        if prof_name not in profiles:
            raise TTSError(f"Unknown TTS profile '{prof_name}'. Available: {', '.join(sorted(profiles))}")
        prof = profiles[prof_name]

        fmt = args.get("format")
        if not fmt:
            fmt = EXTENSION_FORMATS.get(output_file.suffix.lower())

        req = SynthesisRequest(
            text=text,
            voice=args.get("voice"),
            model=args.get("model"),
            format=fmt,
            sample_rate=args.get("sample_rate"),
            speed=args.get("speed"),
            volume=args.get("volume"),
            pitch=args.get("pitch"),
            emotion=args.get("emotion"),
            emotion_scale=args.get("emotion_scale"),
            language=args.get("language"),
            instructions=args.get("instructions"),
        )
        res = synthesize(
            prof,
            req,
            protocol_override=args.get("protocol"),
            transport=self.transport,
        )

        output_file.parent.mkdir(parents=True, exist_ok=True)
        output_file.write_bytes(res.audio_bytes)

        result: Dict[str, Any] = {
            "output_path": output_file.relative_to(self.project_dir).as_posix(),
            "bytes": len(res.audio_bytes),
            "format": res.audio_format,
            "protocol": res.protocol,
            "profile": prof_name,
            "voice": res.voice,
            "sample_rate": res.sample_rate,
            "duration_seconds": res.duration_seconds,
        }
        if res.model:
            result["model"] = res.model
        if res.request_id:
            result["request_id"] = res.request_id
        return result

    def _handle_batch(self, args: Dict[str, Any]) -> Dict[str, Any]:
        script_file = resolve_project_path(self.project_dir, str(args.get("script_path") or ""))
        if not script_file.is_file():
            raise TTSError(f"Script file not found: {args.get('script_path')}")
        output_dir = resolve_project_path(self.project_dir, str(args.get("output_dir") or ""))
        manifest_file = (
            resolve_project_path(self.project_dir, str(args["manifest_path"]))
            if args.get("manifest_path")
            else None
        )
        profiles = self._profiles()
        return run_batch(
            script_path=script_file,
            output_dir=output_dir,
            project_dir=self.project_dir,
            profiles=profiles,
            resolve_output_file=lambda rel: resolve_project_path(self.project_dir, rel),
            manifest_path=manifest_file,
            profile_override=args.get("profile"),
            voice_override=args.get("voice"),
            format_override=args.get("format"),
            speed_override=args.get("speed"),
            start_index=int(args.get("start_index", 0) or 0),
            limit=int(args.get("limit", 20) or 20),
            concurrency=int(args.get("concurrency", 3) or 3),
            skip_existing=bool(args.get("skip_existing", False)),
            continue_on_error=bool(args.get("continue_on_error", True)),
            transport=self.transport,
        )

    def handle_message(self, message: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        method = message.get("method")
        if method == "initialize":
            params = message.get("params") or {}
            return {
                "protocolVersion": params.get("protocolVersion", "2024-11-05"),
                "capabilities": {"tools": {}},
                "serverInfo": SERVER_INFO,
            }
        if method == "tools/list":
            return {"tools": self.tools}
        if method == "tools/call":
            params = message.get("params") or {}
            return self.call_tool(str(params.get("name", "")), params.get("arguments") or {})
        if method == "ping":
            return {}
        return None


def _ok_json(payload: Dict[str, Any]) -> Dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False, indent=2)}]}


def _err_text(message: str) -> Dict[str, Any]:
    return {"content": [{"type": "text", "text": message}], "isError": True}


def main(argv: List[str]) -> int:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8")
            except Exception:
                pass
    project_arg = argv[1] if len(argv) > 1 and argv[1].strip() else os.getcwd()
    project_dir = pathlib.Path(project_arg).expanduser()
    if not project_dir.is_dir():
        sys.stderr.write(f"Project directory does not exist: {project_dir}\n")
        return 1

    server = TTSServer(project_dir=project_dir)
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(request, dict) or "id" not in request:
            continue
        result = server.handle_message(request)
        reply: Dict[str, Any] = {"jsonrpc": "2.0", "id": request["id"]}
        if result is None:
            reply["error"] = {"code": -32601, "message": "method not found"}
        else:
            reply["result"] = result
        sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
