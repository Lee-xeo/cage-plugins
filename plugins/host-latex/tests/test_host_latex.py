"""Host LaTeX regressions. Set HOST_LATEX_TEST_TEX=1 for the real compiler test."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SERVER = Path(__file__).resolve().parents[1] / "server.py"
spec = importlib.util.spec_from_file_location("host_latex", SERVER)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


def stdio(root, requests):
    run = subprocess.run(
        [sys.executable, "-I", "-B", str(SERVER), str(root)],
        input="".join(json.dumps(r) + "\n" for r in requests).encode(),
        capture_output=True, check=True, timeout=150,
    )
    return [json.loads(line) for line in run.stdout.splitlines()]


def call(ident, method, params):
    return {"jsonrpc": "2.0", "id": ident, "method": method, "params": params}


class HostLatexTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()

    def test_invalid_params_reply_and_next_request(self):
        requests = [call(i, "tools/call", p) for i, p in enumerate(([], [1], None, "", False, 10))]
        requests += [
            call(6, "initialize", {"protocolVersion": []}),
            {"jsonrpc": "2.0", "method": "notifications/initialized", "params": []},
            call(7, "initialize", {"protocolVersion": "2025-06-18"}),
            call(8, "ping", {}),
        ]
        replies = stdio(self.root, requests)
        self.assertEqual([r["id"] for r in replies], list(range(9)))
        self.assertEqual([r["error"]["code"] for r in replies[:7]], [-32602] * 7)
        self.assertEqual(replies[7]["result"]["protocolVersion"], "2025-06-18")
        self.assertEqual(replies[8]["result"], {})

    def test_invalid_project_does_not_report_host_path(self):
        file = self.root / "private-local-name"
        file.touch()
        for candidate in (file, self.root / "missing-local-folder"):
            with self.subTest(candidate=candidate.name):
                run = subprocess.run(
                    [sys.executable, "-I", "-B", str(SERVER), str(candidate)],
                    input=b"", capture_output=True, timeout=15,
                )
                self.assertNotEqual(run.returncode, 0)
                self.assertNotIn(candidate.name.encode(), run.stderr + run.stdout)

    @unittest.skipUnless(os.name == "nt", "Windows system directory validation")
    def test_missing_windows_root(self):
        with patch.dict(os.environ, {"SystemRoot": "", "WINDIR": ""}), \
                patch.object(server.shutil, "which", return_value=str(self.root / "tool.exe")):
            with self.assertRaises(server.BuildError):
                server.texlive_engine("xelatex", self.root)

    def test_texlive_includes_distribution_directories_and_ignores_invalid_ones(self):
        names = ("TEXMFDIST", "TEXMFMAIN", "TEXMFDEBIAN")
        paths = {name: self.root / name.lower() for name in names}
        for path in paths.values():
            path.mkdir()
        invalid = self.root / "ordinary-file"
        invalid.touch()

        def query(command, **kwargs):
            variable = command[-1].split("=", 1)[-1]
            value = paths.get(variable, invalid)
            return subprocess.CompletedProcess(command, 0, os.fsencode(value))

        with patch.object(server.shutil, "which", return_value=str(self.root / "tool")), \
                patch.object(server.subprocess, "run", side_effect=query):
            _, _, allowed = server.texlive_engine("xelatex", self.root)
        for path in paths.values():
            self.assertIn(path, allowed)
        self.assertNotIn(invalid, allowed)

    def test_diagnostic_reports_line_without_host_or_project_text(self):
        log = self.root / "compiler.log"
        for name in (r"C:\Users\PRIVATE_USER\temp\main.tex", "/home/PRIVATE_USER/project/main.tex"):
            with self.subTest(name=name):
                log.write_text(f"{name}:23: Undefined control sequence PRIVATE_CONTENT\n", encoding="utf-8")
                with log.open("rb") as output:
                    hint = server.build_diagnostic(output)
                self.assertIn("23", hint)
                self.assertNotIn("PRIVATE", hint)
                self.assertNotIn(name, hint)

    def test_source_outside_project_is_rejected_before_compiling(self):
        request = call(1, "tools/call", {"name": "latex_compile", "arguments": {"source": "../main.tex"}})
        result = stdio(self.root, [request])[0]["result"]
        self.assertTrue(result["isError"])
        self.assertNotIn("cage", result["content"][0]["text"].lower())
        self.assertFalse((self.root / ".latex-out").exists())

    def test_unavailable_sandbox_does_not_run_unconfined(self):
        (self.root / "main.tex").touch()
        runtime = (self.root / "pdflatex", {}, ())
        with patch.object(server, "texlive_engine", return_value=runtime), \
                patch.object(server, "run_contained", side_effect=OSError("isolation unavailable")) as run, \
                patch.object(server.subprocess, "run", side_effect=AssertionError("unconfined launch")):
            result = server.respond(self.root, call(1, "tools/call", {
                "name": "latex_compile", "arguments": {"engine": "pdflatex", "source": "main.tex"},
            }))
        self.assertTrue(result["isError"])
        self.assertEqual(run.call_count, 1)
        self.assertFalse((self.root / ".latex-out").exists())

    def test_xetex_and_pdf_driver_each_run_in_the_sandbox(self):
        (self.root / "main.tex").touch()
        suffix = ".exe" if os.name == "nt" else ""
        engine = self.root / ("xelatex" + suffix)
        driver = self.root / ("xdvipdfmx" + suffix)
        driver.touch()
        driver.chmod(0o755)
        calls = []

        def contained(command, cwd, env, output, timeout, base, allowed):
            calls.append(list(command))
            if Path(command[0]) == driver:
                (base / "build" / "main.pdf").write_bytes(b"%PDF-1.4\n")
            return 0

        # No recorder file is generated. The PDF still requires a successful driver run.
        with patch.object(server, "texlive_engine", return_value=(engine, {}, ())), \
                patch.object(server, "run_contained", side_effect=contained), \
                patch.object(server.subprocess, "run", side_effect=AssertionError("unconfined launch")):
            result = server.compile_pdf(self.root, {"source": "main.tex"})
        self.assertEqual([Path(command[0]) for command in calls], [engine, engine, driver])
        for command in calls[:2]:
            self.assertIn("-no-pdf", command)
            self.assertFalse(any("openin_any" in arg for arg in command))
            self.assertIn("-cnf-line=openout_any=p", command)
        self.assertEqual(result["pdf"], ".latex-out/main.pdf")

    @unittest.skipUnless(os.environ.get("HOST_LATEX_TEST_TEX") == "1", "set HOST_LATEX_TEST_TEX=1 with TeX Live installed")
    def test_spaced_filename_reads_its_bibliography_with_both_engines(self):
        folder = self.root / "shared papers"
        folder.mkdir()
        source = folder / "paper final.tex"
        source.write_text(
            r"\documentclass{article}\begin{document}\bibliography{references}"
            r"\ifdefined\PreparedReference\PreparedReference\else\errmessage{Missing reference}\fi"
            r"\end{document}", encoding="utf-8",
        )
        source.with_suffix(".bbl").write_text(r"\gdef\PreparedReference{Bibliography loaded}", encoding="utf-8")
        for engine in ("xelatex", "pdflatex"):
            with self.subTest(engine=engine):
                args = {"source": source.relative_to(self.root).as_posix(), "engine": engine}
                reply = stdio(self.root, [call(1, "tools/call", {"name": "latex_compile", "arguments": args})])
                result = reply[0]["result"]
                self.assertFalse(result.get("isError"), result)
                self.assertEqual(result["structuredContent"]["pdf"], ".latex-out/shared papers/paper final.pdf")
                pdf = self.root / result["structuredContent"]["pdf"]
                self.assertTrue(pdf.read_bytes().startswith(b"%PDF"))
                pdf.unlink()


if __name__ == "__main__":
    unittest.main()
