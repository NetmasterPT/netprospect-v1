# Assessment — que containers devem sair do HEL1 (e para onde)

> **O princípio:** separar por **perfil de I/O**, não por "é grande". Um container só deve sair
> do host da app se o que ele precisa (disco barato, CPU dedicado, proximidade à DB) for
> **diferente** do que o host oferece. Mover o que é **latency-crítico** é como perder throughput
> — já o provámos: os workers remotos morriam à fome na workqueue partilhada do NATS.
>
> **Estado atual (2026-07-12):** HEL1 = 18c / 251 GB / NVMe · CT `np-db` = 14c / 64 GB (Postgres,
> já migrado) · DE1 = 6c / 24 GB + **HDD barato por usar**.

---

## Veredicto por container

| Container | Perfil de I/O | Onde deve viver | Prioridade |
|---|---|---|---|
| **postgres** | disco rápido + latência à app | **CT `np-db`** | ✅ **FEITO** |
| **minio** | **disco-pesado**, escreve-1×/lê-raro, latency-**tolerante** | **DE1 (HDD)** | 🔴 **ALTA** |
| **clickhouse** | disco-pesado, analítico, latency-tolerante | **DE1 (HDD)** — ou desmantelar | 🟠 MÉDIA |
| **ollama** | **CPU-pesado** (inferência), latency-tolerante (segundos) | **VM de IA dedicada** | 🟠 MÉDIA |
| **worker** (browser/security/ai) | **CPU-pesado** (Chromium+Nuclei) — *é o motor da load* | **VMs de CPU dedicadas** | 🟠 MÉDIA |
| **directus** | CPU + muito conversador com a DB | **co-localizar no CT `np-db`** | 🟡 MÉDIA-BAIXA |
| **dashboard** | leve, user-facing, chatty com o Directus | segue o Directus | 🟢 BAIXA |
| **nats** | ⚡ **latência-CRÍTICA** (os workers puxam em loop) | **FICA no HEL1** | ⛔ **nunca mover** |
| **redis** | latência-sensível (cache + telemetria), minúsculo | **FICA no HEL1** | ⛔ **nunca mover** |
| **worker-base** | network-bound (fetch/DNS/whois) | frota distribuída | ↔️ contínuo |

---

## Racional (o que interessa)

### 🔴 MinIO → DE1 (HDD)
É **o caso mais óbvio de todos**. Object storage: escreve-se uma vez no fim da auditoria
(*fire-and-forget*), lê-se só ao gerar o PDF do cliente. **Zero benefício em NVMe.** E é o que
**mais vai crescer**: 71 KB/site × 1M = **71 GB** (com screenshots seriam 396 GB — ver
`lib/audit/lighthouse.js:leanLhr`). O HEL1 tem ~34 GB livres — **não cabe**.
👉 Runbook: [`docs/runbook-minio-de1.md`](./runbook-minio-de1.md)

### 🟠 ClickHouse → DE1 (HDD) *ou desmantelar*
Mesmo perfil do MinIO (armazém analítico, colunar, latency-tolerante, 3 GB e a crescer).
**MAS:** verificar primeiro se está a ser usado — se a Fase E nunca arrancou a sério, o custo/benefício
de manter um ClickHouse é negativo. **Decidir antes de migrar.**

### 🟠 Ollama → VM de IA dedicada
Inferência (gemma3:4b) é **CPU-pesada** e está a competir com o Chromium das auditorias pelo mesmo
CPU do HEL1. A latência **não** importa (a chamada demora segundos; +35 ms de WAN é ruído).
👉 Tirá-lo do HEL1 liberta CPU para as auditorias — **é a alavanca de CPU mais barata que temos**.
⚠️ **Não** para o DE1 (só 6 cores → inferência lenta). Precisa de uma VM com cores a sério.

### 🟠 Workers pesados (Chromium) → VMs de CPU dedicadas
São **o motor da load** (cada auditoria ~1-2 cores; a 8 concorrentes a load vai a 14/18).
Historicamente não dava para os pôr remotos — os workers remotos **morriam à fome** na workqueue
partilhada. **Isso já está resolvido:** a arquitetura de **fila dedicada por host**
(`JOB_STREAM`/`JOB_SUBJECT_PREFIX` + feeder com hash-shard, commit `73f06a7`) permite dar a um host
remoto a **sua própria fila** que o feeder mantém cheia. **Um worker pesado remoto agora funciona.**

### 🟡 Directus → co-localizar no CT `np-db`
O Directus é um proxy REST sobre o Postgres: **cada** pedido é ≥1 round-trip à DB. Hoje faz
HEL1 → tailnet → CT em **todas** as queries. Pô-lo *ao lado* do Postgres elimina esse salto e liberta
CPU do HEL1 (o Directus já foi o gargalo, pré-A2). O CT tem folga (~4-6 de 14 cores).
⚠️ Requer repontar `DIRECTUS_URL` em workers/dashboard/scripts do host.

### ⛔ NATS e Redis — NÃO MOVER
- **NATS**: os workers fazem `pull` em ciclo apertado. Foi exatamente por causa da latência WAN que
  o DE1 ficava ocioso. Mover o NATS para longe dos workers **estrangula a frota toda**.
- **Redis**: cache do dashboard + telemetria dos workers (heartbeat a cada 10 s). Minúsculo,
  latency-sensível. Não há nada a ganhar em movê-lo.

---

## Ordem recomendada
1. **MinIO → DE1 (HDD)** — maior ganho de disco, risco quase nulo (é fail-soft), runbook pronto.
2. **Decidir o ClickHouse** — usar ou desmantelar? Se usar → DE1 (HDD).
3. **Ollama → VM de IA** — a maior libertação de CPU no HEL1.
4. **Workers pesados → VMs de CPU** (com a fila dedicada) — escala as auditorias para lá do teto do HEL1.
5. **Directus → CT** — otimização de latência + CPU; fazer por último (mexe em muitas configs).

**Regra de ouro:** *disco-pesado e latency-tolerante → HDD barato · CPU-pesado → VM dedicada ·
latency-crítico → fica ao pé de quem o consome.*
