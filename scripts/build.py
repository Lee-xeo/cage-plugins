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
FIELDS = {"name", "version", "description", "platforms", "permissions", "command"}
PERMISSIONS = {"files", "commands", "screen", "input", "network"}
PLATFORMS = {"darwin", "linux", "windows"}
NAME = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
VERSION = re.compile(r"^[0-9]+(\.[0-9]+){0,2}([-+.][0-9A-Za-z.-]+)?$")
# Tools describe only what they do, never where the model runs.
RESERVED = ("cage", "guest", "virtual machine", "虚拟机", "客机")
MAX_BYTES = 20 * 1024 * 1024


def fail(message):
    sys.exit("error: " + message)


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
    command = data.get("command")
    if not isinstance(command, list) or not command or not all(isinstance(part, str) and part for part in command):
        fail(f"{folder.name}: command is missing")
    lowered = json.dumps(data, ensure_ascii=False).lower()
    for word in RESERVED:
        if word in lowered:
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


def main():
    check = "--check" in sys.argv[1:]
    entries, wanted = [], {}
    for folder in sorted((ROOT / "plugins").iterdir()):
        if not folder.is_dir():
            continue
        data = manifest(folder)
        name = f"{data['name']}-{data['version']}.tar.gz"
        target = ROOT / "dist" / name
        packed = pack(folder)
        if target.exists() and target.read_bytes() != packed:
            fail(f"{folder.name}: its files changed but its version did not; raise the version in plugin.json")
        wanted[target] = packed
        entry = {key: data[key] for key in ("name", "version", "description", "permissions")}
        if data.get("platforms"):
            entry["platforms"] = data["platforms"]
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
