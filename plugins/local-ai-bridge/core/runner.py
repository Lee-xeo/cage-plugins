"""Concurrent background task runner, progress tracker, and provider orchestration."""

from __future__ import annotations

import concurrent.futures
import hashlib
import json
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .providers.base import AIProvider, ModelInfo, ProviderStatus, TaskHandle, TurnRequest
from .security import (
    MAX_OUTPUT_RETURN_CHARS,
    build_cli_env,
    is_full_access_allowed,
    is_provider_enabled,
    is_write_allowed,
    mask_proxy_config,
    resolve_effective_mode,
    resolve_prompt_input,
    sanitize_diagnostic,
    validate_effort,
    validate_identifier,
    validate_model_id,
)
from .store import StateStore, utc_now

MODEL_CACHE_TTL_SEC = 60.0
PROBE_CACHE_TTL_SEC = 15.0
MAX_LIVE_PREVIEW_CHARS = 12_000
MAX_ACTIVITY_LOG = 30
MAX_WAIT_SECONDS = 25


@dataclass
class TaskRecord:
    id: str
    session_id: str
    provider: str
    project_dir: str
    project_name: str
    prompt_preview: str
    mode: str
    model: str | None
    effort: str | None
    request_id: str | None
    fingerprint: str | None
    status: str = "queued"  # queued | running | completed | failed | cancelling | cancelled
    phase: str = "queued"
    last_activity: str = "queued"
    started_at: float = field(default_factory=time.monotonic)
    created_at: str = field(default_factory=utc_now)
    changed_at: float = field(default_factory=time.monotonic)
    ended_at: float | None = None
    finished_at: str | None = None
    events_count: int = 0
    partial_text: str = ""
    answer: str | None = None
    error: str | None = None
    usage: dict[str, Any] | None = None
    activities: list[dict[str, Any]] = field(default_factory=list)
    handle: TaskHandle | None = None

    def elapsed_ms(self) -> int:
        end = self.ended_at if self.ended_at is not None else time.monotonic()
        return max(0, int((end - self.started_at) * 1000))


class TaskRunner:
    """Coordinates provider discovery, async CLI execution, streaming progress, and cancellation."""

    def __init__(
        self,
        project_dir: str,
        store: StateStore,
        providers: dict[str, AIProvider],
    ) -> None:
        self.project_dir = str(Path(project_dir).resolve()) if project_dir else ""
        self.project_name = Path(self.project_dir).name if self.project_dir else ""
        self.store = store
        self.providers = providers

        self._lock = threading.RLock()
        self._cond = threading.Condition(self._lock)
        self._tasks: dict[str, TaskRecord] = {}
        self._request_index: dict[str, str] = {}
        self._model_cache: dict[str, tuple[float, list[dict[str, Any]], str | None]] = {}
        self._probe_cache: dict[str, tuple[float, ProviderStatus]] = {}
        self._closed = False
        self._executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=12,
            thread_name_prefix="ai-bridge-worker",
        )
        self._hydrate_saved_tasks()

    def _hydrate_saved_tasks(self) -> None:
        """Load historical completed tasks strictly belonging to this project."""
        for snap in self.store.load_saved_tasks():
            tid = snap.get("id")
            if not isinstance(tid, str) or not tid:
                continue
            if self.project_dir and snap.get("project_dir") != self.project_dir:
                continue
            status = str(snap.get("status") or "completed")
            if status in ("queued", "running", "cancelling"):
                status = "cancelled"
            rec = TaskRecord(
                id=tid,
                session_id=str(snap.get("session_id") or ""),
                provider=str(snap.get("provider") or ""),
                project_dir=str(snap.get("project_dir") or self.project_dir),
                project_name=str(snap.get("project_name") or self.project_name),
                prompt_preview=str(snap.get("prompt_preview") or ""),
                mode=str(snap.get("mode") or "read-only"),
                model=snap.get("model"),
                effort=snap.get("effort"),
                request_id=None,
                fingerprint=None,
                status=status,
                phase=str(snap.get("phase") or status),
                last_activity=str(snap.get("last_activity") or status),
                created_at=str(snap.get("created_at") or ""),
                finished_at=snap.get("finished_at"),
                events_count=int(snap.get("events_count") or 0),
                answer=snap.get("answer"),
                error=snap.get("error"),
                usage=snap.get("usage"),
                activities=list(snap.get("activities") or []),
            )
            elapsed_ms = int(snap.get("elapsed_ms") or 0)
            rec.started_at = time.monotonic() - (elapsed_ms / 1000.0)
            rec.ended_at = time.monotonic()
            self._tasks[tid] = rec

    def _get_provider(self, provider_id: str) -> AIProvider:
        pid = (provider_id or "").strip().lower()
        if pid in ("agy", "ag"):
            pid = "antigravity"
        if pid not in self.providers:
            raise ValueError(
                f"Unknown provider '{provider_id}'. Available: {', '.join(sorted(self.providers))}."
            )
        return self.providers[pid]

    def _bin_override(self, provider_id: str, policy: dict[str, Any]) -> str | None:
        pcfg = (policy.get("providers") or {}).get(provider_id) or {}
        val = pcfg.get("bin_path")
        return val if isinstance(val, str) and val.strip() else None

    def _probe_provider_cached(
        self,
        pid: str,
        provider: AIProvider,
        policy: dict[str, Any],
        cli_env: dict[str, str],
        refresh: bool = False,
    ) -> ProviderStatus:
        now = time.monotonic()
        if not refresh:
            with self._lock:
                cached = self._probe_cache.get(pid)
                if cached and now < cached[0]:
                    return cached[1]
        status = provider.probe(
            bin_override=self._bin_override(pid, policy),
            env=cli_env,
            project_dir=self.project_dir,
        )
        with self._lock:
            self._probe_cache[pid] = (time.monotonic() + PROBE_CACHE_TTL_SEC, status)
        return status

    # ---- Discovery ----
    def _collect_providers(
        self,
        include_host_paths: bool = False,
        refresh: bool = False,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        policy = self.store.get_policy()
        cli_env = build_cli_env(policy)
        statuses: list[dict[str, Any]] = []
        for pid, provider in self.providers.items():
            enabled = is_provider_enabled(pid, policy)
            allow_write = is_write_allowed(pid, policy)
            allow_full_access = is_full_access_allowed(pid, policy)
            status = self._probe_provider_cached(pid, provider, policy, cli_env, refresh=refresh)
            entry: dict[str, Any] = {
                "id": pid,
                "display_name": provider.display_name,
                "enabled": enabled,
                "available": status.available,
                "binary_detected": bool(status.binary_path),
                "authenticated": status.authenticated,
                "version": status.version,
                "error": sanitize_diagnostic(status.error, self.project_dir) if status.error else None,
                "allow_write": allow_write,
                "allow_full_access": allow_full_access,
                "max_mode": "full-access" if allow_full_access else ("workspace-write" if allow_write else "read-only"),
                "default_mode": "read-only",
                "requires_risk_ack": pid == "antigravity",
                "capabilities": list(provider.capabilities),
            }
            if pid == "antigravity":
                pcfg = (policy.get("providers") or {}).get(pid) or {}
                entry["risk_acknowledged"] = bool(pcfg.get("risk_acknowledged", False))
            if include_host_paths and status.binary_path:
                entry["binary_path"] = sanitize_diagnostic(status.binary_path, self.project_dir)
            statuses.append(entry)
        return policy, statuses

    def list_providers(self, refresh: bool = False) -> dict[str, Any]:
        """Model-safe provider status summary (never leaks host user paths or credentials)."""
        policy, statuses = self._collect_providers(include_host_paths=False, refresh=refresh)
        return {
            "project_name": self.project_name,
            "global_allow_write": bool(policy.get("allow_write", False)),
            "global_allow_full_access": bool(policy.get("allow_full_access", False)),
            "proxy_enabled": bool((policy.get("proxy") or {}).get("enabled", False)),
            "max_concurrent": int(policy.get("max_concurrent", 4)),
            "providers": statuses,
        }

    def list_models(self, provider_id: str, refresh: bool = False) -> dict[str, Any]:
        provider = self._get_provider(provider_id)
        pid = provider.id
        policy = self.store.get_policy()
        if pid == "antigravity" and not is_provider_enabled(pid, policy):
            raise PermissionError(
                "Antigravity is disabled by default because invoking it via third-party automation "
                "does not comply with Google's policies. Please consider carefully and confirm the "
                "risk warning in the Local AI Bridge panel before enabling it."
            )
        now = time.monotonic()
        with self._lock:
            cached = self._model_cache.get(pid)
            if not refresh and cached and now < cached[0]:
                return {
                    "provider": pid,
                    "models": cached[1],
                    "cached": True,
                    **({"error": cached[2]} if cached[2] else {}),
                }
        cli_env = build_cli_env(policy)
        models_out: list[dict[str, Any]] = []
        err_msg: str | None = None
        try:
            models: list[ModelInfo] = provider.list_models(
                bin_override=self._bin_override(pid, policy),
                env=cli_env,
                project_dir=self.project_dir,
            )
            models_out = [m.to_dict() for m in models]
        except Exception as exc:
            err_msg = sanitize_diagnostic(str(exc), self.project_dir)

        with self._lock:
            self._model_cache[pid] = (time.monotonic() + MODEL_CACHE_TTL_SEC, models_out, err_msg)
        return {
            "provider": pid,
            "models": models_out,
            "cached": False,
            **({"error": err_msg} if err_msg else {}),
        }

    # ---- Execution ----
    def start_task(
        self,
        provider_id: str,
        prompt: str | None = None,
        prompt_file: str | None = None,
        session_id: str | None = None,
        model: str | None = None,
        effort: str | None = None,
        mode: str | None = None,
        title: str | None = None,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        if not self.project_dir:
            raise RuntimeError("Open a shared project directory before running AI tasks.")

        provider = self._get_provider(provider_id)
        pid = provider.id
        policy = self.store.get_policy()
        if not is_provider_enabled(pid, policy):
            if pid == "antigravity":
                raise PermissionError(
                    "Antigravity is disabled by default because invoking it via third-party automation "
                    "does not comply with Google's policies. Please consider carefully and confirm the "
                    "risk warning in the Local AI Bridge panel before enabling it."
                )
            raise PermissionError(f"Provider '{pid}' is disabled in Local AI Bridge settings.")

        effective_mode = resolve_effective_mode(mode, pid, policy)
        resolved_prompt = resolve_prompt_input(prompt, prompt_file, self.project_dir)
        clean_model = validate_model_id(model)
        clean_effort = validate_effort(effort)
        clean_req_id = validate_identifier(request_id, "request_id") if request_id else None

        fingerprint = hashlib.sha256(
            json.dumps(
                [pid, session_id or "", resolved_prompt, clean_model or "", clean_effort or "", effective_mode],
                ensure_ascii=False,
            ).encode("utf-8")
        ).hexdigest()

        with self._lock:
            if self._closed:
                raise RuntimeError("Service is shutting down.")
            if clean_req_id and clean_req_id in self._request_index:
                existing = self._tasks.get(self._request_index[clean_req_id])
                if existing and existing.project_dir == self.project_dir:
                    if existing.fingerprint != fingerprint:
                        raise ValueError("request_id was already used with different arguments.")
                    return self._format_task_for_caller(existing, include_next_check=True)

            active_count = sum(1 for t in self._tasks.values() if t.ended_at is None)
            max_conc = int(policy.get("max_concurrent", 4))
            if active_count >= max_conc:
                raise RuntimeError(
                    f"Concurrency limit reached ({active_count}/{max_conc} tasks running). "
                    "Wait for an active task to finish or cancel one."
                )

            provider_session_id: str | None = None
            if session_id:
                clean_sid = validate_identifier(session_id, "session_id")
                sess = self.store.get_session(clean_sid)
                if not sess or sess.get("project_dir") != self.project_dir:
                    raise ValueError(f"Unknown session_id '{clean_sid}' in the active project.")
                if sess.get("provider") != pid:
                    raise ValueError(
                        f"Session '{clean_sid}' belongs to provider '{sess.get('provider')}', not '{pid}'."
                    )
                provider_session_id = sess.get("provider_session_id") or None
                final_session_id = clean_sid
            else:
                final_session_id = str(uuid.uuid4())
                short_title = (title or "").strip()[:80] or resolved_prompt.splitlines()[0][:64]
                self.store.upsert_session(
                    {
                        "id": final_session_id,
                        "provider": pid,
                        "provider_session_id": None,
                        "project_dir": self.project_dir,
                        "project_name": self.project_name,
                        "title": short_title,
                        "model": clean_model,
                        "effort": clean_effort,
                        "mode": effective_mode,
                        "created_at": utc_now(),
                        "updated_at": utc_now(),
                        "turns": [],
                    }
                )

            task_id = str(uuid.uuid4())
            rec = TaskRecord(
                id=task_id,
                session_id=final_session_id,
                provider=pid,
                project_dir=self.project_dir,
                project_name=self.project_name,
                prompt_preview=resolved_prompt[:240],
                mode=effective_mode,
                model=clean_model,
                effort=clean_effort,
                request_id=clean_req_id,
                fingerprint=fingerprint,
                status="running",
                phase="launching",
                last_activity="launching",
            )
            handle = self._make_handle(rec)
            rec.handle = handle
            self._tasks[task_id] = rec
            if clean_req_id:
                self._request_index[clean_req_id] = task_id

            self.store.append_session_turn(
                final_session_id,
                role="user",
                content=resolved_prompt,
                task_id=task_id,
                meta={"mode": effective_mode, "model": clean_model, "effort": clean_effort},
            )

            req = TurnRequest(
                prompt=resolved_prompt,
                project_dir=self.project_dir,
                mode=effective_mode,
                model=clean_model,
                effort=clean_effort,
                provider_session_id=provider_session_id,
                bin_override=self._bin_override(pid, policy),
                env=build_cli_env(policy),
            )
            self._executor.submit(self._execute_task, rec, provider, req, handle)
            return self._format_task_for_caller(rec, include_next_check=True)

    def _make_handle(self, rec: TaskRecord) -> TaskHandle:
        def on_activity(phase: str, activity: str, detail: str | None = None) -> None:
            with self._cond:
                if rec.ended_at is not None:
                    return
                rec.phase = phase
                rec.last_activity = activity
                rec.events_count += 1
                rec.changed_at = time.monotonic()
                entry: dict[str, Any] = {"at": utc_now(), "phase": phase, "activity": activity}
                if detail:
                    entry["detail"] = sanitize_diagnostic(detail[:200], self.project_dir)
                rec.activities.append(entry)
                if len(rec.activities) > MAX_ACTIVITY_LOG:
                    rec.activities = rec.activities[-MAX_ACTIVITY_LOG:]
                self._cond.notify_all()

        def on_delta(text_chunk: str) -> None:
            if not text_chunk:
                return
            with self._cond:
                if rec.ended_at is not None:
                    return
                combined = rec.partial_text + text_chunk
                if len(combined) > MAX_LIVE_PREVIEW_CHARS:
                    combined = combined[-MAX_LIVE_PREVIEW_CHARS:]
                rec.partial_text = combined
                rec.changed_at = time.monotonic()
                self._cond.notify_all()

        def on_provider_session_id(psid: str) -> None:
            if psid:
                self.store.update_session_provider_id(rec.session_id, psid)

        return TaskHandle(
            on_activity=on_activity,
            on_delta=on_delta,
            on_provider_session_id=on_provider_session_id,
        )

    def _execute_task(
        self,
        rec: TaskRecord,
        provider: AIProvider,
        req: TurnRequest,
        handle: TaskHandle,
    ) -> None:
        try:
            result = provider.run_turn(req, handle)
            if result.provider_session_id:
                self.store.update_session_provider_id(rec.session_id, result.provider_session_id)
            with self._cond:
                if handle.cancel_event.is_set() or rec.status == "cancelling":
                    rec.status = "cancelled"
                    rec.phase = "cancelled"
                    rec.last_activity = "cancelled"
                    rec.error = "Task cancelled by user."
                elif result.ok:
                    rec.status = "completed"
                    rec.phase = "completed"
                    rec.last_activity = "completed"
                    rec.answer = result.answer
                    rec.usage = result.usage
                else:
                    rec.status = "failed"
                    rec.phase = "failed"
                    rec.last_activity = "failed"
                    rec.error = sanitize_diagnostic(result.error or "Provider returned an error.", self.project_dir)
                    if result.answer:
                        rec.answer = result.answer
                rec.finished_at = utc_now()
                rec.handle = None
                snapshot = self._persistable_snapshot(rec)
                final_status = rec.status
                final_answer = rec.answer
                final_error = rec.error
                final_usage = rec.usage
                final_elapsed = rec.elapsed_ms()

            if final_status == "completed" and final_answer is not None:
                self.store.append_session_turn(
                    rec.session_id,
                    role="assistant",
                    content=final_answer,
                    task_id=rec.id,
                    meta={"usage": final_usage, "elapsed_ms": final_elapsed},
                )
            elif final_status in ("failed", "cancelled"):
                self.store.append_session_turn(
                    rec.session_id,
                    role="system",
                    content=f"[{final_status}] {final_error or ''}".strip(),
                    task_id=rec.id,
                )
            self.store.save_task_snapshot(snapshot)

            with self._cond:
                rec.ended_at = time.monotonic()
                rec.changed_at = rec.ended_at
                self._cond.notify_all()
        except Exception as exc:
            err = sanitize_diagnostic(str(exc), self.project_dir)
            with self._cond:
                rec.status = "cancelled" if handle.cancel_event.is_set() else "failed"
                rec.phase = rec.status
                rec.last_activity = rec.status
                rec.error = "Task cancelled by user." if rec.status == "cancelled" else err
                rec.finished_at = utc_now()
                rec.handle = None
                snapshot = self._persistable_snapshot(rec)
                final_status = rec.status
                final_error = rec.error
            self.store.append_session_turn(
                rec.session_id,
                role="system",
                content=f"[{final_status}] {final_error}",
                task_id=rec.id,
            )
            self.store.save_task_snapshot(snapshot)
            with self._cond:
                rec.ended_at = time.monotonic()
                rec.changed_at = rec.ended_at
                self._cond.notify_all()

    def _persistable_snapshot(self, rec: TaskRecord) -> dict[str, Any]:
        return {
            "id": rec.id,
            "session_id": rec.session_id,
            "provider": rec.provider,
            "project_dir": rec.project_dir,
            "project_name": rec.project_name,
            "prompt_preview": rec.prompt_preview,
            "mode": rec.mode,
            "model": rec.model,
            "effort": rec.effort,
            "status": rec.status,
            "phase": rec.phase,
            "last_activity": rec.last_activity,
            "created_at": rec.created_at,
            "finished_at": rec.finished_at,
            "elapsed_ms": rec.elapsed_ms(),
            "events_count": rec.events_count,
            "answer": rec.answer,
            "error": rec.error,
            "usage": rec.usage,
            "activities": rec.activities[-15:],
        }

    def _format_task_for_caller(
        self,
        rec: TaskRecord,
        include_next_check: bool = True,
        offset: int = 0,
        limit: int = MAX_OUTPUT_RETURN_CHARS,
    ) -> dict[str, Any]:
        out: dict[str, Any] = {
            "task_id": rec.id,
            "session_id": rec.session_id,
            "provider": rec.provider,
            "mode": rec.mode,
            "model": rec.model,
            "effort": rec.effort,
            "status": rec.status,
            "phase": rec.phase,
            "last_activity": rec.last_activity,
            "events_count": rec.events_count,
            "elapsed_ms": rec.elapsed_ms(),
            "created_at": rec.created_at,
            "finished_at": rec.finished_at,
        }
        if rec.status in ("queued", "running", "cancelling"):
            if rec.partial_text:
                out["partial_preview"] = rec.partial_text[-2000:]
            if include_next_check:
                after_minutes = 1 if rec.elapsed_ms() < 120_000 else 2
                out["nextCheck"] = {
                    "afterMinutes": after_minutes,
                    "recurring": False,
                    "prompt": (
                        f'Call ai_task_status with task_id "{rec.id}" and wait_seconds 15. '
                        "If still running, schedule one follow-up check using nextCheck. "
                        "Otherwise report the completed result and stop."
                    ),
                }
        elif rec.status == "completed":
            full = rec.answer or ""
            total_len = len(full)
            safe_offset = max(0, min(offset, total_len))
            safe_limit = max(256, min(limit, MAX_OUTPUT_RETURN_CHARS))
            chunk = full[safe_offset : safe_offset + safe_limit]
            out["answer"] = chunk
            out["answer_total_chars"] = total_len
            out["answer_offset"] = safe_offset
            out["answer_truncated"] = (safe_offset + len(chunk)) < total_len
            if rec.usage:
                out["usage"] = rec.usage
        else:
            out["error"] = rec.error or "Task did not complete."
            if rec.answer:
                out["partial_answer"] = rec.answer[:4000]
        return out

    def get_task_status(
        self,
        task_id: str,
        wait_seconds: int = 0,
        offset: int = 0,
        limit: int = MAX_OUTPUT_RETURN_CHARS,
    ) -> dict[str, Any]:
        tid = validate_identifier(task_id, "task_id")
        wait_sec = max(0, min(int(wait_seconds or 0), MAX_WAIT_SECONDS))
        with self._cond:
            rec = self._tasks.get(tid)
            if not rec or (self.project_dir and rec.project_dir != self.project_dir):
                raise ValueError(f"Unknown task_id '{tid}' in the active project.")
            if wait_sec > 0 and rec.ended_at is None and not self._closed:
                initial_change = rec.changed_at
                deadline = time.monotonic() + wait_sec
                while rec.ended_at is None and not self._closed:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    self._cond.wait(timeout=min(0.5, remaining))
                    if rec.ended_at is not None or self._closed:
                        break
                    if rec.changed_at > initial_change and (time.monotonic() - initial_change) >= 2.0:
                        break
            return self._format_task_for_caller(
                rec,
                include_next_check=True,
                offset=offset,
                limit=limit,
            )

    def cancel_task(self, task_id: str) -> dict[str, Any]:
        tid = validate_identifier(task_id, "task_id")
        handle: TaskHandle | None = None
        with self._cond:
            rec = self._tasks.get(tid)
            if not rec or (self.project_dir and rec.project_dir != self.project_dir):
                raise ValueError(f"Unknown task_id '{tid}' in the active project.")
            if rec.ended_at is not None:
                return self._format_task_for_caller(rec, include_next_check=False)
            rec.status = "cancelling"
            rec.phase = "cancelling"
            rec.last_activity = "cancelling"
            rec.changed_at = time.monotonic()
            handle = rec.handle
            self._cond.notify_all()
        if handle:
            handle.cancel()
        with self._cond:
            return self._format_task_for_caller(rec, include_next_check=False)

    # ---- History & Dashboard ----
    def get_session_history(
        self,
        session_id: str | None = None,
        provider: str | None = None,
        limit: int = 20,
    ) -> dict[str, Any]:
        if session_id:
            sid = validate_identifier(session_id, "session_id")
            sess = self.store.get_session(sid)
            if not sess or (self.project_dir and sess.get("project_dir") != self.project_dir):
                raise ValueError(f"Unknown session_id '{sid}' in the active project.")
            turns = list(sess.get("turns") or [])
            safe_limit = max(1, min(int(limit or 20), 60))
            return {
                "session": {
                    "id": sess["id"],
                    "provider": sess.get("provider"),
                    "title": sess.get("title"),
                    "project_name": sess.get("project_name"),
                    "model": sess.get("model"),
                    "effort": sess.get("effort"),
                    "mode": sess.get("mode"),
                    "created_at": sess.get("created_at"),
                    "updated_at": sess.get("updated_at"),
                    "turn_count": len(turns),
                },
                "turns": turns[-safe_limit:],
            }
        sessions = self.store.list_sessions(
            provider=provider.strip().lower() if provider else None,
            limit=limit,
        )
        summaries = [
            {
                "id": s["id"],
                "provider": s.get("provider"),
                "title": s.get("title"),
                "project_name": s.get("project_name"),
                "model": s.get("model"),
                "effort": s.get("effort"),
                "mode": s.get("mode"),
                "turn_count": len(s.get("turns") or []),
                "updated_at": s.get("updated_at"),
            }
            for s in sessions
        ]
        return {"project_name": self.project_name, "sessions": summaries}

    def dashboard_state(self, refresh: bool = False) -> dict[str, Any]:
        """Fast composite snapshot for the sidebar dashboard UI (credentials masked)."""
        policy, providers = self._collect_providers(include_host_paths=True, refresh=refresh)
        safe_policy = dict(policy)
        safe_policy["proxy"] = mask_proxy_config(policy.get("proxy"))

        with self._lock:
            tasks_list = sorted(
                (t for t in self._tasks.values() if not self.project_dir or t.project_dir == self.project_dir),
                key=lambda t: (t.ended_at is not None, -t.started_at),
            )[:50]
            serialized_tasks = [
                {
                    "id": t.id,
                    "session_id": t.session_id,
                    "provider": t.provider,
                    "project_name": t.project_name,
                    "prompt_preview": t.prompt_preview,
                    "mode": t.mode,
                    "model": t.model,
                    "effort": t.effort,
                    "status": t.status,
                    "phase": t.phase,
                    "last_activity": t.last_activity,
                    "events_count": t.events_count,
                    "elapsed_ms": t.elapsed_ms(),
                    "created_at": t.created_at,
                    "finished_at": t.finished_at,
                    "partial_text": t.partial_text if t.ended_at is None else "",
                    "answer": t.answer,
                    "error": t.error,
                    "usage": t.usage,
                    "activities": t.activities[-12:],
                }
                for t in tasks_list
            ]
            active_count = sum(1 for t in self._tasks.values() if t.ended_at is None)

        sessions = self.store.list_sessions(limit=40)
        return {
            "project_name": self.project_name,
            "active_count": active_count,
            "policy": safe_policy,
            "providers": providers,
            "tasks": serialized_tasks,
            "sessions": [
                {
                    "id": s["id"],
                    "provider": s.get("provider"),
                    "title": s.get("title"),
                    "model": s.get("model"),
                    "effort": s.get("effort"),
                    "mode": s.get("mode"),
                    "updated_at": s.get("updated_at"),
                    "turn_count": len(s.get("turns") or []),
                }
                for s in sessions
            ],
        }

    def manage_policy(self, action: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        payload = payload or {}
        if action == "update_policy":
            policy = self.store.update_policy(payload)
            with self._lock:
                self._model_cache.clear()
                self._probe_cache.clear()
            safe_policy = dict(policy)
            safe_policy["proxy"] = mask_proxy_config(policy.get("proxy"))
            return {"ok": True, "policy": safe_policy}
        if action == "delete_session":
            sid = validate_identifier(str(payload.get("session_id") or ""), "session_id")
            sess = self.store.get_session(sid)
            if not sess or (self.project_dir and sess.get("project_dir") != self.project_dir):
                return {"ok": False, "session_id": sid}
            deleted = self.store.delete_session(sid)
            return {"ok": deleted, "session_id": sid}
        if action == "clear_finished_tasks":
            with self._lock:
                for tid in list(self._tasks):
                    rec = self._tasks[tid]
                    if rec.ended_at is not None and (not self.project_dir or rec.project_dir == self.project_dir):
                        del self._tasks[tid]
            cleared = self.store.clear_finished_tasks()
            return {"ok": True, "cleared": cleared}
        raise ValueError(f"Unknown management action '{action}'.")

    def shutdown(self, wait_workers: bool = True) -> None:
        handles: list[TaskHandle] = []
        with self._cond:
            self._closed = True
            for rec in self._tasks.values():
                if rec.ended_at is None and rec.handle is not None:
                    handles.append(rec.handle)
            self._cond.notify_all()
        for h in handles:
            h.cancel()
        self._executor.shutdown(wait=wait_workers, cancel_futures=True)
