# linux-desktop

让 Claude 查看环境内 Linux 桌面的屏幕，并使用那里的鼠标和键盘，操作桌面上运行的图形程序，例如你在环境里安装的应用。

它操作的是**环境自己的桌面**，不是你的电脑。要让 Claude 操作你电脑的屏幕、鼠标和键盘，请用 [`desktop-control`](../desktop-control)。

## 与 `browser` 插件的区别

- [`browser`](../browser)：在环境内运行无界面的 Chromium，通过页面结构（无障碍快照）点击、输入和读取网页。它不需要桌面，也不显示在桌面上，适合处理网页。
- `linux-desktop`：按像素看屏幕，用鼠标和键盘操作桌面上的任何图形程序，适合网页以外的应用，或需要看到实际画面的操作。

两个插件可以同时安装，工具名称互不冲突。

## 工具

工具与 `desktop-control` 相同，名称前加 `desktop_`：

| 工具 | 作用 |
| --- | --- |
| `desktop_screenshot` | 拍下桌面的一块显示器，图片最长边不超过 1568 像素。可选 `region` 或 `window` 只拍一部分，用来放大细看 |
| `desktop_list_displays` | 列出显示器及其位置、大小和完整截图的尺寸 |
| `desktop_list_windows` | 从前到后列出可见窗口：编号、应用、标题、位置、大小，以及哪个窗口有焦点 |
| `desktop_cursor_position` | 返回指针的位置 |
| `desktop_click` | 单击、双击或三击，可选按键和按住的修饰键 |
| `desktop_move_pointer` | 移动指针；按住鼠标键时即为拖动 |
| `desktop_drag` | 按住鼠标键从一处拖到另一处 |
| `desktop_mouse_down` / `desktop_mouse_up` | 按下 / 松开鼠标键 |
| `desktop_scroll` | 按滚轮格数滚动 |
| `desktop_type_text` | 逐字输入文字，不经过剪贴板 |
| `desktop_press_key` | 按键或组合键，如 `return`、`mod+c`（`mod` 在 Linux 上为 Ctrl） |
| `desktop_wait` | 等待 0–30 秒 |

坐标是最近一张完整截图的像素。参数和键名的详细说明见 [`desktop-control` 的说明](../desktop-control/README.md)，其中 Linux 一节的说明同样适用。

## 工作方式

- 运行在环境内（`"kind": "guest"`），程序与 `desktop-control` 的 Linux 版相同，以 `--this-desktop` 启动。
- 插件启动时环境变量里没有 `DISPLAY`。每次调用时，它在当前账户自己运行的进程里找 X 服务器（Xtigervnc、Xvnc、Xorg、Xvfb 等），从启动参数读出显示编号和 `-auth` 指定的授权文件，再连接。有多个时，优先选套接字属于当前账户的，再选编号最小的。
- 桌面没有打开时，工具返回「No desktop is running; open the desktop first.」。先在应用里打开环境的桌面，再调用。
- 只用到 Python 标准库和环境里自带的 X11 库（`libX11`、`libXtst`，有 `libXrandr` 时分辨多块显示器），不需要安装依赖。
