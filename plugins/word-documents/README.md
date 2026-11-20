# word-documents

让 Claude 创建、读取和编辑这台电脑上的 Word 文档（.docx）：段落、标题、列表、表格及其格式、图片、样式、脚注尾注、批注读取、查找替换和文档保护。不需要安装 Microsoft Word。

## 来源

基于 [GongRzhe/Office-Word-MCP-Server](https://github.com/GongRzhe/Office-Word-MCP-Server) 1.1.11，MIT 许可，版权归 GongRzhe，许可全文见 [LICENSE](LICENSE)。上游仓库已归档，不再更新；本插件不修改上游代码，只给出启动命令。

## 依赖

- 需要先安装 [uv](https://docs.astral.sh/uv/getting-started/installation/)，并能在终端里运行 `uvx`。
- 启动时由 `uvx` 从 PyPI 获取固定版本 `office-word-mcp-server==1.1.11`，依赖按 2026-01-01 之前发布的版本解析。这个日期不能放宽：之后发布的 MCP Python SDK 2.x 与上游代码不兼容。
- `convert_to_pdf`（转为 PDF）需要另外安装 LibreOffice，或在 Windows、macOS 上安装 Microsoft Word；Linux 上只能用 LibreOffice。其余工具三个系统相同。
