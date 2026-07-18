# Plan: Auditoria + correção das métricas da Cobertura de Jobs (query a query)

## Context

A página **Cobertura de Jobs** conta, por job, a fração de sites `qualified AND is_live` onde **o job CORREU**
(≠ "achou dado", que é a Cobertura de Dados). Cada job usa um "marcador" — um timestamp dedicado OU uma
coluna-sentinela que o handler DEVE escrever SEMPRE que corre (mesmo a vazio). O contrato quebra quando um
handler só escreve o marcador **quando encontra dados / em caso de sucesso** → o número degrada silenciosamente
de "correu" para "achou" e **subconta**. Já corrigimos exatamente esta classe de bug no `verify`. Esta auditoria
percorreu as 3 queries (`COVERAGE_SQL`, `CONTACT_VERIFY_SQL`, `DATA_COVERAGE_SQL`) e TODOS os handlers, e
confirmou vários casos + duas escolhas de design do utilizador:
- **Denominador → "mostrar ambos"**: cada linha mostra `feito/elegível` (progresso do job) **e** `elegível/total`
  (quão seletivo é o job).
- **Marcadores partilhados → "marcador próprio por job"**: acabar com os 5 jobs que partilham `checked_at` e os
  2 que partilham `whois_checked_at`.

Ficheiros centrais: `dashboard/server.mjs` (COVERAGE_SQL ~1703-1749, CONTACT_VERIFY_SQL, endpoints
`/api/coverage`), `dashboard/public/index.html` (`viewCoverage`, `covSum`, `covRowHtml`, `covBar`, `COV_JOBS`,
`COV_BUCKETS`), `worker/handlers.mjs`, `worker/worker.mjs`, `lib/pgwrite.js` (allow-list + `SITE_COL_TYPE`),
`enrich-sites.js`, `extract-contacts.js`.

## Achados — auditoria por job (verificado no código + na DB ao vivo)

Marcadores **corretos** (escrevem sentinela/timestamp incondicionalmente — não mexer): `fetch` (http_status;
sites sem HTTP ficam `is_live=false` → fora do denominador), `traffic` ('unranked'), `ssl` ('F'), `subdomains`
(`[]`; o 1.1% é backlog real, não bug), `whois` (timestamp; naka em rate-limit, não faz false-ack), `gmb`
(timestamp sempre), `score` (lead_score_at), `contacts` (fine), `enrich`/`checked_at`.

Marcadores **com bug (subcontam — mesma classe do verify)**:
- **nuclei** (`worker.mjs:191/194`) e **wpscan** (`worker.mjs:208/210`): no `catch` de erro (≠"not installed")
  fazem `return 'ack'` **sem escrever** `security_findings`/`wp_vuln_count` e **sem re-tentar** → o site fica NULL
  para sempre e nunca re-corre. (Na DB: `security_findings` tem **0 linhas a `[]`** — os erros/limpos desaparecem.)
- **fingerprint** (`handlers.mjs:215-220`): `tech_detected` fica `null` (não `[]`) quando o wappalyzer está
  ausente/lança/devolve não-array; e early-return em `:210` (sem HTML) → não escreve.
- **emailauth** (`handlers.mjs:262`): `spf_status` fica `null` em DNS transitório (SERVFAIL/timeout); throw é
  engolido pelo `catch{}` e o score é publado à mesma → ack sem marcador.
- **audit (coarse)** vs **DAG fino**: só o `handleAudit` legado escreve `audit_checked_at`; o fan-out fino
  (`handlers.mjs:350-352`: score→lighthouse/nuclei/ssl/whois/dnsprovider) **nunca** o escreve → a linha `audit`
  está **morta** no pipeline atual (0.1%).

Marcadores **partilhados (indistinguíveis)** — o utilizador quer marcador próprio:
- `checked_at` partilhado por **enrich, dns, geoip, locality, industry** → todos mostram o MESMO número.
- `whois_checked_at` partilhado por **whois e dnsprovider** (o `handleDnsprovider` engole erros e faz sempre
  ack → falhas dele são invisíveis, mascaradas pelo marcador do whois).

**Nota (fora de escopo do metrics, mas apanhado):** `gmb_checked_at` está no allow-list de escrita
(`lib/pgwrite.js:44`) mas falta em `SITE_COL_TYPE` (`:120-129`) → no caminho `WRITE_BEHIND` o CASE constrói um
`THEN` text não-tipado contra `timestamptz` → possível erro de type-resolution. Corrigir de passagem.

## Workstream A — Corrigir marcadores condicionais nos handlers (correctness, prio 1)

Política única e consistente (a mesma do verify + lighthouse): **transitório → nak/retry** (bounded por
maxDeliver); **permanente/vazio/fim-das-retries → escrever a SENTINELA de "correu"** (`0`/`[]`/status), **nunca**
`ack` silencioso sem escrever. Assim: erros transitórios re-tentam; o resto conta como "correu (sem dado)".
- `worker/worker.mjs` nuclei/wpscan: no `catch`, distinguir transitório (`isTransientJobErr` → `'retry'`, como o
  lighthouse) vs restante (escrever `security_findings:0`/`wp_vuln_count:0` + `ack`). Deixar de fazer o ack mudo.
- `worker/handlers.mjs` fingerprint: garantir `tech_detected: []` (nunca `null`) quando corre; tratar o
  early-return `:210` (sem HTML: ou nak-para-refetch, ou escrever `[]`).
- `worker/handlers.mjs` emailauth: em DNS transitório → nak/retry em vez de gravar `spf_status:null`.
- `audit_checked_at`: escrevê-lo no DAG fino (na etapa `score` que dispara o fan-out, `handlers.mjs:350-352`),
  para a linha `audit` refletir o pipeline real.

## Workstream B — Marcador próprio por job (fim dos partilhados, prio 2)

Adicionar timestamps dedicados, escritos **incondicionalmente** quando cada handler corre:
`dns_checked_at`, `geoip_checked_at`, `locality_checked_at`, `industry_checked_at`, `dnsprovider_checked_at`.
- **Schema**: novas colunas `timestamptz` em `sites` (migração Directus/PG).
- `lib/pgwrite.js`: juntar as colunas ao allow-list **e** ao `SITE_COL_TYPE` (evita o bug do gmb).
- **Handlers** (`worker/handlers.mjs`): cada handler escreve o seu `*_checked_at` no início/patch, mesmo nos
  early-returns onde o job "correu mas não achou" (ex.: locality sem HTML — decidir se conta como correu).
- `handleDnsprovider`: escrever `dnsprovider_checked_at` e **deixar de esconder erros** (parar o
  `.catch(()=>{})` cego; nak em transitório).
- **COVERAGE_SQL** (`dashboard/server.mjs`): trocar cada marcador partilhado pelo próprio
  (`dns` → `dns_checked_at`, etc.; `dnsprovider` → `dnsprovider_checked_at`).
- **Backfill (uma vez)**: para os sites existentes, `UPDATE sites SET dns_checked_at=checked_at, …=checked_at`
  onde `checked_at IS NOT NULL` (historicamente correram juntos com o fetch) → a transição não perde cobertura.

## Workstream C — UI: mostrar ambos os denominadores + universo elegível por job (prio 2)

Definir o **universo elegível por job** (o "que há para fazer") e mostrar 2 leituras por linha:
`feito/elegível` (progresso) + `elegível/total` (seletividade).
- Elegível = `total` (qualified+live) para a maioria; `wp_total` para `wpscan` (já); `with-email` para `verify`
  (já, contact-level); audit-tier (`audit`/`lighthouse_*`/`nuclei`/`gmb`) = ver Q em aberto abaixo.
- Backend: expor por bucket os denominadores elegíveis que faltarem (já há `wp_total`, `contacts_total`/
  `v_withemail`; adicionar os do audit-tier se se definir uma coorte-alvo).
- `dashboard/public/index.html`: `covRowHtml`/`viewCoverage` passam a renderizar as duas frações
  (ex.: `46/46 elegíveis (100%) · 46/2394 do total (1.9%)`); reutilizar `covBar`. `covSum` já soma por bucket.

## Workstream D — Menor: type de `gmb_checked_at` no write-behind

`lib/pgwrite.js`: adicionar `gmb_checked_at` a `SITE_COL_TYPE` (`timestamptz`) — corrige o CASE não-tipado no
flush do `WRITE_BEHIND`.

## Sequência & backfill
1. **A** (correctness) primeiro — para os handlers deixarem de subcontar/perder jobs a partir de já.
2. **B** (marcadores próprios) — schema + handlers + SQL + backfill.
3. **C** (UI ambos os denominadores).
4. **D** (type fix, trivial).
- Os NULLs já existentes dos jobs bugados (nuclei/wpscan/fingerprint/emailauth) **não se auto-curam**: ou se
  re-enfileiram esses jobs (o backlog corrige com o tempo) ou se aceita que a cobertura sobe à medida que re-correm.

## Verificação (end-to-end)
- **A**: forçar um erro de nuclei/wpscan num site → confirmar que re-tenta (transitório) OU escreve `0` + ack
  (permanente), e que a linha de cobertura passa a contá-lo; `fingerprint`/`emailauth` deixam de gravar `null`.
- **B**: correr `dns`/`geoip`/`locality`/`industry`/`dnsprovider` num site e confirmar que cada `*_checked_at`
  fica preenchido independentemente; `/api/coverage` deixa de mostrar 5 números idênticos; backfill valida os
  existentes. Confirmar que o write-behind não rebenta (SITE_COL_TYPE).
- **C**: na página, cada linha mostra as 2 frações por filtro de score; os totais elegíveis batem com a DB.
- Query de sanidade por filtro (TODOS/>55/>75): `curl /api/coverage` + comparar cada `feito` e `elegível` com um
  `SELECT count(*) FILTER (...)` direto na `sites`/`contacts`.

## Questão em aberto (a decidir na execução de C)
Para o **audit-tier** (`audit`/`lighthouse_*`/`nuclei`/`gmb`), qual é o "elegível"? Não há hoje uma flag
explícita de "alvo de auditoria". Opções: (a) `elegível = total` (a 2ª fração fica trivial 100%); (b) definir a
coorte-alvo (ex.: acima de um score, ou uma flag `audit_target`) e medir contra ela. Recomendo decidir isto
quando chegarmos ao Workstream C, com os números reais à frente.
