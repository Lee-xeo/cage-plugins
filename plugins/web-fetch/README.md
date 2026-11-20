# web-fetch

抓取指定网页并将其正文自动转换为简洁的 Markdown 文本，支持按长度分页读取（`max_length`、`start_index`）、读取原始内容（`raw`），并在抓取前遵守站点 `robots.txt` 规则。适合轻量阅读文档和网页，无需启动无头浏览器。

## 来源

基于官方参考实现 [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) 中的 `mcp-server-fetch` 2026.11.18（随上游 [v2.5.0](https://github.com/modelcontextprotocol/servers/releases/tag/v2.5.0) 发布，提交 `c799c85`）。PyPI 包声明 MIT 许可，版权归 Anthropic, PBC.，许可全文见 [LICENSE](LICENSE)（取自该包随附的许可文件）。本插件不修改上游代码，通过 `launcher.py` 按 `pylock.json` 校验并启动，启动参数为上游自带的 `--no-readability-js`。

## 运行位置与依赖

- 运行在环境内（`"kind": "guest"`），直接使用环境自带的 Python 3，无需在本机安装额外运行环境；macOS、Windows 和 Linux 上完全一致。
- 首次启动时，`launcher.py` 按 `pylock.json` 中记录的精确文件名、字节大小与 SHA-256 摘要，从 `files.pythonhosted.org` 下载锁定版本的预编译包并解包到环境内的 `~/.cache/mcp-plugins/web-fetch/`；之后复用缓存，不再重复下载。

## 数据流与权限

声明 `network` 权限。插件发起的网络访问只有以下几类：

- 调用 `fetch` 时，向目标 URL 发起 HTTP/HTTPS 请求；跟随重定向时，也请求每一跳的地址。
- 抓取前读取目标站点的 `robots.txt`；跟随重定向时，读取每一跳所在站点的 `robots.txt`。
- 若环境设置了 `HTTP_PROXY`、`HTTPS_PROXY` 等代理变量，以上请求经该代理发出。
- 首次准备依赖时，从 `files.pythonhosted.org` 下载 `pylock.json` 锁定的预编译包。

不会发生的访问：

- 不运行 Node.js，也不运行 `npm install`。上游默认在 Node.js 可用时用 Readability.js 提取正文，并在首次提取时执行 `npm install` 从 npm 获取未锁定版本的依赖；本插件以 `--no-readability-js` 启动，只用 `readabilipy` 的纯 Python 提取器，不启动任何子进程。
- 默认拒绝连接私有、回环和链路本地地址。
- 上游不包含遥测。
