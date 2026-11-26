"""Run one executable in a Windows AppContainer with no network or child processes."""

import ctypes as C
from ctypes import wintypes as W
from contextlib import ExitStack
import msvcrt
import hashlib
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid


# Capability SIDs returned by DeriveCapabilitySidsFromName.
TEX_READ = "S-1-15-3-1024-1587808082-2199094102-429469026-2557805077-1337136753-3240677205-2093657248-1138202066"
REGISTRY_READ = "S-1-15-3-1024-1065365936-1281604716-3511738428-1654721687-432734479-3232135806-4053264122-3456934681"
P = C.c_void_p
kernel = C.WinDLL("kernel32", use_last_error=True)
security = C.WinDLL("advapi32", use_last_error=True)
userenv = C.WinDLL("userenv", use_last_error=True)


class Startup(C.Structure):
    _fields_ = [
        ("cb", W.DWORD), ("reserved", W.LPWSTR), ("desktop", W.LPWSTR), ("title", W.LPWSTR),
        ("x", W.DWORD), ("y", W.DWORD), ("width", W.DWORD), ("height", W.DWORD),
        ("cols", W.DWORD), ("rows", W.DWORD), ("fill", W.DWORD), ("flags", W.DWORD),
        ("show", W.WORD), ("reserved_size", W.WORD), ("reserved_bytes", P),
        ("stdin", W.HANDLE), ("stdout", W.HANDLE), ("stderr", W.HANDLE), ("attributes", P),
    ]


class Process(C.Structure):
    _fields_ = [("process", W.HANDLE), ("thread", W.HANDLE), ("pid", W.DWORD), ("tid", W.DWORD)]


class SidAttributes(C.Structure):
    _fields_ = [("sid", P), ("attributes", W.DWORD)]


class Capabilities(C.Structure):
    _fields_ = [("container", P), ("caps", C.POINTER(SidAttributes)),
                ("count", W.DWORD), ("reserved", W.DWORD)]


def checked(result):
    if not result:
        raise C.WinError(C.get_last_error())


def sid_string(sid):
    value = W.LPWSTR()
    checked(security.ConvertSidToStringSidW(sid, C.byref(value)))
    try:
        return value.value
    finally:
        kernel.LocalFree(C.cast(value, P))


def icacls(path, *args):
    windows = Path(os.environ.get("SystemRoot") or os.environ.get("WINDIR") or "")
    if not windows.is_absolute() or not windows.is_dir():
        raise OSError("Windows system directory unavailable")
    program = windows / "System32" / "icacls.exe"
    subprocess.run([str(program), str(path), *args], cwd=program.parent,
                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW,
                   check=True, timeout=120)


def private_runtime(installation):
    """Key an opt-in private runtime by the source install and its update markers."""
    folder = os.environ.get("LOCALAPPDATA")
    if not folder or not Path(folder).is_absolute():
        raise OSError("Local application data directory unavailable")
    root = installation.resolve(strict=True)
    signature = hashlib.sha256(os.fsencode(os.path.normcase(str(root))))
    for name in ("texmf.cnf", "tlpkg/texlive.tlpdb", "texmf-dist/ls-R", "texmf-var/ls-R",
                 "bin/windows/xelatex.exe", "bin/windows/pdftex.dll", "bin/windows/xetex.dll"):
        path = root / name
        if path.is_file():
            info = path.stat()
            signature.update(f"{name}:{info.st_size}:{info.st_mtime_ns}\n".encode())
    return Path(folder) / "HostLatex" / "runtimes" / signature.hexdigest()[:24]


def prepare_runtime(installation):
    """Only grant access to new, private copies. Never change the installed toolchain."""
    root = installation.resolve(strict=True)
    binary = root / "bin" / "windows"
    if not (binary / "xelatex.exe").is_file() or not (root / "texmf-dist" / "web2c" / "texmf.cnf").is_file():
        raise ValueError("请选择含 bin 和 texmf-dist 的 TeX Live 年份目录。")
    target = private_runtime(root)
    if target.is_relative_to(root):
        raise ValueError("专用副本必须在原安装目录之外。")
    if (target / "bin" / "windows" / "kpsewhich.exe").is_file() and (target / "texmf-dist").is_dir():
        return
    if target.exists():
        raise ValueError("运行副本不完整，请先清理插件自己的缓存，再重新准备。")
    def checked_path(path):
        info = path.lstat()
        if info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT or path.resolve() != path:
            raise ValueError("这个 TeX Live 安装包含重解析点，无法建立独立运行副本。")
        return path

    def runtime_entries(directory, entries):
        directory = Path(directory)
        skipped = {"doc", "source"} if directory == root / "texmf-dist" else set()
        for name in set(entries) - skipped:
            checked_path(directory / name)
        return skipped

    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=target.parent) as temp:
        staging = Path(temp) / "runtime"
        dest_bin = staging / "bin" / "windows"
        dest_bin.mkdir(parents=True)
        for program in ("xelatex.exe", "pdflatex.exe", "xdvipdfmx.exe", "kpsewhich.exe"):
            shutil.copy2(checked_path(binary / program), dest_bin / program)
        for dll in binary.glob("*.dll"):
            shutil.copy2(checked_path(dll), dest_bin / dll.name)
        for name in ("texmf-dist", "texmf-var", "texmf-config"):
            src = root / name
            if src.is_dir():
                # The distribution's manuals and source archives are not runtime trees.
                shutil.copytree(checked_path(src), staging / name, ignore=runtime_entries)
        if (root / "texmf.cnf").is_file():
            shutil.copy2(checked_path(root / "texmf.cnf"), staging / "texmf.cnf")
        icacls(staging, "/grant:r", "*" + TEX_READ + ":(OI)(CI)(RX)")
        try:
            staging.rename(target)
        except FileExistsError:
            if not target.is_dir():
                raise


def run_contained(command, cwd, env, output, timeout, base, allowed):
    # The profile, namespace alias and scratch write grant are private to this job.
    profile = "HostLatex." + uuid.uuid4().hex
    binary = Path(command[0])
    install = binary.parent.parent.parent
    sid = P()
    with ExitStack() as stack:
        hr = userenv.CreateAppContainerProfile(profile, profile, "TeX compilation", None, 0, C.byref(sid))
        if hr:
            raise OSError("AppContainer unavailable")
        stack.callback(security.FreeSid, sid)
        stack.callback(userenv.DeleteAppContainerProfile, profile)
        # Kpathsea enumerates every ancestor of argv[0] even when it can already
        # open the executable. A named DOS device avoids exposing user directories.
        checked(kernel.DefineDosDeviceW(8, profile, str(binary.parent)))
        stack.callback(kernel.DefineDosDeviceW, 14, profile, str(binary.parent))
        env = dict(env, TEXMFROOT=str(install), SELFAUTOPARENT=str(install),
                   TEXMFCNF=os.pathsep.join(map(str, (install, install / "texmf-dist" / "web2c"))))
        identity = "*" + sid_string(sid)
        try:
            icacls(base, "/grant:r", identity + ":(OI)(CI)(M)")
            icacls(base, "/setintegritylevel", "(OI)(CI)L")
        except subprocess.CalledProcessError as error:
            raise OSError("AppContainer scratch permissions unavailable") from error

        entries = (SidAttributes * 2)()
        for index, capability in enumerate((TEX_READ, REGISTRY_READ)):
            cap = P()
            checked(security.ConvertStringSidToSidW(capability, C.byref(cap)))
            stack.callback(kernel.LocalFree, cap)
            entries[index] = SidAttributes(cap, 4)  # SE_GROUP_ENABLED
        caps = Capabilities(sid, entries, len(entries), 0)
        no_children = W.DWORD(1)  # PROCESS_CREATION_CHILD_PROCESS_RESTRICTED
        null = stack.enter_context(open(os.devnull, "rb"))
        handles = []
        for file in (null, output):
            handle = os.dup(file.fileno())
            stack.callback(os.close, handle)
            os.set_inheritable(handle, True)
            handles.append(msvcrt.get_osfhandle(handle))
        inherited = (W.HANDLE * len(handles))(*handles)
        # Opt out of permissions granted to all ordinary packaged applications (LPAC).
        restricted_packages = W.DWORD(1)
        # Project inputs are low-integrity data. Windows must not load DLLs from them.
        no_low_images = C.c_uint64(1 << 56)
        values = [(0x20009, caps), (0x2000E, no_children), (0x20002, inherited),
                  (0x2000F, restricted_packages), (0x20007, no_low_images)]
        size = C.c_size_t()
        kernel.InitializeProcThreadAttributeList(None, len(values), 0, C.byref(size))
        attributes = C.create_string_buffer(size.value)
        checked(kernel.InitializeProcThreadAttributeList(attributes, len(values), 0, C.byref(size)))
        stack.callback(kernel.DeleteProcThreadAttributeList, attributes)
        for key, value in values:
            checked(kernel.UpdateProcThreadAttribute(attributes, 0, key, C.byref(value),
                                                     C.c_size_t(C.sizeof(value)), None, None))
        start = Startup(cb=C.sizeof(Startup), flags=0x100, stdin=handles[0],
                        stdout=handles[1], stderr=handles[1], attributes=C.cast(attributes, P))
        process = Process()
        alias = "\\\\.\\" + profile + "\\" + binary.name
        cmdline = C.create_unicode_buffer(subprocess.list2cmdline([alias, *command[1:]]))
        variables = "\0".join(key + "=" + env[key] for key in sorted(env, key=str.upper)) + "\0\0"
        # DETACHED_PROCESS prevents console host creation under the no-children policy.
        flags = 0x8 | 0x80000 | 0x400  # detached, extended startup, Unicode env
        checked(kernel.CreateProcessW(alias, cmdline, None, None, True, flags,
                                      C.create_unicode_buffer(variables), str(cwd),
                                      C.byref(start), C.byref(process)))
        stack.callback(kernel.CloseHandle, W.HANDLE(process.process))
        stack.callback(kernel.CloseHandle, W.HANDLE(process.thread))
        child = W.HANDLE(process.process)
        state = kernel.WaitForSingleObject(child, max(1, int(timeout * 1000)))
        if state != 0:
            checked(kernel.TerminateProcess(child, 1))
            kernel.WaitForSingleObject(child, 5000)
            if state == 258:
                raise subprocess.TimeoutExpired(command, timeout)
            raise OSError("AppContainer wait failed")
        status = W.DWORD()
        checked(kernel.GetExitCodeProcess(child, C.byref(status)))
        if status.value in (0xC0000022, 0xC0000135, 0xC0000142):
            raise OSError("TeX runtime unavailable to the AppContainer")
        return status.value


if __name__ == "__main__":
    sys.stdout.reconfigure(errors="backslashreplace")
    if len(sys.argv) != 3 or sys.argv[1] != "--prepare-runtime":
        sys.exit('用法：python windows_sandbox.py --prepare-runtime "C:\\texlive\\2026"')
    try:
        prepare_runtime(Path(sys.argv[2]))
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        sys.exit(f"准备专用编译环境失败。{error}")
    print("Private TeX Live runtime ready.")
