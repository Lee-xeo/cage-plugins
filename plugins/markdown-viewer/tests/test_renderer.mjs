import test from "node:test";
import assert from "node:assert/strict";
import { isRelativeMarkdownHref, parseFrontmatter, renderMarkdown, sanitizeHref } from "../view/renderer.mjs";
import { findShortestPath, renderKnowledgeGraph } from "../view/render/graph-view.mjs";
import {
  buildKanbanMarkdownReport,
  computeDropPatch,
  computeKanbanStats,
  renderKanbanBoard,
} from "../view/render/kanban-view.mjs";
import { fitStateWithinQuota, getDraft, hydrateStore, setDraft } from "../view/store.mjs";

function createMockDocument() {
  class MockNode {
    constructor(nodeType, nodeValue = "") {
      this.nodeType = nodeType;
      this.nodeValue = nodeValue;
      this.parentNode = null;
      this.childNodes = [];
    }
    get firstChild() {
      return this.childNodes[0] || null;
    }
    get textContent() {
      if (this.nodeType === 3) return this.nodeValue;
      return this.childNodes.map((c) => c.textContent).join("");
    }
    set textContent(val) {
      this.childNodes = [];
      if (val !== undefined && val !== null && String(val) !== "") {
        this.appendChild(new MockNode(3, String(val)));
      }
    }
    appendChild(node) {
      if (node.nodeType === 11) {
        for (const child of [...node.childNodes]) {
          this.appendChild(child);
        }
        node.childNodes = [];
        return node;
      }
      node.parentNode = this;
      this.childNodes.push(node);
      return node;
    }
    removeChild(node) {
      const idx = this.childNodes.indexOf(node);
      if (idx !== -1) {
        this.childNodes.splice(idx, 1);
        node.parentNode = null;
      }
      return node;
    }
  }

  class MockElement extends MockNode {
    constructor(tagName) {
      super(1);
      this.tagName = tagName.toLowerCase();
      this.attributes = new Map();
      this.dataset = {};
      this.style = {};
      this.listeners = new Map();
      this.className = "";
      this.type = "";
      this.disabled = false;
      this.checked = false;
      this.open = false;
      this.id = "";
    }
    get lastElementChild() {
      for (let i = this.childNodes.length - 1; i >= 0; i--) {
        if (this.childNodes[i].nodeType === 1) return this.childNodes[i];
      }
      return null;
    }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }
    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    click() {
      for (const fn of this.listeners.get("click") || []) fn();
    }
  }

  return {
    createElement: (tag) => new MockElement(tag),
    createElementNS: (_ns, tag) => new MockElement(tag),
    createTextNode: (text) => new MockNode(3, String(text)),
    createDocumentFragment: () => new MockNode(11),
  };
}

function collectElements(root, predicate, out = []) {
  for (const child of root.childNodes) {
    if (child.nodeType === 1) {
      if (predicate(child)) out.push(child);
      collectElements(child, predicate, out);
    }
  }
  return out;
}

test("renders headings, lists, task checkboxes, blockquotes, hr, tables, and code blocks", () => {
  const doc = createMockDocument();
  const root = doc.createElement("div");
  let copiedCode = null;

  const md = [
    "# Main Title",
    "",
    "Paragraph with **bold**, *italic*, ***bold-italic***, ~~strike~~, and `inline_code`.",
    "",
    "- [x] Done task",
    "- [ ] Open task",
    "  - Nested item",
    "",
    "> Quoted **line**",
    "",
    "---",
    "",
    "| Name | Align |",
    "| :--- | ---: |",
    "| Alpha | 42 |",
    "",
    "```python",
    "print('hi')",
    "```",
  ].join("\n");

  const meta = renderMarkdown(md, root, {
    document: doc,
    onCopy: (code) => {
      copiedCode = code;
    },
  });

  assert.equal(meta.headings.length, 1);
  assert.equal(meta.headings[0].text, "Main Title");
  assert.ok(meta.wordCount > 0);

  const h1 = collectElements(root, (el) => el.tagName === "h1");
  assert.equal(h1.length, 1);
  assert.equal(h1[0].textContent, "Main Title");
  assert.equal(h1[0].dataset.headingLevel, "1");
  const foldBtns = collectElements(h1[0], (el) => el.className === "md-heading-fold-btn");
  assert.equal(foldBtns.length, 1);

  const checkboxes = collectElements(root, (el) => el.tagName === "input" && el.type === "checkbox");
  assert.equal(checkboxes.length, 2);
  assert.equal(checkboxes[0].checked, true);
  assert.equal(checkboxes[0].parentNode.className, "md-task-item done");
  assert.equal(checkboxes[1].checked, false);
  assert.equal(checkboxes[1].parentNode.className, "md-task-item");

  const boldItalic = collectElements(root, (el) => el.tagName === "strong" && el.childNodes.some((c) => c.tagName === "em"));
  assert.equal(boldItalic.length, 1);
  assert.equal(boldItalic[0].textContent, "bold-italic");

  const ths = collectElements(root, (el) => el.tagName === "th");
  assert.equal(ths[0].style.textAlign, "left");
  assert.equal(ths[1].style.textAlign, "right");

  const copyBtns = collectElements(root, (el) => el.className === "md-copy-btn");
  assert.equal(copyBtns.length, 1);
  copyBtns[0].click();
  assert.equal(copiedCode, "print('hi')");
});

test("renders Obsidian frontmatter, wikilinks, callouts, highlights, tags, and footnotes", () => {
  const doc = createMockDocument();
  const root = doc.createElement("div");

  const md = [
    "---",
    "title: 知识库笔记",
    "tags: [obsidian, markdown]",
    "---",
    "",
    "# 笔记正文",
    "",
    "参考 [[docs/guide#章节|指南]] 与 ==重点高亮== 以及 #知识管理 和脚注[^1]。",
    "",
    "> [!tip]- 可折叠提示",
    "> 这里是 Callout 内容。",
    "",
    "[^1]: 脚注说明内容。",
  ].join("\n");

  const parsed = parseFrontmatter(md);
  assert.equal(parsed.frontmatter.length, 2);

  const meta = renderMarkdown(md, root, { document: doc });
  assert.deepEqual(meta.tags.sort(), ["markdown", "obsidian", "知识管理"].sort());

  const fm = collectElements(root, (el) => el.className === "md-frontmatter");
  assert.equal(fm.length, 1);

  // Heading "# 笔记正文" is on line 6 (after 4 frontmatter lines + 1 blank line)
  const h1 = collectElements(root, (el) => el.tagName === "h1");
  assert.equal(h1[0].dataset.sourceLine, "6");

  const wikilinks = collectElements(root, (el) => el.className === "md-wikilink");
  assert.equal(wikilinks.length, 1);
  assert.equal(wikilinks[0].dataset.mdWikilink, "docs/guide");
  assert.equal(wikilinks[0].dataset.mdHeading, "章节");
  assert.equal(wikilinks[0].textContent, "指南");

  const marks = collectElements(root, (el) => el.tagName === "mark");
  assert.equal(marks.length, 1);
  assert.equal(marks[0].textContent, "重点高亮");

  const callouts = collectElements(root, (el) => el.className.includes("md-callout-tip"));
  assert.equal(callouts.length, 1);
  assert.equal(callouts[0].tagName, "details");
  assert.equal(callouts[0].open, false);

  const footnotes = collectElements(root, (el) => el.className === "md-footnotes");
  assert.equal(footnotes.length, 1);
  assert.ok(footnotes[0].textContent.includes("脚注说明内容。"));
});

test("identifies relative markdown links and blocks XSS payloads", () => {
  const doc = createMockDocument();
  const root = doc.createElement("div");

  const md = [
    "<script>alert(1)</script>",
    "",
    "<img src=x onerror=alert(1)>",
    "",
    "<svg onload=alert(1)>",
    "",
    "[xss](javascript:alert(1))",
    "",
    "[data-xss](data:text/html,<script>alert(1)</script>)",
    "",
    "[Guide](./docs/guide.md)",
    "",
    "[Site](https://example.com/docs)",
  ].join("\n");

  renderMarkdown(md, root, { document: doc });

  const dangerous = collectElements(root, (el) => ["script", "img", "svg", "iframe"].includes(el.tagName));
  assert.equal(dangerous.length, 0);

  const anchors = collectElements(root, (el) => el.tagName === "a");
  assert.equal(anchors.length, 2);
  assert.equal(anchors[0].dataset.mdHref, "./docs/guide.md");
  assert.equal(isRelativeMarkdownHref(anchors[0].dataset.mdHref), true);
  assert.equal(anchors[1].dataset.mdHref, "https://example.com/docs");
  assert.equal(isRelativeMarkdownHref(anchors[1].dataset.mdHref), false);

  const blocked = collectElements(root, (el) => el.className === "md-link-blocked");
  assert.equal(blocked.length, 2);
  assert.equal(sanitizeHref("javascript:alert(1)"), null);
  assert.equal(sanitizeHref("data:text/html,hi"), null);
  assert.equal(sanitizeHref("https://example.com"), "https://example.com");

  assert.ok(root.textContent.includes("<script>alert(1)</script>"));
  assert.ok(root.textContent.includes("<img src=x onerror=alert(1)>"));
});

test("isolates drafts by project and enforces 56 KiB state quota", () => {
  const store = hydrateStore({ activeTab: "files", currentFilePath: "README.md", snippet: "hello" });
  const v2 = hydrateStore({
    version: 2,
    ui: {
      railTab: "graph",
      outlineOpen: false,
      themeMode: "dark",
      taskGroupBy: "priority",
      sidebarWidth: 340,
      outlineWidth: 260,
      splitRatio: 60,
      snippetRatio: 45,
      graph: {
        layout: "radial",
        colorBy: "degree",
        localDepth: 2,
        linkDirection: "out",
        showTags: true,
        repel: 999,
      },
      search: {
        grouped: false,
        context: true,
        sortBy: "matches",
        history: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"],
      },
    },
  });
  assert.equal(v2.ui.railTab, "graph");
  assert.equal(v2.ui.outlineOpen, false);
  assert.equal(v2.ui.themeMode, "dark");
  assert.equal(v2.ui.taskGroupBy, "priority");
  assert.equal(v2.ui.sidebarWidth, 340);
  assert.equal(v2.ui.outlineWidth, 260);
  assert.equal(v2.ui.splitRatio, 60);
  assert.equal(v2.ui.snippetRatio, 45);
  assert.equal(v2.ui.graph.layout, "radial");
  assert.equal(v2.ui.graph.colorBy, "degree");
  assert.equal(v2.ui.graph.localDepth, 2);
  assert.equal(v2.ui.graph.linkDirection, "out");
  assert.equal(v2.ui.graph.showTags, true);
  assert.equal(v2.ui.graph.repel, 250);
  assert.equal(v2.ui.search.grouped, false);
  assert.equal(v2.ui.search.context, true);
  assert.equal(v2.ui.search.sortBy, "matches");
  assert.equal(v2.ui.search.history.length, 10);
  setDraft(store, "proj-a", "a.md", "A".repeat(35000), "etag1");
  setDraft(store, "proj-b", "b.md", "B".repeat(35000), "etag2");
  assert.equal(getDraft(store, "proj-a", "a.md").baseEtag, "etag1");

  const fitted = fitStateWithinQuota(store, "proj-b", "b.md");
  assert.equal(getDraft(fitted, "proj-a", "a.md"), null);
  assert.ok(getDraft(fitted, "proj-b", "b.md"));
});

test("renders syntax highlighting, offline mermaid, offline math, and image hooks", () => {
  const doc = createMockDocument();
  const root = doc.createElement("div");
  const mountedAssets = [];

  const md = [
    "```javascript",
    "const x = 42; // answer",
    "```",
    "",
    "```mermaid",
    "flowchart TB",
    "  subgraph Layer1[\"前端层\"]",
    "    A[\"组件A\\n说明\"] <--> B[(\"数据库\\n本地\")]",
    "  end",
    "```",
    "",
    "```mermaid",
    "sequenceDiagram",
    "  participant User as 用户",
    "  participant Server as 服务端",
    "  User->>Server: Click",
    "  Server-->>User: Reply",
    "```",
    "",
    "```mermaid",
    "stateDiagram-v2",
    "  [*] --> Clean: 打开",
    "  Clean --> Dirty: 编辑",
    "```",
    "",
    "Inline math $x^2 + \\alpha$ and currency $100.",
    "",
    "$$",
    "\\frac{a}{b}",
    "$$",
    "",
    "![Diagram](assets/arch.svg)",
    "",
    "![Remote](https://example.com/pic.png)",
  ].join("\n");

  renderMarkdown(md, root, {
    document: doc,
    onAssetMount: (_fig, href, alt) => mountedAssets.push({ href, alt }),
  });

  const kw = collectElements(root, (el) => el.className === "tok-kw");
  assert.equal(kw.length, 1);
  assert.equal(kw[0].textContent, "const");

  const svgs = collectElements(root, (el) => el.tagName === "svg");
  assert.equal(svgs.length, 3);
  assert.ok(svgs[0].textContent.includes("前端层"), "subgraph title rendered");
  assert.ok(!svgs[0].textContent.includes("\\n"), "literal \\n converted into tspans");
  assert.ok(!svgs[1].textContent.includes("Server-"), "sequenceDiagram should not split Server-->> into Server-");
  assert.ok(svgs[1].textContent.includes("服务端"), "sequenceDiagram participant alias rendered");
  assert.ok(svgs[2].textContent.includes("Clean"), "stateDiagram-v2 rendered");

  const mathInline = collectElements(root, (el) => el.className === "md-math");
  const mathBlock = collectElements(root, (el) => el.className === "md-math-block");
  assert.equal(mathInline.length, 1);
  assert.equal(mathBlock.length, 1);

  assert.deepEqual(mountedAssets, [{ href: "assets/arch.svg", alt: "Diagram" }]);
  const blockedImgs = collectElements(root, (el) => el.className === "md-img-blocked");
  assert.equal(blockedImgs.length, 1);
});

test("supports interactive task checkbox toggle callback", () => {
  const doc = createMockDocument();
  const root = doc.createElement("div");
  const toggled = [];

  renderMarkdown("- [ ] Task A\n- [x] Task B", root, {
    document: doc,
    onTaskToggle: (line, checked) => toggled.push({ line, checked }),
  });

  const checkboxes = collectElements(root, (el) => el.tagName === "input" && el.type === "checkbox");
  assert.equal(checkboxes.length, 2);
  assert.equal(checkboxes[0].disabled, false);
  checkboxes[0].checked = true;
  for (const fn of checkboxes[0].listeners.get("change") || []) fn();
  assert.deepEqual(toggled, [{ line: 1, checked: true }]);
});

test("renders offline Obsidian knowledge graph SVG nodes and edges", () => {
  const doc = createMockDocument();
  doc.createElementNS = (_ns, tag) => doc.createElement(tag);
  const container = doc.createElement("div");
  const graph = {
    nodes: [
      { id: "README.md", label: "README", dir: "(root)", tags: ["home"], inDegree: 1, outDegree: 1, degree: 2, isGhost: false },
      { id: "docs/a.md", label: "a", dir: "docs", tags: ["arch"], inDegree: 1, outDegree: 1, degree: 2, isGhost: false },
      { id: "ghost::missing", label: "missing", dir: "(unresolved)", tags: [], inDegree: 1, outDegree: 0, degree: 1, isGhost: true },
    ],
    edges: [
      { source: "README.md", target: "docs/a.md", kind: "wikilink", broken: false },
      { source: "docs/a.md", target: "ghost::missing", kind: "wikilink", broken: true },
    ],
  };

  const handle = renderKnowledgeGraph(container, graph, { document: doc, activePath: "docs/a.md" });
  assert.equal(handle.nodeCount, 3);
  assert.equal(handle.edgeCount, 2);
  assert.ok(handle.legend.length >= 2);
  // Legend colors across distinct directories/ghosts must be unique
  const legendColors = handle.legend.map((item) => item.color);
  assert.equal(new Set(legendColors).size, legendColors.length);
  // Node circles stay sleek (<= 11px radius at default 100% scale)
  const circles = collectElements(container, (el) => el.tagName === "circle" && el.getAttribute("class") !== "graph-node-ring");
  for (const c of circles) {
    assert.ok(Number(c.getAttribute("r")) <= 11);
  }
  handle.destroy();
  const svgs = collectElements(container, (el) => el.tagName === "svg");
  assert.equal(svgs.length, 1);
  const lines = collectElements(container, (el) => el.tagName === "line");
  assert.equal(lines.length, 2);

  // Tag nodes + radial/hierarchy layouts + shortest path + N-hop local depth
  const withTags = renderKnowledgeGraph(container, graph, {
    document: doc,
    activePath: "docs/a.md",
    showTags: true,
    layout: "radial",
    colorBy: "tag",
  });
  assert.equal(withTags.nodeCount, 5); // 3 docs/ghost + 2 tag nodes (#home, #arch)
  assert.equal(withTags.edgeCount, 4);
  const polygons = collectElements(container, (el) => el.tagName === "polygon");
  assert.equal(polygons.length, 2);

  // Shortest path from README.md -> ghost::missing goes through docs/a.md
  assert.deepEqual(
    findShortestPath(graph.edges, "README.md", "ghost::missing"),
    ["README.md", "docs/a.md", "ghost::missing"]
  );
  const traced = withTags.setPathTarget("README.md", "ghost::missing");
  assert.deepEqual(traced, ["README.md", "docs/a.md", "ghost::missing"]);

  // Local graph depth=1 out-only from README.md includes README.md + docs/a.md (not ghost::missing)
  const localOut1 = renderKnowledgeGraph(container, graph, {
    document: doc,
    scope: "local",
    centerId: "README.md",
    localDepth: 1,
    linkDirection: "out",
    layout: "hierarchy",
    colorBy: "degree",
  });
  assert.equal(localOut1.nodeCount, 2);
  assert.equal(localOut1.edgeCount, 1);

  // Local graph depth=2 out-only reaches ghost::missing as well
  const localOut2 = renderKnowledgeGraph(container, graph, {
    document: doc,
    scope: "local",
    centerId: "README.md",
    localDepth: 2,
    linkDirection: "out",
  });
  assert.equal(localOut2.nodeCount, 3);

  // Focus node triggers onSelectNode with inLinks & outLinks
  let focused = null;
  const withSelect = renderKnowledgeGraph(container, graph, {
    document: doc,
    onSelectNode: (detail) => { focused = detail; },
  });
  assert.equal(withSelect.focusNode("docs/a.md"), true);
  assert.equal(focused.id, "docs/a.md");
  assert.equal(focused.inLinks.length, 1);
  assert.equal(focused.outLinks.length, 1);

  // In-place smooth layout & coloring morphing preserves SVG DOM and updates legend
  const svgBefore = collectElements(container, (el) => el.tagName === "svg")[0];
  withSelect.setLayout("radial");
  const newLegend = withSelect.setColorBy("degree");
  const svgAfter = collectElements(container, (el) => el.tagName === "svg")[0];
  assert.equal(svgBefore, svgAfter);
  assert.ok(newLegend.some((item) => item.key.startsWith("deg:")));
  withSelect.destroy();
});

test("renders interactive Kanban board with multi-axis columns, swimlanes, quick transitions, and report export", () => {
  const doc = createMockDocument();
  const container = doc.createElement("div");
  const sampleTasks = [
    {
      path: "docs/a.md",
      line: 10,
      checked: false,
      status: "todo",
      text: "Design multi-workspace index P1 📅 2026-11-18 @alice group:arch color:red",
      cleanText: "Design multi-workspace index",
      priority: "high",
      due: "2026-11-18",
      assignee: "alice",
      group: "arch",
      color: "red",
      heading: "Phase 1",
    },
    {
      path: "docs/a.md",
      line: 12,
      checked: false,
      status: "doing",
      text: "Build Kanban swimlanes P2 📅 2026-11-20 @bob group:ui color:blue status:doing",
      cleanText: "Build Kanban swimlanes",
      priority: "medium",
      due: "2026-11-20",
      assignee: "bob",
      group: "ui",
      color: "blue",
      heading: "Phase 2",
    },
    {
      path: "docs/b.md",
      line: 5,
      checked: true,
      status: "done",
      text: "Verify offline build P1 @alice group:qa color:green",
      cleanText: "Verify offline build",
      priority: "high",
      due: "",
      assignee: "alice",
      group: "qa",
      color: "green",
      heading: "Release",
    },
  ];

  const stats = computeKanbanStats(sampleTasks, "2026-11-20");
  assert.equal(stats.total, 3);
  assert.equal(stats.todo, 1);
  assert.equal(stats.doing, 1);
  assert.equal(stats.done, 1);
  assert.equal(stats.overdue, 1);
  assert.equal(stats.dueToday, 1);
  assert.equal(stats.completionRate, 33);

  // Verify atomic drop patch across swimlane + column
  const drop = computeDropPatch(sampleTasks[0], "status", "review", "assignee", "bob");
  assert.equal(drop.changed, true);
  assert.equal(drop.patch.status, "review");
  assert.equal(drop.patch.checked, false);
  assert.equal(drop.patch.assignee, "bob");

  const moves = [];
  const openedLocations = [];
  const res = renderKanbanBoard(container, sampleTasks, {
    document: doc,
    columnBy: "status",
    swimlaneBy: "priority",
    today: "2026-11-20",
    onMoveTask: (task, patch) => moves.push({ path: task.path, line: task.line, patch }),
    onOpenTaskLocation: (task) => openedLocations.push(`${task.path}:${task.line}`),
  });
  assert.equal(res.columns.length, 4);
  assert.equal(res.swimlanes.length, 4);
  const cards = collectElements(container, (el) => el.className.startsWith("kanban-card") && !el.className.includes("kanban-card-"));
  assert.equal(cards.length, 3);

  // Click quick transition button on first card to move todo -> doing (must NOT open document location)
  const quickBtns = collectElements(cards[0], (el) => el.className.includes("kanban-quick-btn"));
  const doingBtn = quickBtns.find((b) => b.textContent === "进行中");
  assert.ok(doingBtn);
  doingBtn.click();
  assert.equal(moves.length, 1);
  assert.equal(moves[0].patch.status, "doing");
  assert.equal(openedLocations.length, 0);

  // Simulate dragstart -> drop into review column -> dragend -> immediate accidental click on title
  for (const fn of cards[0].listeners.get("dragstart") || []) fn({});
  const colBodies = collectElements(container, (el) => el.className === "kanban-col-body");
  const reviewCol = colBodies.find((b) => b.dataset.colKey === "review" && b.dataset.laneKey === "medium");
  assert.ok(reviewCol);
  for (const fn of reviewCol.listeners.get("drop") || []) fn({});
  for (const fn of cards[0].listeners.get("dragend") || []) fn({});
  const cardTitle = collectElements(cards[0], (el) => el.className.startsWith("kanban-card-title"))[0];
  cardTitle.click();
  assert.equal(moves.length, 2);
  assert.equal(moves[1].patch.status, "review");
  assert.equal(moves[1].patch.priority, "medium");
  assert.equal(openedLocations.length, 0, "drag-drop and post-drag click must not open document view");

  // Verify Markdown report generation
  const report = buildKanbanMarkdownReport(sampleTasks, {
    projectName: "markdown-viewer",
    scope: "all",
    columnBy: "status",
    today: "2026-11-20",
  });
  assert.ok(report.includes("# 📋 任务看板汇总报告（markdown-viewer · 全部工作区）"));
  assert.ok(report.includes("## 进行中 (1)"));
  assert.ok(report.includes("Build Kanban swimlanes"));

  // Verify store hydration of workspaceScope & kanban preferences
  const hydrated = hydrateStore({
    version: 2,
    ui: {
      railTab: "kanban",
      workspaceScope: "all",
      taskGroupBy: "status",
      kanban: { columnBy: "assignee", swimlaneBy: "file", quickFilter: "high" },
    },
  });
  assert.equal(hydrated.ui.railTab, "kanban");
  assert.equal(hydrated.ui.workspaceScope, "all");
  assert.equal(hydrated.ui.taskGroupBy, "status");
  assert.equal(hydrated.ui.kanban.columnBy, "assignee");
  assert.equal(hydrated.ui.kanban.swimlaneBy, "file");
  assert.equal(hydrated.ui.kanban.quickFilter, "high");
});
