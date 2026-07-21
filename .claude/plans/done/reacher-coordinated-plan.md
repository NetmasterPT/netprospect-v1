# Plano: Verificação coordenada — re-verificação inteligente + provider + qualidade-de-email no lead score

> Sessão **NP Scheduler / Reacher** (2026-07-19). Aprovado.
> ⚠️ **COORDENAÇÃO:** a sessão `01A6TKXbxEL5` está a trabalhar no verify e já implementou parte disto (ver
> "Já feito"). Este plano assenta só no **delta** e constrói sobre o que existe — não duplica nem reverte.

## Context

O piloto do Reacher está **live** (458 contactos, 97% valid). A verificação melhorou muito hoje, mas ainda
**grava só o resultado e não age sobre ele**: `verified_at` é escrito e **nunca lido** → `valid`/`unknown`
**nunca são re-verificados** (o TTL de 90d do README é pura lacuna, e a entregabilidade decai); os
**permanentes** (`no_mx` 496, `invalid`, `catch_all` 130/44 dom, `role`, `disposable`) voltam à fila em vão;
os **68 domínios B2C** (26% do backlog / 40k contactos) sem cap monopolizam um lote; o `mail_provider` é
calculado mas **descartado** (não dá para segmentar/priorizar); e o **lead score ignora a qualidade do email**
(só o booleano `has_email`). Um `valid@empresa-real` não vale mais que um `catch_all@website-builder`.

**Objetivo (o delta):** `reverify_after` + `mail_provider` persistidos → uma **política de re-verificação
inteligente** (salta permanentes, TTL/decay, cap por-domínio B2C, exclui hard-blocks) + **qualidade de email
no lead score**. Aditivo e reversível.

## Já feito por outra sessão (`01A6TKXbxEL5` — NÃO refazer)

- **`contacts.email_verify_detail` (json)** — breakdown rico do Reacher (reachable/deliverable/catch_all/role/
  disabled/full_inbox/disposable/smtp_reason/source), gravado nos resultados definitivos. *(`bootstrap-directus.js`, `verify-core.js` `reacherDetail`)*
- **Big-provider → só-API + defer** — Gmail/M365/Yahoo (por MX) já **não** caem no Reacher (evita o unknown
  falso); API-esgotada → `deferred` (fica null → retry). *(`verify-core.js:makeVerifyOne`)* → **resolve o
  "rotear unknown por provider" ao nível do routing.**
- Deadline de 85s por job (fix desta sessão, intacto); `smtp_timeout` corrigido p/ `Duration{secs,nanos}` (o int
  8 dava HTTP 400 — **não voltar a mexer**); `general_email` prefere o domínio próprio + blacklist de builders;
  painel verify + escada de temperatura no dashboard.

## Estado atual (medido)

verificados 1363 (valid 687 · unknown 331 · catch_all 130 · role 104 · no_mx 496 · invalid 35); 156k por
verificar; via Reacher 458 (**97% valid**); backlog dominado por **68 dom B2C = 40k**; 33.856 dom de 1-contacto
(empresas reais). Provider dos unknown: Microsoft 94% (agora vai só-API), corp/gmail bem.

## Decisões (confirmadas)

- **B2C:** cap por-domínio (top-N por lead_score) + desprioritizar.
- **`reverify_after` denormalizado** (calculado no verify, indexável) — vs recalcular a política na query.
- **Provider = coluna TIPADA** `contacts.mail_provider` (queryable/indexável), não só no blob json.
- **`verify_reason` dispensado** — a razão já vive em `email_verify_detail.smtp_reason` e a **decisão** fica
  codificada no `reverify_after` (não é preciso 3ª coluna).

---

## Fase 1 — Persistir o que falta (schema + verify-core)

**Schema** — `bootstrap-directus.js` (idempotente; `ensureField`/`ensureEnumChoices`):
- `contacts.mail_provider` → `enumS(['gmail','microsoft','yahoo','corp'])` + `ensureEnumChoices`.
- `contacts.reverify_after` → `ts()`.
- `companies.catch_all` → `bool(false)`; `companies.blocks_probing` → `bool(false)`.
- `db/audit-indexes.sql` → `CREATE INDEX IF NOT EXISTS ix_contacts_reverify ON contacts(reverify_after);`

**Persistência** — `lib/verify-core.js` (`verifyDomain`; o `cls = providerClass(mx)` já existe na linha 36):
- Passar `mail_provider: cls` ao `persist` (juntar ao objeto que já leva `...det`).
- Calcular `reverify_after` por (status, provider, detalhe) — a política (tabela); gravar no `persist`.

  | email_status | provider / detalhe | reverify_after |
  |---|---|---|
  | `valid` | — | **now + 90d** (decay) |
  | `catch_all` | — | now + 180d (ou skip via `company.catch_all`) |
  | `unknown` | microsoft *(já só-API)* / `blocks_probing` | **NULL** (não re-sondar) |
  | `unknown` | greylist/transitório *(canConnect=false / smtp_reason)* | **now + 5d** |
  | `role` | — | NULL (departamental estável) |
  | `invalid` / `disposable` / `no_mx` | — | NULL (permanente) |

- **Flags de DOMÍNIO 1×/domínio** (`companies`, que já desvia p/ PG via `updateItemMaybePg`): `catch_all` (do
  `classifyCatchAll`, hoje decidido mas não persistido) e `blocks_probing` (quando os probes corp dão
  `canConnect=false` consistente — ex. `abion.com`, `coast.no`).

## Fase 2 — Re-verificação inteligente (o enqueue) — **totalmente por fazer**

Reescrever a seleção em **ambos**: `enqueue-email-verification.js` (filtro SDK, linha 41) **e**
`/api/verify/enqueue` (PG, `dashboard/server.mjs:1001-1005`). Partindo do JOIN existente
(`contacts ct JOIN companies co ON co.id=ct.company JOIN sites s ON s.id=ct.site`):
- **Predicado:** `(ct.email_status IS NULL OR ct.reverify_after < now())` — permanentes têm `reverify_after
  NULL` → excluídos.
- **Excluir** `co.blocks_probing = true`.
- **Cap por-domínio + desprioritizar B2C:** `row_number() OVER (PARTITION BY co.org_domain ORDER BY
  s.lead_score DESC) <= N` (ex. N=5); ordenar domínios com **menos** contactos-null primeiro, depois
  `s.lead_score DESC`.
- Mantém `--min-score`/`--max-emails`/dedup + o deadline de 85s do worker.

## Fase 3 — Qualidade-de-email no lead score — **totalmente por fazer**

O score é por-`sites`; a qualidade vive em `contacts` → **rollup** (padrão do `has_email`, `extract-contacts.js:138-143`):
- **Rollup:** no fim de `handleVerify`, reduzir os contactos do domínio ao melhor status → coluna(s) em `sites`:
  `has_valid_email` (bool, ≥1 `valid`) + opc. `has_valid_corp_email` (valid num domínio próprio, ≠ gmail/b2c =
  o sinal mais forte). `pub(jobs.score)` a seguir.
- **Sinal:** `lib/lead-score.js` `SCORE_SIGNALS` + peso em `config/lead-score.json` (ex. `has_valid_email:10`,
  `has_valid_corp_email:+4`).
- **Sincronizar os DOIS caminhos de score** (obrigatório, regra do repo): `case` em `score-leads.js` `signalSql`
  **e** a coluna em `SCORE_FIELDS` no `worker/handlers.mjs` (`handleScore`).

---

## Ficheiros a modificar

- **`bootstrap-directus.js`** — `contacts.{mail_provider,reverify_after}` + `companies.{catch_all,blocks_probing}`. *(F1)*
- **`lib/verify-core.js`** — passar `mail_provider` + calcular `reverify_after` no `persist`; rollup flags de
  domínio (`companies`) e qualidade por-site (`sites`). *(F1+F3)*
- **`enqueue-email-verification.js`** + **`dashboard/server.mjs`** (`/api/verify/enqueue`) — SELECT novo (TTL +
  cap por-domínio + exclui blocks_probing). *(F2)*
- **`lib/lead-score.js`** + **`config/lead-score.json`** + **`score-leads.js`** + **`worker/handlers.mjs`** (`SCORE_FIELDS`). *(F3)*
- **`db/audit-indexes.sql`** — índice `reverify_after`. *(F1)*
- **Docs** — `docs/outreach-ops/` + README §10: a política + campos novos.

## Verificação (end-to-end)

1. `node bootstrap-directus.js` → as 4 colunas existem.
2. Verificar 1 corp + 1 catch-all + 1 hard-block → `contacts.mail_provider/reverify_after` corretos;
   `companies.catch_all`/`blocks_probing` marcados.
3. `enqueue-email-verification.js --dry-run` → salta permanentes; re-inclui `valid` com `reverify_after<now()`;
   **cap ≤N por org_domain**; empresas reais antes dos B2C; exclui `blocks_probing`.
4. `score-leads.js` num site com `valid@corp` → o `lead_score_breakdown` mostra o sinal novo.
5. Backfill (opc.): script one-off preenche `mail_provider`/`reverify_after` dos 1363 já feitos a partir de
   `email_status`+`email_verify_detail`; os restantes preenchem-se ao re-verificar.

## Notas / risco

- **Aditivo + reversível**; o antigo `email_status IS NULL` é um subcaso do predicado novo.
- **Coordenar com `01A6TKXbxEL5`** (verify ativo): este plano só toca `reverify_after`/`mail_provider`/enqueue/
  score — **não** mexe no routing big-provider nem no `email_verify_detail` (deles). Se colidir, ceder o routing.
- **Não tocar** no `smtp_timeout` (já é `Duration{secs,nanos}`) nem no deadline (intacto).
- Manter os 2 caminhos de score em sincronia (`lead-score.js` ↔ `score-leads.js`).
- `role` como permanente é afinável (departamentais mudam raramente → `reverify_after=NULL`).
