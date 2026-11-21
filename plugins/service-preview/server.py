"""Expose Linux loopback-accessible listeners through MCP over standard I/O."""

import ipaddress
import json
from pathlib import Path
import re
import struct
import sys

ROOT = Path(__file__).resolve().parent
TOOLS = json.loads((ROOT / "tools.json").read_text(encoding="utf-8"))
MAX_LISTENERS = 256
ROUTE = re.compile(r"/(?!/)[A-Za-z0-9._~!$&'()*+,;=:@/%-]*")
INVALID_ESCAPE = re.compile(r"%(?![a-fA-F0-9]{2})")


def listening_ports():
    ports = {}
    for family, filename in ((4, "tcp"), (6, "tcp6")):
        try:
            rows = Path("/proc/net", filename).read_text(encoding="ascii").splitlines()
        except FileNotFoundError:
            if family == 4:
                raise
            continue
        for row in rows[1:]:
            fields = row.split()
            if fields[3] != "0A":
                continue
            hex_address, hex_port = fields[1].split(":")
            # The kernel writes each 32-bit address word in native byte order.
            address = ipaddress.ip_address(b"".join(
                struct.pack("=I", int(hex_address[start:start + 8], 16))
                for start in range(0, len(hex_address), 8)
            ))
            if family == 6 and address.ipv4_mapped is not None:
                address = address.ipv4_mapped
            if not (address.is_unspecified or str(address) in {"127.0.0.1", "::1"}):
                continue
            port = int(hex_port, 16)
            bind = "127.0.0.1" if address.version == 4 else "localhost"
            ports.setdefault(port, {}).setdefault(bind, set()).add(fields[9])
    return ports


class Preview:
    def __init__(self):
        self.registrations = {}

    def listeners(self):
        ports = listening_ports()
        # Drop labels when their original listeners close, including port reuse.
        for port, (host, sockets, _) in list(self.registrations.items()):
            if not sockets.intersection(ports.get(port, {}).get(host, ())):
                del self.registrations[port]
        return ports

    def list(self):
        ports = self.listeners()
        ordered = sorted(ports, key=lambda port: (port not in self.registrations, port))
        rows = []
        for port in ordered[:MAX_LISTENERS]:
            default_host = "127.0.0.1" if "127.0.0.1" in ports[port] else "localhost"
            host, _, details = self.registrations.get(port, (default_host, None, {}))
            rows.append({"port": port, "host": host, **details})
        return {"services": rows, "total": len(ports)}

    def register(self, arguments):
        port = arguments.get("port")
        label = arguments.get("label")
        path = arguments.get("path", "/")
        if type(port) is not int or not 1 <= port <= 65535:
            raise ValueError("Provide a port number from 1 to 65535.")
        if not isinstance(label, str) or not label.strip() or len(label) > 80 or not label.isprintable():
            raise ValueError("Provide a printable label of 1 to 80 characters.")
        if not isinstance(path, str) or len(path) > 512 or not ROUTE.fullmatch(path) or INVALID_ESCAPE.search(path):
            raise ValueError("Provide an absolute URL path such as / or /docs.")
        if arguments.keys() - {"port", "label", "path"}:
            raise ValueError("Only port, label and path can be registered.")
        binds = self.listeners().get(port)
        if not binds:
            raise ValueError("No TCP listener on this port is accessible on loopback.")
        host = "127.0.0.1" if "127.0.0.1" in binds else "localhost"
        details = {"label": label.strip(), "path": path}
        self.registrations[port] = (host, binds[host], details)
        return {"port": port, "host": host, **details}


def error(code, message):
    return {"error": {"code": code, "message": message}}


def reply(request, preview):
    method = request.get("method")
    params = request.get("params", {})
    if not isinstance(params, dict):
        return error(-32602, "Expected an object for params.")
    if method == "initialize":
        version = params.get("protocolVersion")
        if not isinstance(version, str):
            return error(-32602, "Expected a protocol version.")
        return {"result": {
            "protocolVersion": version,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "service-preview", "version": "0.1.0"},
        }}
    if method == "ping":
        return {"result": {}}
    if method == "tools/list":
        return {"result": {"tools": TOOLS}}
    if method != "tools/call":
        return error(-32601, "Method not found.")

    name = params.get("name")
    arguments = params.get("arguments", {})
    if name not in ("service_preview_list", "service_preview_register") or not isinstance(arguments, dict):
        return error(-32602, "Expected a known tool and an arguments object.")
    try:
        if name == "service_preview_list":
            if arguments:
                raise ValueError("This tool takes no arguments.")
            result = preview.list()
        else:
            result = preview.register(arguments)
    except (OSError, ValueError) as failure:
        message = str(failure) if isinstance(failure, ValueError) else "Could not read the local TCP listener table."
        return {"result": {"isError": True, "content": [{"type": "text", "text": message}]}}
    return {"result": {
        "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
        "structuredContent": result,
    }}


def main():
    preview = Preview()
    for line in sys.stdin:
        try:
            request = json.loads(line)
        except ValueError:
            request_id, response = None, error(-32700, "Invalid JSON.")
        else:
            if not isinstance(request, dict) or request.get("jsonrpc") != "2.0":
                request_id, response = None, error(-32600, "Invalid request.")
            elif "id" not in request:
                continue
            else:
                request_id, response = request["id"], reply(request, preview)
        print(json.dumps({"jsonrpc": "2.0", "id": request_id, **response}), flush=True)


if __name__ == "__main__":
    main()
