# documents-to-markdown

将 PDF、Word（`.docx`）、PowerPoint（`.pptx`）、Excel（`.xlsx`/`.xls`/`.ods`）、EPUB、HTML 等本地文档转换为简洁的 Markdown，并支持生成章节目录树（`outline`）、跨文档与目录检索（`search`）以及按页/区域检查证据（`inspect`）。

## 来源

基于开源项目 [SylphxAI/anymd](https://github.com/SylphxAI/anymd) 8.5.13，MIT 许可，版权归 SylphxAI，许可全文见 [LICENSE](LICENSE)。本插件不修改上游代码，通过 `launcher.py` 固定版本启动。

## 运行位置与依赖

- 运行在环境内（`"kind": "guest"`），直接使用环境自带的 Node.js 与 Python 3，无需在本机安装额外运行环境；macOS、Windows 和 Linux 上完全一致。
- 首次启动时，`launcher.py` 立即返回工具清单，并在后台通过 `npx --yes @sylphx/anymd@8.5.13` 从 npm 获取固定版本（按 npm 完整性哈希校验）；之后使用环境内的 npm 缓存，不再联网。

## 数据流与权限

- 工具调用完全在环境本地读取和解析文档，不访问外部网络。
- 仅首次准备包时连接 npm 镜像源（默认 `registry.npmjs.org`）；上游不包含遥测。
