const strings = {
  en: {
    title: "Service Preview",
    description: "Open HTTP services running in this environment.",
    refresh: "Refresh",
    open: "Open HTTP",
    loading: "Loading listeners…",
    empty: "No local TCP listeners found. Start a development server, then refresh.",
    count: (shown, total) => `Showing ${shown} of ${total} TCP listeners. Some may use protocols other than HTTP.`,
    port: port => `TCP port ${port}`,
    failed: reason => `Could not load services. ${reason}`,
    openFailed: reason => `Could not open the preview. ${reason}`,
  },
  zh: {
    title: "服务预览台",
    description: "在内置浏览器打开当前环境中的 HTTP 服务。",
    refresh: "刷新",
    open: "打开 HTTP 页面",
    loading: "正在读取监听端口…",
    empty: "没有找到本地 TCP 监听端口。启动开发服务后再刷新。",
    count: (shown, total) => `显示 ${shown} 个 TCP 监听端口，共 ${total} 个。部分端口可能使用其他协议。`,
    port: port => `TCP 端口 ${port}`,
    failed: reason => `无法读取服务列表。${reason}`,
    openFailed: reason => `无法打开预览。${reason}`,
  },
};
const title = document.getElementById("title");
const description = document.getElementById("description");
const refreshButton = document.getElementById("refresh");
const status = document.getElementById("status");
const list = document.getElementById("services");
const openError = document.getElementById("open-error");
const waiting = new Map();
let nextId = 1;
let copy = strings.en;
let visible = true;
let refreshing = false;
let lastRender = "";

function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timeout = setTimeout(() => {
      waiting.delete(id);
      reject(new Error("Request timed out."));
    }, 65000);
    waiting.set(id, { resolve, reject, timeout });
    window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  });
}

function setTheme(theme) {
  document.documentElement.dataset.scheme = theme?.scheme === "dark" ? "dark" : "light";
}

window.addEventListener("message", event => {
  const message = event.data;
  if (event.source !== window.parent || message?.jsonrpc !== "2.0") return;
  if (message.method === "ui/themeChanged") setTheme(message.params);
  if (message.method === "ui/visibilityChanged") {
    visible = message.params?.visible !== false;
    if (visible) refresh();
  }
  const pending = waiting.get(message.id);
  if (!pending) return;
  clearTimeout(pending.timeout);
  waiting.delete(message.id);
  if (message.error) pending.reject(new Error(message.error.message));
  else pending.resolve(message.result);
});

function serviceRow(service) {
  const path = service.path ?? "/";
  const url = `http://${service.host}:${service.port}${path}`;
  const row = document.createElement("li");
  const details = document.createElement("div");
  details.className = "details";
  const label = document.createElement("strong");
  label.textContent = service.label ?? copy.port(service.port);
  const address = document.createElement("code");
  address.textContent = url;
  details.append(label, address);

  const open = document.createElement("button");
  open.type = "button";
  open.textContent = copy.open;
  open.setAttribute("aria-label", `${copy.open} · ${label.textContent} · ${url}`);
  open.addEventListener("click", async () => {
    open.disabled = true;
    openError.hidden = true;
    try {
      await request("ui/openUrl", { url });
    } catch (failure) {
      openError.textContent = copy.openFailed(failure.message);
      openError.hidden = false;
    } finally {
      open.disabled = false;
    }
  });
  row.append(details, open);
  return row;
}

async function refresh() {
  if (!visible || refreshing) return;
  refreshing = true;
  try {
    const response = await request("tools/call", { name: "service_preview_list", arguments: {} });
    if (response.isError) throw new Error(response.content?.[0]?.text);
    const result = response.structuredContent ?? JSON.parse(response.content[0].text);
    const serialized = JSON.stringify(result.services);
    if (serialized !== lastRender) {
      list.replaceChildren(...result.services.map(serviceRow));
      lastRender = serialized;
    }
    status.removeAttribute("data-error");
    status.textContent = result.total ? copy.count(result.services.length, result.total) : copy.empty;
  } catch (failure) {
    status.setAttribute("data-error", "");
    status.textContent = copy.failed(failure.message);
    list.replaceChildren();
    lastRender = "";
  } finally {
    refreshing = false;
  }
}

request("ui/initialize", { protocolVersion: 1 }).then(result => {
  if (result.locale?.startsWith("zh")) copy = strings.zh;
  document.documentElement.lang = copy === strings.zh ? "zh-Hans" : "en";
  document.title = title.textContent = copy.title;
  description.textContent = copy.description;
  refreshButton.textContent = copy.refresh;
  status.textContent = copy.loading;
  setTheme(result.theme);
  refreshButton.disabled = false;
  refreshButton.addEventListener("click", refresh);
  refresh();
  setInterval(refresh, 5000);
}).catch(failure => {
  status.setAttribute("data-error", "");
  status.textContent = copy.failed(failure.message);
});
