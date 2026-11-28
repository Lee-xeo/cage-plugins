"""Literal project references used for scoped host compilation."""

import importlib.util
from pathlib import Path
import tempfile
import unittest


MODULE = Path(__file__).resolve().parents[1] / "project_dependencies.py"
SPEC = importlib.util.spec_from_file_location("host_latex_dependencies", MODULE)
dependencies = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dependencies)


class ProjectDependencyTests(unittest.TestCase):
    def test_scoped_figures_references_and_tex_inputs(self):
        with tempfile.TemporaryDirectory() as temp:
            scratch = Path(temp).resolve()
            root = scratch / "project"
            files = ["src/main.tex", "src/main.bbl", "src/local.cls",
                     "shared/figures/my plot.png", "shared/figures/cover.pdf", "shared/table.tex",
                     "shared/data.csv", "shared/refs.bib", "shared/thesis.aux", "shared/ref.bst",
                     "shared/unreferenced.txt", "shared/ignored.pdf", "shared/macro.pdf"]
            for name in files:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"fixture")
            (scratch / "outside.pdf").write_bytes(b"unrelated")
            source = Path("src/main.tex")
            absolute = (root / "shared/figures/cover.pdf").as_posix()
            manuscript = (
                r"\documentclass{local}" "\n"
                r"\graphicspath{{../shared/figures/}}" "\n"
                r"\includegraphics[height={3cm}]{my plot}" "\n"
                r"\includegraphics{\detokenize{" + absolute + "}}\n"
                r"\input ../shared/table" "\n"
                r"\lstinputlisting{../shared/data.csv}" "\n"
                r"\bibliography{../shared/refs}" "\n"
                r"\bibliographystyle{../shared/ref}" "\n"
                r"\externaldocument[prefix]{../shared/thesis}" "\n"
                r"\includegraphics{../../outside.pdf}" "\n"
                r"% \includegraphics{../shared/ignored.pdf}" "\n"
                r"\verb|\includegraphics{../shared/ignored.pdf}|" "\n"
                r"\begin{verbatim}\input{../shared/ignored.pdf}\end{verbatim}" "\n"
                r"\includegraphics{\dynamicname}" "\n")
            staged = scratch / "staged.tex"
            staged.write_text(manuscript, encoding="utf-8")
            result, edits, incomplete = dependencies.referenced_inputs(root, source, source.parent, staged)
            self.assertEqual(set(result), {Path(name) for name in files[1:10]})
            self.assertTrue(incomplete)
            self.assertEqual(staged.read_text(encoding="utf-8"), manuscript)
            dependencies.apply_staged_edits(staged, edits)
            self.assertEqual(staged.read_text(encoding="utf-8"),
                             manuscript.replace(absolute, "../shared/figures/cover.pdf"))

    def test_graphics_keep_native_extension_selection(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            for filename in ("plot.final.png", "plot.final.pdf"):
                (root / filename).touch()
            raw = (root / "plot.final").as_posix()
            source = Path("main.tex")
            (root / source).write_text(r"\includegraphics{" + raw + "}", encoding="utf-8")
            staged = root / "staged.tex"
            staged.write_bytes((root / source).read_bytes())
            files, edits, incomplete = dependencies.referenced_inputs(root, source, Path("."), staged)
            self.assertEqual(set(files), {Path("plot.final.pdf"), Path("plot.final.png")})
            dependencies.apply_staged_edits(staged, edits)
            self.assertEqual(staged.read_text(), r"\includegraphics{plot.final}")
            self.assertFalse(incomplete)

    def test_reference_across_text_blocks_and_multiline_options(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            (root / "figure.pdf").touch()
            # The control sequence crosses the stream reader's 64 KiB boundary.
            content = "a" * 65532 + "\\includegraphics[\nwidth=2cm\n]{figure}"
            source = Path("main.tex")
            (root / source).write_text(content, encoding="utf-8")
            result = dependencies.referenced_inputs(root, source, Path("."), root / source)
            self.assertEqual(result, ([Path("figure.pdf")], [], False))

    def test_graphic_candidates_use_the_filename_stored_by_the_filesystem(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            upper, lower = root / "figure.PNG", root / "figure.png"
            upper.touch()
            if lower.exists():
                upper.rename(root / "figure.PnG")
                expected = {"figure.PnG"}
            else:
                lower.touch()
                expected = {"figure.PNG", "figure.png"}
            source = Path("main.tex")
            (root / source).write_text(r"\includegraphics{figure}", encoding="utf-8")
            files, _, _ = dependencies.referenced_inputs(root, source, Path("."), root / source)
            self.assertEqual({p.as_posix() for p in files}, expected)

    def test_probe_requires_every_original_directory_component(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            (root / "figure.pdf").touch()
            candidate = root / "missing-folder" / ".." / "figure.pdf"
            self.assertIsNone(dependencies.existing_file(root, candidate))
            self.assertFalse(dependencies.supported_path("C:figure.pdf"))
            self.assertFalse(dependencies.supported_path("//?/C:/figure.pdf"))
