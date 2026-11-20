# blender

让 Claude 操作正在运行的 Blender：读取场景和物体信息、截取视口、在 Blender 里运行 Python 来创建和修改物体、材质与灯光，并可选地从 Poly Haven、Sketchfab 获取素材或用 Hyper3D Rodin 生成模型。

## 来源

基于 [ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp) 1.3.1，MIT 许可，版权归 Siddharth Ahuja，许可全文见 [LICENSE](LICENSE)。`addon.py` 是上游同一版本的 Blender 插件原文件，未作修改。`server.py` 是本插件的启动文件：它关闭上游默认开启的匿名使用统计（`DISABLE_TELEMETRY`），再启动上游服务。

## 使用前

1. 安装 [Blender](https://www.blender.org/download/) 3.0 或更新版本，以及 [uv](https://docs.astral.sh/uv/getting-started/installation/)（能在终端里运行 `uv`）。
2. 在 Blender 里打开「编辑 → 偏好设置 → 插件 → 从磁盘安装」，选择本插件目录里的 `addon.py` 并启用。插件目录可在 Cage 插件页的「位置」里复制。
3. 在 3D 视图侧栏的 BlenderMCP 面板里点「Connect to Claude」。Blender 会在本机 127.0.0.1:9876 上等待连接。

## 依赖与网络

- 启动时由 `uv` 从 PyPI 获取固定版本 `blender-mcp==1.3.1`，依赖按 2025-10-21（该版本发布次日）之前发布的版本解析。这个日期不能放宽：之后发布的 MCP Python SDK 2.x 与上游代码不兼容。
- Poly Haven、Sketchfab、Hyper3D 默认关闭，在 Blender 面板里勾选后才会联网；Sketchfab 和 Hyper3D 需要你自己的密钥。
- `execute_blender_code` 在 Blender 里运行任意 Python，能读写文件和运行程序，所以本插件声明了 `commands` 和 `files` 权限。macOS、Windows、Linux 上工具相同。
