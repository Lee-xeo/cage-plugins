# documents-to-markdown

将 PDF、Word（`.docx`）、PowerPoint（`.pptx`）、Excel（`.xlsx`/`.xls`/`.ods`）、EPUB、HTML 等本地文档或 http(s) 网址指向的文档转换为简洁的 Markdown，并支持生成章节目录树（`outline`）、跨文档与目录检索（`search`）以及按页/区域检查证据（`inspect`）。

## 来源

基于开源项目 [SylphxAI/anymd](https://github.com/SylphxAI/anymd) 8.5.13，MIT 许可，版权归 SylphxAI，许可全文见 [LICENSE](LICENSE)。本插件不修改上游代码，通过 `launcher.py` 固定版本启动。

## 运行位置与依赖

- 运行在环境内（`"kind": "guest"`），直接使用环境自带的 Node.js 与 Python 3，无需在本机安装额外运行环境；macOS、Windows 和 Linux 上完全一致。
- 首次启动时，`launcher.py` 立即返回工具清单，并在后台通过 `npx --yes @sylphx/anymd@8.5.13` 从 npm 获取固定版本（按 npm 完整性哈希校验）；之后使用环境内的 npm 缓存，不再联网。

## 数据流与权限

声明 `network` 权限，调用前会请你确认。插件发起的网络访问有以下几类：

- `read`、`outline`、`search` 和 `inspect` 的来源可以是 http(s) 网址：传入网址时，插件会下载该网址的内容再解析。只读取本地文件时不访问网络。
- `read` 的 `download_asr_model` 设为 `true` 时，从 `huggingface.co` 下载锁定版本的 Qwen3-ASR-1.7B 语音识别模型（约 2.2 GB，按 SHA-256 校验）及配套的对齐模型，存入环境内的 anymd 缓存，用于转写音视频。默认不下载，只在明确开启时下载；请留意环境的磁盘空间。
- 首次准备包时，经 `npx` 连接 npm 镜像源（默认 `registry.npmjs.org`）获取固定版本。
- OCR 只使用已经安装的引擎和模型，设置 `ocr` 不会自动下载模型。上游不包含遥测。
