"""Compile files from the active shared project with TeX Live."""

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path, PurePosixPath


ENGINES = {"xelatex", "pdflatex"}
MCP_VERSIONS = {"2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"}
INPUT_SUFFIXES = set("""
    .tex .ltx .sty .cls .clo .cfg .def .fd .bib .bbl .bst .bbx .cbx .lbx .dbx
    .tikz .pdf .png .jpg .jpeg .jbig2 .eps .svg .otf .ttf .ttc .enc .map
    .txt .dat .csv .tsv .json .xml .pgf .ps .mps .ist .ini .lua .pygtex
""".split())
ARTIFACT_DIR = ".cage-latex"
MAX_INPUT_BYTES = 512 * 1024 * 1024
MAX_INPUT_FILES = 5000
MAX_PDF_BYTES = 64 * 1024 * 1024
BUILD_SECONDS = 90
TOOL = {
    "name": "latex_compile",
    "description": (
        "Compile a .tex file in the current shared project using the installed "
        "LaTeX compiler. Use this tool to build a PDF without installing TeX. "
        "Returns a project-relative PDF path or a build error."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "source": {
                "type": "string",
                "description": "Project-relative .tex path, for example paper/main.tex.",
                "maxLength": 300,
            },
            "engine": {"type": "string", "enum": sorted(ENGINES), "default": "xelatex"},
        },
        "required": ["source"],
        "additionalProperties": False,
    },
}


class BuildError(Exception):
    pass


def relative_source(name):
    if not isinstance(name, str) or not 1 <= len(name) <= 300:
        raise BuildError("请提供项目内的 .tex 相对路径。")
    if any(part in ("", ".", "..") or part.endswith((" ", ".")) for part in name.split("/")):
        raise BuildError("请输入项目相对路径，例如 paper/main.tex。")
    if re.search(r'[\\<>:"|?*%#{}\x00-\x1f]', name):
        raise BuildError("TeX 文件路径包含不支持的字符。")
    path = PurePosixPath(name)
    if path.suffix.lower() != ".tex" or any(part.startswith((".", "-")) for part in path.parts):
        raise BuildError("请输入项目内普通的 .tex 文件路径。")
    return path


def is_link(info):
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
    )


def source_path(root, relative):
    path = root
    for part in relative.parts:
        path /= part
        try:
            linked = is_link(path.lstat())
        except FileNotFoundError:
            raise BuildError("共享项目内找不到指定的 .tex 文件。") from None
        if linked:
            raise BuildError("编译入口不能经过链接或重解析点。")
    if not path.is_file() or not path.resolve().is_relative_to(root):
        raise BuildError("编译入口必须是共享项目里的普通文件。")
    return path


def snapshot_project(root, staging):
    size, files = 0, 0
    for folder, dirs, names in os.walk(root, followlinks=False):
        directory = Path(folder)
        dirs[:] = [
            name for name in dirs
            if not name.startswith(".") and name not in {"node_modules", "__pycache__"}
            and not is_link((directory / name).lstat())
        ]
        for name in names:
            source = directory / name
            if name.startswith(".") or source.suffix.lower() not in INPUT_SUFFIXES:
                continue
            info = source.lstat()
            if is_link(info) or not stat.S_ISREG(info.st_mode):
                continue
            size += info.st_size
            files += 1
            if size > MAX_INPUT_BYTES or files > MAX_INPUT_FILES:
                raise BuildError("项目的 LaTeX 输入超过 512 MiB 或 5000 个文件，请在 Cage 中打开更小的项目目录。")
            target = staging / source.relative_to(root)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)


def texlive_engine(engine, base):
    path_entries = os.get_exec_path()
    if sys.platform == "darwin":
        path_entries.append("/Library/TeX/texbin")
    found = shutil.which(engine, path=os.pathsep.join(path_entries))
    if not found:
        raise BuildError(f"本机找不到 {engine}，请检查 TeX Live 的 PATH。")
    # On Unix the filename of the symlink selects the TeX engine format.
    binary = Path(found).absolute()
    kpsewhich = shutil.which("kpsewhich", path=str(binary.parent))
    if not kpsewhich:
        raise BuildError("当前编译器不是可识别的 TeX Live 安装。")
    system_keys = ("SystemRoot", "WINDIR", "SystemDrive", "COMSPEC", "LANG", "LC_CTYPE")
    env = {key: os.environ[key] for key in system_keys if key in os.environ}
    fonts = ()
    if os.name == "nt":
        windows = Path(os.environ["SystemRoot"]).resolve()
        path = os.pathsep.join(map(str, (binary.parent, windows / "System32")))
        fonts = (windows / "Fonts",)
    else:
        path = os.pathsep.join((str(binary.parent), os.defpath))
        fonts = tuple(map(Path, ("/etc/fonts", "/usr/share/fonts", "/usr/local/share/fonts",
                                "/usr/share/fontconfig", "/System/Library/Fonts", "/Library/Fonts")))
    env.update(
        PATH=path, HOME=str(base), USERPROFILE=str(base), APPDATA=str(base), LOCALAPPDATA=str(base),
        TEMP=str(base), TMP=str(base), TMPDIR=str(base), TEXMFHOME=str(base / "texmf-home"),
        TEXMFCONFIG=str(base / "texmf-config"), TEXMFVAR=str(base / "texmf-var"),
        TEXMFOUTPUT=str(base / "build"),
    )
    launch = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    trees = []
    for name in ("TEXMFDIST", "TEXMFLOCAL", "TEXMFSYSVAR", "TEXMFSYSCONFIG"):
        try:
            result = subprocess.run([kpsewhich, "-var-value=" + name], cwd=base, env=env,
                                    capture_output=True, timeout=3, **launch)
        except subprocess.TimeoutExpired:
            raise BuildError("本机 TeX Live 查询超时。") from None
        value = Path(os.fsdecode(result.stdout.strip()))
        if result.returncode == 0 and value.is_absolute():
            tree = value.resolve()
            trees.append(tree)
            # Standalone TeX Live also reads its version-root texmf.cnf.
            if name == "TEXMFDIST" and tree.name == "texmf-dist":
                bin_dir = binary.parent.resolve()
                if bin_dir.parent.name == "bin" and bin_dir.parent.parent == tree.parent:
                    trees.append(tree.parent)
        elif name == "TEXMFDIST":
            raise BuildError("无法定位本机 TeX Live 的系统文件。")
    return binary, env, (base, *(item.resolve() for item in (*trees, *fonts))), launch


def check_record(record, cwd, allowed):
    if not record.is_file():
        raise BuildError("编译器没有生成输入记录，请检查本机 TeX Live。")
    for line in record.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        if not line.startswith(("INPUT ", "OUTPUT ")):
            continue
        kind, name = line.split(" ", 1)
        path = (cwd / name).resolve()
        roots = allowed if kind == "INPUT" else (allowed[0],)
        if not any(path.is_relative_to(root) for root in roots):
            raise BuildError("编译引用了共享项目和 TeX Live 之外的文件，结果未写入项目。")


def publish_pdf(root, relative, pdf):
    destination = root / ARTIFACT_DIR
    for part in (ARTIFACT_DIR, *relative.parent.parts):
        destination = root / part if part == ARTIFACT_DIR else destination / part
        destination.mkdir(exist_ok=True)
        if is_link(destination.lstat()) or not destination.resolve().is_relative_to(root):
            raise BuildError("输出目录包含链接，无法写入 PDF。")
    destination /= relative.with_suffix(".pdf").name
    if destination.exists() and (is_link(destination.lstat()) or not destination.is_file()):
        raise BuildError("输出位置已被链接或目录占用。")
    handle, temporary = tempfile.mkstemp(suffix=".pdf", dir=destination.parent)
    try:
        with os.fdopen(handle, "wb") as file, pdf.open("rb") as result:
            shutil.copyfileobj(result, file)
        os.replace(temporary, destination)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return destination.relative_to(root).as_posix()


def compile_pdf(root, args):
    if not isinstance(args, dict) or set(args) - {"source", "engine"}:
        raise BuildError("只接受 source 和 engine 两个参数。")
    relative = relative_source(args.get("source"))
    engine = args.get("engine", "xelatex")
    if not isinstance(engine, str) or engine not in ENGINES:
        raise BuildError("编译器只能选择 xelatex 或 pdflatex。")
    source_path(root, relative)
    with tempfile.TemporaryDirectory(prefix="cage-latex-") as directory:
        base = Path(directory).resolve()
        staging, build = base / "project", base / "build"
        staging.mkdir()
        build.mkdir()
        binary, env, allowed, launch = texlive_engine(engine, base)
        snapshot_project(root, staging)
        source = staging / relative
        if not source.is_file():
            raise BuildError("项目文件在编译期间发生了变化，请保存后再试。")
        command = [
            str(binary), "-no-shell-escape", "-no-parse-first-line", "-no-mktex=tex", "-no-mktex=tfm",
            "-cnf-line=openout_any=p", "-interaction=nonstopmode", "-halt-on-error",
            "-file-line-error", "-recorder", "-jobname=cage-document",
            f"-output-directory={build}", f"./{source.name}",
        ]
        deadline = time.monotonic() + BUILD_SECONDS
        for _ in range(2):
            try:
                with (build / "process.log").open("wb") as output:
                    result = subprocess.run(
                        command, cwd=source.parent, env=env, stdin=subprocess.DEVNULL,
                        stdout=output, stderr=subprocess.STDOUT,
                        timeout=max(0.1, deadline - time.monotonic()),
                        **launch,
                    )
            except subprocess.TimeoutExpired:
                raise BuildError(f"本机编译超过 {BUILD_SECONDS} 秒，已停止。") from None
            check_record(build / "cage-document.fls", source.parent, allowed)
            if result.returncode != 0:
                with (build / "process.log").open("rb") as output:
                    output.seek(max(0, output.seek(0, os.SEEK_END) - 10000))
                    lines = output.read().decode("utf-8", errors="replace").splitlines()
                message = next(
                    (line for line in reversed(lines) if re.search(r"^! |\.\w+:\d+: ", line)),
                    "请检查论文源文件和所用的 TeX Live 包。",
                )
                raise BuildError(f"{engine} 编译失败。{message[:400]}")
        pdf = build / "cage-document.pdf"
        if not pdf.is_file() or not 0 < pdf.stat().st_size <= MAX_PDF_BYTES:
            raise BuildError("编译未生成 PDF，或 PDF 超过 64 MiB。")
        return {"engine": engine, "pdf": publish_pdf(root, relative, pdf)}


def respond(root, request):
    method = request.get("method")
    if method == "initialize":
        version = (request.get("params") or {}).get("protocolVersion", "")
        return {"protocolVersion": version if version in MCP_VERSIONS else "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "host-latex", "version": "0.1.0"}}
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": [TOOL]}
    if method != "tools/call":
        return None
    params = request.get("params") or {}
    if params.get("name") != TOOL["name"]:
        return {"isError": True, "content": [{"type": "text", "text": "未知工具。"}]}
    try:
        result = compile_pdf(root, params.get("arguments", {}))
        return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                "structuredContent": result}
    except BuildError as failure:
        text = str(failure)
    except (OSError, ValueError):
        text = "无法读取共享项目、运行本机 TeX Live 或写入 PDF，请检查文件和本机权限。"
    return {"isError": True, "content": [{"type": "text", "text": text}]}


def main():
    root = Path(sys.argv[1]).resolve(strict=True)
    for line in sys.stdin.buffer:
        try:
            request = json.loads(line)
            if not isinstance(request, dict) or "id" not in request:
                continue
            result = respond(root, request)
        except (ValueError, TypeError, AttributeError):
            continue
        envelope = {"jsonrpc": "2.0", "id": request["id"]}
        if result is None:
            envelope["error"] = {"code": -32601, "message": "Method not found"}
        else:
            envelope["result"] = result
        print(json.dumps(envelope), flush=True)


if __name__ == "__main__":
    main()
