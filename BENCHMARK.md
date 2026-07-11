# NetProspect — Benchmark da frota

> **Documento vivo.** Atualizar sempre que se afina concorrência, se muda specs de uma VM,
> ou se adiciona um novo worker host. A metodologia está no fim (§5) para reproduzir.
>
> **Última atualização:** 2026-07-11 · frota: HEL1 (Finlândia, app) + DE1 (Alemanha, VM).

---

## 1. Servidores

| Host | Papel | CPU / RAM | Rede ao NATS/CT | Workers (`base`) |
|------|-------|-----------|-----------------|------------------|
| **HEL1** | App host (NATS, Redis, MinIO, Directus, dashboard) **+ workers** | 18c / 251 GB | local (0 ms) | ×7 |
| **DE1** | Worker VM dedicado | 6c / 23 GB | tailnet WAN (~35 ms, FI↔DE) | ×4 |
| **CT `np-db`** | PostgreSQL 16 + PgBouncer (write-path da frota) — **não corre workers** | 14c / 64 GB | local (0 ms) | — |

Clouds free (Oracle/GCP) e mais VMs Proxmox: **por adicionar** (colunas futuras nesta tabela).

---

## 2. Benchmark por tipo de job × host

**Concorrência** = (por-worker × nº workers). **Throughput** = linhas/min medidas.
`TBD` = ainda não isolado num benchmark limpo (correu dentro do enrich/DAG, sem medição própria).

| Job (consumer) | por-worker | **HEL1** 18c ×7 | **DE1** 6c ×4 | Notas / gargalo |
|----------------|-----------:|-----------------|---------------|-----------------|
| **enrich** (coarse) | 24 | 168 conc · ~915/min¹ | 96 conc · ~286/min² | ¹pico nos 12c antigos ×6; ²medido nos 4c antigos ×2. Corpus COMPLETO. |
| **contacts** | 56 | 392 conc · **~3 150/min** | 224 conc · ~0 útil³ | cap `maxAckPending` 512; depois load do HEL1 |
| **fingerprint** (cms) | 48 | 336 conc · **~2 200/min** | 192 conc · ~0 útil³ | fetch-bound; escritas no CT + load HEL1 |
| **ssl** | 8 | 56 conc · *drena ≈ ritmo de enqueue* (milhares/min) | 32 · ~0³ | job leve (TLS handshake) |
| **dnsprovider** | 8 | 56 conc · *idem* | 32 · ~0³ | job leve (NS lookup) |
| **whois** | 4 | 28 conc · **rate-limited** (~25-41 in-flight) | 16 · ~0³ | limite das registries; .pt precisa WhoisXML key |
| **traffic** | 20 | corre no **CT** (join Tranco top-1M), não nos workers | — | ~4k matches (baixo é esperado) |
| **score** | 2⁴ | 14 conc · TBD | 8 · TBD | ⁴`SCORE_CONC=2` (estrangula a cascata de amplificação) |
| **geoip** | 12 | TBD | TBD | corre dentro do enrich/DAG |
| **dns** | 12 | TBD | TBD | idem |
| **social** | 8 | TBD | TBD | idem |
| **locality** | 8 | TBD | TBD | idem |
| **emailauth** (SPF/DMARC) | 10 | TBD | TBD | idem |
| **fetch** (root fino) | 8 | TBD | TBD | DAG fino |
| **subdomains** | 2 | TBD | TBD | `maxAckPending` 4 |
| **discover** | 2 | TBD | TBD | `maxAckPending` 4 |
| **industry** (AI) | — | — (role `ai`, Ollama) | — | nunca correu |
| **audit_qualified/rest/ondemand** (browser) | — | — (role `browser`, `maxAckPending` 8) | — | nunca correu (render pesado) |
| **verify** (email) | 4 | — (role `verify`) | — | precisa API keys / IPs |
| **campaign_generate / _send** | 4 / 6 | TBD | TBD | Fase F (outreach) |

³ **DE1 fica ocioso nos consumers pós-enrich:** no pull partilhado, o HEL1 (0 ms ao NATS) agarra os
jobs antes do DE1 (~35 ms WAN). O DE1 só rendeu quando o **próprio enrich** era o gargalo.

---

## 3. Picos combinados da frota (referência histórica)

| Fase | Specs | Config | Throughput total |
|------|-------|--------|------------------|
| enrich | 12c + 4c (antigo) | HEL1 ×6 + DE1 ×3 | ~1 651/min (máx seguro) |
| enrich | 12c + 4c | HEL1 ×7 + DE1 ×3 | 1 825/min (HEL1 load 17 ⚠️) |
| enrich+contacts | 18c + 6c | HEL1 ×8 + DE1 ×4 | ~4 346/min |
| enrich+contacts | 18c + 6c | HEL1 ×9 + DE1 ×4 | ~4 967/min (HEL1 load 17 ⚠️) |
| contacts+cms (pós-cap) | 18c + 6c | HEL1 ×7, `maxAckPending` 512 | ~5 350/min (contacts+cms) |

---

## 4. Achados & alavancas de afinação

1. **`max_ack_pending` (default 256) é o teto por-consumer**, não os workers. Partilhado por todos os
   workers no consumer durável → +workers não passa dos 256 in-flight. **Lever:** subir `maxAckPending`
   (`lib/jobs.js`; contacts+fingerprint já a 512). Mutável a quente via `jsm.consumers.update`.
2. **`fingerprint` (cms) é CPU/fetch-pesado** → concorrência própria **`FINGERPRINT_CONC`** (env, default 4;
   backfill a 48). Antes estava hardcoded a 8 → um backfill a ×8 workers = 64 parses = **load 59 (incidente)**.
3. **`DOMAIN_HEALTH_CONC`** (ssl/dnsprovider/whois) e **`SCORE_CONC`** (estrangula a cascata de re-score)
   throttlam os backfills sem saturar o CPU. `DOMAIN_HEALTH_SKIP_SCORE=true` salta o re-score no ssl/whois.
4. **O CT nunca foi o gargalo** (pico ~10 de 14 cores; média 3-6). A parede é sempre a **load do worker host**.
5. **Tetos de load seguros:** HEL1 ≤ ~15 de 18 (corre a tooling do dev + a stack); DE1 ≤ ~6 de 6.
6. **Próximo ganho real = worker host co-localizado** (rede do NATS/CT), não mais VMs remotas (a latência
   WAN esfomeia-as no pull partilhado).

---

## 5. Como fazer benchmark (reproduzir)

- **Throughput total:** delta de `SELECT count(*) FROM sites (+contacts)` no CT por janela de tempo
  (`scratchpad/measure-fleet.sh`). Nota: enrich cresce `sites`; contacts cresce `contacts`; usar a soma.
- **In-flight / filas por consumer:** `GET /api/queues` (`pending`, `ackPending`, `waiting`, `byRole`).
- **Load dos hosts:** `/proc/loadavg`; **CT:** `ct-stat.sh` (`pgcpu`, `active_q`, `load`).
- **Concorrência por-worker:** mapa `CONC` em `worker/worker.mjs` (env: `ENRICH_CONCURRENCY`,
  `CONTACTS_CONCURRENCY`, `FINGERPRINT_CONC`, `DOMAIN_HEALTH_CONC`, `SCORE_CONC`, `VERIFY_CONCURRENCY`).

### Como atualizar este ficheiro
Ao afinar/experimentar: correr o benchmark acima, preencher a célula (concorrência · throughput),
juntar coluna se for VM nova, e atualizar a data no topo. Preencher os `TBD` à medida que se medem.
