# Codex Dispatch

在 Cage 中打开主机共享的项目后，可以在 Claude Code 或 Claude Desktop 里请主机上的 Codex 做一次只读审查，并在原对话查进度或取消。

> 看看 Codex 有哪些模型。用 Sol 和 high 审一下当前项目的改动，你安排好回查，我先做别的，结束后在这里总结发现。

## 使用条件

主机为 macOS 或 Windows，已安装 Node.js 22 及支持 `app-server --stdio`、`exec --json --ignore-user-config --ignore-rules` 的 Codex CLI。先在主机上完成 Codex 登录。已在 macOS 用 Codex CLI 0.171.0-alpha.13 验证模型列表。Windows 支持 PATH 上的原生 codex.exe 与 npm 官方安装布局。必要时可以在启动 Cage 前把 `CODEX_BIN` 指向受信任的 CLI 绝对路径。

本地试用时把含有 `plugin.json` 的 `codex-dispatch` 文件夹放进 Cage 配置目录的 `plugins` 下，在 Cage 的「插件」里启用并重新加载，然后打开一个从主机共享的项目。Cage 自行管理两个 Claude 客户端的 MCP 接入和工具授权。使用本机插件需开启主机插件功能。

## Claude 能做什么

| 工具 | 用途 |
| --- | --- |
| `codex_dispatch_models` | 读取当前项目名、项目标识和 CLI 返回的可选模型，列出每个模型支持的推理强度及默认值。列表缓存 60 秒。 |
| `codex_dispatch_start` | 在当前共享项目中启动只读任务。可指定 model 和 reasoningEffort，或采用默认值，立即返回任务号。 |
| `codex_dispatch_progress` | 查询任务状态、最近活动、事件数、耗时，以及完成后的答案。可等待下一次状态变化，最长 12 秒。 |
| `codex_dispatch_cancel` | 按任务号请求取消，之后可查询最终状态。 |

在交互式 Claude Code 中，如果你希望任务完成后听到结果，运行中的任务会附上 `nextCheck`，包括回查提示和建议的分钟数。Claude 可用 `CronCreate` 在原会话安排一次回查，然后继续对话。回查时仍在运行，可以再约一次，任务完成、失败、取消或不可查询时停止。建议首次约一分钟后查看，运行超过两分钟后拉长间隔。会话忙时 Claude Code 会等当前轮结束再处理。是否已挂上回查，以 Claude Code 成功创建定时任务为准。客户端没有开放会话定时工具时，仍可用任务号手动查询。[Claude Code 会话定时任务](https://code.claude.com/docs/en/scheduled-tasks)

Cage 的逐次授权设置也适用于进度查询。每个插件实例最多并行运行两个任务，保留至多 64 条近期任务记录。切换共享项目或重新加载插件会结束当前实例和其中的任务。任务记录在内存中，结果返回发起查询的对话。当前版本使用一次性 Codex 会话。

## 数据和权限

任务提示和 Codex 为审查选取的上下文由主机 CLI 提交给其服务，占用主机 Codex 账户的用量。Cage 中的 Claude 收到进度和最终回答。此版本面向 Codex 内置 OpenAI 服务，发现自定义模型目录、提供商或配置中的自定义端点会提示不支持。运行目录由 Cage 指定，Claude 无法提供任意主机目录或 shell 启动参数。工具调用参数仍受 Cage 的 4000 字节上限约束。

Codex 以只读模式运行，关闭 hooks、plugins 和 apps。只读限制文件修改，主机账户可读文件的范围仍取决于 Codex 与系统策略。模型列表来自本机 CLI，列出某个模型不能保证账户额度充足或该次请求一定成功。

[插件接口](https://github.com/Lee-xeo/Claude-Cage/blob/main/docs/plugins.md)
