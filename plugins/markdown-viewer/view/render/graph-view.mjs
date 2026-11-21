const SVG_NS = "http://www.w3.org/2000/svg";

// Curated Obsidian-inspired soft-vivid palette (crimson red reserved strictly for broken ghost nodes)
const PALETTE = [
  "#6366f1", // indigo
  "#0ea5e9", // sky
  "#14b8a6", // teal
  "#8b5cf6", // violet
  "#f59e0b", // amber
  "#10b981", // emerald
  "#3b82f6", // blue
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#f97316", // orange
];

const DEGREE_TIERS = [
  { key: "hub", label: "核心枢纽 (≥6)", enLabel: "Hub (≥6)", min: 6, color: "#8b5cf6" },
  { key: "high", label: "高连接 (3–5)", enLabel: "High (3–5)", min: 3, color: "#0ea5e9" },
  { key: "mid", label: "已连接 (1–2)", enLabel: "Linked (1–2)", min: 1, color: "#14b8a6" },
  { key: "orphan", label: "孤立节点 (0)", enLabel: "Orphan (0)", min: 0, color: "#94a3b8" },
];

function svgEl(doc, tag, attrs = {}, text = "") {
  const node = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) node.setAttribute(k, String(v));
  }
  if (text) node.textContent = text;
  return node;
}

function nowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function clearBrowserSelection() {
  try {
    if (typeof globalThis.getSelection === "function") {
      globalThis.getSelection()?.removeAllRanges?.();
    }
  } catch {
    // Ignore in headless/mock environments
  }
}

function degreeTierFor(deg) {
  for (const tier of DEGREE_TIERS) {
    if (deg >= tier.min) return tier;
  }
  return DEGREE_TIERS[DEGREE_TIERS.length - 1];
}

function getRawGroupKeyAndLabel(node, colorBy, isEn = false) {
  if (node.isGhost) return { key: "__ghost__", label: isEn ? "Broken Target" : "断链目标", fixedColor: "#ef4444" };
  if (node.isTag) return { key: "__tag__", label: isEn ? "Tag Node" : "标签节点", fixedColor: "#10b981" };
  if (colorBy === "degree") {
    const t = degreeTierFor(node.degree || 0);
    return { key: `deg:${t.key}`, label: isEn ? t.enLabel : t.label, fixedColor: t.color };
  }
  if (colorBy === "tag") {
    const primary = Array.isArray(node.tags) && node.tags.length > 0 ? node.tags[0] : "";
    if (!primary) return { key: "tag:(none)", label: isEn ? "Untagged" : "无标签", fixedColor: "#94a3b8" };
    return { key: `tag:${primary}`, label: `#${primary}`, fixedColor: null };
  }
  const dir = node.dir || "(root)";
  const label = dir === "." || dir === "(root)" ? (isEn ? "(root)" : "根目录") : dir;
  return { key: `dir:${dir}`, label, fixedColor: null };
}

function assignGroupColors(nodes, colorBy, isEn = false) {
  const dynamicKeys = new Set();
  for (const n of nodes) {
    const info = getRawGroupKeyAndLabel(n, colorBy, isEn);
    if (!info.fixedColor) dynamicKeys.add(info.key);
  }
  const sortedKeys = [...dynamicKeys].sort();
  const colorMap = new Map(sortedKeys.map((k, i) => [k, PALETTE[i % PALETTE.length]]));

  const legendMap = new Map();
  for (const n of nodes) {
    const info = getRawGroupKeyAndLabel(n, colorBy, isEn);
    const color = info.fixedColor || colorMap.get(info.key) || PALETTE[0];
    n._groupKey = info.key;
    n._color = color;
    if (!legendMap.has(info.key)) {
      legendMap.set(info.key, { key: info.key, label: info.label, color, count: 0 });
    }
    legendMap.get(info.key).count += 1;
  }
  return [...legendMap.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * Pure undirected BFS shortest path between two node IDs.
 */
export function findShortestPath(edges, fromId, toId) {
  if (!fromId || !toId) return [];
  if (fromId === toId) return [fromId];
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    if (!adj.has(e.target)) adj.set(e.target, []);
    adj.get(e.source).push(e.target);
    adj.get(e.target).push(e.source);
  }
  const visited = new Set([fromId]);
  const prev = new Map();
  const queue = [fromId];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const next of adj.get(cur) || []) {
      if (visited.has(next)) continue;
      visited.add(next);
      prev.set(next, cur);
      if (next === toId) {
        const path = [toId];
        let step = cur;
        while (step !== undefined) {
          path.push(step);
          step = prev.get(step);
        }
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return [];
}

function stepForcePhysics(nodes, edges, nodeMap, params, timeMs, energy) {
  const { cx, cy, scope, centerId, kRepel, springLen, kGravity, ambient } = params;

  // Pairwise repulsion + soft collision spacing
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let dist2 = dx * dx + dy * dy;
      if (dist2 < 1) {
        dx = (i % 2 === 0 ? 1 : -1) * 1.5;
        dy = (j % 2 === 0 ? 1 : -1) * 1.5;
        dist2 = dx * dx + dy * dy;
      }
      const dist = Math.sqrt(dist2);
      let force = Math.min(18, kRepel / (dist2 + 120));
      if (dist < 48) {
        force += (48 - dist) * 0.085;
      }
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
  }

  // Elastic spring edges
  const kSpring = 0.026;
  for (const e of edges) {
    const a = nodeMap.get(e.source);
    const b = nodeMap.get(e.target);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const targetLen = e.kind === "tag" ? springLen * 0.82 : springLen;
    const diff = dist - targetLen;
    const fx = (dx / dist) * diff * kSpring;
    const fy = (dy / dist) * diff * kSpring;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }

  // Center gravity + gentle Obsidian ambient floating + anchored stay-where-dropped
  const damping = 0.86;
  for (const n of nodes) {
    if (n.dragging) {
      n.vx = 0;
      n.vy = 0;
      continue;
    }
    if (n.gliding) {
      // Smooth post-drag inertial glide; updates home anchor so it settles right where placed
      n.x += n.vx;
      n.y += n.vy;
      n.vx *= 0.87;
      n.vy *= 0.87;
      n.homeX = n.x;
      n.homeY = n.y;
      if (Math.hypot(n.vx, n.vy) < 0.14) {
        n.gliding = false;
        n.vx = 0;
        n.vy = 0;
      }
      continue;
    }
    if (n.anchored) {
      // Gently float around the user-chosen drop location without snapping back
      const floatX = ambient ? Math.cos(timeMs * n._freq + n._phase) * 2.1 : 0;
      const floatY = ambient ? Math.sin(timeMs * n._freq * 0.85 + n._phase + 1.1) * 2.1 : 0;
      n.vx = (n.homeX + floatX - n.x) * 0.16;
      n.vy = (n.homeY + floatY - n.y) * 0.16;
      n.x += n.vx;
      n.y += n.vy;
      continue;
    }
    if (n.id === centerId && scope === "local") {
      n.vx = (n.vx + (cx - n.x) * 0.14) * 0.72;
      n.vy = (n.vy + (cy - n.y) * 0.14) * 0.72;
      n.x += n.vx;
      n.y += n.vy;
      continue;
    }

    const gravMul = n.degree === 0 ? 0.55 : 1.0;
    n.vx += (cx - n.x) * kGravity * gravMul;
    n.vy += (cy - n.y) * kGravity * gravMul;

    if (ambient) {
      const t = timeMs * n._freq + n._phase;
      n.vx += Math.cos(t) * 0.055;
      n.vy += Math.sin(t * 0.87 + 1.1) * 0.055;
    }

    n.vx *= damping;
    n.vy *= damping;

    const maxStep = Math.max(2.2, 13 * energy);
    n.x += Math.max(-maxStep, Math.min(maxStep, n.vx));
    n.y += Math.max(-maxStep, Math.min(maxStep, n.vy));
  }
}

function initForcePositions(nodes, edges, nodeMap, { width, height, scope, centerId, repel, linkDist, gravity }) {
  const cx = width / 2;
  const cy = height / 2;
  const groups = [...new Set(nodes.map((n) => n._groupKey || n.dir || "(root)"))].sort();
  const groupIndex = new Map(groups.map((g, i) => [g, i]));
  const baseRadius = Math.min(width, height) * 0.4;

  nodes.forEach((n, idx) => {
    n.vx = 0;
    n.vy = 0;
    if (n.id === centerId && scope === "local") {
      n.x = cx;
      n.y = cy;
      return;
    }
    const gIdx = groupIndex.get(n._groupKey || n.dir || "(root)") || 0;
    const clusterAngle = (gIdx / Math.max(1, groups.length)) * Math.PI * 2;
    const spreadAngle = (idx * 2.39996) % (Math.PI * 2);
    const ringFactor = n.degree === 0 ? 0.92 : (0.35 + 0.52 * Math.sqrt((idx + 1) / nodes.length));
    const r = baseRadius * ringFactor;
    n.x = cx + Math.cos(clusterAngle) * (baseRadius * 0.34) + Math.cos(spreadAngle) * r * 0.78;
    n.y = cy + Math.sin(clusterAngle) * (baseRadius * 0.34) + Math.sin(spreadAngle) * r * 0.78;
  });

  const repelFactor = Math.max(0.3, Math.min(2.5, (repel || 130) / 100));
  const kRepel = Math.max(5200, (98000 / Math.max(8, Math.sqrt(nodes.length) * 3)) * repelFactor);
  const springLen = Math.max(60, Math.min(230, linkDist || (scope === "local" ? 150 : 145)));
  const kGravity = Math.max(0.0025, Math.min(0.035, (gravity || 10) / 1400));

  const params = { cx, cy, scope, centerId, kRepel, springLen, kGravity, ambient: false };
  const warmupSteps = Math.min(150, Math.max(90, nodes.length * 3));
  for (let i = 0; i < warmupSteps; i++) {
    stepForcePhysics(nodes, edges, nodeMap, params, 0, 1.0);
  }
  for (const n of nodes) {
    n.homeX = n.x;
    n.homeY = n.y;
  }
  return { ...params, ambient: true };
}

function layoutRadial(nodes, { width, height, linkDist }) {
  const cx = width / 2;
  const cy = height / 2;
  const groups = new Map();
  for (const n of nodes) {
    const gk = n._groupKey || "default";
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(n);
  }
  const orderedGroups = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const total = Math.max(1, nodes.length);
  const scaleRing = Math.max(0.8, Math.min(1.7, (linkDist || 145) / 120));
  const innerR = Math.min(width, height) * 0.22 * scaleRing;
  const outerR = Math.min(width, height) * 0.46 * scaleRing;

  let cursorAngle = -Math.PI / 2;
  for (const [, list] of orderedGroups) {
    list.sort((a, b) => (b.degree || 0) - (a.degree || 0));
    const slice = (list.length / total) * Math.PI * 2;
    const pad = Math.min(0.07, slice * 0.14);
    list.forEach((n, idx) => {
      const frac = list.length === 1 ? 0.5 : idx / (list.length - 1);
      const angle = cursorAngle + pad + frac * Math.max(0.02, slice - pad * 2);
      const ringBand = idx % 3;
      const r = list.length <= 2
        ? (innerR + outerR) * 0.45
        : innerR + (outerR - innerR) * (ringBand === 0 ? 0.25 : ringBand === 1 ? 0.65 : 1.0);
      n.x = cx + Math.cos(angle) * r;
      n.y = cy + Math.sin(angle) * r;
      n.homeX = n.x;
      n.homeY = n.y;
    });
    cursorAngle += slice;
  }
}

function layoutHierarchy(nodes, edges, nodeMap, { width, height, centerId, linkDist }) {
  const adj = new Map(nodes.map((n) => [n.id, new Set()]));
  for (const e of edges) {
    adj.get(e.source)?.add(e.target);
    adj.get(e.target)?.add(e.source);
  }

  let rootId = centerId && nodeMap.has(centerId) ? centerId : "";
  if (!rootId) {
    const sorted = [...nodes].sort((a, b) => (b.degree || 0) - (a.degree || 0));
    rootId = sorted[0]?.id || "";
  }

  const levels = new Map();
  const visited = new Set();
  if (rootId) {
    visited.add(rootId);
    levels.set(rootId, 0);
    const queue = [rootId];
    while (queue.length > 0) {
      const cur = queue.shift();
      const d = levels.get(cur);
      for (const next of adj.get(cur) || []) {
        if (!visited.has(next)) {
          visited.add(next);
          levels.set(next, d + 1);
          queue.push(next);
        }
      }
    }
  }

  let maxLevel = 0;
  for (const lv of levels.values()) maxLevel = Math.max(maxLevel, lv);
  const disconnected = nodes.filter((n) => !visited.has(n.id));
  if (disconnected.length > 0) {
    const unreachLevel = visited.size > 0 ? maxLevel + 1 : 0;
    for (const n of disconnected) levels.set(n.id, unreachLevel);
  }

  const rows = new Map();
  for (const n of nodes) {
    const lv = levels.get(n.id) ?? 0;
    if (!rows.has(lv)) rows.set(lv, []);
    rows.get(lv).push(n);
  }

  const orderedLevels = [...rows.keys()].sort((a, b) => a - b);
  const rowGap = Math.max(92, Math.min(185, (linkDist || 145) * 0.95));
  const colGap = Math.max(105, Math.min(185, (linkDist || 145) * 0.92));
  const totalH = (orderedLevels.length - 1) * rowGap;
  const startY = height / 2 - totalH / 2;

  orderedLevels.forEach((lv, rowIdx) => {
    const list = rows.get(lv);
    list.sort((a, b) =>
      String(a._groupKey || "").localeCompare(String(b._groupKey || ""))
      || (b.degree || 0) - (a.degree || 0)
      || a.id.localeCompare(b.id)
    );
    const maxPerRow = Math.max(7, Math.ceil(Math.sqrt(list.length) * 2.1));
    list.forEach((n, idx) => {
      const subRow = Math.floor(idx / maxPerRow);
      const subIdx = idx % maxPerRow;
      const subCount = Math.min(maxPerRow, list.length - subRow * maxPerRow);
      const rowW = (subCount - 1) * colGap;
      n.x = width / 2 - rowW / 2 + subIdx * colGap;
      n.y = startY + rowIdx * rowGap + subRow * 68;
      n.homeX = n.x;
      n.homeY = n.y;
    });
  });
}

function computeFitCamera(points, width, height) {
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x - 52);
    maxX = Math.max(maxX, p.x + 52);
    minY = Math.min(minY, p.y - 38);
    maxY = Math.max(maxY, p.y + 38);
  }
  const bw = Math.max(160, maxX - minX);
  const bh = Math.max(160, maxY - minY);
  const scale = Math.max(0.35, Math.min(1.45, Math.min((width - 72) / bw, (height - 72) / bh)));
  return {
    scale,
    x: width / 2 - ((minX + maxX) / 2) * scale,
    y: height / 2 - ((minY + maxY) / 2) * scale,
  };
}

/**
 * Pure-DOM offline interactive Obsidian-style Knowledge Graph renderer.
 * Features live continuous inertial physics & gentle ambient floating, stay-where-dropped
 * drag inertia without selection highlights, smooth glide morphing when switching layouts
 * or color dimensions, sleek node proportions, non-colliding palette, tag nodes, N-hop local
 * depth, interactive legend, shortest-path tracing, smart LOD labels, and SVG export.
 */
export function renderKnowledgeGraph(container, rawGraph, options = {}) {
  if (typeof container._graphCleanup === "function") {
    container._graphCleanup();
    container._graphCleanup = null;
  }

  const doc = options.document || globalThis.document;
  const isEn = String(options.locale || doc.documentElement?.lang || "").toLowerCase().startsWith("en");
  const {
    activePath = "",
    centerId = "",
    scope = "global", // "global" | "local"
    localDepth = 1, // 1 | 2 | 3
    linkDirection = "both", // "both" | "in" | "out"
    layout = "force", // "force" | "radial" | "hierarchy"
    colorBy = "dir", // "dir" | "degree" | "tag"
    showOrphans = true,
    showGhosts = true,
    showTags = false,
    showArrows = true,
    smartLabels = false,
    animatePhysics = true,
    repel = 130,
    linkDist = 145,
    gravity = 10,
    nodeScale = 100,
    filterQuery = "",
    highlightGroup = null,
    pathFromId = "",
    pathToId = "",
    onOpenFile = null,
    onSelectNode = null,
  } = options;

  while (container.firstChild) container.removeChild(container.firstChild);

  const effectiveCenter = centerId || activePath;
  const rawNodes = Array.isArray(rawGraph?.nodes) ? rawGraph.nodes : [];
  const rawEdges = Array.isArray(rawGraph?.edges) ? rawGraph.edges : [];
  const q = String(filterQuery || "").trim().toLowerCase();

  let currentLayout = layout;
  let currentColorBy = colorBy;
  let currentRepel = repel;
  let currentLinkDist = linkDist;
  let currentGravity = gravity;

  // Clone base nodes & edges, optionally synthesize #tag cluster nodes
  const workingNodes = rawNodes.map((n) => ({
    ...n,
    tags: Array.isArray(n.tags) ? [...n.tags] : [],
    isTag: Boolean(n.isTag),
    isGhost: Boolean(n.isGhost),
  }));
  const workingEdges = rawEdges.map((e) => ({ ...e }));

  if (showTags) {
    const tagNodeMap = new Map();
    for (const n of workingNodes) {
      if (n.isGhost || n.isTag) continue;
      for (const tag of n.tags) {
        const cleanTag = String(tag || "").trim();
        if (!cleanTag) continue;
        const tid = `tag::${cleanTag}`;
        if (!tagNodeMap.has(tid)) {
          tagNodeMap.set(tid, {
            id: tid,
            label: `#${cleanTag}`,
            dir: "(tags)",
            tags: [cleanTag],
            inDegree: 0,
            outDegree: 0,
            degree: 0,
            isGhost: false,
            isTag: true,
          });
        }
        workingEdges.push({
          source: n.id,
          target: tid,
          kind: "tag",
          broken: false,
        });
      }
    }
    for (const tn of tagNodeMap.values()) {
      workingNodes.push(tn);
    }
  }

  // Recompute degrees cleanly on working set
  const workingById = new Map(workingNodes.map((n) => [n.id, n]));
  for (const n of workingNodes) {
    n.inDegree = 0;
    n.outDegree = 0;
    n.degree = 0;
  }
  for (const e of workingEdges) {
    const s = workingById.get(e.source);
    const t = workingById.get(e.target);
    if (s && t) {
      s.outDegree += 1;
      t.inDegree += 1;
      s.degree += 1;
      t.degree += 1;
    }
  }

  // Filter nodes & edges by toggles + N-hop local BFS
  let allowedIds = new Set(workingNodes.map((n) => n.id));
  if (!showGhosts) {
    for (const n of workingNodes) {
      if (n.isGhost) allowedIds.delete(n.id);
    }
  }
  if (!showOrphans) {
    for (const n of workingNodes) {
      if (n.degree === 0) allowedIds.delete(n.id);
    }
  }
  if (scope === "local") {
    if (!effectiveCenter || !allowedIds.has(effectiveCenter)) {
      allowedIds = new Set();
    } else {
      const depthLimit = Math.max(1, Math.min(3, Number(localDepth) || 1));
      const localSet = new Set([effectiveCenter]);
      let frontier = [effectiveCenter];
      for (let hop = 0; hop < depthLimit; hop++) {
        const nextFrontier = [];
        for (const cur of frontier) {
          for (const e of workingEdges) {
            if (linkDirection !== "in" && e.source === cur && allowedIds.has(e.target) && !localSet.has(e.target)) {
              localSet.add(e.target);
              nextFrontier.push(e.target);
            }
            if (linkDirection !== "out" && e.target === cur && allowedIds.has(e.source) && !localSet.has(e.source)) {
              localSet.add(e.source);
              nextFrontier.push(e.source);
            }
          }
        }
        frontier = nextFrontier;
        if (frontier.length === 0) break;
      }
      allowedIds = localSet;
    }
  }

  const nodes = workingNodes
    .filter((n) => allowedIds.has(n.id))
    .map((n, idx) => ({
      ...n,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      homeX: 0,
      homeY: 0,
      dragging: false,
      gliding: false,
      anchored: false,
      _phase: (idx * 1.73205) % (Math.PI * 2),
      _freq: 0.00055 + ((idx * 37) % 100) * 0.0000042,
    }));
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const edges = workingEdges.filter((e) => nodeMap.has(e.source) && nodeMap.has(e.target));

  if (nodes.length === 0) {
    const empty = doc.createElement("div");
    empty.className = "graph-empty muted";
    empty.textContent = scope === "local" && !effectiveCenter
      ? (isEn
        ? "Open a note or pick a node in Global Graph as local center, or switch to Global Graph."
        : "请先打开一篇文档或在全局图谱中选择节点作为局部中心，或切换为「全局图谱」。")
      : (isEn ? "No nodes match current filter." : "当前筛选条件下没有可显示的文档节点。");
    container.appendChild(empty);
    return {
      nodeCount: 0,
      edgeCount: 0,
      legend: [],
      pathNodes: [],
      fit: () => {},
      zoomBy: () => {},
      focusNode: () => false,
      setHighlightGroup: () => {},
      setPathTarget: () => [],
      setLayout: () => {},
      setColorBy: () => [],
      destroy: () => {},
      serializeSvg: () => "",
    };
  }

  // Build adjacency & incoming/outgoing lists
  const neighbors = new Map(nodes.map((n) => [n.id, new Set([n.id])]));
  const inLinksMap = new Map(nodes.map((n) => [n.id, []]));
  const outLinksMap = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    neighbors.get(e.source).add(e.target);
    neighbors.get(e.target).add(e.source);
    const srcNode = nodeMap.get(e.source);
    const dstNode = nodeMap.get(e.target);
    outLinksMap.get(e.source).push({
      id: dstNode.id,
      label: dstNode.label,
      isGhost: dstNode.isGhost,
      isTag: dstNode.isTag,
      kind: e.kind,
    });
    inLinksMap.get(e.target).push({
      id: srcNode.id,
      label: srcNode.label,
      isGhost: srcNode.isGhost,
      isTag: srcNode.isTag,
      kind: e.kind,
    });
  }

  // Assign non-colliding colors & build legend
  let legend = assignGroupColors(nodes, currentColorBy, isEn);

  const width = Math.max(container.clientWidth || 920, 680);
  const height = Math.max(container.clientHeight || 600, 460);

  function computeTargetLayout(targetLayout, opts = {}) {
    const shadows = nodes.map((n) => ({
      id: n.id,
      dir: n.dir,
      _groupKey: n._groupKey,
      degree: n.degree,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      homeX: 0,
      homeY: 0,
      dragging: false,
      gliding: false,
      anchored: false,
      _phase: n._phase,
      _freq: n._freq,
    }));
    const shadowMap = new Map(shadows.map((s) => [s.id, s]));
    let nextForceParams = null;
    if (targetLayout === "radial") {
      layoutRadial(shadows, { width, height, linkDist: opts.linkDist ?? currentLinkDist });
    } else if (targetLayout === "hierarchy") {
      layoutHierarchy(shadows, edges, shadowMap, {
        width,
        height,
        centerId: effectiveCenter,
        linkDist: opts.linkDist ?? currentLinkDist,
      });
    } else {
      nextForceParams = initForcePositions(shadows, edges, shadowMap, {
        width,
        height,
        scope,
        centerId: effectiveCenter,
        repel: opts.repel ?? currentRepel,
        linkDist: opts.linkDist ?? currentLinkDist,
        gravity: opts.gravity ?? currentGravity,
      });
    }
    const coords = new Map(shadows.map((s) => [s.id, { x: s.x, y: s.y }]));
    return { coords, nextForceParams, fitCam: computeFitCamera(shadows, width, height) };
  }

  // Initial layout coordinates
  const initialPlan = computeTargetLayout(currentLayout);
  let forceParams = initialPlan.nextForceParams;
  for (const n of nodes) {
    const pos = initialPlan.coords.get(n.id);
    if (pos) {
      n.x = pos.x;
      n.y = pos.y;
      n.homeX = pos.x;
      n.homeY = pos.y;
    }
  }

  // Construct Pure DOM SVG
  const svg = svgEl(doc, "svg", {
    class: "graph-svg",
    xmlns: SVG_NS,
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": "文档双向链接知识图谱",
  });

  const defs = svgEl(doc, "defs");
  const makeMarker = (id, fill) => {
    const mk = svgEl(doc, "marker", {
      id,
      viewBox: "0 0 10 10",
      refX: "13.5",
      refY: "5",
      markerWidth: "4.8",
      markerHeight: "4.8",
      orient: "auto",
    });
    mk.appendChild(svgEl(doc, "path", { d: "M 0 2 L 8 5 L 0 8 z", fill }));
    return mk;
  };
  defs.appendChild(makeMarker("graph-arrow", "var(--muted)"));
  defs.appendChild(makeMarker("graph-arrow-active", "var(--accent)"));
  defs.appendChild(makeMarker("graph-arrow-path", "#f59e0b"));
  svg.appendChild(defs);

  const viewport = svgEl(doc, "g", { class: "graph-viewport" });
  const edgesLayer = svgEl(doc, "g", { class: "graph-edges" });
  const nodesLayer = svgEl(doc, "g", { class: "graph-nodes" });
  viewport.appendChild(edgesLayer);
  viewport.appendChild(nodesLayer);
  svg.appendChild(viewport);
  container.appendChild(svg);

  // Camera, selection & morph animation state
  const cam = { x: 0, y: 0, scale: 1 };
  let activeHighlightGroup = highlightGroup || null;
  let activePathNodes = findShortestPath(edges, pathFromId, pathToId);
  let hoveredId = null;
  let selectedId = scope === "local" && effectiveCenter && nodeMap.has(effectiveCenter) ? effectiveCenter : null;
  let physicsEnergy = 0.36;
  let activeMorph = null;

  const nodeEls = new Map();

  function buildNodeDetail(n) {
    if (!n) return null;
    return {
      ...n,
      inLinks: inLinksMap.get(n.id) || [],
      outLinks: outLinksMap.get(n.id) || [],
    };
  }

  function applyLabelLod() {
    if (!smartLabels) {
      for (const item of nodeEls.values()) {
        item.text.setAttribute("opacity", "1");
      }
      return;
    }
    const focusId = hoveredId || selectedId;
    const focusNeighbors = focusId ? neighbors.get(focusId) : null;
    const pathSet = new Set(activePathNodes);
    const hideLowDegree = cam.scale < 0.92 && nodes.length > 14;
    for (const [id, item] of nodeEls.entries()) {
      const keep = !hideLowDegree
        || item.node.degree >= 3
        || id === activePath
        || id === effectiveCenter
        || id === focusId
        || (focusNeighbors && focusNeighbors.has(id))
        || pathSet.has(id)
        || (q && item.matchedQuery);
      item.text.setAttribute("opacity", keep ? "1" : "0");
    }
  }

  const applyCam = () => {
    viewport.setAttribute("transform", `translate(${cam.x.toFixed(1)}, ${cam.y.toFixed(1)}) scale(${cam.scale.toFixed(3)})`);
    applyLabelLod();
  };

  function fitToView() {
    const fitted = computeFitCamera(nodes, width, height);
    cam.x = fitted.x;
    cam.y = fitted.y;
    cam.scale = fitted.scale;
    applyCam();
  }

  // Render edges
  const edgeEls = edges.map((e) => {
    const a = nodeMap.get(e.source);
    const b = nodeMap.get(e.target);
    const attrs = {
      x1: a.x.toFixed(1),
      y1: a.y.toFixed(1),
      x2: b.x.toFixed(1),
      y2: b.y.toFixed(1),
      class: `graph-edge${e.broken ? " broken" : ""}${e.kind === "tag" ? " tag-edge" : ""}${e.kind === "markdown" ? " md-edge" : ""}`,
    };
    if (showArrows && e.kind !== "tag") {
      attrs["marker-end"] = "url(#graph-arrow)";
    }
    const line = svgEl(doc, "line", attrs);
    edgesLayer.appendChild(line);
    return { edge: e, el: line };
  });

  function syncAllPositionsToDom() {
    for (const n of nodes) {
      const item = nodeEls.get(n.id);
      if (item) {
        item.g.setAttribute("transform", `translate(${n.x.toFixed(1)}, ${n.y.toFixed(1)})`);
      }
    }
    for (const item of edgeEls) {
      const a = nodeMap.get(item.edge.source);
      const b = nodeMap.get(item.edge.target);
      item.el.setAttribute("x1", a.x.toFixed(1));
      item.el.setAttribute("y1", a.y.toFixed(1));
      item.el.setAttribute("x2", b.x.toFixed(1));
      item.el.setAttribute("y2", b.y.toFixed(1));
    }
  }

  const updateHighlight = () => {
    const focusId = hoveredId || selectedId;
    const focusNeighbors = focusId ? neighbors.get(focusId) : null;
    const pathSet = new Set(activePathNodes);
    const pathEdgeSet = new Set();
    for (let i = 0; i + 1 < activePathNodes.length; i++) {
      pathEdgeSet.add(`${activePathNodes[i]}|${activePathNodes[i + 1]}`);
      pathEdgeSet.add(`${activePathNodes[i + 1]}|${activePathNodes[i]}`);
    }
    const hasPath = activePathNodes.length >= 2;

    for (const [id, item] of nodeEls.entries()) {
      const matchedQuery = !q
        || item.node.label.toLowerCase().includes(q)
        || item.node.id.toLowerCase().includes(q)
        || item.node.tags.some((t) => t.toLowerCase().includes(q));
      item.matchedQuery = matchedQuery;

      const matchedGroup = !activeHighlightGroup || item.node._groupKey === activeHighlightGroup;
      let dimmed = !matchedQuery || !matchedGroup;
      let active = false;
      const inPath = hasPath && pathSet.has(id);

      if (hasPath) {
        dimmed = !inPath;
      } else if (focusNeighbors) {
        active = id === focusId;
        if (!focusNeighbors.has(id)) dimmed = true;
      }

      item.g.setAttribute(
        "class",
        `graph-node${item.node.isGhost ? " ghost" : ""}${item.node.isTag ? " tag-node" : ""}${id === activePath ? " current" : ""}${active ? " focused" : ""}${inPath ? " path-hit" : ""}${dimmed ? " dimmed" : ""}`
      );
    }

    for (const item of edgeEls) {
      const pairKey = `${item.edge.source}|${item.edge.target}`;
      const inPath = hasPath && pathEdgeSet.has(pairKey);
      const touchesFocus = !focusId || item.edge.source === focusId || item.edge.target === focusId;
      const cls = [
        "graph-edge",
        item.edge.broken ? "broken" : "",
        item.edge.kind === "tag" ? "tag-edge" : "",
        item.edge.kind === "markdown" ? "md-edge" : "",
        inPath ? "path-hit" : (!hasPath && focusId && touchesFocus ? "highlighted" : ""),
        hasPath ? (inPath ? "" : "dimmed") : (focusId && !touchesFocus ? "dimmed" : ""),
      ].filter(Boolean).join(" ");
      item.el.setAttribute("class", cls);
      if (showArrows && item.edge.kind !== "tag") {
        item.el.setAttribute(
          "marker-end",
          inPath ? "url(#graph-arrow-path)" : (!hasPath && focusId && touchesFocus ? "url(#graph-arrow-active)" : "url(#graph-arrow)")
        );
      }
    }
    applyLabelLod();
  };

  function syncEdgesFor(nodeId) {
    for (const item of edgeEls) {
      if (item.edge.source === nodeId || item.edge.target === nodeId) {
        const a = nodeMap.get(item.edge.source);
        const b = nodeMap.get(item.edge.target);
        item.el.setAttribute("x1", a.x.toFixed(1));
        item.el.setAttribute("y1", a.y.toFixed(1));
        item.el.setAttribute("x2", b.x.toFixed(1));
        item.el.setAttribute("y2", b.y.toFixed(1));
      }
    }
  }

  // Sleek Obsidian node sizing
  const sizeMul = Math.max(0.6, Math.min(1.8, (nodeScale || 100) / 100));

  for (const n of nodes) {
    const baseR = n.isGhost
      ? 4.4
      : n.isTag
        ? Math.min(8.2, 4.6 + Math.sqrt(n.degree) * 1.05)
        : Math.min(10.5, 4.2 + Math.sqrt(n.degree) * 1.45);
    const r = baseR * sizeMul;
    const fill = n.isGhost ? "transparent" : n._color;
    const g = svgEl(doc, "g", {
      class: "graph-node",
      transform: `translate(${n.x.toFixed(1)}, ${n.y.toFixed(1)})`,
    });

    if (n.id === activePath || (scope === "local" && n.id === effectiveCenter)) {
      g.appendChild(svgEl(doc, "circle", {
        r: (r + 4.2).toFixed(1),
        class: "graph-node-ring",
      }));
    }

    let shape;
    if (n.isTag) {
      const s = r * 1.15;
      shape = svgEl(doc, "polygon", {
        points: `0,${(-s).toFixed(1)} ${s.toFixed(1)},0 0,${s.toFixed(1)} ${(-s).toFixed(1)},0`,
        fill,
        stroke: "var(--paper)",
        "stroke-width": "1.5",
      });
    } else {
      shape = svgEl(doc, "circle", {
        r: r.toFixed(1),
        fill,
        stroke: n.isGhost ? "#ef4444" : "var(--paper)",
        "stroke-width": "1.5",
        ...(n.isGhost ? { "stroke-dasharray": "2.6 2" } : {}),
      });
    }
    g.appendChild(shape);

    const shortLabel = n.label.length > 22 ? n.label.slice(0, 20) + "…" : n.label;
    const text = svgEl(doc, "text", {
      y: (r + 12.5).toFixed(1),
      "text-anchor": "middle",
      class: "graph-node-label",
    }, shortLabel);
    g.appendChild(text);

    g.addEventListener("pointerenter", () => {
      hoveredId = n.id;
      updateHighlight();
    });
    g.addEventListener("pointerleave", () => {
      if (hoveredId === n.id) hoveredId = null;
      updateHighlight();
    });
    g.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      clearBrowserSelection();
      activeMorph = null;

      const startX = ev.clientX;
      const startY = ev.clientY;
      const origX = n.x;
      const origY = n.y;
      let lastX = n.x;
      let lastY = n.y;
      let throwVx = 0;
      let throwVy = 0;
      let moved = false;

      n.dragging = true;
      n.gliding = false;
      physicsEnergy = Math.max(physicsEnergy, 0.7);

      if (typeof g.setPointerCapture === "function") g.setPointerCapture(ev.pointerId);
      const onMove = (me) => {
        me.preventDefault();
        const dx = (me.clientX - startX) / cam.scale;
        const dy = (me.clientY - startY) / cam.scale;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
        const nextX = origX + dx;
        const nextY = origY + dy;
        throwVx = throwVx * 0.45 + (nextX - lastX) * 0.55;
        throwVy = throwVy * 0.45 + (nextY - lastY) * 0.55;
        lastX = nextX;
        lastY = nextY;
        n.x = nextX;
        n.y = nextY;
        n.homeX = nextX;
        n.homeY = nextY;
        n.anchored = true;
        physicsEnergy = Math.max(physicsEnergy, 0.65);
        if (!animatePhysics) {
          g.setAttribute("transform", `translate(${n.x.toFixed(1)}, ${n.y.toFixed(1)})`);
          syncEdgesFor(n.id);
        }
      };
      const onUp = () => {
        g.removeEventListener("pointermove", onMove);
        g.removeEventListener("pointerup", onUp);
        g.removeEventListener("pointercancel", onUp);
        n.dragging = false;
        if (!moved) {
          selectedId = n.id;
          activePathNodes = [];
          updateHighlight();
          if (typeof onSelectNode === "function") onSelectNode(buildNodeDetail(n));
        } else {
          // Stay where placed after a smooth inertial momentum glide (never snap back!)
          n.anchored = true;
          n.homeX = n.x;
          n.homeY = n.y;
          if (animatePhysics) {
            n.vx = Math.max(-11, Math.min(11, throwVx * 0.72));
            n.vy = Math.max(-11, Math.min(11, throwVy * 0.72));
            n.gliding = Math.hypot(n.vx, n.vy) >= 0.16;
            physicsEnergy = Math.max(physicsEnergy, 0.78);
            ensureLoopRunning();
          }
        }
      };
      g.addEventListener("pointermove", onMove);
      g.addEventListener("pointerup", onUp);
      g.addEventListener("pointercancel", onUp);
    });
    g.addEventListener("dblclick", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!n.isGhost && !n.isTag && typeof onOpenFile === "function") onOpenFile(n.id);
    });

    nodesLayer.appendChild(g);
    nodeEls.set(n.id, { node: n, g, shape, text, matchedQuery: true });
  }

  // Pan & zoom on SVG background
  svg.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    clearBrowserSelection();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const origX = cam.x;
    const origY = cam.y;
    let moved = false;
    if (typeof svg.setPointerCapture === "function") svg.setPointerCapture(ev.pointerId);
    const onMove = (me) => {
      me.preventDefault();
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
      cam.x = origX + dx;
      cam.y = origY + dy;
      applyCam();
    };
    const onUp = () => {
      svg.removeEventListener("pointermove", onMove);
      svg.removeEventListener("pointerup", onUp);
      svg.removeEventListener("pointercancel", onUp);
      if (!moved) {
        selectedId = null;
        activePathNodes = [];
        updateHighlight();
        if (typeof onSelectNode === "function") onSelectNode(null);
      }
    };
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerup", onUp);
    svg.addEventListener("pointercancel", onUp);
  });

  svg.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.12 : 0.89;
    const nextScale = Math.max(0.25, Math.min(3.2, cam.scale * factor));
    const rect = svg.getBoundingClientRect ? svg.getBoundingClientRect() : { left: 0, top: 0 };
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    cam.x = mx - (mx - cam.x) * (nextScale / cam.scale);
    cam.y = my - (my - cam.y) * (nextScale / cam.scale);
    cam.scale = nextScale;
    applyCam();
  }, { passive: false });

  // Unified Animation Loop: handles smooth layout/color morph glides AND live floating physics
  let rafId = 0;
  let destroyed = false;
  const startTime = nowMs();

  function tick(now) {
    if (destroyed) {
      rafId = 0;
      return;
    }
    const currentNow = now || nowMs();
    const t = currentNow - startTime;

    if (activeMorph) {
      const elapsed = currentNow - activeMorph.startTime;
      const rawP = Math.max(0, Math.min(1, elapsed / activeMorph.duration));
      const ease = 1 - Math.pow(1 - rawP, 3); // smooth cubic ease-out

      for (const n of nodes) {
        if (n.dragging) continue;
        n.x = n._msx + (n._mtx - n._msx) * ease;
        n.y = n._msy + (n._mty - n._msy) * ease;
        n.homeX = n.x;
        n.homeY = n.y;
        n.vx = 0;
        n.vy = 0;
      }

      cam.x = activeMorph.startCam.x + (activeMorph.endCam.x - activeMorph.startCam.x) * ease;
      cam.y = activeMorph.startCam.y + (activeMorph.endCam.y - activeMorph.startCam.y) * ease;
      cam.scale = activeMorph.startCam.scale + (activeMorph.endCam.scale - activeMorph.startCam.scale) * ease;
      applyCam();
      syncAllPositionsToDom();

      if (rawP >= 1) {
        for (const n of nodes) {
          n.homeX = n._mtx;
          n.homeY = n._mty;
        }
        activeMorph = null;
        physicsEnergy = 0.25;
        if (!animatePhysics) {
          rafId = 0;
          return;
        }
      }
      rafId = requestAnimationFrame(tick);
      return;
    }

    if (!animatePhysics) {
      rafId = 0;
      return;
    }

    physicsEnergy = Math.max(0.18, physicsEnergy * 0.988);

    if (currentLayout === "force" && forceParams) {
      stepForcePhysics(nodes, edges, nodeMap, forceParams, t, physicsEnergy);
    } else {
      // Smooth glide + gentle ambient breathing around each node's home anchor (stays where dropped!)
      for (const n of nodes) {
        if (n.dragging) continue;
        if (n.gliding) {
          n.x += n.vx;
          n.y += n.vy;
          n.vx *= 0.87;
          n.vy *= 0.87;
          n.homeX = n.x;
          n.homeY = n.y;
          if (Math.hypot(n.vx, n.vy) < 0.14) {
            n.gliding = false;
            n.vx = 0;
            n.vy = 0;
          }
          continue;
        }
        const floatX = Math.cos(t * n._freq + n._phase) * 2.1;
        const floatY = Math.sin(t * n._freq * 0.85 + n._phase + 1.2) * 2.1;
        n.vx = (n.vx + (n.homeX + floatX - n.x) * 0.08) * 0.82;
        n.vy = (n.vy + (n.homeY + floatY - n.y) * 0.08) * 0.82;
        n.x += n.vx;
        n.y += n.vy;
      }
    }

    syncAllPositionsToDom();
    rafId = requestAnimationFrame(tick);
  }

  function ensureLoopRunning() {
    if (destroyed || rafId || typeof requestAnimationFrame !== "function") return;
    rafId = requestAnimationFrame(tick);
  }

  if (animatePhysics && typeof requestAnimationFrame === "function") {
    for (const n of nodes) {
      n.vx = Math.cos(n._phase) * 0.8;
      n.vy = Math.sin(n._phase) * 0.8;
    }
    ensureLoopRunning();
  }

  function morphToPlan(plan, durationMs = 540) {
    forceParams = plan.nextForceParams;
    for (const n of nodes) {
      const target = plan.coords.get(n.id);
      if (!target) continue;
      n.anchored = false;
      n.gliding = false;
      n.vx = 0;
      n.vy = 0;
      n._msx = n.x;
      n._msy = n.y;
      n._mtx = target.x;
      n._mty = target.y;
    }

    if (typeof requestAnimationFrame !== "function") {
      // Synchronous fallback for non-browser tests
      for (const n of nodes) {
        n.x = n._mtx;
        n.y = n._mty;
        n.homeX = n.x;
        n.homeY = n.y;
      }
      cam.x = plan.fitCam.x;
      cam.y = plan.fitCam.y;
      cam.scale = plan.fitCam.scale;
      applyCam();
      syncAllPositionsToDom();
      return;
    }

    activeMorph = {
      startTime: nowMs(),
      duration: durationMs,
      startCam: { x: cam.x, y: cam.y, scale: cam.scale },
      endCam: plan.fitCam,
    };
    ensureLoopRunning();
  }

  function setLayout(nextLayout, opts = {}) {
    currentLayout = nextLayout || "force";
    if (typeof opts.repel === "number") currentRepel = opts.repel;
    if (typeof opts.linkDist === "number") currentLinkDist = opts.linkDist;
    if (typeof opts.gravity === "number") currentGravity = opts.gravity;
    const plan = computeTargetLayout(currentLayout, opts);
    morphToPlan(plan, 540);
  }

  function setColorBy(nextColorBy) {
    currentColorBy = nextColorBy || "dir";
    legend = assignGroupColors(nodes, currentColorBy);
    activeHighlightGroup = null;
    for (const item of nodeEls.values()) {
      if (!item.node.isGhost && item.shape) {
        item.shape.setAttribute("fill", item.node._color);
      }
    }
    updateHighlight();
    // Smoothly glide all nodes to cluster according to the new color dimension!
    const plan = computeTargetLayout(currentLayout);
    morphToPlan(plan, 560);
    return legend;
  }

  function destroy() {
    destroyed = true;
    activeMorph = null;
    if (rafId && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }
  container._graphCleanup = destroy;

  function focusNode(targetId) {
    const n = nodeMap.get(targetId);
    if (!n) return false;
    selectedId = targetId;
    cam.scale = Math.max(cam.scale, 1.15);
    cam.x = width / 2 - n.x * cam.scale;
    cam.y = height / 2 - n.y * cam.scale;
    applyCam();
    updateHighlight();
    if (typeof onSelectNode === "function") onSelectNode(buildNodeDetail(n));
    return true;
  }

  function serializeSvg() {
    if (typeof XMLSerializer === "undefined") return "";
    const cs = typeof window !== "undefined" && window.getComputedStyle
      ? window.getComputedStyle(document.documentElement)
      : null;
    const getVar = (name, fallback) => (cs ? cs.getPropertyValue(name).trim() || fallback : fallback);
    const paper = getVar("--paper", "#ffffff");
    const ink = getVar("--ink", "#1f2937");
    const muted = getVar("--muted", "#6b7280");
    const accent = getVar("--accent", "#0284c7");
    const danger = getVar("--danger", "#ef4444");

    const clone = svg.cloneNode(true);
    const bg = doc.createElementNS(SVG_NS, "rect");
    bg.setAttribute("width", String(width));
    bg.setAttribute("height", String(height));
    bg.setAttribute("fill", paper);
    clone.insertBefore(bg, clone.firstChild);

    const styleNode = doc.createElementNS(SVG_NS, "style");
    styleNode.textContent = [
      `.graph-edge { stroke: ${muted}; stroke-width: 1.05; stroke-opacity: 0.35; }`,
      `.graph-edge.broken { stroke: ${danger}; stroke-dasharray: 4 3; }`,
      `.graph-edge.tag-edge { stroke: #10b981; stroke-dasharray: 2 3; stroke-opacity: 0.4; }`,
      `.graph-edge.highlighted { stroke: ${accent}; stroke-width: 1.75; stroke-opacity: 0.92; }`,
      `.graph-edge.path-hit { stroke: #f59e0b; stroke-width: 2.4; stroke-opacity: 1; }`,
      `.graph-edge.dimmed { stroke-opacity: 0.08; }`,
      `.graph-node.dimmed { opacity: 0.16; }`,
      `.graph-node-ring { fill: none; stroke: ${accent}; stroke-width: 1.5; }`,
      `.graph-node-label { font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 10.5px; fill: ${muted}; stroke: ${paper}; stroke-width: 3px; paint-order: stroke; }`,
    ].join("\n");
    clone.insertBefore(styleNode, clone.firstChild);

    let xml = new XMLSerializer().serializeToString(clone);
    xml = xml
      .replace(/var\(--paper\)/g, paper)
      .replace(/var\(--muted\)/g, muted)
      .replace(/var\(--accent\)/g, accent)
      .replace(/var\(--danger\)/g, danger)
      .replace(/var\(--ink\)/g, ink);
    return xml;
  }

  fitToView();
  updateHighlight();

  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    get legend() {
      return legend;
    },
    pathNodes: activePathNodes,
    fit: fitToView,
    zoomBy: (factor) => {
      const nextScale = Math.max(0.25, Math.min(3.2, cam.scale * factor));
      cam.x = width / 2 - (width / 2 - cam.x) * (nextScale / cam.scale);
      cam.y = height / 2 - (height / 2 - cam.y) * (nextScale / cam.scale);
      cam.scale = nextScale;
      applyCam();
    },
    focusNode,
    setHighlightGroup: (groupKey) => {
      activeHighlightGroup = activeHighlightGroup === groupKey ? null : groupKey;
      updateHighlight();
      return activeHighlightGroup;
    },
    setPathTarget: (fromId, toId) => {
      activePathNodes = findShortestPath(edges, fromId, toId);
      updateHighlight();
      return activePathNodes;
    },
    setLayout,
    setColorBy,
    destroy,
    serializeSvg,
  };
}
