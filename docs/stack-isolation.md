# Assessment — que containers devem sair do HEL1 (e para onde)

> **O princípio:** separar por **perfil de I/O**, não por "é grande". Um container só deve sair
> do host da app se o que ele precisa (disco barato, CPU dedicado, proximidade à DB) for
> **diferente** do que o host oferece. Mover o que é **latency-crítico** é perder throughput
> — já o provámos: os workers remotos morriam à fome na workqueue partilhada do NATS.
>
> **Estado (2026-07-13):** HEL1 = 18c / 251 GB / NVMe · `np-db` = 14c / 64 GB (Postgres, ✅ migrado)
> · `de-minio` = 500 GB no DE1 (MinIO, ✅ migrado) · DE1 workers = 6c / 24 GB.
>
> O inventário vivo da frota está em [`LOAD-DISTRIBUTION.md`](../LOAD-DISTRIBUTION.md).

---

## Veredicto por container

| Container | Perfil de I/O | Onde deve viver | Estado |
|---|---|---|---|
| **postgres + pgbouncer** | disco rápido + latência à app | **`np-db`** (CT, HEL1) | ✅ **FEITO** |
| **minio** | **disco-pesado**, escreve-1×/lê-raro, latency-**tolerante** | **`de-minio`** (DE1, 500 GB) | ✅ **FEITO** |
| **clickhouse + posthog** | disco-pesado, analítico, latency-tolerante | **`de-analytics`** (DE1) | 🟠 VM por criar |
| **ollama** | **CPU-pesado** (inferência), latency-tolerante (segundos) | **`hel1-ollama`** (CPU, sem GPU) | 🟠 VM criada, deploy pendente |
| **nats** | ⚡ **latência-CRÍTICA** (os workers puxam em loop) | **`np-server`** — VM no MESMO Proxmox (LAN) | 🟡 a separar |
| **redis** | latência-sensível (cache + telemetria), minúsculo | **`np-server`** (idem) | 🟡 a separar |
| **directus** | CPU + conversador com a DB | **`np-server`** | 🟡 a separar |
| **dashboard** | leve, user-facing, chatty com o Directus | **`np-server`** (segue o Directus) | 🟢 a separar |
| **worker** (browser) | **CPU-pesado** (Chromium) — *é o motor da load* | **VMs de CPU dedicadas** | 🟠 |
| **worker-base / security** | network-bound (fetch/DNS/whois/nuclei) | frota distribuída (free VMs) | ↔️ contínuo |

---

## Racional (o que interessa)

### ✅ MinIO → `de-minio` (DE1) — FEITO
Era **o caso mais óbvio de todos**. Object storage: escreve-se uma vez no fim da auditoria
(*fire-and-forget*), lê-se só ao gerar o PDF do cliente. **Zero benefício em NVMe.** E é o que
**mais vai crescer**: 71 KB/site × 1M = **71 GB** (com screenshots seriam 396 GB — ver
`lib/audit/lighthouse.js:leanLhr`).
**Resultado:** 16.929 reports + 20 snapshots (843 MB) numa VM com 500 GB (1% usado). Toda a frota
escreve lá (HEL1 + os **dois** projetos compose do DE1). Round-trip validado das duas pontas.
👉 [`runbook-minio-de1.md`](./runbook-minio-de1.md) · falta só parar o MinIO local do HEL1 (§8, rollback).

### 🟠 ClickHouse + PostHog → `de-analytics` (DE1)
Mesmo perfil do MinIO (armazém analítico, colunar, latency-tolerante, e a crescer).
**Decisão: MANTER** — a Fase E tem **10M observações**, é dado real. Vai para o disco barato do DE1.
O PostHog usa ClickHouse como backend → vivem juntos (é o pesado: traz Postgres+Redis+Kafka próprios,
+4-6 GB → *opt-in*).
👉 [`runbook-analytics-de.md`](./runbook-analytics-de.md)

### 🟠 Ollama → `hel1-ollama` (CPU, **sem GPU**)
A inferência (gemma3:4b) é **CPU-pesada** e competia com o Chromium das auditorias pelo mesmo CPU do
HEL1 (chegou a 14 de 18 cores). Tirá-la para uma VM própria liberta CPU — **é a alavanca de CPU mais
barata que temos**. A latência não importa (a chamada demora segundos).
**Decisão: sem compra de GPU.** Fica em CPU (custo 0), com `OLLAMA_TIMEOUT_MS` alto. Em contrapartida,
o **batch** de `industry` deixou de usar o Ollama (107 s/job → 26 dias) e passou ao **classificador
heurístico** (`lib/audit/industry-heuristic.js`, 6.640/h — **154× mais rápido**). O Ollama serve o
*on-demand* e os casos difíceis.

### 🟠 Workers pesados (Chromium) → VMs de CPU dedicadas
São **o motor da load** (cada auditoria ~1-2 cores; a 8 concorrentes a load vai a 14/18).
Historicamente não dava para os pôr remotos — os workers remotos **morriam à fome** na workqueue
partilhada. **Isso já está resolvido:** a **fila dedicada por host** (`JOB_STREAM`/`JOB_SUBJECT_PREFIX`
+ feeder com hash-shard, commit `73f06a7`) dá a um host remoto a **sua própria fila**, que o feeder
mantém cheia. **Um worker pesado remoto agora funciona.**

### 🟡 NATS, Redis, Directus, Dashboard → `np-server` (VM no MESMO Proxmox)
Estes quatro são o **control-plane** e estão no *hot-path* de cada job — mas hoje partilham a VM com os
workers pesados, e quando o Chromium satura os cores o Directus dá 503 *"under pressure"* e os pulls do
NATS atrasam-se.
**A solução NÃO é mandá-los para longe** (o NATS longe dos workers estrangula a frota — foi por isso que
o DE1 ficava ocioso). É pô-los numa **VM própria no mesmo host Proxmox (HEL1)**: ganham CPU garantido e
continuam a **~0,1 ms** dos workers de Helsínquia, por LAN. Os workers remotos já falavam com eles por
tailnet → para esses nada muda.
⚠️ O único estado a migrar é o **JetStream do NATS** (ficheiro) → fazer com o backlog baixo.
👉 [`runbook-server-hel1.md`](./runbook-server-hel1.md)

---

## Ordem recomendada

1. ~~**MinIO → DE1**~~ — ✅ **FEITO** (maior ganho de disco, risco quase nulo).
2. **Free VMs como Worker L** (`security` + `whois`) — add-only, sem tocar no HEL1; precisa da imagem
   `worker-security` (sem Chromium, arm64).
3. **`de-analytics`** (ClickHouse + PostHog) e **`hel1-ollama`** — ambos fail-soft, risco baixo.
4. **`np-server`** (Directus+Dashboard+NATS+Redis) — a maior libertação de CPU no HEL1, mas mexe no que
   corre → fazer com os backfills drenados.
5. **Workers pesados → VMs de CPU** (com a fila dedicada) — escala as auditorias para lá do teto do HEL1.

**Regra de ouro:** *disco-pesado e latency-tolerante → HDD barato · CPU-pesado → VM dedicada ·
latency-crítico → fica ao pé de quem o consome (mesma LAN, não necessariamente a mesma VM).*
