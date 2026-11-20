#!/usr/bin/env python3
"""Start an MCP server packaged with this plugin, and answer for it at once.

This file is the same in every plugin that has a launch.json; the build
checks that it matches scripts/launcher.py. It needs only the Python standard
library, version 3.8 or later.

What it does:

* Answers initialize and tools/list itself, from tools.json, so the tools
  are there the moment the plugin starts, however long the server takes.
* Gets the server ready in the background. A Python server's packages are
  listed in pylock.json with their exact files and SHA-256 digests; they are
  downloaded once from the Python Package Index, checked, and unpacked into
  a folder of their own under ~/.cache/mcp-plugins. A Node.js server's
  packages come inside the plugin, installed from its package-lock.json, so
  nothing is downloaded.
* Passes each tool call to the server once it is ready, and the answer back.
  When something the server needs is missing, the call says what and how to
  get it.
"""
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(os.path.expanduser("~"), ".cache", "mcp-plugins")
DOWNLOAD_HOSTS = ("files.pythonhosted.org",)


def load(name):
    with open(os.path.join(HERE, name), encoding="utf-8") as file:
        return json.load(file)


def say(text):
    sys.stderr.write(text.rstrip() + "\n")
    sys.stderr.flush()


class Unready(Exception):
    """What keeps the server from starting, worded for the person using it."""


def python_key():
    machine = platform.machine().lower()
    machine = {"amd64": "x86_64", "arm64": "aarch64"}.get(machine, machine)
    return "%d.%d-%s" % (sys.version_info[0], sys.version_info[1], machine)


def wheels(lock):
    key = python_key()
    chosen = lock["environments"].get(key)
    if chosen is None:
        raise Unready("This tool needs Python %s on %s, which has Python %d.%d on %s. Install one of the "
                      "supported Python versions (python3) to use it." % (
                          " or ".join(sorted({k.split("-")[0] for k in lock["environments"]})),
                          sys.platform, sys.version_info[0], sys.version_info[1], platform.machine()))
    if sys.platform != "linux" and any(not item["file"].endswith("-any.whl") for item in chosen):
        raise Unready("This plugin's locked Python packages are built for Linux, not %s." % sys.platform)
    return key, chosen


def install(name, lock):
    """The folder the server's packages are unpacked in, downloading them
    the first time."""
    key, chosen = wheels(lock)
    digest = hashlib.sha256(json.dumps(chosen, sort_keys=True).encode()).hexdigest()[:16]
    home = os.path.join(CACHE, name)
    target = os.path.join(home, key + "-" + digest)
    if os.path.isfile(os.path.join(target, ".complete")):
        return target
    os.makedirs(home, exist_ok=True)
    total = sum(item["size"] for item in chosen)
    say("downloading %d packages (%.1f MB) from the Python Package Index" % (len(chosen), total / 1e6))
    staging = tempfile.mkdtemp(prefix=".unpacking-", dir=home)
    try:
        for item in chosen:
            data = fetch(item)
            unpack(data, staging)
        with open(os.path.join(staging, ".complete"), "w") as file:
            file.write(digest)
        try:
            os.rename(staging, target)
        except OSError:
            # Another start finished first.
            if not os.path.isfile(os.path.join(target, ".complete")):
                raise
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    # Earlier versions of this plugin's packages are no longer needed.
    for entry in os.listdir(home):
        if entry != os.path.basename(target) and not entry.startswith(".unpacking-"):
            shutil.rmtree(os.path.join(home, entry), ignore_errors=True)
    return target


def fetch(item):
    url = item["url"]
    host = urllib.parse.urlparse(url).hostname
    if not url.startswith("https://") or host not in DOWNLOAD_HOSTS:
        raise Unready("refusing to download %s" % url)
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                if urllib.parse.urlparse(response.geturl()).hostname not in DOWNLOAD_HOSTS:
                    raise Unready("refusing a redirect to %s" % response.geturl())
                data = response.read(item["size"] + 1)
            break
        except Unready:
            raise
        except Exception as error:  # noqa: BLE001 - network errors of every kind
            last = error
            time.sleep(1 + attempt * 2)
    else:
        raise Unready("The first start downloads this tool's packages from files.pythonhosted.org, and that failed "
                      "(%s). Check the network connection, then try again." % last)
    if len(data) != item["size"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
        raise Unready("%s did not match its recorded SHA-256 digest; it was not used." % item["file"])
    return data


def unpack(data, into):
    """Install a wheel by unpacking it, as pip does for a target folder."""
    import io
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for member in archive.infolist():
            name = member.filename
            parts = name.split("/")
            if name.startswith("/") or ".." in parts or "\\" in name:
                raise Unready("a package holds an unexpected path %r" % name)
            # name-1.0.data/purelib/x.py belongs at x.py; scripts and data
            # files are not needed to run the server.
            if len(parts) > 2 and parts[0].endswith(".data"):
                if parts[1] not in ("purelib", "platlib"):
                    continue
                parts = parts[2:]
            if member.is_dir() or not parts or not parts[-1]:
                continue
            path = os.path.join(into, *parts)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with archive.open(member) as source, open(path, "wb") as out:
                shutil.copyfileobj(source, out)
            if member.external_attr >> 16 & 0o111:
                os.chmod(path, 0o755)


def missing(config):
    for need in config.get("requires", []):
        found = shutil.which(need["program"]) if "program" in need else os.path.exists(need["path"])
        if not found:
            raise Unready(need["missing"])


def filter_unexpanded(args):
    """Drop an unexpanded ${PROJECT_DIR} placeholder (on older apps that do not
    substitute it) so the plugin still starts cleanly."""
    out, i = [], 0
    args = list(args)
    while i < len(args):
        if i + 1 < len(args) and args[i].startswith("-") and "${PROJECT_DIR}" in args[i + 1]:
            i += 2
            continue
        if "${PROJECT_DIR}" in args[i]:
            i += 1
            continue
        out.append(args[i])
        i += 1
    return out


def server_command(config, extra_args=()):
    """The command that runs the real server, once its files are ready."""
    missing(config)
    extra = filter_unexpanded(extra_args)
    server = config["server"]
    if "entry" in server:
        site = install(config["name"], load(config["python"]["lock"]))
        # -I -S: neither the environment's variables nor the system's own
        # packages; only the plugin's.
        return [sys.executable, "-I", "-S", os.path.abspath(__file__), "--run", site, server["entry"]] + server.get("args", []) + extra
    return server["command"] + extra


def run(site, entry, args):
    """Run a Python server's entry point with its packages on the path."""
    import site as sitemodule
    sys.path[:] = [path for path in sys.path if path != HERE]
    # First on the path, and with the packages' .pth files read.
    sys.path.insert(0, site)
    sitemodule.addsitedir(site)
    module, _, attribute = entry.partition(":")
    sys.argv = [module] + args
    target = __import__(module, fromlist=["_"])
    for part in attribute.split("."):
        target = getattr(target, part)
    sys.exit(target())


class Proxy:
    def __init__(self, config, extra_args=()):
        self.config = config
        self.extra_args = list(extra_args)
        self.tools = load("tools.json")
        self.out = threading.Lock()
        self.ready = threading.Event()
        self.problem = None
        self.child = None
        self.client_init = None
        self.next_id = 1
        self.waiting = {}
        self.waiting_lock = threading.Lock()

    def write(self, message):
        line = json.dumps(message, ensure_ascii=False) + "\n"
        with self.out:
            sys.stdout.write(line)
            sys.stdout.flush()

    def reply(self, ident, result=None, error=None):
        message = {"jsonrpc": "2.0", "id": ident}
        if error is not None:
            message["error"] = error
        else:
            message["result"] = result
        self.write(message)

    def prepare(self):
        try:
            command = server_command(self.config, self.extra_args)
            env = dict(os.environ)
            env.update(self.config.get("env", {}))
            self.child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, cwd=HERE, env=env)
            threading.Thread(target=self.read_child, daemon=True).start()
            answer = self.ask("initialize", self.client_init)
            if "error" in answer:
                raise Unready("the server did not start: %s" % answer["error"].get("message"))
            self.send_child({"jsonrpc": "2.0", "method": "notifications/initialized"})
        except Unready as problem:
            self.problem = str(problem)
        except Exception as problem:  # noqa: BLE001
            self.problem = "The tool could not start: %s" % problem
        if self.problem:
            say(self.problem)
        self.ready.set()

    def send_child(self, message):
        self.child.stdin.write((json.dumps(message) + "\n").encode())
        self.child.stdin.flush()

    def ask(self, method, params):
        with self.waiting_lock:
            ident = self.next_id
            self.next_id += 1
            slot = self.waiting[ident] = {"done": threading.Event()}
        self.send_child({"jsonrpc": "2.0", "id": ident, "method": method, "params": params or {}})
        slot["done"].wait()
        return slot["answer"]

    def read_child(self):
        for line in self.child.stdout:
            try:
                message = json.loads(line)
            except ValueError:
                say("server: " + line.decode(errors="replace"))
                continue
            if "method" in message and "id" in message:
                # The server asks the client something; this client offers nothing.
                self.send_child({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32601, "message": "not supported"}})
            elif "method" in message:
                self.write(message)
            else:
                with self.waiting_lock:
                    slot = self.waiting.pop(message.get("id"), None)
                if slot:
                    slot["answer"] = message
                    slot["done"].set()
        # The server ended: every call still waiting fails.
        self.problem = self.problem or "The tool's server stopped. Turn the plugin off and on again to restart it."
        with self.waiting_lock:
            pending, self.waiting = self.waiting, {}
        for slot in pending.values():
            slot["answer"] = {"error": {"code": -32603, "message": self.problem}}
            slot["done"].set()

    def call(self, ident, params):
        self.ready.wait()
        if self.problem:
            self.reply(ident, {"content": [{"type": "text", "text": self.problem}], "isError": True})
            return
        answer = self.ask("tools/call", params)
        if "error" in answer:
            self.reply(ident, error=answer["error"])
        else:
            self.reply(ident, answer.get("result"))

    def serve(self):
        for line in sys.stdin:
            try:
                message = json.loads(line)
            except ValueError:
                continue
            method, ident = message.get("method"), message.get("id")
            if method == "initialize":
                self.client_init = message.get("params") or {}
                self.reply(ident, {"protocolVersion": self.client_init.get("protocolVersion", "2025-06-18"),
                                   "capabilities": {"tools": {}},
                                   "serverInfo": {"name": self.config["name"], "version": self.config["version"]}})
                threading.Thread(target=self.prepare, daemon=True).start()
            elif method == "tools/list":
                self.reply(ident, {"tools": self.tools})
            elif method == "tools/call":
                threading.Thread(target=self.call, args=(ident, message.get("params")), daemon=True).start()
            elif method == "ping":
                self.reply(ident, {})
            elif ident is not None:
                self.reply(ident, error={"code": -32601, "message": "method not found"})
        if self.child:
            self.child.terminate()


def main():
    if sys.argv[1:2] == ["--run"]:
        run(sys.argv[2], sys.argv[3], sys.argv[4:])
    config = load("launch.json")
    if sys.argv[1:2] == ["--prepare"]:
        # Used when the plugin is built, and by anyone who wants the
        # download done before the first call.
        print(json.dumps(server_command(config, sys.argv[2:])))
        return
    Proxy(config, sys.argv[1:]).serve()


if __name__ == "__main__":
    main()
