# Markdown 渲染 (`markdown-viewer`)

零依赖、纯离线的 Markdown 知识库与协作工作台：支持单项目或跨工作区浏览、编辑、全文检索、双链知识图谱、任务看板与泳道排期，以及短文实时预览。

## 核心能力

- **跨工作区与项目文件树**：支持树形目录/平铺切换、可拖拽四栏布局、`⌘P` 快速打开，并可在已挂载的同级工作区间一键切换「当前项目 / 全部工作区」。
- **阅读、分栏与编辑**：
  - 支持「阅读 / 分栏 / 编辑」三模式、分栏双向悬浮高亮与自动平滑翻页、Markdown 快捷工具栏、标题级折叠、文档大纲与打印/导出 PDF。
  - **浅色 / 深色 / 跟随系统** 三态主题切换，本地草稿隔离恢复与 `ETag` 乐观锁防覆盖冲突保护。
- **Obsidian 知识库与离线图谱**：
  - 支持 YAML Frontmatter、`[[双向链接]]` 跳转与重名消歧、反向链接、Callout 折叠标注、标签组合筛选、离线 Mermaid 图示、离线 LaTeX 数学公式与项目内图片预览。
  - **双链知识图谱**：支持力导向 / 环形簇 / 层级树三种离线平滑滑移布局、实时惯性漂浮物理引擎、标签聚类节点、1–3 跳局部图谱、最短路径追踪、可交互图例与离线 SVG 导出。
- **高性能全文检索（`⌘⇧F`）**：
  - 复用内存增量索引，支持 `Aa` 大小写、`\b` 全词、`.*` 正则、空格多词 AND、`"精确短语"`、`-排除词`、`path:` / `tag:` / `heading:` 语法、命中居中截取、上下行上下文、按文件分组折叠与搜索历史。
- **项目待办汇总与任务看板（Kanban + Swimlanes）**：
  - 解析并可视化编辑任务状态（`status:todo|doing|review|done`）、优先级（`P1/P2/P3`）、截止时间（`📅 YYYY-MM-DD`）、分配人（`@用户`）、分组（`group:...`）与颜色（`color:...`）。
  - 全屏**任务看板工作台**：支持按状态 / 优先级 / 分配人 / 分组 / 颜色 5 种分列、5 种水平泳道、拖拽卡片跨列/跨泳道原子写回 `.md`、顶部统计仪表盘筛选、快速新建待办与一键复制 Markdown 待办周报。
- **安全与隐私**：纯 DOM 渲染（零 `innerHTML`、零 `eval`、零外网请求），严格路径沙箱与 UTF-8 安全边界保护。

## MCP 工具

- `list_markdown_files`：扫描当前项目或全部已挂载工作区的 `.md` / `.markdown` / `.mdx` 文件（返回工作区清单与文件元信息）。
- `read_markdown_file` / `save_markdown_file`：按安全路径读写 UTF-8 Markdown 文件（上限 512 KiB，支持 ETag 乐观锁与冲突检测）。
- `read_markdown_asset`：安全读取文档引用的项目内相对图片资源（上限 4 MiB，离线 Base64 预览）。
- `search_markdown_files`：基于内存增量索引的全文检索引擎（支持多词、引号短语、排除词、行内操作词、正则、上下文与相关性分组）。
- `get_backlinks` / `inspect_project_links` / `get_project_graph`：反向链接定位、断链与重名巡检、知识图谱节点与边构建。
- `list_project_tags` / `list_project_tasks` / `toggle_markdown_task` / `update_markdown_task_meta`：标签聚合、跨文件待办汇总、安全勾选与状态/优先级/时间/分配人/分组/颜色元数据原子回写。

## 运行环境与测试

仅依赖标准 Python 3 与浏览器原生 DOM/SVG，无任何第三方包与外网请求。

```sh
python3 plugins/markdown-viewer/tests/test_server.py -v
node --test plugins/markdown-viewer/tests/test_renderer.mjs
```
