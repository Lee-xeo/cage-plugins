# Host LaTeX

Host LaTeX uses TeX Live already installed on the computer running Cage. Open a shared project, ask Claude to compile a `.tex` file, and find the PDF in that project.

## 工作原理

1. Claude 在 Cage 里打开的是你共享的项目。它编辑 `main.tex` 后，可以请插件编译这份文件。
2. 你允许这次调用后，插件用宿主机上已有的 TeX Live 编译。编译在临时副本里进行，源文件留在原目录。Cage 环境无需再装一套 TeX。
3. PDF 存回同一个共享项目，比如 `.cage-latex/main.pdf`。你在电脑上能打开，Claude 在 Cage 里也能接着用。

## 第一次使用

### Windows 从零安装

宿主机就是你打开 Cage 的那台电脑。下面这几步在 Windows 桌面上做。

1. 从 CTAN 下载 [TeX Live Windows 安装程序](https://mirror.ctan.org/systems/texlive/tlnet/install-tl-windows.exe)。
2. 双击下载好的 `install-tl-windows.exe`。安装界面里保留默认设置，点 **Install（安装）**，等它下载并装完。完整安装需要几 GB 空间。
3. 从 Windows 开始菜单打开一个新的 **PowerShell**，输入 `xelatex --version`。如果看到 `XeTeX` 和 `TeX Live` 的版本号，就装好了。第一次安装后，完全退出再打开 Cage，让它读到新的 PATH。

已经装过 TeX Live，而且这个版本命令能正常运行的话，可以直接用。

### macOS 和 Linux

- **macOS** 到 [MacTeX 下载页](https://ctan.org/pkg/mactex) 下载并打开 `.pkg` 安装包。
- **Debian / Ubuntu** 可在运行 Cage 的 Linux 电脑上执行 `sudo apt install texlive-xetex texlive-latex-extra`。编译中文文档时可加装 `texlive-lang-chinese`。[TeX Live 软件包](https://packages.debian.org/stable/tex/)
- **其他 Linux** 可按 [TeX Live 安装指南](https://texdoc.org/serve/texlive/1) 安装。

### 用 Cage 编译第一个 PDF

1. 在 Cage 的「插件」里启用「宿主机 LaTeX 编译」，然后打开一个包含 `main.tex` 的共享项目。
2. 新开一个 Claude Code 会话，说「帮我用宿主机 LaTeX 编译 `main.tex`，生成 PDF」。
3. Cage 弹出授权窗口后，确认是这次编译，再点「允许」。成功后在项目里的 `.cage-latex/main.pdf` 找到结果。

## How it works

1. Claude asks the plugin to compile a file in the shared project.
2. After you approve the call, the plugin runs the computer's installed TeX Live on a temporary copy of the source files.
3. The plugin saves the finished PDF in the shared project so both you and Claude can open it.

## Use

Install Python 3.9 or newer and TeX Live on the computer running the plugin. Make `xelatex`, `pdflatex`, and `kpsewhich` available on PATH. The plugin also checks the standard MacTeX binary directory.

Open a shared project and call `latex_compile` with a project-relative path such as `paper/main.tex`. The default engine is XeLaTeX. Select `pdflatex` for documents that require it. A successful build writes `.cage-latex/paper/main.pdf`.

The plugin runs two passes for common cross-references. Projects that require BibTeX or Biber can supply an existing `.bbl` file.

## Permissions and data flow

- `files` reads the shared project's source and assets and writes the generated PDF into that project.
- `commands` runs the installed TeX Live compiler and its installation lookup tool. The tool accepts a source path and a choice of engine.
- This plugin makes no network requests and downloads no dependencies. It uses the Python standard library.

Compile trusted projects. The tool makes a temporary copy of the relevant files, disables TeX shell escape, and checks the compiler's recorded paths before publishing the PDF. TeX still runs with the host account's privileges. Keep the normal per-call approval for this tool.

The MCP service can also run directly with `python3 -I -B server.py /absolute/path/to/project` using standard input and output.
