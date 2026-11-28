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

# The manifest uses Python's isolated mode. Only import helpers from this plugin.
sys.path.insert(0, str(Path(__file__).resolve().parent))
if os.name == "nt":
    from windows_publish import pin_project
    from windows_sandbox import private_runtime, run_contained
else:
    from posix_publish import pin_project
    from posix_sandbox import run_contained


ENGINES = {"xelatex", "pdflatex"}
MCP_VERSIONS = {"2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"}
ARTIFACT_DIR = ".latex-out"
EXCLUDED_DIRS = {ARTIFACT_DIR, ".cage-latex", ".git", ".hg", ".svn", ".ssh", ".gnupg", ".aws"}
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
            "working_directory": {
                "type": "string", "maxLength": 300,
                "description": ("Directory normally used to run TeX, relative to the shared project. "
                                "Use '.' for the project root or e.g. 'paper' for a subproject. "
                                "Specify it for nested entries when the project contains other inputs."),
            },
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
    if (path.suffix.lower() != ".tex" or any(part.startswith("-") for part in path.parts)
            or any(part.casefold() in EXCLUDED_DIRS for part in path.parts[:-1])):
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


def walk_error(error):
    raise error


def snapshot_project(root, staging):
    size, files, folders = 0, 0, 0
    skipped_links = False
    for folder, dirs, names in os.walk(root, followlinks=False, onerror=walk_error):
        directory = Path(folder)
        if directory.resolve(strict=True) != directory:
            raise BuildError("项目目录在复制期间发生了变化。")
        target_dir = staging / directory.relative_to(root)
        target_dir.mkdir(exist_ok=True)
        folders += 1
        if folders > MAX_INPUT_FILES:
            raise BuildError("项目包含过多目录，请打开更小的项目目录。")
        keep = []
        for name in dirs:
            child = directory / name
            if name.casefold() in EXCLUDED_DIRS or child == staging.parent:
                continue
            if is_link(child.lstat()):
                skipped_links = True
            else:
                keep.append(name)
        dirs[:] = keep
        for name in names:
            source = directory / name
            if name.casefold() in {".git", ".env"} or name.casefold().startswith(".env."):
                continue
            info = source.lstat()
            if is_link(info):
                skipped_links = True
                continue
            if not stat.S_ISREG(info.st_mode):
                continue
            size += info.st_size
            files += 1
            if size > MAX_INPUT_BYTES or files > MAX_INPUT_FILES:
                raise BuildError("项目的 LaTeX 输入超过 512 MiB 或 5000 个文件，请打开更小的项目目录。")
            with source.open("rb") as data:
                if not os.path.samestat(info, os.fstat(data.fileno())) or source.resolve(strict=True) != source:
                    raise BuildError("项目文件在复制期间发生了变化。")
                with (target_dir / name).open("xb") as target:
                    remaining = info.st_size
                    while remaining:
                        block = data.read(min(remaining, 1024 * 1024))
                        if not block:
                            raise BuildError("项目文件在复制期间发生了变化。")
                        target.write(block)
                        remaining -= len(block)
                    if data.read(1) or os.fstat(data.fileno()).st_mtime_ns != info.st_mtime_ns:
                        raise BuildError("项目文件在复制期间发生了变化。")
    return skipped_links


def compilation_directory(staging, source, requested):
    if requested is None:
        # Preserve calls for a self-contained subproject. With other inputs
        # alongside it, the two invocation directories can produce different PDFs.
        parent = source.parent
        while parent != staging:
            if any(sibling != parent for sibling in parent.parent.iterdir()):
                raise BuildError("请按项目平时启动 LaTeX 的位置指定 working_directory：项目根目录填 .，子目录填其相对路径。")
            parent = parent.parent
        return source.parent
    if not isinstance(requested, str) or not requested or len(requested) > 300:
        raise BuildError("working_directory 必须是项目内的相对目录。")
    if requested == ".":
        return staging
    if (any(part in ("", ".", "..") for part in requested.split("/"))
            or re.search(r'[\\<>:"|?*\x00-\x1f]', requested)):
        raise BuildError("working_directory 必须是项目内的相对目录。")
    cwd = staging / requested
    if not cwd.is_dir():
        raise BuildError("共享项目里找不到指定的编译目录。")
    return cwd


def compilation_warnings(output):
    # Classify diagnostics on the final TeX pass or the PDF driver. Raw output
    # may contain private paths and arbitrary document text.
    output.seek(0)
    messages = set()
    for chunk in iter(lambda: output.readline(8192), b""):
        line = chunk.lower().strip()
        if b"undefined" in line and any(word in line for word in (b"citation", b"reference")):
            messages.add("文中有未解析的引用，请检查标签或参考文献。")
        elif line.startswith(b"no file ") and line.endswith((b".bbl.", b".ind.", b".gls.")):
            messages.add("缺少参考文献、索引或术语表的生成文件。")
        elif b"rerun" in line and (b"warning" in line or b"cross-reference" in line):
            messages.add("编译器提示仍需再次处理交叉引用或运行相应的文献工具。")
        elif line.startswith((b"latex warning:", b"latex font warning:", b"xdvipdfmx:warning:",
                              b"missing character:")) or (line.startswith(b"package ") and b" warning:" in line):
            messages.add("编译器报告了排版、字体、插图或宏包警告，请核对成品。")
    return messages


def texlive_engine(engine, base):
    path_entries = os.get_exec_path()
    if sys.platform == "darwin":
        path_entries.append("/Library/TeX/texbin")
    def executable(name):
        return name + ".exe" if os.name == "nt" else name

    # An explicit absolute pathname also avoids older Windows Python versions
    # searching the working directory before the configured PATH.
    binary = next((Path(entry) / executable(engine) for entry in path_entries
                   if Path(entry).is_absolute() and shutil.which(str(Path(entry) / executable(engine)))), None)
    if binary is None:
        raise BuildError(f"本机找不到 {engine}，请检查 TeX Live 的 PATH。")
    if sys.platform == "darwin":
        # MacTeX's texbin alias traverses several distribution-management symlinks.
        # Resolve the directory before sandboxing; the basename selects the TeX format.
        binary = binary.parent.resolve(strict=True) / binary.name
    if (os.name == "nt" and Path(os.environ.get("LOCALAPPDATA") or "").is_absolute()
            and binary.parent.name.lower() == "windows" and binary.parent.parent.name.lower() == "bin"):
        cached = private_runtime(binary.parent.parent.parent) / "bin" / "windows" / binary.name
        if cached.is_file():
            binary = cached
    # On Unix the filename of the symlink selects the TeX engine format.
    kpsewhich = shutil.which(str(binary.with_name(executable("kpsewhich"))))
    if not kpsewhich:
        raise BuildError("当前编译器不是可识别的 TeX Live 安装。")
    system_keys = ("SystemRoot", "WINDIR", "SystemDrive", "COMSPEC", "LANG", "LC_CTYPE")
    env = {key: os.environ[key] for key in system_keys if key in os.environ}
    fonts = ()
    if os.name == "nt":
        windows = Path(os.environ.get("SystemRoot") or os.environ.get("WINDIR") or "")
        if not windows.is_absolute() or not windows.is_dir():
            raise BuildError("无法找到 Windows 系统目录，请检查 SystemRoot 设置。")
        windows = windows.resolve()
        env.update(SystemRoot=str(windows), WINDIR=str(windows))
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
    )
    launch = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    trees = []
    lookup_deadline = time.monotonic() + 30
    for name in ("TEXMFDIST", "TEXMFMAIN", "TEXMFDEBIAN", "TEXMFLOCAL", "TEXMFSYSVAR", "TEXMFSYSCONFIG"):
        try:
            result = subprocess.run([kpsewhich, "-var-value=" + name], cwd=base, env=env,
                                    capture_output=True, timeout=max(0.1, lookup_deadline - time.monotonic()),
                                    **launch)
        except subprocess.TimeoutExpired:
            raise BuildError("本机 TeX Live 查询超时。") from None
        value = Path(os.fsdecode(result.stdout.strip()))
        if result.returncode == 0 and value.is_absolute() and value.is_dir():
            tree = value.resolve()
            trees.append(tree)
            # Standalone TeX Live also reads its version-root texmf.cnf.
            if name == "TEXMFDIST" and tree.name == "texmf-dist":
                bin_dir = binary.parent.resolve()
                if bin_dir.parent.name == "bin" and bin_dir.parent.parent == tree.parent:
                    config = tree.parent / "texmf.cnf"
                    if config.is_file():
                        trees.append(config)
        elif name == "TEXMFDIST":
            raise BuildError("无法定位本机 TeX Live 的系统文件。")
    roots = dict.fromkeys([*trees, *(item.resolve() for item in fonts if item.is_dir())])
    return binary, env, (base, *roots)


def build_diagnostic(output):
    # TeX diagnostics can contain host paths, usernames, and arbitrary document text.
    # Return only a known error category and an optional line number.
    output.seek(max(0, output.seek(0, os.SEEK_END) - 10000))
    lines = output.read().decode("utf-8", errors="replace").splitlines()
    for line in lines:
        if line.startswith(("bwrap:", "sandbox-exec:")):
            return "无法启动系统隔离工具，请按插件说明检查安装和运行权限。"
        location = re.match(r"^.+?:(\d{1,8}): ", line)
        if not location and not line.startswith("! "):
            continue
        hint = "请检查源文件和所用的 TeX Live 包。"
        if "Undefined control sequence" in line:
            hint = "有命令无法识别，请检查拼写和导言区的宏包。"
        elif "not found" in line.lower():
            hint = "找不到所需文件，请检查项目文件和已安装的宏包。"
        if location:
            return f"编译器报告第 {location[1]} 行出错。{hint}"
        return hint
    return "请检查源文件和所用的 TeX Live 包。"


def compile_pdf(root, args, expected_root=None):
    if not isinstance(args, dict) or set(args) - {"source", "engine", "working_directory"}:
        raise BuildError("只接受 source、engine 和 working_directory 参数。")
    relative = relative_source(args.get("source"))
    engine = args.get("engine", "xelatex")
    if not isinstance(engine, str) or engine not in ENGINES:
        raise BuildError("编译器只能选择 xelatex 或 pdflatex。")
    output_pdf = Path(ARTIFACT_DIR) / relative.with_suffix(".pdf")
    with pin_project(root, output_pdf) as project, tempfile.TemporaryDirectory(prefix="latex-") as directory:
        if expected_root is not None and project.root_identity != expected_root:
            raise BuildError("共享项目目录已更换，请重新打开项目后再试。")
        source_path(root, relative)
        base = Path(directory).resolve()
        staging, build = base / "project", base / "build"
        staging.mkdir()
        build.mkdir()
        binary, env, allowed = texlive_engine(engine, base)
        skipped_links = snapshot_project(root, staging)
        source = staging / relative
        if not source.is_file():
            raise BuildError("项目文件在编译期间发生了变化，请保存后再试。")
        if "working_directory" in args and not isinstance(args["working_directory"], str):
            raise BuildError("working_directory 必须是项目内的相对目录。")
        cwd = compilation_directory(staging, source, args.get("working_directory"))
        # TeX opens relative chapter.aux names under its output directory;
        # it does not create their parent directories.
        for folder, _, _ in os.walk(cwd, onerror=walk_error):
            (build / Path(folder).relative_to(cwd)).mkdir(exist_ok=True)
        # Use the installation's native input-name policy. Older TeX versions
        # reject legitimate .generated/ and ../ paths with a forced openin_any=p.
        # Filesystem access is enforced for every pass by run_contained.
        tex = [
            str(binary), "-no-shell-escape", "-no-parse-first-line", "-no-mktex=tex", "-no-mktex=tfm",
            "-cnf-line=openout_any=p", "-interaction=nonstopmode",
            "-halt-on-error", "-file-line-error", f"-output-directory={build}",
        ]
        pdf = build / source.with_suffix(".pdf").name
        steps = [tex, tex]
        if engine == "xelatex":
            tex.append("-no-pdf")
            driver = shutil.which(str(binary.with_name("xdvipdfmx" + binary.suffix)))
            if not driver:
                raise BuildError("找不到生成 PDF 所需的 xdvipdfmx，请检查本机 TeX Live。")
            steps.append([driver, "-D", "", "-o", str(pdf), str(pdf.with_suffix(".xdv"))])
        tex.append("./" + Path(os.path.relpath(source, cwd)).as_posix())
        deadline = time.monotonic() + BUILD_SECONDS
        warnings = {"项目中有链接未复制到编译目录，请核对相关输入。"} if skipped_links else set()
        for index, command in enumerate(steps):
            try:
                # Keep diagnostics on a parent-owned handle, outside the writable job directory.
                with tempfile.TemporaryFile() as output:
                    status = run_contained(command, cwd, env, output,
                                           max(0.1, deadline - time.monotonic()), base, allowed)
                    if status:
                        raise BuildError(f"{engine} 编译失败。{build_diagnostic(output)}")
                    if index > 0:
                        warnings.update(compilation_warnings(output))
            except subprocess.TimeoutExpired:
                raise BuildError(f"本机编译超过 {BUILD_SECONDS} 秒，已停止。") from None
            except OSError:
                if os.name == "nt":
                    raise BuildError("无法在 Windows 隔离环境中启动编译器。请按插件说明准备专用运行副本。") from None
                raise BuildError("无法启动编译隔离环境，请按插件说明检查系统工具和权限。") from None
        if (not pdf.is_file() or is_link(pdf.lstat()) or pdf.resolve().parent != build
                or not 0 < pdf.stat().st_size <= MAX_PDF_BYTES):
            raise BuildError("编译未生成 PDF，或 PDF 超过 64 MiB。")
        try:
            project.publish(pdf, output_pdf)
        except OSError:
            raise BuildError("无法保存 PDF，请检查项目和输出目录是否已移动、被占用或缺少写入权限。") from None
        result = {"engine": engine, "pdf": output_pdf.as_posix(),
                  "working_directory": cwd.relative_to(staging).as_posix()}
        if warnings:
            result["warnings"] = sorted(warnings)
        return result


class InvalidParams(Exception):
    pass


def respond(root, request, expected_root=None):
    method = request.get("method")
    params = request.get("params", {})
    if not isinstance(params, dict):
        raise InvalidParams
    if method == "initialize":
        version = params.get("protocolVersion", "")
        if not isinstance(version, str):
            raise InvalidParams
        return {"protocolVersion": version if version in MCP_VERSIONS else "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "host-latex", "version": "0.1.0"}}
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": [TOOL]}
    if method != "tools/call":
        return None
    if params.get("name") != TOOL["name"]:
        return {"isError": True, "content": [{"type": "text", "text": "未知工具。"}]}
    try:
        result = compile_pdf(root, params.get("arguments", {}), expected_root)
        return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                "structuredContent": result}
    except BuildError as failure:
        text = str(failure)
    except (OSError, ValueError):
        text = "无法读取共享项目、运行本机 TeX Live 或写入 PDF，请检查文件和本机权限。"
    return {"isError": True, "content": [{"type": "text", "text": text}]}


def main():
    if len(sys.argv) != 2:
        sys.exit("请指定共享项目目录。")
    try:
        root = Path(sys.argv[1]).resolve(strict=True)
        info = root.lstat()
    except (OSError, RuntimeError, ValueError):
        sys.exit("无法打开共享项目目录。")
    if not stat.S_ISDIR(info.st_mode) or is_link(info):
        sys.exit("请指定共享项目目录。")
    expected_root = (info.st_dev, info.st_ino)
    for line in sys.stdin.buffer:
        try:
            request = json.loads(line)
        except ValueError:
            continue
        if not isinstance(request, dict) or "id" not in request:
            continue
        envelope = {"jsonrpc": "2.0", "id": request["id"]}
        try:
            result = respond(root, request, expected_root)
        except InvalidParams:
            envelope["error"] = {"code": -32602, "message": "Invalid params"}
        else:
            if result is None:
                envelope["error"] = {"code": -32601, "message": "Method not found"}
            else:
                envelope["result"] = result
        print(json.dumps(envelope), flush=True)


if __name__ == "__main__":
    main()
