# Computer Use

**English** — Lets Claude see and work the apps of this Mac in the background through the macOS accessibility interface, without taking your mouse or keyboard or bringing apps forward: pictures of a window even when it is covered, its controls and text as numbered elements, pressing buttons, typing (any script, regardless of the input method), menus, scrolling, selection in lists and file dialogs, and the clipboard. While it works, a cursor of its own and a banner show on screen; press Esc to stop it. The app hosting this tool's approvals, password and security prompts are never touched; terminals and code editors are limited to looking and clicking, and password managers are blocked (see `policy.json`). macOS only; Python standard library and system frameworks, plus a small Swift overlay program whose source is included.

**中文**：
让 Claude 通过 macOS 的辅助功能接口读取和操作这台电脑上的应用，**大多在后台完成，不占用你的鼠标和键盘**。它和 desktop-control 并存：desktop-control 负责整屏截图和真实的鼠标键盘；Computer Use 以单个应用为对象，按界面元素操作。思路与 Claude 和 Codex 的电脑操作功能相同。

## 工具

| 工具 | 作用 |
| --- | --- |
| `list_apps` | 列出正在运行的应用：名称、bundle identifier、进程号、屏幕上的窗口数、是否隐藏，以及本插件能怎样使用它（full / click_only / blocked）。不需要截图 |
| `open_app` | 打开应用；默认在后台打开，不抢到最前面（`foreground: true` 才会切到前台）。带 `url` 时让浏览器在后台打开网址 |
| `app_state` | 读取某个应用的一个窗口：窗口截图（即使被别的窗口挡住也能拍到），以及窗口里的按钮、文字、输入框、列表等元素，每个元素有编号和它在截图里的位置。可用 `query` 只找含某段文字的元素（包括滚动到视野外的部分），用 `inside` 展开某个元素的内部。**同一个元素在多次读取之间编号不变，一个编号也不会转给别的元素**，因此旧编号最多失效，不会点错地方 |
| `app_click` | 按编号或截图坐标点击。默认在后台用辅助功能“按下”按钮、选中行、聚焦输入框，指针不动；做不到时把点击只发给这个应用；`foreground: true` 时把应用切到前台、用真实指针点击，点完把指针放回原处 |
| `app_type` | 向输入框打字。默认在后台通过辅助功能直接写入文字，**中文等任何文字都不受输入法影响**；不支持时改为把按键只发给这个应用 |
| `app_key` | 向应用按键或组合键（如 `return`、`mod+s`），默认只发给这个应用 |
| `app_scroll` | 在后台滚动某个滚动区域，单位是“屏”，可以是小数 |
| `app_menu` | 在后台使用应用的菜单栏：列出菜单、列出某个菜单的项目和快捷键，或直接选择某个菜单项，例如 `["文件", "导出为 PDF…"]` |
| `app_set_value` | 直接设置元素的值：输入框整段文字、滑块数值，或是否选中、聚焦、展开、窗口是否最小化 |
| `app_select_text` | 在文本元素里选中一段文字，或把光标放到它前后，接着用 `app_type` 替换或插入 |
| `app_action` | 列出或执行元素提供的辅助功能动作（如 `AXShowMenu`、`AXIncrement`） |
| `read_clipboard` / `write_clipboard` | 读写剪贴板文字 |
| `app_batch` | 一次调用里按顺序执行多步（最多 20 步），遇到失败就停下 |

## 后台与前台

- **辅助功能操作**（按下按钮、写入文字、选菜单、设置值、滚动条滚动）不移动指针、不需要应用在最前面，你可以照常用电脑。
- **只发给应用的点击和按键**也不移动指针，但有些应用在后台会忽略它们；工具会说明，并提示改用 `foreground: true`。
- **`foreground: true`** 会把应用切到前台，短暂使用真实的指针或键盘。点击前会检查该位置最上面的窗口是否属于这个应用，不是就不点；点完把指针放回原处。
- **保持你的前台应用**：有些应用在后台被操作时会自己跳到前面（例如打开文件时）。后台操作结束后，如果目标应用自己到了前台，插件会立即把你原来的前台应用切回来，并在结果里注明。
- **文件对话框**：在“打开/存储”对话框里双击侧边栏位置或分栏视图中的文件夹，用“选中”完成；双击文件则选中后按对话框的默认按钮（如“打开”“上传”）。整个过程不会把应用调到前台。

## 屏幕提示与 Esc 停止

和 Codex 的电脑操作一样，Claude 在应用里操作时屏幕上会有提示：

- **Claude 的光标**：一个带“Claude”标签的橙色箭头，滑到它将要操作的位置，点击时有一圈波纹。它和你的真实鼠标指针是分开的，不影响你用鼠标。
- **顶部横幅**：显示“Claude 正在使用「某应用」· 正在做什么 · 按 Esc 停止”。停止操作 4 秒后，横幅和光标自动淡出。
- **Esc 停止**：横幅显示时按 Esc，横幅变为“已让 Claude 停止操作”。之后 90 秒内，除 `list_apps` 外所有工具都拒绝执行，并提示 Claude 停下来问你。
- 提示窗口不接收鼠标和键盘、不会把焦点抢走，也不会出现在截图里。

提示由 `overlay/ClaudeOverlay` 显示（源码 `overlay/overlay.swift`）。重新编译：在 `overlay` 目录运行 `swiftc -O -swift-version 5 overlay.swift -o ClaudeOverlay`。没有这个程序时，插件照常工作，只是没有屏幕提示。

## 安全限制

- **始终不能操作**：Cage 本身、Cage 弹出的授权对话框（由 `osascript` 显示）、系统的密码和 Touch ID 提示、登录窗口等。这样 Claude 不能替你批准它自己的请求。这条规则写在代码里，不能通过配置关闭。
- **`policy.json`**（改完立即生效）：
  - `click_only`：终端和代码编辑器默认只能查看、左键点击和滚动，不能打字、按键或选菜单。命令和代码改用 shell 和文件工具处理更稳妥。
  - `blocked`：钥匙串访问、“密码”应用和常见密码管理器默认完全屏蔽。
  - `guarded_windows`：“系统设置”显示隐私与安全性、辅助功能、录屏、用户与群组、密码、共享等页面时，只能查看不能操作。
- 和其他插件一样，第一次调用时 Cage 会询问是否允许；选择“始终允许”后不再询问，可以在插件页撤销。
- 截图和元素列表会把窗口里的内容交给模型。密码输入框的内容不会显示。

## 使用前

需要 Cage 已获得的两项权限（与 desktop-control 相同）：系统设置 → 隐私与安全性 → **辅助功能**，以及**录屏与系统录音**（截图需要）。插件由 Cage 启动，因此沿用 Cage 的授权。只用到 Python 标准库和系统自带的框架。

## 安装与卸载

- 安装：把 `computer-use` 文件夹放进 `~/.claude-cage/plugins/`，在 Cage 的插件页点击“重新加载插件”。
- 卸载：删除这个文件夹，再点“重新加载插件”。

## 已知局限

- 应用必须把界面提供给辅助功能接口。大多数原生应用和网页内容都可以；少数自绘界面的应用（部分游戏、画布类应用）只能用截图坐标点击。
- Chrome 等浏览器的网页内容有时要第二次 `app_state` 才完整。
- 最小化、隐藏或在其他桌面空间的窗口拍不到截图，但元素列表通常仍可读取。
- 只发给应用的点击、按键和滚轮在有些应用里不起作用，这时需要 `foreground: true`。
