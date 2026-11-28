"""Keep project-local absolute graphic names working in a private project copy."""

from pathlib import Path


# Install after graphics defines the file loader, leaving graphicx options,
# driver selection and the document's own source untouched.
_GRAPHICS_HOOK = r"""
\def\HostLatexLoadFile#1#2{%
  \ifcsname HostLatexGraphic/\detokenize{#1}\endcsname
    \edef\HostLatexGraphicName{\csname HostLatexGraphic/\detokenize{#1}\endcsname}%
    \expandafter#2\expandafter{\HostLatexGraphicName}%
  \else
    #2{#1}%
  \fi}
\def\HostLatexLoadGraphic#1{\HostLatexLoadFile{#1}\HostLatexOriginalLoad}
\def\HostLatexFindPDF#1{\HostLatexLoadFile{#1}\HostLatexOriginalFindPDF}
\def\HostLatexInstallGraphics{%
  \let\HostLatexOriginalLoad\Ginclude@graphics
  \let\Ginclude@graphics\HostLatexLoadGraphic}
\def\HostLatexInstallPDFPages{%
  \let\HostLatexOriginalFindPDF\AM@findfile
  \let\AM@findfile\HostLatexFindPDF}
\ifdefined\AddToHook
  \AddToHook{package/graphics/after}{\HostLatexInstallGraphics}%
  \AddToHook{package/pdfpages/after}{\HostLatexInstallPDFPages}%
\else
  \AtBeginDocument{%
    \@ifundefined{Ginclude@graphics}{}{\HostLatexInstallGraphics}%
    \@ifundefined{AM@findfile}{}{\HostLatexInstallPDFPages}}%
\fi
\makeatother
"""


def tex_filename(value):
    # Even \detokenize needs a balanced argument and cannot protect a comment
    # or ^^ character translation, which occur before TeX constructs its tokens.
    if not value or any(not char.isprintable() or char in r'\{}%#^"' for char in value):
        raise ValueError("Unsupported character in a LaTeX graphics path")
    return r"\detokenize{" + value + "}"


def graphics_command(aliases, source_argument, jobname, base):
    """Return the engine's input arguments for already selected staged graphics."""
    if not aliases:
        return [source_argument]
    lines = [r"\makeatletter"]
    for actual, staged in sorted(aliases.items()):
        if not Path(actual).is_absolute() or Path(staged).is_absolute():
            raise ValueError("Invalid graphics mapping")
        escaped = tex_filename(actual)
        target = tex_filename(staged)
        # Match literal, quoted, and explicitly detokenized filename operands
        # without expanding arbitrary macros in the document to probe for a key.
        for operand in (actual, '"' + actual + '"', escaped, r'\detokenize{"' + actual + '"}'):
            lines.append(r"\expandafter\def\csname HostLatexGraphic/\detokenize{" + operand
                         + r"}\endcsname{" + target + "}")
    lines.extend([_GRAPHICS_HOOK, r"\input{" + tex_filename(source_argument) + "}"])
    # Keep the original job name through TeX's normal entry filename, including
    # the names TeX uses for bibliography, bookmarks and auxiliary files.
    entry = Path(base) / (jobname + ".tex")
    with entry.open("xb") as out:
        out.write(("\n".join(lines) + "\n").encode("utf-8"))
    return [str(entry)]
