"""Incremental Markdown project index for tags, tasks, wikilinks, and broken links."""

import hashlib
import os
import pathlib
import re

MARKDOWN_EXTENSIONS = {".md", ".markdown", ".mdx"}
SKIP_DIRS = {"node_modules", "_output", "__pycache__", "dist", "build", "target"}
MAX_INDEX_FILE_BYTES = 512 * 1024

WIKILINK_RE = re.compile(r"\[\[([^\[\]]+)\]\]")
MD_LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)\s]+)(?:\s+[\"'][^\"']*[\"'])?\)")
INLINE_CODE_RE = re.compile(r"`+[^`]*`+")
INLINE_TAG_RE = re.compile(r"(?:^|[\s(（])#([a-zA-Z\u4e00-\u9fa5][a-zA-Z0-9_\-/\u4e00-\u9fa5]*)")
TASK_LINE_RE = re.compile(r"^(\s*(?:[-*+]|\d{1,9}[.)])\s+\[)([ xX])(\]\s*)(.*)$")
HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+\s*)?$")
FENCE_RE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")

VALID_TASK_COLORS = {"red", "orange", "amber", "green", "blue", "purple", "pink"}
VALID_PRIORITIES = {"high", "medium", "low"}
VALID_TASK_STATUSES = {"todo", "doing", "review", "done"}
TASK_DUE_RE = re.compile(r"(?:📅\s*|due:|@)(\d{4}-\d{2}-\d{2})\b")
TASK_ASSIGNEE_RE = re.compile(r"(?:^|\s)@([a-zA-Z\u4e00-\u9fa5][a-zA-Z0-9_.\-\u4e00-\u9fa5]*)")
TASK_GROUP_RE = re.compile(r"(?:(?:^|\s)group:([^\s]+)|\[分组:([^\]]+)\])")
TASK_COLOR_RE = re.compile(r"(?:^|\s)color:(red|orange|amber|green|blue|purple|pink)\b", re.IGNORECASE)
TASK_STATUS_RE = re.compile(r"(?:^|\s)status:(todo|doing|review|done)\b", re.IGNORECASE)
TASK_PRIO_RE = re.compile(
    r"(?:^|\s)(?:\[?(P[0-3])\]?|!(高|中|低)|(⏫|🔺|🔼|🔽))(?=\s|$)",
    re.IGNORECASE,
)


def parse_task_metadata(raw_text: str, checked: bool = False) -> dict:
    """Extract priority, due date, assignee, group, color, and workflow status from a Markdown task line."""
    text = str(raw_text or "").strip()
    priority = ""
    due = ""
    assignee = ""
    group = ""
    color = ""
    status = ""

    due_m = TASK_DUE_RE.search(text)
    if due_m:
        due = due_m.group(1)

    prio_m = TASK_PRIO_RE.search(text)
    if prio_m:
        p_code, p_zh, p_emoji = prio_m.group(1), prio_m.group(2), prio_m.group(3)
        if p_code:
            code = p_code.upper()
            priority = "high" if code in ("P0", "P1") else ("medium" if code == "P2" else "low")
        elif p_zh:
            priority = {"高": "high", "中": "medium", "低": "low"}.get(p_zh, "")
        elif p_emoji:
            priority = "high" if p_emoji in ("⏫", "🔺") else ("medium" if p_emoji == "🔼" else "low")

    grp_m = TASK_GROUP_RE.search(text)
    if grp_m:
        group = (grp_m.group(1) or grp_m.group(2) or "").strip()

    col_m = TASK_COLOR_RE.search(text)
    if col_m:
        color = col_m.group(1).lower()

    st_m = TASK_STATUS_RE.search(text)
    if st_m:
        status = st_m.group(1).lower()

    if checked:
        status = "done"
    elif status not in ("todo", "doing", "review"):
        status = "todo"

    # Extract @assignee (avoiding @YYYY-MM-DD dates)
    for m in TASK_ASSIGNEE_RE.finditer(text):
        cand = m.group(1)
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", cand):
            assignee = cand
            break

    clean = text
    clean = TASK_DUE_RE.sub("", clean)
    clean = TASK_PRIO_RE.sub("", clean)
    clean = TASK_GROUP_RE.sub("", clean)
    clean = TASK_COLOR_RE.sub("", clean)
    clean = TASK_STATUS_RE.sub("", clean)
    if assignee:
        clean = re.sub(r"(?:^|\s)@" + re.escape(assignee) + r"(?=\s|$)", "", clean, count=1)
    clean = re.sub(r"\s{2,}", " ", clean).strip()

    return {
        "cleanText": clean or text,
        "priority": priority,
        "due": due,
        "assignee": assignee,
        "group": group,
        "color": color,
        "status": status,
    }


def format_task_metadata(
    raw_text: str,
    priority: str = "",
    due: str = "",
    assignee: str = "",
    group: str = "",
    color: str = "",
    status: str = "",
    clean_text: str = "",
) -> str:
    """Rewrite task metadata tokens cleanly while preserving or replacing the base task text."""
    base = clean_text.strip() if isinstance(clean_text, str) and clean_text.strip() else parse_task_metadata(raw_text)["cleanText"]
    parts = [base] if base else []

    p = str(priority or "").strip().lower()
    if p in VALID_PRIORITIES:
        parts.append({"high": "P1", "medium": "P2", "low": "P3"}[p])

    d = str(due or "").strip()
    if re.match(r"^\d{4}-\d{2}-\d{2}$", d):
        parts.append(f"📅 {d}")

    a = str(assignee or "").strip().lstrip("@")
    if a and not re.search(r"[\s\x00-\x1f\x7f]", a):
        parts.append(f"@{a}")

    g = str(group or "").strip()
    if g and not re.search(r"[\s\x00-\x1f\x7f]", g):
        parts.append(f"group:{g}")

    c = str(color or "").strip().lower()
    if c in VALID_TASK_COLORS:
        parts.append(f"color:{c}")

    st = str(status or "").strip().lower()
    if st in ("doing", "review"):
        parts.append(f"status:{st}")

    return " ".join(parts).strip()


def _is_within_root(root_real: str, target_real: str) -> bool:
    try:
        return os.path.commonpath([root_real, target_real]) == root_real
    except ValueError:
        return False


def _strip_ext(posix_path: str) -> str:
    for ext in MARKDOWN_EXTENSIONS:
        if posix_path.lower().endswith(ext):
            return posix_path[: -len(ext)]
    return posix_path


def _parse_frontmatter_tags(lines: list[str]) -> tuple[list[str], int]:
    if not lines or lines[0].strip() != "---":
        return [], 0
    end_idx = -1
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end_idx = i
            break
    if end_idx == -1:
        return [], 0

    tags = []
    in_tags_list = False
    for line in lines[1:end_idx]:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if in_tags_list and line.startswith((" ", "\t")) and stripped.startswith("- "):
            val = stripped[2:].strip().strip("\"'").lstrip("#")
            if val:
                tags.append(val)
            continue
        in_tags_list = False
        kv = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if kv and kv.group(1).lower() in ("tags", "tag"):
            raw_val = kv.group(2).strip()
            if raw_val.startswith("[") and raw_val.endswith("]"):
                for item in raw_val[1:-1].split(","):
                    clean = item.strip().strip("\"'").lstrip("#")
                    if clean:
                        tags.append(clean)
            elif raw_val == "":
                in_tags_list = True
            else:
                clean = raw_val.strip("\"'").lstrip("#")
                if clean:
                    tags.append(clean)

    return tags, end_idx + 1


def _extract_file_data(rel_path: str, raw: bytes, mtime_ns: int, size: int) -> dict:
    etag = hashlib.sha256(raw).hexdigest()[:16]
    text = raw.decode("utf-8")
    lines = text.splitlines()

    fm_tags, start_idx = _parse_frontmatter_tags(lines)
    tags = set(fm_tags)
    tasks = []
    wikilinks = []
    md_links = []

    current_heading = ""
    line_headings = [""] * len(lines)
    fence_char = ""
    fence_len = 0

    for idx in range(start_idx, len(lines)):
        line = lines[idx]
        lineno = idx + 1

        fence_match = FENCE_RE.match(line)
        if fence_match:
            marker = fence_match.group(1)
            if not fence_char:
                fence_char = marker[0]
                fence_len = len(marker)
                line_headings[idx] = current_heading
                continue
            if marker[0] == fence_char and len(marker) >= fence_len and line.strip() == marker:
                fence_char = ""
                fence_len = 0
                line_headings[idx] = current_heading
                continue
        if fence_char:
            line_headings[idx] = current_heading
            continue

        h_match = HEADING_RE.match(line)
        if h_match:
            current_heading = h_match.group(1).strip()
        line_headings[idx] = current_heading

        task_match = TASK_LINE_RE.match(line)
        if task_match:
            raw_task_text = task_match.group(4).strip()
            is_checked = task_match.group(2).lower() == "x"
            indent = len(task_match.group(1).expandtabs(2)) - len(task_match.group(1).lstrip(" \t").expandtabs(2))
            meta = parse_task_metadata(raw_task_text, checked=is_checked)
            tasks.append({
                "path": rel_path,
                "line": lineno,
                "indent": indent,
                "checked": is_checked,
                "status": meta["status"],
                "text": raw_task_text,
                "cleanText": meta["cleanText"],
                "priority": meta["priority"],
                "due": meta["due"],
                "assignee": meta["assignee"],
                "group": meta["group"],
                "color": meta["color"],
                "heading": current_heading,
                "etag": etag,
                "subtasksTotal": 0,
                "subtasksDone": 0,
                "subtasks": [],
            })

        # Strip inline code before scanning tags and links
        no_code = INLINE_CODE_RE.sub(" ", line)
        for tag_match in INLINE_TAG_RE.finditer(no_code):
            tags.add(tag_match.group(1))

        for raw_wiki in WIKILINK_RE.findall(no_code):
            target_part = raw_wiki.split("|", 1)[0].split("#", 1)[0].strip().replace("\\", "/")
            if target_part:
                wikilinks.append({"line": lineno, "raw": raw_wiki, "target": target_part})

        for match in MD_LINK_RE.finditer(no_code):
            is_image = match.group(0).startswith("!")
            if is_image:
                continue
            href = match.group(1).split("#", 1)[0].split("?", 1)[0].strip()
            if not href or re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", href):
                continue
            if os.path.splitext(href)[1].lower() in MARKDOWN_EXTENSIONS:
                md_links.append({"line": lineno, "raw": match.group(1), "href": href})

    # Aggregate indented subtasks onto their nearest parent task
    stack: list[dict] = []
    for t in tasks:
        while stack and stack[-1]["indent"] >= t["indent"]:
            stack.pop()
        if stack:
            parent = stack[-1]
            parent["subtasksTotal"] += 1
            if t["checked"]:
                parent["subtasksDone"] += 1
            parent["subtasks"].append({
                "line": t["line"],
                "checked": t["checked"],
                "cleanText": t["cleanText"],
            })
        stack.append(t)

    return {
        "path": rel_path,
        "mtimeNs": mtime_ns,
        "size": size,
        "etag": etag,
        "tags": sorted(tags),
        "tasks": tasks,
        "wikilinks": wikilinks,
        "mdLinks": md_links,
        "lines": lines,
        "lineHeadings": line_headings,
    }


class ProjectIndex:
    """Incremental project index keyed by relative POSIX path."""

    def __init__(self):
        self._entries: dict[str, dict] = {}
        self._root: str = ""
        self._multi: dict[str, "ProjectIndex"] = {}

    def refresh_multi(self, workspace_roots: dict[str, str]) -> dict[str, dict]:
        """Refresh and merge incremental indexes across multiple named workspace directories."""
        merged: dict[str, dict] = {}
        active_names = set(workspace_roots.keys())
        for stale in list(self._multi.keys()):
            if stale not in active_names:
                del self._multi[stale]

        for ws_name, ws_real in workspace_roots.items():
            sub = self._multi.get(ws_name)
            if sub is None:
                sub = ProjectIndex()
                self._multi[ws_name] = sub
            sub_entries = sub.refresh(ws_real)
            for rel_path, entry in sub_entries.items():
                ns_path = f"{ws_name}/{rel_path}"
                ns_tasks = [
                    {**t, "path": ns_path, "workspace": ws_name}
                    for t in entry["tasks"]
                ]
                merged[ns_path] = {
                    **entry,
                    "path": ns_path,
                    "workspace": ws_name,
                    "tasks": ns_tasks,
                }
        return merged

    def refresh(self, root_real: str) -> dict[str, dict]:
        if self._root != root_real:
            self._entries.clear()
            self._root = root_real

        seen: set[str] = set()
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
                if os.path.splitext(fname)[1].lower() not in MARKDOWN_EXTENSIONS:
                    continue
                full_file = os.path.join(current_root, fname)
                if os.path.islink(full_file):
                    resolved = os.path.realpath(full_file)
                    if not _is_within_root(root_real, resolved) or not os.path.isfile(resolved):
                        continue
                try:
                    st = os.stat(full_file)
                except OSError:
                    continue
                if not os.path.isfile(full_file) or st.st_size > MAX_INDEX_FILE_BYTES:
                    continue

                rel_path = pathlib.PurePosixPath(
                    *pathlib.Path(os.path.relpath(full_file, root_real)).parts
                ).as_posix()
                seen.add(rel_path)

                prev = self._entries.get(rel_path)
                if prev and prev["mtimeNs"] == st.st_mtime_ns and prev["size"] == st.st_size:
                    continue

                try:
                    with open(full_file, "rb") as handle:
                        raw = handle.read()
                    if b"\x00" in raw:
                        self._entries.pop(rel_path, None)
                        continue
                    self._entries[rel_path] = _extract_file_data(rel_path, raw, st.st_mtime_ns, st.st_size)
                except (OSError, UnicodeDecodeError):
                    self._entries.pop(rel_path, None)

        for stale in list(self._entries.keys()):
            if stale not in seen:
                del self._entries[stale]

        return self._entries


def summarize_tags(entries: dict[str, dict]) -> dict:
    tag_map: dict[str, list[str]] = {}
    for rel_path in sorted(entries.keys()):
        for tag in entries[rel_path]["tags"]:
            tag_map.setdefault(tag, []).append(rel_path)

    tags = [
        {"name": name, "count": len(files), "files": files}
        for name, files in tag_map.items()
    ]
    tags.sort(key=lambda item: (-item["count"], item["name"].lower()))
    return {"tags": tags, "totalFiles": len(entries)}


def summarize_tasks(
    entries: dict[str, dict],
    status: str = "all",
    path_prefix: str = "",
    limit: int = 500,
) -> dict:
    if limit is None:
        limit = 500
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
        raise ValueError("Parameter 'limit' must be a positive integer.")
    limit = min(limit, 1000)
    prefix = path_prefix.strip().lstrip("./")
    tasks = []
    truncated = False

    for rel_path in sorted(entries.keys()):
        if prefix and not rel_path.startswith(prefix):
            continue
        for task in entries[rel_path]["tasks"]:
            if status == "open" and task["checked"]:
                continue
            if status == "done" and not task["checked"]:
                continue
            if len(tasks) >= limit:
                truncated = True
                break
            tasks.append(task)
        if truncated:
            break

    return {"tasks": tasks, "total": len(tasks), "truncated": truncated}


def inspect_links(entries: dict[str, dict]) -> dict:
    all_paths = set(entries.keys())
    lower_paths = {p.lower(): p for p in all_paths}
    lower_no_ext = {_strip_ext(p).lower(): p for p in all_paths}
    stem_map: dict[str, list[str]] = {}
    for p in sorted(all_paths):
        stem = pathlib.PurePosixPath(_strip_ext(p)).name.lower()
        stem_map.setdefault(stem, []).append(p)

    ambiguous_targets = [
        {"key": key, "candidates": candidates}
        for key, candidates in sorted(stem_map.items())
        if len(candidates) >= 2
    ]

    broken_links = []
    for src_path in sorted(all_paths):
        entry = entries[src_path]
        src_dir = pathlib.PurePosixPath(src_path).parent

        for wl in entry["wikilinks"]:
            clean = wl["target"].lstrip("./").lower()
            no_ext = _strip_ext(clean)
            matched = (
                clean in lower_paths
                or no_ext in lower_no_ext
                or no_ext in stem_map
            )
            if not matched:
                broken_links.append({
                    "sourcePath": src_path,
                    "line": wl["line"],
                    "rawTarget": wl["raw"],
                    "kind": "wikilink",
                })

        for ml in entry["mdLinks"]:
            resolved = os.path.normpath(os.path.join(str(src_dir), ml["href"])).replace("\\", "/")
            if resolved not in all_paths:
                broken_links.append({
                    "sourcePath": src_path,
                    "line": ml["line"],
                    "rawTarget": ml["raw"],
                    "kind": "markdown",
                })

    return {"brokenLinks": broken_links, "ambiguousTargets": ambiguous_targets}


def build_project_graph(entries: dict[str, dict]) -> dict:
    """Build a directed document link graph (nodes + edges) from indexed Markdown files."""
    all_paths = sorted(entries.keys())
    all_set = set(all_paths)
    lower_paths = {p.lower(): p for p in all_paths}
    lower_no_ext = {_strip_ext(p).lower(): p for p in all_paths}
    stem_map: dict[str, list[str]] = {}
    for p in all_paths:
        stem = pathlib.PurePosixPath(_strip_ext(p)).name.lower()
        stem_map.setdefault(stem, []).append(p)

    nodes_map: dict[str, dict] = {}
    for p in all_paths:
        parts = p.split("/")
        top_dir = parts[0] if len(parts) > 1 else "(root)"
        stem = pathlib.PurePosixPath(_strip_ext(p)).name
        if stem.lower() in {"readme", "index"} and len(parts) >= 2:
            label = f"{parts[-2]}/{stem}"
        else:
            label = stem
        entry_tasks = entries[p]["tasks"]
        open_tasks = sum(1 for t in entry_tasks if not t.get("checked"))
        nodes_map[p] = {
            "id": p,
            "label": label,
            "dir": top_dir,
            "tags": entries[p]["tags"],
            "tasksOpen": open_tasks,
            "tasksTotal": len(entry_tasks),
            "bytes": entries[p]["size"],
            "inDegree": 0,
            "outDegree": 0,
            "degree": 0,
            "isGhost": False,
        }

    edges = []
    seen_edges: set[tuple[str, str, str]] = set()

    def add_edge(src: str, dst: str, kind: str, broken: bool = False):
        if src == dst:
            return
        key = (src, dst, kind)
        if key in seen_edges:
            return
        seen_edges.add(key)
        edges.append({"source": src, "target": dst, "kind": kind, "broken": broken})
        nodes_map[src]["outDegree"] += 1
        nodes_map[dst]["inDegree"] += 1

    for src_path in all_paths:
        entry = entries[src_path]
        src_dir = pathlib.PurePosixPath(src_path).parent

        for wl in entry["wikilinks"]:
            clean = wl["target"].lstrip("./").lower()
            no_ext = _strip_ext(clean)
            targets = []
            if clean in lower_paths:
                targets = [lower_paths[clean]]
            elif no_ext in lower_no_ext:
                targets = [lower_no_ext[no_ext]]
            elif no_ext in stem_map:
                targets = stem_map[no_ext]

            if targets:
                for dst in targets:
                    add_edge(src_path, dst, "wikilink", broken=False)
            else:
                ghost_id = f"ghost::{wl['target']}"
                if ghost_id not in nodes_map:
                    nodes_map[ghost_id] = {
                        "id": ghost_id,
                        "label": wl["target"],
                        "dir": "(unresolved)",
                        "tags": [],
                        "inDegree": 0,
                        "outDegree": 0,
                        "degree": 0,
                        "isGhost": True,
                    }
                add_edge(src_path, ghost_id, "wikilink", broken=True)

        for ml in entry["mdLinks"]:
            resolved = os.path.normpath(os.path.join(str(src_dir), ml["href"])).replace("\\", "/")
            if resolved in all_set:
                add_edge(src_path, resolved, "markdown", broken=False)

    nodes = []
    for node in nodes_map.values():
        node["degree"] = node["inDegree"] + node["outDegree"]
        nodes.append(node)
    nodes.sort(key=lambda n: (n["isGhost"], -n["degree"], n["id"]))

    return {"nodes": nodes, "edges": edges}


QUERY_TOKEN_RE = re.compile(r'(-?(?:path|tag|heading):(?:"[^"]+"|\S+)|-"[^"]+"|"[^"]+"|\S+)', re.IGNORECASE)


def parse_search_query(query: str, regex: bool = False) -> dict:
    """Parse search query into positive/excluded terms and inline path:/tag:/heading: operators."""
    stripped = (query or "").strip()
    if regex:
        return {
            "mode": "regex",
            "raw": stripped,
            "terms": [stripped] if stripped else [],
            "excludeTerms": [],
            "includePaths": [],
            "excludePaths": [],
            "tags": [],
            "headings": [],
        }

    terms: list[str] = []
    exclude_terms: list[str] = []
    include_paths: list[str] = []
    exclude_paths: list[str] = []
    tags: list[str] = []
    headings: list[str] = []

    def unquote(s: str) -> str:
        if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
            return s[1:-1]
        return s

    for m in QUERY_TOKEN_RE.finditer(stripped):
        tok = m.group(1)
        low = tok.lower()
        if low.startswith("-path:"):
            val = unquote(tok[6:]).strip()
            if val:
                exclude_paths.append(val.lower())
        elif low.startswith("path:"):
            val = unquote(tok[5:]).strip()
            if val:
                include_paths.append(val.lower())
        elif low.startswith("tag:"):
            val = unquote(tok[4:]).strip().lstrip("#")
            if val:
                tags.append(val.lower())
        elif low.startswith("heading:"):
            val = unquote(tok[8:]).strip()
            if val:
                headings.append(val)
        elif tok.startswith("-") and len(tok) > 1:
            val = unquote(tok[1:]).strip()
            if val:
                exclude_terms.append(val)
        else:
            val = unquote(tok).strip()
            if val:
                terms.append(val)

    return {
        "mode": "text",
        "raw": stripped,
        "terms": terms,
        "excludeTerms": exclude_terms,
        "includePaths": include_paths,
        "excludePaths": exclude_paths,
        "tags": tags,
        "headings": headings,
    }


def _compile_term_pattern(term: str, case_sensitive: bool, whole_word: bool, is_regex: bool) -> re.Pattern:
    flags = 0 if case_sensitive else re.IGNORECASE
    if is_regex:
        try:
            compiled = re.compile(term, flags)
        except re.error as exc:
            raise ValueError(f"Invalid regular expression: {exc}") from exc
        if compiled.search("") is not None and not term.strip("^$"):
            raise ValueError("Regular expression matches empty strings; please narrow the pattern.")
        return compiled
    escaped = re.escape(term)
    if whole_word:
        escaped = rf"(?<![A-Za-z0-9_]){escaped}(?![A-Za-z0-9_])"
    return re.compile(escaped, flags)


def _merge_ranges(ranges: list[tuple[int, int]]) -> list[list[int]]:
    if not ranges:
        return []
    ordered = sorted(ranges, key=lambda r: (r[0], r[1]))
    merged: list[list[int]] = [[ordered[0][0], ordered[0][1]]]
    for s, e in ordered[1:]:
        if s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return merged


def _center_snippet(line: str, ranges: list[list[int]], max_len: int = 152) -> tuple[str, list[list[int]]]:
    """Slice a long line centered around the first match and remap highlight ranges."""
    stripped_lead = len(line) - len(line.lstrip())
    trimmed = line.strip()
    if not trimmed:
        return "", []
    shifted = []
    for s, e in ranges:
        ns = max(0, s - stripped_lead)
        ne = min(len(trimmed), e - stripped_lead)
        if ne > ns:
            shifted.append([ns, ne])

    if len(trimmed) <= max_len or not shifted:
        return trimmed[:max_len], [r for r in shifted if r[0] < max_len]

    first_s, first_e = shifted[0]
    lead_ctx = min(44, max(16, (max_len - (first_e - first_s)) // 3))
    win_start = max(0, first_s - lead_ctx)
    win_end = min(len(trimmed), win_start + max_len)
    if win_end - win_start < max_len:
        win_start = max(0, win_end - max_len)

    prefix = "…" if win_start > 0 else ""
    suffix = "…" if win_end < len(trimmed) else ""
    snippet = prefix + trimmed[win_start:win_end] + suffix
    offset = len(prefix) - win_start
    remapped = []
    for s, e in shifted:
        rs = max(len(prefix), s + offset)
        re_ = min(len(prefix) + (win_end - win_start), e + offset)
        if re_ > rs:
            remapped.append([rs, re_])
    return snippet, remapped


def filter_entries_by_scope(
    entries: dict[str, dict],
    path_prefix: str = "",
    tags: list[str] | None = None,
    include_paths: list[str] | None = None,
    exclude_paths: list[str] | None = None,
) -> dict[str, dict]:
    """Filter indexed Markdown entries by shared search/replace path prefix, path tokens, and tags."""
    norm_prefix = (path_prefix or "").strip().lstrip("./").lower()
    required_tags = {t.strip().lstrip("#").lower() for t in (tags or []) if isinstance(t, str) and t.strip()}
    inc_paths = [p.strip().lower() for p in (include_paths or []) if isinstance(p, str) and p.strip()]
    exc_paths = [p.strip().lower() for p in (exclude_paths or []) if isinstance(p, str) and p.strip()]

    filtered: dict[str, dict] = {}
    for rel_path, entry in entries.items():
        low_path = rel_path.lower()
        if norm_prefix and not low_path.startswith(norm_prefix):
            continue
        if inc_paths and not all(inc in low_path for inc in inc_paths):
            continue
        if exc_paths and any(exc in low_path for exc in exc_paths):
            continue
        if required_tags:
            entry_tags = {t.lower() for t in entry.get("tags", [])}
            if not required_tags.issubset(entry_tags):
                continue
        filtered[rel_path] = entry
    return filtered


def search_entries(
    entries: dict[str, dict],
    query: str,
    limit: int = 80,
    tags: list[str] | None = None,
    case_sensitive: bool = False,
    whole_word: bool = False,
    regex: bool = False,
    path_prefix: str = "",
    sort_by: str = "relevance",
    include_context: bool = False,
    max_per_file: int = 25,
) -> dict:
    """In-memory full-text search across indexed Markdown files with operators, scoring, and grouping."""
    parsed = parse_search_query(query, regex=regex)
    pos_patterns = [
        _compile_term_pattern(t, case_sensitive, whole_word, regex)
        for t in parsed["terms"]
    ]
    exc_patterns = [
        _compile_term_pattern(t, case_sensitive, whole_word, False)
        for t in parsed["excludeTerms"]
    ]
    heading_patterns = [
        _compile_term_pattern(h, case_sensitive, False, False)
        for h in parsed["headings"]
    ]

    required_tags = {t.strip().lstrip("#").lower() for t in (tags or []) if isinstance(t, str) and t.strip()}
    required_tags.update(parsed["tags"])

    if sort_by not in {"relevance", "matches", "path", "mtime"}:
        sort_by = "relevance"

    scoped_entries = filter_entries_by_scope(
        entries,
        path_prefix=path_prefix,
        tags=list(required_tags),
        include_paths=parsed["includePaths"],
        exclude_paths=parsed["excludePaths"],
    )

    matched_files = []
    total_matches_all = 0

    for rel_path, entry in scoped_entries.items():

        lines = entry.get("lines", [])
        line_headings = entry.get("lineHeadings", [])
        full_text = "\n".join(lines)

        if exc_patterns and any(ep.search(full_text) for ep in exc_patterns):
            continue

        # Operator-only query (e.g. "path:docs/ tag:obsidian") matches files directly
        if not pos_patterns and not heading_patterns:
            matched_files.append({
                "path": rel_path,
                "matchCount": 1,
                "score": 10,
                "mtimeNs": entry.get("mtimeNs", 0),
                "tags": entry.get("tags", []),
                "hits": [{
                    "path": rel_path,
                    "line": 0,
                    "column": 0,
                    "matchLength": 0,
                    "snippet": rel_path,
                    "matchRanges": [],
                    "heading": "",
                    "isHeading": False,
                    "contextBefore": "",
                    "contextAfter": "",
                }],
            })
            total_matches_all += 1
            continue

        # Verify all positive terms exist in either file text or path (multi-term AND)
        if pos_patterns:
            if not all(p.search(full_text) or p.search(rel_path) for p in pos_patterns):
                continue

        file_hits = []
        file_match_count = 0
        score = 0
        path_matched = any(p.search(rel_path) for p in pos_patterns) if pos_patterns else False
        if path_matched:
            score += 14

        for idx, line in enumerate(lines):
            enclosing_h = line_headings[idx] if idx < len(line_headings) else ""
            is_heading_line = bool(HEADING_RE.match(line))

            if heading_patterns:
                heading_hay = enclosing_h or (line if is_heading_line else "")
                if not all(hp.search(heading_hay) for hp in heading_patterns):
                    continue

            active_patterns = pos_patterns if pos_patterns else heading_patterns
            ranges: list[tuple[int, int]] = []
            matched_term_count = 0
            for pat in active_patterns:
                term_hit = False
                for m in pat.finditer(line):
                    if m.end() > m.start():
                        ranges.append((m.start(), m.end()))
                        term_hit = True
                    if len(ranges) >= 24:
                        break
                if term_hit:
                    matched_term_count += 1

            if not ranges:
                continue

            file_match_count += 1
            if is_heading_line:
                score += 8
            elif matched_term_count > 1:
                score += 4
            elif file_match_count <= 15:
                score += 2

            if len(file_hits) < max_per_file:
                merged = _merge_ranges(ranges)
                snippet, remapped = _center_snippet(line, merged)
                ctx_before = lines[idx - 1].strip()[:120] if (include_context and idx > 0) else ""
                ctx_after = lines[idx + 1].strip()[:120] if (include_context and idx + 1 < len(lines)) else ""
                first_col = merged[0][0] + 1
                first_len = merged[0][1] - merged[0][0]
                file_hits.append({
                    "path": rel_path,
                    "line": idx + 1,
                    "column": first_col,
                    "matchLength": first_len,
                    "snippet": snippet,
                    "matchRanges": remapped,
                    "heading": enclosing_h,
                    "isHeading": is_heading_line,
                    "contextBefore": ctx_before,
                    "contextAfter": ctx_after,
                })

        if file_match_count == 0 and path_matched and not heading_patterns:
            file_match_count = 1
            file_hits.append({
                "path": rel_path,
                "line": 0,
                "column": 0,
                "matchLength": 0,
                "snippet": rel_path,
                "matchRanges": [],
                "heading": "",
                "isHeading": False,
                "contextBefore": "",
                "contextAfter": "",
            })

        if file_hits:
            matched_files.append({
                "path": rel_path,
                "matchCount": file_match_count,
                "score": score,
                "mtimeNs": entry.get("mtimeNs", 0),
                "tags": entry.get("tags", []),
                "hits": file_hits,
            })
            total_matches_all += file_match_count

    if sort_by == "matches":
        matched_files.sort(key=lambda f: (-f["matchCount"], -f["score"], f["path"]))
    elif sort_by == "mtime":
        matched_files.sort(key=lambda f: (-f["mtimeNs"], -f["score"], f["path"]))
    elif sort_by == "path":
        matched_files.sort(key=lambda f: f["path"])
    else:
        matched_files.sort(key=lambda f: (-f["score"], -f["matchCount"], f["path"]))

    flat_matches = []
    grouped_files = []
    truncated = False
    for f in matched_files:
        remaining = limit - len(flat_matches)
        if remaining <= 0:
            truncated = True
            break
        kept_hits = f["hits"][:remaining]
        if len(kept_hits) < f["matchCount"]:
            truncated = True
        flat_matches.extend(kept_hits)
        grouped_files.append({
            "path": f["path"],
            "matchCount": f["matchCount"],
            "score": f["score"],
            "mtimeNs": f["mtimeNs"],
            "tags": f["tags"],
            "hits": kept_hits,
        })

    return {
        "query": parsed["raw"],
        "matches": flat_matches,
        "files": grouped_files,
        "totalFilesMatched": len(matched_files),
        "totalMatches": total_matches_all,
        "truncated": truncated,
        "parsed": {
            "mode": parsed["mode"],
            "terms": parsed["terms"],
            "excludeTerms": parsed["excludeTerms"],
            "includePaths": parsed["includePaths"],
            "excludePaths": parsed["excludePaths"],
            "tags": sorted(required_tags),
            "headings": parsed["headings"],
        },
    }
