"""Shared adapter protocol, data models, and safe cross-platform subprocess utilities."""

from __future__ import annotations

import os
import queue
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable


@dataclass
class ProviderStatus:
    available: bool
    authenticated: bool | None = None
    version: str | None = None
    binary_path: str | None = None
    error: str | None = None


@dataclass
class ModelInfo:
    id: str
    display_name: str
    is_default: bool = False
    efforts: list[str] = field(default_factory=list)
    default_effort: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "display_name": self.display_name,
            "is_default": self.is_default,
            "efforts": list(self.efforts),
            "default_effort": self.default_effort,
        }


@dataclass
class TurnRequest:
    prompt: str
    project_dir: str
    mode: str = "read-only"  # "read-only" | "workspace-write" | "full-access"
    model: str | None = None
    effort: str | None = None
    provider_session_id: str | None = None
    bin_override: str | None = None
    env: dict[str, str] | None = None
    timeout_seconds: int = 900


@dataclass
class TurnResult:
    ok: bool
    answer: str = ""
    error: str | None = None
    provider_session_id: str | None = None
    usage: dict[str, Any] | None = None


class TaskHandle:
    """Thread-safe cancellation and streaming progress callback handle."""

    def __init__(
        self,
        on_activity: Callable[[str, str, str | None], None],
        on_delta: Callable[[str], None],
        on_provider_session_id: Callable[[str], None],
    ) -> None:
        self.cancel_event = threading.Event()
        self._on_activity = on_activity
        self._on_delta = on_delta
        self._on_provider_session_id = on_provider_session_id
        self._lock = threading.Lock()
        self._cancel_hooks: list[Callable[[], None]] = []

    def emit_activity(self, phase: str, activity: str, detail: str | None = None) -> None:
        self._on_activity(phase, activity, detail)

    def append_delta(self, chunk: str) -> None:
        self._on_delta(chunk)

    def set_provider_session_id(self, session_id: str) -> None:
        if session_id:
            self._on_provider_session_id(session_id)

    def add_cancel_hook(self, hook: Callable[[], None]) -> None:
        already_cancelled = False
        with self._lock:
            if self.cancel_event.is_set():
                already_cancelled = True
            else:
                self._cancel_hooks.append(hook)
        if already_cancelled:
            try:
                hook()
            except Exception:
                pass

    def cancel(self) -> None:
        with self._lock:
            self.cancel_event.set()
            hooks = list(self._cancel_hooks)
            self._cancel_hooks.clear()
        for hook in hooks:
            try:
                hook()
            except Exception:
                pass


class AIProvider:
    """Base interface implemented by each native CLI adapter."""

    id: str = ""
    display_name: str = ""
    capabilities: tuple[str, ...] = ()

    def probe(
        self,
        bin_override: str | None = None,
        env: dict[str, str] | None = None,
        project_dir: str = "",
    ) -> ProviderStatus:
        raise NotImplementedError

    def list_models(
        self,
        bin_override: str | None = None,
        env: dict[str, str] | None = None,
        project_dir: str = "",
    ) -> list[ModelInfo]:
        raise NotImplementedError

    def run_turn(self, req: TurnRequest, handle: TaskHandle) -> TurnResult:
        raise NotImplementedError


def spawn_cli(
    argv: list[str],
    cwd: str | None = None,
    env: dict[str, str] | None = None,
) -> subprocess.Popen[str]:
    """Start a CLI subprocess in its own process group with shell=False."""
    kwargs: dict[str, Any] = {
        "stdin": subprocess.PIPE,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "shell": False,
        "cwd": cwd,
        "env": env,
    }
    if sys.platform == "win32":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(
            subprocess, "CREATE_NEW_PROCESS_GROUP", 0
        )
    else:
        kwargs["start_new_session"] = True
    return subprocess.Popen(argv, **kwargs)


def terminate_process_tree(proc: subprocess.Popen[Any]) -> None:
    """Reliably terminate a subprocess and all of its descendants across POSIX and Windows."""
    pid = getattr(proc, "pid", None)
    if not isinstance(pid, int) or pid <= 0 or pid == os.getpid():
        return
    try:
        if sys.platform == "win32":
            if proc.poll() is not None:
                return
            system_root = os.environ.get("SystemRoot", "").strip()
            taskkill = str(Path(system_root) / "System32" / "taskkill.exe") if system_root else "taskkill.exe"
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            try:
                subprocess.run(
                    [taskkill, "/PID", str(pid), "/T", "/F"],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=5,
                    shell=False,
                    creationflags=creationflags,
                )
            except Exception:
                pass
            if proc.poll() is None:
                try:
                    proc.kill()
                except OSError:
                    pass
            try:
                proc.wait(timeout=1.5)
            except subprocess.TimeoutExpired:
                pass
            return

        # POSIX: signal the whole process group even if the group leader exited.
        sent_term = False
        try:
            os.killpg(pid, signal.SIGTERM)
            sent_term = True
        except ProcessLookupError:
            pass
        except OSError:
            if proc.poll() is None:
                proc.terminate()
                sent_term = True

        if sent_term:
            try:
                proc.wait(timeout=0.6)
            except subprocess.TimeoutExpired:
                pass
            try:
                os.killpg(pid, signal.SIGKILL)
            except OSError:
                if proc.poll() is None:
                    proc.kill()
        elif proc.poll() is None:
            proc.kill()
        try:
            proc.wait(timeout=1.0)
        except subprocess.TimeoutExpired:
            pass
    except Exception:
        pass


def run_quick_command(
    argv: list[str],
    timeout: float = 8.0,
    env: dict[str, str] | None = None,
) -> tuple[int, str, str]:
    """Run a short metadata command (e.g. --version / models) safely."""
    proc = spawn_cli(argv, env=env)
    try:
        out, err = proc.communicate(timeout=timeout)
        return proc.returncode or 0, out or "", err or ""
    except subprocess.TimeoutExpired:
        terminate_process_tree(proc)
        return -1, "", "Command timed out."
    except Exception as exc:
        terminate_process_tree(proc)
        return -1, "", str(exc)


def stream_process_lines(
    proc: subprocess.Popen[str],
    handle: TaskHandle,
    on_stdout_line: Callable[[str], None],
    stdin_text: str | None = None,
    timeout_seconds: int = 900,
) -> tuple[int, list[str], bool]:
    """
    Feed optional stdin, stream stdout lines non-blockingly via a queue, collect tail stderr,
    and honor cancellation and timeout without blocking on readline().
    Returns: (exit_code, stderr_tail, timed_out)
    """
    handle.add_cancel_hook(lambda: terminate_process_tree(proc))

    stderr_tail: list[str] = []
    line_q: queue.Queue[str | None] = queue.Queue()

    def _drain_stderr() -> None:
        if not proc.stderr:
            return
        try:
            for line in proc.stderr:
                stderr_tail.append(line)
                if len(stderr_tail) > 60:
                    del stderr_tail[:-60]
        except Exception:
            pass

    def _read_stdout() -> None:
        if not proc.stdout:
            line_q.put(None)
            return
        try:
            for line in proc.stdout:
                line_q.put(line)
        except Exception:
            pass
        finally:
            line_q.put(None)

    t_err = threading.Thread(target=_drain_stderr, daemon=True)
    t_out = threading.Thread(target=_read_stdout, daemon=True)
    t_err.start()
    t_out.start()

    if proc.stdin is not None:
        try:
            if stdin_text is not None:
                proc.stdin.write(stdin_text)
                proc.stdin.flush()
        except OSError:
            pass
        finally:
            try:
                proc.stdin.close()
            except OSError:
                pass

    deadline = time.monotonic() + max(5, timeout_seconds)
    timed_out = False
    while True:
        if handle.cancel_event.is_set():
            terminate_process_tree(proc)
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            timed_out = True
            terminate_process_tree(proc)
            break
        try:
            item = line_q.get(timeout=min(0.25, remaining))
        except queue.Empty:
            if proc.poll() is not None and not t_out.is_alive():
                break
            continue
        if item is None:
            break
        on_stdout_line(item)

    try:
        code = proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        terminate_process_tree(proc)
        code = -1
    t_err.join(timeout=1.0)
    return code, stderr_tail, timed_out
