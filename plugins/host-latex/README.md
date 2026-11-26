# Local LaTeX

Local LaTeX compiles TeX files from the open, shared project using an existing TeX Live installation. It returns the path to the resulting PDF inside the project.

## Use

Install Python 3.9 or newer and TeX Live on the computer running the plugin. Make `xelatex`, `pdflatex`, and `kpsewhich` available on PATH. The plugin also checks the standard MacTeX binary directory.

Open a shared project and call `latex_compile` with a project-relative path such as `paper/main.tex`. The default engine is XeLaTeX. Select `pdflatex` for documents that require it. A successful build writes `.cage-latex/paper/main.pdf`.

The plugin runs two passes for common cross-references. Projects that require BibTeX or Biber can supply an existing `.bbl` file.

## Permissions and data flow

- `files` reads the shared project's source and assets and writes the generated PDF into that project.
- `commands` runs the installed TeX Live compiler and its installation lookup tool. The tool accepts a source path and a choice of engine.
- This plugin makes no network requests and downloads no dependencies. It uses the Python standard library.

Compile trusted projects. The tool makes a temporary copy of the relevant files, disables TeX shell escape, and checks the compiler's recorded paths before publishing the PDF. TeX still runs with the host account's privileges. Keep the normal per-call approval for this tool.

The MCP service can also run directly with `python3 -I -B server.py /absolute/path/to/project` using standard input and output.
