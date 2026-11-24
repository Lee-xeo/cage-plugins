# An MCP server on standard input and output with one tool that reports live
# system telemetry: CPU utilization, load averages, memory, disk, network I/O
# and uptime. Linux only; Python's standard library only.
import json
import os
import shutil
import sys
import time

TOOLS = [{
    "name": "system_status",
    "description": "Report live CPU utilization, processor load, memory use, disk use, network throughput and uptime of the system this tool runs on.",
    "inputSchema": {"type": "object", "properties": {}},
}]

_last_cpu = None
_last_net = None


def _read_cpu_totals():
    with open("/proc/stat", encoding="ascii") as file:
        parts = file.readline().split()
    if len(parts) < 5 or parts[0] != "cpu":
        return None
    nums = [int(x) for x in parts[1:]]
    idle = nums[3] + (nums[4] if len(nums) > 4 else 0)
    total = sum(nums)
    return idle, total


def cpu_percent():
    global _last_cpu
    now = _read_cpu_totals()
    if now is None:
        return None
    if _last_cpu is None:
        # Take a brief initial sample so the very first render has a real percentage.
        prev = now
        time.sleep(0.1)
        now = _read_cpu_totals()
        if now is None:
            return None
    else:
        prev = _last_cpu
    _last_cpu = now
    delta_total = now[1] - prev[1]
    delta_idle = now[0] - prev[0]
    if delta_total <= 0:
        return 0.0
    busy = max(0.0, min(100.0, (1.0 - delta_idle / delta_total) * 100.0))
    return round(busy, 1)


def memory():
    values = {}
    with open("/proc/meminfo", encoding="ascii") as file:
        for line in file:
            name, _, rest = line.partition(":")
            parts = rest.split()
            if parts:
                values[name] = int(parts[0]) * 1024
    total = values["MemTotal"]
    available = values.get("MemAvailable", 0)
    swap_total = values.get("SwapTotal", 0)
    swap_free = values.get("SwapFree", 0)
    return {
        "total_bytes": total,
        "used_bytes": max(0, total - available),
        "available_bytes": available,
        "swap_total_bytes": swap_total,
        "swap_used_bytes": max(0, swap_total - swap_free),
    }


def _read_net_totals():
    rx_total = 0
    tx_total = 0
    with open("/proc/net/dev", encoding="ascii") as file:
        for line in file.readlines()[2:]:
            iface, sep, rest = line.partition(":")
            if not sep:
                continue
            name = iface.strip()
            if name == "lo":
                continue
            cols = rest.split()
            if len(cols) >= 10:
                rx_total += int(cols[0])
                tx_total += int(cols[8])
    return rx_total, tx_total


def network():
    global _last_net
    try:
        rx, tx = _read_net_totals()
    except OSError:
        return None
    now = time.monotonic()
    if _last_net is None:
        _last_net = (now, rx, tx)
        return {"rx_bytes_per_sec": 0, "tx_bytes_per_sec": 0}
    prev_t, prev_rx, prev_tx = _last_net
    _last_net = (now, rx, tx)
    dt = now - prev_t
    if dt <= 0.05:
        return {"rx_bytes_per_sec": 0, "tx_bytes_per_sec": 0}
    return {
        "rx_bytes_per_sec": max(0, int((rx - prev_rx) / dt)),
        "tx_bytes_per_sec": max(0, int((tx - prev_tx) / dt)),
    }


def tasks():
    try:
        with open("/proc/loadavg", encoding="ascii") as file:
            parts = file.read().split()
        if len(parts) >= 4 and "/" in parts[3]:
            running, _, total = parts[3].partition("/")
            return {"running": int(running), "total": int(total)}
    except (OSError, ValueError):
        pass
    return None


def status():
    one, five, fifteen = os.getloadavg()
    disk = shutil.disk_usage(os.path.expanduser("~"))
    with open("/proc/uptime", encoding="ascii") as file:
        uptime = float(file.read().split()[0])
    report = {
        "processors": os.cpu_count() or 1,
        "load": {"1m": round(one, 2), "5m": round(five, 2), "15m": round(fifteen, 2)},
        "memory": memory(),
        "disk": {"total_bytes": disk.total, "used_bytes": disk.used, "free_bytes": disk.free},
        "uptime_seconds": int(uptime),
        "time": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    cpu = cpu_percent()
    if cpu is not None:
        report["cpu_percent"] = cpu
    net = network()
    if net is not None:
        report["network"] = net
    proc = tasks()
    if proc is not None:
        report["tasks"] = proc
    return report


def answer(message):
    method = message.get("method")
    if method == "initialize":
        return {"protocolVersion": message["params"]["protocolVersion"], "capabilities": {"tools": {}},
                "serverInfo": {"name": "system-status", "version": "0.2.0"}}
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
