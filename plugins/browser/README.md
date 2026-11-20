# browser

让 Claude 用无界面的 Chromium 打开网页，读取页面结构（无障碍快照），点击、输入、填写表单、上传文件、截图和查看控制台与网络请求。

## 来源

基于 [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) 0.0.86，Apache-2.0 许可，版权归 Microsoft Corporation，许可全文见 [LICENSE](LICENSE)。本插件不修改上游代码，只给出启动参数。

## 运行位置与依赖

- 运行在环境内（`"kind": "guest"`），使用环境里已安装的 Chromium（`/usr/bin/chromium`）和 Node.js，不接触你电脑上的浏览器、登录状态和 Cookie。所以 macOS、Windows 和 Linux 上用法和能力完全相同。
- 启动时由 `npx` 从 npm 获取固定版本 `@playwright/mcp@0.0.86`（npm 按包内记录的完整性哈希校验，同一版本的文件发布后不会改变）。第一次启动需要联网，之后使用 npm 缓存。不会下载浏览器。
- 以 `--isolated` 启动：每次启动使用全新的浏览器资料，不保留登录状态。截图和快照文件写在插件目录的 `output/` 下。

## 工具

导航（`browser_navigate`、`browser_navigate_back`、`browser_tabs`）、读取（`browser_snapshot`、`browser_take_screenshot`、`browser_console_messages`、`browser_network_requests`）、操作（`browser_click`、`browser_type`、`browser_fill_form`、`browser_select_option`、`browser_hover`、`browser_drag`、`browser_press_key`、`browser_file_upload`、`browser_handle_dialog`）以及 `browser_evaluate`、`browser_run_code_unsafe`（在页面里运行脚本）等，共 25 个，以插件运行后列出的为准。
