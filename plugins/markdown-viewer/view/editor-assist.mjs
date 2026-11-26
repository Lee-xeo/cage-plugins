const LIST_CONTINUATION_RE = /^(\s*)([-*+]|\d{1,9}([.)]))\s+(\[[ xX]\]\s+)?(.*)$/;

const SLASH_COMMANDS = [
  { key: "h1", aliases: ["h1", "一级标题", "title"], label: "/h1 一级标题", detail: "# ", insert: "# " },
  { key: "h2", aliases: ["h2", "二级标题", "section"], label: "/h2 二级标题", detail: "## ", insert: "## " },
  { key: "h3", aliases: ["h3", "三级标题", "sub"], label: "/h3 三级标题", detail: "### ", insert: "### " },
  {
    key: "todo",
    aliases: ["todo", "task", "待办", "任务"],
    label: "/todo 新建待办任务",
    detail: "- [ ] P2 📅",
    insert: () => `- [ ] 待办事项 P2 📅 ${todayIso()} status:todo`,
  },
  {
    key: "table",
    aliases: ["table", "表格", "tb"],
    label: "/table 插入 3×2 Markdown 表格",
    detail: "| 列 | 列 |",
    insert: "| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n| 内容 1 | 内容 2 | 内容 3 |\n",
  },
  {
    key: "code",
    aliases: ["code", "代码块", "snippet"],
    label: "/code 插入代码块",
    detail: "```lang",
    insert: "```python\n\n```\n",
    cursorBack: 5,
  },
  {
    key: "mermaid",
    aliases: ["mermaid", "flow", "流程图", "diagram"],
    label: "/mermaid 流程图模板",
    detail: "flowchart",
    insert: "```mermaid\nflowchart LR\n    A[开始] --> B{判断}\n    B -->|通过| C[完成]\n```\n",
  },
  {
    key: "gantt",
    aliases: ["gantt", "甘特图", "schedule"],
    label: "/gantt 排期甘特图",
    detail: "gantt",
    insert: () => `\`\`\`mermaid\ngantt\n    title 迭代排期\n    section 开发\n    核心实现 :active, t1, ${todayIso()}, 3d\n\`\`\`\n`,
  },
  {
    key: "dataview",
    aliases: ["dataview", "dv", "查询", "数据视图"],
    label: "/dataview 动态任务与文档查询",
    detail: "dataview",
    insert: "```dataview\nTASK\nWHERE status != \"done\"\nSORT priority ASC\nLIMIT 10\n```\n",
  },
  {
    key: "callout",
    aliases: ["callout", "note", "标注", "提示"],
    label: "/callout 折叠提示框",
    detail: "> [!note]",
    insert: "> [!note] 说明\n> 在此输入提示内容。\n",
  },
  {
    key: "toc",
    aliases: ["toc", "目录", "index"],
    label: "/toc 自动章节目录",
    detail: "[TOC]",
    insert: "[TOC]\n\n",
  },
  {
    key: "math",
    aliases: ["math", "formula", "公式", "latex"],
    label: "/math 数学公式块",
    detail: "$$ ... $$",
    insert: "$$\nE = mc^2\n$$\n",
  },
  {
    key: "date",
    aliases: ["date", "today", "日期", "今天"],
    label: "/date 插入今天日期",
    detail: "YYYY-MM-DD",
    insert: () => todayIso(),
  },
  {
    key: "hr",
    aliases: ["hr", "divider", "slide", "分割线", "分页"],
    label: "/hr 分割线 / 幻灯片分页",
    detail: "---",
    insert: "\n---\n\n",
  },
  {
    key: "slidenote",
    aliases: ["slidenote", "note", "演讲备注", "备注"],
    label: "/note 幻灯片演讲者备注",
    detail: "<!-- note -->",
    insert: "<!-- note: 在此编写演讲者备注 -->\n",
  },
];

const CODE_LANGUAGES = [
  ["python", "Python"],
  ["javascript", "JavaScript"],
  ["typescript", "TypeScript"],
  ["go", "Go"],
  ["rust", "Rust"],
  ["bash", "Shell / Bash"],
  ["json", "JSON"],
  ["yaml", "YAML"],
  ["sql", "SQL"],
  ["mermaid", "Mermaid 图表"],
  ["dataview", "Dataview 查询"],
  ["diff", "Diff 补丁"],
  ["html", "HTML"],
  ["css", "CSS"],
  ["markdown", "Markdown"],
];

const CALLOUT_SUGGESTIONS = [
  ["note", "笔记 / 说明"],
  ["tip", "实用技巧"],
  ["important", "关键信息"],
  ["warning", "注意事项"],
  ["caution", "危险警告"],
  ["todo", "待办事项"],
  ["example", "示例演示"],
  ["quote", "文献引用"],
  ["success", "验收通过"],
  ["bug", "缺陷记录"],
  ["abstract", "摘要概览"],
];

const AUTO_PAIRS = {
  "(": ")",
  "[": "]",
  "`": "`",
  "\"": "\"",
  "【": "】",
  "「": "」",
};

function todayIso(offsetDays = 0) {
  const d = new Date();
  if (offsetDays) d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Extract ATX headings from raw Markdown text for [[file#heading]] autocomplete.
 */
export function extractHeadingsFromMarkdown(text) {
  const out = [];
  let inFence = false;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) {
      out.push({ level: m[1].length, text: m[2].trim() });
    }
  }
  return out;
}

/**
 * Convert multi-line tab-separated spreadsheet text (TSV) into a clean GFM Markdown table.
 */
export function convertTsvToMarkdownTable(text) {
  const lines = String(text || "")
    .replace(/\r\n?/g, "\n")
    .trimEnd()
    .split("\n");
  if (lines.length < 2 || !lines[0].includes("\t") || !lines[1].includes("\t")) {
    return null;
  }
  const rows = lines.map((l) => l.split("\t").map((c) => c.trim().replace(/\|/g, "\\|")));
  const colCount = Math.max(...rows.map((r) => r.length));
  if (colCount < 2) return null;
  const pad = (r) => Array.from({ length: colCount }, (_, i) => r[i] || "");
  const header = `| ${pad(rows[0]).join(" | ")} |`;
  const sep = `| ${Array(colCount).fill("---").join(" | ")} |`;
  const body = rows.slice(1).map((r) => `| ${pad(r).join(" | ")} |`);
  return [header, sep, ...body].join("\n") + "\n";
}

/**
 * Compute autocomplete candidates at cursor position `pos` inside `text`.
 * Pure function suitable for unit testing and interactive editor popup rendering.
 */
export function computeAutocompleteCandidates(text, pos, context = {}) {
  const val = String(text || "");
  const lineStart = val.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
  const beforeCursor = val.slice(lineStart, pos);
  const files = Array.isArray(context.files) ? context.files : [];
  const tags = Array.isArray(context.tags) ? context.tags : [];
  const assignees = Array.isArray(context.assignees) ? context.assignees : [];
  const currentHeadings = Array.isArray(context.currentHeadings) ? context.currentHeadings : [];
  const resolveNoteHeadings = typeof context.getNoteHeadings === "function" ? context.getNoteHeadings : null;

  // 1. Obsidian Transclusion / Wikilink with optional #heading: ![[doc#h or [[doc#h
  const wikiMatch = beforeCursor.match(/(!?)\[\[([^\[\]\n]*)$/);
  if (wikiMatch) {
    const bang = wikiMatch[1] || "";
    const inner = wikiMatch[2];
    const hashIdx = inner.indexOf("#");
    const triggerStart = pos - wikiMatch[0].length;

    if (hashIdx !== -1) {
      const targetDoc = inner.slice(0, hashIdx).trim();
      const headQuery = inner.slice(hashIdx + 1).toLowerCase();
      let hPool = [];
      if (!targetDoc) {
        hPool = currentHeadings;
      } else if (resolveNoteHeadings) {
        hPool = resolveNoteHeadings(targetDoc) || [];
      }
      const candidates = hPool
        .filter((h) => !headQuery || h.text.toLowerCase().includes(headQuery))
        .slice(0, 12)
        .map((h) => ({
          label: `${"#".repeat(Math.min(3, h.level || 1))} ${h.text}`,
          detail: targetDoc ? `章节 · ${targetDoc}` : "当前文档章节",
          insert: `${bang}[[${targetDoc}#${h.text}]]`,
        }));
      return { candidates, triggerStart, triggerEnd: pos };
    }

    const q = inner.toLowerCase();
    const sorted = files
      .filter((f) => f.path.toLowerCase().includes(q))
      .sort((a, b) => {
        const ab = a.path.split("/").pop().toLowerCase().startsWith(q) ? 0 : 1;
        const bb = b.path.split("/").pop().toLowerCase().startsWith(q) ? 0 : 1;
        return ab - bb || a.path.length - b.path.length;
      });
    const candidates = sorted.slice(0, 12).map((f) => {
      const stem = /\.(md|markdown|mdx)$/i.test(f.path)
        ? f.path.replace(/\.(md|markdown|mdx)$/i, "")
        : f.path;
      const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "根目录";
      return {
        label: f.path.split("/").pop(),
        detail: `${bang ? "嵌入 · " : ""}${dir}`,
        insert: `${bang}[[${stem}]]`,
      };
    });
    return { candidates, triggerStart, triggerEnd: pos };
  }

  // 2. Callout type autocomplete: > [!type
  const calloutMatch = beforeCursor.match(/^\s*>\s*\[!([a-zA-Z]*)$/);
  if (calloutMatch) {
    const q = calloutMatch[1].toLowerCase();
    const candidates = CALLOUT_SUGGESTIONS
      .filter(([name, desc]) => name.includes(q) || desc.includes(q))
      .map(([name, desc]) => ({
        label: `[!${name}]`,
        detail: desc,
        insert: `[!${name}] `,
      }));
    const start = pos - calloutMatch[1].length - 2;
    return { candidates, triggerStart: start, triggerEnd: pos };
  }

  // 3. Fenced code language autocomplete: ```lang
  const fenceMatch = beforeCursor.match(/^\s{0,3}```([a-zA-Z0-9_-]*)$/);
  if (fenceMatch) {
    const q = fenceMatch[1].toLowerCase();
    const candidates = CODE_LANGUAGES
      .filter(([lang, desc]) => lang.includes(q) || desc.toLowerCase().includes(q))
      .slice(0, 10)
      .map(([lang, desc]) => ({
        label: lang,
        detail: desc,
        insert: `${lang}\n\n\`\`\``,
        cursorBack: 4,
      }));
    return { candidates, triggerStart: pos - fenceMatch[1].length, triggerEnd: pos };
  }

  // 4. Slash commands: /cmd at start or after space
  const slashMatch = beforeCursor.match(/(?:^|\s)\/([a-zA-Z0-9\u4e00-\u9fff_-]*)$/);
  if (slashMatch) {
    const q = slashMatch[1].toLowerCase();
    const candidates = SLASH_COMMANDS
      .filter((cmd) => !q || cmd.aliases.some((a) => a.toLowerCase().includes(q)) || cmd.label.toLowerCase().includes(q))
      .slice(0, 10)
      .map((cmd) => ({
        label: cmd.label,
        detail: cmd.detail,
        insert: typeof cmd.insert === "function" ? cmd.insert() : cmd.insert,
        cursorBack: cmd.cursorBack || 0,
      }));
    const slashOffset = slashMatch[0].indexOf("/");
    return {
      candidates,
      triggerStart: pos - (slashMatch[0].length - slashOffset),
      triggerEnd: pos,
    };
  }

  // 5. Task status / color / due date metadata
  const statusMatch = beforeCursor.match(/(?:^|\s)status:([a-z]*)$/i);
  if (statusMatch) {
    const q = statusMatch[1].toLowerCase();
    const statuses = [
      ["todo", "待开始"],
      ["doing", "进行中"],
      ["review", "待验收"],
      ["done", "已完成"],
    ];
    const candidates = statuses
      .filter(([s, d]) => s.includes(q) || d.includes(q))
      .sort(([sa], [sb]) => (sa.startsWith(q) ? 0 : 1) - (sb.startsWith(q) ? 0 : 1))
      .map(([s, d]) => ({ label: `status:${s}`, detail: d, insert: `status:${s} ` }));
    const off = statusMatch[0].toLowerCase().indexOf("status:");
    return { candidates, triggerStart: pos - (statusMatch[0].length - off), triggerEnd: pos };
  }

  const colorMatch = beforeCursor.match(/(?:^|\s)color:([a-z]*)$/i);
  if (colorMatch) {
    const q = colorMatch[1].toLowerCase();
    const colors = [
      ["red", "红色"], ["orange", "橙色"], ["amber", "琥珀"],
      ["green", "绿色"], ["blue", "蓝色"], ["purple", "紫色"], ["pink", "粉色"],
    ];
    const candidates = colors
      .filter(([c, d]) => c.includes(q) || d.includes(q))
      .map(([c, d]) => ({ label: `color:${c}`, detail: d, insert: `color:${c} ` }));
    const off = colorMatch[0].toLowerCase().indexOf("color:");
    return { candidates, triggerStart: pos - (colorMatch[0].length - off), triggerEnd: pos };
  }

  const dueMatch = beforeCursor.match(/(?:^|\s)(📅|due:)\s*([0-9-]*)$/i);
  if (dueMatch) {
    const dates = [
      [todayIso(0), "今天"],
      [todayIso(1), "明天"],
      [todayIso(3), "3 天后"],
      [todayIso(7), "1 周后"],
    ];
    const candidates = dates.map(([d, label]) => ({
      label: `📅 ${d}`,
      detail: label,
      insert: `📅 ${d} `,
    }));
    const tok = dueMatch[1];
    const off = dueMatch[0].indexOf(tok);
    return { candidates, triggerStart: pos - (dueMatch[0].length - off), triggerEnd: pos };
  }

  // 6. Inline tag #query (not heading)
  const tagMatch = beforeCursor.match(/(?:^|\s)#([^\s#\n]*)$/);
  if (tagMatch && !/^\s*#{1,6}\s/.test(beforeCursor)) {
    const q = tagMatch[1].toLowerCase();
    const candidates = tags
      .filter((t) => t.name.toLowerCase().includes(q))
      .slice(0, 12)
      .map((t) => ({ label: `#${t.name}`, detail: `${t.count} 篇`, insert: `#${t.name} ` }));
    const hashOffset = tagMatch[0].indexOf("#");
    return {
      candidates,
      triggerStart: pos - (tagMatch[0].length - hashOffset),
      triggerEnd: pos,
    };
  }

  // 7. Assignee @query
  const atMatch = beforeCursor.match(/(?:^|\s)@([^\s@\n]*)$/);
  if (atMatch) {
    const q = atMatch[1].toLowerCase();
    const candidates = assignees
      .filter((a) => a.toLowerCase().includes(q))
      .slice(0, 10)
      .map((a) => ({ label: `@${a}`, detail: "负责人", insert: `@${a} ` }));
    const atOffset = atMatch[0].indexOf("@");
    return {
      candidates,
      triggerStart: pos - (atMatch[0].length - atOffset),
      triggerEnd: pos,
    };
  }

  return { candidates: [], triggerStart: pos, triggerEnd: pos };
}

/**
 * Smart editor enhancements: slash commands, [[doc#heading]] & ![[transclude]],
 * callout/code/task metadata autocomplete, auto-pairs, line movement, TSV table paste,
 * shortcuts, and clipboard/drag-drop image upload.
 */
export function attachEditorAssist({
  textarea,
  popupEl,
  getFiles,
  getTags,
  getAssignees,
  getCurrentHeadings,
  getNoteHeadings,
  onChanged,
  onImageFile,
}) {
  let candidates = [];
  let activeIdx = 0;
  let triggerRange = null;

  function hidePopup() {
    candidates = [];
    triggerRange = null;
    if (popupEl) popupEl.hidden = true;
  }

  function positionPopupNearCaret() {
    if (!popupEl || !textarea) return;
    const pos = textarea.selectionStart || 0;
    const before = textarea.value.slice(0, pos);
    const lines = before.split("\n");
    const lineIdx = Math.max(0, lines.length - 1);
    const colChars = lines[lines.length - 1].length;

    const cs = typeof window !== "undefined" && typeof window.getComputedStyle === "function"
      ? window.getComputedStyle(textarea)
      : null;
    const lineH = cs ? (Number.parseFloat(cs.lineHeight) || 22) : 22;
    const padTop = cs ? (Number.parseFloat(cs.paddingTop) || 12) : 12;
    const padLeft = cs ? (Number.parseFloat(cs.paddingLeft) || 12) : 12;

    const relTop = padTop + (lineIdx + 1) * lineH - (textarea.scrollTop || 0) + 4;
    const maxTop = Math.max(24, (textarea.clientHeight || 260) - 180);
    const clampedTop = Math.max(8, Math.min(maxTop, relTop));
    const estLeft = Math.min(Math.max(12, padLeft + Math.min(colChars, 36) * 8), Math.max(12, (textarea.clientWidth || 420) - 240));

    popupEl.style.top = `${Math.round(clampedTop)}px`;
    popupEl.style.left = `${Math.round(estLeft)}px`;
  }

  function applyCandidate(item) {
    if (!triggerRange) return;
    const val = textarea.value;
    const before = val.slice(0, triggerRange.start);
    const after = val.slice(triggerRange.end);
    const insertText = item.insert;
    textarea.value = before + insertText + after;
    const caret = Math.max(0, before.length + insertText.length - (item.cursorBack || 0));
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
    hidePopup();
    if (typeof onChanged === "function") onChanged();
  }

  function renderPopup() {
    if (!popupEl) return;
    if (candidates.length === 0) {
      hidePopup();
      return;
    }
    while (popupEl.firstChild) popupEl.removeChild(popupEl.firstChild);
    candidates.forEach((item, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ac-item" + (idx === activeIdx ? " active" : "");
      const label = document.createElement("span");
      label.className = "ac-label";
      label.textContent = item.label;
      btn.appendChild(label);
      if (item.detail) {
        const detail = document.createElement("span");
        detail.className = "ac-detail";
        detail.textContent = item.detail;
        btn.appendChild(detail);
      }
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        applyCandidate(item);
      });
      popupEl.appendChild(btn);
    });
    positionPopupNearCaret();
    popupEl.hidden = false;
  }

  function updateAutocomplete() {
    if (!popupEl || textarea.readOnly) {
      hidePopup();
      return;
    }
    const pos = textarea.selectionStart;
    if (pos !== textarea.selectionEnd) {
      hidePopup();
      return;
    }
    const res = computeAutocompleteCandidates(textarea.value, pos, {
      files: typeof getFiles === "function" ? getFiles() : [],
      tags: typeof getTags === "function" ? getTags() : [],
      assignees: typeof getAssignees === "function" ? getAssignees() : [],
      currentHeadings: typeof getCurrentHeadings === "function" ? getCurrentHeadings() : [],
      getNoteHeadings,
    });
    candidates = res.candidates;
    triggerRange = candidates.length > 0 ? { start: res.triggerStart, end: res.triggerEnd } : null;
    activeIdx = 0;
    renderPopup();
  }

  function wrapSelection(before, after, placeholder) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;
    const selected = value.slice(start, end) || placeholder;
    textarea.value = value.slice(0, start) + before + selected + after + value.slice(end);
    textarea.setSelectionRange(start + before.length, start + before.length + selected.length);
    if (typeof onChanged === "function") onChanged();
  }

  function getSelectedLineBounds() {
    const val = textarea.value;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const blockStart = val.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    let blockEnd = val.indexOf("\n", end);
    if (blockEnd === -1) blockEnd = val.length;
    return { val, start, end, blockStart, blockEnd };
  }

  function moveSelectedLines(direction) {
    const { val, start, end, blockStart, blockEnd } = getSelectedLineBounds();
    const lines = val.split("\n");
    const firstIdx = val.slice(0, blockStart).split("\n").length - 1;
    const selCount = val.slice(blockStart, blockEnd).split("\n").length;
    if (direction < 0 && firstIdx === 0) return;
    if (direction > 0 && firstIdx + selCount >= lines.length) return;

    const moving = lines.slice(firstIdx, firstIdx + selCount);
    if (direction < 0) {
      const swapLine = lines[firstIdx - 1];
      lines.splice(firstIdx - 1, selCount + 1, ...moving, swapLine);
      const delta = -(swapLine.length + 1);
      textarea.value = lines.join("\n");
      textarea.setSelectionRange(Math.max(0, start + delta), Math.max(0, end + delta));
    } else {
      const swapLine = lines[firstIdx + selCount];
      lines.splice(firstIdx, selCount + 1, swapLine, ...moving);
      const delta = swapLine.length + 1;
      textarea.value = lines.join("\n");
      textarea.setSelectionRange(start + delta, end + delta);
    }
    if (typeof onChanged === "function") onChanged();
  }

  function setHeadingPrefix(level) {
    const { val, blockStart, blockEnd } = getSelectedLineBounds();
    const line = val.slice(blockStart, blockEnd);
    const stripped = line.replace(/^\s{0,3}#{1,6}\s+/, "");
    const nextLine = line.startsWith("#".repeat(level) + " ") ? stripped : `${"#".repeat(level)} ${stripped}`;
    textarea.value = val.slice(0, blockStart) + nextLine + val.slice(blockEnd);
    const pos = blockStart + nextLine.length;
    textarea.setSelectionRange(pos, pos);
    if (typeof onChanged === "function") onChanged();
  }

  textarea.addEventListener("keydown", (event) => {
    if (textarea.readOnly) return;

    if (candidates.length > 0 && popupEl && !popupEl.hidden) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        activeIdx = (activeIdx + 1) % candidates.length;
        renderPopup();
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        activeIdx = (activeIdx - 1 + candidates.length) % candidates.length;
        renderPopup();
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        applyCandidate(candidates[activeIdx]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        hidePopup();
        return;
      }
    }

    // Move lines Alt+Up / Alt+Down
    if (event.altKey && !event.metaKey && !event.ctrlKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      moveSelectedLines(event.key === "ArrowUp" ? -1 : 1);
      return;
    }

    // Formatting & editing shortcuts
    if (event.metaKey || event.ctrlKey) {
      const k = event.key.toLowerCase();
      if (event.shiftKey && k === "d") {
        event.preventDefault();
        const { val, blockStart, blockEnd } = getSelectedLineBounds();
        const block = val.slice(blockStart, blockEnd);
        textarea.value = val.slice(0, blockEnd) + "\n" + block + val.slice(blockEnd);
        const caret = blockEnd + 1 + block.length;
        textarea.setSelectionRange(caret, caret);
        if (typeof onChanged === "function") onChanged();
        return;
      }
      if (event.shiftKey && k === "k") {
        event.preventDefault();
        const { val, blockStart, blockEnd } = getSelectedLineBounds();
        const removeEnd = blockEnd < val.length ? blockEnd + 1 : blockEnd;
        const removeStart = blockEnd === val.length && blockStart > 0 ? blockStart - 1 : blockStart;
        textarea.value = val.slice(0, removeStart) + val.slice(removeEnd);
        textarea.setSelectionRange(removeStart, removeStart);
        if (typeof onChanged === "function") onChanged();
        return;
      }
      if (k === "enter") {
        event.preventDefault();
        const { val, blockStart, blockEnd } = getSelectedLineBounds();
        const line = val.slice(blockStart, blockEnd);
        let nextLine = line;
        if (/^(\s*(?:[-*+]|\d{1,9}[.)])\s+\[)[ ](\])/.test(line)) {
          nextLine = line.replace(/^(\s*(?:[-*+]|\d{1,9}[.)])\s+\[)[ ](\])/, "$1x$2");
        } else if (/^(\s*(?:[-*+]|\d{1,9}[.)])\s+\[)[xX](\])/.test(line)) {
          nextLine = line.replace(/^(\s*(?:[-*+]|\d{1,9}[.)])\s+\[)[xX](\])/, "$1 $2");
        } else {
          nextLine = `- [ ] ${line.trimStart()}`;
        }
        textarea.value = val.slice(0, blockStart) + nextLine + val.slice(blockEnd);
        textarea.setSelectionRange(blockStart + nextLine.length, blockStart + nextLine.length);
        if (typeof onChanged === "function") onChanged();
        return;
      }
      if (k === "/") {
        event.preventDefault();
        const { val, blockStart, blockEnd } = getSelectedLineBounds();
        const line = val.slice(blockStart, blockEnd);
        const m = line.match(/^<!--\s*([\s\S]*?)\s*-->$/);
        const nextLine = m ? m[1] : `<!-- ${line} -->`;
        textarea.value = val.slice(0, blockStart) + nextLine + val.slice(blockEnd);
        textarea.setSelectionRange(blockStart + nextLine.length, blockStart + nextLine.length);
        if (typeof onChanged === "function") onChanged();
        return;
      }
      if (["1", "2", "3", "4"].includes(k)) {
        event.preventDefault();
        setHeadingPrefix(Number(k));
        return;
      }
      if (k === "b") {
        event.preventDefault();
        wrapSelection("**", "**", "粗体");
        return;
      }
      if (k === "i") {
        event.preventDefault();
        wrapSelection("*", "*", "斜体");
        return;
      }
      if (k === "k") {
        event.preventDefault();
        wrapSelection("[", "](https://)", "链接文字");
        return;
      }
      if (k === "e") {
        event.preventDefault();
        wrapSelection("`", "`", "code");
        return;
      }
    }

    // Auto-pair characters & wrap selection
    if (!event.metaKey && !event.ctrlKey && !event.altKey && Object.prototype.hasOwnProperty.call(AUTO_PAIRS, event.key)) {
      const openCh = event.key;
      const closeCh = AUTO_PAIRS[openCh];
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const val = textarea.value;
      if (start !== end) {
        event.preventDefault();
        const selected = val.slice(start, end);
        textarea.value = val.slice(0, start) + openCh + selected + closeCh + val.slice(end);
        textarea.setSelectionRange(start + 1, end + 1);
        if (typeof onChanged === "function") onChanged();
        return;
      }
      const nextCh = val[end] || "";
      if (!nextCh || /[\s)\]}\n.,;!?，。！？]/.test(nextCh)) {
        event.preventDefault();
        textarea.value = val.slice(0, start) + openCh + closeCh + val.slice(end);
        textarea.setSelectionRange(start + 1, start + 1);
        if (typeof onChanged === "function") onChanged();
        updateAutocomplete();
        return;
      }
    }

    // Backspace deletes empty pair () / [] / ``
    if (event.key === "Backspace" && textarea.selectionStart === textarea.selectionEnd) {
      const pos = textarea.selectionStart;
      if (pos > 0) {
        const val = textarea.value;
        const prev = val[pos - 1];
        const next = val[pos];
        if (AUTO_PAIRS[prev] && AUTO_PAIRS[prev] === next) {
          event.preventDefault();
          textarea.value = val.slice(0, pos - 1) + val.slice(pos + 1);
          textarea.setSelectionRange(pos - 1, pos - 1);
          if (typeof onChanged === "function") onChanged();
          return;
        }
      }
    }

    // Tab / Shift+Tab multi-line indent
    if (event.key === "Tab") {
      event.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const val = textarea.value;
      const lineStart = val.lastIndexOf("\n", start - 1) + 1;
      const block = val.slice(lineStart, end);
      const lines = block.split("\n");
      const nextLines = event.shiftKey
        ? lines.map((l) => (l.startsWith("  ") ? l.slice(2) : l.replace(/^\t/, "")))
        : lines.map((l) => "  " + l);
      const replaced = nextLines.join("\n");
      textarea.value = val.slice(0, lineStart) + replaced + val.slice(end);
      textarea.setSelectionRange(lineStart, lineStart + replaced.length);
      if (typeof onChanged === "function") onChanged();
      return;
    }

    // Enter smart list / task continuation
    if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      const pos = textarea.selectionStart;
      if (pos !== textarea.selectionEnd) return;
      const val = textarea.value;
      const lineStart = val.lastIndexOf("\n", pos - 1) + 1;
      const currentLine = val.slice(lineStart, pos);
      const m = currentLine.match(LIST_CONTINUATION_RE);
      if (!m) return;

      event.preventDefault();
      const indent = m[1];
      const marker = m[2];
      const orderedPunct = m[3];
      const hasTask = Boolean(m[4]);
      const body = m[5];

      if (!body.trim()) {
        textarea.value = val.slice(0, lineStart) + val.slice(pos);
        textarea.setSelectionRange(lineStart, lineStart);
        if (typeof onChanged === "function") onChanged();
        return;
      }

      let nextMarker = marker;
      if (orderedPunct) {
        const num = Number.parseInt(marker, 10);
        nextMarker = `${num + 1}${orderedPunct}`;
      }
      const prefix = `\n${indent}${nextMarker} ${hasTask ? "[ ] " : ""}`;
      textarea.value = val.slice(0, pos) + prefix + val.slice(pos);
      const caret = pos + prefix.length;
      textarea.setSelectionRange(caret, caret);
      if (typeof onChanged === "function") onChanged();
    }
  });

  textarea.addEventListener("input", () => updateAutocomplete());
  textarea.addEventListener("blur", () => setTimeout(hidePopup, 140));

  // Smart paste: image files, URL-on-selection, and Excel TSV -> Markdown table
  textarea.addEventListener("paste", (event) => {
    if (textarea.readOnly) return;
    const files = [...(event.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (files.length > 0 && typeof onImageFile === "function") {
      event.preventDefault();
      for (const file of files) onImageFile(file);
      return;
    }
    const pasted = event.clipboardData?.getData("text/plain");
    if (!pasted) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (start < end && /^https?:\/\/\S+$/i.test(pasted.trim())) {
      event.preventDefault();
      const sel = textarea.value.slice(start, end);
      const linkText = `[${sel}](${pasted.trim()})`;
      textarea.value = textarea.value.slice(0, start) + linkText + textarea.value.slice(end);
      textarea.setSelectionRange(start + linkText.length, start + linkText.length);
      if (typeof onChanged === "function") onChanged();
      return;
    }
    const mdTable = convertTsvToMarkdownTable(pasted);
    if (mdTable) {
      event.preventDefault();
      textarea.value = textarea.value.slice(0, start) + mdTable + textarea.value.slice(end);
      const pos = start + mdTable.length;
      textarea.setSelectionRange(pos, pos);
      if (typeof onChanged === "function") onChanged();
    }
  });

  textarea.addEventListener("dragover", (event) => {
    if (textarea.readOnly) return;
    if (event.dataTransfer?.types?.includes("Files")) {
      event.preventDefault();
    }
  });

  textarea.addEventListener("drop", (event) => {
    if (textarea.readOnly || typeof onImageFile !== "function") return;
    const files = [...(event.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    for (const file of files) onImageFile(file);
  });
}
