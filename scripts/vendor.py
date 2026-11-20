#!/usr/bin/env python3
"""Pin a launched plugin's server: run it after changing a plugin's launch.json.

    python3 scripts/vendor.py plugins/<name> [--uv /path/to/uv]

For a Python server it resolves launch.json's python.requires for every
Python version and processor listed, with uv, and writes pylock.json: for
each, the exact wheel file of every package, its address on the Python
Package Index, size and SHA-256. For a Node.js server it runs `npm ci` from
the plugin's package-lock.json into node_modules, without install scripts.
Either way it then starts the server once and writes what tools/list
answers to tools.json, and copies scripts/launcher.py into the plugin.

This needs network access and, for Python, uv; building the market
(scripts/build.py) needs neither.
"""
import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
MACHINES = ("x86_64", "aarch64")
# The oldest C library the wheels may need: Debian 10, Ubuntu 20.04, Fedora 29.
GLIBC = (2, 28)


def wheel_tags(filename):
    name = filename[:-4].split("-")
    python, abi, plat = name[-3], name[-2], name[-1]
    return python.split("."), abi.split("."), plat.split(".")


def platform_ok(plat, machine):
    if plat == "any":
        return True
    for prefix, glibc in (("manylinux1_", (2, 5)), ("manylinux2010_", (2, 12)), ("manylinux2014_", (2, 17))):
        if plat == prefix + machine:
            return glibc <= GLIBC
    match = re.match(r"^manylinux_(\d+)_(\d+)_(.+)$", plat)
    return bool(match) and match.group(3) == machine and (int(match.group(1)), int(match.group(2))) <= GLIBC


def score(filename, version, machine):
    """How well a wheel fits CPython version on Linux machine; None if not."""
    major, minor = version
    pythons, abis, plats = wheel_tags(filename)
    if not any(platform_ok(plat, machine) for plat in plats):
        return None
    best = None
    for python in pythons:
        for abi in abis:
            if python == "cp%d%d" % (major, minor) and abi == "cp%d%d" % (major, minor):
                rank = 3
            elif abi == "abi3" and python.startswith("cp3") and int(python[3:]) <= minor:
                rank = 2
            elif abi == "none" and python in ("py3", "py%d" % major, "py%d%d" % (major, minor), "cp%d%d" % (major, minor)):
                rank = 1
            else:
                continue
            best = max(best or 0, rank)
    if best is None:
        return None
    return (best, 0 if "any" in plats else 1)


def pypi_files(name, version):
    import time
    url = "https://pypi.org/pypi/%s/%s/json" % (name, version)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                return json.load(response)["urls"]
        except Exception:
            if attempt == 3:
                raise
            time.sleep(1 + attempt * 2)


def resolve(uv, requires, python, machine, exclude_newer):
    command = [uv, "pip", "compile", "-", "--python-version", python, "--python-platform", machine + "-manylinux_2_28",
               "--only-binary", ":all:", "--no-header", "--no-annotate", "--quiet"]
    if exclude_newer:
        command += ["--exclude-newer", exclude_newer]
    out = subprocess.run(command, input="\n".join(requires), capture_output=True, text=True)
    if out.returncode:
        return None, out.stderr.strip().splitlines()[-1:]
    pins = [line.split("==") for line in out.stdout.splitlines() if "==" in line and not line.startswith("#")]
    return [(name.strip(), version.strip()) for name, version in pins], None


def lock_python(folder, config, uv):
    python = config["python"]
    environments, skipped = {}, {}
    cache = {}
    for version in python["pythons"]:
        for machine in MACHINES:
            key = version + "-" + machine
            pins, problem = resolve(uv, python["requires"], version, machine, python.get("resolvedBefore"))
            if pins is None:
                skipped[key] = problem
                continue
            chosen = []
            for name, pinned in pins:
                files = cache.get((name, pinned)) or pypi_files(name, pinned)
                cache[(name, pinned)] = files
                ranked = [(score(f["filename"], tuple(map(int, version.split("."))), machine), f)
                          for f in files if f["packagetype"] == "bdist_wheel" and not f.get("yanked")]
                ranked = [item for item in ranked if item[0]]
                if not ranked:
                    raise SystemExit("error: %s %s has no wheel for Python %s on %s" % (name, pinned, version, machine))
                best = max(ranked, key=lambda item: item[0])[1]
                chosen.append({"name": name, "version": pinned, "file": best["filename"], "url": best["url"],
                               "size": best["size"], "sha256": best["digests"]["sha256"]})
            environments[key] = chosen
    if not environments:
        raise SystemExit("error: nothing resolved: %s" % skipped)
    lock = {"requires": python["requires"], "environments": environments}
    (folder / python["lock"]).write_text(json.dumps(lock, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    for key, problem in skipped.items():
        print("  skipped Python %s: %s" % (key, " ".join(problem)))
    sizes = {key: sum(item["size"] for item in items) for key, items in environments.items()}
    print("  locked %s; download %.1f-%.1f MB" % (", ".join(sorted(environments)), min(sizes.values()) / 1e6,
                                                  max(sizes.values()) / 1e6))


def install_node(folder):
    shutil.rmtree(folder / "node_modules", ignore_errors=True)
    subprocess.run(["npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=folder, check=True)
    # Package managers leave records and .bin symlinks that are not needed to run;
    # plugins may only contain plain files and folders.
    shutil.rmtree(folder / "node_modules" / ".bin", ignore_errors=True)
    for junk in (folder / "node_modules" / ".package-lock.json",):
        if junk.exists():
            junk.unlink()


RESERVED = ("cage", "guest", "virtual machine", "vm", "虚拟机", "客机")


def check_tools_wording(tools):
    for tool in tools:
        parts = [tool.get("name", ""), tool.get("title", ""), tool.get("description", "")]
        if isinstance(tool.get("annotations"), dict):
            parts.append(str(tool["annotations"].get("title", "")))
        for key in ("inputSchema", "outputSchema"):
            if tool.get(key) is not None:
                parts.append(json.dumps(tool[key], ensure_ascii=False))
        lowered = " ".join(parts).lower()
        words = set(re.split(r"[^a-z0-9\u0080-\U0010ffff]+", lowered))
        for word in RESERVED:
            hit = (word in lowered) if (" " in word or not word.isascii()) else (word in words)
            if hit:
                raise SystemExit("error: tool %s mentions reserved word %r" % (tool.get("name"), word))


def capture_command(folder, config, uv, env):
    def expand(value):
        if value == "~" or value.startswith("~/"):
            return os.path.join(env["HOME"], value[2:]) if value.startswith("~/") else env["HOME"]
        return value
    for rel in config.get("dataDirs", []):
        os.makedirs(expand(rel), exist_ok=True)
    if "python" in config and sys.platform != "linux":
        # pylock.json locks Linux wheels; on macOS/Windows run the same pinned
        # requirements via uv to capture tools.json.
        python = config["python"]
        server = config["server"]
        command = [uv, "run", "--no-project"]
        if python.get("resolvedBefore"):
            command += ["--exclude-newer", python["resolvedBefore"]]
        for req in python["requires"]:
            command += ["--with", req]
        runner = (
            "import sys; "
            "entry = sys.argv[1]; args = sys.argv[2:]; "
            "mod, _, attr = entry.partition(':'); "
            "sys.argv = [mod] + args; "
            "target = __import__(mod, fromlist=['_']); "
            "[target := getattr(target, p) for p in attr.split('.')]; "
            "sys.exit(target())"
        )
        args = [expand(arg) for arg in server.get("args", [])]
        return command + ["python", "-c", runner, server["entry"]] + args
    return json.loads(subprocess.run([sys.executable, "-I", str(folder / "launcher.py"), "--prepare"],
                                     env=env, capture_output=True, text=True, check=True).stdout)


def capture_tools(folder, config, uv):
    """Start the server and keep what tools/list answers."""
    home = tempfile.mkdtemp(prefix="vendor-home-")
    env = dict(os.environ, HOME=home)
    try:
        command = capture_command(folder, config, uv, env)
        child_env = dict(env)
        for key, value in config.get("env", {}).items():
            child_env[key] = os.path.join(home, value[2:]) if value.startswith("~/") else (home if value == "~" else value)
        child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, cwd=folder, env=child_env)

        def send(message):
            child.stdin.write((json.dumps(message) + "\n").encode())
            child.stdin.flush()

        def answer(ident):
            for line in child.stdout:
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if message.get("id") == ident:
                    return message
            raise SystemExit("error: the server stopped before answering")

        send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "client", "version": "1"}}})
        answer(1)
        send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        tools = answer(2)["result"]["tools"]
        child.terminate()
        child.wait(10)
    finally:
        shutil.rmtree(home, ignore_errors=True)
    prefix = config.get("toolPrefix", "")
    if prefix:
        for tool in tools:
            if not tool["name"].startswith(prefix):
                tool["name"] = prefix + tool["name"]
    check_tools_wording(tools)
    (folder / "tools.json").write_text(json.dumps(tools, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print("  %d tools" % len(tools))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("folder")
    parser.add_argument("--uv", default=shutil.which("uv") or "uv")
    parser.add_argument("--tools-only", action="store_true")
    options = parser.parse_args()
    folder = pathlib.Path(options.folder).resolve()
    config = json.loads((folder / "launch.json").read_text(encoding="utf-8"))
    shutil.copyfile(ROOT / "scripts" / "launcher.py", folder / "launcher.py")
    print(folder.name)
    if not options.tools_only:
        if "python" in config:
            lock_python(folder, config, options.uv)
        if (folder / "package-lock.json").exists():
            install_node(folder)
    capture_tools(folder, config, options.uv)


if __name__ == "__main__":
    main()
