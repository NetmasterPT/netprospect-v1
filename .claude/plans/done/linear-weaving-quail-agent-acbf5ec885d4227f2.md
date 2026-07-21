# Ronda de saúde NetProspect @2026-07-18T10:40Z — plano de ações

## Veredicto (read-only, já apurado)
**OK — sem problemas novos.** `/api/alerts` count=0, `/api/config` clickhouse.up=TRUE.
Nada a relançar (só sweep+quota com órfãos). Sem POISON. Sem incidente novo.

Sinais:
- Deploy-watch: env-hashes 5/5 INALTERADOS (sem deploy .env). 10 workers, 1/host + hel1 6, sem duplicados.
  - hel1 base ×3 CONTÍNUO (`3de203d3`/`ff9f8dfad7`/`04630ff6`, up 159.0/159.0/158.9m = +77.9m 1:1, sem recreate).
  - hel1 ai ×3 mesmos ids (`964d368a`/`2f1f24be`/`ab7a34f9`), up ~58m → reciclaram 1× desde @09:21 (esperado 84.7m), fail1h 0/0/0 = residual benigno, não crash-loop.
  - de1 (`ecf5022d989a`, up 2.0m), oracle1 (`9665ca1d6e9b`, up 6.0m), oracle2 (`37f4a041a5a4`, up 1.3m) = recreate por code pull (ids novos, env+version inalt.). laptop (`6c03b3221b9b`, up 27.0m) reciclou (residencial).
- Migração CH (A) — R3/3: workers estáveis + clickhouse.up=TRUE + campaign_generate 0/0/0 servido pelos 3 ai. RESSALVA: write-path CH (lighthouse→CH) AINDA por exercitar (lighthouse pend 0 toda a ronda, ai idle done1h 0).
- C5 exporters (B): alerts=0 inclui targets nats/redis/postgres CT200 → estável.
- Órfãos: subdomains (sweep, pend 2633, maxAck 16, crt.sh — NÃO relançar) + verify (quota 22, re-orfana — NÃO relançar). Restantes 28 filas 0/0/0. campaign_generate 0/0/0 não-órfão (waiting 3).
- Logs: 181 linhas, 18 ✗ (subdomains ECONNREFUSED, laptop) + 111 ↻ (102 crt.sh `fetch failed` + 9 PG ETIMEDOUT). 0 under-pressure, 0 gmb-block, 0 crash/SyntaxError, 0 erro-CH.
- Observação (não incidente): subdomains — assinatura mudou, crt.sh `fetch failed` (102) agora DOMINANTE sobre PG (27, ~flat vs 26 @09:21). É o teto externo crt.sh do watch-item (maxAck 16). Best-effort sweep, retry-only, confinado a 1 job. Subdomains a DRENAR (pend 3762@09:21 → 2633). Gates PG de escalada NÃO atingidos (não espalhou a outros jobs; PG ~flat).

## Ações a executar (bookkeeping — bloqueadas por plan mode, pedir aprovação)
1. **Filas: NENHUMA operação** — nada seguro/não-quota com órfãos. (Sem POST requeue esta ronda.)
2. **docs/deploy-watch.md** — reescrever bloco de baseline + tabela por host com valores @10:40Z; na secção "Sob observação":
   - Migração CH (hel1-docker workers) → R3/3 worker-estável VALIDADO, com ressalva "write-path CH por exercitar" (mantém nota até haver lote lighthouse).
   - np-server dashboard → R3/3 clickhouse.up=TRUE VALIDADO.
   - ai×3 reciclagem → 1× nesta ronda, fail1h 0/0/0 (benigno).
   - PG subdomains → atualizar: agora crt.sh `fetch failed` dominante (102) + PG flat (27); gates não atingidos.
3. **docs/orphan-offenders.md** — acrescentar linha datada @10:40Z (alerts=0, clickhouse.up=TRUE; 2 filas c/ órfãos = subdomains sweep + verify quota, nada relançado; campaign_generate não-órfão; logs 18✗+111↻ todas subdomains, repartição crt.sh 102 + PG 27; sem POISON; observação crt.sh dominante).
4. **DEBUG-FOUND.md** — SEM nova linha (sem problema real novo).

Nenhum ficheiro de código é alterado. Sem commit.
