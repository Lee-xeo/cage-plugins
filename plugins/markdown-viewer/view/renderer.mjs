import { highlightCode } from "./render/highlighter.mjs";
import { renderMath } from "./render/math-offline.mjs";
import { renderMermaidBlock } from "./render/mermaid-offline.mjs";

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);
const MARKDOWN_LINK_RE = /\.(md|markdown|mdx)$/i;
const CALLOUT_TYPES = new Set([
  "note", "tip", "warning", "important", "caution", "info", "todo",
  "example", "quote", "abstract", "success", "question", "failure", "danger", "bug",
]);
const CALLOUT_LABELS = {
  note: "笔记",
  tip: "提示",
  warning: "警告",
  important: "重要",
  caution: "注意",
  info: "信息",
  todo: "待办",
  example: "示例",
  quote: "引用",
  abstract: "摘要",
  success: "完成",
  question: "疑问",
  failure: "失败",
  danger: "危险",
  bug: "缺陷",
};

/**
 * Validate and normalize a link target. Returns null for unsafe schemes
 * (such as javascript:, data:, vbscript:, file:) or control characters.
 */
export function sanitizeHref(rawHref) {
  if (typeof rawHref !== "string") return null;
  const trimmed = rawHref.trim();
  if (!trimmed) return null;
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return null;
  if (trimmed.startsWith("//")) return null;

  const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase() + ":";
    return SAFE_SCHEMES.has(scheme) ? trimmed : null;
  }
  return trimmed;
}

/**
 * Whether a sanitized href points to a relative Markdown document.
 */
export function isRelativeMarkdownHref(href) {
  if (typeof href !== "string" || !href) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) || href.startsWith("#") || href.startsWith("//")) {
    return false;
  }
  const pathOnly = href.split(/[?#]/, 1)[0];
  return MARKDOWN_LINK_RE.test(pathOnly);
}

export function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

/**
 * Parse YAML-like frontmatter from the top of a Markdown document.
 */
export function parseFrontmatter(normalized) {
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: null, body: normalized, lineOffset: 0 };
  }
  const endIdx = normalized.indexOf("\n---\n", 4);
  const eofEndIdx = endIdx === -1 && normalized.endsWith("\n---") ? normalized.length - 4 : -1;
  const closeIdx = endIdx !== -1 ? endIdx : eofEndIdx;
  if (closeIdx === -1) {
    return { frontmatter: null, body: normalized, lineOffset: 0 };
  }

  const rawBlock = normalized.slice(4, closeIdx);
  const body = endIdx !== -1 ? normalized.slice(closeIdx + 5) : "";
  const consumed = endIdx !== -1 ? normalized.slice(0, closeIdx + 5) : normalized;
  const lineOffset = consumed.split("\n").length - 1;
  const entries = [];
  let currentKey = null;

  for (const line of rawBlock.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const listMatch = line.match(/^\s+-\s+(.*)$/);
    if (listMatch && currentKey) {
      const last = entries[entries.length - 1];
      if (!Array.isArray(last.value)) last.value = [];
      last.value.push(listMatch[1].trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    const kvMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const rawVal = kvMatch[2].trim();
      if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
        const items = rawVal
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
        entries.push({ key: currentKey, value: items });
      } else if (rawVal === "") {
        entries.push({ key: currentKey, value: [] });
      } else {
        entries.push({ key: currentKey, value: rawVal.replace(/^["']|["']$/g, "") });
      }
    }
  }

  return { frontmatter: entries.length > 0 ? entries : null, body, lineOffset };
}

function appendText(doc, parent, text) {
  if (text) parent.appendChild(doc.createTextNode(text));
}

function findClosingBackticks(text, start, count) {
  let i = start;
  while (i < text.length) {
    if (text[i] === "`") {
      let run = 0;
      while (i + run < text.length && text[i + run] === "`") run++;
      if (run === count) return i;
      i += run;
      continue;
    }
    i++;
  }
  return -1;
}

function parseLinkTarget(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    if (end !== -1) return trimmed.slice(1, end).trim();
  }
  const match = trimmed.match(/^(\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?$/);
  return match ? match[1] : trimmed;
}

function findMatchingBracket(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      i++;
      continue;
    }
    if (ch === "`") {
      let run = 0;
      while (i + run < text.length && text[i + run] === "`") run++;
      const close = findClosingBackticks(text, i + run, run);
      if (close !== -1) {
        i = close + run - 1;
        continue;
      }
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findClosingParen(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      i++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function createTagPill(doc, tag, ctx) {
  ctx.tags.add(tag);
  const btn = doc.createElement("button");
  btn.type = "button";
  btn.className = "md-tag";
  btn.dataset.mdTag = tag;
  btn.textContent = "#" + tag;
  return btn;
}

function renderInline(doc, parent, text, ctx) {
  let i = 0;
  let buffer = "";

  const flush = () => {
    if (buffer) {
      appendText(doc, parent, buffer);
      buffer = "";
    }
  };

  while (i < text.length) {
    const ch = text[i];

    // Hard line break: two+ spaces or backslash before newline
    if (ch === "\\" && text[i + 1] === "\n") {
      flush();
      parent.appendChild(doc.createElement("br"));
      i += 2;
      continue;
    }
    if (ch === "\n") {
      if (buffer.endsWith("  ")) {
        buffer = buffer.slice(0, -2);
        flush();
        parent.appendChild(doc.createElement("br"));
      } else {
        buffer += " ";
      }
      i++;
      continue;
    }

    // Backslash escape for punctuation
    if (ch === "\\" && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!~|>=]/.test(text[i + 1])) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }

    // Inline code span
    if (ch === "`") {
      let run = 0;
      while (i + run < text.length && text[i + run] === "`") run++;
      const close = findClosingBackticks(text, i + run, run);
      if (close !== -1) {
        flush();
        let codeText = text.slice(i + run, close);
        if (codeText.length >= 2 && codeText.startsWith(" ") && codeText.endsWith(" ") && codeText.trim()) {
          codeText = codeText.slice(1, -1);
        }
        const codeEl = doc.createElement("code");
        codeEl.textContent = codeText;
        parent.appendChild(codeEl);
        i = close + run;
        continue;
      }
      buffer += text.slice(i, i + run);
      i += run;
      continue;
    }

    // Obsidian Wikilinks: [[target#heading|alias]]
    if (ch === "[" && text[i + 1] === "[") {
      const closeWiki = text.indexOf("]]", i + 2);
      if (closeWiki !== -1 && !text.slice(i + 2, closeWiki).includes("\n")) {
        flush();
        const rawInner = text.slice(i + 2, closeWiki);
        const [targetAndHeading, aliasPart] = rawInner.split("|", 2);
        const [rawTarget, rawHeading] = targetAndHeading.split("#", 2);
        const target = rawTarget.trim();
        const heading = rawHeading ? rawHeading.trim() : "";
        const display = aliasPart !== undefined ? aliasPart.trim() : (heading ? `${target} › ${heading}` : target);

        const anchor = doc.createElement("a");
        anchor.className = "md-wikilink";
        anchor.setAttribute("href", "#");
        anchor.dataset.mdWikilink = target;
        if (heading) anchor.dataset.mdHeading = heading;
        anchor.textContent = display || target;
        parent.appendChild(anchor);

        i = closeWiki + 2;
        continue;
      }
    }

    // Footnote reference: [^id]
    if (ch === "[" && text[i + 1] === "^") {
      const closeFn = text.indexOf("]", i + 2);
      if (closeFn !== -1) {
        const fnId = text.slice(i + 2, closeFn).trim();
        if (fnId && !/\s/.test(fnId) && ctx.footnotes.has(fnId)) {
          flush();
          if (!ctx.footnoteOrder.includes(fnId)) {
            ctx.footnoteOrder.push(fnId);
          }
          const num = ctx.footnoteOrder.indexOf(fnId) + 1;
          const sup = doc.createElement("sup");
          const a = doc.createElement("a");
          a.className = "md-footnote-ref";
          a.setAttribute("href", `#fn-${fnId}`);
          a.dataset.mdHref = `#fn-${fnId}`;
          a.textContent = `[${num}]`;
          sup.appendChild(a);
          parent.appendChild(sup);
          i = closeFn + 1;
          continue;
        }
      }
    }

    // Inline image: ![alt](target)
    if (ch === "!" && text[i + 1] === "[") {
      const closeBracket = findMatchingBracket(text, i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === "(") {
        const closeParen = findClosingParen(text, closeBracket + 1);
        if (closeParen !== -1) {
          flush();
          const alt = text.slice(i + 2, closeBracket);
          const target = parseLinkTarget(text.slice(closeBracket + 2, closeParen));
          const safe = sanitizeHref(target);
          const hasScheme = safe && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(safe);
          if (!safe || hasScheme) {
            const blocked = doc.createElement("span");
            blocked.className = "md-img-blocked";
            blocked.textContent = alt ? `[外部或受限图片已拦截: ${alt}]` : "[外部或受限图片已拦截]";
            if (safe) blocked.dataset.mdHref = safe;
            parent.appendChild(blocked);
          } else {
            const figure = doc.createElement("figure");
            figure.className = "md-img-frame";
            figure.dataset.assetHref = safe;
            const loading = doc.createElement("span");
            loading.className = "muted";
            loading.textContent = alt ? `正在加载图片: ${alt}…` : `正在加载图片: ${safe}…`;
            figure.appendChild(loading);
            parent.appendChild(figure);
            if (ctx.options && typeof ctx.options.onAssetMount === "function") {
              ctx.options.onAssetMount(figure, safe, alt);
            }
          }
          i = closeParen + 1;
          continue;
        }
      }
    }

    // Inline math: $...$ (avoid currency like $100)
    if (ch === "$" && text[i + 1] !== "$" && text[i + 1] && !/\s/.test(text[i + 1])) {
      const close = text.indexOf("$", i + 1);
      if (close !== -1 && close > i + 1 && !/\s/.test(text[close - 1]) && text[close + 1] !== "$") {
        const expr = text.slice(i + 1, close);
        if (!/^\d+(?:[.,]\d+)?$/.test(expr) && !expr.includes("\n")) {
          flush();
          parent.appendChild(renderMath(doc, expr, false));
          i = close + 1;
          continue;
        }
      }
    }

    // Links: [label](target)
    if (ch === "[") {
      const closeBracket = findMatchingBracket(text, i);
      if (closeBracket !== -1 && text[closeBracket + 1] === "(") {
        const closeParen = findClosingParen(text, closeBracket + 1);
        if (closeParen !== -1) {
          flush();
          const label = text.slice(i + 1, closeBracket);
          const target = parseLinkTarget(text.slice(closeBracket + 2, closeParen));
          const safe = sanitizeHref(target);
          if (safe) {
            const anchor = doc.createElement("a");
            anchor.setAttribute("href", safe);
            anchor.dataset.mdHref = safe;
            anchor.setAttribute("rel", "noopener noreferrer");
            renderInline(doc, anchor, label, ctx);
            parent.appendChild(anchor);
          } else {
            const blocked = doc.createElement("span");
            blocked.className = "md-link-blocked";
            blocked.setAttribute("title", "Unsafe link blocked");
            renderInline(doc, blocked, label, ctx);
            parent.appendChild(blocked);
          }
          i = closeParen + 1;
          continue;
        }
      }
    }

    // Obsidian Highlight ==text==
    if (ch === "=" && text[i + 1] === "=") {
      const close = text.indexOf("==", i + 2);
      if (close !== -1 && close > i + 2) {
        flush();
        const mark = doc.createElement("mark");
        renderInline(doc, mark, text.slice(i + 2, close), ctx);
        parent.appendChild(mark);
        i = close + 2;
        continue;
      }
    }

    // Strikethrough ~~text~~
    if (ch === "~" && text[i + 1] === "~") {
      const close = text.indexOf("~~", i + 2);
      if (close !== -1 && close > i + 2) {
        flush();
        const del = doc.createElement("del");
        renderInline(doc, del, text.slice(i + 2, close), ctx);
        parent.appendChild(del);
        i = close + 2;
        continue;
      }
    }

    // Bold + Italic ***text*** or ___text___
    if ((ch === "*" && text[i + 1] === "*" && text[i + 2] === "*") || (ch === "_" && text[i + 1] === "_" && text[i + 2] === "_")) {
      const marker = ch + ch + ch;
      const close = text.indexOf(marker, i + 3);
      if (close !== -1 && close > i + 3) {
        flush();
        const strong = doc.createElement("strong");
        const em = doc.createElement("em");
        renderInline(doc, em, text.slice(i + 3, close), ctx);
        strong.appendChild(em);
        parent.appendChild(strong);
        i = close + 3;
        continue;
      }
    }

    // Bold **text** or __text__
    if ((ch === "*" && text[i + 1] === "*") || (ch === "_" && text[i + 1] === "_")) {
      const marker = ch + ch;
      const close = text.indexOf(marker, i + 2);
      if (close !== -1 && close > i + 2) {
        flush();
        const strong = doc.createElement("strong");
        renderInline(doc, strong, text.slice(i + 2, close), ctx);
        parent.appendChild(strong);
        i = close + 2;
        continue;
      }
    }

    // Italic *text* or _text_
    if (ch === "*" || ch === "_") {
      const prev = i > 0 ? text[i - 1] : " ";
      const next = text[i + 1] || " ";
      if (!/\s/.test(next) && !(ch === "_" && /[a-zA-Z0-9]/.test(prev))) {
        let close = -1;
        for (let j = i + 1; j < text.length; j++) {
          if (text[j] === "\\" && j + 1 < text.length) {
            j++;
            continue;
          }
          if (text[j] === "`") {
            let run = 0;
            while (j + run < text.length && text[j + run] === "`") run++;
            const endTick = findClosingBackticks(text, j + run, run);
            if (endTick !== -1) {
              j = endTick + run - 1;
              continue;
            }
          }
          if (text[j] === ch && text[j + 1] !== ch && !/\s/.test(text[j - 1])) {
            if (ch === "_" && j + 1 < text.length && /[a-zA-Z0-9]/.test(text[j + 1])) {
              continue;
            }
            close = j;
            break;
          }
        }
        if (close !== -1 && close > i + 1) {
          flush();
          const em = doc.createElement("em");
          renderInline(doc, em, text.slice(i + 1, close), ctx);
          parent.appendChild(em);
          i = close + 1;
          continue;
        }
      }
    }

    // Inline Obsidian #tag
    if (ch === "#") {
      const prev = i > 0 ? text[i - 1] : " ";
      if (/[\s(（]/.test(prev)) {
        const tagMatch = text.slice(i + 1).match(/^([a-zA-Z\u4e00-\u9fa5][a-zA-Z0-9_\-/\u4e00-\u9fa5]*)/);
        if (tagMatch) {
          flush();
          parent.appendChild(createTagPill(doc, tagMatch[1], ctx));
          i += 1 + tagMatch[1].length;
          continue;
        }
      }
    }

    buffer += ch;
    i++;
  }

  flush();
}

function splitTableRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  const cells = [];
  let current = "";
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "\\" && trimmed[i + 1] === "|") {
      current += "|";
      i++;
    } else if (trimmed[i] === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += trimmed[i];
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseTableAlignments(line) {
  if (!line || !line.includes("|")) return null;
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    if (!/^:?-{3,}:?$/.test(cell)) return null;
    if (cell.startsWith(":") && cell.endsWith(":")) aligns.push("center");
    else if (cell.endsWith(":")) aligns.push("right");
    else if (cell.startsWith(":")) aligns.push("left");
    else aligns.push("");
  }
  return aligns;
}

function isHorizontalRule(line) {
  return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);
}

function matchFenceOpen(line) {
  const match = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  const fence = match[1];
  const info = match[2].trim();
  if (fence[0] === "`" && info.includes("`")) return null;
  return { char: fence[0], len: fence.length, lang: info.split(/\s+/)[0] || "" };
}

function isFenceClose(line, fence) {
  const trimmed = line.trim();
  if (trimmed.length < fence.len) return false;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== fence.char) return false;
  }
  return true;
}

function matchListLine(line) {
  const match = line.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/);
  if (!match) return null;
  const indent = match[1].replace(/\t/g, "  ").length;
  const marker = match[2];
  const ordered = /^\d/.test(marker);
  const start = ordered ? Number.parseInt(marker, 10) : 1;
  let content = match[3];
  let task = null;
  const taskMatch = content.match(/^\[([ xX])\]\s*(.*)$/);
  if (taskMatch) {
    task = taskMatch[1].toLowerCase() === "x";
    content = taskMatch[2];
  }
  return { indent, ordered, start, content, task };
}

function isBlockStarter(lines, index) {
  const line = lines[index];
  if (!line.trim()) return true;
  if (/^\s{0,3}#{1,6}(?:\s|$)/.test(line)) return true;
  if (matchFenceOpen(line)) return true;
  if (isHorizontalRule(line)) return true;
  if (/^\s{0,3}>/.test(line)) return true;
  if (matchListLine(line)) return true;
  if (index + 1 < lines.length && line.includes("|") && parseTableAlignments(lines[index + 1])) {
    return true;
  }
  return false;
}

function setSourceRange(el, lineMap, startIdx, endIdx) {
  if (!lineMap || startIdx < 0 || startIdx >= lineMap.length) return;
  const startLine = lineMap[startIdx];
  const clampedEnd = Math.min(Math.max(startIdx, endIdx), lineMap.length - 1);
  const endLine = lineMap[clampedEnd];
  el.dataset.sourceLine = String(startLine);
  el.dataset.sourceEndLine = String(endLine);
}

function renderList(doc, lines, startIndex, baseIndent, ctx, lineMap) {
  const first = matchListLine(lines[startIndex]);
  const listEl = doc.createElement(first.ordered ? "ol" : "ul");
  if (first.ordered && first.start !== 1) {
    listEl.setAttribute("start", String(first.start));
  }

  let i = startIndex;
  while (i < lines.length) {
    const info = matchListLine(lines[i]);
    if (!info) break;
    if (info.indent < baseIndent) break;
    if (info.indent > baseIndent) {
      const lastLi = listEl.lastElementChild;
      if (lastLi) {
        const sub = renderList(doc, lines, i, info.indent, ctx, lineMap);
        lastLi.appendChild(sub.element);
        i = sub.nextIndex;
        continue;
      }
    }
    if (info.ordered !== first.ordered) break;

    const liStart = i;
    const li = doc.createElement("li");
    if (info.task !== null) {
      const taskLine = lineMap ? lineMap[liStart] : liStart + 1;
      li.className = info.task ? "md-task-item done" : "md-task-item";
      const checkbox = doc.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = info.task;
      checkbox.dataset.taskLine = String(taskLine);
      if (ctx.options && typeof ctx.options.onTaskToggle === "function") {
        checkbox.disabled = false;
        checkbox.addEventListener("change", () => {
          li.className = checkbox.checked ? "md-task-item done" : "md-task-item";
          ctx.options.onTaskToggle(taskLine, checkbox.checked, checkbox);
        });
      } else {
        checkbox.disabled = true;
      }
      li.appendChild(checkbox);
      appendText(doc, li, " ");
    }

    const textLines = [info.content];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (!next.trim()) {
        if (i + 1 < lines.length && /^\s+/.test(lines[i + 1]) && !matchListLine(lines[i + 1])) {
          i++;
          continue;
        }
        break;
      }
      const nextList = matchListLine(next);
      if (nextList) break;
      if (/^\s{2,}/.test(next) && !isBlockStarter(lines, i)) {
        textLines.push(next.trim());
        i++;
        continue;
      }
      break;
    }

    renderInline(doc, li, textLines.join("\n"), ctx);

    if (i < lines.length) {
      const nested = matchListLine(lines[i]);
      if (nested && nested.indent > baseIndent) {
        const sub = renderList(doc, lines, i, nested.indent, ctx, lineMap);
        li.appendChild(sub.element);
        i = sub.nextIndex;
      }
    }

    setSourceRange(li, lineMap, liStart, i - 1);
    listEl.appendChild(li);
  }

  setSourceRange(listEl, lineMap, startIndex, i - 1);
  return { element: listEl, nextIndex: i };
}

function renderFrontmatterCard(doc, entries, ctx) {
  const details = doc.createElement("details");
  details.className = "md-frontmatter";
  details.open = true;

  const summary = doc.createElement("summary");
  summary.textContent = "属性 (Frontmatter)";
  details.appendChild(summary);

  const grid = doc.createElement("div");
  grid.className = "md-frontmatter-grid";
  for (const { key, value } of entries) {
    const kEl = doc.createElement("div");
    kEl.className = "md-fm-key";
    kEl.textContent = key;
    grid.appendChild(kEl);

    const vEl = doc.createElement("div");
    vEl.className = "md-fm-val";
    if (Array.isArray(value)) {
      for (const item of value) {
        if (key.toLowerCase() === "tags" || key.toLowerCase() === "tag") {
          vEl.appendChild(createTagPill(doc, item.replace(/^#/, ""), ctx));
          appendText(doc, vEl, " ");
        } else {
          const chip = doc.createElement("span");
          chip.className = "md-fm-chip";
          chip.textContent = item;
          vEl.appendChild(chip);
        }
      }
    } else if (key.toLowerCase() === "tags" || key.toLowerCase() === "tag") {
      vEl.appendChild(createTagPill(doc, value.replace(/^#/, ""), ctx));
    } else {
      vEl.textContent = value;
    }
    grid.appendChild(vEl);
  }
  details.appendChild(grid);
  return details;
}

function extractFootnotes(lines, lineOffset) {
  const footnotes = new Map();
  const bodyLines = [];
  const lineMap = [];
  for (let i = 0; i < lines.length; i++) {
    const fnMatch = lines[i].match(/^\[\^([^\s\]]+)\]:\s*(.*)$/);
    if (fnMatch) {
      const id = fnMatch[1];
      const parts = [fnMatch[2]];
      while (i + 1 < lines.length && (/^\s{2,}/.test(lines[i + 1]) || !lines[i + 1].trim())) {
        if (!lines[i + 1].trim()) {
          if (i + 2 < lines.length && /^\s{2,}/.test(lines[i + 2])) {
            i++;
            continue;
          }
          break;
        }
        parts.push(lines[i + 1].trim());
        i++;
      }
      footnotes.set(id, parts.join(" "));
      continue;
    }
    bodyLines.push(lines[i]);
    lineMap.push(lineOffset + i + 1);
  }
  return { footnotes, bodyLines, lineMap };
}

function renderBlocks(doc, container, lines, options, ctx, lineMap) {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // Block math: $$ ... $$
    if (/^\s{0,3}\$\$/.test(line)) {
      const trimmed = line.trim();
      const blockStart = i;
      if (trimmed.length > 4 && trimmed.endsWith("$$")) {
        const mathEl = renderMath(doc, trimmed.slice(2, -2), true);
        setSourceRange(mathEl, lineMap, blockStart, blockStart);
        container.appendChild(mathEl);
        i++;
        continue;
      }
      const mathLines = [trimmed.slice(2)];
      i++;
      while (i < lines.length && !lines[i].trim().endsWith("$$")) {
        mathLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        const last = lines[i].trim();
        mathLines.push(last.slice(0, -2));
        i++;
      }
      const mathEl = renderMath(doc, mathLines.join("\n"), true);
      setSourceRange(mathEl, lineMap, blockStart, i - 1);
      container.appendChild(mathEl);
      continue;
    }

    // Fenced code block
    const fence = matchFenceOpen(line);
    if (fence) {
      const blockStart = i;
      const codeLines = [];
      i++;
      while (i < lines.length && !isFenceClose(lines[i], fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const codeText = codeLines.join("\n");

      if (fence.lang.toLowerCase() === "mermaid") {
        const mermaidEl = renderMermaidBlock(doc, codeText, options);
        setSourceRange(mermaidEl, lineMap, blockStart, i - 1);
        container.appendChild(mermaidEl);
        continue;
      }

      const wrapper = doc.createElement("div");
      wrapper.className = "md-code-block";
      setSourceRange(wrapper, lineMap, blockStart, i - 1);

      const header = doc.createElement("div");
      header.className = "md-code-header";

      const langLabel = doc.createElement("span");
      langLabel.className = "md-code-lang";
      langLabel.textContent = fence.lang || "text";
      header.appendChild(langLabel);

      const copyBtn = doc.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "md-copy-btn";
      copyBtn.textContent = "复制";
      copyBtn.addEventListener("click", () => {
        if (typeof options.onCopy === "function") {
          options.onCopy(codeText, copyBtn);
        }
      });
      header.appendChild(copyBtn);
      wrapper.appendChild(header);

      const pre = doc.createElement("pre");
      const codeEl = doc.createElement("code");
      if (fence.lang) {
        codeEl.className = "language-" + fence.lang.replace(/[^a-zA-Z0-9_-]/g, "");
      }
      highlightCode(doc, codeEl, codeText, fence.lang);
      pre.appendChild(codeEl);
      wrapper.appendChild(pre);
      container.appendChild(wrapper);
      continue;
    }

    // ATX Heading
    const headingMatch = line.match(/^\s{0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = (headingMatch[2] || "").replace(/\s+#+\s*$/, "");
      const heading = doc.createElement("h" + level);
      const slug = slugify(headingText);
      const headingIndex = ctx.headings.length;
      if (slug) heading.id = slug;
      heading.dataset.headingLevel = String(level);
      heading.dataset.headingKey = `${headingIndex}:${slug || headingText}`;
      setSourceRange(heading, lineMap, i, i);

      const foldBtn = doc.createElement("button");
      foldBtn.type = "button";
      foldBtn.className = "md-heading-fold-btn";
      foldBtn.setAttribute("aria-label", "折叠或展开章节");
      foldBtn.setAttribute("aria-expanded", "true");
      heading.appendChild(foldBtn);

      renderInline(doc, heading, headingText, ctx);
      ctx.headings.push({
        level,
        id: slug,
        key: heading.dataset.headingKey,
        text: heading.textContent,
        line: lineMap ? lineMap[i] : i + 1,
      });
      container.appendChild(heading);
      i++;
      continue;
    }

    // Horizontal rule
    if (isHorizontalRule(line)) {
      const hr = doc.createElement("hr");
      setSourceRange(hr, lineMap, i, i);
      container.appendChild(hr);
      i++;
      continue;
    }

    // Blockquote & Obsidian Callouts
    if (/^\s{0,3}>/.test(line)) {
      const quoteStart = i;
      const quoteLines = [];
      const quoteMap = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
        if (lineMap) quoteMap.push(lineMap[i]);
        i++;
      }

      const calloutMatch = quoteLines[0] && quoteLines[0].match(/^\[!([a-zA-Z0-9_-]+)\]([+-])?(?:\s+(.*))?$/);
      if (calloutMatch) {
        const rawType = calloutMatch[1].toLowerCase();
        const type = CALLOUT_TYPES.has(rawType) ? rawType : "note";
        const fold = calloutMatch[2] || "";
        const customTitle = (calloutMatch[3] || "").trim();
        const titleText = customTitle || CALLOUT_LABELS[type] || rawType.toUpperCase();

        const box = doc.createElement(fold ? "details" : "div");
        box.className = `md-callout md-callout-${type}`;
        if (fold === "+") box.open = true;
        setSourceRange(box, lineMap, quoteStart, i - 1);

        const titleEl = doc.createElement(fold ? "summary" : "div");
        titleEl.className = "md-callout-title";
        renderInline(doc, titleEl, titleText, ctx);
        box.appendChild(titleEl);

        if (quoteLines.length > 1) {
          const bodyEl = doc.createElement("div");
          bodyEl.className = "md-callout-body";
          renderBlocks(doc, bodyEl, quoteLines.slice(1), options, ctx, lineMap ? quoteMap.slice(1) : null);
          box.appendChild(bodyEl);
        }
        container.appendChild(box);
      } else {
        const bq = doc.createElement("blockquote");
        setSourceRange(bq, lineMap, quoteStart, i - 1);
        renderBlocks(doc, bq, quoteLines, options, ctx, lineMap ? quoteMap : null);
        container.appendChild(bq);
      }
      continue;
    }

    // GFM Table
    if (i + 1 < lines.length && line.includes("|")) {
      const aligns = parseTableAlignments(lines[i + 1]);
      if (aligns) {
        const tableStart = i;
        const headers = splitTableRow(line);
        const table = doc.createElement("table");
        const thead = doc.createElement("thead");
        const headRow = doc.createElement("tr");
        setSourceRange(headRow, lineMap, i, i);
        for (let col = 0; col < aligns.length; col++) {
          const th = doc.createElement("th");
          if (aligns[col]) th.style.textAlign = aligns[col];
          renderInline(doc, th, headers[col] || "", ctx);
          headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = doc.createElement("tbody");
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes("|") && !isBlockStarter(lines, i)) {
          const rowCells = splitTableRow(lines[i]);
          const tr = doc.createElement("tr");
          setSourceRange(tr, lineMap, i, i);
          for (let col = 0; col < aligns.length; col++) {
            const td = doc.createElement("td");
            if (aligns[col]) td.style.textAlign = aligns[col];
            renderInline(doc, td, rowCells[col] || "", ctx);
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
          i++;
        }
        if (tbody.childNodes.length > 0) {
          table.appendChild(tbody);
        }
        setSourceRange(table, lineMap, tableStart, i - 1);
        container.appendChild(table);
        continue;
      }
    }

    // Lists
    const listInfo = matchListLine(line);
    if (listInfo) {
      const { element, nextIndex } = renderList(doc, lines, i, listInfo.indent, ctx, lineMap);
      container.appendChild(element);
      i = nextIndex;
      continue;
    }

    // Paragraph
    const paraStart = i;
    const paraLines = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStarter(lines, i)) {
      paraLines.push(lines[i]);
      i++;
    }
    const p = doc.createElement("p");
    setSourceRange(p, lineMap, paraStart, i - 1);
    renderInline(doc, p, paraLines.join("\n"), ctx);
    container.appendChild(p);
  }
}

function estimateWordCount(text) {
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const latin = (text.replace(/[\u4e00-\u9fa5]/g, " ").match(/\b\w+\b/g) || []).length;
  return cjk + latin;
}

/**
 * Safely render Markdown into a DOM container using only DOM APIs (no innerHTML).
 * Returns extracted metadata: { headings, tags, wordCount, readingMinutes }.
 */
export function renderMarkdown(markdown, container, options = {}) {
  const doc = options.document || globalThis.document;
  if (!doc || !container) {
    throw new Error("renderMarkdown requires a valid container and document.");
  }
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }

  const normalized = String(markdown || "").replace(/\r\n?/g, "\n");
  const { frontmatter, body, lineOffset } = parseFrontmatter(normalized);
  const { footnotes, bodyLines, lineMap } = extractFootnotes(body.split("\n"), lineOffset);
  const ctx = {
    headings: [],
    tags: new Set(),
    footnotes,
    footnoteOrder: [],
    options,
  };

  if (!normalized.trim()) {
    return { headings: [], tags: [], wordCount: 0, readingMinutes: 0 };
  }

  const fragment = doc.createDocumentFragment ? doc.createDocumentFragment() : container;
  if (frontmatter) {
    fragment.appendChild(renderFrontmatterCard(doc, frontmatter, ctx));
  }
  renderBlocks(doc, fragment, bodyLines, options, ctx, lineMap);

  if (ctx.footnoteOrder.length > 0) {
    const fnSection = doc.createElement("section");
    fnSection.className = "md-footnotes";
    fnSection.appendChild(doc.createElement("hr"));
    const ol = doc.createElement("ol");
    for (const id of ctx.footnoteOrder) {
      const li = doc.createElement("li");
      li.id = `fn-${id}`;
      renderInline(doc, li, ctx.footnotes.get(id) || "", ctx);
      ol.appendChild(li);
    }
    fnSection.appendChild(ol);
    fragment.appendChild(fnSection);
  }

  if (fragment !== container) {
    container.appendChild(fragment);
  }

  const wordCount = estimateWordCount(body);
  return {
    headings: ctx.headings,
    tags: [...ctx.tags],
    wordCount,
    readingMinutes: wordCount === 0 ? 0 : Math.max(1, Math.ceil(wordCount / 300)),
  };
}
