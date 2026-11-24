"""Collect a strictly read-only, offline, redacted host environment report."""

import argparse
from datetime import datetime, timezone
import json
import locale
import os
from pathlib import Path
import platform
import stat
import subprocess
import sys

import audit_client_boundary
import claude_local_data
from config_snapshot import SnapshotError, checked_stat


ROOT = Path(__file__).resolve().parent
KIT_VERSION = "0.4.1"

IPV6_DEFAULT_PREFIXES = {"::/0", "::/1", "8000::/1"}


def _decode_json_bytes(raw):
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        encoding = locale.getpreferredencoding(False) or "utf-8"
        return raw.decode(encoding)


def _trusted_windows_system_root():
    """Resolve the Windows directory via Win32 API first, falling back to SystemRoot."""
    if sys.platform == "win32":
        try:
            import ctypes

            kernel32 = ctypes.WinDLL("kernel32.dll", use_last_error=True)
            get_sys_win_dir = kernel32.GetSystemWindowsDirectoryW
            get_sys_win_dir.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32]
            get_sys_win_dir.restype = ctypes.c_uint32
            buf = ctypes.create_unicode_buffer(520)
            length = get_sys_win_dir(buf, len(buf))
            if 0 < length < len(buf) and buf.value:
                return buf.value
        except (AttributeError, OSError):
            pass
    return (os.environ.get("SystemRoot") or "").strip()


def _windows_powershell(system_root):
    root = Path(system_root)
    powershell_path = Path("WindowsPowerShell") / "v1.0" / "powershell.exe"
    if os.environ.get("PROCESSOR_ARCHITEW6432"):
        sysnative = root / "Sysnative" / powershell_path
        if sysnative.is_file():
            return str(sysnative)
    return str(root / "System32" / powershell_path)


def _ensure_unlinked_script(script_path):
    try:
        info = checked_stat(script_path)
        return stat.S_ISREG(info.st_mode)
    except (OSError, SnapshotError):
        return False


def capture_json(command):
    try:
        run_kwargs = {
            "stdin": subprocess.DEVNULL,
            "capture_output": True,
            "timeout": 40,
            "check": False,
        }
        if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW"):
            run_kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        result = subprocess.run(command, **run_kwargs)
    except (OSError, subprocess.SubprocessError):
        return {"status": "unavailable", "reason": "collector-start-or-timeout"}
    if result.returncode != 0:
        return {"status": "unavailable", "reason": "collector-exit", "exitCode": result.returncode}
    try:
        data = json.loads(_decode_json_bytes(result.stdout))
    except (UnicodeError, ValueError):
        return {"status": "unavailable", "reason": "invalid-collector-output"}
    if not isinstance(data, dict):
        return {"status": "unavailable", "reason": "unexpected-collector-shape"}
    return {"status": "collected", "data": data}


def _collect_client_boundary(system, config_dir=None):
    boundary_script = ROOT / "audit_client_boundary.py"
    if not _ensure_unlinked_script(boundary_script):
        return {"status": "unavailable", "reason": "collector-script-invalid"}
    try:
        data = audit_client_boundary.collect_boundary_audit(
            system=system,
            config_dir=config_dir,
        )
    except Exception:
        return {"status": "unavailable", "reason": "boundary-audit-error"}
    if not isinstance(data, dict):
        return {"status": "unavailable", "reason": "unexpected-collector-shape"}
    return {"status": "collected", "data": data}


def _collect_claude_local_data(config_dir=None, project_dir=None):
    claude_script = ROOT / "claude_local_data.py"
    if not _ensure_unlinked_script(claude_script):
        return {"status": "unavailable", "reason": "collector-script-invalid"}
    try:
        data = claude_local_data.audit_default(
            config_dir=config_dir,
            project_dir=project_dir,
        )
    except (OSError, SnapshotError, ValueError):
        return {"status": "unavailable", "reason": "local-data-audit-error"}
    if not isinstance(data, dict):
        return {"status": "unavailable", "reason": "unexpected-collector-shape"}
    return {"status": "collected", "data": data}


def _has_observed_network_subsystem(network_data):
    if not isinstance(network_data, dict):
        return False
    if "Routing" in network_data or "Dns" in network_data or "Firewall" in network_data:
        routing = network_data.get("Routing") if isinstance(network_data.get("Routing"), dict) else {}
        dns = network_data.get("Dns") if isinstance(network_data.get("Dns"), dict) else {}
        firewall = network_data.get("Firewall") if isinstance(network_data.get("Firewall"), dict) else {}
        return (
            routing.get("ActiveStore") == "observed"
            or dns.get("AdapterResolvers") == "observed"
            or firewall.get("ActiveStore") == "observed"
        )
    if "default_routes" in network_data or "dns_configuration" in network_data:
        routes = network_data.get("default_routes") if isinstance(network_data.get("default_routes"), dict) else {}
        ipv4 = routes.get("ipv4") if isinstance(routes.get("ipv4"), dict) else {}
        ipv6 = routes.get("ipv6") if isinstance(routes.get("ipv6"), dict) else {}
        dns = network_data.get("dns_configuration") if isinstance(network_data.get("dns_configuration"), dict) else {}
        return (
            ipv4.get("status") == "observed"
            or ipv6.get("status") == "observed"
            or dns.get("status") == "observed"
        )
    return False


def _unix_route_interface_types(route_obj):
    if not isinstance(route_obj, dict):
        return set()
    mapping = route_obj.get("candidate_interface_types")
    if not isinstance(mapping, dict):
        mapping = route_obj.get("interface_types")
    if not isinstance(mapping, dict):
        return set()
    return {key for key, count in mapping.items() if count}


def _make_check(check_id, category, title, status, evidence_tier, detail):
    return {
        "id": check_id,
        "category": category,
        "title": title,
        "status": status,
        "evidenceTier": evidence_tier,
        "detail": detail,
    }


def _evaluate_routing_check(network_data):
    if not isinstance(network_data, dict):
        return _make_check(
            "routing_and_ipv6_surface",
            "network",
            "Default route and IPv6 surface",
            "unknown",
            "observed_local",
            "Network collector data unavailable; routing and IPv6 surface were not observed.",
        )
    if "Routing" in network_data:
        routing = network_data.get("Routing")
        if not isinstance(routing, dict) or routing.get("ActiveStore") != "observed":
            return _make_check(
                "routing_and_ipv6_surface",
                "network",
                "Default route and IPv6 surface",
                "unknown",
                "observed_local",
                "Windows ActiveStore routing table could not be observed.",
            )
        candidates = [
            row for row in (routing.get("Candidates") or [])
            if isinstance(row, dict)
        ]
        active_v4 = [
            row for row in candidates
            if row.get("AddressFamily") == "IPv4" and row.get("InterfaceState") != "Disconnected"
        ]
        active_v6 = [
            row for row in candidates
            if row.get("AddressFamily") == "IPv6"
            and row.get("InterfaceState") != "Disconnected"
            and row.get("DestinationPrefix") in IPV6_DEFAULT_PREFIXES
        ]
        untunnelled_v6 = [
            row for row in active_v6
            if row.get("InterfaceCategory") != "tunnel_candidate"
        ]
        if untunnelled_v6:
            return _make_check(
                "routing_and_ipv6_surface",
                "network",
                "Default route and IPv6 surface",
                "gap",
                "observed_local",
                f"Observed {len(untunnelled_v6)} active non-tunnel IPv6 default/split-default route candidate(s); "
                "confirm IPv6 is tunnelled or disabled to prevent dual-stack bypass.",
            )
        if not active_v4:
            return _make_check(
                "routing_and_ipv6_surface",
                "network",
                "Default route and IPv6 surface",
                "gap",
                "observed_local",
                "No active IPv4 default or split-default route candidate was observed.",
            )
        v4_has_tunnel = any(row.get("InterfaceCategory") == "tunnel_candidate" for row in active_v4)
        if v4_has_tunnel:
            return _make_check(
                "routing_and_ipv6_surface",
                "network",
                "Default route and IPv6 surface",
                "pass",
                "observed_local",
                f"Tunnel interface candidate observed in active Windows IPv4 routes ({len(active_v4)} active "
                "candidate(s), 0 untunnelled IPv6 default routes); per-process egress still depends on proxy rules.",
            )
        return _make_check(
            "routing_and_ipv6_surface",
            "network",
            "Default route and IPv6 surface",
            "gap",
            "observed_local",
            "No tunnel interface candidate observed in active Windows IPv4 default/split-default routes "
            "(standard non-tunnel egress only; if using an application-layer proxy without TUN, verify per-app binding).",
        )

    if "default_routes" in network_data:
        default_routes = network_data.get("default_routes") or {}
        split_routes = network_data.get("split_tunnel_routes") or {}
        ipv4 = default_routes.get("ipv4") if isinstance(default_routes, dict) else None
        ipv6 = default_routes.get("ipv6") if isinstance(default_routes, dict) else None
        if not isinstance(ipv4, dict) or ipv4.get("status") != "observed":
            return _make_check(
                "routing_and_ipv6_surface",
                "network",
                "Default route and IPv6 surface",
                "unknown",
                "observed_local",
                "Local IPv4 route table could not be observed.",
            )
        v4_types = _unix_route_interface_types(ipv4)
        split_v4 = split_routes.get("ipv4") if isinstance(split_routes, dict) else None
        v4_types.update(_unix_route_interface_types(split_v4))
        v6_types = set()
        v6_active = False
        if isinstance(ipv6, dict) and ipv6.get("status") == "observed":
            v6_active = (ipv6.get("forwarding_candidate_count") or 0) > 0
            v6_types.update(_unix_route_interface_types(ipv6))
        split_v6 = split_routes.get("ipv6") if isinstance(split_routes, dict) else None
        if isinstance(split_v6, dict) and split_v6.get("status") == "observed":
            if (split_v6.get("forwarding_candidate_count") or 0) > 0:
                v6_active = True
            v6_types.update(_unix_route_interface_types(split_v6))
        if v6_active and "tunnel_candidate" not in v6_types:
            return _make_check(
                "routing_and_ipv6_surface",
                "network",
                "Default route and IPv6 surface",
                "gap",
                "observed_local",
                "Active non-tunnel IPv6 default route candidate observed; confirm IPv6 is tunnelled or blocked.",
            )
        if "tunnel_candidate" in v4_types:
            return _make_check(
                "routing_and_ipv6_surface",
                "network",
                "Default route and IPv6 surface",
                "pass",
                "observed_local",
                "Tunnel interface candidate observed in local IPv4 routes; policy-routing precedence is not tested.",
            )
        return _make_check(
            "routing_and_ipv6_surface",
            "network",
            "Default route and IPv6 surface",
            "gap",
            "observed_local",
            "No tunnel interface candidate observed in local IPv4 default or split-tunnel routes.",
        )

    return _make_check(
        "routing_and_ipv6_surface",
        "network",
        "Default route and IPv6 surface",
        "unknown",
        "observed_local",
        "Unrecognized routing snapshot shape.",
    )


def _evaluate_dns_check(network_data):
    if not isinstance(network_data, dict):
        return _make_check(
            "system_dns_observations",
            "network",
            "System DNS and encrypted transport",
            "unknown",
            "observed_local",
            "Network collector data unavailable; DNS configuration was not observed.",
        )
    if "Dns" in network_data:
        dns = network_data.get("Dns")
        if not isinstance(dns, dict) or dns.get("AdapterResolvers") != "observed":
            return _make_check(
                "system_dns_observations",
                "network",
                "System DNS and encrypted transport",
                "unknown",
                "observed_local",
                "Windows adapter DNS resolvers could not be observed.",
            )
        interfaces = [row for row in (dns.get("Interfaces") or []) if isinstance(row, dict)]
        strict_doh = any(
            (row.get("AutoUpgradeCount") or 0) > 0 and (row.get("AutoUpgradeWithFallback") or 0) == 0
            for row in interfaces
        )
        if strict_doh:
            return _make_check(
                "system_dns_observations",
                "network",
                "System DNS and encrypted transport",
                "pass",
                "observed_local",
                "At least one adapter registers OS-level DoH auto-upgrade without UDP fallback; "
                "browser and app private DNS traffic remain unobserved.",
            )
        return _make_check(
            "system_dns_observations",
            "network",
            "System DNS and encrypted transport",
            "unknown",
            "observed_local",
            "Adapter resolvers observed without strict OS-level DoH auto-upgrade; live proxy DNS routing, "
            "port-53 firewall rules, and browser private DNS traffic are not verified by offline snapshots.",
        )

    if "dns_configuration" in network_data:
        dns = network_data.get("dns_configuration")
        if not isinstance(dns, dict) or dns.get("status") != "observed":
            return _make_check(
                "system_dns_observations",
                "network",
                "System DNS and encrypted transport",
                "unknown",
                "observed_local",
                "Local Unix resolver configuration could not be observed.",
            )
        source = dns.get("source") or "local"
        count = dns.get("configured_resolver_count", 0)
        return _make_check(
            "system_dns_observations",
            "network",
            "System DNS and encrypted transport",
            "unknown",
            "observed_local",
            f"Observed {count} configured resolver(s) via {source} (dns_transport_tested=false); "
            "encrypted DNS transport and browser/app DNS are not tested by read-only snapshots.",
        )

    return _make_check(
        "system_dns_observations",
        "network",
        "System DNS and encrypted transport",
        "unknown",
        "observed_local",
        "DNS configuration data was not present in network snapshot.",
    )


def _evaluate_firewall_check(platform_name, network_data):
    if platform_name != "Windows":
        return _make_check(
            "firewall_and_fail_closed",
            "firewall",
            "Firewall outbound policy and fail-closed verification",
            "unknown",
            "observed_local",
            f"Windows Firewall profile checks do not apply on {platform_name}; verify pf/nftables/iptables separately.",
        )
    if not isinstance(network_data, dict):
        return _make_check(
            "firewall_and_fail_closed",
            "firewall",
            "Firewall outbound policy and fail-closed verification",
            "unknown",
            "observed_local",
            "Windows network evidence unavailable; firewall profiles were not observed.",
        )
    firewall = network_data.get("Firewall")
    if not isinstance(firewall, dict) or firewall.get("ActiveStore") != "observed":
        return _make_check(
            "firewall_and_fail_closed",
            "firewall",
            "Firewall outbound policy and fail-closed verification",
            "unknown",
            "observed_local",
            "Windows Firewall ActiveStore profiles could not be observed.",
        )
    profiles = [row for row in (firewall.get("Profiles") or []) if isinstance(row, dict)]
    if not profiles:
        return _make_check(
            "firewall_and_fail_closed",
            "firewall",
            "Firewall outbound policy and fail-closed verification",
            "unknown",
            "observed_local",
            "No Windows Firewall profile entries were returned.",
        )
    disabled = [str(row.get("Profile") or "?") for row in profiles if str(row.get("Enabled")) != "True"]
    if disabled:
        return _make_check(
            "firewall_and_fail_closed",
            "firewall",
            "Firewall outbound policy and fail-closed verification",
            "gap",
            "observed_local",
            f"Disabled Windows Firewall profile(s): {', '.join(disabled)}.",
        )
    bypass = firewall.get("OutboundAllowBypass") if isinstance(firewall.get("OutboundAllowBypass"), dict) else {}
    bypass_count = int(bypass.get("ClaudeAllowRuleCount") or 0) if bypass.get("Status") == "observed" else 0
    msix_count = int(bypass.get("MsixPackageAllowRuleCount") or 0) if bypass.get("Status") == "observed" else 0

    allow_profiles = [
        str(row.get("Profile") or "?")
        for row in profiles
        if str(row.get("DefaultOutboundAction")) != "Block"
    ]
    if allow_profiles:
        extra_note = (
            f" Also observed {bypass_count} active native Claude/MSIX outbound Allow rule(s)."
            if bypass_count > 0
            else ""
        )
        return _make_check(
            "firewall_and_fail_closed",
            "firewall",
            "Firewall outbound policy and fail-closed verification",
            "gap",
            "observed_local",
            f"DefaultOutboundAction is not Block on {', '.join(allow_profiles)} "
            f"(typical when host-wide outbound blocking is not enabled).{extra_note}",
        )
    if bypass_count > 0:
        return _make_check(
            "firewall_and_fail_closed",
            "firewall",
            "Firewall outbound policy and fail-closed verification",
            "gap",
            "observed_local",
            f"All active firewall profiles set DefaultOutboundAction=Block, but {bypass_count} active outbound "
            f"Allow rule(s) matching native Claude/MSIX packages (MSIX={msix_count}) can bypass default blocking.",
        )
    if network_data.get("FailClosedVerified") is True:
        return _make_check(
            "firewall_and_fail_closed",
            "firewall",
            "Firewall outbound policy and fail-closed verification",
            "pass",
            "observed_local",
            "All firewall profiles default-block outbound traffic with 0 native Claude/MSIX Allow bypasses "
            "and recorded fail-closed verification.",
        )
    return _make_check(
        "firewall_and_fail_closed",
        "firewall",
        "Firewall outbound policy and fail-closed verification",
        "unknown",
        "observed_local",
        "All active firewall profiles set DefaultOutboundAction=Block (0 native Claude/MSIX outbound Allow "
        "rules observed), but live tunnel-disconnect fail-closed behavior cannot be verified offline.",
    )


def build_tri_state_summary(report):
    platform_name = report.get("platform") or "unknown"
    network = report.get("network") if isinstance(report.get("network"), dict) else {}
    network_data = (
        network.get("data")
        if network.get("status") == "collected" and isinstance(network.get("data"), dict)
        else None
    )
    boundary = report.get("clientBoundary") if isinstance(report.get("clientBoundary"), dict) else {}
    boundary_data = (
        boundary.get("data")
        if boundary.get("status") == "collected" and isinstance(boundary.get("data"), dict)
        else None
    )
    local_data = report.get("claudeLocalData") if isinstance(report.get("claudeLocalData"), dict) else {}
    local_payload = (
        local_data.get("data")
        if local_data.get("status") == "collected" and isinstance(local_data.get("data"), dict)
        else None
    )

    checks = []
    if network_data is not None and _has_observed_network_subsystem(network_data):
        checks.append(_make_check(
            "network_collector",
            "network",
            "Local network evidence collection",
            "pass",
            "observed_local",
            f"Read-only local network observations collected for {platform_name}.",
        ))
    elif network_data is not None:
        checks.append(_make_check(
            "network_collector",
            "network",
            "Local network evidence collection",
            "unknown",
            "observed_local",
            f"Collector ran on {platform_name}, but all local routing, DNS, and firewall sub-checks returned unavailable.",
        ))
    else:
        reason = network.get("reason") or network.get("status") or "missing"
        checks.append(_make_check(
            "network_collector",
            "network",
            "Local network evidence collection",
            "unknown",
            "observed_local",
            f"Network collector unavailable ({reason}); network state was not verified.",
        ))

    checks.append(_evaluate_routing_check(network_data))
    checks.append(_evaluate_dns_check(network_data))
    checks.append(_evaluate_firewall_check(platform_name, network_data))

    if boundary_data is None:
        reason = boundary.get("reason") or boundary.get("status") or "missing"
        checks.append(_make_check(
            "host_client_boundary",
            "client_boundary",
            "Host native client boundary",
            "unknown",
            "static_config",
            f"Client boundary audit unavailable ({reason}).",
        ))
        checks.append(_make_check(
            "cli_anti_telemetry_switches",
            "client_boundary",
            "Claude CLI 5 anti-telemetry switches",
            "unknown",
            "static_config",
            f"Client boundary audit unavailable ({reason}).",
        ))
        checks.append(_make_check(
            "local_mcp_host_bridges",
            "client_boundary",
            "Local MCP / host-tool bridges",
            "unknown",
            "static_config",
            f"Client boundary audit unavailable ({reason}).",
        ))
    else:
        footprints = boundary_data.get("localClientFootprints") or {}
        has_desktop = bool(
            footprints.get("claudeDesktopDataPresent") or footprints.get("claudeDesktopMsixPresent")
        )
        has_cli = bool(
            footprints.get("claudeCliConfigDirPresent") or footprints.get("claudeCliStateFilePresent")
        )
        env_flags = boundary_data.get("environmentVariableFlags") or {}
        base_url_set = bool(env_flags.get("ANTHROPIC_BASE_URL_set"))
        if has_desktop:
            checks.append(_make_check(
                "host_client_boundary",
                "client_boundary",
                "Host native client boundary",
                "gap",
                "static_config",
                "Native Claude Desktop footprint detected on host; Desktop reads host OS locale/timezone and "
                "issues cold-start requests (Sentry, updates, events) even when logged out.",
            ))
        elif has_cli or base_url_set:
            checks.append(_make_check(
                "host_client_boundary",
                "client_boundary",
                "Host native client boundary",
                "gap",
                "static_config",
                "Host Claude CLI footprint or ANTHROPIC_BASE_URL detected; keep host CLI sessions separated "
                "from isolated browser profiles.",
            ))
        else:
            checks.append(_make_check(
                "host_client_boundary",
                "client_boundary",
                "Host native client boundary",
                "pass",
                "static_config",
                "No native Claude Desktop or CLI footprints detected in default host locations.",
            ))

        anti_flags = boundary_data.get("cliAntiTelemetryFlags") or {}
        enabled_count = sum(1 for val in anti_flags.values() if val is True)
        total_flags = len(anti_flags) or 5
        if not has_cli:
            checks.append(_make_check(
                "cli_anti_telemetry_switches",
                "client_boundary",
                "Claude CLI 5 anti-telemetry switches",
                "pass",
                "static_config",
                f"No host Claude CLI footprint detected ({enabled_count}/{total_flags} switches set in env).",
            ))
        elif enabled_count == total_flags:
            checks.append(_make_check(
                "cli_anti_telemetry_switches",
                "client_boundary",
                "Claude CLI 5 anti-telemetry switches",
                "pass",
                "static_config",
                f"All {total_flags}/{total_flags} Claude CLI anti-telemetry switches are enabled.",
            ))
        else:
            checks.append(_make_check(
                "cli_anti_telemetry_switches",
                "client_boundary",
                "Claude CLI 5 anti-telemetry switches",
                "gap",
                "static_config",
                f"Only {enabled_count}/{total_flags} Claude CLI anti-telemetry switches are enabled; "
                "unset switches allow background telemetry, GrowthBook, or update checks.",
            ))

        mcp = boundary_data.get("localMcpBridges") or {}
        mcp_total = int(mcp.get("claudeDesktopMcpServerCount") or 0) + int(mcp.get("claudeCliMcpServerCount") or 0)
        if mcp_total > 0:
            checks.append(_make_check(
                "local_mcp_host_bridges",
                "client_boundary",
                "Local MCP / host-tool bridges",
                "gap",
                "static_config",
                f"Detected {mcp_total} configured local MCP server entry/entries; host-side MCP tools run in "
                "the host OS context and can expose host timezone or filesystem metadata.",
            ))
        else:
            checks.append(_make_check(
                "local_mcp_host_bridges",
                "client_boundary",
                "Local MCP / host-tool bridges",
                "pass",
                "static_config",
                "No local Claude Desktop or CLI MCP server bridges configured.",
            ))

    if local_payload is not None:
        file_count = int(local_payload.get("files") or 0)
        byte_count = int(local_payload.get("bytes") or 0)
        checks.append(_make_check(
            "claude_local_data_audit",
            "local_data",
            "Redacted local Claude data inventory",
            "pass",
            "static_config",
            f"Inventory collected ({file_count} file(s), {byte_count} bytes); file contents were not read.",
        ))
    else:
        reason = local_data.get("reason") or local_data.get("status") or "missing"
        checks.append(_make_check(
            "claude_local_data_audit",
            "local_data",
            "Redacted local Claude data inventory",
            "unknown",
            "static_config",
            f"Local Claude data audit unavailable ({reason}).",
        ))

    checks.append(_make_check(
        "exit_ip_reputation",
        "external_blind_spot",
        "Exit IP historical reputation and proxy-pool databases",
        "unknown",
        "external_blind_spot",
        "Local offline reports never query external IP reputation or proxy-pool databases "
        "(such as Spur, IPQS, or MaxMind) or verify public exit history. Treat exit reputation as unknown.",
    ))
    checks.append(_make_check(
        "runtime_environment_and_policy_boundaries",
        "external_blind_spot",
        "Runtime GPU/TPM health and platform Terms/regional policy",
        "unknown",
        "external_blind_spot",
        "Network-layer checks do not inspect runtime GPU/WebGL blocklists, hardware TPM attestation, "
        "isolated desktop graphics stability, or platform Terms of Service and regional eligibility.",
    ))

    counts = {"pass": 0, "gap": 0, "unknown": 0}
    tiers = {"observed_local": 0, "static_config": 0, "external_blind_spot": 0}
    for item in checks:
        counts[item["status"]] += 1
        tiers[item["evidenceTier"]] += 1

    blind_spots = [item["id"] for item in checks if item["status"] == "unknown"]
    return {
        "counts": counts,
        "totalChecks": len(checks),
        "evidenceTiers": tiers,
        "blindSpots": blind_spots,
        "checks": checks,
    }


def build_report(system, config_dir=None, project_dir=None, evidence_directory=None):
    report = {
        "schemaVersion": 2,
        "kitVersion": KIT_VERSION,
        "generatedAtUtc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platform": system,
        "scope": "Local observations only. No route, DNS, or disconnection guarantee.",
    }
    if system not in {"Windows", "Darwin", "Linux"}:
        report["status"] = "unsupported-platform"
        return report

    if system == "Windows":
        system_root = _trusted_windows_system_root()
        win_collector = ROOT / "Collect-WindowsEvidence.ps1"
        if not system_root:
            report["network"] = {"status": "unavailable", "reason": "windows-system-root-unset"}
        elif not _ensure_unlinked_script(win_collector):
            report["network"] = {"status": "unavailable", "reason": "collector-script-invalid"}
        else:
            command = [
                _windows_powershell(system_root),
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(win_collector),
            ]
            if evidence_directory is not None:
                command.extend(["-EvidenceDirectory", os.path.abspath(evidence_directory)])
            report["network"] = capture_json(command)
    else:
        unix_collector = ROOT / "inspect_unix_network.py"
        if not _ensure_unlinked_script(unix_collector):
            report["network"] = {"status": "unavailable", "reason": "collector-script-invalid"}
        else:
            report["network"] = capture_json([sys.executable, "-B", str(unix_collector)])

    report["claudeLocalData"] = _collect_claude_local_data(config_dir=config_dir, project_dir=project_dir)
    report["clientBoundary"] = _collect_client_boundary(system, config_dir=config_dir)
    report["summary"] = build_tri_state_summary(report)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config-dir", type=Path, help="Override the Claude configuration directory.")
    parser.add_argument("--project-dir", type=Path, help="Inspect one explicit project configuration.")
    parser.add_argument("--evidence-directory", type=Path, help="Windows-only saved probe results.")
    args = parser.parse_args(argv)

    system = platform.system()
    if args.evidence_directory is not None and system != "Windows":
        parser.error("--evidence-directory is only supported on Windows")
    report = build_report(system, args.config_dir, args.project_dir, args.evidence_directory)
    print(json.dumps(report, indent=2, ensure_ascii=True))
    if report.get("status") == "unsupported-platform":
        return 2
    required_keys = ("network", "claudeLocalData", "clientBoundary")
    return 0 if all(
        isinstance(report.get(key), dict) and report[key].get("status") == "collected"
        for key in required_keys
    ) else 2


if __name__ == "__main__":
    sys.exit(main())
