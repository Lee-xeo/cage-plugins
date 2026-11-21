import { copyText, initializeHost, isVisible, onVisibilityChanged, request, setThemeMode } from "./bridge.mjs";
import { createFindBar, locateSourceLine } from "./findbar.mjs";
import { createAssetLoader } from "./render/asset-loader.mjs";
import { renderKnowledgeGraph } from "./render/graph-view.mjs";
import {
  STATUS_META,
  buildKanbanMarkdownReport,
  computeKanbanStats,
  normalizeTaskStatus,
  renderKanbanBoard,
} from "./render/kanban-view.mjs";
import { isRelativeMarkdownHref, renderMarkdown, slugify } from "./renderer.mjs";
import {
  createInitialGraphSettings,
  deleteDraft,
  fitStateWithinQuota,
  getDraft,
  getProjectState,
  hasDraftForFile,
  hydrateStore,
  setDraft,
} from "./store.mjs";

const MAX_SNIPPET_BYTES = 24 * 1024;
const MAX_READ_BYTES = 512 * 1024;
const encoder = new TextEncoder();

const el = (id) => document.getElementById(id);
const tabFiles = el("tab-files");
const tabKanban = el("tab-kanban");
const tabGraph = el("tab-graph");
const tabSnippet = el("tab-snippet");
const projectTooltipName = el("project-tooltip-name");
const projectTooltipWs = el("project-tooltip-ws");
const scopeProjectBtn = el("scope-project-btn");
const scopeAllBtn = el("scope-all-btn");
const scopeWsCount = el("scope-ws-count");
const themeLightBtn = el("theme-light-btn");
const themeDarkBtn = el("theme-dark-btn");
const themeSystemBtn = el("theme-system-btn");
const quickOpenBtn = el("quick-open-btn");
const printBtn = el("print-btn");
const refreshBtn = el("refresh-btn");
const statusBanner = el("status-banner");
const panelFiles = el("panel-files");
const panelSnippet = el("panel-snippet");
const railBtnTree = el("rail-btn-tree");
const railBtnSearch = el("rail-btn-search");
const railBtnTags = el("rail-btn-tags");
const railBtnTasks = el("rail-btn-tasks");
const railBtnKanban = el("rail-btn-kanban");
const railBtnLinks = el("rail-btn-links");
const railBtnGraph = el("rail-btn-graph");
const badgeTags = el("badge-tags");
const badgeTasks = el("badge-tasks");
const badgeLinks = el("badge-links");
const railPanelTree = el("rail-panel-tree");
const railPanelSearch = el("rail-panel-search");
const railPanelTags = el("rail-panel-tags");
const railPanelTasks = el("rail-panel-tasks");
const railPanelLinks = el("rail-panel-links");
const searchTagsBar = el("search-tags-bar");
const tagsSummary = el("tags-summary");
const clearTagsBtn = el("clear-tags-btn");
const tagCloud = el("tag-cloud");
const tagFilesList = el("tag-files-list");
const tasksSummary = el("tasks-summary");
const openKanbanBtn = el("open-kanban-btn");
const taskFilterOpen = el("task-filter-open");
const taskFilterAll = el("task-filter-all");
const taskFilterDone = el("task-filter-done");
const taskGroupBySel = el("task-group-by");
const taskFilterPrioritySel = el("task-filter-priority");
const taskFilterAssigneeSel = el("task-filter-assignee");
const taskColorFilter = el("task-color-filter");
const tasksList = el("tasks-list");
const emptyKanbanBtn = el("empty-kanban-btn");
const emptyGraphBtn = el("empty-graph-btn");
const kanbanWorkspace = el("kanban-workspace");
const kanbanColBySel = el("kanban-col-by");
const kanbanLaneBySel = el("kanban-lane-by");
const kanbanFilterInput = el("kanban-filter");
const kanbanAddTaskBtn = el("kanban-add-task-btn");
const kanbanCopyReportBtn = el("kanban-copy-report-btn");
const kanbanRefreshBtn = el("kanban-refresh-btn");
const kanbanCloseBtn = el("kanban-close-btn");
const kanbanStatsBar = el("kanban-stats-bar");
const kanbanBoard = el("kanban-board");
const graphWorkspace = el("graph-workspace");
const graphScopeGlobalBtn = el("graph-scope-global");
const graphScopeLocalBtn = el("graph-scope-local");
const graphLayoutSel = el("graph-layout-sel");
const graphColorSel = el("graph-color-sel");
const graphFilterInput = el("graph-filter");
const graphShowOrphansCb = el("graph-show-orphans");
const graphShowGhostsCb = el("graph-show-ghosts");
const graphShowTagsCb = el("graph-show-tags");
const graphShowArrowsCb = el("graph-show-arrows");
const graphSmartLabelsCb = el("graph-smart-labels");
const graphAnimatePhysicsCb = el("graph-animate-physics");
const graphLocalDepthSel = el("graph-local-depth");
const graphLinkDirSel = el("graph-link-dir");
const graphRepelInput = el("graph-repel");
const graphRepelVal = el("graph-repel-val");
const graphLinkDistInput = el("graph-link-dist");
const graphLinkDistVal = el("graph-link-dist-val");
const graphGravityInput = el("graph-gravity");
const graphGravityVal = el("graph-gravity-val");
const graphNodeScaleInput = el("graph-node-scale");
const graphNodeScaleVal = el("graph-node-scale-val");
const graphZoomOutBtn = el("graph-zoom-out");
const graphFitBtn = el("graph-fit");
const graphZoomInBtn = el("graph-zoom-in");
const graphRefreshBtn = el("graph-refresh");
const graphExportSvgBtn = el("graph-export-svg");
const graphSettingsBtn = el("graph-settings-btn");
const graphSettingsPanel = el("graph-settings-panel");
const graphResetSettingsBtn = el("graph-reset-settings");
const graphStatsEl = el("graph-stats");
const graphCloseBtn = el("graph-close-btn");
const graphCanvas = el("graph-canvas");
const graphLegendEl = el("graph-legend");
const graphNodeCard = el("graph-node-card");
const graphNodeTitle = el("graph-node-title");
const graphNodeCenterBtn = el("graph-node-center");
const graphNodePathBtn = el("graph-node-path");
const graphNodeOpenBtn = el("graph-node-open");
const graphNodeMeta = el("graph-node-meta");
const graphPathInfoEl = el("graph-path-info");
const graphNodeTags = el("graph-node-tags");
const graphNodeLinksEl = el("graph-node-links");
const editorLineHighlight = el("editor-line-highlight");
const taskMetaModal = el("task-meta-modal");
const taskMetaDesc = el("task-meta-desc");
const tmStatus = el("tm-status");
const tmPriority = el("tm-priority");
const tmDue = el("tm-due");
const tmAssignee = el("tm-assignee");
const tmGroup = el("tm-group");
const tmColorPicker = el("tm-color-picker");
const tmCancelBtn = el("tm-cancel-btn");
const tmSaveBtn = el("tm-save-btn");
const newTaskModal = el("new-task-modal");
const ntFile = el("nt-file");
const ntText = el("nt-text");
const ntStatus = el("nt-status");
const ntPriority = el("nt-priority");
const ntDue = el("nt-due");
const ntAssignee = el("nt-assignee");
const ntGroup = el("nt-group");
const ntColorPicker = el("nt-color-picker");
const ntCancelBtn = el("nt-cancel-btn");
const ntSaveBtn = el("nt-save-btn");
const linksSummary = el("links-summary");
const scanLinksBtn = el("scan-links-btn");
const linksList = el("links-list");
const disambigModal = el("disambig-modal");
const disambigDesc = el("disambig-desc");
const disambigList = el("disambig-list");
const disambigCancelBtn = el("disambig-cancel-btn");
const fileBrowser = el("file-browser");
const projectNameEl = el("project-name");
const fileFilter = el("file-filter");
const fulltextInput = el("fulltext-input");
const fulltextBtn = el("fulltext-btn");
const searchOptCase = el("search-opt-case");
const searchOptWord = el("search-opt-word");
const searchOptRegex = el("search-opt-regex");
const searchOptCtx = el("search-opt-ctx");
const searchGroupToggle = el("search-group-toggle");
const searchCollapseBtn = el("search-collapse-btn");
const searchScopeDir = el("search-scope-dir");
const searchSortBy = el("search-sort-by");
const searchHistoryBar = el("search-history-bar");
const viewTreeBtn = el("view-tree-btn");
const toggleAllBtn = el("toggle-all-btn");
const fileCount = el("file-count");
const fileList = el("file-list");
const searchSummary = el("search-summary");
const searchList = el("search-list");
const docWorkspace = el("doc-workspace");
const docEmpty = el("doc-empty");
const emptyQuickOpenBtn = el("empty-quick-open-btn");
const emptySearchBtn = el("empty-search-btn");
const docViewer = el("doc-viewer");
const toggleTreeBtn = el("toggle-tree-btn");
const backBtn = el("back-btn");
const docPath = el("doc-path");
const docSavedPill = el("doc-saved-pill");
const docDirtyPill = el("doc-dirty-pill");
const docReadonlyPill = el("doc-readonly-pill");
const docConflictPill = el("doc-conflict-pill");
const docMeta = el("doc-meta");
const modeReadBtn = el("mode-read");
const modeSplitBtn = el("mode-split");
const modeEditBtn = el("mode-edit");
const findBtn = el("find-btn");
const outlineBtn = el("outline-btn");
const outlinePanel = el("outline-panel");
const outlineList = el("outline-list");
const outlineFoldAllBtn = el("outline-fold-all-btn");
const saveBtn = el("save-btn");
const copySourceBtn = el("copy-source-btn");
const conflictBanner = el("conflict-banner");
const openConflictBtn = el("open-conflict-btn");
const readonlyBanner = el("readonly-banner");
const draftBanner = el("draft-banner");
const draftBannerText = el("draft-banner-text");
const restoreDiskBtn = el("restore-disk-btn");
const workspacePanes = el("workspace-panes");
const editorPane = el("editor-pane");
const previewPane = el("preview-pane");
const formatBar = el("format-bar");
const docEditor = el("doc-editor");
const docContent = el("doc-content");
const backlinksPanel = el("backlinks-panel");
const backlinksCount = el("backlinks-count");
const backlinksList = el("backlinks-list");
const snippetInput = el("snippet-input");
const snippetBytes = el("snippet-bytes");
const snippetPreview = el("snippet-preview");
const snippetCopyBtn = el("snippet-copy-btn");

// Modals & Overlays
const leaveModal = el("leave-modal");
const leaveModalDesc = el("leave-modal-desc");
const leaveSaveBtn = el("leave-save-btn");
const leaveDraftBtn = el("leave-draft-btn");
const leaveDiscardBtn = el("leave-discard-btn");
const leaveCancelBtn = el("leave-cancel-btn");
const conflictModal = el("conflict-modal");
const conflictModalDesc = el("conflict-modal-desc");
const conflictMetaBox = el("conflict-meta-box");
const conflictKeepBtn = el("conflict-keep-btn");
const conflictReloadBtn = el("conflict-reload-btn");
const conflictForceBtn = el("conflict-force-btn");
const quickOpenModal = el("quick-open-modal");
const quickOpenInput = el("quick-open-input");
const quickOpenList = el("quick-open-list");
const lightboxModal = el("lightbox-modal");
const lightboxCaption = el("lightbox-caption");
const lightboxImg = el("lightbox-img");
const lightboxCloseBtn = el("lightbox-close-btn");
const toastEl = el("toast");
const resizerSidebar = el("resizer-sidebar");
const resizerSplit = el("resizer-split");
const resizerOutline = el("resizer-outline");
const resizerSnippet = el("resizer-snippet");

const findBar = createFindBar({
  barEl: el("find-bar"),
  inputEl: el("find-input"),
  countEl: el("find-count"),
  prevBtn: el("find-prev"),
  nextBtn: el("find-next"),
  caseBtn: el("find-case"),
  closeBtn: el("find-close"),
  containerEl: docContent,
});

const assetLoader = createAssetLoader(request, () => (store?.ui?.workspaceScope === "all" ? "all" : "project"));

let store = hydrateStore(null);
let allFiles = [];
let discoveredWorkspaces = [];
let currentProjectName = "";
let currentFilePath = "";
let savedFileContent = "";
let currentBaseEtag = "";
let currentFileBytes = 0;
let currentFileTruncated = false;
let currentFileReadOnly = false;
let isDirty = false;
let conflictInfo = null; // { path, diskEtag, diskBytes }
let knownDirs = new Set();
let stateTimer = null;
let draftTimer = null;
let searchTimer = null;
let toastTimer = null;
let scrollSpyRaf = 0;
let pendingLeaveAction = null;
let currentHeadings = [];
let quickOpenItems = [];
let quickOpenIndex = 0;

const selectedTags = new Set();
const collapsedDocHeadings = new Set();
const collapsedSnippetHeadings = new Set();
const collapsedKanbanLanes = new Set();
let taskFilterStatus = "open";
let taskFilterPriority = "";
let taskFilterAssignee = "";
let taskFilterColor = "";
let editingTask = null;
let editingTaskColor = "";
let newTaskColor = "";
let cachedTags = [];
let cachedAllTasks = [];
let kanbanOpen = false;
let graphOpen = false;
let graphScope = "global";
let cachedGraphData = null;
let graphHandle = null;
let selectedGraphNode = null;
let activeSyncPreviewEl = null;
let activeSyncEditorRange = null; // { startLine, endLine }
let hoverSyncTimer = null;

function getActiveScope() {
  return store?.ui?.workspaceScope === "all" ? "all" : "project";
}

function withScope(args = {}) {
  return getActiveScope() === "all" ? { ...args, scope: "all" } : { ...args };
}

async function callScopedTool(name, args = {}) {
  const scopedArgs = withScope(args);
  const res = await request("tools/call", { name, arguments: scopedArgs });
  if (
    getActiveScope() === "all" &&
    res &&
    res.isError &&
    /additionalProperties|Unexpected|scope/i.test(res.content?.[0]?.text || "")
  ) {
    return request("tools/call", { name, arguments: { ...args } });
  }
  return res;
}

function applyScopeUI() {
  const scope = getActiveScope();
  if (scopeProjectBtn) scopeProjectBtn.classList.toggle("active", scope === "project");
  if (scopeAllBtn) scopeAllBtn.classList.toggle("active", scope === "all");
  const wsCount = Math.max(1, discoveredWorkspaces.length);
  if (scopeWsCount) scopeWsCount.textContent = String(wsCount);
  if (projectTooltipName) projectTooltipName.textContent = currentProjectName || "—";
  if (projectTooltipWs) {
    projectTooltipWs.textContent =
      wsCount > 1
        ? `已发现同级工作区（${wsCount} 个）：${discoveredWorkspaces.join(" · ")}`
        : `当前检测到 1 个工作区（${currentProjectName || "—"}）；可在宿主左侧「项目 +」添加或切换工作区。`;
  }
}

function showToast(message) {
  if (!toastEl || !message) return;
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 2400);
}

function showBanner(message, isError = false) {
  if (!message) {
    statusBanner.hidden = true;
    statusBanner.textContent = "";
    statusBanner.classList.remove("error");
    return;
  }
  statusBanner.hidden = false;
  statusBanner.textContent = message;
  statusBanner.classList.toggle("error", isError);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function setBadge(badgeEl, count) {
  if (!badgeEl) return;
  const n = Number(count) || 0;
  badgeEl.hidden = n <= 0;
  badgeEl.textContent = n > 99 ? "99+" : String(n);
}

function schedulePersistState(immediate = false) {
  clearTimeout(stateTimer);
  const run = () => {
    store.snippet = snippetInput.value || "";
    const proj = getProjectState(store, currentProjectName);
    proj.currentFilePath = currentFilePath;
    const fitted = fitStateWithinQuota(store, currentProjectName, currentFilePath);
    request("ui/setState", { state: fitted }).catch(() => {});
  };
  if (immediate) {
    run();
  } else {
    stateTimer = setTimeout(run, 200);
  }
}

function resolveRelativePath(baseFile, href) {
  const cleanHref = href.split(/[?#]/, 1)[0];
  const baseParts = baseFile.split("/").slice(0, -1);
  const relParts = cleanHref.split("/");
  const stack = [...baseParts];
  for (const part of relParts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) return null;
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join("/");
}

function resolveWikilinkCandidates(target) {
  const clean = target.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const stripExt = (p) => p.replace(/\.(md|markdown|mdx)$/i, "");
  const exact = allFiles.filter((f) => f.path.toLowerCase() === clean || stripExt(f.path.toLowerCase()) === clean);
  if (exact.length > 0) return exact.map((f) => f.path);
  return allFiles
    .filter((f) => {
      const base = f.path.split("/").pop().toLowerCase();
      return base === clean || stripExt(base) === clean;
    })
    .map((f) => f.path);
}

function annotateWikilinks(container) {
  const links = container.querySelectorAll("a.md-wikilink");
  for (const anchor of links) {
    const target = anchor.dataset.mdWikilink || "";
    if (!target) continue;
    const candidates = resolveWikilinkCandidates(target);
    anchor.classList.toggle("broken", candidates.length === 0);
    if (candidates.length === 0) {
      anchor.title = `失效链接：未找到「${target}」（点击前往链接巡检）`;
    } else if (candidates.length > 1) {
      anchor.title = `存在 ${candidates.length} 个同名目标，点击消歧选择`;
    } else {
      anchor.title = `跳转至 ${candidates[0]}`;
    }
  }
}

function openDisambigModal(rawTarget, candidates, heading) {
  disambigDesc.textContent = `找到 ${candidates.length} 个同名文档「${rawTarget}」，请选择要打开的目标：`;
  while (disambigList.firstChild) disambigList.removeChild(disambigList.firstChild);
  for (const candidate of candidates) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "file-item search-hit";
    const span = document.createElement("span");
    span.className = "file-name";
    span.textContent = candidate;
    btn.appendChild(span);

    const fileInfo = allFiles.find((f) => f.path === candidate);
    const meta = document.createElement("span");
    meta.className = "hit-snippet";
    const dir = candidate.includes("/") ? candidate.slice(0, candidate.lastIndexOf("/")) : "根目录";
    meta.textContent = fileInfo ? `目录：${dir} · ${formatBytes(fileInfo.bytes)}` : `目录：${dir}`;
    btn.appendChild(meta);

    btn.addEventListener("click", () => {
      disambigModal.hidden = true;
      guardUnsavedAction(() => openProjectFile(candidate, { anchorSlug: heading ? slugify(heading) : "" }));
    });
    disambigList.appendChild(btn);
  }
  disambigModal.hidden = false;
}

function openLightbox(src, caption) {
  if (!lightboxModal || !lightboxImg) return;
  lightboxImg.src = src;
  lightboxImg.alt = caption || "";
  lightboxCaption.textContent = caption || "离线图片预览";
  lightboxModal.hidden = false;
}

function closeLightbox() {
  if (!lightboxModal) return;
  lightboxModal.hidden = true;
  lightboxImg.removeAttribute("src");
}

function appendHighlightedSnippet(parentEl, snippet, query) {
  const text = String(snippet || "");
  const q = String(query || "").trim();
  if (!q) {
    parentEl.textContent = text;
    return;
  }
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let pos = 0;
  let idx = lower.indexOf(needle);
  while (idx !== -1) {
    if (idx > pos) {
      parentEl.appendChild(document.createTextNode(text.slice(pos, idx)));
    }
    const mk = document.createElement("mark");
    mk.textContent = text.slice(idx, idx + q.length);
    parentEl.appendChild(mk);
    pos = idx + q.length;
    idx = lower.indexOf(needle, pos);
  }
  if (pos < text.length) {
    parentEl.appendChild(document.createTextNode(text.slice(pos)));
  }
}

function applyLayoutSizes() {
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty("--sidebar-width", `${store.ui.sidebarWidth || 276}px`);
  rootStyle.setProperty("--outline-width", `${store.ui.outlineWidth || 210}px`);
  rootStyle.setProperty("--split-ratio", `${store.ui.splitRatio || 50}%`);
  rootStyle.setProperty("--snippet-ratio", `${store.ui.snippetRatio || 50}%`);
}

function attachHorizontalResizer(handleEl, { onDrag, onReset }) {
  if (!handleEl) return;
  handleEl.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handleEl.classList.add("dragging");
    document.body.classList.add("is-resizing");
    handleEl.setPointerCapture(event.pointerId);

    const onMove = (moveEvent) => onDrag(moveEvent);
    const onUp = () => {
      handleEl.classList.remove("dragging");
      document.body.classList.remove("is-resizing");
      handleEl.removeEventListener("pointermove", onMove);
      handleEl.removeEventListener("pointerup", onUp);
      handleEl.removeEventListener("pointercancel", onUp);
      schedulePersistState(true);
    };

    handleEl.addEventListener("pointermove", onMove);
    handleEl.addEventListener("pointerup", onUp);
    handleEl.addEventListener("pointercancel", onUp);
  });

  handleEl.addEventListener("dblclick", () => {
    onReset();
    applyLayoutSizes();
    schedulePersistState(true);
  });
}

function syncRailActiveStates() {
  const isFilesTab = store.ui.activeTab !== "snippet";
  const activeDrawer = store.ui.sidebarOpen ? store.ui.railTab : "";
  if (railBtnTree) railBtnTree.classList.toggle("active", activeDrawer === "tree");
  if (railBtnSearch) railBtnSearch.classList.toggle("active", activeDrawer === "search");
  if (railBtnTags) railBtnTags.classList.toggle("active", activeDrawer === "tags");
  if (railBtnTasks) railBtnTasks.classList.toggle("active", activeDrawer === "tasks");
  if (railBtnLinks) railBtnLinks.classList.toggle("active", activeDrawer === "links");
  if (railBtnKanban) railBtnKanban.classList.toggle("active", isFilesTab && Boolean(kanbanOpen));
  if (railBtnGraph) railBtnGraph.classList.toggle("active", isFilesTab && Boolean(graphOpen));

  if (tabFiles) {
    const docActive = isFilesTab && !kanbanOpen && !graphOpen;
    tabFiles.classList.toggle("active", docActive);
    tabFiles.setAttribute("aria-selected", String(docActive));
  }
  if (tabKanban) {
    const kbActive = isFilesTab && Boolean(kanbanOpen);
    tabKanban.classList.toggle("active", kbActive);
    tabKanban.setAttribute("aria-selected", String(kbActive));
  }
  if (tabGraph) {
    const grActive = isFilesTab && Boolean(graphOpen);
    tabGraph.classList.toggle("active", grActive);
    tabGraph.setAttribute("aria-selected", String(grActive));
  }
  if (tabSnippet) {
    const snActive = !isFilesTab;
    tabSnippet.classList.toggle("active", snActive);
    tabSnippet.setAttribute("aria-selected", String(snActive));
  }
}

function setSidebarOpen(open) {
  store.ui.sidebarOpen = Boolean(open);
  fileBrowser.hidden = !store.ui.sidebarOpen;
  if (resizerSidebar) resizerSidebar.hidden = !store.ui.sidebarOpen;
  toggleTreeBtn.classList.toggle("active", store.ui.sidebarOpen);
  syncRailActiveStates();
}

function applyThemeModeUI(mode) {
  const next = mode === "light" || mode === "dark" ? mode : "system";
  store.ui.themeMode = next;
  setThemeMode(next);
  if (themeLightBtn) themeLightBtn.classList.toggle("active", next === "light");
  if (themeDarkBtn) themeDarkBtn.classList.toggle("active", next === "dark");
  if (themeSystemBtn) themeSystemBtn.classList.toggle("active", next === "system");
}

function closeGraphView() {
  graphOpen = false;
  if (graphHandle && typeof graphHandle.destroy === "function") {
    graphHandle.destroy();
    graphHandle = null;
  }
  if (graphWorkspace) graphWorkspace.hidden = true;
  if (kanbanOpen) {
    if (kanbanWorkspace) kanbanWorkspace.hidden = false;
    docViewer.hidden = true;
    docEmpty.hidden = true;
  } else if (currentFilePath) {
    docViewer.hidden = false;
    docEmpty.hidden = true;
  } else {
    docViewer.hidden = true;
    docEmpty.hidden = false;
  }
  syncRailActiveStates();
}

function getKanbanPrefs() {
  if (!store.ui.kanban || typeof store.ui.kanban !== "object") {
    store.ui.kanban = { columnBy: "status", swimlaneBy: "none", quickFilter: "all" };
  }
  return store.ui.kanban;
}

function syncKanbanControlsFromStore() {
  const kp = getKanbanPrefs();
  if (kanbanColBySel) kanbanColBySel.value = kp.columnBy || "status";
  if (kanbanLaneBySel) kanbanLaneBySel.value = kp.swimlaneBy || "none";
}

function closeKanbanView() {
  kanbanOpen = false;
  if (kanbanWorkspace) kanbanWorkspace.hidden = true;
  if (currentFilePath) {
    docViewer.hidden = false;
    docEmpty.hidden = true;
  } else {
    docViewer.hidden = true;
    docEmpty.hidden = false;
  }
  syncRailActiveStates();
}

let graphLocalCenter = "";
let graphHighlightGroup = null;

function getGraphSettings() {
  if (!store.ui.graph || typeof store.ui.graph !== "object") {
    store.ui.graph = createInitialGraphSettings();
  }
  return store.ui.graph;
}

function syncGraphControlsFromStore() {
  const gs = getGraphSettings();
  if (graphLayoutSel) graphLayoutSel.value = gs.layout;
  if (graphColorSel) graphColorSel.value = gs.colorBy;
  if (graphShowOrphansCb) graphShowOrphansCb.checked = gs.showOrphans;
  if (graphShowGhostsCb) graphShowGhostsCb.checked = gs.showGhosts;
  if (graphShowTagsCb) graphShowTagsCb.checked = gs.showTags;
  if (graphShowArrowsCb) graphShowArrowsCb.checked = gs.showArrows;
  if (graphSmartLabelsCb) graphSmartLabelsCb.checked = gs.smartLabels;
  if (graphAnimatePhysicsCb) graphAnimatePhysicsCb.checked = gs.animatePhysics !== false;
  if (graphLocalDepthSel) graphLocalDepthSel.value = String(gs.localDepth);
  if (graphLinkDirSel) graphLinkDirSel.value = gs.linkDirection;
  if (graphRepelInput) graphRepelInput.value = String(gs.repel);
  if (graphRepelVal) graphRepelVal.textContent = String(gs.repel);
  if (graphLinkDistInput) graphLinkDistInput.value = String(gs.linkDist);
  if (graphLinkDistVal) graphLinkDistVal.textContent = String(gs.linkDist);
  if (graphGravityInput) graphGravityInput.value = String(gs.gravity);
  if (graphGravityVal) graphGravityVal.textContent = String(gs.gravity);
  if (graphNodeScaleInput) graphNodeScaleInput.value = String(gs.nodeScale);
  if (graphNodeScaleVal) graphNodeScaleVal.textContent = `${gs.nodeScale}%`;
}

function renderGraphLegend(legendItems) {
  if (!graphLegendEl) return;
  while (graphLegendEl.firstChild) graphLegendEl.removeChild(graphLegendEl.firstChild);
  if (!legendItems || legendItems.length === 0) {
    graphLegendEl.hidden = true;
    return;
  }
  if (graphScope === "local" && graphLocalCenter) {
    const centerBtn = document.createElement("button");
    centerBtn.type = "button";
    centerBtn.className = "graph-legend-item active";
    centerBtn.title = "点击清除自定义局部中心，回到当前打开文档";
    const lbl = document.createElement("span");
    lbl.className = "graph-legend-label";
    lbl.textContent = `中心: ${graphLocalCenter.split("/").pop()} ✕`;
    centerBtn.appendChild(lbl);
    centerBtn.addEventListener("click", () => {
      graphLocalCenter = "";
      renderGraphFromCache();
    });
    graphLegendEl.appendChild(centerBtn);
  }
  for (const item of legendItems.slice(0, 12)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "graph-legend-item" + (graphHighlightGroup === item.key ? " active" : "");
    btn.title = `点击高亮/取消筛选：${item.label}`;
    const dot = document.createElement("span");
    dot.className = "graph-legend-dot";
    dot.style.background = item.color;
    const label = document.createElement("span");
    label.className = "graph-legend-label";
    label.textContent = item.label;
    const cnt = document.createElement("span");
    cnt.className = "count";
    cnt.textContent = String(item.count);
    btn.append(dot, label, cnt);
    btn.addEventListener("click", () => {
      if (!graphHandle) return;
      graphHighlightGroup = graphHandle.setHighlightGroup(item.key);
      renderGraphLegend(graphHandle.legend);
    });
    graphLegendEl.appendChild(btn);
  }
  graphLegendEl.hidden = false;
}

function renderGraphNodeCard(node) {
  selectedGraphNode = node;
  if (!node) {
    graphNodeCard.hidden = true;
    if (graphPathInfoEl) graphPathInfoEl.hidden = true;
    return;
  }
  graphNodeTitle.textContent = node.label;
  graphNodeOpenBtn.hidden = Boolean(node.isGhost || node.isTag);
  if (graphNodeCenterBtn) graphNodeCenterBtn.hidden = false;
  if (graphNodePathBtn) {
    const canTrace = Boolean(currentFilePath && currentFilePath !== node.id);
    graphNodePathBtn.hidden = !canTrace;
  }
  if (graphPathInfoEl) graphPathInfoEl.hidden = true;

  if (node.isGhost) {
    graphNodeMeta.textContent = `未创建目标 · 被 ${node.inDegree} 处引用`;
  } else if (node.isTag) {
    graphNodeMeta.textContent = `标签聚类节点 · 关联 ${node.degree} 篇文档`;
  } else {
    const taskPart = node.tasksTotal > 0 ? ` · 待办 ${node.tasksOpen}/${node.tasksTotal}` : "";
    graphNodeMeta.textContent = `${node.id} · 入链 ${node.inDegree} · 出链 ${node.outDegree}${taskPart}`;
  }

  while (graphNodeTags.firstChild) graphNodeTags.removeChild(graphNodeTags.firstChild);
  for (const tag of node.tags || []) {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    chip.textContent = `#${tag}`;
    graphNodeTags.appendChild(chip);
  }

  if (graphNodeLinksEl) {
    while (graphNodeLinksEl.firstChild) graphNodeLinksEl.removeChild(graphNodeLinksEl.firstChild);
    const appendRelGroup = (title, list) => {
      if (!list || list.length === 0) return;
      const block = document.createElement("div");
      block.className = "graph-rel-block";
      const head = document.createElement("div");
      head.className = "graph-rel-title";
      head.textContent = `${title} (${list.length})`;
      const chips = document.createElement("div");
      chips.className = "graph-rel-chips";
      for (const rel of list.slice(0, 14)) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "graph-rel-chip";
        b.textContent = rel.label;
        b.title = `定位到 ${rel.id}`;
        b.addEventListener("click", () => {
          if (graphHandle) graphHandle.focusNode(rel.id);
        });
        chips.appendChild(b);
      }
      block.append(head, chips);
      graphNodeLinksEl.appendChild(block);
    };
    appendRelGroup("出链（引用）", node.outLinks);
    appendRelGroup("入链（反向引用）", node.inLinks);
  }

  graphNodeCard.hidden = false;
}

function renderGraphFromCache() {
  if (!graphCanvas || !cachedGraphData) return;
  const gs = getGraphSettings();
  graphNodeCard.hidden = true;
  selectedGraphNode = null;
  graphHighlightGroup = null;
  graphHandle = renderKnowledgeGraph(graphCanvas, cachedGraphData, {
    activePath: currentFilePath,
    centerId: graphLocalCenter || currentFilePath,
    scope: graphScope,
    localDepth: gs.localDepth,
    linkDirection: gs.linkDirection,
    layout: gs.layout,
    colorBy: gs.colorBy,
    showOrphans: gs.showOrphans,
    showGhosts: gs.showGhosts,
    showTags: gs.showTags,
    showArrows: gs.showArrows,
    smartLabels: gs.smartLabels,
    animatePhysics: gs.animatePhysics !== false,
    repel: gs.repel,
    linkDist: gs.linkDist,
    gravity: gs.gravity,
    nodeScale: gs.nodeScale,
    filterQuery: graphFilterInput ? graphFilterInput.value : "",
    onOpenFile: (path) => {
      closeGraphView();
      guardUnsavedAction(() => openProjectFile(path));
    },
    onSelectNode: renderGraphNodeCard,
  });
  graphStatsEl.textContent = `${graphHandle.nodeCount} 节点 · ${graphHandle.edgeCount} 连线`;
  renderGraphLegend(graphHandle.legend);
}

async function buildClientSideGraph() {
  const files = allFiles.length > 0 ? allFiles : [];
  let linksData = null;
  try {
    const linksRes = await callScopedTool("inspect_project_links", {});
    if (linksRes && !linksRes.isError) {
      linksData = linksRes.structuredContent || JSON.parse(linksRes.content[0].text);
      if (linksData && linksData.graph && Array.isArray(linksData.graph.nodes)) {
        return linksData.graph;
      }
    }
  } catch {
    // Continue with pure backlinks fallback
  }

  const tagsByPath = new Map();
  try {
    const tagsRes = await callScopedTool("list_project_tags", {});
    if (tagsRes && !tagsRes.isError) {
      const tagsData = tagsRes.structuredContent || JSON.parse(tagsRes.content[0].text);
      for (const t of tagsData.tags || []) {
        for (const p of t.files || []) {
          if (!tagsByPath.has(p)) tagsByPath.set(p, []);
          tagsByPath.get(p).push(t.name);
        }
      }
    }
  } catch {
    // Tags are optional metadata on graph nodes
  }

  const nodesMap = new Map();
  for (const f of files) {
    const p = f.path;
    const parts = p.split("/");
    const dir = parts.length > 1 ? parts[0] : "(root)";
    const base = parts[parts.length - 1];
    const stem = base.replace(/\.(md|markdown|mdx)$/i, "") || p;
    const label = /^(readme|index)$/i.test(stem) && parts.length >= 2 ? `${parts[parts.length - 2]}/${stem}` : stem;
    nodesMap.set(p, {
      id: p,
      label,
      dir,
      degree: 0,
      inDegree: 0,
      outDegree: 0,
      tags: tagsByPath.get(p) || [],
      isGhost: false,
    });
  }

  const edgeMap = new Map();
  const capped = files.slice(0, 120);
  const BATCH = 10;
  for (let i = 0; i < capped.length; i += BATCH) {
    const batch = capped.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map((f) =>
        callScopedTool("get_backlinks", { path: f.path }).catch(() => null)
      )
    );
    results.forEach((res, idx) => {
      if (!res || res.isError) return;
      const targetPath = batch[idx].path;
      let payload = null;
      try {
        payload = res.structuredContent || JSON.parse(res.content[0].text);
      } catch {
        return;
      }
      for (const bl of payload.backlinks || []) {
        const src = bl.sourcePath;
        if (!src || src === targetPath || !nodesMap.has(src)) continue;
        const key = `${src}=>${targetPath}`;
        if (!edgeMap.has(key)) {
          edgeMap.set(key, {
            source: src,
            target: targetPath,
            kind: bl.kind || "wikilink",
            broken: false,
          });
        }
      }
    });
  }

  for (const b of (linksData && linksData.brokenLinks) || []) {
    const src = b.sourcePath;
    const rawTarget = (b.rawTarget || "").trim();
    if (!src || !rawTarget || !nodesMap.has(src)) continue;
    const ghostId = `ghost::${rawTarget}`;
    if (!nodesMap.has(ghostId)) {
      nodesMap.set(ghostId, {
        id: ghostId,
        label: rawTarget,
        dir: "_ghost",
        degree: 0,
        inDegree: 0,
        outDegree: 0,
        tags: [],
        isGhost: true,
      });
    }
    const key = `${src}=>${ghostId}`;
    if (!edgeMap.has(key)) {
      edgeMap.set(key, {
        source: src,
        target: ghostId,
        kind: b.kind || "wikilink",
        broken: true,
      });
    }
  }

  const edges = [...edgeMap.values()];
  for (const e of edges) {
    const s = nodesMap.get(e.source);
    const t = nodesMap.get(e.target);
    if (s) { s.outDegree += 1; s.degree += 1; }
    if (t) { t.inDegree += 1; t.degree += 1; }
  }

  return {
    nodes: [...nodesMap.values()],
    edges,
  };
}

async function openGraphView(forceReload = false) {
  setTab("files");
  kanbanOpen = false;
  if (kanbanWorkspace) kanbanWorkspace.hidden = true;
  graphOpen = true;
  docEmpty.hidden = true;
  docViewer.hidden = true;
  graphWorkspace.hidden = false;
  syncRailActiveStates();
  if (!cachedGraphData || forceReload) {
    showBanner("正在构建双链知识图谱…");
    try {
      let data = null;
      try {
        const result = await callScopedTool("get_project_graph", {});
        if (result && !result.isError) {
          data = result.structuredContent || JSON.parse(result.content[0].text);
        }
      } catch {
        data = null;
      }
      if (!data || !Array.isArray(data.nodes)) {
        data = await buildClientSideGraph();
      }
      cachedGraphData = data;
      showBanner("");
    } catch (err) {
      showBanner(`知识图谱加载失败: ${err.message}`, true);
      return;
    }
  }
  requestAnimationFrame(() => renderGraphFromCache());
}

const VALID_RAILS = new Set(["tree", "search", "tags", "tasks", "links"]);

function setRailTab(tab, ensureOpen = true) {
  const next = VALID_RAILS.has(tab) ? tab : "tree";
  store.ui.railTab = next;
  if (ensureOpen) setSidebarOpen(true);
  railPanelTree.hidden = next !== "tree";
  railPanelSearch.hidden = next !== "search";
  railPanelTags.hidden = next !== "tags";
  railPanelTasks.hidden = next !== "tasks";
  railPanelLinks.hidden = next !== "links";
  syncRailActiveStates();
}

function setOutlineOpen(open) {
  store.ui.outlineOpen = Boolean(open);
  outlinePanel.hidden = !store.ui.outlineOpen;
  if (resizerOutline) resizerOutline.hidden = !store.ui.outlineOpen;
  outlineBtn.classList.toggle("active", store.ui.outlineOpen);
  docWorkspace.classList.toggle("outline-open", store.ui.outlineOpen);
}

function updateActiveOutlineItem() {
  if (!store.ui.outlineOpen || currentHeadings.length === 0 || docViewer.hidden) return;
  const paneRect = previewPane.getBoundingClientRect();
  let activeId = currentHeadings[0]?.id || "";
  for (const h of currentHeadings) {
    if (!h.id) continue;
    const target = document.getElementById(h.id);
    if (!target) continue;
    if (target.getBoundingClientRect().top - paneRect.top <= 96) {
      activeId = h.id;
    } else {
      break;
    }
  }
  const buttons = outlineList.querySelectorAll("button.outline-item");
  for (const btn of buttons) {
    btn.classList.toggle("active", Boolean(activeId && btn.dataset.headingId === activeId));
  }
}

function recomputeHeadingFolding(container, collapsedSet) {
  const children = [...container.children];
  const hiddenByStack = []; // [{ level, headingEl, count }]
  for (const child of children) {
    const level = child.dataset && child.dataset.headingLevel ? Number.parseInt(child.dataset.headingLevel, 10) : 0;
    if (level > 0) {
      while (hiddenByStack.length > 0 && hiddenByStack[hiddenByStack.length - 1].level >= level) {
        const popped = hiddenByStack.pop();
        popped.headingEl.dataset.foldHint = popped.count > 0 ? `已折叠 ${popped.count} 块` : "已折叠";
      }
      const hiddenByAncestor = hiddenByStack.length > 0;
      child.classList.toggle("md-folded-hidden", hiddenByAncestor);
      if (hiddenByAncestor) {
        for (const frame of hiddenByStack) frame.count += 1;
      }
      const key = child.dataset.headingKey || "";
      const isCollapsed = Boolean(key && collapsedSet.has(key));
      child.classList.toggle("md-heading-collapsed", isCollapsed);
      const btn = child.querySelector(":scope > button.md-heading-fold-btn");
      if (btn) btn.setAttribute("aria-expanded", String(!isCollapsed));
      if (isCollapsed) {
        hiddenByStack.push({ level, headingEl: child, count: 0 });
      } else {
        delete child.dataset.foldHint;
      }
    } else {
      const shouldHide = hiddenByStack.length > 0;
      child.classList.toggle("md-folded-hidden", shouldHide);
      if (shouldHide) {
        for (const frame of hiddenByStack) frame.count += 1;
      }
    }
  }
  while (hiddenByStack.length > 0) {
    const popped = hiddenByStack.pop();
    popped.headingEl.dataset.foldHint = popped.count > 0 ? `已折叠 ${popped.count} 块` : "已折叠";
  }
  if (container === docContent && outlineFoldAllBtn) {
    const anyCollapsed = collapsedDocHeadings.size > 0;
    outlineFoldAllBtn.textContent = anyCollapsed ? "展开全部" : "折叠全部";
  }
}

function unfoldAncestorsOf(container, targetEl, collapsedSet) {
  if (!targetEl || !container.contains(targetEl)) return;
  let block = targetEl;
  while (block && block.parentElement !== container) {
    block = block.parentElement;
  }
  if (!block) return;

  const children = [...container.children];
  const targetIdx = children.indexOf(block);
  if (targetIdx === -1) return;

  let minLevel = block.dataset && block.dataset.headingLevel
    ? Number.parseInt(block.dataset.headingLevel, 10)
    : 7;
  let changed = false;
  for (let i = targetIdx - 1; i >= 0; i--) {
    const elNode = children[i];
    const lvl = elNode.dataset && elNode.dataset.headingLevel ? Number.parseInt(elNode.dataset.headingLevel, 10) : 0;
    if (lvl > 0 && lvl < minLevel) {
      const key = elNode.dataset.headingKey || "";
      if (key && collapsedSet.has(key)) {
        collapsedSet.delete(key);
        changed = true;
      }
      minLevel = lvl;
      if (minLevel === 1) break;
    }
  }
  if (changed) {
    recomputeHeadingFolding(container, collapsedSet);
    if (container === docContent) renderOutline(currentHeadings);
  }
}

function renderOutline(headings) {
  currentHeadings = Array.isArray(headings) ? headings : [];
  while (outlineList.firstChild) outlineList.removeChild(outlineList.firstChild);
  if (currentHeadings.length === 0) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "当前文档没有标题。";
    outlineList.appendChild(empty);
    return;
  }
  for (const h of currentHeadings) {
    const row = document.createElement("div");
    row.className = "outline-row";
    row.style.paddingLeft = `${(h.level - 1) * 10}px`;

    const foldBtn = document.createElement("button");
    foldBtn.type = "button";
    foldBtn.className = "outline-fold-btn";
    const isCollapsed = Boolean(h.key && collapsedDocHeadings.has(h.key));
    foldBtn.textContent = isCollapsed ? "▸" : "▾";
    foldBtn.title = isCollapsed ? "展开此章节" : "折叠此章节";
    foldBtn.addEventListener("click", () => {
      if (!h.key) return;
      if (collapsedDocHeadings.has(h.key)) collapsedDocHeadings.delete(h.key);
      else collapsedDocHeadings.add(h.key);
      recomputeHeadingFolding(docContent, collapsedDocHeadings);
      renderOutline(currentHeadings);
    });
    row.appendChild(foldBtn);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "outline-item";
    if (h.id) btn.dataset.headingId = h.id;
    btn.textContent = h.text;
    btn.addEventListener("click", () => {
      const targetEl = h.id ? document.getElementById(h.id) : null;
      if (targetEl) {
        unfoldAncestorsOf(docContent, targetEl, collapsedDocHeadings);
        targetEl.scrollIntoView({ behavior: "smooth" });
      }
    });
    row.appendChild(btn);
    outlineList.appendChild(row);
  }
  updateActiveOutlineItem();
}

function renderDocContent(markdown) {
  const meta = renderMarkdown(markdown, docContent, {
    onCopy: (code) => {
      copyText(code, "已复制代码块");
      showToast("已复制代码块");
    },
    onAssetMount: (figureEl, assetHref, alt) => {
      assetLoader.mountProjectImage(figureEl, currentFilePath, assetHref, alt, openLightbox);
    },
    onTaskToggle: currentFilePath && !currentFileReadOnly
      ? (line, checked, checkboxEl) => handleInlineTaskToggle(line, checked, checkboxEl)
      : null,
  });
  annotateWikilinks(docContent);
  recomputeHeadingFolding(docContent, collapsedDocHeadings);
  renderOutline(meta.headings);
  const sizeLabel = currentFileTruncated
    ? `${formatBytes(currentFileBytes)}（已截断）`
    : formatBytes(currentFileBytes);
  docMeta.textContent = `${sizeLabel} · ${meta.wordCount} 字 · 约 ${meta.readingMinutes} 分钟`;
  findBar.refresh();
}

function setDocMode(mode) {
  if (currentFileReadOnly && mode !== "read") {
    mode = "read";
  }
  store.ui.docMode = mode === "edit" || mode === "split" ? mode : "read";
  modeReadBtn.classList.toggle("active", store.ui.docMode === "read");
  modeSplitBtn.classList.toggle("active", store.ui.docMode === "split");
  modeEditBtn.classList.toggle("active", store.ui.docMode === "edit");
  workspacePanes.className = `workspace-panes mode-${store.ui.docMode}`;
  editorPane.hidden = store.ui.docMode === "read";
  previewPane.hidden = store.ui.docMode === "edit";
  if (resizerSplit) resizerSplit.hidden = store.ui.docMode !== "split";
}

function hasCurrentConflict() {
  return Boolean(conflictInfo && conflictInfo.path === currentFilePath);
}

function updateStatusPills() {
  const conflict = hasCurrentConflict();
  docConflictPill.hidden = !conflict;
  conflictBanner.hidden = !conflict;
  docReadonlyPill.hidden = conflict || !currentFileReadOnly;
  docDirtyPill.hidden = conflict || currentFileReadOnly || !isDirty;
  docSavedPill.hidden = conflict || currentFileReadOnly || isDirty;
}

function updateReadOnlyControls() {
  readonlyBanner.hidden = !currentFileReadOnly;
  modeSplitBtn.disabled = currentFileReadOnly;
  modeEditBtn.disabled = currentFileReadOnly;
  docEditor.readOnly = currentFileReadOnly;
  if (currentFileReadOnly) {
    setDocMode("read");
  }
  updateStatusPills();
}

function updateDirtyState() {
  isDirty = !currentFileReadOnly && docEditor.value !== savedFileContent;
  saveBtn.hidden = !isDirty;
  draftBanner.hidden = hasCurrentConflict() || (!isDirty && !hasDraftForFile(store, currentProjectName, currentFilePath));
  updateStatusPills();
}

function scheduleDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    if (!currentFilePath || currentFileReadOnly) return;
    if (docEditor.value !== savedFileContent) {
      setDraft(store, currentProjectName, currentFilePath, docEditor.value, currentBaseEtag);
    } else {
      deleteDraft(store, currentProjectName, currentFilePath);
    }
    renderFileList();
    schedulePersistState(true);
  }, 300);
}

function openConflictDialog() {
  if (!conflictInfo) return;
  const localBytes = encoder.encode(docEditor.value || "").length;
  conflictModalDesc.textContent = `「${conflictInfo.path}」在磁盘上的版本已发生变化（ETag 失配），为防止覆盖外部修改，本次保存已被拦截。`;

  while (conflictMetaBox.firstChild) conflictMetaBox.removeChild(conflictMetaBox.firstChild);
  const leftCol = document.createElement("div");
  leftCol.className = "modal-meta-col";
  const lt = document.createElement("strong");
  lt.textContent = "你的本地草稿";
  const l1 = document.createElement("span");
  l1.className = "muted";
  l1.textContent = `大小：${formatBytes(localBytes)}`;
  const l2 = document.createElement("span");
  l2.className = "muted";
  l2.textContent = `基准 ETag：${currentBaseEtag ? currentBaseEtag.slice(0, 10) : "—"}`;
  leftCol.append(lt, l1, l2);

  const rightCol = document.createElement("div");
  rightCol.className = "modal-meta-col";
  const rt = document.createElement("strong");
  rt.textContent = "磁盘最新外部版本";
  const r1 = document.createElement("span");
  r1.className = "muted";
  r1.textContent = `大小：${formatBytes(conflictInfo.diskBytes || 0)}`;
  const r2 = document.createElement("span");
  r2.className = "muted";
  r2.textContent = `最新 ETag：${conflictInfo.diskEtag ? conflictInfo.diskEtag.slice(0, 10) : "—"}`;
  rightCol.append(rt, r1, r2);

  conflictMetaBox.append(leftCol, rightCol);
  conflictMetaBox.hidden = false;
  conflictModal.hidden = false;
}

function guardUnsavedAction(action) {
  if (!currentFilePath || !isDirty) {
    action();
    return;
  }
  pendingLeaveAction = action;
  leaveModalDesc.textContent = `「${currentFilePath}」有未保存的编辑内容，切换前请选择处理方式：`;
  leaveModal.hidden = false;
}

leaveSaveBtn.addEventListener("click", async () => {
  const action = pendingLeaveAction;
  leaveModal.hidden = true;
  pendingLeaveAction = null;
  const ok = await saveCurrentFile();
  if (ok && action) action();
});

leaveDraftBtn.addEventListener("click", () => {
  const action = pendingLeaveAction;
  leaveModal.hidden = true;
  pendingLeaveAction = null;
  setDraft(store, currentProjectName, currentFilePath, docEditor.value, currentBaseEtag);
  schedulePersistState(true);
  showToast(`已将 ${currentFilePath} 保留为本地草稿`);
  if (action) action();
});

leaveDiscardBtn.addEventListener("click", () => {
  const action = pendingLeaveAction;
  leaveModal.hidden = true;
  pendingLeaveAction = null;
  deleteDraft(store, currentProjectName, currentFilePath);
  isDirty = false;
  if (hasCurrentConflict()) conflictInfo = null;
  schedulePersistState(true);
  showToast("已放弃未保存修改");
  if (action) action();
});

leaveCancelBtn.addEventListener("click", () => {
  leaveModal.hidden = true;
  pendingLeaveAction = null;
});

function attachInteractiveHandlers(container) {
  const collapsedSet = container === docContent ? collapsedDocHeadings : collapsedSnippetHeadings;
  container.addEventListener("click", (event) => {
    const foldBtn = event.target.closest("button.md-heading-fold-btn");
    const collapsedHeading = !foldBtn ? event.target.closest("h1.md-heading-collapsed, h2.md-heading-collapsed, h3.md-heading-collapsed, h4.md-heading-collapsed, h5.md-heading-collapsed, h6.md-heading-collapsed") : null;
    if (foldBtn || (collapsedHeading && !event.target.closest("a, button"))) {
      const heading = foldBtn ? foldBtn.parentElement : collapsedHeading;
      const key = heading && heading.dataset ? heading.dataset.headingKey : "";
      if (key) {
        if (collapsedSet.has(key)) collapsedSet.delete(key);
        else collapsedSet.add(key);
        recomputeHeadingFolding(container, collapsedSet);
        if (container === docContent) renderOutline(currentHeadings);
      }
      return;
    }

    const tagBtn = event.target.closest("button.md-tag");
    if (tagBtn) {
      const tag = tagBtn.dataset.mdTag;
      if (tag) {
        setTab("files");
        setRailTab("tags", true);
        selectedTags.clear();
        selectedTags.add(tag);
        renderSearchTagBar();
        loadTagsPanel();
      }
      return;
    }

    const anchor = event.target.closest("a");
    if (!anchor) return;
    event.preventDefault();

    if (anchor.dataset.mdWikilink) {
      const rawTarget = anchor.dataset.mdWikilink;
      const candidates = resolveWikilinkCandidates(rawTarget);
      const heading = anchor.dataset.mdHeading || "";
      if (candidates.length === 1) {
        guardUnsavedAction(() => openProjectFile(candidates[0], { anchorSlug: heading ? slugify(heading) : "" }));
      } else if (candidates.length > 1) {
        openDisambigModal(rawTarget, candidates, heading);
      } else {
        setRailTab("links", true);
        loadLinksPanel();
        showToast(`未找到双链目标「[[${rawTarget}]]」，已打开链接巡检`);
      }
      return;
    }

    const href = anchor.dataset.mdHref || anchor.getAttribute("href") || "";
    if (!href) return;

    if (href.startsWith("#")) {
      const targetId = href.slice(1);
      const targetEl = targetId ? document.getElementById(targetId) : null;
      if (targetEl) {
        unfoldAncestorsOf(container, targetEl, collapsedSet);
        targetEl.scrollIntoView({ behavior: "smooth" });
      }
      return;
    }

    if (isRelativeMarkdownHref(href) && currentFilePath && store.ui.activeTab === "files") {
      const resolved = resolveRelativePath(currentFilePath, href);
      if (resolved) {
        guardUnsavedAction(() => openProjectFile(resolved));
        return;
      }
    }

    copyText(href, `已复制链接: ${href}`);
    showToast("已复制外部链接");
  });
}

function setTab(tab) {
  store.ui.activeTab = tab === "snippet" ? "snippet" : "files";
  panelFiles.hidden = store.ui.activeTab !== "files";
  panelSnippet.hidden = store.ui.activeTab !== "snippet";
  refreshBtn.hidden = store.ui.activeTab !== "files";
  quickOpenBtn.hidden = store.ui.activeTab !== "files";
  syncRailActiveStates();
  schedulePersistState();
}

function createFileItemButton(item, displayName) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "file-item";
  if (item.path === currentFilePath) btn.classList.add("active");
  btn.setAttribute("role", "listitem");

  const nameSpan = document.createElement("span");
  nameSpan.className = "file-name";
  if (hasDraftForFile(store, currentProjectName, item.path)) {
    const dot = document.createElement("span");
    dot.className = "file-item-status";
    dot.title = "有未保存草稿";
    nameSpan.appendChild(dot);
  }
  const label = item.bytes > MAX_READ_BYTES ? `🔒 ${displayName}` : displayName;
  nameSpan.appendChild(document.createTextNode(label));
  btn.appendChild(nameSpan);

  const sizeSpan = document.createElement("span");
  sizeSpan.className = "file-size";
  sizeSpan.textContent = formatBytes(item.bytes);
  btn.appendChild(sizeSpan);

  btn.addEventListener("click", () => {
    if (item.path === currentFilePath && !docViewer.hidden) return;
    guardUnsavedAction(() => openProjectFile(item.path));
  });
  return btn;
}

function buildFileTree(files) {
  const root = { dirs: new Map(), files: [], count: 0 };
  for (const item of files) {
    const parts = item.path.split("/");
    let node = root;
    node.count += 1;
    for (let i = 0; i < parts.length - 1; i++) {
      const dirName = parts[i];
      if (!node.dirs.has(dirName)) {
        node.dirs.set(dirName, { dirs: new Map(), files: [], count: 0 });
      }
      node = node.dirs.get(dirName);
      node.count += 1;
    }
    node.files.push({ item, name: parts[parts.length - 1] });
  }
  return root;
}

function renderTreeNode(node, parentEl, prefix, forceExpand, collapsedSet) {
  const dirNames = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b));
  for (const dirName of dirNames) {
    const child = node.dirs.get(dirName);
    const dirPath = prefix ? `${prefix}/${dirName}` : dirName;
    knownDirs.add(dirPath);
    const isExpanded = forceExpand || !collapsedSet.has(dirPath);

    const wrapper = document.createElement("div");
    wrapper.className = "tree-dir";

    const dirBtn = document.createElement("button");
    dirBtn.type = "button";
    dirBtn.className = "tree-dir-btn";

    const chevron = document.createElement("span");
    chevron.className = "tree-chevron";
    chevron.textContent = isExpanded ? "▾" : "▸";
    dirBtn.appendChild(chevron);

    const nameSpan = document.createElement("span");
    nameSpan.className = "tree-dir-name";
    nameSpan.textContent = dirName;
    dirBtn.appendChild(nameSpan);

    const badge = document.createElement("span");
    badge.className = "tree-badge";
    badge.textContent = String(child.count);
    dirBtn.appendChild(badge);

    const childrenEl = document.createElement("div");
    childrenEl.className = "tree-children";
    childrenEl.hidden = !isExpanded;

    dirBtn.addEventListener("click", () => {
      const proj = getProjectState(store, currentProjectName);
      const set = new Set(proj.collapsedDirs || []);
      if (set.has(dirPath)) set.delete(dirPath);
      else set.add(dirPath);
      proj.collapsedDirs = [...set];
      renderFileList();
      schedulePersistState();
    });

    wrapper.appendChild(dirBtn);
    renderTreeNode(child, childrenEl, dirPath, forceExpand, collapsedSet);
    wrapper.appendChild(childrenEl);
    parentEl.appendChild(wrapper);
  }

  const sortedFiles = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
  for (const { item, name } of sortedFiles) {
    parentEl.appendChild(createFileItemButton(item, name));
  }
}

function renderFileList() {
  const query = (fileFilter.value || "").trim().toLowerCase();
  const filtered = query
    ? allFiles.filter((f) => f.path.toLowerCase().includes(query))
    : allFiles;

  fileCount.textContent = query ? `${filtered.length} / ${allFiles.length}` : `${allFiles.length} 个文件`;
  viewTreeBtn.textContent = store.ui.treeMode ? "切换平铺" : "切换树形";
  toggleAllBtn.hidden = !store.ui.treeMode || filtered.length === 0;
  while (fileList.firstChild) fileList.removeChild(fileList.firstChild);

  if (filtered.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = allFiles.length === 0 ? "当前项目未发现 Markdown 文件。" : "没有匹配的文件名，可切至左侧「🔍 全文检索」搜正文。";
    fileList.appendChild(empty);
    return;
  }

  if (store.ui.treeMode) {
    knownDirs.clear();
    const proj = getProjectState(store, currentProjectName);
    const collapsedSet = new Set(proj.collapsedDirs || []);
    const tree = buildFileTree(filtered);
    renderTreeNode(tree, fileList, "", Boolean(query), collapsedSet);
    const allCollapsed = knownDirs.size > 0 && [...knownDirs].every((d) => collapsedSet.has(d));
    toggleAllBtn.textContent = allCollapsed ? "展开目录" : "收起目录";
  } else {
    for (const item of filtered) {
      fileList.appendChild(createFileItemButton(item, item.path));
    }
  }
}

function renderSearchTagBar() {
  while (searchTagsBar.firstChild) searchTagsBar.removeChild(searchTagsBar.firstChild);
  if (selectedTags.size === 0) {
    searchTagsBar.hidden = true;
    return;
  }
  searchTagsBar.hidden = false;
  const label = document.createElement("span");
  label.className = "count";
  label.textContent = "限定标签：";
  searchTagsBar.appendChild(label);

  for (const tag of selectedTags) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tag-chip active";
    chip.textContent = `#${tag} ×`;
    chip.title = "点击移除该标签过滤";
    chip.addEventListener("click", () => {
      selectedTags.delete(tag);
      renderSearchTagBar();
      if (store.ui.railTab === "tags") loadTagsPanel();
      if (fulltextInput.value.trim()) runFulltextSearch();
    });
    searchTagsBar.appendChild(chip);
  }
}

let searchCaseSensitive = false;
let searchWholeWord = false;
let searchRegex = false;
let searchPathPrefix = "";
let searchCollapsedFiles = new Set();
let lastSearchData = null;
let lastSearchQuery = "";
let searchHitButtons = [];
let searchActiveIdx = -1;

function getSearchPrefs() {
  if (!store.ui.search || typeof store.ui.search !== "object") {
    store.ui.search = { grouped: true, context: false, sortBy: "relevance", history: [] };
  }
  return store.ui.search;
}

function syncSearchControlsFromStore() {
  const sp = getSearchPrefs();
  if (searchOptCtx) searchOptCtx.classList.toggle("active", Boolean(sp.context));
  if (searchGroupToggle) {
    searchGroupToggle.classList.toggle("active", Boolean(sp.grouped));
    searchGroupToggle.textContent = sp.grouped ? "按文件" : "平铺";
  }
  if (searchCollapseBtn) searchCollapseBtn.hidden = !sp.grouped;
  if (searchSortBy) searchSortBy.value = sp.sortBy || "relevance";
  renderSearchHistory();
}

function populateSearchDirScope() {
  if (!searchScopeDir) return;
  const topDirs = [...new Set(
    allFiles
      .map((f) => (f.path.includes("/") ? f.path.split("/")[0] + "/" : ""))
      .filter(Boolean)
  )].sort();
  const prev = searchPathPrefix;
  while (searchScopeDir.firstChild) searchScopeDir.removeChild(searchScopeDir.firstChild);
  const optAll = document.createElement("option");
  optAll.value = "";
  optAll.textContent = "全部目录";
  searchScopeDir.appendChild(optAll);
  for (const d of topDirs) {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = `仅 ${d}`;
    searchScopeDir.appendChild(opt);
  }
  searchScopeDir.value = topDirs.includes(prev) ? prev : "";
  searchPathPrefix = searchScopeDir.value;
}

function pushSearchHistory(query) {
  const q = String(query || "").trim();
  if (!q || q.length < 2) return;
  const sp = getSearchPrefs();
  const next = [q, ...(sp.history || []).filter((item) => item !== q)].slice(0, 10);
  sp.history = next;
  schedulePersistState();
  renderSearchHistory();
}

function renderSearchHistory() {
  if (!searchHistoryBar) return;
  while (searchHistoryBar.firstChild) searchHistoryBar.removeChild(searchHistoryBar.firstChild);
  const sp = getSearchPrefs();
  const list = Array.isArray(sp.history) ? sp.history : [];
  if (list.length === 0) {
    searchHistoryBar.hidden = true;
    return;
  }
  searchHistoryBar.hidden = false;
  const lbl = document.createElement("span");
  lbl.className = "count";
  lbl.textContent = "最近：";
  searchHistoryBar.appendChild(lbl);
  for (const q of list.slice(0, 6)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "search-history-chip";
    btn.textContent = q;
    btn.title = `搜索：${q}`;
    btn.addEventListener("click", () => {
      fulltextInput.value = q;
      runFulltextSearch(q, { saveHistory: true });
    });
    searchHistoryBar.appendChild(btn);
  }
}

function appendRangeHighlightedSnippet(parentEl, snippet, ranges, fallbackQuery) {
  const text = String(snippet || "");
  if (!Array.isArray(ranges) || ranges.length === 0) {
    appendHighlightedSnippet(parentEl, text, fallbackQuery);
    return;
  }
  let pos = 0;
  for (const pair of ranges) {
    const s = Math.max(pos, Math.min(text.length, Number(pair[0]) || 0));
    const e = Math.max(s, Math.min(text.length, Number(pair[1]) || 0));
    if (s > pos) parentEl.appendChild(document.createTextNode(text.slice(pos, s)));
    if (e > s) {
      const mk = document.createElement("mark");
      mk.textContent = text.slice(s, e);
      parentEl.appendChild(mk);
    }
    pos = e;
  }
  if (pos < text.length) {
    parentEl.appendChild(document.createTextNode(text.slice(pos)));
  }
}

function extractPrimaryFindTerm(query, parsed) {
  if (parsed && Array.isArray(parsed.terms) && parsed.terms.length > 0) {
    return parsed.terms[0];
  }
  if (parsed && Array.isArray(parsed.headings) && parsed.headings.length > 0) {
    return parsed.headings[0];
  }
  return String(query || "").trim();
}

function setSearchActiveIndex(nextIdx) {
  if (searchHitButtons.length === 0) {
    searchActiveIdx = -1;
    return;
  }
  if (searchActiveIdx >= 0 && searchHitButtons[searchActiveIdx]) {
    searchHitButtons[searchActiveIdx].classList.remove("kb-active");
  }
  searchActiveIdx = ((nextIdx % searchHitButtons.length) + searchHitButtons.length) % searchHitButtons.length;
  const target = searchHitButtons[searchActiveIdx];
  target.classList.add("kb-active");
  target.scrollIntoView({ block: "nearest" });
}

function createSearchHitButton(hit, findTerm, showPath) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "search-hit-item";

  const meta = document.createElement("div");
  meta.className = "search-hit-meta";
  const lineEl = document.createElement("span");
  lineEl.className = "search-hit-line";
  lineEl.textContent = showPath
    ? (hit.line > 0 ? `${hit.path}:${hit.line}` : hit.path)
    : (hit.line > 0 ? `L${hit.line}` : "路径匹配");
  meta.appendChild(lineEl);

  if (hit.heading) {
    const hEl = document.createElement("span");
    hEl.className = "search-hit-heading";
    hEl.textContent = `§ ${hit.heading}`;
    meta.appendChild(hEl);
  }
  btn.appendChild(meta);

  if (hit.contextBefore) {
    const beforeEl = document.createElement("div");
    beforeEl.className = "search-hit-ctx";
    beforeEl.textContent = hit.contextBefore;
    btn.appendChild(beforeEl);
  }

  const snip = document.createElement("div");
  snip.className = "search-hit-snippet";
  appendRangeHighlightedSnippet(snip, hit.snippet, hit.matchRanges, findTerm);
  btn.appendChild(snip);

  if (hit.contextAfter) {
    const afterEl = document.createElement("div");
    afterEl.className = "search-hit-ctx";
    afterEl.textContent = hit.contextAfter;
    btn.appendChild(afterEl);
  }

  btn.addEventListener("click", () => {
    guardUnsavedAction(() =>
      openProjectFile(hit.path, {
        line: hit.line,
        query: searchRegex ? "" : findTerm,
        caseSensitive: searchCaseSensitive,
      })
    );
  });
  return btn;
}

function renderSearchResults(data, query) {
  while (searchList.firstChild) searchList.removeChild(searchList.firstChild);
  searchHitButtons = [];
  searchActiveIdx = -1;

  if (!data) {
    const hint = document.createElement("div");
    hint.className = "search-syntax-hint";
    hint.textContent = "检索语法：空格多词 AND · \"精确短语\" · -排除词 · path:docs/ · -path:targets · tag:标签 · heading:章节；也可开启 Aa / \\b / .* 正则。";
    searchList.appendChild(hint);
    return;
  }

  const matches = Array.isArray(data.matches) ? data.matches : [];
  let files = Array.isArray(data.files) ? data.files : null;
  if (!files) {
    const map = new Map();
    for (const m of matches) {
      if (!map.has(m.path)) map.set(m.path, { path: m.path, matchCount: 0, hits: [] });
      const g = map.get(m.path);
      g.matchCount += 1;
      g.hits.push(m);
    }
    files = [...map.values()];
  }

  const totalFiles = typeof data.totalFilesMatched === "number" ? data.totalFilesMatched : files.length;
  const totalMatches = typeof data.totalMatches === "number" ? data.totalMatches : matches.length;
  searchSummary.textContent = `${totalMatches} 处 / ${totalFiles} 文件${data.truncated ? "（部分）" : ""}`;

  if (matches.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = selectedTags.size > 0 || searchPathPrefix
      ? "在当前限定条件下未找到匹配内容。"
      : "未找到匹配内容。";
    searchList.appendChild(empty);
    return;
  }

  const findTerm = extractPrimaryFindTerm(query, data.parsed);
  const sp = getSearchPrefs();
  if (sp.grouped) {
    for (const fileGroup of files) {
      const card = document.createElement("div");
      card.className = "search-file-group";
      const isCollapsed = searchCollapsedFiles.has(fileGroup.path);

      const header = document.createElement("button");
      header.type = "button";
      header.className = "search-file-header";
      header.title = fileGroup.path;

      const chev = document.createElement("span");
      chev.className = "search-file-chevron";
      chev.textContent = isCollapsed ? "▸" : "▾";

      const title = document.createElement("span");
      title.className = "search-file-title";
      title.textContent = fileGroup.path;

      const badge = document.createElement("span");
      badge.className = "count";
      badge.textContent = String(fileGroup.matchCount || fileGroup.hits.length);

      header.append(chev, title, badge);
      header.addEventListener("click", () => {
        if (searchCollapsedFiles.has(fileGroup.path)) searchCollapsedFiles.delete(fileGroup.path);
        else searchCollapsedFiles.add(fileGroup.path);
        renderSearchResults(lastSearchData, lastSearchQuery);
      });
      card.appendChild(header);

      if (!isCollapsed) {
        const listEl = document.createElement("div");
        listEl.className = "search-file-hits";
        for (const hit of fileGroup.hits) {
          const hitBtn = createSearchHitButton(hit, findTerm, false);
          listEl.appendChild(hitBtn);
          searchHitButtons.push(hitBtn);
        }
        card.appendChild(listEl);
      }
      searchList.appendChild(card);
    }

    if (searchCollapseBtn) {
      const allCollapsed = files.length > 0 && files.every((f) => searchCollapsedFiles.has(f.path));
      searchCollapseBtn.textContent = allCollapsed ? "展开" : "收起";
    }
  } else {
    for (const hit of matches) {
      const hitBtn = createSearchHitButton(hit, findTerm, true);
      searchList.appendChild(hitBtn);
      searchHitButtons.push(hitBtn);
    }
  }
}

async function runFulltextSearch(explicitQuery, opts = {}) {
  const query = (explicitQuery !== undefined ? explicitQuery : fulltextInput.value || "").trim();
  lastSearchQuery = query;
  if (!query) {
    lastSearchData = null;
    searchSummary.textContent = "输入关键词";
    renderSearchResults(null, "");
    return;
  }
  const sp = getSearchPrefs();
  showBanner(`正在检索 "${query}"…`);
  try {
    const richArgs = {
      query,
      limit: 150,
      caseSensitive: searchCaseSensitive,
      wholeWord: searchWholeWord,
      regex: searchRegex,
      pathPrefix: searchPathPrefix,
      sortBy: sp.sortBy || "relevance",
      includeContext: Boolean(sp.context),
    };
    if (selectedTags.size > 0) {
      richArgs.tags = [...selectedTags];
    }

    let result;
    try {
      result = await callScopedTool("search_markdown_files", richArgs);
      if (result && result.isError && /additionalProperties|Unexpected|invalid/i.test(result.content?.[0]?.text || "")) {
        throw new Error("LEGACY_SCHEMA");
      }
    } catch {
      const legacyArgs = { query, limit: 100 };
      if (selectedTags.size > 0) legacyArgs.tags = [...selectedTags];
      result = await request("tools/call", {
        name: "search_markdown_files",
        arguments: legacyArgs,
      });
    }

    if (result.isError) throw new Error(result.content?.[0]?.text || "检索失败");
    const data = result.structuredContent || JSON.parse(result.content[0].text);
    lastSearchData = data;
    searchCollapsedFiles.clear();
    renderSearchResults(data, query);
    if (opts.saveHistory) pushSearchHistory(query);
    showBanner("");
  } catch (err) {
    searchSummary.textContent = "检索出错";
    showBanner(`检索失败: ${err.message}`, true);
  }
}

async function refreshRailBadges() {
  if (!isVisible() || allFiles.length === 0) {
    setBadge(badgeTags, 0);
    setBadge(badgeTasks, 0);
    setBadge(badgeLinks, 0);
    return;
  }
  const [tagsRes, tasksRes, linksRes] = await Promise.all([
    callScopedTool("list_project_tags", {}).catch(() => null),
    callScopedTool("list_project_tasks", { status: "open", limit: 300 }).catch(() => null),
    callScopedTool("inspect_project_links", {}).catch(() => null),
  ]);

  if (tagsRes && !tagsRes.isError) {
    const data = tagsRes.structuredContent || JSON.parse(tagsRes.content[0].text);
    const list = Array.isArray(data.tags) ? data.tags : [];
    setBadge(badgeTags, list.length);
  }
  if (tasksRes && !tasksRes.isError) {
    const data = tasksRes.structuredContent || JSON.parse(tasksRes.content[0].text);
    const count = typeof data.total === "number" ? data.total : (Array.isArray(data.tasks) ? data.tasks.length : 0);
    setBadge(badgeTasks, count);
  }
  if (linksRes && !linksRes.isError) {
    const data = linksRes.structuredContent || JSON.parse(linksRes.content[0].text);
    const brokenCount = Array.isArray(data.brokenLinks) ? data.brokenLinks.length : 0;
    const ambigCount = Array.isArray(data.ambiguousTargets) ? data.ambiguousTargets.length : 0;
    setBadge(badgeLinks, brokenCount + ambigCount);
  }
}

async function loadBacklinks(path) {
  backlinksPanel.hidden = true;
  while (backlinksList.firstChild) backlinksList.removeChild(backlinksList.firstChild);
  try {
    const result = await callScopedTool("get_backlinks", { path });
    if (result.isError) return;
    const data = result.structuredContent || JSON.parse(result.content[0].text);
    const items = Array.isArray(data.backlinks) ? data.backlinks : [];
    if (items.length === 0) return;

    backlinksCount.textContent = `${items.length} 处引用`;
    for (const item of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "backlink-item search-hit";

      const head = document.createElement("span");
      head.className = "file-name";
      head.textContent = `${item.path}:${item.line}`;
      btn.appendChild(head);

      const snip = document.createElement("span");
      snip.className = "hit-snippet";
      snip.textContent = item.snippet;
      btn.appendChild(snip);

      btn.addEventListener("click", () => {
        guardUnsavedAction(() => openProjectFile(item.path, { line: item.line }));
      });
      backlinksList.appendChild(btn);
    }
    backlinksPanel.hidden = false;
  } catch {
    // Backlinks are auxiliary; keep silent if unavailable.
  }
}

async function loadFiles() {
  if (!isVisible()) return;
  refreshBtn.disabled = true;
  showBanner("正在扫描项目中的 Markdown 文件…");
  try {
    const result = await callScopedTool("list_markdown_files", {});
    if (result.isError) {
      throw new Error(result.content?.[0]?.text || "列出文件失败");
    }
    const data = result.structuredContent || JSON.parse(result.content[0].text);
    const nextProject = typeof data.project === "string" && data.project ? data.project : "未知（请重新加载插件）";
    if (currentProjectName && currentProjectName !== nextProject && currentFilePath) {
      docViewer.hidden = true;
      docEmpty.hidden = false;
      currentFilePath = "";
      isDirty = false;
      conflictInfo = null;
      schedulePersistState();
    }
    currentProjectName = nextProject;
    discoveredWorkspaces = Array.isArray(data.workspaces) && data.workspaces.length > 0
      ? data.workspaces
      : [currentProjectName];
    projectNameEl.textContent = getActiveScope() === "all" && discoveredWorkspaces.length > 1
      ? `${currentProjectName} (+${discoveredWorkspaces.length - 1})`
      : currentProjectName;
    applyScopeUI();
    allFiles = Array.isArray(data.files) ? data.files : [];
    populateSearchDirScope();
    renderFileList();
    if (!docViewer.hidden) annotateWikilinks(docContent);
    showBanner(data.truncated ? "文件数量超过 500 条上限，仅显示前 500 个文件。" : "");
    refreshRailBadges();
    if (store.ui.railTab === "tags") loadTagsPanel();
    else if (store.ui.railTab === "tasks") loadTasksPanel();
    else if (store.ui.railTab === "links") loadLinksPanel();
    if (kanbanOpen) loadKanbanTasks();
    if (graphOpen) openGraphView(true);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg.includes("插件没有在运行") || msg.includes("没有可调用的服务") || msg.includes("-32003")) {
      showBanner("请先启动运行环境并打开一个项目，再点击「刷新」加载项目文件；也可先切换到「短文预览」直接使用。", false);
    } else {
      showBanner(`无法加载项目文件: ${msg}`, true);
    }
  } finally {
    refreshBtn.disabled = false;
  }
}

async function openProjectFile(path, options = {}) {
  const {
    anchorSlug = "",
    line = 0,
    query = "",
    caseSensitive = false,
    ignoreDraft = false,
    preserveView = false,
  } = options;
  if (!preserveView) {
    showBanner(`正在读取 ${path}…`);
  }
  try {
    const result = await callScopedTool("read_markdown_file", { path });
    if (result.isError) {
      throw new Error(result.content?.[0]?.text || "读取文件失败");
    }
    const data = result.structuredContent || {
      path,
      content: result.content?.[0]?.text || "",
      bytes: 0,
      truncated: false,
      readOnly: false,
      etag: "",
    };

    const prevPath = currentFilePath;
    currentFilePath = data.path || path;
    if (prevPath !== currentFilePath) {
      collapsedDocHeadings.clear();
    }
    savedFileContent = data.content || "";
    currentBaseEtag = data.etag || "";
    currentFileBytes = data.bytes || 0;
    currentFileTruncated = Boolean(data.truncated);
    currentFileReadOnly = Boolean(data.readOnly || data.truncated);
    if (conflictInfo && conflictInfo.path !== currentFilePath) {
      conflictInfo = null;
    }

    const savedDraft = !ignoreDraft && !currentFileReadOnly
      ? getDraft(store, currentProjectName, currentFilePath)
      : null;

    const activeContent = savedDraft ? savedDraft.content : savedFileContent;
    docPath.textContent = currentFilePath;
    docEditor.value = activeContent;

    if (savedDraft && savedDraft.baseEtag && currentBaseEtag && savedDraft.baseEtag !== currentBaseEtag) {
      conflictInfo = { path: currentFilePath, diskEtag: currentBaseEtag, diskBytes: currentFileBytes };
    } else if (ignoreDraft) {
      conflictInfo = null;
    }

    updateReadOnlyControls();
    updateDirtyState();
    if (savedDraft && !hasCurrentConflict()) {
      draftBanner.hidden = false;
      draftBannerText.textContent = "已恢复未保存的本地草稿（按项目与文件路径隔离）。";
    } else {
      draftBanner.hidden = true;
    }

    renderDocContent(activeContent);
    if (!preserveView || (!kanbanOpen && !graphOpen)) {
      graphOpen = false;
      kanbanOpen = false;
      if (graphWorkspace) graphWorkspace.hidden = true;
      if (kanbanWorkspace) kanbanWorkspace.hidden = true;
      docEmpty.hidden = true;
      docViewer.hidden = false;
      setSidebarOpen(store.ui.sidebarOpen);
      setOutlineOpen(store.ui.outlineOpen);
      syncRailActiveStates();
    }
    showBanner("");
    renderFileList();
    schedulePersistState();
    loadBacklinks(currentFilePath);

    if (!preserveView || (!kanbanOpen && !graphOpen)) {
      if (line > 0) {
        const targetBlock = locateSourceLine(docContent, line);
        if (targetBlock) {
          unfoldAncestorsOf(docContent, targetBlock, collapsedDocHeadings);
          targetBlock.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        if (query) {
          findBar.open(query, targetBlock, { caseSensitive });
        }
      } else if (anchorSlug) {
        const targetEl = document.getElementById(anchorSlug);
        if (targetEl) {
          unfoldAncestorsOf(docContent, targetEl, collapsedDocHeadings);
          targetEl.scrollIntoView({ behavior: "smooth" });
        }
      }
    }
  } catch (err) {
    showBanner(`读取失败: ${err.message}`, true);
  }
}

async function saveCurrentFile(force = false) {
  if (!currentFilePath || currentFileReadOnly) return false;
  if (!isDirty && !force) return true;

  saveBtn.disabled = true;
  try {
    const content = docEditor.value;
    const result = await callScopedTool("save_markdown_file", {
      path: currentFilePath,
      content,
      expectedEtag: currentBaseEtag || undefined,
      force,
    });
    if (result.isError) throw new Error(result.content?.[0]?.text || "保存失败");
    const data = result.structuredContent || {};

    if (data.conflict) {
      conflictInfo = {
        path: currentFilePath,
        diskEtag: data.diskEtag || "",
        diskBytes: data.diskBytes || 0,
      };
      setDraft(store, currentProjectName, currentFilePath, content, currentBaseEtag);
      schedulePersistState(true);
      updateDirtyState();
      openConflictDialog();
      return false;
    }

    savedFileContent = content;
    currentBaseEtag = data.etag || "";
    currentFileBytes = data.bytes || encoder.encode(content).length;
    currentFileTruncated = false;
    conflictInfo = null;
    deleteDraft(store, currentProjectName, currentFilePath);
    updateDirtyState();
    renderDocContent(content);
    renderFileList();
    schedulePersistState(true);
    showToast(`已安全保存 ${currentFilePath}`);
    await request("ui/notify", { level: "info", message: `已保存 ${currentFilePath}` }).catch(() => {});
    loadBacklinks(currentFilePath);
    refreshRailBadges();
    return true;
  } catch (err) {
    showBanner(`保存失败: ${err.message}`, true);
    return false;
  } finally {
    saveBtn.disabled = false;
  }
}

openConflictBtn.addEventListener("click", openConflictDialog);

conflictKeepBtn.addEventListener("click", () => {
  conflictModal.hidden = true;
  setDraft(store, currentProjectName, currentFilePath, docEditor.value, currentBaseEtag);
  schedulePersistState(true);
  updateDirtyState();
  showToast("已保留本地草稿，磁盘文件未被覆盖");
});

conflictReloadBtn.addEventListener("click", () => {
  conflictModal.hidden = true;
  conflictInfo = null;
  deleteDraft(store, currentProjectName, currentFilePath);
  openProjectFile(currentFilePath, { ignoreDraft: true });
  showToast("已重新加载磁盘最新版本");
});

conflictForceBtn.addEventListener("click", async () => {
  conflictModal.hidden = true;
  await saveCurrentFile(true);
});

restoreDiskBtn.addEventListener("click", () => {
  conflictInfo = null;
  deleteDraft(store, currentProjectName, currentFilePath);
  openProjectFile(currentFilePath, { ignoreDraft: true });
  showToast("已恢复磁盘版本");
});

function highlightQuickOpenItem(nextIndex) {
  if (quickOpenItems.length === 0) return;
  quickOpenIndex = ((nextIndex % quickOpenItems.length) + quickOpenItems.length) % quickOpenItems.length;
  quickOpenItems.forEach((btn, idx) => {
    const active = idx === quickOpenIndex;
    btn.classList.toggle("kbd-active", active);
    if (active) btn.scrollIntoView({ block: "nearest" });
  });
}

function renderQuickOpenList() {
  while (quickOpenList.firstChild) quickOpenList.removeChild(quickOpenList.firstChild);
  quickOpenItems = [];
  quickOpenIndex = 0;

  const q = (quickOpenInput.value || "").trim().toLowerCase();
  const matches = allFiles.filter((f) => !q || f.path.toLowerCase().includes(q)).slice(0, 40);
  if (matches.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = allFiles.length === 0 ? "当前项目暂无 Markdown 文档。" : "没有匹配的文档。";
    quickOpenList.appendChild(empty);
    return;
  }
  matches.forEach((item, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "file-item" + (idx === 0 ? " kbd-active" : "");
    const nameSpan = document.createElement("span");
    nameSpan.className = "file-name";
    if (hasDraftForFile(store, currentProjectName, item.path)) {
      const dot = document.createElement("span");
      dot.className = "file-item-status";
      nameSpan.appendChild(dot);
    }
    nameSpan.appendChild(document.createTextNode(item.bytes > MAX_READ_BYTES ? `🔒 ${item.path}` : item.path));
    const sizeSpan = document.createElement("span");
    sizeSpan.className = "file-size";
    sizeSpan.textContent = formatBytes(item.bytes);
    btn.append(nameSpan, sizeSpan);
    btn.addEventListener("click", () => {
      quickOpenModal.hidden = true;
      guardUnsavedAction(() => openProjectFile(item.path));
    });
    quickOpenList.appendChild(btn);
    quickOpenItems.push(btn);
  });
}

function openQuickOpen() {
  setTab("files");
  quickOpenInput.value = "";
  renderQuickOpenList();
  quickOpenModal.hidden = false;
  quickOpenInput.focus();
}

quickOpenInput.addEventListener("input", renderQuickOpenList);
quickOpenInput.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    highlightQuickOpenItem(quickOpenIndex + 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    highlightQuickOpenItem(quickOpenIndex - 1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    const chosen = quickOpenItems[quickOpenIndex];
    if (chosen) chosen.click();
  }
});

for (const [modal, onClose] of [
  [quickOpenModal, () => { quickOpenModal.hidden = true; }],
  [disambigModal, () => { disambigModal.hidden = true; }],
  [leaveModal, () => { leaveModal.hidden = true; pendingLeaveAction = null; }],
  [conflictModal, () => { conflictModal.hidden = true; }],
  [lightboxModal, closeLightbox],
]) {
  modal.addEventListener("click", (event) => {
    if (event.target === modal) onClose();
  });
}
lightboxCloseBtn.addEventListener("click", closeLightbox);

function wrapEditorSelection(before, after, placeholder) {
  if (currentFileReadOnly) return;
  const start = docEditor.selectionStart;
  const end = docEditor.selectionEnd;
  const value = docEditor.value;
  const selected = value.slice(start, end) || placeholder;
  const next = value.slice(0, start) + before + selected + after + value.slice(end);
  docEditor.value = next;
  docEditor.focus();
  docEditor.setSelectionRange(start + before.length, start + before.length + selected.length);
  updateDirtyState();
  scheduleDraftSave();
  renderDocContent(docEditor.value);
}

formatBar.addEventListener("click", (event) => {
  const btn = event.target.closest("button.fmt-btn");
  if (!btn) return;
  const fmt = btn.dataset.fmt;
  if (fmt === "bold") wrapEditorSelection("**", "**", "粗体");
  else if (fmt === "italic") wrapEditorSelection("*", "*", "斜体");
  else if (fmt === "code") wrapEditorSelection("`", "`", "code");
  else if (fmt === "link") wrapEditorSelection("[", "](https://)", "链接文字");
  else if (fmt === "wikilink") wrapEditorSelection("[[", "]]", "笔记名称");
  else if (fmt === "task") wrapEditorSelection("- [ ] ", "", "待办事项");
  else if (fmt === "callout") wrapEditorSelection("> [!note] 标题\n> ", "", "内容");
  else if (fmt === "img") wrapEditorSelection("![图片说明](assets/", ")", "diagram.svg");
  else if (fmt === "math") wrapEditorSelection("$$", "$$", "E = mc^2");
  else if (fmt === "mermaid") wrapEditorSelection("```mermaid\nflowchart LR\n    A[开始] --> B[结束]\n```\n", "", "");
});

async function handleInlineTaskToggle(line, checked, checkboxEl) {
  if (!currentFilePath || currentFileReadOnly) return;
  if (isDirty) {
    const lines = docEditor.value.split("\n");
    if (line >= 1 && line <= lines.length) {
      lines[line - 1] = lines[line - 1].replace(/^(\s*(?:[-*+]|\d{1,9}[.)])\s+\[)[ xX](\])/, `$1${checked ? "x" : " "}$2`);
      docEditor.value = lines.join("\n");
      updateDirtyState();
      scheduleDraftSave();
      renderDocContent(docEditor.value);
      showToast(`已同步更新草稿第 ${line} 行任务`);
    }
    return;
  }

  try {
    const result = await callScopedTool("toggle_markdown_task", {
      path: currentFilePath,
      line,
      checked,
      expectedEtag: currentBaseEtag,
    });
    if (result.isError) throw new Error(result.content?.[0]?.text || "更新任务失败");
    const data = result.structuredContent || JSON.parse(result.content[0].text);
    if (data.conflict) {
      if (checkboxEl) checkboxEl.checked = !checked;
      conflictInfo = {
        path: currentFilePath,
        diskEtag: data.diskEtag || "",
        diskBytes: data.diskBytes || 0,
      };
      updateStatusPills();
      openConflictDialog();
      return;
    }
    currentBaseEtag = data.etag || currentBaseEtag;
    const lines = savedFileContent.split("\n");
    if (line >= 1 && line <= lines.length) {
      lines[line - 1] = lines[line - 1].replace(/^(\s*(?:[-*+]|\d{1,9}[.)])\s+\[)[ xX](\])/, `$1${checked ? "x" : " "}$2`);
      savedFileContent = lines.join("\n");
      docEditor.value = savedFileContent;
    }
    showToast(`已安全回写第 ${line} 行任务`);
    refreshRailBadges();
    if (store.ui.railTab === "tasks") loadTasksPanel();
  } catch (err) {
    if (checkboxEl) checkboxEl.checked = !checked;
    showBanner(`更新任务失败: ${err.message}`, true);
  }
}

function renderTagFiles() {
  while (tagFilesList.firstChild) tagFilesList.removeChild(tagFilesList.firstChild);
  clearTagsBtn.hidden = selectedTags.size === 0;
  renderSearchTagBar();

  const matching = selectedTags.size === 0
    ? allFiles.map((f) => f.path)
    : (() => {
        const set = cachedTags
          .filter((t) => selectedTags.has(t.name))
          .reduce((acc, t) => {
            if (acc === null) return new Set(t.files);
            return new Set(t.files.filter((f) => acc.has(f)));
          }, null);
        return set ? [...set].sort() : [];
      })();

  const info = document.createElement("div");
  info.className = "count";
  info.textContent = selectedTags.size > 0
    ? `同时满足 ${[...selectedTags].map((t) => "#" + t).join(" + ")}：${matching.length} 篇`
    : `全部文档：${matching.length} 篇（可多选标签交集筛选）`;
  tagFilesList.appendChild(info);

  if (matching.length === 0) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "没有同时包含所选标签的文档。";
    tagFilesList.appendChild(p);
    return;
  }
  for (const path of matching) {
    const item = allFiles.find((f) => f.path === path) || { path, bytes: 0 };
    tagFilesList.appendChild(createFileItemButton(item, path));
  }
}

async function loadTagsPanel() {
  try {
    const result = await callScopedTool("list_project_tags", {});
    if (result.isError) throw new Error(result.content?.[0]?.text || "加载标签失败");
    const data = result.structuredContent || JSON.parse(result.content[0].text);
    cachedTags = Array.isArray(data.tags) ? data.tags : [];
    tagsSummary.textContent = `${cachedTags.length} 个标签`;
    setBadge(badgeTags, cachedTags.length);
    while (tagCloud.firstChild) tagCloud.removeChild(tagCloud.firstChild);

    for (const tag of cachedTags) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tag-chip";
      if (selectedTags.has(tag.name)) btn.classList.add("active");
      btn.textContent = `#${tag.name} (${tag.count})`;
      btn.addEventListener("click", () => {
        if (selectedTags.has(tag.name)) selectedTags.delete(tag.name);
        else selectedTags.add(tag.name);
        btn.classList.toggle("active", selectedTags.has(tag.name));
        renderTagFiles();
      });
      tagCloud.appendChild(btn);
    }
    renderTagFiles();
  } catch (err) {
    tagsSummary.textContent = "加载失败";
    showBanner(`加载标签失败: ${err.message}`, true);
  }
}

const PRIORITY_LABELS = { high: "高 P1", medium: "中 P2", low: "低 P3" };
const COLOR_LABELS = {
  red: "红色", orange: "橙色", amber: "琥珀", green: "绿色", blue: "蓝色", purple: "紫色", pink: "粉色",
};
const VALID_TASK_COLORS = new Set(["red", "orange", "amber", "green", "blue", "purple", "pink"]);

function parseTaskMetadataClient(rawText, checked = false) {
  let clean = String(rawText || "");
  let priority = "";
  let due = "";
  let assignee = "";
  let group = "";
  let color = "";
  let status = "";

  const prioMap = {
    p1: "high", p2: "medium", p3: "low",
    "⏫": "high", "🔼": "medium", "🔽": "low",
    "!高": "high", "!中": "medium", "!低": "low",
  };
  clean = clean.replace(/(?:^|\s)(P[123]|⏫|🔼|🔽|![高中低])(?=\s|$)/gi, (m, tok) => {
    if (!priority) priority = prioMap[tok.toLowerCase()] || prioMap[tok] || "";
    return " ";
  });
  clean = clean.replace(/(?:^|\s)(?:📅\s*|due:)(\d{4}-\d{2}-\d{2})(?=\s|$)/gi, (m, d) => {
    if (!due) due = d;
    return " ";
  });
  clean = clean.replace(/(?:^|\s)@([A-Za-z0-9_\u4e00-\u9fff][A-Za-z0-9_.\-\u4e00-\u9fff]{0,31})(?=\s|$)/g, (m, a) => {
    if (!assignee) assignee = a;
    return " ";
  });
  clean = clean.replace(/(?:^|\s)group:([^\s#]{1,32})(?=\s|$)/gi, (m, g) => {
    if (!group) group = g;
    return " ";
  });
  clean = clean.replace(/(?:^|\s)color:([a-zA-Z]{2,16})(?=\s|$)/gi, (m, c) => {
    const low = c.toLowerCase();
    if (!color && VALID_TASK_COLORS.has(low)) color = low;
    return " ";
  });
  clean = clean.replace(/(?:^|\s)status:(todo|doing|review|done)(?=\s|$)/gi, (m, st) => {
    if (!status) status = st.toLowerCase();
    return " ";
  });

  if (checked) {
    status = "done";
  } else if (status !== "doing" && status !== "review") {
    status = "todo";
  }

  clean = clean.replace(/\s{2,}/g, " ").trim();
  return { cleanText: clean || String(rawText || "").trim(), priority, due, assignee, group, color, status };
}

function formatTaskMetadataClient(rawText, { priority = "", due = "", assignee = "", group = "", color = "", status = "" }) {
  const base = parseTaskMetadataClient(rawText).cleanText;
  const parts = base ? [base] : [];
  if (priority === "high") parts.push("P1");
  else if (priority === "medium") parts.push("P2");
  else if (priority === "low") parts.push("P3");
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) parts.push(`📅 ${due}`);
  const cleanAssignee = String(assignee || "").trim().replace(/^@/, "");
  if (cleanAssignee) parts.push(`@${cleanAssignee.replace(/\s+/g, "_")}`);
  const cleanGroup = String(group || "").trim();
  if (cleanGroup) parts.push(`group:${cleanGroup.replace(/\s+/g, "_")}`);
  const cleanColor = String(color || "").trim().toLowerCase();
  if (VALID_TASK_COLORS.has(cleanColor)) parts.push(`color:${cleanColor}`);
  const cleanStatus = String(status || "").trim().toLowerCase();
  if (cleanStatus === "doing" || cleanStatus === "review") parts.push(`status:${cleanStatus}`);
  return parts.join(" ");
}

function enrichTaskItem(task) {
  const parsed = parseTaskMetadataClient(task?.text || "", Boolean(task?.checked));
  return {
    ...task,
    cleanText: typeof task?.cleanText === "string" && task.cleanText ? task.cleanText : parsed.cleanText,
    priority: task?.priority || parsed.priority,
    due: task?.due || parsed.due,
    assignee: task?.assignee || parsed.assignee,
    group: task?.group || parsed.group,
    color: task?.color || parsed.color,
    status: task?.checked ? "done" : (task?.status || parsed.status || "todo"),
  };
}

function getTodayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getEffectiveTaskColor(task) {
  if (task.color) return task.color;
  if (task.priority === "high") return "red";
  if (task.priority === "medium") return "amber";
  if (task.priority === "low") return "blue";
  return "";
}

function getDueCategory(due, today) {
  if (!due) return { key: "none", label: "无截止时间", cls: "" };
  if (due < today) return { key: "overdue", label: "已逾期", cls: "due-overdue" };
  if (due === today) return { key: "today", label: "今日到期", cls: "due-today" };
  return { key: "upcoming", label: "即将到期", cls: "" };
}

function openTaskMetaModal(task) {
  editingTask = task;
  editingTaskColor = task.color || "";
  taskMetaDesc.textContent = `${task.path}:${task.line} — ${task.cleanText || task.text}`;
  if (tmStatus) tmStatus.value = normalizeTaskStatus(task);
  tmPriority.value = task.priority || "";
  tmDue.value = task.due || "";
  tmAssignee.value = task.assignee || "";
  tmGroup.value = task.group || "";
  tmColorPicker.querySelectorAll(".color-dot").forEach((btn) => {
    btn.classList.toggle("active", (btn.dataset.color || "") === editingTaskColor);
  });
  taskMetaModal.hidden = false;
}

function renderSingleTaskRow(task, today) {
  const row = document.createElement("div");
  const effColor = getEffectiveTaskColor(task);
  row.className = "task-row" + (task.checked ? " done" : "") + (effColor ? ` task-color-${effColor}` : "");

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = Boolean(task.checked);
  cb.addEventListener("change", async () => {
    try {
      const res = await callScopedTool("toggle_markdown_task", {
        path: task.path,
        line: task.line,
        checked: cb.checked,
        expectedEtag: task.etag,
      });
      if (res.isError) throw new Error(res.content?.[0]?.text || "切换失败");
      const out = res.structuredContent || JSON.parse(res.content[0].text);
      if (out.conflict) {
        cb.checked = !cb.checked;
        showBanner(`${task.path} 已被外部修改，请刷新后再试。`, true);
        return;
      }
      task.etag = out.etag;
      task.checked = out.checked;
      showToast(`已安全回写 ${task.path}:${task.line}`);
      if (task.path === currentFilePath) {
        await openProjectFile(currentFilePath, { ignoreDraft: !isDirty, preserveView: true });
      }
      loadTasksPanel();
      if (kanbanOpen) loadKanbanTasks();
    } catch (err) {
      cb.checked = !cb.checked;
      showBanner(`更新待办失败: ${err.message}`, true);
    }
  });
  row.appendChild(cb);

  const body = document.createElement("div");
  body.className = "task-body";
  const textEl = document.createElement("div");
  textEl.className = "task-text" + (task.checked ? " done" : "");
  textEl.textContent = task.cleanText || task.text || "(空任务)";
  body.appendChild(textEl);

  const badges = document.createElement("div");
  badges.className = "task-badges";
  const st = normalizeTaskStatus(task);
  if ((st === "doing" || st === "review") && STATUS_META[st]) {
    const stChip = document.createElement("span");
    stChip.className = `task-chip ${STATUS_META[st].cls}`;
    stChip.textContent = `${STATUS_META[st].icon} ${STATUS_META[st].label}`;
    badges.appendChild(stChip);
  }
  if (task.priority && PRIORITY_LABELS[task.priority]) {
    const b = document.createElement("span");
    b.className = `task-chip prio-${task.priority}`;
    b.textContent = PRIORITY_LABELS[task.priority];
    badges.appendChild(b);
  }
  if (task.due) {
    const dueInfo = getDueCategory(task.due, today);
    const b = document.createElement("span");
    b.className = `task-chip ${dueInfo.cls}`;
    b.textContent = `📅 ${task.due}${dueInfo.key === "overdue" && !task.checked ? " (逾期)" : ""}`;
    badges.appendChild(b);
  }
  if (task.assignee) {
    const b = document.createElement("span");
    b.className = "task-chip assignee";
    b.textContent = `@${task.assignee}`;
    badges.appendChild(b);
  }
  if (task.group) {
    const b = document.createElement("span");
    b.className = "task-chip group";
    b.textContent = `📁 ${task.group}`;
    badges.appendChild(b);
  }
  if (badges.childNodes.length > 0) body.appendChild(badges);

  const metaEl = document.createElement("div");
  metaEl.className = "task-meta";
  metaEl.textContent = `${task.path}:${task.line}${task.heading ? " · " + task.heading : ""}`;
  body.appendChild(metaEl);

  body.addEventListener("click", () => {
    guardUnsavedAction(() => openProjectFile(task.path, { line: task.line }));
  });
  row.appendChild(body);

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "task-edit-btn";
  editBtn.textContent = "✎";
  editBtn.title = "编辑优先级、时间、分配人、分组与颜色";
  editBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    openTaskMetaModal(task);
  });
  row.appendChild(editBtn);

  return row;
}

async function loadTasksPanel() {
  try {
    const [filteredRes, allRes] = await Promise.all([
      callScopedTool("list_project_tasks", { status: taskFilterStatus, limit: 300 }),
      callScopedTool("list_project_tasks", { status: "all", limit: 300 }),
    ]);
    if (filteredRes.isError) throw new Error(filteredRes.content?.[0]?.text || "加载待办失败");
    const data = filteredRes.structuredContent || JSON.parse(filteredRes.content[0].text);
    const rawTasks = (Array.isArray(data.tasks) ? data.tasks : []).map(enrichTaskItem);

    let allTasks = rawTasks;
    if (allRes && !allRes.isError) {
      const allData = allRes.structuredContent || JSON.parse(allRes.content[0].text);
      allTasks = (Array.isArray(allData.tasks) ? allData.tasks : rawTasks).map(enrichTaskItem);
    }
    const openTotal = allTasks.filter((t) => !t.checked).length;
    setBadge(badgeTasks, openTotal);
    tasksSummary.textContent = `${openTotal} 待办 / ${allTasks.length} 总计`;

    // Populate assignee dropdown from all tasks
    const assignees = [...new Set(allTasks.map((t) => t.assignee).filter(Boolean))].sort();
    const prevAssignee = taskFilterAssignee;
    while (taskFilterAssigneeSel.firstChild) taskFilterAssigneeSel.removeChild(taskFilterAssigneeSel.firstChild);
    const optAll = document.createElement("option");
    optAll.value = "";
    optAll.textContent = "全部分配人";
    taskFilterAssigneeSel.appendChild(optAll);
    for (const a of assignees) {
      const opt = document.createElement("option");
      opt.value = a;
      opt.textContent = `@${a}`;
      taskFilterAssigneeSel.appendChild(opt);
    }
    taskFilterAssigneeSel.value = assignees.includes(prevAssignee) ? prevAssignee : "";
    taskFilterAssignee = taskFilterAssigneeSel.value;

    const tasks = rawTasks.filter((t) => {
      if (taskFilterPriority && t.priority !== taskFilterPriority) return false;
      if (taskFilterAssignee && t.assignee !== taskFilterAssignee) return false;
      if (taskFilterColor && getEffectiveTaskColor(t) !== taskFilterColor) return false;
      return true;
    });

    while (tasksList.firstChild) tasksList.removeChild(tasksList.firstChild);

    if (tasks.length === 0) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "没有匹配当前筛选条件的待办事项。";
      tasksList.appendChild(p);
      return;
    }

    const today = getTodayIso();
    const groupBy = store.ui.taskGroupBy || "none";
    if (groupBy === "none") {
      for (const task of tasks) {
        tasksList.appendChild(renderSingleTaskRow(task, today));
      }
      return;
    }

    const groups = new Map();
    const groupKeyOf = (t) => {
      if (groupBy === "status") {
        const st = normalizeTaskStatus(t);
        return STATUS_META[st] ? `${STATUS_META[st].icon} ${STATUS_META[st].label}` : "○ 待开始";
      }
      if (groupBy === "file") return t.path;
      if (groupBy === "priority") return PRIORITY_LABELS[t.priority] || "未设优先级";
      if (groupBy === "assignee") return t.assignee ? `@${t.assignee}` : "未分配";
      if (groupBy === "due") return getDueCategory(t.due, today).label;
      if (groupBy === "group") return t.group || "未分组";
      if (groupBy === "color") {
        const c = getEffectiveTaskColor(t);
        return c ? (COLOR_LABELS[c] || c) : "默认色";
      }
      return "其他";
    };
    for (const task of tasks) {
      const key = groupKeyOf(task);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(task);
    }

    const statusOrder = ["○ 待开始", "◐ 进行中", "◈ 待验收", "✓ 已完成"];
    const prioOrder = ["高 P1", "中 P2", "低 P3", "未设优先级"];
    const dueOrder = ["已逾期", "今日到期", "即将到期", "无截止时间"];
    const orderedKeys = [...groups.keys()].sort((a, b) => {
      if (groupBy === "status") return statusOrder.indexOf(a) - statusOrder.indexOf(b);
      if (groupBy === "priority") return prioOrder.indexOf(a) - prioOrder.indexOf(b);
      if (groupBy === "due") return dueOrder.indexOf(a) - dueOrder.indexOf(b);
      return a.localeCompare(b);
    });

    for (const key of orderedKeys) {
      const items = groups.get(key);
      const sec = document.createElement("div");
      sec.className = "task-group-section";
      const header = document.createElement("div");
      header.className = "task-group-header";
      const title = document.createElement("span");
      title.textContent = key;
      const cnt = document.createElement("span");
      cnt.className = "count";
      cnt.textContent = String(items.length);
      header.append(title, cnt);
      sec.appendChild(header);
      for (const task of items) {
        sec.appendChild(renderSingleTaskRow(task, today));
      }
      tasksList.appendChild(sec);
    }
  } catch (err) {
    tasksSummary.textContent = "加载失败";
    showBanner(`加载待办失败: ${err.message}`, true);
  }
}

async function loadLinksPanel() {
  try {
    const result = await callScopedTool("inspect_project_links", {});
    if (result.isError) throw new Error(result.content?.[0]?.text || "巡检失败");
    const data = result.structuredContent || JSON.parse(result.content[0].text);
    const broken = Array.isArray(data.brokenLinks) ? data.brokenLinks : [];
    const ambig = Array.isArray(data.ambiguousTargets) ? data.ambiguousTargets : [];
    linksSummary.textContent = `${broken.length} 断链 · ${ambig.length} 重名`;
    setBadge(badgeLinks, broken.length + ambig.length);
    while (linksList.firstChild) linksList.removeChild(linksList.firstChild);

    if (broken.length === 0 && ambig.length === 0) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "未发现失效链接或重名双链。";
      linksList.appendChild(p);
      return;
    }

    if (broken.length > 0) {
      const h1 = document.createElement("div");
      h1.className = "links-section-title";
      h1.textContent = `失效链接 (${broken.length})`;
      linksList.appendChild(h1);

      for (const item of broken) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "file-item search-hit";
        const head = document.createElement("span");
        head.className = "file-name broken-label";
        head.textContent = item.kind === "wikilink" ? `[[${item.rawTarget}]]` : item.rawTarget;
        btn.appendChild(head);
        const snip = document.createElement("span");
        snip.className = "hit-snippet";
        snip.textContent = `来源：${item.sourcePath}:${item.line}`;
        btn.appendChild(snip);
        btn.addEventListener("click", () => {
          guardUnsavedAction(() => openProjectFile(item.sourcePath, { line: item.line, query: item.rawTarget }));
        });
        linksList.appendChild(btn);
      }
    }

    if (ambig.length > 0) {
      const h2 = document.createElement("div");
      h2.className = "links-section-title";
      h2.textContent = `同名多匹配双链 (${ambig.length})`;
      linksList.appendChild(h2);

      for (const group of ambig) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "file-item search-hit";
        const t = document.createElement("span");
        t.className = "file-name";
        t.textContent = `[[${group.key}]] (${group.candidates.length} 个候选)`;
        btn.appendChild(t);
        const m = document.createElement("span");
        m.className = "hit-snippet";
        m.textContent = group.candidates.join(" · ");
        btn.appendChild(m);
        btn.addEventListener("click", () => openDisambigModal(group.key, group.candidates, ""));
        linksList.appendChild(btn);
      }
    }
  } catch (err) {
    linksSummary.textContent = "巡检失败";
    showBanner(`链接巡检失败: ${err.message}`, true);
  }
}

function updateSnippetPreview() {
  const text = snippetInput.value || "";
  const byteLen = encoder.encode(text).length;
  snippetBytes.textContent = `${formatBytes(byteLen)} / 24 KiB`;
  snippetBytes.parentElement.classList.toggle("over", byteLen > MAX_SNIPPET_BYTES);
  renderMarkdown(text, snippetPreview, {
    onCopy: (code) => {
      copyText(code, "已复制代码块");
      showToast("已复制代码块");
    },
  });
  recomputeHeadingFolding(snippetPreview, collapsedSnippetHeadings);
  schedulePersistState();
}

tabFiles.addEventListener("click", () => {
  if (kanbanOpen) closeKanbanView();
  if (graphOpen) closeGraphView();
  setTab("files");
});
if (tabKanban) tabKanban.addEventListener("click", () => openKanbanView());
if (tabGraph) tabGraph.addEventListener("click", () => openGraphView(true));
tabSnippet.addEventListener("click", () => setTab("snippet"));
quickOpenBtn.addEventListener("click", openQuickOpen);
emptyQuickOpenBtn.addEventListener("click", openQuickOpen);
emptySearchBtn.addEventListener("click", () => {
  setRailTab("search", true);
  fulltextInput.focus();
  schedulePersistState();
});
if (printBtn) printBtn.addEventListener("click", () => window.print());
refreshBtn.addEventListener("click", () => loadFiles());

function activateDrawerRail(tab, onOpen) {
  if (store.ui.railTab === tab && store.ui.sidebarOpen) {
    setSidebarOpen(false);
  } else {
    setRailTab(tab, true);
    if (typeof onOpen === "function") onOpen();
  }
  schedulePersistState();
}

railBtnTree.addEventListener("click", () => {
  activateDrawerRail("tree");
});

railBtnSearch.addEventListener("click", () => {
  activateDrawerRail("search", () => {
    renderSearchTagBar();
    fulltextInput.focus();
  });
});

railBtnTags.addEventListener("click", () => {
  activateDrawerRail("tags", () => loadTagsPanel());
});

railBtnTasks.addEventListener("click", () => {
  activateDrawerRail("tasks", () => loadTasksPanel());
});

railBtnLinks.addEventListener("click", () => {
  activateDrawerRail("links", () => loadLinksPanel());
});

clearTagsBtn.addEventListener("click", () => {
  selectedTags.clear();
  tagCloud.querySelectorAll("button.tag-chip").forEach((b) => b.classList.remove("active"));
  renderTagFiles();
});

for (const [btn, status] of [
  [taskFilterOpen, "open"],
  [taskFilterAll, "all"],
  [taskFilterDone, "done"],
]) {
  btn.addEventListener("click", () => {
    taskFilterStatus = status;
    taskFilterOpen.classList.toggle("active", status === "open");
    taskFilterAll.classList.toggle("active", status === "all");
    taskFilterDone.classList.toggle("active", status === "done");
    loadTasksPanel();
  });
}

scanLinksBtn.addEventListener("click", () => loadLinksPanel());
disambigCancelBtn.addEventListener("click", () => {
  disambigModal.hidden = true;
});

fileFilter.addEventListener("input", () => renderFileList());
fulltextInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = fulltextInput.value.trim();
  if (!q) {
    runFulltextSearch("");
    return;
  }
  searchTimer = setTimeout(() => runFulltextSearch(q), 280);
});
fulltextInput.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" && searchHitButtons.length > 0) {
    event.preventDefault();
    setSearchActiveIndex(searchActiveIdx + 1);
  } else if (event.key === "ArrowUp" && searchHitButtons.length > 0) {
    event.preventDefault();
    setSearchActiveIndex(searchActiveIdx <= 0 ? searchHitButtons.length - 1 : searchActiveIdx - 1);
  } else if (event.key === "Enter") {
    if (searchActiveIdx >= 0 && searchHitButtons[searchActiveIdx]) {
      event.preventDefault();
      searchHitButtons[searchActiveIdx].click();
      return;
    }
    clearTimeout(searchTimer);
    runFulltextSearch(undefined, { saveHistory: true });
  }
});
fulltextBtn.addEventListener("click", () => {
  clearTimeout(searchTimer);
  runFulltextSearch(undefined, { saveHistory: true });
});
if (searchOptCase) searchOptCase.addEventListener("click", () => {
  searchCaseSensitive = !searchCaseSensitive;
  searchOptCase.classList.toggle("active", searchCaseSensitive);
  if (fulltextInput.value.trim()) runFulltextSearch();
});
if (searchOptWord) searchOptWord.addEventListener("click", () => {
  searchWholeWord = !searchWholeWord;
  searchOptWord.classList.toggle("active", searchWholeWord);
  if (fulltextInput.value.trim()) runFulltextSearch();
});
if (searchOptRegex) searchOptRegex.addEventListener("click", () => {
  searchRegex = !searchRegex;
  searchOptRegex.classList.toggle("active", searchRegex);
  if (fulltextInput.value.trim()) runFulltextSearch();
});
if (searchOptCtx) searchOptCtx.addEventListener("click", () => {
  const sp = getSearchPrefs();
  sp.context = !sp.context;
  searchOptCtx.classList.toggle("active", sp.context);
  schedulePersistState();
  if (fulltextInput.value.trim()) runFulltextSearch();
});
if (searchGroupToggle) searchGroupToggle.addEventListener("click", () => {
  const sp = getSearchPrefs();
  sp.grouped = !sp.grouped;
  syncSearchControlsFromStore();
  schedulePersistState();
  if (lastSearchData) renderSearchResults(lastSearchData, lastSearchQuery);
});
if (searchCollapseBtn) searchCollapseBtn.addEventListener("click", () => {
  if (!lastSearchData || !Array.isArray(lastSearchData.files)) return;
  const allCollapsed = lastSearchData.files.every((f) => searchCollapsedFiles.has(f.path));
  if (allCollapsed) searchCollapsedFiles.clear();
  else lastSearchData.files.forEach((f) => searchCollapsedFiles.add(f.path));
  renderSearchResults(lastSearchData, lastSearchQuery);
});
if (searchScopeDir) searchScopeDir.addEventListener("change", () => {
  searchPathPrefix = searchScopeDir.value;
  if (fulltextInput.value.trim()) runFulltextSearch();
});
if (searchSortBy) searchSortBy.addEventListener("change", () => {
  getSearchPrefs().sortBy = searchSortBy.value;
  schedulePersistState();
  if (fulltextInput.value.trim()) runFulltextSearch();
});

viewTreeBtn.addEventListener("click", () => {
  store.ui.treeMode = !store.ui.treeMode;
  renderFileList();
  schedulePersistState();
});
toggleAllBtn.addEventListener("click", () => {
  const proj = getProjectState(store, currentProjectName);
  const set = new Set(proj.collapsedDirs || []);
  const allCollapsed = knownDirs.size > 0 && [...knownDirs].every((d) => set.has(d));
  proj.collapsedDirs = allCollapsed ? [] : [...knownDirs];
  renderFileList();
  schedulePersistState();
});

toggleTreeBtn.addEventListener("click", () => {
  setSidebarOpen(!store.ui.sidebarOpen);
  schedulePersistState();
});

backBtn.addEventListener("click", () => {
  guardUnsavedAction(() => {
    docViewer.hidden = true;
    docEmpty.hidden = false;
    setSidebarOpen(true);
    currentFilePath = "";
    isDirty = false;
    conflictInfo = null;
    findBar.close();
    renderFileList();
    schedulePersistState(true);
  });
});

modeReadBtn.addEventListener("click", () => {
  setDocMode("read");
  schedulePersistState();
});
modeSplitBtn.addEventListener("click", () => {
  setDocMode("split");
  schedulePersistState();
});
modeEditBtn.addEventListener("click", () => {
  setDocMode("edit");
  schedulePersistState();
});
findBtn.addEventListener("click", () => {
  if (findBar.isOpen()) findBar.close();
  else findBar.open();
});
outlineBtn.addEventListener("click", () => {
  setOutlineOpen(!store.ui.outlineOpen);
  schedulePersistState();
});
if (outlineFoldAllBtn) {
  outlineFoldAllBtn.addEventListener("click", () => {
    if (collapsedDocHeadings.size > 0) {
      collapsedDocHeadings.clear();
    } else {
      for (const h of currentHeadings) {
        if (h.level >= 2 && h.key) collapsedDocHeadings.add(h.key);
      }
      if (collapsedDocHeadings.size === 0) {
        for (const h of currentHeadings) {
          if (h.key) collapsedDocHeadings.add(h.key);
        }
      }
    }
    recomputeHeadingFolding(docContent, collapsedDocHeadings);
    renderOutline(currentHeadings);
  });
}
saveBtn.addEventListener("click", () => saveCurrentFile());
docEditor.addEventListener("input", () => {
  updateDirtyState();
  scheduleDraftSave();
  renderDocContent(docEditor.value);
});
copySourceBtn.addEventListener("click", () => {
  if (docEditor.value) {
    copyText(docEditor.value, "已复制 Markdown 原文");
    showToast("已复制 Markdown 源码");
  }
});
snippetInput.addEventListener("input", () => updateSnippetPreview());
snippetCopyBtn.addEventListener("click", () => {
  if (snippetInput.value) {
    copyText(snippetInput.value, "已复制短文 Markdown 原文");
    showToast("已复制短文源码");
  }
});

previewPane.addEventListener("scroll", () => {
  if (scrollSpyRaf) return;
  scrollSpyRaf = requestAnimationFrame(() => {
    scrollSpyRaf = 0;
    updateActiveOutlineItem();
  });
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
    event.preventDefault();
    openQuickOpen();
  } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    if (!docViewer.hidden && !currentFileReadOnly && isDirty) {
      event.preventDefault();
      saveCurrentFile();
    }
  } else if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "f") {
    event.preventDefault();
    setTab("files");
    setRailTab("search", true);
    renderSearchTagBar();
    renderSearchHistory();
    if (!lastSearchData) renderSearchResults(null, "");
    fulltextInput.focus();
    fulltextInput.select();
  } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
    if (!docViewer.hidden) {
      event.preventDefault();
      findBar.open();
    }
  } else if (event.key === "Escape") {
    if (!lightboxModal.hidden) {
      closeLightbox();
    } else if (newTaskModal && !newTaskModal.hidden) {
      newTaskModal.hidden = true;
    } else if (taskMetaModal && !taskMetaModal.hidden) {
      taskMetaModal.hidden = true;
      editingTask = null;
    } else if (!disambigModal.hidden) {
      disambigModal.hidden = true;
    } else if (!quickOpenModal.hidden) {
      quickOpenModal.hidden = true;
    } else if (!leaveModal.hidden) {
      leaveModal.hidden = true;
      pendingLeaveAction = null;
    } else if (!conflictModal.hidden) {
      conflictModal.hidden = true;
    } else if (findBar.isOpen()) {
      findBar.close();
    }
  }
});

attachHorizontalResizer(resizerSidebar, {
  onDrag: (e) => {
    const railRect = panelFiles.getBoundingClientRect();
    const width = Math.max(180, Math.min(560, Math.round(e.clientX - railRect.left - 48)));
    store.ui.sidebarWidth = width;
    applyLayoutSizes();
  },
  onReset: () => {
    store.ui.sidebarWidth = 276;
  },
});

attachHorizontalResizer(resizerSplit, {
  onDrag: (e) => {
    const rect = workspacePanes.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = Math.max(20, Math.min(80, Math.round(((e.clientX - rect.left) / rect.width) * 100)));
    store.ui.splitRatio = pct;
    applyLayoutSizes();
  },
  onReset: () => {
    store.ui.splitRatio = 50;
  },
});

attachHorizontalResizer(resizerOutline, {
  onDrag: (e) => {
    const rect = docWorkspace.getBoundingClientRect();
    const width = Math.max(150, Math.min(420, Math.round(rect.right - e.clientX)));
    store.ui.outlineWidth = width;
    applyLayoutSizes();
  },
  onReset: () => {
    store.ui.outlineWidth = 210;
  },
});

attachHorizontalResizer(resizerSnippet, {
  onDrag: (e) => {
    const rect = panelSnippet.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = Math.max(20, Math.min(80, Math.round(((e.clientX - rect.left) / rect.width) * 100)));
    store.ui.snippetRatio = pct;
    applyLayoutSizes();
  },
  onReset: () => {
    store.ui.snippetRatio = 50;
  },
});

/* ==========================================================================
   Split-Mode Bidirectional Hover Highlight & Auto-Scroll Sync
   ========================================================================== */
function getEditorMetrics() {
  const cs = window.getComputedStyle(docEditor);
  const fontSize = Number.parseFloat(cs.fontSize) || 12.5;
  const lineHeight = Number.parseFloat(cs.lineHeight) || fontSize * 1.55;
  const padTop = Number.parseFloat(cs.paddingTop) || 8;
  const padLeft = Number.parseFloat(cs.paddingLeft) || 10;
  const padRight = Number.parseFloat(cs.paddingRight) || 10;
  const innerW = Math.max(120, docEditor.clientWidth - padLeft - padRight);
  const charW = fontSize * 0.62;
  const charsPerLine = Math.max(16, Math.floor(innerW / charW));
  return { lineHeight, padTop, charsPerLine };
}

function visualRowsForLine(lineText, charsPerLine) {
  let units = 0;
  for (const ch of lineText) {
    units += /[\u2e80-\uffff]/.test(ch) ? 1.85 : 1;
  }
  return Math.max(1, Math.ceil(units / charsPerLine));
}

function getLineVisualBounds(lines, targetStart, targetEnd, metrics) {
  let rowCursor = 0;
  let startRow = 0;
  let endRow = 1;
  const clampedStart = Math.max(1, Math.min(lines.length, targetStart));
  const clampedEnd = Math.max(clampedStart, Math.min(lines.length, targetEnd));
  for (let i = 0; i < lines.length; i++) {
    const rows = visualRowsForLine(lines[i], metrics.charsPerLine);
    const lineNo = i + 1;
    if (lineNo === clampedStart) startRow = rowCursor;
    rowCursor += rows;
    if (lineNo === clampedEnd) {
      endRow = rowCursor;
      break;
    }
  }
  return {
    top: metrics.padTop + startRow * metrics.lineHeight,
    height: Math.max(metrics.lineHeight, (endRow - startRow) * metrics.lineHeight),
  };
}

function lineFromEditorClientY(clientY) {
  const rect = docEditor.getBoundingClientRect();
  const metrics = getEditorMetrics();
  const y = clientY - rect.top + docEditor.scrollTop - metrics.padTop;
  const targetRow = Math.max(0, Math.floor(y / metrics.lineHeight));
  const lines = docEditor.value.split("\n");
  let rowCursor = 0;
  for (let i = 0; i < lines.length; i++) {
    rowCursor += visualRowsForLine(lines[i], metrics.charsPerLine);
    if (targetRow < rowCursor) return i + 1;
  }
  return lines.length;
}

function positionEditorHighlight() {
  if (!editorLineHighlight || !activeSyncEditorRange || store.ui.docMode !== "split") {
    if (editorLineHighlight) editorLineHighlight.hidden = true;
    return;
  }
  const metrics = getEditorMetrics();
  const lines = docEditor.value.split("\n");
  const bounds = getLineVisualBounds(lines, activeSyncEditorRange.startLine, activeSyncEditorRange.endLine, metrics);
  const visibleTop = bounds.top - docEditor.scrollTop;
  editorLineHighlight.style.top = `${Math.round(visibleTop)}px`;
  editorLineHighlight.style.height = `${Math.round(bounds.height)}px`;
  editorLineHighlight.hidden = false;
}

function scrollEditorToLines(startLine, endLine) {
  const metrics = getEditorMetrics();
  const lines = docEditor.value.split("\n");
  const bounds = getLineVisualBounds(lines, startLine, endLine, metrics);
  const viewTop = docEditor.scrollTop;
  const viewBottom = viewTop + docEditor.clientHeight;
  if (bounds.top < viewTop + 36 || bounds.top + bounds.height > viewBottom - 36) {
    const desired = Math.max(0, bounds.top - (docEditor.clientHeight - bounds.height) / 2);
    docEditor.scrollTo({ top: desired, behavior: "smooth" });
  }
}

function findPreviewBlockForLine(line) {
  const candidates = [...docContent.querySelectorAll("[data-source-line]")];
  let best = null;
  let bestSpan = Infinity;
  let nearest = null;
  let nearestDist = Infinity;
  for (const node of candidates) {
    const start = Number.parseInt(node.dataset.sourceLine, 10);
    const end = Number.parseInt(node.dataset.sourceEndLine || node.dataset.sourceLine, 10);
    if (Number.isNaN(start)) continue;
    if (line >= start && line <= end) {
      const span = end - start;
      if (span <= bestSpan) {
        best = node;
        bestSpan = span;
      }
    }
    const dist = Math.abs(start - line);
    if (dist < nearestDist) {
      nearest = node;
      nearestDist = dist;
    }
  }
  return best || nearest;
}

function setSyncPreviewHighlight(elNode, autoScroll) {
  if (activeSyncPreviewEl && activeSyncPreviewEl !== elNode) {
    activeSyncPreviewEl.classList.remove("md-sync-hover");
  }
  activeSyncPreviewEl = elNode || null;
  if (!activeSyncPreviewEl) return;
  unfoldAncestorsOf(docContent, activeSyncPreviewEl, collapsedDocHeadings);
  activeSyncPreviewEl.classList.add("md-sync-hover");
  if (autoScroll) {
    const pRect = previewPane.getBoundingClientRect();
    const eRect = activeSyncPreviewEl.getBoundingClientRect();
    if (eRect.top < pRect.top + 32 || eRect.bottom > pRect.bottom - 32) {
      activeSyncPreviewEl.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
}

function clearSplitHoverSync() {
  if (activeSyncPreviewEl) {
    activeSyncPreviewEl.classList.remove("md-sync-hover");
    activeSyncPreviewEl = null;
  }
  activeSyncEditorRange = null;
  if (editorLineHighlight) editorLineHighlight.hidden = true;
}

docContent.addEventListener("mousemove", (event) => {
  if (store.ui.docMode !== "split" || document.body.classList.contains("is-resizing")) return;
  const block = event.target.closest("[data-source-line]");
  if (!block || block === activeSyncPreviewEl) return;
  const startLine = Number.parseInt(block.dataset.sourceLine, 10);
  const endLine = Number.parseInt(block.dataset.sourceEndLine || block.dataset.sourceLine, 10);
  if (Number.isNaN(startLine)) return;

  setSyncPreviewHighlight(block, false);
  activeSyncEditorRange = { startLine, endLine };
  clearTimeout(hoverSyncTimer);
  hoverSyncTimer = setTimeout(() => {
    scrollEditorToLines(startLine, endLine);
    positionEditorHighlight();
  }, 55);
  positionEditorHighlight();
});

docEditor.addEventListener("mousemove", (event) => {
  if (store.ui.docMode !== "split" || event.buttons !== 0 || document.body.classList.contains("is-resizing")) return;
  const line = lineFromEditorClientY(event.clientY);
  if (activeSyncEditorRange && activeSyncEditorRange.startLine === line && activeSyncEditorRange.endLine === line) {
    return;
  }
  activeSyncEditorRange = { startLine: line, endLine: line };
  positionEditorHighlight();
  clearTimeout(hoverSyncTimer);
  hoverSyncTimer = setTimeout(() => {
    const targetBlock = findPreviewBlockForLine(line);
    if (targetBlock) setSyncPreviewHighlight(targetBlock, true);
  }, 60);
});

docEditor.addEventListener("scroll", positionEditorHighlight);
workspacePanes.addEventListener("mouseleave", () => {
  clearTimeout(hoverSyncTimer);
  clearSplitHoverSync();
});

// Theme Switcher Events
if (themeLightBtn) themeLightBtn.addEventListener("click", () => { applyThemeModeUI("light"); schedulePersistState(true); });
if (themeDarkBtn) themeDarkBtn.addEventListener("click", () => { applyThemeModeUI("dark"); schedulePersistState(true); });
if (themeSystemBtn) themeSystemBtn.addEventListener("click", () => { applyThemeModeUI("system"); schedulePersistState(true); });

// Graph View Events
if (railBtnGraph) railBtnGraph.addEventListener("click", () => {
  if (graphOpen) {
    closeGraphView();
  } else {
    openGraphView(true);
  }
});
if (emptyGraphBtn) emptyGraphBtn.addEventListener("click", () => openGraphView(true));
if (graphCloseBtn) graphCloseBtn.addEventListener("click", closeGraphView);
if (graphScopeGlobalBtn) graphScopeGlobalBtn.addEventListener("click", () => {
  graphScope = "global";
  graphScopeGlobalBtn.classList.add("active");
  graphScopeLocalBtn.classList.remove("active");
  renderGraphFromCache();
});
if (graphScopeLocalBtn) graphScopeLocalBtn.addEventListener("click", () => {
  graphScope = "local";
  graphScopeLocalBtn.classList.add("active");
  graphScopeGlobalBtn.classList.remove("active");
  renderGraphFromCache();
});
if (graphLayoutSel) graphLayoutSel.addEventListener("change", () => {
  const gs = getGraphSettings();
  gs.layout = graphLayoutSel.value;
  schedulePersistState();
  if (graphHandle && typeof graphHandle.setLayout === "function") {
    graphHandle.setLayout(gs.layout, {
      repel: gs.repel,
      linkDist: gs.linkDist,
      gravity: gs.gravity,
    });
  } else {
    renderGraphFromCache();
  }
});
if (graphColorSel) graphColorSel.addEventListener("change", () => {
  const gs = getGraphSettings();
  gs.colorBy = graphColorSel.value;
  graphHighlightGroup = null;
  schedulePersistState();
  if (graphHandle && typeof graphHandle.setColorBy === "function") {
    const newLegend = graphHandle.setColorBy(gs.colorBy);
    renderGraphLegend(newLegend);
  } else {
    renderGraphFromCache();
  }
});
if (graphFilterInput) {
  graphFilterInput.addEventListener("input", renderGraphFromCache);
  graphFilterInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && cachedGraphData && graphHandle) {
      const q = graphFilterInput.value.trim().toLowerCase();
      if (!q) return;
      const match = (cachedGraphData.nodes || []).find((n) =>
        n.label.toLowerCase().includes(q)
        || n.id.toLowerCase().includes(q)
        || (n.tags || []).some((t) => t.toLowerCase().includes(q))
      );
      if (match) graphHandle.focusNode(match.id);
    }
  });
}
if (graphSettingsBtn && graphSettingsPanel) {
  graphSettingsBtn.addEventListener("click", () => {
    const nextOpen = graphSettingsPanel.hidden;
    graphSettingsPanel.hidden = !nextOpen;
    graphSettingsBtn.classList.toggle("active", nextOpen);
  });
}
if (graphResetSettingsBtn) {
  graphResetSettingsBtn.addEventListener("click", () => {
    store.ui.graph = createInitialGraphSettings();
    syncGraphControlsFromStore();
    schedulePersistState();
    renderGraphFromCache();
    showToast("已恢复默认图谱参数");
  });
}
const bindGraphCheckbox = (cb, key) => {
  if (!cb) return;
  cb.addEventListener("change", () => {
    getGraphSettings()[key] = Boolean(cb.checked);
    schedulePersistState();
    renderGraphFromCache();
  });
};
bindGraphCheckbox(graphShowOrphansCb, "showOrphans");
bindGraphCheckbox(graphShowGhostsCb, "showGhosts");
bindGraphCheckbox(graphShowTagsCb, "showTags");
bindGraphCheckbox(graphShowArrowsCb, "showArrows");
bindGraphCheckbox(graphSmartLabelsCb, "smartLabels");
bindGraphCheckbox(graphAnimatePhysicsCb, "animatePhysics");

if (graphLocalDepthSel) graphLocalDepthSel.addEventListener("change", () => {
  getGraphSettings().localDepth = Number(graphLocalDepthSel.value) || 1;
  schedulePersistState();
  if (graphScope === "local") renderGraphFromCache();
});
if (graphLinkDirSel) graphLinkDirSel.addEventListener("change", () => {
  getGraphSettings().linkDirection = graphLinkDirSel.value;
  schedulePersistState();
  if (graphScope === "local") renderGraphFromCache();
});

let graphSliderTimer = null;
const bindGraphSlider = (input, valEl, key, suffix = "") => {
  if (!input) return;
  input.addEventListener("input", () => {
    const v = Number(input.value);
    if (valEl) valEl.textContent = `${v}${suffix}`;
    getGraphSettings()[key] = v;
    clearTimeout(graphSliderTimer);
    graphSliderTimer = setTimeout(() => {
      schedulePersistState();
      renderGraphFromCache();
    }, 90);
  });
};
bindGraphSlider(graphRepelInput, graphRepelVal, "repel");
bindGraphSlider(graphLinkDistInput, graphLinkDistVal, "linkDist");
bindGraphSlider(graphGravityInput, graphGravityVal, "gravity");
bindGraphSlider(graphNodeScaleInput, graphNodeScaleVal, "nodeScale", "%");

if (graphZoomOutBtn) graphZoomOutBtn.addEventListener("click", () => { if (graphHandle) graphHandle.zoomBy(0.84); });
if (graphZoomInBtn) graphZoomInBtn.addEventListener("click", () => { if (graphHandle) graphHandle.zoomBy(1.18); });
if (graphFitBtn) graphFitBtn.addEventListener("click", () => { if (graphHandle) graphHandle.fit(); });
if (graphRefreshBtn) graphRefreshBtn.addEventListener("click", () => openGraphView(true));
if (graphExportSvgBtn) graphExportSvgBtn.addEventListener("click", () => {
  if (!graphHandle) return;
  const svgXml = graphHandle.serializeSvg();
  if (!svgXml) {
    showBanner("当前环境无法导出 SVG。", true);
    return;
  }
  const blob = new Blob([svgXml], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(currentProjectName || "markdown").replace(/[^A-Za-z0-9_-]/g, "_")}-graph.svg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("已导出离线 SVG 图谱");
});
if (graphNodeCenterBtn) graphNodeCenterBtn.addEventListener("click", () => {
  if (!selectedGraphNode) return;
  graphLocalCenter = selectedGraphNode.id;
  graphScope = "local";
  graphScopeLocalBtn.classList.add("active");
  graphScopeGlobalBtn.classList.remove("active");
  renderGraphFromCache();
});
if (graphNodePathBtn) graphNodePathBtn.addEventListener("click", () => {
  if (!selectedGraphNode || !currentFilePath || !graphHandle) return;
  const path = graphHandle.setPathTarget(currentFilePath, selectedGraphNode.id);
  if (graphPathInfoEl) {
    if (path.length >= 2) {
      const names = path.map((id) => id.replace(/^ghost::|^tag::/, "").split("/").pop());
      graphPathInfoEl.textContent = `最短路径（${path.length - 1} 跳）：${names.join(" → ")}`;
    } else {
      graphPathInfoEl.textContent = `当前文档「${currentFilePath.split("/").pop()}」与该节点之间暂无连通路径。`;
    }
    graphPathInfoEl.hidden = false;
  }
});
if (graphNodeOpenBtn) graphNodeOpenBtn.addEventListener("click", () => {
  if (selectedGraphNode && !selectedGraphNode.isGhost && !selectedGraphNode.isTag) {
    const target = selectedGraphNode.id;
    closeGraphView();
    guardUnsavedAction(() => openProjectFile(target));
  }
});

// Enhanced Task Filters & Metadata Editor Events
if (taskGroupBySel) taskGroupBySel.addEventListener("change", () => {
  store.ui.taskGroupBy = taskGroupBySel.value;
  schedulePersistState();
  loadTasksPanel();
});
if (taskFilterPrioritySel) taskFilterPrioritySel.addEventListener("change", () => {
  taskFilterPriority = taskFilterPrioritySel.value;
  loadTasksPanel();
});
if (taskFilterAssigneeSel) taskFilterAssigneeSel.addEventListener("change", () => {
  taskFilterAssignee = taskFilterAssigneeSel.value;
  loadTasksPanel();
});
if (taskColorFilter) taskColorFilter.addEventListener("click", (event) => {
  const btn = event.target.closest("button.color-dot");
  if (!btn) return;
  taskFilterColor = btn.dataset.color || "";
  taskColorFilter.querySelectorAll(".color-dot").forEach((b) => b.classList.toggle("active", b === btn));
  loadTasksPanel();
});
if (tmColorPicker) tmColorPicker.addEventListener("click", (event) => {
  const btn = event.target.closest("button.color-dot");
  if (!btn) return;
  editingTaskColor = btn.dataset.color || "";
  tmColorPicker.querySelectorAll(".color-dot").forEach((b) => b.classList.toggle("active", b === btn));
});
if (tmCancelBtn) tmCancelBtn.addEventListener("click", () => {
  taskMetaModal.hidden = true;
  editingTask = null;
});
if (taskMetaModal) taskMetaModal.addEventListener("click", (event) => {
  if (event.target === taskMetaModal) {
    taskMetaModal.hidden = true;
    editingTask = null;
  }
});
async function applyTaskMetaPatch(task, metaPayload) {
  let out = null;
  try {
    const res = await callScopedTool("update_markdown_task_meta", {
      path: task.path,
      line: task.line,
      expectedEtag: task.etag,
      ...metaPayload,
    });
    if (res && !res.isError) {
      out = res.structuredContent || JSON.parse(res.content[0].text);
    }
  } catch {
    out = null;
  }

  if (!out) {
    // Fallback via read_markdown_file + save_markdown_file with ETag protection
    const readRes = await callScopedTool("read_markdown_file", { path: task.path });
    if (readRes.isError) throw new Error(readRes.content?.[0]?.text || "读取任务所在文件失败");
    const docData = readRes.structuredContent || JSON.parse(readRes.content[0].text);
    if (docData.etag !== task.etag) {
      out = { conflict: true };
    } else {
      const lines = (docData.content || "").split(/\r?\n/);
      const idx = task.line - 1;
      if (idx < 0 || idx >= lines.length) throw new Error("任务行号超出范围");
      const m = lines[idx].match(/^(\s*(?:[-*+]|\d{1,9}[.)])\s+\[)([ xX])(\]\s*)(.*)$/);
      if (!m) throw new Error("目标行已不再是任务项");
      const nextChecked = metaPayload.status === "done"
        ? true
        : (["todo", "doing", "review"].includes(metaPayload.status)
            ? false
            : (typeof metaPayload.checked === "boolean" ? metaPayload.checked : m[2].toLowerCase() === "x"));
      const mark = nextChecked ? "x" : " ";
      const formatted = formatTaskMetadataClient(m[4], {
        ...metaPayload,
        status: nextChecked ? "" : metaPayload.status,
      });
      lines[idx] = `${m[1]}${mark}${m[3]}${formatted}`;
      const saveRes = await callScopedTool("save_markdown_file", {
        path: task.path,
        content: lines.join("\n"),
        expectedEtag: task.etag,
      });
      if (saveRes.isError) throw new Error(saveRes.content?.[0]?.text || "保存任务属性失败");
      out = saveRes.structuredContent || JSON.parse(saveRes.content[0].text);
    }
  }

  if (out.conflict) {
    showBanner(`${task.path} 已被外部修改，请刷新后再编辑属性。`, true);
    return false;
  }
  if (task.path === currentFilePath) {
    await openProjectFile(currentFilePath, { ignoreDraft: !isDirty, preserveView: true });
  }
  refreshRailBadges();
  loadTasksPanel();
  if (kanbanOpen) await loadKanbanTasks();
  return true;
}

function renderKanbanStatsBar(stats) {
  if (!kanbanStatsBar) return;
  while (kanbanStatsBar.firstChild) kanbanStatsBar.removeChild(kanbanStatsBar.firstChild);
  const kp = getKanbanPrefs();
  const activeKey = kp.quickFilter || "all";

  const cards = [
    { key: "all", label: "全部任务", count: stats.total, alert: false },
    { key: "todo", label: "○ 待开始", count: stats.todo, alert: false },
    { key: "doing", label: "◐ 进行中", count: stats.doing, alert: false },
    { key: "review", label: "◈ 待验收", count: stats.review, alert: false },
    { key: "done", label: "✓ 已完成", count: stats.done, alert: false },
    { key: "high", label: "🔥 高优 P1", count: stats.high, alert: stats.high > 0 },
    { key: "due", label: "⏰ 逾期 / 今日", count: stats.dueAlert, alert: stats.dueAlert > 0 },
  ];

  for (const item of cards) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "kanban-stat-card" +
      (activeKey === item.key ? " active" : "") +
      (item.alert ? " stat-alert" : "");
    const lbl = document.createElement("span");
    lbl.textContent = item.label;
    const num = document.createElement("span");
    num.className = "kanban-stat-num";
    num.textContent = String(item.count);
    btn.append(lbl, num);
    btn.addEventListener("click", () => {
      kp.quickFilter = activeKey === item.key && item.key !== "all" ? "all" : item.key;
      schedulePersistState();
      renderKanbanFromCache();
    });
    kanbanStatsBar.appendChild(btn);
  }

  const progWrap = document.createElement("div");
  progWrap.className = "kanban-progress-wrap";
  const progText = document.createElement("span");
  progText.textContent = `完成率 ${stats.completionRate}%`;
  const track = document.createElement("div");
  track.className = "kanban-progress-track";
  const fill = document.createElement("div");
  fill.className = "kanban-progress-fill";
  fill.style.width = `${stats.completionRate}%`;
  track.appendChild(fill);
  progWrap.append(progText, track);
  kanbanStatsBar.appendChild(progWrap);
}

function renderKanbanFromCache() {
  if (!kanbanBoard) return;
  const kp = getKanbanPrefs();
  const today = getTodayIso();
  const res = renderKanbanBoard(kanbanBoard, cachedAllTasks, {
    columnBy: kp.columnBy || "status",
    swimlaneBy: kp.swimlaneBy || "none",
    filterQuery: kanbanFilterInput ? kanbanFilterInput.value : "",
    quickFilter: kp.quickFilter || "all",
    today,
    collapsedLanes: collapsedKanbanLanes,
    onMoveTask: async (task, patch) => {
      const ok = await applyTaskMetaPatch(task, patch);
      if (ok) showToast(`已更新 ${task.path}:${task.line}`);
    },
    onToggleTask: async (task, checked) => {
      const ok = await applyTaskMetaPatch(task, {
        status: checked ? "done" : "todo",
        checked,
        priority: task.priority || "",
        due: task.due || "",
        assignee: task.assignee || "",
        group: task.group || "",
        color: task.color || "",
      });
      if (ok) showToast(`已更新 ${task.path}:${task.line}`);
    },
    onEditTask: (task) => openTaskMetaModal(task),
    onOpenTaskLocation: (task) => {
      closeKanbanView();
      guardUnsavedAction(() => openProjectFile(task.path, { line: task.line }));
    },
  });
  renderKanbanStatsBar(res.stats);
}

async function loadKanbanTasks() {
  try {
    const res = await callScopedTool("list_project_tasks", { status: "all", limit: 500 });
    if (res.isError) throw new Error(res.content?.[0]?.text || "加载看板任务失败");
    const data = res.structuredContent || JSON.parse(res.content[0].text);
    cachedAllTasks = (Array.isArray(data.tasks) ? data.tasks : []).map(enrichTaskItem);
    const openCount = cachedAllTasks.filter((t) => !t.checked).length;
    setBadge(badgeTasks, openCount);
    renderKanbanFromCache();
  } catch (err) {
    showBanner(`加载看板任务失败: ${err.message}`, true);
  }
}

async function openKanbanView() {
  setTab("files");
  if (graphOpen) {
    graphOpen = false;
    if (graphHandle && typeof graphHandle.destroy === "function") {
      graphHandle.destroy();
      graphHandle = null;
    }
    if (graphWorkspace) graphWorkspace.hidden = true;
  }
  kanbanOpen = true;
  docEmpty.hidden = true;
  docViewer.hidden = true;
  if (kanbanWorkspace) kanbanWorkspace.hidden = false;
  syncRailActiveStates();
  syncKanbanControlsFromStore();
  await loadKanbanTasks();
}

function openNewTaskModal() {
  if (!newTaskModal) return;
  if (allFiles.length === 0) {
    showBanner("当前项目暂无 Markdown 文档，无法新建待办。", true);
    return;
  }
  while (ntFile.firstChild) ntFile.removeChild(ntFile.firstChild);
  for (const f of allFiles) {
    if (f.bytes > MAX_READ_BYTES) continue;
    const opt = document.createElement("option");
    opt.value = f.path;
    opt.textContent = f.path;
    ntFile.appendChild(opt);
  }
  if (currentFilePath && allFiles.some((f) => f.path === currentFilePath)) {
    ntFile.value = currentFilePath;
  }
  ntText.value = "";
  ntStatus.value = "todo";
  ntPriority.value = "";
  ntDue.value = "";
  ntAssignee.value = "";
  ntGroup.value = "";
  newTaskColor = "";
  if (ntColorPicker) {
    ntColorPicker.querySelectorAll(".color-dot").forEach((b) => {
      b.classList.toggle("active", (b.dataset.color || "") === "");
    });
  }
  newTaskModal.hidden = false;
  ntText.focus();
}

if (tmSaveBtn) tmSaveBtn.addEventListener("click", async () => {
  if (!editingTask) return;
  tmSaveBtn.disabled = true;
  const chosenStatus = tmStatus ? tmStatus.value : normalizeTaskStatus(editingTask);
  const metaPayload = {
    status: chosenStatus,
    checked: chosenStatus === "done",
    priority: tmPriority.value || "",
    due: tmDue.value || "",
    assignee: tmAssignee.value.trim().replace(/^@/, ""),
    group: tmGroup.value.trim(),
    color: editingTaskColor || "",
  };
  try {
    const ok = await applyTaskMetaPatch(editingTask, metaPayload);
    if (ok) {
      taskMetaModal.hidden = true;
      editingTask = null;
      showToast("已安全更新待办属性");
    }
  } catch (err) {
    showBanner(`保存任务属性失败: ${err.message}`, true);
  } finally {
    tmSaveBtn.disabled = false;
  }
});

// Scope Switcher & Kanban Workbench Events
async function switchWorkspaceScope(nextScope) {
  const norm = nextScope === "all" ? "all" : "project";
  if (getActiveScope() === norm) return;
  guardUnsavedAction(async () => {
    store.ui.workspaceScope = norm;
    cachedGraphData = null;
    currentFilePath = "";
    isDirty = false;
    conflictInfo = null;
    if (!kanbanOpen && !graphOpen) {
      docViewer.hidden = true;
      docEmpty.hidden = false;
    }
    applyScopeUI();
    schedulePersistState(true);
    await loadFiles();
    showToast(norm === "all" ? `已切换至跨工作区模式（共 ${discoveredWorkspaces.length || 1} 个工作区）` : "已切换至当前项目模式");
  });
}

if (scopeProjectBtn) scopeProjectBtn.addEventListener("click", () => switchWorkspaceScope("project"));
if (scopeAllBtn) scopeAllBtn.addEventListener("click", () => switchWorkspaceScope("all"));

if (railBtnKanban) railBtnKanban.addEventListener("click", () => {
  if (kanbanOpen) {
    closeKanbanView();
  } else {
    openKanbanView();
  }
});
if (openKanbanBtn) openKanbanBtn.addEventListener("click", () => openKanbanView());
if (emptyKanbanBtn) emptyKanbanBtn.addEventListener("click", () => openKanbanView());
if (kanbanCloseBtn) kanbanCloseBtn.addEventListener("click", closeKanbanView);
if (kanbanRefreshBtn) kanbanRefreshBtn.addEventListener("click", () => loadKanbanTasks());
if (kanbanColBySel) kanbanColBySel.addEventListener("change", () => {
  getKanbanPrefs().columnBy = kanbanColBySel.value;
  schedulePersistState();
  renderKanbanFromCache();
});
if (kanbanLaneBySel) kanbanLaneBySel.addEventListener("change", () => {
  getKanbanPrefs().swimlaneBy = kanbanLaneBySel.value;
  collapsedKanbanLanes.clear();
  schedulePersistState();
  renderKanbanFromCache();
});
if (kanbanFilterInput) kanbanFilterInput.addEventListener("input", () => renderKanbanFromCache());
if (kanbanCopyReportBtn) kanbanCopyReportBtn.addEventListener("click", () => {
  const kp = getKanbanPrefs();
  const report = buildKanbanMarkdownReport(cachedAllTasks, {
    projectName: currentProjectName,
    scope: getActiveScope(),
    columnBy: kp.columnBy || "status",
    today: getTodayIso(),
  });
  copyText(report, "已复制 Markdown 任务看板周报汇总");
  showToast("已复制 Markdown 任务看板周报汇总");
});
if (kanbanAddTaskBtn) kanbanAddTaskBtn.addEventListener("click", openNewTaskModal);
if (ntColorPicker) ntColorPicker.addEventListener("click", (event) => {
  const btn = event.target.closest("button.color-dot");
  if (!btn) return;
  newTaskColor = btn.dataset.color || "";
  ntColorPicker.querySelectorAll(".color-dot").forEach((b) => b.classList.toggle("active", b === btn));
});
if (ntCancelBtn) ntCancelBtn.addEventListener("click", () => {
  if (newTaskModal) newTaskModal.hidden = true;
});
if (newTaskModal) newTaskModal.addEventListener("click", (event) => {
  if (event.target === newTaskModal) newTaskModal.hidden = true;
});
if (ntSaveBtn) ntSaveBtn.addEventListener("click", async () => {
  const targetPath = ntFile ? ntFile.value : "";
  const rawDesc = ntText ? ntText.value.trim() : "";
  if (!targetPath) {
    showBanner("请选择目标 Markdown 文档。", true);
    return;
  }
  if (!rawDesc) {
    ntText.focus();
    showToast("请输入待办事项内容");
    return;
  }
  ntSaveBtn.disabled = true;
  try {
    const readRes = await callScopedTool("read_markdown_file", { path: targetPath });
    if (readRes.isError) throw new Error(readRes.content?.[0]?.text || "读取目标文档失败");
    const docData = readRes.structuredContent || JSON.parse(readRes.content[0].text);
    const chosenStatus = ntStatus ? ntStatus.value : "todo";
    const isDone = chosenStatus === "done";
    const formattedBody = formatTaskMetadataClient(rawDesc, {
      priority: ntPriority ? ntPriority.value : "",
      due: ntDue ? ntDue.value : "",
      assignee: ntAssignee ? ntAssignee.value.trim().replace(/^@/, "") : "",
      group: ntGroup ? ntGroup.value.trim() : "",
      color: newTaskColor || "",
      status: isDone ? "" : chosenStatus,
    });
    const newLine = `- [${isDone ? "x" : " "}] ${formattedBody}`;
    const baseText = docData.content || "";
    const sep = baseText.length === 0 ? "" : (baseText.endsWith("\n") ? "" : "\n");
    const nextContent = `${baseText}${sep}${newLine}\n`;

    const saveRes = await callScopedTool("save_markdown_file", {
      path: targetPath,
      content: nextContent,
      expectedEtag: docData.etag,
    });
    if (saveRes.isError) throw new Error(saveRes.content?.[0]?.text || "写入新待办失败");
    const saveOut = saveRes.structuredContent || JSON.parse(saveRes.content[0].text);
    if (saveOut.conflict) {
      showBanner(`${targetPath} 已被外部修改，请重试。`, true);
      return;
    }
    newTaskModal.hidden = true;
    showToast(`已在 ${targetPath} 新增待办事项`);
    if (targetPath === currentFilePath) {
      await openProjectFile(currentFilePath, { ignoreDraft: !isDirty, preserveView: true });
    }
    refreshRailBadges();
    loadTasksPanel();
    if (kanbanOpen) await loadKanbanTasks();
  } catch (err) {
    showBanner(`新建待办失败: ${err.message}`, true);
  } finally {
    ntSaveBtn.disabled = false;
  }
});

attachInteractiveHandlers(docContent);
attachInteractiveHandlers(snippetPreview);
onVisibilityChanged((nowVisible) => {
  if (nowVisible && store.ui.activeTab === "files" && allFiles.length === 0) {
    loadFiles();
  }
});

initializeHost().then(
  async (result) => {
    store = hydrateStore(result && result.state);
    applyThemeModeUI(store.ui.themeMode);
    applyScopeUI();
    applyLayoutSizes();
    syncGraphControlsFromStore();
    syncSearchControlsFromStore();
    syncKanbanControlsFromStore();
    renderSearchResults(null, "");
    if (taskGroupBySel) taskGroupBySel.value = store.ui.taskGroupBy || "none";
    snippetInput.value = store.snippet || "";
    updateSnippetPreview();
    setDocMode(store.ui.docMode);
    setOutlineOpen(store.ui.outlineOpen);
    const wantGraph = store.ui.railTab === "graph";
    const wantKanban = store.ui.railTab === "kanban";
    setRailTab(wantGraph || wantKanban ? "tree" : store.ui.railTab, false);
    setSidebarOpen(store.ui.sidebarOpen);
    setTab(store.ui.activeTab);
    await loadFiles();
    const projState = getProjectState(store, currentProjectName);
    if (projState.currentFilePath) {
      await openProjectFile(projState.currentFilePath);
    }
    if (wantGraph) {
      await openGraphView(true);
    } else if (wantKanban) {
      await openKanbanView();
    }
  },
  (err) => {
    showBanner(`初始化失败: ${err.message}`, true);
  }
);
