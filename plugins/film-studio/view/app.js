// Film Studio sidebar page.
// Runs inside Cage's sandboxed frame: JSON-RPC 2.0 over postMessage, no network, no storage.
// Everything the page shows comes from the plugin's own tools (film_dashboard, film_setup, ...).

/* ------------------------------------------------------------------ */
/* Text. Simplified Chinese is the default; English is used when the   */
/* locale reported by Cage does not start with "zh".                   */
/* ------------------------------------------------------------------ */
const TEXT = {
  zh: {
    title: "Film Studio",
    loading: "正在读取状态…",
    refresh: "刷新",
    // status
    chipOpenfilm: v => `OpenFilm ${v || ""}`.trim(),
    installed: "已安装", missing: "未安装", ready: "就绪",
    chipBrowser: "渲染浏览器",
    chipFfmpeg: "ffmpeg",
    chipMemory: gb => `可用内存 ${gb} GB`,
    memoryHint: "做视频建议至少 8 GB 内存，可以在 Cage 的设置里调大。",
    studioRunning: "Studio 运行中", studioStopped: "Studio 未运行",
    openStudio: "打开 Studio",
    // banner
    bannerOpened: name => `Claude 刚打开了「${name}」`,
    bannerOpen: "在 Studio 中打开",
    // setup
    setupTitle: "还差几步才能开始",
    setupOpenfilm: mb => `安装 OpenFilm${mb ? `（下载约 ${mb} MB）` : ""}`,
    setupBrowser: mb => `下载渲染浏览器${mb ? `（约 ${mb} MB）` : ""}`,
    setupFfmpeg: "安装 ffmpeg（系统软件包）",
    setupAll: "一键准备",
    setupRunning: "正在准备…",
    setupFailed: "上次准备没有成功，详情见下方「任务」里的日志。",
    ffmpegManual: "ffmpeg 需要管理员权限。请在终端里运行下面的命令，装好后回到这里刷新：",
    copy: "复制", copied: "已复制",
    // films
    filmsTitle: "影片",
    filmsEmpty: "还没有影片。在下面新建一个，或者让 Claude 帮你做。",
    newName: "影片名称", newLocation: "保存位置（绝对路径）", newCreate: "新建影片",
    newNameBad: "请填写影片名称，不要包含 / 或 \\。",
    newLocBad: "保存位置需要是绝对路径，例如 /home/…/Videos。",
    openInStudio: "在 Studio 中打开",
    studioAlready: name => `Studio 已经显示「${name}」。`,
    render: "渲染", render1080: "渲染 1080p", render4k: "渲染 4K", renderLoud: "发布音量 -14 LUFS",
    copyPath: "复制路径",
    renderConfirmTitle: "开始渲染？",
    renderConfirm: (name, what) => `将渲染「${name}」（${what}）。渲染会占用较多内存和处理器。`,
    renderStarted: "已开始渲染，进度见「任务」。",
    renderKind1080: "1080p", renderKind4k: "4K", renderKindLoud: "1080p，发布音量 -14 LUFS",
    modified: when => `修改于 ${when}`,
    video: size => `已渲染视频 ${size}`,
    noThumb: "无预览", thumbLoading: "预览加载中…",
    missingFolder: "（文件夹不存在）",
    // time
    justNow: "刚刚", minAgo: n => `${n} 分钟前`, hourAgo: n => `${n} 小时前`, dayAgo: n => `${n} 天前`,
    // jobs
    jobsTitle: "任务", jobsEmpty: "还没有任务。",
    state: { queued: "排队中", running: "进行中", done: "已完成", failed: "失败", cancelled: "已取消", stopped: "已停止" },
    units: { frames: "帧", packages: "个包", MB: "MB" },
    about: n => `约 ${n}`, sec: n => `${n} 秒`, min: n => `${n} 分钟`,
    elapsed: s => `已用 ${s}`,
    showLog: "日志", noLog: "（暂无日志）",
    cancel: "取消",
    cancelConfirmTitle: "取消渲染？", cancelConfirm: title => `「${title}」会被停止，已渲染的部分不会保留。`,
    cancelConfirmLabel: "取消渲染", cancelStarted: "已请求取消。",
    // settings
    settingsTitle: "设置",
    terminalToggle: "在终端中使用 openfilm 命令",
    terminalHint: "开启后可在终端直接输入 openfilm。命令位置：",
    defaultLoudness: "渲染默认使用发布音量（-14 LUFS）",
    // problems
    approvalTitle: "需要授权才能继续",
    approvalBody: "Cage 会对这个插件的每次调用单独询问是否允许。请打开本插件的详情页，进入「授权与权限」，打开「始终允许」（安装时也可以勾选「安装后始终允许」），然后点「重试」。",
    notRunning: "插件没有在运行。请稍后点「重试」；如果一直这样，请在插件列表里检查它是否已启用。",
    timedOut: "调用超时了。电脑可能正忙，请稍后点「重试」。",
    genericProblem: msg => `读取状态失败：${msg}`,
    retry: "重试",
    failed: msg => msg,
  },
  en: {
    title: "Film Studio",
    loading: "Loading status…",
    refresh: "Refresh",
    chipOpenfilm: v => `OpenFilm ${v || ""}`.trim(),
    installed: "installed", missing: "not installed", ready: "ready",
    chipBrowser: "Render browser",
    chipFfmpeg: "ffmpeg",
    chipMemory: gb => `Free memory ${gb} GB`,
    memoryHint: "Video work wants at least 8 GB; raise it in Cage's settings.",
    studioRunning: "Studio running", studioStopped: "Studio not running",
    openStudio: "Open Studio",
    bannerOpened: name => `Claude just opened "${name}"`,
    bannerOpen: "Open in Studio",
    setupTitle: "A few steps before you start",
    setupOpenfilm: mb => `Install OpenFilm${mb ? ` (about ${mb} MB download)` : ""}`,
    setupBrowser: mb => `Download the render browser${mb ? ` (about ${mb} MB)` : ""}`,
    setupFfmpeg: "Install ffmpeg (system package)",
    setupAll: "Set everything up",
    setupRunning: "Setting up…",
    setupFailed: "The last setup did not finish; see the log under Jobs below.",
    ffmpegManual: "ffmpeg needs administrator rights. Run this command in the terminal, then refresh here:",
    copy: "Copy", copied: "Copied",
    filmsTitle: "Films",
    filmsEmpty: "No films yet. Create one below, or ask Claude to make one.",
    newName: "Film name", newLocation: "Location (absolute path)", newCreate: "New film",
    newNameBad: "Enter a film name without / or \\.",
    newLocBad: "The location must be an absolute path, e.g. /home/.../Videos.",
    openInStudio: "Open in Studio",
    studioAlready: name => `Studio already shows "${name}".`,
    render: "Render", render1080: "Render 1080p", render4k: "Render 4K", renderLoud: "Release loudness -14 LUFS",
    copyPath: "Copy path",
    renderConfirmTitle: "Start rendering?",
    renderConfirm: (name, what) => `"${name}" will be rendered (${what}). Rendering uses a lot of memory and CPU.`,
    renderStarted: "Rendering started; see Jobs for progress.",
    renderKind1080: "1080p", renderKind4k: "4K", renderKindLoud: "1080p, release loudness -14 LUFS",
    modified: when => `Modified ${when}`,
    video: size => `Rendered video ${size}`,
    noThumb: "No preview", thumbLoading: "Loading preview…",
    missingFolder: "(folder missing)",
    justNow: "just now", minAgo: n => `${n} min ago`, hourAgo: n => `${n} h ago`, dayAgo: n => `${n} d ago`,
    jobsTitle: "Jobs", jobsEmpty: "No jobs yet.",
    state: { queued: "Queued", running: "Running", done: "Done", failed: "Failed", cancelled: "Cancelled", stopped: "Stopped" },
    units: { frames: "frames", packages: "packages", MB: "MB" },
    about: n => `about ${n}`, sec: n => `${n} s`, min: n => `${n} min`,
    elapsed: s => `elapsed ${s}`,
    showLog: "Log", noLog: "(no log yet)",
    cancel: "Cancel",
    cancelConfirmTitle: "Cancel this render?", cancelConfirm: title => `"${title}" will be stopped; what has been rendered is not kept.`,
    cancelConfirmLabel: "Cancel render", cancelStarted: "Cancel requested.",
    settingsTitle: "Settings",
    terminalToggle: "Use the openfilm command in the terminal",
    terminalHint: "When on, you can type openfilm in the terminal. Command location: ",
    defaultLoudness: "Render with release loudness (-14 LUFS) by default",
    approvalTitle: "Approval needed to continue",
    approvalBody: "Cage asks for approval on every call of this plugin. Open the plugin's details page, go to \"授权与权限\" (Authorization and permissions) and turn on \"始终允许\" (Always allow), or tick \"安装后始终允许\" when installing. Then press Retry.",
    notRunning: "The plugin is not running. Press Retry in a moment; if it persists, check that it is enabled in the plugin list.",
    timedOut: "The call timed out. The machine may be busy; press Retry in a moment.",
    genericProblem: msg => `Could not read the status: ${msg}`,
    retry: "Retry",
    failed: msg => msg,
  },
};
let T = TEXT.zh;

/* ------------------------------------------------------------------ */
/* JSON-RPC plumbing (same pattern as the system-status example).      */
/* Cage allows at most 8 concurrent requests; we cap at 6 and queue.   */
/* ------------------------------------------------------------------ */
const MAX_INFLIGHT = 6;
const waiting = new Map();
const queued = [];
let nextId = 1;
let inflight = 0;

function pump() {
  while (inflight < MAX_INFLIGHT && queued.length) {
    const { method, params, resolve, reject } = queued.shift();
    const id = nextId++;
    inflight++;
    waiting.set(id, { resolve, reject });
    window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  }
}

function request(method, params) {
  return new Promise((resolve, reject) => {
    queued.push({ method, params, resolve, reject });
    pump();
  });
}

window.addEventListener("message", event => {
  const message = event.data;
  if (event.source !== window.parent || !message || message.jsonrpc !== "2.0") return;
  if (message.method === "ui/themeChanged") { applyTheme(message.params); return; }
  if (message.method === "ui/visibilityChanged") { setVisible(!message.params || message.params.visible !== false); return; }
  const pending = waiting.get(message.id);
  if (!pending) return;
  waiting.delete(message.id);
  inflight--;
  if (message.error) {
    const error = new Error(message.error.message || "request failed");
    error.code = message.error.code;
    pending.reject(error);
  } else pending.resolve(message.result);
  pump();
});

/** Call one of this plugin's tools. Resolves with the MCP result (may carry isError). */
async function callTool(name, args) {
  return (await request("tools/call", { name, arguments: args || {} })) || {};
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */
const $ = id => document.getElementById(id);
const clip = (text, max) => (String(text).length > max ? String(text).slice(0, max - 1) + "…" : String(text));

/** Tiny DOM builder: h("button", {class:"x", onclick: fn, text:"…"}, child, …). */
function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Text of a tool result, for error messages. */
function resultText(result) {
  const first = result && Array.isArray(result.content) ? result.content.find(c => c && typeof c.text === "string") : null;
  return first ? first.text : "";
}

function notify(message, tone) {
  return request("ui/notify", { message: clip(message, 500), tone: tone === "error" ? "error" : "info" }).catch(() => {});
}

async function copyText(text) {
  try { await request("ui/copy", { text }); notify(T.copied); } catch (error) { reportFailure(error); }
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + " GB";
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
  return Math.max(1, Math.round(n / 1024)) + " KB";
}

function relativeTime(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const minutes = Math.floor((Date.now() - ms) / 60000);
  if (minutes < 1) return T.justNow;
  if (minutes < 60) return T.minAgo(minutes);
  if (minutes < 1440) return T.hourAgo(Math.floor(minutes / 60));
  return T.dayAgo(Math.floor(minutes / 1440));
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return T.sec(s);
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}:${String(s % 60).padStart(2, "0")}` : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const isActive = job => job && (job.state === "queued" || job.state === "running");
const baseName = path => String(path || "").split(/[\\/]/).filter(Boolean).pop() || String(path || "");
const parentOf = path => { const cut = Math.max(String(path).lastIndexOf("/"), String(path).lastIndexOf("\\")); return cut > 0 ? String(path).slice(0, cut) : ""; };
const isAbsolute = path => /^(\/|[A-Za-z]:[\\/])/.test(path);

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */
let dash = null;                       // last film_dashboard result
let visible = true;
let problem = null;                    // {code, message} while a card is shown
let ui = { settingsOpen: false, defaults: { loudness: false } };   // persisted with ui/setState
const thumbs = new Map();              // folder -> {status:"loading"|"ok"|"error", url?, modified}
const expandedLogs = new Set();        // job ids whose log is open
let menuFolder = null;                 // film whose render menu is open
let bannerDismissedAt = null;          // lastOpened.at the person already dismissed
let ffmpegManual = false;              // setup said ffmpeg needs a manual command
let locationTouched = false;
const lastSig = {};                    // section -> signature, to avoid needless DOM rebuilds

function saveUi() { request("ui/setState", { state: ui }).catch(() => {}); }

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */
let appliedTokens = [];
function applyTheme(theme) {
  const root = document.documentElement;
  root.dataset.scheme = theme && theme.scheme === "dark" ? "dark" : "light";
  for (const name of appliedTokens) root.style.removeProperty("--" + name);
  appliedTokens = [];
  const tokens = theme && theme.tokens;
  if (tokens && typeof tokens === "object") {
    for (const [name, value] of Object.entries(tokens)) {
      if (/^[a-z-]+$/.test(name) && typeof value === "string") { root.style.setProperty("--" + name, value); appliedTokens.push(name); }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Failure handling                                                    */
/* ------------------------------------------------------------------ */
/** Protocol-level failure (the call itself did not go through). */
function reportFailure(error) {
  const code = error && error.code;
  if (code === -32001 || code === -32003 || code === -32004) setProblem({ code });
  else notify(error && error.message ? error.message : String(error), "error");
}

/** Tool-reported failure (isError). Returns true if the result was an error. */
function toolFailed(result) {
  if (!result || !result.isError) return false;
  notify(resultText(result) || "failed", "error");
  return true;
}

function setProblem(next) {
  problem = next;
  if (next) clearTimeout(timer);
  renderProblem();
  if (!next) refresh();
}

function renderProblem() {
  const box = $("problem");
  if (!problem) { box.hidden = true; box.replaceChildren(); return; }
  let title = T.approvalTitle, body = T.approvalBody;
  if (problem.code === -32003) { title = T.retry; body = T.notRunning; }
  else if (problem.code === -32004) { title = T.retry; body = T.timedOut; }
  else if (problem.code === undefined || ![-32001].includes(problem.code)) { title = ""; body = T.genericProblem(problem.message || ""); }
  box.replaceChildren(
    title ? h("h2", { text: title }) : null,
    h("p", { text: body }),
    h("div", { class: "actions" }, h("button", { type: "button", class: "primary", text: T.retry, onclick: () => setProblem(null) })),
  );
  box.hidden = false;
  $("loading").hidden = true;
}

/* ------------------------------------------------------------------ */
/* Polling: one dashboard call at a time, 3 s while a job is active.   */
/* ------------------------------------------------------------------ */
let timer = 0;
let refreshing = false;
let refreshAgain = false;

function schedule() {
  clearTimeout(timer);
  if (!visible || (problem && problem.code !== undefined && [-32001, -32003, -32004].includes(problem.code))) return;
  const active = dash && Array.isArray(dash.jobs) && dash.jobs.some(isActive);
  timer = setTimeout(refresh, active ? 3000 : 15000);
}

async function refresh() {
  clearTimeout(timer);
  if (!visible) return;
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  try {
    const result = await callTool("film_dashboard", {});
    if (result.isError) throw Object.assign(new Error(resultText(result) || "film_dashboard failed"), { code: -32005 });
    const data = result.structuredContent;
    if (!data || typeof data !== "object") throw Object.assign(new Error("empty dashboard"), { code: -32005 });
    dash = data;
    if (problem) { problem = null; renderProblem(); }
    renderAll();
    pumpThumbs();
  } catch (error) {
    const code = error && error.code;
    if ([-32001, -32003, -32004].includes(code)) problem = { code };
    else problem = { code: code || -1, message: error && error.message };
    renderProblem();
  } finally {
    refreshing = false;
    if (refreshAgain) { refreshAgain = false; refresh(); } else schedule();
  }
}

function setVisible(value) {
  visible = value;
  if (visible) { refresh(); pumpThumbs(); } else clearTimeout(timer);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */
/** Only rebuild a section when its view model changed, so open menus, selections and scroll survive polling. */
function renderIfChanged(name, model, build) {
  const sig = JSON.stringify(model);
  if (lastSig[name] === sig) return;
  lastSig[name] = sig;
  build();
}

function renderAll() {
  if (!dash) return;
  $("loading").hidden = true;
  renderStatus();
  renderBanner();
  renderSetup();
  renderFilms();
  renderJobs();
  renderSettings();
}

function chip(kind, text) { return h("span", { class: "chip " + kind, text }); }

/* 1. Status chips */
function renderStatus() {
  const box = $("status");
  const of = dash.openfilm || {}, br = dash.browser || {}, ff = dash.ffmpeg || {}, mem = dash.memory || {}, st = dash.studio || {};
  const availableMB = Number(mem.availableMB);
  const lowMemory = Number.isFinite(availableMB) && availableMB < 3072;
  const model = [of, br, ff, availableMB, st.running];
  renderIfChanged("status", model, () => {
    box.replaceChildren(
      chip(of.installed ? "ok" : "bad", `${T.chipOpenfilm(of.version)} · ${of.installed ? T.installed : T.missing}`),
      chip(br.installed ? "ok" : "bad", `${T.chipBrowser} · ${br.installed ? T.ready : T.missing}`),
      chip(ff.found ? "ok" : "bad", `${T.chipFfmpeg}${ff.found && ff.version ? " " + ff.version : ""} · ${ff.found ? T.installed : T.missing}`),
      Number.isFinite(availableMB) ? chip(lowMemory ? "warn" : "ok", T.chipMemory((availableMB / 1024).toFixed(1))) : null,
      chip(st.running ? "ok" : "", st.running ? T.studioRunning : T.studioStopped),
      h("button", { type: "button", class: "primary", text: T.openStudio, onclick: ev => openStudioTop(ev.currentTarget) }),
      lowMemory ? h("p", { class: "hint", text: T.memoryHint }) : null,
    );
  });
  box.hidden = false;
}

/* Banner for the film Claude opened recently */
function renderBanner() {
  const box = $("banner");
  const last = dash.lastOpened;
  const at = last && Date.parse(last.at);
  const fresh = last && Number.isFinite(at) && Date.now() - at < 10 * 60 * 1000 && last.at !== bannerDismissedAt;
  if (!fresh) { box.hidden = true; lastSig.banner = null; recentFolder = null; return; }
  recentFolder = last.folder;
  const name = filmName(last.folder, last.shown);
  renderIfChanged("banner", [last.folder, name], () => {
    box.replaceChildren(
      h("span", { text: T.bannerOpened(name) }),
      h("span", { class: "actions" },
        h("button", { type: "button", class: "primary", text: T.bannerOpen, onclick: ev => openFilmInStudio(last.folder, name, ev.currentTarget) }),
        h("button", { type: "button", class: "ghost", "aria-label": "×", text: "×", onclick: () => { bannerDismissedAt = last.at; renderBanner(); renderFilms(); } }),
      ),
    );
  });
  box.hidden = false;
}
let recentFolder = null;

function filmName(folder, shown) {
  const film = (dash && dash.films || []).find(f => f && f.folder === folder);
  return (film && film.name) || baseName(shown || folder);
}

/* 2. Setup card (only while something is missing) */
function renderSetup() {
  const box = $("setup");
  const of = dash.openfilm || {}, br = dash.browser || {}, ff = dash.ffmpeg || {}, setup = dash.setup || {};
  const missing = [];
  if (!of.installed) missing.push(T.setupOpenfilm(setup.downloadMB && setup.downloadMB.openfilm));
  if (!br.installed) missing.push(T.setupBrowser(setup.downloadMB && setup.downloadMB.browser));
  if (!ff.found) missing.push(T.setupFfmpeg);
  const jobs = Array.isArray(dash.jobs) ? dash.jobs : [];
  const running = jobs.find(j => j && j.kind === "setup" && isActive(j));
  const latestSetup = jobs.find(j => j && j.kind === "setup");
  const lastFailed = !running && latestSetup && latestSetup.state === "failed";
  const showCommand = !ff.found && (setup.sudo === false || ffmpegManual);
  if (!missing.length) { box.hidden = true; lastSig.setup = null; ffmpegManual = false; return; }
  const model = [missing, running && [running.id, running.progress, running.state], lastFailed, showCommand, setup.ffmpegCommand];
  renderIfChanged("setup", model, () => {
    box.replaceChildren(
      h("h2", { text: T.setupTitle }),
      h("ul", { class: "steps" }, missing.map(text => h("li", { text }))),
      running ? progressBlock(running) : null,
      lastFailed ? h("p", { class: "note", text: T.setupFailed }) : null,
      h("div", { class: "actions" },
        h("button", { type: "button", class: "primary", disabled: !!running, text: running ? T.setupRunning : T.setupAll, onclick: ev => runSetup(ev.currentTarget) })),
      showCommand ? h("div", {},
        h("p", { class: "note", text: T.ffmpegManual }),
        h("div", { class: "cmd" },
          h("code", { text: setup.ffmpegCommand || "sudo apt-get install -y ffmpeg" }),
          h("button", { type: "button", text: T.copy, onclick: () => copyText(setup.ffmpegCommand || "sudo apt-get install -y ffmpeg") }))) : null,
    );
  });
  box.hidden = false;
}

async function runSetup(button) {
  button.disabled = true;
  try {
    const result = await callTool("film_setup", { step: "all" });
    if (result.isError) {
      // Most likely ffmpeg cannot be installed without a password: show the manual command.
      ffmpegManual = true;
      lastSig.setup = null;
      notify(resultText(result) || "setup failed", "error");
    }
  } catch (error) { reportFailure(error); }
  await refresh();
  lastSig.setup = null; renderSetup();
}

/* 3. Films */
function filmModel(film) {
  const thumb = thumbs.get(film.folder);
  return {
    folder: film.folder, shown: film.shown || film.folder, name: film.name || baseName(film.folder),
    exists: film.exists !== false, modified: film.modified ? relativeTime(film.modified) : "",
    video: film.video && film.video.bytes ? formatBytes(film.video.bytes) : "",
    thumb: thumb && thumb.status === "ok" ? thumb.url.length : thumb && thumb.status,
    recent: film.folder === recentFolder, menu: menuFolder === film.folder,
  };
}

function renderFilms() {
  const films = Array.isArray(dash && dash.films) ? dash.films.filter(f => f && f.folder) : [];
  const models = films.map(filmModel);
  $("films-section").hidden = false;
  renderIfChanged("films", models, () => {
    $("films-empty").hidden = films.length > 0;
    $("films").replaceChildren(...films.map((film, i) => filmItem(film, models[i])));
  });
  // Default location for the "new film" form: parent of the most recent film.
  const input = $("new-loc");
  if (!locationTouched && !input.dataset.filled) {
    let newest = null;
    for (const f of films) if (f.modified && (!newest || Date.parse(f.modified) > Date.parse(newest.modified))) newest = f;
    const parent = parentOf((newest || films[0] || {}).folder || "");
    input.value = parent || "~/Videos/OpenFilm/Projects";
    input.dataset.filled = "1";
  }
}

function filmItem(film, m) {
  const thumb = thumbs.get(film.folder);
  const thumbNode = thumb && thumb.status === "ok"
    ? h("div", { class: "thumb", style: `background-image:url("${thumb.url}")`, role: "img", "aria-label": m.name })
    : h("div", { class: "thumb empty" , text: "" });
  const alt = !thumb || thumb.status === "loading" ? T.thumbLoading : T.noThumb;
  if (!(thumb && thumb.status === "ok")) thumbNode.setAttribute("title", alt);
  const meta = [m.modified && T.modified(m.modified), m.video && T.video(m.video), !m.exists && T.missingFolder].filter(Boolean).join(" · ");
  return h("li", { class: "film" + (m.recent ? " recent" : "") },
    thumbNode,
    h("div", { class: "film-main" },
      h("div", { class: "film-name", text: m.name }),
      h("div", { class: "film-path", text: m.shown }),
      meta ? h("div", { class: "film-meta", text: meta }) : null,
      h("div", { class: "actions" },
        h("button", { type: "button", class: "primary", text: T.openInStudio, onclick: ev => openFilmInStudio(film.folder, m.name, ev.currentTarget) }),
        h("div", { class: "menu-wrap" },
          h("button", { type: "button", text: T.render + " ▾", "aria-haspopup": "menu", "aria-expanded": String(m.menu),
            onclick: ev => { ev.stopPropagation(); menuFolder = m.menu ? null : film.folder; renderFilms(); } }),
          m.menu ? h("div", { class: "menu", role: "menu" },
            menuItem(T.render1080, () => startRender(film, m.name, {}, T.renderKind1080)),
            menuItem(T.render4k, () => startRender(film, m.name, { uhd: true }, T.renderKind4k)),
            menuItem(T.renderLoud, () => startRender(film, m.name, { loudness: -14 }, T.renderKindLoud, true))) : null),
        h("button", { type: "button", text: T.copyPath, onclick: () => copyText(film.folder) }),
      )));
}
function menuItem(text, handler) { return h("button", { type: "button", role: "menuitem", text, onclick: handler }); }

async function openStudioTop(button) {
  button.disabled = true;
  try {
    const result = await callTool("film_studio", {});
    if (toolFailed(result)) return;
    const url = result.structuredContent && result.structuredContent.url;
    if (url) await request("ui/openUrl", { url });
  } catch (error) { reportFailure(error); } finally { button.disabled = false; }
}

async function openFilmInStudio(folder, name, button) {
  if (button) button.disabled = true;
  try {
    const result = await callTool("film_studio", { folder });
    if (toolFailed(result)) return;
    const data = result.structuredContent || {};
    if (data.alreadyOpen) notify(T.studioAlready(name));
    else if (data.url) await request("ui/openUrl", { url: data.url });
    refresh();
  } catch (error) { reportFailure(error); } finally { if (button) button.disabled = false; }
}

async function startRender(film, name, options, what, forceLoudness) {
  menuFolder = null; renderFilms();
  try {
    const { confirmed } = await request("ui/confirm", { title: T.renderConfirmTitle, message: T.renderConfirm(name, what), confirmLabel: T.render });
    if (!confirmed) return;
    const args = { folder: film.folder, wait_seconds: 0, ...options };
    if (forceLoudness || ui.defaults.loudness) args.loudness = -14;
    const result = await callTool("film_render", args);
    if (toolFailed(result)) return;
    notify(T.renderStarted);
    refresh();
  } catch (error) { reportFailure(error); }
}

/* Thumbnails: strictly one film_thumbnail call at a time, only for films not yet loaded. */
let thumbBusy = false;
async function pumpThumbs() {
  if (thumbBusy || !visible || problem || !dash) return;
  const films = Array.isArray(dash.films) ? dash.films : [];
  const next = films.find(f => f && f.folder && f.exists !== false && (!thumbs.has(f.folder) || (thumbs.get(f.folder).modified !== (f.modified || null) && thumbs.get(f.folder).status !== "loading")));
  if (!next) return;
  thumbBusy = true;
  const previous = thumbs.get(next.folder);
  thumbs.set(next.folder, { status: previous && previous.status === "ok" ? "ok" : "loading", url: previous && previous.url, modified: next.modified || null });
  renderFilms();
  try {
    const result = await callTool("film_thumbnail", { folder: next.folder });
    const url = result.structuredContent && result.structuredContent.dataUrl;
    if (!result.isError && typeof url === "string" && url.startsWith("data:image/")) thumbs.set(next.folder, { status: "ok", url, modified: next.modified || null });
    else thumbs.set(next.folder, { status: "error", modified: next.modified || null });
  } catch (error) {
    thumbs.set(next.folder, { status: "error", modified: next.modified || null });
    if ([-32001, -32003, -32004].includes(error && error.code)) setProblem({ code: error.code });
  }
  thumbBusy = false;
  renderFilms();
  pumpThumbs();
}

/* New film form */
async function createFilm(event) {
  event.preventDefault();
  const name = $("new-name").value.trim();
  const location = $("new-loc").value.trim().replace(/[\\/]+$/, "");
  if (!name || /[\\/]/.test(name)) { notify(T.newNameBad, "error"); return; }
  if (!isAbsolute(location) && !location.startsWith("~/")) { notify(T.newLocBad, "error"); return; }
  const button = $("new-submit");
  button.disabled = true;
  try {
    const result = await callTool("film_studio", { folder: `${location}/${name}` });
    if (toolFailed(result)) return;
    $("new-name").value = "";
    const url = result.structuredContent && result.structuredContent.url;
    if (url) await request("ui/openUrl", { url });
    refresh();
  } catch (error) { reportFailure(error); } finally { button.disabled = false; }
}

/* 4. Jobs */
function progressBlock(job) {
  const p = job.progress;
  const total = p && Number(p.total) > 0 ? Number(p.total) : 0;
  const done = p ? Number(p.done) || 0 : 0;
  const pct = total ? Math.max(0, Math.min(100, (done / total) * 100)) : 0;
  const unit = p && p.unit ? (T.units[p.unit] || p.unit) : "";
  const left = p && Number.isFinite(Number(p.leftSeconds)) && p.leftSeconds !== null ? Number(p.leftSeconds) : null;
  const text = total ? `${done}/${total} ${unit}`.trim() : "";
  const leftText = left === null ? "" : T.about(left >= 120 ? T.min(Math.round(left / 60)) : T.sec(Math.round(left)));
  const bar = h("div", { class: "bar" + (total ? "" : " indeterminate"), role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": total ? String(Math.round(pct)) : null },
    h("i", { style: total ? `width:${pct.toFixed(1)}%` : null }));
  return h("div", {}, bar, (text || leftText) ? h("div", { class: "small", text: [text, leftText].filter(Boolean).join(" · ") }) : null);
}

function renderJobs() {
  const jobs = Array.isArray(dash && dash.jobs) ? dash.jobs.filter(j => j && j.id) : [];
  $("jobs-section").hidden = false;
  const model = jobs.map(j => [j.id, j.state, j.progress, j.outputs, j.tail, j.title, j.started, j.ended, expandedLogs.has(j.id)]);
  // Elapsed time of running jobs changes every poll anyway; include it so the display stays live.
  const clockTick = jobs.some(isActive) ? Math.floor(Date.now() / 3000) : 0;
  renderIfChanged("jobs", [model, clockTick], () => {
    $("jobs-empty").hidden = jobs.length > 0;
    $("jobs").replaceChildren(...jobs.map(jobItem));
    for (const pre of $("jobs").querySelectorAll("pre.tail")) pre.scrollTop = pre.scrollHeight;
  });
}

function jobItem(job) {
  const started = Date.parse(job.started), ended = job.ended ? Date.parse(job.ended) : Date.now();
  const elapsed = Number.isFinite(started) ? T.elapsed(formatDuration((ended - started) / 1000)) : "";
  const outputs = Array.isArray(job.outputs) ? job.outputs : [];
  const tail = Array.isArray(job.tail) ? job.tail : [];
  const state = T.state[job.state] ? job.state : "stopped";
  return h("li", { class: "job" },
    h("div", { class: "job-head" },
      h("span", { class: "job-title", text: job.title || job.kind || job.id }),
      h("span", { class: "actions" },
        h("span", { class: "badge " + state, text: T.state[state] }),
        isActive(job) ? h("button", { type: "button", class: "danger", text: T.cancel, onclick: ev => cancelJob(job, ev.currentTarget) }) : null)),
    isActive(job) ? progressBlock(job) : null,
    elapsed ? h("div", { class: "small", text: elapsed }) : null,
    outputs.length ? h("div", { class: "outputs" }, outputs.map(path => h("div", { class: "output" },
      h("code", { text: path }),
      h("button", { type: "button", text: T.copy, onclick: () => copyText(path) })))) : null,
    h("details", { class: "log", open: expandedLogs.has(job.id) ? true : null, ontoggle: ev => { ev.target.open ? expandedLogs.add(job.id) : expandedLogs.delete(job.id); } },
      h("summary", { text: T.showLog }),
      h("pre", { class: "tail", text: tail.length ? tail.join("\n") : T.noLog })));
}

async function cancelJob(job, button) {
  button.disabled = true;
  try {
    if (job.kind === "render") {
      const { confirmed } = await request("ui/confirm", { title: T.cancelConfirmTitle, message: T.cancelConfirm(job.title || job.id), confirmLabel: T.cancelConfirmLabel, danger: true });
      if (!confirmed) return;
    }
    const result = await callTool("film_cancel", { id: job.id });
    if (toolFailed(result)) return;
    notify(T.cancelStarted);
    refresh();
  } catch (error) { reportFailure(error); } finally { button.disabled = false; }
}

/* 5. Settings */
function renderSettings() {
  const term = (dash && dash.terminal) || {};
  const details = $("settings");
  $("settings-section").hidden = false;
  renderIfChanged("settings", [term, ui.defaults.loudness], () => {
    $("settings-body").replaceChildren(
      h("div", {},
        h("label", { class: "toggle" },
          h("input", { type: "checkbox", checked: term.linked ? true : null, onchange: ev => setTerminal(ev.target) }),
          h("span", { text: T.terminalToggle })),
        h("div", { class: "cmd" },
          h("span", { class: "small", text: T.terminalHint }),
          h("code", { text: term.command || "" }),
          term.command ? h("button", { type: "button", text: T.copy, onclick: () => copyText(term.command) }) : null)),
      h("label", { class: "toggle" },
        h("input", { type: "checkbox", checked: ui.defaults.loudness ? true : null, onchange: ev => { ui.defaults.loudness = ev.target.checked; saveUi(); } }),
        h("span", { text: T.defaultLoudness })),
    );
  });
  if (details.open !== ui.settingsOpen && !details.dataset.bound) details.open = ui.settingsOpen;
  if (!details.dataset.bound) {
    details.dataset.bound = "1";
    details.addEventListener("toggle", () => { ui.settingsOpen = details.open; saveUi(); });
  }
}

async function setTerminal(checkbox) {
  checkbox.disabled = true;
  try {
    const result = await callTool("film_terminal", { enable: checkbox.checked });
    if (toolFailed(result)) checkbox.checked = !checkbox.checked;
  } catch (error) { checkbox.checked = !checkbox.checked; reportFailure(error); }
  checkbox.disabled = false;
  refresh();
}

/* ------------------------------------------------------------------ */
/* Static text, global handlers, start-up                              */
/* ------------------------------------------------------------------ */
function applyStaticText() {
  document.documentElement.lang = T === TEXT.zh ? "zh-CN" : "en";
  $("title").textContent = T.title;
  $("refresh").textContent = T.refresh;
  $("loading").textContent = T.loading;
  $("films-title").textContent = T.filmsTitle;
  $("films-empty").textContent = T.filmsEmpty;
  $("new-name-label").textContent = T.newName;
  $("new-loc-label").textContent = T.newLocation;
  $("new-submit").textContent = T.newCreate;
  $("jobs-title").textContent = T.jobsTitle;
  $("jobs-empty").textContent = T.jobsEmpty;
  $("settings-title").textContent = T.settingsTitle;
}

$("refresh").addEventListener("click", () => { if (problem) setProblem(null); else refresh(); });
$("new-film").addEventListener("submit", createFilm);
$("new-loc").addEventListener("input", () => { locationTouched = true; });
document.addEventListener("click", () => { if (menuFolder) { menuFolder = null; renderFilms(); } });
document.addEventListener("keydown", event => { if (event.key === "Escape" && menuFolder) { menuFolder = null; renderFilms(); } });

applyStaticText();
request("ui/initialize", { protocolVersion: 1 }).then(init => {
  const locale = init && typeof init.locale === "string" ? init.locale : "zh-CN";
  T = locale.toLowerCase().startsWith("zh") ? TEXT.zh : TEXT.en;
  applyStaticText();
  applyTheme(init && init.theme);
  const saved = init && init.state;
  if (saved && typeof saved === "object") {
    ui = { settingsOpen: !!saved.settingsOpen, defaults: { loudness: !!(saved.defaults && saved.defaults.loudness) } };
  }
  refresh();
}, failure => {
  $("loading").textContent = failure.message;
});
