# local-preview

让 Claude 在这台电脑的浏览器里打开本机开发服务器上的页面，并读回标签页实际显示的标题和地址。支持 macOS、Windows 和 Linux。

## 工具

| 工具 | 作用 |
| --- | --- |
| `open_page` | 在浏览器窗口里打开 `url`，等页面加载出自己的标题（最多约 3 秒）后返回标签页的 `id`、`title` 和 `url`。只接受 `http://` 或 `https://` 开头、主机为 `127.0.0.1`、`localhost` 或 `[::1]` 的地址，例如 `http://localhost:5173/`；地址最长 2048 个字符，不能含空格、引号、反斜杠、控制字符或用户名密码 |
| `read_tab` | 返回某个标签页现在的 `id`、`title` 和 `url`。`id` 用 `open_page` 返回的值，省略时读最近一次打开的标签页。页面跳转或用户在标签页里换了地址，返回的就是新的地址 |

两个工具的结果都是一行 JSON，例如 `{"id": "F850…", "title": "My App", "url": "http://127.0.0.1:5173/"}`。

## 工作方式

插件不使用你平时的浏览器资料。第一次调用 `open_page` 时，它用一个单独的配置目录启动浏览器，打开一个新窗口；之后的调用在同一个浏览器里新开标签页。浏览器开着远程调试端口（只监听 `127.0.0.1`，端口由浏览器随机选择），插件通过这个端口的 HTTP 接口新开标签页、读取标签页列表，不注入脚本，也不读取页面内容。

浏览器按以下顺序查找，用第一个找到的：

| 系统 | 位置 |
| --- | --- |
| macOS | `/Applications` 或 `~/Applications` 下的 Google Chrome、Microsoft Edge、Chromium |
| Windows | Program Files、Program Files (x86)、`%LOCALAPPDATA%` 下的 Chrome、Edge、Chromium，以及安装程序登记的 `chrome.exe`、`msedge.exe` |
| Linux | `PATH` 中的 `google-chrome`、`google-chrome-stable`、`microsoft-edge`、`microsoft-edge-stable`、`chromium`、`chromium-browser`，以及 `/opt/google/chrome/chrome`、`/opt/microsoft/msedge/msedge`、`/usr/lib/chromium/chromium` |

想用别的 Chromium 系浏览器时，把环境变量 `LOCAL_PREVIEW_BROWSER` 设为它的程序路径（应用启动时要能看到这个变量）。一个都找不到时，工具会报错说明。

浏览器的配置目录：

| 系统 | 目录 |
| --- | --- |
| macOS | `~/Library/Application Support/local-preview/browser` |
| Windows | `%LOCALAPPDATA%\local-preview\browser` |
| Linux | `$XDG_DATA_HOME/local-preview/browser`，默认 `~/.local/share/local-preview/browser`；snap 安装的浏览器用 `~/snap/<名称>/common/local-preview` |

这个目录里保存的是这个浏览器自己的历史、Cookie 和缓存，删掉后下次会重新创建。浏览器窗口可以随时手动关闭，下次 `open_page` 会重新启动它。

## 使用前

- macOS 和 Linux 需要能找到 `python3`，只用到标准库。Windows 用系统自带的 PowerShell 运行，不需要安装任何东西；如果组策略禁止运行 PowerShell 脚本，插件无法启动。
- Linux 需要图形会话（`DISPLAY` 或 `WAYLAND_DISPLAY`），浏览器才能打开窗口。
- 声明的权限是 `network`：插件让浏览器访问本机回环地址上的服务，并通过本机端口控制这个浏览器。

## 注意

- 浏览器开着远程调试端口期间，这台电脑上以你的账户运行的其他程序也能连上这个端口、控制这个浏览器。不用时可以关掉预览窗口。
- 只限制 `open_page` 打开的地址。页面自己跳转到别处，或你在窗口里手动访问其他网站，浏览器照常打开，`read_tab` 也照实返回。
