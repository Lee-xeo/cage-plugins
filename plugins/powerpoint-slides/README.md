# powerpoint-slides

让 Claude 创建、读取和编辑工作区里的 PowerPoint 演示文稿（`.pptx`）：幻灯片、文本、表格、图表、图片、形状和模板。不需要安装 Microsoft PowerPoint。

## 来源

基于 [GongRzhe/Office-PowerPoint-MCP-Server](https://github.com/GongRzhe/Office-PowerPoint-MCP-Server) 2.0.7，MIT 许可，版权归 GongRzhe，许可全文见 [LICENSE](LICENSE)。上游仓库已归档，不再更新；本插件不修改上游代码，通过 `launcher.py` 按 `pylock.json` 校验并启动。

## 运行位置与依赖

- 运行在环境内（`"kind": "guest"`），直接使用环境自带的 Python 3，不需要在电脑上安装 `uv` 或额外运行环境。macOS、Windows 和 Linux 上用法和工具完全一致。
- 首次启动时，`launcher.py` 按 `pylock.json` 中记录的精确文件名、字节大小与 SHA-256 摘要，从 `files.pythonhosted.org` 下载锁定版本的预编译包并解包到环境内的 `~/.cache/mcp-plugins/powerpoint-slides/`（依赖按 `2026-01-01` 之前解析，以保持与 MCP Python SDK 1.x 兼容）；之后启动直接复用缓存，不再联网。

## 数据流与权限

- 工具调用本身不访问网络，只在环境内读写 `.pptx` 文件（包括挂载到环境里的项目目录）。
- 仅首次准备依赖时连接 `files.pythonhosted.org`；上游不包含遥测。
