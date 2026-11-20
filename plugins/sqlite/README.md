# sqlite

为 Claude 提供本地 SQLite 数据库操作能力：执行查询（`read_query`）、写入与更新（`write_query`）、建表（`create_table`）、查看表列表（`list_tables`）、查看表结构（`describe_table`）以及记录分析备忘（`append_insight`）。

## 来源

基于官方参考实现 [modelcontextprotocol/servers-archived](https://github.com/modelcontextprotocol/servers-archived) 中的 `mcp-server-sqlite` 2025.4.25，MIT 许可，版权归 Anthropic, PBC，许可全文见 [LICENSE](LICENSE)。本插件不修改上游代码，通过 `launcher.py` 按 `pylock.json` 校验并启动。

## 运行位置与依赖

- 运行在环境内（`"kind": "guest"`），直接使用环境自带的 Python 3 与标准库 `sqlite3`，无需在本机安装额外运行环境；macOS、Windows 和 Linux 上完全一致。
- 首次启动时，`launcher.py` 按 `pylock.json` 中记录的精确文件名、字节大小与 SHA-256 摘要，从 `files.pythonhosted.org` 下载锁定版本的预编译包并解包到环境内的 `~/.cache/mcp-plugins/sqlite/`（依赖按 `2026-01-01` 之前解析，以兼容 MCP Python SDK 1.x）；之后复用缓存，不再联网。

## 数据流与权限

- 工具调用完全在环境本地运行，不访问外部网络；默认数据文件保存在环境内的 `~/.local/share/sqlite/sqlite.db`，独立于插件安装目录，更新或重装插件时保留已有数据。
- 仅首次准备依赖时连接 `files.pythonhosted.org`；上游不包含遥测。
