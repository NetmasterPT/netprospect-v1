---
title: "00 — Port-25 gate + IP hygiene (do this FIRST)"
type: how-to
tags: [outreach, email]
related: []
owner: outreach
status: stable
updated: 2026-07-19
visibility: internal
---

# 00 — Port-25 gate + IP hygiene (do this FIRST)

Outbound **port 25** is required for both validation (Reacher `RCPT` probes) and cold sending
(delivering to the recipient MX). This is the single biggest risk in the whole plan — settle it
before anything else.

> ✅ **JÁ RESOLVIDO PARA O VALIDATION FLEET (2026-07-19).** Os nossos hosts **Hetzner já têm o porto 25 de
> saída ABERTO** e os IPs **Spamhaus-limpos** — não é preciso provisionar VMs Oracle/VPS novas nem lutar com
> o gate. Testado: `de-minio`/`np-wk-de1` (DE, egress `49.12.120.250`) e `hel1-docker` (FI, `65.108.120.25`)
> devolvem `220 mx.google.com ESMTP`; ambos os IPs **ZEN-limpos**. **Os Oracle free bloqueiam o 25** (não usar
> para probing). Falta só o **PTR** (nenhum IP o tem — definir no Hetzner Robot, ver `01`/`02`). O piloto do
> Reacher usa o IP DE. Deploy concreto: [`deploy/reacher/README.md`](../../deploy/reacher/README.md). Os passos
> abaixo (Oracle/VPS + unblock ticket) só são precisos para **escalar a mais IPs** ou para o **sending fleet** (`03`).

## Step 1 — Provision a throwaway test VM

Create **one** small instance to test with (you'll keep or delete it based on the result):

- **Oracle Cloud (preferred, free):** in an **isolated compartment/account** (not production), create
  an **Always Free** instance — ARM `VM.Standard.A1.Flex` (up to 4 OCPU / 24 GB free) or an AMD
  `VM.Standard.E2.1.Micro`. It gets a free static public IPv4. Upgrade the account to **Pay-As-You-Go**
  (stays free within Always-Free limits) — required to open a support ticket for port 25.
- **Fallback (cheap VPS):** RackNerd (LowEndBox "specials", ~$10–15/yr) or Contabo (~€5/mo). These
  ship with port 25 **open** and let you set PTR in the panel.

## Step 2 — Test outbound port 25 from the VM

SSH into the VM and run:

```bash
# raw reachability to a real MX on 25 (gmail's MX shown; any works)
nc -vz gmail-smtp-in.l.google.com 25        # "succeeded" = open ; "timed out" = blocked

# full handshake proof (should print 220 banner then 250 EHLO reply)
printf 'EHLO test.example\r\nQUIT\r\n' | nc -w8 gmail-smtp-in.l.google.com 25
```

- **220/250 replies → port 25 is open.** Good — use this provider.
- **Timeout / no banner → port 25 is blocked.** Oracle blocks it by default and *often refuses* to
  unblock even on PAYG. Open a support ticket (below); if refused within a day or two, **switch to the
  cheap-VPS fallback** — do not sink time fighting Oracle.

### Oracle port-25 unblock ticket (try once)

> Subject: Request to remove outbound TCP/25 throttle
> We run internal micro-services on this tenancy and need standard outbound SMTP connectivity
> (TCP/25) for system data-hygiene/health-check handshakes with external mail systems. We are an
> established paying customer. Please remove the default egress restriction on port 25 for this
> instance's IP.

Also remove Oracle's internal firewall rules that block 25 egress if present, and ensure the VCN
**egress** security list allows all-protocols outbound (default does).

## Step 3 — Blocklist hygiene (mandatory, every IP)

A fresh cloud IP may already be listed from a previous abuser. **Check every IP before committing it**
and re-check monthly.

```bash
IP=<your.vm.ip>
REV=$(echo $IP | awk -F. '{print $4"."$3"."$2"."$1}')
for bl in zen.spamhaus.org b.barracudacentral.org bl.spamcop.net dnsbl.sorbs.net; do
  ans=$(dig +short $REV.$bl)
  echo "$bl: ${ans:-clean}"
done
```

- **All "clean" → keep the IP.**
- **Any listing (esp. Spamhaus SBL/CSS/PBL) →** for Oracle/VPS, **terminate + recreate the instance**
  to draw a new IP (cheapest fix), or request delisting at the blocklist's site. Never send/probe from
  a listed IP.
- Also confirm you can set a **PTR/rDNS** record for the IP (Oracle: VNIC → Edit → "Reverse DNS";
  RackNerd/Contabo: panel → rDNS). No PTR control = unusable for mail.

## Step 4 — Decide the two fleets

Once you have a working recipe (open 25 + settable PTR + clean IP):

- **Validation fleet:** 2–4 IPs → PTR `p1..pN.<disposable-domain>`. → continue to `01-validation-fleet.md`.
- **Cold-sending fleet:** 2–4 **different** IPs → PTR `mail.<secondary-domain>`. → `03-sending-fleet.md` (Phase 2).

Record each IP + its PTR + provider in a private note; the code's `config/verify-proxies.json` and
`config/sending-accounts.json` reference them.
