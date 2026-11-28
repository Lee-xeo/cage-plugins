#!/usr/bin/env python3
"""
Local AI Bridge MCP Server
Speaks newline-delimited JSON-RPC 2.0 over UTF-8 stdin/stdout using Python 3 stdlib only.
Dispatches tool calls concurrently on a thread pool so progress waits never block
sidebar dashboard updates or task cancellation.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import signal
import sys
import threading
from pathlib import Path
from typing import Any

PLUGIN_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PLUGIN_ROOT))

from core import VERSION  # noqa: E402
from core.providers import create_default_providers  # noqa: E402
from core.runner import TaskRunner  # noqa: E402
from core.security import sanitize_diagnostic  # noqa: E402
from core.store import StateStore  # noqa: E402

SUPPORTED_PROTOCOLS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
SERVER_INFO = {"name": "local-ai-bridge", "version": VERSION}
_STDOUT_LOCK = threading.Lock()


def _load_tools() -> list[dict[str, Any]]:
    raw = json.loads((PLUGIN_ROOT / "tools.json").read_text(encoding="utf-8"))
    tools = raw["tools"] if isinstance(raw, dict) else raw
    if not isinstance(tools, list):
        raise RuntimeError("Invalid tools.json format.")
    return tools


TOOLS: list[dict[str, Any]] = _load_tools()
_TOOLS_BY_NAME: dict[str, dict[str, Any]] = {t["name"]: t for t in TOOLS}


def validate_tool_args(tool_name: str, args: Any) -> dict[str, Any]:
    """Strictly validate MCP tool call arguments against the tool's JSON Schema."""
    tool = _TOOLS_BY_NAME.get(tool_name)
    if not tool:
        raise ValueError(f"Unknown tool: {tool_name}")
    if not isinstance(args, dict):
        raise ValueError("Tool arguments must be an object.")

    schema = tool.get("inputSchema") or {}
    props = schema.get("properties") or {}
    required = schema.get("required") or []

    if schema.get("additionalProperties") is False:
        extra = set(args) - set(props)
        if extra:
            raise ValueError(f"Unexpected argument(s): {', '.join(sorted(extra))}.")

    for req_key in required:
        if req_key not in args or args[req_key] is None:
            raise ValueError(f"Missing required argument: {req_key}.")

    for key, value in args.items():
        if key not in props or value is None:
            continue
        spec = props[key]
        expected_type = spec.get("type")
        if expected_type == "string":
            if not isinstance(value, str):
                raise ValueError(f"Argument '{key}' must be a string.")
        elif expected_type == "boolean":
            if not isinstance(value, bool):
                raise ValueError(f"Argument '{key}' must be a boolean.")
        elif expected_type == "integer":
            if isinstance(value, bool) or not isinstance(value, int):
                raise ValueError(f"Argument '{key}' must be an integer.")
            if "minimum" in spec and value < spec["minimum"]:
                raise ValueError(f"Argument '{key}' must be >= {spec['minimum']}.")
            if "maximum" in spec and value > spec["maximum"]:
                raise ValueError(f"Argument '{key}' must be <= {spec['maximum']}.")
        elif expected_type == "object":
            if not isinstance(value, dict):
                raise ValueError(f"Argument '{key}' must be an object.")
        if "enum" in spec and value not in spec["enum"]:
            raise ValueError(f"Invalid value for '{key}'. Expected one of: {', '.join(map(str, spec['enum']))}.")
    return args


def _write_message(obj: dict[str, Any]) -> None:
    line = json.dumps(obj, ensure_ascii=False) + "\n"
    with _STDOUT_LOCK:
        sys.stdout.write(line)
        sys.stdout.flush()


def _send_result(req_id: Any, result: dict[str, Any]) -> None:
    _write_message({"jsonrpc": "2.0", "id": req_id, "result": result})


def _send_error(req_id: Any, code: int, message: str) -> None:
    _write_message(
        {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": code, "message": sanitize_diagnostic(message)},
        }
    )


def _tool_response(payload: dict[str, Any], is_error: bool = False) -> dict[str, Any]:
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    res: dict[str, Any] = {
        "content": [{"type": "text", "text": text}],
        "structuredContent": payload,
    }
    if is_error:
        res["isError"] = True
    return res


def dispatch_tool(runner: TaskRunner, name: str, raw_args: Any) -> dict[str, Any]:
    args = validate_tool_args(name, raw_args)
    if name == "ai_list_providers":
        return runner.list_providers(refresh=bool(args.get("refresh", False)))
    if name == "ai_list_models":
        return runner.list_models(
            provider_id=args["provider"],
            refresh=bool(args.get("refresh", False)),
        )
    if name == "ai_run_task":
        return runner.start_task(
            provider_id=args["provider"],
            prompt=args.get("prompt"),
            prompt_file=args.get("prompt_file"),
            session_id=args.get("session_id"),
            model=args.get("model"),
            effort=args.get("effort"),
            mode=args.get("mode"),
            title=args.get("title"),
            request_id=args.get("request_id"),
        )
    if name == "ai_task_status":
        return runner.get_task_status(
            task_id=args["task_id"],
            wait_seconds=args.get("wait_seconds", 0),
            offset=args.get("offset", 0),
            limit=args.get("limit", 32000),
        )
    if name == "ai_task_cancel":
        return runner.cancel_task(task_id=args["task_id"])
    if name == "ai_session_history":
        return runner.get_session_history(
            session_id=args.get("session_id"),
            provider=args.get("provider"),
            limit=args.get("limit", 20),
        )
    if name == "ai_dashboard_state":
        return runner.dashboard_state(refresh=bool(args.get("refresh", False)))
    if name == "ai_manage_policy":
        return runner.manage_policy(
            action=args["action"],
            payload=args.get("payload") or {},
        )
    raise ValueError(f"Unknown tool: {name}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Local AI Bridge MCP Server")
    parser.add_argument("--project-dir", default="", help="Active shared project directory")
    ns = parser.parse_args()

    project_dir = ns.project_dir.strip() if isinstance(ns.project_dir, str) else ""
    if project_dir and not Path(project_dir).is_dir():
        project_dir = ""

    store = StateStore(project_dir=project_dir)
    runner = TaskRunner(
        project_dir=project_dir,
        store=store,
        providers=create_default_providers(),
    )

    pool = concurrent.futures.ThreadPoolExecutor(max_workers=16, thread_name_prefix="mcp-rpc")
    shutting_down = threading.Event()
    in_flight: set[concurrent.futures.Future[Any]] = set()
    in_flight_lock = threading.Lock()

    def _shutdown_now(*_args: Any) -> None:
        if shutting_down.is_set():
            return
        shutting_down.set()
        # Cancel active CLI process trees and wake waiting status polls FIRST so we never
        # stall behind a 25s ai_task_status wait and leave orphaned children.
        runner.shutdown(wait_workers=False)
        pool.shutdown(wait=False, cancel_futures=True)

    signal.signal(signal.SIGTERM, _shutdown_now)
    signal.signal(signal.SIGINT, _shutdown_now)

    def _handle_request(msg: dict[str, Any]) -> None:
        req_id = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}
        if not isinstance(method, str):
            if req_id is not None:
                _send_error(req_id, -32600, "Invalid request.")
            return

        if req_id is None:
            return

        try:
            if method == "initialize":
                requested = params.get("protocolVersion") if isinstance(params, dict) else None
                proto = requested if requested in SUPPORTED_PROTOCOLS else SUPPORTED_PROTOCOLS[-1]
                _send_result(
                    req_id,
                    {
                        "protocolVersion": proto,
                        "capabilities": {"tools": {"listChanged": False}},
                        "serverInfo": SERVER_INFO,
                    },
                )
            elif method == "ping":
                _send_result(req_id, {})
            elif method == "tools/list":
                _send_result(req_id, {"tools": TOOLS})
            elif method == "tools/call":
                if not isinstance(params, dict):
                    _send_error(req_id, -32602, "Invalid tools/call params.")
                    return
                tool_name = params.get("name")
                tool_args = params.get("arguments")
                if tool_args is None:
                    tool_args = {}
                if not isinstance(tool_name, str) or not tool_name:
                    _send_error(req_id, -32602, "Missing tool name.")
                    return
                try:
                    data = dispatch_tool(runner, tool_name, tool_args)
                    _send_result(req_id, _tool_response(data, is_error=False))
                except Exception as exc:
                    _send_result(
                        req_id,
                        _tool_response({"error": sanitize_diagnostic(str(exc), project_dir)}, is_error=True),
                    )
            else:
                _send_error(req_id, -32601, f"Method not found: {method}")
        except Exception as exc:
            _send_error(req_id, -32603, str(exc))

    try:
        for raw_line in sys.stdin:
            line = raw_line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                _send_error(None, -32700, "Parse error.")
                continue
            if not isinstance(msg, dict):
                _send_error(None, -32600, "Invalid request.")
                continue
            fut = pool.submit(_handle_request, msg)
            with in_flight_lock:
                in_flight.add(fut)
            fut.add_done_callback(lambda f: _discard_future(in_flight, in_flight_lock, f))
    finally:
        if not shutting_down.is_set():
            shutting_down.set()
            # Wake any long ai_task_status waits and terminate child CLI trees FIRST
            # so shutdown completes well inside the host's graceful exit window.
            runner.shutdown(wait_workers=False)
            with in_flight_lock:
                pending = list(in_flight)
            if pending:
                concurrent.futures.wait(pending, timeout=1.5)
            pool.shutdown(wait=False, cancel_futures=True)
    return 0


def _discard_future(
    bucket: set[concurrent.futures.Future[Any]],
    lock: threading.Lock,
    fut: concurrent.futures.Future[Any],
) -> None:
    with lock:
        bucket.discard(fut)


if __name__ == "__main__":
    raise SystemExit(main())
