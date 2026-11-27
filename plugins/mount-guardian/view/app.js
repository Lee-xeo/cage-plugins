(function () {
  "use strict";

  var seq = 0;
  var pending = {};

  function send(method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      window.parent.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params || {} }, "*");
    });
  }

  window.addEventListener("message", function (event) {
    var msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.id && pending[msg.id]) {
      var p = pending[msg.id];
      delete pending[msg.id];
      if (msg.error) p.reject(new Error(msg.error.message || "error"));
      else p.resolve(msg.result);
    }
  });

  function callTool(name, args) {
    return send("tools/call", { name: name, arguments: args || {} }).then(function (res) {
      if (res && res.isError) throw new Error(res.content && res.content[0] ? res.content[0].text : "tool error");
      var text = res && res.content && res.content[0] ? res.content[0].text : "{}";
      return JSON.parse(text);
    });
  }

  function notify(message, tone) {
    send("ui/notify", { message: message, tone: tone || "info" });
  }

  function applyTheme(theme) {
    if (!theme || !theme.tokens) return;
    var map = theme.tokens;
    var root = document.documentElement;
    Object.keys(map).forEach(function (key) {
      root.style.setProperty("--" + key, map[key]);
    });
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function tag(text, cls) {
    return el("span", "tag " + cls, text);
  }

  function render(status) {
    var dot = document.getElementById("overall-dot");
    var text = document.getElementById("overall-text");
    dot.className = "dot " + status.overall;
    text.textContent = status.overall === "ok" ? "全部正常"
      : status.overall === "degraded" ? "映射离线 · 镜像兜底中" : "存在断链";

    var list = document.getElementById("projects");
    list.textContent = "";
    if (!status.projects || !status.projects.length) {
      list.appendChild(el("div", "empty", "未配置项目"));
    }
    (status.projects || []).forEach(function (p) {
      var card = el("div", "card");
      var name = el("div", "name");
      name.appendChild(el("span", "dot " + p.state));
      name.appendChild(el("span", "", p.name));
      card.appendChild(name);
      card.appendChild(el("div", "path", p.path));
      var tags = el("div", "tags");
      tags.appendChild(p.live_mount
        ? tag("映射在线", "ok")
        : tag("映射离线", p.git_ok ? "warn" : "bad"));
      tags.appendChild(p.git_ok ? tag("git 正常", "ok") : tag("git 断链", "bad"));
      if (p.mirror && p.mirror.synced_at) {
        tags.appendChild(tag("镜像 " + p.mirror.synced_at.slice(5, 16), ""));
      } else {
        tags.appendChild(tag("无镜像", "warn"));
      }
      card.appendChild(tags);
      list.appendChild(card);
    });

    var cat = document.getElementById("catalog");
    if (status.catalog && status.catalog.ok) {
      cat.textContent = "工作区目录：" + status.catalog.worktrees + " 个 worktree · " +
        (status.catalog.agents === null ? "?" : status.catalog.agents) + " 个代理 · 检查于 " +
        (status.checked_at || "").slice(5, 19);
    } else {
      cat.textContent = "工作区目录不可用：" + (status.catalog && status.catalog.error ? status.catalog.error : "未知");
    }
  }

  function setBusy(busy) {
    ["btn-refresh", "btn-sync", "btn-heal"].forEach(function (id) {
      document.getElementById(id).disabled = busy;
    });
  }

  function refresh() {
    setBusy(true);
    callTool("mount_health").then(render).catch(function (e) {
      notify("检查失败：" + e.message, "error");
    }).finally(function () { setBusy(false); });
  }

  document.getElementById("btn-refresh").addEventListener("click", refresh);

  document.getElementById("btn-sync").addEventListener("click", function () {
    setBusy(true);
    callTool("mount_mirror_sync").then(function (res) {
      var done = res.results.filter(function (r) { return r.synced; }).length;
      notify("镜像同步完成：" + done + "/" + res.results.length + " 个项目");
      refresh();
    }).catch(function (e) {
      notify("同步失败：" + e.message, "error");
      setBusy(false);
    });
  });

  document.getElementById("btn-heal").addEventListener("click", function () {
    send("ui/confirm", {
      title: "立即修复",
      message: "将对映射离线且 git 断链的项目，从本地镜像恢复 .git 元数据。映射在线的项目不会被修改。",
      confirmLabel: "修复",
      danger: false
    }).then(function (res) {
      if (res && (res.confirmed === false || res.cancelled === true || res.canceled === true)) return;
      setBusy(true);
      return callTool("mount_heal").then(function (r) {
        var healed = r.results.filter(function (x) { return x.healed; }).length;
        notify("修复完成：" + healed + " 个项目已恢复");
        refresh();
      });
    }).catch(function (e) {
      notify("修复失败：" + e.message, "error");
      setBusy(false);
    });
  });

  send("ui/initialize", { protocolVersion: 1 }).then(function (init) {
    applyTheme(init && init.theme);
    refresh();
  }).catch(function () {
    refresh();
  });

  window.addEventListener("message", function (event) {
    var msg = event.data;
    if (msg && msg.method === "ui/themeChanged" && msg.params) {
      applyTheme(msg.params);
    }
  });

  setInterval(function () {
    if (!document.hidden) refresh();
  }, 60000);
})();
