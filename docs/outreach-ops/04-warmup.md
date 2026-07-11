# 04 — Domain & IP warm-up

New domain+IP = zero sending history → Gmail/Outlook distrust it. Warm-up builds reputation
gradually so real cold sends land in the inbox. **Do not skip.**

## The ramp (enforced by `campaign-drip.js`)

The drip caps each account's daily sends by a warm-up stage that advances one step per day:

```
WARMUP_RAMP (per account, per day): 5 → 10 → 15 → 25 → 35 → 50   (then steady at warmup_max)
```

So a mailbox does ≤5 sends day 1, ≤10 day 2, … up to its `warmup_max` (default 50). With 3 mailboxes
that's ~150/day at first, ~450/day once warmed. State (`warmup_stage`, `sent_today`, `daily_cap`)
lives in the Directus `sending_accounts` collection and is visible/editable.

## Two warm-up phases

1. **Engagement warm-up (week 1–2, before cold volume):** send low volume to **seed inboxes that will
   open + reply** — your own mailboxes across Gmail/Outlook/Yahoo, colleagues, a warm-up pool. Positive
   engagement (opens, replies, "not spam") is what teaches the filters to trust the domain. Options:
   - Manual seed list (10–20 friendly addresses) the drip sends to first.
   - Or a warm-up service that auto-exchanges mail (many exist; some free tiers).
2. **Cold ramp (week 3+):** point the drip at real cold campaigns; the `WARMUP_RAMP` keeps volume
   climbing slowly while you watch the metrics.

## What to watch (stop/slow if these move)

- **Bounce rate < 2 %** (the `imap-poller.js` marks bounces → DNC; a spike means dirty list → validate more).
- **Complaints / spam < 0.1 %** — register the domains in **Google Postmaster Tools** (Gmail spam rate)
  and check Microsoft SNDS. A rising spam rate = pause, review copy/targeting.
- **Inbox placement** — periodic mail-tester / seed-inbox checks (inbox vs spam folder).

## Tightening DMARC

Start `p=none` (monitor). After ~2–4 weeks of clean `rua` reports showing SPF+DKIM aligned, move to
`p=quarantine`, then `p=reject`. This protects the domain from spoofing and signals maturity to receivers.

## When to escalate (the ladder)

If, after a fair warm-up, inbox rates stay poor (cloud IP reputation can cap you): MXRoute (~€45/yr,
better shared reputation) → Google Workspace / M365 mailboxes on the secondary domains (~€6/mailbox/mo,
best inbox) → Instantly/Smartlead (managed cold-email sending + built-in warm-up). The drip's
`config/sending-accounts.json` accepts any SMTP endpoint, so escalating is just swapping the account host.
