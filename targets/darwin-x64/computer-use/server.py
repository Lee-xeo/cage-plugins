# An MCP server on standard input and output for the Computer Use tools.
# The tools are described in tools.json beside this file and carried out by
# appcontrol.py, which is loaded at the first call. Only Python's standard
# library and the system's own frameworks are used.
import importlib
import json
import os
import sys

VERSION = "0.1.0"
HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "tools.json"), encoding="utf-8") as tools_file:
    TOOLS = json.load(tools_file)["tools"]
NAMES = {tool["name"] for tool in TOOLS}
_module, _stamp = None, None


def implementation():
    """The module that carries out the tools. While a file named .reload-on-change
    is beside it, edits to it take effect at the next call, without a restart."""
    global _module, _stamp
    stamp = os.stat(os.path.join(HERE, "appcontrol.py")).st_mtime_ns
    if _module is None:
        if HERE not in sys.path:
            sys.path.insert(0, HERE)
        import appcontrol
        _module, _stamp = appcontrol, stamp
    elif stamp != _stamp and os.path.exists(os.path.join(HERE, ".reload-on-change")):
        _module, _stamp = importlib.reload(_module), stamp
    return _module


def failed(words):
    return {"content": [{"type": "text", "text": words}], "isError": True}


def answer(message):
    method = message.get("method")
    params = message.get("params") or {}
    if method == "initialize":
        return {"protocolVersion": params.get("protocolVersion") or "2025-06-18", "capabilities": {"tools": {}},
                "serverInfo": {"name": "computer-use", "version": VERSION}}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        name = params.get("name")
        if name not in NAMES:
            return failed("there is no tool %s" % name)
        try:
            module = implementation()
        except Exception as failure:
            return failed("the tools could not start: %s: %s" % (type(failure).__name__, failure))
        return module.call(name, params.get("arguments") or {})
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
            continue  # a notification needs no answer
        result = answer(request)
        reply = {"jsonrpc": "2.0", "id": request["id"]}
        if result is None:
            reply["error"] = {"code": -32601, "message": "method not found"}
        else:
            reply["result"] = result
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
