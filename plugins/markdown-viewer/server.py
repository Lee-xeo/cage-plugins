"""Stdio JSON-RPC 2.0 MCP server for discovering, searching, reading, and saving Markdown files."""

import base64
import hashlib
import json
import os
import pathlib
import re
import sys
import tempfile

from index_engine import (
    ProjectIndex,
    build_project_graph,
    format_task_metadata,
    inspect_links,
    parse_task_metadata,
    search_entries,
    summarize_tags,
    summarize_tasks,
)
from office_reader import OFFICE_EXTENSIONS, doc_type_for_path, read_office_file

SERVER_NAME = "markdown-viewer"
SERVER_VERSION = "1.10.0"
_INDEX = ProjectIndex()
SCOPE_PROP = {
    "type": "string",
    "enum": ["project", "all"],
    "description": "Scope of operation: 'project' (current workspace, default) or 'all' (all mounted sibling workspaces).",
}
TASK_TOGGLE_RE = re.compile(r"^(\s*(?:[-*+]|\d{1,9}[.)])\s+\[)([ xX])(\]\s*.*)$")
MARKDOWN_EXTENSIONS = {".md", ".markdown", ".mdx"}
ASSET_MIME_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".svg": "image/svg+xml",
}
SKIP_DIRS = {"node_modules", "_output", "__pycache__", "dist", "build", "target"}
MAX_FILES = 500
MAX_READ_BYTES = 512 * 1024
MAX_ASSET_BYTES = 4 * 1024 * 1024
MAX_PATH_ARG_BYTES = 1024
MAX_SEARCH_MATCHES = 200
WIKILINK_RE = re.compile(r"\[\[([^\[\]]+)\]\]")
MD_LINK_RE = re.compile(r"\[[^\]]*\]\(([^)\s]+)(?:\s+[\"'][^\"']*[\"'])?\)")

TOOLS = [
    {
        "name": "list_markdown_files",
        "title": "List Markdown Files",
        "description": (
            "Recursively list Markdown files (.md, .markdown, .mdx) under the project root, "
            "returning relative POSIX paths, byte sizes, and modification times."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "scope": SCOPE_PROP,
                "includeDocs": {
                    "type": "boolean",
                    "description": "Also include Excel, Word, PowerPoint, and PDF documents alongside Markdown files.",
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "read_markdown_file",
        "title": "Read Markdown File",
        "description": (
            "Read a UTF-8 Markdown file inside the project root by its relative POSIX path. "
            "Files larger than 512 KiB are safely truncated at a UTF-8 boundary and marked readOnly."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Relative POSIX path to a Markdown file inside the project root.",
                },
                "scope": SCOPE_PROP,
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "search_markdown_files",
        "title": "Search Markdown Files",
        "description": (
            "Search Markdown files under the project root with multi-term AND, quoted phrases, "
            "exclusions (-word), inline path:/tag:/heading: operators, case sensitivity, whole word, "
            "and regex support, returning ranked grouped files and centered highlighted snippets."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query (supports multi-word, quotes, -exclude, path:, tag:, heading:, or regex).",
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of matches to return (1-200, default 80).",
                },
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional list of tags (AND filter) to narrow the search.",
                },
                "caseSensitive": {
                    "type": "boolean",
                    "description": "Match case sensitively (default false).",
                },
                "wholeWord": {
                    "type": "boolean",
                    "description": "Match whole words only (default false).",
                },
                "regex": {
                    "type": "boolean",
                    "description": "Interpret query as a regular expression (default false).",
                },
                "pathPrefix": {
                    "type": "string",
                    "description": "Optional relative directory/path prefix to restrict search scope.",
                },
                "sortBy": {
                    "type": "string",
                    "enum": ["relevance", "matches", "path", "mtime"],
                    "description": "Result ordering mode (default relevance).",
                },
                "includeContext": {
                    "type": "boolean",
                    "description": "Include previous and next line context around each hit.",
                },
                "scope": SCOPE_PROP,
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_backlinks",
        "title": "Get Backlinks",
        "description": (
            "Find Markdown files in the project that link to the specified Markdown file "
            "via [[wikilinks]] or relative Markdown links."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Relative POSIX path of the target Markdown file.",
                },
                "scope": SCOPE_PROP,
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "save_markdown_file",
        "title": "Save Markdown File",
        "description": (
            "Atomically write UTF-8 Markdown content to a relative .md/.markdown/.mdx file path "
            "inside the project root (max 512 KiB), with optional ETag conflict detection."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Relative POSIX path to a Markdown file inside the project root.",
                },
                "content": {
                    "type": "string",
                    "description": "UTF-8 Markdown text content to save.",
                },
                "expectedEtag": {
                    "type": "string",
                    "description": "Optional ETag from read_markdown_file for optimistic conflict detection.",
                },
                "force": {
                    "type": "boolean",
                    "description": "Whether to overwrite even if the file changed on disk.",
                },
                "createDirs": {
                    "type": "boolean",
                    "description": "Whether to create missing parent directories inside the project root.",
                },
                "scope": SCOPE_PROP,
            },
            "required": ["path", "content"],
            "additionalProperties": False,
        },
    },
    {
        "name": "read_markdown_asset",
        "title": "Read Markdown Image Asset",
        "description": (
            "Read a relative image asset referenced by a Markdown document inside the project root "
            "(PNG, JPEG, GIF, WebP, AVIF, SVG up to 4 MiB) and return base64-encoded data."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "docPath": {
                    "type": "string",
                    "description": "Relative POSIX path of the Markdown document referencing the asset.",
                },
                "assetHref": {
                    "type": "string",
                    "description": "Relative POSIX image path resolved from the document directory.",
                },
                "scope": SCOPE_PROP,
            },
            "required": ["docPath", "assetHref"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_project_tags",
        "title": "List Project Tags",
        "description": "Aggregate Frontmatter and inline tags across Markdown files in the project.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "scope": SCOPE_PROP,
                "includeDocs": {
                    "type": "boolean",
                    "description": "Also include Excel, Word, PowerPoint, and PDF documents alongside Markdown files.",
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "list_project_tasks",
        "title": "List Project Tasks",
        "description": "List Markdown task checkboxes across the project, optionally filtered by status or path prefix.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "status": {
                    "type": "string",
                    "enum": ["all", "open", "done"],
                    "description": "Filter tasks by completion status.",
                },
                "pathPrefix": {
                    "type": "string",
                    "description": "Optional relative path prefix to filter tasks.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of tasks to return (default 500).",
                },
                "scope": SCOPE_PROP,
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "toggle_markdown_task",
        "title": "Toggle Markdown Task",
        "description": "Safely toggle a single task checkbox line in a Markdown file with ETag conflict protection.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative POSIX path to the Markdown file."},
                "line": {"type": "integer", "description": "1-based line number of the task item."},
                "checked": {"type": "boolean", "description": "Target checked state."},
                "expectedEtag": {"type": "string", "description": "Expected file ETag for conflict detection."},
                "scope": SCOPE_PROP,
            },
            "required": ["path", "line", "checked", "expectedEtag"],
            "additionalProperties": False,
        },
    },
    {
        "name": "inspect_project_links",
        "title": "Inspect Project Links",
        "description": "Scan Markdown files for broken links and ambiguous wikilink targets.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "scope": SCOPE_PROP,
                "includeDocs": {
                    "type": "boolean",
                    "description": "Also include Excel, Word, PowerPoint, and PDF documents alongside Markdown files.",
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "update_markdown_task_meta",
        "title": "Update Markdown Task Metadata",
        "description": (
            "Update workflow status, priority, due date, assignee, group, and color metadata on a single "
            "Markdown task line with ETag conflict protection."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative POSIX path to the Markdown file."},
                "line": {"type": "integer", "description": "1-based line number of the task item."},
                "expectedEtag": {"type": "string", "description": "Expected file ETag for conflict detection."},
                "status": {
                    "type": "string",
                    "enum": ["", "todo", "doing", "review", "done"],
                    "description": "Optional workflow status (updates checkbox state automatically).",
                },
                "checked": {"type": "boolean", "description": "Optional explicit checkbox state."},
                "priority": {"type": "string", "enum": ["", "high", "medium", "low"], "description": "Task priority level."},
                "due": {"type": "string", "description": "Optional YYYY-MM-DD due date or empty string."},
                "assignee": {"type": "string", "description": "Optional assignee handle without @ or empty string."},
                "group": {"type": "string", "description": "Optional custom group name or empty string."},
                "color": {
                    "type": "string",
                    "enum": ["", "red", "orange", "amber", "green", "blue", "purple", "pink"],
                    "description": "Optional color tag.",
                },
                "cleanText": {
                    "type": "string",
                    "description": "Optional replacement task title text.",
                },
                "scope": SCOPE_PROP,
            },
            "required": ["path", "line", "expectedEtag"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_project_graph",
        "title": "Get Project Link Graph",
        "description": "Build a node-and-edge graph of Markdown files linked by wikilinks and relative Markdown links.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "scope": SCOPE_PROP,
                "includeDocs": {
                    "type": "boolean",
                    "description": "Also include Excel, Word, PowerPoint, and PDF documents alongside Markdown files.",
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "rename_markdown_file",
        "title": "Rename or Move Markdown File",
        "description": "Safely rename or move a Markdown file inside the project root and optionally update wikilinks and relative links.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "oldPath": {"type": "string", "description": "Existing relative POSIX path."},
                "newPath": {"type": "string", "description": "Destination relative POSIX path."},
                "updateLinks": {"type": "boolean", "description": "Whether to rewrite references across project Markdown files."},
                "scope": SCOPE_PROP,
            },
            "required": ["oldPath", "newPath"],
            "additionalProperties": False,
        },
    },
    {
        "name": "save_markdown_asset",
        "title": "Save Markdown Image Asset",
        "description": "Save a base64-encoded image into the document's assets/ directory inside the project root.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "docPath": {"type": "string", "description": "Relative POSIX path of the Markdown document."},
                "filename": {"type": "string", "description": "Image file name with valid image extension."},
                "data": {"type": "string", "description": "Base64-encoded image bytes (max 4 MiB)."},
                "scope": SCOPE_PROP,
            },
            "required": ["docPath", "filename", "data"],
            "additionalProperties": False,
        },
    },
    {
        "name": "replace_in_markdown_files",
        "title": "Replace in Markdown Files",
        "description": "Atomically replace matching text across selected Markdown files with optional ETag conflict checking.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query or regex pattern."},
                "replacement": {"type": "string", "description": "Replacement text."},
                "paths": {"type": "array", "items": {"type": "string"}, "description": "Relative POSIX paths to update."},
                "caseSensitive": {"type": "boolean", "description": "Case-sensitive matching."},
                "wholeWord": {"type": "boolean", "description": "Whole-word matching."},
                "regex": {"type": "boolean", "description": "Treat query as a regular expression."},
                "expectedEtags": {"type": "object", "description": "Optional map of path to expected ETag."},
                "scope": SCOPE_PROP,
            },
            "required": ["query", "replacement"],
            "additionalProperties": False,
        },
    },
    {
        "name": "read_office_document",
        "title": "Read Office or PDF Document",
        "description": (
            "Read and parse an Excel (.xlsx/.xlsm/.csv/.tsv), Word (.docx), PowerPoint (.pptx), "
            "or PDF (.pdf) document inside the project root for offline preview and Markdown conversion."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Relative POSIX path to an Excel, Word, PowerPoint, or PDF file inside the project root.",
                },
                "scope": SCOPE_PROP,
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    },
]


def _compute_etag(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()[:16]


def _is_within_root(root_real: str, target_real: str) -> bool:
    try:
        return os.path.commonpath([root_real, target_real]) == root_real
    except ValueError:
        return False


def _has_control_chars(text: str) -> bool:
    return any(ord(ch) < 32 or ord(ch) == 127 for ch in text)


def _iter_markdown_files(root_real: str, allowed_exts: set[str] | None = None):
    exts = allowed_exts if allowed_exts is not None else MARKDOWN_EXTENSIONS
    for current_root, dirnames, filenames in os.walk(root_real, topdown=True, followlinks=False):
        kept_dirs = []
        for dname in sorted(dirnames):
            if dname.startswith(".") or dname in SKIP_DIRS:
                continue
            full_dir = os.path.join(current_root, dname)
            if os.path.islink(full_dir):
                continue
            kept_dirs.append(dname)
        dirnames[:] = kept_dirs

        for fname in sorted(filenames):
            if fname.startswith("."):
                continue
            if os.path.splitext(fname)[1].lower() not in exts:
                continue
            full_file = os.path.join(current_root, fname)
            if os.path.islink(full_file):
                resolved = os.path.realpath(full_file)
                if not _is_within_root(root_real, resolved) or not os.path.isfile(resolved):
                    continue
            if not os.path.isfile(full_file):
                continue
            rel_path = pathlib.PurePosixPath(
                *pathlib.Path(os.path.relpath(full_file, root_real)).parts
            ).as_posix()
            yield rel_path, full_file


def _resolve_markdown_path(
    root_dir: str,
    rel_path: str,
    must_exist: bool = True,
    allowed_exts: set[str] | None = None,
) -> tuple[str, str, str]:
    exts = allowed_exts if allowed_exts is not None else MARKDOWN_EXTENSIONS
    root_real = os.path.realpath(root_dir)
    if not os.path.isdir(root_real):
        raise ValueError("Project root directory does not exist.")

    if not isinstance(rel_path, str) or not rel_path.strip():
        raise ValueError("Parameter 'path' must be a non-empty string.")
    if len(rel_path.encode("utf-8")) > MAX_PATH_ARG_BYTES:
        raise ValueError("Parameter 'path' exceeds maximum allowed length.")
    if _has_control_chars(rel_path):
        raise ValueError("Parameter 'path' contains invalid control characters.")
    if "\\" in rel_path or os.path.isabs(rel_path) or rel_path.startswith("/"):
        raise ValueError("Parameter 'path' must be a relative POSIX path.")

    posix_path = pathlib.PurePosixPath(rel_path)
    if ".." in posix_path.parts or not posix_path.parts:
        raise ValueError("Parent directory traversal ('..') is not allowed.")

    if posix_path.suffix.lower() not in exts:
        if exts is MARKDOWN_EXTENSIONS:
            raise ValueError("Only Markdown files (.md, .markdown, .mdx) are supported.")
        raise ValueError("Unsupported document file extension.")

    joined = os.path.join(root_real, *posix_path.parts)
    if os.path.islink(joined):
        target_real = os.path.realpath(joined)
        if not _is_within_root(root_real, target_real):
            raise ValueError("Requested path resolves outside the project root.")
    else:
        target_real = os.path.realpath(joined)

    if target_real == root_real or not _is_within_root(root_real, target_real):
        raise ValueError("Requested path resolves outside the project root.")

    if must_exist and not os.path.isfile(target_real):
        raise ValueError(f"Document file not found: {posix_path.as_posix()}")

    normalized = pathlib.PurePosixPath(
        *pathlib.Path(os.path.relpath(target_real, root_real)).parts
    ).as_posix()
    return root_real, target_real, normalized


UNSAFE_PARENT_DIRS = {
    "/",
    "/Users",
    "/home",
    "/tmp",
    "/private/tmp",
    "/var",
    "/private/var",
    "/etc",
    "/opt",
    "/usr",
    os.path.realpath(os.path.expanduser("~")),
}


def _dir_has_markdown(dir_real: str, max_depth: int = 3) -> bool:
    for cur_root, dirnames, filenames in os.walk(dir_real, topdown=True, followlinks=False):
        rel = os.path.relpath(cur_root, dir_real)
        depth = 0 if rel == "." else rel.count(os.sep) + 1
        for fname in filenames:
            if not fname.startswith(".") and os.path.splitext(fname)[1].lower() in MARKDOWN_EXTENSIONS:
                return True
        if depth >= max_depth:
            dirnames[:] = []
            continue
        dirnames[:] = [
            d for d in sorted(dirnames)
            if not d.startswith(".") and d not in SKIP_DIRS and not os.path.islink(os.path.join(cur_root, d))
        ]
    return False


def discover_workspaces(root_dir: str) -> dict[str, str]:
    """Safely discover mounted sibling workspace folders alongside the primary project root."""
    root_real = os.path.realpath(root_dir)
    if not os.path.isdir(root_real):
        raise ValueError("Project root directory does not exist.")
    current_name = os.path.basename(root_real) or "project"
    workspaces: dict[str, str] = {current_name: root_real}

    parent = os.path.realpath(os.path.dirname(root_real))
    if parent == root_real or parent in UNSAFE_PARENT_DIRS or not os.path.isdir(parent):
        return workspaces

    try:
        children = sorted(os.listdir(parent))
    except OSError:
        return workspaces

    for name in children:
        if name.startswith(".") or name in SKIP_DIRS or name in workspaces:
            continue
        full = os.path.join(parent, name)
        if os.path.islink(full) or not os.path.isdir(full):
            continue
        real_child = os.path.realpath(full)
        if not _is_within_root(parent, real_child):
            continue
        if _dir_has_markdown(real_child):
            workspaces[name] = real_child
        if len(workspaces) >= 20:
            break
    return workspaces


def _resolve_scoped_markdown_path(
    root_dir: str,
    rel_path: str,
    scope: str = "project",
    must_exist: bool = True,
    allowed_exts: set[str] | None = None,
) -> tuple[str, str, str]:
    if scope != "all":
        return _resolve_markdown_path(root_dir, rel_path, must_exist=must_exist, allowed_exts=allowed_exts)

    if not isinstance(rel_path, str) or "/" not in rel_path:
        raise ValueError("Cross-workspace path must be formatted as '<workspace>/<relative-path>'.")
    ws_name, inner_rel = rel_path.split("/", 1)
    workspaces = discover_workspaces(root_dir)
    if ws_name not in workspaces:
        raise ValueError(f"Workspace '{ws_name}' is not in the authorized workspace list.")
    ws_real, target_real, inner_norm = _resolve_markdown_path(
        workspaces[ws_name], inner_rel, must_exist=must_exist, allowed_exts=allowed_exts
    )
    return ws_real, target_real, f"{ws_name}/{inner_norm}"


def _refresh_scoped_entries(root_dir: str, scope: str = "project") -> dict[str, dict]:
    root_real = os.path.realpath(root_dir)
    if not os.path.isdir(root_real):
        raise ValueError("Project root directory does not exist.")
    if scope == "all":
        workspaces = discover_workspaces(root_real)
        return _INDEX.refresh_multi(workspaces)
    return _INDEX.refresh(root_real)


def list_markdown_files(root_dir: str, scope: str = "project", include_docs: bool = False) -> dict:
    root_real = os.path.realpath(root_dir)
    if not os.path.isdir(root_real):
        raise ValueError("Project root directory does not exist.")

    workspaces = discover_workspaces(root_real)
    allowed = (MARKDOWN_EXTENSIONS | OFFICE_EXTENSIONS) if include_docs else MARKDOWN_EXTENSIONS
    entries = []
    truncated = False

    if scope == "all":
        for ws_name, ws_real in workspaces.items():
            for rel_path, full_file in _iter_markdown_files(ws_real, allowed_exts=allowed):
                try:
                    st = os.stat(full_file)
                except OSError:
                    continue
                if len(entries) >= MAX_FILES:
                    truncated = True
                    break
                item = {
                    "path": f"{ws_name}/{rel_path}",
                    "workspace": ws_name,
                    "bytes": st.st_size,
                    "mtime": int(st.st_mtime),
                    "mtimeNs": st.st_mtime_ns,
                }
                if include_docs:
                    item["docType"] = doc_type_for_path(rel_path)
                entries.append(item)
            if truncated:
                break
    else:
        for rel_path, full_file in _iter_markdown_files(root_real, allowed_exts=allowed):
            try:
                st = os.stat(full_file)
            except OSError:
                continue
            if len(entries) >= MAX_FILES:
                truncated = True
                break
            item = {
                "path": rel_path,
                "bytes": st.st_size,
                "mtime": int(st.st_mtime),
                "mtimeNs": st.st_mtime_ns,
            }
            if include_docs:
                item["docType"] = doc_type_for_path(rel_path)
            entries.append(item)

    entries.sort(key=lambda item: item["path"])
    return {
        "project": os.path.basename(root_real) or root_real,
        "scope": "all" if scope == "all" else "project",
        "workspaces": list(workspaces.keys()),
        "files": entries,
        "total": len(entries),
        "truncated": truncated,
    }


def read_office_document(root_dir: str, rel_path: str, scope: str = "project") -> dict:
    _, target_real, normalized = _resolve_scoped_markdown_path(
        root_dir,
        rel_path,
        scope=scope,
        must_exist=True,
        allowed_exts=OFFICE_EXTENSIONS,
    )
    payload = read_office_file(target_real)
    payload["path"] = normalized
    return payload


def _decode_utf8_prefix(raw: bytes, limit: int) -> tuple[str, bool]:
    if len(raw) <= limit:
        return raw.decode("utf-8"), False

    for trim in range(4):
        end = limit - trim
        if end <= 0:
            break
        try:
            return raw[:end].decode("utf-8"), True
        except UnicodeDecodeError as exc:
            if exc.start < limit - 4:
                raise
    return raw[:limit].decode("utf-8"), True


def read_markdown_file(root_dir: str, rel_path: str, scope: str = "project") -> dict:
    _, target_real, normalized = _resolve_scoped_markdown_path(root_dir, rel_path, scope=scope, must_exist=True)

    st = os.stat(target_real)
    total_bytes = st.st_size
    with open(target_real, "rb") as handle:
        raw = handle.read(MAX_READ_BYTES + 1)

    if b"\x00" in raw:
        raise ValueError("File appears to be binary and cannot be read as UTF-8 text.")

    try:
        text, truncated = _decode_utf8_prefix(raw, MAX_READ_BYTES)
    except UnicodeDecodeError as exc:
        raise ValueError("File is not valid UTF-8 text.") from exc

    etag = _compute_etag(raw[:MAX_READ_BYTES] if truncated else raw)
    return {
        "path": normalized,
        "content": text,
        "bytes": total_bytes,
        "truncated": truncated,
        "readOnly": truncated,
        "etag": etag,
        "mtimeNs": st.st_mtime_ns,
    }


def search_markdown_files(
    root_dir: str,
    query: str,
    limit: int = 80,
    tags: list[str] | None = None,
    case_sensitive: bool = False,
    whole_word: bool = False,
    regex: bool = False,
    path_prefix: str = "",
    sort_by: str = "relevance",
    include_context: bool = False,
    scope: str = "project",
) -> dict:
    if not isinstance(query, str) or not query.strip():
        raise ValueError("Parameter 'query' must be a non-empty string.")
    if len(query) > 240:
        raise ValueError("Parameter 'query' is too long (max 240 characters).")
    if not isinstance(limit, int) or limit < 1:
        limit = 80
    limit = min(limit, MAX_SEARCH_MATCHES)

    entries = _refresh_scoped_entries(root_dir, scope=scope)
    return search_entries(
        entries,
        query,
        limit=limit,
        tags=tags,
        case_sensitive=bool(case_sensitive),
        whole_word=bool(whole_word),
        regex=bool(regex),
        path_prefix=str(path_prefix or ""),
        sort_by=str(sort_by or "relevance"),
        include_context=bool(include_context),
    )


def _strip_ext(posix_path: str) -> str:
    for ext in MARKDOWN_EXTENSIONS:
        if posix_path.lower().endswith(ext):
            return posix_path[: -len(ext)]
    return posix_path


def get_backlinks(root_dir: str, rel_path: str, scope: str = "project") -> dict:
    _, _, target_norm = _resolve_scoped_markdown_path(root_dir, rel_path, scope=scope, must_exist=True)
    target_no_ext = _strip_ext(target_norm).lower()
    target_stem = pathlib.PurePosixPath(target_no_ext).name.lower()
    target_name = pathlib.PurePosixPath(target_norm).name.lower()
    entries = _refresh_scoped_entries(root_dir, scope=scope)

    backlinks = []
    for src_path in sorted(entries.keys()):
        if src_path == target_norm:
            continue
        src_dir = pathlib.PurePosixPath(src_path).parent
        for lineno, line in enumerate(entries[src_path].get("lines", []), start=1):
            matched_kind = None
            matched_text = ""
            for raw_wiki in WIKILINK_RE.findall(line):
                target_part = raw_wiki.split("|", 1)[0].split("#", 1)[0].strip().replace("\\", "/")
                if not target_part:
                    continue
                norm_wiki = _strip_ext(target_part.lstrip("./")).lower()
                if norm_wiki in (target_no_ext, target_stem) or target_part.lower() == target_name:
                    matched_kind = "wikilink"
                    matched_text = f"[[{raw_wiki}]]"
                    break
            if not matched_kind:
                for raw_href in MD_LINK_RE.findall(line):
                    href = raw_href.split("#", 1)[0].split("?", 1)[0].strip()
                    if not href or re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", href):
                        continue
                    resolved = os.path.normpath(os.path.join(str(src_dir), href)).replace("\\", "/")
                    if resolved == target_norm:
                        matched_kind = "markdown"
                        matched_text = raw_href
                        break
            if matched_kind:
                backlinks.append({
                    "path": src_path,
                    "line": lineno,
                    "kind": matched_kind,
                    "linkText": matched_text,
                    "snippet": line.strip()[:160],
                })
                if len(backlinks) >= MAX_SEARCH_MATCHES:
                    return {"target": target_norm, "backlinks": backlinks}

    return {"target": target_norm, "backlinks": backlinks}


def save_markdown_file(
    root_dir: str,
    rel_path: str,
    content: str,
    expected_etag: str | None = None,
    force: bool = False,
    create_dirs: bool = False,
    scope: str = "project",
) -> dict:
    root_real, target_real, normalized = _resolve_scoped_markdown_path(
        root_dir, rel_path, scope=scope, must_exist=False
    )
    if not isinstance(content, str):
        raise ValueError("Parameter 'content' must be a string.")
    encoded = content.encode("utf-8")
    if len(encoded) > MAX_READ_BYTES:
        raise ValueError("File content exceeds maximum size of 512 KiB.")
    if b"\x00" in encoded:
        raise ValueError("Content contains invalid NUL bytes.")

    parent_dir = os.path.dirname(target_real)
    if create_dirs and not os.path.exists(parent_dir):
        probe = parent_dir
        while probe and not os.path.exists(probe):
            probe = os.path.dirname(probe)
        if not probe or not _is_within_root(root_real, os.path.realpath(probe)):
            raise ValueError("Target parent directory resolves outside the project root.")
        os.makedirs(parent_dir, exist_ok=True)

    if not os.path.isdir(parent_dir) or not _is_within_root(root_real, os.path.realpath(parent_dir)):
        raise ValueError("Target parent directory does not exist inside the project root.")

    if expected_etag and not force and os.path.isfile(target_real):
        st = os.stat(target_real)
        with open(target_real, "rb") as handle:
            disk_raw = handle.read(MAX_READ_BYTES + 1)
        disk_etag = _compute_etag(disk_raw[:MAX_READ_BYTES] if len(disk_raw) > MAX_READ_BYTES else disk_raw)
        if disk_etag != expected_etag:
            return {
                "path": normalized,
                "saved": False,
                "conflict": True,
                "diskEtag": disk_etag,
                "diskMtimeNs": st.st_mtime_ns,
                "diskBytes": st.st_size,
            }

    fd, tmp_path = tempfile.mkstemp(prefix=".mdsave-", dir=parent_dir)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, target_real)
    except Exception:
        if os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        raise

    st = os.stat(target_real)
    return {
        "path": normalized,
        "bytes": len(encoded),
        "saved": True,
        "conflict": False,
        "etag": _compute_etag(encoded),
        "mtimeNs": st.st_mtime_ns,
    }


def read_markdown_asset(root_dir: str, doc_path: str, asset_href: str, scope: str = "project") -> dict:
    root_real, doc_real, _ = _resolve_scoped_markdown_path(root_dir, doc_path, scope=scope, must_exist=True)

    if not isinstance(asset_href, str) or not asset_href.strip():
        raise ValueError("Parameter 'assetHref' must be a non-empty string.")
    clean_href = asset_href.split("#", 1)[0].split("?", 1)[0].strip()
    if not clean_href or len(clean_href.encode("utf-8")) > MAX_PATH_ARG_BYTES:
        raise ValueError("Parameter 'assetHref' is invalid or too long.")
    if _has_control_chars(clean_href):
        raise ValueError("Parameter 'assetHref' contains invalid control characters.")
    if "\\" in clean_href or os.path.isabs(clean_href) or clean_href.startswith("/"):
        raise ValueError("Parameter 'assetHref' must be a relative POSIX path.")
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", clean_href):
        raise ValueError("External URLs are not permitted for local asset loading.")

    doc_dir = os.path.dirname(doc_real)
    candidate = os.path.normpath(os.path.join(doc_dir, *pathlib.PurePosixPath(clean_href).parts))
    target_real = os.path.realpath(candidate)

    if target_real == root_real or not _is_within_root(root_real, target_real):
        raise ValueError("Asset path resolves outside the project root.")
    if not os.path.isfile(target_real):
        raise ValueError(f"Asset file not found: {clean_href}")

    ext = os.path.splitext(target_real)[1].lower()
    mime_type = ASSET_MIME_TYPES.get(ext)
    if not mime_type:
        raise ValueError("Unsupported image format.")

    size = os.path.getsize(target_real)
    if size > MAX_ASSET_BYTES:
        raise ValueError("Image asset exceeds maximum size of 4 MiB.")

    with open(target_real, "rb") as handle:
        raw = handle.read(MAX_ASSET_BYTES + 1)
    if len(raw) > MAX_ASSET_BYTES:
        raise ValueError("Image asset exceeds maximum size of 4 MiB.")

    normalized = pathlib.PurePosixPath(
        *pathlib.Path(os.path.relpath(target_real, root_real)).parts
    ).as_posix()

    return {
        "resolvedPath": normalized,
        "mimeType": mime_type,
        "bytes": len(raw),
        "encoding": "base64",
        "data": base64.b64encode(raw).decode("ascii"),
    }


def list_project_tags(root_dir: str, scope: str = "project") -> dict:
    entries = _refresh_scoped_entries(root_dir, scope=scope)
    return summarize_tags(entries)


def list_project_tasks(
    root_dir: str,
    status: str = "all",
    path_prefix: str = "",
    limit: int = 500,
    scope: str = "project",
) -> dict:
    if status not in ("all", "open", "done"):
        status = "all"
    entries = _refresh_scoped_entries(root_dir, scope=scope)
    return summarize_tasks(entries, status=status, path_prefix=path_prefix, limit=limit)


def toggle_markdown_task(
    root_dir: str,
    rel_path: str,
    line: int,
    checked: bool,
    expected_etag: str,
    scope: str = "project",
) -> dict:
    _, target_real, normalized = _resolve_scoped_markdown_path(root_dir, rel_path, scope=scope, must_exist=True)
    if not isinstance(line, int) or line < 1:
        raise ValueError("Parameter 'line' must be a positive integer.")
    if not isinstance(expected_etag, str) or not expected_etag.strip():
        raise ValueError("Parameter 'expectedEtag' is required.")

    with open(target_real, "rb") as handle:
        raw = handle.read(MAX_READ_BYTES + 1)
    if len(raw) > MAX_READ_BYTES:
        raise ValueError("Cannot toggle tasks in files larger than 512 KiB.")
    if b"\x00" in raw:
        raise ValueError("File appears to be binary.")

    disk_etag = _compute_etag(raw)
    if disk_etag != expected_etag:
        return {
            "path": normalized,
            "line": line,
            "checked": bool(checked),
            "saved": False,
            "conflict": True,
            "diskEtag": disk_etag,
        }

    text = raw.decode("utf-8")
    lines = text.splitlines(keepends=True)
    if line > len(lines):
        raise ValueError(f"Line {line} is out of range.")

    raw_line = lines[line - 1]
    line_ending = "\r\n" if raw_line.endswith("\r\n") else ("\n" if raw_line.endswith("\n") else "")
    body = raw_line[: len(raw_line) - len(line_ending)]
    m = TASK_TOGGLE_RE.match(body)
    if not m:
        raise ValueError(f"Line {line} is not a Markdown task item.")

    mark = "x" if checked else " "
    lines[line - 1] = f"{m.group(1)}{mark}{m.group(3)}{line_ending}"
    updated = "".join(lines).encode("utf-8")

    parent_dir = os.path.dirname(target_real)
    fd, tmp_path = tempfile.mkstemp(prefix=".mdtask-", dir=parent_dir)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(updated)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, target_real)
    except Exception:
        if os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        raise

    return {
        "path": normalized,
        "line": line,
        "checked": bool(checked),
        "etag": _compute_etag(updated),
        "saved": True,
        "conflict": False,
    }


def inspect_project_links(root_dir: str, scope: str = "project") -> dict:
    entries = _refresh_scoped_entries(root_dir, scope=scope)
    result = inspect_links(entries)
    result["graph"] = build_project_graph(entries)
    return result


def update_markdown_task_meta(
    root_dir: str,
    rel_path: str,
    line: int,
    expected_etag: str,
    priority: str = "",
    due: str = "",
    assignee: str = "",
    group: str = "",
    color: str = "",
    status: str = "",
    checked: bool | None = None,
    clean_text: str = "",
    scope: str = "project",
) -> dict:
    _, target_real, normalized = _resolve_scoped_markdown_path(root_dir, rel_path, scope=scope, must_exist=True)
    if not isinstance(line, int) or line < 1:
        raise ValueError("Parameter 'line' must be a positive integer.")
    if not isinstance(expected_etag, str) or not expected_etag.strip():
        raise ValueError("Parameter 'expectedEtag' is required.")

    with open(target_real, "rb") as handle:
        raw = handle.read(MAX_READ_BYTES + 1)
    if len(raw) > MAX_READ_BYTES:
        raise ValueError("Cannot edit tasks in files larger than 512 KiB.")
    if b"\x00" in raw:
        raise ValueError("File appears to be binary.")

    disk_etag = _compute_etag(raw)
    if disk_etag != expected_etag:
        return {
            "path": normalized,
            "line": line,
            "saved": False,
            "conflict": True,
            "diskEtag": disk_etag,
        }

    text = raw.decode("utf-8")
    lines = text.splitlines(keepends=True)
    if line > len(lines):
        raise ValueError(f"Line {line} is out of range.")

    raw_line = lines[line - 1]
    line_ending = "\r\n" if raw_line.endswith("\r\n") else ("\n" if raw_line.endswith("\n") else "")
    body = raw_line[: len(raw_line) - len(line_ending)]
    m = re.match(r"^(\s*(?:[-*+]|\d{1,9}[.)])\s+\[)([ xX])(\]\s*)(.*)$", body)
    if not m:
        raise ValueError(f"Line {line} is not a Markdown task item.")

    orig_checked = m.group(2).lower() == "x"
    norm_status = str(status or "").strip().lower()
    if norm_status == "done":
        next_checked = True
    elif norm_status in ("todo", "doing", "review"):
        next_checked = False
    elif checked is not None:
        next_checked = bool(checked)
    else:
        next_checked = orig_checked

    mark = "x" if next_checked else " "
    rewritten_text = format_task_metadata(
        m.group(4),
        priority=priority,
        due=due,
        assignee=assignee,
        group=group,
        color=color,
        status="" if next_checked else norm_status,
        clean_text=clean_text,
    )
    lines[line - 1] = f"{m.group(1)}{mark}{m.group(3)}{rewritten_text}{line_ending}"
    updated = "".join(lines).encode("utf-8")

    parent_dir = os.path.dirname(target_real)
    fd, tmp_path = tempfile.mkstemp(prefix=".mdtaskmeta-", dir=parent_dir)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(updated)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, target_real)
    except Exception:
        if os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        raise

    parsed = parse_task_metadata(rewritten_text, checked=next_checked)
    return {
        "path": normalized,
        "line": line,
        "checked": next_checked,
        "status": parsed["status"],
        "text": rewritten_text,
        "cleanText": parsed["cleanText"],
        "priority": parsed["priority"],
        "due": parsed["due"],
        "assignee": parsed["assignee"],
        "group": parsed["group"],
        "color": parsed["color"],
        "etag": _compute_etag(updated),
        "saved": True,
        "conflict": False,
    }


def get_project_graph(root_dir: str, scope: str = "project") -> dict:
    entries = _refresh_scoped_entries(root_dir, scope=scope)
    return build_project_graph(entries)


def _atomic_write_bytes(target_real: str, data: bytes, prefix: str = ".mdwrite-") -> None:
    parent_dir = os.path.dirname(target_real)
    fd, tmp_path = tempfile.mkstemp(prefix=prefix, dir=parent_dir)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, target_real)
    except Exception:
        if os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        raise


def rename_markdown_file(
    root_dir: str,
    old_path: str,
    new_path: str,
    update_links: bool = True,
    scope: str = "project",
) -> dict:
    root_real, old_real, old_norm = _resolve_scoped_markdown_path(root_dir, old_path, scope=scope, must_exist=True)
    _, new_real, new_norm = _resolve_scoped_markdown_path(root_dir, new_path, scope=scope, must_exist=False)

    if old_norm == new_norm:
        return {"oldPath": old_norm, "newPath": new_norm, "updatedFiles": [], "updatedCount": 0}
    if os.path.exists(new_real):
        raise ValueError(f"Destination already exists: {new_norm}")

    new_parent = os.path.dirname(new_real)
    probe = new_parent
    while probe and not os.path.exists(probe):
        probe = os.path.dirname(probe)
    if not probe or not _is_within_root(root_real, os.path.realpath(probe)):
        raise ValueError("Destination parent directory resolves outside the project root.")
    os.makedirs(new_parent, exist_ok=True)
    os.replace(old_real, new_real)

    updated_files = []
    if update_links:
        old_no_ext = _strip_ext(old_norm)
        new_no_ext = _strip_ext(new_norm)
        old_stem = pathlib.PurePosixPath(old_no_ext).name
        new_stem = pathlib.PurePosixPath(new_no_ext).name

        for rel_path, full_file in _iter_markdown_files(root_real):
            try:
                if os.path.getsize(full_file) > MAX_READ_BYTES:
                    continue
                with open(full_file, "rb") as handle:
                    raw = handle.read()
                if b"\x00" in raw:
                    continue
                text = raw.decode("utf-8")
            except (OSError, UnicodeDecodeError):
                continue

            changed = False

            def _replace_wiki(match):
                nonlocal changed
                inner = match.group(1)
                target_and_heading, *alias_rest = inner.split("|", 1)
                target_part, *heading_rest = target_and_heading.split("#", 1)
                clean_target = target_part.strip().replace("\\", "/").lstrip("./")
                if _strip_ext(clean_target).lower() in (old_no_ext.lower(), old_stem.lower()) or clean_target.lower() == old_norm.lower():
                    replacement_target = new_no_ext if "/" in clean_target else new_stem
                    rebuilt = replacement_target
                    if heading_rest:
                        rebuilt += "#" + heading_rest[0]
                    if alias_rest:
                        rebuilt += "|" + alias_rest[0]
                    changed = True
                    return f"[[{rebuilt}]]"
                return match.group(0)

            new_text = WIKILINK_RE.sub(_replace_wiki, text)
            if changed:
                _atomic_write_bytes(full_file, new_text.encode("utf-8"), prefix=".mdlink-")
                updated_files.append(rel_path)

    return {
        "oldPath": old_norm,
        "newPath": new_norm,
        "updatedFiles": updated_files,
        "updatedCount": len(updated_files),
    }


def save_markdown_asset(
    root_dir: str,
    doc_path: str,
    filename: str,
    data_b64: str,
    scope: str = "project",
) -> dict:
    root_real, doc_real, _ = _resolve_scoped_markdown_path(root_dir, doc_path, scope=scope, must_exist=True)
    if not isinstance(filename, str) or not filename.strip():
        raise ValueError("Parameter 'filename' must be a non-empty string.")
    if not isinstance(data_b64, str) or not data_b64.strip():
        raise ValueError("Parameter 'data' must be base64-encoded image content.")

    base_name = os.path.basename(filename.strip().replace("\\", "/"))
    ext = os.path.splitext(base_name)[1].lower()
    if ext not in ASSET_MIME_TYPES:
        raise ValueError("Unsupported image format.")
    safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "-", os.path.splitext(base_name)[0]).strip("-") or "image"

    try:
        raw = base64.b64decode(data_b64.encode("ascii"), validate=True)
    except Exception as exc:
        raise ValueError("Invalid base64 image data.") from exc
    if not raw or len(raw) > MAX_ASSET_BYTES:
        raise ValueError("Image asset size must be between 1 byte and 4 MiB.")

    doc_dir = os.path.dirname(doc_real)
    assets_dir = os.path.realpath(os.path.join(doc_dir, "assets")) if os.path.exists(os.path.join(doc_dir, "assets")) else os.path.join(doc_dir, "assets")
    if not _is_within_root(root_real, os.path.realpath(doc_dir)):
        raise ValueError("Document directory resolves outside the project root.")
    os.makedirs(assets_dir, exist_ok=True)
    if not _is_within_root(root_real, os.path.realpath(assets_dir)):
        raise ValueError("Assets directory resolves outside the project root.")

    stamp = int(os.stat(doc_real).st_mtime_ns // 1_000_000) % 1_000_000_000
    final_name = f"{stamp}-{safe_stem}{ext}"
    target_real = os.path.join(assets_dir, final_name)
    counter = 1
    while os.path.exists(target_real):
        final_name = f"{stamp}-{safe_stem}-{counter}{ext}"
        target_real = os.path.join(assets_dir, final_name)
        counter += 1

    _atomic_write_bytes(target_real, raw, prefix=".mdasset-")
    resolved_rel = pathlib.PurePosixPath(*pathlib.Path(os.path.relpath(target_real, root_real)).parts).as_posix()
    return {
        "assetHref": f"assets/{final_name}",
        "resolvedPath": resolved_rel,
        "bytes": len(raw),
    }


def replace_in_markdown_files(
    root_dir: str,
    query: str,
    replacement: str,
    paths: list[str] | None = None,
    case_sensitive: bool = False,
    whole_word: bool = False,
    regex: bool = False,
    expected_etags: dict[str, str] | None = None,
    scope: str = "project",
) -> dict:
    if not isinstance(query, str) or not query:
        raise ValueError("Parameter 'query' must be a non-empty string.")
    if not isinstance(replacement, str):
        raise ValueError("Parameter 'replacement' must be a string.")

    flags = 0 if case_sensitive else re.IGNORECASE
    if regex:
        try:
            pattern = re.compile(query, flags)
        except re.error as exc:
            raise ValueError(f"Invalid regular expression: {exc}") from exc
    elif whole_word:
        pattern = re.compile(r"\b" + re.escape(query) + r"\b", flags)
    else:
        pattern = re.compile(re.escape(query), flags)

    target_paths = paths if isinstance(paths, list) and paths else []
    if not target_paths:
        listed = list_markdown_files(root_dir, scope=scope)
        target_paths = [item["path"] for item in listed["files"]]

    etags_map = expected_etags if isinstance(expected_etags, dict) else {}
    replaced_files = []
    conflicts = []
    total_replacements = 0

    for rel_path in target_paths:
        try:
            _, target_real, normalized = _resolve_scoped_markdown_path(root_dir, rel_path, scope=scope, must_exist=True)
            with open(target_real, "rb") as handle:
                raw = handle.read(MAX_READ_BYTES + 1)
            if len(raw) > MAX_READ_BYTES or b"\x00" in raw:
                continue
            disk_etag = _compute_etag(raw)
            if normalized in etags_map and etags_map[normalized] and etags_map[normalized] != disk_etag:
                conflicts.append({"path": normalized, "diskEtag": disk_etag})
                continue
            text = raw.decode("utf-8")
        except (OSError, UnicodeDecodeError, ValueError):
            continue

        new_text, count = pattern.subn(replacement, text)
        if count > 0 and new_text != text:
            encoded = new_text.encode("utf-8")
            if len(encoded) > MAX_READ_BYTES:
                continue
            _atomic_write_bytes(target_real, encoded, prefix=".mdrepl-")
            replaced_files.append({"path": normalized, "count": count, "etag": _compute_etag(encoded)})
            total_replacements += count

    return {
        "replacedFiles": replaced_files,
        "totalReplacements": total_replacements,
        "conflicts": conflicts,
    }


def _tool_error(message: str) -> dict:
    return {
        "content": [{"type": "text", "text": message}],
        "isError": True,
    }


def handle_request(message: dict, root_dir: str | None) -> dict | None:
    if not isinstance(message, dict):
        return None
    method = message.get("method")
    params = message.get("params") if isinstance(message.get("params"), dict) else {}

    if method == "initialize":
        return {
            "protocolVersion": params.get("protocolVersion", "2024-11-05"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        name = params.get("name")
        args = params.get("arguments")
        if args is None:
            args = {}
        if not isinstance(args, dict):
            return _tool_error("Tool arguments must be a JSON object.")
        if not root_dir or not os.path.isdir(root_dir):
            return _tool_error("Project root directory is missing or invalid.")

        try:
            scope = "all" if args.get("scope") == "all" else "project"
            if name == "list_markdown_files":
                result = list_markdown_files(
                    root_dir,
                    scope=scope,
                    include_docs=bool(args.get("includeDocs", False)),
                )
                return {
                    "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                    "structuredContent": result,
                }
            if name == "read_office_document":
                result = read_office_document(root_dir, args.get("path", ""), scope=scope)
                return {
                    "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                    "structuredContent": result,
                }
            if name == "read_markdown_file":
                result = read_markdown_file(root_dir, args.get("path", ""), scope=scope)
                return {
                    "content": [{"type": "text", "text": result["content"]}],
                    "structuredContent": result,
                }
            if name == "search_markdown_files":
                result = search_markdown_files(
                    root_dir,
                    args.get("query", ""),
                    args.get("limit", 80),
                    tags=args.get("tags"),
                    case_sensitive=bool(args.get("caseSensitive", False)),
                    whole_word=bool(args.get("wholeWord", False)),
                    regex=bool(args.get("regex", False)),
                    path_prefix=args.get("pathPrefix", ""),
                    sort_by=args.get("sortBy", "relevance"),
                    include_context=bool(args.get("includeContext", False)),
                    scope=scope,
                )
                return {
                    "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                    "structuredContent": result,
                }
            if name == "get_backlinks":
                result = get_backlinks(root_dir, args.get("path", ""), scope=scope)
                return {
                    "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                    "structuredContent": result,
                }
            if name == "save_markdown_file":
                result = save_markdown_file(
                    root_dir,
                    args.get("path", ""),
                    args.get("content", ""),
                    expected_etag=args.get("expectedEtag"),
                    force=bool(args.get("force", False)),
                    create_dirs=bool(args.get("createDirs", False)),
                    scope=scope,
                )
                return {
                    "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                    "structuredContent": result,
                }
            if name == "read_markdown_asset":
                result = read_markdown_asset(
                    root_dir, args.get("docPath", ""), args.get("assetHref", ""), scope=scope
                )
                return {
                    "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                    "structuredContent": result,
                }
            if name == "list_project_tags":
                result = list_project_tags(root_dir, scope=scope)
                return {
                    "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                    "structuredContent": result,
                }
            if name == "list_project_tasks":
                result = list_project_tasks(
                    root_dir,
                    status=args.get("status", "all"),
                    path_prefix=args.get("pathPrefix", ""),
                    limit=args.get("limit", 500),
                    scope=scope,
                )
                return {
                    "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                    "structuredContent": result,
                }
            if name == "toggle_markdown_task":
                result = toggle_markdown_task(
                    root_dir,
                    args.get("path", ""),
                    args.get("line"),
                    bool(args.get("checked", False)),
                    args.get("expectedEtag", ""),
                    scope=scope,
                )
                return {
                    "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                    "structuredContent": result,
                }
            if name == "inspect_project_links":
                result = inspect_project_links(root_dir, scope=scope)
                return {
                    "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                    "structuredContent": result,
                }
            if name == "update_markdown_task_meta":
                result = update_markdown_task_meta(
                    root_dir,
                    args.get("path", ""),
                    args.get("line"),
                    args.get("expectedEtag", ""),
                    priority=args.get("priority", ""),
                    due=args.get("due", ""),
                    assignee=args.get("assignee", ""),
                    group=args.get("group", ""),
                    color=args.get("color", ""),
                    status=args.get("status", ""),
                    checked=args.get("checked") if "checked" in args else None,
                    clean_text=args.get("cleanText", ""),
                    scope=scope,
                )
                return {
                    "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                    "structuredContent": result,
                }
            if name == "get_project_graph":
                result = get_project_graph(root_dir, scope=scope)
                return {
                    "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                    "structuredContent": result,
                }
            if name == "rename_markdown_file":
                result = rename_markdown_file(
                    root_dir,
                    args.get("oldPath", ""),
                    args.get("newPath", ""),
                    update_links=bool(args.get("updateLinks", True)),
                    scope=scope,
                )
                return {
                    "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                    "structuredContent": result,
                }
            if name == "save_markdown_asset":
                result = save_markdown_asset(
                    root_dir,
                    args.get("docPath", ""),
                    args.get("filename", ""),
                    args.get("data", ""),
                    scope=scope,
                )
                return {
                    "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                    "structuredContent": result,
                }
            if name == "replace_in_markdown_files":
                result = replace_in_markdown_files(
                    root_dir,
                    args.get("query", ""),
                    args.get("replacement", ""),
                    paths=args.get("paths"),
                    case_sensitive=bool(args.get("caseSensitive", False)),
                    whole_word=bool(args.get("wholeWord", False)),
                    regex=bool(args.get("regex", False)),
                    expected_etags=args.get("expectedEtags"),
                    scope=scope,
                )
                return {
                    "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                    "structuredContent": result,
                }
        except (OSError, ValueError) as exc:
            return _tool_error(str(exc))

        return _tool_error(f"Unknown tool: {name}")

    return None


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if not args or not args[0].strip():
        sys.stderr.write("error: project root directory argument is required\n")
        return 1
    root_dir = os.path.realpath(args[0])
    if not os.path.isdir(root_dir):
        sys.stderr.write(f"error: project root is not a directory: {args[0]}\n")
        return 1

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            sys.stdout.write(json.dumps({
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": "parse error"},
            }) + "\n")
            sys.stdout.flush()
            continue

        if not isinstance(request, dict) or "id" not in request:
            continue

        result = handle_request(request, root_dir)
        reply = {"jsonrpc": "2.0", "id": request["id"]}
        if result is None:
            reply["error"] = {"code": -32601, "message": "method not found"}
        else:
            reply["result"] = result
        sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
