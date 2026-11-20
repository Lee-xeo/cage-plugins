# word-documents

让 Claude 创建、读取和编辑工作区里的 Word 文档（`.docx`）：段落、标题、列表、表格及其格式、图片、样式、脚注尾注、批注读取、查找替换和文档保护。不需要安装 Microsoft Word。

## 来源

基于 [GongRzhe/Office-Word-MCP-Server](https://github.com/GongRzhe/Office-Word-MCP-Server) 1.1.11，MIT 许可，版权归 GongRzhe，许可全文见 [LICENSE](LICENSE)。上游仓库已归档，不再更新；本插件不修改上游代码，通过 `launcher.py` 按 `pylock.json` 校验并启动。

## 运行位置与依赖

- 运行在环境内（`"kind": "guest"`），直接使用环境自带的 Python 3，不需要在电脑上安装 `uv` 或额外运行环境。macOS、Windows 和 Linux 上用法和工具完全一致。
- 首次启动时，`launcher.py` 按 `pylock.json` 中记录的精确文件名、字节大小与 SHA-256 摘要，从 `files.pythonhosted.org` 下载锁定版本的预编译包并解包到环境内的 `~/.cache/mcp-plugins/word-documents/`（依赖按 `2026-01-01` 之前解析，以保持与 MCP Python SDK 1.x 兼容）；之后启动直接复用缓存，不再联网。
- `convert_to_pdf`（转为 PDF）需要环境内另外安装 LibreOffice；其余工具无需额外软件。

## 数据流与权限

- 工具调用本身不访问网络，只在环境内读写 `.docx` 文档（包括挂载到环境里的项目目录）。
- 仅首次准备依赖时连接 `files.pythonhosted.org`；上游不包含遥测。
