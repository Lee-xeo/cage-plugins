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
import { renderOfficeDocument } from "../view/render/office-viewer.mjs";
import { createAssetLoader } from "../view/render/asset-loader.mjs";
import { parseMarkdownSlides, renderSlidesDeck } from "../view/render/slides-view.mjs";
import { evaluateDataviewQuery, renderDataviewBlock } from "../view/render/dataview.mjs";
import { computeLineDiff, renderDiffView } from "../view/render/diff-view.mjs";
import { computeAutocompleteCandidates, convertTsvToMarkdownTable, extractHeadingsFromMarkdown } from "../view/editor-assist.mjs";
import { applyI18n, resolveEffectiveLocale, translate } from "../view/i18n.mjs";
import { buildBatchReplaceArgs, buildSearchScopeArgs } from "../view/search-scope.mjs";
import {
  canPersistDraft,
  fitStateWithinQuota,
  fitStateWithinQuotaWithMeta,
  getDraft,
  hydrateStore,
  isRecoverableDraft,
  setDraft,
} from "../view/store.mjs";

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
    append(...nodes) {
      for (const n of nodes) {
        this.appendChild(typeof n === "string" ? new MockNode(3, n) : n);
      }
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
      const self = this;
      this.classList = {
        add(...tokens) {
          const set = new Set(self.className.split(/\s+/).filter(Boolean));
          for (const t of tokens) if (t) set.add(t);
          self.className = [...set].join(" ");
        },
        remove(...tokens) {
          const rm = new Set(tokens);
          self.className = self.className.split(/\s+/).filter((c) => c && !rm.has(c)).join(" ");
        },
        toggle(token, force) {
          const set = new Set(self.className.split(/\s+/).filter(Boolean));
          const has = force !== undefined ? Boolean(force) : !set.has(token);
          if (has) set.add(token);
          else set.delete(token);
          self.className = [...set].join(" ");
          return has;
        },
        contains(token) {
          return self.className.split(/\s+/).filter(Boolean).includes(token);
        },
      };
    }
    querySelectorAll(selector) {
      const m = String(selector || "").trim().match(/^([a-z0-9_-]+)?(?:\.([a-z0-9_-]+))?$/i);
      if (!m) return [];
      const tag = m[1] ? m[1].toLowerCase() : "";
      const cls = m[2] || "";
      const hits = [];
      const walk = (node) => {
        for (const ch of node.childNodes || []) {
          if (ch.nodeType === 1) {
            const tagOk = !tag || ch.tagName === tag;
            const clsOk = !cls || ch.classList.contains(cls);
            if (tagOk && clsOk) hits.push(ch);
            walk(ch);
          }
        }
      };
      walk(this);
      return hits;
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

test("renders extra offline Mermaid diagrams (pie, gantt, mindmap, classDiagram, erDiagram) and calendar kanban", () => {
  const doc = createMockDocument();
  const root = doc.createElement("div");

  const md = [
    "```mermaid",
    "pie title 分布",
    "  \"A\" : 60",
    "  \"B\" : 40",
    "```",
    "",
    "```mermaid",
    "gantt",
    "  title 排期",
    "  section 核心",
    "  开发 :active, t1, 2026-11-20, 3d",
    "```",
    "",
    "```mermaid",
    "mindmap",
    "  root((中心))",
    "    分支一",
    "```",
    "",
    "```mermaid",
    "classDiagram",
    "  class Node {",
    "    +id string",
    "  }",
    "```",
    "",
    "```mermaid",
    "erDiagram",
    "  USER ||--o{ NOTE : owns",
    "```",
  ].join("\n");

  renderMarkdown(md, root, { document: doc });
  const svgs = collectElements(root, (el) => el.tagName === "svg");
  assert.equal(svgs.length, 5);

  const calHost = doc.createElement("div");
  renderKanbanBoard(
    calHost,
    [
      {
        path: "a.md",
        line: 3,
        checked: false,
        status: "doing",
        cleanText: "排期任务",
        due: "2026-11-22",
        subtasksTotal: 2,
        subtasksDone: 1,
      },
      {
        path: "a.md",
        line: 8,
        checked: false,
        status: "todo",
        cleanText: "未排期任务",
        due: "",
        subtasksTotal: 0,
        subtasksDone: 0,
      },
    ],
    {
      document: doc,
      viewMode: "calendar",
      calendarMonth: "2026-11",
      today: "2026-11-21",
    },
  );
  const calCells = collectElements(calHost, (el) => el.className.includes("kanban-cal-cell") && el.dataset.date === "2026-11-22");
  assert.equal(calCells.length, 1);
  const subLabels = collectElements(calHost, (el) => el.className === "kanban-subtasks-label");
  assert.equal(subLabels[0].textContent, "子任务 1/2");
});

test("renders offline Excel, Word, PPT, and PDF viewers with convert-to-Markdown hooks", () => {
  const doc = createMockDocument();
  const root = doc.createElement("div");
  let converted = null;
  let copiedMd = "";

  // 1. Excel viewer with sheet switching & copy hook
  const xlsxHandle = renderOfficeDocument(
    root,
    {
      path: "docs/budget.xlsx",
      docType: "excel",
      format: "xlsx",
      markdown: "| 项目 | 金额 |\n| --- | --- |\n| 研发 | 1200 |",
      sheets: [
        { name: "Q4预算", rowCount: 2, colCount: 2, truncated: false, rows: [["项目", "金额"], ["研发", "1200"]] },
        { name: "汇总", rowCount: 1, colCount: 1, truncated: false, rows: [["OK"]] },
      ],
    },
    {
      document: doc,
      onCopyMarkdown: (md) => { copiedMd = md; },
      onConvertToMarkdown: (d) => { converted = d.path; },
    },
  );
  const sheetTabs = collectElements(root, (el) => el.classList && el.classList.contains("office-sheet-tab"));
  assert.equal(sheetTabs.length, 2);
  sheetTabs[1].click();
  assert.ok(sheetTabs[1].classList.contains("active"));
  const btns = collectElements(root, (el) => el.tagName === "button");
  btns.find((b) => b.textContent === "复制 Markdown 表格").click();
  assert.ok(copiedMd.includes("| 研发 | 1200 |"));
  btns.find((b) => b.textContent === "转为 Markdown 笔记").click();
  assert.equal(converted, "docs/budget.xlsx");
  xlsxHandle.destroy();

  // 2. Word viewer headings, tables & data: URL embedded images (no blob:)
  const wordHandle = renderOfficeDocument(
    root,
    {
      path: "docs/spec.docx",
      docType: "word",
      format: "docx",
      markdown: "# 架构设计",
      blocks: [
        { kind: "heading", level: 1, text: "架构设计", runs: [{ text: "架构设计", bold: true }], imageRids: ["rId1"] },
        { kind: "table", rows: [["模块", "状态"], ["解析器", "完成"]] },
      ],
      images: {
        rId1: { name: "arch.png", mimeType: "image/png", data: "iVBORw0KGgo=" },
      },
    },
    { document: doc },
  );
  assert.equal(wordHandle.headings.length, 1);
  assert.equal(wordHandle.headings[0].text, "架构设计");
  const wordImgs = collectElements(root, (el) => el.tagName === "img");
  assert.equal(wordImgs.length, 1);
  assert.equal(wordImgs[0].src, "data:image/png;base64,iVBORw0KGgo=");
  wordHandle.destroy();

  // 3. PPT deck slide navigation & data: URL slide images
  const pptHandle = renderOfficeDocument(
    root,
    {
      path: "docs/deck.pptx",
      docType: "ppt",
      format: "pptx",
      markdown: "# Slide 1",
      slides: [
        {
          index: 1,
          title: "第一页",
          bullets: [{ level: 0, text: "要点 A" }],
          tables: [],
          images: [{ name: "slide.png", mimeType: "image/png", data: "AAAA" }],
          notes: "备注 1",
        },
        { index: 2, title: "第二页", bullets: [{ level: 0, text: "要点 B" }], tables: [], images: [], notes: "" },
      ],
    },
    { document: doc },
  );
  assert.equal(pptHandle.headings.length, 2);
  const pptImgs = collectElements(root, (el) => el.tagName === "img");
  assert.equal(pptImgs[0].src, "data:image/png;base64,AAAA");
  const nextBtn = collectElements(root, (el) => el.tagName === "button" && el.textContent === "下一页 ▶")[0];
  nextBtn.click();
  const slideTitles = collectElements(root, (el) => el.className === "office-ppt-title");
  assert.equal(slideTitles[0].textContent, "第二页");
  pptHandle.destroy();

  // 4. PDF viewer defaults directly to extracted text view without <embed>
  const pdfHandle = renderOfficeDocument(
    root,
    {
      path: "docs/manual.pdf",
      docType: "pdf",
      format: "pdf",
      title: "Offline Manual",
      pageCount: 2,
      extractedText: "PDF Extracted Body Text",
      markdown: "# Offline Manual\n\nPDF Extracted Body Text",
    },
    { document: doc },
  );
  const embeds = collectElements(root, (el) => el.tagName === "embed");
  assert.equal(embeds.length, 0);
  const pre = collectElements(root, (el) => el.className === "office-pdf-text")[0];
  assert.equal(pre.textContent, "PDF Extracted Body Text");
  pdfHandle.destroy();
});

test("renders M1-M6 extensions: [TOC], transclusions, dataview, slides deck, LCS diff, and splitScrollLock", () => {
  const doc = createMockDocument();
  const root = doc.createElement("div");

  // 1. [TOC], ![[Transclusion]], and ```dataview block placeholder
  const md = [
    "[TOC]",
    "",
    "# 第一章 架构",
    "",
    "![[docs/design#核心模块|核心模块摘要]]",
    "",
    "行内嵌入 ![[note-a]] 与图片 ![[shot.png]]。",
    "",
    "## 1.1 任务视图",
    "",
    "```dataview",
    "TASK",
    "FROM \"docs\"",
    "WHERE priority = \"high\"",
    "```",
  ].join("\n");

  const mountedImages = [];
  renderMarkdown(md, root, {
    document: doc,
    onAssetMount: (_fig, href) => mountedImages.push(href),
  });
  const tocLinks = collectElements(root, (el) => el.className === "md-toc-box")[0];
  assert.ok(tocLinks);
  const tocAnchors = collectElements(tocLinks, (el) => el.tagName === "a");
  assert.equal(tocAnchors.length, 2);
  assert.equal(tocAnchors[0].textContent, "第一章 架构");

  const transcludes = collectElements(root, (el) => el.className === "md-transclude");
  assert.equal(transcludes.length, 1);
  assert.equal(transcludes[0].dataset.transcludeTarget, "docs/design");
  assert.equal(transcludes[0].dataset.transcludeHeading, "核心模块");
  assert.ok(mountedImages.includes("shot.png"));

  // 2. Dataview engine evaluation & DOM rendering
  const dvHost = doc.createElement("div");
  const dvRes = renderDataviewBlock(
    doc,
    dvHost,
    'TASK\nFROM "docs"\nWHERE priority = "high"\nLIMIT 5',
    {
      files: [{ path: "docs/plan.md", bytes: 200, mtime: 1700000000 }],
      tasks: [
        { path: "docs/plan.md", line: 4, cleanText: "紧急发布", priority: "high", checked: false, status: "todo" },
        { path: "notes/other.md", line: 2, cleanText: "普通任务", priority: "low", checked: false, status: "todo" },
      ],
    },
  );
  assert.equal(dvRes.totalMatched, 1);
  assert.equal(dvRes.rows[0].cleanText, "紧急发布");

  const tableHost = doc.createElement("div");
  const tblRes = renderDataviewBlock(
    doc,
    tableHost,
    "TABLE tasksOpen, bytes\nSORT bytes DESC",
    {
      files: [
        { path: "a.md", bytes: 100, mtime: 100 },
        { path: "b.md", bytes: 500, mtime: 100 },
      ],
      tasks: [{ path: "b.md", checked: false, status: "todo" }],
    },
  );
  assert.equal(tblRes.mode, "table");
  assert.equal(tblRes.rows[0].path, "b.md");
  assert.equal(tblRes.rows[0].tasksOpen, 1);

  // 3. Markdown Slides parser & deck navigation (ignoring --- inside code fence)
  const slideMd = [
    "# 封面页",
    "",
    "```yaml",
    "---",
    "```",
    "<!-- note: 开场白 -->",
    "",
    "---",
    "",
    "## 第二页：细节",
    "- 要点 1",
  ].join("\n");
  const parsedSlides = parseMarkdownSlides(slideMd);
  assert.equal(parsedSlides.slides.length, 2);
  assert.equal(parsedSlides.slides[0].notes, "开场白");

  const slideHost = doc.createElement("div");
  const deck = renderSlidesDeck(slideHost, slideMd, { document: doc, bindKeyboard: false });
  assert.equal(deck.total, 2);
  assert.equal(deck.getCurrentIndex(), 0);
  deck.step(1);
  assert.equal(deck.getCurrentIndex(), 1);
  deck.destroy();

  // 4. LCS Diff computation & DOM view
  const diffHost = doc.createElement("div");
  const diff = renderDiffView(doc, diffHost, "line1\nold line\nline3", "line1\nnew line\nadded line\nline3");
  assert.equal(diff.removed, 1);
  assert.equal(diff.added, 2);
  const addRows = collectElements(diffHost, (el) => el.classList && el.classList.contains("diff-add"));
  const delRows = collectElements(diffHost, (el) => el.classList && el.classList.contains("diff-del"));
  assert.equal(addRows.length, 2);
  assert.equal(delRows.length, 1);

  // 5. splitScrollLock & locale persistence in store
  const s = hydrateStore({ version: 2, ui: { splitScrollLock: false, locale: "en" } });
  assert.equal(s.ui.splitScrollLock, false);
  assert.equal(s.ui.locale, "en");
});

test("supports smart editor autocomplete (slash, heading anchors, callout, code fence, TSV paste) and zh-CN/en i18n", () => {
  // 1. Slash command suggestions (English & Chinese aliases)
  const slashRes = computeAutocompleteCandidates("hello\n/tab", 10);
  assert.ok(slashRes.candidates.some((c) => c.label.includes("/table")));

  // 2. Callout & code fence language autocomplete
  const calloutRes = computeAutocompleteCandidates("> [!war", 7);
  assert.equal(calloutRes.candidates[0].insert, "[!warning] ");
  const fenceRes = computeAutocompleteCandidates("```py", 5);
  assert.equal(fenceRes.candidates[0].label, "python");

  // 3. Task status & Heading anchor autocomplete inside [[doc# and ![[doc#
  const statusRes = computeAutocompleteCandidates("- [ ] Task status:do", 20);
  assert.equal(statusRes.candidates[0].insert, "status:doing ");

  const headings = extractHeadingsFromMarkdown("# 架构总览\n```bash\n# ignored comment\n```\n## 核心接口\n");
  assert.equal(headings.length, 2);
  const anchorRes = computeAutocompleteCandidates("参考 [[design#核心", 16, {
    getNoteHeadings: (docName) => (docName === "design" ? headings : []),
  });
  assert.equal(anchorRes.candidates[0].insert, "[[design#核心接口]]");

  // 4. TSV clipboard to GFM Markdown table conversion
  const mdTable = convertTsvToMarkdownTable("名称\t进度\n解析器\t100%");
  assert.ok(mdTable.includes("| 名称 | 进度 |"));
  assert.ok(mdTable.includes("| --- | --- |"));
  assert.ok(mdTable.includes("| 解析器 | 100% |"));

  // 5. Bilingual i18n locale resolution & translation + Kanban/Graph EN rendering
  assert.equal(resolveEffectiveLocale("auto", "en-US"), "en");
  assert.equal(resolveEffectiveLocale("auto", "zh-CN"), "zh-CN");
  assert.equal(resolveEffectiveLocale("en", "zh-CN"), "en");
  assert.equal(translate("en", "tab.kanban"), "📋 Kanban");
  assert.equal(translate("zh-CN", "tab.kanban"), "📋 任务看板");
  assert.equal(translate("en", "graph.global"), "Global Graph");
  assert.equal(translate("en", "drawer.linksTitle"), "Link Inspector");

  const doc = createMockDocument();
  const kbHost = doc.createElement("div");
  const kbEn = renderKanbanBoard(
    kbHost,
    [{ path: "a.md", line: 1, checked: false, status: "todo", cleanText: "Fix i18n" }],
    { document: doc, locale: "en" },
  );
  assert.equal(kbEn.columns[0].label, "To Do");
  const emptyColHints = collectElements(kbHost, (el) => el.className === "kanban-col-empty");
  assert.ok(emptyColHints.some((e) => e.textContent === "Drop cards here"));

  const grHost = doc.createElement("div");
  const grEn = renderKnowledgeGraph(
    grHost,
    {
      nodes: [
        { id: "a.md", label: "a", dir: "docs", tags: [], degree: 1, inDegree: 0, outDegree: 1 },
        { id: "missing", label: "missing", isGhost: true, tags: [], degree: 1, inDegree: 1, outDegree: 0 },
      ],
      edges: [{ source: "a.md", target: "missing", kind: "wikilink" }],
    },
    { document: doc, locale: "en", colorBy: "tag" },
  );
  assert.ok(grEn.legend.some((item) => item.label === "Untagged"));
  assert.ok(grEn.legend.some((item) => item.label === "Broken Target"));
});

test("uses data: URLs in asset-loader and reads host theme tokens + copyText return/tone in bridge", async () => {
  const doc = createMockDocument();
  const styleProps = new Map();
  doc.documentElement = {
    dataset: {},
    style: {
      setProperty: (k, v) => styleProps.set(k, v),
      removeProperty: (k) => styleProps.delete(k),
    },
  };

  const origDoc = globalThis.document;
  const origWindow = globalThis.window;
  const origURL = globalThis.URL;

  try {
    globalThis.document = doc;
    globalThis.URL = {
      createObjectURL: () => {
        throw new Error("blob: URL must not be used");
      },
      revokeObjectURL: () => {
        throw new Error("blob: URL must not be revoked");
      },
    };

    const figureEl = doc.createElement("figure");
    const loader = createAssetLoader(async () => ({
      isError: false,
      structuredContent: {
        resolvedPath: "docs/assets/a.png",
        mimeType: "image/png",
        bytes: 8,
        data: "iVBORw0KGgo=",
      },
    }));
    await loader.mountProjectImage(figureEl, "docs/guide.md", "assets/a.png", "Logo");
    const mountedImgs = collectElements(figureEl, (el) => el.tagName === "img");
    assert.equal(mountedImgs.length, 1);
    assert.equal(mountedImgs[0].src, "data:image/png;base64,iVBORw0KGgo=");
    loader.clear();

    const listeners = new Map();
    const sent = [];
    let failCopy = false;
    const mockParent = {
      postMessage(msg) {
        sent.push(msg);
        const handlerList = listeners.get("message") || [];
        queueMicrotask(() => {
          const reply = msg.method === "ui/copy" && failCopy
            ? { jsonrpc: "2.0", id: msg.id, error: { message: "denied" } }
            : { jsonrpc: "2.0", id: msg.id, result: { ok: true } };
          for (const fn of handlerList) fn({ source: mockParent, data: reply });
        });
      },
    };
    globalThis.window = {
      parent: mockParent,
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
    };

    const bridge = await import("../view/bridge.mjs");
    bridge.setThemeMode("system");
    bridge.applyTheme({
      scheme: "dark",
      paper: "#wrong-top-level",
      tokens: { paper: "#111213", ink: "#eaeaea" },
    });
    assert.equal(doc.documentElement.dataset.scheme, "dark");
    assert.equal(styleProps.get("--paper"), "#111213");
    assert.equal(styleProps.get("--ink"), "#eaeaea");

    const ok = await bridge.copyText("hello", "Copied!");
    assert.equal(ok, true);
    const infoNotify = sent.find((m) => m.method === "ui/notify");
    assert.equal(infoNotify.params.tone, "info");
    assert.equal("level" in infoNotify.params, false);

    sent.length = 0;
    failCopy = true;
    const failed = await bridge.copyText("hello");
    assert.equal(failed, false);
    const errNotify = sent.find((m) => m.method === "ui/notify");
    assert.equal(errNotify.params.tone, "error");
    assert.equal("level" in errNotify.params, false);
  } finally {
    globalThis.document = origDoc;
    globalThis.window = origWindow;
    globalThis.URL = origURL;
  }
});

test("PR #10 [P1] regressions: shared search/replace scope args and no silent draft truncation over quota", () => {
  // 1. Search and batch replace share identical directory/tag/match-mode scope parameters
  const shared = {
    caseSensitive: true,
    wholeWord: true,
    regex: false,
    pathPrefix: "docs/",
    tags: ["alpha", "alpha", "beta"],
  };
  const searchArgs = buildSearchScopeArgs(shared);
  const replaceArgs = buildBatchReplaceArgs({
    query: "old_token",
    replacement: "new_token",
    ...shared,
  });
  assert.equal(replaceArgs.pathPrefix, searchArgs.pathPrefix);
  assert.deepEqual(replaceArgs.tags, ["alpha", "beta"]);
  assert.equal(replaceArgs.caseSensitive, searchArgs.caseSensitive);
  assert.equal(replaceArgs.wholeWord, searchArgs.wholeWord);
  assert.equal(replaceArgs.regex, searchArgs.regex);

  // 2. Oversized draft (102,403 chars > 56 KiB quota) must NEVER be truncated & restored cleanly
  const store = hydrateStore(null);
  const diskContent = "X".repeat(102400);
  const longDraft = diskContent + "123"; // 102,403 chars
  const baseEtag = "etag-100k-orig";

  assert.equal(canPersistDraft(store, "PR10-Test", "docs/long.md", longDraft, baseEtag), false);

  // Even if setDraft is called directly before quota enforcement, fitStateWithinQuotaWithMeta drops rather than truncates
  setDraft(store, "PR10-Test", "docs/long.md", longDraft, baseEtag);
  const { state: persisted, droppedActiveDraft, droppedKeys } = fitStateWithinQuotaWithMeta(
    store,
    "PR10-Test",
    "docs/long.md",
  );
  assert.equal(droppedActiveDraft, true);
  assert.ok(droppedKeys.includes("PR10-Test::docs/long.md"));
  assert.equal(getDraft(persisted, "PR10-Test", "docs/long.md"), null);
  assert.ok(new TextEncoder().encode(JSON.stringify(persisted)).length <= 56 * 1024);

  // Simulate reopening page from persisted state: must NOT restore truncated draft; file saves full 102,400 chars
  const reopened = hydrateStore(JSON.parse(JSON.stringify(persisted)));
  assert.equal(getDraft(reopened, "PR10-Test", "docs/long.md"), null);
  const activeAfterReopen = getDraft(reopened, "PR10-Test", "docs/long.md")?.content ?? diskContent;
  assert.equal(activeAfterReopen.length, 102400);

  // 3. Legacy or tampered truncated drafts without complete+length integrity are also rejected
  const tamperedStore = hydrateStore({
    version: 2,
    drafts: {
      "proj::legacy.md": { content: "truncated...", baseEtag: "etag1", updatedAt: 1 },
      "proj::mismatch.md": {
        content: "abc",
        baseEtag: "etag2",
        updatedAt: 2,
        complete: true,
        contentLength: 999,
      },
      "proj::ok.md": {
        content: "D".repeat(12000),
        baseEtag: "etag-ok",
        updatedAt: 3,
        complete: true,
        contentLength: 12000,
        contentBytes: 12000,
      },
    },
  });
  assert.equal(isRecoverableDraft(tamperedStore.drafts["proj::ok.md"]), true);
  assert.equal(getDraft(tamperedStore, "proj", "legacy.md"), null);
  assert.equal(getDraft(tamperedStore, "proj", "mismatch.md"), null);
  assert.equal(getDraft(tamperedStore, "proj", "ok.md").content.length, 12000);
  assert.equal(canPersistDraft(tamperedStore, "proj", "normal.md", "D".repeat(12000), "etag-n"), true);
});
