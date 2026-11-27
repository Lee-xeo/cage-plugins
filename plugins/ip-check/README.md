# ip-check

Checks how risky a public IP address looks, using the
[ip-check](https://ip-check.leeguoo.com) service. Two tools:

| Tool | What it checks |
| --- | --- |
| `ip_check_exit` | The public address this tool's own traffic leaves from (the current exit). |
| `ip_check_ip` | A given public IPv4 or IPv6 address. Private, loopback and reserved addresses are rejected before any request is made. |

Each result has a 0-100 risk score (higher is riskier), the network type
(residential, hosting, VPN, residential proxy, Tor, mobile, China cloud), the
reasons, country and ASN, a verdict on whether the network looks suitable for
signing in to Claude (including Anthropic's supported-region list), and a link to
the HTML report.

The score is built from public network signals: ASN and hosting lists, known VPN
and proxy operators, Tor exits, anycast ranges and region. It cannot prove that
an account is safe, and it cannot see local proxy settings, browser state or
anything else on the machine.

`ip_check_exit` uses ASN and edge data only. Residential-proxy, mobile and
abuse reputation feeds are applied only when `ip_check_ip` checks an address
other than the caller's own; passing the exit address to `ip_check_ip` from the
same network gives the same result as `ip_check_exit`.

## Data flow

- The only network destination is `https://ip-check.leeguoo.com/`.
- `ip_check_exit` sends a plain request with no parameters; the service sees the
  address the request comes from.
- `ip_check_ip` sends the address being looked up as `?ip=`.
- If an API key is set, it is sent as `Authorization: Bearer <key>`.
- Nothing is written to disk. No other data (files, project, environment) is read or sent.

## Limits

| Use | Limit |
| --- | --- |
| `ip_check_ip` without a key | 10 lookups a day per caller address (UTC day) |
| `ip_check_ip` with a free key | 100 lookups a day |
| `ip_check_exit` | not counted against the daily limit; short-term rate limit only |

A free key (`ipck_...`) can be created at
[account.leeguoo.com/apikeys](https://account.leeguoo.com/apikeys) and entered
in the plugin's API key setting (`IPCHECK_API_KEY`).

## Requirements

Python 3 standard library only. Nothing is downloaded at runtime.

## License

MIT.
