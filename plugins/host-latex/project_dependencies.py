"""Find literal project inputs without enumerating the shared project."""

import os
from pathlib import Path, PureWindowsPath
import re
import stat


# This list selects files to inspect for TeX commands. It never filters a file
# explicitly chosen as input or referenced by a command with a literal name.
TEX_SOURCES = {"", ".tex", ".ltx", ".cls", ".clo", ".sty", ".def", ".cfg", ".fd",
               ".inc", ".tikz", ".pgf", ".pdf_tex", ".bbl", ".aux", ".ind", ".gls"}
GRAPHICS = ("", ".pdf", ".png", ".jpg", ".jpeg", ".jbig2", ".jb2", ".mps", ".eps",
            ".ps", ".bmp", ".PDF", ".PNG", ".JPG", ".JPEG", ".EPS", ".PS")
COMMANDS = {
    "input": ("", ".tex"), "include": ("", ".tex"), "subfile": ("", ".tex"),
    "InputIfFileExists": ("", ".tex"), "IfFileExists": ("", ".tex"),
    "@input": ("", ".tex"), "externaldocument": (".aux",),
    "usepackage": (".sty",), "RequirePackage": (".sty",),
    "documentclass": (".cls",), "LoadClass": (".cls",),
    "bibliography": (".bib",), "addbibresource": (".bib",),
    "bibliographystyle": (".bst",), "lstinputlisting": ("",),
    "includegraphics": GRAPHICS, "includepdf": (".pdf",),
}
COMMA_LIST = {"usepackage", "RequirePackage", "bibliography"}
VERBATIM = {"verbatim", "verbatim*", "Verbatim", "lstlisting", "minted", "comment"}
FILE_OPERAND_LENGTH = 32768  # A single filesystem operand, not the source file.


class Reader:
    """One-character lookahead over fixed-size text blocks."""

    def __init__(self, data):
        self.chars = (c for block in iter(lambda: data.read(65536), "") for c in block)
        self.char = next(self.chars, "")

    def take(self):
        current = self.char
        self.char = next(self.chars, "")
        return current

    def comment(self):
        while self.char and self.take() != "\n":
            pass

    def spaces(self):
        while self.char:
            if self.char == "%":
                self.comment()
            elif self.char.isspace():
                self.take()
            else:
                break

    def word(self, accepts, maximum):
        result = []
        while self.char and accepts(self.char):
            char = self.take()
            if len(result) <= maximum:
                result.append(char)
        return "".join(result) if len(result) <= maximum else ""

    def braced(self, opening, closing, keep=True):
        self.spaces()
        if self.char != opening:
            return None
        self.take()
        depth = 1
        value = []
        while self.char:
            char = self.take()
            if char == "%":
                self.comment()
                continue
            if char == opening:
                depth += 1
            if char == closing:
                depth -= 1
                if not depth:
                    return "".join(value)
            if char == "\\" and self.char:
                char += self.take()
            if keep:
                value.append(char)
                if len(value) > FILE_OPERAND_LENGTH:
                    raise ValueError("项目引用的文件名过长，无法识别。")
        return None


def arguments(data):
    reader = Reader(data)
    verbatim = None
    while reader.char:
        char = reader.take()
        if char == "%" and not verbatim:
            reader.comment()
        if char != "\\" or not reader.char:
            continue
        if not reader.char.isascii() or not (reader.char.isalpha() or reader.char == "@"):
            reader.take()  # Escaped punctuation, including literal \\ and \%.
            continue
        name = reader.word(lambda c: c.isascii() and (c.isalpha() or c == "@"), 64)
        if verbatim:
            if name == "end" and reader.braced("{", "}") == verbatim:
                verbatim = None
            continue
        if name == "begin":
            env = reader.braced("{", "}")
            if env in VERBATIM:
                verbatim = env
            continue
        if name == "verb":
            if reader.char == "*":
                reader.take()
            delimiter = reader.take()
            while reader.char and reader.take() not in (delimiter, "\n"):
                pass
            continue
        if name not in COMMANDS and name != "graphicspath":
            continue
        if reader.char == "*":
            reader.take()
        while reader.braced("[", "]", keep=False) is not None:
            pass
        if name == "graphicspath":
            reader.spaces()
            if reader.char == "{":
                reader.take()
                while True:
                    directory = reader.braced("{", "}")
                    if directory is None:
                        break
                    yield name, directory
                if reader.char != "}":
                    yield name, None
            continue
        value = reader.braced("{", "}")
        if value is None and name == "input":
            if reader.char == "\\":
                yield name, None
            value = reader.word(lambda c: not c.isspace() and c not in "\\{}%", FILE_OPERAND_LENGTH)
        if value:
            yield name, value


def literal(value):
    if not value:
        return None
    value = value.strip()
    unwrapped = re.fullmatch(r"\\detokenize\s*\{([^{}]*)\}", value)
    if unwrapped:
        value = unwrapped[1]
    if len(value) > 1 and value.startswith('"') and value.endswith('"'):
        value = value[1:-1]
    if not value or re.search(r'[\\{}#$~\x00-\x1f]', value):
        return None
    return value


def existing_file(root, candidate):
    """Only return ordinary files reached through ordinary project directories."""
    try:
        relative = candidate.relative_to(root)
    except ValueError:
        return None
    entry = root
    for index, part in enumerate(relative.parts):
        if part == "..":
            if entry == root:
                return None
            entry = entry.parent
            continue
        if os.name == "nt":
            reserved = os.path.isreserved(part) if hasattr(os.path, "isreserved") else PureWindowsPath(part).is_reserved()
            if reserved or ":" in part or part.endswith((" ", ".")):
                return None
        entry /= part
        try:
            info = entry.lstat()
        except OSError:
            return None
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            return None
        if index + 1 < len(relative.parts) and not stat.S_ISDIR(info.st_mode):
            return None
    if not relative.parts or relative.parts[-1] == ".." or not stat.S_ISREG(info.st_mode):
        return None
    return entry.relative_to(root)


def supported_path(operand):
    """Reject Windows drive-relative, current-drive-rooted and device names."""
    win = PureWindowsPath(operand)
    if win.drive and (os.name != "nt" or not win.root):
        return False
    if os.name == "nt" and win.root and not win.drive:
        return False
    return not operand.startswith(("//?/", "//./"))


def stored_names(root, paths):
    """Keep the on-disk spelling when two extension probes find the same file."""
    spellings = {}
    for path in paths:
        spellings.setdefault((path.parent, path.name.casefold()), []).append(path)
    confirmed, ambiguous = [], {}
    for (parent, name), variants in spellings.items():
        if len(variants) == 1:
            confirmed.extend(variants)
        else:
            ambiguous.setdefault(parent, {})[name] = {(root / path).lstat().st_ino for path in variants}
    # One shallow listing per directory with ambiguous matches. APFS may find
    # both figure.png and figure.PNG for a single entry stored as figure.Png.
    # Case-sensitive filesystems may actually contain both entries.
    for parent, names in ambiguous.items():
        with os.scandir(root / parent) as entries:
            for entry in entries:
                identities = names.get(entry.name.casefold())
                if identities is not None and Path(entry.path).lstat().st_ino in identities:
                    confirmed.append(parent / entry.name)
    return sorted(confirmed)


def referenced_inputs(root, source, cwd, staged_file):
    """Return files, absolute graphics aliases and whether an operand was nonliteral."""
    if source.suffix.lower() not in TEX_SOURCES:
        return [], {}, False
    # TeX filenames can depend on macros or packages. Preserve the native TeX
    # lookup and allow additional project_inputs for anything nonliteral.
    base_dirs = tuple(dict.fromkeys((root / cwd, root / source.parent)))
    graphics_dirs = {}
    found, aliases = {}, {}
    incomplete = False
    with staged_file.open(encoding="utf-8-sig", errors="replace") as data:
        if "\x00" in data.read(4096):
            return [], {}, False
        data.seek(0)
        for name, value in arguments(data):
            if name == "graphicspath":
                entry = literal(value)
                if entry and supported_path(entry):
                    graphics_dirs.update((base / entry, None) for base in base_dirs)
                elif not entry:
                    incomplete = True
        data.seek(0)
        for name, value in arguments(data):
            if name == "graphicspath":
                continue
            graphics = name in ("includegraphics", "includepdf")
            for item in value.split(",") if name in COMMA_LIST and value else (value,):
                operand = literal(item)
                if not operand:
                    incomplete = True
                    continue
                if not supported_path(operand):
                    continue
                path = Path(operand)
                # A name like plot.final may still mean plot.final.pdf in graphicx.
                suffixes = ("",) if path.suffix and path.suffix.lower() in COMMANDS[name] else COMMANDS[name]
                roots = (root,) if path.is_absolute() else (*base_dirs, *(graphics_dirs if graphics else ()))
                for base in dict.fromkeys(roots):
                    for extension in suffixes:
                        relative = existing_file(root, base / (operand + extension))
                        if relative is not None:
                            found[relative.as_posix()] = relative
                            if graphics and path.is_absolute():
                                alias = Path(os.path.relpath(os.path.normpath(path), root / cwd))
                                aliases[operand] = alias.as_posix()
    # LaTeX opens the prepared bibliography/index by job name. Sources may
    # reside below cwd when the project normally runs TeX from the root.
    for base in base_dirs:
        for suffix in (".bbl", ".ind", ".gls"):
            prepared = existing_file(root, base / (source.stem + suffix))
            if prepared is not None:
                found[prepared.as_posix()] = prepared
    return stored_names(root, found.values()), aliases, incomplete
