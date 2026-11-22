<!--
感谢向 Cage 插件市场贡献插件！
请按下方模板填写信息；如为非插件改动（文档、脚本、CI 等），可精简不适用项。
详细收录要求见 README.md：https://github.com/Lee-xeo/cage-plugins/blob/main/README.md
-->

## 变更类型 / Change Type

- [ ] 新增插件（New plugin）
- [ ] 更新已有插件（Update existing plugin，已提高 `plugin.json` 版本号）
- [ ] 文档 / 脚本 / 仓库维护（Docs / Scripts / Maintenance）

## 插件概览 / Plugin Overview

| 项目 | 说明 |
| --- | --- |
| 插件名称与版本 | `name` / `version` |
| 运行位置 (`kind`) | `host`（本机） / `guest`（环境内） |
| 适用平台 | macOS / Windows / Linux（如按目标分包，注明 `targets/` 目录） |
| 能力形态 | MCP 工具 (`contributes.mcpServers`) / 扩展页面 (`contributes.views`) |
| 声明权限 (`permissions`) | `[]` 或列出具体权限 |
| 所属分类 (`categories`) | 1~3 个有效分类 |
| 上游开源项目与许可 | 如适用，填写项目名、版本与 SPDX 许可证；自研填“无” |

### 功能说明与设计要点

<!--
简述插件解决的问题、提供的工具或页面，以及：
1. 选择 `host` 或 `guest` 的理由（例如是否依赖本机软件/硬件性能，或可在环境内独立运行）；
2. 前置运行环境依赖与启动方式（`launcher.py` + `pylock.json` / 锁定版本 `npx` / `uvx` 等）；
3. 数据流向（是否联网、访问哪些外部地址、是否读取/写入本机或项目文件）。
-->

## 运行效果图 / Runtime Screenshots or Demo

<!--
【新增插件或涉及界面/交互变更的 PR 必填】
请直接将截图、GIF 或短录屏拖入本 PR 描述框上传：
- 请勿把效果图提交进 `plugins/`、`targets/` 或 `dist/` 目录，避免增大插件压缩包体积。
- 上传前请遮盖账号、令牌、密钥、代理订阅、本机敏感路径等隐私信息。

建议附带以下画面：
1. 插件在 Cage「插件」页面成功加载的状态；
2. MCP 工具：在 Cage 中实际调用工具并产出效果的画面（主机插件建议一并展示授权弹窗或实际执行效果）；
3. 扩展页面（`contributes.views`）：侧栏页面在 Cage 工作台中的真实界面效果（如有浅色/深色主题可一并附上）。

如为纯文档/脚本维护或确无可见运行效果的改动，请在此说明原因。
-->

## 测试与验证 / Testing & Verification

- **实测环境**：<!-- 例：macOS 15.x (arm64) / Windows 11 (x64) / Ubuntu 24.04 (x64)，Cage v0.2.x -->
- **自动检查**：
  - [ ] `python3 scripts/build.py --check` 通过
  - [ ] 插件自带单元测试 / 冒烟测试通过（如有，请补充命令与结果）
- **端到端验证**：<!-- 简述在 Cage 中安装、加载、调用工具或打开页面的实测步骤与结果 -->
- **尚未实测的范围**：<!-- 明确注明未实机测试的系统、架构或场景，便于评审接续核对 -->

## 提交前自查清单 / Checklist

- [ ] 已在 PR 描述中附带插件在 Cage 中的**真实运行效果图**（截图 / GIF / 录屏），并已遮盖敏感信息
- [ ] 效果图仅上传到 PR 描述中，未提交进 `plugins/`、`targets/` 或 `dist/` 目录
- [ ] 已在根目录 `authors.json` 登记插件名与有效的 GitHub 用户名
- [ ] 已在插件目录（含各 `targets/` 目录）提供覆盖全部 15 种 Cage 界面语言的 `i18n.json`，且 `plugin.json` 保持简洁英文
- [ ] `permissions` 如实声明，`categories` 填写 1~3 个有效分类
- [ ] 工具名称、说明、参数说明及 `i18n.json` 仅描述功能，不含产品名及 `VM` / `guest` / `虚拟机` / `客机` 等保留词
- [ ] 运行时不下载未锁定代码（外部依赖已按要求锁定版本与哈希），并已关闭上游默认遥测/统计
- [ ] 基于开源项目的插件已附上游 `LICENSE`、`source.json` 与说明数据流向及依赖的 `README.md`
- [ ] 修改已有插件时已提高 `plugin.json` 版本号（并按需清理不再保留的旧版 `dist/` 归档）
- [ ] 已运行 `python3 scripts/build.py` 更新 `dist/` 与 `index.json` 并随本次 PR 一并提交
- [ ] 同意以本仓库 [MIT 许可](https://github.com/Lee-xeo/cage-plugins/blob/main/LICENSE) 发布本次提交的插件代码
