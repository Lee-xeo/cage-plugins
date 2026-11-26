const SVG_NS = "http://www.w3.org/2000/svg";
const PALETTE = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16"];

function svgEl(doc, tag, attrs = {}, text = "") {
  const node = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
  if (text) node.textContent = text;
  return node;
}

/* 1. Pie Chart */
export function parsePie(lines) {
  let title = "";
  const slices = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("%%")) continue;
    const tMatch = line.match(/^title\s+(.+)$/i);
    if (tMatch) {
      title = tMatch[1].trim();
      continue;
    }
    const sMatch = line.match(/^"([^"]+)"\s*:\s*([0-9]+(?:\.[0-9]+)?)$/);
    if (sMatch) {
      const value = Number.parseFloat(sMatch[2]);
      if (value > 0) slices.push({ label: sMatch[1], value });
    }
  }
  if (slices.length === 0) return null;
  return { type: "pie", title, slices };
}

export function buildPieSvg(doc, model) {
  const width = 460;
  const height = Math.max(220, 60 + model.slices.length * 24);
  const cx = 115;
  const cy = height / 2 + (model.title ? 10 : 0);
  const r = 78;
  const total = model.slices.reduce((sum, s) => sum + s.value, 0);

  const svg = svgEl(doc, "svg", {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    class: "md-mermaid-svg",
    role: "img",
  });

  if (model.title) {
    svg.appendChild(svgEl(doc, "text", {
      x: width / 2, y: 22, "text-anchor": "middle", "font-size": "13", "font-weight": "600", fill: "var(--strong)",
    }, model.title));
  }

  let angle = -Math.PI / 2;
  model.slices.forEach((slice, idx) => {
    const color = PALETTE[idx % PALETTE.length];
    const frac = slice.value / total;
    const sweep = frac * Math.PI * 2;
    const endAngle = angle + sweep;

    if (model.slices.length === 1) {
      svg.appendChild(svgEl(doc, "circle", { cx, cy, r, fill: color }));
    } else {
      const x1 = cx + r * Math.cos(angle);
      const y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(endAngle);
      const y2 = cy + r * Math.sin(endAngle);
      const largeArc = sweep > Math.PI ? 1 : 0;
      const d = `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
      svg.appendChild(svgEl(doc, "path", { d, fill: color, stroke: "var(--paper)", "stroke-width": "1.5" }));
    }

    const ly = 48 + idx * 24;
    svg.appendChild(svgEl(doc, "rect", { x: 226, y: ly - 10, width: 12, height: 12, rx: "2", fill: color }));
    svg.appendChild(svgEl(doc, "text", { x: 244, y: ly, "font-size": "11.5", fill: "var(--ink)" },
      `${slice.label} (${(frac * 100).toFixed(1)}%)`));
    angle = endAngle;
  });

  return svg;
}

/* 2. Gantt Chart */
export function parseGantt(lines) {
  let title = "";
  let currentSection = "默认分组";
  const tasks = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("%%") || /^(?:dateFormat|axisFormat|excludes)\b/i.test(line)) continue;
    const tMatch = line.match(/^title\s+(.+)$/i);
    if (tMatch) { title = tMatch[1].trim(); continue; }
    const sMatch = line.match(/^section\s+(.+)$/i);
    if (sMatch) { currentSection = sMatch[1].trim(); continue; }

    const colonIdx = line.indexOf(":");
    if (colonIdx !== -1) {
      const name = line.slice(0, colonIdx).trim();
      const rest = line.slice(colonIdx + 1).trim();
      const parts = rest.split(",").map((p) => p.trim());
      const state = parts.find((p) => ["done", "active", "crit"].includes(p.toLowerCase())) || "";
      tasks.push({ name, section: currentSection, state: state.toLowerCase(), index: tasks.length });
    }
  }
  if (tasks.length === 0) return null;
  return { type: "gantt", title, tasks };
}

export function buildGanttSvg(doc, model) {
  const rowH = 30;
  const labelW = 160;
  const barAreaW = 340;
  const width = labelW + barAreaW + 30;
  const topY = model.title ? 40 : 20;
  const height = topY + model.tasks.length * rowH + 24;

  const svg = svgEl(doc, "svg", {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    class: "md-mermaid-svg",
    role: "img",
  });

  if (model.title) {
    svg.appendChild(svgEl(doc, "text", {
      x: width / 2, y: 22, "text-anchor": "middle", "font-size": "13", "font-weight": "600", fill: "var(--strong)",
    }, model.title));
  }

  const count = model.tasks.length;
  const segW = Math.max(46, Math.floor(barAreaW / Math.max(1, count)));
  model.tasks.forEach((task, idx) => {
    const y = topY + idx * rowH;
    svg.appendChild(svgEl(doc, "text", {
      x: 12, y: y + 18, "font-size": "11.5", fill: "var(--ink)",
    }, task.name.slice(0, 20)));

    const bx = labelW + Math.min(barAreaW - segW, idx * Math.floor((barAreaW - segW) / Math.max(1, count - 1)));
    const fill = task.state === "crit" ? "#ef4444" : (task.state === "done" ? "#10b981" : (task.state === "active" ? "#3b82f6" : "var(--accent)"));
    svg.appendChild(svgEl(doc, "rect", {
      x: bx, y: y + 5, width: segW, height: 18, rx: "4", fill, opacity: task.state === "done" ? "0.75" : "0.9",
    }));
    svg.appendChild(svgEl(doc, "text", {
      x: bx + 6, y: y + 17, "font-size": "10", fill: "#ffffff",
    }, task.section.slice(0, 10)));
  });

  return svg;
}

/* 3. Mindmap */
export function parseMindmap(lines) {
  const nodes = [];
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith("%%")) continue;
    const indent = raw.search(/\S/);
    const label = raw.trim().replace(/^root\(\((.+)\)\)$/, "$1").replace(/^[(\[]+|[)\]]+$/g, "");
    nodes.push({ indent, label });
  }
  if (nodes.length === 0) return null;
  return { type: "mindmap", nodes };
}

export function buildMindmapSvg(doc, model) {
  const rowH = 34;
  const width = 540;
  const height = Math.max(180, 32 + model.nodes.length * rowH);
  const svg = svgEl(doc, "svg", {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    class: "md-mermaid-svg",
    role: "img",
  });

  const baseIndent = model.nodes[0].indent;
  const stack = [];
  const positions = [];

  model.nodes.forEach((n, idx) => {
    const depth = Math.max(0, Math.round((n.indent - baseIndent) / 2));
    const x = 24 + depth * 96;
    const y = 20 + idx * rowH;
    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack.length > 0 ? stack[stack.length - 1] : null;
    if (parent) {
      svg.appendChild(svgEl(doc, "path", {
        d: `M ${parent.x + 80} ${parent.y + 13} C ${parent.x + 90} ${parent.y + 13}, ${x - 10} ${y + 13}, ${x} ${y + 13}`,
        fill: "none", stroke: "var(--muted)", "stroke-width": "1.4",
      }));
    }
    const item = { x, y, depth, label: n.label, color: PALETTE[depth % PALETTE.length] };
    positions.push(item);
    stack.push(item);
  });

  for (const item of positions) {
    const boxW = Math.min(180, Math.max(84, item.label.length * 10 + 20));
    svg.appendChild(svgEl(doc, "rect", {
      x: item.x, y: item.y, width: boxW, height: 26, rx: "13",
      fill: "var(--chrome)", stroke: item.color, "stroke-width": "1.6",
    }));
    svg.appendChild(svgEl(doc, "text", {
      x: item.x + boxW / 2, y: item.y + 17, "text-anchor": "middle", "font-size": "11.5", fill: "var(--strong)",
    }, item.label.slice(0, 18)));
  }

  return svg;
}

/* 4. Class Diagram & 5. ER Diagram (structured box + edge layout) */
export function parseClassDiagram(lines) {
  const classes = new Map();
  const edges = [];
  let current = null;

  const ensureClass = (name) => {
    if (!classes.has(name)) classes.set(name, { name, members: [] });
    return classes.get(name);
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("%%")) continue;
    const openMatch = line.match(/^class\s+([A-Za-z0-9_]+)\s*\{$/);
    if (openMatch) {
      current = ensureClass(openMatch[1]);
      continue;
    }
    if (line === "}") {
      current = null;
      continue;
    }
    if (current) {
      current.members.push(line);
      continue;
    }
    const relMatch = line.match(/^([A-Za-z0-9_]+)\s+(<\|--|--\|>|\*--|o--|-->|--)\s+([A-Za-z0-9_]+)(?:\s*:\s*(.*))?$/);
    if (relMatch) {
      ensureClass(relMatch[1]);
      ensureClass(relMatch[3]);
      edges.push({ from: relMatch[1], to: relMatch[3], label: (relMatch[4] || "").trim() });
    }
  }
  if (classes.size === 0) return null;
  return { type: "class", entities: [...classes.values()], edges };
}

export function parseErDiagram(lines) {
  const entities = new Map();
  const edges = [];
  let current = null;

  const ensureEntity = (name) => {
    if (!entities.has(name)) entities.set(name, { name, members: [] });
    return entities.get(name);
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("%%")) continue;
    const openMatch = line.match(/^([A-Za-z0-9_-]+)\s*\{$/);
    if (openMatch) {
      current = ensureEntity(openMatch[1]);
      continue;
    }
    if (line === "}") {
      current = null;
      continue;
    }
    if (current) {
      current.members.push(line);
      continue;
    }
    const relMatch = line.match(/^([A-Za-z0-9_-]+)\s+([|o}][|o{]?--[|o{]?[|o{])\s+([A-Za-z0-9_-]+)(?:\s*:\s*(.*))?$/);
    if (relMatch) {
      ensureEntity(relMatch[1]);
      ensureEntity(relMatch[3]);
      edges.push({ from: relMatch[1], to: relMatch[3], label: (relMatch[4] || "").replace(/^"|"$/g, "").trim() });
    }
  }
  if (entities.size === 0) return null;
  return { type: "er", entities: [...entities.values()], edges };
}

export function buildEntityDiagramSvg(doc, model) {
  const cols = Math.min(3, Math.max(1, model.entities.length));
  const boxW = 176;
  const gapX = 48;
  const gapY = 44;
  const pos = new Map();
  let width = 32;
  let height = 32;

  model.entities.forEach((ent, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const boxH = 34 + Math.max(1, ent.members.length) * 18;
    const x = 20 + col * (boxW + gapX);
    const y = 20 + row * (110 + gapY);
    pos.set(ent.name, { x, y, w: boxW, h: boxH });
    width = Math.max(width, x + boxW + 24);
    height = Math.max(height, y + boxH + 24);
  });

  const svg = svgEl(doc, "svg", {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    class: "md-mermaid-svg",
    role: "img",
  });

  for (const edge of model.edges) {
    const p1 = pos.get(edge.from);
    const p2 = pos.get(edge.to);
    if (!p1 || !p2) continue;
    const x1 = p1.x + p1.w / 2;
    const y1 = p1.y + p1.h / 2;
    const x2 = p2.x + p2.w / 2;
    const y2 = p2.y + p2.h / 2;
    svg.appendChild(svgEl(doc, "line", { x1, y1, x2, y2, stroke: "var(--muted)", "stroke-width": "1.5" }));
    if (edge.label) {
      svg.appendChild(svgEl(doc, "text", {
        x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 4, "text-anchor": "middle", "font-size": "10.5", fill: "var(--muted)",
      }, edge.label));
    }
  }

  for (const ent of model.entities) {
    const p = pos.get(ent.name);
    svg.appendChild(svgEl(doc, "rect", {
      x: p.x, y: p.y, width: p.w, height: p.h, rx: "6",
      fill: "var(--chrome)", stroke: "var(--accent)", "stroke-width": "1.5",
    }));
    svg.appendChild(svgEl(doc, "text", {
      x: p.x + p.w / 2, y: p.y + 19, "text-anchor": "middle", "font-size": "12", "font-weight": "600", fill: "var(--strong)",
    }, ent.name));
    svg.appendChild(svgEl(doc, "line", {
      x1: p.x, y1: p.y + 26, x2: p.x + p.w, y2: p.y + 26, stroke: "var(--line)", "stroke-width": "1",
    }));
    ent.members.forEach((m, mIdx) => {
      svg.appendChild(svgEl(doc, "text", {
        x: p.x + 8, y: p.y + 42 + mIdx * 17, "font-size": "11", fill: "var(--ink)",
      }, m.slice(0, 24)));
    });
  }

  return svg;
}
