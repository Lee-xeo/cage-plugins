# An MCP server on standard input and output with one tool that reports how
# busy the system it runs on is. Linux only; Python's standard library only.
import json
import os
import shutil
import sys
import time

TOOLS = [{
    "name": "system_status",
    "description": "Report processor load, memory use, disk use and uptime of the system this tool runs on.",
    "inputSchema": {"type": "object", "properties": {}},
}]


def memory():
    values = {}
    with open("/proc/meminfo", encoding="ascii") as file:
        for line in file:
            name, _, rest = line.partition(":")
            values[name] = int(rest.split()[0]) * 1024
    total = values["MemTotal"]
    return {"total_bytes": total, "used_bytes": total - values.get("MemAvailable", 0)}


def status():
    one, five, fifteen = os.getloadavg()
    disk = shutil.disk_usage(os.path.expanduser("~"))
    with open("/proc/uptime", encoding="ascii") as file:
        uptime = float(file.read().split()[0])
    return {
        "processors": os.cpu_count(),
        "load": {"1m": round(one, 2), "5m": round(five, 2), "15m": round(fifteen, 2)},
        "memory": memory(),
        "disk": {"total_bytes": disk.total, "used_bytes": disk.used},
        "uptime_seconds": int(uptime),
        "time": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }


def answer(message):
    method = message.get("method")
    if method == "initialize":
        return {"protocolVersion": message["params"]["protocolVersion"], "capabilities": {"tools": {}},
                "serverInfo": {"name": "system-status", "version": "0.1.0"}}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call" and message["params"].get("name") == "system_status":
        try:
            report = status()
        except OSError as failure:
            return {"content": [{"type": "text", "text": f"failed: {failure}"}], "isError": True}
        return {"content": [{"type": "text", "text": json.dumps(report)}], "structuredContent": report}
    if method == "ping":
        return {}
    return None


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    if "id" not in request:
        continue  # a notification needs no reply
    result = answer(request)
    reply = {"jsonrpc": "2.0", "id": request["id"]}
    if result is None:
        reply["error"] = {"code": -32601, "message": "method not found"}
    else:
        reply["result"] = result
    sys.stdout.write(json.dumps(reply) + "\n")
    sys.stdout.flush()
