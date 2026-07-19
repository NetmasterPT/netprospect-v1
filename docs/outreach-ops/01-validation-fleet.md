---
title: "01 — Validation fleet: Dante SOCKS5 proxies + DNS/PTR"
type: how-to
tags: [outreach, email]
related: []
owner: outreach
status: stable
updated: 2026-07-11
visibility: internal
---

# 01 — Validation fleet: Dante SOCKS5 proxies + DNS/PTR

Goal: 2–4 clean datacenter IPs, each running a **SOCKS5 proxy** (Dante) that Reacher tunnels its SMTP
`RCPT` probes through, with **PTR aligned to a subdomain of your disposable domain** so the `EHLO`
name Reacher presents matches the reverse DNS (mail servers check this).

Prereq: `00-port25-and-ips.md` done — each IP has open port 25 + settable PTR + is blocklist-clean.

## Step 1 — DNS on the disposable domain (you have this domain)

For each validation IP `i` (1..N), at your DNS provider:

```
p1.<disposable-domain>.   A   <IP-1>
p2.<disposable-domain>.   A   <IP-2>
...
```

Then set the **PTR/rDNS** of each IP (in the cloud/VPS panel) to the matching name:

```
<IP-1>  ->  p1.<disposable-domain>
<IP-2>  ->  p2.<disposable-domain>
```

Verify each:

```bash
dig +short p1.<disposable-domain>          # -> IP-1
dig +short -x <IP-1>                        # -> p1.<disposable-domain>.
```

Both must agree (forward + reverse match). This is what makes Gmail/Outlook trust the HELO.

## Step 2 — Dante SOCKS5 on each VM (Docker)

On each validation VM, create `docker-compose.dante.yml`:

```yaml
services:
  dante:
    image: wernight/dante           # or vimagick/dante — any Dante 1.4+ image
    restart: unless-stopped
    network_mode: host              # so the proxy egresses from the VM's real IP
    volumes:
      - ./danted.conf:/etc/danted.conf:ro
```

`danted.conf` (username/password auth; only the Hetzner worker should reach :1080):

```
logoutput: stderr
internal: 0.0.0.0 port = 1080
external: <this-vm-public-interface-or-ip>
socksmethod: username
user.privileged: root
user.unprivileged: nobody
client pass { from: 0.0.0.0/0 to: 0.0.0.0/0 }
socks pass  { from: 0.0.0.0/0 to: 0.0.0.0/0 protocol: tcp connect }
```

Create a proxy user (host account Dante authenticates against), then start:

```bash
sudo useradd --no-create-home --shell /usr/sbin/nologin proxyuser
echo 'proxyuser:<STRONG_PASS>' | sudo chpasswd
docker compose -f docker-compose.dante.yml up -d
```

## Step 3 — Lock the firewall (only the worker may use the proxy)

Open **1080/tcp only to the Hetzner worker's IP** (or route it over Tailscale and don't expose 1080
publicly). Never leave an open SOCKS5 proxy on the internet.

- Oracle: VCN → Security List → ingress `1080/tcp` from `<worker-ip>/32` only. Also `iptables`/`nft`
  on the VM to match.
- VPS: `ufw allow from <worker-ip> to any port 1080` ; `ufw deny 1080`.

## Step 4 — Smoke-test the tunnel end-to-end

From the Hetzner worker box:

```bash
# does the proxy tunnel reach a real MX on 25?
curl -x socks5://proxyuser:<PASS>@p1.<disposable-domain>:1080 \
     -v telnet://gmail-smtp-in.l.google.com:25 --max-time 10
# expect a 220 banner coming back through the tunnel
```

## Step 5 — Record it in the app config

Add each proxy to `config/verify-proxies.json` (gitignored — see `config/verify-proxies.example.json`):

```json
[
  { "id": "val1", "host": "p1.<disposable-domain>", "port": 1080,
    "user": "proxyuser", "pass": "<PASS>", "ip": "<IP-1>", "helo": "p1.<disposable-domain>" }
]
```

`helo` **must** equal the PTR name. Then continue to `02-reacher.md` and run the Phase-1 validation.

## Warm-up note (why early Gmail/M365 results look bad)

Brand-new IPs get greylisted/rate-limited by Gmail & Microsoft → many `unknown`. That's expected; the
code falls back to the free-tier API pool for those providers. As the IPs accumulate a little history
(days of low-rate probing), Gmail/M365 `RCPT` answers become usable. Keep the probing rate gentle
(the per-IP/per-provider cooldowns in `verify-emails.js` handle this).
