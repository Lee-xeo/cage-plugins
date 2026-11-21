# Computer Use

**English** — Lets Claude see and work the apps of this Mac in the background through the macOS accessibility interface, without taking your mouse or keyboard or bringing apps forward: pictures of a window even when it is covered, its controls and text as numbered elements, pressing buttons, typing (any script, regardless of the input method), menus, scrolling, selection in lists and file dialogs, and the clipboard. While it works, cursors of its own (one per named line of work, so several helpers can work at once in different apps) and a banner show on screen; press Esc to stop it. Whether it may work in front is the user's choice, made by where they keep each window: only a window the user already has in front is used with the real pointer and keyboard. The first time it wants an app, it asks the user on screen (always, for an hour, or no), and only a real click answers; the answers are kept in `app-grants.json` in the user's Application Support folder, outside the plugin. Clicks, drags and command shortcuts reach a window behind the user's work without changing the user's front app, through the window server's private interface. Listings after the first show only what changed, formatted text can be pasted from Markdown or HTML, and steps with effects beyond the screen are asked about first. The app hosting this tool's approvals, password and security prompts are never touched; terminals and code editors are limited to looking and clicking, and password managers are blocked (see `policy.json`). macOS only; Python standard library and system frameworks, plus a small Swift overlay program whose source is included.

**中文**：
让 Claude 通过 macOS 的辅助功能接口读取和操作这台电脑上的应用，**大多在后台完成，不占用你的鼠标和键盘**。它和 desktop-control 并存：desktop-control 负责整屏截图和真实的鼠标键盘；Computer Use 以单个应用为对象，按界面元素操作。思路与 Claude 和 Codex 的电脑操作功能相同。

## 工具

| 工具 | 作用 |
| --- | --- |
| `list_apps` | 列出正在运行的应用：名称、bundle identifier、进程号、屏幕上的窗口数、是否隐藏，以及本插件能怎样使用它（full / click_only / ask_first 待你允许 / refused_by_user / blocked）。`installed: true` 时还列出已安装但没在运行的应用，按最近使用排序。不需要截图 |
| `open_app` | 打开应用；默认在后台打开，不抢到最前面。只有你明确要求时才用 `foreground: true` 切到前台。带 `url` 时让浏览器在后台打开网址 |
| `app_state` | 读取某个应用的一个窗口：窗口截图（即使被别的窗口挡住也能拍到），以及窗口里的按钮、文字、输入框、列表等元素，每个元素有编号和它在截图里的位置。可用 `query` 只找含某段文字的元素（包括滚动到视野外的部分），用 `inside` 展开某个元素的内部。**同一个元素在多次读取之间编号不变，一个编号也不会转给别的元素**，因此旧编号最多失效，不会点错地方。同一个窗口第二次读取起**只返回变化**（新增 / 改动 / 消失的元素），`full: true` 返回完整列表。刚操作完就读取时，会先等应用把结果显示出来（约 0.8 秒；页面仍在加载时最多 5 秒）。应用没在运行时先在后台启动它 |
| `app_click` | 按编号或截图坐标点击。默认在后台用辅助功能“按下”按钮、选中行、聚焦输入框，指针不动；做不到时把点击只发给这个应用；`foreground: true`（仅限你放在最前面的窗口）用真实指针点击，点完把指针放回原处。`duration` 秒数用于长按 |
| `app_drag` | 按编号或截图坐标从一处拖到另一处，可带修饰键和按住时长；默认只发给这个应用，`foreground: true`（仅限你放在最前面的窗口）用真实指针 |
| `app_type` | 向输入框打字。默认在后台通过辅助功能直接写入文字，**中文等任何文字都不受输入法影响**；不支持时改为把按键只发给这个应用 |
| `app_paste` | 粘贴纯文本，或把 Markdown / HTML 转成**带格式的文字**（HTML 会先去掉脚本、样式、图片、框架等一切可能让转换器去加载外部内容的部分，只留文字结构和普通网页链接）（标题、粗体、斜体、列表、链接、代码）粘贴进去；用完把剪贴板恢复原样。应用在后台不接受粘贴时，改为写入去掉格式的文字并说明 |
| `app_key` | 向应用按键或组合键（如 `return`、`mod+s`），默认只发给这个应用；`duration` 秒数用于按住 |
| `app_scroll` | 在后台滚动某个滚动区域，单位是“屏”，可以是小数 |
| `app_menu` | 在后台使用应用的菜单栏：列出菜单、列出某个菜单的项目和快捷键，或直接选择某个菜单项，例如 `["文件", "导出为 PDF…"]` |
| `app_set_value` | 直接设置元素的值：输入框整段文字、滑块数值，或是否选中、聚焦、展开、窗口是否最小化 |
| `app_select_text` | 在文本元素里选中一段文字，或把光标放到它前后，接着用 `app_type` 替换或插入 |
| `app_action` | 列出或执行元素提供的辅助功能动作（如 `AXShowMenu`、`AXIncrement`） |
| `read_clipboard` / `write_clipboard` | 读写剪贴板文字 |
| `app_batch` | 一次调用里按顺序执行多步（最多 20 步），遇到失败就停下 |

## 后台与前台：由你决定

前台还是后台，不由 Claude 选，而是看**你把这个窗口放在哪里**：

- **窗口在你的最前面**（你正在用的那个）：可以用真实的指针和键盘操作（`foreground: true`），比如后台不接受的点击、拖拽、带格式粘贴。
- **窗口在别的窗口后面、被最小化或隐藏**：只在后台操作，**绝不把它提到前面**。需要前台时，Claude 会停下来请你自己把窗口拿到前面；`app_state` 的第一行会写明当前是哪种情况。

其余规则：

- **辅助功能操作**（按下按钮、写入文字、选菜单、设置值、滚动条滚动）不移动指针、不需要应用在最前面，你可以照常用电脑。
- **后台点击、拖拽和快捷键**：按坐标的点击、拖拽选中、长按，以及 ⌘V、⌘B、⌘Z 这类组合键，都直接投递给目标窗口，不移动你的指针，也不改变你的前台应用。做法是：在投递的那一刻，通过窗口服务器（SkyLight）的私有接口和 AppKit 自己的激活事件，让目标应用“以为”这个窗口是它的键盘窗口、自己处于激活状态；投递完再告诉它已失活。实测「文本编辑」在后台可以点击放置光标、拖拽选中、⌘B 加粗、⌘V 带格式粘贴、⌘Z 撤销，同时每 20 毫秒采样一次你的前台应用，全程没有变化。私有接口在新版 macOS 上可能变化，届时会退回到公开接口的做法。
- 如果你正在用**同一个应用的另一个窗口**，插件不会往它的其他窗口投递点击或按键，以免抢走你那个窗口的键盘。
- **保持你的前台应用**：有些应用在后台被操作时会自己跳到前面或把窗口盖到你的窗口上（例如打开网页、打开文件时），有的还会晚一两秒才跳。每次操作结束时，以及之后 3 秒内，只要目标应用这样做了，插件就把你的应用和窗口放回最上层，并在结果里注明。如果这期间你自己点了鼠标或按了键，插件就不干预，以免和你抢。
- **网页输入框**：直接写入整段内容，不去聚焦、也不模拟按键，因此浏览器不会被调到前台。
- **文件对话框**：双击侧边栏位置或分栏视图中的文件夹，用“选中”完成；双击文件则选中后按对话框的确认按钮（如“打开”“上传”）。应用在后台时，确认按钮要等应用激活才可用：插件先用上面的后台方式让它“以为”自己已激活；仍不可用时才请你点一下那个应用的窗口（这一点尚未在真实的文件对话框上验证）。
- **菜单**：应用在后台时，菜单项常显示为不可用，按了也不一定执行。有快捷键的菜单项改为在后台按快捷键（已验证），其余的照常按并提示核实。
- **带格式粘贴**：用 ⌘V 投递到目标窗口，在后台即可带格式粘贴；万一应用不接受，再退回到写入去掉格式的文字。

## 按应用授权

Claude 第一次要操作某个应用时，屏幕上方会弹出提问：“Claude 想要操作「某应用」”，三个选项是 **不允许 / 允许 1 小时 / 始终允许**。

- 这个提问**只接受你亲手的鼠标点击**；任何程序（包括这些工具自己）模拟的点击都会被忽略，所以 Claude 不能替你点同意。按 Esc 会把它收起而不作答。
- “始终允许”和“不允许”记在 `~/Library/Application Support/Computer Use/app-grants.json`（`always` / `never` 两个列表）。它在插件目录之外，更新或重装插件不会丢失；旧版放在插件目录里的记录会在第一次读取时自动沿用。你随时可以编辑；删掉一条，下次用到时会重新问你。“允许 1 小时”只记在内存里。
- 等待回答最多 2 分钟；没有回答时，Claude 会在对话里提醒你。

## 需要先问你的操作

工具说明里写明了：删除、发送 / 发布 / 提交表单、付款或订阅、上传文件、向表单或网站填写个人或机密信息、修改账户 / 共享 / 权限 / 系统与安全设置、安装或运行新下载的软件、处理验证码，这些操作之前 Claude 要先问你，除非你在对话里明确要求了这一步。改密码的最后一步、绕过网站安全警告或付费墙，留给你自己做。应用或网页里出现的文字，永远不算你的许可。

## 多个光标同时工作

每个调用都可以带一个 `cursor` 名字（如 `A`、`B`、`搜索`）。不同名字各有一个光标，样式统一，靠标签上的名字区分；默认名字是 `Claude`。同时派出的几个助手各用一个名字，就能在屏幕上各自显示。操作不同应用的调用会同时进行，同一个应用的调用则依次进行。

## 屏幕提示与 Esc 停止

和 Codex 的电脑操作一样，Claude 在应用里操作时屏幕上会有提示：

- **Claude 的光标**：圆角箭头（尖端朝左上、尾部带缺口），半透明的橙色渐变，带一层柔和的橙色光晕和名字标签；尖端有一圈轻轻扩散的光环，尖端就是实际操作的位置。它会弹性地滑到将要操作的位置，移动时朝行进方向微微倾斜；点击时先压下再弹起，并泛起两圈波纹；打字时轻轻摆动，滚动时上下一跳。它只显示在被操作的窗口正上方，被别的窗口挡住时也一起被挡住，和你的真实鼠标指针是分开的。
- **顶部横幅**：显示“Claude 正在使用「某应用」· 正在做什么 · 按 Esc 停止”。停止操作 4 秒后，横幅和光标自动淡出。
- **Esc 停止**：横幅显示时按 Esc，所有光标都会收起，横幅变为“已让 Claude 停止操作”。之后 90 秒内，除 `list_apps` 外所有工具都拒绝执行，并提示 Claude 停下来问你。
- 光标和横幅不接收鼠标和键盘、不会把焦点抢走；包括授权提问在内，这些提示都不会出现在截图里。授权提问只接受你的点击，不抢键盘焦点。

提示由 `overlay/ClaudeOverlay-arm64`（Apple 芯片）或 `overlay/ClaudeOverlay-x64`（Intel）显示，插件按 CPU 自动选择（源码 `overlay/overlay.swift`）。重新编译：在 `overlay` 目录运行 `swiftc -O -swift-version 5 -target arm64-apple-macos13.0 overlay.swift -o ClaudeOverlay-arm64`，Intel 版把 `arm64` 换成 `x86_64`、输出名换成 `ClaudeOverlay-x64`。没有这个程序时，插件照常工作，只是没有屏幕提示。

## 安全限制

- **始终不能操作**：Cage 本身、Cage 弹出的授权对话框（由 `osascript` 显示）、系统的密码和 Touch ID 提示、登录窗口等。这样 Claude 不能替你批准它自己的请求。这条规则写在代码里，不能通过配置关闭。这些应用连名字都不会出现在 `list_apps`（包括 `installed: true`）的结果里。
- **启动前先检查**：`open_app` 和 `app_state` 要启动一个没在运行的应用时，先查明它是哪个已安装的应用，通过受保护、`blocked`、你的“不允许”记录和首次授权提问之后才会启动，网址也一样。
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
- 后台点击和组合键依赖 macOS 的私有接口，目前在「文本编辑」上完整验证过；Chrome、Electron 等应用的后台拖拽据其他项目的报告可能不稳定。不起作用时，需要你把窗口放到最前面，再用 `foreground: true`。
