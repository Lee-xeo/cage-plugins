# knowledge-memory

为 Claude 提供持久化的本地知识图谱记忆：创建和删除实体（`create_entities`、`delete_entities`）、建立和移除关系（`create_relations`、`delete_relations`）、追加和移除观察记录（`add_observations`、`delete_observations`），以及读取、搜索和检索图谱节点（`read_graph`、`search_nodes`、`open_nodes`）。

## 来源

基于官方参考实现 [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) 中的 `@modelcontextprotocol/server-memory` 2.2.1（随上游 [v2.5.0](https://github.com/modelcontextprotocol/servers/releases/tag/v2.5.0) 发布，提交 `c799c85`）。npm 包的许可字段为 `SEE LICENSE IN LICENSE`，指向上游仓库的 [LICENSE](LICENSE)：项目正从 MIT 过渡到 Apache-2.0，新代码采用 Apache-2.0，尚未获准重新授权的旧贡献仍为 MIT，两者分别适用于各自的部分，因此记为 `Apache-2.0 AND MIT`。本插件通过 `package-lock.json` 锁定并随包携带运行所需依赖（`npm ci --omit=dev --ignore-scripts`），未修改上游代码。

## 运行位置与依赖

- 运行在环境内（`"kind": "guest"`），直接使用环境自带的 Node.js 与 Python 3，无需在本机安装额外运行环境；macOS、Windows 和 Linux 上完全一致。
- 依赖已随插件压缩包提供，启动时完全离线，无需从 npm 下载任何包。

## 数据流与权限

- 完全离线运行，不访问任何网络地址；知识图谱保存在环境内的 `~/.local/share/knowledge-memory/memory.jsonl`，独立于插件安装目录，更新或重装插件时保留已有数据。
- 上游不包含遥测。
