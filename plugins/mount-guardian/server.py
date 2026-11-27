#!/usr/bin/env python3
"""Mount Guardian: keeps shared project folders usable when mappings drop.

Watches shared project folders, mirrors their git metadata into a local
directory while a mapping is live, and restores it from the mirror when the
mapping drops, so tools that resolve the folder's git metadata keep working.
Standard library only; stdio JSON-RPC 2.0.
"""

from __future__ import annotations

import getpass
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

VERSION = "0.2.0"
LIVE_FSTYPES = {"fuse.sshfs", "sshfs", "fuse", "9p", "virtiofs", "fuse.9p"}
LIVE_SOURCE_HINTS = ("sshfs", "9p", "virtiofs")
STATE_LOCK = threading.Lock()
STOP = threading.Event()

TOOLS = [
    {
        "name": "mount_health",
        "description": "Report whether each watched project folder is currently mapped live, whether its git metadata resolves, and whether the workspace catalog sees the workspaces. Call this first before work that depends on a shared project folder, or when a workspace listing unexpectedly comes back empty.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "mount_mirror_sync",
        "description": "Copy the git metadata of each live-mapped project folder into the local mirror directory. Safe to run repeatedly; skips projects whose mapping is not live. Call after a mapping comes back to refresh the mirror.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "Optional project name to sync; omit to sync all live projects."}
            },
        },
    },
    {
        "name": "mount_heal",
        "description": "Restore a project folder's git metadata from the local mirror when the shared mapping is offline and git no longer resolves. Never writes while the mapping is live. Call when mount_health reports broken, and continue only after healed is true.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "Optional project name to heal; omit to heal all broken projects."}
            },
        },
    },
]


def log(msg: str) -> None:
    sys.stderr.write(f"[mount-guardian] {msg}\n")
    sys.stderr.flush()


def env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if raw in ("true", "1", "yes", "on"):
        return True
    if raw in ("false", "0", "no", "off"):
        return False
    return default


def data_dir() -> Path:
    return Path(os.environ.get("MG_DATA_DIR", "~/.local/share/mount-guardian")).expanduser()


def load_config() -> dict:
    cfg = {
        "projects": [],
        "extra_projects": [],
        "mirror_dir": data_dir() / "mirrors",
        "state_file": data_dir() / "status.json",
        "orca_ide": os.environ.get("MG_ORCA_IDE", "~/.local/bin/orca-ide"),
        "auto_mirror": env_bool("MG_AUTO_MIRROR", True),
        "auto_heal": env_bool("MG_AUTO_HEAL", True),
        "use_sudo": env_bool("MG_USE_SUDO", True),
        "watch_interval_sec": 300,
    }
    raw_interval = os.environ.get("MG_WATCH_INTERVAL", "").strip()
    if raw_interval.isdigit():
        cfg["watch_interval_sec"] = int(raw_interval)
    raw_extra = os.environ.get("MG_EXTRA_PROJECTS", "").strip()
    if raw_extra:
        try:
            extra = json.loads(raw_extra)
            if isinstance(extra, list):
                cfg["extra_projects"] = [p for p in extra if isinstance(p, dict) and p.get("name") and p.get("path")]
        except json.JSONDecodeError:
            log("MG_EXTRA_PROJECTS is not valid JSON; ignored")
    cfg_path = Path(__file__).resolve().parent / "config.json"
    if cfg_path.is_file():
        try:
            local = json.loads(cfg_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            local = {}
            log("config.json is not valid JSON; ignored")
        if isinstance(local.get("projects"), list):
            cfg["projects"] = [p for p in local["projects"] if isinstance(p, dict) and p.get("name") and p.get("path")]
        for key in ("auto_mirror", "auto_heal", "use_sudo"):
            if isinstance(local.get(key), bool):
                cfg[key] = local[key]
        if isinstance(local.get("watch_interval_sec"), int):
            cfg["watch_interval_sec"] = local["watch_interval_sec"]
        for key in ("mirror_dir", "state_file", "orca_ide"):
            if isinstance(local.get(key), str) and local[key]:
                cfg[key] = local[key]
    cfg["orca_ide"] = str(Path(cfg["orca_ide"]).expanduser())
    cfg["mirror_dir"] = Path(cfg["mirror_dir"]).expanduser()
    cfg["state_file"] = Path(cfg["state_file"]).expanduser()
    return cfg


def run(cmd: list[str], timeout: int = 30) -> tuple[int, str, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"
    except FileNotFoundError as exc:
        return 127, "", str(exc)


def unescape_mount(field: str) -> str:
    return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), field)


def mount_table() -> list[tuple[str, str, str]]:
    table = []
    try:
        with open("/proc/self/mounts", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                parts = line.split()
                if len(parts) >= 3:
                    table.append((unescape_mount(parts[1]), parts[2], unescape_mount(parts[0])))
    except OSError:
        pass
    return table


def covering_mount(path: str, table: list[tuple[str, str, str]]) -> tuple[str, str, str] | None:
    best = None
    for target, fstype, source in table:
        if path == target or path.startswith(target.rstrip("/") + "/"):
            if best is None or len(target) > len(best[0]):
                best = (target, fstype, source)
    return best


def mount_is_live_entry(fstype: str, source: str) -> bool:
    return fstype in LIVE_FSTYPES or any(h in source for h in LIVE_SOURCE_HINTS)


def is_live_mount(path: str, table: list[tuple[str, str, str]]) -> tuple[bool, str]:
    cover = covering_mount(path, table)
    if cover is None:
        return False, "no covering mount"
    target, fstype, source = cover
    if mount_is_live_entry(fstype, source):
        return True, f"{fstype} on {target}"
    return False, f"local {fstype} on {target}"


def git_ok(path: str) -> tuple[bool, str]:
    rc, out, err = run(["git", "-C", path, "rev-parse", "--is-inside-work-tree"], timeout=20)
    if rc == 0 and out.strip() == "true":
        return True, "ok"
    return False, (err.strip() or out.strip() or f"rc={rc}")[:200]


def safe_name(name: str) -> str:
    # Keep CJK and other word characters; only replace path-hostile ones.
    return re.sub(r'[\\/:*?"<>\x00-\x1f]+', "_", name)


def discover_projects(cfg: dict, table) -> list[dict]:
    """Live shared mounts that hold a git repository, at the mountpoint or one
    level below it, plus projects remembered from earlier runs."""
    found: dict[str, dict] = {}

    def consider(path: Path) -> None:
        try:
            if (path / ".git").exists():
                found.setdefault(str(path), {"name": path.name, "path": str(path)})
        except OSError:
            pass

    for target, fstype, source in table:
        if not mount_is_live_entry(fstype, source):
            continue
        root = Path(target)
        consider(root)
        try:
            children = sorted(root.iterdir())[:50]
        except OSError:
            continue
        for child in children:
            if child.is_dir():
                consider(child)

    for proj in cfg["projects"] + cfg["extra_projects"]:
        found.setdefault(proj["path"], {"name": proj["name"], "path": proj["path"]})

    state_file = cfg["state_file"]
    if state_file.is_file():
        try:
            saved = json.loads(state_file.read_text(encoding="utf-8"))
            for proj in saved.get("known_projects", []):
                if isinstance(proj, dict) and proj.get("name") and proj.get("path"):
                    found.setdefault(proj["path"], {"name": proj["name"], "path": proj["path"]})
        except json.JSONDecodeError:
            pass
    return sorted(found.values(), key=lambda p: p["name"])


def mirror_path(cfg: dict, proj: dict) -> Path:
    return cfg["mirror_dir"] / f"{safe_name(proj['name'])}.git"


def mirror_meta_path(cfg: dict, proj: dict) -> Path:
    return cfg["mirror_dir"] / f"{safe_name(proj['name'])}.meta.json"


def current_head(path: str) -> str:
    rc, out, _ = run(["git", "-C", path, "rev-parse", "HEAD"], timeout=15)
    return out.strip() if rc == 0 else ""


def needs_root(target: Path) -> bool:
    probe = target if target.exists() else target.parent
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    return not os.access(probe, os.W_OK)


def sudo_prefix(cfg: dict, target: Path) -> list[str]:
    if cfg.get("use_sudo") and os.geteuid() != 0 and needs_root(target):
        return ["sudo", "-n"]
    return []


def mirror_sync_project(cfg: dict, proj: dict, table) -> dict:
    name, path = proj["name"], proj["path"]
    live, why = is_live_mount(path, table)
    if not live:
        return {"project": name, "synced": False, "reason": f"mapping not live ({why})"}
    ok, why = git_ok(path)
    if not ok:
        return {"project": name, "synced": False, "reason": f"git not resolving ({why})"}
    src = Path(path) / ".git"
    dst = mirror_path(cfg, proj)
    dst.parent.mkdir(parents=True, exist_ok=True)
    if shutil.which("rsync"):
        rc, _, err = run(["rsync", "-a", "--delete", str(src) + "/", str(dst) + "/"], timeout=600)
        if rc != 0:
            return {"project": name, "synced": False, "reason": f"rsync rc={rc}: {err.strip()[:200]}"}
    else:
        tmp = dst.with_suffix(".tmp")
        if tmp.exists():
            shutil.rmtree(tmp)
        shutil.copytree(src, tmp, symlinks=True)
        if dst.exists():
            shutil.rmtree(dst)
        tmp.rename(dst)
    meta = {"synced_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "head": current_head(path), "source": path}
    mirror_meta_path(cfg, proj).write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    return {"project": name, "synced": True, "head": meta["head"]}


def heal_project(cfg: dict, proj: dict, table) -> dict:
    name, path = proj["name"], proj["path"]
    live, why = is_live_mount(path, table)
    if live:
        return {"project": name, "healed": False, "reason": f"mapping is live ({why}); nothing to heal"}
    ok, _ = git_ok(path)
    if ok:
        return {"project": name, "healed": False, "reason": "git already resolves; nothing to heal"}
    src = mirror_path(cfg, proj)
    if not src.is_dir():
        return {"project": name, "healed": False, "reason": "no local mirror available"}
    dst = Path(path) / ".git"
    pre = sudo_prefix(cfg, dst)
    actions = []
    if dst.exists():
        rc, _, err = run(pre + ["rm", "-rf", str(dst)], timeout=120)
        if rc != 0:
            return {"project": name, "healed": False, "reason": f"remove stale .git failed: {err.strip()[:200]}"}
        actions.append("removed stale .git")
    rc, _, err = run(pre + ["cp", "-a", str(src), str(dst)], timeout=600)
    if rc != 0:
        return {"project": name, "healed": False, "reason": f"restore failed: {err.strip()[:200]}"}
    actions.append("restored .git from mirror")
    user = getpass.getuser()
    run(pre + ["chown", "-R", f"{user}:{user}", str(dst)], timeout=300)
    ok, why = git_ok(path)
    return {"project": name, "healed": ok, "actions": actions, "git": why}


def catalog_status(cfg: dict) -> dict:
    ide = cfg["orca_ide"]
    if not Path(ide).exists():
        return {"ok": False, "error": "workspace catalog tool not available"}
    rc, out, err = run([ide, "worktree", "ps", "--json"], timeout=30)
    if rc != 0:
        return {"ok": False, "error": (err.strip() or f"rc={rc}")[:200]}
    try:
        result = json.loads(out).get("result", {})
        worktrees = result.get("totalCount", len(result.get("worktrees", [])))
    except json.JSONDecodeError:
        return {"ok": False, "error": "unparseable catalog output"}
    rc2, out2, _ = run([ide, "agent", "list", "--json"], timeout=30)
    agents = None
    if rc2 == 0:
        try:
            agents = len(json.loads(out2).get("result", {}).get("agents", []))
        except json.JSONDecodeError:
            agents = None
    return {"ok": True, "worktrees": worktrees, "agents": agents}


def collect_status(cfg: dict) -> dict:
    table = mount_table()
    projects = discover_projects(cfg, table)
    rows = []
    worst = "ok"
    for proj in projects:
        name, path = proj["name"], proj["path"]
        exists = Path(path).is_dir()
        live, why = is_live_mount(path, table) if exists else (False, "path missing")
        git, git_why = (git_ok(path) if exists else (False, "path missing"))
        meta = None
        meta_file = mirror_meta_path(cfg, proj)
        if meta_file.is_file():
            try:
                meta = json.loads(meta_file.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                meta = None
        state = "ok" if (live and git) else ("degraded" if git else "broken")
        if state == "broken":
            worst = "broken"
        elif state == "degraded" and worst == "ok":
            worst = "degraded"
        rows.append({
            "name": name, "path": path, "exists": exists,
            "live_mount": live, "mount_detail": why,
            "git_ok": git, "git_detail": git_why,
            "state": state, "mirror": meta,
        })
    return {
        "overall": worst,
        "checked_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "projects": rows,
        "known_projects": projects,
        "catalog": catalog_status(cfg),
        "config": {"auto_mirror": cfg["auto_mirror"], "auto_heal": cfg["auto_heal"]},
    }


def write_state(cfg: dict, status: dict) -> None:
    with STATE_LOCK:
        cfg["state_file"].parent.mkdir(parents=True, exist_ok=True)
        tmp = cfg["state_file"].with_suffix(".tmp")
        tmp.write_text(json.dumps(status, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(cfg["state_file"])


def pick_projects(cfg: dict, args: dict, table) -> list[dict]:
    wanted = (args or {}).get("project")
    projects = discover_projects(cfg, table)
    if not wanted:
        return projects
    matched = [p for p in projects if p["name"] == wanted]
    if not matched:
        raise ValueError(f"unknown project: {wanted}")
    return matched


def watcher(cfg: dict) -> None:
    while not STOP.is_set():
        try:
            table = mount_table()
            for proj in discover_projects(cfg, table):
                live, _ = is_live_mount(proj["path"], table)
                if live and cfg["auto_mirror"]:
                    res = mirror_sync_project(cfg, proj, table)
                    if res.get("synced"):
                        log(f"mirrored {proj['name']} @ {res.get('head', '')[:8]}")
                elif not live and cfg["auto_heal"]:
                    ok, _ = git_ok(proj["path"]) if Path(proj["path"]).is_dir() else (False, "missing")
                    if not ok:
                        res = heal_project(cfg, proj, table)
                        log(f"heal {proj['name']}: {json.dumps(res, ensure_ascii=False)}")
            write_state(cfg, collect_status(cfg))
        except Exception as exc:  # never let the watcher die
            log(f"watcher error: {exc}")
        STOP.wait(max(30, int(cfg.get("watch_interval_sec", 300))))


def handle_tool(cfg: dict, name: str, args: dict) -> dict:
    table = mount_table()
    if name == "mount_health":
        status = collect_status(cfg)
        write_state(cfg, status)
        return ok_json(status)
    if name == "mount_mirror_sync":
        results = [mirror_sync_project(cfg, p, table) for p in pick_projects(cfg, args, table)]
        write_state(cfg, collect_status(cfg))
        return ok_json({"results": results})
    if name == "mount_heal":
        results = [heal_project(cfg, p, table) for p in pick_projects(cfg, args, table)]
        status = collect_status(cfg)
        write_state(cfg, status)
        return ok_json({"results": results, "catalog": status["catalog"], "overall": status["overall"]})
    return err_result(f"unknown tool: {name}")


def ok_json(payload) -> dict:
    return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False, indent=1)}]}


def err_result(message: str) -> dict:
    return {"isError": True, "content": [{"type": "text", "text": message}]}


def answer(cfg: dict, message: dict) -> dict | None:
    method = message.get("method")
    params = message.get("params") or {}
    if method == "initialize":
        return {
            "protocolVersion": params.get("protocolVersion", "2024-11-05"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "mount-guardian", "version": VERSION},
        }
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        try:
            return handle_tool(cfg, params.get("name", ""), params.get("arguments") or {})
        except ValueError as exc:
            return err_result(str(exc))
        except Exception as exc:
            return err_result(f"{type(exc).__name__}: {exc}")
    if method == "ping":
        return {}
    return None


def main() -> None:
    cfg = load_config()
    threading.Thread(target=watcher, args=(cfg,), daemon=True).start()
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "id" not in request:
            continue
        result = answer(cfg, request)
        reply = {"jsonrpc": "2.0", "id": request["id"]}
        if result is None:
            reply["error"] = {"code": -32601, "message": "method not found"}
        else:
            reply["result"] = result
        sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    STOP.set()


if __name__ == "__main__":
    main()
