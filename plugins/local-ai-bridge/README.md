# Local AI Bridge

作者：杀猪小弟（[@ianisme](https://github.com/ianisme)）

通过原生非交互 CLI 协议，从共享项目工作区异步调度宿主机上已安装的 **Codex CLI**、**Grok CLI** 与 **Antigravity CLI (`agy`)**，并在侧栏提供实时任务与多轮会话看板。

## 特性

- **原生非交互协议、零额外依赖**：仅使用 Python 3 标准库，无需启动外部 sidecar 服务，不抢占鼠标或窗口焦点；全部提示词均通过标准输入或私有临时文件传递，不把不可信提示词拼进命令行参数。
  - **Codex**：`codex app-server --stdio` 发现模型，`codex exec --json` / `codex exec resume` 通过 stdin 传递提示词执行任务与多轮续聊。
  - **Grok**：`grok models` 发现模型，`grok --prompt-file <private_tmp>` + `--output-format streaming-messages-json` + `--session-id` / `--resume` 执行任务与多轮续聊。
  - **Antigravity (`agy`)**：**默认停用**——通过第三方工具调用 Antigravity 在 Google 侧不符合相关使用规定，存在账号风险；必须在侧栏看板经过明确的风险二次确认弹窗后才可手动启用，且从看板派发/追问任务时也会再次弹窗确认。启用后通过 `agy models` 发现模型、`agy --input-format stream-json --output-format stream-json` 走 stdin 传提示词并用 `--conversation` 多轮续聊。
- **三级权限档位（默认硬只读、逐项二次确认放行）**：
  - `read-only`（默认）：
    - **Codex**：`--sandbox read-only --ignore-user-config --ignore-rules --disable hooks --disable plugins --disable apps -c web_search="disabled"`（Windows 额外加 `-c windows.sandbox="unelevated"`）。
    - **Grok**：`--permission-mode plan --disable-web-search --no-subagents --tools read_file,list_dir,grep`，配合 `--disallowed-tools`（同时覆盖 `run_terminal_cmd` / `run_terminal_command` 等工具名）与内置前缀 `--deny Bash(*)` / `Edit(*)` / `Write(*)` / `MCPTool(*)` / `WebFetch(*)` / `WebSearch(*)` 硬禁止终端执行、文件写入/编辑、网络与 MCP 工具。
    - **Antigravity (`agy`)**：`--disable-slash-commands --settings <temp_deny.json>`，通过引擎最高优先级 `Deny > Ask > Allow` 硬拒绝 `write_file(*)`、`command(*)`、`mcp(*)`、`execute_url(*)`、`download_url(*)`、`read_url(*)`（覆盖用户本地 `Allow` 规则，且兼容 Windows 10/11；注：`agy` 当前未为 `run_workflow` 或项目内 `.agents/hooks.json` 提供独立 deny 规则字段，对不信任仓库请先审查项目内 hooks 配置）。
  - `workspace-write`：Codex `workspace-write`（禁用 hooks/plugins/apps）；Grok `acceptEdits`（加 `--no-subagents`、`--disable-web-search`，并通过 `--disallowed-tools` 与 `--deny Bash(*)` / `MCPTool(*)` / `WebFetch(*)` / `WebSearch(*)` 禁用终端执行与 MCP）；Antigravity `--mode accept-edits`（仍拒绝 `command(*)` / `mcp(*)` / 浏览器操作）。
  - `full-access`：Codex `danger-full-access`（保留本机 plugins/apps 与浏览器/Chrome MCP）；Grok `bypassPermissions --always-approve`；Antigravity `--dangerously-skip-permissions`。
  - 每次为全局或任意单个 AI 新增解锁 `workspace-write` / `full-access` 均须在侧栏看板经 `ui/confirm` 二次确认。
- **异步并行 + 流式进度 + 完整进程树取消**：启动任务立即返回 `task_id` 与 `session_id`；支持 `prompt_file`（严格限制在 `${PROJECT_DIR}` 内，防路径穿越和软链逃逸）绕开 4000 字节参数上限；取消或退出时在 POSIX 终止整个进程组、在 Windows 调用 `taskkill /T /F` 清理全部子孙进程。
- **实时侧栏看板**：展示各本机 AI 的就绪/登录状态（带 15 秒探测缓存）、运行中任务的流式输出与事件活动、按项目隔离的多轮会话历史，支持直接发起新任务、继续追问、取消任务，以及配置可选的子进程级网络代理（支持一键粘贴 `export https_proxy=... http_proxy=... all_proxy=...`）。

## MCP 工具

工具清单定义于 [tools.json](tools.json)：

| 工具 | 可见性 | 说明 |
| --- | --- | --- |
| `ai_list_providers` | 模型 + 看板 | 检测 Codex / Grok / Antigravity 可用性、版本、登录状态与权限策略（不向模型暴露宿主机路径与用户名） |
| `ai_list_models` | 模型 + 看板 | 查询指定 AI 的可选模型与推理强度（缓存 60 秒） |
| `ai_run_task` | 模型 + 看板 | 发起新任务或基于 `session_id` 续聊，立即返回 `task_id` 与 `session_id` |
| `ai_task_status` | 模型 + 看板 | 查询进度或等待变化（最长 25 秒），返回流式预览、`nextCheck` 或分页后的最终回复 |
| `ai_task_cancel` | 模型 + 看板 | 取消当前项目的运行中任务并终止完整进程树 |
| `ai_session_history` | 模型 + 看板 | 列出当前项目会话或查看指定会话的多轮记录 |
| `ai_dashboard_state` | 仅看板 | 获取侧栏看板的聚合状态快照（自动脱敏代理凭据） |
| `ai_manage_policy` | 仅看板 | 在侧栏修改权限策略、代理、自定义 CLI 路径或清理当前项目历史 |

## 本地安装与使用

1. 将 `local-ai-bridge` 整个目录复制到配置目录的 `plugins/local-ai-bridge/`（使用普通目录复制，不要使用软链接）。
2. 开启主机插件开关，点击「重新加载」，启用 **Local AI Bridge**。
3. 打开一个主机共享的项目目录，即可在侧栏打开 **Local AI Bridge** 实时看板或在对话中直接调度。

## 数据、多项目隔离与安全

- **多项目严格隔离**：全局策略保存在 `~/.local/share/local-ai-bridge/policy.json`；各项目的会话与任务按项目路径哈希隔离保存在 `~/.local/share/local-ai-bridge/projects/<project_key>/` 下，使用跨进程原子锁与唯一临时文件名写入，多项目窗口并发打开不会互相覆盖或跨项目读取。
- **文件权限保护**：私有策略文件与临时提示词/策略文件在 POSIX 下设为 `0600`，在 Windows 下通过 `icacls` 限制为仅当前用户可读写（如需在 Windows 上使用代理凭据，建议仅绑定本地回环代理端口）。
- **Windows 可执行文件安全解析**：Windows 上优先定位 `.exe`，遇到 npm 包装器 `.cmd`/`.ps1`/`.bat` 时直接解析其底层 JS 入口并由 `node.exe` 启动，拒绝直接经由 `cmd.exe` 执行批处理包装器，同时拒绝加载位于当前项目目录内的同名可执行文件。
- **凭据脱敏与网络流向**：代理 URL 中的 `user:pass@` 在看板提示、诊断信息与 stderr 报错中均自动脱敏为 `***@`；网络请求仅由你本机已登录的 `codex` / `grok` / `agy` CLI 各自发往其官方服务端，插件本身无遥测。
