"""Start freecad-mcp. Headless runs need freecadcmd, which the Windows and
macOS installers do not put on PATH, so its lookup, done again for each run,
also looks in their install folders.

Cage puts the tools of every plugin in one namespace, and names such as
create_document are taken by other plugins, so every tool is renamed with a
freecad_ prefix, along with the places that name another tool."""
import glob
import os
import re
import sys

from freecad_mcp import headless
from freecad_mcp import server as upstream
from mcp.types import TextContent

PREFIX = "freecad_"

# Text that freecad-mcp 0.1.32 and its FreeCAD add-on put in tool results and
# that names a tool. Only these are changed in results, because results also
# carry the user's own output and object properties.
RESULT_PHRASES = [
    ("use ", "get_object", " to poll"),
    ("Poll ", "get_async_status", "("),
    ("Poll ", "get_task_status", "("),
    ("call ", "reload_document", " to see"),
    ("it has no ", "get_rpc_status", ""),
    ("build it with ", "execute_code", ""),
    ("so ", "create_object", " cannot"),
    ("consider ", "execute_code_async", ","),
    ("inside ", "execute_code_async", " workers"),
]


def newest_first(paths):
    key = lambda path: [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", path)]
    return sorted(set(paths), key=key, reverse=True)


def installed_freecadcmd():
    patterns = []
    if sys.platform == "win32":
        roots = [os.environ.get("ProgramFiles"), os.environ.get("ProgramW6432")]
        if os.environ.get("LOCALAPPDATA"):
            roots.append(os.path.join(os.environ["LOCALAPPDATA"], "Programs"))
        patterns = [os.path.join(root, "FreeCAD*", "bin", "freecadcmd.exe") for root in roots if root]
    elif sys.platform == "darwin":
        for root in ("/Applications", os.path.expanduser("~/Applications")):
            for name in ("freecadcmd", "FreeCADCmd"):
                patterns.append(os.path.join(root, "FreeCAD*.app", "Contents", "Resources", "bin", name))
    found = [path for pattern in patterns for path in glob.glob(pattern)
             if os.path.isfile(path) and os.access(path, os.X_OK)]
    return newest_first(found)[0] if found else None


def find_freecadcmd(detect=headless.detect_freecadcmd):
    command = detect()
    if command is None:
        path = installed_freecadcmd()
        command = [path] if path else None
    return command


def prefix_tools():
    manager = upstream.mcp._tool_manager
    tools = manager.list_tools()
    names = sorted((tool.name for tool in tools), key=len, reverse=True)
    mention = re.compile(r"(?<![\w.])(" + "|".join(map(re.escape, names)) + r")(?!\w)")

    def rename(text):
        return mention.sub(lambda match: PREFIX + match.group(1), text)

    def rename_strings(value):
        if isinstance(value, str):
            return rename(value)
        if isinstance(value, dict):
            return {key: rename_strings(item) for key, item in value.items()}
        if isinstance(value, list):
            return [rename_strings(item) for item in value]
        return value

    renamed = {}
    for tool in tools:
        tool.name = PREFIX + tool.name
        if tool.description:
            tool.description = rename(tool.description)
        tool.parameters = rename_strings(tool.parameters)
        renamed[tool.name] = tool
    manager._tools = renamed
    upstream.ASSET_CREATION_STRATEGY = rename(upstream.ASSET_CREATION_STRATEGY)

    def fix_result(value):
        if isinstance(value, TextContent):
            for before, name, after in RESULT_PHRASES:
                value.text = value.text.replace(before + name + after, before + PREFIX + name + after)
        elif isinstance(value, (list, tuple)):
            for item in value:
                fix_result(item)
        elif isinstance(getattr(value, "content", None), list):
            fix_result(value.content)
        return value

    call_tool = manager.call_tool

    async def call_and_fix(*args, **kwargs):
        return fix_result(await call_tool(*args, **kwargs))

    manager.call_tool = call_and_fix


headless.detect_freecadcmd = find_freecadcmd
prefix_tools()
upstream.main()
