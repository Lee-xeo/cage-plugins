// Local AI Bridge — Sandboxed Sidebar Dashboard
// Communicates strictly via JSON-RPC 2.0 postMessage with the workbench host.

const waiting = new Map();
let nextRpcId = 1;

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextRpcId++;
    waiting.set(id, { resolve, reject });
    window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  });
}

async function callTool(name, args = {}) {
  const res = await rpc("tools/call", { name, arguments: args });
  const data = res?.structuredContent ?? (() => {
    const txt = res?.content?.[0]?.text;
    if (!txt) return {};
    try { return JSON.parse(txt); } catch { return { text: txt }; }
  })();
  if (res?.isError) {
    throw new Error(data?.error || data?.text || "Tool call failed.");
  }
  return data;
}

const I18N = {
  en: {
    title: "Local AI Bridge",
    refresh: "Refresh",
    settings: "Policy & Paths",
    newTask: "+ New Task",
    readOnly: "Read-Only",
    writeEnabled: "Write Enabled",
    fullAccessEnabled: "Full Access",
    noProject: "No Project",
    tabsTasks: "Tasks",
    tabsRunning: "Running",
    tabsSessions: "Sessions",
    allProviders: "All Providers",
    clearFinished: "Clear Finished",
    emptyDetail: 'Select a task or session on the left, or click "+ New Task" to dispatch a prompt to Codex, Grok, or Antigravity.',
    emptyList: "No matching items yet.",
    available: "Ready",
    unavailable: "Not Found",
    needAuth: "Login Required",
    disabled: "Disabled",
    allowWrite: "Writable",
    enableWriteConfirmTitle: "Enable Workspace Edits?",
    enableWriteConfirmMsg: "This allows the selected local AI CLI to modify files inside the active project directory when requested. Continue?",
    enableWriteBtn: "Enable Write",
    enableFullConfirmTitle: "Enable Full-Access Mode?",
    enableFullConfirmMsg: "Full-access unlocks unrestricted host commands, network, plugins/browser control (e.g. Chrome), and auto-approved execution for the selected AI CLI. Continue?",
    enableFullBtn: "Enable Full Access",
    cancelTask: "Cancel Task",
    copyReply: "Copy Reply",
    deleteSession: "Delete Session",
    copied: "Copied to clipboard.",
    taskDispatched: "Task dispatched.",
    taskCancelled: "Cancellation requested.",
    policySaved: "Policy saved.",
    send: "Send",
    followupPlaceholder: "Send a follow-up message in this session...",
    modeLabel: "Mode",
    modeRo: "Read-Only",
    modeRw: "Workspace Write",
    modeFull: "Full Access",
    writeBlockedHint: "Higher permission tiers are locked. Unlock in provider card or Policy & Paths.",
    liveStream: "Live output",
    noReplyYet: "Waiting for CLI output...",
    proxyOn: "Proxy ON",
    proxyParsed: "Proxy fields parsed. Click Save Policy to apply.",
    proxyParseEmpty: "No proxy variables found in the pasted command.",
    agRiskTitle: "Policy Warning: Use Antigravity?",
    agRiskEnableMsg: "Invoking Antigravity via third-party automation does not comply with Google's policies and may risk account restrictions or suspension. Please consider carefully before enabling it.",
    agRiskRunMsg: "Invoking Antigravity via third-party automation does not comply with Google's policies and carries account risk. Please consider carefully before dispatching this task.",
    agRiskBtn: "I Understand, Continue",
    agOptInHint: "Disabled by default: invoking via third-party bridge does not comply with Google's policies.",
  },
  zh: {
    title: "本地 AI 协作桥",
    refresh: "刷新",
    settings: "策略与路径",
    newTask: "+ 新建任务",
    readOnly: "默认只读",
    writeEnabled: "已允许写入",
    fullAccessEnabled: "已开完全权限",
    noProject: "未打开项目",
    tabsTasks: "任务",
    tabsRunning: "运行中",
    tabsSessions: "会话",
    allProviders: "全部 AI",
    clearFinished: "清理已完成",
    emptyDetail: "在左侧选择一个任务或会话查看实时进度，或点击右上角「+ 新建任务」向 Codex / Grok / Antigravity 派发任务。",
    emptyList: "暂无记录。",
    available: "就绪",
    unavailable: "未检测到",
    needAuth: "需登录",
    disabled: "已停用",
    allowWrite: "可写入",
    enableWriteConfirmTitle: "确认开启项目写入权限？",
    enableWriteConfirmMsg: "开启后，被调度的本机 AI CLI 可在收到 workspace-write 请求时修改当前共享项目目录中的文件。确定继续吗？",
    enableWriteBtn: "允许写入",
    enableFullConfirmTitle: "确认开启完全权限（Full Access）？",
    enableFullConfirmMsg: "开启后，所选本机 AI CLI 可在收到 full-access 请求时启用插件/浏览器控制（如 Chrome）、本机网络与自动批准的命令执行。确定继续吗？",
    enableFullBtn: "开启完全权限",
    cancelTask: "取消任务",
    copyReply: "复制回复",
    deleteSession: "删除会话",
    copied: "已复制到剪贴板。",
    taskDispatched: "任务已派发。",
    taskCancelled: "已发送取消请求。",
    policySaved: "策略已保存。",
    send: "发送",
    followupPlaceholder: "在当前会话继续追问...",
    modeLabel: "权限模式",
    modeRo: "只读模式",
    modeRw: "允许改写",
    modeFull: "完全权限",
    writeBlockedHint: "更高权限档位当前已锁定；可在上方卡片或「策略与路径」中手动解锁。",
    liveStream: "实时输出中",
    noReplyYet: "正在等待本机 CLI 返回...",
    proxyOn: "代理已开启",
    proxyParsed: "已解析代理地址，点击保存即可生效。",
    proxyParseEmpty: "未从粘贴内容中识别到 http_proxy / https_proxy / all_proxy。",
    agRiskTitle: "风险提示：确认使用 Antigravity？",
    agRiskEnableMsg: "通过第三方工具调用 Antigravity 在 Google 侧不符合相关使用规定，可能存在账号受限或封禁风险。请仔细考虑后再决定是否启用。",
    agRiskRunMsg: "通过第三方工具调用 Antigravity 在 Google 侧不符合相关使用规定，存在账号风险。请仔细考虑后再决定是否继续发送本次任务。",
    agRiskBtn: "知晓风险，继续使用",
    agOptInHint: "默认停用：此调用方式在 Google 侧不符合规定，请谨慎考虑后再启用。",
  },
};

const state = {
  lang: "en",
  visible: true,
  activeTab: "tasks", // tasks | running | sessions
  providerFilter: "",
  selectedKind: null, // "task" | "session"
  selectedId: null,
  dashboard: null,
  sessionDetail: null,
  modelsCache: {},
  pollTimer: null,
};

const $ = (id) => document.getElementById(id);
const t = (key) => (I18N[state.lang] || I18N.en)[key] || I18N.en[key] || key;

function applyTheme(theme) {
  if (!theme) return;
  if (theme.scheme) {
    document.documentElement.setAttribute("data-scheme", theme.scheme);
  }
  const tokens = theme.tokens || {};
  for (const [k, v] of Object.entries(tokens)) {
    if (typeof v === "string" && v) {
      document.documentElement.style.setProperty(`--${k}`, v);
    }
  }
}

function applyStaticLabels() {
  $("title-text").textContent = t("title");
  $("btn-refresh").textContent = t("refresh");
  $("btn-settings").textContent = t("settings");
  $("btn-new-task").textContent = t("newTask");
  $("btn-clear-done").textContent = t("clearFinished");
  $("empty-detail-text").textContent = t("emptyDetail");
  $("followup-input").placeholder = t("followupPlaceholder");
  $("btn-send-followup").textContent = t("send");
  $("lbl-followup-mode").textContent = t("modeLabel");
  $("followup-mode").options[0].textContent = t("modeRo");
  $("followup-mode").options[1].textContent = t("modeRw");
  $("followup-mode").options[2].textContent = t("modeFull");
  $("new-mode").options[0].textContent = t("modeRo");
  $("new-mode").options[1].textContent = t("modeRw");
  $("new-mode").options[2].textContent = t("modeFull");
  $("filter-provider").options[0].textContent = t("allProviders");
}

function formatDuration(ms) {
  const sec = Math.max(0, Math.floor((ms || 0) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

function providerLabel(pid) {
  if (pid === "codex") return "Codex";
  if (pid === "grok") return "Grok";
  if (pid === "antigravity") return "Antigravity";
  return pid || "AI";
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderProviders() {
  const wrap = $("providers-strip");
  wrap.textContent = "";
  const providers = state.dashboard?.providers || [];
  for (const p of providers) {
    const card = el("div", `provider-card${p.enabled ? "" : " disabled"}`);
    const head = el("div", "provider-head");
    const nameWrap = el("div", "provider-name");
    nameWrap.appendChild(el("span", `tag ${p.id}`, providerLabel(p.id)));
    if (!p.enabled) {
      nameWrap.appendChild(el("span", "tag ro", t("disabled")));
    } else if (!p.available) {
      nameWrap.appendChild(el("span", "tag failed", t("unavailable")));
    } else if (p.authenticated === false) {
      nameWrap.appendChild(el("span", "tag grok", t("needAuth")));
    } else {
      nameWrap.appendChild(el("span", "tag completed", t("available")));
    }
    head.appendChild(nameWrap);

    const tier = p.allow_full_access ? "full-access" : (p.allow_write ? "workspace-write" : "read-only");
    const tierCls = tier === "full-access" ? "tier-full" : (tier === "workspace-write" ? "tier-rw" : "tier-ro");
    const tierSel = el("select", `tier-select ${tierCls}`);
    tierSel.setAttribute("aria-label", `${p.id} permission tier`);
    for (const [val, label] of [
      ["read-only", t("modeRo")],
      ["workspace-write", t("modeRw")],
      ["full-access", t("modeFull")],
    ]) {
      const opt = el("option", "", label);
      opt.value = val;
      if (val === tier) opt.selected = true;
      tierSel.appendChild(opt);
    }
    tierSel.addEventListener("change", () => setProviderTier(p, tierSel.value, tierSel));
    head.appendChild(tierSel);
    card.appendChild(head);

    const meta = el("div", "provider-meta");
    meta.appendChild(el("span", "", p.version || p.binary_path || "—"));
    card.appendChild(meta);

    if (p.error) {
      const errEl = el("div", "provider-err", p.error);
      errEl.title = p.error;
      card.appendChild(errEl);
    } else if (p.id === "antigravity" && !p.enabled) {
      const warnEl = el("div", "provider-err", t("agOptInHint"));
      warnEl.title = t("agOptInHint");
      card.appendChild(warnEl);
    }

    const foot = el("div", "provider-foot");
    const quickBtn = el("button", "btn sm", t("newTask"));
    quickBtn.type = "button";
    quickBtn.disabled = !p.enabled || !p.available;
    quickBtn.addEventListener("click", () => openNewTaskModal(p.id));
    foot.appendChild(quickBtn);

    const toggleEnableBtn = el("button", "btn sm ghost", p.enabled ? "ON" : "OFF");
    toggleEnableBtn.type = "button";
    toggleEnableBtn.addEventListener("click", () => toggleProviderEnabled(p));
    foot.appendChild(toggleEnableBtn);

    card.appendChild(foot);
    wrap.appendChild(card);
  }
}

function maskUrlCreds(url) {
  return String(url || "").replace(/((?:https?|socks5h?|socks4a?):\/\/)([^/\s@]+)@/gi, "$1***@");
}

function renderTopbar() {
  const dash = state.dashboard;
  if (!dash) return;
  const active = dash.active_count || 0;
  $("live-dot").classList.toggle("active", active > 0);
  $("project-pill").textContent = dash.project_name || t("noProject");
  $("project-pill").title = dash.project_name || "";

  const anyFull = Boolean(dash.policy?.allow_full_access) ||
    (dash.providers || []).some((p) => p.allow_full_access);
  const anyWrite = Boolean(dash.policy?.allow_write) ||
    (dash.providers || []).some((p) => p.allow_write);
  const modePill = $("mode-pill");
  if (anyFull) {
    modePill.textContent = t("fullAccessEnabled");
    modePill.className = "pill mode-full";
  } else if (anyWrite) {
    modePill.textContent = t("writeEnabled");
    modePill.className = "pill mode-rw";
  } else {
    modePill.textContent = t("readOnly");
    modePill.className = "pill mode-ro";
  }

  const proxyOn = Boolean(dash.policy?.proxy?.enabled);
  const proxyPill = $("proxy-pill");
  proxyPill.classList.toggle("hidden", !proxyOn);
  proxyPill.textContent = t("proxyOn");
  if (proxyOn) {
    const px = dash.policy.proxy;
    proxyPill.title = [px.https_proxy, px.http_proxy, px.all_proxy]
      .filter(Boolean)
      .map(maskUrlCreds)
      .join(" | ");
  }

  const readyCount = (dash.providers || []).filter((p) => p.enabled && p.available).length;
  $("summary-text").textContent = state.lang === "zh"
    ? `${readyCount} 个本机 AI 就绪 · ${active} 个运行中 · ${(dash.sessions || []).length} 个会话`
    : `${readyCount} local CLIs ready · ${active} running · ${(dash.sessions || []).length} sessions`;

  $("count-tasks").textContent = String((dash.tasks || []).length);
  $("count-running").textContent = String(active);
  $("count-sessions").textContent = String((dash.sessions || []).length);
}

function renderList() {
  const listEl = $("item-list");
  listEl.textContent = "";
  const dash = state.dashboard;
  if (!dash) return;

  const filterPid = state.providerFilter;
  if (state.activeTab === "sessions") {
    const items = (dash.sessions || []).filter((s) => !filterPid || s.provider === filterPid);
    if (!items.length) {
      listEl.appendChild(el("div", "empty-detail", t("emptyList")));
      return;
    }
    for (const s of items) {
      const btn = el("button", `list-item${state.selectedKind === "session" && state.selectedId === s.id ? " selected" : ""}`);
      btn.type = "button";
      const top = el("div", "item-top");
      top.appendChild(el("span", `tag ${s.provider}`, providerLabel(s.provider)));
      top.appendChild(el("span", "tag ro", `${s.turn_count || 0} turns`));
      btn.appendChild(top);
      btn.appendChild(el("div", "item-title", s.title || s.id));
      const sub = el("div", "item-sub");
      sub.appendChild(el("span", "", s.model || "default"));
      sub.appendChild(el("span", "", (s.updated_at || "").replace("T", " ").replace("Z", "")));
      btn.appendChild(sub);
      btn.addEventListener("click", () => selectSession(s.id));
      listEl.appendChild(btn);
    }
    return;
  }

  let tasks = dash.tasks || [];
  if (state.activeTab === "running") {
    tasks = tasks.filter((x) => x.status === "running" || x.status === "queued" || x.status === "cancelling");
  }
  if (filterPid) {
    tasks = tasks.filter((x) => x.provider === filterPid);
  }
  if (!tasks.length) {
    listEl.appendChild(el("div", "empty-detail", t("emptyList")));
    return;
  }
  for (const task of tasks) {
    const btn = el("button", `list-item${state.selectedKind === "task" && state.selectedId === task.id ? " selected" : ""}`);
    btn.type = "button";
    const top = el("div", "item-top");
    const leftTags = el("span", "");
    leftTags.appendChild(el("span", `tag ${task.provider}`, providerLabel(task.provider)));
    top.appendChild(leftTags);
    top.appendChild(el("span", `tag ${task.status}`, task.status));
    btn.appendChild(top);
    btn.appendChild(el("div", "item-title", task.prompt_preview || task.id));
    const sub = el("div", "item-sub");
    sub.appendChild(el("span", "", `${task.last_activity || task.phase} · ${formatDuration(task.elapsed_ms)}`));
    const modeShort = task.mode === "full-access" ? "FULL" : (task.mode === "workspace-write" ? "RW" : "RO");
    sub.appendChild(el("span", "", modeShort));
    btn.appendChild(sub);
    btn.addEventListener("click", () => selectTask(task.id));
    listEl.appendChild(btn);
  }
}

function renderDetail() {
  const dash = state.dashboard;
  const emptyEl = $("empty-detail");
  const bodyEl = $("detail-body");
  if (!dash || !state.selectedId) {
    emptyEl.classList.remove("hidden");
    bodyEl.classList.add("hidden");
    return;
  }

  if (state.selectedKind === "task") {
    const task = (dash.tasks || []).find((x) => x.id === state.selectedId);
    if (!task) {
      emptyEl.classList.remove("hidden");
      bodyEl.classList.add("hidden");
      return;
    }
    emptyEl.classList.add("hidden");
    bodyEl.classList.remove("hidden");

    const badges = $("detail-badges");
    badges.textContent = "";
    badges.appendChild(el("span", `tag ${task.provider}`, providerLabel(task.provider)));
    badges.appendChild(el("span", `tag ${task.status}`, task.status));
    const modeTagCls = task.mode === "full-access" ? "full" : (task.mode === "workspace-write" ? "rw" : "ro");
    badges.appendChild(el("span", `tag ${modeTagCls}`, task.mode));
    if (task.model) badges.appendChild(el("span", "tag ro", task.model));

    $("detail-title").textContent = task.prompt_preview || task.id;
    $("detail-meta").textContent = `Task ${task.id.slice(0, 8)} · ${formatDuration(task.elapsed_ms)} · ${task.events_count || 0} events`;

    const actions = $("detail-actions");
    actions.textContent = "";
    if (task.status === "running" || task.status === "queued") {
      const cancelBtn = el("button", "btn sm danger", t("cancelTask"));
      cancelBtn.type = "button";
      cancelBtn.addEventListener("click", () => cancelTask(task.id));
      actions.appendChild(cancelBtn);
    }
    if (task.answer) {
      const copyBtn = el("button", "btn sm", t("copyReply"));
      copyBtn.type = "button";
      copyBtn.addEventListener("click", () => copyText(task.answer));
      actions.appendChild(copyBtn);
    }

    const actStrip = $("activity-strip");
    if (task.activities && task.activities.length) {
      actStrip.classList.remove("hidden");
      const last = task.activities[task.activities.length - 1];
      actStrip.textContent = `${last.activity}${last.detail ? ` — ${last.detail}` : ""}`;
    } else {
      actStrip.classList.add("hidden");
    }

    const transcript = $("transcript");
    transcript.textContent = "";
    const userCard = el("div", "turn-card user");
    const uh = el("div", "turn-head");
    uh.appendChild(el("strong", "", "Prompt"));
    uh.appendChild(el("span", "", task.created_at || ""));
    userCard.appendChild(uh);
    userCard.appendChild(el("pre", "turn-content", task.prompt_preview || ""));
    transcript.appendChild(userCard);

    if (task.status === "running" || task.status === "queued" || task.status === "cancelling") {
      const liveCard = el("div", "turn-card assistant");
      const lh = el("div", "turn-head");
      lh.appendChild(el("strong", "", `${providerLabel(task.provider)} · ${t("liveStream")}`));
      lh.appendChild(el("span", "", task.last_activity || ""));
      liveCard.appendChild(lh);
      liveCard.appendChild(el("pre", "turn-content", task.partial_text || t("noReplyYet")));
      transcript.appendChild(liveCard);
    } else if (task.answer) {
      const replyCard = el("div", "turn-card assistant");
      const rh = el("div", "turn-head");
      rh.appendChild(el("strong", "", providerLabel(task.provider)));
      rh.appendChild(el("span", "", task.finished_at || ""));
      replyCard.appendChild(rh);
      replyCard.appendChild(el("pre", "turn-content", task.answer));
      transcript.appendChild(replyCard);
    }
    if (task.error) {
      const errCard = el("div", "turn-card system");
      errCard.appendChild(el("div", "turn-head", task.status.toUpperCase()));
      errCard.appendChild(el("pre", "turn-content", task.error));
      transcript.appendChild(errCard);
    }

    updateFollowupBox(task.provider, task.session_id);
    return;
  }

  // Session detail view
  const detail = state.sessionDetail;
  if (!detail || detail.session?.id !== state.selectedId) {
    emptyEl.classList.add("hidden");
    bodyEl.classList.remove("hidden");
    $("detail-title").textContent = "Loading session...";
    return;
  }
  const sess = detail.session;
  emptyEl.classList.add("hidden");
  bodyEl.classList.remove("hidden");

  const badges = $("detail-badges");
  badges.textContent = "";
  badges.appendChild(el("span", `tag ${sess.provider}`, providerLabel(sess.provider)));
  badges.appendChild(el("span", "tag ro", `${sess.turn_count || 0} turns`));
  if (sess.model) badges.appendChild(el("span", "tag ro", sess.model));

  $("detail-title").textContent = sess.title || sess.id;
  $("detail-meta").textContent = `Session ${sess.id.slice(0, 8)} · ${sess.updated_at || ""}`;
  $("activity-strip").classList.add("hidden");

  const actions = $("detail-actions");
  actions.textContent = "";
  const delBtn = el("button", "btn sm danger", t("deleteSession"));
  delBtn.type = "button";
  delBtn.addEventListener("click", () => deleteSession(sess.id));
  actions.appendChild(delBtn);

  const transcript = $("transcript");
  transcript.textContent = "";
  for (const turn of detail.turns || []) {
    const card = el("div", `turn-card ${turn.role || "system"}`);
    const head = el("div", "turn-head");
    head.appendChild(el("strong", "", turn.role === "assistant" ? providerLabel(sess.provider) : turn.role));
    head.appendChild(el("span", "", turn.at || ""));
    card.appendChild(head);
    card.appendChild(el("pre", "turn-content", turn.content || ""));
    transcript.appendChild(card);
  }
  updateFollowupBox(sess.provider, sess.id);
}

function updateFollowupBox(providerId, sessionId) {
  const form = $("followup-form");
  if (!sessionId) {
    form.classList.add("hidden");
    return;
  }
  form.classList.remove("hidden");
  form.dataset.provider = providerId;
  form.dataset.sessionId = sessionId;
  const prov = (state.dashboard?.providers || []).find((p) => p.id === providerId);
  const canWrite = Boolean(prov?.allow_write);
  const canFull = Boolean(prov?.allow_full_access);
  const modeSel = $("followup-mode");
  modeSel.options[1].disabled = !canWrite;
  modeSel.options[2].disabled = !canFull;
  if (!canFull && modeSel.value === "full-access") {
    modeSel.value = canWrite ? "workspace-write" : "read-only";
  }
  if (!canWrite && modeSel.value === "workspace-write") {
    modeSel.value = "read-only";
  }
  $("followup-hint").textContent = canFull ? "" : t("writeBlockedHint");
}

async function refreshDashboard(forceRefresh = false) {
  try {
    state.dashboard = await callTool("ai_dashboard_state", forceRefresh ? { refresh: true } : {});
    if (!state.selectedId && state.dashboard.tasks?.length) {
      state.selectedKind = "task";
      state.selectedId = state.dashboard.tasks[0].id;
    }
    renderTopbar();
    renderProviders();
    renderList();
    renderDetail();
  } catch (err) {
    $("summary-text").textContent = err.message;
  } finally {
    schedulePoll();
  }
}

function schedulePoll() {
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
  if (!state.visible) return;
  const active = state.dashboard?.active_count || 0;
  const delay = active > 0 ? 1500 : 5000;
  state.pollTimer = setTimeout(refreshDashboard, delay);
}

async function selectTask(taskId) {
  state.selectedKind = "task";
  state.selectedId = taskId;
  renderList();
  renderDetail();
  saveUiState();
}

async function selectSession(sessionId) {
  state.selectedKind = "session";
  state.selectedId = sessionId;
  state.sessionDetail = null;
  renderList();
  renderDetail();
  saveUiState();
  try {
    state.sessionDetail = await callTool("ai_session_history", { session_id: sessionId, limit: 40 });
    renderDetail();
  } catch (err) {
    await notify(err.message, "error");
  }
}

async function cancelTask(taskId) {
  try {
    await callTool("ai_task_cancel", { task_id: taskId });
    await notify(t("taskCancelled"), "info");
    await refreshDashboard();
  } catch (err) {
    await notify(err.message, "error");
  }
}

async function deleteSession(sessionId) {
  const res = await rpc("ui/confirm", {
    title: t("deleteSession"),
    message: `Delete session ${sessionId.slice(0, 8)}?`,
    confirmLabel: t("deleteSession"),
    danger: true,
  });
  if (!res?.confirmed) return;
  try {
    await callTool("ai_manage_policy", { action: "delete_session", payload: { session_id: sessionId } });
    if (state.selectedId === sessionId) {
      state.selectedId = null;
      state.selectedKind = null;
      state.sessionDetail = null;
    }
    await refreshDashboard();
  } catch (err) {
    await notify(err.message, "error");
  }
}

async function setProviderTier(provider, nextTier, selectEl) {
  const prevTier = provider.allow_full_access ? "full-access" : (provider.allow_write ? "workspace-write" : "read-only");
  if (nextTier === prevTier) return;
  if (nextTier === "full-access") {
    const res = await rpc("ui/confirm", {
      title: t("enableFullConfirmTitle"),
      message: t("enableFullConfirmMsg"),
      confirmLabel: t("enableFullBtn"),
      danger: true,
    });
    if (!res?.confirmed) {
      selectEl.value = prevTier;
      return;
    }
  } else if (nextTier === "workspace-write" && prevTier === "read-only") {
    const res = await rpc("ui/confirm", {
      title: t("enableWriteConfirmTitle"),
      message: t("enableWriteConfirmMsg"),
      confirmLabel: t("enableWriteBtn"),
      danger: true,
    });
    if (!res?.confirmed) {
      selectEl.value = prevTier;
      return;
    }
  }
  try {
    const updates = {
      providers: {
        [provider.id]: {
          allow_write: nextTier === "workspace-write" || nextTier === "full-access",
          allow_full_access: nextTier === "full-access",
        },
      },
    };
    if (nextTier !== "full-access" && state.dashboard?.policy?.allow_full_access) {
      updates.allow_full_access = false;
    }
    if (nextTier === "read-only" && state.dashboard?.policy?.allow_write) {
      updates.allow_write = false;
    }
    await callTool("ai_manage_policy", { action: "update_policy", payload: updates });
    await notify(t("policySaved"), "info");
    await refreshDashboard();
  } catch (err) {
    selectEl.value = prevTier;
    await notify(err.message, "error");
  }
}

async function confirmAntigravityRisk(isEnable = false) {
  const res = await rpc("ui/confirm", {
    title: t("agRiskTitle"),
    message: isEnable ? t("agRiskEnableMsg") : t("agRiskRunMsg"),
    confirmLabel: t("agRiskBtn"),
    danger: true,
  });
  return Boolean(res?.confirmed);
}

async function toggleProviderEnabled(provider) {
  const nextEnabled = !provider.enabled;
  const providerUpdate = { enabled: nextEnabled };
  if (provider.id === "antigravity") {
    if (nextEnabled) {
      const confirmed = await confirmAntigravityRisk(true);
      if (!confirmed) return;
      providerUpdate.risk_acknowledged = true;
    } else {
      providerUpdate.risk_acknowledged = false;
    }
  }
  try {
    await callTool("ai_manage_policy", {
      action: "update_policy",
      payload: { providers: { [provider.id]: providerUpdate } },
    });
    await refreshDashboard();
  } catch (err) {
    await notify(err.message, "error");
  }
}

async function copyText(text) {
  try {
    await rpc("ui/copy", { text: String(text || "").slice(0, 60000) });
    await notify(t("copied"), "info");
  } catch (err) {
    await notify(err.message, "error");
  }
}

async function notify(message, tone = "info") {
  try {
    await rpc("ui/notify", { message: String(message || "").slice(0, 480), tone });
  } catch { /* ignore */ }
}

function saveUiState() {
  rpc("ui/setState", {
    state: {
      activeTab: state.activeTab,
      providerFilter: state.providerFilter,
    },
  }).catch(() => {});
}

// ---- Modals ----
function openNewTaskModal(defaultProvider) {
  const modal = $("task-modal");
  if (defaultProvider) $("new-provider").value = defaultProvider;
  syncNewTaskModeOptions();
  populateModelDropdown($("new-provider").value);
  modal.classList.remove("hidden");
  $("new-prompt").focus();
}

function closeNewTaskModal() {
  $("task-modal").classList.add("hidden");
}

function syncNewTaskModeOptions() {
  const pid = $("new-provider").value;
  const prov = (state.dashboard?.providers || []).find((p) => p.id === pid);
  const canWrite = Boolean(prov?.allow_write);
  const canFull = Boolean(prov?.allow_full_access);
  const sel = $("new-mode");
  sel.options[1].disabled = !canWrite;
  sel.options[2].disabled = !canFull;
  if (!canFull && sel.value === "full-access") {
    sel.value = canWrite ? "workspace-write" : "read-only";
  }
  if (!canWrite && sel.value === "workspace-write") {
    sel.value = "read-only";
  }
}

function populateModelDropdown(pid) {
  const sel = $("new-model");
  sel.textContent = "";
  sel.appendChild(el("option", "", "CLI Default"));
  const models = state.modelsCache[pid] || [];
  for (const m of models) {
    const opt = el("option", "", m.is_default ? `${m.display_name} (default)` : m.display_name);
    opt.value = m.id;
    sel.appendChild(opt);
  }
}

async function loadModelsForSelectedProvider() {
  const pid = $("new-provider").value;
  const btn = $("btn-load-models");
  btn.disabled = true;
  try {
    const res = await callTool("ai_list_models", { provider: pid, refresh: true });
    state.modelsCache[pid] = res.models || [];
    populateModelDropdown(pid);
    if (res.error) await notify(res.error, "error");
  } catch (err) {
    await notify(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

function openSettingsModal() {
  const policy = state.dashboard?.policy;
  if (!policy) return;
  $("set-global-write").checked = Boolean(policy.allow_write);
  $("set-global-full").checked = Boolean(policy.allow_full_access);
  $("set-max-concurrent").value = String(policy.max_concurrent || 4);

  const px = policy.proxy || {};
  $("set-proxy-enabled").checked = Boolean(px.enabled);
  $("set-proxy-paste").value = "";
  $("set-http-proxy").value = px.http_proxy || "";
  $("set-https-proxy").value = px.https_proxy || "";
  $("set-all-proxy").value = px.all_proxy || "";
  $("set-no-proxy").value = px.no_proxy || "127.0.0.1,localhost,::1";

  const container = $("provider-settings-rows");
  container.textContent = "";
  for (const pid of ["codex", "grok", "antigravity"]) {
    const pcfg = policy.providers?.[pid] || { enabled: true, allow_write: false, allow_full_access: false, bin_path: "" };
    const card = el("div", "pset-card");
    const head = el("div", "pset-head");
    head.appendChild(el("span", `tag ${pid}`, providerLabel(pid)));
    const checks = el("div", "pset-checks");

    const enLbl = el("label", "");
    const enBox = document.createElement("input");
    enBox.type = "checkbox";
    enBox.id = `pset-en-${pid}`;
    enBox.checked = pid === "antigravity"
      ? Boolean(pcfg.enabled && pcfg.risk_acknowledged)
      : Boolean(pcfg.enabled);
    enLbl.appendChild(enBox);
    enLbl.appendChild(document.createTextNode("Enabled"));

    const wrLbl = el("label", "");
    const wrBox = document.createElement("input");
    wrBox.type = "checkbox";
    wrBox.id = `pset-wr-${pid}`;
    wrBox.checked = Boolean(pcfg.allow_write);
    wrLbl.appendChild(wrBox);
    wrLbl.appendChild(document.createTextNode("Write"));

    const fullLbl = el("label", "");
    const fullBox = document.createElement("input");
    fullBox.type = "checkbox";
    fullBox.id = `pset-full-${pid}`;
    fullBox.checked = Boolean(pcfg.allow_full_access);
    fullLbl.appendChild(fullBox);
    fullLbl.appendChild(document.createTextNode("Full Access"));

    checks.appendChild(enLbl);
    checks.appendChild(wrLbl);
    checks.appendChild(fullLbl);
    head.appendChild(checks);
    card.appendChild(head);

    const pathInput = document.createElement("input");
    pathInput.type = "text";
    pathInput.id = `pset-bin-${pid}`;
    pathInput.value = pcfg.bin_path || "";
    pathInput.placeholder = `Optional custom ${pid} CLI executable path`;
    card.appendChild(pathInput);
    container.appendChild(card);
  }
  $("settings-modal").classList.remove("hidden");
}

function closeSettingsModal() {
  $("settings-modal").classList.add("hidden");
}

// ---- Event Wiring ----
window.addEventListener("message", (event) => {
  const msg = event.data;
  if (event.source !== window.parent || !msg || msg.jsonrpc !== "2.0") return;
  if (msg.id !== undefined && waiting.has(msg.id)) {
    const p = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message || "RPC error"));
    else p.resolve(msg.result);
    return;
  }
  if (msg.method === "ui/themeChanged") {
    applyTheme(msg.params);
  } else if (msg.method === "ui/visibilityChanged") {
    state.visible = Boolean(msg.params?.visible);
    if (state.visible) refreshDashboard();
    else if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; }
  }
});

for (const tabBtn of document.querySelectorAll(".tab")) {
  tabBtn.addEventListener("click", () => {
    state.activeTab = tabBtn.dataset.tab;
    for (const b of document.querySelectorAll(".tab")) b.classList.toggle("active", b === tabBtn);
    renderList();
    saveUiState();
  });
}

$("filter-provider").addEventListener("change", (e) => {
  state.providerFilter = e.target.value;
  renderList();
  saveUiState();
});

$("btn-refresh").addEventListener("click", () => refreshDashboard(true));
$("btn-new-task").addEventListener("click", () => openNewTaskModal());
$("btn-settings").addEventListener("click", () => openSettingsModal());
$("btn-close-task-modal").addEventListener("click", closeNewTaskModal);
$("btn-cancel-task-modal").addEventListener("click", closeNewTaskModal);
$("btn-close-settings-modal").addEventListener("click", closeSettingsModal);
$("btn-cancel-settings").addEventListener("click", closeSettingsModal);
$("new-provider").addEventListener("change", () => {
  syncNewTaskModeOptions();
  populateModelDropdown($("new-provider").value);
});
$("btn-load-models").addEventListener("click", loadModelsForSelectedProvider);

$("btn-clear-done").addEventListener("click", async () => {
  try {
    await callTool("ai_manage_policy", { action: "clear_finished_tasks" });
    await refreshDashboard();
  } catch (err) {
    await notify(err.message, "error");
  }
});

async function handleSubmitNewTask() {
  const prompt = $("new-prompt").value.trim();
  if (!prompt) {
    $("new-prompt").focus();
    return;
  }
  const selectedProvider = $("new-provider").value;
  if (selectedProvider === "antigravity") {
    const confirmed = await confirmAntigravityRisk(false);
    if (!confirmed) return;
  }
  const btn = $("btn-submit-task");
  btn.disabled = true;
  try {
    const args = {
      provider: selectedProvider,
      prompt,
      mode: $("new-mode").value,
    };
    const model = $("new-model").value;
    const effort = $("new-effort").value;
    const title = $("new-title").value.trim();
    if (model) args.model = model;
    if (effort) args.effort = effort;
    if (title) args.title = title;

    const created = await callTool("ai_run_task", args);
    $("new-prompt").value = "";
    $("new-title").value = "";
    closeNewTaskModal();
    state.activeTab = "tasks";
    for (const b of document.querySelectorAll(".tab")) b.classList.toggle("active", b.dataset.tab === "tasks");
    state.selectedKind = "task";
    state.selectedId = created.task_id;
    await notify(t("taskDispatched"), "info");
    await refreshDashboard();
  } catch (err) {
    await notify(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

$("btn-submit-task").addEventListener("click", handleSubmitNewTask);
$("new-prompt").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    handleSubmitNewTask();
  }
});

async function handleSendFollowup() {
  const form = $("followup-form");
  const prompt = $("followup-input").value.trim();
  if (!prompt) return;
  if (form.dataset.provider === "antigravity") {
    const confirmed = await confirmAntigravityRisk(false);
    if (!confirmed) return;
  }
  const btn = $("btn-send-followup");
  btn.disabled = true;
  try {
    const created = await callTool("ai_run_task", {
      provider: form.dataset.provider,
      session_id: form.dataset.sessionId,
      prompt,
      mode: $("followup-mode").value,
    });
    $("followup-input").value = "";
    state.selectedKind = "task";
    state.selectedId = created.task_id;
    await notify(t("taskDispatched"), "info");
    await refreshDashboard();
  } catch (err) {
    await notify(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

$("btn-send-followup").addEventListener("click", handleSendFollowup);
$("followup-input").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    handleSendFollowup();
  }
});

function parseProxyExportLine() {
  const raw = $("set-proxy-paste").value || "";
  const regex = /\b(http_proxy|https_proxy|all_proxy|no_proxy)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;]+))/gi;
  let matched = 0;
  let m;
  while ((m = regex.exec(raw)) !== null) {
    const key = m[1].toLowerCase();
    const val = (m[2] ?? m[3] ?? m[4] ?? "").trim();
    if (!val) continue;
    matched++;
    if (key === "http_proxy") $("set-http-proxy").value = val;
    else if (key === "https_proxy") $("set-https-proxy").value = val;
    else if (key === "all_proxy") $("set-all-proxy").value = val;
    else if (key === "no_proxy") $("set-no-proxy").value = val;
  }
  if (matched > 0) {
    $("set-proxy-enabled").checked = true;
    notify(t("proxyParsed"), "info");
  } else {
    notify(t("proxyParseEmpty"), "error");
  }
}

$("btn-parse-proxy").addEventListener("click", parseProxyExportLine);

async function handleSaveSettings() {
  const btn = $("btn-save-settings");
  const globalWrite = $("set-global-write").checked;
  const globalFull = $("set-global-full").checked;
  const maxConc = Number($("set-max-concurrent").value) || 4;
  const proxy = {
    enabled: $("set-proxy-enabled").checked,
    http_proxy: $("set-http-proxy").value.trim(),
    https_proxy: $("set-https-proxy").value.trim(),
    all_proxy: $("set-all-proxy").value.trim(),
    no_proxy: $("set-no-proxy").value.trim(),
  };
  const providers = {};
  for (const pid of ["codex", "grok", "antigravity"]) {
    providers[pid] = {
      enabled: $(`pset-en-${pid}`).checked,
      allow_write: $(`pset-wr-${pid}`).checked,
      allow_full_access: $(`pset-full-${pid}`).checked,
      bin_path: $(`pset-bin-${pid}`).value.trim(),
    };
  }
  const oldPolicy = state.dashboard?.policy || {};
  const oldProviders = oldPolicy.providers || {};

  const prevAgActive = Boolean(oldProviders.antigravity?.enabled && oldProviders.antigravity?.risk_acknowledged);
  if (providers.antigravity.enabled) {
    if (!prevAgActive) {
      const confirmed = await confirmAntigravityRisk(true);
      if (!confirmed) return;
    }
    providers.antigravity.risk_acknowledged = true;
  } else {
    providers.antigravity.risk_acknowledged = false;
  }

  // Check each scope individually so unlocking one provider never skips confirmation for another.
  const newlyFullTargets = [];
  if (globalFull && !oldPolicy.allow_full_access) {
    newlyFullTargets.push(state.lang === "zh" ? "全局" : "Global");
  }
  const newlyWriteTargets = [];
  if (globalWrite && !oldPolicy.allow_write) {
    newlyWriteTargets.push(state.lang === "zh" ? "全局" : "Global");
  }
  for (const pid of ["codex", "grok", "antigravity"]) {
    const prev = oldProviders[pid] || {};
    if (providers[pid].allow_full_access && !prev.allow_full_access) {
      newlyFullTargets.push(providerLabel(pid));
    }
    if (providers[pid].allow_write && !prev.allow_write) {
      newlyWriteTargets.push(providerLabel(pid));
    }
  }

  if (newlyFullTargets.length > 0) {
    const scopeText = newlyFullTargets.join(", ");
    const res = await rpc("ui/confirm", {
      title: t("enableFullConfirmTitle"),
      message: `${t("enableFullConfirmMsg")} (${scopeText})`,
      confirmLabel: t("enableFullBtn"),
      danger: true,
    });
    if (!res?.confirmed) return;
  } else if (newlyWriteTargets.length > 0) {
    const scopeText = newlyWriteTargets.join(", ");
    const res = await rpc("ui/confirm", {
      title: t("enableWriteConfirmTitle"),
      message: `${t("enableWriteConfirmMsg")} (${scopeText})`,
      confirmLabel: t("enableWriteBtn"),
      danger: true,
    });
    if (!res?.confirmed) return;
  }
  btn.disabled = true;
  try {
    const saved = await callTool("ai_manage_policy", {
      action: "update_policy",
      payload: {
        allow_write: globalWrite,
        allow_full_access: globalFull,
        max_concurrent: maxConc,
        proxy,
        providers,
      },
    });
    if (!saved?.policy || saved.policy.proxy === undefined) {
      await notify(
        state.lang === "zh"
          ? "后台插件进程还是旧版本，请先在插件页点击「重新加载」后再保存。"
          : "Backend server is running an older version. Click Reload in the Plugins page and try again.",
        "error",
      );
      return;
    }
    closeSettingsModal();
    await notify(t("policySaved"), "info");
    await refreshDashboard();
  } catch (err) {
    await notify(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

$("btn-save-settings").addEventListener("click", handleSaveSettings);

// ---- Bootstrap ----
const init = await rpc("ui/initialize", { protocolVersion: 1 });
applyTheme(init?.theme);
const locale = String(init?.locale || "en").toLowerCase();
state.lang = locale.startsWith("zh") ? "zh" : "en";
if (init?.state?.activeTab) {
  state.activeTab = init.state.activeTab;
  for (const b of document.querySelectorAll(".tab")) b.classList.toggle("active", b.dataset.tab === state.activeTab);
}
if (typeof init?.state?.providerFilter === "string") {
  state.providerFilter = init.state.providerFilter;
  $("filter-provider").value = state.providerFilter;
}
applyStaticLabels();
await refreshDashboard();
