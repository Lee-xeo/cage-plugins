# excel-workbooks

让 Claude 创建、读取和编辑这台电脑上的 Excel 工作簿（.xlsx）：读写单元格与公式、格式、条件格式、数据验证、图表、数据透视表、工作表的增删改，以及 CSV 导入导出。不需要安装 Microsoft Excel。

## 来源

基于 [haris-musa/excel-mcp-server](https://github.com/haris-musa/excel-mcp-server) 2.3.2，MIT 许可，版权归 Haris Musa，许可全文见 [LICENSE](LICENSE)。本插件不修改上游代码，只给出启动命令。

## 依赖

- 需要先安装 [uv](https://docs.astral.sh/uv/getting-started/installation/)，并能在终端里运行 `uvx`。uv 在 macOS、Windows 和 Linux 上用法相同，三个系统的工具完全一致。
- 启动时由 `uvx` 从 PyPI 获取固定版本 `excel-mcp-server==2.3.2`，依赖按 `--exclude-newer` 给出的日期解析，每次启动得到同一组版本。第一次启动需要联网；没有合适的 Python 时 uv 会自行准备一个。

## 注意

插件以你的系统账户权限运行，可以打开账户能访问的任何 .xlsx 文件。调用前会弹出确认窗口，显示要操作的文件路径。
