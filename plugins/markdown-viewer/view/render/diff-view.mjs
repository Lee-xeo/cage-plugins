/**
 * Zero-dependency line-by-line diff computation and pure DOM renderer.
 * Used for external ETag conflict resolution and local draft comparison.
 */

/**
 * Compute an ordered line diff between `oldText` and `newText`.
 */
export function computeLineDiff(oldText, newText) {
  const aLines = String(oldText || "").replace(/\r\n?/g, "\n").split("\n");
  const bLines = String(newText || "").replace(/\r\n?/g, "\n").split("\n");

  let prefix = 0;
  while (prefix < aLines.length && prefix < bLines.length && aLines[prefix] === bLines[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < aLines.length - prefix &&
    suffix < bLines.length - prefix &&
    aLines[aLines.length - 1 - suffix] === bLines[bLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const out = [];
  for (let i = 0; i < prefix; i++) {
    out.push({ type: "same", oldLine: i + 1, newLine: i + 1, text: aLines[i] });
  }

  const aMid = aLines.slice(prefix, aLines.length - suffix);
  const bMid = bLines.slice(prefix, bLines.length - suffix);

  if (aMid.length * bMid.length <= 250000) {
    const m = aMid.length;
    const n = bMid.length;
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = aMid[i] === bMid[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (aMid[i] === bMid[j]) {
        out.push({ type: "same", oldLine: prefix + i + 1, newLine: prefix + j + 1, text: aMid[i] });
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push({ type: "del", oldLine: prefix + i + 1, newLine: null, text: aMid[i] });
        i += 1;
      } else {
        out.push({ type: "add", oldLine: null, newLine: prefix + j + 1, text: bMid[j] });
        j += 1;
      }
    }
    while (i < m) {
      out.push({ type: "del", oldLine: prefix + i + 1, newLine: null, text: aMid[i] });
      i += 1;
    }
    while (j < n) {
      out.push({ type: "add", oldLine: null, newLine: prefix + j + 1, text: bMid[j] });
      j += 1;
    }
  } else {
    aMid.forEach((line, i) => out.push({ type: "del", oldLine: prefix + i + 1, newLine: null, text: line }));
    bMid.forEach((line, j) => out.push({ type: "add", oldLine: null, newLine: prefix + j + 1, text: line }));
  }

  for (let k = 0; k < suffix; k++) {
    out.push({
      type: "same",
      oldLine: aLines.length - suffix + k + 1,
      newLine: bLines.length - suffix + k + 1,
      text: aLines[aLines.length - suffix + k],
    });
  }

  let added = 0;
  let removed = 0;
  for (const row of out) {
    if (row.type === "add") added += 1;
    else if (row.type === "del") removed += 1;
  }

  return { lines: out, added, removed };
}

/**
 * Render a unified red/green diff view with collapsed unchanged runs into `containerEl`.
 */
export function renderDiffView(doc, containerEl, oldText, newText, options = {}) {
  while (containerEl.firstChild) containerEl.removeChild(containerEl.firstChild);
  const diff = computeLineDiff(oldText, newText);
  const ctx = Math.max(0, Number(options.contextLines ?? 2));
  const oldLabel = options.oldLabel || "基准/磁盘版本";
  const newLabel = options.newLabel || "当前/草稿版本";

  const head = doc.createElement("div");
  head.className = "diff-summary-bar";
  const titleSpan = doc.createElement("span");
  titleSpan.textContent = `${oldLabel} → ${newLabel}`;
  const statsSpan = doc.createElement("span");
  statsSpan.className = "diff-stats";
  const addStat = doc.createElement("span");
  addStat.className = "diff-stat-add";
  addStat.textContent = `+${diff.added}`;
  const delStat = doc.createElement("span");
  delStat.className = "diff-stat-del";
  delStat.textContent = `-${diff.removed}`;
  statsSpan.appendChild(addStat);
  statsSpan.appendChild(doc.createTextNode(" / "));
  statsSpan.appendChild(delStat);
  head.appendChild(titleSpan);
  head.appendChild(statsSpan);
  containerEl.appendChild(head);

  if (diff.added === 0 && diff.removed === 0) {
    const empty = doc.createElement("div");
    empty.className = "diff-empty muted";
    empty.textContent = "两个版本逐行内容完全一致，没有文本差异。";
    containerEl.appendChild(empty);
    return diff;
  }

  const changedIdx = new Set();
  diff.lines.forEach((entry, idx) => {
    if (entry.type !== "same") {
      for (let d = -ctx; d <= ctx; d++) {
        if (idx + d >= 0 && idx + d < diff.lines.length) changedIdx.add(idx + d);
      }
    }
  });

  const table = doc.createElement("div");
  table.className = "diff-lines-box";
  let skipped = 0;

  const flushSkipped = () => {
    if (skipped <= 0) return;
    const sep = doc.createElement("div");
    sep.className = "diff-hunk-sep";
    sep.textContent = `⋯ 已折叠 ${skipped} 行相同上下文 ⋯`;
    table.appendChild(sep);
    skipped = 0;
  };

  diff.lines.forEach((entry, idx) => {
    if (!changedIdx.has(idx)) {
      skipped += 1;
      return;
    }
    flushSkipped();

    const row = doc.createElement("div");
    row.className = `diff-line diff-${entry.type}`;

    const gOld = doc.createElement("span");
    gOld.className = "diff-ln";
    gOld.textContent = entry.oldLine ? String(entry.oldLine) : "";

    const gNew = doc.createElement("span");
    gNew.className = "diff-ln";
    gNew.textContent = entry.newLine ? String(entry.newLine) : "";

    const sig = doc.createElement("span");
    sig.className = "diff-sig";
    sig.textContent = entry.type === "add" ? "+" : (entry.type === "del" ? "-" : " ");

    const code = doc.createElement("span");
    code.className = "diff-code";
    code.textContent = entry.text || " ";

    row.appendChild(gOld);
    row.appendChild(gNew);
    row.appendChild(sig);
    row.appendChild(code);
    table.appendChild(row);
  });
  flushSkipped();

  containerEl.appendChild(table);
  return diff;
}
