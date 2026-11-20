# excel-workbooks

让 Claude 创建、读取和编辑工作区里的 Excel 工作簿（`.xlsx`）：读写单元格与公式、格式、条件格式、数据验证、图表、数据透视表、工作表的增删改，以及 CSV 导入导出。不需要安装 Microsoft Excel。

## 来源

基于 [haris-musa/excel-mcp-server](https://github.com/haris-musa/excel-mcp-server) 2.3.2，MIT 许可，版权归 Haris Musa，许可全文见 [LICENSE](LICENSE)。本插件不修改上游代码，通过 `launcher.py` 按 `pylock.json` 校验并启动。

## 运行位置与依赖

- 运行在环境内（`"kind": "guest"`），直接使用环境自带的 Python 3，不需要在电脑上安装 `uv` 或额外运行环境。macOS、Windows 和 Linux 上用法和工具完全一致。
- 首次启动时，`launcher.py` 按 `pylock.json` 中记录的精确文件名、字节大小与 SHA-256 摘要，从 `files.pythonhosted.org` 下载锁定版本的预编译包并解包到环境内的 `~/.cache/mcp-plugins/excel-workbooks/`；之后启动直接复用缓存，不再联网。

## 数据流与权限

- 工具调用本身不访问网络，默认通过 `--allow-dir ${PROJECT_DIR}` 仅限定读写当前打开的项目目录内的工作簿文件（较早版本应用自动回退到普通模式）。
- 仅首次准备依赖时连接 `files.pythonhosted.org`；上游不包含遥测。
