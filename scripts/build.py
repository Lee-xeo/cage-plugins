#!/usr/bin/env python3
"""Check every plugin, pack each into dist/, and write index.json.

Run it after adding or changing a plugin. With --check it changes nothing and
fails if index.json or dist/ would differ, which is what the pull request
check runs.
"""
import gzip
import hashlib
import io
import json
import pathlib
import re
import sys
import tarfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = "https://raw.githubusercontent.com/Lee-xeo/cage-plugins/main/"
FIELDS = {"name", "displayName", "version", "description", "engines", "kind", "platforms", "permissions",
          "categories", "activationEvents", "command", "icon", "contributes"}
TARGETS = {"darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"}
ENGINE = re.compile(r"^(>=|\^)\d+\.\d+\.\d+$")
SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*$")
COMMON_SCHEMES = {"http", "https", "file", "ftp", "mailto", "data", "javascript", "blob", "about", "chrome", "ws", "wss", "claude", "tailscale"}
HOST = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")
PORT = re.compile(r"^(\*|\d{1,5})$")
PERMISSIONS = {"files", "commands", "screen", "input", "network"}
# The market's sections. The application shows only those it knows, so add
# here only after the application knows the new one.
CATEGORIES = ("desktop", "developer", "system", "network", "files", "productivity", "example")
PLATFORMS = {"darwin", "linux", "windows"}
NAME = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
VERSION = re.compile(r"^[0-9]+(\.[0-9]+){0,2}([-+.][0-9A-Za-z.-]+)?$")
# Tools describe only what they do, never where the model runs. Latin words
# are matched whole, as the application does.
RESERVED = ("cage", "guest", "vm", "virtual machine", "虚拟机", "客机")
MAX_BYTES = 20 * 1024 * 1024
MAX_ICON_BYTES = 256 * 1024


def fail(message):
    sys.exit("error: " + message)


def inside(folder, name, suffixes):
    """Whether name is a path of a file inside the plugin with one of the suffixes."""
    path = pathlib.PurePosixPath(str(name))
    return (isinstance(name, str) and name and not path.is_absolute() and ".." not in path.parts and "\\" not in name
            and path.as_posix() == name and path.suffix.lower() in suffixes
            and (folder / name).is_file() and not (folder / name).is_symlink())


def only(where, value, allowed):
    if not isinstance(value, dict) or set(value) - allowed:
        fail(f"{where}: must be an object with fields drawn from {sorted(allowed)}")


def command_ok(command):
    return isinstance(command, list) and command and all(isinstance(part, str) and part for part in command)


def open_url_ok(pattern):
    scheme, found, rest = str(pattern).partition("://")
    authority, slash, route = rest.partition("/")
    if not found or not slash or re.search(r"[\s?#@\\]", pattern):
        return False
    host, colon, port = authority.partition(":")
    if colon and not PORT.match(port):
        return False
    if scheme == "https":
        if not HOST.match(host):
            return False
    elif scheme != "http" or host not in ("127.0.0.1", "localhost"):
        return False
    return "*" not in route.removesuffix("*")


def contributes(folder, data):
    """Check the second manifest format: what the plugin adds."""
    name, c = folder.name, data["contributes"]
    only(f"{name}: contributes", c, {"mcpServers", "views", "uriHandlers"})
    if "command" in data:
        fail(f"{name}: command belongs in contributes.mcpServers")
    engines = data.get("engines")
    if not isinstance(engines, dict) or set(engines) != {"cage"} or not ENGINE.match(str(engines["cage"])):
        fail(f"{name}: engines.cage must be >=X.Y.Z or ^X.Y.Z")
    if data.get("kind") not in ("host", "guest"):
        fail(f"{name}: kind must be host or guest")
    if data["kind"] == "guest" and data.get("platforms"):
        fail(f"{name}: platforms is for host plugins")
    servers, views, schemes = [], [], []
    for server in c.get("mcpServers", []):
        only(f"{name}: mcpServers", server, {"id", "command"})
        if not NAME.match(str(server.get("id", ""))) or server["id"] in servers or not command_ok(server.get("command")):
            fail(f"{name}: mcpServers needs a unique id and a command")
        servers.append(server["id"])
    for view in c.get("views", []):
        only(f"{name}: views", view, {"id", "title", "icon", "entry", "server", "openUrls"})
        if not NAME.match(str(view.get("id", ""))) or view["id"] in views:
            fail(f"{name}: views needs a unique id")
        if not isinstance(view.get("title"), str) or not 0 < len(view["title"]) <= 80:
            fail(f"{name}: view {view['id']} needs a title")
        if not inside(folder, view.get("entry"), (".html",)):
            fail(f"{name}: view {view['id']}: entry must be an HTML file inside the plugin")
        if "icon" in view and not inside(folder, view["icon"], (".png", ".svg")):
            fail(f"{name}: view {view['id']}: icon must be a PNG or SVG file inside the plugin")
        if "server" in view and view["server"] not in servers:
            fail(f"{name}: view {view['id']}: server is not one of mcpServers")
        for pattern in view.get("openUrls", []):
            if not open_url_ok(pattern):
                fail(f"{name}: view {view['id']}: openUrls {pattern!r} must be https to a named host, or http to "
                     "127.0.0.1 or localhost, with a path that may end in *")
        views.append(view["id"])
    for handler in c.get("uriHandlers", []):
        only(f"{name}: uriHandlers", handler, {"scheme", "server", "tool", "reveal"})
        scheme = str(handler.get("scheme", ""))
        if not SCHEME.match(scheme) or len(scheme) > 40 or scheme in COMMON_SCHEMES or scheme in schemes:
            fail(f"{name}: uriHandlers scheme {scheme!r} is not valid, reserved or repeated")
        if handler.get("server") not in servers or not handler.get("tool"):
            fail(f"{name}: uriHandlers {scheme}: server must be one of mcpServers, and tool is required")
        if "reveal" in handler and handler["reveal"] not in views:
            fail(f"{name}: uriHandlers {scheme}: reveal is not one of views")
        schemes.append(scheme)
    for event in data.get("activationEvents", []):
        kind, _, target = str(event).partition(":")
        if not (event == "onStartupFinished" or kind == "onView" and target in views or kind == "onUri" and target in schemes):
            fail(f"{name}: unknown activation event {event!r}")


def manifest(folder):
    path = folder / "plugin.json"
    if not path.is_file():
        fail(f"{folder.name}: plugin.json is missing")
    data = json.loads(path.read_text(encoding="utf-8"))
    extra = set(data) - FIELDS
    if extra:
        fail(f"{folder.name}: unknown fields {sorted(extra)}")
    if data.get("name") != folder.name or not NAME.match(folder.name) or len(folder.name) > 40:
        fail(f"{folder.name}: name must equal the folder name: lowercase letters, digits and hyphens")
    if not VERSION.match(str(data.get("version", ""))):
        fail(f"{folder.name}: version must look like 1.2.3")
    if not isinstance(data.get("description"), str) or not data["description"].strip():
        fail(f"{folder.name}: description is missing")
    if not isinstance(data.get("permissions"), list) or set(data["permissions"]) - PERMISSIONS:
        fail(f"{folder.name}: permissions must be a list drawn from {sorted(PERMISSIONS)}")
    if set(data.get("platforms", [])) - PLATFORMS:
        fail(f"{folder.name}: platforms must be drawn from {sorted(PLATFORMS)}")
    if "displayName" in data and (not isinstance(data["displayName"], str) or not 0 < len(data["displayName"]) <= 80):
        fail(f"{folder.name}: displayName must be a short name")
    categories = data.get("categories", [])
    if (not isinstance(categories, list) or not 0 < len(categories) <= 3 or len(set(categories)) != len(categories)
            or set(categories) - set(CATEGORIES)):
        fail(f"{folder.name}: categories must name one to three of {list(CATEGORIES)}")
    if "contributes" in data:
        contributes(folder, data)
    else:
        # The first format: one command, and nothing the second format added.
        if not command_ok(data.get("command")):
            fail(f"{folder.name}: command is missing")
        if data.get("kind", "host") != "host" or "engines" in data or "activationEvents" in data:
            fail(f"{folder.name}: kind, engines and activationEvents need contributes")
    icon = data.get("icon")
    if icon is not None:
        if not inside(folder, icon, (".png", ".svg")):
            fail(f"{folder.name}: icon must be a PNG or SVG file inside the plugin")
        if (folder / icon).stat().st_size > MAX_ICON_BYTES:
            fail(f"{folder.name}: icon is over {MAX_ICON_BYTES // 1024} KB")
    # Only what is shown to people and models; kind and engines are structure.
    shown = [data["name"], data.get("displayName", ""), data["description"]]
    shown += [view["title"] for view in data.get("contributes", {}).get("views", [])]
    lowered = json.dumps(shown, ensure_ascii=False).lower()
    words = set(re.split(r"[^a-z0-9\u0080-\U0010ffff]+", lowered))
    for word in RESERVED:
        if (word in lowered) if (" " in word or not word.isascii()) else (word in words):
            fail(f"{folder.name}: the manifest mentions {word!r}")
    return data


def pack(folder):
    """A tar.gz whose bytes depend only on the files' paths and contents."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for path in sorted(folder.rglob("*")):
            relative = path.relative_to(folder).as_posix()
            if path.is_symlink():
                fail(f"{folder.name}: {relative} is a link; plugins contain only files and folders")
            if any(part.startswith(".") or part == "__pycache__" for part in path.relative_to(folder).parts):
                continue
            info = tarfile.TarInfo(folder.name + "/" + relative)
            info.mtime = 0
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            if path.is_dir():
                info.type, info.mode = tarfile.DIRTYPE, 0o755
                archive.addfile(info)
            elif path.is_file():
                data = path.read_bytes()
                info.size, info.mode = len(data), 0o755
                archive.addfile(info, io.BytesIO(data))
    packed = io.BytesIO()
    with gzip.GzipFile(fileobj=packed, mode="wb", mtime=0, filename="") as out:
        out.write(raw.getvalue())
    if len(packed.getvalue()) > MAX_BYTES:
        fail(f"{folder.name}: the packed plugin is over {MAX_BYTES // 1024 // 1024} MB")
    return packed.getvalue()


def folders():
    """Each plugin folder with its target: plugins/<name> runs anywhere,
    targets/<target>/<name> holds a build for one system and processor."""
    found = [(folder, "") for folder in sorted((ROOT / "plugins").iterdir()) if folder.is_dir()]
    for group in sorted((ROOT / "targets").iterdir()) if (ROOT / "targets").is_dir() else []:
        if not group.is_dir():
            continue
        if group.name not in TARGETS:
            fail(f"targets/{group.name}: target must be one of {sorted(TARGETS)}")
        found += [(folder, group.name) for folder in sorted(group.iterdir()) if folder.is_dir()]
    return found


def main():
    check = "--check" in sys.argv[1:]
    entries, wanted = [], {}
    for folder, target_name in folders():
        data = manifest(folder)
        name = f"{data['name']}-{data['version']}{'-' + target_name if target_name else ''}.tar.gz"
        target = ROOT / "dist" / name
        packed = pack(folder)
        if target.exists() and target.read_bytes() != packed:
            fail(f"{folder.name}: its files changed but its version did not; raise the version in plugin.json")
        wanted[target] = packed
        entry = {key: data[key] for key in ("name", "version", "description", "permissions")}
        for key in ("displayName", "platforms", "categories", "kind", "engines", "contributes"):
            if data.get(key):
                entry[key] = data[key]
        if target_name:
            entry["target"] = target_name
        # The application takes pictures only from plugins/<name>/; a build
        # for one target shows the picture of the plugin's folder there.
        if data.get("icon") and (not target_name or (ROOT / "plugins" / data["name"] / data["icon"]).is_file()):
            entry["icon"] = BASE + "plugins/" + data["name"] + "/" + data["icon"]
        entry["archive"] = BASE + "dist/" + name
        entry["sha256"] = hashlib.sha256(packed).hexdigest()
        entry["bytes"] = len(packed)
        entries.append(entry)
    index = json.dumps({"version": 1, "plugins": entries}, ensure_ascii=False, indent=2) + "\n"
    path = ROOT / "index.json"
    if check:
        stale = [str(target.relative_to(ROOT)) for target in wanted if not target.exists()]
        if stale or not path.exists() or path.read_text(encoding="utf-8") != index:
            fail("index.json or dist/ is out of date; run python3 scripts/build.py and commit the result")
        print(f"ok: {len(entries)} plugins")
        return
    (ROOT / "dist").mkdir(exist_ok=True)
    for target, packed in wanted.items():
        if not target.exists():
            target.write_bytes(packed)
    path.write_text(index, encoding="utf-8")
    print(f"wrote index.json with {len(entries)} plugins")


if __name__ == "__main__":
    main()
