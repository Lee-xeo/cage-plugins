# film-studio

让 Claude 用 OpenFilm 把影片写成网页、检查画面、渲染 MP4、取素材，并在侧栏页面一键在 Cage 浏览器里打开 Studio 手动剪辑。

## 来源

与 [openfilm/openfilm](https://github.com/openfilm/openfilm) 0.4.1 配合使用，MIT 许可，许可全文见 [LICENSE](LICENSE)。本插件不修改上游代码，也不随包携带：首次使用时，由插件按随包的 `package-lock.json`（记录每个包的完整性哈希）从 npm 安装 OpenFilm 0.4.1。

film-studio 与 OpenFilm 配合使用（works with OpenFilm），并非 OpenFilm 项目出品或认可；OpenFilm 名称与标志属于其所有者。

## 运行位置与依赖

- 运行在环境内，使用环境自带的 Node.js，macOS、Windows 和 Linux 上用法一致。
- 首次使用时下载（侧栏页面一键完成，也会在 Claude 第一次调用时自动开始）：
  - OpenFilm 的 npm 包：压缩后约 80 MB，解包约 270 MB，放在 `~/.cache/film-studio/openfilm/`。
  - Chromium Headless Shell 149（Playwright 修订 1228）：约 100 MB，从 `cdn.playwright.dev` 下载，核对大小和 SHA-256 后解包到 `~/.cache/film-studio/browsers/`。
  - ffmpeg：通过 `sudo apt-get install -y ffmpeg` 安装。环境里可免密码使用 sudo 时，页面一键安装；否则请在终端里自己运行这条命令。
- OpenFilm 的数据放在 `~/.local/share/film-studio/home`（`OPENFILM_HOME`），与环境里其他方式安装的 OpenFilm 互不干扰。
- 内存：一个渲染进程约占 1.1 GB，建议把环境的内存设为 8 GB 或更多。可用内存低于 4 GB 时，渲染默认只用 1 个进程。

## 工具

| 工具 | 作用 |
| --- | --- |
| `film_guide` | 返回 OpenFilm 的使用手册；给出 `skill` 时返回该技能的全文 |
| `film_open` | 创建或打开一部影片（一个文件夹），启动 Studio，返回项目路径和 Studio 地址 |
| `film_look` | 检查画面：返回报告文字和最多 4 张画面图片，可指定时间点、数量、是否完整输出和响度检查；尚未完成时返回任务 |
| `film_render` | 在后台把影片渲染成 MP4，可设置范围、帧率、4K、缩放、运动模糊、透明通道、字幕、响度、进程数和输出路径；等待一段时间后返回任务状态 |
| `film_run` | 运行其他 OpenFilm 命令（取素材、查看技能、`doctor` 等），参数以数组给出 |
| `film_job` | 查看任务的进度、日志末尾和输出文件，可等待一段时间 |
| `film_cancel` | 停止一个任务 |

安装、渲染等耗时操作都是后台任务，工具等待一小会儿后会返回任务编号，再用 `film_job` 查询。

## 页面

侧栏的 Film Studio 页面显示：

- 状态栏：OpenFilm、渲染浏览器、ffmpeg、可用内存和 Studio 是否在运行。
- 首次准备：缺少什么就显示一张卡片，一键安装并显示进度；ffmpeg 无法自动安装时，显示命令供复制。
- 影片列表：缩略图、名称、路径、修改时间和已渲染的 MP4。可以在 Cage 浏览器里打开 Studio 手动剪辑，也可以新建影片。
- 任务：进度、剩余时间、取消和日志末尾。
- 终端命令开关。

页面专用的工具 `film_dashboard`、`film_setup`、`film_studio`、`film_thumbnail`、`film_terminal` 只供页面调用，Claude 看不到。

## 在终端里使用

插件会写出命令脚本 `~/.local/share/film-studio/bin/openfilm`，它带着固定版本和上述环境设置运行 OpenFilm。在页面里打开终端命令开关后，还会建立链接 `~/.local/bin/openfilm`，之后在终端里直接输入 `openfilm` 即可。

因为版本已固定，`openfilm update` 会被拦下。Claude Code 可以直接照着 OpenFilm 的手册（`openfilm` 不带参数的输出）操作。

## 数据流与权限

声明的权限是 `network`。插件联网访问：

- `registry.npmjs.org`：首次使用时安装 OpenFilm。
- `cdn.playwright.dev`（及其镜像）：下载渲染浏览器，下载后核对 SHA-256。
- Debian 软件源：安装 ffmpeg。
- `openfilm.dev`：Studio 启动时获取素材库目录；音乐、音效、贴纸、配音等素材库媒体在首次使用时下载；语义搜索素材库时会把搜索词发给它（可在 Studio →「设置」→「服务」→ Library search 选 None 关闭）；约每 5 分钟刷新一次媒体模型列表；只有登录账号后才会有账号和付费生成相关的访问。
- `raw.githubusercontent.com`、`api.github.com`：社区技能和示例的索引。
- `huggingface.co`、`github.com`：按需下载视觉模型，OpenFilm 会核对 SHA-256。
- 各服务商的接口：仅在你自己配置了密钥时才访问。

本插件会关闭 OpenFilm 的更新检查和安装统计（`OPENFILM_NO_UPDATE_CHECK`、`OPENFILM_NO_STATS`）。Studio 只监听环境内的 `127.0.0.1`。

因为声明了 `network`，Cage 会逐次请求你批准每一次调用，页面的刷新也一样。建议安装后选择「安装后始终允许」，或在插件详情页的「授权与权限」里设置。

## 注意

- 从头到尾制作一部影片需要能写文件的 Claude，例如 Claude Code；Claude Desktop 可以检查画面、渲染和取素材。
- 从电脑共享给环境的项目文件夹里，`.film` 缓存的读写会慢一些，而且 Studio 只能发现在环境内做出的修改。
- 渲染会保留已完成的分段；对同一部影片再次开始同样的渲染，会从中断处继续。
- arm64（Apple Silicon）版本的渲染浏览器尚未测试。
