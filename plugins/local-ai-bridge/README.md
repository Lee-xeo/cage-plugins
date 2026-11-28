# Local AI Bridge

作者：杀猪小弟（[@ianisme](https://github.com/ianisme)）

通过原生非交互 CLI 协议，从共享项目工作区异步委派任务给宿主机上已安装的 **Codex CLI**、**Grok CLI** 与 **Antigravity CLI (`agy`)**，并在侧栏提供实时任务与多轮会话看板。

## 各 CLI 实际隔离边界与数据流向（派发前透明披露）

插件默认以 **`read-only`** 启动任务，但三个上游 CLI 自身提供的约束机制不同，插件不在界面或文档中夸大任何后端的隔离强度；派发前可通过 `ai_list_providers` 或侧栏「新建任务」弹窗确认**使用哪个已登录账号**、**发往哪个服务**以及**实际隔离层级**：

| 后端 | 使用账号与数据去向 | `read-only` 默认实际边界（如实说明） | 隔离层级标识 |
| --- | --- | --- | --- |
| **Codex CLI** | 本机 `codex login` 账号（ChatGPT / API Key）→ OpenAI Codex 服务 | `--sandbox read-only --ignore-user-config --ignore-rules --disable hooks --disable plugins --disable apps -c web_search="disabled"`（Windows 加 `-c windows.sandbox="unelevated"`），使用 CLI 提供的 OS 级只读沙箱 | `os-sandbox` |
| **Grok CLI** | 本机 `grok login` 账号 → xAI Grok 服务 | `--permission-mode plan --disable-web-search --no-subagents --tools read_file,list_dir,grep`，配合 `--disallowed-tools`（覆盖 `run_terminal_cmd` / `run_terminal_command` 等）与内置 `--deny Bash(*)` / `Edit(*)` / `Write(*)` / `MCPTool(*)` / `WebFetch(*)` / `WebSearch(*)`。**属于 CLI 工具/权限层约束，非 OS 内核文件系统沙箱** | `cli-tool-restricted` |
| **Antigravity CLI (`agy`)** | **默认停用**；启用后使用本机 `agy` 已缓存登录态 → Google Antigravity 服务 | 临时 `--settings` 设 `toolPermission: "request-review"` + `permissions.deny`（拒绝 `write_file(*)`、`command(*)`、`mcp(*)`、`execute_url(*)`、`download_url(*)`、`read_url(*)`）+ `--disable-slash-commands`，并在启动前检查并**拒绝**包含项目级 hooks 或工作流（`.agents/hooks.json`、`.agents/workflows/` 等）的目录。**不是 OS 级只读沙箱**，`agy` 进程仍在当前项目目录启动，且当前 CLI 对 `run_workflow` 与用户全局 hooks/workflows 无独立 deny 规则 | `policy-deny-best-effort` |

> **发送上下文说明**：所有后端均通过宿主机对应 CLI 读取当前打开的共享项目目录（`${PROJECT_DIR}`），将你提供的提示词与 CLI 选取的项目文件上下文发送至各自上游服务，并占用本机对应账号用量。

## Antigravity 专项说明：账号合规风险与执行边界（分步独立确认）

Antigravity 后端**默认关闭**（`enabled: false`, `risk_acknowledged: false`）。首次启用时会**分两步弹出独立 `ui/confirm` 确认**，每次从看板派发/追问时也会再次分项展示并确认两类独立信息：

1. **账号与服务条款风险（Account / Usage Policy）**：
   - Antigravity CLI 官方文档提供了无头模式与流式 JSON 接口（上游文档：[Antigravity Headless Mode](https://antigravity.google/docs/cli/headless)、[Permissions](https://antigravity.google/docs/permissions)），但通过第三方工具进行非交互桥接或自动化编排是否符合你的账号类型与地区政策需自行核对（参见 [Google 服务条款](https://policies.google.com/terms) 及账号所属套餐协议），存在触发风控、限制或封禁的风险。请自行评估后再决定是否启用。
2. **文件与执行权限边界（File & Execution Boundary）**：
   - `agy` 在原共享项目目录启动，插件无法向其施加 OS 级只读文件系统隔离；`read-only` 仅靠临时 `--settings` 拒绝列表与启动前项目检查（检测 `.agents/hooks.json`、`.agent/hooks.json`、`.gemini/hooks.json`、`.antigravity/hooks.json`、`.agents/plugins/*/hooks.json` 以及非空的 `.agents/workflows/`、`.agent/workflows/`、`.gemini/workflows/`、`.antigravity/workflows/`、`.agents/plugins/*/workflows/` 目录，命中时在 `read-only`/`workspace-write` 下直接拒绝启动）。
   - `agy` 目前不提供禁用 `run_workflow` 或用户全局 hooks/workflows 的独立开关；如对项目来源不信任，请优先使用具备 OS 级只读沙箱的 Codex `read-only` 审查。

## 权限分层：普通只读审查 vs 独立高风险覆盖

- **默认只读（`read-only`）**：开箱默认档位，按上表约束各 CLI 权限。
- **项目写入（`workspace-write`）**：默认关闭，按后端在卡片或「策略与路径」中经 `ui/confirm` 确认开启；Codex 禁用 hooks/plugins/apps，Grok 仍禁用终端、子代理与 MCP，Antigravity 仍拒绝 `command(*)`/`mcp(*)`/`*_url` 并拦截项目 hooks/workflows。
- **高风险覆盖（`full-access`，与普通只读审查独立分离）**：
  - 不出现在主卡片常规下拉框中，独立放置在「策略与路径」底部的红色高风险覆盖区（`High-Risk Override`），默认关闭，须逐项经 `ui/confirm` 显式解锁。
  - 开启后自动批准本机任意命令、文件写入、网络与插件/浏览器调用（Codex `danger-full-access` 保留 plugins/apps、Grok `bypassPermissions --always-approve`、Antigravity `--dangerously-skip-permissions`）。

## 关键安全与工程设计

- **提示词零命令行注入 + 单句柄无 TOCTOU 读取**：
  - 全部后端均通过标准输入（Codex `-`、Antigravity `--input-format stream-json`）或私有临时文件（Grok `--prompt-file`）传递提示词，不将不可信提示词拼入命令行参数。
  - `prompt_file` 在 POSIX 上通过 `dir_fd` 逐级 `O_NOFOLLOW` 打开并在同一文件句柄上 `fstat` 校验普通文件与限量读取（≤ 512 KiB）；在 Windows 上单句柄打开后通过 `GetFinalPathNameByHandleW` 核验内核最终路径仍在 `${PROJECT_DIR}` 内并限量读取，消除路径与大小检查的 TOCTOU 竞态。
- **Windows 安全执行与完整进程树清理**：
  - Windows 优先定位 `.exe`，遇到 npm `.cmd`/`.ps1`/`.bat` 包装器时解包出底层 JS 入口直接由 `node.exe` 启动，拒绝经 `cmd.exe` 执行未解包批处理，拒绝加载 `${PROJECT_DIR}` 内的同名可执行文件。
  - 取消任务或进程退出时先唤醒全部等待轮询并终止子进程树（POSIX `killpg`、Windows `taskkill /T /F`）。
- **多项目并发隔离与凭据脱敏**：
  - 全局策略保存在 `~/.local/share/local-ai-bridge/policy.json`，会话与任务按项目路径哈希隔离于 `projects/<project_key>/`，使用操作系统内核文件锁（Windows `msvcrt.locking` + NTFS 瞬态重试、POSIX `fcntl.flock`）与唯一临时文件名写入；POSIX 文件权限 `0600`，Windows 使用 `icacls` 限定当前用户。
  - 模型接口不返回宿主机路径或用户名；代理 URL 中的 `user:pass@` 在看板快照、tooltip 与 stderr 诊断中统一脱敏为 `***@`；代理环境变量仅注入拉起的宿主机 CLI 子进程。

## MCP 工具

工具清单定义于 [tools.json](tools.json)：

| 工具 | 可见性 | 说明 |
| --- | --- | --- |
| `ai_list_providers` | 模型 + 看板 | 返回各 CLI 可用性、版本、登录账号摘要、目标服务、实际只读边界与权限档位（不暴露宿主机绝对路径） |
| `ai_list_models` | 模型 + 看板 | 查询指定 AI 的可选模型与推理强度（缓存 60 秒） |
| `ai_run_task` | 模型 + 看板 | 发起新任务或基于 `session_id` 续聊，立即返回 `task_id` 与 `session_id` |
| `ai_task_status` | 模型 + 看板 | 查询进度或等待变化（最长 25 秒），返回流式预览、`nextCheck` 或分页后的最终回复 |
| `ai_task_cancel` | 模型 + 看板 | 取消当前项目的运行中任务并终止完整进程树 |
| `ai_session_history` | 模型 + 看板 | 列出当前项目会话或查看指定会话的多轮记录 |
| `ai_dashboard_state` | 仅看板 | 获取侧栏看板的聚合状态快照（自动脱敏代理凭据） |
| `ai_manage_policy` | 仅看板 | 在侧栏修改权限策略、代理、自定义 CLI 路径或清理当前项目历史 |

## 本地安装

1. 将 `local-ai-bridge` 整个目录复制到配置目录的 `plugins/local-ai-bridge/`（普通目录复制，不要使用软链接）。
2. 开启主机插件开关，点击「重新加载」，启用 **Local AI Bridge**。
3. 打开主机共享的项目目录，在侧栏 **Local AI Bridge** 看板查看各后端状态与边界并按需启用或委派。
