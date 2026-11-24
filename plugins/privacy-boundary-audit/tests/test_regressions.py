#!/usr/bin/env python3
"""Regression tests for privacy-boundary-audit read-only collectors and MCP server."""
from __future__ import annotations

import io
import json
import pathlib
import re
import sys
import unittest
from unittest import mock

PLUGIN_DIR = pathlib.Path(__file__).resolve().parent.parent
AUDIT_KIT_DIR = PLUGIN_DIR / "audit_kit"
REPO_ROOT = PLUGIN_DIR.parent.parent

for candidate in (str(PLUGIN_DIR), str(AUDIT_KIT_DIR)):
    if candidate not in sys.path:
        sys.path.insert(0, candidate)

import claude_local_data  # noqa: E402
import config_snapshot  # noqa: E402
import environment_report  # noqa: E402
import inspect_unix_network  # noqa: E402
import server  # noqa: E402


def _check_map(summary: dict) -> dict[str, dict]:
    return {item["id"]: item for item in summary["checks"]}


class PrivacyBoundaryAuditRegressionTests(unittest.TestCase):
    def test_macos_utun_default_route_marks_pass(self) -> None:
        netstat_sample = "\n".join(
            [
                "Routing tables",
                "Internet:",
                "Destination        Gateway            Flags           Netif Expire",
                "default            link#20            UCSg            utun4",
            ]
        )
        parsed_v4 = inspect_unix_network.mac_defaults(netstat_sample)
        network_data = {
            "default_routes": {
                "ipv4": inspect_unix_network.route_summary(parsed_v4, "netstat", {}),
                "ipv6": inspect_unix_network.route_summary([], "netstat", {}),
            },
            "split_tunnel_routes": {},
        }
        check = environment_report._evaluate_routing_check(network_data)
        self.assertEqual(check["status"], "pass")
        self.assertIn("tunnel", check["detail"].lower())

    def test_unix_ipv6_default_without_tunnel_marks_gap_and_with_tunnel_marks_pass(self) -> None:
        eth_v6 = inspect_unix_network.iproute_defaults(
            json.dumps([{"dst": "default", "gateway": "fe80::1", "dev": "eth0"}]),
            "ipv6",
        )
        tun_v4 = inspect_unix_network.iproute_defaults(
            json.dumps([{"dst": "default", "dev": "tun0"}]),
            "ipv4",
        )
        gap_check = environment_report._evaluate_routing_check(
            {
                "default_routes": {
                    "ipv4": inspect_unix_network.route_summary(tun_v4, "iproute2", {}),
                    "ipv6": inspect_unix_network.route_summary(eth_v6, "iproute2", {}),
                },
                "split_tunnel_routes": {},
            }
        )
        self.assertEqual(gap_check["status"], "gap")

        tun_v6 = inspect_unix_network.iproute_defaults(
            json.dumps([{"dst": "default", "dev": "tun0"}]),
            "ipv6",
        )
        pass_check = environment_report._evaluate_routing_check(
            {
                "default_routes": {
                    "ipv4": inspect_unix_network.route_summary(tun_v4, "iproute2", {}),
                    "ipv6": inspect_unix_network.route_summary(tun_v6, "iproute2", {}),
                },
                "split_tunnel_routes": {},
            }
        )
        self.assertEqual(pass_check["status"], "pass")

    def test_windows_all_unavailable_marks_network_collector_unknown(self) -> None:
        report = {
            "platform": "Windows",
            "network": {
                "status": "collected",
                "data": {
                    "Routing": {"ActiveStore": "unavailable", "DefaultRouteCount": None, "Routes": []},
                    "Dns": {"AdapterResolvers": "unavailable", "DohAutoServers": "unavailable"},
                    "Firewall": {"ActiveStore": "unavailable", "Profiles": []},
                },
            },
            "clientBoundary": {"status": "unavailable"},
            "claudeLocalData": {"status": "unavailable"},
        }
        checks = _check_map(environment_report.build_tri_state_summary(report))
        self.assertEqual(checks["network_collector"]["status"], "unknown")
        self.assertEqual(checks["routing_and_ipv6_surface"]["status"], "unknown")
        self.assertEqual(checks["system_dns_observations"]["status"], "unknown")
        self.assertEqual(checks["firewall_and_fail_closed"]["status"], "unknown")

    def test_windows_routing_distinguishes_standard_route_from_tunnel_candidate(self) -> None:
        direct_only = {
            "Routing": {
                "ActiveStore": "observed",
                "Candidates": [
                    {
                        "AddressFamily": "IPv4",
                        "DestinationPrefix": "0.0.0.0/0",
                        "InterfaceState": "Connected",
                        "InterfaceCategory": "other",
                    }
                ],
            }
        }
        self.assertEqual(
            environment_report._evaluate_routing_check(direct_only)["status"],
            "gap",
        )

        with_tunnel = {
            "Routing": {
                "ActiveStore": "observed",
                "Candidates": [
                    {
                        "AddressFamily": "IPv4",
                        "DestinationPrefix": "0.0.0.0/1",
                        "InterfaceState": "Connected",
                        "InterfaceCategory": "tunnel_candidate",
                    }
                ],
            }
        }
        self.assertEqual(
            environment_report._evaluate_routing_check(with_tunnel)["status"],
            "pass",
        )

    def test_windows_firewall_detects_msix_outbound_allow_bypass(self) -> None:
        base_profiles = [
            {"Profile": "Domain", "Enabled": "True", "DefaultOutboundAction": "Block"},
            {"Profile": "Private", "Enabled": "True", "DefaultOutboundAction": "Block"},
            {"Profile": "Public", "Enabled": "True", "DefaultOutboundAction": "Block"},
        ]
        with_bypass = {
            "Firewall": {
                "ActiveStore": "observed",
                "Profiles": base_profiles,
                "OutboundAllowBypass": {
                    "Status": "observed",
                    "ClaudeAllowRuleCount": 1,
                    "MsixPackageAllowRuleCount": 1,
                },
            },
            "FailClosedVerified": True,
        }
        bypass_check = environment_report._evaluate_firewall_check("Windows", with_bypass)
        self.assertEqual(bypass_check["status"], "gap")
        self.assertIn("MSIX=1", bypass_check["detail"])

        clean_block = {
            "Firewall": {
                "ActiveStore": "observed",
                "Profiles": base_profiles,
                "OutboundAllowBypass": {
                    "Status": "observed",
                    "ClaudeAllowRuleCount": 0,
                    "MsixPackageAllowRuleCount": 0,
                },
            },
            "FailClosedVerified": False,
        }
        clean_check = environment_report._evaluate_firewall_check("Windows", clean_block)
        self.assertEqual(clean_check["status"], "unknown")

    def test_server_redacts_unexpected_exception_paths_and_exposes_controlled_validation(self) -> None:
        buf = io.StringIO()
        secret_path = "/Users/alice_secret_name/.claude/private_token.json"
        with mock.patch.object(sys, "stdout", buf):
            with mock.patch.object(
                server,
                "handle_tool_call",
                side_effect=PermissionError(f"Permission denied: {secret_path}"),
            ):
                server._execute_tool_call(42, "privacy_client_boundary", {})
            server._execute_tool_call(43, "privacy_web_login_triage", {"stage": "invalid_stage"})

        lines = [json.loads(line) for line in buf.getvalue().splitlines() if line.strip()]
        self.assertEqual(len(lines), 2)
        err_text = lines[0]["result"]["content"][0]["text"]
        self.assertTrue(lines[0]["result"]["isError"])
        self.assertIn("PermissionError", err_text)
        self.assertNotIn("alice_secret_name", err_text)
        self.assertNotIn(secret_path, err_text)

        val_text = lines[1]["result"]["content"][0]["text"]
        self.assertTrue(lines[1]["result"]["isError"])
        self.assertIn("Unsupported stage filter", val_text)

    def test_tools_json_matches_server_and_modules_stay_strictly_read_only(self) -> None:
        tools_json = json.loads((PLUGIN_DIR / "tools.json").read_text(encoding="utf-8"))
        self.assertEqual(tools_json, server.TOOLS)

        for forbidden_attr in ("safe_rmtree", "copy_tree", "restore_snapshot", "write_restore_launcher"):
            self.assertFalse(hasattr(config_snapshot, forbidden_attr))
        for forbidden_attr in ("backup", "recover", "copy_file", "publish"):
            self.assertFalse(hasattr(claude_local_data, forbidden_attr))
        for forbidden_attr in ("render_html_report", "_write_text_safely"):
            self.assertFalse(hasattr(environment_report, forbidden_attr))

    def test_no_reserved_words_or_missing_external_script_names_in_plugin_files(self) -> None:
        build_script = REPO_ROOT / "scripts" / "build.py"
        reserved = (
            "ca" + "ge",
            "gu" + "est",
            "v" + "m",
            "virtual" + " machine",
            "\u865a\u62df\u673a",
            "\u5ba2\u673a",
        )
        if build_script.is_file():
            self.assertEqual(len(reserved), 6)
        stale_scripts = ("Test-ProxyState.ps1", "Manage-WindowsKillSwitch.ps1", "Inspect-WindowsFirewall.ps1")

        for path in sorted(PLUGIN_DIR.rglob("*")):
            if not path.is_file() or "__pycache__" in path.parts or path.suffix in (".pyc", ".png", ".svg"):
                continue
            rel = path.relative_to(PLUGIN_DIR).as_posix()
            text = path.read_text(encoding="utf-8")
            self.assertNotIn("\r\n", path.read_bytes().decode("utf-8"), f"CRLF found in {rel}")
            if rel != "tests/test_regressions.py":
                for script_name in stale_scripts:
                    self.assertNotIn(script_name, text, f"Stale script {script_name} referenced in {rel}")
            if rel == "plugin.json":
                data = json.loads(text)
                data.pop("engines", None)
                text = json.dumps(data, ensure_ascii=False)
            lowered = text.lower()
            words = set(re.split(r"[^a-z0-9\u0080-\U0010ffff]+", lowered))
            for word in reserved:
                hit = (word in lowered) if (" " in word or not word.isascii()) else (word in words)
                self.assertFalse(hit, f"{rel} contains reserved term {word!r}")


if __name__ == "__main__":
    unittest.main()
