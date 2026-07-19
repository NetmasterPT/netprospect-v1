---
title: NetProspect — Outreach & Validation Ops Runbooks
type: how-to
tags: [outreach, email]
related: []
owner: outreach
status: stable
updated: 2026-07-11
visibility: internal
---

# NetProspect — Outreach & Validation Ops Runbooks

Operational runbooks for the e-mail **validation** and **cold-outreach** infrastructure. These are
the steps **you** execute (creating accounts, VMs, DNS records, PTR/rDNS) — the code in the repo
consumes what these produce. Follow them in order; nothing here touches the production Netmaster
stack.

## The one rule: isolation

Three **separate** fleets of IPs/domains, never mixed:

| Fleet | Purpose | IPs | Domains | Reputation |
|---|---|---|---|---|
| **Validation** | Reacher SMTP `RCPT` probes (no mail delivered) | 2–4 clean datacenter IPs | subdomains of the **disposable** domain (`p1..pN.<disp>`) | low stakes — just needs port 25 + PTR + not-blocklisted |
| **Cold sending** | first-touch cold outreach | 2–4 **different** clean IPs (never validation IPs) | **separate** cheap secondary domains | matters — warm-up + auth |
| **Warm (Phase 4)** | Mautic + AWS SES nurture | AWS SES shared pool | **super-validated** domains | paramount |

**Never** use production Netmaster IPs/domains for any of this. Probing taints an IP's reputation, so
validation IPs must never later be used for sending.

## Why datacenter IPs (not residential)

Residential/domestic IPs are a non-starter for sending or probing: they sit on the Spamhaus **PBL**
("should not deliver mail directly"), ISPs block outbound port 25, and receivers auto-reject. Clean
**datacenter** IPs (Oracle Always-Free, cheap VPS) with correct PTR are the right choice — provided
each IP is **blocklist-checked** before use (see `00-port25-and-ips.md`).

## Runbook order

0. `00-port25-and-ips.md` — **gate:** test outbound port 25 (Oracle vs VPS), blocklist hygiene, pick the IPs.
1. `01-validation-fleet.md` — Dante SOCKS5 + validation-domain DNS/PTR (feeds Phase 1: Reacher validation).
2. `02-reacher.md` — the Reacher service the validation engine calls.
3. `03-sending-fleet.md` — `docker-mailserver` + secondary-domain SPF/DKIM/DMARC/PTR (feeds Phase 2: cold send).
4. `04-warmup.md` — domain/IP warm-up schedule.
5. `05-esp-ladder.md` — Brevo/MailerLite engagement rung (Phase 3).
6. `06-aws-ses-mautic.md` — Mautic + AWS SES warm tier (Phase 4).

## Cost summary (target: near-zero, escalate only if needed)

- **Validation IPs:** Oracle Always-Free (free) if port 25 opens; else 2–4 cheap VPS (~$10–15/yr each).
- **Cold sending IPs:** Oracle Always-Free + the non-production Hetzner VM (free); cheap VPS fallback.
- **Domains:** validation = the disposable domain you have; cold = ~2–3 secondary domains (~€10/yr each).
- **Escape hatch** (only if inbox rates stay poor after a fair warm-up): MXRoute (~€45/yr) → Google
  Workspace / M365 mailboxes (~€6/mailbox/mo) → Instantly/Smartlead.
