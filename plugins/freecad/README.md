# freecad

让 Claude 操作正在运行的 FreeCAD：新建和查看文档，创建和修改零件及其属性，在 FreeCAD 里运行 Python，把较重的建模脚本放到单独的无界面 FreeCAD 进程里运行，截取 3D 视图，以及对已有的分析运行 CalculiX 有限元求解。

## 来源

基于 [neka-nat/freecad-mcp](https://github.com/neka-nat/freecad-mcp) 0.1.32，MIT 许可，版权归 Shirokuma (k tanaka)，许可全文见 [LICENSE](LICENSE)。`FreeCADMCP/` 是上游同一版本的 FreeCAD 插件（上游的 `addon/FreeCADMCP`）原文件，未作修改。`server.py` 是本插件的启动文件：Windows 和 macOS 的 FreeCAD 安装程序不会把 `freecadcmd` 加进 `PATH`，它在 `PATH` 里找不到时，到默认安装位置（Windows 的 `Program Files\FreeCAD *\bin`，macOS 的 `/Applications/FreeCAD*.app`）找版本最新的一个，交给上游的 `--freecadcmd`，再启动上游服务。上游没有使用统计。

## 使用前

1. 安装 [FreeCAD](https://www.freecad.org/downloads.php)（在 1.1.4 上测试过）和 [uv](https://docs.astral.sh/uv/getting-started/installation/)（能在终端里运行 `uv`）。
2. 把本插件目录里的 `FreeCADMCP` 文件夹整个复制到 FreeCAD 的用户插件目录 `Mod` 下，结果应是 `Mod/FreeCADMCP/InitGui.py`，不要多套一层文件夹。插件目录可在 Cage 插件页的「位置」里复制。用户插件目录因版本和安装方式而异，例如 Windows 上 FreeCAD 1.1 是 `%APPDATA%\FreeCAD\v1-1\Mod\`，macOS 上是 `~/Library/Application Support/FreeCAD/v1-1/Mod/`。不确定时，在 FreeCAD 的「视图 → 面板 → Python 控制台」里运行 `import os; print(os.path.join(FreeCAD.getUserAppDataDir(), "Mod"))`。
3. 重启 FreeCAD，在工作台列表里选「MCP Addon」，点 FreeCAD MCP 工具栏里的「Start RPC Server」。FreeCAD 会在本机 127.0.0.1:9875 上等待连接。在 FreeCAD MCP 菜单里勾选「Auto-Start Server」后，以后打开 FreeCAD 时自动开始等待。

更新本插件后，重新复制 `FreeCADMCP` 文件夹并重启 FreeCAD。两边版本不一致时，工具回复的开头会提示需要更新哪一边。

## 依赖与网络

- 启动时由 `uv` 从 PyPI 获取固定版本 `freecad-mcp==0.1.32`，依赖按 2026-11-17（该版本发布次日）之前发布的版本解析。上游需要 Python 3.12 或更新，电脑上没有时 `uv` 会自动下载一份。
- 服务只连接本机 127.0.0.1:9875 上的 FreeCAD 插件。FreeCAD 插件默认只接受本机连接，不要打开它的「Remote Connections」，除非你清楚这样做的风险。
- 零件库工具读取的是通过 FreeCAD 插件管理器安装在本机 `Mod/parts_library` 下的零件库，不联网。
- `execute_code` 在 FreeCAD 里运行任意 Python，`execute_code_headless` 启动 `freecadcmd` 运行脚本，二者都能读写文件和运行程序，所以本插件声明了 `commands` 和 `files` 权限；`network` 用于启动时获取上游程序和连接本机的 FreeCAD。
- 无界面脚本使用的 `freecadcmd`：`PATH` 里的优先，其次是上面说的默认安装位置；Linux 上找不到时还会找 Flatpak 版。macOS、Windows、Linux 上工具相同。
