const MAX_STATE_BYTES = 56 * 1024;
const MAX_SNIPPET_BYTES = 24 * 1024;
const encoder = new TextEncoder();

export function createInitialGraphSettings() {
  return {
    layout: "force",
    colorBy: "dir",
    localDepth: 1,
    linkDirection: "both",
    showOrphans: true,
    showGhosts: true,
    showTags: false,
    showArrows: true,
    smartLabels: false,
    animatePhysics: true,
    repel: 130,
    linkDist: 145,
    gravity: 10,
    nodeScale: 100,
  };
}

export function createInitialStore() {
  return {
    version: 2,
    ui: {
      activeTab: "files",
      railTab: "tree",
      sidebarOpen: true,
      treeMode: true,
      docMode: "read",
      splitScrollLock: true,
      outlineOpen: true,
      themeMode: "system",
      locale: "auto",
      workspaceScope: "project",
      taskGroupBy: "none",
      sidebarWidth: 276,
      outlineWidth: 210,
      splitRatio: 50,
      snippetRatio: 50,
      graph: createInitialGraphSettings(),
      search: {
        grouped: true,
        context: false,
        sortBy: "relevance",
        history: [],
      },
      kanban: {
        columnBy: "status",
        swimlaneBy: "none",
        quickFilter: "all",
      },
    },
    projects: {},
    drafts: {},
    snippet: "",
  };
}

export function hydrateStore(raw) {
  const base = createInitialStore();
  if (!raw || typeof raw !== "object") return base;

  if (raw.version === 2) {
    if (raw.ui && typeof raw.ui === "object") {
      base.ui.activeTab = raw.ui.activeTab === "snippet" ? "snippet" : "files";
      base.ui.railTab = ["tree", "search", "tags", "tasks", "kanban", "links", "graph"].includes(raw.ui.railTab) ? raw.ui.railTab : "tree";
      base.ui.sidebarOpen = raw.ui.sidebarOpen !== false;
      base.ui.treeMode = raw.ui.treeMode !== false;
      base.ui.docMode = ["read", "split", "edit"].includes(raw.ui.docMode) ? raw.ui.docMode : "read";
      base.ui.splitScrollLock = raw.ui.splitScrollLock !== false;
      base.ui.outlineOpen = raw.ui.outlineOpen !== false;
      base.ui.themeMode = ["system", "light", "dark"].includes(raw.ui.themeMode) ? raw.ui.themeMode : "system";
      base.ui.locale = ["auto", "zh-CN", "en"].includes(raw.ui.locale) ? raw.ui.locale : "auto";
      base.ui.workspaceScope = raw.ui.workspaceScope === "all" ? "all" : "project";
      base.ui.taskGroupBy = ["none", "status", "file", "priority", "assignee", "due", "group", "color"].includes(raw.ui.taskGroupBy)
        ? raw.ui.taskGroupBy
        : "none";
      if (typeof raw.ui.sidebarWidth === "number" && Number.isFinite(raw.ui.sidebarWidth)) {
        base.ui.sidebarWidth = Math.max(180, Math.min(560, Math.round(raw.ui.sidebarWidth)));
      }
      if (typeof raw.ui.outlineWidth === "number" && Number.isFinite(raw.ui.outlineWidth)) {
        base.ui.outlineWidth = Math.max(150, Math.min(420, Math.round(raw.ui.outlineWidth)));
      }
      if (typeof raw.ui.splitRatio === "number" && Number.isFinite(raw.ui.splitRatio)) {
        base.ui.splitRatio = Math.max(20, Math.min(80, Math.round(raw.ui.splitRatio)));
      }
      if (typeof raw.ui.snippetRatio === "number" && Number.isFinite(raw.ui.snippetRatio)) {
        base.ui.snippetRatio = Math.max(20, Math.min(80, Math.round(raw.ui.snippetRatio)));
      }
      if (raw.ui.graph && typeof raw.ui.graph === "object") {
        const g = raw.ui.graph;
        const dst = base.ui.graph;
        if (["force", "radial", "hierarchy"].includes(g.layout)) dst.layout = g.layout;
        if (["dir", "degree", "tag"].includes(g.colorBy)) dst.colorBy = g.colorBy;
        if ([1, 2, 3].includes(Number(g.localDepth))) dst.localDepth = Number(g.localDepth);
        if (["both", "in", "out"].includes(g.linkDirection)) dst.linkDirection = g.linkDirection;
        if (typeof g.showOrphans === "boolean") dst.showOrphans = g.showOrphans;
        if (typeof g.showGhosts === "boolean") dst.showGhosts = g.showGhosts;
        if (typeof g.showTags === "boolean") dst.showTags = g.showTags;
        if (typeof g.showArrows === "boolean") dst.showArrows = g.showArrows;
        if (typeof g.smartLabels === "boolean") dst.smartLabels = g.smartLabels;
        if (typeof g.animatePhysics === "boolean") dst.animatePhysics = g.animatePhysics;
        if (typeof g.repel === "number" && Number.isFinite(g.repel)) dst.repel = Math.max(30, Math.min(250, Math.round(g.repel)));
        if (typeof g.linkDist === "number" && Number.isFinite(g.linkDist)) dst.linkDist = Math.max(50, Math.min(220, Math.round(g.linkDist)));
        if (typeof g.gravity === "number" && Number.isFinite(g.gravity)) dst.gravity = Math.max(5, Math.min(60, Math.round(g.gravity)));
        if (typeof g.nodeScale === "number" && Number.isFinite(g.nodeScale)) dst.nodeScale = Math.max(60, Math.min(180, Math.round(g.nodeScale)));
      }
      if (raw.ui.search && typeof raw.ui.search === "object") {
        const s = raw.ui.search;
        const dst = base.ui.search;
        if (typeof s.grouped === "boolean") dst.grouped = s.grouped;
        if (typeof s.context === "boolean") dst.context = s.context;
        if (["relevance", "matches", "path", "mtime"].includes(s.sortBy)) dst.sortBy = s.sortBy;
        if (Array.isArray(s.history)) {
          dst.history = s.history.filter((q) => typeof q === "string" && q.trim()).slice(0, 10);
        }
      }
      if (raw.ui.kanban && typeof raw.ui.kanban === "object") {
        const k = raw.ui.kanban;
        const dst = base.ui.kanban;
        if (["status", "priority", "assignee", "group", "color"].includes(k.columnBy)) dst.columnBy = k.columnBy;
        if (["none", "priority", "assignee", "file", "group"].includes(k.swimlaneBy)) dst.swimlaneBy = k.swimlaneBy;
        if (["all", "todo", "doing", "review", "done", "high", "due"].includes(k.quickFilter)) dst.quickFilter = k.quickFilter;
      }
    }
    if (raw.projects && typeof raw.projects === "object") {
      base.projects = { ...raw.projects };
    }
    if (raw.drafts && typeof raw.drafts === "object") {
      for (const [key, entry] of Object.entries(raw.drafts)) {
        if (isRecoverableDraft(entry)) {
          base.drafts[key] = entry;
        }
      }
    }
    if (typeof raw.snippet === "string") {
      base.snippet = raw.snippet;
    }
    return base;
  }

  // Migrate v1 flat state cleanly
  base.ui.activeTab = raw.activeTab === "snippet" ? "snippet" : "files";
  if (typeof raw.snippet === "string") base.snippet = raw.snippet;
  if (typeof raw.currentFilePath === "string" && raw.currentFilePath) {
    base.projects.__legacy__ = {
      currentFilePath: raw.currentFilePath,
      collapsedDirs: [],
    };
  }
  return base;
}

export function draftKey(projectName, filePath) {
  return `${projectName || "__default__"}::${filePath}`;
}

export function isRecoverableDraft(entry) {
  if (!entry || typeof entry !== "object" || typeof entry.content !== "string") return false;
  if (entry.complete !== true || entry.truncated === true) return false;
  if (typeof entry.contentLength !== "number" || entry.contentLength !== entry.content.length) return false;
  if (typeof entry.contentBytes === "number" && entry.contentBytes !== encoder.encode(entry.content).length) {
    return false;
  }
  return true;
}

export function getDraft(store, projectName, filePath) {
  if (!filePath || !store || typeof store !== "object" || !store.drafts) return null;
  const entry = store.drafts[draftKey(projectName, filePath)];
  return isRecoverableDraft(entry) ? entry : null;
}

export function setDraft(store, projectName, filePath, content, baseEtag) {
  if (!filePath || typeof content !== "string") return;
  store.drafts[draftKey(projectName, filePath)] = {
    content,
    baseEtag: baseEtag || "",
    updatedAt: Date.now(),
    complete: true,
    contentLength: content.length,
    contentBytes: encoder.encode(content).length,
  };
}

export function deleteDraft(store, projectName, filePath) {
  if (!filePath) return;
  delete store.drafts[draftKey(projectName, filePath)];
}

export function hasDraftForFile(store, projectName, filePath) {
  return Boolean(getDraft(store, projectName, filePath));
}

export function getProjectState(store, projectName) {
  const key = projectName || "__default__";
  if (!store.projects[key]) {
    store.projects[key] = { currentFilePath: "", collapsedDirs: [] };
  }
  return store.projects[key];
}

/**
 * Shrink serialized state to fit within the 56 KiB host state budget.
 * Never truncates draft content in place: if even evicting all other drafts
 * leaves the active draft over quota, drop it so incomplete content is never
 * restored and saved over a full file on disk.
 */
export function fitStateWithinQuotaWithMeta(store, activeProjectName, activeFilePath) {
  const clone = JSON.parse(JSON.stringify(store));
  if (!clone.drafts || typeof clone.drafts !== "object") {
    clone.drafts = {};
  }
  for (const [key, entry] of Object.entries(clone.drafts)) {
    if (!isRecoverableDraft(entry)) {
      delete clone.drafts[key];
    }
  }

  while (encoder.encode(clone.snippet || "").length > MAX_SNIPPET_BYTES) {
    clone.snippet = clone.snippet.slice(0, Math.floor(clone.snippet.length * 0.85));
  }

  const activeKey = activeFilePath ? draftKey(activeProjectName, activeFilePath) : "";
  const byteSize = () => encoder.encode(JSON.stringify(clone)).length;
  const droppedKeys = [];
  let droppedActiveDraft = false;

  if (byteSize() > MAX_STATE_BYTES) {
    const evictable = Object.entries(clone.drafts)
      .filter(([key]) => key !== activeKey)
      .sort((a, b) => (a[1]?.updatedAt || 0) - (b[1]?.updatedAt || 0));
    for (const [key] of evictable) {
      delete clone.drafts[key];
      droppedKeys.push(key);
      if (byteSize() <= MAX_STATE_BYTES) break;
    }
  }

  if (byteSize() > MAX_STATE_BYTES && activeKey && clone.drafts[activeKey]) {
    delete clone.drafts[activeKey];
    droppedKeys.push(activeKey);
    droppedActiveDraft = true;
  }

  return { state: clone, droppedActiveDraft, droppedKeys };
}

export function fitStateWithinQuota(store, activeProjectName, activeFilePath) {
  return fitStateWithinQuotaWithMeta(store, activeProjectName, activeFilePath).state;
}

export function canPersistDraft(store, projectName, filePath, content, baseEtag = "") {
  if (!filePath || typeof content !== "string") return false;
  const probe = JSON.parse(JSON.stringify(store));
  if (!probe.drafts || typeof probe.drafts !== "object") {
    probe.drafts = {};
  }
  setDraft(probe, projectName, filePath, content, baseEtag);
  const { state, droppedActiveDraft } = fitStateWithinQuotaWithMeta(probe, projectName, filePath);
  return !droppedActiveDraft && Boolean(getDraft(state, projectName, filePath));
}
