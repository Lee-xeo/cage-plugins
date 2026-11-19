// Talks to the workbench that frames this page: JSON-RPC 2.0 over postMessage.
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
  if (message.method === "ui/themeChanged") setScheme(message.params && message.params.scheme);
  if (message.method === "ui/visibilityChanged") visible = !message.params || message.params.visible !== false;
  const pending = waiting.get(message.id);
  if (!pending) return;
  waiting.delete(message.id);
  if (message.error) pending.reject(new Error(message.error.message || "request failed"));
  else pending.resolve(message.result);
});

let visible = true;
const element = id => document.getElementById(id);
const setScheme = scheme => { document.documentElement.dataset.scheme = scheme === "dark" ? "dark" : "light"; };
const gigabytes = bytes => (bytes / 1073741824).toFixed(1) + " GB";

function meter(name, share, text) {
  const bar = element(name + "-bar");
  bar.style.width = Math.max(0, Math.min(100, share * 100)).toFixed(1) + "%";
  bar.classList.toggle("high", share > 0.85);
  element(name + "-text").textContent = text;
}

async function refresh() {
  if (!visible) return;
  try {
    const result = await request("tools/call", { name: "system_status", arguments: {} });
    if (result.isError) throw new Error(result.content && result.content[0] ? result.content[0].text : "the tool failed");
    const status = result.structuredContent || JSON.parse(result.content[0].text);
    meter("load", status.load["1m"] / status.processors, status.load["1m"] + " of " + status.processors + " processors");
    meter("memory", status.memory.used_bytes / status.memory.total_bytes, gigabytes(status.memory.used_bytes) + " of " + gigabytes(status.memory.total_bytes));
    meter("disk", status.disk.used_bytes / status.disk.total_bytes, gigabytes(status.disk.used_bytes) + " of " + gigabytes(status.disk.total_bytes));
    const hours = Math.floor(status.uptime_seconds / 3600), minutes = Math.floor(status.uptime_seconds % 3600 / 60);
    element("uptime").textContent = "Running for " + hours + " h " + minutes + " min";
    element("note").hidden = true;
    element("meters").hidden = false;
  } catch (failure) {
    element("note").hidden = false;
    element("note").textContent = "Could not read the status: " + failure.message;
  }
}

request("ui/initialize", { protocolVersion: 1 }).then(result => {
  setScheme(result && result.theme && result.theme.scheme);
  refresh();
  setInterval(refresh, 5000);
}, failure => { element("note").textContent = "Could not start: " + failure.message; });
