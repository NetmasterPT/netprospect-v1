# 07 — Smart re-verification policy (provider + TTL + email-quality lead score)

> The verify fleet doesn't just **record** a result any more — it **acts** on it: valid/catch-all
> emails are re-checked on a decay schedule, permanents are never re-probed, catch-all/hard-block
> domains are skipped, and a verified-deliverable email now **lifts the lead score**. This is the
> `reacher-coordinated-plan` delta on top of the routing/detail work already in `verify-core.js`.

## Why

Deliverability **decays** (people leave, mailboxes fill, domains lapse), so a `valid` from 6 months
ago is not a `valid` today — but the old engine wrote `verified_at` and **never read it**, so nothing
was ever re-checked. At the same time it kept re-probing **permanent** answers (`no_mx`, `invalid`,
`role`) for nothing, let **B2C mega-domains** (jouwweb/ISP shared domains, hundreds of contacts each)
monopolise a batch, and scored a `valid@real-company` no higher than a `catch_all@website-builder`.

## The four persisted fields

| Field | Table | Meaning |
|---|---|---|
| `reverify_after` | `contacts` (ts) | when this contact becomes eligible again — **NULL = never** (permanent) |
| `mail_provider` | `contacts` (enum: gmail·microsoft·yahoo·corp) | MX class at verify time — segment & prioritise |
| `catch_all` | `companies` (bool) | domain accepts anything → probing can't distinguish real mailboxes |
| `blocks_probing` | `companies` (bool) | corporate MX that consistently refuses the SMTP handshake |

`mail_provider` comes from `providerClass(mx)` (already computed for routing). The **decision** lives
entirely in `reverify_after` — there is deliberately no separate `verify_reason` column; the human-readable
reason is already in `email_verify_detail.smtp_reason` (from the other session's work).

## The re-verification schedule (`lib/verify-core.js` → `reverifyAfter(status, cls)`)

| `email_status` | provider / detail | `reverify_after` |
|---|---|---|
| `valid` | — | **now + 90 d** (deliverability decay) |
| `catch_all` | — | now + 180 d (or skipped entirely via `company.catch_all`) |
| `unknown` | **big provider** (Gmail/M365/Yahoo) | **NULL** — re-probing won't help; already API-only |
| `unknown` | corporate (transient/greylist) | now + 5 d |
| `role` · `invalid` · `disposable` · `no_mx` | — | **NULL** — permanent, never re-probe |

Domain flags are written **once per domain** at the end of `verifyDomain`: `companies.catch_all` from
`classifyCatchAll`, and `blocks_probing` when the corporate probes return `canConnect=false` consistently
(≥3 unknowns, no valids, not catch-all) — e.g. `abion.com`, `coast.no`.

## Selection (both enqueue paths must agree)

Automated daily (`POST /api/verify/enqueue`, `dashboard/server.mjs`) **and** manual
(`enqueue-email-verification.js`) select the same population:

```
eligible ⟺ (email_status IS NULL OR reverify_after < now())   -- permanents (NULL) excluded
         AND company.blocks_probing = false                    -- skip hard-block domains
         AND site.qualified AND site.is_live                    -- (dashboard path; gated leads only)
```

- **B2C deprioritisation:** domains with **> 20** eligible contacts sort *last*
  (`ORDER BY (count(*) > 20) ASC, max(lead_score) DESC`) — real companies drain first.
- **Per-domain cap:** one `jobs.verify` per `org_domain`; the worker processes at most
  `VERIFY_MAX_PER_DOMAIN` (default **50**) contacts per domain per run — the rest stay eligible for the
  next batch. This is the B2C cap (enforced worker-side, so both enqueue paths inherit it).

> ⚠️ The relational `site` filter in `enqueue-email-verification.js` must stay a **top-level** key
> (`{_or, company, site}` = implicit AND). Wrapping it in `_and:[…]` makes the Directus SDK treat
> `site` as `contacts.site = <object>` → `NaN` → 400. (`company` single-field is fine inside `_and`.)

## Email quality in the lead score (`has_valid_email`, weight 10)

Quality lives on `contacts`; the score is per-`sites` → **rollup**. At the end of `handleVerify`, if the
domain got ≥1 `valid`, the site is marked `has_valid_email=true` (via `pgUpdateSite`, PG-direct — the
column is in the `pgwrite.js` allow-list + type map) and a `jobs.score` is published. The signal is wired
in **both** score paths (repo rule): `lib/lead-score.js` `SCORE_SIGNALS` + `config/lead-score.json`
weight, **and** `score-leads.js` `signalSql` + `SCORE_FIELDS` in `worker/handlers.mjs`.

A verified-deliverable email is a strong buy signal — it means outreach will actually land.

## Backfill (one-off, already run 2026-07-19)

Contacts verified **before** this code have `reverify_after=NULL` (→ frozen out of re-verification) and
their sites are unmarked. `backfill-verify-metadata.js` fixes all of it in bulk SQL (idempotent):

```bash
node backfill-verify-metadata.js --dry-run   # preview counts
node backfill-verify-metadata.js             # apply
node score-leads.js                          # propagate has_valid_email → lead_score
```

It sets `sites.has_valid_email` (≥1 valid), `contacts.reverify_after` by policy (valid +90d / catch_all
+180d / unknown +5d; permanents left NULL), and `companies.catch_all` (≥1 catch-all contact). It does
**not** backfill `mail_provider` (needs a per-domain MX lookup) — that fills on the next re-verify.

*First run marked 1115 sites `has_valid_email`, set `reverify_after` on 2711 contacts, flagged 195
catch-all companies.*
