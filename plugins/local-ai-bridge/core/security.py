"""Security boundaries, Windows-safe binary resolution, redaction, and validation."""

from __future__ import annotations

import ctypes
import glob
import hashlib
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path, PurePath
from typing import Any, Sequence

if os.name == "nt":
    import msvcrt  # type: ignore[import-not-found]
else:
    msvcrt = None  # type: ignore[assignment]

MAX_PROMPT_BYTES = 512 * 1024
MAX_OUTPUT_RETURN_CHARS = 32_000
ALLOWED_MODES = ("read-only", "workspace-write", "full-access")
DEFAULT_MODE = "read-only"

_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_SAFE_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,127}$")
_SAFE_EFFORT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$")
_PROXY_URL_RE = re.compile(r"^(?:https?|socks5h?|socks4a?)://[^\s\x00-\x1f\x7f]+$", re.IGNORECASE)
_URL_CREDS_RE = re.compile(r"((?:https?|socks5h?|socks4a?)://)([^/\s@]+)@", re.IGNORECASE)
_CMD_JS_SHIM_RE = re.compile(r'["\']?(?:%~dp0|%dp0%)[\\/]([^"\'\r\n]+?\.(?:mjs|cjs|js))["\']?', re.IGNORECASE)
DEFAULT_NO_PROXY = "127.0.0.1,localhost,::1"

# Reserved words that must not appear in tool responses or UI descriptions.
_RESERVED_WORDS = ("cage", "guest", "vm", "virtual machine", "虚拟机", "客机")
_RESERVED_LATIN_RE = re.compile(r"\b(cage|guest|vm|virtual\s+machine)\b", re.IGNORECASE)


def redact_proxy_credentials(text: str) -> str:
    """Mask embedded user:pass@ credentials inside proxy/HTTP URLs."""
    if not text:
        return text
    return _URL_CREDS_RE.sub(r"\1***@", text)


def sanitize_reserved_words(text: str) -> str:
    """Redact reserved environment terms and proxy credentials from text."""
    if not text:
        return text
    out = redact_proxy_credentials(text)
    out = _RESERVED_LATIN_RE.sub("runtime", out)
    out = out.replace("虚拟机", "隔离环境").replace("客机", "隔离环境")
    return out


def sanitize_diagnostic(text: str, project_dir: str = "") -> str:
    """Sanitize diagnostics/stderr before returning to model or UI."""
    if not text:
        return ""
    out = sanitize_reserved_words(text)
    try:
        home_str = str(Path.home())
        if home_str and len(home_str) > 3:
            out = out.replace(home_str, "~")
    except Exception:
        pass
    if project_dir:
        out = out.replace(project_dir, "<project>")
    return out


def has_reserved_words(text: str) -> list[str]:
    """Return any reserved words found in text (for self-tests)."""
    lowered = text.lower()
    tokens = set(re.split(r"[^a-z0-9\u0080-\U0010ffff]+", lowered))
    hits: list[str] = []
    for word in _RESERVED_WORDS:
        if " " in word or not word.isascii():
            if word in lowered:
                hits.append(word)
        elif word in tokens:
            hits.append(word)
    return hits


def mask_proxy_config(proxy: dict[str, Any] | None) -> dict[str, Any]:
    """Return a copy of proxy config with any URL credentials masked for safe display."""
    raw = proxy if isinstance(proxy, dict) else {}
    return {
        "enabled": bool(raw.get("enabled", False)),
        "http_proxy": redact_proxy_credentials(str(raw.get("http_proxy") or "")),
        "https_proxy": redact_proxy_credentials(str(raw.get("https_proxy") or "")),
        "all_proxy": redact_proxy_credentials(str(raw.get("all_proxy") or "")),
        "no_proxy": str(raw.get("no_proxy") or DEFAULT_NO_PROXY),
    }


def harden_private_file(path: Path) -> None:
    """Restrict file permissions to the current user (0600 on POSIX, icacls on Windows)."""
    if os.name == "nt":
        username = os.environ.get("USERNAME", "").strip()
        if not username:
            return
        domain = os.environ.get("USERDOMAIN", "").strip()
        principal = f"{domain}\\{username}" if domain else username
        system_root = os.environ.get("SystemRoot", "").strip()
        icacls = str(Path(system_root) / "System32" / "icacls.exe") if system_root else "icacls"
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            subprocess.run(
                [icacls, str(path), "/inheritance:r", "/grant:r", f"{principal}:(R,W)"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                shell=False,
                creationflags=creationflags,
            )
        except Exception:
            pass
    else:
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass


def write_private_temp_file(content: str, prefix: str, suffix: str) -> Path:
    """Create a private UTF-8 temporary file restricted to the current user."""
    fd, tmp_name = tempfile.mkstemp(prefix=prefix, suffix=suffix)
    path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(content)
        harden_private_file(path)
        return path
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def project_storage_key(project_dir: str) -> str:
    """Compute a stable per-project directory hash for isolated disk state."""
    if not project_dir:
        return "default"
    try:
        canonical = str(Path(project_dir).resolve())
    except OSError:
        canonical = project_dir
    normalized = os.path.normcase(canonical)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]


def validate_identifier(value: str, label: str = "identifier") -> str:
    if not isinstance(value, str) or not _SAFE_ID_RE.match(value.strip()):
        raise ValueError(f"Invalid {label}.")
    return value.strip()


def validate_model_id(value: str | None) -> str | None:
    if value is None or not str(value).strip():
        return None
    cleaned = str(value).strip()
    if not _SAFE_MODEL_RE.match(cleaned):
        raise ValueError("Invalid model identifier.")
    return cleaned


def validate_effort(value: str | None) -> str | None:
    if value is None or not str(value).strip():
        return None
    cleaned = str(value).strip().lower()
    if not _SAFE_EFFORT_RE.match(cleaned):
        raise ValueError("Invalid reasoning effort value.")
    return cleaned


def validate_proxy_url(value: str | None, label: str = "proxy") -> str:
    if value is None:
        return ""
    cleaned = str(value).strip()
    if not cleaned:
        return ""
    if len(cleaned) > 512 or not _PROXY_URL_RE.match(cleaned):
        raise ValueError(
            f"Invalid {label} URL. Expected http://, https://, socks5://, socks5h://, or socks4://."
        )
    return cleaned


def validate_no_proxy(value: str | None) -> str:
    if value is None:
        return ""
    cleaned = str(value).strip()
    if any(ch in cleaned for ch in ("\r", "\n", "\x00")):
        raise ValueError("Invalid no_proxy value.")
    if len(cleaned) > 1024:
        raise ValueError("no_proxy value is too long.")
    return cleaned


def build_cli_env(policy: dict[str, Any] | None = None) -> dict[str, str]:
    """Build subprocess environment variables, applying configured proxy settings when enabled."""
    env = os.environ.copy()
    proxy = (policy or {}).get("proxy")
    if not isinstance(proxy, dict) or not bool(proxy.get("enabled", False)):
        return env

    http_p = str(proxy.get("http_proxy") or "").strip()
    https_p = str(proxy.get("https_proxy") or "").strip()
    all_p = str(proxy.get("all_proxy") or "").strip()
    no_p = str(proxy.get("no_proxy") or "").strip() or DEFAULT_NO_PROXY

    if http_p:
        env["http_proxy"] = http_p
        env["HTTP_PROXY"] = http_p
    if https_p:
        env["https_proxy"] = https_p
        env["HTTPS_PROXY"] = https_p
    if all_p:
        env["all_proxy"] = all_p
        env["ALL_PROXY"] = all_p
    if http_p or https_p or all_p:
        env["no_proxy"] = no_p
        env["NO_PROXY"] = no_p
    return env


def assert_within_dir(target: Path, base: Path, label: str = "path") -> Path:
    """Resolve symlinks and guarantee target is strictly inside base."""
    resolved_base = base.resolve(strict=True)
    resolved_target = target.resolve(strict=True)
    try:
        resolved_target.relative_to(resolved_base)
    except ValueError as exc:
        raise ValueError(f"{label} escapes the active project directory.") from exc
    return resolved_target


def _win_normalize_final_path(raw: str) -> str:
    if raw.startswith("\\\\?\\UNC\\"):
        raw = "\\\\" + raw[8:]
    elif raw.startswith("\\\\?\\"):
        raw = raw[4:]
    return os.path.normcase(os.path.normpath(raw))


def _win_final_path_from_handle(handle: int) -> str:
    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    buf_len = 4096
    buf = ctypes.create_unicode_buffer(buf_len)
    res = kernel32.GetFinalPathNameByHandleW(ctypes.c_void_p(handle), buf, buf_len, 0)
    if res == 0:
        raise OSError("GetFinalPathNameByHandleW failed.")
    if res >= buf_len:
        buf = ctypes.create_unicode_buffer(res + 1)
        res = kernel32.GetFinalPathNameByHandleW(ctypes.c_void_p(handle), buf, res + 1, 0)
        if res == 0:
            raise OSError("GetFinalPathNameByHandleW failed.")
    return _win_normalize_final_path(buf.value)


def _win_final_path_from_fd(fd: int) -> str:
    """Resolve the kernel final path of an open Windows file descriptor via GetFinalPathNameByHandleW."""
    assert msvcrt is not None
    return _win_final_path_from_handle(msvcrt.get_osfhandle(fd))


def _win_final_path_from_dir(path: Path) -> str:
    """Resolve the kernel final path of a Windows directory via CreateFileW + GetFinalPathNameByHandleW."""
    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    FILE_SHARE_ALL = 0x00000001 | 0x00000002 | 0x00000004
    OPEN_EXISTING = 3
    FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
    INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
    handle = kernel32.CreateFileW(
        str(path),
        0,
        FILE_SHARE_ALL,
        None,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS,
        None,
    )
    if not handle or handle == INVALID_HANDLE_VALUE:
        return _win_normalize_final_path(str(path.resolve(strict=True)))
    try:
        return _win_final_path_from_handle(handle)
    finally:
        kernel32.CloseHandle(ctypes.c_void_p(handle))


def _read_bounded_fd(fd: int, max_bytes: int, label: str) -> bytes:
    """Verify an already-open descriptor is a regular file and read at most max_bytes from it."""
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode):
        raise ValueError(f"{label} is not a regular file.")
    if st.st_size > max_bytes:
        raise ValueError(f"{label} exceeds the {max_bytes // 1024} KiB size limit.")
    chunks: list[bytes] = []
    total = 0
    while True:
        want = min(65536, (max_bytes + 1) - total)
        if want <= 0:
            break
        block = os.read(fd, want)
        if not block:
            break
        total += len(block)
        if total > max_bytes:
            raise ValueError(f"{label} exceeds the {max_bytes // 1024} KiB size limit.")
        chunks.append(block)
    return b"".join(chunks)


def _split_safe_relative_parts(rel_path: str, label: str) -> list[str]:
    if not isinstance(rel_path, str) or not rel_path.strip():
        raise ValueError(f"{label} must be a non-empty relative path.")
    cleaned = rel_path.strip()
    if "\x00" in cleaned:
        raise ValueError(f"{label} contains invalid characters.")
    if cleaned.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", cleaned):
        raise ValueError(f"{label} must be a relative path inside the active project directory.")
    raw_parts = [p for p in re.split(r"[\\/]+", cleaned) if p]
    if not raw_parts:
        raise ValueError(f"{label} must be a non-empty relative path.")
    parts: list[str] = []
    for seg in raw_parts:
        if seg in (".", ".."):
            raise ValueError(f"{label} must not contain '.' or '..' path segments.")
        parts.append(seg)
    return parts


def read_project_file_safe(
    rel_path: str,
    project_dir: str,
    label: str = "prompt_file",
    max_bytes: int = MAX_PROMPT_BYTES,
) -> tuple[str, str]:
    """
    Safely open and read a relative UTF-8 text file confined to project_dir using a single
    verified file descriptor (eliminating path/size TOCTOU races):
    - POSIX: walks directory components via dir_fd + O_NOFOLLOW, then fstat + bounded os.read.
    - Windows: verifies no reparse points, opens one fd, verifies GetFinalPathNameByHandleW
      remains inside project_dir + fstat + bounded os.read.
    Returns: (text, filename)
    """
    if not project_dir:
        raise ValueError("No active project directory is open.")
    base = Path(project_dir)
    if not base.is_dir():
        raise ValueError("Active project directory does not exist.")
    parts = _split_safe_relative_parts(rel_path, label=label)
    filename = parts[-1]

    use_dir_fd = (
        os.name != "nt"
        and hasattr(os, "O_NOFOLLOW")
        and (os.open in getattr(os, "supports_dir_fd", set()))
    )
    if use_dir_fd:
        o_dir = getattr(os, "O_DIRECTORY", 0)
        o_nofollow = os.O_NOFOLLOW
        o_nonblock = getattr(os, "O_NONBLOCK", 0)
        cur_fd: int | None = None
        file_fd: int | None = None
        try:
            cur_fd = os.open(str(base.resolve(strict=True)), os.O_RDONLY | o_dir)
            for seg in parts[:-1]:
                try:
                    next_fd = os.open(seg, os.O_RDONLY | o_dir | o_nofollow, dir_fd=cur_fd)
                except OSError as exc:
                    raise ValueError(f"{label} directory component is invalid or a symlink: {seg}") from exc
                os.close(cur_fd)
                cur_fd = next_fd
            try:
                file_fd = os.open(filename, os.O_RDONLY | o_nofollow | o_nonblock, dir_fd=cur_fd)
            except FileNotFoundError as exc:
                raise ValueError(f"{label} does not exist: {rel_path}") from exc
            except OSError as exc:
                raise ValueError(f"{label} cannot be opened safely (symlink or inaccessible): {rel_path}") from exc
            raw = _read_bounded_fd(file_fd, max_bytes=max_bytes, label=label)
        finally:
            if file_fd is not None:
                try:
                    os.close(file_fd)
                except OSError:
                    pass
            if cur_fd is not None:
                try:
                    os.close(cur_fd)
                except OSError:
                    pass
    else:
        resolved_base = base.resolve(strict=True)
        walk = resolved_base
        for idx, seg in enumerate(parts):
            walk = walk / seg
            try:
                lst = os.lstat(walk)
            except FileNotFoundError as exc:
                raise ValueError(f"{label} does not exist: {rel_path}") from exc
            attrs = getattr(lst, "st_file_attributes", 0)
            if stat.S_ISLNK(lst.st_mode) or (attrs & 0x400):
                raise ValueError(f"{label} escapes or uses a symbolic link/reparse point.")
            if idx < len(parts) - 1:
                if not stat.S_ISDIR(lst.st_mode):
                    raise ValueError(f"{label} directory component is not a directory: {seg}")
            elif not stat.S_ISREG(lst.st_mode):
                raise ValueError(f"{label} is not a regular file.")
        o_bin = getattr(os, "O_BINARY", 0)
        file_fd = None
        try:
            try:
                file_fd = os.open(str(walk), os.O_RDONLY | o_bin)
            except FileNotFoundError as exc:
                raise ValueError(f"{label} does not exist: {rel_path}") from exc
            except OSError as exc:
                raise ValueError(f"{label} cannot be opened safely: {rel_path}") from exc
            if os.name == "nt":
                final_target = _win_final_path_from_fd(file_fd)
                base_norm = _win_final_path_from_dir(resolved_base)
                if final_target == base_norm:
                    raise ValueError(f"{label} is not a regular file.")
                try:
                    Path(final_target).relative_to(Path(base_norm))
                except ValueError as exc:
                    raise ValueError(f"{label} escapes the active project directory.") from exc
            raw = _read_bounded_fd(file_fd, max_bytes=max_bytes, label=label)
        finally:
            if file_fd is not None:
                try:
                    os.close(file_fd)
                except OSError:
                    pass

    if b"\x00" in raw:
        raise ValueError(f"{label} appears to be binary.")
    text = raw.decode("utf-8", errors="replace").strip()
    if not text:
        raise ValueError(f"{label} is empty: {filename}")
    return text, filename


def resolve_prompt_input(
    prompt: str | None,
    prompt_file: str | None,
    project_dir: str,
) -> str:
    """Resolve prompt text from inline string or a single-handle bounded project file."""
    if isinstance(prompt, str) and prompt.strip():
        text = prompt.strip()
        if len(text.encode("utf-8")) > MAX_PROMPT_BYTES:
            raise ValueError(f"Prompt exceeds {MAX_PROMPT_BYTES // 1024} KiB limit.")
        return text
    if isinstance(prompt_file, str) and prompt_file.strip():
        text, _ = read_project_file_safe(prompt_file, project_dir, label="prompt_file")
        return text
    raise ValueError("Provide either 'prompt' or 'prompt_file'.")


def _env_truthy(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def is_full_access_allowed(provider_id: str, policy: dict[str, Any]) -> bool:
    """Determine whether full-access (unrestricted tools/network/browser/host commands) is permitted."""
    if _env_truthy("AI_BRIDGE_ALLOW_FULL_ACCESS"):
        return True
    if bool(policy.get("allow_full_access", False)):
        return True
    providers_cfg = policy.get("providers") or {}
    pcfg = providers_cfg.get(provider_id) or {}
    return bool(pcfg.get("allow_full_access", False))


def is_write_allowed(provider_id: str, policy: dict[str, Any]) -> bool:
    """Determine whether workspace-write is currently permitted for provider_id."""
    if is_full_access_allowed(provider_id, policy):
        return True
    if _env_truthy("AI_BRIDGE_ALLOW_WRITE"):
        return True
    if bool(policy.get("allow_write", False)):
        return True
    providers_cfg = policy.get("providers") or {}
    pcfg = providers_cfg.get(provider_id) or {}
    return bool(pcfg.get("allow_write", False))


def is_provider_enabled(provider_id: str, policy: dict[str, Any]) -> bool:
    providers_cfg = policy.get("providers") or {}
    pcfg = providers_cfg.get(provider_id) or {}
    if provider_id == "antigravity":
        return bool(pcfg.get("enabled", False)) and bool(pcfg.get("risk_acknowledged", False))
    return bool(pcfg.get("enabled", True))


def resolve_effective_mode(
    requested_mode: str | None,
    provider_id: str,
    policy: dict[str, Any],
) -> str:
    """Enforce default read-only mode unless higher tiers are explicitly enabled by user."""
    mode = (requested_mode or DEFAULT_MODE).strip().lower()
    if mode not in ALLOWED_MODES:
        raise ValueError(
            f"Unsupported mode '{mode}'. Use 'read-only', 'workspace-write', or 'full-access'."
        )
    if mode == "workspace-write" and not is_write_allowed(provider_id, policy):
        raise PermissionError(
            f"Write mode is disabled for '{provider_id}'. "
            "Enable workspace edits in the Local AI Bridge panel before requesting workspace-write."
        )
    if mode == "full-access" and not is_full_access_allowed(provider_id, policy):
        raise PermissionError(
            f"Full-access mode is disabled for '{provider_id}'. "
            "Enable full-access in the Local AI Bridge panel before requesting full-access."
        )
    return mode


def _is_within_project(candidate: Path, project_dir: str) -> bool:
    if not project_dir:
        return False
    try:
        resolved_proj = Path(project_dir).resolve()
        resolved_cand = candidate.resolve()
        resolved_cand.relative_to(resolved_proj)
        return True
    except (OSError, ValueError):
        return False


def _find_node_executable(platform_name: str | None = None) -> str | None:
    plat = platform_name or sys.platform
    node_name = "node.exe" if plat == "win32" else "node"
    found = shutil.which(node_name)
    if found:
        return found
    if plat == "win32":
        for root_env in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
            base = os.environ.get(root_env, "").strip()
            if not base:
                continue
            cand = Path(base) / "nodejs" / "node.exe"
            if cand.is_file():
                return str(cand)
    return None


def _unwrap_windows_shim(
    shim_path: Path,
    npm_rel_entries: Sequence[str] = (),
    node_exe: str | None = None,
) -> list[str] | None:
    """Resolve a Windows .cmd/.bat/.ps1 npm wrapper directly to [node.exe, entry.js] without cmd.exe."""
    node = node_exe or _find_node_executable("win32")
    if not node:
        return None
    parent = shim_path.parent
    for rel in npm_rel_entries:
        cand = parent / rel
        if cand.is_file():
            return [node, str(cand)]
    try:
        text = shim_path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None
    for match in _CMD_JS_SHIM_RE.finditer(text):
        rel_part = match.group(1).replace("\\", "/")
        cand = (parent / rel_part).resolve()
        if cand.is_file():
            return [node, str(cand)]
    return None


def _resolve_windows_file(
    candidate: Path,
    npm_rel_entries: Sequence[str] = (),
    project_dir: str = "",
    node_exe: str | None = None,
) -> list[str] | None:
    if not candidate.is_file() or _is_within_project(candidate, project_dir):
        return None
    ext = candidate.suffix.lower()
    if ext == ".exe":
        return [str(candidate)]
    if ext in (".js", ".mjs", ".cjs"):
        node = node_exe or _find_node_executable("win32")
        return [node, str(candidate)] if node else None
    if ext in (".cmd", ".bat", ".ps1"):
        resolved = _unwrap_windows_shim(candidate, npm_rel_entries=npm_rel_entries, node_exe=node_exe)
        if resolved and not _is_within_project(Path(resolved[-1]), project_dir):
            return resolved
        return None
    return None


def _extra_search_dirs(platform_name: str | None = None) -> list[Path]:
    plat = platform_name or sys.platform
    home = Path.home()
    dirs: list[Path] = [
        home / ".local" / "bin",
        home / ".grok" / "bin",
        home / ".codex" / "bin",
        home / ".npm-global" / "bin",
        home / ".bun" / "bin",
    ]
    if plat != "win32":
        dirs.extend([Path("/opt/homebrew/bin"), Path("/usr/local/bin")])
        nvm_bins = sorted(glob.glob(str(home / ".nvm" / "versions" / "node" / "*" / "bin")), reverse=True)
        dirs.extend(Path(p) for p in nvm_bins)
        if plat == "darwin":
            dirs.extend(
                [
                    Path("/Applications/Codex.app/Contents/Resources"),
                    Path("/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS"),
                ]
            )
    else:
        appdata = os.environ.get("APPDATA")
        localappdata = os.environ.get("LOCALAPPDATA")
        if appdata:
            dirs.append(Path(appdata) / "npm")
        if localappdata:
            dirs.append(Path(localappdata) / "agy" / "bin")
            dirs.append(Path(localappdata) / "grok" / "bin")
            dirs.append(Path(localappdata) / "Programs")
    return dirs


def resolve_cli_command(
    binary_name: str,
    env_var: str,
    policy_override: str | None = None,
    npm_rel_entries: Sequence[str] = (),
    project_dir: str = "",
    platform_name: str | None = None,
    node_exe: str | None = None,
) -> list[str] | None:
    """
    Locate a safe, directly launchable CLI command prefix (no cmd.exe .cmd/.bat shell parsing).
    On Windows returns [exe] or [node.exe, entry.js]; on POSIX returns [binary].
    Rejects executables located inside the active project_dir.
    """
    plat = platform_name or sys.platform
    is_win = plat == "win32"

    for raw_cand in (policy_override, os.environ.get(env_var)):
        if not raw_cand or not str(raw_cand).strip():
            continue
        raw = str(raw_cand).strip()
        p = Path(raw).expanduser()
        if is_win:
            if p.is_file():
                resolved = _resolve_windows_file(p, npm_rel_entries, project_dir, node_exe=node_exe)
                if resolved:
                    return resolved
                return None
            found = shutil.which(raw)
            if found:
                return _resolve_windows_file(Path(found), npm_rel_entries, project_dir, node_exe=node_exe)
            return None
        if p.is_file() and os.access(p, os.X_OK) and not _is_within_project(p, project_dir):
            return [str(p)]
        found = shutil.which(raw)
        if found and not _is_within_project(Path(found), project_dir):
            return [found]
        return None

    # Search PATH directories first, then common install directories
    search_dirs: list[Path] = []
    path_env = os.environ.get("PATH") or (os.environ.get("Path") if is_win else "") or ""
    sep = ";" if is_win else ":"
    for seg in path_env.split(sep):
        cleaned = seg.strip().strip('"')
        if cleaned:
            search_dirs.append(Path(cleaned))
    search_dirs.extend(_extra_search_dirs(plat))

    seen_dirs: set[str] = set()
    for directory in search_dirs:
        key = os.path.normcase(str(directory))
        if key in seen_dirs:
            continue
        seen_dirs.add(key)
        if not directory.is_dir():
            continue
        if is_win:
            # 1) Prefer native .exe
            exe_cand = directory / f"{binary_name}.exe"
            resolved = _resolve_windows_file(exe_cand, npm_rel_entries, project_dir, node_exe=node_exe)
            if resolved:
                return resolved
            # 2) Unwrap npm .cmd/.ps1/.bat shim directly to [node.exe, entry.js]
            for ext in (".cmd", ".ps1", ".bat"):
                shim_cand = directory / f"{binary_name}{ext}"
                resolved = _resolve_windows_file(shim_cand, npm_rel_entries, project_dir, node_exe=node_exe)
                if resolved:
                    return resolved
            # 3) Direct known npm entry under this directory
            for rel in npm_rel_entries:
                js_cand = directory / rel
                resolved = _resolve_windows_file(js_cand, npm_rel_entries, project_dir, node_exe=node_exe)
                if resolved:
                    return resolved
        else:
            cand = directory / binary_name
            if cand.is_file() and os.access(cand, os.X_OK) and not _is_within_project(cand, project_dir):
                return [str(cand)]
    return None
