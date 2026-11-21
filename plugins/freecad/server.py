"""Start freecad-mcp. Headless runs need freecadcmd, which the Windows and
macOS installers do not put on PATH, so look in their install folders too."""
import glob
import os
import re
import sys

from freecad_mcp.headless import detect_freecadcmd
from freecad_mcp.server import main


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
    found = [path for pattern in patterns for path in glob.glob(pattern) if os.path.isfile(path)]
    return newest_first(found)[0] if found else None


if not any(arg == "--freecadcmd" or arg.startswith("--freecadcmd=") for arg in sys.argv[1:]):
    if sys.platform in ("win32", "darwin") and detect_freecadcmd() is None:
        path = installed_freecadcmd()
        if path:
            sys.argv += ["--freecadcmd", path]
main()
