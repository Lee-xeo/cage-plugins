#!/usr/bin/env python3
"""
Privacy Boundary Audit MCP Server (v0.1.0)
Offline, strictly read-only host network and client privacy boundary audit over
newline-delimited JSON-RPC 2.0 stdin/stdout with zero external dependencies.
"""

from __future__ import annotations

import concurrent.futures
import json
import platform
import sys
import threading
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True

AUDIT_KIT_DIR = Path(__file__).resolve().parent / "audit_kit"
if str(AUDIT_KIT_DIR) not in sys.path:
    sys.path.insert(0, str(AUDIT_KIT_DIR))

import audit_client_boundary  # noqa: E402
import environment_report  # noqa: E402

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "privacy-boundary-audit", "version": "0.1.0"}
_STDOUT_LOCK = threading.Lock()

WEB_LOGIN_TRIAGE_STAGES: list[dict[str, Any]] = [
    {
        "id": "widget_load",
        "titleZh": "验证框空白或加载失败",
        "titleEn": "Challenge widget blank or failed to load",
        "observe": [
            "Record browser version, first-seen timestamp with timezone, and the exact error code shown on the page.",
            "Example reference code: Turnstile 200500 indicates widget iframe load failure; inspect whether requests to challenges.cloudflare.com were blocked or timed out.",
        ],
        "observeZh": [
            "记录浏览器版本、首次出现时间（含时区）以及页面实际显示的错误码。",
            "对照示例：Turnstile 错误码 200500 表示验证框未能加载，可排查该页对 challenges.cloudflare.com 的组件请求是否被拦截或超时（记录时仅填写自己实际看到的错误码）。",
        ],
    },
    {
        "id": "challenge_loop",
        "titleZh": "手动完成后反复回到验证框",
        "titleEn": "Returns to challenge repeatedly after manual completion",
        "observe": [
            "Using the same egress IP and target page, test once manually in a standard supported browser and once in the isolated browser; record timestamp, outcome, error code, and Ray ID for each.",
            "If the loop reproduces only in one browser profile, check extensions, script blockers, cache, and connection stability; a private window helps isolate extension or cache interference.",
        ],
        "observeZh": [
            "保持同一网络出口与同一页面，分别在受支持的普通浏览器和隔离浏览器中各手动测试一次，分别记录时间、结果、错误码与 Ray ID。",
            "若现象仅在单一浏览器配置中复现，优先排查扩展、脚本加载、缓存和连接稳定性；无痕窗口可用于排查扩展或缓存干扰。",
        ],
    },
    {
        "id": "post_challenge",
        "titleZh": "验证通过后返回站点才出现限制提示",
        "titleEn": "Site notice appears only after challenge succeeds",
        "observe": [
            "Record the exact site notice or email wording and first-seen timestamp with timezone separately from challenge logs.",
            "Distinguish extra verification prompts, unsupported-region messages, and suspension emails; retain last-known normal usage time to bound the timeline.",
        ],
        "observeZh": [
            "单独记录站点提示或邮件原文以及首次可见时间（含时区），与人机验证日志分开归档。",
            "明确区分“要求补充验证”“提示地区不可用”与“收到停用邮件”；同时留存最近一次已知正常使用时间以限定排查窗口。",
        ],
    },
]

TRIAGE_REDACTION_RULES = {
    "publicSafe": [
        "Client version numbers and OS platform",
        "Redacted error notices and relative timestamps",
        "Exact challenge error codes without account identifiers",
    ],
    "publicSafeZh": [
        "客户端版本号与操作系统平台",
        "脱敏后的提示原文与相对时间差",
        "不关联账号标识的页面错误码",
    ],
    "keepPrivate": [
        "Full Cloudflare Ray IDs (share only with official site support)",
        "Sign-in links, verification codes, session cookies, and account emails",
        "Proxy subscription URLs, node credentials, and local usernames or paths",
    ],
    "keepPrivateZh": [
        "完整 Ray ID（仅提供给对应站点官方支持）",
        "登录链接、一次性验证码、会话 Cookie 与账号邮箱",
        "代理订阅链接、节点凭据及本机用户名与敏感路径",
    ],
}

TOOLS: list[dict[str, Any]] = [
    {
        "name": "privacy_boundary_report",
        "description": (
            "Run an offline, strictly read-only, redacted host audit covering active routes, "
            "IPv6 exposure, DNS configuration, firewall outbound defaults, local client data footprints, "
            "CLI anti-telemetry switches, local MCP bridge counts, and a 10-check tri-state summary "
            "(pass, gap, unknown) with explicit evidence tiers."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
        "_meta": {"ui": {"visibility": ["model", "app"]}},
    },
    {
        "name": "privacy_client_boundary",
        "description": (
            "Run a fast, offline, strictly read-only redacted check of host OS timezone and locale, "
            "local Claude Desktop/MSIX and CLI data footprints, the 5 CLI anti-telemetry switches, "
            "and local MCP server bridge counts without querying OS routing or firewall tables."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
        "_meta": {"ui": {"visibility": ["model", "app"]}},
    },
    {
        "name": "privacy_web_login_triage",
        "description": (
            "Return an offline stage-by-stage checklist for distinguishing web login challenge "
            "widget load failures, challenge loops, and post-challenge site notices, plus redaction "
            "guidelines for diagnostic notes."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "stage": {
                    "type": "string",
                    "enum": ["all", "widget_load", "challenge_loop", "post_challenge"],
                    "description": "Optional failure stage filter (defaults to 'all').",
                }
            },
            "additionalProperties": False,
        },
        "_meta": {"ui": {"visibility": ["model", "app"]}},
    },
]


def _neutralize_summary(report: dict[str, Any]) -> dict[str, Any]:
    summary = report.get("summary")
    if not isinstance(summary, dict):
        return report
    checks = summary.get("checks")
    if isinstance(checks, list):
        for item in checks:
            if not isinstance(item, dict):
                continue
            detail = item.get("detail")
            if isinstance(detail, str):
                item["detail"] = (
                    detail.replace("virtual-machine", "isolated-environment")
                    .replace("virtual machine", "isolated environment")
                )
    return report


def handle_tool_call(tool_name: str, tool_args: dict[str, Any]) -> dict[str, Any]:
    if tool_name == "privacy_boundary_report":
        system = platform.system()
        report = environment_report.build_report(system)
        return _neutralize_summary(report)

    if tool_name == "privacy_client_boundary":
        return audit_client_boundary.collect_boundary_audit()

    if tool_name == "privacy_web_login_triage":
        stage = str(tool_args.get("stage") or "all").strip()
        if stage not in ("all", "widget_load", "challenge_loop", "post_challenge"):
            raise ValueError(f"Unsupported stage filter: {stage}")
        stages = (
            WEB_LOGIN_TRIAGE_STAGES
            if stage == "all"
            else [item for item in WEB_LOGIN_TRIAGE_STAGES if item["id"] == stage]
        )
        return {
            "schemaVersion": 1,
            "scope": "Offline web login failure stage triage checklist and redaction rules.",
            "filter": stage,
            "stages": stages,
            "redaction": TRIAGE_REDACTION_RULES,
        }

    raise ValueError(f"Unknown tool: {tool_name}")


def send_json(payload: dict[str, Any]) -> None:
    line = json.dumps(payload, ensure_ascii=False) + "\n"
    with _STDOUT_LOCK:
        sys.stdout.write(line)
        sys.stdout.flush()


def _execute_tool_call(req_id: Any, tool_name: str, tool_args: dict[str, Any]) -> None:
    try:
        result = handle_tool_call(tool_name, tool_args)
        send_json(
            {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, indent=2)}],
                    "structuredContent": result,
                    "isError": False,
                },
            }
        )
    except Exception as exc:
        send_json(
            {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": f"Error: {exc}"}],
                    "isError": True,
                },
            }
        )


def handle_request(msg: dict[str, Any], executor: concurrent.futures.ThreadPoolExecutor) -> None:
    req_id = msg.get("id")
    method = msg.get("method", "")
    params = msg.get("params") if isinstance(msg.get("params"), dict) else {}

    if req_id is None:
        return

    if method == "initialize":
        send_json(
            {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": params.get("protocolVersion", PROTOCOL_VERSION),
                    "capabilities": {"tools": {}},
                    "serverInfo": SERVER_INFO,
                },
            }
        )
        return

    if method == "ping":
        send_json({"jsonrpc": "2.0", "id": req_id, "result": {}})
        return

    if method == "tools/list":
        send_json({"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}})
        return

    if method == "tools/call":
        tool_name = str(params.get("name") or "")
        tool_args = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        executor.submit(_execute_tool_call, req_id, tool_name, tool_args)
        return

    send_json(
        {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"},
        }
    )


def main() -> None:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass

    with concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="privacy-audit") as executor:
        for raw in sys.stdin:
            raw = raw.strip()
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError as exc:
                sys.stderr.write(f"Invalid JSON-RPC input: {exc}\n")
                sys.stderr.flush()
                continue
            if isinstance(msg, dict):
                handle_request(msg, executor)


if __name__ == "__main__":
    main()
