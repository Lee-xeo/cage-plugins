# An MCP server on standard input and output that opens pages served on this
# computer's loopback address in a Chromium-based browser (Chrome, Edge or
# Chromium) and reads back which tab shows them. The browser runs with its own
# profile folder and is driven through its remote debugging HTTP endpoints, so
# the user's everyday browser profile is left alone. It needs nothing beyond
# Python's standard library. macOS and Linux; Windows has server.ps1.
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = "0.1.1"
NAME = "local-preview"
HOSTS = {"127.0.0.1", "localhost", "::1"}
MAX_URL = 2048
TAB_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# A path set here is used before any browser found on the computer.
OVERRIDE = "LOCAL_PREVIEW_BROWSER"

TOOLS = [
    {
        "name": "open_page",
        "description": "Open a page served on this computer at 127.0.0.1, localhost or [::1] in a browser window "
                       "on this computer, and return the tab's id, title and address once it has loaded.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "maxLength": MAX_URL,
                        "description": "http or https address on 127.0.0.1, localhost or [::1], "
                                       "such as http://localhost:5173/"},
            },
            "required": ["url"],
            "additionalProperties": False,
        },
    },
    {
        "name": "read_tab",
        "description": "Return the id, title and address that a browser tab opened by open_page shows now.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "maxLength": 64,
                       "description": "tab id returned by open_page; default the tab opened most recently"},
            },
            "additionalProperties": False,
        },
    },
]


class Refused(Exception):
    """A failure to report to the caller in plain words."""


def browsers():
    """Candidate browser programs on this computer, most preferred first."""
    found = []
    override = os.environ.get(OVERRIDE, "").strip()
    if override:
        found.append(override)
    if sys.platform == "darwin":
        apps = [("Google Chrome.app", "Google Chrome"), ("Microsoft Edge.app", "Microsoft Edge"),
                ("Chromium.app", "Chromium")]
        for root in ("/Applications", os.path.expanduser("~/Applications")):
            found += [os.path.join(root, app, "Contents", "MacOS", exe) for app, exe in apps]
    else:
        for command in ("google-chrome", "google-chrome-stable", "microsoft-edge", "microsoft-edge-stable",
                        "chromium", "chromium-browser"):
            path = shutil.which(command)
            if path:
                found.append(path)
        found += ["/opt/google/chrome/chrome", "/opt/microsoft/msedge/msedge", "/usr/lib/chromium/chromium",
                  "/usr/lib/chromium-browser/chromium-browser"]
    return found


def find_browser():
    for path in browsers():
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    if os.environ.get(OVERRIDE, "").strip():
        raise Refused(f"{os.environ[OVERRIDE]} is not a program that can be run.")
    raise Refused("No Chrome, Edge or Chromium browser was found on this computer. Install one of them, "
                  f"or set {OVERRIDE} to the path of a Chromium-based browser.")


def profile_folder(browser):
    """The browser's own profile folder, kept apart from the user's everyday one."""
    if sys.platform == "darwin":
        return pathlib.Path.home() / "Library" / "Application Support" / NAME / "browser"
    real = os.path.realpath(browser)
    if real.startswith("/snap/") or browser.startswith("/snap/"):
        # A snap may not write to hidden folders in the home folder.
        snap = pathlib.PurePosixPath(browser).name
        return pathlib.Path.home() / "snap" / snap / "common" / NAME
    data = os.environ.get("XDG_DATA_HOME") or os.path.join(pathlib.Path.home(), ".local", "share")
    return pathlib.Path(data) / NAME / "browser"


# The browser's debugging endpoints are on this computer; never ask a proxy.
DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class Browser:
    def __init__(self):
        self.port = None
        self.last_tab = None

    def call(self, path, method="GET", timeout=3):
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method)
        with DIRECT.open(request, timeout=timeout) as response:
            return json.load(response)

    def alive(self, port):
        self.port = port
        try:
            return "Browser" in self.call("/json/version", timeout=1)
        except (OSError, ValueError):
            return False

    def running_port(self, profile):
        """The debugging port of a browser already running with this profile, if any."""
        try:
            port = int((profile / "DevToolsActivePort").read_text().splitlines()[0])
        except (OSError, ValueError, IndexError):
            return None
        return port if self.alive(port) else None

    def start(self, url):
        """Make sure the browser runs. Returns True when it was started with url open."""
        path = find_browser()
        profile = profile_folder(path)
        if self.port is not None and self.alive(self.port):
            return False
        port = self.running_port(profile)
        if port:
            self.port = port
            return False
        profile.mkdir(parents=True, exist_ok=True)
        (profile / "DevToolsActivePort").unlink(missing_ok=True)
        try:
            process = subprocess.Popen(
                [path, "--user-data-dir=" + str(profile), "--remote-debugging-port=0", "--no-first-run",
                 "--no-default-browser-check", "--new-window", url],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True)
        except OSError as error:
            raise Refused(f"The browser at {path} could not be started: {error.strerror or error}")
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            status = process.poll()
            port = self.running_port(profile)
            if port:
                self.port = port
                self.last_tab = None
                return True
            if status is not None and status != 0:
                raise Refused(f"The browser at {path} stopped before it was ready (exit status {status}).")
            time.sleep(0.1)
        raise Refused(f"The browser at {path} did not become ready within 20 seconds.")

    def pages(self):
        return [item for item in self.call("/json/list") if item.get("type") == "page"]

    def first_page(self):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            pages = self.pages()
            if pages:
                return self.wait(pages[0]["id"]) or pages[0]
            time.sleep(0.1)
        raise Refused("The browser started, but its tab could not be found.")

    def wait(self, tab_id):
        """The tab once its page has a title of its own, or as it is after a few seconds."""
        deadline = time.monotonic() + 3
        while True:
            tab = next((item for item in self.pages() if item.get("id") == tab_id), None)
            if tab is None or tab.get("title") and not looks_untitled(tab) or time.monotonic() > deadline:
                return tab
            time.sleep(0.1)

    def open_page(self, url):
        check_url(url)
        try:
            started = self.start(url)
            if started:
                # The first window opened with the page as its only tab.
                tab = self.first_page()
            else:
                tab = self.call("/json/new?" + urllib.parse.quote(url, safe=""), method="PUT")
                try:
                    self.call("/json/activate/" + tab["id"])
                except (OSError, ValueError):
                    pass  # only brings the tab to the front
                tab = self.wait(tab["id"]) or tab
        except (urllib.error.URLError, OSError, ValueError, KeyError) as error:
            raise Refused(f"The browser did not answer: {error}")
        self.last_tab = tab["id"]
        return describe(tab)

    def read_tab(self, tab_id=None):
        if tab_id is not None and (not isinstance(tab_id, str) or not TAB_ID.match(tab_id)):
            raise Refused("id must be a tab id returned by open_page.")
        tab_id = tab_id or self.last_tab
        if not tab_id:
            raise Refused("No tab has been opened yet; open a page with open_page first.")
        path = find_browser()
        if not (self.port is not None and self.alive(self.port)) and not self.running_port(profile_folder(path)):
            raise Refused("The browser is not running; open the page again with open_page.")
        try:
            for item in self.pages():
                if item.get("id") == tab_id:
                    return describe(item)
        except (urllib.error.URLError, OSError, ValueError) as error:
            raise Refused(f"The browser did not answer: {error}")
        raise Refused("That tab has been closed; open the page again with open_page.")


def looks_untitled(tab):
    """A page without a title of its own is listed under its address."""
    url = tab.get("url", "")
    bare = url.split("://", 1)[-1]
    return tab.get("title") in (url, bare, bare.rstrip("/")) or url == "about:blank"


def describe(tab):
    return {"id": tab.get("id"), "title": tab.get("title", ""), "url": tab.get("url", "")}


def check_url(url):
    if not isinstance(url, str) or not url:
        raise Refused("url is required.")
    if len(url) > MAX_URL:
        raise Refused(f"url must be at most {MAX_URL} characters.")
    if re.search(r'[\s"\\\x00-\x1f\x7f]', url):
        raise Refused("url must not contain spaces, quotes, backslashes or control characters.")
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise Refused("url must start with http:// or https://.")
    if "@" in parts.netloc:
        raise Refused("url must not contain a user name or password.")
    try:
        parts.port
    except ValueError:
        raise Refused("url has a port that is not a number from 1 to 65535.")
    if (parts.hostname or "") not in HOSTS:
        raise Refused("Only pages on 127.0.0.1, localhost or [::1] can be opened.")
    if parts.port == 0:
        raise Refused("url has a port that is not a number from 1 to 65535.")


BROWSER = Browser()


def run_tool(name, arguments):
    if not isinstance(arguments, dict):
        raise Refused("arguments must be an object.")
    if name == "open_page":
        extra = set(arguments) - {"url"}
        if extra:
            raise Refused(f"open_page takes only url, not {', '.join(sorted(extra))}.")
        return BROWSER.open_page(arguments.get("url"))
    extra = set(arguments) - {"id"}
    if extra:
        raise Refused(f"read_tab takes only id, not {', '.join(sorted(extra))}.")
    return BROWSER.read_tab(arguments.get("id"))


def answer(message):
    method = message.get("method")
    params = message.get("params") or {}
    if method == "initialize":
        return {
            "protocolVersion": params.get("protocolVersion"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": NAME, "version": VERSION},
        }
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call" and params.get("name") in ("open_page", "read_tab"):
        try:
            tab = run_tool(params["name"], params.get("arguments") or {})
        except Refused as error:
            return {"content": [{"type": "text", "text": str(error)}], "isError": True}
        except Exception as error:  # report, keep serving
            return {"content": [{"type": "text", "text": f"failed: {error}"}], "isError": True}
        return {"content": [{"type": "text", "text": json.dumps(tab, ensure_ascii=False)}]}
    if method == "ping":
        return {}
    return None


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            continue
        if not isinstance(request, dict) or "id" not in request:
            continue  # a notification needs no reply
        result = answer(request)
        reply = {"jsonrpc": "2.0", "id": request["id"]}
        if result is None:
            reply["error"] = {"code": -32601, "message": "method not found"}
        else:
            reply["result"] = result
        sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
