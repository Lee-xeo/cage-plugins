# Privacy Boundary Audit

Offline, strictly read-only host network and client privacy boundary audit plugin (`kind: "host"`), built on [cross-platform-privacy-environment-kit](https://github.com/rumpelpalmour757-lgtm/cross-platform-privacy-environment-kit) (`v0.4.1`, MIT).

## What It Does

- **Unified Tri-State Health Report (`privacy_boundary_report`)**: Collects redacted host network, routing, IPv6, DNS, and firewall observations together with local client footprints, CLI anti-telemetry switches, local MCP bridge counts, and a 10-check tri-state summary (`pass` / `gap` / `unknown`) classified by evidence tier (`observed_local`, `static_config`, `external_blind_spot`).
- **Fast Host Client Boundary Audit (`privacy_client_boundary`)**: Quickly inspects host OS timezone, UTC offset, locale, native Desktop / MSIX / CLI data footprints, the 5 CLI anti-telemetry switches (`DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`, `DISABLE_GROWTHBOOK`), and local MCP server counts.
- **Offline Web Login Triage Checklist (`privacy_web_login_triage`)**: Provides a structured stage-by-stage troubleshooting checklist distinguishing challenge widget load failures, challenge loops, and post-challenge site notices, along with redaction reminders.
- **Interactive Workbench View**: Displays tri-state summary cards, evidence-tier filters, host boundary switches, login triage steps, and one-click redacted Markdown report copy (`ui/copy`) with automatic light/dark theme synchronization.

## Why `host`?

This plugin audits the **host computer** itself (host OS routing tables, host firewall outbound policies, host resolver settings, host timezone/locale, and host-installed native clients/MCP configurations) so users can verify host-side boundaries without modifying any settings.

## Runtime & Dependencies

- Pure **Python 3 standard library** (`python3`), zero third-party packages, zero runtime downloads.
- On Windows, invokes built-in Windows PowerShell (`Collect-WindowsEvidence.ps1`, read-only) to inspect active routing, DNS, and firewall profiles.
- On macOS and Linux, invokes bundled pure-Python `inspect_unix_network.py` (read-only) to inspect local route and resolver metadata.

## Security & Data Flow

- **100% Offline**: Makes **zero** outbound or inbound network connections.
- **Strictly Read-Only**: Does **not** write files, change firewall/DNS/proxy rules, or modify any user configuration.
- **Redacted by Default**: Omits personal paths, usernames, tokens, API keys, proxy credentials, interface names, and MCP command strings; reports only boolean footprints, counts, and coarse status labels.
- **Honest Blind Spots**: External exit IP reputation, runtime graphics/TPM health, and service-provider regional policies are explicitly marked `unknown` (`external_blind_spot`) rather than falsely marked `pass`.

## License

MIT — see [LICENSE](LICENSE).
