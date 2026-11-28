# Host LaTeX

Host LaTeX uses TeX Live already installed on the computer running Cage. Open a shared project, ask Claude to compile a `.tex` file, and find the PDF in that project.

## 工作原理

1. Claude 在 Cage 里打开的是你共享的项目。它编辑 `main.tex` 后，可以请插件编译这份文件。
2. 你允许这次调用后，插件用宿主机上已有的 TeX Live 编译。编译在临时副本里进行，源文件留在原目录。Cage 环境无需再装一套 TeX。
3. PDF 存回同一个共享项目，比如 `.latex-out/main.pdf`。你在电脑上能打开，Claude 在 Cage 里也能接着用。

## 第一次使用

### Windows 从零安装

宿主机就是你打开 Cage 的那台电脑。下面这几步在 Windows 桌面上做。

1. 从 CTAN 下载 [TeX Live Windows 安装程序](https://mirror.ctan.org/systems/texlive/tlnet/install-tl-windows.exe)。
2. 双击下载好的 `install-tl-windows.exe`。安装界面里保留默认设置，点 **Install（安装）**，等它下载并装完。完整安装需要几 GB 空间。
3. 从 Windows 开始菜单打开一个新的 **PowerShell**，输入 `xelatex --version`。如果看到 `XeTeX` 和 `TeX Live` 的版本号，就装好了。第一次安装后，完全退出再打开 Cage，让它读到新的 PATH。

已经装过 TeX Live 且版本命令能正常运行的话，可以跳过下载安装。

### Windows 首次编译

1. 在 Cage 的「插件」里安装并启用「宿主机 LaTeX 编译」。
2. 在 PowerShell 输入 `python --version`。需要 Python 3.9 或以上版本。如果提示找不到命令，请从 [Python 官方 Windows 下载页](https://www.python.org/downloads/windows/) 安装 Python，再打开一个新的 PowerShell。
3. 先按下方「用 Cage 编译第一个 PDF」试一次。如果提示 Windows 隔离环境无法启动编译器，再执行下面的命令。它会读取现有安装，把所需程序、宏包和字体复制到当前用户的插件缓存里，只对这个副本设置读取权限。完整发行版的副本可能占用数 GB。

```powershell
$setup = Join-Path $env:USERPROFILE '.claude-cage\plugins\host-latex\windows_sandbox.py'
$texLive = kpsewhich -var-value=TEXMFROOT
if (Test-Path -LiteralPath $setup -PathType Leaf) {
    python -I -B "$setup" --prepare-runtime "$texLive"
} else {
    Write-Host '在默认目录找不到插件。请确认已安装，或把第一行改为实际的 windows_sandbox.py 路径后重试。'
}
```

看到 `Private TeX Live runtime ready.` 后再编译。TeX Live 更新后，如再次提示缺少运行副本，可重跑上面的命令。副本放在 `%LOCALAPPDATA%\HostLatex\runtimes`。手工改过系统宏包、字体或配置时，关闭插件，清理该插件缓存，再重新准备。原安装的文件、权限和设置均保持原样。

### macOS 和 Linux

- **macOS** 到 [MacTeX 下载页](https://ctan.org/pkg/mactex) 下载并打开 `.pkg` 安装包。插件使用系统自带的 `/usr/bin/sandbox-exec` 隔离编译。
- **Debian / Ubuntu** 在运行 Cage 的电脑上打开终端，执行 `sudo apt install texlive-xetex texlive-latex-extra bubblewrap`。其中 `bubblewrap` 负责隔离编译。编译中文文档时可加装 `texlive-lang-chinese`。[TeX Live 软件包](https://packages.debian.org/stable/tex/) · [bubblewrap 软件包](https://packages.debian.org/stable/bubblewrap)
- **其他 Linux** 按 [TeX Live 安装指南](https://texdoc.org/serve/texlive/1) 安装，再用系统的软件包管理器安装 `bubblewrap`。插件需要系统提供 `ldd` 并允许启动 bubblewrap 沙箱。

### 用 Cage 编译第一个 PDF

1. 在 Cage 的「插件」里启用「宿主机 LaTeX 编译」，然后打开一个包含 `main.tex` 的共享项目。
2. 新开一个 Claude Code 会话，说「帮我用宿主机 LaTeX 编译 `main.tex`，生成 PDF」。
3. Cage 弹出授权窗口后，确认是这次编译，再点「允许」。成功后打开项目里的 `.latex-out` 文件夹，双击 `main.pdf`。

如果入口在子目录，生成的 PDF 会保留相同的目录结构。文件名也可以带空格，例如 `paper/My Paper.tex` 会生成 `.latex-out/paper/My Paper.pdf`。如果文件管理器里看不到 `.latex-out`，macOS 的访达可按 `Command + Shift + .` 显示隐藏文件，Linux 常见的文件管理器可按 `Ctrl + H`。

编译期间如果移动项目或输出文件夹，Windows 可能会提示文件夹正在使用。如果插件提示无法保存 PDF，请等移动完成，重新打开项目再编译。新的 PDF 写好后才会替换旧版。

**从哪里开始编译**会影响 LaTeX 读到哪一份同名文件。如果你平时在项目根目录运行 `xelatex paper/main.tex`，告诉 Claude「从项目根目录编译」，对应 `working_directory="."`。如果平时先进 `paper` 再运行 `xelatex main.tex`，就指定 `working_directory="paper"`。单独放在一个文件夹里的论文可沿用原来的调用方式。入口在子目录、同时外层还有其他项目内容时，工具会要求明确目录。

如果宏或自定义模板提示缺文件，可以通过 `project_inputs` 补充该文件或所在目录，路径从共享项目根目录算起。选目录会包含它下面的文件。

**有参考文献时**，把已有的 `.bbl` 保留在你平时编译能找到的位置。例如在 `paper` 内编译 `My Paper.tex`，就使用 `paper/My Paper.bbl`。插件会运行两遍 LaTeX 来更新交叉引用。如果你手里只有 `.bib` 文件，需要先用 BibTeX 或 Biber 生成 `.bbl`。使用个人宏包或个人字体的项目，需要确认这些资源在隔离环境中可用。

编译时，系统会限制编译器能打开哪些文件。它可以用项目的临时副本、TeX Live、系统字体和运行所需的系统文件。XeLaTeX 还需要一个生成 PDF 的程序，这一步也受同样的限制。系统无法启用隔离时，插件会停止编译并给出提示。

## How it works

1. Claude asks the plugin to compile a file in the shared project.
2. After you approve the call, the plugin runs the computer's installed TeX Live on a temporary copy of the source files.
3. The plugin saves the finished PDF in the shared project so both you and Claude can open it.

## Use

Install Python 3.9 or newer and TeX Live on the computer running the plugin. Put your TeX Live binaries on PATH, including `xelatex`, `pdflatex`, `kpsewhich`, and the XeLaTeX PDF driver `xdvipdfmx`. The plugin also checks the standard MacTeX binary directory.

- **Windows** uses an AppContainer with child processes blocked and no network capability. Try compiling first. If the sandbox cannot access TeX Live, the optional PowerShell setup above creates a private runtime copy in `%LOCALAPPDATA%\HostLatex\runtimes`. The copy can take several GB. Only the copy receives a new read grant. Refresh this cache after local TeX customizations.
- **Linux** requires `bubblewrap` and `ldd`, with permission to start a sandbox.
- **macOS** requires `/usr/bin/sandbox-exec`.

Open a shared project and call `latex_compile` with a project-relative path such as `paper/My Paper.tex`. The default engine is XeLaTeX. Select `pdflatex` for documents that require it. A successful build writes `.latex-out/paper/My Paper.pdf`.

Windows may report that the project or output folder is in use if you move it during compilation. If the plugin cannot save the PDF after a move, reopen the project and compile again. The previous PDF is replaced only after the new file has been written.

Set `working_directory` to the directory used by your usual TeX command. For example, `xelatex paper/main.tex` from the project root uses `"."`; running `xelatex main.tex` inside that subproject uses `"paper"`. Self-contained entries retain their source-directory default. For nested entries with other files or directories outside the subproject, specify the working directory explicitly. The result includes the directory used and any final-pass or PDF-driver warnings the tool recognizes.

If a macro or custom template needs extra inputs, pass their project-relative paths in `project_inputs`. Selecting a directory includes its contents.

The plugin runs two LaTeX passes for cross-references. For BibTeX or Biber projects, include the matching `.bbl` where your usual TeX invocation looks for it. Private fonts, packages outside the shared project or system runtime, and additional external tools may require a different workflow.

## Permissions and data flow

- `files` reads the shared project's source and assets and writes the generated PDF into that project.
- `commands` runs TeX Live utilities and the platform's compilation sandbox. The tool accepts a source path and a choice of engine.
- This plugin makes no network requests and downloads no dependencies. It uses the Python standard library.

The operating system restricts file access while the compiler runs. It can read the temporary project copy, TeX Live resources, fonts and required system files. The plugin disables TeX shell escape. For XeLaTeX it starts the PDF driver separately inside the sandbox and disables external graphics conversion. If isolation cannot be set up, compilation stops. Keep the usual per-call approval for projects you trust.

The MCP service can also run directly with `python3 -I -B server.py /absolute/path/to/project` using standard input and output.
