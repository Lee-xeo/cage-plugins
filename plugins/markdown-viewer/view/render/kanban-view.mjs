export const STATUS_META = {
  todo: { key: "todo", label: "待开始", icon: "○", cls: "st-todo" },
  doing: { key: "doing", label: "进行中", icon: "◐", cls: "st-doing" },
  review: { key: "review", label: "待验收", icon: "◈", cls: "st-review" },
  done: { key: "done", label: "已完成", icon: "✓", cls: "st-done" },
};

export const PRIORITY_META = {
  high: { key: "high", label: "高优先级 (P1)", short: "高 P1", cls: "prio-high" },
  medium: { key: "medium", label: "中优先级 (P2)", short: "中 P2", cls: "prio-medium" },
  low: { key: "low", label: "低优先级 (P3)", short: "低 P3", cls: "prio-low" },
  "": { key: "", label: "未设优先级", short: "无优先级", cls: "prio-none" },
};

export const COLOR_META = {
  red: { key: "red", label: "红色", dotCls: "c-red" },
  orange: { key: "orange", label: "橙色", dotCls: "c-orange" },
  amber: { key: "amber", label: "琥珀", dotCls: "c-amber" },
  green: { key: "green", label: "绿色", dotCls: "c-green" },
  blue: { key: "blue", label: "蓝色", dotCls: "c-blue" },
  purple: { key: "purple", label: "紫色", dotCls: "c-purple" },
  pink: { key: "pink", label: "粉色", dotCls: "c-pink" },
  "": { key: "", label: "默认无色", dotCls: "" },
};

export function normalizeTaskStatus(task) {
  if (!task) return "todo";
  if (task.checked) return "done";
  const st = String(task.status || "").toLowerCase();
  if (st === "doing" || st === "review" || st === "done") return st;
  return "todo";
}

export function getEffectiveColor(task) {
  if (!task) return "";
  if (task.color && COLOR_META[task.color]) return task.color;
  if (task.priority === "high") return "red";
  if (task.priority === "medium") return "amber";
  if (task.priority === "low") return "blue";
  return "";
}

export function computeKanbanStats(tasks, today = "") {
  const list = Array.isArray(tasks) ? tasks : [];
  let todo = 0;
  let doing = 0;
  let review = 0;
  let done = 0;
  let high = 0;
  let overdue = 0;
  let dueToday = 0;

  for (const t of list) {
    const st = normalizeTaskStatus(t);
    if (st === "done") done += 1;
    else if (st === "doing") doing += 1;
    else if (st === "review") review += 1;
    else todo += 1;

    if (st !== "done" && t.priority === "high") high += 1;
    if (st !== "done" && t.due && today) {
      if (t.due < today) overdue += 1;
      else if (t.due === today) dueToday += 1;
    }
  }

  const total = list.length;
  const open = total - done;
  const completionRate = total > 0 ? Math.round((done / total) * 100) : 0;
  return {
    total,
    open,
    todo,
    doing,
    review,
    done,
    high,
    overdue,
    dueToday,
    dueAlert: overdue + dueToday,
    completionRate,
  };
}

export function getTaskAxisValue(task, axis) {
  if (axis === "status") return normalizeTaskStatus(task);
  if (axis === "priority") return task.priority || "";
  if (axis === "assignee") return task.assignee || "";
  if (axis === "group") return task.group || "";
  if (axis === "color") return task.color || "";
  if (axis === "file") return task.path || "";
  return "__all__";
}

export function buildColumnsForAxis(tasks, columnBy = "status") {
  if (columnBy === "status") {
    return [STATUS_META.todo, STATUS_META.doing, STATUS_META.review, STATUS_META.done];
  }
  if (columnBy === "priority") {
    return [PRIORITY_META.high, PRIORITY_META.medium, PRIORITY_META.low, PRIORITY_META[""]];
  }
  if (columnBy === "color") {
    return [
      COLOR_META.red,
      COLOR_META.orange,
      COLOR_META.amber,
      COLOR_META.green,
      COLOR_META.blue,
      COLOR_META.purple,
      COLOR_META.pink,
      COLOR_META[""],
    ];
  }
  if (columnBy === "assignee") {
    const names = [...new Set((tasks || []).map((t) => t.assignee).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    return [
      ...names.map((a) => ({ key: a, label: `@${a}`, cls: "col-assignee" })),
      { key: "", label: "未分配", cls: "col-unassigned" },
    ];
  }
  if (columnBy === "group") {
    const groups = [...new Set((tasks || []).map((t) => t.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    return [
      ...groups.map((g) => ({ key: g, label: `📁 ${g}`, cls: "col-group" })),
      { key: "", label: "未分组", cls: "col-ungrouped" },
    ];
  }
  return [STATUS_META.todo, STATUS_META.doing, STATUS_META.review, STATUS_META.done];
}

export function buildSwimlanesForAxis(tasks, swimlaneBy = "none") {
  if (!swimlaneBy || swimlaneBy === "none") {
    return [{ key: "__all__", label: "全部任务" }];
  }
  if (swimlaneBy === "priority") {
    return [PRIORITY_META.high, PRIORITY_META.medium, PRIORITY_META.low, PRIORITY_META[""]];
  }
  if (swimlaneBy === "assignee") {
    const names = [...new Set((tasks || []).map((t) => t.assignee).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    return [
      ...names.map((a) => ({ key: a, label: `负责人：@${a}` })),
      { key: "", label: "负责人：未分配" },
    ];
  }
  if (swimlaneBy === "group") {
    const groups = [...new Set((tasks || []).map((t) => t.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    return [
      ...groups.map((g) => ({ key: g, label: `分组：📁 ${g}` })),
      { key: "", label: "分组：未分组" },
    ];
  }
  if (swimlaneBy === "file") {
    const files = [...new Set((tasks || []).map((t) => t.path).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    return files.length > 0
      ? files.map((f) => ({ key: f, label: `📄 ${f}` }))
      : [{ key: "", label: "全部文档" }];
  }
  return [{ key: "__all__", label: "全部任务" }];
}

export function computeDropPatch(task, columnBy, colKey, swimlaneBy = "none", laneKey = "__all__") {
  const prevStatus = normalizeTaskStatus(task);
  const next = {
    status: prevStatus,
    checked: Boolean(task.checked),
    priority: task.priority || "",
    due: task.due || "",
    assignee: task.assignee || "",
    group: task.group || "",
    color: task.color || "",
  };

  const applyAxis = (axis, val) => {
    if (axis === "status") {
      next.status = val || "todo";
      next.checked = next.status === "done";
    } else if (axis === "priority") {
      next.priority = val || "";
    } else if (axis === "assignee") {
      next.assignee = val || "";
    } else if (axis === "group") {
      next.group = val || "";
    } else if (axis === "color") {
      next.color = val || "";
    }
  };

  if (swimlaneBy && swimlaneBy !== "none" && swimlaneBy !== "file" && laneKey !== "__all__") {
    applyAxis(swimlaneBy, laneKey);
  }
  if (columnBy) {
    applyAxis(columnBy, colKey);
  }

  const changed =
    next.status !== prevStatus ||
    next.checked !== Boolean(task.checked) ||
    next.priority !== (task.priority || "") ||
    next.assignee !== (task.assignee || "") ||
    next.group !== (task.group || "") ||
    next.color !== (task.color || "");

  return { changed, patch: next };
}

export function filterKanbanTasks(tasks, { filterQuery = "", quickFilter = "all", today = "" } = {}) {
  const q = String(filterQuery || "").trim().toLowerCase();
  return (tasks || []).filter((t) => {
    const st = normalizeTaskStatus(t);
    if (quickFilter === "todo" && st !== "todo") return false;
    if (quickFilter === "doing" && st !== "doing") return false;
    if (quickFilter === "review" && st !== "review") return false;
    if (quickFilter === "done" && st !== "done") return false;
    if (quickFilter === "high" && (st === "done" || t.priority !== "high")) return false;
    if (quickFilter === "due") {
      if (st === "done" || !t.due || !today || t.due > today) return false;
    }
    if (!q) return true;
    const hay = [
      t.cleanText || "",
      t.text || "",
      t.path || "",
      t.assignee ? `@${t.assignee}` : "",
      t.group || "",
      t.heading || "",
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

export function buildKanbanMarkdownReport(tasks, { projectName = "", scope = "project", columnBy = "status", today = "" } = {}) {
  const stats = computeKanbanStats(tasks, today);
  const cols = buildColumnsForAxis(tasks, columnBy);
  const lines = [
    `# 📋 任务看板汇总报告${projectName ? `（${projectName}${scope === "all" ? " · 全部工作区" : ""}）` : ""}`,
    "",
    `- **统计时间**：${today || "当前"}`,
    `- **总体进度**：已完成 ${stats.done} / ${stats.total}（完成率 ${stats.completionRate}%）· 进行中 ${stats.doing} · 待验收 ${stats.review} · 待开始 ${stats.todo}`,
    `- **重点关注**：高优 P1 待办 ${stats.high} 项 · 逾期/今日到期 ${stats.dueAlert} 项`,
    "",
  ];

  for (const col of cols) {
    const bucket = (tasks || []).filter((t) => getTaskAxisValue(t, columnBy) === col.key);
    lines.push(`## ${col.label} (${bucket.length})`);
    if (bucket.length === 0) {
      lines.push("", "_暂无任务_", "");
      continue;
    }
    lines.push("");
    for (const t of bucket) {
      const mark = normalizeTaskStatus(t) === "done" ? "x" : " ";
      const tags = [];
      const st = normalizeTaskStatus(t);
      if (columnBy !== "status" && STATUS_META[st]) tags.push(`[${STATUS_META[st].label}]`);
      if (t.priority && PRIORITY_META[t.priority]) tags.push(PRIORITY_META[t.priority].short);
      if (t.due) tags.push(`📅 ${t.due}`);
      if (t.assignee) tags.push(`@${t.assignee}`);
      if (t.group) tags.push(`group:${t.group}`);
      const metaSuffix = tags.length > 0 ? ` — ${tags.join(" ")}` : "";
      lines.push(`- [${mark}] ${t.cleanText || t.text}${metaSuffix} (\`${t.path}:${t.line}\`)`);
    }
    lines.push("");
  }
  return lines.join("\n").trim() + "\n";
}

export function renderKanbanBoard(containerEl, allTasks, options = {}) {
  const doc = options.document || globalThis.document;
  const columnBy = options.columnBy || "status";
  const swimlaneBy = options.swimlaneBy || "none";
  const filterQuery = options.filterQuery || "";
  const quickFilter = options.quickFilter || "all";
  const today = options.today || "";
  const collapsedLanes = options.collapsedLanes || new Set();
  const onMoveTask = typeof options.onMoveTask === "function" ? options.onMoveTask : null;
  const onToggleTask = typeof options.onToggleTask === "function" ? options.onToggleTask : null;
  const onEditTask = typeof options.onEditTask === "function" ? options.onEditTask : null;
  const onOpenTaskLocation = typeof options.onOpenTaskLocation === "function" ? options.onOpenTaskLocation : null;

  while (containerEl.firstChild) containerEl.removeChild(containerEl.firstChild);

  const stats = computeKanbanStats(allTasks, today);
  const filteredTasks = filterKanbanTasks(allTasks, { filterQuery, quickFilter, today });
  const columns = buildColumnsForAxis(allTasks, columnBy);
  const swimlanes = buildSwimlanesForAxis(filteredTasks.length > 0 ? filteredTasks : allTasks, swimlaneBy);

  if (!allTasks || allTasks.length === 0) {
    const empty = doc.createElement("div");
    empty.className = "kanban-empty muted";
    empty.textContent = "当前范围暂无 Markdown 待办事项（- [ ] 或 - [x]），可点击右上角「+ 新建待办」立即创建。";
    containerEl.appendChild(empty);
    return { stats, filteredTasks, columns, swimlanes };
  }

  if (filteredTasks.length === 0) {
    const empty = doc.createElement("div");
    empty.className = "kanban-empty muted";
    empty.textContent = "没有匹配当前筛选条件的任务卡片，请清除筛选词或切换顶部指标卡。";
    containerEl.appendChild(empty);
    return { stats, filteredTasks, columns, swimlanes };
  }

  let draggedTask = null;
  let lastDragAt = 0;

  function createCardElement(task) {
    const st = normalizeTaskStatus(task);
    const effColor = getEffectiveColor(task);
    const card = doc.createElement("div");
    card.className =
      "kanban-card" +
      (st === "done" ? " is-done" : "") +
      (effColor ? ` task-color-${effColor}` : "");
    card.setAttribute("draggable", "true");
    card.dataset.taskPath = task.path;
    card.dataset.taskLine = String(task.line);
    card.dataset.taskStatus = st;

    card.addEventListener("dragstart", (ev) => {
      draggedTask = task;
      lastDragAt = Date.now();
      if (card.classList) card.classList.add("dragging");
      if (ev && ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = "move";
        try {
          ev.dataTransfer.setData("text/plain", `${task.path}:${task.line}`);
        } catch {
          // Ignore in synthetic drag events
        }
      }
    });
    card.addEventListener("dragend", () => {
      draggedTask = null;
      lastDragAt = Date.now();
      if (card.classList) card.classList.remove("dragging");
    });

    // Top Row: Checkbox + Title + Edit Button
    const topRow = doc.createElement("div");
    topRow.className = "kanban-card-top";

    const cb = doc.createElement("input");
    cb.type = "checkbox";
    cb.className = "kanban-card-cb";
    cb.checked = st === "done";
    cb.title = st === "done" ? "标记为未完成" : "标记为已完成";
    cb.addEventListener("click", (ev) => {
      if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
    });
    cb.addEventListener("change", (ev) => {
      if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
      if (onToggleTask) onToggleTask(task, cb.checked);
    });
    topRow.appendChild(cb);

    const titleBtn = doc.createElement("button");
    titleBtn.type = "button";
    titleBtn.className = "kanban-card-title" + (st === "done" ? " done" : "");
    titleBtn.setAttribute("draggable", "false");
    titleBtn.textContent = task.cleanText || task.text || "(空任务)";
    titleBtn.title = `点击跳转到 ${task.path}:${task.line}`;
    titleBtn.addEventListener("click", (ev) => {
      if (Date.now() - lastDragAt < 300) {
        if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
        return;
      }
      if (onOpenTaskLocation) onOpenTaskLocation(task);
    });
    topRow.appendChild(titleBtn);

    const editBtn = doc.createElement("button");
    editBtn.type = "button";
    editBtn.className = "task-edit-btn";
    editBtn.textContent = "✎";
    editBtn.title = "编辑状态、优先级、截止时间、分配人、分组与颜色";
    editBtn.addEventListener("click", (ev) => {
      if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
      if (onEditTask) onEditTask(task);
    });
    topRow.appendChild(editBtn);
    card.appendChild(topRow);

    // Metadata Chips Row
    const badges = doc.createElement("div");
    badges.className = "kanban-card-badges";

    if (columnBy !== "status" && STATUS_META[st]) {
      const stChip = doc.createElement("span");
      stChip.className = `task-chip ${STATUS_META[st].cls}`;
      stChip.textContent = `${STATUS_META[st].icon} ${STATUS_META[st].label}`;
      badges.appendChild(stChip);
    }
    if (task.priority && PRIORITY_META[task.priority]) {
      const pChip = doc.createElement("span");
      pChip.className = `task-chip ${PRIORITY_META[task.priority].cls}`;
      pChip.textContent = PRIORITY_META[task.priority].short;
      badges.appendChild(pChip);
    }
    if (task.due) {
      const dChip = doc.createElement("span");
      let dueCls = "";
      let suffix = "";
      if (st !== "done" && today) {
        if (task.due < today) {
          dueCls = "due-overdue";
          suffix = " 逾期";
        } else if (task.due === today) {
          dueCls = "due-today";
          suffix = " 今日";
        }
      }
      dChip.className = `task-chip ${dueCls}`.trim();
      dChip.textContent = `📅 ${task.due}${suffix}`;
      badges.appendChild(dChip);
    }
    if (task.assignee) {
      const aChip = doc.createElement("span");
      aChip.className = "task-chip assignee";
      aChip.textContent = `@${task.assignee}`;
      badges.appendChild(aChip);
    }
    if (task.group) {
      const gChip = doc.createElement("span");
      gChip.className = "task-chip group";
      gChip.textContent = `📁 ${task.group}`;
      badges.appendChild(gChip);
    }
    if (badges.childNodes.length > 0) {
      card.appendChild(badges);
    }

    // Quick status transition bar
    const quickBar = doc.createElement("div");
    quickBar.className = "kanban-card-quick";
    for (const stItem of [STATUS_META.todo, STATUS_META.doing, STATUS_META.review, STATUS_META.done]) {
      const qBtn = doc.createElement("button");
      qBtn.type = "button";
      qBtn.className = `kanban-quick-btn ${stItem.cls}` + (st === stItem.key ? " active" : "");
      qBtn.textContent = stItem.label;
      qBtn.title = `切换状态为：${stItem.label}`;
      qBtn.addEventListener("click", (ev) => {
        if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
        if (st === stItem.key) return;
        const { changed, patch } = computeDropPatch(task, "status", stItem.key, "none", "__all__");
        if (changed && onMoveTask) onMoveTask(task, patch);
      });
      quickBar.appendChild(qBtn);
    }
    card.appendChild(quickBar);

    // Footer: file:line & section heading
    const footer = doc.createElement("div");
    footer.className = "kanban-card-footer";
    const locBtn = doc.createElement("button");
    locBtn.type = "button";
    locBtn.className = "kanban-card-loc";
    locBtn.setAttribute("draggable", "false");
    locBtn.textContent = `${task.path}:${task.line}${task.heading ? " · § " + task.heading : ""}`;
    locBtn.title = `打开 ${task.path} 第 ${task.line} 行`;
    locBtn.addEventListener("click", (ev) => {
      if (Date.now() - lastDragAt < 300) {
        if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
        return;
      }
      if (onOpenTaskLocation) onOpenTaskLocation(task);
    });
    footer.appendChild(locBtn);
    card.appendChild(footer);

    return card;
  }

  function renderColumnsGrid(laneTasks, laneKey) {
    const grid = doc.createElement("div");
    grid.className = "kanban-columns-grid";

    for (const col of columns) {
      const colTasks = laneTasks.filter((t) => getTaskAxisValue(t, columnBy) === col.key);
      const colEl = doc.createElement("section");
      colEl.className = `kanban-column ${col.cls || ""}`.trim();
      colEl.dataset.colKey = col.key;
      colEl.dataset.laneKey = laneKey;

      const head = doc.createElement("header");
      head.className = "kanban-col-header";
      const titleWrap = doc.createElement("div");
      titleWrap.className = "kanban-col-title";
      if (col.dotCls) {
        const dot = doc.createElement("span");
        dot.className = `color-dot ${col.dotCls}`;
        titleWrap.appendChild(dot);
      }
      const titleSpan = doc.createElement("span");
      titleSpan.textContent = col.label;
      titleWrap.appendChild(titleSpan);

      const countSpan = doc.createElement("span");
      countSpan.className = "kanban-col-count";
      countSpan.textContent = String(colTasks.length);
      head.appendChild(titleWrap);
      head.appendChild(countSpan);
      colEl.appendChild(head);

      const body = doc.createElement("div");
      body.className = "kanban-col-body";
      body.dataset.colKey = col.key;
      body.dataset.laneKey = laneKey;

      body.addEventListener("dragover", (ev) => {
        if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
        if (colEl.classList) colEl.classList.add("drag-over");
      });
      body.addEventListener("dragleave", () => {
        if (colEl.classList) colEl.classList.remove("drag-over");
      });
      body.addEventListener("drop", (ev) => {
        if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
        if (colEl.classList) colEl.classList.remove("drag-over");
        if (!draggedTask) return;
        const { changed, patch } = computeDropPatch(draggedTask, columnBy, col.key, swimlaneBy, laneKey);
        if (changed && onMoveTask) {
          onMoveTask(draggedTask, patch);
        }
        draggedTask = null;
      });

      if (colTasks.length === 0) {
        const dropHint = doc.createElement("div");
        dropHint.className = "kanban-col-empty";
        dropHint.textContent = "拖拽卡片到此列";
        body.appendChild(dropHint);
      } else {
        for (const task of colTasks) {
          body.appendChild(createCardElement(task));
        }
      }

      colEl.appendChild(body);
      grid.appendChild(colEl);
    }

    return grid;
  }

  if (!swimlaneBy || swimlaneBy === "none") {
    containerEl.appendChild(renderColumnsGrid(filteredTasks, "__all__"));
  } else {
    const stack = doc.createElement("div");
    stack.className = "kanban-swimlanes-stack";

    for (const lane of swimlanes) {
      const laneTasks = filteredTasks.filter((t) => getTaskAxisValue(t, swimlaneBy) === lane.key);
      const laneSection = doc.createElement("div");
      laneSection.className = "kanban-swimlane";
      laneSection.dataset.laneKey = lane.key;

      const isCollapsed = collapsedLanes.has(lane.key);
      const laneHeader = doc.createElement("button");
      laneHeader.type = "button";
      laneHeader.className = "kanban-lane-header";

      const chev = doc.createElement("span");
      chev.className = "kanban-lane-chevron";
      chev.textContent = isCollapsed ? "▸" : "▾";

      const laneTitle = doc.createElement("span");
      laneTitle.className = "kanban-lane-title";
      laneTitle.textContent = lane.label;

      const laneDone = laneTasks.filter((t) => normalizeTaskStatus(t) === "done").length;
      const laneMeta = doc.createElement("span");
      laneMeta.className = "count";
      laneMeta.textContent = `${laneTasks.length} 项（已完成 ${laneDone}）`;

      laneHeader.appendChild(chev);
      laneHeader.appendChild(laneTitle);
      laneHeader.appendChild(laneMeta);
      laneSection.appendChild(laneHeader);

      const laneBody = renderColumnsGrid(laneTasks, lane.key);
      laneBody.hidden = isCollapsed;
      laneHeader.addEventListener("click", () => {
        if (collapsedLanes.has(lane.key)) collapsedLanes.delete(lane.key);
        else collapsedLanes.add(lane.key);
        laneBody.hidden = collapsedLanes.has(lane.key);
        chev.textContent = laneBody.hidden ? "▸" : "▾";
      });

      laneSection.appendChild(laneBody);
      stack.appendChild(laneSection);
    }

    containerEl.appendChild(stack);
  }

  return { stats, filteredTasks, columns, swimlanes };
}
