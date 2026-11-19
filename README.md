# Cage 插件市场

这里收录 [Cage](https://github.com/Lee-xeo/Claude-Cage) 的插件。插件让环境里的 Claude 在你的电脑上多一项能力，例如运行命令、读取屏幕或操作某个应用。每个插件是一个标准的 MCP 服务，通过标准输入输出通信。

## 安装插件

在 Cage 侧栏打开「插件」→「插件市场」，按分类浏览并安装。Cage 从本仓库读取 `index.json`，下载对应的压缩包，核对 SHA-256 后放进插件目录。

运行在你电脑上的插件以你的系统账户权限运行，不受环境的隔离保护。调用前会弹出确认窗口，显示插件、工具和参数，你可以只允许这一次，也可以选择对该插件始终允许。安装前请阅读插件声明的权限，只安装你信任的插件。

## 提交插件

1. 在 `plugins/` 下新建一个以插件名命名的目录，放入清单 `plugin.json` 和程序文件。
2. 运行 `python3 scripts/build.py`。它检查清单，把插件打包到 `dist/`，并更新 `index.json`。
3. 把 `plugins/`、`dist/`、`index.json` 的改动一起提交，发起 Pull Request。

修改已发布的插件时，必须同时提高 `plugin.json` 里的版本号。已发布版本的压缩包不会被改写；旧版本的压缩包可以从 `dist/` 删除。

### 清单 `plugin.json`

插件有两种用途，可以兼有：给 Claude 提供工具（MCP 服务），或者给 Cage 加一个自己的页面。可以运行在你的电脑上（`"kind": "host"`），也可以运行在环境内（`"kind": "guest"`）。

```json
{
  "name": "system-status",
  "displayName": "System Status",
  "version": "0.1.0",
  "description": "Shows processor load, memory and disk use.",
  "icon": "icon.svg",
  "engines": { "cage": ">=0.1.8" },
  "kind": "guest",
  "permissions": [],
  "categories": ["system"],
  "contributes": {
    "mcpServers": [{ "id": "status", "command": ["python3", "server.py"] }],
    "views": [{ "id": "status", "title": "System Status", "entry": "view/index.html", "server": "status" }]
  }
}
```

清单各字段、页面的限制和页面与 Cage 之间的消息协议，见 Cage 仓库的[插件文档](https://github.com/Lee-xeo/Claude-Cage/blob/main/docs/plugins.md)。只有一个 MCP 服务的主机插件也可以用旧格式，像 [`plugins/clock`](plugins/clock) 那样只写 `command`。

`permissions` 必须如实写明，没有就写空列表。可选值：`files`（读写文件）、`commands`（运行命令）、`screen`（查看屏幕）、`input`（控制键盘和鼠标）、`network`（访问网络）。

`categories` 是插件在市场里的分类，上架时必须写 1 到 3 个：`desktop`（桌面控制）、`developer`（开发）、`system`（系统与状态）、`network`（网络）、`files`（文件）、`productivity`（效率）、`example`（示例）。

带有按系统编译的程序的插件，放在 `targets/<目标>/<插件名>/` 下，每个目标一份，目标为 `darwin-arm64`、`darwin-x64`、`linux-arm64`、`linux-x64`、`win32-arm64` 或 `win32-x64`。不分系统的插件放在 `plugins/` 下。

### 收录要求

- 权限如实声明。插件做了清单没有声明的事，会被移除。
- 工具的名称、说明和参数说明只描述工具做什么，不提及模型运行在哪里，也不出现本产品的名字或 VM、guest 之类的词。打包脚本只检查清单；工具的文字由应用在加载时检查，不合格的插件无法加载。
- 以 MIT 许可提交。本仓库采用 [MIT 许可](LICENSE)，提交插件即表示同意以该许可发布；插件带有第三方代码时，在插件目录里附上其许可。
- 源码可读。不收录只有二进制文件或混淆代码的插件。
- 插件目录里只有普通文件和文件夹，不含链接；打包后不超过 20 MB。
- 运行时不自行下载并执行代码。需要的依赖在说明里写明，由用户自己安装。

示例都不需要安装依赖，只用到 Python 标准库或 Windows 自带的 PowerShell：

- [`plugins/clock`](plugins/clock)：最小的主机插件，一个工具。
- [`plugins/desktop-control`](plugins/desktop-control)：主机插件，查看屏幕并使用键鼠。macOS 版在 `plugins/` 下，Windows 版按目标放在 `targets/win32-x64/` 和 `targets/win32-arm64/` 下。
- [`plugins/system-status`](plugins/system-status)：环境内插件，一个页面加一个工具。

## 索引格式

`index.json` 由脚本生成，不要手工修改。

```json
{
  "version": 1,
  "plugins": [
    {
      "name": "clock",
      "version": "0.1.1",
      "description": "Tells the current time on this computer.",
      "permissions": [],
      "icon": "https://raw.githubusercontent.com/Lee-xeo/cage-plugins/main/plugins/clock/icon.svg",
      "archive": "https://raw.githubusercontent.com/Lee-xeo/cage-plugins/main/dist/clock-0.1.1.tar.gz",
      "sha256": "…",
      "bytes": 887
    }
  ]
}
```
