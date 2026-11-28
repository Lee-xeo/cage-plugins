"""Document inputs selected for the host compiler's temporary project."""

from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

from test_host_latex import server
from test_host_latex_projects import write_files


class SelectionTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve() / "project"
        self.staging = self.root.parent / "staging"
        self.staging.mkdir()

    def test_brackets_in_graphics_options_do_not_hide_the_filename(self):
        source = Path("main.tex")
        write_files(self.root, {"figure.png": b"figure", "after.tex": b"after"})
        options = (
            "[alt={a]b}]",
            "[alt={{a[b}}]",
            "[alt={a% } ] ignored in this comment\n]b}]",
            r"[alt={\{a\}b]c}]",
        )
        for option in options:
            with self.subTest(option=option):
                manuscript = r"\includegraphics" + option + r"{figure.png}\input{after}"
                (self.root / source).write_text(manuscript, encoding="utf-8")
                files, edits, incomplete = server.referenced_inputs(
                    self.root, source, Path("."), self.root / source)
                self.assertEqual(set(files), {Path("figure.png"), Path("after.tex")})
                self.assertEqual(edits, [])
                self.assertFalse(incomplete)

    def test_graphics_directory_from_separate_preamble_reaches_chapter(self):
        figures = (self.root / "figures").as_posix()
        write_files(self.root, {
            "paper/main.tex": br"\input{preamble}\input{text}",
            "paper/preamble.tex": (r"\graphicspath{{" + figures + "/}}").encode(),
            "paper/text.tex": br"\includegraphics{plot}",
            "figures/plot.pdf": b"used",
            "figures/other.pdf": b"unused",
        })
        server.snapshot_project(self.root, self.staging, [], Path("paper/main.tex"), Path("paper"))
        self.assertEqual((self.staging / "figures/plot.pdf").read_bytes(), b"used")
        self.assertFalse((self.staging / "figures/other.pdf").exists())
        self.assertEqual((self.staging / "paper/preamble.tex").read_bytes(), br"\graphicspath{{../figures/}}")

    def test_includeonly_selects_the_right_chapter_when_basenames_match(self):
        first = (self.root / "first/chapter").as_posix()
        second = (self.root / "second/chapter").as_posix()
        manuscript = (rf"\includeonly{{{second}}}" + "\n" +
                      rf"\include{{{first}}}" + "\n" + rf"\include{{{second}}}").encode()
        write_files(self.root, {"paper/main.tex": manuscript, "first/chapter.tex": b"First",
                                "second/chapter.tex": b"Second"})
        server.snapshot_project(self.root, self.staging, [], Path("paper/main.tex"), Path("paper"))
        working = self.staging / "paper"
        staged = (working / "main.tex").read_text(encoding="utf-8")
        first_alias, second_alias = re.findall(r"\\include\{([^}]+)\}", staged)
        self.assertNotEqual(first_alias, second_alias)
        self.assertEqual(re.findall(r"\\includeonly\{([^}]+)\}", staged), [second_alias])
        for alias, directory in ((first_alias, "first"), (second_alias, "second")):
            with self.subTest(directory=directory):
                self.assertFalse(Path(alias).is_absolute())
                self.assertNotIn("..", Path(alias).parts)
                wrapper = (working / (alias + ".tex")).read_text(encoding="utf-8")
                self.assertIn("../" + directory + "/chapter.tex", wrapper)
        self.assertEqual((self.root / "paper/main.tex").read_bytes(), manuscript)

    def test_invalid_working_directory_components_are_rejected_before_lookup(self):
        source = self.root / "paper.tex"
        # Simulate a filesystem that treats names with trailing spaces/dots as
        # existing directories, even when running the suite on a POSIX host.
        with patch.object(Path, "is_dir", return_value=True):
            for folder in ("part.", "part ", "part./sub", "part /sub", "sub/part.", "sub/part "):
                with self.subTest(folder=folder), self.assertRaises(server.BuildError):
                    server.compilation_directory(self.root, source, folder)
            for folder in (".", ".draft", "part.v2", "two words"):
                with self.subTest(folder=folder):
                    self.assertEqual(server.compilation_directory(self.root, source, folder),
                                     self.root / folder)
