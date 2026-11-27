"""Cross-process locked, per-project isolated local state persistence."""

from __future__ import annotations

import errno
import json
import os
import random
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

if os.name == "nt":
    import msvcrt  # type: ignore[import-not-found]
    fcntl = None  # type: ignore[assignment]
else:
    import fcntl
    msvcrt = None  # type: ignore[assignment]

from .security import (
    DEFAULT_NO_PROXY,
    harden_private_file,
    project_storage_key,
    validate_no_proxy,
    validate_proxy_url,
)

MAX_SESSIONS = 120
MAX_TURNS_PER_SESSION = 60
MAX_STORED_TASKS = 80
DEFAULT_MAX_CONCURRENT = 4
_LOCK_STALE_SECONDS = 30.0
_LOCK_TIMEOUT_SECONDS = 10.0
_WIN_RETRY_ERRNOS = {errno.EACCES, errno.EPERM, errno.EBUSY}
_WIN_RETRY_WINERRORS = {5, 32, 33}  # ACCESS_DENIED, SHARING_VIOLATION, LOCK_VIOLATION


def _is_transient_fs_error(exc: OSError) -> bool:
    """Detect transient Windows NTFS lock/sharing/delete-pending errors worth retrying."""
    if isinstance(exc, PermissionError):
        return True
    if exc.errno in _WIN_RETRY_ERRNOS:
        return True
    winerr = getattr(exc, "winerror", None)
    return isinstance(winerr, int) and winerr in _WIN_RETRY_WINERRORS


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def default_state_dir() -> Path:
    override = os.environ.get("AI_BRIDGE_STATE_DIR", "").strip()
    if override:
        return Path(override).expanduser()
    return Path.home() / ".local" / "share" / "local-ai-bridge"


def default_policy() -> dict[str, Any]:
    return {
        "allow_write": False,
        "allow_full_access": False,
        "max_concurrent": DEFAULT_MAX_CONCURRENT,
        "proxy": {
            "enabled": False,
            "http_proxy": "",
            "https_proxy": "",
            "all_proxy": "",
            "no_proxy": DEFAULT_NO_PROXY,
        },
        "providers": {
            "codex": {"enabled": True, "allow_write": False, "allow_full_access": False, "bin_path": ""},
            "grok": {"enabled": True, "allow_write": False, "allow_full_access": False, "bin_path": ""},
            "antigravity": {"enabled": True, "allow_write": False, "allow_full_access": False, "bin_path": ""},
        },
    }


class CrossProcessLock:
    """
    Thread-safe + cross-process lock guard using OS kernel file locks:
    - Windows: `msvcrt.locking` on a persistent lockfile (never unlinked, avoiding NTFS
      delete-pending PermissionError races) with transient PermissionError retries.
    - POSIX: `fcntl.flock` on a persistent lockfile (auto-released by kernel on crash).
    Strictly fail-closed on timeout.
    """

    def __init__(
        self,
        local_lock: threading.RLock,
        lock_path: Path,
        timeout: float = _LOCK_TIMEOUT_SECONDS,
    ) -> None:
        self._local_lock = local_lock
        self._lock_path = lock_path
        self._timeout = timeout
        self._fd: int | None = None
        self._acquired_local = False

    def __enter__(self) -> CrossProcessLock:
        self._local_lock.acquire()
        self._acquired_local = True
        try:
            self._lock_path.parent.mkdir(parents=True, exist_ok=True)
            deadline = time.monotonic() + self._timeout
            if os.name == "nt" and msvcrt is not None:
                self._acquire_windows(deadline)
            elif fcntl is not None:
                self._acquire_posix_flock(deadline)
            else:
                self._acquire_excl_fallback(deadline)
            return self
        except BaseException:
            self._close_fd()
            self._release_local()
            raise

    def _acquire_windows(self, deadline: float) -> None:
        while True:
            fd: int | None = None
            try:
                fd = os.open(str(self._lock_path), os.O_CREAT | os.O_RDWR)
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                self._fd = fd
                return
            except OSError as exc:
                if fd is not None:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
                retryable = _is_transient_fs_error(exc) or exc.errno in (errno.EDEADLK, errno.EAGAIN)
                if not retryable:
                    raise RuntimeError(f"Failed to acquire state lock: {exc}") from exc
                if time.monotonic() >= deadline:
                    raise TimeoutError(
                        f"Timed out waiting for state lock ({self._timeout:.0f}s)."
                    ) from exc
                time.sleep(0.015 + random.random() * 0.02)

    def _acquire_posix_flock(self, deadline: float) -> None:
        fd = os.open(str(self._lock_path), os.O_CREAT | os.O_RDWR, 0o600)
        self._fd = fd
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"Timed out waiting for state lock ({self._timeout:.0f}s).")
                time.sleep(0.015 + random.random() * 0.015)
            except OSError as exc:
                if exc.errno in (errno.EAGAIN, errno.EACCES, errno.EINTR):
                    if time.monotonic() >= deadline:
                        raise TimeoutError(
                            f"Timed out waiting for state lock ({self._timeout:.0f}s)."
                        ) from exc
                    time.sleep(0.015)
                    continue
                raise RuntimeError(f"Failed to acquire state lock: {exc}") from exc

    def _acquire_excl_fallback(self, deadline: float) -> None:
        while True:
            try:
                self._fd = os.open(
                    str(self._lock_path),
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                    0o600,
                )
                os.write(self._fd, f"{os.getpid()}:{time.time()}\n".encode("ascii"))
                return
            except FileExistsError:
                try:
                    age = time.time() - self._lock_path.stat().st_mtime
                    if age > _LOCK_STALE_SECONDS:
                        self._lock_path.unlink(missing_ok=True)
                        continue
                except OSError:
                    pass
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"Timed out waiting for state lock ({self._timeout:.0f}s).")
                time.sleep(0.025)
            except OSError as exc:
                if _is_transient_fs_error(exc) and time.monotonic() < deadline:
                    time.sleep(0.025)
                    continue
                raise RuntimeError(f"Failed to acquire state lock: {exc}") from exc

    def _close_fd(self) -> None:
        if self._fd is None:
            return
        fd = self._fd
        self._fd = None
        try:
            if os.name == "nt" and msvcrt is not None:
                try:
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                except OSError:
                    pass
            elif fcntl is not None:
                try:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                except OSError:
                    pass
        finally:
            try:
                os.close(fd)
            except OSError:
                pass

    def _release_local(self) -> None:
        if self._acquired_local:
            self._acquired_local = False
            self._local_lock.release()

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        try:
            self._close_fd()
        finally:
            self._release_local()


class StateStore:
    """
    Atomic, cross-process locked JSON persistence.
    - Policy is stored globally at `<state_dir>/policy.json` (private permissions).
    - Sessions and tasks are isolated per project at `<state_dir>/projects/<project_key>/`.
    """

    def __init__(self, state_dir: Path | None = None, project_dir: str = "") -> None:
        self.state_dir = state_dir or default_state_dir()
        self.project_dir = str(Path(project_dir).resolve()) if project_dir else ""
        self.project_key = project_storage_key(self.project_dir)

        self.policy_file = self.state_dir / "policy.json"
        self._policy_lock_file = self.state_dir / ".policy.lock"

        self.project_state_dir = self.state_dir / "projects" / self.project_key
        self.sessions_file = self.project_state_dir / "sessions.json"
        self.tasks_file = self.project_state_dir / "tasks.json"
        self._project_lock_file = self.project_state_dir / ".state.lock"

        self._policy_rlock = threading.RLock()
        self._project_rlock = threading.RLock()

        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.project_state_dir.mkdir(parents=True, exist_ok=True)

    def _policy_lock(self) -> CrossProcessLock:
        return CrossProcessLock(self._policy_rlock, self._policy_lock_file)

    def _project_lock(self) -> CrossProcessLock:
        return CrossProcessLock(self._project_rlock, self._project_lock_file)

    def _read_json(self, path: Path, fallback: Any) -> Any:
        deadline = time.monotonic() + 1.5
        while True:
            try:
                if not path.is_file():
                    return fallback
                return json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                return fallback
            except OSError as exc:
                if os.name == "nt" and _is_transient_fs_error(exc) and time.monotonic() < deadline:
                    time.sleep(0.015)
                    continue
                return fallback

    def _write_json(self, path: Path, payload: Any, private: bool = True) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        unique_name = f".{path.name}.{os.getpid()}.{threading.get_ident()}.{uuid.uuid4().hex[:8]}.tmp"
        tmp = path.with_name(unique_name)
        text = json.dumps(payload, ensure_ascii=False, indent=2)
        try:
            with tmp.open("w", encoding="utf-8", newline="\n") as fh:
                fh.write(text)
                fh.flush()
                try:
                    os.fsync(fh.fileno())
                except OSError:
                    pass
            if private:
                harden_private_file(tmp)
            replace_deadline = time.monotonic() + 3.0
            while True:
                try:
                    os.replace(tmp, path)
                    break
                except OSError as exc:
                    if os.name == "nt" and _is_transient_fs_error(exc) and time.monotonic() < replace_deadline:
                        time.sleep(0.02 + random.random() * 0.02)
                        continue
                    raise
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise

    # ---- Policy (global, cross-process locked) ----
    def _parse_policy(self, saved: Any) -> dict[str, Any]:
        base = default_policy()
        if not isinstance(saved, dict):
            return base
        base["allow_write"] = bool(saved.get("allow_write", False))
        base["allow_full_access"] = bool(saved.get("allow_full_access", False))
        mc = saved.get("max_concurrent", DEFAULT_MAX_CONCURRENT)
        if isinstance(mc, int) and not isinstance(mc, bool) and 1 <= mc <= 12:
            base["max_concurrent"] = mc
        saved_proxy = saved.get("proxy")
        if isinstance(saved_proxy, dict):
            base["proxy"]["enabled"] = bool(saved_proxy.get("enabled", False))
            for key in ("http_proxy", "https_proxy", "all_proxy"):
                val = saved_proxy.get(key)
                base["proxy"][key] = str(val).strip() if isinstance(val, str) else ""
            np_val = saved_proxy.get("no_proxy")
            base["proxy"]["no_proxy"] = (
                str(np_val).strip() if isinstance(np_val, str) and np_val.strip() else DEFAULT_NO_PROXY
            )
        saved_providers = saved.get("providers")
        if isinstance(saved_providers, dict):
            for pid in ("codex", "grok", "antigravity"):
                entry = saved_providers.get(pid)
                if isinstance(entry, dict):
                    base["providers"][pid]["enabled"] = bool(entry.get("enabled", True))
                    base["providers"][pid]["allow_write"] = bool(entry.get("allow_write", False))
                    base["providers"][pid]["allow_full_access"] = bool(entry.get("allow_full_access", False))
                    bp = entry.get("bin_path")
                    base["providers"][pid]["bin_path"] = str(bp).strip() if isinstance(bp, str) else ""
        return base

    def get_policy(self) -> dict[str, Any]:
        with self._policy_lock():
            return self._parse_policy(self._read_json(self.policy_file, {}))

    def update_policy(self, updates: dict[str, Any]) -> dict[str, Any]:
        with self._policy_lock():
            policy = self._parse_policy(self._read_json(self.policy_file, {}))
            if "allow_write" in updates:
                policy["allow_write"] = bool(updates["allow_write"])
            if "allow_full_access" in updates:
                policy["allow_full_access"] = bool(updates["allow_full_access"])
            if "max_concurrent" in updates:
                raw_mc = updates["max_concurrent"]
                if isinstance(raw_mc, bool) or not isinstance(raw_mc, int) or not 1 <= raw_mc <= 12:
                    raise ValueError("max_concurrent must be an integer between 1 and 12.")
                policy["max_concurrent"] = raw_mc
            if isinstance(updates.get("proxy"), dict):
                px = updates["proxy"]
                if "enabled" in px:
                    policy["proxy"]["enabled"] = bool(px["enabled"])
                for key in ("http_proxy", "https_proxy", "all_proxy"):
                    if key in px:
                        val = px[key]
                        if isinstance(val, str) and "://***@" in val and policy["proxy"].get(key):
                            continue
                        policy["proxy"][key] = validate_proxy_url(val, label=key)
                if "no_proxy" in px:
                    policy["proxy"]["no_proxy"] = validate_no_proxy(px["no_proxy"]) or DEFAULT_NO_PROXY
            if isinstance(updates.get("providers"), dict):
                for pid, pval in updates["providers"].items():
                    if pid not in policy["providers"] or not isinstance(pval, dict):
                        continue
                    if "enabled" in pval:
                        policy["providers"][pid]["enabled"] = bool(pval["enabled"])
                    if "allow_write" in pval:
                        policy["providers"][pid]["allow_write"] = bool(pval["allow_write"])
                    if "allow_full_access" in pval:
                        policy["providers"][pid]["allow_full_access"] = bool(pval["allow_full_access"])
                    if "bin_path" in pval:
                        policy["providers"][pid]["bin_path"] = str(pval["bin_path"] or "").strip()
            self._write_json(self.policy_file, policy, private=True)
            return policy

    # ---- Sessions (strictly per-project isolated) ----
    def _load_sessions_map(self) -> dict[str, dict[str, Any]]:
        raw = self._read_json(self.sessions_file, {})
        if not isinstance(raw, dict):
            return {}
        if not self.project_dir:
            return raw
        return {
            sid: sess
            for sid, sess in raw.items()
            if isinstance(sess, dict) and sess.get("project_dir") == self.project_dir
        }

    def _save_sessions_map(self, data: dict[str, dict[str, Any]]) -> None:
        if len(data) > MAX_SESSIONS:
            ordered = sorted(
                data.items(),
                key=lambda kv: str(kv[1].get("updated_at") or ""),
                reverse=True,
            )[:MAX_SESSIONS]
            data = dict(ordered)
        self._write_json(self.sessions_file, data, private=True)

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        with self._project_lock():
            return self._load_sessions_map().get(session_id)

    def upsert_session(self, session: dict[str, Any]) -> dict[str, Any]:
        with self._project_lock():
            data = self._load_sessions_map()
            sid = session["id"]
            session["project_dir"] = self.project_dir
            session["updated_at"] = utc_now()
            turns = session.get("turns") or []
            if len(turns) > MAX_TURNS_PER_SESSION:
                session["turns"] = turns[-MAX_TURNS_PER_SESSION:]
            data[sid] = session
            self._save_sessions_map(data)
            return session

    def append_session_turn(
        self,
        session_id: str,
        role: str,
        content: str,
        task_id: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        with self._project_lock():
            data = self._load_sessions_map()
            sess = data.get(session_id)
            if not sess:
                return None
            turns = list(sess.get("turns") or [])
            turns.append(
                {
                    "role": role,
                    "content": content,
                    "task_id": task_id,
                    "at": utc_now(),
                    **({"meta": meta} if meta else {}),
                }
            )
            sess["turns"] = turns[-MAX_TURNS_PER_SESSION:]
            sess["updated_at"] = utc_now()
            data[session_id] = sess
            self._save_sessions_map(data)
            return sess

    def update_session_provider_id(self, session_id: str, provider_session_id: str) -> None:
        if not provider_session_id:
            return
        with self._project_lock():
            data = self._load_sessions_map()
            sess = data.get(session_id)
            if not sess:
                return
            if sess.get("provider_session_id") != provider_session_id:
                sess["provider_session_id"] = provider_session_id
                sess["updated_at"] = utc_now()
                data[session_id] = sess
                self._save_sessions_map(data)

    def list_sessions(
        self,
        provider: str | None = None,
        limit: int = 30,
    ) -> list[dict[str, Any]]:
        with self._project_lock():
            items = list(self._load_sessions_map().values())
        if provider:
            items = [s for s in items if s.get("provider") == provider]
        items.sort(key=lambda s: str(s.get("updated_at") or ""), reverse=True)
        return items[: max(1, min(limit, 100))]

    def delete_session(self, session_id: str) -> bool:
        with self._project_lock():
            data = self._load_sessions_map()
            if session_id not in data:
                return False
            del data[session_id]
            self._save_sessions_map(data)
            return True

    # ---- Persisted task snapshots (strictly per-project isolated) ----
    def load_saved_tasks(self) -> list[dict[str, Any]]:
        with self._project_lock():
            raw = self._read_json(self.tasks_file, [])
            if not isinstance(raw, list):
                return []
            if not self.project_dir:
                return [item for item in raw if isinstance(item, dict)]
            return [
                item
                for item in raw
                if isinstance(item, dict) and item.get("project_dir") == self.project_dir
            ]

    def save_task_snapshot(self, snapshot: dict[str, Any]) -> None:
        with self._project_lock():
            items = self._load_saved_tasks_unlocked()
            tid = snapshot["id"]
            snapshot["project_dir"] = self.project_dir
            items = [item for item in items if item.get("id") != tid]
            items.insert(0, snapshot)
            self._write_json(self.tasks_file, items[:MAX_STORED_TASKS], private=True)

    def _load_saved_tasks_unlocked(self) -> list[dict[str, Any]]:
        raw = self._read_json(self.tasks_file, [])
        if not isinstance(raw, list):
            return []
        if not self.project_dir:
            return [item for item in raw if isinstance(item, dict)]
        return [
            item
            for item in raw
            if isinstance(item, dict) and item.get("project_dir") == self.project_dir
        ]

    def clear_finished_tasks(self) -> int:
        with self._project_lock():
            items = self._load_saved_tasks_unlocked()
            count = len(items)
            self._write_json(self.tasks_file, [], private=True)
            return count
