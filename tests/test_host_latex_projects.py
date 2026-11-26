"""Regression cases for multi-file projects and native working directories."""

import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from test_host_latex import call, server, stdio


def write_files(root, files):
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)


def fingerprint(root):
    return {
        p.relative_to(root): (hashlib.sha256(p.read_bytes()).digest(), p.stat().st_mtime_ns)
        for p in root.rglob("*") if p.is_file() and not p.is_relative_to(root / ".latex-out")
    }


class ProjectTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.temp = Path(temp.name).resolve()
        self.root = self.temp / "project"
        self.root.mkdir()

    def test_snapshot_copies_project_data_verbatim(self):
        files = {name: b"fixture\r\n\xff\n" for name in (
            "main.tex", "existing.ind", "external.aux", "src/sample.py", "diagram.pdf_tex",
            ".generated/table.inc", "figures/old.EPS", "figures/old.PS", "data-no-extension",
            "chapters/sub/data.custom", "node_modules/example/plot.dat",
        )}
        write_files(self.root, files)
        write_files(self.root, {".env": b"secret", ".git/config": b"internal", ".latex-out/old.pdf": b"old"})
        (self.root / "empty").mkdir()
        before = fingerprint(self.root)
        stage = self.temp / "scratch" / "stage"
        stage.mkdir(parents=True)
        server.snapshot_project(self.root, stage)
        self.assertEqual({p.relative_to(stage).as_posix(): p.read_bytes()
                          for p in stage.rglob("*") if p.is_file()}, files)
        self.assertTrue((stage / "empty").is_dir())
        self.assertEqual(before, fingerprint(self.root))

    def test_explicit_workdir_and_ambiguous_layout(self):
        write_files(self.root, {"papers/main.tex": b"", "papers/value.tex": b"", "value.tex": b""})
        source = self.root / "papers/main.tex"
        for invalid in [None, "..", "../papers", "/outside", "D:/outside", "papers/..", "unknown"]:
            with self.subTest(invalid=invalid), self.assertRaises(server.BuildError):
                server.compilation_directory(self.root, source, invalid)
        self.assertEqual(server.compilation_directory(self.root, source, "."), self.root)
        self.assertEqual(server.compilation_directory(self.root, source, "papers"), source.parent)
        with tempfile.TemporaryDirectory(dir=self.root) as sibling:
            directory = Path(sibling)
            self.assertEqual(server.compilation_directory(self.root, source, directory.name), directory)
        (self.root / "value.tex").unlink()
        self.assertEqual(server.compilation_directory(self.root, source, None), source.parent)

    def test_warning_categories_do_not_expose_private_paths(self):
        log = io.BytesIO(b"LaTeX Warning: Reference 'PRIVATE' on page 1 undefined.\n"
                         b"No file C:/PRIVATE/main.ind.\nxdvipdfmx:warning: PRIVATE\n")
        warnings = server.compilation_warnings(log)
        self.assertEqual(len(warnings), 3)
        self.assertNotIn("PRIVATE", str(warnings))

    def test_failed_build_preserves_sources_and_previous_pdf(self):
        write_files(self.root, {"main.tex": b"original draft", ".latex-out/main.pdf": b"previous PDF"})
        before = fingerprint(self.root)
        def failed_engine(command, cwd, env, output, timeout, base, allowed):
            (cwd / "main.tex").write_bytes(b"temporary change")
            (base / "build/main.pdf").write_bytes(b"incomplete")
            return 1
        with patch.object(server, "texlive_engine", return_value=(self.temp / "pdflatex", {}, ())), \
                patch.object(server, "run_contained", side_effect=failed_engine):
            with self.assertRaises(server.BuildError):
                server.compile_pdf(self.root, {"source": "main.tex", "engine": "pdflatex"})
        self.assertEqual(fingerprint(self.root), before)
        self.assertEqual((self.root / ".latex-out/main.pdf").read_bytes(), b"previous PDF")

    @unittest.skipUnless(os.environ.get("HOST_LATEX_TEST_TEX") == "1", "requires a real TeX runtime")
    def test_generated_pdf_contains_project_inputs(self):
        # All expected content is supplied by real project files, not embedded in the main document.
        pdftotext = shutil.which("pdftotext")
        self.assertIsNotNone(pdftotext, "pdftotext is required for the real-output regression")
        main = br"""\documentclass{article}
\usepackage{makeidx,xr}
\makeindex
\externaldocument{external}
\begin{document}
\input{value.tex} \input{.generated/appendix.inc} \input{fig.pdf_tex}
\input{src/listing.py} \ref{external-label}.
\include{chapters/part}
\printindex
\end{document}
"""
        files = {
            "paper/main.tex": main, "paper/value.tex": b"SUB17", "value.tex": b"ROOT42",
            ".generated/appendix.inc": b"AppendixXYZ", "fig.pdf_tex": b"FigureLayerXYZ",
            "src/listing.py": b"ListingXYZ", "chapters/part.tex": b"ChapterXYZ",
            "external.aux": br"\newlabel{external-label}{{RefSeven}{1}{}{}{}}",
            "main.ind": br"\begin{theindex}\item IndexXYZ, 1\end{theindex}",
        }
        write_files(self.root, files)
        before = fingerprint(self.root)
        args = {"source": "paper/main.tex", "working_directory": "."}
        for engine in ("pdflatex", "xelatex"):
            with self.subTest(engine=engine):
                reply = stdio(self.root, [call(1, "tools/call", {"name": "latex_compile",
                                         "arguments": dict(args, engine=engine)})])[0]["result"]
                self.assertFalse(reply.get("isError"), reply)
                result = reply["structuredContent"]
                self.assertEqual(result["working_directory"], ".")
                self.assertFalse(any("未解析" in msg or "缺少参考文献" in msg
                                     for msg in result.get("warnings", ())), result)
                data = subprocess.check_output([pdftotext, str(self.root / result["pdf"]), "-"])
                self.assertGreaterEqual(data.count(b"\f"), 3)
                for token in (b"ROOT42", b"AppendixXYZ", b"FigureLayerXYZ", b"ListingXYZ",
                              b"RefSeven", b"ChapterXYZ", b"IndexXYZ"):
                    self.assertIn(token, data)
                self.assertNotIn(b"SUB17", data)
                self.assertEqual(before, fingerprint(self.root))
        write_files(self.root, {"paper/compare.tex":
                    br"\documentclass{article}\begin{document}\input{value.tex}\end{document}",
                    "alternate/value.tex": b"ALT23"})
        before = fingerprint(self.root)
        for folder, expected in (("paper", b"SUB17"), ("alternate", b"ALT23")):
            with self.subTest(working_directory=folder):
                args = {"source": "paper/compare.tex", "working_directory": folder, "engine": "pdflatex"}
                result = stdio(self.root, [call(1, "tools/call", {"name": "latex_compile",
                                           "arguments": args})])[0]["result"]
                self.assertFalse(result.get("isError"), result)
                pdf = self.root / result["structuredContent"]["pdf"]
                data = subprocess.check_output([pdftotext, str(pdf), "-"])
                self.assertIn(expected, data)
                self.assertNotIn(b"ROOT42", data)
                self.assertEqual(before, fingerprint(self.root))

    @unittest.skipUnless(os.environ.get("HOST_LATEX_TEST_TEX") == "1", "requires a real TeX runtime")
    def test_final_missing_reference_is_reported(self):
        write_files(self.root, {"main.tex": br"\documentclass{article}\begin{document}\ref{absent}\end{document}"})
        result = stdio(self.root, [call(1, "tools/call", {"name": "latex_compile",
                                    "arguments": {"engine": "pdflatex", "source": "main.tex"}})])[0]["result"]
        self.assertFalse(result.get("isError"), result)
        self.assertTrue((self.root / result["structuredContent"]["pdf"]).is_file())
        self.assertTrue(any("未解析" in msg for msg in result["structuredContent"]["warnings"]))
        self.assertNotIn("absent", json.dumps(result))
