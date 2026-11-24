// Talks to the workbench that frames this view: JSON-RPC 2.0 over postMessage.
const waiting = new Map();
let nextId = 1;

function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  });
}

window.addEventListener("message", event => {
  const message = event.data;
  if (event.source !== window.parent || !message || message.jsonrpc !== "2.0") return;
  if (message.method === "ui/themeChanged") applyTheme(message.params);
  if (message.method === "ui/visibilityChanged") {
    const next = !message.params || message.params.visible !== false;
    const woke = !visible && next;
    visible = next;
    if (woke) refresh(false);
  }
  const pending = waiting.get(message.id);
  if (!pending) return;
  waiting.delete(message.id);
  if (message.error) pending.reject(new Error(message.error.message || "request failed"));
  else pending.resolve(message.result);
});

const STRINGS = {
  "zh-CN": {
    title: "系统状态",
    connecting: "正在读取状态…",
    cpu: "CPU",
    mem: "内存",
    disk: "磁盘",
    load: "负载",
    cores: n => `${n} 核`,
    loadInline: v => `负载 ${v}`,
    tasks: (r, t) => `${r}/${t} 进程`,
    uptime: (d, h, m) => d > 0 ? `运行 ${d}天 ${h}时` : h > 0 ? `运行 ${h}时 ${m}分` : `运行 ${m}分`,
    compactTip: "切换到精简视图",
    fullTip: "切换到详细视图",
    refreshTip: "立即刷新",
    failed: msg => `暂时无法读取状态：${msg}`,
    startFailed: msg => `无法启动：${msg}`,
    ringCpu: "CPU",
    ringMem: "内存",
    ringDisk: "磁盘",
  },
  "zh-TW": {
    title: "系統狀態",
    connecting: "正在讀取狀態…",
    cpu: "CPU",
    mem: "記憶體",
    disk: "磁碟",
    load: "負載",
    cores: n => `${n} 核`,
    loadInline: v => `負載 ${v}`,
    tasks: (r, t) => `${r}/${t} 程序`,
    uptime: (d, h, m) => d > 0 ? `運行 ${d}天 ${h}時` : h > 0 ? `運行 ${h}時 ${m}分` : `運行 ${m}分`,
    compactTip: "切換至精簡檢視",
    fullTip: "切換至詳細檢視",
    refreshTip: "立即重新整理",
    failed: msg => `暫時無法讀取狀態：${msg}`,
    startFailed: msg => `無法啟動：${msg}`,
    ringCpu: "CPU",
    ringMem: "記憶體",
    ringDisk: "磁碟",
  },
  en: {
    title: "System Status",
    connecting: "Loading status…",
    cpu: "CPU",
    mem: "Memory",
    disk: "Disk",
    load: "Load",
    cores: n => `${n}C`,
    loadInline: v => `Load ${v}`,
    tasks: (r, t) => `${r}/${t} tasks`,
    uptime: (d, h, m) => d > 0 ? `Up ${d}d ${h}h` : h > 0 ? `Up ${h}h ${m}m` : `Up ${m}m`,
    compactTip: "Compact view",
    fullTip: "Detailed view",
    refreshTip: "Refresh now",
    failed: msg => `Could not read status: ${msg}`,
    startFailed: msg => `Could not start: ${msg}`,
    ringCpu: "CPU",
    ringMem: "MEM",
    ringDisk: "DISK",
  },
};

let visible = true;
let isFloating = true;
let density = "full";
let text = STRINGS.en;
let inFlight = false;
let lastHeight = 0;
const cpuHistory = [];
const MAX_SAMPLES = 28;
const RING_CIRCUMFERENCE = 2 * Math.PI * 18;

const el = id => document.getElementById(id);

function pickStrings(locale) {
  const code = String(locale || "").toLowerCase();
  if (code === "zh-tw" || code === "zh-hk" || code === "zh-hant") return STRINGS["zh-TW"];
  if (code.startsWith("zh")) return STRINGS["zh-CN"];
  return STRINGS.en;
}

function applyLocale(locale) {
  text = pickStrings(locale);
  el("page-title").textContent = text.title;
  el("label-cpu").textContent = text.cpu;
  el("label-mem").textContent = text.mem;
  el("label-disk").textContent = text.disk;
  el("label-load").textContent = text.load;
  el("ring-cpu-label").textContent = text.ringCpu;
  el("ring-mem-label").textContent = text.ringMem;
  el("ring-disk-label").textContent = text.ringDisk;
  el("refresh-btn").title = text.refreshTip;
  el("refresh-btn").setAttribute("aria-label", text.refreshTip);
  updateDensityButton();
}

function applyTheme(theme) {
  const scheme = theme && theme.scheme === "dark" ? "dark" : "light";
  document.documentElement.dataset.scheme = scheme;
}

function toneFor(pct) {
  if (pct >= 85) return "high";
  if (pct >= 65) return "warn";
  return "ok";
}

function formatBytes(bytes) {
  const gb = bytes / 1073741824;
  if (gb >= 100) return gb.toFixed(0) + " GB";
  if (gb >= 1) return gb.toFixed(1) + " GB";
  return Math.max(0, Math.round(bytes / 1048576)) + " MB";
}

function formatRate(bps) {
  if (bps >= 1048576) return (bps / 1048576).toFixed(1) + "M/s";
  if (bps >= 1024) return (bps / 1024).toFixed(bps >= 10240 ? 0 : 1) + "K/s";
  return bps + "B/s";
}

function setBar(id, pct) {
  const clamped = Math.max(0, Math.min(100, pct));
  const bar = el(id);
  bar.style.width = clamped.toFixed(1) + "%";
  bar.dataset.tone = toneFor(clamped);
}

function setRing(id, valId, pct) {
  const clamped = Math.max(0, Math.min(100, pct));
  const ring = el(id);
  ring.style.strokeDashoffset = (RING_CIRCUMFERENCE * (1 - clamped / 100)).toFixed(2);
  ring.dataset.tone = toneFor(clamped);
  el(valId).textContent = Math.round(clamped) + "%";
}

function renderSparkline(samples, tone) {
  const wrap = el("spark").parentElement;
  wrap.dataset.tone = tone;
  const w = 132;
  const h = 52;
  const padTop = 5;
  const padBottom = 4;
  const usableH = h - padTop - padBottom;
  const points = samples.length >= 2 ? samples : [samples[0] || 0, samples[0] || 0];
  const step = w / (MAX_SAMPLES - 1);
  const startX = w - (points.length - 1) * step;

  const coords = points.map((v, i) => {
    const x = startX + i * step;
    const clamped = Math.max(0, Math.min(100, v));
    const y = padTop + usableH * (1 - clamped / 100);
    return [x, y];
  });

  let line = `M${coords[0][0].toFixed(1)},${coords[0][1].toFixed(1)}`;
  for (let i = 1; i < coords.length; i++) {
    const prev = coords[i - 1];
    const curr = coords[i];
    const midX = ((prev[0] + curr[0]) / 2).toFixed(1);
    line += ` Q${prev[0].toFixed(1)},${prev[1].toFixed(1)} ${midX},${((prev[1] + curr[1]) / 2).toFixed(1)}`;
  }
  const last = coords[coords.length - 1];
  line += ` T${last[0].toFixed(1)},${last[1].toFixed(1)}`;

  const area = `${line} L${last[0].toFixed(1)},${h} L${coords[0][0].toFixed(1)},${h} Z`;
  el("spark-line").setAttribute("d", line);
  el("spark-area").setAttribute("d", area);
  el("spark-dot").setAttribute("cx", last[0].toFixed(1));
  el("spark-dot").setAttribute("cy", last[1].toFixed(1));
}

function updateDensityButton() {
  const btn = el("density-btn");
  const tip = density === "compact" ? text.fullTip : text.compactTip;
  btn.title = tip;
  btn.setAttribute("aria-label", tip);
  btn.setAttribute("aria-pressed", String(density === "compact"));
}

function syncHeight() {
  if (!isFloating) return;
  requestAnimationFrame(() => {
    const height = Math.ceil(el("hud").getBoundingClientRect().height);
    if (height > 60 && Math.abs(height - lastHeight) >= 2) {
      lastHeight = height;
      request("ui/resize", { height }).catch(() => {});
    }
  });
}

function setDensity(next, persist) {
  density = next === "compact" ? "compact" : "full";
  document.documentElement.dataset.density = density;
  el("full-view").hidden = density === "compact";
  el("compact-view").hidden = density !== "compact";
  updateDensityButton();
  syncHeight();
  if (persist) {
    request("ui/setState", { state: { density } }).catch(() => {});
  }
}

function renderStatus(data) {
  const cores = Math.max(1, Number(data.processors) || 1);
  const load1 = Number(data.load && data.load["1m"]) || 0;
  const load5 = Number(data.load && data.load["5m"]) || 0;
  const load15 = Number(data.load && data.load["15m"]) || 0;
  const cpuPct = typeof data.cpu_percent === "number"
    ? Math.max(0, Math.min(100, data.cpu_percent))
    : Math.max(0, Math.min(100, (load1 / cores) * 100));

  cpuHistory.push(cpuPct);
  if (cpuHistory.length > MAX_SAMPLES) cpuHistory.shift();

  const cpuTone = toneFor(cpuPct);
  el("cpu-dot").dataset.tone = cpuTone;
  el("page-dot").dataset.tone = cpuTone;
  el("cpu-pct").textContent = Math.round(cpuPct) + "%";
  el("cpu-sub").textContent = `${text.cores(cores)} · ${text.loadInline(load1.toFixed(2))}`;
  renderSparkline(cpuHistory, cpuTone);

  const memTotal = Math.max(1, Number(data.memory && data.memory.total_bytes) || 1);
  const memUsed = Math.max(0, Number(data.memory && data.memory.used_bytes) || 0);
  const memPct = (memUsed / memTotal) * 100;
  el("mem-text").textContent = `${formatBytes(memUsed)} / ${formatBytes(memTotal)}`;
  el("mem-pct").textContent = Math.round(memPct) + "%";
  setBar("mem-bar", memPct);

  const diskTotal = Math.max(1, Number(data.disk && data.disk.total_bytes) || 1);
  const diskUsed = Math.max(0, Number(data.disk && data.disk.used_bytes) || 0);
  const diskPct = (diskUsed / diskTotal) * 100;
  el("disk-text").textContent = `${formatBytes(diskUsed)} / ${formatBytes(diskTotal)}`;
  el("disk-pct").textContent = Math.round(diskPct) + "%";
  setBar("disk-bar", diskPct);

  el("load-1m").textContent = load1.toFixed(2);
  el("load-5m").textContent = load5.toFixed(2);
  el("load-15m").textContent = load15.toFixed(2);

  const tasksEl = el("tasks-chip");
  if (data.tasks && typeof data.tasks.running === "number" && typeof data.tasks.total === "number") {
    tasksEl.textContent = text.tasks(data.tasks.running, data.tasks.total);
    tasksEl.hidden = false;
  } else {
    tasksEl.hidden = true;
  }

  setRing("ring-cpu", "ring-cpu-val", cpuPct);
  setRing("ring-mem", "ring-mem-val", memPct);
  setRing("ring-disk", "ring-disk-val", diskPct);

  const netEl = el("net-chip");
  if (data.network && typeof data.network.rx_bytes_per_sec === "number") {
    el("net-rx").textContent = "↓" + formatRate(data.network.rx_bytes_per_sec);
    el("net-tx").textContent = "↑" + formatRate(data.network.tx_bytes_per_sec);
    netEl.hidden = false;
  } else {
    netEl.hidden = true;
  }

  const up = Math.max(0, Number(data.uptime_seconds) || 0);
  const days = Math.floor(up / 86400);
  const hours = Math.floor((up % 86400) / 3600);
  const minutes = Math.floor((up % 3600) / 60);
  el("uptime").textContent = text.uptime(days, hours, minutes);

  el("state-panel").hidden = true;
  el("content").hidden = false;
  syncHeight();
}

async function refresh(manual) {
  if ((!visible && !manual) || inFlight) return;
  inFlight = true;
  const btn = el("refresh-btn");
  if (manual) btn.classList.add("spinning");
  try {
    const result = await request("tools/call", { name: "system_status", arguments: {} });
    if (result.isError) {
      throw new Error(result.content && result.content[0] ? result.content[0].text : "tool error");
    }
    const data = result.structuredContent || JSON.parse(result.content[0].text);
    renderStatus(data);
  } catch (failure) {
    el("skeleton").hidden = true;
    const note = el("note");
    note.classList.add("error");
    note.textContent = text.failed(failure.message);
    el("state-panel").hidden = false;
    el("content").hidden = true;
    syncHeight();
  } finally {
    inFlight = false;
    if (manual) {
      setTimeout(() => btn.classList.remove("spinning"), 260);
    }
  }
}

el("density-btn").addEventListener("click", () => {
  setDensity(density === "compact" ? "full" : "compact", true);
});

el("refresh-btn").addEventListener("click", () => {
  refresh(true);
});

request("ui/initialize", { protocolVersion: 1 }).then(result => {
  isFloating = (result && result.presentation) === "floating";
  document.documentElement.dataset.presentation = isFloating ? "floating" : "page";
  applyTheme(result && result.theme);
  applyLocale(result && result.locale);
  el("note").textContent = text.connecting;
  if (result && result.state && result.state.density === "compact") {
    setDensity("compact", false);
  } else {
    setDensity("full", false);
  }
  refresh(false);
  setInterval(() => refresh(false), 2000);
}, failure => {
  el("skeleton").hidden = true;
  const note = el("note");
  note.classList.add("error");
  note.textContent = text.startFailed(failure.message);
});
