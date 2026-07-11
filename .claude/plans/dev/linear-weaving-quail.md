# Plan: Data completion & validation, then the TODO.md backlog (outreach paused)

> **Scope note.** The outreach/validation plan (Reacher + cold ladder, Phases 0–5) is **built and
> paused** — code is in the repo, live paths await user-provisioned VMs; it's preserved in README
> (Deferred Follow-Ups) + memory (`netprospect-email-outreach`). This file now covers what comes
> **first**: finish the enrichment/extraction jobs, complete + validate all collected data, fix bugs,
> then work the `TODO.md` backlog. No production IPs/domains are touched.

## Context

The corpus is ~979k sites / ~461k qualified / ~236k contacts, but the data has concrete gaps and bugs
(measured via SQL this session):

- **`.no` contact extraction is 90 % incomplete** (7,021 of 66,150 qualified extracted) and **`.pt`
  ~35 % incomplete** (28,840 of 44,516) — the enrichment/extract jobs never finished for these TLDs.
- **`.pt`/`.no` already-extracted contacts are pre-Phase-A** (role_category 0.2 %/0 %, phone_country
  0 %, social 0 %). `.se`/`.fi` are complete (role_category 77–100 %).
- **Email verification 0 %** — `email_status` is null for all 236k contacts (never run).
- **domain-health ~77–80 %** (ssl/dns backfill paused at 104k qualified remaining); **CMS version ~0 %**.
- **5,013 duplicate-email contacts** (cross-company dupes) — a real bug.
- **Clean:** 0 garbage emails/companies (the run-on fix held); orphans negligible; `has_decision_maker`
  low (0.4 %) but *correct* — only ~4k contacts are decision-makers (SME reality), not a rollup bug.

`TODO.md` is the forward backlog (repo cleanup, Redis, config pages, dashboard pages, CSV import,
public pages, AI agents). User picked **all four** near-term clusters after the data work.

**Machine reality:** only the **NL enrich stream** runs now (~23 % of 765k, load ~8.8). Earlier we hit
CPU/Directus saturation (load ~17) running the domain-health backfill alongside enrich — so heavy
re-work is sequenced/throttled (worker-base concurrency knobs `DOMAIN_HEALTH_CONC`/`SCORE_CONC` exist).

---

## PART A — Data completion, validation & bug-fixing (do first)

### A1 — Let the running jobs finish
NL `enrich → extract` (via `run-parallel-tlds.sh`) is in progress and self-completes. Monitor
`out/enrich-nl-p.log`; no action beyond keeping the box healthy.

### A2 — Re-extract `.pt` + `.no` contacts (`--force`, per user)
Run `extract-contacts.js --tld=no --force` and `--tld=pt --force` → re-extracts **all** qualified
.pt/.no sites with the current code, giving full Phase-A fields (role_category, phone_country, E.164,
per-person social) and fixing the .no under-extraction. ~110k site re-crawls — run as **throttled
streams** (moderate `--concurrency`, watch load; ideally after/around NL enrich to avoid the earlier
saturation). This is the bulk of "the jobs must run."

### A3 — Cheap residual backfills (SQL/script, fast)
After A2, sweep any residue: role_category re-derive (`lib/contacts.js roleCategory()`) for contacts
with `role` but null `role_category`; `phone_country` from the stored E.164 phone; `has_decision_maker`
rollup recompute. Then **`requalify.js` + `score-leads.js`** to refresh qualification + lead score
against the updated data.

### A4 — Resume domain-health backfill
Restart `worker-base` (currently stopped) with low `DOMAIN_HEALTH_CONC`/`SCORE_CONC`; re-run
`enqueue-domain-health.js --only=ssl,dnsprovider` (resumable, ~104k qualified left) once NL frees CPU;
optionally `--only=cms` (fingerprint re-fetch — heavy, ~0 % coverage) and bounded `--only=whois`.

### A5 — Email verification via APIs (enhanced) — per user
Turn on verification **now** through the API tier (no SMTP VMs needed — providers do the probe), and
**maximise free limits**:
- **`lib/verify-providers.js`:** support **multiple API keys per provider** (config = array; already
  round-robins per-account, formalise `apiKeys:[…]`), **integrate more free providers** (research +
  add adapters: e.g. MyEmailVerifier, MailboxLayer, Bouncer, DeBounce, Verifalia, Kickbox — whichever
  expose a free tier + REST verify), and **optional proxy routing** of the HTTP calls (undici
  ProxyAgent) so IP-rate-limited providers get one free quota per proxy IP (inactive until
  `config/verify-proxies.json` exists — the outreach clean proxies).
- **`config/verify-providers.json`** (user is adding the first QuickEmailVerification key to
  `verify-providers.example.json`). Only QEV has a **daily** free tier; others are low per-account →
  the multi-key/multi-provider/proxy fan-out is what makes this worthwhile.
- Run `verify-emails.js` over the ~84k contacts-with-email (API path; corporate limited by quotas,
  Gmail/M365 reliable via APIs). The Reacher/SMTP path stays deferred to the outreach VMs.

### A6 — Data validation audit + bug fixes
- **Dedup the ~5k duplicate-email contacts** (cleanup script: keep the richest row per email, merge
  source/role, delete the rest; guard the campaign/emails relations).
- **Quality audit report** (`audit-data.js`, new): coverage %/nulls/orphans/garbage/consistency across
  sites/companies/contacts, per TLD → prints a report; fix what it surfaces.
- Re-run A3's requalify/score after fixes.

**Part A verification:** re-run the SQL coverage queries from this session (role_category/phone_country/
social/email_status per TLD; ssl/dns coverage; dup count) and confirm the gaps close; spot-check
samples; `verify-emails.js --dry-run` shows correct routing.

---

## PART B — TODO.md backlog (all four clusters; ordered)

Dashboard pattern for every new page (from the map): new `/api/*` in `dashboard/server.mjs` (reuse
`d`/`count`/`dwrite`/`siteFilterParts`/`buildSiteFilters`) + `viewX()` + `ICONS` entry + `renderNav`
row + `route()` branch in `dashboard/public/index.html`. **Each cluster ends by updating README** +
the **Pending retirement** + **Deferred Follow-Ups** sections (process carried from prior phases).

### B1 — Performance + cleanup (foundation)
- **Redis** service (compose) + a small server-side cache layer in `server.mjs` for the heavy live
  queries — `/api/stats` (many aggregates), directory/segment counts — with short TTL + explicit
  invalidation on writes. Directly fixes "está a ficar lento" (today every request hits Directus live;
  no cache anywhere).
- **Repo cleanup** — delete the **Pending retirement** items *after user sign-off*: `lib/proxy-pool.js`
  free-list + `data/proxies.json`, the `smtpProbe` fallback in `lib/email-verify.js` (keep prefilter
  helpers), the unused `email_templates` collection, the no-op `verify` NATS slot, obsolete
  `.claude/conversations/smtp-verification-plan.md`.

### B2 — Workers observability (greenfield endpoints)
- New **`/api/workers`** endpoints: queue depth per consumer (`jsm.consumers.info(NP_JOBS, durable)` →
  `num_pending/num_ack_pending/num_redelivered`), stream state (`streams.info` → messages/bytes),
  consumer catalog + roles from `CONSUMERS` (`lib/jobs.js`). Nothing exposes this today.
- Dashboard pages: **Workers Queue** (live depth per subject), **Queue Statistics**, **Workers**
  (instances/roles/concurrency). **Logs** need a sink (workers log to stdout only) → capture via
  Docker/Loki or a lightweight log store; scope as a sub-task.

### B3 — Data pages + CSV import
- **Clients** (converted): add an `is_client`/`client` concept (a `companies.is_client` flag +
  optional `clients` collection for deal metadata) + a Clients page.
- **ISPs discovered**: aggregate `sites.isp` (extend the top-12 `byIsp` in `/api/stats` to a paginated
  endpoint + drill-down) — no new collection needed (`isp` is a first-class column).
- **CSV import**: multipart upload endpoint (+ `csv-parse` dep; export is dependency-free today) →
  map + upsert into contacts/companies/sites/ISPs/segments/campaigns/clients/triggers. The model is
  import-ready (`contacts.source` already has `csv_import`). Column-mapping UI + dedup on import.

### B4 — AI Agents (Orchestrator / Planner / Audience Creator)
- **Extract `lib/ollama.js`** — the `/api/generate` + JSON-schema `format` + AbortController pattern is
  duplicated in `campaign-ai.js` + `ollama-classify.js`; make one shared client with structured output.
- **Audience Creator** — NL target → Directus filter object (a `segments` row) by querying the model
  against our schema/enums; reuses `siteFilterParts`.
- **Planner** — suggests campaigns/products/audiences from the data.
- **Orchestrator** — a chat page that can launch the sub-agents (Campaign Creator already exists as
  `campaign-ai.js`). New **AI Agent Chat** dashboard page + `/api/agents/*` endpoints.

### B5 — Config pages + public pages + outreach dashboards (tie-in, later)
Grouped because they pair with the outreach work when it resumes:
- **Config pages** (Proxies, Mail Servers, Workers, Cold/Semi-Warm/Warm outreach) — UI over the
  config files/collections (`verify-proxies.json`, `sending-accounts` collection, worker env,
  `campaign-angles.json`). *Security:* editing gitignored secrets via UI needs care (write to the
  runtime file / a secrets store, never commit).
- **Public pages** (company report summary → full report → Book Call → Buy) — the email CTA landing
  pages that convert prospects; tie to the outreach campaigns + a `site_reports`/company view.
- **Semi-warm / warm outreach dashboards + logs + stats** — land with outreach Phases 2–4.

---

## Critical files
Data: `extract-contacts.js`, `requalify.js`, `score-leads.js`, `enqueue-domain-health.js`,
`lib/contacts.js` (roleCategory), `lib/verify-providers.js` (multi-key/providers/proxy),
`verify-emails.js`, new `audit-data.js` + a dedup script. Backlog: `dashboard/server.mjs` +
`dashboard/public/index.html` (every page), `docker/docker-compose.yml` (+redis), `lib/jobs.js`
(consumer info), new `lib/ollama.js`, `bootstrap-directus.js` (clients flag, import), README.

## Sequencing & risks
- **Order:** A1→A2→A3 (data complete) → A4/A5/A6 (backfill/verify/validate, throttled) → B1 (perf/
  cleanup) → B2 → B3 → B4 → B5 (with outreach). Data work first (user's directive).
- **Top risk:** CPU/Directus saturation from A2/A4 alongside NL enrich (we hit load ~17 before) →
  throttle concurrency, sequence after NL, watch load. Never touch production IPs/domains.
- **Sign-off gate:** repo cleanup (B1) deletes files only after the user reviews the Pending-retirement list.

## Verification (per part)
SQL coverage re-checks after A; `verify-emails.js` API run cross-checked vs `email_status` distribution;
each new endpoint smoke-tested vs Directus; Redis cache hit/miss + invalidation checked; new dashboard
pages loaded + anchors/README validated (as in the prior Phase-G/5 passes).
