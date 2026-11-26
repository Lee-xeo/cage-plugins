import { copyText, initializeHost, isVisible, onVisibilityChanged, request, setThemeMode } from "./bridge.mjs";
import { attachEditorAssist, extractHeadingsFromMarkdown } from "./editor-assist.mjs";
import { buildStandaloneHtml } from "./export-html.mjs";
import { createFindBar, locateSourceLine } from "./findbar.mjs";
import { applyI18n, resolveEffectiveLocale, translate } from "./i18n.mjs";
import { createAssetLoader } from "./render/asset-loader.mjs";
import { renderDataviewBlock } from "./render/dataview.mjs";
import { renderDiffView } from "./render/diff-view.mjs";
import { renderKnowledgeGraph } from "./render/graph-view.mjs";
import {
  STATUS_META,
  buildKanbanMarkdownReport,
  computeKanbanStats,
  normalizeTaskStatus,
  renderKanbanBoard,
} from "./render/kanban-view.mjs";
import { renderOfficeDocument } from "./render/office-viewer.mjs";
import { renderSlidesDeck } from "./render/slides-view.mjs";
import { isRelativeMarkdownHref, renderMarkdown, slugify } from "./renderer.mjs";
import { buildBatchReplaceArgs, buildSearchScopeArgs } from "./search-scope.mjs";
import {
  canPersistDraft,
  createInitialGraphSettings,
  deleteDraft,
  fitStateWithinQuotaWithMeta,
  getDraft,
  getProjectState,
  hasDraftForFile,
  hydrateStore,
  setDraft,
} from "./store.mjs";

const MAX_SNIPPET_BYTES = 24 * 1024;
const MAX_READ_BYTES = 512 * 1024;
const MAX_ASSET_UPLOAD_BYTES = 512 * 1024;
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
const refreshBtn = el("refresh-btn");
const langToggleBtn = el("lang-toggle-btn");
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
const ntWorkspaceHint = el("nt-workspace-hint");
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
const docWsPill = el("doc-ws-pill");
const docPath = el("doc-path");
const docSavedPill = el("doc-saved-pill");
const docDirtyPill = el("doc-dirty-pill");
const docReadonlyPill = el("doc-readonly-pill");
const docConflictPill = el("doc-conflict-pill");
const docMeta = el("doc-meta");
const modeReadBtn = el("mode-read");
const modeSplitBtn = el("mode-split");
const modeEditBtn = el("mode-edit");
const splitScrollLockBtn = el("split-scroll-lock-btn");
const slidesModeBtn = el("slides-mode-btn");
const focusModeBtn = el("focus-mode-btn");
const focusExitBtn = el("focus-exit-btn");
const slidesModal = el("slides-modal");
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
const draftDiffBtn = el("draft-diff-btn");
const restoreDiskBtn = el("restore-disk-btn");
const workspacePanes = el("workspace-panes");
const editorPane = el("editor-pane");
const previewPane = el("preview-pane");
const formatBar = el("format-bar");
const docEditor = el("doc-editor");
const editorStatusbar = el("editor-statusbar");
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
const conflictDiffBox = el("conflict-diff-box");
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
  replaceToggleBtn: el("find-replace-toggle"),
  replaceRowEl: el("find-replace-row"),
  replaceInputEl: el("find-replace-input"),
  replaceOneBtn: el("find-replace-one"),
  replaceAllBtn: el("find-replace-all"),
  containerEl: docContent,
  getSourceText: () => docEditor.value,
  isReadOnly: () => currentFileReadOnly,
  onReplaceText: (nextText) => {
    docEditor.value = nextText;
    updateDirtyState();
    scheduleDraftSave();
    renderDocContent(nextText);
  },
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
let activeDraftExceedsQuota = false;
let restoredFromDraft = false;
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
let cachedLinksData = null;
let kanbanOpen = false;
let graphOpen = false;
let graphScope = "global";
let cachedGraphData = null;
let graphHandle = null;
let selectedGraphNode = null;
let currentOfficeHandle = null;
let activeSlidesHandle = null;
let focusMode = false;
let isScrollSyncing = false;
let renderHydrateToken = 0;
const transcludeCache = new Map();
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
    const en = isEnLocale();
    projectTooltipWs.textContent =
      wsCount > 1
        ? (en
          ? `Discovered sibling workspaces (${wsCount}): ${discoveredWorkspaces.join(" · ")}`
          : `已发现同级工作区（${wsCount} 个）：${discoveredWorkspaces.join(" · ")}`)
        : (en
          ? `1 workspace active (${currentProjectName || "—"}); add or switch in host sidebar '+'.`
          : `当前检测到 1 个工作区（${currentProjectName || "—"}）；可在宿主左侧「项目 +」添加或切换工作区。`);
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
    const { state: fitted, droppedActiveDraft } = fitStateWithinQuotaWithMeta(
      store,
      currentProjectName,
      currentFilePath,
    );
    if (droppedActiveDraft && isDirty && currentFilePath && !currentFileReadOnly && !activeDraftExceedsQuota) {
      activeDraftExceedsQuota = true;
      updateDirtyState();
    }
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
    graphNodeMeta.textContent = isEnLocale()
      ? `Missing target · Referenced ${node.inDegree} times`
      : `未创建目标 · 被 ${node.inDegree} 处引用`;
  } else if (node.isTag) {
    graphNodeMeta.textContent = isEnLocale()
      ? `Tag cluster · ${node.degree} linked docs`
      : `标签聚类节点 · 关联 ${node.degree} 篇文档`;
  } else {
    const taskPart = node.tasksTotal > 0
      ? (isEnLocale() ? ` · Tasks ${node.tasksOpen}/${node.tasksTotal}` : ` · 待办 ${node.tasksOpen}/${node.tasksTotal}`)
      : "";
    graphNodeMeta.textContent = isEnLocale()
      ? `${node.id} · In ${node.inDegree} · Out ${node.outDegree}${taskPart}`
      : `${node.id} · 入链 ${node.inDegree} · 出链 ${node.outDegree}${taskPart}`;
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
    appendRelGroup(isEnLocale() ? "Outgoing Links" : "出链（引用）", node.outLinks);
    appendRelGroup(isEnLocale() ? "Incoming Backlinks" : "入链（反向引用）", node.inLinks);
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
    locale: getEffectiveLocale(),
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
  graphStatsEl.textContent = isEnLocale()
    ? `${graphHandle.nodeCount} nodes · ${graphHandle.edgeCount} edges`
    : `${graphHandle.nodeCount} 节点 · ${graphHandle.edgeCount} 连线`;
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
      if ((store.ui.docMode === "edit" || store.ui.docMode === "split") && h.line > 0) {
        const lines = docEditor.value.split("\n");
        let offset = 0;
        for (let idx = 0; idx < Math.min(lines.length, h.line - 1); idx++) {
          offset += lines[idx].length + 1;
        }
        if (store.ui.docMode === "edit") docEditor.focus();
        docEditor.setSelectionRange(offset, offset);
        scrollEditorToLines(h.line, h.line);
        updateEditorStatusbar();
      }
      const targetEl = h.id ? document.getElementById(h.id) : null;
      if (targetEl && store.ui.docMode !== "edit") {
        unfoldAncestorsOf(docContent, targetEl, collapsedDocHeadings);
        targetEl.scrollIntoView({ behavior: "smooth" });
      }
    });
    row.appendChild(btn);
    outlineList.appendChild(row);
  }
  updateActiveOutlineItem();
}

function extractMarkdownSection(markdownText, targetHeading) {
  const norm = String(markdownText || "").replace(/\r\n?/g, "\n");
  let body = norm;
  if (norm.startsWith("---\n")) {
    const endIdx = norm.indexOf("\n---\n", 4);
    if (endIdx !== -1) body = norm.slice(endIdx + 5);
  }
  const want = String(targetHeading || "").trim().toLowerCase();
  if (!want) return body.trim();
  const lines = body.split("\n");
  let startIdx = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (!m) continue;
    const hText = m[2].trim().toLowerCase();
    if (startIdx === -1) {
      if (hText === want || slugify(m[2]) === slugify(want)) {
        startIdx = i;
        startLevel = m[1].length;
      }
    } else if (m[1].length <= startLevel) {
      return lines.slice(startIdx, i).join("\n").trim();
    }
  }
  return startIdx !== -1 ? lines.slice(startIdx).join("\n").trim() : "";
}

async function hydrateTransclusions(container, token, depth = 0, visited = new Set()) {
  const hosts = [...container.querySelectorAll(".md-transclude")];
  if (hosts.length === 0) return;

  for (const card of hosts) {
    if (token !== renderHydrateToken) return;
    const target = card.dataset.transcludeTarget || "";
    const heading = card.dataset.transcludeHeading || "";
    const bodyEl = card.querySelector(".md-transclude-body");
    if (!bodyEl) continue;

    const candidates = resolveWikilinkCandidates(target);
    if (candidates.length === 0) {
      bodyEl.textContent = `未找到可嵌入的文档「${target}」`;
      bodyEl.classList.add("md-transclude-err");
      continue;
    }
    const targetPath = candidates[0];
    if (depth >= 2 || visited.has(targetPath)) {
      bodyEl.textContent = `已拦截循环嵌入或超过最大嵌套深度（${targetPath}）`;
      continue;
    }
    try {
      let text = transcludeCache.get(targetPath);
      if (typeof text !== "string") {
        const res = await callScopedTool("read_markdown_file", { path: targetPath });
        if (res.isError) throw new Error(res.content?.[0]?.text || "读取失败");
        const data = res.structuredContent || { content: res.content?.[0]?.text || "" };
        text = String(data.content || "");
        transcludeCache.set(targetPath, text);
      }
      if (token !== renderHydrateToken) return;
      const slice = extractMarkdownSection(text, heading);
      if (!slice) {
        bodyEl.textContent = heading
          ? `文档「${targetPath}」中未找到章节「${heading}」`
          : `文档「${targetPath}」内容为空`;
        continue;
      }
      bodyEl.classList.remove("muted");
      renderMarkdown(slice, bodyEl, {
        document,
        onCopy: (code) => {
          copyText(code, "已复制代码块");
          showToast("已复制代码块");
        },
        onAssetMount: (figureEl, assetHref, alt) => {
          assetLoader.mountProjectImage(figureEl, targetPath, assetHref, alt, openLightbox);
        },
      });
      annotateWikilinks(bodyEl);
      const nextVisited = new Set(visited);
      nextVisited.add(targetPath);
      await hydrateTransclusions(bodyEl, token, depth + 1, nextVisited);
    } catch (err) {
      bodyEl.textContent = `加载嵌入内容失败：${err.message}`;
    }
  }
}

async function hydrateDataviewBlocks(container, token) {
  const hosts = [...container.querySelectorAll(".md-dataview-host")];
  if (hosts.length === 0) return;

  try {
    if (cachedAllTasks.length === 0) {
      const taskRes = await callScopedTool("list_project_tasks", {});
      if (!taskRes.isError) {
        const tData = taskRes.structuredContent || JSON.parse(taskRes.content[0].text);
        cachedAllTasks = Array.isArray(tData.tasks) ? tData.tasks.map(enrichTaskItem) : [];
      }
    }
    if (cachedTags.length === 0) {
      const tagRes = await callScopedTool("list_project_tags", {});
      if (!tagRes.isError) {
        const tgData = tagRes.structuredContent || JSON.parse(tagRes.content[0].text);
        cachedTags = Array.isArray(tgData.tags) ? tgData.tags : [];
      }
    }
  } catch {
    // Keep best-effort local data if offline/unavailable
  }
  if (token !== renderHydrateToken) return;

  const tagFilesMap = new Map();
  for (const tag of cachedTags) {
    for (const p of tag.files || []) {
      if (!tagFilesMap.has(p)) tagFilesMap.set(p, new Set());
      tagFilesMap.get(p).add(String(tag.name || "").toLowerCase());
    }
  }
  const mdFiles = allFiles.filter((f) => isMarkdownPath(f.path));

  for (const host of hosts) {
    const queryText = host.dataset.dataviewQuery || "";
    renderDataviewBlock(
      document,
      host,
      queryText,
      { files: mdFiles, tasks: cachedAllTasks, tagFilesMap },
      {
        onOpenFile: (targetPath, ln) => guardUnsavedAction(() => openProjectFile(targetPath, { line: ln || 0 })),
        onToggleTask: async (task, nextChecked) => {
          const ok = await applyTaskMetaPatch(task, { checked: nextChecked, status: nextChecked ? "done" : "todo" });
          if (ok) hydrateDataviewBlocks(container, token);
        },
      },
    );
  }
}

function updateEditorStatusbar() {
  if (!editorStatusbar || !docEditor) return;
  const val = docEditor.value || "";
  const pos = docEditor.selectionStart || 0;
  const end = docEditor.selectionEnd || pos;
  const before = val.slice(0, pos);
  const lines = before.split("\n");
  const lineNo = lines.length;
  const colNo = lines[lines.length - 1].length + 1;
  const selLen = Math.max(0, end - pos);
  if (isEnLocale()) {
    const selInfo = selLen > 0 ? ` · ${selLen} selected` : "";
    editorStatusbar.textContent = `Ln ${lineNo}, Col ${colNo}${selInfo} · ${val.length} chars`;
  } else {
    const selInfo = selLen > 0 ? ` · 选中 ${selLen} 字符` : "";
    editorStatusbar.textContent = `第 ${lineNo} 行, 第 ${colNo} 列${selInfo} · 共 ${val.length} 字符`;
  }
}

function renderDocContent(markdown) {
  const token = ++renderHydrateToken;
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
  updateEditorStatusbar();
  if (currentFilePath) {
    hydrateTransclusions(docContent, token, 0, new Set([currentFilePath]));
    hydrateDataviewBlocks(docContent, token);
  }
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
  if (splitScrollLockBtn) {
    splitScrollLockBtn.hidden = store.ui.docMode !== "split";
    splitScrollLockBtn.classList.toggle("active", store.ui.splitScrollLock !== false);
  }
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
  if (!isDirty) {
    activeDraftExceedsQuota = false;
    restoredFromDraft = false;
  }
  saveBtn.hidden = !isDirty;
  const hasStoredDraft = hasDraftForFile(store, currentProjectName, currentFilePath);
  const showQuotaBanner = isDirty && activeDraftExceedsQuota && !hasCurrentConflict();
  draftBanner.hidden = hasCurrentConflict() || (!showQuotaBanner && !hasStoredDraft);
  if (draftBanner) {
    draftBanner.classList.toggle("danger", showQuotaBanner);
    draftBanner.classList.toggle("warn", !showQuotaBanner);
  }
  if (draftBannerText && !draftBanner.hidden) {
    if (showQuotaBanner) {
      draftBannerText.textContent = "当前未保存修改超出本地草稿缓存上限（56 KiB），无法自动暂存；离开或重开前请先保存（⌘S）。";
    } else if (restoredFromDraft) {
      draftBannerText.textContent = "已恢复未保存的本地草稿（按项目与文件路径隔离）。";
    } else {
      draftBannerText.textContent = "当前文档有未保存修改，已暂存为完整本地草稿。";
    }
  }
  updateStatusPills();
}

function scheduleDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    if (!currentFilePath || currentFileReadOnly) return;
    if (docEditor.value !== savedFileContent) {
      restoredFromDraft = false;
      if (canPersistDraft(store, currentProjectName, currentFilePath, docEditor.value, currentBaseEtag)) {
        activeDraftExceedsQuota = false;
        setDraft(store, currentProjectName, currentFilePath, docEditor.value, currentBaseEtag);
      } else {
        activeDraftExceedsQuota = true;
        deleteDraft(store, currentProjectName, currentFilePath);
      }
    } else {
      activeDraftExceedsQuota = false;
      restoredFromDraft = false;
      deleteDraft(store, currentProjectName, currentFilePath);
    }
    updateDirtyState();
    renderFileList();
    schedulePersistState(true);
  }, 300);
}

async function openConflictDialog(draftPreviewOnly = false) {
  const isConflict = !draftPreviewOnly && Boolean(conflictInfo);
  if (!isConflict && !currentFilePath) return;

  const targetPath = isConflict ? conflictInfo.path : currentFilePath;
  const localBytes = encoder.encode(docEditor.value || "").length;
  conflictModalDesc.textContent = isConflict
    ? `「${targetPath}」在磁盘上的版本已发生变化（ETag 失配），为防止覆盖外部修改，本次保存已被拦截。`
    : `「${targetPath}」当前本地未保存草稿与磁盘基准版本逐行对比：`;

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
  rt.textContent = isConflict ? "磁盘最新外部版本" : "磁盘当前基准版本";
  const r1 = document.createElement("span");
  r1.className = "muted";
  r1.textContent = `大小：${formatBytes((isConflict ? conflictInfo.diskBytes : currentFileBytes) || 0)}`;
  const r2 = document.createElement("span");
  r2.className = "muted";
  r2.textContent = `ETag：${(isConflict ? conflictInfo.diskEtag : currentBaseEtag)?.slice(0, 10) || "—"}`;
  rightCol.append(rt, r1, r2);

  conflictMetaBox.append(leftCol, rightCol);
  conflictMetaBox.hidden = false;

  conflictForceBtn.hidden = !isConflict;
  conflictReloadBtn.textContent = isConflict ? "重新加载磁盘版本" : "放弃草稿并恢复磁盘版本";
  conflictKeepBtn.textContent = isConflict ? "保留我的草稿" : "继续保留草稿并关闭";

  let diskText = savedFileContent || "";
  if (isConflict) {
    try {
      const diskRes = await callScopedTool("read_markdown_file", { path: targetPath });
      if (!diskRes.isError) {
        const diskData = diskRes.structuredContent || { content: diskRes.content?.[0]?.text || "" };
        diskText = String(diskData.content || "");
      }
    } catch {
      // Fall back to cached savedFileContent if disk fetch fails
    }
  }
  if (conflictDiffBox) {
    renderDiffView(document, conflictDiffBox, diskText, docEditor.value || "", {
      oldLabel: isConflict ? "磁盘最新版本" : "磁盘基准版本",
      newLabel: "你的本地草稿",
    });
    conflictDiffBox.hidden = false;
  }
  conflictModal.hidden = false;
}

function guardUnsavedAction(action) {
  if (!currentFilePath || !isDirty) {
    action();
    return;
  }
  const fitsQuota = canPersistDraft(store, currentProjectName, currentFilePath, docEditor.value, currentBaseEtag);
  activeDraftExceedsQuota = !fitsQuota;
  updateDirtyState();
  pendingLeaveAction = action;
  if (leaveDraftBtn) {
    leaveDraftBtn.hidden = !fitsQuota;
  }
  leaveModalDesc.textContent = fitsQuota
    ? `「${currentFilePath}」有未保存的编辑内容，切换前请选择处理方式：`
    : `「${currentFilePath}」未保存内容超出本地草稿缓存上限（56 KiB），无法暂存为可恢复草稿。继续离开将丢失修改，请先「保存并继续」或选择「放弃修改」：`;
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
  if (!canPersistDraft(store, currentProjectName, currentFilePath, docEditor.value, currentBaseEtag)) {
    activeDraftExceedsQuota = true;
    deleteDraft(store, currentProjectName, currentFilePath);
    if (leaveDraftBtn) leaveDraftBtn.hidden = true;
    leaveModalDesc.textContent = `「${currentFilePath}」未保存内容超出本地草稿缓存上限（56 KiB），无法暂存为可恢复草稿。请先「保存并继续」或选择「放弃修改」：`;
    updateDirtyState();
    showBanner("当前修改超出 56 KiB 草稿上限，无法暂存为完整草稿，请先保存后再离开。", true);
    return;
  }
  const action = pendingLeaveAction;
  leaveModal.hidden = true;
  pendingLeaveAction = null;
  activeDraftExceedsQuota = false;
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
  activeDraftExceedsQuota = false;
  restoredFromDraft = false;
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

function isMarkdownPath(relPath) {
  return /\.(md|markdown|mdx)$/i.test(String(relPath || "").trim());
}

function getFileDocType(item) {
  if (item && typeof item === "object" && item.docType) return item.docType;
  const low = String(typeof item === "string" ? item : item?.path || "").trim().toLowerCase();
  if (/\.(xlsx|xlsm|csv|tsv)$/.test(low)) return "excel";
  if (/\.docx$/.test(low)) return "word";
  if (/\.pptx$/.test(low)) return "ppt";
  if (/\.pdf$/.test(low)) return "pdf";
  return "markdown";
}

function fileIconPrefix(item) {
  const dt = getFileDocType(item);
  if (dt === "excel") return "📊 ";
  if (dt === "word") return "📝 ";
  if (dt === "ppt") return "📽 ";
  if (dt === "pdf") return "📕 ";
  return "";
}

function splitWorkspaceRelPath(relPath) {
  const clean = String(relPath || "").replace(/^\/+/, "");
  if (getActiveScope() === "all" && clean.includes("/")) {
    const slashIdx = clean.indexOf("/");
    return { workspace: clean.slice(0, slashIdx), innerPath: clean.slice(slashIdx + 1) };
  }
  return { workspace: currentProjectName || "当前工作区", innerPath: clean };
}

function updateDocWorkspacePill(relPath) {
  if (!docWsPill) return;
  if (!relPath) {
    docWsPill.hidden = true;
    return;
  }
  const { workspace, innerPath } = splitWorkspaceRelPath(relPath);
  docWsPill.hidden = false;
  docWsPill.textContent = isEnLocale() ? `Workspace: ${workspace}` : `工作区: ${workspace}`;
  docWsPill.title = isEnLocale()
    ? `Workspace: ${workspace}\nPath: ${innerPath}`
    : `所属工作区：${workspace}\n相对路径：${innerPath}`;
}

function cleanupOfficeViewer() {
  if (currentOfficeHandle && typeof currentOfficeHandle.destroy === "function") {
    currentOfficeHandle.destroy();
  }
  currentOfficeHandle = null;
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
  const md = isMarkdownPath(item.path);
  const oversized = md ? item.bytes > MAX_READ_BYTES : item.bytes > 16 * 1024 * 1024;
  const label = `${oversized ? "🔒 " : ""}${fileIconPrefix(item)}${displayName}`;
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

  fileCount.textContent = query
    ? `${filtered.length} / ${allFiles.length}`
    : (isEnLocale() ? `${allFiles.length} files` : `${allFiles.length} 个文件`);
  viewTreeBtn.textContent = store.ui.treeMode
    ? translate(getEffectiveLocale(), "btn.toggleTree")
    : translate(getEffectiveLocale(), "btn.toggleTreeHierarchy");
  toggleAllBtn.hidden = !store.ui.treeMode || filtered.length === 0;
  while (fileList.firstChild) fileList.removeChild(fileList.firstChild);

  if (filtered.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = allFiles.length === 0
      ? (isEnLocale() ? "No documents found in this workspace." : "当前项目未发现 Markdown 文件。")
      : (isEnLocale() ? "No matching filenames. Try Full-Text Search." : "没有匹配的文件名，可切至左侧「🔍 全文检索」搜正文。");
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
    toggleAllBtn.textContent = allCollapsed
      ? translate(getEffectiveLocale(), "btn.expandAll")
      : translate(getEffectiveLocale(), "btn.collapseAll");
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
      ...buildSearchScopeArgs({
        caseSensitive: searchCaseSensitive,
        wholeWord: searchWholeWord,
        regex: searchRegex,
        pathPrefix: searchPathPrefix,
        tags: [...selectedTags],
      }),
      sortBy: sp.sortBy || "relevance",
      includeContext: Boolean(sp.context),
    };

    let result = await callScopedTool("search_markdown_files", richArgs);
    if (
      result &&
      result.isError &&
      /additionalProperties|Unexpected (?:property|parameter|field)|unknown (?:property|parameter|field)/i.test(
        result.content?.[0]?.text || "",
      )
    ) {
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
    lastSearchData = null;
    renderSearchResults(null, "");
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
  transcludeCache.clear();
  refreshBtn.disabled = true;
  showBanner("正在扫描项目中的文档文件…");
  try {
    let result = await callScopedTool("list_markdown_files", { includeDocs: true });
    if (result && result.isError && /additionalProperties|Unexpected|includeDocs/i.test(result.content?.[0]?.text || "")) {
      result = await callScopedTool("list_markdown_files", {});
    }
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
      activeDraftExceedsQuota = false;
      restoredFromDraft = false;
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

async function convertOfficeToMarkdown(officeData) {
  const mdText = String(officeData?.markdown || "").trim();
  const srcPath = String(officeData?.path || currentFilePath || "").trim();
  if (!srcPath || !mdText) {
    showBanner("该文档暂无可转换的 Markdown 内容。", true);
    return;
  }
  const baseStem = srcPath.replace(/\.[^/.]+$/, "");
  let targetMdPath = `${baseStem}.md`;
  if (allFiles.some((f) => f.path === targetMdPath)) {
    targetMdPath = `${baseStem}-提取.md`;
  }
  const { workspace, innerPath } = splitWorkspaceRelPath(targetMdPath);
  try {
    const res = await callScopedTool("save_markdown_file", {
      path: targetMdPath,
      content: mdText + "\n",
      createDirs: true,
    });
    if (res.isError) throw new Error(res.content?.[0]?.text || "转换保存失败");
    await loadFiles();
    await openProjectFile(targetMdPath);
    showToast(`已生成至工作区「${workspace}」：${innerPath}`);
  } catch (err) {
    showBanner(`转换 Markdown 失败: ${err.message}`, true);
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
    if (!isMarkdownPath(path)) {
      const result = await callScopedTool("read_office_document", { path });
      if (result.isError) {
        throw new Error(result.content?.[0]?.text || "读取文档失败");
      }
      const data = result.structuredContent || JSON.parse(result.content[0].text);
      cleanupOfficeViewer();
      collapsedDocHeadings.clear();
      currentFilePath = data.path || path;
      savedFileContent = data.markdown || "";
      currentBaseEtag = data.etag || "";
      currentFileBytes = data.bytes || 0;
      currentFileTruncated = Boolean(data.truncated);
      currentFileReadOnly = true;
      conflictInfo = null;
      draftBanner.hidden = true;
      findBar.close();

      docPath.textContent = currentFilePath;
      updateDocWorkspacePill(currentFilePath);
      docEditor.value = "";
      updateReadOnlyControls();
      updateDirtyState();
      if (renameDocBtn) renameDocBtn.hidden = true;
      if (slidesModeBtn) slidesModeBtn.hidden = true;
      if (findBtn) findBtn.hidden = true;
      if (copySourceBtn) copySourceBtn.hidden = true;
      if (backlinksPanel) backlinksPanel.hidden = true;

      currentOfficeHandle = renderOfficeDocument(docContent, data, {
        onCopyMarkdown: async (text) => {
          const ok = await copyText(text);
          showToast(ok ? "已复制 Markdown 表格内容" : "复制失败");
        },
        onConvertToMarkdown: (officeData) => convertOfficeToMarkdown(officeData),
      });
      currentHeadings = currentOfficeHandle.headings || [];
      renderOutline(currentHeadings);
      docMeta.textContent = `${formatBytes(currentFileBytes)} · ${String(data.format || "").toUpperCase()} 离线只读预览`;

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
      if (typeof recordTabAndHistory === "function") {
        recordTabAndHistory(currentFilePath, Boolean(options.skipHistory));
      }
      renderFileList();
      schedulePersistState();
      return;
    }

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

    cleanupOfficeViewer();
    if (renameDocBtn) renameDocBtn.hidden = false;
    if (slidesModeBtn) slidesModeBtn.hidden = false;
    if (findBtn) findBtn.hidden = false;
    if (copySourceBtn) copySourceBtn.hidden = false;

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
    activeDraftExceedsQuota = false;
    restoredFromDraft = Boolean(savedDraft);
    docPath.textContent = currentFilePath;
    updateDocWorkspacePill(currentFilePath);
    docEditor.value = activeContent;

    if (savedDraft && savedDraft.baseEtag && currentBaseEtag && savedDraft.baseEtag !== currentBaseEtag) {
      conflictInfo = { path: currentFilePath, diskEtag: currentBaseEtag, diskBytes: currentFileBytes };
    } else if (ignoreDraft) {
      conflictInfo = null;
    }

    updateReadOnlyControls();
    updateDirtyState();

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
    if (typeof recordTabAndHistory === "function") {
      recordTabAndHistory(currentFilePath, Boolean(options.skipHistory));
    }
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
      if (canPersistDraft(store, currentProjectName, currentFilePath, content, currentBaseEtag)) {
        activeDraftExceedsQuota = false;
        setDraft(store, currentProjectName, currentFilePath, content, currentBaseEtag);
      } else {
        activeDraftExceedsQuota = true;
        deleteDraft(store, currentProjectName, currentFilePath);
      }
      schedulePersistState(true);
      updateDirtyState();
      openConflictDialog();
      return false;
    }

    savedFileContent = content;
    currentBaseEtag = data.etag || "";
    currentFileBytes = data.bytes || encoder.encode(content).length;
    currentFileTruncated = false;
    activeDraftExceedsQuota = false;
    restoredFromDraft = false;
    conflictInfo = null;
    deleteDraft(store, currentProjectName, currentFilePath);
    updateDirtyState();
    renderDocContent(content);
    renderFileList();
    schedulePersistState(true);
    showToast(`已安全保存 ${currentFilePath}`);
    await request("ui/notify", { tone: "info", message: `已保存 ${currentFilePath}` }).catch(() => {});
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
  if (canPersistDraft(store, currentProjectName, currentFilePath, docEditor.value, currentBaseEtag)) {
    activeDraftExceedsQuota = false;
    setDraft(store, currentProjectName, currentFilePath, docEditor.value, currentBaseEtag);
    schedulePersistState(true);
    updateDirtyState();
    showToast("已保留本地草稿，磁盘文件未被覆盖");
  } else {
    activeDraftExceedsQuota = true;
    deleteDraft(store, currentProjectName, currentFilePath);
    schedulePersistState(true);
    updateDirtyState();
    showBanner("当前修改超出 56 KiB 本地草稿缓存上限，无法跨重开保留；磁盘文件未被覆盖，请手动保存或备份。", true);
  }
});

conflictReloadBtn.addEventListener("click", () => {
  conflictModal.hidden = true;
  conflictInfo = null;
  activeDraftExceedsQuota = false;
  restoredFromDraft = false;
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
  activeDraftExceedsQuota = false;
  restoredFromDraft = false;
  deleteDraft(store, currentProjectName, currentFilePath);
  openProjectFile(currentFilePath, { ignoreDraft: true });
  showToast("已恢复磁盘版本");
});

if (draftDiffBtn) {
  draftDiffBtn.addEventListener("click", () => {
    openConflictDialog(true);
  });
}

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
    const { workspace, innerPath } = splitWorkspaceRelPath(item.path);
    const wsTag = document.createElement("span");
    wsTag.className = "state-badge ws-badge";
    wsTag.textContent = workspace;
    nameSpan.appendChild(wsTag);
    const oversized = isMarkdownPath(item.path) ? item.bytes > MAX_READ_BYTES : item.bytes > 16 * 1024 * 1024;
    nameSpan.appendChild(document.createTextNode(` ${oversized ? "🔒 " : ""}${fileIconPrefix(item)}${innerPath}`));
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
  if (fmt === "heading") {
    const start = docEditor.selectionStart;
    const val = docEditor.value;
    const lineStart = val.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    let lineEnd = val.indexOf("\n", start);
    if (lineEnd === -1) lineEnd = val.length;
    const line = val.slice(lineStart, lineEnd);
    const m = line.match(/^(#{1,3})\s+(.*)$/);
    const next = m
      ? (m[1].length < 3 ? `${"#".repeat(m[1].length + 1)} ${m[2]}` : m[2])
      : `# ${line.replace(/^#{1,6}\s+/, "")}`;
    docEditor.value = val.slice(0, lineStart) + next + val.slice(lineEnd);
    docEditor.focus();
    docEditor.setSelectionRange(lineStart + next.length, lineStart + next.length);
    updateDirtyState();
    scheduleDraftSave();
    renderDocContent(docEditor.value);
  }
  else if (fmt === "bold") wrapEditorSelection("**", "**", "粗体");
  else if (fmt === "italic") wrapEditorSelection("*", "*", "斜体");
  else if (fmt === "strike") wrapEditorSelection("~~", "~~", "删除内容");
  else if (fmt === "highlight") wrapEditorSelection("==", "==", "高亮内容");
  else if (fmt === "code") wrapEditorSelection("`", "`", "code");
  else if (fmt === "codeblock") wrapEditorSelection("```python\n", "\n```\n", "print('hello')");
  else if (fmt === "link") wrapEditorSelection("[", "](https://)", "链接文字");
  else if (fmt === "wikilink") wrapEditorSelection("[[", "]]", "笔记名称");
  else if (fmt === "task") wrapEditorSelection("- [ ] ", "", "待办事项");
  else if (fmt === "ul") wrapEditorSelection("- ", "", "列表项");
  else if (fmt === "ol") wrapEditorSelection("1. ", "", "编号列表项");
  else if (fmt === "table") wrapEditorSelection("| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n| 内容 1 | 内容 2 | 内容 3 |\n", "", "");
  else if (fmt === "callout") wrapEditorSelection("> [!note] 标题\n> ", "", "内容");
  else if (fmt === "img") wrapEditorSelection("![图片说明](assets/", ")", "diagram.svg");
  else if (fmt === "math") wrapEditorSelection("$$", "$$", "E = mc^2");
  else if (fmt === "mermaid") wrapEditorSelection("```mermaid\nflowchart LR\n    A[开始] --> B[结束]\n```\n", "", "");
  else if (fmt === "toc") wrapEditorSelection("[TOC]\n\n", "", "");
  else if (fmt === "hr") wrapEditorSelection("\n---\n\n", "", "");
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

function renderLinksPanelData(data) {
  if (!data) return;
  const en = isEnLocale();
  const broken = Array.isArray(data.brokenLinks) ? data.brokenLinks : [];
  const ambig = Array.isArray(data.ambiguousTargets) ? data.ambiguousTargets : [];
  linksSummary.textContent = en
    ? `${broken.length} broken · ${ambig.length} ambiguous`
    : `${broken.length} 断链 · ${ambig.length} 重名`;
  setBadge(badgeLinks, broken.length + ambig.length);
  while (linksList.firstChild) linksList.removeChild(linksList.firstChild);

  if (broken.length === 0 && ambig.length === 0) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = en ? "No broken or ambiguous links found." : "未发现失效链接或重名双链。";
    linksList.appendChild(p);
    return;
  }

  if (broken.length > 0) {
    const h1 = document.createElement("div");
    h1.className = "links-section-title";
    h1.textContent = en ? `Broken Links (${broken.length})` : `失效链接 (${broken.length})`;
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
      snip.textContent = en ? `Source: ${item.sourcePath}:${item.line}` : `来源：${item.sourcePath}:${item.line}`;
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
    h2.textContent = en ? `Ambiguous Wikilinks (${ambig.length})` : `同名多匹配双链 (${ambig.length})`;
    linksList.appendChild(h2);

    for (const group of ambig) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "file-item search-hit";
      const t = document.createElement("span");
      t.className = "file-name";
      t.textContent = en
        ? `[[${group.key}]] (${group.candidates.length} candidates)`
        : `[[${group.key}]] (${group.candidates.length} 个候选)`;
      btn.appendChild(t);
      const m = document.createElement("span");
      m.className = "hit-snippet";
      m.textContent = group.candidates.join(" · ");
      btn.appendChild(m);
      btn.addEventListener("click", () => openDisambigModal(group.key, group.candidates, ""));
      linksList.appendChild(btn);
    }
  }
}

async function loadLinksPanel() {
  try {
    const result = await callScopedTool("inspect_project_links", {});
    if (result.isError) throw new Error(result.content?.[0]?.text || "巡检失败");
    const data = result.structuredContent || JSON.parse(result.content[0].text);
    cachedLinksData = data;
    renderLinksPanelData(data);
  } catch (err) {
    linksSummary.textContent = isEnLocale() ? "Failed" : "巡检失败";
    showBanner(`${isEnLocale() ? "Link inspect failed" : "链接巡检失败"}: ${err.message}`, true);
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
    cleanupOfficeViewer();
    updateDocWorkspacePill("");
    docViewer.hidden = true;
    docEmpty.hidden = false;
    setSidebarOpen(true);
    currentFilePath = "";
    isDirty = false;
    activeDraftExceedsQuota = false;
    restoredFromDraft = false;
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
  if (store.ui.docMode === "split" && store.ui.splitScrollLock !== false && !isScrollSyncing) {
    const denom = Math.max(1, previewPane.scrollHeight - previewPane.clientHeight);
    const ratio = previewPane.scrollTop / denom;
    const targetMax = Math.max(0, docEditor.scrollHeight - docEditor.clientHeight);
    isScrollSyncing = true;
    docEditor.scrollTop = Math.round(ratio * targetMax);
    requestAnimationFrame(() => { isScrollSyncing = false; });
  }
  if (scrollSpyRaf) return;
  scrollSpyRaf = requestAnimationFrame(() => {
    scrollSpyRaf = 0;
    updateActiveOutlineItem();
  });
});

docEditor.addEventListener("scroll", () => {
  positionEditorHighlight();
  if (store.ui.docMode === "split" && store.ui.splitScrollLock !== false && !isScrollSyncing) {
    const denom = Math.max(1, docEditor.scrollHeight - docEditor.clientHeight);
    const ratio = docEditor.scrollTop / denom;
    const targetMax = Math.max(0, previewPane.scrollHeight - previewPane.clientHeight);
    isScrollSyncing = true;
    previewPane.scrollTop = Math.round(ratio * targetMax);
    requestAnimationFrame(() => { isScrollSyncing = false; });
  }
});

docEditor.addEventListener("keyup", updateEditorStatusbar);
docEditor.addEventListener("click", updateEditorStatusbar);
docEditor.addEventListener("select", updateEditorStatusbar);
docEditor.addEventListener("focus", updateEditorStatusbar);

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
  } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "h") {
    if (!docViewer.hidden) {
      event.preventDefault();
      findBar.open("", null, true);
    }
  } else if (event.altKey && event.key === "ArrowLeft") {
    event.preventDefault();
    if (typeof navigateHistory === "function") navigateHistory(-1);
  } else if (event.altKey && event.key === "ArrowRight") {
    event.preventDefault();
    if (typeof navigateHistory === "function") navigateHistory(1);
  } else if (event.key === "Escape") {
    if (activeSlidesHandle) {
      return;
    } else if (focusMode) {
      setFocusMode(false);
    } else if (!lightboxModal.hidden) {
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

if (splitScrollLockBtn) {
  splitScrollLockBtn.classList.toggle("active", store.ui.splitScrollLock !== false);
}
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
if (graphExportSvgBtn) graphExportSvgBtn.addEventListener("click", async () => {
  if (!graphHandle) return;
  const svgXml = graphHandle.serializeSvg();
  if (!svgXml) {
    showBanner("当前环境无法导出 SVG。", true);
    return;
  }
  if (encoder.encode(svgXml).length > MAX_READ_BYTES) {
    showBanner("导出的 SVG 文件超过 512 KiB 上限，无法保存。", true);
    return;
  }
  const svgName = `${(currentProjectName || "markdown").replace(/[^A-Za-z0-9_-]/g, "_")}-graph.svg`;
  const targetWs = discoveredWorkspaces[0] || currentProjectName;
  const targetPath = getActiveScope() === "all" && targetWs ? `${targetWs}/exports/${svgName}` : `exports/${svgName}`;
  try {
    const res = await callScopedTool("save_exported_file", { path: targetPath, content: svgXml });
    if (res.isError) throw new Error(res.content?.[0]?.text || "导出 SVG 失败");
    const out = res.structuredContent || JSON.parse(res.content[0].text);
    if (!out || out.saved !== true) {
      throw new Error("导出 SVG 未确认保存成功");
    }
    showToast(`已导出 SVG 图谱至 ${out.path}`);
  } catch (err) {
    showBanner(`导出 SVG 失败: ${err.message}`, true);
  }
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

  const en = isEnLocale();
  const cards = [
    { key: "all", label: en ? "All Tasks" : "全部任务", count: stats.total, alert: false },
    { key: "todo", label: en ? "○ To Do" : "○ 待开始", count: stats.todo, alert: false },
    { key: "doing", label: en ? "◐ Doing" : "◐ 进行中", count: stats.doing, alert: false },
    { key: "review", label: en ? "◈ Review" : "◈ 待验收", count: stats.review, alert: false },
    { key: "done", label: en ? "✓ Done" : "✓ 已完成", count: stats.done, alert: false },
    { key: "high", label: en ? "🔥 High P1" : "🔥 高优 P1", count: stats.high, alert: stats.high > 0 },
    { key: "due", label: en ? "⏰ Overdue / Today" : "⏰ 逾期 / 今日", count: stats.dueAlert, alert: stats.dueAlert > 0 },
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
    locale: getEffectiveLocale(),
    columnBy: kp.columnBy || "status",
    swimlaneBy: kp.swimlaneBy || "none",
    filterQuery: kanbanFilterInput ? kanbanFilterInput.value : "",
    quickFilter: kp.quickFilter || "all",
    today,
    collapsedLanes: collapsedKanbanLanes,
    viewMode: kanbanViewMode,
    calendarMonth: kanbanCalendarMonth,
    onMonthChange: (nextMonth) => {
      kanbanCalendarMonth = nextMonth;
      renderKanbanFromCache();
    },
    onRenameTask: async (task, cleanText) => {
      const ok = await applyTaskMetaPatch(task, { cleanText });
      if (ok) showToast(`已重命名任务 ${task.path}:${task.line}`);
    },
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

function updateNtWorkspaceHint() {
  if (!ntWorkspaceHint || !ntFile) return;
  const val = ntFile.value || "";
  if (!val) {
    ntWorkspaceHint.textContent = "";
    return;
  }
  const { workspace, innerPath } = splitWorkspaceRelPath(val);
  ntWorkspaceHint.textContent = `目标工作区：${workspace} · 写入路径：${innerPath}`;
}

function openNewTaskModal() {
  if (!newTaskModal) return;
  const mdFiles = allFiles.filter((f) => isMarkdownPath(f.path) && f.bytes <= MAX_READ_BYTES);
  if (mdFiles.length === 0) {
    showBanner("当前项目暂无可写入的 Markdown 文档，无法新建待办。", true);
    return;
  }
  while (ntFile.firstChild) ntFile.removeChild(ntFile.firstChild);
  for (const f of mdFiles) {
    const { workspace, innerPath } = splitWorkspaceRelPath(f.path);
    const opt = document.createElement("option");
    opt.value = f.path;
    opt.textContent = `[${workspace}] ${innerPath}`;
    ntFile.appendChild(opt);
  }
  if (currentFilePath && mdFiles.some((f) => f.path === currentFilePath)) {
    ntFile.value = currentFilePath;
  }
  updateNtWorkspaceHint();
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

if (ntFile) ntFile.addEventListener("change", updateNtWorkspaceHint);

// Scope Switcher & Kanban Workbench Events
async function switchWorkspaceScope(nextScope) {
  const norm = nextScope === "all" ? "all" : "project";
  if (getActiveScope() === norm) return;
  guardUnsavedAction(async () => {
    cleanupOfficeViewer();
    updateDocWorkspacePill("");
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

let hostLocaleHint = "";
function getEffectiveLocale() {
  return resolveEffectiveLocale(store?.ui?.locale, hostLocaleHint);
}
function isEnLocale() {
  return getEffectiveLocale() === "en";
}
function applyLocaleUI() {
  const eff = getEffectiveLocale();
  applyI18n(document, eff);
  applyScopeUI();
  renderFileList();
  updateDocWorkspacePill(currentFilePath);
  updateEditorStatusbar();
  if (cachedLinksData) renderLinksPanelData(cachedLinksData);
  if (kanbanOpen) renderKanbanFromCache();
  if (graphOpen) {
    renderGraphFromCache();
    if (selectedGraphNode) renderGraphNodeCard(selectedGraphNode);
  }
}

if (langToggleBtn) {
  langToggleBtn.addEventListener("click", () => {
    const cur = resolveEffectiveLocale(store?.ui?.locale, hostLocaleHint);
    store.ui.locale = cur === "en" ? "zh-CN" : "en";
    applyLocaleUI();
    schedulePersistState();
    showToast(store.ui.locale === "en" ? "Switched UI language to English" : "已切换界面语言为简体中文");
  });
}

initializeHost().then(
  async (result) => {
    store = hydrateStore(result && result.state);
    hostLocaleHint = (result && (result.locale || result.language)) || "";
    applyLocaleUI();
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

// ==========================================================================
// 1.8.0 Full-Stack Productivity Enhancements
// ==========================================================================
let kanbanViewMode = "board";
let kanbanCalendarMonth = getTodayIso().slice(0, 7);
const openTabs = [];
const pinnedTabs = new Set();
const historyStack = [];
let historyIndex = -1;

const histBackBtn = el("hist-back-btn");
const histFwdBtn = el("hist-fwd-btn");
const docTabsList = el("doc-tabs-list");
const exportHtmlBtn = el("export-html-btn");
const newDocBtn = el("new-doc-btn");
const newDocModal = el("new-doc-modal");
const ndWorkspaceSel = el("nd-workspace");
const ndPathInput = el("nd-path");
const ndFullPreview = el("nd-full-preview");
const ndTemplateSel = el("nd-template");
const ndCancelBtn = el("nd-cancel-btn");
const ndCreateBtn = el("nd-create-btn");
const renameDocBtn = el("rename-doc-btn");
const renameDocModal = el("rename-doc-modal");
const rdWorkspaceHint = el("rd-workspace-hint");
const rdNewPathInput = el("rd-new-path");
const rdUpdateLinksChk = el("rd-update-links");
const rdCancelBtn = el("rd-cancel-btn");
const rdConfirmBtn = el("rd-confirm-btn");
const batchReplaceToggle = el("batch-replace-toggle");
const batchReplaceBox = el("batch-replace-box");
const batchReplaceInput = el("batch-replace-input");
const batchReplaceBtn = el("batch-replace-btn");
const kanbanModeBoardBtn = el("kanban-mode-board");
const kanbanModeCalBtn = el("kanban-mode-calendar");

function renderDocTabs() {
  if (!docTabsList) return;
  while (docTabsList.firstChild) docTabsList.removeChild(docTabsList.firstChild);
  for (const path of openTabs) {
    const tab = document.createElement("div");
    tab.className = "doc-tab" + (path === currentFilePath ? " active" : "");
    tab.setAttribute("role", "tab");
    tab.title = path;

    const pinBtn = document.createElement("button");
    pinBtn.type = "button";
    pinBtn.className = "doc-tab-pin";
    pinBtn.textContent = pinnedTabs.has(path) ? "📌" : "·";
    pinBtn.title = pinnedTabs.has(path) ? "取消固定" : "固定标签页";
    pinBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (pinnedTabs.has(path)) pinnedTabs.delete(path);
      else pinnedTabs.add(path);
      renderDocTabs();
    });
    tab.appendChild(pinBtn);

    const label = document.createElement("span");
    const dirtyDot = hasDraftForFile(store, currentProjectName, path) ? "● " : "";
    label.textContent = dirtyDot + path.split("/").pop();
    tab.appendChild(label);

    if (!pinnedTabs.has(path)) {
      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "doc-tab-close";
      closeBtn.textContent = "×";
      closeBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const idx = openTabs.indexOf(path);
        if (idx !== -1) openTabs.splice(idx, 1);
        if (path === currentFilePath) {
          if (openTabs.length > 0) {
            const nextPath = openTabs[Math.min(idx, openTabs.length - 1)];
            guardUnsavedAction(() => openProjectFile(nextPath));
          } else {
            backBtn.click();
          }
        } else {
          renderDocTabs();
        }
      });
      tab.appendChild(closeBtn);
    }

    tab.addEventListener("click", () => {
      if (path !== currentFilePath) {
        guardUnsavedAction(() => openProjectFile(path));
      }
    });
    docTabsList.appendChild(tab);
  }
  if (histBackBtn) histBackBtn.disabled = historyIndex <= 0;
  if (histFwdBtn) histFwdBtn.disabled = historyIndex < 0 || historyIndex >= historyStack.length - 1;
}

function recordTabAndHistory(path, skipHistory) {
  if (!path) return;
  if (!openTabs.includes(path)) openTabs.push(path);
  if (!skipHistory) {
    if (historyStack[historyIndex] !== path) {
      historyStack.splice(historyIndex + 1);
      historyStack.push(path);
      historyIndex = historyStack.length - 1;
    }
  }
  renderDocTabs();
}

function navigateHistory(delta) {
  const nextIdx = historyIndex + delta;
  if (nextIdx < 0 || nextIdx >= historyStack.length) return;
  const target = historyStack[nextIdx];
  guardUnsavedAction(() => {
    historyIndex = nextIdx;
    openProjectFile(target, { skipHistory: true });
  });
}

if (histBackBtn) histBackBtn.addEventListener("click", () => navigateHistory(-1));
if (histFwdBtn) histFwdBtn.addEventListener("click", () => navigateHistory(1));

function buildDocTemplate(tpl, path) {
  const title = path.split("/").pop().replace(/\.(md|markdown|mdx)$/i, "") || "新文档";
  const today = getTodayIso();
  if (tpl === "card") {
    return `# 🚧 进行中：${title}\n\n**需求** 简述本卡片的目标与背景。\n\n## 验收条件\n\n- [ ] 完成核心实现与自测 P1 📅 ${today} @dp status:todo\n`;
  }
  if (tpl === "meeting") {
    return `---\ntitle: ${title}\ndate: ${today}\ntags: [meeting]\n---\n\n# 📋 ${title}\n\n## 议题记录\n\n- \n\n## 行动项\n\n- [ ] 跟进待办事项 P1 📅 ${today} @dp status:todo\n`;
  }
  if (tpl === "adr") {
    return `---\ntitle: ${title}\ndate: ${today}\ntags: [adr, architecture]\n---\n\n# 🏛 ${title}\n\n## 背景与问题\n\n## 方案设计\n\n\`\`\`mermaid\nflowchart LR\n  A[请求] --> B[处理] --> C[落盘]\n\`\`\`\n\n## 决策与影响\n`;
  }
  if (tpl === "weekly") {
    return `---\ntitle: ${title}\ndate: ${today}\ntags: [weekly]\n---\n\n# 📊 ${title}\n\n## 本周完成\n\n- \n\n## 风险与阻塞\n\n- \n\n## 下周计划\n\n- [ ] 推进下一阶段目标 P2 📅 ${today} status:todo\n`;
  }
  return `---\ntitle: ${title}\ndate: ${today}\n---\n\n# ${title}\n\n`;
}

function computeNewDocInnerPath(chosenWs) {
  let raw = (ndPathInput.value || "").trim().replace(/^\/+/, "");
  if (chosenWs && raw.startsWith(`${chosenWs}/`)) {
    raw = raw.slice(chosenWs.length + 1);
  }
  if (raw && !/\.(md|markdown|mdx)$/i.test(raw)) raw += ".md";
  return raw;
}

function updateNewDocPreview() {
  if (!ndFullPreview) return;
  const ws = (ndWorkspaceSel && ndWorkspaceSel.value) || currentProjectName || "当前工作区";
  const inner = computeNewDocInnerPath(ws);
  const tag = ws === currentProjectName ? "主工作区" : "挂载工作区";
  ndFullPreview.textContent = inner
    ? `完整新建位置：[${ws} · ${tag}] / ${inner}`
    : `目标工作区：[${ws} · ${tag}]`;
}

function openNewDocModal(prefillPath = "") {
  if (!newDocModal) return;
  const wsList = discoveredWorkspaces.length > 0 ? discoveredWorkspaces : [currentProjectName || "project"];
  if (ndWorkspaceSel) {
    while (ndWorkspaceSel.firstChild) ndWorkspaceSel.removeChild(ndWorkspaceSel.firstChild);
    for (const ws of wsList) {
      const opt = document.createElement("option");
      opt.value = ws;
      opt.textContent = ws === currentProjectName ? `${ws}（当前主工作区）` : ws;
      ndWorkspaceSel.appendChild(opt);
    }
  }
  let initialWs = currentFilePath ? splitWorkspaceRelPath(currentFilePath).workspace : (currentProjectName || wsList[0]);
  let initialPath = prefillPath || `docs/note-${getTodayIso()}.md`;
  if (prefillPath && prefillPath.includes("/")) {
    const firstSeg = prefillPath.split("/", 1)[0];
    if (wsList.includes(firstSeg)) {
      initialWs = firstSeg;
      initialPath = prefillPath.slice(firstSeg.length + 1);
    }
  }
  if (ndWorkspaceSel && wsList.includes(initialWs)) {
    ndWorkspaceSel.value = initialWs;
  }
  ndPathInput.value = initialPath;
  updateNewDocPreview();
  newDocModal.hidden = false;
  ndPathInput.focus();
  ndPathInput.select();
}

if (ndWorkspaceSel) ndWorkspaceSel.addEventListener("change", updateNewDocPreview);
if (ndPathInput) ndPathInput.addEventListener("input", updateNewDocPreview);
if (newDocBtn) newDocBtn.addEventListener("click", () => openNewDocModal());
if (ndCancelBtn) ndCancelBtn.addEventListener("click", () => { newDocModal.hidden = true; });
if (ndCreateBtn) {
  ndCreateBtn.addEventListener("click", async () => {
    const chosenWs = (ndWorkspaceSel && ndWorkspaceSel.value) || currentProjectName || "project";
    const innerPath = computeNewDocInnerPath(chosenWs);
    if (!innerPath) return;
    const crossWs = chosenWs !== currentProjectName || getActiveScope() === "all";
    const apiPath = crossWs ? `${chosenWs}/${innerPath}` : innerPath;
    const content = buildDocTemplate(ndTemplateSel.value, innerPath);
    try {
      const args = {
        path: apiPath,
        content,
        createDirs: true,
        ...(crossWs ? { scope: "all" } : {}),
      };
      const res = await request("tools/call", { name: "save_markdown_file", arguments: args });
      if (res.isError) throw new Error(res.content?.[0]?.text || "创建失败");
      if (crossWs && getActiveScope() !== "all") {
        store.ui.workspaceScope = "all";
        applyScopeUI();
      }
      newDocModal.hidden = true;
      await loadFiles();
      await openProjectFile(apiPath);
      showToast(`已在工作区「${chosenWs}」创建 ${innerPath}`);
    } catch (err) {
      showBanner(`创建文档失败: ${err.message}`, true);
    }
  });
}

if (renameDocBtn && renameDocModal) {
  renameDocBtn.addEventListener("click", () => {
    if (!currentFilePath) return;
    if (rdWorkspaceHint) {
      const { workspace, innerPath } = splitWorkspaceRelPath(currentFilePath);
      rdWorkspaceHint.textContent = getActiveScope() === "all"
        ? `当前所属工作区：${workspace}（跨工作区移动须保留或修改 <工作区>/ 前缀）`
        : `当前所属工作区：${workspace} · 当前路径：${innerPath}`;
    }
    rdNewPathInput.value = currentFilePath;
    renameDocModal.hidden = false;
    rdNewPathInput.focus();
    rdNewPathInput.select();
  });
  rdCancelBtn.addEventListener("click", () => { renameDocModal.hidden = true; });
  rdConfirmBtn.addEventListener("click", async () => {
    const newPath = (rdNewPathInput.value || "").trim();
    if (!newPath || newPath === currentFilePath) {
      renameDocModal.hidden = true;
      return;
    }
    try {
      const res = await callScopedTool("rename_markdown_file", {
        oldPath: currentFilePath,
        newPath,
        updateLinks: Boolean(rdUpdateLinksChk.checked),
      });
      if (res.isError) throw new Error(res.content?.[0]?.text || "重命名失败");
      const out = res.structuredContent || JSON.parse(res.content[0].text);
      const tabIdx = openTabs.indexOf(currentFilePath);
      if (tabIdx !== -1) openTabs[tabIdx] = out.newPath;
      renameDocModal.hidden = true;
      await loadFiles();
      await openProjectFile(out.newPath);
      showToast(`已移动至 ${out.newPath}${out.updatedCount ? `（同步更新 ${out.updatedCount} 篇引用）` : ""}`);
    } catch (err) {
      showBanner(`重命名失败: ${err.message}`, true);
    }
  });
}

if (batchReplaceToggle && batchReplaceBox) {
  batchReplaceToggle.addEventListener("click", () => {
    batchReplaceBox.hidden = !batchReplaceBox.hidden;
    batchReplaceToggle.classList.toggle("active", !batchReplaceBox.hidden);
  });
}

if (batchReplaceBtn) {
  batchReplaceBtn.addEventListener("click", async () => {
    const query = (fulltextInput.value || "").trim();
    const replacement = batchReplaceInput.value || "";
    if (!query) {
      showBanner("请先输入搜索关键字后再执行批量替换。", true);
      return;
    }
    try {
      const args = buildBatchReplaceArgs({
        query,
        replacement,
        caseSensitive: searchCaseSensitive,
        wholeWord: searchWholeWord,
        regex: searchRegex,
        pathPrefix: searchPathPrefix,
        tags: [...selectedTags],
      });
      const res = await callScopedTool("replace_in_markdown_files", args);
      if (res.isError) throw new Error(res.content?.[0]?.text || "批量替换失败");
      const out = res.structuredContent || JSON.parse(res.content[0].text);
      showToast(
        out.totalReplacements > 0
          ? `已替换 ${out.replacedFiles.length} 个文件，共 ${out.totalReplacements} 处`
          : "当前搜索范围内未找到可替换内容",
      );
      await runFulltextSearch(query);
      if (currentFilePath && out.replacedFiles.some((f) => f.path === currentFilePath)) {
        await openProjectFile(currentFilePath, { ignoreDraft: true, preserveView: true });
      }
    } catch (err) {
      showBanner(`批量替换失败: ${err.message}`, true);
    }
  });
}

if (exportHtmlBtn) {
  exportHtmlBtn.addEventListener("click", async () => {
    if (!currentFilePath && docViewer.hidden) {
      showToast("请先打开一篇文档再导出 HTML");
      return;
    }
    const { filename, html } = buildStandaloneHtml(currentFilePath || "markdown-export", docContent);
    if (encoder.encode(html).length > MAX_READ_BYTES) {
      showBanner("导出的 HTML 文件超过 512 KiB 上限，无法保存。", true);
      return;
    }
    const targetWs = currentFilePath && currentFilePath.includes("/")
      ? splitWorkspaceRelPath(currentFilePath).workspace
      : (discoveredWorkspaces[0] || currentProjectName);
    const targetPath = getActiveScope() === "all" && targetWs ? `${targetWs}/exports/${filename}` : `exports/${filename}`;
    try {
      const res = await callScopedTool("save_exported_file", { path: targetPath, content: html });
      if (res.isError) throw new Error(res.content?.[0]?.text || "导出 HTML 失败");
      const out = res.structuredContent || JSON.parse(res.content[0].text);
      if (!out || out.saved !== true) {
        throw new Error("导出 HTML 未确认保存成功");
      }
      showToast(`已导出 HTML 至 ${out.path}`);
    } catch (err) {
      showBanner(`导出 HTML 失败: ${err.message}`, true);
    }
  });
}

if (kanbanModeBoardBtn && kanbanModeCalBtn) {
  kanbanModeBoardBtn.addEventListener("click", () => {
    kanbanViewMode = "board";
    kanbanModeBoardBtn.classList.add("active");
    kanbanModeCalBtn.classList.remove("active");
    renderKanbanFromCache();
  });
  kanbanModeCalBtn.addEventListener("click", () => {
    kanbanViewMode = "calendar";
    kanbanModeCalBtn.classList.add("active");
    kanbanModeBoardBtn.classList.remove("active");
    renderKanbanFromCache();
  });
}

attachEditorAssist({
  textarea: docEditor,
  popupEl: el("editor-ac-popup"),
  getFiles: () => allFiles.filter((f) => isMarkdownPath(f.path)),
  getTags: () => cachedTags,
  getAssignees: () => [...new Set((cachedAllTasks || []).map((t) => t.assignee).filter(Boolean))],
  getCurrentHeadings: () => currentHeadings,
  getNoteHeadings: (targetDoc) => {
    const targetPath = resolveWikilinkCandidates(targetDoc)[0];
    if (!targetPath) return [];
    const cached = transcludeCache.get(targetPath);
    if (typeof cached === "string") {
      return extractHeadingsFromMarkdown(cached);
    }
    callScopedTool("read_markdown_file", { path: targetPath }).then((res) => {
      if (!res.isError) {
        const d = res.structuredContent || { content: res.content?.[0]?.text || "" };
        transcludeCache.set(targetPath, String(d.content || ""));
      }
    }).catch(() => {});
    return [];
  },
  onChanged: () => {
    updateDirtyState();
    scheduleDraftSave();
    renderDocContent(docEditor.value);
  },
  onImageFile: (file) => {
    if (!currentFilePath) return;
    if (typeof file.size === "number" && file.size > MAX_ASSET_UPLOAD_BYTES) {
      showBanner("图片超过 512 KiB 上传限制，无法内联保存。", true);
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = String(reader.result || "");
      const b64 = dataUrl.includes(",") ? dataUrl.split(",", 2)[1] : "";
      if (!b64) return;
      const estimatedBytes = Math.floor((b64.length * 3) / 4);
      if (estimatedBytes > MAX_ASSET_UPLOAD_BYTES) {
        showBanner("图片超过 512 KiB 上传限制，无法内联保存。", true);
        return;
      }
      try {
        const res = await callScopedTool("save_markdown_asset", {
          docPath: currentFilePath,
          filename: file.name || "pasted.png",
          data: b64,
        });
        if (res.isError) throw new Error(res.content?.[0]?.text || "保存图片失败");
        const out = res.structuredContent || JSON.parse(res.content[0].text);
        const start = docEditor.selectionStart;
        const snippet = `![${file.name || "图片"}](${out.assetHref})`;
        docEditor.value = docEditor.value.slice(0, start) + snippet + docEditor.value.slice(docEditor.selectionEnd);
        updateDirtyState();
        scheduleDraftSave();
        renderDocContent(docEditor.value);
        showToast(`已保存图片至 ${out.assetHref}`);
      } catch (err) {
        showBanner(`保存图片失败: ${err.message}`, true);
      }
    };
    reader.readAsDataURL(file);
  },
});

// ==========================================================================
// M1/M4/M5 Productivity Actions (Slides, Scroll Lock, Focus, Daily, Random)
// ==========================================================================
function setFocusMode(enabled) {
  focusMode = Boolean(enabled);
  document.body.classList.toggle("focus-mode", focusMode);
  if (focusModeBtn) focusModeBtn.classList.toggle("active", focusMode);
  if (focusExitBtn) focusExitBtn.hidden = !focusMode;
}

if (focusModeBtn) focusModeBtn.addEventListener("click", () => setFocusMode(!focusMode));
if (focusExitBtn) focusExitBtn.addEventListener("click", () => setFocusMode(false));

if (splitScrollLockBtn) {
  splitScrollLockBtn.addEventListener("click", () => {
    store.ui.splitScrollLock = store.ui.splitScrollLock === false;
    splitScrollLockBtn.classList.toggle("active", store.ui.splitScrollLock !== false);
    schedulePersistState();
    showToast(store.ui.splitScrollLock ? "已锁定分栏相对滚动同步" : "已解除分栏滚动锁定");
  });
}

function closeSlidesModal() {
  if (activeSlidesHandle && typeof activeSlidesHandle.destroy === "function") {
    activeSlidesHandle.destroy();
  }
  activeSlidesHandle = null;
  if (slidesModal) {
    while (slidesModal.firstChild) slidesModal.removeChild(slidesModal.firstChild);
    slidesModal.hidden = true;
  }
}

function openSlidesModal() {
  if (!slidesModal || !currentFilePath || !isMarkdownPath(currentFilePath)) return;
  const src = docEditor.value || savedFileContent || "";
  closeSlidesModal();
  slidesModal.hidden = false;
  activeSlidesHandle = renderSlidesDeck(slidesModal, src, {
    document,
    onCopy: (code) => {
      copyText(code, "已复制代码块");
      showToast("已复制代码块");
    },
    onAssetMount: (figureEl, assetHref, alt) => {
      assetLoader.mountProjectImage(figureEl, currentFilePath, assetHref, alt, openLightbox);
    },
    onClose: closeSlidesModal,
  });
}

if (slidesModeBtn) slidesModeBtn.addEventListener("click", openSlidesModal);

const dailyNoteBtn = el("daily-note-btn");
const randomNoteBtn = el("random-note-btn");

async function openDailyNote() {
  const today = getTodayIso();
  const activeWs = currentFilePath ? splitWorkspaceRelPath(currentFilePath).workspace : (currentProjectName || "");
  const isCross = getActiveScope() === "all" && activeWs;
  const relInner = `journal/${today}.md`;
  const targetPath = isCross ? `${activeWs}/${relInner}` : relInner;

  if (allFiles.some((f) => f.path === targetPath)) {
    guardUnsavedAction(() => openProjectFile(targetPath));
    return;
  }
  const tpl = `---\ntitle: ${today} 工作日志\ndate: ${today}\ntags: [daily, journal]\n---\n\n# 📅 ${today} 工作日志\n\n## 今日聚焦\n\n- [ ] 梳理今日核心推进事项 P1 📅 ${today} status:doing\n\n## 进展与记录\n\n- \n\n## 明日计划\n\n- \n`;
  try {
    const res = await callScopedTool("save_markdown_file", {
      path: targetPath,
      content: tpl,
      createDirs: true,
    });
    if (res.isError) throw new Error(res.content?.[0]?.text || "创建日记失败");
    await loadFiles();
    await openProjectFile(targetPath);
    showToast(`已打开今日日记：${targetPath}`);
  } catch (err) {
    showBanner(`创建今日日记失败: ${err.message}`, true);
  }
}

function openRandomNote() {
  const mdPool = allFiles.filter((f) => isMarkdownPath(f.path));
  if (mdPool.length === 0) {
    showBanner("当前工作区暂无 Markdown 笔记。", true);
    return;
  }
  const choices = mdPool.length > 1 ? mdPool.filter((f) => f.path !== currentFilePath) : mdPool;
  const picked = choices[Math.floor(Math.random() * choices.length)];
  if (!picked) return;
  guardUnsavedAction(() => openProjectFile(picked.path));
}

if (dailyNoteBtn) dailyNoteBtn.addEventListener("click", openDailyNote);
if (randomNoteBtn) randomNoteBtn.addEventListener("click", openRandomNote);

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", (event) => {
    if (isDirty && currentFilePath && !currentFileReadOnly && activeDraftExceedsQuota) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
}
