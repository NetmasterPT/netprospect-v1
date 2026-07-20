# NetProspect — backlog execution roadmap

> On approval, save the canonical copy to `.claude/plans/current/backlog-roadmap.md` (repo pattern).
> **Discipline (every item):** this repo has concurrent Claude sessions committing — re-check current state
> (`git log` + grep the symbols) BEFORE touching each item; cede on collision. See [[multi-session-verify-plan]].

## Context

After shipping the smart re-verification layer (`d374db9`), the user asked for a plan to work through the
**whole remaining backlog**, verifying each item isn't already done. A 3-agent audit of the codebase (not the
stale `TODO.md` checkboxes) found that **much is already done or closed-by-decision** — the real remaining work
is smaller and re-shaped. User decisions: **lead with data-quality + verify wins**; **prep the cold-sending
stack to turnkey but do NOT go live** (infra is user-gated).

## Already done / closed — do NOT redo (audit findings)

- **Extractor CODE** (contacts/social/locality/fingerprints) already rewritten & fixed (15–19 Jul); run-on/
  HTML-encoded-JSON hazard mitigated. **Gap = the DB still holds old poisoned rows** (Phase 1b).
- **Directory filters:** flat AND *and* flat OR already ship (commit `5c38838`). Gap = nested groups + platform multi-select.
- **Moloni:** core in production; VD-write & subscriptions↔Moloni **closed by design**; FF read-only done.
  Remaining follow-ups (Documenso/Wise tokens) are **config-blocked + owned by the active Moloni session** → **CEDE**.
- **Verify capacity:** worker provisioning is a documented manual flow; **Reacher multi-IP is already supported in
  `lib/reacher.js`** (proxy list) — only the ops/automation is single-IP.
- **snapshot-regen** script + **coverage dashboards** + per-job **band-enqueue** tooling all exist.
- **Bookings foundation** (`Agendamentos`: GCal+Notion+Directus) built; only a public "Book Call" page is missing.

---

## Phase 1 — Data quality + verify wins  *(LEAD)*

### 1a. Verify quick wins (hours, high ROI)
- **`mail_provider` backfill** — new `backfill-mail-provider.js` (model on `backfill-verify-metadata.js`): per
  distinct domain → `resolveMx` (`lib/email-verify.js`) → `providerClass` (`lib/reacher.js`) → bulk
  `UPDATE contacts SET mail_provider`. Rate-limited MX loop; network-bound.
- **Orphan requeue** — **check live first** (`GET /api/queues`; the ~959 may have aged out via the stream's 48h
  MaxAge). If `verify` pending==0 and orphans>0: `POST /api/queues/verify/orphans {mode:"requeue"}` (endpoint exists,
  `dashboard/server.mjs:1202`). No code.
- **`.se` timeout churn** — `lib/reacher.js` maps both transport failure (`AbortController` timeout / `"fetch
  failed"`) and genuine SMTP `unknown` to `status:'unknown'`. Distinguish transport errors so `reverifyAfter`
  (`lib/verify-core.js:41`) does NOT stamp them +5d (which re-queues every 5d → churn). Either a distinct transient
  status or skip the `reverify_after` bump on transport error.
- **GMB resume bug** — `enqueue-fine-audits.js:50` resumes on `gmb_name` but the ran-marker is `gmb_checked_at`;
  sites checked-with-no-match get re-enqueued forever. One-line fix (`resume: 'gmb_checked_at'`).

### 1b. Poison-DB by-band re-run (the crux — M, highest downstream value)
The fixed extractors only run inside a full `fetch` fan-out, dedup is **insert-only** (a naive re-run can't fix
poison), and most MinIO snapshots were pruned/homepage-only (no contact-page HTML). Design — a **`reextract`
variant of `jobs.fetch`**:
- **`lib/artifacts.js` / `handleFetch`** — stamp `full: !job.snapshotOnly` on the snapshot bundle
  (`worker/handlers.mjs:182`). Add a `job.reextract` branch after `ensureSite`: if a **full** snapshot exists
  (`snap.full===true || snap.pages?.length`) → skip network, fan out to all extractors; else fall through to the
  existing full-fetch (which re-fetches homepage + contact pages).
- **`handleContacts`** — under `job.reextract`, **purge-then-reinsert**: delete only *stale machine* contacts
  (`source='site' AND reviewed=false AND do_not_contact=false AND email_status IS NULL AND id NOT IN (SELECT
  contact FROM emails …)`) — preserves manual edits, DNC, verified, and email-linked rows — then the existing
  insert re-adds clean rows. Also fix the **sticky `has_decision_maker`** (`handlers.mjs:351` only ever sets
  true): compute `found.some(p=>p.role_category==='decision_maker')` so a clean re-extract can clear a false positive.
- **`lib/pgwrite.js`** — add `pgDeleteStaleSiteContacts(siteId)` (+ optional `pgClearSitePlatforms`); Directus
  fallback via `deleteItems` when PG off.
- **`enqueue-reextract.js`** (clone `enqueue-fine-audits.js`) — `--min-score`/`--by-score` (highest-value first,
  keyset cursor) + resume via `contacts_checked_at < FIX_DATE` (default 2026-07-14) so completed sites skip.
  Run band-by-band from **>60 down**. Re-score is automatic (each extractor publishes `jobs.score`).
- **Risks:** manual-but-unmarked edits are purged (guard = `reviewed=true`, document it); `emails.contact`
  orphaning (guarded by the `NOT IN emails` clause); cost when snapshots pruned (bounded by band).

### 1c. Run the >50 coverage bands on CLEAN data (OPS)
After 1b cleans a band, enqueue the remaining audits for it: `enqueue-snapshot-regen.js` (industry, ~30h),
lighthouse (`browser` role), whois (~1.3k), ssl — each via `--min-score`. GMB stays laptop/residential-bound
(structural — just keep the resume fix; don't force scale).

## Phase 2 — Cold-sending: prep to turnkey (NO go-live)
Code is ready; infra undeployed. Build the missing artifacts so it's a one-command deploy once the user provisions IPs/domains:
- **`deploy/mailserver/`** — `docker-mailserver` compose (OpenDKIM/rspamd/fail2ban) + per-domain SPF/DKIM/DMARC
  templates (lift the inline compose from `docs/outreach-ops/03-sending-fleet.md`). No such dir exists today.
- **Code tidy** — point `handleCampaignSend` (`worker/handlers.mjs:504`) at `makeMailerPool` (multi-account) instead
  of the single-transport `sendEmail`; wire `config/sending-accounts.json` (example exists; `campaign-drip.js` already reads it).
- **Go-live runbook** — provisioning + warm-up steps. `SMTP_HOST` stays empty (dry-run) until the user provisions. **No live send.**

## Phase 3 — Capacity: Reacher 2nd IP + worker scaling  *(includes the user's TODO-KEYS.md request)*
- **`TODO-KEYS.md`** — add a section **"## 4. Capacidade de verify — mais workers / 2.º IP Reacher"** documenting:
  add-a-VM (`bootstrap-vm.sh` + set `WORKER_ROLES=verify` via dashboard fleet-env) and add-a-Reacher-IP
  (FCrDNS `p2.<domain>`→new IP + 2nd tailnet-bound Dante + one entry in `config/verify-proxies.json`).
- **`deploy/reacher/activate.sh`** — extend with an `add-proxy` mode (currently hardcoded single-IP) so the 2nd IP
  is one command. `lib/reacher.js` already round-robins a proxy list — no code change there.

## Phase 4 — Directory + product features
- **SSL cert types** (`handleSsl`, `worker/handlers.mjs:390`): EV via CA/B policy OID (`2.23.140.1.x`) from cert
  extensions + Multidomain via SAN count. Sectigo paid/free = flag uncertain (needs vendor API, not the served cert).
- **Nested AND/OR groups** (`buildSiteFilters` `dashboard/server.mjs:160` + filter UI): filter-group model + nested
  `_and`/`_or` builder + group UI. M-L; needs live test.
- **Platform multi-select** — OR is easy (`[slug][_in]`); AND-across-platforms is semantically odd (one
  `primary_platform`/site) → design note.
- **Public "Book Call" page** — public route + availability UI on GCal free/busy + existing `POST /api/agendamentos`.

## Phase 5 — New data sources (greenfield, L each; by value)
- Company registries: **Racius (PT)** + brreg (NO) / bolagsverket (SE) / PRH·YTJ (FI) / KVK (NL) → named roles,
  company scale, financials. Endpoints already researched in `.claude/plans/dev/prospecting.md`. Each = fetcher +
  handler + schema fields + enqueue + coverage wiring.
- **Better monthly traffic** — Tranco rank is structurally low-coverage; integrate a real estimate source. M-L.

## Phase 6 — Store / Stripe / Client Portal (greenfield, L; last)
Stripe checkout/PaymentIntent/webhook/subscription endpoints (only the `lib/stripe.js` client stub exists), Sell
flow, Client Portal, Netmaster-store integration. Biggest, lowest urgency.

## Cede / user-gated (not in my execution path)
Moloni follow-ups (active session; config-blocked) · sending GO-LIVE (user IPs/domains + weeks warm-up) · GMB
at-scale (residential IPs) · bulk compute runs (coverage bands, ~30h regen) = OPS.

## Verification (per phase)
- **1a:** PG spot-checks — `mail_provider` populated; orphans 0; `.se` timeouts no longer stamped +5d; GMB no longer re-runs checked sites.
- **1b:** take the poisoned sites from `DATA-BENCHMARK.md`, re-run, confirm invalid people purged, socials/address
  now correct, `has_decision_maker` corrected, `lead_score` recomputed; verify manual/verified/emailed rows survive.
- **2:** `docker-mailserver` stands up in test; `handleCampaignSend` uses the pool; still dry-run (no live send).
- **Every phase:** `node --check` changed files; commit **only my files**; push; confirm fleet convergence (~5 min).

## Notes
- Each phase is independently shippable + reversible; commit per phase to `main` (the fleet pulls `main`).
- `TODO.md` checkboxes are stale — trust the code. Re-audit state before each item.
