# NetProspect

**Self-hosted, zero-SaaS-cost, GDPR-aware B2B lead-discovery & enrichment pipeline.**

NetProspect finds businesses that are operating a website on a target platform
(WordPress / WooCommerce / PrestaShop / Wix / cPanel / Shopify…), enriches each one
with technical, performance, security, domain-health and locality signals, extracts
company and named **people** contacts (all roles, international phones, per-person
socials), verifies e-mail addresses, **scores every lead 0–100**, and exposes it all
as a searchable **Business Directory** with rich prospecting filters and saveable
audience segments. It then **detects change over time** (sales triggers) and runs
**outreach campaigns** with per-recipient, on-prem-AI-tailored e-mail — the whole
funnel, discovery → outreach, on your own infrastructure.

It was built to feed [Netmaster](https://netmaster.pt)'s outbound prospecting for
**website maintenance + managed hosting** contracts across Portugal and the
Nordics/Netherlands (`.pt`, `.no`, `.se`, `.fi`, `.nl`).

Everything runs on our own infrastructure — no per-lead SaaS fees, no data
leaving our servers except deliberate, throttled, reputation-safe probes.

---

## Functionalities & strong suits

- **Discovery by market, not by upload** — enumerates *every operating domain* of a
  country TLD from Common Crawl (not a purchased list); re-crawlable for thousands of TLDs.
- **Discovery by tech stack** — we know each site's CMS/e-commerce/hosting platform, so
  we can target "all WooCommerce shops on cPanel with broken SPF" — a segment no generic
  contact DB can build.
- **Deep per-site audit** — Lighthouse SEO + mobile, Nuclei security scan, WPScan (WordPress
  vulns), traffic rank (Tranco), AI-classified line of business, SPF/DMARC, load speed, cPanel,
  Google-Business presence — each a concrete sales angle.
- **Domain & infrastructure health** — TLS certificate grade + days-to-expiry, WHOIS domain age
  and expiry (renewal triggers), authoritative DNS provider, and CMS version + staleness
  (out-of-date WordPress/WooCommerce/PrestaShop) — direct hooks for hosting, renewal and
  maintenance pitches.
- **People contacts we extract ourselves** — named decision-makers *and* all other roles
  (never dropped), with international E.164 phones, role categories, and per-person LinkedIn.
- **Configurable qualification** — a lead must have an e-mail contact **and** a real pitch
  signal; the rule is a JSON file, not hard-code.
- **Lead scoring 0–100** — a tunable weighted index over all signals, so the directory sorts
  best-opportunity-first.
- **Audience segments** — save any filter combination as a live, always-current audience;
  one-click "audit all" and CSV export.
- **Change-detection triggers** — every re-analysis writes a time-series observation
  (self-hosted ClickHouse); diffs across runs emit sales triggers (lead-score jumped, SPF
  broke, certificate expiring, domain expiring, CMS went stale, platform migrated), shown as
  a per-site timeline and a global "Triggers" feed.
- **Campaigns with per-recipient AI e-mail** — pick a segment + an angle (speed/SEO/security/
  hosting/maintenance); an on-prem-AI job (Ollama, with a template fallback) writes a **different
  e-mail for every contact** using that site's own measured signals (platform, speed, SEO,
  vulnerabilities, SSL/domain expiry). Sends via Gmail/Workspace or any SMTP/ESP relay, with
  open/click tracking, an opt-out footer, and campaign metrics.
- **On-prem AI, GDPR-aware, zero SaaS cost** — own Directus/Postgres, own NATS job queue,
  **on-prem AI** (Ollama/Gemma) for line-of-business classification *and* per-recipient e-mail
  copy; all contact data processed under B2B legitimate interest; e-mail probes from disposable infra.
- **Scales horizontally** — a single NATS queue fed by replicable Docker workers; scale each
  job type independently across servers.
- **100 % self-hosted end-to-end** — discovery → enrichment → audit → contacts → scoring →
  change-detection → outreach, all on your own infra, at zero SaaS cost.

## NetProspect vs Apollo vs Hunter.io

| Capability | **NetProspect** | Apollo.io | Hunter.io |
|---|---|---|---|
| Hosting / model | **Self-hosted, own infra** | SaaS | SaaS |
| Cost model | **No per-lead / per-credit fee** | Per-seat + credits | Per-search/verify credits |
| Data ownership | **100 % ours, on-prem** | Vendor cloud | Vendor cloud |
| Lead sourcing | **Whole-TLD web discovery (Common Crawl)** | Prebuilt B2B database | Domain search |
| Target by **tech stack / hosting** | **Yes** (CMS, e-commerce, cPanel, CDN) | Limited technographics | No |
| Website **audit signals** (SEO, security, speed, SPF/DMARC) | **Yes, first-party** | No | No |
| **Domain health** (TLS grade, WHOIS age/expiry, DNS host, CMS staleness) | **Yes, first-party** | No | No |
| Named people + roles | **Yes (self-extracted, all roles)** | Yes (large DB) | Yes (patterns) |
| E-mail verification | **Yes (tiered, reputation-safe)** | Yes | Yes |
| **Lead scoring** on site health | **Yes (configurable)** | Generic scoring | No |
| On-prem **AI** (classification / copy) | **Yes (Ollama/Gemma)** | Cloud AI | No |
| GDPR basis / data residency | **Own servers, legitimate interest** | Vendor DPA | Vendor DPA |
| Change-detection triggers | **Yes (self-hosted time-series)** | Limited | No |
| Campaigns + **per-recipient** tailored e-mail | **Yes (on-prem AI, site-metric-driven)** | Yes (cloud, generic) | Basic |

> The point isn't to out-database Apollo — it's that NetProspect targets **by website
> characteristics we measure ourselves** (platform, speed, security, deliverability), which the
> generic contact clouds simply don't have, at **zero marginal cost** and full data ownership.

---

## Table of contents

1. [What it does](#1-what-it-does)
2. [How it works — the pipeline](#2-how-it-works--the-pipeline)
3. [Infrastructure](#3-infrastructure)
4. [Workers & the job DAG](#4-workers--the-fine-grained-job-dag)
5. [Where the data comes from](#5-where-the-data-comes-from-origins)
6. [Enrichment data points](#6-enrichment-data-points)
7. [How we get the contacts](#7-how-we-get-the-contacts)
8. [Filters, qualification & lead score](#8-filters-qualification--lead-score)
9. [Creating audience segments](#9-creating-audience-segments)
10. [E-mail validation at scale](#10-e-mail-validation-at-scale)
11. [Roadmap — v2, built in phases](#11-roadmap--v2-built-in-phases)
12. [Deferred Follow-Ups](#12-deferred-follow-ups)
13. [Repository map](#13-repository-map)
14. [Running it](#14-running-it)

*(Above the TOC: [Functionalities & strong suits](#functionalities--strong-suits) ·
[NetProspect vs Apollo vs Hunter.io](#netprospect-vs-apollo-vs-hunterio).)*

---

## 1. What it does

Given a target market (a country TLD + a set of website platforms), NetProspect:

1. **Discovers** every domain that is actually *operating* a site in that TLD
   (not the registry list — sites that respond).
2. **Enriches** each domain: DNS/IP → hosting geography & ISP → HTTP liveness →
   website platform/tech stack → cheap audit signals (social, cPanel, load time,
   SPF/DMARC, business locality).
3. **Qualifies** each lead against a **configurable rule** (`config/qualification.json`):
   at least one e-mail contact **and** at least one pitch signal (target platform,
   cPanel, Shopify, SPF/DMARC problem, security findings…) — broader than the old
   platform-only test.
4. **Extracts contacts** — a general company e-mail/phone, plus named people of
   *all* roles (CEO / Founder / Manager / …, never dropped) with E.164 phone,
   role category and per-person LinkedIn.
5. **Audits deeply** (on demand or in batch): Lighthouse SEO + mobile-friendliness,
   Nuclei security scan, WordPress vulnerability scan, traffic rank, AI-classified
   line of business, plus SSL/WHOIS/DNS/CMS domain-health signals.
6. **Scores** every lead 0–100 and **verifies e-mails** at scale without burning
   sender reputation.
7. **Detects change** over time (ClickHouse time-series → sales triggers) and runs
   **outreach campaigns** with per-recipient AI-tailored e-mail.
8. **Presents** it all in a dashboard: KPIs, a filterable/segmentable business
   directory, a contacts directory, saved segments, lead scores, a **Triggers** feed,
   per-site timelines, and **Campaigns**.

**Snapshot (2026-07-09, mid-build):** ~785k sites discovered, ~724k live,
~379k qualified, ~737k companies, ~155k people contacts (~55k with e-mail). `.pt`
and `.no` are complete; `.se`/`.fi`/`.nl` are enriching/extracting in parallel.

---

## 2. How it works — the pipeline

```
                          ┌─────────────────────────────────────────────┐
  Common Crawl (S3)  ───► │ tld-domains-v2.js   discovery                │ ─► out/dominios_<tld>.txt
                          └─────────────────────────────────────────────┘
                                                │
                                                ▼
   ┌───────────────────────────────────────────────────────────────────────────────┐
   │ enrich-sites.js        DNS(A)+PTR → GeoIP(ASN/ISP/country/city) → HTTP liveness │
   │                        → hybrid tech detection → CHEAP AUDIT (social / cPanel / │
   │                        load-time / GMB-signal / SPF / DMARC / locality)         │
   │                        → general company contacts → idempotent upsert           │
   └───────────────────────────────────────────────────────────────────────────────┘
                                                │  (qualified?)
                                                ▼
   ┌───────────────────────────────────────────┐   ┌──────────────────────────────────┐
   │ extract-contacts.js   people contacts      │   │ HEAVY AUDIT (NATS queue)         │
   │ (name/role/email/phone from team/about/    │   │ Lighthouse · Nuclei · Tranco ·   │
   │  contact pages)                            │   │ Ollama/Gemma · GMB(browser) ·    │
   └───────────────────────────────────────────┘   │ WPScan  → site_reports           │
                                                │   └──────────────────────────────────┘
                                                ▼
   ┌───────────────────────────────────────────┐   ┌──────────────────────────────────┐
   │ verify-emails.js   tiered SMTP/API/proxy   │   │ dashboard/  Business Directory,  │
   │ verification (reputation-safe)             │   │ rich filters, segments, drawer   │
   └───────────────────────────────────────────┘   └──────────────────────────────────┘
                                   │                                 │
                                   └──────────► Directus (Postgres) ◄─┘
```

On top of that v1 core, the **v2** additions (see the [Roadmap](#11-roadmap--v2-built-in-phases))
layer in: a **fine-grained job DAG** (one job per step; [Workers](#4-workers--the-fine-grained-job-dag)) with **MinIO**
page snapshots; a convergent **qualify + lead-score** step; **domain-health** jobs (SSL/WHOIS/DNS/
CMS); **ClickHouse** change-detection → a **Triggers** feed + per-site timelines; and **Campaigns**
with on-prem-AI per-recipient e-mail. All of it writes back to the same Directus/Postgres.

Two execution models coexist:

- **Standalone scripts** (on the host) — the current production path for
  discovery + enrichment + contact extraction of each TLD. Resumable and
  idempotent; parallelised per-TLD (see [Workers](#4-workers--the-fine-grained-job-dag)).
- **Job queue** (NATS JetStream + Docker workers) — the same enrichment/contacts
  logic exposed as reusable handlers, plus the heavy audits. Producers
  (`enqueue-enrich.js`, `enqueue-audits.js`) publish jobs; replicable workers
  consume them and chain follow-ups (enrich → contacts → audit) through the queue.

Every stage is **resumable** (via `*_checked_at` columns and local checkpoints)
and **idempotent** (upsert keyed by domain / `Nats-Msg-Id` dedup), so a crash or
restart never loses or double-writes work.

---

## 3. Infrastructure

A single **isolated** Docker Compose stack (`docker/docker-compose.yml`, project
name `netprospect`). It is deliberately separate from Netmaster's *production*
Directus (project `netmaster-app`, port 8055) — different project name, network,
volumes and host ports, so the two never collide.

### Deployment topologies

NetProspect runs the **same containers/code** in two shapes — pick by scale:

**A — Single Docker host** *(simplest; the default `docker/docker-compose.yml`)*
Everything on one box: Postgres, Directus, dashboard, NATS, Redis, MinIO, workers. Great for building
the corpus and moderate throughput. **Limit:** Postgres shares CPU + disk I/O with the crawlers and
ClickHouse — measured, **Postgres is ~70 % of the load (~8–9 of 12 cores)** while the workers are cheap
and network-bound (~1.7 cores). So the DB becomes the ceiling as you add workers.

**B — Split by I/O profile + distributed worker fleet** ⭐ *(recommended at scale)*
Each piece lives where its **I/O profile** fits — not where there happens to be room. The live fleet
inventory + the placement rationale are in [`LOAD-DISTRIBUTION.md`](LOAD-DISTRIBUTION.md) and
[`docs/stack-isolation.md`](docs/stack-isolation.md).
- **`np-db`** — a dedicated Proxmox LXC CT for **Postgres + PgBouncer + Tailscale** (the "fat DB host";
  Postgres is ~70 % of the load). Runbook: [`docs/runbook-db-host.md`](docs/runbook-db-host.md).
- **`de-minio`** — a dedicated VM on the **cheap-disk** host for **MinIO**: object storage is
  write-once/read-rarely and latency-tolerant, so it wastes NVMe. Runbook:
  [`docs/runbook-minio-de1.md`](docs/runbook-minio-de1.md).
- **`np-server`** — Directus, dashboard, **NATS**, Redis. These are latency-**critical** (workers pull in
  a tight loop), so this VM stays on the **same Proxmox host** as the heavy workers — a separate VM for
  guaranteed CPU, still ~0.1 ms away over the LAN. Runbook: [`docs/runbook-server-hel1.md`](docs/runbook-server-hel1.md).
- **Worker VMs** (Docker + Tailscale) spread across a 2nd Proxmox host + free-tier clouds — 1 IP each,
  so each also carries its own email-verify / WHOIS-RDAP quota. Runbook: [`docs/runbook-worker-vms.md`](docs/runbook-worker-vms.md).

**Why the dedicated DB host is the recommendation:** the load is **~70 % Postgres, which is *central* and
can't be distributed**; the workers are cheap and *distributable*. So spreading workers alone doesn't
relieve the bottleneck — separating (and scaling) the DB does. A dedicated host gives Postgres its own
**cores + local NVMe** (no noisy-neighbour contention with crawlers/ClickHouse), **PgBouncer** multiplexes
dozens of fleet workers into a bounded connection pool (`A1`), the workers write **direct to Postgres**
bypassing the Directus REST tax (`A2`), and **Tailscale** keeps it all private (NATS has no auth → tailnet-only).
A **Proxmox LXC CT** is the sweet spot — **near-native I/O (critical for WAL fsync), ZFS snapshots, easy
core/RAM pinning**; a dedicated VM is the portable alternative. Scale plan: `.claude/plans/dev/postgres-scaling-and-whois-rdap.md`.

> **Recommended DB-host resources:** **12–16 vCPU · ≥64 GB RAM · local NVMe** (ZFS `recordsize=16K`, `lz4`).
> Postgres tuned to the RAM (`shared_buffers ~16 GB`, `effective_cache_size ~44 GB`, `synchronous_commit=off`,
> `wal_compression=on`). Full tuning + a ~10 GB `pg_dump | pg_restore` migration in the runbook above.

> 📊 **Fleet benchmark** — measured throughput per job type × per worker host (specs + worker counts),
> combined-fleet peaks, and the tuning levers (per-consumer `maxAckPending` cap, `FINGERPRINT_CONC`,
> host load ceilings, why the DB is never the bottleneck): **[`BENCHMARK.md`](BENCHMARK.md)**. Living
> doc — update it whenever you tune concurrency, change a VM's specs, or add a worker host.

### Services & ports

Every container we run, with its **published host port** (or why it has none). Two
Compose files: the **main stack** (`docker/docker-compose.yml`, project `netprospect`)
and a **separate opt-in PostHog stack** (`docker/posthog.compose.yml`, project
`netprospect-posthog`). Ports published to `127.0.0.1` are host-local (reach them over
Tailscale / an SSH or VSCode forward, never public); Directus and the dashboard bind all
interfaces (they sit behind NPMplus/Authentik in production).

**Main stack — always-on (default profile)**

| Service | Image | Role | Host port |
|---|---|---|---|
| `postgres` | postgis/postgis:16-3.4-alpine | Postgres/PostGIS behind Directus | **none** (internal `:5432` only) |
| `directus` | directus/directus:11.3.5 | Headless CMS / REST API | **8056** → container 8055 |
| `dashboard` | built `../dashboard` (node) | Express SPA + API. Explorar: Directory, Contacts, **Clientes**. Sistema: **Workers** (per-instance telemetry drill-down), **Filas** (queue depth + job purge/delete), **Agentes IA** (Orchestrator chat + Audience Creator + Planner), ISPs, Triggers, Campaigns, Segments. **Configuração** (service status + config summaries, secrets hidden), Triggers, Campaigns, Segments. Header: refresh + **Importar CSV** (multi-entity). Redis-cached aggregates + worker telemetry; 10s auto-refresh; multer/csv-parse; Ollama agents (`/api/agents/*`); mounts `config:ro` | **3001** → container 3000 |
| `nats` | nats:2.10-alpine | JetStream job queue (`NATS_BIND` to expose on the tailnet for the remote fleet) | **127.0.0.1:4222** |
| `redis` | redis:7-alpine | Cache for the dashboard's heavy aggregates (`/api/stats` ~18 queries, segment counts); fail-soft (`REDIS_URL` empty = off) | **127.0.0.1:6379** |
| `minio` | minio/minio | Page-snapshot object store (S3) | **127.0.0.1:9000** (API) + **9001** (console) |
| `worker-base` | built `worker/Dockerfile.base` (slim) | Light job workers (fetch/…/score/ssl/whois/dnsprovider/campaign) | **none** (NATS consumer; `WORKER_BASE_REPLICAS`, default 2) |
| `worker` | built `worker/Dockerfile` (heavy) | Chromium/Nuclei/WPScan/AI workers | **none** (NATS consumer; `WORKER_REPLICAS`, default 2) |

**Main stack — opt-in (started only with `--profile <name>`)**

| Service | Image | Role | Host port | Profile |
|---|---|---|---|---|
| `clickhouse` | clickhouse/clickhouse-server:24.3-alpine | Time-series observations + change events (Phase E) | **127.0.0.1:8123** (HTTP) | `analytics` |
| `ollama` | ollama/ollama | Gemma 3 — industry classifier + campaign-copy AI (CPU) | **none** (internal `:11434`) | `audit` |
| `ollama-init` | ollama/ollama | One-shot: pulls the model on first start, then exits | **none** | `audit` |
| `tailscale-egress` | tailscale/tailscale | Egress proxy through a Tailscale **exit node** (internal `:1055`) | **none** | `egress` |
| `tailscale` | tailscale/tailscale | Joins the tailnet + `tailscale serve`s Directus/dashboard | **none** (outbound to tailnet) | `tailscale` |

**Separate PostHog stack** — `docker/posthog.compose.yml` (project `netprospect-posthog`),
**heavy & opt-in, not part of the main stack and not started by default.** The main
stack's analytics is **ClickHouse only**; PostHog is an optional product-analytics add-on.

| Service | Image | Role | Host port |
|---|---|---|---|
| `posthog-web` | posthog/posthog | PostHog UI + API | **127.0.0.1:8000** |
| `posthog-worker` | posthog/posthog | PostHog Celery worker/scheduler | **none** |
| `posthog-db` | postgres:15-alpine | PostHog's own Postgres | **none** |
| `posthog-redis` | redis:7-alpine | PostHog's Redis | **none** |
| `posthog-kafka` | redpandadata/redpanda | Kafka API (single-node, no Zookeeper) | **none** |
| `posthog-clickhouse` | clickhouse/clickhouse-server:24.3-alpine | PostHog's own ClickHouse (separate from ours) | **none** |

> Not containers: the **host** `tailscaled` (kernel + userspace, outside Compose) is what
> proxies these `127.0.0.1` ports to a laptop over the tailnet — independent of the
> `tailscale`/`tailscale-egress` containers above.

- **Host**: Hetzner VM, 12 vCPU / 125 GB RAM, **no GPU** (Ollama runs on CPU).
- **Worker image** (~2.3 GB) bundles Chromium (Lighthouse + GMB browser
  automation), the Nuclei binary + templates, and WPScan (Ruby gem).
- **Exposure** (production): the optional Tailscale sidecar joins the tailnet and
  `tailscale serve`s Directus/the dashboard, reachable behind NPMplus + Authentik
  on a `netmaster.pt` subdomain on another VM.
- **Config** lives in `docker/.env` (copy from `docker/.env.example`); Node
  scripts read it via `lib/env.js`. GeoIP DBs live in `data/geoip/`, the Tranco
  list in `data/tranco/`, both bind-mounted read-only into the workers.
- **All container data is on host bind mounts** under `docker/.data/<service>/` (Postgres,
  Directus uploads, NATS, MinIO, Ollama, Tailscale) — no anonymous Docker volumes, so the
  dataset is visible and backupable on disk. (Postgres' dir is `700`/uid-70, so `du` as a
  normal user shows `4K` — that's a permissions artifact, not missing data.) In deployment **B**,
  Postgres and MinIO have moved to their own hosts (`np-db`, `de-minio`); the local dirs stay
  behind as rollback.

Directus stores: `sites`, `companies`, `platforms` (seeded catalog), `contacts`,
`segments` (saved filters), `site_reports` (heavy-audit outputs), and — for
outreach — `campaigns`, `emails` (one rendered per recipient) and `email_templates`.
Time-series observations + change events live separately in **ClickHouse** (Phase E).

---

## 4. Workers & the fine-grained job DAG

The pipeline runs as **one job per step** on a single NATS JetStream queue,
consumed by **replicable, role-scoped Docker workers**. This is the scale
foundation: each job type is its own subject with its own consumer, so we scale
each independently and place it on the best-fit server.

### The DAG (event-driven, no central orchestrator)

A `fetch` job (the per-domain root) resolves DNS + does one HTTP fetch, stores the
**page bundle in MinIO once**, writes liveness/load/cPanel, and publishes its
successors. Every downstream analysis job **reads the MinIO snapshot** instead of
re-fetching. Each step publishes the next; the `score` job is the convergence
point (qualify + lead score) and, once a site first qualifies, fans out the heavy
audits.

```
discover(block) ─▶ fetch(domain) ─▶ snapshot→MinIO
                     ├─▶ geoip            (from resolved IP)
                     ├─▶ fingerprint ─┐
                     ├─▶ social       ├─ read snapshot ─▶ score ─▶ (if qualified &
                     ├─▶ locality     │                            AUDIT_ENABLED)
                     ├─▶ contacts ────┘                            ├─▶ lighthouse.mobile
                     ├─▶ industry (Ollama)                         ├─▶ nuclei
                     ├─▶ emailauth (SPF/DMARC, DNS TXT)            ├─▶ ssl / whois / dnsprovider
                     └─▶ traffic (Tranco)                          └─▶ gmb (opt-in)
```

Subjects: `jobs.discover / fetch / dns / geoip / fingerprint / social / locality /
emailauth / traffic / industry / lighthouse.{mobile,desktop} / nuclei / wpscan /
gmb / subdomains / ssl / whois / dnsprovider / score / campaign.generate /
campaign.send` (+ the legacy coarse `enrich / contacts / audit.*` kept for
migration). All defined in `lib/jobs.js`; dedup via `Nats-Msg-Id`; transient
failures `nak`+retry, permanent `term`. (The two `campaign.*` jobs are triggered
from the Campaigns dashboard, not the per-domain DAG.)

### The full pipeline order (running everything from scratch)

Two entry paths cover the same work: the **coarse** jobs (`jobs.enrich` does
DNS + HTTP + fingerprint + qualify in **one** job, then cascades — the bulk path
we run for `.pt`/`.no`/`.nl`) and the **fine-grained DAG** above (one job per step —
better observability, retry granularity, and *surgical refresh*, see below). End to
end, in order:

| # | Stage | Subjects (queues) | Entry / trigger | Produces |
|---|---|---|---|---|
| 0 | **Discover** | `jobs.discover` → `jobs.fetch`; `jobs.subdomains` | `enqueue-discover.js` (list from `tld-domains-v2.js` / Tranco) | domain rows |
| 1 | **Enrich** | `jobs.fetch` → `geoip`, `fingerprint`, `social`, `locality`, `emailauth`, `traffic`, `industry` *(coarse: `jobs.enrich`)* | `enqueue-enrich.js` | tech/platform/ISP/liveness + MinIO snapshot |
| 2 | **Contacts** | `jobs.contacts` | `enqueue-contacts.js --tld=X` (or cascaded on qualify) | people contacts + company email/phone |
| 3 | **Score / qualify** | `jobs.score` | *every* stage publishes it (dedup-collapsed) | `qualified`, `lead_score`; on **first** qualify fans out the audits |
| 4 | **Domain-health** | `jobs.ssl`, `jobs.whois`, `jobs.dnsprovider` | `enqueue-domain-health.js --only=…` | cert/registrar/NS + `cms_outdated` |
| 5 | **Heavy audits** *(opt-in)* | `jobs.lighthouse.*`, `jobs.nuclei`, `jobs.wpscan`, `jobs.gmb` | `enqueue-audits.js` (`AUDIT_ENABLED`) | `site_reports` |
| 6 | **Verify emails** | `jobs.verify` *(role `verify`, remote fleet)* | `enqueue-email-verification.js` | `email_status` — **needs** contacts (2) + lead_score (3) |
| 7 | **Outreach** | `jobs.campaign.generate` → `jobs.campaign.send` | Campaigns dashboard / `campaign-drip.js` | rendered emails, SMTP-sent — **only** to deliverable addresses (6) |

Bulk finalisers (**not** queues): `requalify.js` + `score-leads.js` re-derive
qualification / lead-score across the whole corpus in one SQL pass — far cheaper
than job-per-site for a *global* sweep.

```
discover → fetch(enrich)/geoip/fingerprint/social/locality/emailauth/traffic/industry
         → contacts → score → {ssl/whois/dnsprovider + audits} → score
         → verify → campaign.generate → campaign.send
```

### Recurring refresh — what runs, what doesn't

Data ages at different rates, so a refresh **never re-runs everything** — you target
a subset with `enqueue-*.js --only=… --tld=…` (or a `lead_score` filter). Every job
is idempotent (rewrites by domain) and `jobs.score` collapses via the 24 h dedup, so
a refresh is a fraction of the initial run's cost.

| Cadence | Run | Why | Skip |
|---|---|---|---|
| **Daily** | `jobs.ssl` for `ssl_days_left < 30` | cert expiry moves daily — the "SSL expiring" angle | everything else |
| **Weekly** | `jobs.fingerprint` (qualified) → `jobs.score` | CMS staleness is the core sales signal; re-fetch catches new versions | discover, contacts, whois, verify |
| **Monthly** | `jobs.fetch`/enrich (liveness/redesign/platform) + `jobs.traffic` + `jobs.emailauth` + `jobs.whois`; then `requalify.js` + `score-leads.js` | liveness/traffic/DNS-auth drift at this rate | discover, contacts, heavy audits |
| **Quarterly** | `jobs.contacts` (qualified) + `jobs.dnsprovider` | new people/emails appear slowly; re-crawl is costly | discover |
| **Before each outreach wave** | `jobs.verify` (emails > 90 d old, or `unknown`/`catch-all`) | deliverability decays as mailboxes close | enrich, contacts, domain-health |
| **Never** (one-time) | `jobs.discover` | domain list is stable — only for *new* domains | — |

Rules of thumb:

- **Refresh SSL only** → `jobs.ssl` → `jobs.score`. No enrich/fetch/contacts/fingerprint.
- **Refresh CMS staleness** → `jobs.fingerprint` (re-fetches the homepage itself) → `jobs.score`. No contacts, no domain-health.
- `jobs.score` runs after any change but is cheap (~20 fields, dedup-collapsed); for a
  global sweep use `score-leads.js` (one bulk `UPDATE`) instead.
- **Contacts** rarely need a refresh; **verification** decays fastest — re-verify before each send.
- `jobs.discover` + contact extraction are the stages you *don't* repeat in a normal
  refresh — only for new domains or deliberate re-crawls.

### Worker roles & images

`WORKER_ROLES` (env) selects which consumers a worker runs (`consumersForRoles()`):

| Role | Consumers | Image |
|---|---|---|
| **base** | fetch/dns/geoip/fingerprint/social/locality/emailauth/traffic/contacts/score/ssl/whois/dnsprovider/subdomains/discover/**campaign.generate**/**campaign.send** (+ coarse enrich/contacts) | `worker/Dockerfile.base` (**634 MB**, no Chromium) |
| **browser** | lighthouse.mobile/desktop, gmb, coarse audit.* | `worker/Dockerfile` (**2.3 GB**, Chromium) |
| **security** | nuclei, wpscan | `worker/Dockerfile` |
| **ai** | industry (Ollama) | `worker/Dockerfile` |

Compose ships `worker-base` (light, always on, `WORKER_BASE_REPLICAS`) and `worker`
(heavy, `WORKER_ROLES=browser,security,ai`, only active when `AUDIT_ENABLED`). Scale
each independently: `docker compose up -d --scale worker-base=6`. Heavy audits stay
**off on the fleet** (`AUDIT_ENABLED=false`) until CPU frees.

### Standalone host streams (current production run)

Because the whole machine was ~80 % idle under the old strictly-sequential
pipeline, the remaining TLDs run as **parallel per-TLD streams**
(`run-parallel-tlds.sh`):

- **SE** — extraction only (already enriched): working through the ~130k
  qualified backlog.
- **FI** — `enrich → extract`.
- **NL** — `enrich → extract` (the long pole: ~880k domains).

Each extraction stream is **TLD-scoped** (`extract-contacts.js --tld=se`) so the
streams never overlap (the extractor snapshots the whole pool at start; two global
instances would duplicate work). Concurrency is tuned so Directus's pressure
limiter stays green (`CONC_ENRICH`/`CONC_EXTRACT` env vars).

---

## 5. Where the data comes from (origins)

| Data | Source | Script / lib |
|---|---|---|
| **Operating domains of a TLD** | **Common Crawl** columnar index on S3 (`data.commoncrawl.org` — `cluster.idx` + range-fetched `cdx-*.gz` blocks). We merge the ~3 most recent crawls and keep apex domains (via `tldts`) that actually appear in the crawl. | `tld-domains-v2.js` |
| Subdomains of a seed domain | **Certificate Transparency** logs — the public crt.sh Postgres replica (FTS index). *Per-seed only* — broad TLD queries are cancelled by the replica. | `crtsh-enum.js`, `enrich-subdomains.js`, `lib/crtsh.js` |
| Hosting geography / ASN / ISP | **MaxMind GeoLite2** (ASN + Country + City `.mmdb`), refreshed if missing or >2 weeks old; **Team Cymru** DNS as a keyless fallback. | `lib/geoip.js`, `update-geoip.js` |
| Website platform / tech stack | **Custom fingerprints** + **simple-wappalyzer** (hybrid), run over the homepage HTML + response headers/cookies. | `lib/fingerprints.js` |
| Traffic (proxy) | **Tranco** top-1M ranking list (bucketed; most small-country domains are `unranked` = no data, not "low traffic"). | `lib/audit/tranco.js`, `fetch-tranco.js` |
| Line of business (industry) | **Ollama / Gemma 3** running locally on CPU, structured-JSON classification over the homepage title + meta + visible text against a fixed 22-category taxonomy. | `lib/audit/ollama-classify.js` |
| SEO & mobile-friendliness | **Lighthouse** (mobile config) driving the bundled Chromium. | `lib/audit/lighthouse.js` |
| Security findings | **Nuclei** (ProjectDiscovery) — batch scanner, no API limit. | `lib/audit/nuclei.js` |
| WordPress vulnerabilities | **WPScan** (free API token, 25/day) — **on-demand only**. | `lib/audit/wpscan.js` |
| Google Business profile / verified locality | **Headless browser** against Google Maps (no Places API; best-effort, opt-in). | `lib/audit/gmb-lookup.js` |

The historical `tld-domains.js` (older Common Crawl **CDX API** approach) is kept
for reference; `tld-domains-v2.js` (S3 columnar index) is the working version —
the CDX API became unreliable and CloudFront rate-limits non-browser clients.

---

## 6. Enrichment data points

Per **site** (Directus `sites` collection), grouped by stage:

**Network / hosting** — `hosting_ip`, `ptr`, `asn`, `isp`, `ip_country`,
`ip_city`, `cdn`.

**Liveness / HTTP** — `is_live`, `http_status`, `final_url`, `redirects_www`,
`language`, `checked_at`.

**Platform / tech** — `primary_platform` (m2o), `platforms` (m2m all detected),
`tech_detected` (JSON of name/version/categories).

**Qualification & scoring** — `qualified` (boolean) + `qualified_reasons` (JSON of the
signals that matched); `has_decision_maker` (rollup); `lead_score` (0–100) +
`lead_score_breakdown` (JSON `{signal: points}`) + `lead_score_at`. Both are driven by
editable config files ([config/qualification.json](config/qualification.json),
[config/lead-score.json](config/lead-score.json)) — see §8.

**Cheap audit** (from the same homepage fetch + DNS TXT, no extra crawl):
`has_email`, `has_phone`, `social` (JSON — **arrays of every profile URL per network**) +
`social_facebook/instagram/linkedin/twitter` booleans, `gmb` + `gmb_signal`, `is_cpanel` + `cpanel_signal`,
`load_ms` + `load_bucket` (fast/medium/slow/very_slow), `spf_status` &
`dmarc_status` (ok/weak/missing/invalid), `business_city` / `business_region` /
`business_address` (the *business* locality, distinct from the *hosting* city),
`cheap_checked_at`.

**Heavy audit** (queue): `industry` + `industry_confidence`, `seo_score`,
`mobile_score`, `mobile_friendly`, `security_findings` + `security_severity`
(info…critical), `wp_vuln_count`, `traffic_rank` + `traffic_bucket`, `gmb_name`/
`gmb_category`/`gmb_rating`/`gmb_reviews`/`gmb_phone`/`gmb_url`/`gmb_place_id`,
`audit_status` (pending/queued/running/done/error/skipped), `audit_error`,
`audit_checked_at`. Large reports (full Lighthouse LHR, Nuclei results, WPScan
JSON) go into the separate `site_reports` collection to keep the `sites` table
lean.

**Domain & infrastructure** (Phase D fine jobs): `ssl_issuer`, `ssl_not_after`,
`ssl_days_left`, `ssl_grade` (A–F); `whois_registrar`, `domain_created`,
`domain_expiry`, `domain_age_days`, `expiring_soon` (≤90 d); `dns_provider`
(authoritative NS org); `cms_version` + `cms_outdated` (detected version vs
[config/cms-latest.json](config/cms-latest.json)).

Per **company** (`companies`, deduplicated) — `org_domain` (dedup key), `name`,
`website`, `general_email`, `general_phone` (**E.164**), `country`, `source`. Companies
are merged across domains **only when corroborated** (the contact e-mail's domain is
itself a known site in our set), which kills false merges from
template/placeholder e-mails.

Per **contact** (`contacts`) — `name`, `role`, `role_category`
(decision_maker/manager/dpo/staff/unknown), `email` + verification fields, `phone`
(**E.164**) + `phone_country`, `social_profiles` (JSON, e.g. per-person LinkedIn),
`source`/`source_detail`, `gdpr_basis`.

---

## 7. How we get the contacts

Two distinct kinds, from two distinct origins:

### General business contacts (company-level)

Collected **during enrichment** by `enrich-sites.js` (`extractContacts` in
`lib/fingerprints.js`). It scans the homepage — and, if empty, `/contactos` and
`/contact` — for:

- **E-mail**: `mailto:` links first, then a length-bounded e-mail regex, with an
  aggressive junk filter (placeholders like `your@`, `name@`, `@example`,
  `wixpress`, image assets, etc.).
- **Phone**: **international** — `tel:` links + plausible number substrings parsed with
  `libphonenumber-js` ([lib/phone.js](lib/phone.js)) using the site's country (from TLD →
  hosting), kept only if valid, stored as **E.164**. Works for PT/NO/SE/FI/NL/… (the old
  code was PT-only).

These populate `company.general_email` / `company.general_phone`.

### People contacts (all roles, not just decision-makers)

Collected by `extract-contacts.js` + `lib/contacts.js`. For each qualified site it
crawls the homepage plus up to three **team / about / contact** pages and extracts
**named people**:

- **A broad role taxonomy** (~26 canonical roles: CEO, Founder, Owner, Partner, President,
  CTO/CFO/COO/CMO/CIO, DPO, VP, Head, Manager, Director, Lead, Sales, Marketing, HR, Support,
  Legal, Accountant, Consultant, Designer, Engineer, Administrative) mapped to a
  **`role_category`** (decision_maker / manager / dpo / staff / unknown) for filtering.
- **People with no detectable role are kept too** (name-only), not dropped — guarded by a
  strong name/precision filter (rejects org/service phrases, UI/theme labels, and phrases that
  are themselves job titles).
- **Role from context** (a role near the name on a team page) or from the **e-mail local-part**
  (`ceo@`, `fundador@`, `vendas@`…).
- **International phones** (E.164 + `phone_country`) and **per-person social**
  (LinkedIn `/in/` whose slug matches the person's name) → `contacts.social_profiles`.

Each person is stored in `contacts` linked to its company and site, with
`source='site'`, `source_detail=<URL>`, and `gdpr_basis='legitimate_interest'` (B2B
legitimate interest). Deduplicated by e-mail, else by name+role, per company. A
`sites.has_decision_maker` rollup flags sites with a C-level/owner contact.

> The `contacts` collection is scaffolded for **multi-source ingestion** — the
> `source` field lets us later add LinkedIn, WHOIS, or manual contacts alongside
> the website-crawled ones.

---

## 8. Filters, qualification & lead score

The dashboard (Directory **and** Contacts pages) exposes a rich set of prospecting
filters. All are server-side Directus filter expressions (`buildSiteFilters()` in
`dashboard/server.mjs`); booleans/enums are indexed in Postgres (`db/audit-indexes.sql`).

**Base**: search (domain/company), qualified, platform, country, ISP.
**Quality** — **lead score ≥ N**, **has decision-maker** (`has_decision_maker`).
**Contact** — has e-mail, has phone.
**Location** — business city (free-text).
**Social** — Facebook / Instagram / LinkedIn / Twit-X / Google Business.
**Infra & performance** — cPanel; load-speed bucket.
**E-mail auth** — SPF problems, DMARC problems.
**Domínio / SSL** — certificate expiring (≤30 d), domain expiring (≤90 d), CMS outdated.
**Traffic** — Tranco bucket. **Activity** — industry (22-category taxonomy).
**Audits** — weak SEO, mobile-not-friendly, security findings + severity, WPScan vulns.
**Contacts page** — **role multi-select** (any subset of the ~26 roles) + **role category**
(decision_maker/manager/dpo/staff/unknown), on top of every site-level filter (via the
`site` relation). The directory sorts **best-lead-first** and shows a **lead-score column**.

### Configurable qualification
A site is **`qualified`** when it has **≥ 1 e-mail contact AND ≥ 1 pitch signal**. Both the
requirement and the signal set live in [config/qualification.json](config/qualification.json)
(`require_email` + `signals_any`: target_platform, cPanel, Shopify, SPF/DMARC problem, security
findings — editable without redeploy). `lib/qualify.js` evaluates it at enrich time; the
`requalify.js` backfill recomputes the whole table via one SQL pass. This broadened
qualification well beyond the old "WordPress/Woo/Presta/Wix only".

### Lead score (0–100)
`lib/lead-score.js` + [config/lead-score.json](config/lead-score.json) sum tunable weights over
the signals present (platform, cPanel, decision-maker, SPF/DMARC weakness, traffic, security,
no-GMB, weak-SEO, slow site, plus the **Phase D** signals now live — `ssl_expiring` ≤21 d,
`whois_expiring` ≤90 d, `cms_outdated`). `score-leads.js` backfills the whole table. The score
sorts the directory and drives the "lead ≥ N" filter.

### Export & bulk actions
Every list has **CSV export** (`/api/directory.csv`, `/api/contacts.csv`) honouring the current
filters. The directory has an **"Audit all"** button that enqueues heavy audits for the whole
filtered audience (`POST /api/audit/segment`), and the site drawer has a dedicated **WPScan**
button (`?only=wpscan`) for on-demand WordPress scans.

---

## 9. Creating audience segments

A **segment** is a named, saved combination of filters — a reusable audience.

- **In the UI**: set any combination of filters on the Directory, then click
  **"Guardar segmento"**. The **full filter state** is captured (all audit facets +
  lead-score + roles, not just the basic four), you name it and pick an accent colour,
  and it's saved. The Segments page lists every segment with a **live count** of
  matching sites and lets you open, edit, share, or delete it.
- **Storage**: the Directus `segments` collection — `name`, `description`,
  `accent`, `filters` (JSON of the filter object), `shared` (boolean), `owner`.
- **API**: `GET/POST/PUT/DELETE /api/segments`. The saved `filters` JSON is fed
  straight back through the same `siteFilterParts()` builder used by the
  directory, so a segment's count and its directory view are always consistent.

Segments are how you turn "WooCommerce shops in Lisbon with a Facebook page,
weak SPF and no verified e-mail" into a one-click, always-up-to-date list.

---

## 10. E-mail validation at scale

`verify-emails.js` is a **tiered, reputation-safe** engine (never uses production
mail infra). It runs concurrently across domains, groups by destination MX, is
resumable via `contacts.email_status`, and **routes by provider** because SMTP `RCPT`
verification is only reliable for corporate mail servers — Gmail/Workspace/M365/Yahoo
accept-all + greylist fresh IPs, so those go to the API pool instead.

**Tier 0 — pattern inference** (`lib/email-verify.js`): name-but-no-e-mail → candidate
addresses (`first.last@`, `flast@`, `first@`, …) for the company domain.

**Tier 1 — local pre-filter** (free, kills most work): syntax → MX lookup →
role/departmental → disposable-domain → per-domain catch-all classification (cached).

**Provider routing** (`lib/reacher.js providerClass`): classifies each domain's MX as
Google / Microsoft / Yahoo (→ prefer the API pool) or **corporate** (→ prefer SMTP via
Reacher). Corporate is ~60–70 % of the list — where SMTP verification actually works.

**Tier 2 — Reacher via our clean SOCKS5 proxies** (`lib/reacher.js`): the self-hosted
**Reacher** engine does the SMTP `RCPT` handshake **through our own Dante proxies on
clean datacenter IPs with PTR-aligned HELO** (`config/verify-proxies.json`). Per-IP +
per-provider cooldowns; the probe egresses from a validation IP, never from our infra.
*(This replaces the old free-public-proxy tier, which was ~0.06 % usable — see
[Pending retirement](#pending-retirement-review-before-delete).)*

**Tier 3 — free-tier API pool** (`lib/verify-providers.js`): a rotating pool across
**QuickEmailVerification · Verifalia · MyEmailVerifier · Reoon · MailboxValidator ·
ZeroBounce · AbstractAPI · MailboxLayer · Hunter · Emailable · Clearout** + the keyless
**Disify** — the **reliable path for Gmail/M365/Yahoo** and the fallback when Reacher
returns `unknown`. Supports **multiple keys per provider** (`apiKeys:[…]`), optional
**proxy routing** (undici — one free quota per IP for IP-limited providers), and a hard
per-call timeout. Keys in gitignored `config/verify-providers.json` (see
`…example.json`). This tier is also exposed as a **distributed NATS worker**
(`jobs.verify`, role `verify`) so a fleet of free VMs each contributes its own IP's free
quota — see **§ Distributed free-tier fleet & the math** below.

Results write back `email`, `email_source` (`reacher` / `api:<provider>` /
`pattern_guess` / `existing`), `email_verified`, `verified_at`, and
`email_status` ∈ `{valid, invalid, catch_all, role, disposable, no_mx, unknown}`.

**Smart re-verification** — the fleet also **acts** on the result. Each contact gets a
`reverify_after` TTL (valid → +90 d, catch_all → +180 d, transient-unknown → +5 d;
permanents = NULL/never) and a typed `mail_provider`; domains get `catch_all` /
`blocks_probing` flags. The enqueue then re-checks decaying `valid`s, skips permanents +
hard-block domains, and caps/deprioritises B2C mega-domains. A verified-deliverable email
sets `sites.has_valid_email` → **+10 lead score** (`has_valid_email` signal). Full policy +
the one-off `backfill-verify-metadata.js`: [`docs/outreach-ops/07-reverification-policy.md`](./docs/outreach-ops/07-reverification-policy.md).

```bash
node verify-emails.js --dry-run --limit=25                 # pre-filter + routing + candidates (standalone)
REACHER_URL=http://127.0.0.1:8080 node verify-emails.js --limit=500
# …or the distributed fleet (many free VMs, one IP each) — see docs/distributed-fleet.md:
node enqueue-email-verification.js --limit=300             # queue top-lead_score domains → jobs.verify
WORKER_ROLES=verify node worker/worker.mjs                 # a verify worker (locally, or on each cloud VM)
```

**Infrastructure:** the clean IPs, Dante proxies, PTR/rDNS, and the Reacher service are
provisioned via the [runbooks](./docs/outreach-ops/README.md) in **`docs/outreach-ops/`** (00 port-25 gate + blocklist
hygiene → 01 validation fleet → 02 Reacher). *Isolate validation IPs/domains from
sending ones — probing taints reputation.*

> Engine + routing built and unit-tested (dry-run verified against live data). **Pilot ready
> (2026-07-19):** the Hetzner fleet already has **outbound port 25 open + Spamhaus-clean IPs**, so
> no Oracle/VPS provisioning is needed; the Reacher SMTP path was **validated live** (v0.11.6,
> `/v1/check_email`, correct valid/invalid on `netmaster.pt`). Deploy artifacts in
> [`deploy/reacher/`](deploy/reacher/); it only awaits the user's **Phase 0** (disposable domain +
> PTR on `49.12.120.250`), then it's a deploy. Big-provider answers improve as the validation IPs
> warm up; the API pool covers them meanwhile.

### Distributed free-tier fleet & the math

Verification scales **horizontally on free tiers**: run the worker on many small VMs, each
bringing **its own IP + its own free provider accounts**. Because a verify job is a tiny
HTTPS call (a few KB), **egress caps and port-25 blocks are irrelevant** — the only scarce
resource is **free quota per account/IP**. The worker is the existing NATS consumer with
`WORKER_ROLES=verify` (light image, no wappalyzer/geoip/MinIO); jobs are enqueued by
`enqueue-email-verification.js` **prioritised by `lead_score`** (highest-value leads first).
Full runbook (Debian + Docker + Tailscale + config): **[`docs/distributed-fleet.md`](./docs/distributed-fleet.md)**.

```
enqueue-email-verification.js ──▶ jobs.verify ──▶ [VM#1 verify | VM#2 verify | …]
   (central, lead_score desc)      (NATS workqueue)   each: own IP + own free keys
```
Self-throttling: a worker that exhausts its daily free quota naks its jobs; those
contacts stay `email_status=null` and return in the next day's batch. Zero data loss.

#### Cloud free-tier VMs (for running verify workers 24/7) — *verified Jul 2026*

| Cloud | Always-free 24/7 VM? | Free boxes / account | VMs/acct | Egress free | Port 25 | Recommended role |
|---|---|---|---|---|---|---|
| **Oracle Cloud** | ✅ never expires | **2× Ampere A1** (1 OCPU/6 GB ea) + **2× AMD** (⅛ OCPU/1 GB ea) | **4** | **10 TB/mo** | blocked | A1 → `verify,base` (enrich/extract) **+ Tailscale exit-node/proxy**; AMD → `verify` |
| **Google Cloud** | ✅ never expires | 1× e2-micro (2 vCPU-burst/1 GB), us-w1/c1/e1 | **1** | **1 GB/mo** ⚠ | blocked | `verify` only — **never** an exit node (1 GB cap) |
| **AWS** | ❌ trial only | t3.micro 750 h/12 mo **or** up-to-$200 credits/6 mo | 0 forever | 100 GB/mo | blocked-by-default | trial burst only |
| **Azure** | ❌ trial only | B1s 750 h/12 mo **or** $200 credits/30 d | 0 forever | 100 GB/mo | blocked | trial burst only |
| **Tencent / Alibaba** | ❌ trial only | 1–2 vCPU, 3–12 mo | 0 forever | small | — | trial burst only |
| Fly / Render / Koyeb / Zeabur | ❌ no free 24/7 (sleep) | — | 0 | — | — | avoid for workers |
| *(paid fallback)* **Hetzner / Scaleway** | 💶 cheapest paid | CX23 €5.49 / Stardust ~€1.83 | — | 20 TB / small | blocked-by-default | extra IPs beyond the free ones |

Oracle's **4 VMs** fit under the 200 GB block-volume ceiling: 2×50 GB (A1) + 2×47 GB (AMD) = **194 GB**.
Each cloud allows **one free account per verified identity** (card + phone; a *person* **or** a *company*).

> **Fleet size & ToS.** Across distinct legitimate identities (you, the company, …) you can stand up
> **~6 accounts → ~6 × (4 Oracle + 1 GCP) = ~30 VMs / ~30 distinct IPs**. Don't farm many accounts
> under one identity (ban risk). All clouds **block outbound port 25** — irrelevant here (verification
> is HTTPS APIs); port 25 only bites the outreach *sending* fleet. The **Oracle** VMs (10 TB egress)
> double as **Tailscale exit nodes + API/crawl proxies** for IP diversity; keep **GCP off egress duty**
> (1 GB/mo cap). The same ~30 VMs also parallelise **enrich/extract** (`--shard=i/30`) — each box is
> slow alone, but 30× in parallel is far more jobs/s than the single central host.

#### Email-verification providers — free tiers *(recurring = sustainable)*

| Provider | Free | Period | Quota tied to | Notes |
|---|---|---|---|---|
| **QuickEmailVerification** | 100 | **DAILY** | key *(verify per-IP)* | primary; real deliverability |
| **MyEmailVerifier** | 100 | **DAILY**\* | key | \*asterisk terms — verify at signup |
| **Verifalia** | 25 | **DAILY** | key | Basic-auth (adapter TODO) |
| **Reoon** | ~600 | **MONTHLY** | key | full SMTP/catch-all (`mode=power`) |
| **MailboxValidator** | 300 | **MONTHLY** | key | auto-renew |
| **ZeroBounce** | 100 | **MONTHLY** | key (≤5 keys/acct) | |
| **AbstractAPI** | 100 | **MONTHLY** | key | |
| **MailboxLayer** | 100 | **MONTHLY** | key | |
| **Hunter** | 25 | **MONTHLY** | key | |
| **Disify** | 1 000 | **DAILY** | **IP** (keyless) | prefilter only (disposable/MX), never `valid` |
| Kickbox · MillionVerifier | 100 | one-time | key | signup burst |
| ~~EVA (pingutil)~~ | — | **DEAD** | — | removed from the pool |

#### The math — the full free fleet

**Fleet:** ~6 identities × (4 Oracle + 1 GCP) = **~30 VMs / ~30 distinct IPs**, each running one light
worker. Register **one free provider account per IP** → **~30 accounts per provider** (key-based quota
is per-account; the 30 IPs also give Disify its per-IP quota + keep the per-provider signups looking
legit). Per account, per day:

```
daily providers   : QEV 100 + MyEmailVerifier 100 + Verifalia 25                      = 225
monthly providers : (Reoon 600 + MailboxValidator 300 + ZeroBounce 100 + AbstractAPI 100
                     + MailboxLayer 100 + Hunter 25) ÷ 30                              ≈ 41
                                                                        per account ≈ 266 / day
```

**× 30 accounts ≈ 7 975 real deliverability verifications/day**, **plus Disify 1 000/day × 30 IPs =
30 000/day** free *prefilter* (keyless, per-IP — strips disposable/no-MX before a real credit is
spent). **Total ceiling ≈ 37 975 checks/day** (≈ 8 k true verifications + 30 k prefilter).

| Stage | identities | IPs / accounts | real verif/day | + Disify prefilter/day |
|---|--:|--:|--:|--:|
| Start | 1 | 5 | ~1 330 | 5 000 |
| Mid | 3 | 15 | ~3 990 | 15 000 |
| **Full** | **6** | **30** | **~7 975** | **30 000** |

> QEV's 100/day may be per-key *or* per-IP (unconfirmed) — with **one account per IP** it doesn't
> matter. Registering ~30 accounts per provider is real signup effort → **ramp gradually** (start at
> 5 IPs and grow). Disify is a *prefilter* (never confirms `valid`), so ~8 k/day is the true
> deliverability ceiling; the 30 k Disify checks *multiply effective throughput* by pre-rejecting junk.

**Against the backlog:** ~**267 k** unverified contacts across ~**48.5 k** domains (avg **5.5**/domain;
`db/data-quality.sql`). Catch-all domains cost ~1–2 probes *total* (not per contact) and Disify pre-strips
dead domains, so effective throughput is higher. At the **full fleet (~8 k/day)** the whole backlog ≈
**~1 month**; at the 5-IP start (~1.3 k/day) ≈ ~6 months — either way we **verify highest-`lead_score`
first**, so the top few thousand outreach-ready leads clear in **days**. `enqueue-email-verification.js
--limit=<capacity/5.5>` daily (cron); see the runbook.

### Cold outreach — the paced sender (outreach Phase 2)

Once contacts are cleaned, cold campaigns (Phase F copy generation) are sent by **`campaign-drip.js`**
— a host-side, humanised, **multi-account** sender that never touches production IPs:

- **Sending fleet:** `docker-mailserver` on separate clean datacenter IPs / secondary domains
  (SPF+DKIM+DMARC+PTR), provisioned via `docs/outreach-ops/03-sending-fleet.md`. Credentials in
  gitignored `config/sending-accounts.json`; state (warm-up stage, daily cap, counters) in the
  Directus **`sending_accounts`** collection.
- **Pacing + warm-up:** the drip rotates accounts, respects a per-account **daily cap that ramps**
  (5→10→…→50/day) and a 60–180 s humanised gap; `lib/mailer.js makeMailerPool` gives one memoized
  transport per mailbox. ~450 cold/day safely across ~3 mailboxes.
- **Suppression:** a **`dnc`** collection + `contacts.do_not_contact`; the drip and
  `handleCampaignSend` both skip DNC; one-click **List-Unsubscribe** (`/t/u/:token`, GET + POST) and
  the opt-out footer feed it.
- **Bounces & replies:** **`imap-poller.js`** reads each sending mailbox — DSN bounces →
  `email_status='bounced'` + DNC; human replies → `contacts.responded=true` (the warm-tier candidate).

Verified in dry-run against live data (DNC skip + account selection + warm-up cap); real sending
awaits the mail-server VMs. Runbooks: `docs/outreach-ops/03-sending-fleet.md` + `.../04-warmup.md`.

**The reputation ladder continues:** contacts that *engage* with the cold outreach graduate up two
more rungs — `export-engaged-to-esp.js` → a **Brevo/MailerLite** campaign (Phase 3, borrows their
trusted IPs, engagement sieve; *engaged only* — never the cold list), then `export-warm-to-mautic.js`
→ **Mautic + AWS SES** (Phase 4, super-validated domains, cheap nurture at scale with SNS
bounce/complaint → DNC). Runbooks: `docs/outreach-ops/05-esp-ladder.md` + `.../06-aws-ses-mautic.md`.

---

## 11. Roadmap — v2, built in phases

Tracked in `.claude/plans/linear-weaving-quail.md`. Each phase ends by updating this README.

- **Phase A — data quality + scoring** ✅ *done* — international phones, all-roles +
  name-only people + role categories + per-person social, all company socials, configurable
  qualification, lead scoring, dashboard role multi-select + lead column/sort + full-fidelity
  segments + CSV export + WPScan/audit-all buttons.
- **Phase B — fine-grained jobs** ✅ *done* — the coarse enrich/audit jobs split into **one
  job per step** with an event-driven DAG (see §4), a **MinIO** page-snapshot store shared
  across jobs, **role-based worker images** (`WORKER_ROLES`: base/browser/security/ai; a 634 MB
  slim base + the 2.3 GB heavy), and **TLD-crawl-as-a-job** (`jobs.discover`, block-sharded,
  `enqueue-discover.js`). Verified end-to-end (fetch → snapshot → fan-out → lead score).
- **Phase C — IP diversity** ✅ *done (deployment opt-in)* — `EGRESS_PROXY`-aware external
  fetch (undici) + Chromium (`--proxy-server`) routes GMB/site egress through a **Tailscale
  exit-node** sidecar (`tailscale-egress`, profile `egress`, `TS_EXIT_NODE`); **subdomain
  enumeration is now a fine job** (`jobs.subdomains` via crt.sh, `enqueue-subdomains.js`),
  sharded across workers (run several behind different exit nodes to spread crt.sh across IPs).
  *(Live exit-node routing needs a tailnet auth key + nodes; the plumbing + fallback-to-direct
  are verified, the subdomain job is verified end-to-end.)*
- **Phase D — new enrichment surfaces** ✅ *done* — four fine jobs feeding the lead score and
  the dashboard: **SSL** (`jobs.ssl`, live TLS handshake → issuer, `not_after`, `days_left`,
  A–F `ssl_grade`), **WHOIS** (`jobs.whois` via `whoiser` → registrar, created/expiry dates,
  `domain_age_days`, `expiring_soon` ≤90 d), **DNS provider** (`jobs.dnsprovider` → authoritative
  NS org), and **CMS version + staleness** (`handleFingerprint` compares the detected version to
  `config/cms-latest.json` → `cms_version`, `cms_outdated`). New lead-score weights
  (`ssl_expiring` 6, `whois_expiring` 5, `cms_outdated` 9), three new dashboard facets
  (**Domínio / SSL**: cert-expiring ≤30 d, domain-expiring ≤90 d, CMS outdated) + directory
  badges + drawer detail rows, and on-demand `?only=ssl|whois|dnsprovider` re-runs. Verified
  end-to-end (logic on live domains → Directus write → NATS DAG → worker → dashboard).
- **Phase E — change detection + analytics** ✅ *done (ClickHouse live; PostHog opt-in)* —
  a self-hosted **ClickHouse** (`--profile analytics`) stores two MergeTree tables:
  `observations` (a time-series row per metric per run) and `change_events` (diffs between
  runs). `lib/metrics.js` `recordRun()` (wired into both `handleScore` **and** the standalone
  `enrich-sites.js`, fail-soft, gated by `CLICKHOUSE_URL`, throttled to one snapshot per site per
  window) records the current metrics and emits **sales triggers** — `score_up/down`, `qualified/disqualified`, `spf_broke`,
  `dmarc_broke`, `cert_expiring`, `domain_expiring`, `cms_went_stale`, `platform_changed`,
  `security_worsened`, `seo_regressed`. Dashboard: a **Triggers** page (severity/period filters)
  + a per-site **timeline** (lead-score sparkline + recent changes) in the drawer
  (`/api/triggers`, `/api/timeline`). **PostHog** ships as an opt-in self-host stack
  (`docker/posthog.compose.yml`) + a `capture()` hook (`POSTHOG_HOST`/`POSTHOG_KEY`) that
  forwards each trigger — not booted by default (Kafka/Redis/CH ≈ 4–6 GB). Verified end-to-end
  (logic → DAG → worker → ClickHouse → dashboard).
- **Phase F — campaigns + AI-tailored e-mail** ✅ *done* — three collections (`campaigns`,
  `emails`, `email_templates`); a **Campaigns** dashboard page (create against a segment, pick an
  angle, generate, preview, send). `lib/campaign-ai.js` generates **per-recipient** copy — Ollama
  (Gemma) when available, deterministic `config/campaign-angles.json` templates as fallback — each
  e-mail driven by that site's own signals (platform, speed, SEO, security, SSL/domain expiry).
  Two fine jobs (`jobs.campaign.generate` → AI copy, `jobs.campaign.send` → `lib/mailer.js`
  nodemailer SMTP for Gmail/Workspace/ESP, **dry-run** when no SMTP). Open/click **tracking**
  (pixel + wrapped links → `/t/o/:token`, `/t/c/:token`), opt-out footer, and campaign metrics
  (email statuses + `np_email_*` PostHog events). Verified end-to-end (1920-contact audience →
  generate → dry-run send → opened/clicked tracked).
- **Phase G — final docs review** ✅ *done* — this consolidation pass: deduped the strong-suits
  list (dropped the stale "(soon) e-mail copy"), refreshed the dataset snapshot (~785k sites) and
  the pipeline overview, added the v2 stages to the diagram, updated the collections/roles/subjects
  lists for Campaigns, and reconciled the Deferred Follow-Ups (completed items struck through).

**Operational (ongoing, not code):** enable heavy audits once CPU frees
(`AUDIT_ENABLED=true` + `--profile audit up ollama` + `enqueue-audits.js --tier=qualified`);
run e-mail verification at scale (provider keys / disposable `EMAIL_FROM`); `gemma3:1b` for the
long tail; finish Authentik + NPMplus + Tailscale production exposure; complete the NL run.

## 12. Deferred Follow-Ups

Running list of deferred/backfill items across phases. **Completed items are struck through**
(kept for history), not deleted.

- **[Part A — Postgres/Directus write-scaling]** Plan `.claude/plans/dev/postgres-scaling-and-whois-rdap.md`.
  **Shipped + live:** ~~**A1 PgBouncer**~~ (`pgbouncer` service, transaction pool, `127.0.0.1:6432`, for the
  direct-PG path + fleet — *not* Directus, which needs session state); ~~**A2 direct-PG writes**~~
  (`lib/pgwrite.js`; sites/companies UPDATEs bypass Directus REST via `DIRECT_PG_WRITE=true`; shadow-`updateItem`
  + `wrapClientPg` = zero call-site edits); ~~**A4 batch contacts**~~ (`handleContacts` N reads + N inserts → 1
  read + 1 multi-row insert). ~~**A3 write-behind**~~ **built + tested + OFF** (`jobs.result.site` → `worker-writer`
  pool, `pgFlushSites` jsonb-merge, coalesce-by-id; `WRITE_BEHIND`/`WRITER_REPLICAS`). ~~**Disk cleanup**~~ — the
  host was **97 % full (3.8 GB free)**, risking the live drain; `docker image/builder prune` freed ~29 GB → **65 %**.
  - **A6 — Postgres tuning finalization (when NL drain finishes / a restart window):** add `wal_compression=on`,
    `checkpoint_timeout=15min`, confirm NVMe, to `docker-compose.yml` postgres `command`. Needs a **Postgres
    restart** (~10 s blip absorbed by the durable queue) — hence deferred.
  - **A5 — read replica: DEFERRED to fleet / a separate DB host (not viable on this host).** Blocker: **Directus
    cannot serve reads from a read-only standby** (it writes its own sessions/activity/cache tables on start), so
    the plan's "second read-only Directus" doesn't work; a replica would need the dashboard's ~18 `/api/stats`
    aggregates rewritten to **raw SQL** against the replica. Given the reads are already **Redis-cached** (B1), the
    DB is small (10 GB), and it's a single small host, the ROI is low here — real read/write isolation belongs on a
    **separate DB host at fleet scale** (where A3 write-behind also pays off). Enable then via a raw-SQL read pool.
- **[Data completion — cross-TLD backfill]** *(active — auto-fires when NL finishes)*
  `orchestrate-backfill.sh` (background watcher) waits for `orchestrate-nl.sh` to finish **and** the
  queues to drain, then enqueues the **missing** jobs across **all** TLDs (each `enqueue-*` is
  resume-filtered → only what's absent) and re-scores:
  - `enqueue-domain-health.js --only=cms` (fingerprint) · `--only=ssl` · `--only=dnsprovider` · `enqueue-contacts.js` (all TLDs)
  - **traffic ranking** → `backfill-traffic.sh`: a **bulk SQL join** against the Tranco top-1M — a *set-op*, not a
    per-domain crawl (the `jobs.traffic` path can't help: `worker-base` doesn't load the ~150 MB Tranco map, so it
    would write `unranked` to everyone). ~3.3k qualified-live sites match a real rank; the rest → `unranked`.
  - then `requalify.js` + `score-leads.js`.

  **Per-stage coverage — 2026-07-11** (living checklist; update the numbers/strikethroughs as the backfill closes each column):

  *Never run at all — all TLDs* (the watcher **closes traffic**; the rest stay deferred):
  | Stage | State | Note |
  |---|---|---|
  | `jobs.traffic` | ⏳ backfill queued | bulk-SQL via `backfill-traffic.sh` |
  | `jobs.whois` | ✗ deferred | ~0 rows; ccTLDs restrictive over port 43 — **revisit with RDAP** (works for any TLD, free, rate-limited) |
  | `jobs.industry` (Ollama) | ✗ deferred | role `ai`; nice-to-have score signal |
  | `jobs.lighthouse.* / nuclei / wpscan / gmb` | ✗ deferred | heavy audits — `AUDIT_ENABLED=false` |
  | `jobs.verify` | 🟡 pilot ready | Reacher SMTP path validated on Hetzner (port 25 open); deploy in [`deploy/reacher/`](deploy/reacher/); awaits Phase 0 (domain + PTR). APIs cover ~100/day meanwhile (§10) |
  | `jobs.campaign.*` | ✗ deferred | outreach paused |

  *Ran but incomplete — the watcher backfills these to 100 %:*
  | TLD | total | fingerprint | contacts | ssl | dnsprovider |
  |---|--:|--:|--:|--:|--:|
  | nl | 423,260 | 57 % | 2.6 % ⏳ | 13 % ⏳ | 14 % ⏳ |
  | se | 317,569 | 54 % | 69 % | 46 % | 46 % |
  | fi | 141,644 | 61 % | 52 % | 47 % | 48 % |
  | no | 141,475 | 51 % | 50 % | 47 % | 47 % |
  | pt | 87,454 | 55 % | 66 % | 51 % | 50 % |

  *Complete (100 %) in every TLD:* `enrich` (fetch/liveness) · `geoip` (ISP/ASN) · `social` · `emailauth` (SPF/DMARC) · `score`/qualify.
- **[Part B — B5]** ~~**Config page**~~ **shipped** — the **Configuração** dashboard page (service status for
  Directus/NATS/Redis/ClickHouse/Ollama + config summaries: verify-providers key-counts, proxy count, campaign
  angles, `sending_accounts`; secrets read server-side via a `config:ro` mount but **never** served). **Still
  deferred: public pages + outreach dashboards** — they **pair with the (paused) cold-outreach infra** (§10, `docs/outreach-ops/`), which awaits the
  user-provisioned clean-IP VMs. Scope when outreach resumes: Config pages (Proxies / Mail servers /
  Workers / Cold-Semiwarm-Warm outreach) over `config/*.json` + the `sending_accounts` collection
  (*security:* edit gitignored secrets via the runtime file, never commit); Public pages (company
  report summary → full report → Book Call → Buy — the email-CTA landing pages); semi-warm/warm
  outreach dashboards + logs + stats (land with outreach Phases 2–4). Plan: `.claude/plans/dev/linear-weaving-quail.md`.
- **[Part B — polish]** The directory **"audience" filter** (in-a-campaign or not) was reverted: it relied on a
  `sites.emails` o2m alias, but that alias got pulled into the standalone scripts' `SELECT *` (Directus didn't
  treat it as relational without the relation's `one_field` wired), so **every `sites` query broke**
  (`column sites.emails does not exist`) and stalled the host enrich/extract jobs. Field dropped, feature removed.
  Proper redo: add a real `sites.in_campaign` boolean set when a campaign email is created (cheap to filter), **or**
  wire the o2m relation's `one_field` correctly and confirm `SELECT *` excludes it. **isp** + **client** filters ship.
- **[Part B — polish]** `/queues` **job-level prioritization** isn't natively supported by the NATS
  **workqueue** (FIFO per consumer) — the page offers per-consumer **purge/delete** and depth, but
  true reprioritization needs the priority-subject model (as the audit tier already does with
  `ondemand`/`qualified`/`rest`). Revisit if per-job priority becomes a real need.
- **[Part B — perf] Postgres tuning shipped (fixed the `503 under pressure` errors).** Postgres was on
  the container default (`shared_buffers=128MB`, `work_mem=4MB`, `effective_cache_size=4GB`) — far too
  small for the 125 GB / 12-core host, so under the concurrent host jobs Directus's event loop stalled and
  returned 503s that made the standalone enrich/extract jobs fail. Fixed in `docker/docker-compose.yml`:
  `shared_buffers=12GB`, `work_mem=48MB`, `effective_cache_size=64GB`, `maintenance_work_mem=2GB`,
  `max_connections=200`, `synchronous_commit=off`, parallel-worker + SSD-cost knobs, `shm_size=2gb`; plus
  Directus `DB_POOL_MAX=40`. Result: the host jobs run **clean (0 errors)** at load ~12, Directus stays 200
  under load. **Then — the score-cascade decouple shipped (`DOMAIN_HEALTH_SKIP_SCORE`).** Draining the
  domain-health queue was still *CPU*-bound because each `ssl` job cascaded a `score` recompute (worker-base at
  *any* concurrency → Postgres ~7 cores / load ~27). Fix: `handleSsl`/`handleWhois` now skip the per-job
  `score` publish when `DOMAIN_HEALTH_SKIP_SCORE=true` (set on `worker-base` in `.env`) — the SSL grade barely
  moves qualification. Result: the ~11k SSL backlog **drained cleanly at conc 8, load stayed ~14–15** (vs. 27).
  **→ run `node score-leads.js` once at the end** to refresh lead scores from the backfilled SSL/domain data.
- **[Part B — perf] The `score` job was made ~7× cheaper** (it was the CPU hog behind the queue saturation).
  Three changes in `worker/handlers.mjs`: (1) the 7 DAG handlers that published `jobs.score` now use
  `msgId: score:<domain>`, so the stream's **24 h dedup collapses them to one score per site** (was up to 7);
  (2) `recordRun` (the ClickHouse Phase-E write — a SELECT + 1–2 INSERTs) is now **fire-and-forget**, off the
  score's critical path (metrics still land — verified ~7.5k obs/3 min); (3) the SSL/DNS backfill skips score
  entirely (`DOMAIN_HEALTH_SKIP_SCORE`). Result: enrich processing ~2× faster, `score` queue stays ~0, load
  ~14. **Caveat of the 24 h collapse:** a domain is scored at most once per 24 h via the DAG, on the state at
  the moment it runs — if signals arrive late (or audits run <24 h after enrich) the score is slightly stale
  until **`node score-leads.js`** (the bulk-SQL finaliser) runs. `score-leads.js` was also fixed to include the
  Fase-D signals (`ssl_expiring`/`whois_expiring`/`cms_outdated`, 20 pts) it had been silently dropping.
- **[Part B — ops]** `enqueue-retries.js` re-queues the FAILURES logged by the standalone host jobs during the
  saturation/`sites.emails` episode: `extract-*.log` → `jobs.contacts`, `enrich-*.log` → `jobs.enrich` (dedup
  `msgId retry:<domain>`). One-shot after an incident; `worker-base` drains them (heavier — enrich re-crawls +
  cascades). ~7.4k retries drained at ~1–1.4/s, load stable ~15, host jobs unaffected.
- **[Phase A]** The running FI/NL/SE streams now emit the new contact fields, but the **`.pt`/`.no`
  contacts extracted before Phase A** still need a `extract-contacts.js --tld=<x> --force` pass (+
  `requalify.js` / `score-leads.js`) to backfill `role_category` / `phone_country` / per-person
  social / E.164 phones / `has_decision_maker`. *(Until then those filters under-count on the
  older TLDs — the data only fully populates on re-extraction.)*
- ~~**[Phase A]** Re-analysis currently re-fetches pages; from **Phase B** it reads MinIO snapshots
  instead (no re-fetch).~~ **Done in Phase B** — analysis jobs read the MinIO snapshot.
- ~~**[Phase B]** The `subdomains` fine handler is a no-op placeholder (crt.sh sharding lands in
  Phase C).~~ **Done in Phase C** — `handleSubdomains` (crt.sh) + `enqueue-subdomains.js`.
- ~~**[Phase B]** The `whois` fine handler is still a no-op placeholder (WHOIS client lands in
  **Phase D**). The `ssl` and `dnsprovider` handlers write fields that only exist once the
  **Phase D** schema fields are added.~~ **Done in Phase D** — `handleWhois`/`handleSsl`/
  `handleDnsprovider` are real (see `lib/whois.js`), the schema fields exist, verified via NATS.
- **[Phase D]** *Backfill ~84 % done, then paused.* `enqueue-domain-health.js` (new producer,
  resumable, skips rows already filled) backfilled `ssl` + `dnsprovider` over the qualified set —
  **354k of ~381k sites done, ~67k left**. It was **paused** because it can't run alongside the
  standalone **NL enrich (conc 18)** without saturating the shared **Directus/Postgres**: each
  `ssl`/`dnsprovider` job cascades a `score` recompute (Directus read+write + ClickHouse write), and
  NL enrich already maxes the DB — even a conc-3 trickle kept load at ~17. **Resume when NL frees the
  DB**: raise `DOMAIN_HEALTH_CONC` + `SCORE_CONC` (worker `.env` knobs; default 8/12) and
  `docker compose up -d worker-base`. Still to run at all: `--only=cms` (re-fetches the homepage —
  `handleFingerprint` now falls back to a live fetch when there's no MinIO snapshot) and
  `--only=whois` (bounded/off-peak — WHOIS servers rate-limit; `.pt` returns null anyway).
- **[Phase C]** Live Tailscale **exit-node** egress needs a tailnet auth key + advertised exit
  nodes to verify end-to-end; the `EGRESS_PROXY` plumbing (fetch + Chromium) and fallback-to-direct
  are done. Routing crt.sh's raw-Postgres egress through an exit node needs the **kernel-mode**
  sidecar (`network_mode: service`), documented but not wired as a default service.
- **[Phase B]** The legacy **coarse** `enrich`/`audit.*` job path is kept for migration; retire it
  once the fine path is the sole producer everywhere.
- ~~**[Phase D→bug]** The `extract-contacts.js` standalone path didn't clip fields and used
  run-on `mailto:`/social captures that ran through HTML-encoded JSON on page-builder sites,
  overflowing `varchar(255)` and crashing whole batches.~~ **Fixed** — anchored full-match email
  validation + bounded slug captures in `lib/contacts.js`/`fingerprints.js`/`audit/social.js` +
  `clip()` in the standalone inserter; ~5.6k garbage emails/socials recovered or nulled.
- ~~**[Phase E]** Metrics/change-detection only fire via the **fine DAG** (`handleScore`); the
  current bulk enrichment runs through the **standalone** scripts, which don't call `recordRun`.~~
  **Done** — `enrich-sites.js` now calls `recordRun()` for every live site (fail-soft, gated by
  `CLICKHOUSE_URL`), so the **standalone** bulk path feeds ClickHouse too, not just the DAG. (The
  `score-leads.js` bulk backfill is a pure SQL `UPDATE` with no per-site loop — left as-is.)
- **[Phase E]** The **Triggers** feed is global (severity/period/domain filters); per-**segment**
  trigger filtering (join change_events to a Directus site-filter) is not yet wired.
- **[Phase E]** **PostHog** is delivered as an opt-in stack (`docker/posthog.compose.yml`) + a
  `capture()` hook, but not booted (Kafka/Redis/CH ≈ 4–6 GB). Bring it up + run first-run
  migrations, then set `POSTHOG_HOST`/`POSTHOG_KEY` to forward triggers as product events.
- **[Phase F]** Sending runs in **dry-run** until SMTP is configured (`SMTP_HOST`/`SMTP_USER`/…);
  a **real send** against Gmail/Workspace/ESP is unverified here (no live mailbox). A dedicated
  **Gmail/Workspace OAuth2** transport (vs SMTP app-password) is not implemented. Set
  `CAMPAIGN_TRACK_BASE` to the dashboard's public URL for open/click tracking to work in real sends.
- **[Phase F]** Copy generation used the **template fallback** in verification because Ollama runs
  under `--profile audit` (not up here); with `gemma3:4b` running, `campaign.generate` produces the
  richer AI variant. Audience de-dup is **per e-mail address**; de-dup **per site** (one contact per
  company) and a smarter best-contact pick are not yet wired.
- **[Outreach — lead score]** Three already-collected signals aren't scored yet: **domain
  registration age** (`domain_age_days`), **DNS-provider internal ranking** (`dns_provider` → a
  ranking table), and benchmark metrics. Small addition to `config/lead-score.json` + `lib/lead-score.js`.
- **[Outreach — Phase 1]** The clean-IP validation fleet (Oracle/VPS + Dante + Reacher) is provisioned
  via `docs/outreach-ops/`; the live SMTP path is unverified until those VMs exist. Fill
  `config/verify-proxies.json` + `config/verify-providers.json`, then clean the ~155k contacts.
- **[Outreach — Phase 2]** The cold sender (`campaign-drip.js`) + bounce/reply poller
  (`imap-poller.js`) are built + dry-run-verified, but real sending awaits the `docker-mailserver`
  fleet (`docs/outreach-ops/03-sending-fleet.md`) + secondary domains + warm-up. `imap-poller.js`
  bounce-parsing needs tuning against real DSNs. Fill `config/sending-accounts.json`.
- **[Outreach — Phase 2]** Two send paths coexist: the **drip** (paced cold, host) and the Phase-F
  `jobs.campaign.send` → `handleCampaignSend` (immediate/dry-run, single transport). Decide whether
  the immediate path stays for one-off sends or is folded into the drip.
- **[Outreach — Phase 3]** `export-engaged-to-esp.js` produces the CSV; the **pull-back** of ESP
  engagement (Brevo/MailerLite webhook → `contacts.esp_engaged`) is documented but not wired.
- **[Outreach — Phase 4]** `export-warm-to-mautic.js` (API + CSV) + runbooks are ready; the live
  bridge needs Mautic up + SES out of Sandbox + the **SNS bounce/complaint → DNC** webhook wired
  (currently documented). Warm the SES domain before volume.

## Pending retirement (review before delete)

Code the outreach plan makes dead. **Do not delete until reviewed + signed off** — kept here so the
repo cleanup (Phase 5 of the outreach plan) is deliberate, not silent.

- `lib/proxy-pool.js` (free-public-proxy fetching) + `data/proxies.json` — superseded by the clean
  static proxies in `config/verify-proxies.json` + Reacher (`lib/reacher.js`). *Verified ~0.06 %
  usable (2/3270).* `verify-emails.js` no longer imports it.
- `smtpProbe` + `probeViaProxy` path in `lib/email-verify.js` — Reacher supersedes the raw SMTP
  state machine. (Keep the **prefilter helpers** — `syntaxValid`, `isRoleLocal`, `isDisposable`,
  `classifyCatchAll`, `generatePatterns`, `resolveMx`, `nameTokens` — they're still used.)
- `email_templates` Directus collection — created in Phase F but **never read/written** (angle
  fallbacks live in `config/campaign-angles.json`).
- `.claude/conversations/smtp-verification-plan.md` — obsolete approach (free public proxies).

> The `verify` NATS slot is **no longer retirable** — it's now the live distributed verify fleet
> (`handleVerify` + `WORKER_ROLES=verify`, §10). Removed from this list.

## 13. Repository map

```
tld-domains-v2.js        Domain discovery (Common Crawl S3 columnar index)  → out/dominios_<tld>.txt
tld-domains.js           Older CDX-API discovery (reference)
crtsh-enum.js            Per-seed subdomain enumeration (Certificate Transparency)
enrich-sites.js          Enrichment + cheap audit + general contacts + qualify + score + upsert
enrich-subdomains.js     Fills sites.hostnames from crt.sh
extract-contacts.js      People-contact extraction (--tld scope)  (also exports processSite)
audit-cheap.js           Backfill of cheap audit signals for already-enriched sites
requalify.js             Bulk SQL backfill of qualified + qualified_reasons (from config)
score-leads.js           Bulk SQL backfill of lead_score + breakdown (from config)
verify-emails.js         Tiered e-mail verification engine (prefilter + provider routing + Reacher + API pool)
campaign-drip.js         Paced multi-account cold sender (host loop; caps + warm-up + DNC) (outreach Phase 2)
imap-poller.js           Reads sending mailboxes → bounces (DNC) + replies (responded) (outreach Phase 2)
export-engaged-to-esp.js Engaged contacts → CSV for Brevo/MailerLite reputation ladder (outreach Phase 3)
export-warm-to-mautic.js Warm contacts → Mautic (API or CSV) for the SES nurture tier (outreach Phase 4)
update-geoip.js          Download/refresh MaxMind GeoLite2
fetch-tranco.js          Download the Tranco top-1M list
bootstrap-directus.js    Idempotent schema-as-code (collections, fields, relations, seeds)
bootstrap-clickhouse.js  Idempotent ClickHouse schema (observations + change_events)
enqueue-enrich.js        Producer → jobs.enrich (coarse) or jobs.fetch (--fine, DAG root)
enqueue-audits.js        Producer → jobs.audit.* (--tier / --domain)
enqueue-discover.js      Producer → jobs.discover (TLD-as-job, block-sharded)
enqueue-subdomains.js    Producer → jobs.subdomains (crt.sh, exit-node-shardable)
enqueue-domain-health.js Producer → jobs.ssl/dnsprovider/whois/fingerprint backfill (resumable)
run-parallel-tlds.sh     Parallel per-TLD streams (SE extract + FI/NL enrich→extract)

config/
  qualification.json     Qualification rule (require_email + signals_any)
  lead-score.json        Lead-score weights (tunable, no redeploy)
  cms-latest.json        Latest CMS versions (for cms_outdated)
  campaign-angles.json   Per-angle AI guidance + fallback e-mail templates (Phase F)

lib/
  directus.js  env.js  geoip.js  company.js  fingerprints.js  contacts.js  crtsh.js
  phone.js              International phone parsing (libphonenumber-js) + tldToCountry
  qualify.js            Configurable qualification predicate
  lead-score.js         Weighted 0–100 lead score
  jobs.js               NATS JetStream topology (subjects/consumers/roles) + publish
  worker-telemetry.js   Worker heartbeat + per-job counters/durations + recent logs → Redis (dashboard /workers)
  whois.js              WHOIS lookup (whoiser) → registrar/dates/age/expiring_soon
  metrics.js            ClickHouse observations + change-detection + PostHog capture (Phase E)
  ollama.js             Shared Ollama client (/api/generate + JSON schema + timeout) — campaign-ai, classifier, agents
  campaign-ai.js        Per-recipient e-mail copy (Ollama + template fallback) (Phase F)
  mailer.js             SMTP send (nodemailer) + open/click tracking + dry-run (Phase F)
  reacher.js            Reacher engine wrapper + clean-proxy pool + provider routing (outreach Phase 1)
  artifacts.js          MinIO page-snapshot store (put/get/list versions)
  egress.js             EGRESS_PROXY-aware external fetch + Chromium proxy (Tailscale exit node)
  email-verify.js  verify-providers.js  verify-core.js  reacher.js   (tiered e-mail verification)
  audit/
    social.js  gmb.js  cpanel.js  load.js  emailauth.js  locality.js  jsonld.js   (cheap)
    lighthouse.js  nuclei.js  wpscan.js  tranco.js  ollama-classify.js  gmb-lookup.js  (heavy)

worker/worker.mjs        Role-scoped worker: registers consumers per WORKER_ROLES, dispatches
worker/handlers.mjs      Fine-grained DAG handlers (fetch/…/score/ssl/whois/dnsprovider/campaign.*)
worker/Dockerfile        Heavy image (Chromium + Nuclei + WPScan + Node) — browser/security/ai
worker/Dockerfile.base   Slim base image (634 MB) — the light job roles
dashboard/server.mjs     Express API (Directus proxy, filters, segments, lead score, CSV, audit,
                         timeline/triggers, campaigns + open/click tracking)
dashboard/public/        SPA (Directory, Contacts, Triggers, Segments, Campaigns, site drawer)
docker/docker-compose.yml  Isolated stack (+ clickhouse, profile `analytics`)
docker/docker-compose.worker.yml  Remote-fleet worker (verify/base) → central NATS+Directus
docker/posthog.compose.yml Opt-in PostHog self-host stack (heavy; not booted by default)
lib/verify-core.js       Shared per-domain verify logic (CLI + `jobs.verify` worker)
lib/verify-providers.js  Free-tier API pool: multi-key, proxy routing, 12 adapters
enqueue-email-verification.js  Enqueue `jobs.verify`, prioritised by `lead_score`
db/audit-indexes.sql     Secondary indexes for the filter columns
db/clickhouse-schema.sql Time-series schema (observations + change_events)
db/data-quality.sql      Read-only coverage/gaps/red-flags report per TLD
config/verify-providers.example.json  API-pool config shape (multi-key / keyless / proxy)
config/verify-proxies.example.json  Shape of the clean-proxy config (outreach Phase 1)
docs/distributed-fleet.md  Runbook: free-tier cloud VMs (Debian+Docker+Tailscale) verify fleet
docs/runbook-db-host.md    Runbook: dedicated Postgres+PgBouncer+Tailscale CT (Proxmox) — the "fat DB host"
docs/runbook-worker-vms.md Runbook: worker VMs (Docker+Tailscale) for a 2nd Proxmox host + free clouds
docs/outreach-ops/       Provisioning runbooks: port-25 gate, blocklists, Dante, Reacher, DMS, warm-up
```

House style: Node.js **ESM**, Portuguese logs, `pool(items, n, worker)`
concurrency, resume via `*_checked_at`, idempotent upsert, and two hard-won regex
rules on HTML-scale text: **(1) bounded quantifiers** (an unbounded e-mail regex once
caused catastrophic backtracking that froze an entire run); **(2) validate captured
emails/URLs with an anchored full-match + `clip()` before insert** — page-builder
sites embed hrefs inside HTML-encoded JSON (`&quot;`), so negated-class captures run
on through hundreds of chars of junk and overflow `varchar(255)`.

---

## 14. Running it

```bash
# 0. Config
cp docker/.env.example docker/.env            # fill in secrets (openssl rand -hex 32)

# 1. Bring up the stack + schema
docker compose -f docker/docker-compose.yml up -d postgres directus dashboard nats
node bootstrap-directus.js                    # idempotent
docker exec -i netprospect-postgres-1 psql -U netprospect -d netprospect < db/audit-indexes.sql

# 2. Discover a TLD
node tld-domains-v2.js pt                      # → out/dominios_pt.txt

# 3. Enrich + extract contacts (standalone)
node enrich-sites.js  --input=out/dominios_pt.txt
node extract-contacts.js --tld=pt

#    …or the same via the queue
docker compose -f docker/docker-compose.yml up -d --scale worker=3 worker
node enqueue-enrich.js --input=out/dominios_pt.txt

# 4. Heavy audits (when CPU is free)
node fetch-tranco.js
docker compose -f docker/docker-compose.yml --profile audit up -d ollama
# set AUDIT_ENABLED=true in docker/.env, then:
docker compose -f docker/docker-compose.yml up -d worker
node enqueue-audits.js --tier=qualified

# 5. E-mail verification (see §10 + docs/outreach-ops/ for the clean-IP fleet + Reacher)
node verify-emails.js --dry-run --limit=25                 # prefilter + provider routing + candidates
REACHER_URL=http://127.0.0.1:8080 node verify-emails.js --limit=500   # live (needs clean proxies)

# 6. Analytics — change detection + triggers (Phase E, opt-in)
#    Set CLICKHOUSE_URL (non-empty) in docker/.env, then:
docker compose -f docker/docker-compose.yml --profile analytics up -d clickhouse
CLICKHOUSE_URL=http://localhost:8123 node bootstrap-clickhouse.js
docker compose -f docker/docker-compose.yml up -d worker-base dashboard   # pick up CLICKHOUSE_URL
#    Standalone enrichment then records observations automatically (enrich-sites.js → recordRun).
#    Backfill domain-health onto the existing corpus (resumable; worker-base drains it).
#    NOTE: each job cascades a `score` recompute → don't run it while a heavy standalone
#    enrich stream is saturating Postgres. Throttle via worker .env: DOMAIN_HEALTH_CONC,
#    SCORE_CONC (defaults 8/12; drop to 3/3 for a trickle). worker-base drains the queue.
node enqueue-domain-health.js --only=ssl,dnsprovider          # safe, whole qualified set
# node enqueue-domain-health.js --only=cms   --limit=20000    # re-fetches homepages
# node enqueue-domain-health.js --only=whois --tld=se --limit=5000   # WHOIS is rate-limited
#    (PostHog, heavier & optional: docker compose -f docker/posthog.compose.yml up -d)

# 7. Campaigns (Phase F) — the worker-base already runs the campaign jobs.
#    Dashboard → Campanhas → new campaign (segment + angle) → Gerar → preview → Enviar.
#    Sending is DRY-RUN until SMTP is set in docker/.env:
#      SMTP_HOST=smtp.gmail.com SMTP_USER=you@workspace.tld SMTP_PASS=<app-password>
#      CAMPAIGN_TRACK_BASE=https://<dashboard-public-url>   # enables open/click tracking
#    Richer AI copy needs Ollama up (--profile audit up -d ollama); else template fallback.

# 8. Dashboard  →  http://localhost:3001  (Triggers page + per-site timeline + Campaigns)
```

---

*NetProspect is internal tooling for Netmaster. All contact data is processed
under B2B legitimate interest; probes are throttled, reputation-safe, and run
from disposable infrastructure.*
