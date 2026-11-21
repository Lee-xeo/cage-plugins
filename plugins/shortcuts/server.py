# An MCP server on standard input and output that lists and runs the user's
# Shortcuts on this Mac through the system `shortcuts` command. Only the
# shortcuts in one folder of the Shortcuts app can be listed or run: by
# default the folder named in README.md, or the one named by the
# SHORTCUTS_FOLDER environment variable. It needs nothing beyond Python's
# standard library.
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

VERSION = "0.1.0"
NAME = "shortcuts"
SHORTCUTS = "/usr/bin/shortcuts"
FOLDER = os.environ.get("SHORTCUTS_FOLDER", "").strip() or "Claude-Cage"
MAX_INPUT = 64 * 1024
MAX_OUTPUT = 1024 * 1024
LIST_TIMEOUT = 30
ENTRY = re.compile(r"^(.*) \(([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\)$")


def run_timeout():
    try:
        value = int(os.environ.get("SHORTCUTS_TIMEOUT", "120"))
    except ValueError:
        value = 120
    return min(max(value, 5), 600)


TOOLS = [
    {
        "name": "list_shortcuts",
        "description": "List the shortcuts the user has made available from the Shortcuts app on this Mac, "
                       "with the name and identifier of each. Only these shortcuts can be run.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "run_shortcut",
        "description": "Run one of the shortcuts returned by list_shortcuts on this Mac and return the text "
                       "it outputs. A shortcut can act on the user's apps and data, as the user built it.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "shortcut": {"type": "string", "maxLength": 512,
                             "description": "name or identifier from list_shortcuts; use the identifier "
                                            "when two shortcuts share a name"},
                "input": {"type": "string", "maxLength": MAX_INPUT,
                          "description": "optional text given to the shortcut as its input"},
            },
            "required": ["shortcut"],
            "additionalProperties": False,
        },
    },
]


class Refused(Exception):
    """A failure to report to the caller in plain words."""


def command(args, timeout):
    try:
        result = subprocess.run([SHORTCUTS, *args], capture_output=True, timeout=timeout,
                                stdin=subprocess.DEVNULL)
    except FileNotFoundError:
        raise Refused("The shortcuts command is not available on this Mac (macOS 12 or later is required).")
    except subprocess.TimeoutExpired:
        raise Refused(f"The shortcuts command did not finish within {timeout} seconds.")
    return result


def folder_exists():
    result = command(["list", "--folders"], LIST_TIMEOUT)
    if result.returncode != 0:
        raise Refused("Could not read the folders of the Shortcuts app.")
    return FOLDER in result.stdout.decode("utf-8", "replace").splitlines()


def allowed():
    """The shortcuts in the chosen folder, as (name, identifier) pairs.

    `shortcuts list --folder-name` lists every shortcut when the folder does
    not exist, so the folder is confirmed before and after listing it.
    """
    if not folder_exists():
        return None
    result = command(["list", "--folder-name", FOLDER, "--show-identifiers"], LIST_TIMEOUT)
    if result.returncode != 0:
        raise Refused("Could not list the available shortcuts.")
    entries = []
    for line in result.stdout.decode("utf-8", "replace").splitlines():
        match = ENTRY.match(line)
        if match:
            entries.append((match.group(1), match.group(2).upper()))
    if not folder_exists():
        return None
    return entries


NO_FOLDER = ("No shortcuts are available yet. The user can make shortcuts available by creating the folder "
             "described in this plugin's instructions in the Shortcuts app and moving shortcuts into it.")


def list_shortcuts():
    entries = allowed()
    if entries is None:
        return NO_FOLDER
    if not entries:
        return "The folder for available shortcuts is empty."
    return "\n".join(f"{name} ({identifier})" for name, identifier in entries)


def resolve(wanted, entries):
    wanted = wanted.strip()
    by_id = [e for e in entries if e[1] == wanted.upper()]
    if by_id:
        return by_id[0]
    by_name = [e for e in entries if e[0] == wanted]
    if len(by_name) == 1:
        return by_name[0]
    if len(by_name) > 1:
        raise Refused("Several available shortcuts have this name; give the identifier from list_shortcuts.")
    raise Refused("This shortcut is not available. Use list_shortcuts to see the shortcuts that can be run.")


def run_shortcut(arguments):
    wanted = arguments.get("shortcut")
    text = arguments.get("input")
    if not isinstance(wanted, str) or not wanted.strip():
        raise Refused("Give the name or identifier of a shortcut.")
    if text is not None and (not isinstance(text, str) or len(text.encode("utf-8")) > MAX_INPUT):
        raise Refused("The input must be text of at most 64 KB.")
    entries = allowed()
    if entries is None:
        raise Refused(NO_FOLDER)
    name, identifier = resolve(wanted, entries)
    timeout = run_timeout()
    work = tempfile.mkdtemp(prefix="shortcuts-")
    try:
        args = ["run", identifier]
        if text is not None:
            source = os.path.join(work, "input.txt")
            with open(source, "w", encoding="utf-8") as file:
                file.write(text)
            args += ["--input-path", source]
        output = os.path.join(work, "output.txt")
        args += ["--output-path", output, "--output-type", "public.plain-text"]
        result = command(args, timeout)
        if result.returncode != 0:
            detail = result.stderr.decode("utf-8", "replace").strip().splitlines()
            reason = detail[-1][:300] if detail else f"exit status {result.returncode}"
            raise Refused(f"The shortcut {name} did not complete: {reason}")
        if not os.path.exists(output):
            return f"The shortcut {name} completed without text output."
        size = os.path.getsize(output)
        with open(output, "rb") as file:
            data = file.read(MAX_OUTPUT + 1)
        value = data[:MAX_OUTPUT].decode("utf-8", "replace")
        if size > MAX_OUTPUT:
            value += f"\n[output truncated: {size} bytes, first {MAX_OUTPUT} shown]"
        return value if value.strip() else f"The shortcut {name} completed without text output."
    finally:
        shutil.rmtree(work, ignore_errors=True)


def call(name, arguments):
    if name == "list_shortcuts":
        return list_shortcuts()
    if name == "run_shortcut":
        return run_shortcut(arguments)
    raise Refused(f"Unknown tool: {name}")


def answer(message):
    method = message.get("method")
    if method == "initialize":
        return {
            "protocolVersion": message["params"]["protocolVersion"],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": NAME, "version": VERSION},
        }
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        params = message.get("params") or {}
        try:
            text = call(params.get("name"), params.get("arguments") or {})
            return {"content": [{"type": "text", "text": text}]}
        except Refused as error:
            return {"content": [{"type": "text", "text": str(error)}], "isError": True}
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
        except json.JSONDecodeError:
            continue
        if "id" not in request:
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
