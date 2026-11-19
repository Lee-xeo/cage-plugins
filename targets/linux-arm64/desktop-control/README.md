# desktop-control

让 Claude 查看这台电脑的屏幕，并使用鼠标和键盘。支持 macOS、Windows 和 Linux。

## 工具

| 工具 | 作用 |
| --- | --- |
| `screenshot` | 拍下主屏幕（Linux 上为整个 X 屏幕）。其余工具的位置都以这张图的像素为准 |
| `click` | 在指定位置单击、双击或三击，可选左、右、中键 |
| `move_pointer` | 移动指针，不点击 |
| `drag` | 按住左键从一处拖到另一处 |
| `scroll` | 在指定位置滚动。macOS 上按行计，Windows 和 Linux 上按滚轮格数计 |
| `type_text` | 向当前有键盘焦点的地方输入文字 |
| `press_key` | 按一个键或组合键，如 `return`、`ctrl+c`、`ctrl+shift+tab`。macOS 上修饰键为 `cmd`、`shift`、`ctrl`、`alt`；Windows 上为 `ctrl`、`shift`、`alt`、`win`；Linux 上为 `ctrl`、`shift`、`alt`、`super`，写 `win` 或 `meta` 时按 `super` 处理。Windows 和 Linux 上写 `cmd` 时按 `ctrl` 处理 |

## 使用前

### macOS

第一次调用时，系统会要求授权。在「系统设置 → 隐私与安全性」里，为运行本插件的应用打开：

- **录屏与系统录音**：截图需要。打开后要重新启动该应用。
- **辅助功能**：鼠标和键盘操作需要。

### Windows

不需要额外授权，也不需要安装任何东西：插件用 Windows 自带的 PowerShell 运行。

- 以管理员身份运行的窗口在最前面时，Windows 不允许普通程序向它发送鼠标和键盘输入，操作会没有效果或报错。
- 屏幕锁定、出现用户账户控制（UAC）提示时，截图和输入都不可用。
- 如果组策略禁止运行 PowerShell 脚本，插件无法启动。

### Linux

需要 X11 图形会话，并能找到 `python3` 和系统的 X11 库 `libX11.so.6`、`libXtst.so.6`。常见桌面发行版都已自带；缺少时安装对应的包，例如 Debian 和 Ubuntu 上的 `libx11-6`、`libxtst6`，Fedora 上的 `libX11`、`libXtst`。不需要额外授权。

- 插件通过环境变量 `DISPLAY` 找到屏幕。没有 `DISPLAY` 时，所有工具都会报错说明原因。
- Wayland 会话里，插件只能经 XWayland 看到和操作 X11 窗口：Wayland 原生窗口、桌面和面板在截图里可能是黑的或缺失，鼠标和键盘输入也到不了它们。需要完整功能时，登录时请选择 X11（Xorg）会话。
- 屏幕锁定时，锁屏程序会截住鼠标和键盘输入。

## 须知

- 截图会把屏幕上当时显示的一切交给模型，包括其他应用的窗口和通知。调用前请留意屏幕上有什么。
- 输入文字的方式：
  - macOS 上，`type_text` 经剪贴板粘贴文字，这样输入法不会改写内容。原先剪贴板里的文字会在之后放回；图片、文件等非文字内容不会保留。
  - Windows 上，`type_text` 逐字发送字符本身，不经过剪贴板，也不受键盘布局和输入法影响。
  - Linux 上，`type_text` 按键输入，不经过剪贴板，也不受键盘布局影响：键盘上没有的字符，会在输入期间暂时放到没有用到的键上，输入结束后恢复原样。这类不同的字符很多时，输入会慢一些。大写锁定在输入期间暂时关闭，之后恢复。中文等输入法处于输入状态时，字母可能先进入输入法，请先切换到英文状态。
- macOS 和 Windows 上只处理主屏幕。Linux 上截图是整个 X 屏幕，接了多台显示器时，它们拼在同一张图里。
- 不需要安装依赖：macOS 上只用到 Python 标准库和系统自带的框架，Windows 上只用到 PowerShell 和系统自带的库，Linux 上只用到 Python 标准库和系统的 X11 库。
