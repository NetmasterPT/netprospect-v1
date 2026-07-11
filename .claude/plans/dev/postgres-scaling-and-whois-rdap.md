# Plan: Postgres/Directus write-scaling + WHOIS-via-RDAP at fleet scale

Two independent workstreams the user green-lit:
- **Part A** — make the write path survive **dozens of fleet workers** (today 2 workers + 1 standalone
  already push Postgres to ~9 cores).
- **Part B** — replace the port-43 WHOIS with an **RDAP-first, tiered** solution that works for every TLD
  we run, free, with strong rate-limit handling across many fleet IPs / API keys.

> Measured baseline (2026-07-11): the bottleneck is **the write PATH, not raw Postgres**. Every field
> update is `worker → Directus REST (HTTP+auth+permission+hooks+validation+1-row upsert) → Knex →
> Postgres` — thousands of tiny transactions. Postgres tuning + score-collapse + async ClickHouse are
> already shipped; the next wins are structural.

---

## PART A — Postgres + Directus write-path scaling

Ordered by **impact ÷ risk**. Each phase is independently shippable and reversible.

### A1 — PgBouncer (transaction pooling) — *do first, lowest risk, essential for the fleet*
**Why:** dozens of fleet VMs each open Postgres connections over the tailnet; each Postgres backend is a
process (~10 MB) and `max_connections` is finite. PgBouncer in **transaction mode** multiplexes hundreds
of client connections onto ~20-40 real backends.
**How:**
- Add `pgbouncer` service to `docker/docker-compose.yml` (image `edoburu/pgbouncer` or `bitnami/pgbouncer`),
  `pool_mode=transaction`, `default_pool_size=25`, `max_client_conn=1000`, `max_db_connections=40`
  (≤ Postgres `max_connections=200`). Bind on the tailnet (like `nats`) so fleet workers reach it.
- Point **Directus** (`DB_HOST=pgbouncer DB_PORT=6432`) and **all workers** (`lib/directus.js` stays on
  Directus REST for now; the *direct-PG* path in A2 connects to PgBouncer) at PgBouncer, not Postgres.
- Caveat: transaction mode forbids session-level features (prepared statements w/ names, `SET`, advisory
  locks across statements). Directus + our simple upserts are fine; disable server-side prepared statements
  in the Knex/pg client (`?prepared=false` / `statement_cache_size=0`).
**Verify:** `SHOW POOLS`/`SHOW STATS` on PgBouncer (`psql -p 6432 pgbouncer`); Postgres
`SELECT count(*) FROM pg_stat_activity` stays ~pool-size under load; host jobs still clean.
**Rollback:** point services back at `postgres:5432`.

### A2 — Direct-Postgres bulk write path in workers (behind `DIRECT_PG_WRITE`) — *biggest single win*
**Why:** removes the Directus-REST tax (HTTP + auth + permission + hooks + validation) from the hot path.
Directus stays for the dashboard reads + schema; **machine-written enrichment data doesn't need Directus
validation** — we own its shape.
**How:**
- New `lib/pgwrite.js`: a small `pg` (or Knex) client to PgBouncer with helpers:
  - `upsertSite(domain, patch)` → `INSERT INTO sites(domain,…) VALUES(…) ON CONFLICT (domain) DO UPDATE SET …`
  - `upsertContacts(rows)` / `upsertCompany(org, patch)` — multi-row `INSERT … ON CONFLICT`.
  - all parameterised; column allow-list mirrors the Directus schema.
- In `worker/handlers.mjs`, gate each `client.request(updateItem/createItem …)` behind
  `if (DIRECT_PG_WRITE) pgwrite.upsertSite(...) else client.request(...)`. Keep the Directus path as
  fallback/default so we roll out gradually (enable on `worker-base` first).
- **Reads** that the handlers do (e.g. `siteRow`, dedup lookups) also move to `pgwrite` selects (cheaper
  than Directus reads) — same flag.
**Risks:** bypasses Directus hooks (none critical for enrichment); must keep the column allow-list in sync
with `bootstrap-directus.js` (add a test that asserts every written column exists). PostGIS/relation writes
(`sites_platforms` m2m) handled with explicit inserts.
**Verify:** row-count + spot-checks equal between REST and direct path on a sample TLD; Postgres CPU per
1000 jobs drops materially (measure jobs/min at fixed load before/after).

### A3 — Write-behind aggregator (NATS `results` → batched upserts) — *the fleet multiplier*
**Why:** even direct single-row upserts are one transaction each. With dozens of producers, batching
turns N tiny commits into a few big ones → collapses WAL/commit overhead (the real cost once
`synchronous_commit=off`).
**How:**
- Workers publish their result rows to `jobs.result.site` / `jobs.result.contact` (small JSON) instead of
  writing inline (flag `WRITE_BEHIND`).
- A small pool of **writer workers** (`worker/writer.mjs`, role `writer`) consume, buffer, and flush every
  `≥500 rows` or `1s` via multi-row `INSERT … ON CONFLICT` / `COPY … ` into a temp table + upsert-join.
- Idempotent (ON CONFLICT), ordered-enough (last-writer-wins per domain is fine — enrichment is
  convergent). Backpressure: writer lag visible via the `jobs.result.*` consumer depth on the Filas page.
**Risks:** a crashed writer loses its in-memory buffer → but the NATS msg is only acked after flush, so it
redelivers (at-least-once). Keep buffers small.
**Verify:** load test — 8 simulated fleet producers → writer pool sustains without Postgres > N cores;
compare commits/sec (`pg_stat_database.xact_commit` delta) vs A2.

### A4 — Kill remaining write amplification
- **`score` single-statement:** `handleScore` does `SELECT SCORE_FIELDS` then `UPDATE`. Fold into one
  `UPDATE sites SET … WHERE id=$1 RETURNING …` (compute in SQL where trivial) or keep read but drop the
  redundant re-reads. Already collapsed 7→1 pubs + async ClickHouse (shipped).
- **Global recomputes = bulk SQL, never per-site jobs.** Codify the pattern we used for `traffic`
  (`backfill-traffic.sh`), `requalify.js`, `score-leads.js`: any corpus-wide recompute is one
  `UPDATE … FROM …`, not a queue fan-out.
- Batch the contacts insert loop in `handleContacts` (currently one `createItem` per person) into one
  multi-row insert.

### A5 — Read replica for the dashboard
**Why:** the dashboard's heavy aggregates (already Redis-cached) still hit the primary on cache-miss;
isolate them so analytics never contends with writes.
**How:** a streaming physical replica (`postgres-replica` service, `primary_conninfo`), Directus/dashboard
read-only queries → replica (Directus doesn't natively split; simplest is a second read-only Directus or
the dashboard's `pgwrite`-style read client pointed at the replica for `/api/stats`/`/api/isps`).
**Verify:** primary write throughput unaffected while dashboard hammered; replica lag < few sec.

### A6 — Postgres vertical/storage finalisation (last lever)
Already: `shared_buffers=12GB`, `work_mem=48MB`, `effective_cache_size=64GB`, `synchronous_commit=off`,
`max_wal_size=8GB`, `shm_size=2gb`, `DB_POOL_MAX=40`. Add if still WAL-bound: `wal_compression=on`,
`checkpoint_timeout=15min`, `bgwriter_lru_maxpages` up, confirm data dir on **NVMe**. Bigger box only if
A1-A5 still saturate.

**Recommended fleet topology (end state):**
`fleet workers → (tailnet) → PgBouncer(txn pool) → Postgres primary`, workers doing **direct bulk
upserts** or **write-behind**, Directus + dashboard reading from a **replica**, global recomputes as
**bulk SQL**. Sequencing: **A1 → A2 → A4 → A3 → A5 → A6** (A4 is cheap and helps everywhere; A3 before
onboarding many fleet VMs).

---

## PART B — WHOIS via RDAP (tiered, per-TLD, rate-limit-hardened)

### Research findings (live-tested 2026-07-11)

| TLD | RDAP endpoint | RDAP result | Port-43 (whoiser) result | Chosen primary |
|---|---|---|---|---|
| **.nl** | `https://rdap.sidn.nl/` | ✓ registrar + `registration` (**no expiry**) | registrar + created | **RDAP** |
| **.no** | `https://rdap.norid.no/` | ✓ registrar + `registration` (**no expiry**) | registrar + created | **RDAP** |
| **.fi** | `https://rdap.fi/rdap/rdap/` | ✓ `registration` (**no expiry**) | (untested) | **RDAP** |
| **.se** | none (rdap.se = lander, rdap.iis.se = NXDOMAIN) | — | ✓✓ registrar + created + **expiry** | **Port-43** |
| **.pt** | `rdap.dns.pt` = **NXDOMAIN** (no public A) | — | ✗ all NULL (DNS.pt restrictive) | **WhoisXML** (best-effort) |

> **`.pt` RDAP re-validated twice on the Hetzner VM (with a browser User-Agent), 2026-07-11 — it does NOT
> exist:** `rdap.dns.pt` is **NXDOMAIN on THREE independent resolvers** (system `ENOTFOUND`, Google DoH,
> Cloudflare DoH); `rdap.pt.pt` NXDOMAIN too. This is **not** a firewall/Cloudflare block — Cloudflare-proxied
> hosts *resolve* (to anycast IPs) then 403/challenge; NXDOMAIN means the name doesn't exist. The `dns.pt`
> apex isn't even behind Cloudflare (`Server: Apache`, no `cf-ray`). `dns.pt/…` + `www.pt.pt/rdap/…` → **404**;
> `rdap.org/domain/<d>.pt` → 404 (IANA bootstrap doesn't list `.pt`). Control: `rdap.norid.no` returns **200**
> from the same VM + same UA, proving outbound HTTPS works. **DNS.PT has not deployed a public RDAP server** —
> a browser UA can't fix a non-existent DNS record. (The circulating Gemini snippets used a broken URL, a
> *fabricated* example response, and hallucinated citations.)

**Hard truths that shape the design:**
1. **RFC 9083 standardises the FORMAT, not the CONTENT.** Expiry, *when published*, is always
   `events[].eventAction: "expiration"` — so the parser captures it **opportunistically** for any TLD
   (future-proof: gTLDs, or if a ccTLD starts publishing it). **But registries choose what to populate.**
   Verified 2026-07-11 by dumping the full `events[]` + `grep expir` on the raw JSON: `.nl` (SIDN), `.no`
   (Norid), `.fi` (Traficom) **omit `expiration` entirely** (only `registration`/`last changed`). No method
   (RDAP *or* WHOIS *or* WhoisXML) can surface what the registry doesn't expose.
   → **Expiry is only obtainable for `.se`** (port-43, verified `expiry=2031`). For `.nl/.no/.fi` use
   **domain age** (from `registration`/`created`); the "domain expiring soon" angle is **`.se`-only**.
2. **`.pt` has no public RDAP AND its port-43 is IP-filtered — the data exists, the *access* is blocked.**
   `.pt` WHOIS data (registration/expiration/renewal) **does exist** (visible on the pt.pt web form). But
   `whois.dns.pt` (185.39.208.67) **silently drops TCP SYN on port 43 from our datacenter IP** (ETIMEDOUT /
   20 s timeout on the direct IP), while `.se`'s `whois.iis.se` answers in **80 ms from the same VM** — so
   port-43 outbound works; DNS.PT is **filtering datacenter IP ranges** at the firewall. **Implication:** the
   fleet's cloud IPs (Oracle/GCP/Hetzner) are all datacenter → likely all filtered too; only **residential /
   PT-based IPs** get through. So `.pt` needs **either** (a) **WhoisXML/aggregator** (whitelisted access — the
   default), **or** (b) the port-43 query routed through a **residential/PT clean proxy** (ties into the
   outreach clean-proxy fleet). If we get `.pt` access via (b), add a `.pt`-specific port-43 parser (whoiser's
   fuzzy labels returned NULL — the `.pt` format needs its own field map). Verify (b) by running the raw
   socket probe from a residential connection first.
3. **`rdap.org` (public redirector) only covers IANA-bootstrap TLDs** (302'd `.no`, 404'd `.se`/`.pt`) →
   we must ship a **hardcoded per-TLD endpoint map**, not rely on the bootstrap alone.
4. RDAP covers **~64 % of the corpus** by volume (`.nl` 423k + `.no` 141k + `.fi` 141k = 705k of ~1.1M).

### Definitive solution — a tiered router with per-TLD capability map

```
lookupWhois(domain):
  tld = suffix(domain)
  for tier in ROUTE[tld]:            # ordered per-TLD
     r = tier.fetch(domain)          # RDAP | Port43 | WhoisXML
     if r.usable: return r + cache(whois_checked_at)
  return null (cache the miss too, shorter TTL)

ROUTE = {
  no: [RDAP, Port43, WhoisXML],
  nl: [RDAP, Port43, WhoisXML],
  fi: [RDAP, Port43, WhoisXML],
  se: [Port43, WhoisXML],           # no RDAP; port-43 gives everything incl. expiry
  pt: [WhoisXML, Port43@residentialProxy],  # no RDAP; port-43 IP-filters datacenter IPs → aggregator, or route port-43 via clean/PT proxy
  '*': [RDAP(bootstrap), Port43, WhoisXML],   # any future TLD: IANA bootstrap → fallback
}
```

### Implementation phases

**B1 — `lib/rdap.js` (the RDAP tier).**
- Hardcoded `RDAP_BASE = { no:'https://rdap.norid.no/', nl:'https://rdap.sidn.nl/', fi:'https://rdap.fi/rdap/rdap/' }`,
  plus a lazily-fetched+cached **IANA bootstrap** (`https://data.iana.org/rdap/dns.json`) for any other TLD.
- `GET {base}domain/{name}` with `Accept: application/rdap+json`, undici + **`AbortSignal.timeout`**;
  optional **ProxyAgent** (fleet IP routing, reuse the verify-proxy pattern).
- Parse (RFC 9083): `events[]` → `registration`→created, `expiration`→expiry **opportunistically** (present
  for gTLDs / future ccTLDs; absent for .nl/.no/.fi today — captured for free if they ever add it);
  `entities[]` role `registrar` → `vcardArray fn`. Follow `links[rel=related]` referrals once (registry →
  registrar RDAP) like whoiser's `follow:1`. Return the **same shape** as `lib/whois.js`
  (`registrar/created/expiry/ageDays/expiringSoon`) so callers don't change.

**B2 — WhoisXML provider tier (`lib/whois-providers.js`), multi-key.**
- Mirror `lib/verify-providers.js`: `apiKeys:[…]` round-robin, per-key monthly budget (1,000/mo — the free
  tier), 50 req/s hard cap, ProxyAgent optional. Config in gitignored `config/whois-providers.json`
  (+ `.example`). Used **sparingly**, prioritised by `lead_score` (like `enqueue-email-verification.js`).
- Parse WhoisXML's normalised JSON (`registrarName`, `createdDate`, `expiresDate`) → common shape.

**B3 — Router (`lib/whois.js` becomes `lookupWhois` = the router).**
- Keep the existing `whoiser` port-43 code as the **Port43 tier**. Add `ROUTE` map + tier cascade above.
- A result is "usable" if it has ≥ registrar **or** created; on unusable/error/rate-limit → next tier.

**B4 — Distributed job + strong rate-limiting.**
- `handleWhois` (worker) already exists → point it at the router. Keep it a **distributed role** (like
  `verify`) so it runs on fleet VMs, each IP with its own budget.
- **Per-registry-host token bucket** (`lib/ratelimit.js`, Redis-backed so it's shared across a VM's
  workers): start conservative (RDAP ~1-2 req/s per host per IP; WhoisXML per-key 50/s but 1k/mo). On
  `429`/`503`/`Retry-After` → **`nak` + exponential backoff** (the queue requeues later) — never hammer.
- **Cache hard:** WHOIS changes slowly → set `whois_checked_at`; `enqueue-domain-health.js --only=whois`
  skips domains checked < **90 days** ago (resume field). Cache negative results too (shorter, ~30 d).

**B5 — Enqueue + backfill.**
- `enqueue-domain-health.js --only=whois` already exists; it will now route per-TLD automatically.
- Run it **per-TLD in politeness-sized batches**, prioritised by lead_score, off-peak — never the whole
  corpus at once (registry rate limits). Wire into `orchestrate-backfill.sh` as a **throttled tail step**
  (after the current cms/ssl/dnsprovider/contacts + traffic), TLD by TLD.

**B6 — RDAP capability re-probe (robustness, cheap insurance).**
- ccTLDs deploy RDAP over time — `.pt`/`.se` may get one later. A monthly job probes one live domain per TLD
  against the IANA bootstrap + a small candidate host list (`rdap.<registry>`, `rdap.<tld>`, …); if a TLD
  starts returning valid `application/rdap+json`, it's **auto-promoted** to the RDAP tier in the `ROUTE`
  map (config-driven, no redeploy). Logs the promotion so we notice `.pt` going live.

### Verification (Part B)
- Unit: `lookupWhois` returns the common shape for one live domain per TLD via the chosen tier
  (`.nl/.no/.fi`→RDAP, `.se`→port-43 w/ expiry, `.pt`→WhoisXML or null).
- Rate-limit: hammer one registry through the token bucket → observe req/s capped + `Retry-After`
  honoured (no 429 storms, no IP ban).
- Coverage: after a `.se` batch, `whois_registrar`/`domain_created`/`expiry` populate; after `.nl/.no/.fi`
  batches, registrar+created populate (expiry stays null — expected). Update the README §12 coverage table.

### Files
`lib/rdap.js` (new) · `lib/whois-providers.js` (new) · `lib/whois.js` (→ router) · `lib/ratelimit.js`
(new, Redis token bucket) · `worker/handlers.mjs` (`handleWhois` → router) · `config/whois-providers.json(.example)`
· `enqueue-domain-health.js` (whois resume = `whois_checked_at` < 90 d) · `orchestrate-backfill.sh` (throttled whois tail) · README §12.

---

## Sequencing across both parts
Part A and Part B are independent. Suggested: **A1 (PgBouncer) + A4 (cheap amp cuts)** first (help
immediately and before the fleet grows), then **B1-B4 (RDAP)** (unblocks the whois gap that's currently
~0 %), then **A2 → A3** (direct/write-behind, the fleet multiplier) before onboarding many VMs, then
**A5/A6** as needed. Never touch production Netmaster IPs/domains; validation IPs ≠ sending IPs.
