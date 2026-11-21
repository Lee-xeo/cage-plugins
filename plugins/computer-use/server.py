# An MCP server on standard input and output for the Computer Use tools.
# The tools are described in tools.json beside this file and carried out by
# appcontrol.py, which is loaded when the server starts. Only Python's standard
# library and the system's own frameworks are used.
import importlib
import json
import os
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
try:  # the version is the manifest's, so the two cannot differ
    with open(os.path.join(HERE, "plugin.json"), encoding="utf-8") as manifest_file:
        VERSION = str(json.load(manifest_file).get("version") or "0")
except (OSError, ValueError):
    VERSION = "0"
with open(os.path.join(HERE, "tools.json"), encoding="utf-8") as tools_file:
    TOOLS = json.load(tools_file)["tools"]
NAMES = {tool["name"] for tool in TOOLS}
_module, _stamp = None, None
_loading = threading.Lock()  # loading the module, and counting the calls under way
_writing = threading.Lock()  # one reply at a time on standard output
_busy = 0
_failure = None  # why the module could not be loaded


def load():
    """Load the module that carries out the tools, or load it again after an edit
    while a file named .reload-on-change is beside it and no call is under way.
    Only on the main thread, where the system's frameworks must be started."""
    global _module, _stamp
    stamp = os.stat(os.path.join(HERE, "appcontrol.py")).st_mtime_ns
    if _module is None:
        if HERE not in sys.path:
            sys.path.insert(0, HERE)
        import appcontrol
        _module, _stamp = appcontrol, stamp
        return
    if stamp == _stamp or not os.path.exists(os.path.join(HERE, ".reload-on-change")):
        return
    with _loading:
        if _busy:
            return
        if hasattr(_module, "shutdown"):
            _module.shutdown()
        _module, _stamp = importlib.reload(_module), stamp


def implementation():
    if _module is None:
        raise _failure or RuntimeError("the tools are still starting")
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


def reply(request):
    global _busy
    try:
        result = answer(request)
        message = {"jsonrpc": "2.0", "id": request["id"]}
        if result is None:
            message["error"] = {"code": -32601, "message": "method not found"}
        else:
            message["result"] = result
        with _writing:
            sys.stdout.write(json.dumps(message) + "\n")
            sys.stdout.flush()
    finally:
        if request.get("method") == "tools/call":
            with _loading:
                _busy -= 1


def read():
    """Each tool call runs on a thread of its own, so calls for different apps go on at the same time; the
    module makes calls for one app take turns."""
    global _busy
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
        if request.get("method") == "tools/call":
            with _loading:
                _busy += 1
            threading.Thread(target=reply, args=(request,), daemon=True).start()
        else:
            reply(request)


def main():
    global _failure
    try:
        load()
    except Exception as problem:  # answer the calls with what went wrong
        _failure = problem
    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    # The main thread takes in the system's news of apps starting, quitting and
    # coming to the front, which arrives only on the main thread.
    while reader.is_alive():
        if _failure is None:
            try:
                load()
            except Exception:
                pass
        module = _module
        if module is not None and hasattr(module, "idle"):
            try:
                module.idle()
            except Exception:
                pass
        time.sleep(0.05)


if __name__ == "__main__":
    main()
