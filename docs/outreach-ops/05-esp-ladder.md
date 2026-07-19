---
title: "05 — ESP ladder (Brevo / MailerLite)"
type: how-to
tags: [outreach, email]
related: []
owner: outreach
status: stable
updated: 2026-07-11
visibility: internal
---

# 05 — ESP ladder (Brevo / MailerLite)

A **reputation-ladder rung** between cold (Phase 2) and the warm tier (Phase 4). Send an extra
follow-up/nurture campaign through a reputable ESP whose IP pool is already trusted — it borrows their
inbox reputation **and** acts as a second engagement sieve before you invest in Mautic+SES.

## The one rule

**Only export contacts that already engaged** with your cold outreach — replied, opened, or clicked.
**Never** upload the full cold/scraped list: Brevo and MailerLite scan for cold-list patterns and will
**suspend the account and hold your contacts**. The `export-engaged-to-esp.js` filter enforces this
(responders + openers/clickers, minus DNC).

## Steps

1. Export the engaged segment:
   ```bash
   node export-engaged-to-esp.js --out=out/esp-engaged.csv --mark
   # --mark sets contacts.esp_engaged=true so you don't re-export them
   ```
2. Create a **Brevo** (or **MailerLite**) account; verify a **sending domain** there (they'll give
   you SPF/DKIM records — use one of your secondary domains, or a fresh nurture domain).
3. Import `out/esp-engaged.csv` as a list. Keep the first campaign genuinely useful/relevant
   (these people engaged — reward that, don't blast).
4. Watch their dashboard: **bounce < 2 %, spam-complaint < 0.1 %**. Their engagement data (opens/
   clicks/replies) tells you who's worth graduating to Phase 4.
5. Graduate the best engagers to the warm tier → `docs/outreach-ops/06-aws-ses-mautic.md`.

## Pull engagement back (optional)

To reflect ESP engagement in NetProspect, either (a) re-import their engagement CSV and set
`contacts.esp_engaged=true` for openers/clickers, or (b) wire the ESP webhook (Brevo → "transactional
webhooks" / MailerLite → webhooks) to a small endpoint that flips `esp_engaged`. The Phase-4 export
(`export-warm-to-mautic.js`) can then prefer `esp_engaged` contacts.

## Cost

Brevo free tier (limited daily sends) or a cheap paid tier; MailerLite similar. For the engaged
segment (hundreds, not tens of thousands) the free/cheap tier is plenty.
