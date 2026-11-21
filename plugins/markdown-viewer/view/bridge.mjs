const THEME_KEYS = [
  "paper", "ink", "strong", "muted", "line", "chrome", "hover", "selected",
  "accent", "link", "focus", "input", "button", "button-ink", "success", "danger",
];

const waiting = new Map();
let nextId = 1;
let visible = true;
let hostTheme = null;
let themeMode = "system"; // "system" | "light" | "dark"
const themeListeners = new Set();
const visibilityListeners = new Set();

export function isVisible() {
  return visible;
}

export function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  });
}

function getSystemScheme() {
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

function renderActiveTheme() {
  const root = document.documentElement;
  if (themeMode === "light" || themeMode === "dark") {
    for (const key of THEME_KEYS) {
      root.style.removeProperty(`--${key}`);
    }
    root.dataset.scheme = themeMode;
    return;
  }

  // "system": prefer host theme tokens & scheme if provided, else follow OS prefers-color-scheme
  const scheme = hostTheme && (hostTheme.scheme === "dark" || hostTheme.scheme === "light")
    ? hostTheme.scheme
    : getSystemScheme();
  root.dataset.scheme = scheme;
  for (const key of THEME_KEYS) {
    if (hostTheme && typeof hostTheme[key] === "string" && hostTheme[key]) {
      root.style.setProperty(`--${key}`, hostTheme[key]);
    } else {
      root.style.removeProperty(`--${key}`);
    }
  }
}

export function applyTheme(theme) {
  if (theme && typeof theme === "object") {
    hostTheme = { ...theme };
  }
  renderActiveTheme();
}

export function setThemeMode(mode) {
  themeMode = mode === "light" || mode === "dark" ? mode : "system";
  renderActiveTheme();
}

export function getThemeMode() {
  return themeMode;
}

export function onThemeChanged(fn) {
  themeListeners.add(fn);
  return () => themeListeners.delete(fn);
}

export function onVisibilityChanged(fn) {
  visibilityListeners.add(fn);
  return () => visibilityListeners.delete(fn);
}

if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", () => {
      if (themeMode === "system") renderActiveTheme();
    });
  }
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (event.source !== window.parent || !message || message.jsonrpc !== "2.0") return;

  if (message.method === "ui/themeChanged") {
    const theme = message.params && message.params.theme ? message.params.theme : message.params;
    applyTheme(theme);
    for (const fn of themeListeners) fn(theme);
    return;
  }
  if (message.method === "ui/visibilityChanged") {
    visible = !message.params || message.params.visible !== false;
    for (const fn of visibilityListeners) fn(visible);
    return;
  }

  const pending = waiting.get(message.id);
  if (!pending) return;
  waiting.delete(message.id);
  if (message.error) {
    pending.reject(new Error(message.error.message || "request failed"));
  } else {
    pending.resolve(message.result);
  }
});

export async function copyText(text, notice) {
  try {
    await request("ui/copy", { text });
    if (notice) {
      await request("ui/notify", { level: "info", message: notice }).catch(() => {});
    }
  } catch (err) {
    await request("ui/notify", { level: "error", message: `复制失败: ${err.message}` }).catch(() => {});
  }
}

export async function initializeHost() {
  const result = await request("ui/initialize", { protocolVersion: 1 });
  applyTheme(result && result.theme);
  return result || {};
}
