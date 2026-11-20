# web-fetch

抓取指定网页并将其正文自动转换为简洁的 Markdown 文本，支持按长度分页读取（`max_length`、`start_index`）、读取原始内容（`raw`），并在抓取前遵守站点 `robots.txt` 规则。适合轻量阅读文档和网页，无需启动无头浏览器。

## 来源

基于官方参考实现 [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) 中的 `mcp-server-fetch` 2026.11.18，Apache-2.0 OR MIT 许可，许可全文见 [LICENSE](LICENSE)。本插件不修改上游代码，通过 `launcher.py` 按 `pylock.json` 校验并启动。

## 运行位置与依赖

- 运行在环境内（`"kind": "guest"`），直接使用环境自带的 Python 3，无需在本机安装额外运行环境；macOS、Windows 和 Linux 上完全一致。
- 首次启动时，`launcher.py` 按 `pylock.json` 中记录的精确文件名、字节大小与 SHA-256 摘要，从 `files.pythonhosted.org` 下载锁定版本的预编译包并解包到环境内的 `~/.cache/mcp-plugins/web-fetch/`；之后复用缓存，不再重复下载。

## 数据流与权限

- 声明 `network` 权限：调用 `fetch` 工具时会向目标 URL 及其站点的 `robots.txt` 发起 HTTP/HTTPS 请求，经环境网络出口访问。
- 首次准备依赖时连接 `files.pythonhosted.org`；上游不包含遥测。
