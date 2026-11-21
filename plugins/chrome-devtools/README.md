# chrome-devtools

让 Claude 用环境里的无界面 Chromium 打开网页，并通过 Chrome DevTools 调试：查看控制台消息和网络请求、录制并分析性能（LCP、CLS、INP 等）、运行 Lighthouse 审计（无障碍、SEO、最佳实践）、读取元素匹配的 CSS 规则、抓取内存堆快照、模拟设备与网络条件、设置日志断点，以及点击、填写、按键和截图。

与 [`browser`](../browser) 的区别：`browser`（Playwright）侧重浏览和操作网页；本插件侧重前端调试与性能排查。两者工具名不重复，可以同时启用。

## 来源

基于 [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) 1.13.0，Apache-2.0 许可，版权归 Google LLC，许可全文见 [LICENSE](LICENSE)。本插件不修改上游代码，通过 `launcher.py` 固定版本启动。

## 运行位置与依赖

- 运行在环境内（`"kind": "guest"`），使用环境里已安装的 Chromium（`/usr/bin/chromium`）和 Node.js（20.19 或更高），不接触你电脑上的浏览器、登录状态和 Cookie。macOS、Windows 和 Linux 上用法和能力完全相同。
- 首次启动时，`launcher.py` 立即返回工具清单，并在后台通过 `npx --yes chrome-devtools-mcp@1.13.0` 从 npm 获取固定版本（按 npm 完整性哈希校验）；之后使用环境内的 npm 缓存。不会下载浏览器。
- 以 `--headless --isolated` 启动：每次启动使用全新的临时浏览器资料，关闭后自动清除，不保留登录状态。
- 读写文件的工具（保存截图、性能记录、Lighthouse 报告、堆快照，上传文件）只能访问环境的临时目录。

## 数据流与权限

声明 `network` 权限：打开的网页由 Chromium 直接访问。此外：

- 首次准备包时，经 `npx` 连接 npm 镜像源（默认 `registry.npmjs.org`）。
- 上游默认开启的使用统计已用 `--no-usage-statistics` 和 `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1` 关闭。
- 上游默认会把性能记录里的网址发送到 Google 的 CrUX API 获取真实用户数据，已用 `--no-performance-crux` 关闭。

## 工具

工具名统一加 `devtools_` 前缀，避免与 `desktop-control` 的 `click`、`drag`、`press_key`、`type_text` 等重名：

- 页面：`devtools_list_pages`、`devtools_new_page`、`devtools_select_page`、`devtools_close_page`、`devtools_navigate_page`、`devtools_resize_page`、`devtools_wait_for`、`devtools_emulate`
- 读取：`devtools_take_snapshot`、`devtools_take_screenshot`、`devtools_get_css_styles`、`devtools_evaluate_script`
- 控制台与网络：`devtools_list_console_messages`、`devtools_get_console_message`、`devtools_list_network_requests`、`devtools_get_network_request`、`devtools_set_logpoints`
- 性能与审计：`devtools_performance_start_trace`、`devtools_performance_stop_trace`、`devtools_performance_analyze_insight`、`devtools_lighthouse_audit`、`devtools_take_heapsnapshot`、`devtools_screencast_start`、`devtools_screencast_stop`
- 输入：`devtools_click`、`devtools_hover`、`devtools_drag`、`devtools_fill`、`devtools_fill_form`、`devtools_type_text`、`devtools_press_key`、`devtools_upload_file`、`devtools_handle_dialog`

共 33 个。`tools.json` 由上游 1.13.0 的 `tools/list` 生成，只给名称和说明中引用的工具名加上前缀，其余文字保持原样。
