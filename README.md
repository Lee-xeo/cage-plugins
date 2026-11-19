# Cage 插件市场

这里收录 [Cage](https://github.com/Lee-xeo/Claude-Cage) 的插件。插件让环境里的 Claude 在你的电脑上多一项能力，例如运行命令、读取屏幕或操作某个应用。每个插件是一个标准的 MCP 服务，通过标准输入输出通信。

## 安装插件

在 Cage 侧栏打开「MCP 插件」→「插件市场」，选择插件并安装。Cage 从本仓库读取 `index.json`，下载对应的压缩包，核对 SHA-256 后放进插件目录。

插件以你的系统账户权限在电脑上运行，不受环境的隔离保护。每次调用前系统会弹出确认窗口，显示插件、工具和参数。安装前请阅读插件声明的权限，只安装你信任的插件。

## 提交插件

1. 在 `plugins/` 下新建一个以插件名命名的目录，放入清单 `plugin.json` 和程序文件。
2. 运行 `python3 scripts/build.py`。它检查清单，把插件打包到 `dist/`，并更新 `index.json`。
3. 把 `plugins/`、`dist/`、`index.json` 的改动一起提交，发起 Pull Request。

修改已发布的插件时，必须同时提高 `plugin.json` 里的版本号。已发布版本的压缩包不会被改写；旧版本的压缩包可以从 `dist/` 删除。

### 清单 `plugin.json`

```json
{
  "name": "clock",
  "version": "0.1.0",
  "description": "Tells the current time on this computer.",
  "platforms": ["darwin", "linux", "windows"],
  "permissions": [],
  "command": ["python3", "server.py"],
  "icon": "icon.svg"
}
```

| 字段 | 说明 |
| --- | --- |
| `name` | 小写字母、数字和连字符，必须与目录名相同 |
| `version` | 版本号，如 `1.2.3` |
| `description` | 一句话说明 |
| `platforms` | 支持的系统：`darwin`、`linux`、`windows`。省略表示都支持 |
| `permissions` | 插件在电脑上会做的事，必须写明，没有就写空列表。可选值：`files`（读写文件）、`commands`（运行命令）、`screen`（查看屏幕）、`input`（控制键盘和鼠标）、`network`（访问网络） |
| `command` | 程序和参数。相对路径从插件目录算起 |
| `icon` | 插件目录内的一张 PNG 或 SVG 图片，显示在插件名称旁，不超过 256 KB。可省略 |

清单里不能有其他字段。

### 收录要求

- 权限如实声明。插件做了清单没有声明的事，会被移除。
- 工具的名称和说明只描述工具做什么，不提及模型运行在哪里，也不出现本产品的名字。
- 源码可读。不收录只有二进制文件或混淆代码的插件。
- 插件目录里只有普通文件和文件夹，不含链接；打包后不超过 20 MB。
- 运行时不自行下载并执行代码。需要的依赖在说明里写明，由用户自己安装。

[`plugins/clock`](plugins/clock) 是一个完整的示例，只用到 Python 标准库。

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
