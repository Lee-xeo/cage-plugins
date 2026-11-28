"use strict";
// Linux Files: a column file browser. The workbench frames this page and
// relays JSON-RPC 2.0 over postMessage; every file system call goes to the
// plugin's own MCP server through tools/call.

// ------------------------------------------------------------------ workbench

const waiting = new Map();
let nextId = 1;
// The workbench refuses a page's 9th request in flight; stay well under it so
// a deep folder (one request per column) or a refresh never hits the limit.
const MAX_IN_FLIGHT = 4;
const queued = [];

function request(method, params) {
  return new Promise((resolve, reject) => {
    queued.push({ method, params, resolve, reject });
    pump();
  });
}

function pump() {
  while (waiting.size < MAX_IN_FLIGHT && queued.length) {
    const { method, params, resolve, reject } = queued.shift();
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  }
}

window.addEventListener("message", event => {
  const message = event.data;
  if (event.source !== window.parent || !message || message.jsonrpc !== "2.0") return;
  if (message.method === "ui/themeChanged") applyTheme(message.params);
  const pending = waiting.get(message.id);
  if (!pending) return;
  waiting.delete(message.id);
  pump();
  if (message.error) pending.reject(Object.assign(new Error(message.error.message || "request failed"), { code: message.error.code }));
  else pending.resolve(message.result);
});

async function tool(name, args) {
  const result = await request("tools/call", { name, arguments: args || {} });
  if (result && result.isError) {
    const text = (result.content || []).map(part => part.text || "").join(" ").trim();
    throw new Error(text || name + " failed");
  }
  return result.structuredContent;
}

function notify(message, tone) {
  request("ui/notify", { message: String(message).slice(0, 500), tone: tone || "info" }).catch(() => {});
}

async function copyText(text, what) {
  try {
    await request("ui/copy", { text });
    notify(t("copied", what || text));
  } catch (error) {
    notify(t("copyFailed", error.message), "error");
  }
}

// ------------------------------------------------------------------ strings

const STRINGS = {
  en: {
    places: "Places", shared: "Shared folders", home: "Home", root: "Root",
    goTo: "Go to folder (⌘L)", showHidden: "Show hidden files (⌘⇧.)", refresh: "Refresh",
    copyPath: "Copy path", copyName: "Copy name", download: "Download to computer", change: "Change",
    openHere: "Browse from here", cancel: "Cancel", useFolder: "Use this folder",
    pickTitle: "Where should downloads go?",
    pickText: sub => `Pick a folder shared with your computer. Files are saved in its “${sub}” subfolder.`,
    pickNone: "No folder shared with your computer was found. Open a project in the workbench.",
    likelyDefault: "Probably the default workspace (already has Downloads)",
    notWritable: "Not writable",
    destNone: "Downloads: not chosen", dest: path => `Downloads → ${path}`,
    items: (n, h) => h ? `${n} items, ${h} hidden` : `${n} items`,
    more: n => `Show ${n} more`, empty: "Empty folder", loading: "Loading…",
    truncated: "Only the first 50,000 entries were read.",
    folder: "Folder", file: "File", symlink: "Link", other: "Special file", unknown: "Unreadable",
    linkTo: kind => `Link to ${kind.toLowerCase()}`, broken: "Broken link",
    kind: "Kind", size: "Size", modified: "Modified", accessed: "Opened", permissions: "Permissions",
    owner: "Owner", path: "Path", target: "Points to", contents: "Contents", type: "Type",
    entries: (n, capped) => capped ? `${n}+ items` : `${n} items`,
    preview: "Preview", previewCut: "First 4 KB shown.",
    copied: what => `Copied ${what}`, copyFailed: msg => `Could not copy: ${msg}`,
    confirmTitle: "Download to computer",
    confirmFile: (name, dest) => `Copy “${name}” to ${dest} on your computer?`,
    confirmFolder: (name, dest) => `Zip the folder “${name}” and save it to ${dest} on your computer? Unreadable files are skipped.`,
    confirmOk: "Download",
    jobRunning: (name, done) => `${name}: ${done}`, jobDone: name => `Saved ${name}`,
    jobFailed: (name, msg) => `${name} failed: ${msg}`, jobCancelled: name => `${name} cancelled`,
    jobSkipped: n => `${n} skipped`,
    savedTo: path => `Saved to ${path}`, cancelJob: "Stop",
    notFound: msg => `Cannot open: ${msg}`, startFailed: msg => `Cannot start: ${msg}`,
  },
  "zh-CN": {
    places: "位置", shared: "共享文件夹", home: "主目录", root: "根目录",
    goTo: "前往文件夹（⌘L）", showHidden: "显示隐藏文件（⌘⇧.）", refresh: "刷新",
    copyPath: "复制路径", copyName: "复制名称", download: "下载到电脑", change: "更改",
    openHere: "从这里浏览", cancel: "取消", useFolder: "使用此文件夹",
    pickTitle: "下载保存到哪里？",
    pickText: sub => `选择一个与电脑共享的文件夹，文件会保存到其中的“${sub}”子文件夹。`,
    pickNone: "没有找到与电脑共享的文件夹。请在工作台打开一个项目。",
    likelyDefault: "可能是默认工作区（已有 Downloads）",
    notWritable: "不可写",
    destNone: "下载位置：未选择", dest: path => `下载 → ${path}`,
    items: (n, h) => h ? `${n} 项，另有 ${h} 项隐藏` : `${n} 项`,
    more: n => `再显示 ${n} 项`, empty: "空文件夹", loading: "正在读取…",
    truncated: "只读取了前 50,000 项。",
    folder: "文件夹", file: "文件", symlink: "链接", other: "特殊文件", unknown: "无法读取",
    linkTo: kind => `指向${kind}的链接`, broken: "失效的链接",
    kind: "种类", size: "大小", modified: "修改时间", accessed: "访问时间", permissions: "权限",
    owner: "所有者", path: "路径", target: "指向", contents: "内容", type: "类型",
    entries: (n, capped) => capped ? `${n}+ 项` : `${n} 项`,
    preview: "预览", previewCut: "仅显示前 4 KB。",
    copied: what => `已复制 ${what}`, copyFailed: msg => `复制失败：${msg}`,
    confirmTitle: "下载到电脑",
    confirmFile: (name, dest) => `把“${name}”复制到电脑上的 ${dest}？`,
    confirmFolder: (name, dest) => `把文件夹“${name}”压缩后保存到电脑上的 ${dest}？无法读取的文件会被跳过。`,
    confirmOk: "下载",
    jobRunning: (name, done) => `${name}：${done}`, jobDone: name => `已保存 ${name}`,
    jobFailed: (name, msg) => `${name} 失败：${msg}`, jobCancelled: name => `${name} 已取消`,
    jobSkipped: n => `跳过 ${n} 项`,
    savedTo: path => `已保存到 ${path}`, cancelJob: "停止",
    notFound: msg => `无法打开：${msg}`, startFailed: msg => `无法启动：${msg}`,
  },
  "zh-TW": {
    places: "位置", shared: "共享資料夾", home: "主目錄", root: "根目錄",
    goTo: "前往資料夾（⌘L）", showHidden: "顯示隱藏檔案（⌘⇧.）", refresh: "重新整理",
    copyPath: "複製路徑", copyName: "複製名稱", download: "下載到電腦", change: "變更",
    openHere: "從這裡瀏覽", cancel: "取消", useFolder: "使用此資料夾",
    pickTitle: "下載要存到哪裡？",
    pickText: sub => `選擇一個與電腦共享的資料夾，檔案會存到其中的「${sub}」子資料夾。`,
    pickNone: "找不到與電腦共享的資料夾。請在工作台開啟一個專案。",
    likelyDefault: "可能是預設工作區（已有 Downloads）",
    notWritable: "無法寫入",
    destNone: "下載位置：未選擇", dest: path => `下載 → ${path}`,
    items: (n, h) => h ? `${n} 項，另有 ${h} 項隱藏` : `${n} 項`,
    more: n => `再顯示 ${n} 項`, empty: "空資料夾", loading: "正在讀取…",
    truncated: "只讀取了前 50,000 項。",
    folder: "資料夾", file: "檔案", symlink: "連結", other: "特殊檔案", unknown: "無法讀取",
    linkTo: kind => `指向${kind}的連結`, broken: "失效的連結",
    kind: "種類", size: "大小", modified: "修改時間", accessed: "存取時間", permissions: "權限",
    owner: "擁有者", path: "路徑", target: "指向", contents: "內容", type: "類型",
    entries: (n, capped) => capped ? `${n}+ 項` : `${n} 項`,
    preview: "預覽", previewCut: "僅顯示前 4 KB。",
    copied: what => `已複製 ${what}`, copyFailed: msg => `複製失敗：${msg}`,
    confirmTitle: "下載到電腦",
    confirmFile: (name, dest) => `把「${name}」複製到電腦上的 ${dest}？`,
    confirmFolder: (name, dest) => `把資料夾「${name}」壓縮後存到電腦上的 ${dest}？無法讀取的檔案會被略過。`,
    confirmOk: "下載",
    jobRunning: (name, done) => `${name}：${done}`, jobDone: name => `已儲存 ${name}`,
    jobFailed: (name, msg) => `${name} 失敗：${msg}`, jobCancelled: name => `${name} 已取消`,
    jobSkipped: n => `略過 ${n} 項`,
    savedTo: path => `已儲存到 ${path}`, cancelJob: "停止",
    notFound: msg => `無法開啟：${msg}`, startFailed: msg => `無法啟動：${msg}`,
  },
};

Object.assign(STRINGS.en, {
  destButton: "Download folder…", destAsk: "Downloads: ask every time", downloadTo: "Download to…",
  remember: "Remember this folder and don't ask again",
  rememberHint: "You can change it later with “Download folder…” in the status bar.",
  downloadTitle: name => `Download “${name}” to your computer`,
  downloadTextFile: sub => `Choose a folder shared with your computer. The file is saved in its “${sub}” subfolder.`,
  downloadTextFolder: sub => `Choose a folder shared with your computer. The folder is zipped and saved in its “${sub}” subfolder; unreadable files are skipped.`,
  downloadOk: "Download", save: "Save", folderTitle: "Download folder",
  folderText: "Where should downloads go? Choose a folder to use without asking, or have each download ask.",
  askEveryTime: "Ask every time", askEveryTimeHint: "Choose a folder for each download",
  confirmHint: "Change the folder with “Download folder…” in the status bar.",
  rememberedTag: "Current",
});
Object.assign(STRINGS["zh-CN"], {
  destButton: "下载位置…", destAsk: "下载位置：每次询问", downloadTo: "下载到…",
  remember: "记住这个文件夹，以后不再询问",
  rememberHint: "之后可在状态栏的“下载位置…”中更改。",
  downloadTitle: name => `把“${name}”下载到电脑`,
  downloadTextFile: sub => `选择一个与电脑共享的文件夹，文件会保存到其中的“${sub}”子文件夹。`,
  downloadTextFolder: sub => `选择一个与电脑共享的文件夹，文件夹会压缩后保存到其中的“${sub}”子文件夹；无法读取的文件会被跳过。`,
  downloadOk: "下载", save: "保存", folderTitle: "下载位置",
  folderText: "下载保存到哪里？选择一个文件夹后直接使用，或者每次下载时询问。",
  askEveryTime: "每次询问", askEveryTimeHint: "每次下载时选择文件夹",
  confirmHint: "可在状态栏的“下载位置…”中更改文件夹。",
  rememberedTag: "当前",
});
Object.assign(STRINGS["zh-TW"], {
  destButton: "下載位置…", destAsk: "下載位置：每次詢問", downloadTo: "下載到…",
  remember: "記住這個資料夾，以後不再詢問",
  rememberHint: "之後可在狀態列的「下載位置…」中變更。",
  downloadTitle: name => `把「${name}」下載到電腦`,
  downloadTextFile: sub => `選擇一個與電腦共享的資料夾，檔案會存到其中的「${sub}」子資料夾。`,
  downloadTextFolder: sub => `選擇一個與電腦共享的資料夾，資料夾會壓縮後存到其中的「${sub}」子資料夾；無法讀取的檔案會被略過。`,
  downloadOk: "下載", save: "儲存", folderTitle: "下載位置",
  folderText: "下載要存到哪裡？選擇一個資料夾後直接使用，或者每次下載時詢問。",
  askEveryTime: "每次詢問", askEveryTimeHint: "每次下載時選擇資料夾",
  confirmHint: "可在狀態列的「下載位置…」中變更資料夾。",
  rememberedTag: "目前",
});

let locale = "en";
let strings = STRINGS.en;

function pickLocale(requested) {
  const tag = String(requested || "en");
  if (STRINGS[tag]) return tag;
  if (/^zh[-_](tw|hk|mo|hant)/i.test(tag)) return "zh-TW";
  if (/^zh/i.test(tag)) return "zh-CN";
  return "en";
}

function t(key, ...args) {
  const value = strings[key] !== undefined ? strings[key] : STRINGS.en[key];
  return typeof value === "function" ? value(...args) : value;
}

// ------------------------------------------------------------------ helpers

const $ = id => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function joinPath(folder, name) {
  return folder === "/" ? "/" + name : folder + "/" + name;
}

function parentOf(path) {
  if (path === "/") return null;
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function baseName(path) {
  return path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
}

function normalize(path) {
  const parts = [];
  for (const part of String(path).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}

function isAncestor(ancestor, path) {
  return ancestor === path || ancestor === "/" || path.startsWith(ancestor + "/");
}

function formatSize(bytes) {
  if (bytes === undefined || bytes === null) return "";
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = -1;
  do { value /= 1000; unit++; } while (value >= 1000 && unit < units.length - 1);
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatTime(seconds) {
  if (!seconds) return "";
  try {
    return new Date(seconds * 1000).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return new Date(seconds * 1000).toLocaleString();
  }
}

function isFolder(entry) {
  return entry.kind === "directory" || entry.target_kind === "directory";
}

// ------------------------------------------------------------------ icons

const ICONS = {
  folder: '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.4 1.5h4.6A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" fill="currentColor" fill-opacity=".18" stroke="currentColor" stroke-width="1.2"/>',
  file: '<path d="M4 2h5l3 3v8.5a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 2v3h3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>',
  other: '<rect x="3" y="3" width="10" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/>',
  unknown: '<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6.6 6.3a1.5 1.5 0 1 1 2 1.4c-.4.2-.6.5-.6.9v.4M8 11h.01" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
  link: '<path d="M6 13.5 3.5 11M3.5 11H6M3.5 11v2.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  chevron: '<path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  home: '<path d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h3V9.5h2V13h3V6.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>',
  root: '<rect x="2.5" y="3" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M2.5 9.5h11" stroke="currentColor" stroke-width="1.2"/><circle cx="11" cy="11.3" r=".8" fill="currentColor"/>',
  shared: '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.4 1.5h4.6A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 7v4M6.2 8.6 8 6.8l1.8 1.8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>',
  edit: '<path d="M3 13h2.5L13 5.5 10.5 3 3 10.5z M9.5 4l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.35-3.42M13 3.2v2.4h-2.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
};

function icon(name, className) {
  const span = el("span", "ico " + (className || ""));
  span.innerHTML = `<svg viewBox="0 0 16 16" width="100%" height="100%" aria-hidden="true">${ICONS[name]}</svg>`;
  return span;
}

function entryIcon(entry, className) {
  if (entry.kind === "symlink") {
    const base = entry.target_kind === "directory" ? "folder" : entry.target_kind === "broken" ? "unknown" : "file";
    const node = icon(base, (base === "folder" ? "folder " : "") + "link " + (className || ""));
    node.querySelector("svg").insertAdjacentHTML("beforeend", ICONS.link);
    return node;
  }
  const name = entry.kind === "directory" ? "folder" : entry.kind === "file" ? "file" : entry.kind === "unknown" ? "unknown" : "other";
  return icon(name, (name === "folder" ? "folder " : "") + (className || ""));
}

// ------------------------------------------------------------------ state

const PAGE = 300;
const state = {
  root: "/",        // the first column's folder
  columns: [],      // {path, entries, total, hiddenCount, truncated, selected, error, loading, el}
  details: null,    // {path, data, error, el}
  active: 0,        // index of the column the keyboard moves in
  showHidden: false,
  places: null,
  jobs: new Map(),
};
let openTimer = 0;
let saveTimer = 0;

function currentPath() {
  if (state.details) return state.details.path;
  for (let index = state.columns.length - 1; index >= 0; index--) {
    const column = state.columns[index];
    if (column.selected) return joinPath(column.path, column.selected);
  }
  const last = state.columns[state.columns.length - 1];
  return last ? last.path : state.root;
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const saved = { root: state.root, path: currentPath(), showHidden: state.showHidden };
    request("ui/setState", { state: saved }).catch(() => {});
  }, 400);
}

// ------------------------------------------------------------------ loading

function newColumn(path) {
  return { path, entries: [], total: 0, hiddenCount: 0, truncated: false, selected: null, error: null, loading: true, el: null };
}

async function loadColumn(column, offset) {
  column.loading = true;
  if (!offset) renderColumn(column);
  try {
    const page = await tool("list_directory", { path: column.path, offset: offset || 0, limit: PAGE, hidden: state.showHidden });
    if (!state.columns.includes(column)) return false;
    column.entries = offset ? column.entries.concat(page.entries) : page.entries;
    column.total = page.total;
    column.hiddenCount = page.hidden_count;
    column.truncated = page.truncated;
    column.error = null;
  } catch (error) {
    if (!state.columns.includes(column)) return false;
    column.error = error.message;
    column.entries = [];
  }
  column.loading = false;
  renderColumn(column);
  updateStatus();
  return true;
}

async function loadDetails(path) {
  const details = { path, data: null, error: null, el: null };
  state.details = details;
  renderDetails();
  try {
    details.data = await tool("path_details", { path });
  } catch (error) {
    details.error = error.message;
  }
  if (state.details === details) renderDetails();
}

// Opens columns from root down to target. A folder target ends with its own
// column; a file target ends selected in its folder, with its details shown.
async function openPath(root, target, options) {
  root = normalize(root);
  target = normalize(target);
  if (!isAncestor(root, target)) root = "/";
  let info = null;
  try {
    info = await tool("path_details", { path: target });
  } catch (error) {
    if (!options || !options.quiet) notify(t("notFound", error.message), "error");
    return false;
  }
  const targetIsFolder = info.kind === "directory" || info.target_kind === "directory";
  const folder = targetIsFolder ? target : parentOf(target);
  state.root = isAncestor(root, folder) ? root : "/";
  state.details = null;
  const chain = [];
  for (let path = folder; path !== null; path = parentOf(path)) {
    chain.unshift(path);
    if (path === state.root) break;
  }
  state.columns = chain.map(path => newColumn(path));
  chain.forEach((path, index) => {
    if (index + 1 < chain.length) state.columns[index].selected = baseName(chain[index + 1]);
  });
  if (!targetIsFolder) state.columns[state.columns.length - 1].selected = baseName(target);
  state.active = state.columns.length - 1;
  renderAll();
  await Promise.all(state.columns.map(column => loadColumn(column)));
  if (!targetIsFolder) await loadDetails(target);
  revealSelection();
  persist();
  return true;
}

function selectEntry(index, name, options) {
  const column = state.columns[index];
  if (!column) return;
  const entry = column.entries.find(item => item.name === name);
  if (!entry) return;
  column.selected = name;
  state.active = index;
  const dropped = state.columns.splice(index + 1);
  dropped.forEach(item => item.el && item.el.remove());
  if (state.details) { state.details.el && state.details.el.remove(); state.details = null; }
  renderSelection(column);
  markActive();
  updateCrumbs();
  updateStatus();
  persist();
  clearTimeout(openTimer);
  const path = joinPath(column.path, name);
  const open = () => {
    if (state.columns[index] !== column || column.selected !== name) return;
    if (isFolder(entry)) {
      const child = newColumn(path);
      state.columns.push(child);
      renderAll();
      loadColumn(child).then(() => scrollColumnsToEnd());
    } else {
      loadDetails(path).then(() => scrollColumnsToEnd());
    }
  };
  if (options && options.delay) openTimer = setTimeout(open, 140);
  else open();
}

async function refresh() {
  const path = currentPath();
  await openPath(state.root, path, { quiet: true }) || await openPath("/", parentOf(path) || "/");
}

// ------------------------------------------------------------------ rendering

function renderAll() {
  const host = $("columns");
  const wanted = [];
  for (const column of state.columns) {
    if (!column.el) {
      column.el = el("div", "column");
      column.el.setAttribute("role", "listbox");
      bindColumn(column);
      renderColumn(column);
    }
    wanted.push(column.el);
  }
  if (state.details && state.details.el) wanted.push(state.details.el);
  [...host.children].forEach(child => { if (!wanted.includes(child)) child.remove(); });
  wanted.forEach(node => host.appendChild(node));
  markActive();
  updateCrumbs();
  updateStatus();
}

function renderColumn(column) {
  if (!column.el) return;
  const node = column.el;
  node.replaceChildren();
  if (column.loading && !column.entries.length) {
    node.appendChild(el("div", "column-note", t("loading")));
    return;
  }
  if (column.error) {
    node.appendChild(el("div", "column-note error", column.error));
    return;
  }
  if (!column.entries.length) node.appendChild(el("div", "column-note", t("empty")));
  const fragment = document.createDocumentFragment();
  for (const entry of column.entries) {
    const row = el("div", "row");
    row.dataset.name = entry.name;
    row.setAttribute("role", "option");
    row.title = entry.name;
    if (entry.hidden) row.classList.add("hidden-entry");
    row.appendChild(entryIcon(entry));
    row.appendChild(el("span", "name", entry.name));
    if (isFolder(entry)) row.appendChild(icon("chevron", "chev"));
    fragment.appendChild(row);
  }
  node.appendChild(fragment);
  const remaining = column.total - column.entries.length;
  if (remaining > 0) {
    const more = el("button", "more-btn", t("more", Math.min(PAGE, remaining)));
    more.type = "button";
    more.addEventListener("click", event => { event.stopPropagation(); loadColumn(column, column.entries.length); });
    node.appendChild(more);
  }
  if (column.truncated) node.appendChild(el("div", "column-note", t("truncated")));
  renderSelection(column);
}

function renderSelection(column) {
  if (!column.el) return;
  for (const row of column.el.querySelectorAll(".row")) {
    row.classList.toggle("selected", row.dataset.name === column.selected);
    row.setAttribute("aria-selected", row.dataset.name === column.selected ? "true" : "false");
  }
}

function markActive() {
  state.columns.forEach((column, index) => column.el && column.el.classList.toggle("active", index === state.active));
}

function revealSelection() {
  for (const column of state.columns) {
    const row = column.el && column.el.querySelector(".row.selected");
    if (row) row.scrollIntoView({ block: "nearest" });
  }
  scrollColumnsToEnd();
}

function scrollColumnsToEnd() {
  const host = $("columns");
  host.scrollLeft = host.scrollWidth;
}

function prop(list, label, value, mono) {
  if (value === undefined || value === null || value === "") return;
  list.appendChild(el("dt", "", label));
  list.appendChild(el("dd", mono ? "mono" : "", String(value)));
}

function kindLabel(data) {
  if (data.kind === "symlink") return data.target_kind === "broken" ? t("broken") : t("linkTo", t(data.target_kind === "directory" ? "folder" : data.target_kind || "file"));
  return t(data.kind) || data.kind;
}

function renderDetails() {
  const details = state.details;
  if (!details) return;
  if (!details.el) {
    details.el = el("div", "column details");
    details.el.addEventListener("contextmenu", event => {
      event.preventDefault();
      showMenu(event.clientX, event.clientY, details.path, false);
    });
  }
  const node = details.el;
  node.replaceChildren();
  if (details.error) {
    node.appendChild(el("div", "column-note error", details.error));
  } else if (!details.data) {
    node.appendChild(el("div", "column-note", t("loading")));
  } else {
    const data = details.data;
    node.appendChild(entryIcon(data, "big-ico"));
    node.appendChild(el("h3", "", data.name));
    node.appendChild(el("div", "sub", [kindLabel(data), data.kind !== "directory" ? formatSize(data.size) : ""].filter(Boolean).join(" · ")));
    const actions = el("div", "detail-actions");
    const copy = el("button", "text-btn", t("copyPath"));
    copy.type = "button";
    copy.addEventListener("click", () => copyText(data.path, data.path));
    const download = el("button", "text-btn primary", t("download"));
    download.type = "button";
    download.disabled = data.target_kind === "broken" || !(data.kind === "file" || data.kind === "directory" || data.kind === "symlink");
    download.addEventListener("click", () => startExport(data.path));
    actions.append(copy, download);
    node.appendChild(actions);
    const list = el("dl", "props");
    prop(list, t("path"), data.path, true);
    if (data.link_target) prop(list, t("target"), data.link_target, true);
    if (data.mime) prop(list, t("type"), data.mime);
    if (data.items !== undefined) prop(list, t("contents"), t("entries", data.items, data.items_capped));
    prop(list, t("size"), data.kind === "directory" ? "" : `${formatSize(data.size)} (${data.size.toLocaleString(locale)} B)`);
    prop(list, t("modified"), formatTime(data.modified));
    prop(list, t("accessed"), formatTime(data.accessed));
    prop(list, t("permissions"), `${data.mode} (${data.octal})`, true);
    prop(list, t("owner"), `${data.owner}:${data.group}`);
    node.appendChild(list);
    if (data.preview) {
      node.appendChild(el("div", "preview-title", t("preview")));
      node.appendChild(el("pre", "preview", data.preview.text));
      if (!data.preview.complete) node.appendChild(el("div", "preview-note", t("previewCut")));
    }
  }
  if (!node.isConnected) renderAll();
}

function updateCrumbs() {
  const crumbs = $("crumbs");
  crumbs.replaceChildren();
  const path = currentPath();
  const parts = path === "/" ? [] : path.slice(1).split("/");
  const add = (label, target) => {
    const button = el("button", "crumb", label);
    button.type = "button";
    button.title = target;
    button.addEventListener("click", event => { event.stopPropagation(); openPath(isAncestor(state.root, target) ? state.root : "/", target); });
    crumbs.appendChild(button);
  };
  add("/", "/");
  let walked = "";
  parts.forEach(part => {
    walked += "/" + part;
    crumbs.appendChild(el("span", "crumb-sep", "›"));
    add(part, walked);
  });
  crumbs.scrollLeft = crumbs.scrollWidth;
  for (const button of document.querySelectorAll(".place")) {
    button.classList.toggle("current", button.dataset.path === state.root);
  }
}

function updateStatus() {
  const column = state.columns[state.active] || state.columns[state.columns.length - 1];
  $("status-count").textContent = column && !column.loading && !column.error ? t("items", column.total, state.showHidden ? 0 : column.hiddenCount) : "";
  const places = state.places;
  const folder = places && places.remembered && places.shared.find(item => item.path === places.remembered);
  const shown = folder ? shownFolder(folder) : null;
  const label = $("dest-label");
  if (shown) {
    // "Downloads → " stays whole; a long path is shortened from its start.
    const prefix = t("dest", "");
    // Left-to-right marks keep the leading "/" in place inside the rtl box.
    label.replaceChildren(el("span", "dest-prefix", prefix), el("span", "dest-path", "‎" + shown + "‎"));
  } else {
    label.replaceChildren(el("span", "dest-prefix", t("destAsk")));
  }
  label.title = shown || "";
}

function renderPlaces() {
  const places = state.places;
  const host = $("places");
  host.replaceChildren();
  const add = (parent, iconName, label, path, badge) => {
    const button = el("button", "place");
    button.type = "button";
    button.dataset.path = path;
    button.title = path;
    button.appendChild(icon(iconName));
    button.appendChild(el("span", "label", label));
    if (badge) button.appendChild(el("span", "badge", badge));
    button.addEventListener("click", () => openPath(path, path));
    parent.appendChild(button);
  };
  add(host, "home", t("home"), places.home);
  add(host, "root", t("root"), "/");
  const shared = $("shared");
  shared.replaceChildren();
  if (!places.shared.length) shared.appendChild(el("div", "place-note", "—"));
  for (const folder of places.shared) add(shared, "shared", baseName(folder.path), folder.path, folder.writable ? "" : "ro");
  updateCrumbs();
}

// ------------------------------------------------------------------ interaction

function bindColumn(column) {
  column.el.addEventListener("click", event => {
    const row = event.target.closest(".row");
    const index = state.columns.indexOf(column);
    if (index < 0) return;
    $("browser").focus({ preventScroll: true });
    if (row) selectEntry(index, row.dataset.name);
    else { state.active = index; markActive(); updateStatus(); }
  });
  column.el.addEventListener("contextmenu", event => {
    event.preventDefault();
    const index = state.columns.indexOf(column);
    const row = event.target.closest(".row");
    if (row) {
      if (column.selected !== row.dataset.name) selectEntry(index, row.dataset.name);
      const entry = column.entries.find(item => item.name === row.dataset.name);
      showMenu(event.clientX, event.clientY, joinPath(column.path, row.dataset.name), entry && isFolder(entry));
    } else {
      showMenu(event.clientX, event.clientY, column.path, true);
    }
  });
}

function showMenu(x, y, path, folder) {
  const menu = $("menu");
  menu.replaceChildren();
  const item = (label, action) => {
    const button = el("button", "", label);
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.addEventListener("click", () => { hideMenu(); action(); });
    menu.appendChild(button);
  };
  item(t("copyPath"), () => copyText(path, path));
  item(t("copyName"), () => copyText(baseName(path), baseName(path)));
  menu.appendChild(el("hr"));
  if (folder) item(t("openHere"), () => openPath(path, path));
  item(t("download"), () => startExport(path));
  item(t("downloadTo"), () => startExport(path, { ask: true }));
  menu.hidden = false;
  const box = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - box.width - 6) + "px";
  menu.style.top = Math.min(y, window.innerHeight - box.height - 6) + "px";
  menu.querySelector("button").focus();
}

function hideMenu() {
  $("menu").hidden = true;
}

document.addEventListener("mousedown", event => {
  if (!$("menu").hidden && !event.target.closest("#menu")) hideMenu();
});

let typeahead = "";
let typeaheadTimer = 0;

function moveSelection(delta) {
  const column = state.columns[state.active];
  if (!column || !column.entries.length) return;
  const last = column.entries.length - 1;
  let index = column.entries.findIndex(entry => entry.name === column.selected);
  if (!Number.isFinite(delta)) index = delta > 0 ? last : 0;
  else if (index < 0) index = delta > 0 ? 0 : last;
  else index = Math.max(0, Math.min(last, index + delta));
  if (column.entries[index].name === column.selected) return;  // at the end already
  selectEntry(state.active, column.entries[index].name, { delay: true });
  const row = column.el.querySelector(".row.selected");
  if (row) row.scrollIntoView({ block: "nearest" });
}

function enterFolder() {
  const column = state.columns[state.active];
  const next = state.columns[state.active + 1];
  if (!column || !column.selected) return;
  const entry = column.entries.find(item => item.name === column.selected);
  if (!entry || !isFolder(entry)) return;
  const step = () => {
    const child = state.columns[state.active + 1];
    if (!child) return;
    state.active += 1;
    markActive();
    if (!child.selected && child.entries.length) selectEntry(state.active, child.entries[0].name, { delay: true });
    updateStatus();
  };
  if (next && !next.loading) step();
  else {
    clearTimeout(openTimer);
    if (!next) selectEntry(state.active, column.selected);
    const wait = setInterval(() => {
      const child = state.columns[state.active + 1];
      if (child && !child.loading) { clearInterval(wait); step(); }
    }, 40);
    setTimeout(() => clearInterval(wait), 5000);
  }
}

// Like Finder: focus moves left and the columns to the right stay as they are.
function leaveFolder() {
  if (state.active === 0) return;
  state.active -= 1;
  markActive();
  updateStatus();
  const row = state.columns[state.active].el.querySelector(".row.selected");
  if (row) row.scrollIntoView({ block: "nearest" });
}

function jumpTo(letter) {
  clearTimeout(typeaheadTimer);
  typeahead += letter.toLowerCase();
  typeaheadTimer = setTimeout(() => { typeahead = ""; }, 800);
  const column = state.columns[state.active];
  if (!column) return;
  const match = column.entries.find(entry => entry.name.toLowerCase().startsWith(typeahead));
  if (match) {
    selectEntry(state.active, match.name, { delay: true });
    const row = column.el.querySelector(".row.selected");
    if (row) row.scrollIntoView({ block: "nearest" });
  }
}

function showPathInput() {
  $("crumbs").hidden = true;
  $("path-form").hidden = false;
  const input = $("path-input");
  input.value = currentPath();
  input.focus();
  input.select();
}

function hidePathInput() {
  $("path-form").hidden = true;
  $("crumbs").hidden = false;
}

$("path-input").addEventListener("keydown", event => {
  if (event.key === "Escape") { event.preventDefault(); hidePathInput(); $("browser").focus(); }
  if (event.key === "Enter") {
    event.preventDefault();
    const raw = $("path-input").value.trim();
    if (!raw) return;
    const typed = raw.startsWith("~") && state.places ? state.places.home + raw.slice(1) : raw;
    const target = normalize(typed.startsWith("/") ? typed : joinPath(currentPath(), typed));
    hidePathInput();
    $("browser").focus();
    openPath(isAncestor(state.root, target) ? state.root : "/", target);
  }
});
$("path-input").addEventListener("blur", () => setTimeout(hidePathInput, 100));
$("crumbs").addEventListener("click", event => { if (event.target === $("crumbs")) showPathInput(); });

document.addEventListener("keydown", event => {
  if (!$("modal").hidden) {
    if (event.key === "Escape") closeModal(null);
    return;
  }
  if (!$("menu").hidden) {
    if (event.key === "Escape") { event.preventDefault(); hideMenu(); }
    return;
  }
  if (event.target === $("path-input")) return;
  const command = event.metaKey || event.ctrlKey;
  if (command && event.key.toLowerCase() === "l") { event.preventDefault(); showPathInput(); return; }
  if (command && event.shiftKey && (event.key === "." || event.key === ">")) { event.preventDefault(); toggleHidden(); return; }
  if (command && event.key.toLowerCase() === "c" && !window.getSelection().toString()) { event.preventDefault(); copyText(currentPath(), currentPath()); return; }
  if (command && event.key.toLowerCase() === "r") { event.preventDefault(); refresh(); return; }
  if (command || event.altKey) return;
  switch (event.key) {
    case "ArrowDown": event.preventDefault(); moveSelection(1); break;
    case "ArrowUp": event.preventDefault(); moveSelection(-1); break;
    case "ArrowRight": case "Enter": event.preventDefault(); enterFolder(); break;
    case "ArrowLeft": event.preventDefault(); leaveFolder(); break;
    case "Home": event.preventDefault(); moveSelection(-Infinity); break;
    case "End": event.preventDefault(); moveSelection(Infinity); break;
    default:
      if (event.key.length === 1 && event.key !== " ") jumpTo(event.key);
  }
});

function toggleHidden() {
  state.showHidden = !state.showHidden;
  $("hidden-btn").setAttribute("aria-pressed", String(state.showHidden));
  refresh();
}

// ------------------------------------------------------------------ export

let modalResolve = null;

function shownFolder(folder) {
  const sub = state.places.export_subfolder || "Downloads";
  return joinPath(folder.path, sub);
}

// mode "download": pick a folder for one download, optionally remembering it.
// mode "folder": choose the remembered folder, or "ask every time" (null).
// Resolves {path, remember} or null when cancelled.
function chooseDestination(mode, item) {
  return new Promise(resolve => {
    const places = state.places;
    const sub = places.export_subfolder || "Downloads";
    const list = $("modal-list");
    list.replaceChildren();
    const writable = places.shared.filter(folder => folder.writable);
    let chosen = mode === "folder" ? places.remembered : (places.remembered || places.suggested);
    if (mode === "download" && !writable.some(folder => folder.path === chosen)) chosen = writable[0] ? writable[0].path : null;
    $("modal-title").textContent = mode === "download" ? t("downloadTitle", item.name) : t("folderTitle");
    $("modal-text").textContent = !places.shared.length ? t("pickNone")
      : mode === "download" ? (item.isDir ? t("downloadTextFolder", sub) : t("downloadTextFile", sub))
      : t("folderText");
    const choose = (path, option) => {
      chosen = path;
      list.querySelectorAll(".option").forEach(node => node.classList.toggle("chosen", node === option));
    };
    const addOption = (path, label, hint, enabled, className) => {
      const option = el("button", "option" + (className ? " " + className : ""));
      option.type = "button";
      option.disabled = !enabled;
      option.appendChild(el("span", "path", label));
      if (hint) option.appendChild(el("span", "hint", hint));
      option.addEventListener("click", () => choose(path, option));
      option.addEventListener("dblclick", () => { choose(path, option); finish(); });
      if (path === chosen) option.classList.add("chosen");
      list.appendChild(option);
    };
    if (mode === "folder") addOption(null, t("askEveryTime"), t("askEveryTimeHint"), true, "ask");
    for (const folder of places.shared) {
      const hints = [];
      if (folder.path === places.remembered) hints.push(t("rememberedTag"));
      if (!folder.writable) hints.push(t("notWritable"));
      else if (folder.has_downloads && folder.path === places.suggested) hints.push(t("likelyDefault"));
      addOption(folder.path, shownFolder(folder), hints.join(" · "), folder.writable);
    }
    const box = $("remember-box");
    box.checked = false;
    $("remember-row").hidden = mode !== "download" || !writable.length;
    $("modal-hint").textContent = mode === "download" && writable.length ? t("rememberHint") : "";
    const ok = $("modal-ok");
    ok.textContent = mode === "download" ? t("downloadOk") : t("save");
    ok.disabled = mode === "download" && !writable.length;
    const finish = () => {
      if (mode === "download" && !chosen) return;
      closeModal({ path: chosen, remember: mode === "download" ? box.checked : true });
    };
    ok.onclick = finish;
    $("modal-cancel").onclick = () => closeModal(null);
    modalResolve = resolve;
    $("modal").hidden = false;
    (list.querySelector(".option.chosen:not(:disabled)") || ok).focus();
  });
}

function closeModal(value) {
  $("modal").hidden = true;
  const resolve = modalResolve;
  modalResolve = null;
  $("browser").focus();
  if (resolve) resolve(value);
}

async function refreshPlaces() {
  try {
    state.places = await tool("places", {});
    renderPlaces();
    updateStatus();
  } catch (error) {
    notify(error.message, "error");
  }
}

async function remember(path) {
  try {
    state.places = await tool("remember_destination", { destination: path });
    updateStatus();
  } catch (error) {
    notify(error.message, "error");
  }
}

// The status bar's "Download folder…": remember a folder, or ask every time.
async function pickDestination() {
  await refreshPlaces();
  if (!state.places) return;
  const choice = await chooseDestination("folder");
  if (choice && choice.path !== state.places.remembered) await remember(choice.path);
}

// ask: choose a folder for this download even when one is remembered.
async function startExport(path, options) {
  hideMenu();
  await refreshPlaces();
  if (!state.places) return;
  let isDir = false;
  try {
    const info = await tool("path_details", { path });
    isDir = info.kind === "directory" || info.target_kind === "directory";
  } catch (error) {
    notify(error.message, "error");
    return;
  }
  const name = baseName(path);
  let dest = options && options.ask ? null : state.places.remembered;
  if (dest) {
    // A remembered folder: one confirm, which says where the file goes and how to change it.
    const folder = state.places.shared.find(item => item.path === dest);
    const shown = folder ? shownFolder(folder) : dest;
    try {
      const answer = await request("ui/confirm", {
        title: t("confirmTitle"),
        message: ((isDir ? t("confirmFolder", name, shown) : t("confirmFile", name, shown)) + "\n\n" + t("confirmHint")).slice(0, 2000),
        confirmLabel: t("confirmOk"),
      });
      if (!answer || !answer.confirmed) return;
    } catch (error) {
      if (error.code !== -32001) notify(error.message, "error");
      return;
    }
  } else {
    // No remembered folder: the picker is the confirmation.
    const choice = await chooseDestination("download", { name, isDir });
    if (!choice) return;
    dest = choice.path;
    if (choice.remember) await remember(dest);
  }
  try {
    const job = await tool("export_start", { path, destination: dest });
    trackJob(job);
  } catch (error) {
    notify(error.message, "error");
  }
}

function trackJob(job) {
  state.jobs.set(job.id, job);
  renderJobs();
  const poll = async () => {
    let next;
    try {
      next = await tool("export_status", { job: job.id });
    } catch (error) {
      next = Object.assign({}, job, { state: "failed", error: error.message });
    }
    state.jobs.set(job.id, next);
    renderJobs();
    if (next.state === "running") { setTimeout(poll, 700); return; }
    if (next.state === "done") {
      const skipped = next.skipped ? ` (${t("jobSkipped", next.skipped)})` : "";
      notify(t("savedTo", next.result) + skipped);
    } else if (next.state === "failed") {
      notify(t("jobFailed", next.name, next.error || ""), "error");
    }
    setTimeout(() => { state.jobs.delete(job.id); renderJobs(); }, next.state === "done" ? 15000 : 8000);
  };
  setTimeout(poll, 300);
}

function renderJobs() {
  const host = $("jobs");
  host.replaceChildren();
  for (const job of state.jobs.values()) {
    const span = el("span", "job " + job.state);
    if (job.state === "running") {
      const done = job.bytes_total ? `${Math.floor((job.bytes_done / Math.max(1, job.bytes_total)) * 100)}%` : formatSize(job.bytes_done);
      span.textContent = t("jobRunning", job.name, done) + " ";
      const stop = el("button", "link-btn", t("cancelJob"));
      stop.type = "button";
      stop.addEventListener("click", () => tool("export_cancel", { job: job.id }).catch(() => {}));
      span.appendChild(stop);
    } else if (job.state === "done") {
      span.textContent = t("jobDone", baseName(job.result || job.name)) + (job.skipped ? ` · ${t("jobSkipped", job.skipped)}` : "") + " ";
      const copy = el("button", "link-btn", t("copyPath"));
      copy.type = "button";
      copy.addEventListener("click", () => copyText(job.result, job.result));
      span.appendChild(copy);
    } else if (job.state === "failed") {
      span.textContent = t("jobFailed", job.name, job.error || "");
    } else {
      span.textContent = t("jobCancelled", job.name);
    }
    host.appendChild(span);
  }
}

// ------------------------------------------------------------------ toolbar

function decorate() {
  document.querySelectorAll("[data-text]").forEach(node => { node.textContent = t(node.dataset.text); });
  const buttons = { "edit-path-btn": "edit", "hidden-btn": "eye", "refresh-btn": "refresh" };
  for (const [id, name] of Object.entries(buttons)) {
    const button = $(id);
    button.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
    button.title = t(button.dataset.title);
    button.setAttribute("aria-label", t(button.dataset.title));
  }
  document.documentElement.lang = locale;
}

$("edit-path-btn").addEventListener("click", showPathInput);
$("hidden-btn").addEventListener("click", toggleHidden);
$("refresh-btn").addEventListener("click", () => { refreshPlaces(); refresh(); });
$("copy-btn").addEventListener("click", () => copyText(currentPath(), currentPath()));
$("download-btn").addEventListener("click", () => startExport(currentPath()));
$("dest-btn").addEventListener("click", pickDestination);

function applyTheme(theme) {
  if (!theme) return;
  const root = document.documentElement;
  root.dataset.scheme = theme.scheme === "dark" ? "dark" : "light";
  for (const [name, value] of Object.entries(theme.tokens || {})) {
    if (/^[a-z-]+$/.test(name) && typeof value === "string") root.style.setProperty("--" + name, value);
  }
}

// ------------------------------------------------------------------ start

async function start() {
  let init;
  try {
    init = await request("ui/initialize", { protocolVersion: 1 });
  } catch (error) {
    $("empty-note").hidden = false;
    $("empty-note").textContent = t("startFailed", error.message);
    return;
  }
  locale = pickLocale(init.locale);
  strings = STRINGS[locale];
  applyTheme(init.theme);
  decorate();
  const saved = init.state && typeof init.state === "object" ? init.state : {};
  state.showHidden = Boolean(saved.showHidden);
  $("hidden-btn").setAttribute("aria-pressed", String(state.showHidden));
  await refreshPlaces();
  if (!state.places) {
    $("empty-note").hidden = false;
    $("empty-note").textContent = t("startFailed", "places");
    return;
  }
  const home = state.places.home;
  const opened = (typeof saved.path === "string" && await openPath(typeof saved.root === "string" ? saved.root : "/", saved.path, { quiet: true }))
    || await openPath(home, home, { quiet: true })
    || await openPath("/", "/");
  if (!opened) {
    $("empty-note").hidden = false;
    $("empty-note").textContent = t("notFound", home);
  }
  $("browser").focus({ preventScroll: true });
}

start();
