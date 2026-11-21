import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest

PLUGIN_DIR = pathlib.Path(__file__).resolve().parent.parent
SERVER_PATH = PLUGIN_DIR / "server.py"
MANIFEST_PATH = PLUGIN_DIR / "plugin.json"
RESERVED = ("cage", "guest", "vm", "virtual machine", "虚拟机", "客机")


def contains_reserved(text: str) -> str | None:
    lowered = text.lower()
    words = set(re.split(r"[^a-z0-9\u0080-\U0010ffff]+", lowered))
    for word in RESERVED:
        if (word in lowered) if (" " in word or not word.isascii()) else (word in words):
            return word
    return None


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        (self.root / "README.md").write_text("# Hello\n\nWorld\n", encoding="utf-8")
        (self.root / "docs").mkdir()
        (self.root / "docs" / "guide.markdown").write_text(
            "## Guide\n\nSee [[README]] and [Demo](demo.mdx).\n",
            encoding="utf-8",
        )
        (self.root / "docs" / "demo.mdx").write_text("# MDX\n\nBack to [[guide]].\n", encoding="utf-8")
        (self.root / "notes.txt").write_text("not markdown", encoding="utf-8")

        for ignored in (".git", "node_modules", "_output", "__pycache__", ".venv"):
            d = self.root / ignored
            d.mkdir()
            (d / "ignored.md").write_text("# Ignored\n", encoding="utf-8")

        self.outside = tempfile.TemporaryDirectory()
        self.outside_file = pathlib.Path(self.outside.name) / "secret.md"
        self.outside_file.write_text("# Secret\n", encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()
        self.outside.cleanup()

    def run_rpc(self, messages: list[str]) -> list[dict]:
        proc = subprocess.run(
            [sys.executable, str(SERVER_PATH), str(self.root)],
            input="\n".join(messages) + "\n",
            text=True,
            capture_output=True,
            timeout=10,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]

    def test_missing_or_invalid_root_cli(self):
        missing_arg = subprocess.run(
            [sys.executable, str(SERVER_PATH)],
            text=True,
            capture_output=True,
            timeout=5,
        )
        self.assertNotEqual(missing_arg.returncode, 0)
        self.assertIn("project root", missing_arg.stderr.lower())

        bad_dir = subprocess.run(
            [sys.executable, str(SERVER_PATH), str(self.root / "nonexistent")],
            text=True,
            capture_output=True,
            timeout=5,
        )
        self.assertNotEqual(bad_dir.returncode, 0)

    def test_stdio_lifecycle_and_listing(self):
        replies = self.run_rpc([
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}}),
            json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "ping"}),
            json.dumps({"jsonrpc": "2.0", "id": 3, "method": "tools/list"}),
            json.dumps({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "list_markdown_files", "arguments": {}}}),
            json.dumps({"jsonrpc": "2.0", "id": 5, "method": "unknown/method"}),
            "{not-json",
        ])
        self.assertEqual(len(replies), 6)
        self.assertEqual(replies[0]["result"]["serverInfo"]["name"], "markdown-viewer")
        self.assertEqual(replies[1]["result"], {})
        tool_names = [t["name"] for t in replies[2]["result"]["tools"]]
        self.assertEqual(
            tool_names,
            [
                "list_markdown_files",
                "read_markdown_file",
                "search_markdown_files",
                "get_backlinks",
                "save_markdown_file",
                "read_markdown_asset",
                "list_project_tags",
                "list_project_tasks",
                "toggle_markdown_task",
                "inspect_project_links",
                "update_markdown_task_meta",
                "get_project_graph",
                "rename_markdown_file",
                "save_markdown_asset",
                "replace_in_markdown_files",
                "read_office_document",
            ],
        )

        listed = replies[3]["result"]["structuredContent"]
        self.assertEqual(listed["project"], self.root.name)
        paths = [item["path"] for item in listed["files"]]
        self.assertEqual(paths, ["README.md", "docs/demo.mdx", "docs/guide.markdown"])
        self.assertFalse(listed["truncated"])
        for item in listed["files"]:
            self.assertIsInstance(item["bytes"], int)
            self.assertIsInstance(item["mtime"], int)

        self.assertEqual(replies[4]["error"]["code"], -32601)
        self.assertEqual(replies[5]["error"]["code"], -32700)

    def test_read_markdown_and_security_rejections(self):
        escape_link = self.root / "escape.md"
        os.symlink(self.outside_file, escape_link)
        (self.root / "binary.md").write_bytes(b"\x00\xff\xfe\xfd")
        big_text = ("中文内容测试ABC\n" * 40000)
        (self.root / "large.md").write_text(big_text, encoding="utf-8")

        calls = [
            ("ok", {"path": "docs/guide.markdown"}),
            ("traversal", {"path": "../secret.md"}),
            ("abs", {"path": "/etc/passwd"}),
            ("nul", {"path": "README.md\x00.txt"}),
            ("symlink", {"path": "escape.md"}),
            ("non_md", {"path": "notes.txt"}),
            ("missing", {"path": "does-not-exist.md"}),
            ("binary", {"path": "binary.md"}),
            ("large", {"path": "large.md"}),
        ]
        msgs = [
            json.dumps({"jsonrpc": "2.0", "id": idx + 1, "method": "tools/call", "params": {"name": "read_markdown_file", "arguments": args}})
            for idx, (_, args) in enumerate(calls)
        ]
        replies = self.run_rpc(msgs)

        by_tag = {calls[i][0]: replies[i]["result"] for i in range(len(calls))}
        self.assertFalse(by_tag["ok"].get("isError", False))
        self.assertEqual(by_tag["ok"]["structuredContent"]["path"], "docs/guide.markdown")
        self.assertIn("## Guide", by_tag["ok"]["structuredContent"]["content"])
        self.assertFalse(by_tag["ok"]["structuredContent"]["truncated"])

        for err_tag in ("traversal", "abs", "nul", "symlink", "non_md", "missing", "binary"):
            self.assertTrue(by_tag[err_tag].get("isError"), f"{err_tag} should have failed")

        self.assertFalse(by_tag["large"].get("isError", False))
        self.assertTrue(by_tag["large"]["structuredContent"]["truncated"])
        self.assertTrue(by_tag["large"]["structuredContent"]["readOnly"])
        self.assertTrue(by_tag["large"]["structuredContent"]["etag"])
        self.assertLessEqual(len(by_tag["large"]["structuredContent"]["content"].encode("utf-8")), 512 * 1024)

    def test_search_backlinks_and_save(self):
        replies = self.run_rpc([
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "search_markdown_files", "arguments": {"query": "guide"}}}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "get_backlinks", "arguments": {"path": "docs/demo.mdx"}}}),
            json.dumps({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "get_backlinks", "arguments": {"path": "README.md"}}}),
            json.dumps({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "save_markdown_file", "arguments": {"path": "docs/new-note.md", "content": "# New\n\nSaved!"}}}),
            json.dumps({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "save_markdown_file", "arguments": {"path": "../outside.md", "content": "nope"}}}),
            json.dumps({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "save_markdown_file", "arguments": {"path": "docs/bad.txt", "content": "nope"}}}),
            json.dumps({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "save_markdown_file", "arguments": {"path": "docs/new-note.md", "content": "# Conflict", "expectedEtag": "stale00000000000"}}}),
            json.dumps({"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {"name": "save_markdown_file", "arguments": {"path": "docs/new-note.md", "content": "# Forced", "expectedEtag": "stale00000000000", "force": True}}}),
        ])
        search_res = replies[0]["result"]["structuredContent"]
        self.assertGreaterEqual(len(search_res["matches"]), 2)
        self.assertIn("column", search_res["matches"][0])
        self.assertEqual(replies[1]["result"]["structuredContent"]["backlinks"][0]["path"], "docs/guide.markdown")
        self.assertEqual(replies[1]["result"]["structuredContent"]["backlinks"][0]["kind"], "markdown")
        self.assertEqual(replies[2]["result"]["structuredContent"]["backlinks"][0]["path"], "docs/guide.markdown")
        self.assertEqual(replies[2]["result"]["structuredContent"]["backlinks"][0]["kind"], "wikilink")

        save_ok = replies[3]["result"]["structuredContent"]
        self.assertTrue(save_ok["saved"])
        self.assertFalse(save_ok["conflict"])
        self.assertTrue(save_ok["etag"])

        self.assertTrue(replies[4]["result"].get("isError"))
        self.assertTrue(replies[5]["result"].get("isError"))

        conflict_res = replies[6]["result"]["structuredContent"]
        self.assertFalse(conflict_res["saved"])
        self.assertTrue(conflict_res["conflict"])
        self.assertEqual(conflict_res["diskEtag"], save_ok["etag"])

        force_res = replies[7]["result"]["structuredContent"]
        self.assertTrue(force_res["saved"])
        self.assertEqual((self.root / "docs" / "new-note.md").read_text(encoding="utf-8"), "# Forced")

    def test_read_markdown_asset_and_sandbox(self):
        (self.root / "docs" / "assets").mkdir()
        svg_path = self.root / "docs" / "assets" / "arch.svg"
        svg_path.write_text("<svg xmlns='http://www.w3.org/2000/svg'></svg>", encoding="utf-8")

        outside_img = pathlib.Path(self.outside.name) / "leak.png"
        outside_img.write_bytes(b"\x89PNG\r\n\x1a\n")
        os.symlink(outside_img, self.root / "docs" / "assets" / "escape.png")

        replies = self.run_rpc([
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "read_markdown_asset", "arguments": {"docPath": "docs/guide.markdown", "assetHref": "assets/arch.svg"}}}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "read_markdown_asset", "arguments": {"docPath": "docs/guide.markdown", "assetHref": "assets/escape.png"}}}),
            json.dumps({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "read_markdown_asset", "arguments": {"docPath": "docs/guide.markdown", "assetHref": "../../etc/passwd"}}}),
            json.dumps({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "read_markdown_asset", "arguments": {"docPath": "docs/guide.markdown", "assetHref": "https://example.com/a.png"}}}),
        ])
        ok = replies[0]["result"]["structuredContent"]
        self.assertEqual(ok["resolvedPath"], "docs/assets/arch.svg")
        self.assertEqual(ok["mimeType"], "image/svg+xml")
        self.assertEqual(ok["encoding"], "base64")

        for idx in (1, 2, 3):
            self.assertTrue(replies[idx]["result"].get("isError"))

    def test_knowledge_base_tags_tasks_toggle_and_links(self):
        (self.root / "kb.md").write_text(
            "---\ntags: [alpha, beta]\n---\n\n# KB\n\n- [ ] First task #gamma\n- [x] Done task\n\n[[missing-note]] [[guide]]\n",
            encoding="utf-8",
        )
        (self.root / "sub").mkdir()
        (self.root / "sub" / "guide.md").write_text("# Duplicate stem\n", encoding="utf-8")

        replies = self.run_rpc([
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_project_tags", "arguments": {}}}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "search_markdown_files", "arguments": {"query": "task", "tags": ["alpha", "gamma"]}}}),
            json.dumps({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "list_project_tasks", "arguments": {"status": "open"}}}),
            json.dumps({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "inspect_project_links", "arguments": {}}}),
        ])
        tags = {t["name"]: t for t in replies[0]["result"]["structuredContent"]["tags"]}
        self.assertIn("alpha", tags)
        self.assertIn("gamma", tags)

        tag_search = replies[1]["result"]["structuredContent"]["matches"]
        self.assertTrue(all(m["path"] == "kb.md" for m in tag_search))

        tasks = replies[2]["result"]["structuredContent"]["tasks"]
        self.assertEqual(len(tasks), 1)
        t = tasks[0]
        self.assertEqual(t["path"], "kb.md")
        self.assertFalse(t["checked"])

        links = replies[3]["result"]["structuredContent"]
        self.assertTrue(any(b["rawTarget"] == "missing-note" for b in links["brokenLinks"]))
        self.assertTrue(any(a["key"] == "guide" and len(a["candidates"]) == 2 for a in links["ambiguousTargets"]))
        self.assertIn("graph", links)
        self.assertTrue(any(n["id"] == "kb.md" for n in links["graph"]["nodes"]))

        # Toggle task with valid and stale ETags
        toggle_replies = self.run_rpc([
            json.dumps({"jsonrpc": "2.0", "id": 10, "method": "tools/call", "params": {"name": "toggle_markdown_task", "arguments": {"path": "kb.md", "line": t["line"], "checked": True, "expectedEtag": "stale00000000000"}}}),
            json.dumps({"jsonrpc": "2.0", "id": 11, "method": "tools/call", "params": {"name": "toggle_markdown_task", "arguments": {"path": "kb.md", "line": t["line"], "checked": True, "expectedEtag": t["etag"]}}}),
        ])
        self.assertTrue(toggle_replies[0]["result"]["structuredContent"]["conflict"])
        self.assertTrue(toggle_replies[1]["result"]["structuredContent"]["saved"])
        self.assertIn("- [x] First task #gamma", (self.root / "kb.md").read_text(encoding="utf-8"))

    def test_task_metadata_update_and_project_graph(self):
        (self.root / "hub.md").write_text(
            "---\ntags: [core]\n---\n\n# Hub\n\n"
            "- [ ] Ship graph view P1 📅 2026-12-01 @alice group:release color:red\n"
            "- [ ] Plain task\n\n"
            "Links: [[guide]] [[ghost-doc]]\n",
            encoding="utf-8",
        )
        replies = self.run_rpc([
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_project_tasks", "arguments": {"status": "open"}}}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "get_project_graph", "arguments": {}}}),
        ])
        tasks = replies[0]["result"]["structuredContent"]["tasks"]
        by_text = {t["cleanText"]: t for t in tasks}
        self.assertIn("Ship graph view", by_text)
        ship = by_text["Ship graph view"]
        self.assertEqual(ship["priority"], "high")
        self.assertEqual(ship["due"], "2026-12-01")
        self.assertEqual(ship["assignee"], "alice")
        self.assertEqual(ship["group"], "release")
        self.assertEqual(ship["color"], "red")

        plain = by_text["Plain task"]
        self.assertEqual(plain["priority"], "")
        self.assertEqual(plain["assignee"], "")

        # Update plain task metadata (stale ETag conflict + valid ETag update)
        upd_replies = self.run_rpc([
            json.dumps({
                "jsonrpc": "2.0",
                "id": 10,
                "method": "tools/call",
                "params": {
                    "name": "update_markdown_task_meta",
                    "arguments": {
                        "path": "hub.md",
                        "line": plain["line"],
                        "expectedEtag": "stale00000000000",
                        "priority": "medium",
                    },
                },
            }),
            json.dumps({
                "jsonrpc": "2.0",
                "id": 11,
                "method": "tools/call",
                "params": {
                    "name": "update_markdown_task_meta",
                    "arguments": {
                        "path": "hub.md",
                        "line": plain["line"],
                        "expectedEtag": plain["etag"],
                        "priority": "medium",
                        "due": "2026-12-15",
                        "assignee": "bob",
                        "group": "qa",
                        "color": "green",
                    },
                },
            }),
        ])
        self.assertTrue(upd_replies[0]["result"]["structuredContent"]["conflict"])
        upd_ok = upd_replies[1]["result"]["structuredContent"]
        self.assertTrue(upd_ok["saved"])
        self.assertEqual(upd_ok["priority"], "medium")
        self.assertEqual(upd_ok["due"], "2026-12-15")
        self.assertEqual(upd_ok["assignee"], "bob")
        self.assertEqual(upd_ok["group"], "qa")
        self.assertEqual(upd_ok["color"], "green")
        updated_src = (self.root / "hub.md").read_text(encoding="utf-8")
        self.assertIn("- [ ] Plain task P2 📅 2026-12-15 @bob group:qa color:green", updated_src)

        # Verify knowledge graph payload
        graph = replies[1]["result"]["structuredContent"]
        node_ids = {n["id"] for n in graph["nodes"]}
        self.assertIn("hub.md", node_ids)
        self.assertIn("docs/guide.markdown", node_ids)
        self.assertIn("ghost::ghost-doc", node_ids)
        hub_node = next(n for n in graph["nodes"] if n["id"] == "hub.md")
        self.assertEqual(hub_node["tasksTotal"], 2)
        self.assertEqual(hub_node["tasksOpen"], 2)
        ghost = next(n for n in graph["nodes"] if n["id"] == "ghost::ghost-doc")
        self.assertTrue(ghost["isGhost"])
        edge_pairs = {(e["source"], e["target"]) for e in graph["edges"]}
        self.assertIn(("hub.md", "docs/guide.markdown"), edge_pairs)
        self.assertIn(("hub.md", "ghost::ghost-doc"), edge_pairs)

    def test_advanced_fulltext_search_operators_regex_context_and_centering(self):
        long_prefix = "filler " * 32  # > 220 chars
        (self.root / "docs" / "engine.md").write_text(
            "---\ntags: [search, core]\n---\n\n"
            "# Search Engine Architecture\n\n"
            "## Query Pipeline\n"
            "Before line context.\n"
            f"{long_prefix}NeedleToken appears twice: NeedleToken!\n"
            "After line context.\n",
            encoding="utf-8",
        )
        (self.root / "docs" / "noise.md").write_text(
            "# Noise Draft\n\nNeedleTokenSubword and draft note.\n",
            encoding="utf-8",
        )

        replies = self.run_rpc([
            # 1. Centered snippet + multi-range + context + wholeWord + caseSensitive
            json.dumps({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "search_markdown_files",
                    "arguments": {
                        "query": "NeedleToken",
                        "caseSensitive": True,
                        "wholeWord": True,
                        "includeContext": True,
                    },
                },
            }),
            # 2. Inline operators: path:docs/ tag:search -draft heading:Pipeline "appears twice"
            json.dumps({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "search_markdown_files",
                    "arguments": {
                        "query": 'path:docs/ tag:search -draft heading:Pipeline "appears twice"',
                    },
                },
            }),
            # 3. Regex search + invalid regex error handling
            json.dumps({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "search_markdown_files",
                    "arguments": {
                        "query": r"Needle[A-Z]\w+",
                        "regex": True,
                        "pathPrefix": "docs/",
                    },
                },
            }),
            json.dumps({
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {
                    "name": "search_markdown_files",
                    "arguments": {
                        "query": "[unclosed",
                        "regex": True,
                    },
                },
            }),
        ])

        r1 = replies[0]["result"]["structuredContent"]
        self.assertEqual(r1["totalFilesMatched"], 1)
        self.assertEqual(r1["files"][0]["path"], "docs/engine.md")
        hit = r1["files"][0]["hits"][0]
        self.assertIn("NeedleToken", hit["snippet"])
        self.assertTrue(hit["snippet"].startswith("…"))
        self.assertEqual(len(hit["matchRanges"]), 2)
        self.assertEqual(hit["heading"], "Query Pipeline")
        self.assertEqual(hit["contextBefore"], "Before line context.")
        self.assertEqual(hit["contextAfter"], "After line context.")

        r2 = replies[1]["result"]["structuredContent"]
        self.assertEqual(r2["totalFilesMatched"], 1)
        self.assertEqual(r2["files"][0]["path"], "docs/engine.md")

        r3 = replies[2]["result"]["structuredContent"]
        self.assertEqual(r3["totalFilesMatched"], 2)

        self.assertTrue(replies[3]["result"].get("isError"))

    def test_multi_workspace_scope_and_task_workflow_statuses(self):
        with tempfile.TemporaryDirectory() as parent_tmp:
            parent = pathlib.Path(parent_tmp)
            ws_a = parent / "alpha-ws"
            ws_b = parent / "beta-ws"
            ws_a.mkdir()
            ws_b.mkdir()
            (ws_a / "a.md").write_text(
                "# Alpha\n\n- [ ] Task in alpha P1 status:doing @alice\n\nLink to [[b]].\n",
                encoding="utf-8",
            )
            (ws_b / "b.md").write_text(
                "# Beta\n\n- [ ] Task in beta P2 status:review @bob\n",
                encoding="utf-8",
            )

            def run_scoped(msgs: list[str]) -> list[dict]:
                proc = subprocess.run(
                    [sys.executable, str(SERVER_PATH), str(ws_a)],
                    input="\n".join(msgs) + "\n",
                    text=True,
                    capture_output=True,
                    timeout=10,
                )
                self.assertEqual(proc.returncode, 0, proc.stderr)
                return [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]

            replies = run_scoped([
                json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_markdown_files", "arguments": {"scope": "all"}}}),
                json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "read_markdown_file", "arguments": {"path": "beta-ws/b.md", "scope": "all"}}}),
                json.dumps({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "list_project_tasks", "arguments": {"status": "open", "scope": "all"}}}),
                json.dumps({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "get_project_graph", "arguments": {"scope": "all"}}}),
                json.dumps({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "read_markdown_file", "arguments": {"path": "unlisted-ws/x.md", "scope": "all"}}}),
            ])

            listed = replies[0]["result"]["structuredContent"]
            self.assertEqual(listed["scope"], "all")
            self.assertEqual(set(listed["workspaces"]), {"alpha-ws", "beta-ws"})
            self.assertEqual([f["path"] for f in listed["files"]], ["alpha-ws/a.md", "beta-ws/b.md"])

            beta_doc = replies[1]["result"]["structuredContent"]
            self.assertEqual(beta_doc["path"], "beta-ws/b.md")
            self.assertIn("# Beta", beta_doc["content"])

            tasks = replies[2]["result"]["structuredContent"]["tasks"]
            self.assertEqual(len(tasks), 2)
            by_path = {t["path"]: t for t in tasks}
            self.assertEqual(by_path["alpha-ws/a.md"]["status"], "doing")
            self.assertEqual(by_path["beta-ws/b.md"]["status"], "review")

            graph = replies[3]["result"]["structuredContent"]
            node_ids = {n["id"] for n in graph["nodes"]}
            self.assertEqual(node_ids, {"alpha-ws/a.md", "beta-ws/b.md"})

            # Unauthorized workspace name is rejected
            self.assertTrue(replies[4]["result"].get("isError"))

            # Move beta task from review -> done via update_markdown_task_meta with scope="all"
            beta_task = by_path["beta-ws/b.md"]
            upd = run_scoped([
                json.dumps({
                    "jsonrpc": "2.0",
                    "id": 10,
                    "method": "tools/call",
                    "params": {
                        "name": "update_markdown_task_meta",
                        "arguments": {
                            "path": "beta-ws/b.md",
                            "line": beta_task["line"],
                            "expectedEtag": beta_task["etag"],
                            "status": "done",
                            "priority": "high",
                            "assignee": "bob",
                            "scope": "all",
                        },
                    },
                }),
            ])[0]["result"]["structuredContent"]
            self.assertTrue(upd["saved"])
            self.assertTrue(upd["checked"])
            self.assertEqual(upd["status"], "done")
            self.assertIn("- [x] Task in beta P1 @bob", (ws_b / "b.md").read_text(encoding="utf-8"))

    def test_no_reserved_words_in_manifest_or_server(self):
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        shown = [
            manifest["name"],
            manifest.get("displayName", ""),
            manifest["description"],
            *[v["title"] for v in manifest.get("contributes", {}).get("views", [])],
        ]
        for text in shown:
            self.assertIsNone(contains_reserved(text), f"Reserved word in manifest text: {text}")

        sys.path.insert(0, str(PLUGIN_DIR))
        try:
            import server as md_server
            for tool in md_server.TOOLS:
                blob = json.dumps(tool, ensure_ascii=False)
                self.assertIsNone(contains_reserved(blob), f"Reserved word in tool: {tool['name']}")
        finally:
            sys.path.pop(0)

        server_source = SERVER_PATH.read_text(encoding="utf-8")
        self.assertIsNone(contains_reserved(server_source), "Reserved word found in server.py")

        i18n_path = PLUGIN_DIR / "i18n.json"
        self.assertTrue(i18n_path.is_file(), "i18n.json is required for marketplace publishing")
        i18n_data = json.loads(i18n_path.read_text(encoding="utf-8"))
        required_locales = (
            "zh-CN", "zh-TW", "ru", "ar", "fa", "ko", "es", "my",
            "be", "ps", "prs", "am", "so", "ti", "fr",
        )
        for code in required_locales:
            self.assertIn(code, i18n_data, f"Missing required locale {code} in i18n.json")
            entry = i18n_data[code]
            self.assertTrue(0 < len(entry.get("displayName", "")) <= 80)
            self.assertTrue(0 < len(entry.get("description", "")) <= 600)
            self.assertIsNone(contains_reserved(json.dumps(entry, ensure_ascii=False)), f"Reserved word in i18n[{code}]")

    def test_v18_lifecycle_assets_batch_replace_and_subtasks(self):
        import base64
        res_create = self.run_rpc([
            json.dumps({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "save_markdown_file",
                    "arguments": {
                        "path": "notes/sub/plan.md",
                        "content": "# Plan\n\n- [ ] Parent task P1 📅 2026-11-22 @dp status:todo\n  - [x] Child done\n  - [ ] Child open\n\nSee [[notes/sub/plan]].\n",
                        "createDirs": True,
                    },
                },
            }),
            json.dumps({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "list_project_tasks", "arguments": {"pathPrefix": "notes/sub/"}},
            }),
        ])
        self.assertTrue(res_create[0]["result"]["structuredContent"]["saved"])
        tasks = res_create[1]["result"]["structuredContent"]["tasks"]
        parent = [t for t in tasks if t["cleanText"] == "Parent task"][0]
        self.assertEqual(parent["subtasksTotal"], 2)
        self.assertEqual(parent["subtasksDone"], 1)

        res_rename_task = self.run_rpc([
            json.dumps({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "update_markdown_task_meta",
                    "arguments": {
                        "path": "notes/sub/plan.md",
                        "line": parent["line"],
                        "expectedEtag": parent["etag"],
                        "cleanText": "Renamed parent task",
                    },
                },
            }),
        ])
        self.assertEqual(res_rename_task[0]["result"]["structuredContent"]["cleanText"], "Renamed parent task")

        png_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR").decode("ascii")
        res_asset = self.run_rpc([
            json.dumps({
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {
                    "name": "save_markdown_asset",
                    "arguments": {"docPath": "notes/sub/plan.md", "filename": "shot.png", "data": png_b64},
                },
            }),
        ])
        asset_out = res_asset[0]["result"]["structuredContent"]
        self.assertTrue(asset_out["assetHref"].startswith("assets/"))
        self.assertTrue((self.root / asset_out["resolvedPath"]).is_file())

        (self.root / "ref.md").write_text("Link to [[plan]] here.\n", encoding="utf-8")
        res_move_replace = self.run_rpc([
            json.dumps({
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {
                    "name": "rename_markdown_file",
                    "arguments": {"oldPath": "notes/sub/plan.md", "newPath": "notes/sub/roadmap.md", "updateLinks": True},
                },
            }),
            json.dumps({
                "jsonrpc": "2.0",
                "id": 6,
                "method": "tools/call",
                "params": {
                    "name": "replace_in_markdown_files",
                    "arguments": {"query": "Renamed parent", "replacement": "Updated parent", "paths": ["notes/sub/roadmap.md"]},
                },
            }),
        ])
        move_out = res_move_replace[0]["result"]["structuredContent"]
        self.assertEqual(move_out["newPath"], "notes/sub/roadmap.md")
        self.assertIn("ref.md", move_out["updatedFiles"])
        self.assertIn("[[roadmap]]", (self.root / "ref.md").read_text(encoding="utf-8"))
        self.assertEqual(res_move_replace[1]["result"]["structuredContent"]["totalReplacements"], 1)

    def test_office_and_pdf_document_reading_and_sandbox(self):
        import zipfile
        import zlib

        # 1. CSV
        (self.root / "docs" / "metrics.csv").write_text("Name,Score\nAlice,95\nBob,88\n", encoding="utf-8")

        # 2. XLSX (ZIP + sharedStrings + workbook + sheet1)
        xlsx_path = self.root / "docs" / "budget.xlsx"
        with zipfile.ZipFile(xlsx_path, "w") as zf:
            zf.writestr(
                "xl/workbook.xml",
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                '<sheets><sheet name="Q4预算" sheetId="1" r:id="rId1"/></sheets></workbook>',
            )
            zf.writestr(
                "xl/_rels/workbook.xml.rels",
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
            )
            zf.writestr(
                "xl/sharedStrings.xml",
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                '<si><t>项目</t></si><si><t>金额</t></si><si><t>研发</t></si></sst>',
            )
            zf.writestr(
                "xl/worksheets/sheet1.xml",
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                '<sheetData>'
                '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
                '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1200</v></c></row>'
                '</sheetData></worksheet>',
            )

        # 3. DOCX
        docx_path = self.root / "docs" / "spec.docx"
        with zipfile.ZipFile(docx_path, "w") as zf:
            zf.writestr(
                "word/document.xml",
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                '<w:body>'
                '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>架构设计</w:t></w:r></w:p>'
                '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>核心结论</w:t></w:r></w:p>'
                '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>模块</w:t></w:r></w:p></w:tc>'
                '<w:tc><w:p><w:r><w:t>状态</w:t></w:r></w:p></w:tc></w:tr>'
                '<w:tr><w:tc><w:p><w:r><w:t>解析器</w:t></w:r></w:p></w:tc>'
                '<w:tc><w:p><w:r><w:t>完成</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
                '</w:body></w:document>',
            )

        # 4. PPTX
        pptx_path = self.root / "docs" / "deck.pptx"
        with zipfile.ZipFile(pptx_path, "w") as zf:
            zf.writestr(
                "ppt/presentation.xml",
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
            )
            zf.writestr(
                "ppt/_rels/presentation.xml.rels",
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>',
            )
            zf.writestr(
                "ppt/slides/slide1.xml",
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
                'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
                '<p:cSld><p:spTree>'
                '<p:sp><p:nvSpPr><p:cNvPr id="1" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>'
                '<p:txBody><a:p><a:r><a:t>季度汇报</a:t></a:r></a:p></p:txBody></p:sp>'
                '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Content 2"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>'
                '<p:txBody><a:p><a:r><a:t>离线支持 Excel/Word/PPT/PDF</a:t></a:r></a:p></p:txBody></p:sp>'
                '</p:spTree></p:cSld></p:sld>',
            )

        # 5. PDF with /Title, /Type /Page, and FlateDecode stream
        compressed = zlib.compress(b"BT /F1 12 Tf 72 720 Td (Hello Offline PDF) Tj ET")
        pdf_bytes = (
            b"%PDF-1.4\n"
            b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"
            b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n"
            b"3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n"
            b"4 0 obj << /Length " + str(len(compressed)).encode("ascii") + b" /Filter /FlateDecode >>\nstream\n"
            + compressed
            + b"\nendstream\nendobj\n"
            b"5 0 obj << /Title (Offline PDF Title) >> endobj\n"
            b"%%EOF\n"
        )
        (self.root / "docs" / "manual.pdf").write_bytes(pdf_bytes)

        replies = self.run_rpc([
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_markdown_files", "arguments": {"includeDocs": False}}}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "list_markdown_files", "arguments": {"includeDocs": True}}}),
            json.dumps({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "read_office_document", "arguments": {"path": "docs/metrics.csv"}}}),
            json.dumps({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "read_office_document", "arguments": {"path": "docs/budget.xlsx"}}}),
            json.dumps({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "read_office_document", "arguments": {"path": "docs/spec.docx"}}}),
            json.dumps({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "read_office_document", "arguments": {"path": "docs/deck.pptx"}}}),
            json.dumps({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "read_office_document", "arguments": {"path": "docs/manual.pdf"}}}),
            json.dumps({"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {"name": "read_office_document", "arguments": {"path": "../secret.pdf"}}}),
            json.dumps({"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": "read_office_document", "arguments": {"path": "README.md"}}}),
        ])

        md_only_paths = [f["path"] for f in replies[0]["result"]["structuredContent"]["files"]]
        self.assertNotIn("docs/budget.xlsx", md_only_paths)
        all_items = replies[1]["result"]["structuredContent"]["files"]
        types_by_path = {f["path"]: f["docType"] for f in all_items}
        self.assertEqual(types_by_path["docs/metrics.csv"], "excel")
        self.assertEqual(types_by_path["docs/budget.xlsx"], "excel")
        self.assertEqual(types_by_path["docs/spec.docx"], "word")
        self.assertEqual(types_by_path["docs/deck.pptx"], "ppt")
        self.assertEqual(types_by_path["docs/manual.pdf"], "pdf")
        self.assertEqual(types_by_path["README.md"], "markdown")

        csv_out = replies[2]["result"]["structuredContent"]
        self.assertEqual(csv_out["docType"], "excel")
        self.assertIn("Alice", csv_out["markdown"])

        xlsx_out = replies[3]["result"]["structuredContent"]
        self.assertEqual(xlsx_out["sheets"][0]["name"], "Q4预算")
        self.assertEqual(xlsx_out["sheets"][0]["rows"][1], ["研发", "1200"])

        docx_out = replies[4]["result"]["structuredContent"]
        self.assertEqual(docx_out["docType"], "word")
        self.assertEqual(docx_out["blocks"][0]["kind"], "heading")
        self.assertIn("架构设计", docx_out["markdown"])
        self.assertIn("| 模块 | 状态 |", docx_out["markdown"])

        pptx_out = replies[5]["result"]["structuredContent"]
        self.assertEqual(pptx_out["docType"], "ppt")
        self.assertEqual(pptx_out["slides"][0]["title"], "季度汇报")
        self.assertIn("离线支持 Excel/Word/PPT/PDF", pptx_out["markdown"])

        pdf_out = replies[6]["result"]["structuredContent"]
        self.assertEqual(pdf_out["docType"], "pdf")
        self.assertEqual(pdf_out["title"], "Offline PDF Title")
        self.assertEqual(pdf_out["pageCount"], 1)
        self.assertIn("Hello Offline PDF", pdf_out["extractedText"])
        self.assertTrue(len(pdf_out["data"]) > 10)

        self.assertTrue(replies[7]["result"]["isError"])
        self.assertTrue(replies[8]["result"]["isError"])


if __name__ == "__main__":
    unittest.main()
