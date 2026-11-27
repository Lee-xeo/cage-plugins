# Mount Guardian · 映射守护

[English](#english) | 中文

> 共享项目文件夹掉线导致 git 断链时，自动用本地镜像修复，让依赖 git 元数据的上层工具（如工作区目录）始终可用。

---

## 中文

### 它解决什么问题

共享项目文件夹（例如从宿主机映射进来的目录）通常是**按需挂载**的：重启、断连、会话重建之后，映射可能悄悄消失。此时目录看起来还在（只剩一个空的骨架），但里面的 `.git` 已经不可达——所有依赖 git 元数据解析的工具会集体失灵，而且故障表现很隐蔽（列表为空、代理"消失"、状态显示异常），排查费时。

Mount Guardian 在后台盯住这件事：**映射在线时**把每个项目的 `.git` 镜像到本地；**映射掉线且 git 断链时**自动用镜像回填，让上层工具无感恢复。

### 工作原理

```
映射在线 (live)                映射掉线 (offline)
─────────────                 ─────────────
共享文件夹可读                  共享文件夹只剩骨架
   │                              │
   ├─ 自动镜像 .git ──► 本地镜像   ├─ git 断链检测
   │   （每 5 分钟增量）           │      │
   │                              │      ▼
   │                              │   从本地镜像回填 .git
   │                              │   （仅在映射离线时执行）
   ▼                              ▼
状态: ok                        状态: degraded（镜像兜底）/ broken（无镜像可救）
```

- **自动发现**：扫描活跃的共享挂载（sshfs/9p/virtiofs），凡挂载点（或其下一层子目录）含有 `.git` 的，自动纳入看护列表；见过的项目会记入状态文件，掉线后也记得它。
- **镜像**：用 rsync 增量同步 `<项目>/.git` → `~/.local/share/mount-guardian/mirrors/<项目名>.git`，并记录同步时间与 HEAD。
- **自愈**：仅在"映射离线 + git 不可解析 + 本地有镜像"三个条件同时满足时回填；**映射在线时绝不写入**（硬保护，防止写穿透到真实源）。
- **状态机**：`ok`（映射在线且 git 正常）→ `degraded`（映射离线但 git 可解析，镜像兜底中）→ `broken`（git 断链且无镜像/未修复）。

### 安装

**方式一：插件市场（推荐）** — 侧栏「插件」→「插件市场」→ 搜索 Mount Guardian → 安装。

**方式二：手动安装** — 把 `plugin/` 目录复制为配置目录下的 `plugins/mount-guardian/`，然后在插件页点「重新加载」：

```bash
make install   # 等价于 rsync plugin/ → ~/.claude-cage/plugins/mount-guardian/
```

**方式三：从源码构建** — 克隆本仓库后 `make install`，同上。

安装后插件立即运行：后台巡检默认每 5 分钟一轮，无需任何配置。

### 使用：侧栏页面

侧栏点击「映射守护」打开状态页：

| 区域 | 含义 |
| --- | --- |
| 顶部状态灯 | 全部正常（绿）/ 镜像兜底中（黄）/ 存在断链（红） |
| 项目卡片 | 每个被看护项目的挂载、git、镜像状态标签 |
| 目录行 | 工作区目录里当前可见的 worktree 与代理数量、上次检查时间 |
| 刷新 | 立即重新检查全部项目 |
| 同步镜像 | 立即把在线项目的 `.git` 同步进本地镜像 |
| 立即修复 | 对"离线且断链"的项目执行回填（会先弹确认） |

### 使用：MCP 工具（给人和 Agent）

三个工具都可由人或 Agent 调用，返回 JSON 文本：

**`mount_health`** — 体检。建议在任何"依赖共享项目文件夹的工作"开始之前先调用一次。
无参数。返回示例（节选）：

```json
{
  "overall": "degraded",
  "projects": [
    {"name": "demo-app", "live_mount": false, "git_ok": true,
     "state": "degraded", "mirror": {"synced_at": "...", "head": "3db1392..."}}
  ],
  "catalog": {"ok": true, "worktrees": 2, "agents": 1}
}
```

判读：`overall=ok` 放心用；`degraded` 能用但文件可能是镜像快照（内容或落后），重要操作前先在宿主机侧确认映射恢复；`broken` 不要用，先修复。

**`mount_mirror_sync`** — 立即同步镜像。参数 `{"project": "可选，项目名"}`，省略则同步全部在线项目。只在映射在线时生效，离线项目会返回跳过原因。

**`mount_heal`** — 立即修复。参数同上。只对"离线且断链"的项目动手；对在线项目调用会原样拒绝（`"mapping is live; nothing to heal"`）。返回里的 `healed: true` 表示修复成功。

### 配置

无需配置即可使用。可选设置（插件详情页 → 设置）：

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| Auto mirror | 开 | 映射在线时自动镜像 git 元数据 |
| Auto heal | 开 | 掉线断链时自动从镜像回填 |
| Check interval (seconds) | 300 | 后台巡检间隔 |
| Extra projects (JSON) | — | 额外看护的 `{"name","path"}` 列表（用于非共享挂载的目录） |

进阶：在 `server.py` 旁放一个 `config.json`（见 `config.example.json`）可**关闭自动发现、改用显式项目列表**，并覆盖镜像目录等路径——适合本地定制，市场版不包含此文件。

### 文件位置

| 位置 | 内容 |
| --- | --- |
| `~/.local/share/mount-guardian/mirrors/` | 各项目的 `.git` 镜像与同步元信息 |
| `~/.local/share/mount-guardian/status.json` | 最近一次体检结果 + 已记住的项目列表 |
| 插件目录 | 插件本体（`plugins/mount-guardian/`） |

### 安全模型

- **零网络**：不声明网络权限，不发出任何网络请求。
- **写保护**：自愈只在映射离线时执行；在线时调用 `mount_heal` 会被拒绝。
- **权限最小**：仅读 `/proc/self/mounts`、运行 `git`/`rsync`、在骨架目录属 root 时用 `sudo -n` 回填（失败则报错，不交互）。
- **不动真实源**：镜像方向永远是 共享文件夹 → 本地，绝不反向。

### 故障排查

| 现象 | 含义 | 怎么办 |
| --- | --- | --- |
| 卡片显示"映射离线"但 git 正常 | 镜像兜底中（degraded） | 可继续只读使用；要最新文件请恢复映射后点"同步镜像" |
| 卡片显示"git 断链" | 断链且无镜像（broken） | 先恢复映射（打开对应项目），再点"同步镜像"建立镜像 |
| "无镜像"标签 | 该项目还没被镜像过 | 映射在线时点"同步镜像" |
| 目录行显示不可用 | 工作区目录工具未就绪 | 不影响映射看护本身；稍后会自动重试 |
| 修复按钮报错权限不足 | 骨架目录属 root 且 sudo 需要密码 | 在环境中为当前用户配置免密 sudo，或手工 `sudo chown` |

### 给 Agent 的指引

如果你是在本环境中工作的 Agent：

1. 准备读写共享项目文件夹、或发现工作区列表异常为空时，先调用 `mount_health`。
2. `overall=broken` 时调用 `mount_heal`，确认返回 `healed: true` 后再继续。
3. `degraded` 状态下可以向用户说明"文件可能是镜像快照"，只读操作可继续。
4. 不要尝试自己挂载共享文件夹——那是宿主侧的手动操作；你的职责是检测、用镜像兜底、并提醒用户恢复映射。

---

## English

### What it solves

Shared project folders are often mounted on demand and can silently vanish
after a restart or reconnect. The directory skeleton stays visible, but its
`.git` metadata becomes unreachable, and every tool that resolves git
metadata starts failing in confusing ways.

Mount Guardian watches for this: while a mapping is **live** it mirrors each
project's `.git` locally; when a mapping **drops** and git stops resolving,
it restores `.git` from the mirror so dependent tools recover on their own.

### How it works

- **Discovery**: live shared mounts (sshfs/9p/virtiofs) that contain a git
  repository — at the mountpoint or one level below — are watched
  automatically, and remembered across runs.
- **Mirror**: incremental rsync of `<project>/.git` into
  `~/.local/share/mount-guardian/mirrors/`, with sync time and HEAD recorded.
- **Heal**: restores `.git` from the mirror only when the mapping is offline,
  git is broken, and a mirror exists. **It never writes through a live
  mapping.**
- **States**: `ok` → `degraded` (offline but git resolves via mirror) →
  `broken` (git broken, no mirror).

### Install

- **Market**: Plugins → Plugin Market → search "Mount Guardian" → Install.
- **Manual**: copy `plugin/` to `plugins/mount-guardian/` in the config
  directory, then reload plugins. From this repo: `make install`.

No configuration is needed; the background check runs every 5 minutes.

### Tools (for humans and agents)

| Tool | When to call | Notes |
| --- | --- | --- |
| `mount_health` | Before work that depends on a shared folder, or when listings look empty | Returns per-project state plus catalog counts |
| `mount_mirror_sync` | After the mapping is back, to refresh mirrors | Optional `{"project": name}`; live projects only |
| `mount_heal` | When `overall` is `broken` | Refuses to touch live mappings |

Interpretation: `ok` = all good; `degraded` = usable but files may be a
mirror snapshot; `broken` = heal first.

### Configuration

All optional (plugin details → Settings): auto mirror (on), auto heal (on),
check interval seconds (300), extra projects JSON. A `config.json` beside
`server.py` (see `config.example.json`) replaces discovery with an explicit
list for local installs.

### Safety

- No network access, no third-party dependencies (Python standard library).
- Heal never writes while a mapping is live; mirror direction is always
  shared-folder → local, never the reverse.
- Uses `sudo -n` only when the skeleton directory is root-owned; fails
  loudly instead of prompting.

### For agents

1. Call `mount_health` before working in a shared project folder, or when a
   workspace listing unexpectedly comes back empty.
2. If `overall` is `broken`, call `mount_heal` and proceed only after
   `healed: true`.
3. In `degraded` state, read-only work may continue; tell the user files may
   be a mirror snapshot.
4. Never try to mount shared folders yourself — that is a manual, host-side
   action. Your job is to detect, bridge with the mirror, and ask the user
   to restore the mapping.

### Develop

```
make test      # end-to-end checks in a throwaway directory
make install   # copy plugin/ into the local app config directory
```

## License

MIT
