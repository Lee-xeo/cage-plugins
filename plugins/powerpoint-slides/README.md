# powerpoint-slides

让 Claude 创建、读取和编辑这台电脑上的 PowerPoint 演示文稿（.pptx）：幻灯片、文本、表格、图表、图片、形状和模板。不需要安装 Microsoft PowerPoint。

## 来源

基于 [GongRzhe/Office-PowerPoint-MCP-Server](https://github.com/GongRzhe/Office-PowerPoint-MCP-Server) 2.0.7，MIT 许可，版权归 GongRzhe，许可全文见 [LICENSE](LICENSE)。上游仓库已归档，不再更新；本插件不修改上游代码，只给出启动命令。

## 依赖

- 需要先安装 [uv](https://docs.astral.sh/uv/getting-started/installation/)，并能在终端里运行 `uvx`。三个系统的工具完全一致。
- 启动时由 `uvx` 从 PyPI 获取固定版本 `office-powerpoint-mcp-server==2.0.7`，依赖按 2026-01-01 之前发布的版本解析。这个日期不能放宽：之后发布的 MCP Python SDK 2.x 与上游代码不兼容。
