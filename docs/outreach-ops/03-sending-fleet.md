---
title: 03 — Sending fleet: docker-mailserver + secondary domains + auth
type: how-to
tags: [outreach, email]
related: []
owner: outreach
status: stable
updated: 2026-07-11
visibility: internal
---

# 03 — Sending fleet: docker-mailserver + secondary domains + auth

Goal: 2–4 **separate** clean datacenter IPs (never the validation IPs, never production),
each running **`docker-mailserver`** (DMS) that: authenticates the drip's SMTP submission, signs
**DKIM**, delivers from the VM's clean IP, and receives **bounces + replies** (read by `imap-poller.js`).

Prereq: `00-port25-and-ips.md` done for these IPs (open 25 + PTR + blocklist-clean).

## Step 1 — Secondary domains (isolate from Netmaster + from the validation domain)

Buy **2–3 cheap secondary domains** (~€10/yr). Reputation is separate from the org root, so a burnt
cold domain never harms `netmaster.pt` or the disposable validation domain. One (or a few) mailboxes
per domain; spread domains across the sending IPs.

## Step 2 — DNS per sending domain

For `secondary-domain-1.tld` on IP `203.0.113.20`:

```
; MX → this domain's mail server
secondary-domain-1.tld.        MX 10  mail.secondary-domain-1.tld.
mail.secondary-domain-1.tld.   A      203.0.113.20
; SPF — authorise ONLY this IP
secondary-domain-1.tld.        TXT   "v=spf1 ip4:203.0.113.20 -all"
; DMARC — start monitoring, tighten after warm-up
_dmarc.secondary-domain-1.tld. TXT   "v=DMARC1; p=none; rua=mailto:dmarc@secondary-domain-1.tld"
; DKIM — added in Step 4 after DMS generates the key
```

Set the IP's **PTR** → `mail.secondary-domain-1.tld` (must match the HELO DMS presents). Verify:
`dig +short -x 203.0.113.20` → `mail.secondary-domain-1.tld.`

## Step 3 — docker-mailserver on the VM

```yaml
# compose.yml
services:
  mailserver:
    image: ghcr.io/docker-mailserver/docker-mailserver:latest
    hostname: mail.secondary-domain-1.tld
    ports: ["25:25", "587:587", "465:465", "993:993"]
    volumes:
      - ./mail-data/:/var/mail/
      - ./mail-state/:/var/mail-state/
      - ./mail-logs/:/var/log/mail/
      - ./config/:/tmp/docker-mailserver/
      - /etc/localtime:/etc/localtime:ro
    environment:
      - ENABLE_RSPAMD=1
      - ENABLE_OPENDKIM=1
      - ENABLE_FAIL2BAN=1
      - PERMIT_DOCKER=network
      - SSL_TYPE=letsencrypt        # or manual; a valid cert on mail.<domain> helps deliverability
    cap_add: ["NET_ADMIN"]
    restart: unless-stopped
```

```bash
docker compose up -d
# create a mailbox (this is the SMTP user the drip authenticates as)
docker exec -it mailserver setup email add goncalo@secondary-domain-1.tld '<STRONG_PASS>'
```

## Step 4 — DKIM

```bash
docker exec -it mailserver setup config dkim
# print the DNS record it generated and add it to DNS:
cat ./config/opendkim/keys/secondary-domain-1.tld/mail.txt
# -> mail._domainkey.secondary-domain-1.tld.  TXT  "v=DKIM1; k=rsa; p=MIGf..."
```

## Step 5 — Verify auth end-to-end

Send one test to a Gmail seed inbox from the mailbox, open the message → "Show original":
**SPF pass, DKIM pass, DMARC pass**. Also run it through https://www.mail-tester.com — aim for **9–10/10**
and fix anything flagged (rDNS, missing headers) before any real volume.

## Step 6 — Register in the app

Add each mailbox to `config/sending-accounts.json` (gitignored — see
`config/sending-accounts.example.json`). IMAP host/port default to the SMTP host / 993; override with
`imap_host`/`imap_port` if different. Then continue to `04-warmup.md`.

> **Deliverability reality:** a brand-new domain+IP has zero sending history — even with perfect auth,
> Gmail/Outlook are cautious at first. **Warm-up (04) is not optional.** If, after a fair warm-up,
> inbox placement stays poor, escalate per the ladder (MXRoute → Workspace/M365 → Instantly/Smartlead).
