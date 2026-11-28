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

    def test_scoped_snapshot_skips_unrelated_tree_and_keeps_shared_inputs(self):
        files = {
            "paper/main.tex": br"\input{part}\includegraphics{../plots/result}\bibliography{../refs/library}",
            "paper/part.tex": br"\input{../tables/numbers.inc}",
            "paper/main.bbl": b"prepared bibliography",
            "plots/result.pdf": b"original graphic",
            "tables/numbers.inc": b"42",
            "refs/library.bib": b"original references",
            "custom/data": b"input selected for a macro",
        }
        write_files(self.root, files)
        write_files(self.root, {"experiments/unrelated.pdf": b"unrelated", "paper/earlier-draft.pdf": b"old"})
        stage = self.temp / "scratch" / "stage"
        stage.mkdir(parents=True)
        with patch.object(server.os, "walk", side_effect=AssertionError("unexpected directory walk")):
            _, count, size, _ = server.snapshot_project(
                self.root, stage, [Path("custom/data")], Path("paper/main.tex"), Path("paper"))
        self.assertEqual(count, len(files))
        self.assertEqual(size, sum(map(len, files.values())))
        self.assertEqual({p.relative_to(stage).as_posix(): p.read_bytes()
                          for p in stage.rglob("*") if p.is_file()}, files)

    def test_project_inputs_keeps_directory_data_for_dynamic_names(self):
        write_files(self.root, {"paper/main.tex": b"paper", "assets/nested/data.custom": b"42",
                                "assets/.env": b"private", "unrelated/log": b"log"})
        with self.assertRaises(server.BuildError):
            server.input_name("../outside")
        stage = self.temp / "scratch" / "stage"
        stage.mkdir(parents=True)
        _, count, _, _ = server.snapshot_project(
            self.root, stage, [Path("assets"), Path("assets/nested")], Path("paper/main.tex"), Path("paper"))
        self.assertEqual(count, 2)
        self.assertEqual((stage / "assets/nested/data.custom").read_bytes(), b"42")
        self.assertFalse((stage / "assets/.env").exists())

    def test_edits_only_file_operands_in_the_staged_copy(self):
        path = (self.root / "shared/part.tex").as_posix().encode()
        prose = b"% " + path + b"\r\nLatin-1: \xe9. " + path + b"\r\n"
        example = b"\\begin{verbatim}\r\n\\input{" + path + b"}\r\n\\end{verbatim}\r\n"
        manuscript = prose + example + b"\\input{" + path + b"}\r\n"
        write_files(self.root, {"paper/main.tex": manuscript, "shared/part.tex": b"Part\r\n"})
        before = fingerprint(self.root)
        stage = self.temp / "stage"
        stage.mkdir()
        server.snapshot_project(self.root, stage, [], Path("paper/main.tex"), Path("paper"))
        self.assertEqual((stage / "paper/main.tex").read_bytes(),
                         prose + example + b"\\input{../shared/part.tex}\r\n")
        self.assertEqual(fingerprint(self.root), before)

    def test_sibling_chapter_and_includeonly_share_the_same_aux_name(self):
        part = (self.root / "chapters/part").as_posix()
        manuscript = (r"\includeonly{" + part + "}\n" + r"\include{" + part + "}\n").encode()
        write_files(self.root, {"paper/main.tex": manuscript, "chapters/part.tex": b"Chapter"})
        stage = self.temp / "stage"
        stage.mkdir()
        server.snapshot_project(self.root, stage, [], Path("paper/main.tex"), Path("paper"))
        commands = (stage / "paper/main.tex").read_text().splitlines()
        target = commands[0].split("{")[1].rstrip("}")
        self.assertEqual(commands[1], r"\include{" + target + "}")
        self.assertNotIn("..", Path(target).parts)
        self.assertFalse(Path(target).is_absolute())
        self.assertIn(b"../chapters/part.tex", (stage / "paper" / (target + ".tex")).read_bytes())

    def test_selected_chapters_retain_their_own_absolute_inputs(self):
        shared = (self.root / "shared/values.tex").as_posix()
        chapter = (r"\input{" + shared + "}").encode()
        write_files(self.root, {"paper/main.tex": br"\input{\chosen}",
                                "sections/part.tex": chapter, "shared/values.tex": b"42"})
        stage = self.temp / "stage"
        stage.mkdir()
        server.snapshot_project(self.root, stage, [Path("sections")], Path("paper/main.tex"), Path("paper"))
        self.assertEqual((stage / "sections/part.tex").read_bytes(), br"\input{../shared/values.tex}")
        self.assertEqual((stage / "shared/values.tex").read_bytes(), b"42")
        self.assertEqual((self.root / "sections/part.tex").read_bytes(), chapter)

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

    def test_publish_creates_nested_pdf_and_preserves_last_copy_on_failure(self):
        relative = Path(".latex-out/papers/My Paper.pdf")
        destination = self.root / relative
        compiled = self.temp / "compiled.pdf"
        with server.pin_project(self.root) as project:
            for content in (b"first PDF", b"revised PDF"):
                compiled.write_bytes(content)
                project.publish(compiled, relative)
                self.assertEqual(destination.read_bytes(), content)

            previous = destination.stat().st_mtime_ns
            with self.assertRaises((OSError, server.BuildError)):
                project.publish(self.temp / "missing.pdf", relative)
            self.assertEqual(destination.read_bytes(), b"revised PDF")
            self.assertEqual(destination.stat().st_mtime_ns, previous)
            self.assertEqual(list(destination.parent.iterdir()), [destination])

    def test_publish_refuses_non_directory_output_component(self):
        write_files(self.root, {".latex-out/papers": b"existing file"})
        compiled = self.temp / "compiled.pdf"
        compiled.write_bytes(b"new PDF")
        with server.pin_project(self.root) as project:
            with self.assertRaises((OSError, server.BuildError)):
                project.publish(compiled, Path(".latex-out/papers/main.pdf"))
        obstacle = self.root / ".latex-out/papers"
        self.assertEqual(obstacle.read_bytes(), b"existing file")
        self.assertEqual(list(obstacle.parent.iterdir()), [obstacle])

    def test_reopened_project_requires_a_new_session(self):
        old_root = self.root.stat()
        self.root.rename(self.temp / "old-project")
        write_files(self.root, {"main.tex": b"new draft"})
        request = call(1, "tools/call", {"name": "latex_compile", "arguments": {"source": "main.tex"}})
        with patch.object(server, "texlive_engine") as engine:
            result = server.respond(self.root, request, (old_root.st_dev, old_root.st_ino))
        self.assertTrue(result.get("isError"))
        self.assertIn("重新打开项目", result["content"][0]["text"])
        engine.assert_not_called()
        self.assertEqual(list(self.root.iterdir()), [self.root / "main.tex"])

    def test_publish_checks_identity_of_existing_output_directory(self):
        relative = Path(".latex-out/papers/main.pdf")
        saved = self.root / relative
        write_files(self.root, {relative: b"previous PDF"})
        compiled = self.temp / "compiled.pdf"
        compiled.write_bytes(b"new PDF")
        archived = self.temp / "archived-output"
        previous = saved.stat().st_mtime_ns

        with server.pin_project(self.root, relative) as project:
            try:
                saved.parent.rename(archived)
            except PermissionError as error:
                if os.name != "nt" or error.winerror not in (5, 32):
                    raise
                project.publish(compiled, relative)
                self.assertEqual(saved.read_bytes(), b"new PDF")
            else:
                saved.parent.mkdir()
                with self.assertRaises((OSError, server.BuildError)):
                    project.publish(compiled, relative)
                self.assertEqual(list(saved.parent.iterdir()), [])
                original = archived / saved.name
                self.assertEqual(list(archived.iterdir()), [original])
                self.assertEqual(original.read_bytes(), b"previous PDF")
                self.assertEqual(original.stat().st_mtime_ns, previous)

    def test_project_rename_during_compile_keeps_output_in_selected_project(self):
        write_files(self.root, {"main.tex": b"draft", ".latex-out/main.pdf": b"previous PDF"})
        sibling = self.temp / "unrelated"
        write_files(sibling, {"record.txt": b"unrelated"})
        before = fingerprint(sibling)
        archived = self.temp / "archived-project"
        rename_attempted = False

        def complete_engine(command, cwd, env, output, timeout, base, allowed):
            nonlocal rename_attempted
            if not rename_attempted:
                rename_attempted = True
                try:
                    self.root.rename(archived)
                except PermissionError as error:
                    # A pinned Windows directory can reject the rename itself.
                    if os.name != "nt" or error.winerror not in (5, 32):
                        raise
                else:
                    self.root.mkdir()
            (base / "build/main.pdf").write_bytes(b"new PDF")
            return 0

        request = call(1, "tools/call", {"name": "latex_compile",
                                        "arguments": {"source": "main.tex", "engine": "pdflatex"}})
        with patch.object(server, "texlive_engine", return_value=(self.temp / "pdflatex", {}, ())), \
                patch.object(server, "run_contained", side_effect=complete_engine):
            result = server.respond(self.root, request)

        self.assertTrue(rename_attempted)
        if archived.exists():
            self.assertTrue(result.get("isError"), result)
            self.assertEqual(list(self.root.iterdir()), [])
            previous_pdf = archived / ".latex-out/main.pdf"
            self.assertEqual(previous_pdf.read_bytes(), b"previous PDF")
            self.assertEqual(list(previous_pdf.parent.iterdir()), [previous_pdf])
        else:
            self.assertFalse(result.get("isError"), result)
            self.assertEqual((self.root / ".latex-out/main.pdf").read_bytes(), b"new PDF")
        self.assertEqual(fingerprint(sibling), before)
        self.assertEqual(list(sibling.iterdir()), [sibling / "record.txt"])

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
