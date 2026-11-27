"""Unit, security, isolation, Windows-shim, protocol, and reserved-word tests for local-ai-bridge."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PLUGIN_DIR))

from core.providers.antigravity import AntigravityProvider, parse_agy_models_output  # noqa: E402
from core.providers.base import AIProvider, ModelInfo, ProviderStatus, TaskHandle, TurnRequest, TurnResult  # noqa: E402
from core.providers.codex import CodexProvider  # noqa: E402
from core.providers.grok import GrokProvider, parse_grok_models_output  # noqa: E402
from core.runner import TaskRunner  # noqa: E402
from core.security import (  # noqa: E402
    build_cli_env,
    has_reserved_words,
    mask_proxy_config,
    redact_proxy_credentials,
    resolve_cli_command,
    resolve_effective_mode,
    resolve_project_file,
    resolve_prompt_input,
    sanitize_diagnostic,
    validate_proxy_url,
)
from core.store import StateStore  # noqa: E402
import server  # noqa: E402


class FakeProvider(AIProvider):
    id = "codex"
    display_name = "Fake Codex"
    capabilities = ("read-only", "workspace-write", "full-access", "multi-turn")

    def __init__(self, delay: float = 0.05) -> None:
        self.delay = delay
        self.calls: list[TurnRequest] = []
        self.probe_count = 0

    def probe(
        self,
        bin_override: str | None = None,
        env: dict[str, str] | None = None,
        project_dir: str = "",
    ) -> ProviderStatus:
        self.probe_count += 1
        return ProviderStatus(available=True, authenticated=True, version="fake 1.0", binary_path="/usr/bin/fake")

    def list_models(
        self,
        bin_override: str | None = None,
        env: dict[str, str] | None = None,
        project_dir: str = "",
    ) -> list[ModelInfo]:
        return [ModelInfo(id="fake-model", display_name="Fake Model", is_default=True, efforts=["low", "high"])]

    def run_turn(self, req: TurnRequest, handle: TaskHandle) -> TurnResult:
        self.calls.append(req)
        handle.set_provider_session_id(req.provider_session_id or "prov-sess-123")
        handle.emit_activity("thinking", "reasoning", "analyzing")
        deadline = time.monotonic() + self.delay
        while time.monotonic() < deadline:
            if handle.cancel_event.is_set():
                return TurnResult(ok=False, error="cancelled")
            time.sleep(0.01)
        handle.append_delta("hello ")
        handle.append_delta("world")
        return TurnResult(
            ok=True,
            answer=f"echo:{req.mode}:{req.prompt}",
            provider_session_id=req.provider_session_id or "prov-sess-123",
            usage={"total_tokens": 42},
        )


class SecurityAndPolicyTests(unittest.TestCase):
    def test_reserved_words_clean_in_manifest_i18n_and_tools(self) -> None:
        manifest = json.loads((PLUGIN_DIR / "plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(has_reserved_words(manifest["displayName"]), [])
        self.assertEqual(has_reserved_words(manifest["description"]), [])

        i18n = json.loads((PLUGIN_DIR / "i18n.json").read_text(encoding="utf-8"))
        self.assertEqual(len(i18n), 15)
        for locale, entry in i18n.items():
            hits = has_reserved_words(json.dumps(entry, ensure_ascii=False))
            self.assertEqual(hits, [], f"i18n[{locale}] leaked reserved words: {hits}")

        tools_file = json.loads((PLUGIN_DIR / "tools.json").read_text(encoding="utf-8"))
        self.assertEqual(tools_file["tools"], server.TOOLS)
        for tool in server.TOOLS:
            blob = json.dumps(tool, ensure_ascii=False)
            hits = has_reserved_words(blob)
            self.assertEqual(hits, [], f"Tool {tool['name']} leaked reserved words: {hits}")

    def test_view_has_no_sandbox_blocked_forms(self) -> None:
        html = (PLUGIN_DIR / "view" / "index.html").read_text(encoding="utf-8").lower()
        self.assertNotIn("<form", html)
        self.assertNotIn('type="submit"', html)

    def test_prompt_file_jail(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            proj = Path(tmp) / "proj"
            proj.mkdir()
            outside = Path(tmp) / "secret.txt"
            outside.write_text("secret", encoding="utf-8")
            inside = proj / "prompt.txt"
            inside.write_text("Review main.py", encoding="utf-8")

            resolved = resolve_project_file("prompt.txt", str(proj))
            self.assertEqual(resolved, inside.resolve())
            self.assertEqual(resolve_prompt_input(None, "prompt.txt", str(proj)), "Review main.py")

            with self.assertRaises(ValueError):
                resolve_project_file("../secret.txt", str(proj))
            with self.assertRaises(ValueError):
                resolve_project_file(str(outside), str(proj))

            link = proj / "escape.txt"
            try:
                link.symlink_to(outside)
            except OSError:
                self.skipTest("Symlink creation requires elevated privileges on this platform.")
            with self.assertRaises(ValueError):
                resolve_project_file("escape.txt", str(proj))

    def test_default_read_only_gate(self) -> None:
        policy = {
            "allow_write": False,
            "allow_full_access": False,
            "providers": {"codex": {"enabled": True, "allow_write": False, "allow_full_access": False}},
        }
        self.assertEqual(resolve_effective_mode(None, "codex", policy), "read-only")
        with self.assertRaises(PermissionError):
            resolve_effective_mode("workspace-write", "codex", policy)
        with self.assertRaises(PermissionError):
            resolve_effective_mode("full-access", "codex", policy)

        policy["providers"]["codex"]["allow_write"] = True
        self.assertEqual(resolve_effective_mode("workspace-write", "codex", policy), "workspace-write")
        with self.assertRaises(PermissionError):
            resolve_effective_mode("full-access", "codex", policy)

        policy["providers"]["codex"]["allow_write"] = False
        policy["providers"]["codex"]["allow_full_access"] = True
        self.assertEqual(resolve_effective_mode("full-access", "codex", policy), "full-access")
        self.assertEqual(resolve_effective_mode("workspace-write", "codex", policy), "workspace-write")

    def test_proxy_validation_redaction_and_env_injection(self) -> None:
        self.assertEqual(validate_proxy_url("http://127.0.0.1:7890"), "http://127.0.0.1:7890")
        self.assertEqual(validate_proxy_url("socks5://user:s3cr3t@127.0.0.1:7890"), "socks5://user:s3cr3t@127.0.0.1:7890")
        self.assertEqual(
            redact_proxy_credentials("Failed via http://alice:pw123@127.0.0.1:7890/"),
            "Failed via http://***@127.0.0.1:7890/",
        )
        self.assertNotIn("pw123", sanitize_diagnostic("proxy http://alice:pw123@127.0.0.1:7890 failed"))

        with self.assertRaises(ValueError):
            validate_proxy_url("ftp://127.0.0.1:7890")
        with self.assertRaises(ValueError):
            validate_proxy_url("http://127.0.0.1:7890\nBAD=1")

        policy = {
            "proxy": {
                "enabled": True,
                "http_proxy": "http://alice:secret@127.0.0.1:7890",
                "https_proxy": "http://127.0.0.1:7890",
                "all_proxy": "socks5://127.0.0.1:7890",
                "no_proxy": "127.0.0.1,localhost,::1",
            }
        }
        masked = mask_proxy_config(policy["proxy"])
        self.assertEqual(masked["http_proxy"], "http://***@127.0.0.1:7890")

        env = build_cli_env(policy)
        self.assertEqual(env["http_proxy"], "http://alice:secret@127.0.0.1:7890")
        self.assertEqual(env["HTTP_PROXY"], "http://alice:secret@127.0.0.1:7890")
        self.assertEqual(env["https_proxy"], "http://127.0.0.1:7890")
        self.assertEqual(env["HTTPS_PROXY"], "http://127.0.0.1:7890")
        self.assertEqual(env["all_proxy"], "socks5://127.0.0.1:7890")
        self.assertEqual(env["ALL_PROXY"], "socks5://127.0.0.1:7890")
        self.assertEqual(env["no_proxy"], "127.0.0.1,localhost,::1")
        self.assertEqual(env["NO_PROXY"], "127.0.0.1,localhost,::1")

        with tempfile.TemporaryDirectory() as tmp:
            store = StateStore(Path(tmp), project_dir=tmp)
            saved = store.update_policy(policy)
            self.assertTrue(saved["proxy"]["enabled"])
            # Re-saving masked value preserves existing stored credential
            saved2 = store.update_policy({"proxy": {"http_proxy": "http://***@127.0.0.1:7890"}})
            self.assertEqual(saved2["proxy"]["http_proxy"], "http://alice:secret@127.0.0.1:7890")

    def test_windows_cmd_shim_unwrapping_and_project_binary_rejection(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bin_dir = root / "npm"
            entry_js = bin_dir / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
            entry_js.parent.mkdir(parents=True)
            entry_js.write_text("// stub", encoding="utf-8")
            cmd_shim = bin_dir / "codex.cmd"
            cmd_shim.write_text('@"%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n', encoding="utf-8")
            bad_cmd = bin_dir / "unwrappable.cmd"
            bad_cmd.write_text("@echo hi\r\n", encoding="utf-8")
            proj = root / "proj"
            proj.mkdir()
            evil_exe = proj / "codex.exe"
            evil_exe.write_bytes(b"MZ")

            resolved = resolve_cli_command(
                "codex",
                "AI_BRIDGE_TEST_NONE",
                policy_override=str(cmd_shim),
                npm_rel_entries=("node_modules/@openai/codex/bin/codex.js",),
                project_dir=str(proj),
                platform_name="win32",
                node_exe="C:/Program Files/nodejs/node.exe",
            )
            self.assertEqual(resolved, ["C:/Program Files/nodejs/node.exe", str(entry_js)])

            # Raw unwrappable .cmd is rejected (never run via cmd.exe)
            rejected_cmd = resolve_cli_command(
                "codex",
                "AI_BRIDGE_TEST_NONE",
                policy_override=str(bad_cmd),
                project_dir=str(proj),
                platform_name="win32",
                node_exe="C:/Program Files/nodejs/node.exe",
            )
            self.assertIsNone(rejected_cmd)

            # Executable inside project_dir is rejected
            rejected_proj = resolve_cli_command(
                "codex",
                "AI_BRIDGE_TEST_NONE",
                policy_override=str(evil_exe),
                project_dir=str(proj),
                platform_name="win32",
                node_exe="C:/Program Files/nodejs/node.exe",
            )
            self.assertIsNone(rejected_proj)

    def test_strict_schema_validation(self) -> None:
        # Reject bool masquerading as integer
        with self.assertRaises(ValueError):
            server.validate_tool_args("ai_task_status", {"task_id": "abc", "wait_seconds": True})
        # Reject unknown extra keys
        with self.assertRaises(ValueError):
            server.validate_tool_args("ai_list_providers", {"extra": 1})
        # Reject out-of-range integer
        with self.assertRaises(ValueError):
            server.validate_tool_args("ai_task_status", {"task_id": "abc", "wait_seconds": 99})
        # Valid call passes
        validated = server.validate_tool_args("ai_task_status", {"task_id": "abc", "wait_seconds": 5})
        self.assertEqual(validated["wait_seconds"], 5)


class ParserAndHardReadOnlyTests(unittest.TestCase):
    def test_parse_grok_models(self) -> None:
        sample = (
            "You are not authenticated.\n\nDefault model: grok-4.6\n\n"
            "Available models:\n  * grok-4.6 (default)\n  - grok-4.5\n"
        )
        models, auth = parse_grok_models_output(sample)
        self.assertIs(auth, False)
        self.assertEqual([m.id for m in models], ["grok-4.6", "grok-4.5"])
        self.assertTrue(models[0].is_default)

    def test_parse_agy_models(self) -> None:
        sample = "Fetching available models...\ngemini-4-neon-high\tGemini 4 Neon (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n"
        models = parse_agy_models_output(sample)
        self.assertEqual(len(models), 2)
        self.assertEqual(models[0].id, "gemini-4-neon-high")
        self.assertTrue(models[0].is_default)

    def test_hard_readonly_argv_for_all_providers(self) -> None:
        codex_ro = CodexProvider()._build_argv(
            ["/usr/bin/codex"],
            TurnRequest(prompt="audit", project_dir="/tmp", mode="read-only"),
            platform_name="win32",
        )
        self.assertIn("--ignore-user-config", codex_ro)
        self.assertIn("--ignore-rules", codex_ro)
        self.assertIn('web_search="disabled"', codex_ro)
        self.assertIn('windows.sandbox="unelevated"', codex_ro)
        self.assertEqual(codex_ro[-1], "-")

        grok_ro = GrokProvider()._build_argv(
            ["/usr/bin/grok"],
            TurnRequest(prompt="audit & %PATH%", project_dir="/tmp", mode="read-only"),
            session_uuid="11111111-1111-1111-1111-111111111111",
            is_resume=False,
            prompt_file_path="/tmp/prompt.txt",
        )
        self.assertIn("--tools", grok_ro)
        self.assertIn("read_file,list_dir,grep", grok_ro)
        self.assertIn("--disallowed-tools", grok_ro)
        self.assertIn("--disable-web-search", grok_ro)
        self.assertIn("--no-subagents", grok_ro)
        self.assertIn("--prompt-file", grok_ro)
        self.assertNotIn("-p", grok_ro)

        agy_ro = AntigravityProvider()._build_argv(
            ["/usr/bin/agy"],
            TurnRequest(prompt="audit & %PATH%", project_dir="/tmp", mode="read-only"),
            settings_path="/tmp/agy-ro.json",
        )
        self.assertIn("--input-format", agy_ro)
        self.assertIn("stream-json", agy_ro)
        self.assertIn("--disable-slash-commands", agy_ro)
        self.assertIn("--settings", agy_ro)
        self.assertNotIn("--sandbox", agy_ro)
        self.assertFalse(any(a.startswith("--print") for a in agy_ro))

    def test_full_access_argv_for_all_providers(self) -> None:
        codex_argv = CodexProvider()._build_argv(
            ["/usr/bin/codex"],
            TurnRequest(prompt="open chrome", project_dir="/tmp", mode="full-access"),
        )
        self.assertIn("danger-full-access", codex_argv)
        self.assertNotIn("plugins", codex_argv)
        self.assertNotIn("apps", codex_argv)

        grok_argv = GrokProvider()._build_argv(
            ["/usr/bin/grok"],
            TurnRequest(prompt="open chrome", project_dir="/tmp", mode="full-access"),
            session_uuid="11111111-1111-1111-1111-111111111111",
            is_resume=False,
            prompt_file_path="/tmp/prompt.txt",
        )
        self.assertIn("bypassPermissions", grok_argv)
        self.assertIn("--always-approve", grok_argv)

        agy_argv = AntigravityProvider()._build_argv(
            ["/usr/bin/agy"],
            TurnRequest(prompt="open chrome", project_dir="/tmp", mode="full-access"),
        )
        self.assertIn("--dangerously-skip-permissions", agy_argv)
        self.assertNotIn("--sandbox", agy_argv)
        self.assertNotIn("--settings", agy_argv)


class RunnerIsolationAndProtocolTests(unittest.TestCase):
    def test_per_project_isolation_and_redaction(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / "state"
            proj_a = Path(tmp) / "proj-a"
            proj_b = Path(tmp) / "proj-b"
            proj_a.mkdir()
            proj_b.mkdir()

            fake_a = FakeProvider(delay=0.02)
            fake_b = FakeProvider(delay=0.02)
            runner_a = TaskRunner(str(proj_a), StateStore(state_dir, str(proj_a)), {"codex": fake_a})
            runner_b = TaskRunner(str(proj_b), StateStore(state_dir, str(proj_b)), {"codex": fake_b})
            try:
                # Model-facing ai_list_providers hides host binary_path & project_dir
                info = runner_a.list_providers()
                self.assertNotIn("project_dir", info)
                self.assertNotIn("binary_path", info["providers"][0])
                self.assertTrue(info["providers"][0]["binary_detected"])

                # Probe caching prevents repeated subprocess probes during rapid polling
                runner_a.list_providers()
                self.assertEqual(fake_a.probe_count, 1)
                runner_a.list_providers(refresh=True)
                self.assertEqual(fake_a.probe_count, 2)

                started = runner_a.start_task(provider_id="codex", prompt="hello A")
                done = runner_a.get_task_status(started["task_id"], wait_seconds=5)
                self.assertEqual(done["status"], "completed")

                # Project B cannot read, cancel, or delete Project A's session/task
                self.assertEqual(runner_b.get_session_history()["sessions"], [])
                with self.assertRaises(ValueError):
                    runner_b.get_session_history(session_id=started["session_id"])
                with self.assertRaises(ValueError):
                    runner_b.get_task_status(started["task_id"])
                del_res = runner_b.manage_policy("delete_session", {"session_id": started["session_id"]})
                self.assertFalse(del_res["ok"])
                # Project A's session is still intact even after Project B clears its finished tasks
                runner_b.manage_policy("clear_finished_tasks")
                self.assertEqual(len(runner_a.get_session_history()["sessions"]), 1)
            finally:
                runner_a.shutdown()
                runner_b.shutdown()

    def test_async_run_multiturn_cancel_and_shutdown_wakeup(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            proj = Path(tmp) / "repo"
            proj.mkdir()
            store = StateStore(Path(tmp) / "state", str(proj))
            fake = FakeProvider(delay=0.05)
            runner = TaskRunner(str(proj), store, {"codex": fake})
            try:
                started = runner.start_task(provider_id="codex", prompt="first turn", request_id="req-1")
                dup = runner.start_task(provider_id="codex", prompt="first turn", request_id="req-1")
                self.assertEqual(started["task_id"], dup["task_id"])

                done = runner.get_task_status(started["task_id"], wait_seconds=5)
                self.assertEqual(done["status"], "completed")
                self.assertEqual(done["answer"], "echo:read-only:first turn")

                second = runner.start_task(
                    provider_id="codex",
                    session_id=started["session_id"],
                    prompt="second turn",
                )
                done2 = runner.get_task_status(second["task_id"], wait_seconds=5)
                self.assertEqual(done2["status"], "completed")
                self.assertEqual(fake.calls[-1].provider_session_id, "prov-sess-123")
                hist = runner.get_session_history(session_id=started["session_id"])
                self.assertEqual(len(hist["turns"]), 4)
            finally:
                runner.shutdown()

            # Verify shutdown wakes a 25s wait immediately
            fake_slow = FakeProvider(delay=10.0)
            runner2 = TaskRunner(str(proj), StateStore(Path(tmp) / "state2", str(proj)), {"codex": fake_slow})
            started_slow = runner2.start_task(provider_id="codex", prompt="slow")
            t0 = time.monotonic()
            threading.Timer(0.15, lambda: runner2.shutdown(wait_workers=False)).start()
            runner2.get_task_status(started_slow["task_id"], wait_seconds=25)
            self.assertLess(time.monotonic() - t0, 2.0)

    def test_mcp_stdio_protocol_smoke(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            proj = Path(tmp) / "repo"
            proj.mkdir()
            env = dict(os.environ)
            env["AI_BRIDGE_STATE_DIR"] = str(Path(tmp) / "state")
            proc = subprocess.Popen(
                [sys.executable, str(PLUGIN_DIR / "server.py"), "--project-dir", str(proj)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
            )
            assert proc.stdin and proc.stdout
            try:
                reqs = [
                    {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}},
                    {"jsonrpc": "2.0", "method": "notifications/initialized"},
                    {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                    {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "ai_dashboard_state", "arguments": {}}},
                    {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "ai_task_status", "arguments": {"task_id": "x", "wait_seconds": True}}},
                ]
                for r in reqs:
                    proc.stdin.write(json.dumps(r) + "\n")
                proc.stdin.flush()
                proc.stdin.close()

                responses = {}
                for line in proc.stdout:
                    obj = json.loads(line)
                    responses[obj["id"]] = obj

                self.assertEqual(responses[1]["result"]["serverInfo"]["name"], "local-ai-bridge")
                tool_names = [t["name"] for t in responses[2]["result"]["tools"]]
                self.assertIn("ai_run_task", tool_names)
                self.assertIn("ai_dashboard_state", tool_names)
                dash = responses[3]["result"]["structuredContent"]
                self.assertEqual(dash["project_name"], "repo")
                self.assertNotIn("project_dir", dash)
                self.assertEqual(len(dash["providers"]), 3)
                # Boolean rejected for integer field
                self.assertTrue(responses[4]["result"]["isError"])
            finally:
                if proc.stdout:
                    proc.stdout.close()
                if proc.stderr:
                    proc.stderr.close()
                proc.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
