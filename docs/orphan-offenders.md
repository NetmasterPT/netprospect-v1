---
title: "Órfãos reincidentes (poison) — lista de retry-policy"
type: working
tags: [ops, jobs]
related: []
owner: infra
status: living
updated: 2026-07-18
visibility: internal
---

# Órfãos reincidentes (poison) — lista de retry-policy

Jobs que **voltam a ficar órfãos** (esgotam o `maxDeliver`) ronda após ronda, **com o mesmo erro**.
O monitor de saúde (loop de 15 min) relança automaticamente os órfãos transitórios (que passam à 2ª/3ª
tentativa), mas os que ficam em **loop com o mesmo erro** entram aqui — para decidirmos se vale a pena
continuar a retentar e, se sim, com que política (max-tentativas / janela de tempo / cadência).

Ver a instrução em [`../DEBUGGING-TODO.md`](../DEBUGGING-TODO.md) → "Gestão ativa de órfãos + retries".

## Como o monitor preenche isto
- Regista `domínio · job · assinatura-de-erro · nº-de-vezes-re-orfanado · 1º-visto · último-visto`.
- **≥3 re-orfanamentos com o MESMO erro** → estado **POISON**, o monitor **deixa de relançar** e sinaliza
  na conversa para o utilizador decidir a política.
- Quando decidirmos, anota-se a **política** na coluna (ex.: `desistir` · `max=5` · `retry 1×/dia` ·
  `retry até <data>`). Marca **RESOLVIDO** quando o job passar a ter sucesso ou for descontinuado.

## Reincidentes

| Estado | Job | Domínio(s) | Erro (assinatura) | Vezes | 1º visto | Último visto | Política decidida |
|---|---|---|---|---|---|---|---|
| A vigiar | lighthouse_mobile | dieselspridare.se, axelpriset.se | `desisto após 3` (Chrome instável / perf-null — sites conhecidos-difíceis do incidente >55) | 1 | 2026-07-17T09:55 | 2026-07-17T09:55 | (relançados 1×; se re-orfanarem ≥3 rondas → POISON). **10:35: NÃO re-orfanaram** (orphans=0 fleet-wide exceto fetch) → resolveu, não relançar. |
| A vigiar (não-órfão) | lighthouse_desktop | eviindustries.se, lundhs-hund.se, brfsturebyhojden.se | `desisto após 3` (mesma classe) — **ack gracioso pelo fix 3c7b886, NÃO ficam órfãos** (desktop orphans=0), só sem score | 1 | 2026-07-17T09:55 | 2026-07-17T09:55 | contido pelo fix (sem loop); vigiar volume. **10:35: sem novos desktop.** |
| A vigiar (não-órfão) | lighthouse_mobile | xn--fjllposten-r5a.se (fjällposten.se) | `desisto após 3` (mesma classe) — **ack gracioso pelo fix 3c7b886, NÃO fica órfão** (orphans=0), só sem score | 1 | 2026-07-17T10:35 | 2026-07-17T10:35 | contido pelo fix (volume=1, 1 linha ✗/248 no buffer); vigiar volume |
| A vigiar | industry | (lote ~2-43, sem domínio nos logs) | naks Directus "Under pressure" (transitório; pressão aliviou) | 3 | 2026-07-17T09:55 | 2026-07-17T14:23 | relançados 1×; esperado resolver sozinho. **10:35: RESOLVIDO** — industry pend 0 / redeliv 0 (era redeliv 146). **11:07: RE-ACUMULOU 36 órfãos** (pend 0, redeliv 36); relançados; **pós-requeue 0/0/0 — drenou limpo**. **11:20: RE-ACUMULOU 43 órfãos** (pend 0, redeliv 43; buffer de logs 100% ✓, 0 ✗ — órfãos assentes). Relançados 1× (requeue: 56 purged/requeued); **pós-requeue 0/0/0, NATS industry inflight 21 redeliv 0 — drenou limpo, NÃO re-orfanou**. 3ª ocorrência da classe MAS não é loop: as mensagens têm SUCESSO no requeue (não re-orfanam) → **NÃO POISON** (poison = mesmas msgs re-orfanam ≥3×; aqui é lote transitório fresco cada vez, classe já em "Conhecido/esperado"). Flagged na conversa. **11:35: NÃO re-acumulou** — industry pend 0 / orphans 0 / redeliv 0 (limpo); resolveu, sem relançar. |
| A vigiar | geoip | (1, sem domínio no buffer) | transitório isolado (1 órfão, redeliv 1) | 1 | 2026-07-17T11:07 | 2026-07-17T11:07 | pend 0; relançado 1× (requeue). **11:07 pós-requeue: 0/0/0 — não re-orfanou.** |
| A vigiar (quota-esperado, NÃO-poison) | verify | helsinki.fi, novumcanal.pt, supera.org.pt, sfraa.pt, troiaresort.pt, … (rotativo) | `verify pool exhausted — sem quota; retry mais tarde` (quota 100/dia, `Conhecido/esperado`) | 1 | 2026-07-18T09:21 | 2026-07-18T09:21 | **NÃO relançar** — relançado 1× @09:21 (17 purged/17 requeued) e **re-orfanou imediatamente** (sem quota). Classe quota resolve ao reset diário; requeue só re-orfana. NÃO é poison (não é falha genuína, é limite de quota esperado). |
| A vigiar | score | (sem domínio no buffer; linhas score todas ✓, 24-270ms) | transitório — órfãos do burst Directus "Under pressure" do sweep | 3 | 2026-07-17T11:07 | 2026-07-17T13:36 | 11:07 relançado (0/0/0). **13:06: RE-ACUMULOU 10 órfãos** (pend 0, redeliv 10) durante o burst under-pressure @13:02:20; relançados 1× (requeue: 10 purged/requeued); **pós-requeue NATS 0/0/0 apanhados por inflight 6 — drenou limpo**. **13:36: RE-ACUMULOU 2 órfãos** (pend 0, redeliv 2); relançados 1× (requeue: 2 purged/2 requeued); **pós-requeue NATS `score pend 0 inflight 1 redeliv 0` — apanhados, drenou limpo**. Não é loop (mensagens têm SUCESSO no requeue; lote fresco cada vez, não as mesmas msgs) → **NÃO POISON** (3ª ocorrência da CLASSE, não das mesmas msgs). |

**Ronda 2026-07-18T09:21Z — migração CH R2/3 estável; verify=quota (relançado 1×, RE-ORFANOU logo/quota → NÃO relançar de novo), subdomains=sweep (assinatura PG mudou p/ ECONNREFUSED):** `/api/alerts` count=**0** (frota saudável nas dimensões de regras) e **`/api/config` clickhouse.up=TRUE** (CH em hel1-analytics 100.120.43.49). **2 filas com órfãos:** (1) **`subdomains`** pend **3762** órfãos **500**/redeliv 504 (crt.sh **maxAck 16**, rate 623 — SWEEP, a drenar de 4545 @08:22 → 3794 → 3762; **NÃO relançado por instrução**); (2) **`verify`** pend 0 órfãos **17**/redeliv 17 (maxAck 256; ≠fetch ≠sweep → fila SEGURA). **Amostra verify:** 102 linhas no buffer TODAS `↻ verify <dom>: verify pool exhausted — sem quota; retry mais tarde` (helsinki.fi/novumcanal.pt/supera.org.pt/…) = **classe QUOTA** (100/dia, `Conhecido/esperado`). **Relançado 1×** (requeue: 17 purged/17 requeued) MAS **re-orfanou imediatamente** (pend 0 órfãos 17 de novo; os ↻ verify confirmam sem-quota) → é a classe quota até ao reset diário; **NÃO voltar a relançar** (o requeue só re-orfana). **NENHUMA outra fila não-sweep tem órfãos** — campaign_generate/campaign_send/industry/score/geoip/whois/nuclei/wpscan/fetch/fetch_residential/contacts/audit_*/ssl/ssllabs/dns/dnsprovider/enrich/traffic/social/locality/fingerprint/discover/emailauth TODAS **0/0/0** (`/api/queues` confirma). `campaign_generate` **0/0/0 não-órfão** ✓ (subscrito pelos 3 `ai` do hel1, waiting 3). **`fetch`/`nuclei`/`wpscan`/`whois`/`lighthouse`/`gmb` pending 0** (drenados); só `subdomains` com pending. Logs da frota: **156 linhas, 14 ✗ TODAS `subdomains ECONNREFUSED 91.199.212.73:5432`** (PG/PgBouncer a RECUSAR — ver observação abaixo) + **73 ↻ TODAS subdomains** (retry PG) + **102 ↻ verify** (quota), **0 under-pressure/503** (Directus SAUDÁVEL), **0 bloqueios gmb**, **0 crash/SyntaxError**, **0 erros ClickHouse**. Sem POISON (nenhum "a vigiar" re-orfanou; os 14 ✗ subdomains são sweep, os 17 verify são quota-esperado). **base fail1h 232/128/3 (hel1) + 8 (oracle-e2-1)** = explicado INTEIRAMENTE por subdomains PG (retry-only, under-pressure 0, sweep). **⚠️ Observação PG (watchlist, não incidente — ver deploy-watch):** os ✗ subdomains mudaram de `ETIMEDOUT` (@08:22) para **`ECONNREFUSED 91.199.212.73:5432`** (14 ECONNREFUSED + 12 ETIMEDOUT no buffer = 26 total, **↓ vs 59 @08:22**). **Confinado a 1 job** (subdomains, 0 spread a outros jobs que escrevem PG — enrich/score/whois/geoip 0/0/0), **retry-only** (sem term/perda além do best-effort do sweep), hel1(12)+laptop(14). Nenhum dos 2 gatilhos de escalada (@08:22: "espalhar a outros jobs" OU "subir claramente mais") ATINGIDO → observação datada, **não incidente**. Novo gatilho: se ECONNREFUSED persistir/crescer OU o refuse do PgBouncer atingir OUTROS jobs de escrita PG → abrir incidente. **Deploy-watch:** env-hashes **5/5 INALTERADOS** (sem deploy `.env`), **10 workers 1/host + hel1 6 sem duplicados**; **migração CH R2/3** — hel1 base ×3 (mesmos ids) up **81.1m contínuo** (20.4m@08:22 +60.7m 1:1 = sem recreate), ai ×3 (mesmos ids) reciclaram 1× (up 6.8m, mas **fail1h 0/0/0** = melhor estado, não crash-loop), np-server dashboard OK/clickhouse.up=TRUE → **migração validada R2/3**. Write-path CH (lighthouse→CH) AINDA por exercitar (lighthouse pend 0, ai idle done1h 0). de1/oracle1/oracle2 recriaram (env inalt.=code pull), laptop reciclou (churn residencial). **C5 exporters np-server**: `/api/alerts` count=0 (inclui os targets nats/redis/postgres do CT200) + dashboard responde → estável, sem crash-loop.

**Ronda 2026-07-18T08:22Z — MIGRAÇÃO CH DE1→HEL1 (deploys ESPERADOS validados); só sweep com órfãos, NADA relançado (`/api/alerts` count=0; 1ª ronda pós-pausa 04h-08h):** `/api/alerts` count=**0** (frota saudável nas dimensões de regras) e **`/api/config` clickhouse.up=TRUE** (CH novo em hel1-analytics 100.120.43.49:8123 acessível). Órfãos SÓ em filas de **sweep** → NÃO relançados por instrução: `subdomains` pend **4.545** órfãos 363/redeliv 369 (crt.sh **maxAck 16**, inflight 16, rate 245 — a drenar de 6.336 @04:37), `lighthouse_mobile` pend 0 órfãos **6**/redeliv 6 (**maxAck 20**, cauda desisto-após-3), `lighthouse_desktop` pend 0 órfãos **0** (limpo), `gmb` pend 0 órfãos **0** (residential, drenado, **0 bloqueios**). **NENHUMA fila não-sweep tem órfãos** — campaign_generate/campaign_send/industry/score/geoip/whois/nuclei/wpscan/verify/fetch/fetch_residential/contacts/audit_* TODAS **0/0/0** (`/api/queues` confirma). `campaign_generate` **0/0/0 não-órfão** ✓ (subscrito pelos 3 `ai` do hel1 RECRIADOS, waiting 3). **`fetch`/`nuclei`/`wpscan`/`whois`/`lighthouse`/`gmb` pending 0** (drenados); só `subdomains` com pending. **Nada relançado.** Logs da frota: **171 linhas, 1 ✗** (lighthouse_desktop dontblink.se `desisto após 3`/ack-gracioso fix 3c7b886 — 1 domínio fresco, resíduo @08:09, lighthouse drenado sem atividade nova) + **59 ↻ TODAS `subdomains ETIMEDOUT 91.199.212.73:5432`** (PG write-path, **ELEVADO vs 13 @04:37** — correlaciona com maxAck 16 + retoma do sweep pós-pausa; confinado a 1 job/só hel1, retry-only; watchlist escrita PG; NÃO é ClickHouse), **0 under-pressure/503** (Directus SAUDÁVEL), **0 bloqueios gmb**, **0 crash/SyntaxError**, **0 erros ClickHouse** (nenhum worker a falhar contra o CLICKHOUSE_URL novo). Sem POISON (nenhum "a vigiar" re-orfanou). **base fail1h 33-43** (`3de203d3`=33 / `ff9f8dfad7`=40 / `04630ff6`=43) = só os 59 PG-ETIMEDOUT, retry-only/esperado (under-pressure 0). **Deploy-watch:** **MIGRAÇÃO CH** — hel1-docker env-hash MUDOU `6b5a435f`→`64381c1d` + 6 workers RECRIADOS (ids novos, up ~20m 1:1 = sem crash-loop, roles corretos), dashboard np-server recriada (clickhouse.up=true) → **AMBOS validados nas dimensões observáveis, sob observação K=3**. Os 3 git-hosts (de1/oracle1/oracle2) também recriaram MAS env inalterado = code pull (git na pausa), roles inalterados; laptop reciclou (churn residencial). **10 workers 1/host + hel1 6, sem duplicados.** Ressalva: write-path CH (lighthouse→CH) por exercitar sob carga dentro do K=3.

**Ronda 2026-07-18T04:37Z — só sweep com órfãos, NADA relançado (`/api/alerts` count=0; reciclagem hel1 PARADA 4/4 — última ronda antes da pausa 04h-08h):** `/api/alerts` count=**0** (frota saudável nas dimensões de regras). Órfãos SÓ em filas de **sweep** → NÃO relançados por instrução: `subdomains` pend **6.336** órfãos 310/redeliv 310 (crt.sh maxAck 4, inflight 4, rate 1011 — LENTO, a drenar de 7.304 @03:20, ~968 drenados), `lighthouse_desktop` pend 0 órfãos **226**/redeliv 223 (**maxAck 20**, CONGELADO idêntico a @03:20 — drenado, sem atividade nova), `lighthouse_mobile` pend 0 órfãos **198**/redeliv 196 (**maxAck 20**, CONGELADO idêntico), `gmb` pend 0 órfãos **28**/redeliv 28 (residential maxAck 5, CONGELADO idêntico, **0 bloqueios**). **NENHUMA fila não-sweep tem órfãos** — campaign_generate/campaign_send/industry/score/geoip/whois/nuclei/wpscan/verify/fetch/fetch_residential/audit_* TODAS **0/0/0** (`/api/queues` confirma). `campaign_generate` **0/0/0 não-órfão** ✓ (subscrito pelos 3 `ai` do hel1, waiting 3). **`fetch`/`nuclei`/`wpscan`/`whois`/`lighthouse`/`gmb` pending 0** (drenados); só `subdomains` com pending (6.336, sweep crt.sh LENTO). **Nada relançado.** Logs da frota: **389 linhas, 8 ✗ TODAS lighthouse_desktop** (`desisto após 3`/ack-gracioso fix 3c7b886 — os MESMOS 8 domínios FRESCOS estagnados de @03:20 nutidaram.se/teijlers.se/tankbutiken.se/staffbyfivemoments.se/kryddburken.se/tadibygg.se/nfoelektro.no/felixvasquezaguilera.se, timestamps 23:45-00:04 = **resíduo estagnado**, lighthouse drenado sem atividade nova, NÃO nova perda) + **47 ↻** (sobretudo subdomains PG + retries lighthouse), **1 under-pressure/503** (Directus SAUDÁVEL), **13 PG `ETIMEDOUT 91.199.212.73:5432`** subdomains/hel1 (frescas, **↓ de 27 @03:20** — dentro/abaixo da banda 19-36; watchlist escrita PG, confinado a 1 job, retry-only), **0 bloqueios gmb**, **0 crash/SyntaxError**. Sem POISON (nenhum "a vigiar" re-orfanou; os 8 ✗ são resíduo dos frescos de @03:20). **base fail1h 8-16** (23d8c7c6=16 / b64dcbdd=8 / c8d4c526=15) = só PG-ETIMEDOUT(13), retry-only/esperado (under-pressure clareou p/ ~0). **Deploy-watch:** env-hashes **5/5 INALTERADOS** (sem deploy), **10 workers 1/host + hel1 6 sem duplicados**, snapshot fresco (maxBeatAge ~5.9s de1). **hel1 ai reciclagem PARADA 4/4** (uptimes +77m 1:1, mesmos ids `425962b6`/`7eb9ee20`/`f339f432`, fail1h ai 0/0/0 — 4ª ronda seguida no melhor estado pós-fix), **de1 quirk mantém-se RESOLVIDO** (`ef79e1eb4c3c` +77m 1:1, mesmo id, load 0/6). **HostOverloaded LXC continua limpo** (count=0). Só o laptop reciclou (id novo `2e23a3523418`, era `1b9705285e04`; churn residencial normal).

**Ronda 2026-07-18T03:20Z — só sweep com órfãos, NADA relançado (`/api/alerts` count=0; reciclagem hel1 PARADA 3/3 3ª ronda seguida):** `/api/alerts` count=**0** (frota saudável nas dimensões de regras). Órfãos SÓ em filas de **sweep** → NÃO relançados por instrução: `subdomains` pend **7.304** órfãos 310/redeliv 310 (crt.sh maxAck 4, inflight 4 — LENTO, a drenar de 7.785 @02:21), `lighthouse_desktop` pend 0 órfãos **226**/redeliv 223 (**maxAck 20**, CONGELADO idêntico a @02:21 — drenado, sem atividade nova), `lighthouse_mobile` pend 0 órfãos **198**/redeliv 196 (**maxAck 20**, CONGELADO idêntico), `gmb` pend 0 órfãos **28**/redeliv 28 (residential maxAck 5, CONGELADO idêntico, **0 bloqueios**). **NENHUMA fila não-sweep tem órfãos** — campaign_generate/campaign_send/industry/score/geoip/whois/nuclei/wpscan/verify/fetch/audit_* TODAS **0/0/0** (`/api/queues` confirma). `campaign_generate` **0/0/0 não-órfão** ✓ (subscrito pelos 3 `ai` do hel1, waiting 3). **`fetch`/`nuclei`/`wpscan`/`whois`/`lighthouse`/`gmb` pending 0** (drenados). **Nada relançado.** Logs da frota: **376 linhas, 8 ✗ TODAS lighthouse_desktop** (`desisto após 3`/ack-gracioso fix 3c7b886 — os MESMOS 8 domínios FRESCOS de @02:21 nutidaram.se/teijlers.se/tankbutiken.se/staffbyfivemoments.se/kryddburken.se/tadibygg.se/nfoelektro.no/felixvasquezaguilera.se, timestamps 23:45-00:04 = **resíduo estagnado**, lighthouse drenado sem atividade nova, NÃO nova perda) + **61 ↻** (sobretudo subdomains PG + retries lighthouse), **0 under-pressure/503** (Directus CLAREOU vs 24 @02:21 — SAUDÁVEL), **27 PG `ETIMEDOUT 91.199.212.73:5432`** subdomains/hel1 (frescas, ~estável na banda 19-36; watchlist escrita PG, confinado a 1 job, retry-only), **0 bloqueios gmb**, **0 crash/SyntaxError**. Sem POISON (nenhum "a vigiar" re-orfanou; os 8 ✗ são resíduo dos frescos de @02:21). **base fail1h 8-12** (vs 7-64 @02:21 — BAIXOU: under-pressure 24→0 removeu o pico; resta o PG-ETIMEDOUT retry-only). **Deploy-watch:** env-hashes **5/5 INALTERADOS** (sem deploy), **10 workers 1/host + hel1 6 sem duplicados**, snapshot fresco (maxBeatAge 9.4s). **hel1 ai reciclagem PARADA 3/3** (uptimes +60m 1:1, fail1h ai 0/0/0 — 3ª ronda seguida no melhor estado pós-fix), **de1 quirk mantém-se RESOLVIDO** (+60m 1:1, mesmo id). **HostOverloaded LXC continua limpo** (count=0). Só o laptop reciclou (id novo `1b9705285e04`, era `aae950bc7b2e`; churn residencial normal).

**Ronda 2026-07-18T02:21Z — só sweep com órfãos, NADA relançado (`/api/alerts` count=0; reciclagem hel1 PARADA 3/3 2ª ronda seguida):** `/api/alerts` count=**0** (frota saudável nas dimensões de regras). Órfãos SÓ em filas de **sweep** → NÃO relançados por instrução: `subdomains` pend **7.785** órfãos 306/redeliv 306 (crt.sh maxAck 4, inflight 4, rate 654 — LENTO, a drenar de 8.257 @01:20), `lighthouse_desktop` pend 0 órfãos **226**/redeliv 223 (**maxAck 20**, CONGELADO idêntico a @01:20 — drenado, sem atividade nova), `lighthouse_mobile` pend 0 órfãos **198**/redeliv 196 (**maxAck 20**, CONGELADO idêntico), `gmb` pend 0 órfãos **28**/redeliv 28 (residential maxAck 5, CONGELADO idêntico, **0 bloqueios**). **NENHUMA fila não-sweep tem órfãos** — campaign_generate/campaign_send/industry/score/geoip/whois/nuclei/wpscan/verify/fetch/audit_* TODAS **0/0/0** (`/api/queues` confirma). `campaign_generate` **0/0/0 não-órfão** ✓ (subscrito pelos 3 `ai` do hel1, waiting 3). **`fetch`/`nuclei`/`wpscan`/`whois`/`lighthouse`/`gmb` pending 0** (drenados). **Nada relançado.** Logs da frota: **376 linhas, 8 ✗ TODAS lighthouse_desktop** (`desisto após 3`/ack-gracioso fix 3c7b886 — os MESMOS 8 domínios FRESCOS de @01:20 nutidaram.se/teijlers.se/tankbutiken.se/staffbyfivemoments.se/kryddburken.se/tadibygg.se/nfoelektro.no/felixvasquezaguilera.se, timestamps 23:45-00:04 = **resíduo estagnado**, lighthouse drenado sem atividade nova, NÃO nova perda) + **76 ↻** (sobretudo subdomains PG + retries lighthouse), **24 under-pressure/503** (transitório Directus, nak+retry, 0 term — subiu de 0 @01:20 mas moderado, sem efeito a jusante nos ai que continuam estáveis), **19 PG `ETIMEDOUT 91.199.212.73:5432`** subdomains/hel1 (frescas 02:18-02:21, **↓ vs 36 @01:20** — não escalou, baixou; watchlist escrita PG, confinado a 1 job, retry-only), **0 bloqueios gmb**, **0 crash/SyntaxError**. Sem POISON (nenhum "a vigiar" re-orfanou; os 8 ✗ são resíduo dos frescos de @01:20). **base `c8d4c526` fail1h=64** (vs base 7-8 nas outras 2 réplicas) = soma de under-pressure(24)+PG-ETIMEDOUT(19), ambas classes esperadas/retry-only, sem perda. **Deploy-watch:** env-hashes **5/5 INALTERADOS** (sem deploy), **10 workers 1/host + hel1 6 sem duplicados**. **hel1 ai reciclagem PARADA 3/3** (uptimes +59.8-59.9m 1:1, fail1h ai 0/0/0 — 2ª ronda seguida no melhor estado pós-fix), **de1 quirk mantém-se RESOLVIDO** (+59.8m 1:1, mesmo id). **HostOverloaded LXC continua limpo** (count=0). Só o laptop reciclou (id novo `aae950bc7b2e`, churn residencial normal).

**Ronda 2026-07-18T01:20Z — só sweep com órfãos, NADA relançado (`/api/alerts` count=0; reciclagem hel1 PAROU 3/3, de1 quirk RESOLVEU):** `/api/alerts` count=**0** (frota saudável nas dimensões de regras). Órfãos SÓ em filas de **sweep** → NÃO relançados por instrução: `subdomains` pend **8.257** órfãos 284/redeliv 285 (crt.sh maxAck 4, LENTO — esperado; +4 órfãos vs @00:21, drenagem lenta), `lighthouse_desktop` pend 0 órfãos **226**/redeliv 223 (**maxAck 20**, CONGELADO idêntico a @00:21 — drenado, sem atividade nova), `lighthouse_mobile` pend 0 órfãos **198**/redeliv 196 (**maxAck 20**, CONGELADO idêntico), `gmb` pend 0 órfãos **28**/redeliv 28 (residential maxAck 5, CONGELADO idêntico, **0 bloqueios**). **NENHUMA fila não-sweep tem órfãos** — campaign_generate/campaign_send/industry/score/geoip/whois/nuclei/wpscan/verify/fetch/audit_* TODAS **0/0/0** (`/api/queues` confirma). `campaign_generate` **0/0/0 não-órfão** ✓ (subscrito pelos 3 `ai` do hel1). **`fetch`/`nuclei`/`wpscan`/`whois`/`lighthouse`/`gmb` pending 0** (drenados). **Nada relançado.** Logs da frota: **372 linhas, 8 ✗ TODAS lighthouse_desktop** (`desisto após 3`/ack-gracioso fix 3c7b886 — os MESMOS 8 domínios FRESCOS de @00:21 nutidaram.se/teijlers.se/tankbutiken.se/staffbyfivemoments.se/kryddburken.se/tadibygg.se/nfoelektro.no/felixvasquezaguilera.se, timestamps 23:45-00:04 = **resíduo estagnado**, lighthouse drenado sem atividade nova, NÃO nova perda) + **70 ↻** (sobretudo subdomains PG), **0 under-pressure/503** (Directus SAUDÁVEL), **36 PG `ETIMEDOUT 91.199.212.73:5432`** subdomains/hel1 (frescas 01:19-01:21, ~roughly estável, watchlist escrita PG, confinado a 1 job, retry-only), **0 bloqueios gmb**, **0 crash/SyntaxError**. Sem POISON (nenhum "a vigiar" re-orfanou; os 8 ✗ são resíduo dos frescos de @00:21). **Deploy-watch:** env-hashes **5/5 INALTERADOS** (sem deploy), **10 workers 1/host + hel1 6 sem duplicados**. **hel1 ai reciclagem PAROU 3/3** (uptimes +59.9m 1:1, fail1h ai 0/0/0 — melhor estado pós-fix), **de1 quirk de uptime RESOLVEU** (+59.7m 1:1, mesmo id). **HostOverloaded LXC continua limpo** (count=0). Só o laptop reciclou (id novo, churn residencial normal).

**Ronda 2026-07-18T00:21Z — só sweep com órfãos, NADA relançado (lighthouse maxAck 20; reciclagem hel1 ESTABILIZOU esta ronda — melhor estado pós-fix):** `/api/alerts` count=**3**, TODOS `NetProspectQueueOrphans` em filas de **SWEEP** (`lighthouse_mobile` 198, `lighthouse_desktop` 226, `gmb` 28) → NÃO relançados por instrução. `/api/queues`: `subdomains` pend 8.605 órfãos 280/redeliv 280 (crt.sh maxAck 4, inflight 0 — LENTO, esperado), `lighthouse_desktop` pend 0 órfãos 226/redeliv 223 (**maxAck 20**, inflight 0 — pending DRENADO, órfãos = cauda desisto-após-3/ack-gracioso), `lighthouse_mobile` pend 0 órfãos 198/redeliv 196 (**maxAck 20**, inflight 0), `gmb` pend 0 órfãos 28/redeliv 28 (residential, maxAck 5, inflight 0, **0 bloqueios**). **NENHUMA fila não-sweep tem órfãos** — campaign_generate/campaign_send/industry/score/geoip/whois/nuclei/wpscan/verify/fetch TODAS **0/0/0** (`/api/queues` confirma). `campaign_generate` **0/0/0 não-órfão** ✓ (subscrito pelos 3 `ai` do hel1). **`fetch`/`nuclei`/`lighthouse_mobile`/`lighthouse_desktop`/`gmb` pending 0** (drenados). **Nada relançado.** Logs da frota: **373 linhas (~23:45→00:21), 8 ✗ TODAS lighthouse_desktop** (`desisto após 3`/ack-gracioso fix 3c7b886 — domínios FRESCOS nutidaram.se/teijlers.se/tankbutiken.se/staffbyfivemoments.se/kryddburken.se/tadibygg.se/nfoelektro.no/felixvasquezaguilera.se, NÃO os reincidentes) + **70 ↻**, **6 under-pressure/503** (Directus SAUDÁVEL, baixo), **30 PG `ETIMEDOUT 91.199.212.73:5432`** subdomains/hel1 (~0.8/min, roughly ESTÁVEL vs 1.7/min @23:21 — watchlist escrita PG, confinado a 1 job, retry-only), **0 bloqueios gmb**, **0 crash/SyntaxError**. Sem POISON (os 8 ✗ são domínios FRESCOS; nenhum "a vigiar" re-orfanou). **HostOverloaded LXC LIMPOU:** os 3 alertas `NetProspectHostOverloaded` (blackbox/pve/PMG) de @23:21 JÁ NÃO estão no `/api/alerts` (regra corrigida `np_host_cores>=4` → falsos-positivos Proxmox/CT eliminados). **Reciclagem hel1 ESTABILIZOU:** load 2.16→**1.12/18**, `fail1h` ai **COLAPSOU 9-16 → 0-1**, **2 dos 3 ai NÃO reciclaram** (`425962b6` 3.2→62.8m, `7eb9ee20` 16.4→76.0m cresceram 1:1; só `f339f432` reciclou 1×) — melhor estado pós-fix, ajudado pelo sweep lighthouse estar drenado.

**Ronda 2026-07-17T23:21Z — só sweep com órfãos, NADA relançado (lighthouse maxAck 30→20 SEGUIDO/commit fc8ff3b; fail1h ai COLAPSOU mas reciclagem PERSISTE):** as ÚNICAS filas com órfãos são todas de **sweep** → NÃO relançadas por instrução: `subdomains` pend 8.946 órfãos 278/redeliv 278 (crt.sh maxAck 4, inflight 4 — LENTO, esperado), `lighthouse_desktop` pend 393 órfãos 224/redeliv 231 (**maxAck 20**, inflight 20 saturado), `lighthouse_mobile` pend 0 órfãos 198/redeliv 196 (**maxAck 20**, inflight 0 — pending DRENADO, órfãos = cauda desisto-após-3/ack-gracioso), `gmb` pend 0 órfãos 28/redeliv 28 (residential, maxAck 5, inflight 0, **0 bloqueios**). **NENHUMA fila não-sweep tem órfãos** — industry/score/geoip/whois/nuclei/wpscan/verify/fetch/campaign_send/campaign_generate TODAS **0/0/0** (`/api/queues` confirma). `campaign_generate` NATS + `/api/queues` **0/0/0 não-órfão** ✓ (subscrito pelos 3 `ai` do hel1, cg=true, waiting 3; os 3 base largaram-no, cs=true). **`fetch` DRENADO** (pend 0). **`nuclei` DRENADO** (pend 0). **Nada relançado.** Logs da frota: **400 linhas (23:07→23:23), 9 ✗ TODAS lighthouse_desktop** (`desisto após 3`/ack-gracioso fix 3c7b886 — domínios FRESCOS valentin-automation.se/callmevard.se/xn--kristoferstrd-mfb.se/gladys.se/nnr.se/pooltorget.se/msmt.se/mariesandberg.se/truckstylesweden.se, NÃO os reincidentes; ~9/16min ≈ 7× ABAIXO do pico R9 105/25m; teto 20 a segurar) + **63 ↻**, **0 under-pressure/503** (Directus SAUDÁVEL — a rajada 49 @22:15 CLAREOU), **18 PG `ETIMEDOUT 91.199.212.73:5432`** subdomains/hel1 (23:11:48→23:22:29, ~1.7/min — **UP** de 0.3/min @22:22; watchlist escrita PG, confinado a 1 job, retry-only), **0 bloqueios gmb** (0 gmb no buffer), **0 crash/SyntaxError**. Sem POISON (os 9 ✗ são domínios FRESCOS; 0 linhas dos domínios "a vigiar"; nenhum re-orfanou). **Watch-item respondido:** lighthouse maxAck **20 CONFIRMADO** (`/api/queues` desktop+mobile maxAckPending 20). `fail1h` ai **COLAPSOU 44-96 @22:22 → 9-16** (~3-5× menos, ajuda também de under-pressure 49→0), MAS a reciclagem dos 3 ai **PERSISTE** (uptimes **3.2/16.4/13.2m**, os 3 reciclaram 1× no intervalo de ~59min; um a 3.2m = acabou de reciclar) → sob o critério estrito "uptimes a crescer sem reset" **NÃO estabilizou totalmente** → **lever residual = `LIGHTHOUSE_CONC` por-host no hel1** (ver DEBUG-FOUND + deploy-watch). **NOVO sinal correlato:** 3 alertas `NetProspectHostOverloaded` no hel1 (blackbox/pve exporters + PMG, 20-24× load/core, ~4h) — camada Proxmox/CT do hel1 sob pressão do sweep Chrome; worker-VM saudável (load 2.16/18), sem perda.

**Ronda 2026-07-17T22:22Z — só sweep com órfãos, NADA relançado (lighthouse maxAck 30 REVERTEU — recomendo 30→20):** as ÚNICAS
filas com órfãos são todas de **sweep >50** → NÃO relançadas por instrução: `subdomains` pend 9.285 órfãos 272/redeliv 273 (crt.sh
maxAck 4, inflight 4 — LENTO, esperado), `lighthouse_desktop` pend 1.042 órfãos 219/redeliv 237 (**maxAck 30**, inflight 30
saturado), `lighthouse_mobile` pend 0 órfãos 198/redeliv 196 (**maxAck 30**, inflight 0 — pending DRENADO, órfãos = cauda
desisto-após-3/ack-gracioso), `gmb` pend 0 órfãos 28/redeliv 28 (residential, maxAck 5, inflight 0, **0 bloqueios**). **NENHUMA fila
não-sweep tem órfãos** — industry/score/geoip/whois/nuclei/wpscan/verify/fetch/campaign_send/campaign_generate TODAS **0/0/0** (script
de parse confirma). `campaign_generate` NATS + `/api/queues` **0/0/0 não-órfão** ✓ (subscrito pelos 3 `ai` do hel1, waiting 3). **`fetch`
DRENADO** (pend 0). **`nuclei` DRENADO** (pend 0). **Nada relançado.** Logs da frota: **400 linhas (22:04→22:22), 7 ✗ TODAS
lighthouse_desktop** (`desisto após 3`/ack-gracioso fix 3c7b886 — domínios FRESCOS toezichttafel.nl/visserenko.nl/boostkungen.se/
freebellion.nl/butiksdesign.se/avalls.se/kulttuurikolari.fi, NÃO os reincidentes; ~7/18min = ~7× ABAIXO do pico R9 105/25m) + **99 ↻**
(87 lighthouse_desktop + 12 subdomains PG), **49 under-pressure/503** (RAJADA @22:15:04, transitório Directus — nak+retry, 0 term; era
1 @21:23), **5 PG `ETIMEDOUT 91.199.212.73:5432`** subdomains/hel1 (era 11 @21:23 → baixou), **0 bloqueios gmb** (0 sorry/recaptcha/
blocked), **0 crash/SyntaxError**. Sem POISON (os ✗ são domínios frescos, não os "a vigiar"; nenhum re-orfanou). **Watch-item REVERTIDO:**
lighthouse maxAck 30 confirmado MAS a reciclagem dos ai do hel1 NÃO estabilizou — os 3 ai reciclaram todos (up 19.1/5.8/3.4m) e
`fail1h` ai subiu ~3× (11-33 @21:23 → **44-96**, de volta ao patamar @20:28), a coincidir com a rajada under-pressure → gatilho "2+
recicles" atingido → **RECOMENDO baixar maxAck 30→20** (ver DEBUG-FOUND + deploy-watch). Sem perda (fix 3c7b886).

**Ronda 2026-07-17T21:23Z — só sweep com órfãos, NADA relançado (lighthouse maxAck 30 a MELHORAR):** as ÚNICAS filas com
órfãos são todas de **sweep >50** → NÃO relançadas por instrução: `subdomains` pend 9.546 órfãos 270/redeliv 272 (crt.sh maxAck 4,
inflight 4 — LENTO, esperado), `lighthouse_desktop` pend 1.918 órfãos 182/redeliv 198 (**maxAck 30**, inflight 30 saturado),
`lighthouse_mobile` pend 0 órfãos 198/redeliv 196 (**maxAck 30**, inflight 0 — pending DRENADO, órfãos = cauda desisto-após-3/
ack-gracioso), `gmb` pend 465 órfãos 28/redeliv 28 (residential, maxAck 5, inflight 5, **0 bloqueios**). **NENHUMA fila não-sweep
tem órfãos** — industry/score/geoip/whois/nuclei/wpscan/verify/fetch/campaign_send TODAS **0/0/0** (NATS confirma; nem score nem
industry acumularam este ronda — sem burst Directus). `campaign_generate` NATS + `/api/queues` **0/0/0 não-órfão** ✓ (subscrito
pelos 3 `ai` do hel1, cg=true; os 3 base largaram-no, cs=true). **`fetch` DRENADO** (pend 0). **`nuclei` DRENADO** (pend 0 órfãos
0). **Nada relançado.** Logs da frota: **400 linhas (21:04→21:23), 5 ✗ TODAS lighthouse_desktop** (`desisto após 3`/ack-gracioso
fix 3c7b886 — domínios FRESCOS sportenbeautyblog.nl/degroningerwinterbbq.nl/slotenmaker-alphen.nl/youngcandoit.nl/uppsalabotox.se,
NÃO os reincidentes; ~5/18min = ~7× ABAIXO do pico R9 105/25m; teto 30 a segurar) + **49 ↻** (lighthouse + subdomains PG),
**1 under-pressure/503** (transitório Directus), **0 bloqueios gmb** (0 sorry/recaptcha/blocked), **0 crash/SyntaxError**. Sem
POISON. **1 OBSERVAÇÃO não-órfã (ver deploy-watch):** PG `ETIMEDOUT 91.199.212.73:5432` ×11/18min em `subdomains`/hel1 (~0.6/min,
era ×8 @20:28 — pressão de escrita crt.sh sobre o CT Postgres, retry-only, confinado a 1 job). **Watch-item respondido:**
lighthouse maxAck 30 CONFIRMADO + reciclagem dos ai do hel1 a MELHORAR (fail1h ai 70-118→11-33; uptimes 8.7-26.6m, NÃO
crash-loop, 3ª ronda pós-fix em trajetória descendente). Nenhum dos "a vigiar" acima re-orfanou.

**Ronda 2026-07-17T20:28Z — só sweep com órfãos, NADA relançado (lighthouse maxAck 30 a funcionar):** as ÚNICAS filas
com órfãos são todas de **sweep >50** → NÃO relançadas por instrução: `subdomains` pend 9.849 órfãos 268/redeliv 269 (crt.sh
maxAck 4, inflight 4, avgMs 14s — LENTO, esperado), `lighthouse_desktop` pend 2.610 órfãos 171/redeliv 189 (**maxAck 30**,
inflight 30 saturado), `lighthouse_mobile` pend 151 órfãos 192/redeliv 208 (**maxAck 30**, inflight 30 — quase drenado),
`gmb` pend 1.845 órfãos 28/redeliv 28 (residential, maxAck 5, inflight 5, **0 bloqueios**). **NENHUMA fila não-sweep tem
órfãos** — industry/score/geoip/whois/nuclei/wpscan/verify/fetch/campaign_send TODAS **0/0/0** (NATS confirma; nem `score`
nem `industry` acumularam este ronda — sem burst Directus). `campaign_generate` NATS + `/api/queues` **0/0/0 não-órfão** ✓
(servido pelos `ai` do hel1, waiting 3). **`fetch` DRENOU** (pend 0, delivered=acked 1.459.843). **`nuclei` DRENOU** (pend 0
órfãos 0 — era 129-135 de cauda lenta em rondas anteriores). **Nada relançado.** Logs da frota: **400 linhas (20:09→20:21),
12 ✗ TODAS lighthouse** (`desisto após 3`/ack-gracioso fix 3c7b886 — 8 mobile + 4 desktop, ~12/12min = ~7× ABAIXO do pico R9
105/25m; teto 30 a segurar) + **68 ↻** (34 desktop + 26 mobile lighthouse + 8 subdomains), **0 under-pressure/503** (Directus
saudável), **0 bloqueios gmb** (35 linhas gmb, 0 sorry/recaptcha/blocked), **0 crash/SyntaxError**. Sem POISON. **1 OBSERVAÇÃO
não-órfã (ver deploy-watch):** PG `ETIMEDOUT 91.199.212.73:5432` ×8 em `subdomains`/hel1 (~1/min, era ×9 @18:32 — pressão de
escrita do sweep crt.sh sobre o CT Postgres, retry-only, confinado a 1 job). **Watch-item respondido:** lighthouse maxAck 30
CONFIRMADO + reciclagem dos ai do hel1 DIMINUIU (fail1h ai 142-168→70-118; uptimes a crescer sem reset em 2 snapshots frescos).
Nenhum dos "a vigiar" acima re-orfanou.

**Ronda 2026-07-17T18:32Z — reboot de1 recuperado; só `score` relançado (regra permanente):** a ÚNICA fila não-sweep
com órfãos = `score` (pend 0, órfãos 1, redeliv 1 — transitório de burst Directus "Under pressure"; 144 linhas score no
buffer todas ✓ 18-252ms) → **relançado 1×** (requeue: 1 purged/1 requeued; **pós-requeue NATS `score pend 0 inflight 0
redeliv 0` — drenou limpo, NÃO re-orfanou**). Filas de **sweep >50** (NÃO relançadas por instrução): `subdomains` pend
10.498 órfãos 243/redeliv 243 (crt.sh maxAck 4, inflight 4, LENTO — esperado), `lighthouse_desktop` pend 3.734 órfãos
126/redeliv 153 (maxAck 40, inflight 40 saturado), `lighthouse_mobile` pend 1.225 órfãos 150/redeliv 176 (maxAck 40,
inflight 40), `gmb` pend 4.373 órfãos 27/redeliv 30 (residential, maxAck 5, inflight 5, **0 bloqueios**). **NENHUMA outra
fila não-sweep tem órfãos** (industry/geoip/whois/nuclei/wpscan/verify/fetch/campaign_send TODAS 0/0/0; NATS confirma).
`campaign_generate` NATS + `/api/queues` **0/0/0 não-órfão** ✓ (servido pelos `ai` do hel1). `fetch` drenou (0/0/0). Logs da
frota: 400 linhas (18:13→18:26), **19 ✗ TODAS lighthouse** (`desisto após 3`/ack-gracioso fix 3c7b886 — 11 mobile + 8
desktop, ~19/13min = ~7× ABAIXO do pico R9 105/25m) + **68 ↻**, **0 under-pressure/503** (Directus saudável, np-server
assentou), **0 bloqueios gmb** (0 sorry/recaptcha/blocked), **0 crash/SyntaxError**. Sem POISON. **2 OBSERVAÇÕES (não
órfão, ver deploy-watch + DEBUG-FOUND):** (1) **hel1 ai/browser ×3 em rajada de restarts** sob o sweep lighthouse >50
(maxAck 40) — recorrência do incid. CLOSED 20260716, SEM perda (redeliv honesto); assentou 18:30→18:31; (2) **PG
`ETIMEDOUT 91.199.212.73:5432` ×9 em `subdomains`/hel1** (~1/min) — pressão de escrita do sweep crt.sh sobre o CT
Postgres, retry-only, confinado a 1 job. Nenhum dos "a vigiar" acima re-orfanou.

**Ronda 2026-07-17T18:07Z — janela pós-reboot np-server; só `score` relançado (regra permanente):** a ÚNICA fila
não-sweep com órfãos = `score` (pend 0, órfãos 7, redeliv 1 — vindos do burst Directus "Under pressure" @18:03:49/
18:04:25) → **relançado 1×** (requeue: 7 purged/7 requeued); **pós-requeue NATS `score pend 0 inflight 2 redeliv 0` —
apanhados, drenou limpo, NÃO re-orfanou**. Filas de **sweep >50** (NÃO relançadas por instrução): `subdomains` pend
10.649 órfãos 228/redeliv 231 (crt.sh maxAck 4, avgMs ~20s, LENTO — esperado), `lighthouse_desktop` pend 4.032 órfãos
107/redeliv 136 (maxAck 40, inflight 40 saturado), `lighthouse_mobile` pend 1.486 órfãos 126/redeliv 153 (maxAck 40,
inflight 40), `gmb` pend 4.642 órfãos 26/redeliv 26 (residential, maxAck 5, 0 bloqueios). **NENHUMA outra fila não-sweep
tem órfãos** (industry/geoip/whois/nuclei/wpscan/verify/fetch/campaign_send TODAS 0/0/0; NATS confirma). `campaign_generate`
NATS + `/api/queues` **0/0/0 não-órfão** ✓ (servido pelos `ai` do hel1, waiting 3). `fetch` drenou (0/0/0). Logs da frota:
366 linhas (17:54→18:07), **9 ✗ TODAS lighthouse** (`desisto após 3`/ack-gracioso fix 3c7b886 — ~9/13min, ~7× ABAIXO do
pico R9 105/25m) + **133 ↻**, **70 "Under pressure"** em 2 bursts apertados (18:03:49 ×40 + 18:04:25 ×30 — transitório do
reboot np-server, NAK+retry, 0 term), **0 bloqueios gmb** (0 sorry/recaptcha/blocked). Sem POISON. **2 OBSERVAÇÕES da
janela (não incidente — coincidem com o reboot autorizado do np-server ~30min):** (1) **`connect ETIMEDOUT
91.199.212.73:5432` ×7 em `subdomains`/hel1** (18:00→18:06, ~1/min — timeouts PG na escrita pesada do crt.sh; watchlist
"escrita PG", mas baixo volume, retry-only sem perda, confinado a 1 sweep pesado); (2) os 3 **ai/browser do hel1
reiniciaram** há ~2-8min (uptimes escalonados 2.3/7.6/7.9m = NÃO crash-loop sincronizado; 0 SyntaxError/crash nos logs)
— provável reconexão pós-reboot. Vigiar ambas na próxima ronda; escalar se se espalharem/persistirem.

**Ronda 2026-07-17T16:21Z — só sweep com órfãos, NADA relançado (incidente de1 duplicado FECHADO):** as ÚNICAS
filas com órfãos são todas de **sweep >50** → NÃO relançadas por instrução: `gmb` pend 6613 órfãos 8/redeliv 8
(residential, maxAck 5, 0 bloqueios), `lighthouse_desktop` pend 5179 órfãos 17/redeliv 34 (maxAck 20, inflight 20
saturado), `lighthouse_mobile` pend 2581 órfãos 25/redeliv 41 (maxAck 20, inflight 20). **NENHUMA fila não-sweep tem
órfãos** (industry/score/geoip/whois/nuclei/wpscan/verify/fetch/campaign_send TODAS 0/0/0). `campaign_generate` NATS +
`/api/queues` **0/0/0 não-órfão** ✓ (servido pelos `ai` do hel1, waiting 3). `fetch` drenou completamente (0 pending/0
órfãos/0 redeliv). **Nada relançado.** Logs da frota: 348 linhas (16:07→16:21), **16 ✗ + 61 ↻ TODAS lighthouse**
(`desisto após 3`/retry — ack-gracioso fix 3c7b886; ~16 ✗/14min = ~7× ABAIXO do pico R9 105/25m, teto 20 a segurar),
**0 bloqueios gmb** (0 sorry/recaptcha/blocked), **0 PG**, **0 under-pressure/503**, **0 crash/SyntaxError**. Sem POISON.
**Evento da ronda = INCIDENTE dos containers duplicados FECHADO** (commit b1d6cf9 + power-cycle do de1; de1 = 1 worker
load 1.54 a reportar beats; ver DEBUG-FOUND + deploy-watch) + deploy de código (HEAD `8f5942e`→`2cd98e8`, git-hosts
recriaram). oracle-e2-1 mostra 2 workers = drain de recreate (antigo beatAge 80s a envelhecer), não regressão — vigiar.
Nenhuma fila afetada, nada a relançar. (Nenhum dos "a vigiar" acima re-orfanou — lighthouse não-sweep/industry/score/
geoip todos 0.)

**Ronda 2026-07-17T15:27Z — só sweep com órfãos, NADA relançado (evento = INCIDENTE de1 duplicado):** as ÚNICAS
filas com órfãos são todas de **sweep >55** → NÃO relançadas por instrução: `gmb` pend 7755 órfãos 8/redeliv 8
(residential, maxAck 5), `lighthouse_desktop` pend 5535 órfãos 12/redeliv 27 (maxAck 20, inflight 20 saturado),
`lighthouse_mobile` pend 2999 órfãos 19/redeliv 32 (maxAck 20, inflight 20). **NENHUMA fila não-sweep tem órfãos**
(industry/score/geoip/whois/nuclei/wpscan/verify/fetch todas 0/0/0). `campaign_generate` NATS **0/0/0 não-órfão** ✓
(servido pelos `ai` do hel1, waiting 3). `fetch` drenou completamente (0 pending/0 órfãos). **Nada relançado.**
Logs da frota: 400 linhas (15:03→15:27), **10 ✗ + 33 ↻ TODAS lighthouse** (`desisto após 3`/retry — ack-gracioso
fix 3c7b886; ~10× ABAIXO do pico R9, teto 20 a segurar), **0 bloqueios gmb** (0 sorry/recaptcha/blocked), **0 PG/
under-pressure REAIS**. Sem POISON. **Evento da ronda = INCIDENTE ABERTO** (containers worker duplicados
`worker`→`npworker` em de1/oracle-e2-1/oracle-e2-2; ver DEBUG-FOUND + deploy-watch) — mas é problema de DEPLOY, não
de filas; nenhuma fila afetada, nada a relançar. Nota: os órfãos/abortos lighthouse de **de1 estão escondidos** (de1
não reporta beats/logs ao dashboard por causa do incidente) → contagem fleet-wide de ✗ lighthouse subestimada.

**Ronda 2026-07-17T11:35Z:** ÚNICA fila com órfãos = `fetch` (pending 0, orphans 678, redeliv 678) → **excluído** (sites mortos a expirar por MaxAge 48h; não relançar). Todas as outras 29 filas 0 órfãos (industry/geoip/score/lighthouse limpas). **Nada relançado esta ronda.** `campaign_generate` 0/0/0 (não órfão). Logs da frota: 215 linhas, **0 ✗/↻**.

**Ronda 2026-07-17T12:13Z — frota limpa, backfill `fetch` drenado:** ÚNICA fila com órfãos = `fetch` (pending 0,
**orphans 1, redeliv 1** — 1 transitório isolado, já não os 678 de 11:35 nem os ~500 de sites-mortos) → **excluído**
(fetch nunca se relança; MaxAge trata). Todas as outras 29 filas 0 órfãos. `campaign_generate` NATS **0/0/0 (não
órfão)** ✓ — servido pelos base do hel1 (rota antiga; hel1 SKIP_GIT ainda não recriou). `industry` **0/0/0** (os naks
Directus under-pressure ficaram resolvidos desde 11:53, sem re-acumulação). `lighthouse_desktop`/`lighthouse_mobile`
**0/0/0** (fix `3c7b886` a segurar; sem novos ✗). **`fetch` backfill base-wide DRENOU** (pend 518k→494k→227k→**0**).
Logs da frota: **165 linhas, 0 ✗/↻**. **Nada relançado.** Sem POISON. Sem incidente. (Nota: nenhum dos "a vigiar"
acima re-orfanou — lighthouse/industry/geoip/score todos 0.)

**Ronda 2026-07-17T12:20Z — frota limpa, nada relançado:** ÚNICA fila com órfãos = `fetch` (pending 0,
**orphans 1, redeliv 1** — 1 transitório isolado; NATS confirma `fetch pend 0 inflight 0 redeliv 1`) → **excluído**
(fetch nunca se relança; MaxAge 48h trata). Todas as outras filas 0 órfãos / 0 redeliv. `campaign_generate` NATS
**0/0/0 (não órfão)** ✓ — ainda servido pelos base do hel1 (hel1 SKIP_GIT não recriou; env-hash inalterado).
`industry`/`geoip`/`score`/`lighthouse_*` todos **0/0/0** (sem re-orfanamento dos "a vigiar"). Logs da frota:
**165 linhas, 0 ✗/↻**. **Nada relançado.** Sem POISON. Sem incidente.

**Ronda 2026-07-17T13:36Z — SWEEP >50 a drenar; só `score` relançado:** filas com órfãos = `score` (pend 0, órfãos 2,
redeliv 2 — NÃO-sweep → **relançado 1×**: requeue 2 purged/2 requeued; pós-requeue NATS `score pend 0 inflight 1 redeliv 0`
— apanhados, drenou limpo). Filas de **sweep** (NÃO relançadas por instrução): `gmb` pend 10.171 órfãos 2/redeliv 2 (inflight
2 — GMB_MAX_ACK=5 ainda não pegou, laptop não recriou), `lighthouse_desktop` pend 6.137 órfãos 3/6 (inflight 6, preso no teto),
`lighthouse_mobile` pend 3.519 órfãos 3/6 (inflight 6), **`nuclei` pend 168 órfãos 129/redeliv 290** (inflight 256; cada scan
**90-224s**, mediana ~90s → ackWait < tempo-de-processamento infla redeliv e alguns batem no maxDeliver; TODAS as 99 linhas
nuclei no buffer = ✓, 0 ✗/↻ → não é crash, é a cauda lenta do sweep), `wpscan` pend 0 órfãos 4/4, `industry` pend 0 órfãos
2/2 (redeliv baixo). `fetch` órfão 1 → **excluído** (MaxAge). `campaign_generate` NATS + `/api/queues` **0/0/0 (não órfão)** ✓ —
servido pelos base do hel1 (rota antiga; hel1 SKIP_GIT não recriou). Logs da frota: **315 linhas, 14 ↻/✗ TODAS lighthouse**
(7↻ mobile + 5↻ desktop + 1✗ cada — ack-gracioso do fix 3c7b886), **0 bloqueios gmb** (0 sorry/recaptcha/blocked), **0 PG/
under-pressure**. Sem POISON. Sem incidente. (**nuclei 129 órfãos = observação, não relançado** — sweep, best-effort, resultados
perdidos p/ esses sites mas por lentidão de scan, não bug; vigiar se subir muito acima de ~130.)

**Ronda 2026-07-17T13:06Z — SWEEP >50 a drenar; só `score` relançado (regra permanente):** sob a carga do sweep,
7 filas têm órfãos>0. Das **não-sweep**, só `score` (pending 0, órfãos 10, redeliv 10) → relançado 1× (requeue:
**10 purged/10 requeued**; pós-requeue NATS `score pend 0 inflight 6 redeliv 0` — apanhados, drenou limpo; 41 linhas
score no buffer todas ✓, órfãos vieram do burst Directus under-pressure @13:02:20, não de bug de score). Das filas do
**sweep** (`gmb`/`lighthouse_*`/`nuclei`/`whois`/`industry`/`wpscan`) — NÃO relançadas por instrução (pending>0 legítimo
ou mid-sweep): `gmb` órfãos 2/redeliv 2, `lighthouse_desktop` 3/7, `lighthouse_mobile` 2/8, `industry` 2/2 (pend 0),
`wpscan` 4/4 (pend 0) — **redeliv baixo, longe do maxDeliver** (nuclei 256, wpscan 48, industry 96, lighthouse 6), NÃO
é escalada de órfão real, só a cauda a re-tentar. `fetch` órfão 1 → **excluído** (MaxAge). `campaign_generate` NATS +
`/api/queues` **0/0/0 (não órfão)** ✓ — servido pelos base do hel1 (rota antiga; hel1 SKIP_GIT não recriou apesar do
git `717444c`). **Sweep a DRENAR:** nuclei 1.2k→869, whois 1.1k→317, industry 0.6k→0, wpscan 84→0, re-fetch 817→0
(gmb 10.6k→10.5k e lighthouse desktop 6.2k/mobile 3.6k lentos mas com inflight ativo — estrutural, esperado). Logs da
frota: 394 linhas, **0 ✗**, 30 ↻ + 17 "Under pressure" + 2×503 (naks transitórios, classe conhecida; 0 erros PG graves).
Sem POISON. Sem incidente.

**Ronda 2026-07-17T12:52Z — frota limpa, nada relançado (só deploy-watch):** ÚNICA fila com órfãos = `fetch`
(pending 0, **orphans 1, redeliv 1** — 1 transitório isolado; NATS confirma `fetch pend 0 inflight 0 redeliv 1`) →
**excluído** (fetch nunca se relança; MaxAge 48h trata). Todas as outras 29 filas 0 órfãos / 0 pending / 0 redeliv.
`campaign_generate` NATS + `/api/queues` **0/0/0 (não órfão)** ✓ — ainda servido pelos base do hel1 (hel1 SKIP_GIT
não recriou; env-hash `6b5a435f5970bfdf` inalterado). `industry`/`geoip`/`score`/`lighthouse_*` todos **0/0/0** (nenhum
dos "a vigiar" re-orfanou). Logs da frota: **123 linhas, 0 ✗/↻**. **Nada relançado.** Sem POISON. Sem incidente.
Evento da ronda = **DEPLOY** (2 commits git novos `98f0982`+`ba93076` dashboard/proxmox → de1/oracle1/oracle2
recriaram de novo, ids novos; **de1 RESOLVEU a 1 worker único** — overlap `--no-deps` era drain, não duplicado;
churn esperado, ver `deploy-watch.md`).

**Ronda 2026-07-17T12:38Z — frota limpa, nada relançado (só deploy-watch):** ÚNICA fila com órfãos = `fetch`
(pending 0, **orphans 1, redeliv 1** — 1 transitório isolado; NATS confirma `fetch pend 0 inflight 0 redeliv 1`) →
**excluído** (fetch nunca se relança; MaxAge 48h trata). Todas as outras 29 filas 0 órfãos / 0 redeliv.
`campaign_generate` NATS + `/api/queues` **0/0/0 (não órfão)** ✓ — ainda servido pelos base do hel1 (hel1 SKIP_GIT
não recriou; env-hash `6b5a435f5970bfdf` inalterado). `industry`/`geoip`/`score`/`lighthouse_*` todos **0/0/0** (nenhum
dos "a vigiar" re-orfanou). Logs da frota: **123 linhas, 0 ✗/↻**. **Nada relançado.** Sem POISON. Sem incidente.
Evento da ronda = **DEPLOY** (git `2340aaf`+`12f4e22` → de1/oracle1/oracle2 recriaram; churn esperado, ver
`deploy-watch.md`).

**Ronda 2026-07-17T14:23Z — hel1 restart (verify+lh12+campaign→ai) validado; só `industry` relançado:** filas com
órfãos = TODAS de **sweep** (não relançadas por instrução) EXCETO `industry`: `gmb` pend 9.3k órfãos 3/redeliv 3
(inflight 5, GMB_MAX_ACK=5 pegou no laptop), `lighthouse_desktop` pend 5.9k órfãos 5/redeliv 13 (inflight **12** —
teto novo), `lighthouse_mobile` pend 3.3k órfãos 6/redeliv 17 (inflight 12), **`nuclei` pend 0 órfãos 135/redeliv 135**
(inflight 0; cauda lenta avgMs 104s — ackWait<scan infla redeliv; NÃO relançado, best-effort; ~129→135, dentro do
padrão), `wpscan` pend 0 órfãos 4/4. `fetch` órfão 1 → **excluído** (MaxAge). **`industry`** (base, NÃO-sweep, pend 0,
órfãos 2/redeliv 2 — naks Directus under-pressure residuais, 0 ✗/under-pressure no buffer) → **relançado 1×**
(requeue: 2 purged/2 requeued); **pós-requeue NATS industry não aparece = 0/0/0 — drenou limpo**. `campaign_generate`
NATS **0/0/0 não-órfão** ✓ — **agora servido pelos `ai` do hel1** (waiting 3; a migração fechou no restart manual @14:23).
`score`/`geoip`/`verify` **0/0/0**. Logs da frota: **143 linhas, 4 ✗ lighthouse** (desisto após 3: vk78.se, certo.se,
oiensonerbygg.se, annawester.se — ack-gracioso fix 3c7b886, sites conhecidos-difíceis) + **15 ↻ lighthouse** (retry a
funcionar; ~4 abortos/9min = **NÃO é pico**, teto 12 a segurar), **0 bloqueios gmb** (0 sorry/recaptcha), **0 PG/
under-pressure/503**. Sem POISON. Sem incidente. (verify pend 0 = 512 contactos repostos ainda não re-enfileirados, normal.)

**Ronda 2026-07-17T11:53Z — os 678 `fetch` re-enfileirados DRENARAM:** NATS `fetch` agora **pend 0, inflight 1, redeliv 1** (era orphans/redeliv 678 @11:35). Ou seja, **~678 drenaram, ~0 re-orfanaram** (redeliv 1 = 1 transitório isolado, não os 678) → NÃO houve re-orfanamento em massa e NÃO surgiram candidatos a sites-mortos nesta ronda (os mortos re-orfanariam; nenhum o fez). `fetch` continua a processar activo (137 ✓ fetch no buffer de logs, 20-31s cada). **NENHUMA fila com órfãos>0** em toda a frota (nem sequer `fetch`). **Nada relançado.** `campaign_generate` NATS 0/0/0 (não órfão) — servido pelos base do hel1 (rota antiga, hel1 ainda não recriou). **`industry` LIMPOU**: NATS 0/0/0 (era redeliv 146 @07:10, 43 @11:20) — os naks do Directus under-pressure resolveram-se, pend 0, sem re-acumulação. Logs da frota: 242 linhas (11:45:52→11:46:34), **0 ✗/↻**, mix fetch 137 + industry 105 (ambos a drenar/classificar saudável). Sem POISON. Sem incidente.

<!--
Exemplo:
| POISON | lighthouse_mobile | eviindustries.se, axelpriset.se | performance mark has not been set | 4 | 2026-07-17T09:40 | 2026-07-17T10:25 | (a decidir) |
| RESOLVIDO | industry | — | Directus under-pressure | — | — | — | transitório, resolveu sozinho |
-->
