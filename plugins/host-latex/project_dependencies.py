"""Find literal project inputs without enumerating the shared project."""

import os
from pathlib import Path, PureWindowsPath
import re
import shutil
import stat
import tempfile


# This list selects files to inspect for TeX commands. It never filters a file
# explicitly chosen as input or referenced by a command with a literal name.
TEX_SOURCES = {"", ".tex", ".ltx", ".cls", ".clo", ".sty", ".def", ".cfg", ".fd",
               ".inc", ".tikz", ".pgf", ".pdf_tex", ".bbl", ".aux", ".ind", ".gls"}
GRAPHICS = ("", ".pdf", ".png", ".jpg", ".jpeg", ".jbig2", ".jb2", ".mps", ".eps",
            ".ps", ".bmp", ".PDF", ".PNG", ".JPG", ".JPEG", ".EPS", ".PS")
COMMANDS = {
    "input": ("", ".tex"), "include": (".tex",), "includeonly": (".tex",), "subfile": ("", ".tex"),
    "InputIfFileExists": ("", ".tex"), "IfFileExists": ("", ".tex"),
    "@input": ("", ".tex"), "externaldocument": (".aux",),
    "usepackage": (".sty",), "RequirePackage": (".sty",),
    "documentclass": (".cls",), "LoadClass": (".cls",),
    "bibliography": (".bib",), "addbibresource": (".bib",),
    "bibliographystyle": (".bst",), "lstinputlisting": ("",),
    "includegraphics": GRAPHICS, "includepdf": (".pdf",),
}
COMMA_LIST = {"usepackage", "RequirePackage", "bibliography", "includeonly"}
VERBATIM = {"verbatim", "verbatim*", "Verbatim", "lstlisting", "minted", "comment"}
FILE_OPERAND_LENGTH = 32768  # A single filesystem operand, not the source file.


class Reader:
    """One-character lookahead over fixed-size text blocks."""

    def __init__(self, data):
        self.chars = (c for block in iter(lambda: data.read(65536), "") for c in block)
        self.char = next(self.chars, "")
        self.position = 0

    def take(self):
        current = self.char
        self.char = next(self.chars, "")
        self.position += len(current)
        return current

    def comment(self):
        while self.char and self.char not in "\r\n":
            self.take()
        if self.char == "\r":
            self.take()
        if self.char == "\n":
            self.take()

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
        self.start = self.position
        self.comments = []
        depth = 1
        value = []
        length = 0
        while self.char:
            char = self.take()
            if char == "%":
                start = self.position - 1
                self.comment()
                if keep:
                    skipped = self.position - start
                    if self.comments and self.comments[-1][0] == length:
                        skipped += self.comments.pop()[1]
                    self.comments.append((length, skipped))
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
                length += len(char)
                if length > FILE_OPERAND_LENGTH:
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
        if name in ("detokenize", "url", "nolinkurl"):
            reader.braced("{", "}", keep=False)
            continue
        if name == "string":
            reader.spaces()
            if reader.take() == "\\":
                if reader.char.isalpha():
                    reader.word(str.isalpha, 64)
                else:
                    reader.take()
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
                    yield name, directory, reader.start, reader.comments
                if reader.char != "}":
                    yield name, None, reader.position, ()
            continue
        value = reader.braced("{", "}")
        if value is None and name == "input":
            if reader.char == "\\":
                yield name, None, reader.position, ()
            reader.start = reader.position
            reader.comments = []
            if reader.char == '"':
                reader.take()
                quoted = reader.word(lambda c: c not in '"\r\n\\{}%', FILE_OPERAND_LENGTH)
                if reader.char == '"':
                    value = '"' + quoted + reader.take()
            else:
                value = reader.word(lambda c: not c.isspace() and c not in "\\{}%", FILE_OPERAND_LENGTH)
        if value:
            yield name, value, reader.start, reader.comments


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


def existing_file(root, candidate, *, directory=False):
    """Only return ordinary files/directories reached through ordinary project directories."""
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
    if directory:
        if not entry.is_dir():
            return None
    elif not relative.parts or relative.parts[-1] == ".." or not stat.S_ISREG(info.st_mode):
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


def operand_edits(start, comments, left, right, replacement):
    """Replace only the filename characters. Keep TeX wrappers, spaces and comments."""
    cursor = left
    for at, skipped in comments:
        if at >= right:
            break
        if at > cursor:
            yield start + cursor, start + at, replacement
            cursor, replacement = at, ""
        start += skipped
    if cursor < right:
        yield start + cursor, start + right, replacement


def apply_staged_edits(staged_file, edits):
    """Stream the private copy through a sibling file, preserving all other bytes."""
    if not edits:
        return
    io_options = dict(encoding="utf-8", errors="surrogateescape", newline="")
    sibling = None
    try:
        with staged_file.open("r", **io_options) as source:
            with tempfile.NamedTemporaryFile(mode="w", dir=staged_file.parent,
                                             delete=False, **io_options) as output:
                sibling = Path(output.name)
                position = 0
                for start, end, replacement in edits:
                    if start < position or end < start:
                        raise ValueError("编译副本中的文件引用位置有误。")
                    while position < start:
                        block = source.read(min(65536, start - position))
                        if not block:
                            raise ValueError("编译副本中的文件引用位置有误。")
                        output.write(block)
                        position += len(block)
                    if len(source.read(end - start)) != end - start:
                        raise ValueError("编译副本中的文件引用位置有误。")
                    output.write(replacement)
                    position = end
                shutil.copyfileobj(source, output, 65536)
        os.replace(sibling, staged_file)
    finally:
        if sibling is not None:
            sibling.unlink(missing_ok=True)


def matching_inputs(root, operand, bases, name):
    # An extension such as ".final" can still mean "plot.final.pdf" in graphicx.
    path = Path(operand)
    suffixes = COMMANDS[name]
    if path.suffix and path.suffix.lower() in suffixes:
        suffixes = ("",)
    for base in ((root,) if path.is_absolute() else dict.fromkeys(bases)):
        for extension in suffixes:
            relative = existing_file(root, base / (operand + extension))
            if relative is not None:
                yield relative


def referenced_inputs(root, source, cwd, staged_file, *, graphics_dirs=None, include_alias=None, bib_alias=None):
    """Return inputs, filename edits for the staged source and whether a name was nonliteral."""
    if source.suffix.lower() not in TEX_SOURCES:
        return [], [], False
    base_dirs = tuple(dict.fromkeys((root / cwd, root / source.parent)))
    if graphics_dirs is None:
        graphics_dirs = set()
    found, edits = {}, []
    incomplete = False
    # Exact character offsets round-trip with unchanged newlines and surrogateescape,
    # including a BOM or non-UTF-8 bytes in text outside the filenames.
    with staged_file.open(encoding="utf-8", errors="surrogateescape", newline="") as data:
        if "\x00" in data.read(4096):
            return [], [], False
        data.seek(0)
        for name, value, _, _ in arguments(data):
            if name == "graphicspath":
                entry = literal(value)
                if entry and supported_path(entry):
                    for base in base_dirs:
                        directory = existing_file(root, base / entry, directory=True)
                        if directory is not None:
                            graphics_dirs.add(root / directory)
                elif not entry:
                    incomplete = True
        data.seek(0)
        for name, value, start, comments in arguments(data):
            graphics = name in ("includegraphics", "includepdf")
            offset = 0
            for item in value.split(",") if name in COMMA_LIST and value else (value,):
                item_offset = offset
                offset += len(item or "") + 1
                operand = literal(item)
                if not operand:
                    incomplete = True
                    continue
                if not supported_path(operand):
                    continue
                path = Path(operand)
                replacement = None
                if path.is_absolute() and path.is_relative_to(root):
                    replacement = Path(os.path.relpath(path, root / cwd)).as_posix()
                text = operand
                if name == "graphicspath":
                    if replacement is None or existing_file(root, path, directory=True) is None:
                        continue
                    if operand.endswith("/"):
                        replacement += "/"
                else:
                    bases = (*base_dirs, *graphics_dirs) if graphics else base_dirs
                    matches = list(matching_inputs(root, operand, bases, name))
                    if name != "includeonly":
                        found.update((relative.as_posix(), relative) for relative in matches)
                    if not matches or replacement is None:
                        continue
                    if name in ("include", "includeonly") and include_alias and not matches[0].is_relative_to(cwd):
                        # LaTeX writes <name>.aux within the output tree as well.
                        replacement = include_alias(matches[0])
                    if name in ("bibliography", "bibliographystyle"):
                        # BibTeX's AUX reader rejects whitespace even within quotes.
                        # TeX quotes and detokenize wrappers aren't part of its filename.
                        text = item.strip()
                        if bib_alias and any(char.isspace() for char in replacement):
                            replacement = bib_alias(matches[0])
                            if path.suffix.lower() == matches[0].suffix.lower():
                                replacement += matches[0].suffix.lower()
                left = item_offset + item.index(text)
                edits.extend(operand_edits(start, comments, left, left + len(text), replacement))
    # LaTeX opens the prepared bibliography/index by job name. Sources may
    # reside below cwd when the project normally runs TeX from the root.
    for base in base_dirs:
        for suffix in (".bbl", ".ind", ".gls"):
            prepared = existing_file(root, base / (source.stem + suffix))
            if prepared is not None:
                found[prepared.as_posix()] = prepared
    return stored_names(root, found.values()), edits, incomplete
