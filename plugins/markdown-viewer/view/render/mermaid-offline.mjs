import {
  buildEntityDiagramSvg,
  buildGanttSvg,
  buildMindmapSvg,
  buildPieSvg,
  parseClassDiagram,
  parseErDiagram,
  parseGantt,
  parseMindmap,
  parsePie,
} from "./mermaid-extra.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";

const SUBGRAPH_PALETTE = [
  { fill: "rgba(2, 132, 199, 0.06)", stroke: "rgba(56, 189, 248, 0.55)" },
  { fill: "rgba(13, 148, 136, 0.06)", stroke: "rgba(45, 212, 191, 0.55)" },
  { fill: "rgba(124, 58, 237, 0.06)", stroke: "rgba(167, 139, 250, 0.55)" },
  { fill: "rgba(217, 119, 6, 0.06)", stroke: "rgba(251, 191, 36, 0.55)" },
];

function svgEl(doc, tag, attrs = {}, text = "") {
  const node = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
  if (text) node.textContent = text;
  return node;
}

function unquote(s) {
  const t = String(s || "").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function splitLabelLines(raw, maxCharsPerLine = 26) {
  const normalized = String(raw || "")
    .replace(/\\n/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  const out = [];
  for (const part of normalized.split("\n")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (visualUnits(trimmed) <= maxCharsPerLine) {
      out.push(trimmed);
      continue;
    }
    // Soft-wrap long single lines on spaces / middle dots
    const chunks = trimmed.split(/(?<=\s|·|\/)/);
    let cur = "";
    for (const chunk of chunks) {
      if (cur && visualUnits(cur + chunk) > maxCharsPerLine) {
        out.push(cur.trim());
        cur = chunk.trimStart();
      } else {
        cur += chunk;
      }
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out.length > 0 ? out : [""];
}

function visualUnits(text) {
  let units = 0;
  for (const ch of String(text || "")) {
    units += /[\u2e80-\uffff]/.test(ch) ? 1.85 : 1;
  }
  return units;
}

function measureLines(lines, fontSize = 12.5) {
  const charW = fontSize * 0.62;
  let maxW = 0;
  for (const line of lines) {
    maxW = Math.max(maxW, visualUnits(line) * charW);
  }
  const lineH = Math.round(fontSize * 1.42);
  return {
    textW: Math.ceil(maxW),
    textH: lines.length * lineH,
    lineH,
  };
}

function appendMultilineText(doc, parent, lines, cx, cy, attrs = {}) {
  const fontSize = Number(attrs["font-size"] || 12.5);
  const lineH = Math.round(fontSize * 1.42);
  const textEl = svgEl(doc, "text", {
    x: cx,
    "text-anchor": "middle",
    ...attrs,
  });
  const startY = cy - ((lines.length - 1) * lineH) / 2 + fontSize * 0.35;
  lines.forEach((line, idx) => {
    const tspan = svgEl(doc, "tspan", {
      x: cx,
      y: Math.round(startY + idx * lineH),
    }, line);
    textEl.appendChild(tspan);
  });
  parent.appendChild(textEl);
  return textEl;
}

/* ==========================================================================
   1. Flowchart / Graph Parser & Hierarchical Subgraph Layout
   ========================================================================== */
function parseNodeToken(token) {
  const t = token.trim();
  if (!t) return null;

  const patterns = [
    { shape: "cylinder", re: /^([A-Za-z0-9_.-]+)\s*\[\((.+)\)\]$/ },
    { shape: "circle", re: /^([A-Za-z0-9_.-]+)\s*\(\((.+)\)\)$/ },
    { shape: "stadium", re: /^([A-Za-z0-9_.-]+)\s*\(\[(.+)\]\)$/ },
    { shape: "diamond", re: /^([A-Za-z0-9_.-]+)\s*\{(.+)\}$/ },
    { shape: "round", re: /^([A-Za-z0-9_.-]+)\s*\((.+)\)$/ },
    { shape: "rect", re: /^([A-Za-z0-9_.-]+)\s*\[(.+)\]$/ },
  ];
  for (const p of patterns) {
    const m = t.match(p.re);
    if (m) {
      return { id: m[1].trim(), label: unquote(m[2]), shape: p.shape };
    }
  }
  const bare = t.match(/^([A-Za-z0-9_.-]+)$/);
  if (bare) {
    return { id: bare[1].trim(), label: null, shape: null };
  }
  return null;
}

function splitFlowEdges(line) {
  // Parse one or more edges on a line: A --> B, A <--> B, A -- "lbl" --> B, A -->|lbl| B
  const edgeOpRe = /\s*(<--+>|<==+>|<-\.+->|--\s+(?:"[^"]*"|'[^']*'|[^-\n]+?)\s+-->|--+>|==+>|-\.+->|---+)\s*(?:\|([^|]+)\|\s*)?/g;
  const parts = [];
  let lastIdx = 0;
  let m;
  while ((m = edgeOpRe.exec(line)) !== null) {
    const left = line.slice(lastIdx, m.index).trim();
    const op = m[1].trim();
    let label = (m[2] || "").trim();
    const inlineLabel = op.match(/^--\s+(.+?)\s+-->$/);
    if (inlineLabel && !label) {
      label = unquote(inlineLabel[1]);
    }
    const kind = op.startsWith("<")
      ? "both"
      : op.includes(".")
        ? "dashed"
        : op.startsWith("=")
          ? "thick"
          : op.endsWith(">")
            ? "arrow"
            : "line";
    parts.push({ nodeText: left, op: { kind, label } });
    lastIdx = m.index + m[0].length;
  }
  if (parts.length === 0) return null;
  const tail = line.slice(lastIdx).trim();
  parts.push({ nodeText: tail, op: null });
  return parts;
}

function parseFlowchart(lines) {
  const header = lines[0].trim();
  const dirMatch = header.match(/^(?:flowchart|graph)\s+(TD|TB|LR|RL|BT)/i);
  const rootDir = dirMatch ? dirMatch[1].toUpperCase() : "TB";

  const nodes = new Map();
  const subgraphs = new Map();
  const edges = [];

  const rootGroup = {
    id: "__root__",
    title: "",
    dir: rootDir,
    parentId: null,
    childGroups: [],
    childNodes: [],
    depth: 0,
  };
  subgraphs.set("__root__", rootGroup);

  const stack = [rootGroup];
  const currentGroup = () => stack[stack.length - 1];

  const ensureNode = (parsed, group) => {
    if (!parsed || !parsed.id) return null;
    if (subgraphs.has(parsed.id) && parsed.id !== "__root__") {
      return parsed.id;
    }
    if (!nodes.has(parsed.id)) {
      const node = {
        id: parsed.id,
        label: parsed.label || parsed.id,
        shape: parsed.shape || "rect",
        groupId: group.id,
      };
      nodes.set(parsed.id, node);
      group.childNodes.push(parsed.id);
    } else {
      const existing = nodes.get(parsed.id);
      if (parsed.label) existing.label = parsed.label;
      if (parsed.shape) existing.shape = parsed.shape;
    }
    return parsed.id;
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("%%") || /^(?:style|classDef|class|click|linkStyle)\b/i.test(line)) {
      continue;
    }
    const dirLine = line.match(/^direction\s+(TD|TB|LR|RL|BT)$/i);
    if (dirLine) {
      currentGroup().dir = dirLine[1].toUpperCase();
      continue;
    }
    const subMatch = line.match(/^subgraph\s+([A-Za-z0-9_.-]+)\s*\[\s*(?:"([^"]*)"|'([^']*)'|([^\]]*))\s*\]$/i)
      || line.match(/^subgraph\s+(?:"([^"]*)"|'([^']*)'|(.+))$/i);
    if (subMatch && /^subgraph\b/i.test(line)) {
      const parent = currentGroup();
      let id;
      let title;
      if (subMatch.length === 5) {
        id = subMatch[1].trim();
        title = (subMatch[2] ?? subMatch[3] ?? subMatch[4] ?? id).trim();
      } else {
        title = (subMatch[1] ?? subMatch[2] ?? subMatch[3] ?? "Group").trim();
        id = `sg_${subgraphs.size}_${title.replace(/[^A-Za-z0-9_]/g, "")}`;
      }
      const grp = {
        id,
        title,
        dir: parent.dir,
        parentId: parent.id,
        childGroups: [],
        childNodes: [],
        depth: parent.depth + 1,
      };
      subgraphs.set(id, grp);
      parent.childGroups.push(id);
      stack.push(grp);
      continue;
    }
    if (/^end$/i.test(line)) {
      if (stack.length > 1) stack.pop();
      continue;
    }

    const chain = splitFlowEdges(line);
    if (chain) {
      const grp = currentGroup();
      for (let k = 0; k < chain.length - 1; k++) {
        const fromParsed = parseNodeToken(chain[k].nodeText);
        const toParsed = parseNodeToken(chain[k + 1].nodeText);
        const fromId = ensureNode(fromParsed, grp);
        const toId = ensureNode(toParsed, grp);
        if (fromId && toId) {
          edges.push({
            from: fromId,
            to: toId,
            kind: chain[k].op.kind,
            label: chain[k].op.label,
          });
        }
      }
      continue;
    }

    const single = parseNodeToken(line);
    if (single) ensureNode(single, currentGroup());
  }

  if (nodes.size === 0 && subgraphs.size <= 1) return null;

  // Measure every node cleanly with multi-line support (no truncation)
  const nodeBox = new Map();
  for (const [id, node] of nodes.entries()) {
    const wrapped = splitLabelLines(node.label, 24);
    const { textW, textH, lineH } = measureLines(wrapped, 12.5);
    const padX = node.shape === "diamond" ? 36 : 26;
    const padY = node.shape === "cylinder" ? 26 : node.shape === "diamond" ? 24 : 18;
    const w = Math.max(116, Math.min(270, textW + padX));
    const h = Math.max(42, textH + padY);
    nodeBox.set(id, { lines: wrapped, w, h, lineH, x: 0, y: 0 });
  }

  const groupBox = new Map();

  function layoutGroup(groupId) {
    const grp = subgraphs.get(groupId);
    const horizontal = grp.dir === "LR" || grp.dir === "RL";
    const items = [];

    for (const cid of grp.childNodes) {
      const b = nodeBox.get(cid);
      items.push({ kind: "node", id: cid, w: b.w, h: b.h });
    }
    for (const gid of grp.childGroups) {
      const gb = layoutGroup(gid);
      items.push({ kind: "group", id: gid, w: gb.w, h: gb.h });
    }

    const itemIds = new Set(items.map((it) => it.id));
    const internalEdges = edges.filter((e) => itemIds.has(e.from) && itemIds.has(e.to) && e.from !== e.to);

    // Assign topological levels among sibling items inside this group
    const level = new Map();
    for (const it of items) level.set(it.id, 0);
    for (let pass = 0; pass < items.length; pass++) {
      let changed = false;
      for (const e of internalEdges) {
        const nextLvl = (level.get(e.from) || 0) + 1;
        if (nextLvl > (level.get(e.to) || 0)) {
          level.set(e.to, nextLvl);
          changed = true;
        }
      }
      if (!changed) break;
    }

    const byLevel = new Map();
    for (const it of items) {
      const lvl = level.get(it.id) || 0;
      if (!byLevel.has(lvl)) byLevel.set(lvl, []);
      byLevel.get(lvl).push(it);
    }

    const gapX = 28;
    const gapY = 34;
    const headerH = grp.title ? 32 : 0;
    const padX = grp.id === "__root__" ? 20 : 18;
    const padY = grp.id === "__root__" ? 20 : 16;

    // Stack sibling subgraphs vertically in TB/TD mode so layered architectures stay compact & legible
    const hasSubgraphItems = items.some((it) => it.kind === "group");
    const rows = [];
    const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);
    const maxPerRow = horizontal ? 99 : (hasSubgraphItems ? 1 : 3);
    for (const lvl of sortedLevels) {
      const arr = byLevel.get(lvl);
      for (let idx = 0; idx < arr.length; idx += maxPerRow) {
        rows.push(arr.slice(idx, idx + maxPerRow));
      }
    }

    let contentW = 0;
    let contentH = 0;
    const localPos = new Map();

    if (horizontal) {
      let curX = 0;
      for (const col of rows) {
        const colW = Math.max(...col.map((it) => it.w));
        let curY = 0;
        for (const it of col) {
          localPos.set(it.id, { x: curX + (colW - it.w) / 2, y: curY });
          curY += it.h + gapY;
        }
        contentH = Math.max(contentH, Math.max(0, curY - gapY));
        curX += colW + gapX + 18;
      }
      contentW = Math.max(0, curX - gapX - 18);
    } else {
      const rowMetrics = rows.map((row) => ({
        row,
        w: row.reduce((s, it) => s + it.w, 0) + Math.max(0, row.length - 1) * gapX,
        h: Math.max(...row.map((it) => it.h)),
      }));
      contentW = Math.max(0, ...rowMetrics.map((m) => m.w));
      let curY = 0;
      for (const { row, w, h } of rowMetrics) {
        let curX = (contentW - w) / 2;
        for (const it of row) {
          localPos.set(it.id, { x: curX, y: curY + (h - it.h) / 2 });
          curX += it.w + gapX;
        }
        curY += h + gapY;
      }
      contentH = Math.max(0, curY - gapY);
    }

    const titleW = grp.title ? measureLines([grp.title], 12).textW + 24 : 0;
    const totalW = Math.max(contentW + padX * 2, titleW + padX * 2, 160);
    const totalH = Math.max(contentH + headerH + padY * 2, 72);

    const box = {
      id: groupId,
      title: grp.title,
      depth: grp.depth,
      x: 0,
      y: 0,
      w: totalW,
      h: totalH,
      padX,
      padY,
      headerH,
      localPos,
      contentOffsetX: (totalW - contentW) / 2,
    };
    groupBox.set(groupId, box);
    return box;
  }

  function assignAbsolute(groupId, absX, absY) {
    const grp = subgraphs.get(groupId);
    const gb = groupBox.get(groupId);
    gb.x = absX;
    gb.y = absY;

    for (const cid of grp.childNodes) {
      const lp = gb.localPos.get(cid);
      const nb = nodeBox.get(cid);
      nb.x = absX + gb.contentOffsetX + lp.x;
      nb.y = absY + gb.headerH + gb.padY + lp.y;
    }
    for (const gid of grp.childGroups) {
      const lp = gb.localPos.get(gid);
      assignAbsolute(gid, absX + gb.contentOffsetX + lp.x, absY + gb.headerH + gb.padY + lp.y);
    }
  }

  const rootBox = layoutGroup("__root__");
  assignAbsolute("__root__", 0, 0);

  return {
    type: "flowchart",
    nodes,
    subgraphs,
    edges,
    nodeBox,
    groupBox,
    width: Math.ceil(rootBox.w),
    height: Math.ceil(rootBox.h),
  };
}

function getEntityRect(model, id) {
  if (model.nodeBox.has(id)) return model.nodeBox.get(id);
  if (model.groupBox.has(id)) return model.groupBox.get(id);
  return null;
}

function computeEdgePoints(r1, r2) {
  const c1x = r1.x + r1.w / 2;
  const c1y = r1.y + r1.h / 2;
  const c2x = r2.x + r2.w / 2;
  const c2y = r2.y + r2.h / 2;
  const dx = c2x - c1x;
  const dy = c2y - c1y;

  let x1; let y1; let x2; let y2;
  if (Math.abs(dy) >= Math.abs(dx) * 0.55) {
    if (dy >= 0) {
      x1 = c1x; y1 = r1.y + r1.h;
      x2 = c2x; y2 = r2.y;
    } else {
      x1 = c1x; y1 = r1.y;
      x2 = c2x; y2 = r2.y + r2.h;
    }
    const midY = (y1 + y2) / 2;
    return {
      d: `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`,
      lx: (x1 + x2) / 2,
      ly: midY,
    };
  }
  if (dx >= 0) {
    x1 = r1.x + r1.w; y1 = c1y;
    x2 = r2.x; y2 = c2y;
  } else {
    x1 = r1.x; y1 = c1y;
    x2 = r2.x + r2.w; y2 = c2y;
  }
  const midX = (x1 + x2) / 2;
  return {
    d: `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`,
    lx: midX,
    ly: (y1 + y2) / 2,
  };
}

function buildFlowchartSvg(doc, model) {
  const svg = svgEl(doc, "svg", {
    viewBox: `0 0 ${model.width} ${model.height}`,
    width: model.width,
    height: model.height,
    class: "md-mermaid-svg",
    role: "img",
  });

  const defs = svgEl(doc, "defs");
  const markerEnd = svgEl(doc, "marker", {
    id: "md-arrow-end",
    viewBox: "0 0 10 10",
    refX: "8.5",
    refY: "5",
    markerWidth: "7",
    markerHeight: "7",
    orient: "auto",
  });
  markerEnd.appendChild(svgEl(doc, "path", { d: "M 0 1.5 L 9 5 L 0 8.5 z", fill: "var(--muted)" }));
  defs.appendChild(markerEnd);

  const markerStart = svgEl(doc, "marker", {
    id: "md-arrow-start",
    viewBox: "0 0 10 10",
    refX: "1.5",
    refY: "5",
    markerWidth: "7",
    markerHeight: "7",
    orient: "auto",
  });
  markerStart.appendChild(svgEl(doc, "path", { d: "M 10 1.5 L 1 5 L 10 8.5 z", fill: "var(--muted)" }));
  defs.appendChild(markerStart);
  svg.appendChild(defs);

  // 1. Subgraph containers (outer to inner)
  const orderedGroups = [...model.groupBox.values()]
    .filter((g) => g.id !== "__root__")
    .sort((a, b) => a.depth - b.depth);
  let topColorIdx = 0;
  const topColorMap = new Map();
  for (const g of orderedGroups) {
    let pal;
    if (g.depth === 1) {
      pal = SUBGRAPH_PALETTE[topColorIdx % SUBGRAPH_PALETTE.length];
      topColorMap.set(g.id, pal);
      topColorIdx++;
    } else {
      const parentId = model.subgraphs.get(g.id)?.parentId;
      pal = topColorMap.get(parentId) || SUBGRAPH_PALETTE[0];
      topColorMap.set(g.id, pal);
    }
    svg.appendChild(svgEl(doc, "rect", {
      x: g.x,
      y: g.y,
      width: g.w,
      height: g.h,
      rx: "10",
      fill: pal.fill,
      stroke: pal.stroke,
      "stroke-width": "1.3",
      ...(g.depth > 1 ? { "stroke-dasharray": "5 3" } : {}),
    }));
    if (g.title) {
      svg.appendChild(svgEl(doc, "text", {
        x: g.x + 14,
        y: g.y + 21,
        "font-size": "12",
        "font-weight": "700",
        fill: "var(--strong)",
      }, g.title));
    }
  }

  // 2. Curved Edges
  for (const edge of model.edges) {
    const r1 = getEntityRect(model, edge.from);
    const r2 = getEntityRect(model, edge.to);
    if (!r1 || !r2) continue;
    const { d, lx, ly } = computeEdgePoints(r1, r2);
    const attrs = {
      d,
      fill: "none",
      stroke: "var(--muted)",
      "stroke-width": edge.kind === "thick" ? "2.4" : "1.5",
    };
    if (edge.kind === "dashed") attrs["stroke-dasharray"] = "5 4";
    if (edge.kind !== "line") attrs["marker-end"] = "url(#md-arrow-end)";
    if (edge.kind === "both") attrs["marker-start"] = "url(#md-arrow-start)";
    svg.appendChild(svgEl(doc, "path", attrs));

    if (edge.label) {
      const lblW = measureLines([edge.label], 11).textW + 14;
      svg.appendChild(svgEl(doc, "rect", {
        x: lx - lblW / 2,
        y: ly - 10,
        width: lblW,
        height: 20,
        rx: "5",
        fill: "var(--paper)",
        stroke: "var(--line)",
        "stroke-width": "1",
      }));
      svg.appendChild(svgEl(doc, "text", {
        x: lx,
        y: ly + 4,
        "text-anchor": "middle",
        "font-size": "11",
        fill: "var(--muted)",
      }, edge.label));
    }
  }

  // 3. Nodes (with distinct shapes & multi-line text)
  for (const [id, node] of model.nodes.entries()) {
    const b = model.nodeBox.get(id);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;

    if (node.shape === "diamond") {
      const pts = `${cx},${b.y} ${b.x + b.w},${cy} ${cx},${b.y + b.h} ${b.x},${cy}`;
      svg.appendChild(svgEl(doc, "polygon", {
        points: pts,
        fill: "var(--chrome)",
        stroke: "var(--warning, var(--accent))",
        "stroke-width": "1.6",
      }));
    } else if (node.shape === "cylinder") {
      const ry = 7;
      svg.appendChild(svgEl(doc, "path", {
        d: `M ${b.x} ${b.y + ry} L ${b.x} ${b.y + b.h - ry} A ${b.w / 2} ${ry} 0 0 0 ${b.x + b.w} ${b.y + b.h - ry} L ${b.x + b.w} ${b.y + ry}`,
        fill: "var(--chrome)",
        stroke: "var(--accent)",
        "stroke-width": "1.6",
      }));
      svg.appendChild(svgEl(doc, "ellipse", {
        cx,
        cy: b.y + ry,
        rx: b.w / 2,
        ry,
        fill: "var(--chrome)",
        stroke: "var(--accent)",
        "stroke-width": "1.6",
      }));
    } else {
      const rx = node.shape === "stadium" || node.shape === "circle" ? b.h / 2 : node.shape === "round" ? 12 : 7;
      svg.appendChild(svgEl(doc, "rect", {
        x: b.x,
        y: b.y,
        width: b.w,
        height: b.h,
        rx: String(rx),
        fill: "var(--chrome)",
        stroke: "var(--accent)",
        "stroke-width": "1.5",
      }));
    }

    appendMultilineText(doc, svg, b.lines, cx, node.shape === "cylinder" ? cy + 3 : cy, {
      "font-size": "12.5",
      fill: "var(--strong)",
    });
  }

  return svg;
}

/* ==========================================================================
   2. Sequence Diagram Parser & Renderer (aliases, dashed arrows, alt/else)
   ========================================================================== */
function parseSequence(lines) {
  const participants = [];
  const pMap = new Map();
  const events = [];

  const ensureP = (id, label) => {
    const clean = id.trim();
    if (!clean) return null;
    if (!pMap.has(clean)) {
      const entry = { id: clean, label: (label || clean).trim() };
      pMap.set(clean, entry);
      participants.push(entry);
    } else if (label) {
      pMap.get(clean).label = label.trim();
    }
    return clean;
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("%%")) continue;

    const pMatch = line.match(/^(?:participant|actor)\s+([A-Za-z0-9_.-]+)(?:\s+as\s+(.+))?$/i);
    if (pMatch) {
      ensureP(pMatch[1], pMatch[2]);
      continue;
    }
    const blockMatch = line.match(/^(alt|else|opt|loop)\s*(.*)$/i);
    if (blockMatch) {
      events.push({ kind: blockMatch[1].toLowerCase(), text: blockMatch[2].trim() });
      continue;
    }
    if (/^end$/i.test(line)) {
      events.push({ kind: "end" });
      continue;
    }

    const msgMatch = line.match(/^([A-Za-z0-9_.-]+?)\s*(-->>|->>|-->|->)\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (msgMatch) {
      const from = ensureP(msgMatch[1]);
      const dashed = msgMatch[2].startsWith("--");
      const to = ensureP(msgMatch[3]);
      events.push({ kind: "msg", from, to, dashed, text: msgMatch[4].trim() });
    }
  }

  if (participants.length === 0) return null;
  return { type: "sequence", participants, events };
}

function buildSequenceSvg(doc, model) {
  const boxWidths = model.participants.map((p) => Math.max(108, measureLines([p.label], 12).textW + 26));
  const colGap = 58;
  const padX = 28;
  const topY = 20;
  const boxH = 34;

  const xOf = new Map();
  let curX = padX;
  model.participants.forEach((p, idx) => {
    const w = boxWidths[idx];
    xOf.set(p.id, { cx: curX + w / 2, w });
    curX += w + colGap;
  });

  const rows = [];
  let rowY = topY + boxH + 34;
  for (const ev of model.events) {
    if (ev.kind === "msg") {
      rows.push({ ...ev, y: rowY });
      rowY += 42;
    } else if (ev.kind === "alt" || ev.kind === "opt" || ev.kind === "loop" || ev.kind === "else") {
      rows.push({ ...ev, y: rowY - 12 });
      rowY += 24;
    }
  }

  const width = Math.max(360, curX - colGap + padX);
  const height = Math.max(140, rowY + 24);

  const svg = svgEl(doc, "svg", {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    class: "md-mermaid-svg",
    role: "img",
  });

  const defs = svgEl(doc, "defs");
  const arrow = svgEl(doc, "marker", {
    id: "md-seq-arrow",
    viewBox: "0 0 10 10",
    refX: "8.5",
    refY: "5",
    markerWidth: "7",
    markerHeight: "7",
    orient: "auto",
  });
  arrow.appendChild(svgEl(doc, "path", { d: "M 0 1.5 L 9 5 L 0 8.5 z", fill: "var(--accent)" }));
  defs.appendChild(arrow);
  svg.appendChild(defs);

  model.participants.forEach((p) => {
    const { cx, w } = xOf.get(p.id);
    svg.appendChild(svgEl(doc, "line", {
      x1: cx, y1: topY + boxH, x2: cx, y2: height - 16,
      stroke: "var(--line)", "stroke-dasharray": "4 4", "stroke-width": "1.5",
    }));
    svg.appendChild(svgEl(doc, "rect", {
      x: cx - w / 2, y: topY, width: w, height: boxH, rx: "7",
      fill: "var(--chrome)", stroke: "var(--accent)", "stroke-width": "1.5",
    }));
    svg.appendChild(svgEl(doc, "text", {
      x: cx, y: topY + 21, "text-anchor": "middle", "font-size": "12", "font-weight": "600", fill: "var(--strong)",
    }, p.label));
  });

  for (const r of rows) {
    if (r.kind !== "msg") {
      svg.appendChild(svgEl(doc, "line", {
        x1: padX - 8, y1: r.y, x2: width - padX + 8, y2: r.y,
        stroke: "var(--line)", "stroke-dasharray": "6 3", "stroke-width": "1.2",
      }));
      svg.appendChild(svgEl(doc, "text", {
        x: padX, y: r.y + 13, "font-size": "11", "font-weight": "600", fill: "var(--warning, var(--accent))",
      }, `[${r.kind}] ${r.text}`));
      continue;
    }
    const p1 = xOf.get(r.from);
    const p2 = xOf.get(r.to);
    if (!p1 || !p2) continue;

    if (r.from === r.to) {
      const loopW = 36;
      svg.appendChild(svgEl(doc, "path", {
        d: `M ${p1.cx} ${r.y - 6} H ${p1.cx + loopW} V ${r.y + 12} H ${p1.cx + 4}`,
        fill: "none", stroke: "var(--accent)", "stroke-width": "1.5", "marker-end": "url(#md-seq-arrow)",
      }));
      svg.appendChild(svgEl(doc, "text", {
        x: p1.cx + loopW + 8, y: r.y + 6, "font-size": "11.5", fill: "var(--ink)",
      }, r.text));
      continue;
    }

    svg.appendChild(svgEl(doc, "line", {
      x1: p1.cx, y1: r.y, x2: p2.cx, y2: r.y,
      stroke: "var(--accent)",
      "stroke-width": "1.6",
      "marker-end": "url(#md-seq-arrow)",
      ...(r.dashed ? { "stroke-dasharray": "5 3" } : {}),
    }));
    const midX = (p1.cx + p2.cx) / 2;
    const lblW = measureLines([r.text], 11.5).textW + 10;
    svg.appendChild(svgEl(doc, "rect", {
      x: midX - lblW / 2, y: r.y - 19, width: lblW, height: 16, rx: "4",
      fill: "var(--paper)",
    }));
    svg.appendChild(svgEl(doc, "text", {
      x: midX, y: r.y - 7, "text-anchor": "middle", "font-size": "11.5", fill: "var(--ink)",
    }, r.text));
  }

  return svg;
}

/* ==========================================================================
   3. State Diagram (stateDiagram-v2) Parser -> Reuses Flowchart Renderer
   ========================================================================== */
function parseStateDiagram(lines) {
  const synth = ["flowchart TD"];
  let startCount = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("%%")) continue;
    const m = line.match(/^(\[\*\]|[A-Za-z0-9_.-]+)\s*-->\s*(\[\*\]|[A-Za-z0-9_.-]+)(?:\s*:\s*(.*))?$/);
    if (!m) continue;
    let from = m[1];
    let to = m[2];
    const lbl = (m[3] || "").trim().replace(/\\n/g, " ");
    if (from === "[*]") {
      startCount++;
      from = `Start${startCount}((开始))`;
    }
    if (to === "[*]") {
      startCount++;
      to = `End${startCount}((结束))`;
    }
    synth.push(lbl ? `${from} -->|${lbl}| ${to}` : `${from} --> ${to}`);
  }
  if (synth.length <= 1) return null;
  return parseFlowchart(synth);
}

/* ==========================================================================
   4. Public Entry with Zoom + Fit + Source Toggle
   ========================================================================== */
export function renderMermaidBlock(doc, codeText, options = {}) {
  const lines = String(codeText || "").trim().split("\n");
  const first = (lines[0] || "").trim().toLowerCase();
  let model = null;
  if (first.startsWith("flowchart") || first.startsWith("graph")) {
    model = parseFlowchart(lines);
  } else if (first.startsWith("sequencediagram")) {
    model = parseSequence(lines);
  } else if (first.startsWith("statediagram")) {
    model = parseStateDiagram(lines);
  } else if (first.startsWith("pie")) {
    model = parsePie(lines);
  } else if (first.startsWith("gantt")) {
    model = parseGantt(lines);
  } else if (first.startsWith("mindmap")) {
    model = parseMindmap(lines);
  } else if (first.startsWith("classdiagram")) {
    model = parseClassDiagram(lines);
  } else if (first.startsWith("erdiagram")) {
    model = parseErDiagram(lines);
  }

  const wrapper = doc.createElement("div");
  wrapper.className = "md-code-block md-mermaid-block";

  const header = doc.createElement("div");
  header.className = "md-code-header";

  const label = doc.createElement("span");
  label.className = "md-code-lang";
  label.textContent = model ? "mermaid (离线图示)" : "mermaid (源码回退)";
  header.appendChild(label);

  const actions = doc.createElement("div");
  actions.className = "md-mermaid-actions";

  const pre = doc.createElement("pre");
  const codeEl = doc.createElement("code");
  codeEl.className = "language-mermaid";
  codeEl.textContent = codeText;
  pre.appendChild(codeEl);

  if (model && typeof doc.createElementNS === "function") {
    const diagramWrap = doc.createElement("div");
    diagramWrap.className = "md-mermaid-canvas";
    const svg = model.type === "flowchart"
      ? buildFlowchartSvg(doc, model)
      : model.type === "sequence"
        ? buildSequenceSvg(doc, model)
        : model.type === "pie"
          ? buildPieSvg(doc, model)
          : model.type === "gantt"
            ? buildGanttSvg(doc, model)
            : model.type === "mindmap"
              ? buildMindmapSvg(doc, model)
              : buildEntityDiagramSvg(doc, model);
    const baseW = Number(svg.getAttribute("width")) || 600;
    const baseH = Number(svg.getAttribute("height")) || 260;
    let zoom = 1;
    let fitMode = false;

    const applyZoom = () => {
      if (fitMode) {
        svg.style.width = "100%";
        svg.style.height = "auto";
        svg.style.maxWidth = "100%";
        zoomLabel.textContent = "适应";
      } else {
        svg.style.maxWidth = "none";
        svg.style.width = `${Math.round(baseW * zoom)}px`;
        svg.style.height = `${Math.round(baseH * zoom)}px`;
        zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
      }
    };

    const zoomOutBtn = doc.createElement("button");
    zoomOutBtn.type = "button";
    zoomOutBtn.className = "md-copy-btn";
    zoomOutBtn.textContent = "−";
    zoomOutBtn.title = "缩小图示";

    const zoomLabel = doc.createElement("button");
    zoomLabel.type = "button";
    zoomLabel.className = "md-copy-btn";
    zoomLabel.textContent = "100%";
    zoomLabel.title = "切换 100% 原尺寸 / 适应容器宽度";

    const zoomInBtn = doc.createElement("button");
    zoomInBtn.type = "button";
    zoomInBtn.className = "md-copy-btn";
    zoomInBtn.textContent = "+";
    zoomInBtn.title = "放大图示";

    zoomOutBtn.addEventListener("click", () => {
      fitMode = false;
      zoom = Math.max(0.5, Math.round((zoom - 0.15) * 100) / 100);
      applyZoom();
    });
    zoomInBtn.addEventListener("click", () => {
      fitMode = false;
      zoom = Math.min(2.2, Math.round((zoom + 0.15) * 100) / 100);
      applyZoom();
    });
    zoomLabel.addEventListener("click", () => {
      fitMode = !fitMode;
      if (!fitMode) zoom = 1;
      applyZoom();
    });

    applyZoom();
    diagramWrap.appendChild(svg);
    pre.hidden = true;

    const toggleBtn = doc.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "md-copy-btn";
    toggleBtn.textContent = "源码";
    toggleBtn.addEventListener("click", () => {
      const showRaw = !pre.hidden;
      pre.hidden = showRaw;
      diagramWrap.hidden = !showRaw;
      toggleBtn.textContent = showRaw ? "源码" : "图示";
    });

    actions.appendChild(zoomOutBtn);
    actions.appendChild(zoomLabel);
    actions.appendChild(zoomInBtn);
    actions.appendChild(toggleBtn);
    wrapper.appendChild(header);
    wrapper.appendChild(diagramWrap);
    wrapper.appendChild(pre);
  } else {
    wrapper.appendChild(header);
    wrapper.appendChild(pre);
  }

  const copyBtn = doc.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "md-copy-btn";
  copyBtn.textContent = "复制";
  copyBtn.addEventListener("click", () => {
    if (typeof options.onCopy === "function") options.onCopy(codeText, copyBtn);
  });
  actions.appendChild(copyBtn);
  header.appendChild(actions);

  return wrapper;
}
