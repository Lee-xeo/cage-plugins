# git-repository

为 Claude 提供结构化的 Git 仓库工具：查看状态（`git_status`）、未暂存与已暂存差异（`git_diff_unstaged`、`git_diff_staged`、`git_diff`）、提交历史（`git_log`）、对象详情（`git_show`）、分支列表与切换/创建（`git_branch`、`git_checkout`、`git_create_branch`）、暂存与提交（`git_add`、`git_reset`、`git_commit`）。

## 来源

基于官方参考实现 [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) 中的 `mcp-server-git` 2026.11.18（随上游 [v2.5.0](https://github.com/modelcontextprotocol/servers/releases/tag/v2.5.0) 发布，提交 `c799c85`）。PyPI 包声明 MIT 许可，版权归 Anthropic, PBC.，许可全文见 [LICENSE](LICENSE)（取自该包随附的许可文件）。本插件不修改上游代码，通过 `launcher.py` 按 `pylock.json` 校验并启动。

## 运行位置与依赖

- 运行在环境内（`"kind": "guest"`），直接使用环境自带的 Python 3 和 `git`，无需在本机安装额外运行环境；macOS、Windows 和 Linux 上完全一致。
- 首次启动时，`launcher.py` 按 `pylock.json` 中记录的精确文件名、字节大小与 SHA-256 摘要，从 `files.pythonhosted.org` 下载锁定版本的预编译包并解包到环境内的 `~/.cache/mcp-plugins/git-repository/`；之后复用缓存，不再联网。

## 数据流与权限

- 工具调用不执行网络推送或拉取，只在环境内读写本地 Git 仓库（包括挂载的项目目录）。
- 仅首次准备依赖时连接 `files.pythonhosted.org`；上游不包含遥测。
