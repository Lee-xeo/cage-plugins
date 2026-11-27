"""Security boundaries, Windows-safe binary resolution, redaction, and validation."""

from __future__ import annotations

import glob
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Sequence

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


def resolve_project_file(rel_path: str, project_dir: str, label: str = "prompt_file") -> Path:
    """Resolve a relative UTF-8 text file confined strictly to project_dir."""
    if not project_dir:
        raise ValueError("No active project directory is open.")
    if not isinstance(rel_path, str) or not rel_path.strip():
        raise ValueError(f"{label} must be a non-empty relative path.")
    cleaned = rel_path.strip()
    if "\x00" in cleaned:
        raise ValueError(f"{label} contains invalid characters.")
    candidate = Path(cleaned)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise ValueError(f"{label} must be a relative path inside the active project directory.")
    base = Path(project_dir)
    if not base.is_dir():
        raise ValueError("Active project directory does not exist.")
    full = base / candidate
    if not full.exists():
        raise ValueError(f"{label} does not exist: {cleaned}")
    resolved = assert_within_dir(full, base, label=label)
    if not resolved.is_file():
        raise ValueError(f"{label} is not a regular file: {cleaned}")
    size = resolved.stat().st_size
    if size > MAX_PROMPT_BYTES:
        raise ValueError(f"{label} exceeds the {MAX_PROMPT_BYTES // 1024} KiB size limit.")
    return resolved


def resolve_prompt_input(
    prompt: str | None,
    prompt_file: str | None,
    project_dir: str,
) -> str:
    """Resolve prompt text from inline string or a jailed project file."""
    if isinstance(prompt, str) and prompt.strip():
        text = prompt.strip()
        if len(text.encode("utf-8")) > MAX_PROMPT_BYTES:
            raise ValueError(f"Prompt exceeds {MAX_PROMPT_BYTES // 1024} KiB limit.")
        return text
    if isinstance(prompt_file, str) and prompt_file.strip():
        path = resolve_project_file(prompt_file, project_dir, label="prompt_file")
        raw = path.read_bytes()
        if b"\x00" in raw:
            raise ValueError("prompt_file appears to be binary.")
        text = raw.decode("utf-8", errors="replace").strip()
        if not text:
            raise ValueError(f"prompt_file is empty: {path.name}")
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
