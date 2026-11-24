(() => {
  "use strict";

  const waiting = new Map();
  let nextId = 1;

  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
    });
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== window.parent || !message || message.jsonrpc !== "2.0") return;
    if (message.method === "ui/themeChanged") {
      applyTheme(message.params);
      return;
    }
    if (message.method === "ui/visibilityChanged") {
      return;
    }
    const pending = waiting.get(message.id);
    if (!pending) return;
    waiting.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || "Request failed"));
    } else {
      pending.resolve(message.result);
    }
  });

  const COPY = {
    zh: {
      title: "隐私边界体检",
      scopePill: "离线 · 只读脱敏",
      subtitle: "核查宿主机路由、防火墙、DNS、本地客户端痕迹与 MCP 桥接边界",
      btnFull: "运行完整体检",
      btnQuick: "快速边界检查",
      btnCopy: "复制脱敏摘要",
      runningFull: "正在运行本机只读体检（路由 / 防火墙 / DNS / 客户端边界）…",
      runningQuick: "正在运行快速边界检查…",
      kpiPass: "已通过 (pass)",
      kpiPassSub: "本机观测或配置满足预期",
      kpiGap: "存在缺口 (gap)",
      kpiGapSub: "建议优先核对或补齐",
      kpiUnknown: "未知盲区 (unknown)",
      kpiUnknownSub: "离线工具无法证实，不等于通过",
      kpiHost: "宿主机语境",
      kpiHostPending: "待体检",
      kpiHostSub: "点击上方按钮运行只读检查",
      calloutTitle: "证据边界提醒：",
      calloutBody: "本面板完全离线且只读，不会修改系统配置或发送任何网络请求。外部出口 IP 信誉、运行态图形/TPM 健康度及平台地区政策固定标为 unknown，切勿将其视为已通过。",
      tabChecks: "十项三态体检",
      tabBoundary: "客户端与 MCP 边界",
      tabTriage: "网页登录分步排查",
      tabJson: "脱敏 JSON",
      filterAll: "全部",
      filterGap: "存在缺口",
      filterUnknown: "未知盲区",
      filterPass: "已通过",
      filterObserved: "本机观测",
      filterStatic: "静态配置",
      filterExternal: "外部盲区",
      emptyTitle: "尚未运行本机只读体检",
      emptyDesc: "点击“运行完整体检”一次采集宿主机路由、防火墙、DNS 与本地客户端边界；或点击“快速边界检查”在 1 秒内仅核查本机时区、客户端痕迹与 MCP 数量。",
      boundaryEmptyTitle: "暂无客户端边界数据",
      boundaryEmptyDesc: "运行“完整体检”或“快速边界检查”后，这里将展示宿主机时区/语言、本地客户端痕迹、5 项 CLI 防后台外联开关与本地 MCP 桥接统计。",
      secHostEnv: "宿主机环境与客户端痕迹",
      secCliSwitches: "CLI 5 项防后台外联开关",
      secMcpBridges: "本地 MCP 桥接与环境变量标记",
      secBoundaryNotes: "脱敏边界提醒",
      triageTitle: "网页登录卡在哪一步？",
      triageLead: "先记录首次出现提示的时间（含时区）、使用的客户端和提示原文；时间不详时明确记为“未知”。",
      btnCopyTriage: "复制排查模板",
      jsonTitle: "脱敏原始观测数据",
      jsonLead: "已省略路径、用户名、密钥、节点凭据与具体 MCP 命令，仅保留布尔值、计数与状态摘要。",
      btnCopyJson: "复制 JSON",
      copiedSummary: "已复制脱敏体检摘要",
      copiedJson: "已复制脱敏 JSON",
      copiedTriage: "已复制网页登录分步记录模板",
      notCollected: "尚未采集",
      lastCollected: (ts) => `最近采集：${ts}`,
      noMatches: "当前筛选条件下没有匹配项。",
      quickOnlyNotice: "当前展示为“快速边界检查”结果；如需十项网络/防火墙/DNS 三态摘要，请点击“运行完整体检”。",
      statusLabels: { pass: "已通过", gap: "存在缺口", unknown: "未知盲区" },
      tierLabels: {
        observed_local: "本机观测",
        static_config: "静态配置",
        external_blind_spot: "外部盲区",
      },
      checkLabels: {
        network_collector: "本机网络与系统观测采集",
        routing_and_ipv6_surface: "默认路由与 IPv6 暴露面",
        system_dns_observations: "系统 DNS 与加密传输观测",
        firewall_and_fail_closed: "防火墙默认出站与断线兜底",
        host_client_boundary: "宿主机原生客户端边界",
        cli_anti_telemetry_switches: "CLI 5 项防后台外联开关",
        local_mcp_host_bridges: "本地 MCP 与宿主机桥接工具",
        claude_local_data_audit: "本地 Claude 数据脱敏盘点",
        exit_ip_reputation: "出口 IP 历史信誉与代理库标记",
        runtime_environment_and_policy_boundaries: "运行态图形 / TPM 健康度与平台合规边界",
      },
      yes: "已检测到 / 已启用",
      no: "未检测到 / 未启用",
      enabled: "已开启",
      disabled: "未开启",
      publicSafeTitle: "公开反馈可保留",
      keepPrivateTitle: "切勿公开（仅留本地或官方支持）",
      kv: {
        platform: "操作系统",
        timezone: "宿主机时区",
        locale: "宿主机语言",
        cliDir: "CLI 配置目录",
        cliState: "CLI 状态文件",
        desktopData: "桌面端数据目录",
        desktopMsix: "Windows MSIX 包",
        desktopMcp: "桌面端 MCP 数量",
        cliMcp: "CLI MCP 数量",
        baseUrl: "ANTHROPIC_BASE_URL",
        configDir: "CLAUDE_CONFIG_DIR",
        proxyEnv: "HTTP(S)/ALL_PROXY",
      },
    },
    en: {
      title: "Privacy Boundary Audit",
      scopePill: "Offline · Read-Only Redacted",
      subtitle: "Audit host routes, firewall defaults, DNS, local client footprints, and local MCP bridge counts",
      btnFull: "Run Full Audit",
      btnQuick: "Quick Boundary Check",
      btnCopy: "Copy Summary",
      runningFull: "Running offline read-only host audit (routes / firewall / DNS / client boundary)…",
      runningQuick: "Running fast host boundary check…",
      kpiPass: "Passed (pass)",
      kpiPassSub: "Observed local checks met expectations",
      kpiGap: "Gaps (gap)",
      kpiGapSub: "Review or tighten recommended",
      kpiUnknown: "Unknown (unknown)",
      kpiUnknownSub: "Unverifiable offline — not a pass",
      kpiHost: "Host Context",
      kpiHostPending: "Not scanned",
      kpiHostSub: "Run an offline read-only audit above",
      calloutTitle: "Evidence Boundary Notice: ",
      calloutBody: "This panel runs 100% offline and read-only. External exit IP reputation, runtime graphics/TPM health, and provider regional policies are always marked unknown and must never be read as pass.",
      tabChecks: "10 Tri-State Checks",
      tabBoundary: "Client & MCP Boundary",
      tabTriage: "Web Login Triage",
      tabJson: "Redacted JSON",
      filterAll: "All",
      filterGap: "Gaps",
      filterUnknown: "Unknown",
      filterPass: "Passed",
      filterObserved: "Observed Local",
      filterStatic: "Static Config",
      filterExternal: "External Blind Spot",
      emptyTitle: "No local audit run yet",
      emptyDesc: "Click 'Run Full Audit' to inspect host routes, firewall, DNS, and client boundaries, or 'Quick Boundary Check' for a sub-second check of timezone, footprints, CLI flags, and MCP counts.",
      boundaryEmptyTitle: "No client boundary data yet",
      boundaryEmptyDesc: "Run either audit action above to inspect host timezone/locale, native client footprints, the 5 CLI anti-telemetry switches, and local MCP bridge counts.",
      secHostEnv: "Host Context & Client Footprints",
      secCliSwitches: "5 CLI Anti-Telemetry Switches",
      secMcpBridges: "Local MCP Bridges & Env Flags",
      secBoundaryNotes: "Redacted Boundary Notes",
      triageTitle: "Where did web login stall?",
      triageLead: "Record first-seen timestamp (with timezone), client used, and exact message text first. Write 'unknown' if timing is uncertain.",
      btnCopyTriage: "Copy Triage Template",
      jsonTitle: "Redacted Raw Observation JSON",
      jsonLead: "Paths, usernames, secrets, node credentials, and MCP commands are omitted; only booleans, counts, and status labels are shown.",
      btnCopyJson: "Copy JSON",
      copiedSummary: "Redacted audit summary copied",
      copiedJson: "Redacted JSON copied",
      copiedTriage: "Web login triage template copied",
      notCollected: "Not collected yet",
      lastCollected: (ts) => `Last collected: ${ts}`,
      noMatches: "No checks match the current filter.",
      quickOnlyNotice: "Showing fast boundary audit only. Click 'Run Full Audit' to evaluate all 10 network, firewall, DNS, and boundary checks.",
      statusLabels: { pass: "Pass", gap: "Gap", unknown: "Unknown" },
      tierLabels: {
        observed_local: "Observed Local",
        static_config: "Static Config",
        external_blind_spot: "External Blind Spot",
      },
      checkLabels: {},
      yes: "Present / Set",
      no: "Absent / Unset",
      enabled: "Enabled",
      disabled: "Not set",
      publicSafeTitle: "Safe for public reports",
      keepPrivateTitle: "Keep private (device or official support only)",
      kv: {
        platform: "Host OS",
        timezone: "Host Timezone",
        locale: "Host Locale",
        cliDir: "CLI Config Dir",
        cliState: "CLI State File",
        desktopData: "Desktop Data Dir",
        desktopMsix: "Windows MSIX Package",
        desktopMcp: "Desktop MCP Servers",
        cliMcp: "CLI MCP Servers",
        baseUrl: "ANTHROPIC_BASE_URL",
        configDir: "CLAUDE_CONFIG_DIR",
        proxyEnv: "HTTP(S)/ALL_PROXY",
      },
    },
  };

  const DEFAULT_TRIAGE = {
    stages: [
      {
        id: "widget_load",
        titleZh: "验证框空白或加载失败",
        titleEn: "Challenge widget blank or failed to load",
        observeZh: [
          "记录浏览器版本、首次出现时间（含时区）以及页面实际显示的错误码。",
          "对照示例：Turnstile 错误码 200500 表示验证框未能加载，可排查该页对 challenges.cloudflare.com 的组件请求是否被拦截或超时。",
        ],
        observe: [
          "Record browser version, first-seen timestamp with timezone, and exact page error code.",
          "Reference example: Turnstile 200500 indicates widget iframe load failure; inspect whether requests to challenges.cloudflare.com were blocked.",
        ],
      },
      {
        id: "challenge_loop",
        titleZh: "手动完成后反复回到验证框",
        titleEn: "Returns to challenge repeatedly after manual completion",
        observeZh: [
          "保持同一网络出口与同一页面，分别在普通浏览器和隔离浏览器中各手动测试一次，分别记录时间、结果、错误码与 Ray ID。",
          "若现象仅在单一配置中复现，优先排查扩展、脚本加载、缓存和连接稳定性；无痕窗口可用于排查扩展或缓存干扰。",
        ],
        observe: [
          "Test once manually in a standard browser and once in the isolated browser over the same egress; record timestamps, outcomes, error codes, and Ray IDs.",
          "If it reproduces only in one profile, check extensions, script blockers, cache, and connection stability.",
        ],
      },
      {
        id: "post_challenge",
        titleZh: "验证通过后返回站点才出现限制提示",
        titleEn: "Site notice appears only after challenge succeeds",
        observeZh: [
          "单独记录站点提示或邮件原文以及首次可见时间（含时区），与人机验证日志分开归档。",
          "明确区分“要求补充验证”“提示地区不可用”与“收到停用邮件”；同时留存最近一次已知正常使用时间。",
        ],
        observe: [
          "Record exact site notice or email text and first-seen timestamp separately from challenge logs.",
          "Distinguish extra verification prompts, unsupported-region notices, and suspension emails.",
        ],
      },
    ],
    redaction: {
      publicSafeZh: ["客户端版本号与操作系统平台", "脱敏后的提示原文与相对时间差", "不关联账号标识的页面错误码"],
      publicSafe: ["Client versions and OS platform", "Redacted notices and relative timestamps", "Error codes without account identifiers"],
      keepPrivateZh: ["完整 Ray ID（仅提供给对应站点官方支持）", "登录链接、验证码、会话 Cookie 与账号邮箱", "代理订阅链接、节点凭据及本机用户名/路径"],
      keepPrivate: ["Full Ray IDs (site support only)", "Sign-in links, verification codes, cookies, and account emails", "Proxy subscriptions, node credentials, and local paths"],
    },
  };

  let lang = "zh";
  let copy = COPY.zh;
  let activeTab = "checks";
  let activeFilter = "all";
  let fullReport = null;
  let boundaryData = null;
  let triageData = DEFAULT_TRIAGE;
  let lastTimestamp = "";
  let busy = false;

  const byId = (id) => document.getElementById(id);

  function applyTheme(theme) {
    const scheme = theme && theme.scheme === "dark" ? "dark" : "light";
    document.documentElement.dataset.scheme = scheme;
    const tokens = theme && theme.tokens && typeof theme.tokens === "object" ? theme.tokens : null;
    if (!tokens) return;
    const rootStyle = document.documentElement.style;
    for (const [key, value] of Object.entries(tokens)) {
      if (typeof value === "string" && value.trim()) {
        rootStyle.setProperty(`--${key}`, value.trim());
      }
    }
  }

  function applyLocale(locale) {
    const raw = String(locale || "zh-CN").toLowerCase();
    lang = raw.startsWith("zh") ? "zh" : "en";
    copy = COPY[lang];
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    byId("ui-title").textContent = copy.title;
    byId("ui-scope-pill").textContent = copy.scopePill;
    byId("ui-subtitle").textContent = copy.subtitle;
    byId("btn-full-audit").textContent = copy.btnFull;
    byId("btn-quick-audit").textContent = copy.btnQuick;
    byId("btn-copy-summary").textContent = copy.btnCopy;
    byId("kpi-pass-label").textContent = copy.kpiPass;
    byId("kpi-pass-sub").textContent = copy.kpiPassSub;
    byId("kpi-gap-label").textContent = copy.kpiGap;
    byId("kpi-gap-sub").textContent = copy.kpiGapSub;
    byId("kpi-unknown-label").textContent = copy.kpiUnknown;
    byId("kpi-unknown-sub").textContent = copy.kpiUnknownSub;
    byId("kpi-host-label").textContent = copy.kpiHost;
    byId("callout-title").textContent = copy.calloutTitle;
    byId("callout-body").textContent = copy.calloutBody;
    byId("tab-checks").textContent = copy.tabChecks;
    byId("tab-boundary").textContent = copy.tabBoundary;
    byId("tab-triage").textContent = copy.tabTriage;
    byId("tab-json").textContent = copy.tabJson;
    byId("filter-all").textContent = copy.filterAll;
    byId("filter-gap").textContent = copy.filterGap;
    byId("filter-unknown").textContent = copy.filterUnknown;
    byId("filter-pass").textContent = copy.filterPass;
    byId("filter-observed").textContent = copy.filterObserved;
    byId("filter-static").textContent = copy.filterStatic;
    byId("filter-external").textContent = copy.filterExternal;
    byId("empty-title").textContent = copy.emptyTitle;
    byId("empty-desc").textContent = copy.emptyDesc;
    byId("boundary-empty-title").textContent = copy.boundaryEmptyTitle;
    byId("boundary-empty-desc").textContent = copy.boundaryEmptyDesc;
    byId("sec-host-env").textContent = copy.secHostEnv;
    byId("sec-cli-switches").textContent = copy.secCliSwitches;
    byId("sec-mcp-bridges").textContent = copy.secMcpBridges;
    byId("sec-boundary-notes").textContent = copy.secBoundaryNotes;
    byId("triage-title").textContent = copy.triageTitle;
    byId("triage-lead").textContent = copy.triageLead;
    byId("btn-copy-triage").textContent = copy.btnCopyTriage;
    byId("json-title").textContent = copy.jsonTitle;
    byId("json-lead").textContent = copy.jsonLead;
    byId("btn-copy-json").textContent = copy.btnCopyJson;
  }

  function showBanner(text, kind = "info") {
    const banner = byId("status-banner");
    if (!text) {
      banner.hidden = true;
      banner.textContent = "";
      return;
    }
    banner.hidden = false;
    banner.className = `banner banner-${kind}`;
    banner.textContent = text;
  }

  function setBusy(state, message) {
    busy = state;
    byId("btn-full-audit").disabled = state;
    byId("btn-quick-audit").disabled = state;
    if (state) {
      showBanner(message, "info");
    }
  }

  function parseToolPayload(result) {
    if (!result || typeof result !== "object") {
      throw new Error("Empty tool response");
    }
    if (result.isError) {
      const msg = (result.content && result.content[0] && result.content[0].text) || "Tool call failed";
      throw new Error(msg);
    }
    if (result.structuredContent && typeof result.structuredContent === "object") {
      return result.structuredContent;
    }
    const text = result.content && result.content[0] && result.content[0].text;
    if (typeof text === "string" && text.trim()) {
      return JSON.parse(text);
    }
    throw new Error("Missing JSON content in tool response");
  }

  function persistState() {
    const compact = {
      activeTab,
      activeFilter,
      lastTimestamp,
      boundaryData,
      fullReport: fullReport
        ? {
            schemaVersion: fullReport.schemaVersion,
            kitVersion: fullReport.kitVersion,
            generatedAtUtc: fullReport.generatedAtUtc,
            platform: fullReport.platform,
            scope: fullReport.scope,
            summary: fullReport.summary,
            clientBoundary: fullReport.clientBoundary,
          }
        : null,
    };
    const serialized = JSON.stringify(compact);
    if (serialized.length < 56000) {
      rpc("ui/setState", { state: compact }).catch(() => {});
    }
  }

  function renderKpis() {
    const summary = fullReport && fullReport.summary;
    const counts = summary && summary.counts;
    byId("kpi-pass").textContent = counts ? String(counts.pass ?? 0) : "—";
    byId("kpi-gap").textContent = counts ? String(counts.gap ?? 0) : "—";
    byId("kpi-unknown").textContent = counts ? String(counts.unknown ?? 0) : "—";

    const host = boundaryData && boundaryData.hostEnvironment;
    if (host) {
      const offset = typeof host.utcOffsetHours === "number"
        ? `UTC${host.utcOffsetHours >= 0 ? "+" : ""}${host.utcOffsetHours}`
        : "";
      byId("kpi-host").textContent = `${boundaryData.platform || ""} · ${host.timezoneName || "unknown"}`;
      byId("kpi-host-sub").textContent = `${offset} · ${host.detectedLocale || "unknown"}`;
    } else {
      byId("kpi-host").textContent = copy.kpiHostPending;
      byId("kpi-host-sub").textContent = copy.kpiHostSub;
    }

    byId("btn-copy-summary").disabled = !(fullReport || boundaryData);
    byId("btn-copy-json").disabled = !(fullReport || boundaryData);
    byId("foot-timestamp").textContent = lastTimestamp ? copy.lastCollected(lastTimestamp) : copy.notCollected;
  }

  function renderChecks() {
    const checks = fullReport && fullReport.summary && Array.isArray(fullReport.summary.checks)
      ? fullReport.summary.checks
      : [];
    const listEl = byId("checks-list");
    const emptyEl = byId("checks-empty");

    if (!checks.length) {
      listEl.hidden = true;
      emptyEl.hidden = false;
      byId("empty-desc").textContent = boundaryData ? copy.quickOnlyNotice : copy.emptyDesc;
      return;
    }

    emptyEl.hidden = true;
    listEl.hidden = false;
    listEl.textContent = "";

    const filtered = checks.filter((item) => {
      if (activeFilter === "all") return true;
      if (activeFilter === "pass" || activeFilter === "gap" || activeFilter === "unknown") {
        return item.status === activeFilter;
      }
      return item.evidenceTier === activeFilter;
    });

    if (!filtered.length) {
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = copy.noMatches;
      listEl.appendChild(note);
      return;
    }

    for (const item of filtered) {
      const row = document.createElement("article");
      row.className = `check-row status-${item.status || "unknown"}`;

      const head = document.createElement("div");
      head.className = "check-head";

      const title = document.createElement("span");
      title.className = "check-title";
      title.textContent = (lang === "zh" && copy.checkLabels[item.id]) || item.title || item.id;

      const badges = document.createElement("div");
      badges.className = "check-badges";

      const statusBadge = document.createElement("span");
      statusBadge.className = `badge badge-${item.status || "unknown"}`;
      statusBadge.textContent = copy.statusLabels[item.status] || item.status || "unknown";

      const tierBadge = document.createElement("span");
      tierBadge.className = "badge badge-neutral";
      tierBadge.textContent = copy.tierLabels[item.evidenceTier] || item.evidenceTier || "";

      badges.appendChild(statusBadge);
      if (tierBadge.textContent) badges.appendChild(tierBadge);
      head.appendChild(title);
      head.appendChild(badges);

      const detail = document.createElement("p");
      detail.className = "check-detail";
      detail.textContent = item.detail || "";

      row.appendChild(head);
      row.appendChild(detail);
      listEl.appendChild(row);
    }
  }

  function addKv(dl, key, value) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  function renderBoundary() {
    const emptyEl = byId("boundary-empty");
    const contentEl = byId("boundary-content");
    if (!boundaryData) {
      emptyEl.hidden = false;
      contentEl.hidden = true;
      return;
    }
    emptyEl.hidden = true;
    contentEl.hidden = false;

    const host = boundaryData.hostEnvironment || {};
    const footprints = boundaryData.localClientFootprints || {};
    const flags = boundaryData.cliAntiTelemetryFlags || {};
    const mcp = boundaryData.localMcpBridges || {};
    const envFlags = boundaryData.environmentVariableFlags || {};

    const kvHost = byId("kv-host-env");
    kvHost.textContent = "";
    const offset = typeof host.utcOffsetHours === "number"
      ? ` (UTC${host.utcOffsetHours >= 0 ? "+" : ""}${host.utcOffsetHours})`
      : "";
    addKv(kvHost, copy.kv.platform, boundaryData.platform || "unknown");
    addKv(kvHost, copy.kv.timezone, `${host.timezoneName || "unknown"}${offset}`);
    addKv(kvHost, copy.kv.locale, host.detectedLocale || "unknown");
    addKv(kvHost, copy.kv.cliDir, footprints.claudeCliConfigDirPresent ? copy.yes : copy.no);
    addKv(kvHost, copy.kv.cliState, footprints.claudeCliStateFilePresent ? copy.yes : copy.no);
    addKv(kvHost, copy.kv.desktopData, footprints.claudeDesktopDataPresent ? copy.yes : copy.no);
    addKv(kvHost, copy.kv.desktopMsix, footprints.claudeDesktopMsixPresent ? copy.yes : copy.no);

    const swList = byId("cli-switch-list");
    swList.textContent = "";
    const switchKeys = [
      "DISABLE_TELEMETRY",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "DISABLE_ERROR_REPORTING",
      "DISABLE_AUTOUPDATER",
      "DISABLE_GROWTHBOOK",
    ];
    for (const key of switchKeys) {
      const enabled = Boolean(flags[`${key}_enabled`]);
      const row = document.createElement("div");
      row.className = "switch-row";
      const keyEl = document.createElement("span");
      keyEl.className = "switch-key";
      keyEl.textContent = key;
      const badge = document.createElement("span");
      badge.className = `badge ${enabled ? "badge-pass" : "badge-unknown"}`;
      badge.textContent = enabled ? copy.enabled : copy.disabled;
      row.appendChild(keyEl);
      row.appendChild(badge);
      swList.appendChild(row);
    }

    const kvMcp = byId("kv-mcp-env");
    kvMcp.textContent = "";
    addKv(kvMcp, copy.kv.desktopMcp, String(mcp.claudeDesktopMcpServerCount ?? 0));
    addKv(kvMcp, copy.kv.cliMcp, String(mcp.claudeCliMcpServerCount ?? 0));
    addKv(kvMcp, copy.kv.baseUrl, envFlags.ANTHROPIC_BASE_URL_set ? copy.yes : copy.no);
    addKv(kvMcp, copy.kv.configDir, envFlags.CLAUDE_CONFIG_DIR_set ? copy.yes : copy.no);
    const anyProxy = Boolean(envFlags.HTTP_PROXY_set || envFlags.HTTPS_PROXY_set || envFlags.ALL_PROXY_set);
    addKv(kvMcp, copy.kv.proxyEnv, anyProxy ? copy.yes : copy.no);

    const notesEl = byId("boundary-notes");
    notesEl.textContent = "";
    const notes = Array.isArray(boundaryData.boundaryNotes) ? boundaryData.boundaryNotes : [];
    for (const note of notes) {
      const item = document.createElement("li");
      item.textContent = note;
      notesEl.appendChild(item);
    }
  }

  function renderTriage() {
    const stagesEl = byId("triage-stages");
    stagesEl.textContent = "";
    const stages = (triageData && triageData.stages) || DEFAULT_TRIAGE.stages;
    for (const stage of stages) {
      const details = document.createElement("details");
      details.className = "triage-step";
      details.open = true;
      const summary = document.createElement("summary");
      summary.textContent = lang === "zh" ? (stage.titleZh || stage.titleEn) : (stage.titleEn || stage.titleZh);
      const list = document.createElement("ul");
      const items = lang === "zh" ? (stage.observeZh || stage.observe || []) : (stage.observe || stage.observeZh || []);
      for (const line of items) {
        const li = document.createElement("li");
        li.textContent = line;
        list.appendChild(li);
      }
      details.appendChild(summary);
      details.appendChild(list);
      stagesEl.appendChild(details);
    }

    const redEl = byId("triage-redaction");
    redEl.textContent = "";
    const red = (triageData && triageData.redaction) || DEFAULT_TRIAGE.redaction;
    const boxes = [
      {
        title: copy.publicSafeTitle,
        items: lang === "zh" ? (red.publicSafeZh || red.publicSafe || []) : (red.publicSafe || red.publicSafeZh || []),
      },
      {
        title: copy.keepPrivateTitle,
        items: lang === "zh" ? (red.keepPrivateZh || red.keepPrivate || []) : (red.keepPrivate || red.keepPrivateZh || []),
      },
    ];
    for (const box of boxes) {
      const div = document.createElement("div");
      div.className = "redaction-box";
      const heading = document.createElement("h4");
      heading.textContent = box.title;
      const list = document.createElement("ul");
      for (const item of box.items) {
        const li = document.createElement("li");
        li.textContent = item;
        list.appendChild(li);
      }
      div.appendChild(heading);
      div.appendChild(list);
      redEl.appendChild(div);
    }
  }

  function renderJson() {
    const payload = fullReport || boundaryData || {};
    byId("json-output").textContent = JSON.stringify(payload, null, 2);
  }

  function renderAll() {
    renderKpis();
    renderChecks();
    renderBoundary();
    renderTriage();
    renderJson();
  }

  function switchTab(tabName) {
    activeTab = tabName;
    for (const btn of document.querySelectorAll(".tab")) {
      const active = btn.dataset.tab === tabName;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    }
    for (const panel of document.querySelectorAll(".panel")) {
      panel.hidden = panel.id !== `panel-${tabName}`;
    }
    persistState();
  }

  function setFilter(filterName) {
    activeFilter = filterName;
    for (const chip of document.querySelectorAll(".chip")) {
      chip.classList.toggle("is-active", chip.dataset.filter === filterName);
    }
    renderChecks();
    persistState();
  }

  function buildMarkdownSummary() {
    const lines = [];
    lines.push(`# ${copy.title} (${lastTimestamp || "local"})`);
    if (fullReport && fullReport.summary) {
      const counts = fullReport.summary.counts || {};
      lines.push(`- Summary: pass=${counts.pass ?? 0}, gap=${counts.gap ?? 0}, unknown=${counts.unknown ?? 0}`);
      lines.push("");
      for (const item of fullReport.summary.checks || []) {
        const label = (lang === "zh" && copy.checkLabels[item.id]) || item.title || item.id;
        lines.push(`- [${String(item.status || "unknown").toUpperCase()} | ${item.evidenceTier}] ${label}: ${item.detail}`);
      }
    } else if (boundaryData) {
      const host = boundaryData.hostEnvironment || {};
      lines.push(`- Host: ${boundaryData.platform} | ${host.timezoneName} (UTC${host.utcOffsetHours}) | ${host.detectedLocale}`);
      for (const note of boundaryData.boundaryNotes || []) {
        lines.push(`- ${note}`);
      }
    }
    lines.push("");
    lines.push("> Note: `unknown` items are offline blind spots and must not be treated as `pass`.");
    return lines.join("\n");
  }

  function buildTriageTemplate() {
    return [
      "# Web Login Failure Triage Record (Redacted)",
      "- First-seen time (with timezone, or 'unknown'): ",
      "- Client & version: ",
      "- Last-known normal usage time: ",
      "- Stage (widget_load / challenge_loop / post_challenge): ",
      "- Exact error code / redacted notice text: ",
      "- Same-egress comparison in another supported browser: ",
      "- Notes (keep full Ray ID, sign-in links, cookies, and emails private): ",
    ].join("\n");
  }

  async function runFullAudit() {
    if (busy) return;
    setBusy(true, copy.runningFull);
    try {
      const res = await rpc("tools/call", { name: "privacy_boundary_report", arguments: {} });
      const data = parseToolPayload(res);
      fullReport = data;
      if (data.clientBoundary && data.clientBoundary.status === "collected" && data.clientBoundary.data) {
        boundaryData = data.clientBoundary.data;
      }
      lastTimestamp = data.generatedAtUtc || new Date().toISOString();
      showBanner("");
      renderAll();
      persistState();
    } catch (err) {
      showBanner(String(err.message || err), "error");
    } finally {
      setBusy(false, "");
    }
  }

  async function runQuickAudit() {
    if (busy) return;
    setBusy(true, copy.runningQuick);
    try {
      const res = await rpc("tools/call", { name: "privacy_client_boundary", arguments: {} });
      const data = parseToolPayload(res);
      boundaryData = data;
      lastTimestamp = new Date().toISOString();
      showBanner("");
      renderAll();
      if (!fullReport) switchTab("boundary");
      persistState();
    } catch (err) {
      showBanner(String(err.message || err), "error");
    } finally {
      setBusy(false, "");
    }
  }

  async function copyText(text, successMsg) {
    try {
      await rpc("ui/copy", { text });
      await rpc("ui/notify", { message: successMsg, tone: "info" });
    } catch (err) {
      showBanner(String(err.message || err), "error");
    }
  }

  byId("btn-full-audit").addEventListener("click", runFullAudit);
  byId("btn-quick-audit").addEventListener("click", runQuickAudit);
  byId("btn-copy-summary").addEventListener("click", () => copyText(buildMarkdownSummary(), copy.copiedSummary));
  byId("btn-copy-json").addEventListener("click", () => {
    const raw = JSON.stringify(fullReport || boundaryData || {}, null, 2);
    copyText(raw.slice(0, 60000), copy.copiedJson);
  });
  byId("btn-copy-triage").addEventListener("click", () => copyText(buildTriageTemplate(), copy.copiedTriage));

  for (const btn of document.querySelectorAll(".tab")) {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  }
  for (const chip of document.querySelectorAll(".chip")) {
    chip.addEventListener("click", () => setFilter(chip.dataset.filter));
  }

  async function bootstrap() {
    try {
      const init = await rpc("ui/initialize", { protocolVersion: 1 });
      if (init && init.theme) applyTheme(init.theme);
      if (init && init.locale) applyLocale(init.locale);
      const saved = init && init.state && typeof init.state === "object" ? init.state : null;
      if (saved) {
        if (saved.fullReport) fullReport = saved.fullReport;
        if (saved.boundaryData) boundaryData = saved.boundaryData;
        if (saved.lastTimestamp) lastTimestamp = saved.lastTimestamp;
        if (saved.activeFilter) activeFilter = saved.activeFilter;
        if (saved.activeTab) activeTab = saved.activeTab;
      }
      renderAll();
      switchTab(activeTab);
      setFilter(activeFilter);
    } catch (err) {
      applyLocale("zh-CN");
      renderAll();
      showBanner(String(err.message || err), "error");
    }
  }

  bootstrap();
})();
