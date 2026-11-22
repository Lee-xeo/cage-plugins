# film-studio

让 Claude 用 OpenFilm 把影片写成网页、检查画面、渲染 MP4、取素材，并在侧栏页面一键在你自己的浏览器里打开 Studio 手动剪辑。插件运行在你的电脑上，只处理当前打开的共享项目文件夹里的影片。

## 来源

与 [openfilm/openfilm](https://github.com/openfilm/openfilm) 0.4.1 配合使用，MIT 许可，许可全文见 [LICENSE](LICENSE)。OpenFilm 不随本插件携带：首次使用时，由插件按随包的 `package-lock.json`（记录每个包的完整性哈希）从 npm 安装 OpenFilm 0.4.1。

安装之后，插件会对这份已安装的副本做五处很小的文字改动（见 `lib/patches.mjs`），目的是让影片页面无法联网。每处改动都要求原文在文件里恰好出现一次，找不到就拒绝安装，不会留下一份没改完的副本：

1. 画面检查和渲染时，页面默认关闭网络，除影片自己的文件夹外的请求都被拒绝并记录。
2. 绘制用的浏览器增加启动参数：除本机地址外的域名一律解析失败，禁止直连 UDP，关闭 DNS 预取。
3. Studio 的预览页（在你的浏览器里播放）带上页面策略：只允许加载影片自己的文件夹和页面自己生成的内容，并禁止弹出窗口、表单提交和接管所在窗口；同时关闭 DNS 预取，并在页面脚本运行前去掉 WebRTC。
4. 预览页里，以访客方式请求的页面同样经过上述处理，不再当作普通文件原样发出。
5. `film.html` 本身只被读取（由播放它的时间线读取）、不运行，所以送出时带上一条禁止一切的策略；以只读方式取其他页面时，同样在脚本运行前去掉 WebRTC。

film-studio 与 OpenFilm 配合使用（works with OpenFilm），并非 OpenFilm 项目出品或认可；OpenFilm 名称与标志属于其所有者。

## 运行位置与依赖

- 运行在这台电脑上（主机插件），以你的账号运行。没有打开共享项目文件夹时不会启动；切换项目时插件会重启。
- 需要本机已有 Node.js 22.2 或更高版本（含 npm）。版本不够时，页面会显示原因。
- 需要你自己安装 ffmpeg，插件不会替你安装：
  - Windows：`winget install --id Gyan.FFmpeg -e`
  - macOS：`brew install ffmpeg`
  - Debian / Ubuntu：`sudo apt-get install -y ffmpeg`

  请在这台电脑的终端里运行。页面的准备卡片会显示适合你系统的命令，带「复制」和「重新检查」按钮。用上面的命令装好后点「重新检查」即可；用别的方式装到别处时，要先重新打开 Cage，让它读到新的 PATH。
- 首次使用时下载（侧栏页面一键完成，也会在 Claude 第一次调用时自动开始）：
  - OpenFilm 的 npm 包：压缩后约 80 MB，解包约 270 MB。
  - Chrome Headless Shell 149.0.7827.55（Playwright 修订 1228）：约 98 至 120 MB，随系统不同；从 `cdn.playwright.dev`（及其镜像）下载，核对大小和 SHA-256 后解包。
- 数据放在：
  - Windows：`%LOCALAPPDATA%\film-studio\cache` 和 `%LOCALAPPDATA%\film-studio\data`
  - macOS：`~/Library/Caches/film-studio` 和 `~/Library/Application Support/film-studio`
  - Linux：`~/.cache/film-studio` 和 `~/.local/share/film-studio`

  `cache` 里是能重新下载的内容（OpenFilm、渲染浏览器、缩略图），`data` 里是 OpenFilm 自己的状态（`home`）和后台任务记录（`jobs`）。
- 支持：Windows x64、macOS arm64 与 x64、Linux x64 与 arm64。
- 实测情况：在 Windows 11 x64（NVIDIA 显卡，在 Cage 里）和 Linux x64 上真正运行过。macOS 和 Linux arm64 的渲染浏览器已固定下载地址和 SHA-256，并检查过能否解包，但还没有运行过，请当作尚未验证。

## 工具

Claude 能用的工具：

| 工具 | 作用 |
| --- | --- |
| `film_guide` | 返回 OpenFilm 的使用手册；给出 `skill` 时返回该技能的全文 |
| `film_open` | 创建或打开一部影片（项目里的一个文件夹），在你的浏览器里打开 Studio |
| `film_look` | 检查画面：返回报告文字和最多 4 张画面图片，可指定时间点、数量、是否完整输出和响度检查；同时报告被拒绝的在线字体和脚本；尚未完成时返回任务 |
| `film_render` | 在后台把影片渲染成 MP4，可设置范围、帧率、4K、缩放、运动模糊、透明通道、字幕、响度、进程数和输出路径；等待一段时间后返回任务状态 |
| `film_run` | 运行白名单内的其他 OpenFilm 命令（取素材、查看技能、`doctor`、`edit`、`canvas`、`color` 的部分子命令），参数以数组给出 |
| `film_job` | 查看任务的进度、日志末尾和输出文件，可等待一段时间 |
| `film_cancel` | 停止一个任务 |

安装、渲染等耗时操作都是后台任务，工具等待一小会儿后会返回任务编号，再用 `film_job` 查询。

## 页面

侧栏的 Film Studio 页面显示：

- 项目路径和状态栏：OpenFilm、渲染浏览器、ffmpeg、内存和 Studio 是否在运行。Windows 和 Linux 显示可用内存，可用内存低于 2 GB 时给出提醒；macOS 取不到可用内存，只显示总量。
- 首次准备：缺少什么就显示一张卡片。「一键准备」只安装 OpenFilm 和渲染浏览器；ffmpeg 显示命令供复制，装好后点「重新检查」。Node.js 版本不够时显示原因。
- 影片列表：缩略图、名称、路径、修改时间和已渲染的 MP4。可以「在 Studio 中打开」（在你的浏览器里打开；浏览器里已经开着 Studio 时，会切换到这部影片）、渲染（1080p、4K、发布音量 -14 LUFS）、复制路径、「下载在线素材」。新建影片只需填名称，影片建在项目文件夹里；名称不能含斜杠，也不能以点开头。
- 任务：进度、剩余时间、取消和日志末尾。
- 设置：渲染默认使用发布音量。

页面专用的工具 `film_dashboard`、`film_setup`、`film_studio`、`film_thumbnail`、`film_localize` 只供页面调用，Claude 看不到。

## 在线字体与脚本

影片页面是在断网状态下绘制的，所以字体和脚本必须放在影片文件夹里。页面里仍可以按常规写这五个地址：Google Fonts（`fonts.googleapis.com`、`fonts.gstatic.com`）、jsDelivr（`cdn.jsdelivr.net/npm/…`）、unpkg、cdnjs，脚本包要写明确切版本，例如 `gsap@3.12.5`。

- `film_look` 会报告被拒绝的在线资源，并给出一条命令：`node '<影片>/.film/film-studio/localize.mjs' '<影片>'`。Claude Code 在自己的终端里运行它（走环境自己的代理）。
- 没有终端时，用页面里影片的「更多」菜单里的「下载在线素材」。点击后会先请你确认，然后通过这台电脑自己的网络（不经过代理）下载，并把影片的页面改为使用下载到本地的文件。
- 文件放在影片的 `assets/vendor/`，下载记录和每个文件的 SHA-256 写在 `assets/vendor/vendor.json`；再次下载时，已记录的文件必须与记录一致。

## 安全边界

- 只在项目内：所有路径都必须在当前共享项目文件夹里，先解析链接再检查；指向项目外的链接会被拒绝。
- `film_run` 只运行白名单内的命令；会运行外来代码的命令（技能自带的命令、添加技能）、让调用方指定网址的命令和发布类命令都不在其中，`update` 也被拦下。
- 影片页面是离线的：画面检查、渲染、导出和缩略图都在网络关闭的状态下绘制（见上文五处改动）。
- 仍有一个缺口：Studio 预览在你的浏览器里播放，页面策略管不到 WebRTC，插件的做法是在页面脚本运行前把它去掉；但从一个特意做出的空白 iframe 里仍能取到 WebRTC。除此之外，预览页受页面策略限制。
- OpenFilm 自己的流量（素材库、模型列表、npm 与 Playwright 下载）走这台电脑自己的网络，不走环境的代理。
- 主机插件以你的账号运行，权限是你的权限。
- 影片的页面是 Claude 写的程序：它们在无头浏览器里，以及在你这台电脑的浏览器里运行。请像对待别人给你的代码一样，留意 Claude 写进去的内容。

## 数据流与权限

声明的权限是 `files`、`commands`、`network`。

- 文件：读写当前项目文件夹（影片、渲染结果、影片里的 `.film` 缓存和 `assets/vendor/`），以及上文列出的缓存和数据文件夹。
- 命令：运行本机的 `node`、`npm`、`ffmpeg`，以及 OpenFilm 和渲染浏览器。
- 网络，联网访问：
  - `registry.npmjs.org`：首次使用时安装 OpenFilm。
  - `cdn.playwright.dev` 及其镜像：下载渲染浏览器，下载后核对 SHA-256。
  - `openfilm.dev`：Studio 启动时获取素材库目录；音乐、音效、贴纸、配音等素材库媒体在首次使用时下载；语义搜索素材库时会把搜索词发给它（可在 Studio →「设置」→「服务」→ Library search 选 None 关闭）；约每 5 分钟刷新一次媒体模型列表；只有登录账号后才会有账号和付费生成相关的访问。
  - `raw.githubusercontent.com`、`api.github.com`、`github.com`：社区技能和示例的索引等。
  - `huggingface.co`：按需下载视觉模型，OpenFilm 会核对 SHA-256。
  - `fonts.googleapis.com`、`fonts.gstatic.com`、`cdn.jsdelivr.net`、`unpkg.com`、`cdnjs.cloudflare.com`：仅在你或 Claude 运行「下载在线素材」时访问；为核对内容还会访问 `data.jsdelivr.com` 和 `api.cdnjs.com` 取哈希。
  - 各服务商的接口：仅在你自己在编辑器里配置了密钥时才访问。

本插件会关闭 OpenFilm 的更新检查和安装统计（`OPENFILM_NO_UPDATE_CHECK`、`OPENFILM_NO_STATS`）。Studio 在你的默认浏览器里打开，地址里带有密钥，插件不会把它交给 Claude 或页面。

## 注意

- 从头到尾制作一部影片需要能写文件的 Claude，例如 Claude Code；Claude Desktop 可以检查画面、渲染和取素材。
- 切换项目会让插件重启，但已经开始的渲染会继续进行。
- 渲染会保留已完成的分段；对同一部影片再次开始同样的渲染，会从中断处继续。
- 有合适的显卡时会用到：在一台 Windows 11（RTX 5060 笔记本）上，WebGL 由显卡绘制，视频由 NVENC 编码；4 秒 1080p 的渲染约 6 秒，同样的影片在没有显卡的 Linux 环境里要 13 至 20 秒。很小的影片差别不大。
