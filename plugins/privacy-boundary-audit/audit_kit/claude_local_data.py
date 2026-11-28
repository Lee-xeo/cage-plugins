"""Strictly read-only metadata inventory of selected local Claude Code work files."""

from dataclasses import dataclass
import os
from pathlib import Path
import stat
import sys
from typing import Optional

from config_snapshot import (
    SnapshotError,
    check_ancestors,
    checked_stat,
    local_path,
    paths_overlap,
)


CONFIG_NAMES = {
    "projects": "sessions_and_project_data",
    "history.jsonl": "history",
    "CLAUDE.md": "instructions",
    "CLAUDE.local.md": "instructions",
    "skills": "skills",
    "hooks": "hooks",
    "commands": "commands",
    "agents": "agents",
    "agent-memory": "memory",
    "rules": "rules",
    "settings.json": "settings",
    "settings.local.json": "settings",
    ".mcp.json": "mcp",
}
PROJECT_NAMES = {
    "CLAUDE.md": "instructions",
    "CLAUDE.local.md": "instructions",
    ".mcp.json": "mcp",
}
DEDICATED_NAMES = {
    ".claude.json", ".claude.json.backup", ".credentials.json", "credentials.json",
    "oauth_tokens.json", ".git", "keyring", "keychains",
    ".npmrc", ".netrc", ".pypirc", "id_rsa", "id_ed25519", "id_ecdsa",
    "secrets.json", "token.json", "auth.json",
}
SENSITIVE_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".jks", ".kdbx")


@dataclass(frozen=True)
class WorkFile:
    source: Path
    relative: Path
    category: str
    identity: tuple
    posix_mode: Optional[int]


def _configured_env_dir():
    value = os.environ.get("CLAUDE_CONFIG_DIR")
    return value if value and value.strip() else None


def selected_config(value=None):
    return local_path(value or _configured_env_dir() or Path.home() / ".claude")


def identity_of(info):
    return (stat.S_IFMT(info.st_mode), info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def is_sensitive_name(name):
    folded = name.casefold()
    return (
        folded in DEDICATED_NAMES
        or folded == ".env"
        or folded.startswith(".env.")
        or folded.endswith(SENSITIVE_SUFFIXES)
    )


def scan_work(config, project=None):
    files = []
    directories = []
    skipped = {"unsafe_or_unavailable": 0, "excluded_secret_entries": 0}
    roots = {"user_config_present": False, "project_selected": project is not None}

    def visit(source, relative, category):
        if is_sensitive_name(source.name):
            skipped["excluded_secret_entries"] += 1
            return
        try:
            info = checked_stat(source)
            if stat.S_ISDIR(info.st_mode):
                directories.append(relative)
                for entry in sorted(source.iterdir(), key=lambda item: item.name):
                    visit(entry, relative / entry.name, category)
            elif stat.S_ISREG(info.st_mode):
                mode = (info.st_mode & 0o755) if os.name == "posix" else None
                files.append(WorkFile(source, relative, category, identity_of(info), mode))
            else:
                skipped["unsafe_or_unavailable"] += 1
        except (OSError, SnapshotError):
            skipped["unsafe_or_unavailable"] += 1

    def selected_names(directory, prefix, names):
        case_insensitive = os.name == "nt" or sys.platform == "darwin"
        if case_insensitive:
            names = {name.casefold(): category for name, category in names.items()}
        try:
            check_ancestors(directory)
            for entry in sorted(directory.iterdir(), key=lambda item: item.name.casefold()):
                if is_sensitive_name(entry.name):
                    skipped["excluded_secret_entries"] += 1
                    continue
                match_name = entry.name.casefold() if case_insensitive else entry.name
                if match_name in names:
                    visit(entry, prefix / entry.name, names[match_name])
            return True
        except FileNotFoundError:
            return False
        except (OSError, SnapshotError):
            skipped["unsafe_or_unavailable"] += 1
            return False

    roots["user_config_present"] = selected_names(config, Path("user-config"), CONFIG_NAMES)
    if project is not None:
        active_project_config = project / ".claude"
        if paths_overlap(config, project) or paths_overlap(config, active_project_config):
            raise SnapshotError("Select non-overlapping user and project scopes.")
        roots["project_present"] = selected_names(project, Path("project"), PROJECT_NAMES)
        roots["project_config_present"] = selected_names(
            active_project_config, Path("project") / ".claude", CONFIG_NAMES,
        )
    return files, directories, skipped, roots


def audit(config, project=None):
    config = local_path(config)
    project = local_path(project) if project is not None else None
    files, directories, skipped, roots = scan_work(config, project)
    categories = {}
    for entry in files:
        count = categories.setdefault(entry.category, {"files": 0, "bytes": 0})
        count["files"] += 1
        count["bytes"] += entry.identity[3]
    return {
        **roots,
        **skipped,
        "files": len(files),
        "directories": len(directories),
        "bytes": sum(entry.identity[3] for entry in files),
        "categories": categories,
        "mixed_account_state_backed_up": False,
        "contents_read": False,
    }


def audit_default(config_dir=None, project_dir=None):
    config = selected_config(config_dir)
    project = local_path(project_dir) if project_dir is not None else None
    return audit(config, project)
