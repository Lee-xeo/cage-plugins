/**
 * Offline Obsidian-style Dataview query engine (`TASK`, `TABLE`, `LIST`).
 * Operates purely in memory over project files and tasks without dynamic code execution.
 */

function stripQuotes(str) {
  return String(str || "").trim().replace(/^["']|["']$/g, "");
}

function parseCondition(expr) {
  const clean = expr.trim();
  if (!clean) return null;
  let m = clean.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(!=|>=|<=|=|>|<|contains)\s+(.+)$/i);
  if (m) {
    return {
      field: m[1].toLowerCase(),
      op: m[2].toLowerCase(),
      value: stripQuotes(m[3]),
    };
  }
  return { field: "text", op: "contains", value: stripQuotes(clean) };
}

/**
 * Parse a concise Dataview query string into structured clauses.
 */
export function parseDataviewQuery(queryText) {
  const lines = String(queryText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//"));

  if (lines.length === 0) {
    return { error: "Dataview 查询不能为空。示例：TASK WHERE priority = \"high\"" };
  }

  const headerLine = lines[0];
  let mode = "";
  let columns = [];
  if (/^TASK\b/i.test(headerLine)) {
    mode = "task";
  } else if (/^LIST\b/i.test(headerLine)) {
    mode = "list";
  } else if (/^TABLE\b/i.test(headerLine)) {
    mode = "table";
    const colStr = headerLine.replace(/^TABLE\b/i, "").trim();
    columns = colStr
      ? colStr.split(",").map((c) => c.trim()).filter(Boolean)
      : ["path", "bytes", "mtime"];
  } else {
    return { error: `暂不支持的查询类型：${headerLine}（支持 TABLE / TASK / LIST）` };
  }

  const parsed = {
    mode,
    columns,
    fromPath: "",
    fromTag: "",
    whereClauses: [],
    whereJoin: "and",
    sortField: "",
    sortDir: "asc",
    limit: 50,
    error: "",
  };

  for (const line of lines.slice(1)) {
    if (/^FROM\s+/i.test(line)) {
      const target = line.replace(/^FROM\s+/i, "").trim();
      if (target.startsWith("#")) parsed.fromTag = target.slice(1).toLowerCase();
      else parsed.fromPath = stripQuotes(target).replace(/^\/+/, "");
    } else if (/^WHERE\s+/i.test(line)) {
      const expr = line.replace(/^WHERE\s+/i, "").trim();
      if (/\s+OR\s+/i.test(expr)) {
        parsed.whereJoin = "or";
        parsed.whereClauses.push(...expr.split(/\s+OR\s+/i).map(parseCondition).filter(Boolean));
      } else {
        parsed.whereJoin = "and";
        parsed.whereClauses.push(...expr.split(/\s+AND\s+/i).map(parseCondition).filter(Boolean));
      }
    } else if (/^SORT\s+/i.test(line)) {
      const m = line.replace(/^SORT\s+/i, "").trim().match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s+(ASC|DESC))?$/i);
      if (m) {
        parsed.sortField = m[1].toLowerCase();
        parsed.sortDir = (m[2] || "asc").toLowerCase();
      }
    } else if (/^LIMIT\s+(\d+)/i.test(line)) {
      parsed.limit = Math.max(1, Math.min(200, Number.parseInt(line.match(/^LIMIT\s+(\d+)/i)[1], 10)));
    }
  }

  return parsed;
}

function getFieldValue(row, field) {
  if (!row) return "";
  if (field === "file" || field === "name") return row.path ? row.path.split("/").pop() : "";
  if (field === "task" || field === "title") return row.cleanText || row.text || "";
  if (field in row) return row[field];
  return "";
}

function matchCondition(row, cond) {
  const actualRaw = getFieldValue(row, cond.field);
  const actualStr = String(actualRaw ?? "").toLowerCase();
  const targetStr = String(cond.value ?? "").toLowerCase();

  if (cond.op === "=") return actualStr === targetStr;
  if (cond.op === "!=") return actualStr !== targetStr;
  if (cond.op === "contains") return actualStr.includes(targetStr);

  const aNum = Number(actualRaw);
  const bNum = Number(cond.value);
  if (Number.isFinite(aNum) && Number.isFinite(bNum) && cond.value !== "") {
    if (cond.op === ">") return aNum > bNum;
    if (cond.op === "<") return aNum < bNum;
    if (cond.op === ">=") return aNum >= bNum;
    if (cond.op === "<=") return aNum <= bNum;
  }
  if (cond.op === ">") return actualStr > targetStr;
  if (cond.op === "<") return actualStr < targetStr;
  if (cond.op === ">=") return actualStr >= targetStr;
  if (cond.op === "<=") return actualStr <= targetStr;
  return false;
}

/**
 * Evaluate a parsed Dataview query against project files, tasks, and tag maps.
 */
export function evaluateDataviewQuery(queryText, dataContext = {}) {
  const q = parseDataviewQuery(queryText);
  if (q.error) return { mode: "error", columns: [], rows: [], totalMatched: 0, error: q.error };

  const files = Array.isArray(dataContext.files) ? dataContext.files : [];
  const tasks = Array.isArray(dataContext.tasks) ? dataContext.tasks : [];
  const tagFilesMap = dataContext.tagFilesMap || new Map();

  let pool;
  if (q.mode === "task") {
    pool = tasks.map((t) => ({ ...t }));
  } else {
    const taskCountByPath = new Map();
    const openCountByPath = new Map();
    for (const t of tasks) {
      taskCountByPath.set(t.path, (taskCountByPath.get(t.path) || 0) + 1);
      if (!t.checked && t.status !== "done") {
        openCountByPath.set(t.path, (openCountByPath.get(t.path) || 0) + 1);
      }
    }
    pool = files.map((f) => ({
      ...f,
      tasksTotal: taskCountByPath.get(f.path) || 0,
      tasksOpen: openCountByPath.get(f.path) || 0,
      tags: [...(tagFilesMap.get(f.path) || [])],
    }));
  }

  if (q.fromPath) {
    const pref = q.fromPath.toLowerCase();
    pool = pool.filter((r) => String(r.path || "").toLowerCase().includes(pref));
  }
  if (q.fromTag) {
    pool = pool.filter((r) => {
      const tagged = tagFilesMap.get(r.path);
      if (tagged && tagged.has(q.fromTag)) return true;
      return String(r.text || "").toLowerCase().includes(`#${q.fromTag}`);
    });
  }

  if (q.whereClauses.length > 0) {
    pool = pool.filter((row) =>
      q.whereJoin === "or"
        ? q.whereClauses.some((c) => matchCondition(row, c))
        : q.whereClauses.every((c) => matchCondition(row, c)),
    );
  }

  if (q.sortField) {
    const factor = q.sortDir === "desc" ? -1 : 1;
    pool.sort((a, b) => {
      const av = getFieldValue(a, q.sortField);
      const bv = getFieldValue(b, q.sortField);
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * factor;
      return String(av ?? "").localeCompare(String(bv ?? "")) * factor;
    });
  }

  const totalMatched = pool.length;
  const rows = pool.slice(0, q.limit);
  return {
    mode: q.mode,
    columns: q.columns,
    rows,
    totalMatched,
    error: "",
  };
}

function formatCellValue(col, val) {
  if (Array.isArray(val)) return val.map((v) => `#${v}`).join(" ");
  if (col.toLowerCase() === "mtime" && typeof val === "number" && val > 0) {
    return new Date(val * 1000).toISOString().slice(0, 10);
  }
  if (col.toLowerCase() === "bytes" && typeof val === "number") {
    return val < 1024 ? `${val} B` : `${(val / 1024).toFixed(1)} KB`;
  }
  return String(val ?? "—");
}

/**
 * Render an evaluated Dataview query directly into `hostEl` using pure DOM.
 */
export function renderDataviewBlock(doc, hostEl, queryText, dataContext, options = {}) {
  while (hostEl.firstChild) hostEl.removeChild(hostEl.firstChild);
  const res = evaluateDataviewQuery(queryText, dataContext);

  const card = doc.createElement("section");
  card.className = "md-dataview-card";

  const head = doc.createElement("div");
  head.className = "md-dataview-head";
  const badge = doc.createElement("span");
  badge.className = "md-dataview-badge";
  badge.textContent = `📊 Dataview · ${res.error ? "语法提示" : `${res.mode.toUpperCase()} (${res.totalMatched})`}`;
  head.appendChild(badge);
  card.appendChild(head);

  if (res.error) {
    const err = doc.createElement("div");
    err.className = "md-dataview-empty";
    err.textContent = res.error;
    card.appendChild(err);
    hostEl.appendChild(card);
    return res;
  }

  if (res.rows.length === 0) {
    const empty = doc.createElement("div");
    empty.className = "md-dataview-empty";
    empty.textContent = "没有匹配该查询条件的记录。";
    card.appendChild(empty);
    hostEl.appendChild(card);
    return res;
  }

  if (res.mode === "table") {
    const wrap = doc.createElement("div");
    wrap.className = "md-dataview-table-wrap";
    const table = doc.createElement("table");
    table.className = "md-dataview-table";
    const thead = doc.createElement("thead");
    const trHead = doc.createElement("tr");
    const cols = ["path", ...res.columns.filter((c) => c.toLowerCase() !== "path")];
    for (const col of cols) {
      const th = doc.createElement("th");
      th.textContent = col;
      trHead.appendChild(th);
    }
    thead.appendChild(trHead);
    table.appendChild(thead);

    const tbody = doc.createElement("tbody");
    for (const row of res.rows) {
      const tr = doc.createElement("tr");
      for (const col of cols) {
        const td = doc.createElement("td");
        const val = getFieldValue(row, col.toLowerCase());
        if (col.toLowerCase() === "path" && typeof options.onOpenFile === "function") {
          const link = doc.createElement("button");
          link.type = "button";
          link.className = "md-dataview-link";
          link.textContent = String(val || row.path);
          link.addEventListener("click", () => options.onOpenFile(row.path, 0));
          td.appendChild(link);
        } else {
          td.textContent = formatCellValue(col, val);
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    card.appendChild(wrap);
  } else if (res.mode === "task") {
    const ul = doc.createElement("ul");
    ul.className = "md-dataview-tasks";
    for (const task of res.rows) {
      const li = doc.createElement("li");
      li.className = "md-dataview-task-item";
      const cb = doc.createElement("input");
      cb.type = "checkbox";
      cb.checked = Boolean(task.checked || task.status === "done");
      if (typeof options.onToggleTask === "function") {
        cb.addEventListener("change", () => options.onToggleTask(task, cb.checked, cb));
      } else {
        cb.disabled = true;
      }
      li.appendChild(cb);

      const title = doc.createElement("span");
      title.className = cb.checked ? "md-dataview-task-done" : "";
      title.textContent = task.cleanText || task.text;
      li.appendChild(title);

      if (task.priority || task.due || task.assignee) {
        const meta = doc.createElement("span");
        meta.className = "md-dataview-meta";
        const parts = [];
        if (task.priority) parts.push(task.priority.toUpperCase());
        if (task.due) parts.push(`📅 ${task.due}`);
        if (task.assignee) parts.push(`@${task.assignee}`);
        meta.textContent = parts.join(" · ");
        li.appendChild(meta);
      }

      const jump = doc.createElement("button");
      jump.type = "button";
      jump.className = "md-dataview-link";
      jump.textContent = `${task.path}:${task.line}`;
      jump.addEventListener("click", () => {
        if (typeof options.onOpenFile === "function") options.onOpenFile(task.path, task.line);
      });
      li.appendChild(jump);
      ul.appendChild(li);
    }
    card.appendChild(ul);
  } else {
    const ul = doc.createElement("ul");
    ul.className = "md-dataview-list";
    for (const item of res.rows) {
      const li = doc.createElement("li");
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "md-dataview-link";
      btn.textContent = item.path;
      btn.addEventListener("click", () => {
        if (typeof options.onOpenFile === "function") options.onOpenFile(item.path, 0);
      });
      li.appendChild(btn);
      ul.appendChild(li);
    }
    card.appendChild(ul);
  }

  hostEl.appendChild(card);
  return res;
}
