# An MCP server on standard input and output that asks ip-check.leeguoo.com
# how risky a public IP address looks. Python's standard library only.
#
# The only network destination is https://ip-check.leeguoo.com. A request
# carries the address being looked up (or nothing, for the exit address) and,
# when IPCHECK_API_KEY is set, that key as a bearer token.
import http.client
import ipaddress
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

VERSION = "0.1.0"
BASE = "https://ip-check.leeguoo.com/"
TIMEOUT = 20
KEY_PAGE = "https://account.leeguoo.com/apikeys"
NOTE = ("Scores come from public network signals (ASN, hosting and VPN lists, Tor exits, region). "
        "They cannot prove that an account is safe or predict a ban.")

TOOLS = [
    {
        "name": "ip_check_exit",
        "description": (
            "Check the public IP address that this tool's own internet traffic leaves from. Returns a 0-100 "
            "risk score (higher is riskier), the network type (residential, hosting, VPN, Tor, China cloud), "
            "the reasons, the country and ASN, and a verdict on whether the network looks suitable for "
            "signing in to Claude, including Anthropic's supported-region list. The exit address is judged from "
            "ASN and edge data only: residential-proxy, mobile and abuse feeds are not applied to it, and passing "
            "the same address to ip_check_ip from this network gives the same result. " + NOTE
        ),
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "ip_check_ip",
        "description": (
            "Check a given public IPv4 or IPv6 address other than the current exit (for the exit, use "
            "ip_check_exit). Returns a 0-100 risk score (higher is riskier), the "
            "network type (residential, hosting, VPN, residential proxy, Tor, mobile, China cloud), the reasons, "
            "the country and ASN, abuse reputation, and a verdict on whether the address looks suitable for "
            "signing in to Claude, including Anthropic's supported-region list. Without an API key the service "
            "allows 10 lookups a day per caller address. " + NOTE
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "ip": {"type": "string", "description": "A public IPv4 or IPv6 address, for example 1.1.1.1 or 2606:4700::1111."},
            },
            "required": ["ip"],
            "additionalProperties": False,
        },
    },
]


class CheckError(Exception):
    pass


def parse_ip(value):
    if not isinstance(value, str) or not value.strip():
        raise CheckError("ip is required: pass a public IPv4 or IPv6 address.")
    text = value.strip()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    try:
        address = ipaddress.ip_address(text)
    except ValueError:
        raise CheckError(f"{value!r} is not an IPv4 or IPv6 address.")
    if address.version == 6 and address.ipv4_mapped:
        address = address.ipv4_mapped
    if not address.is_global:
        raise CheckError(f"{address} is a private, loopback, link-local or reserved address; only public addresses can be checked.")
    return str(address)


def fetch(ip=None):
    url = BASE if ip is None else BASE + "?" + urllib.parse.urlencode({"ip": ip})
    headers = {"Accept": "application/json", "User-Agent": f"ip-check-mcp/{VERSION}"}
    key = os.environ.get("IPCHECK_API_KEY", "").strip()
    if key:
        headers["Authorization"] = "Bearer " + key
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            body = response.read(1 << 20)
    except urllib.error.HTTPError as failure:
        raise CheckError(explain_http(failure))
    except (OSError, http.client.HTTPException) as failure:  # URLError, timeouts, TLS and reset errors
        reason = getattr(failure, "reason", failure)
        raise CheckError(f"could not reach ip-check.leeguoo.com: {reason}. Check the network connection and try again.")
    try:
        data = json.loads(body)
    except ValueError:
        raise CheckError("ip-check.leeguoo.com returned a response that is not JSON; try again later.")
    if not isinstance(data, dict) or "ip" not in data:
        raise CheckError("ip-check.leeguoo.com returned an unexpected response; try again later.")
    return data


def explain_http(failure):
    try:
        data = json.loads(failure.read(1 << 16))
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}
    error = data.get("error")
    if failure.code == 429 and error == "quota_exceeded":
        return (f"daily lookup limit reached ({data.get('used')}/{data.get('quota')} used, resets at "
                f"{data.get('reset')}). A free API key from {KEY_PAGE} raises the limit to 100 a day; "
                "set it as the plugin's API key.")
    if failure.code == 429:
        wait = data.get("reset_seconds")
        return "too many requests in a short time" + (f"; try again in {wait} seconds." if wait else "; try again in a minute.")
    if failure.code == 401 or error == "invalid_key":
        return f"the API key was rejected (invalid or revoked). Create a new one at {KEY_PAGE}, or clear the key to use the anonymous limit."
    return f"ip-check.leeguoo.com answered HTTP {failure.code}" + (f" ({error})" if error else "") + "; try again later."


def english(value):
    if isinstance(value, dict):
        return value.get("en") or value.get("zh")
    return value


def summarize(data, exit_check):
    signals = data.get("signals") if isinstance(data.get("signals"), dict) else {}
    flags = sorted(name for name, on in signals.items() if on is True)
    claude = data.get("claude") if isinstance(data.get("claude"), dict) else {}
    score = data.get("score") if isinstance(data.get("score"), dict) else None
    ip = data.get("ip")
    out = {
        "ip": ip,
        "asn": data.get("asn") or None,
        "org": data.get("org"),
        "country": data.get("country"),
        "city": data.get("city"),
        "risk": data.get("risk"),
        "level": data.get("level"),
        "label": english(data.get("label")),
        "type": data.get("type"),
        "reasons": data.get("reasons") or [],
        "signals": flags,
        "claude_verdict": claude.get("verdict"),
        "claude_title": english(claude.get("title")),
        "claude_action": english(claude.get("action")),
        "claude_safety_score": score.get("value") if score else None,
        "sources": data.get("source"),
        "report_url": BASE + "?" + urllib.parse.urlencode({"ip": ip}) if ip else BASE,
        "note": NOTE,
    }
    if signals.get("abuser") not in (None, "none") or signals.get("abuserScore"):
        out["abuse"] = {"level": signals.get("abuser"), "score": signals.get("abuserScore")}
    if exit_check:
        out["coverage"] = "ASN and edge data only; use ip_check_ip for residential-proxy and abuse feeds on another address."
    if score is None:
        out["lookup"] = "ASN lookup failed; the score may be incomplete."
    return out


def call(name, arguments):
    if name == "ip_check_exit":
        return summarize(fetch(), exit_check=True)
    if name == "ip_check_ip":
        return summarize(fetch(parse_ip(arguments.get("ip"))), exit_check=False)
    raise CheckError(f"unknown tool {name!r}")


def answer(message):
    method = message.get("method")
    params = message.get("params") or {}
    if method == "initialize":
        return {"protocolVersion": params.get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}},
                "serverInfo": {"name": "ip-check", "version": VERSION}}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, dict):
            arguments = {}
        try:
            report = call(params.get("name"), arguments)
        except CheckError as failure:
            return {"content": [{"type": "text", "text": f"failed: {failure}"}], "isError": True}
        except Exception as failure:  # never let one call stop the server
            return {"content": [{"type": "text", "text": f"failed: unexpected error: {failure!r}"}], "isError": True}
        return {"content": [{"type": "text", "text": json.dumps(report, ensure_ascii=False)}], "structuredContent": report}
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
