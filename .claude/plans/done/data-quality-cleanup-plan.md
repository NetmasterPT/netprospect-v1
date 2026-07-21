# Plano (TODO) — Limpeza de qualidade de dados (poison-DB) — Fase 2

> Pick-up-later. Consolida os achados da execução da Fase 1 do backlog-roadmap (2026-07-20). Ver memórias
> [[reextract-poison-cleanup]], [[company-registry-enrichment]], [[extraction-runon-regex-hazard]], [[industry-classification]].
> ⚠️ **Coordenação:** `lib/contacts.js` / `lib/fingerprints.js` / `lib/audit/*` são editados por várias sessões
> em paralelo — `git log` + grep ANTES de mexer; ceder se colidir.

## Contexto

Os extractors on-site (contacts/social/locality/fingerprint) foram **reescritos/corrigidos** (15–19 Jul) mas a
DB ainda tinha as linhas envenenadas do extractor antigo. A **Fase 1b/1c** construiu o mecanismo `reextract`
(re-corre os extractors corrigidos por banda + purga-e-reinsere) e correu-o na banda **>50 qualificados**:
**`has_decision_maker` caiu de 22,5% → 3,2%** (removeu o maior vetor de poison, +16/lead). Mas a execução
revelou **mais camadas de poison** que ficam por resolver.

## O que JÁ está feito (Fase 1b/1c — commit `a8b3831`)

- Mecanismo `reextract` (variante do `jobs.fetch`): `worker/handlers.mjs` (`handleFetch` reextract-branch +
  `handleContacts` purge-then-reinsert + `has_decision_maker` não-sticky), `lib/pgwrite.js`
  (`pgDeleteStaleSiteContacts`), `enqueue-reextract.js` (por-banda, `--by-score`, resume por `contacts_checked_at`).
- Bandas **>70/>60/>50 qualificados** re-extraídas. Orphans de sites lentos/mortos limpos (`POST /api/queues/fetch/orphans {clean}`).

## Poison que FALTA (por ordem de valor)

### 1. `company.name` está ENVENENADO — alto valor, bloqueia a Fase 5
Achado concreto: um site .no tinha `company.name` = **"Nothing found for"** (artefacto de scraping — a página
dizia "Nothing found for…"). Isto (a) polui o directório/relatórios, (b) **impossibilita o match por nome** nos
registos de empresas (Fase 5). Investigar de onde vem o nome (`ensureCompany` em `worker/handlers.mjs` deriva de
`orgDomain`/nome extraído; e o `extractContacts`/título da página). **Ação:** detetar nomes-lixo (frases genéricas,
títulos de erro, "not found", nomes = domínio cru, etc.) e **re-derivar** (de `<title>`/`og:site_name` validado, ou
do domínio) — script de limpeza direcionado OU incluir no re-extract.

### 2. Emails GERAIS/de-diretório extraídos como "contactos" — médio-alto valor
Amostras: **35mm.pt** (cadeia) → `alcala@`, `barcelona@`, `bilbao@…35mm.es` como "pessoas" (name = local-part da
localização); **blakontoret.se** (diretório) → freemail de TERCEIROS (`davidsandberg76@gmail.com`) scraped de uma
listagem. Não são pessoas do negócio. **Ação (em `lib/contacts.js`):** (a) emails de localização/genéricos → não
emitir como `contacts` com nome-falso (vão para `company.general_email`); (b) detetar páginas de listagem/diretório
(muitos freemail de domínios ≠ do site) e não as tratar como contactos do próprio site. ⚠️ regex-hazard + coordenar.

### 3. `decision_maker` falso em nomes genéricos/de-localização — médio
Ex.: "donostia" (cidade) classificado como `decision_maker`. O precisão-primeiro já ajudou (22,5%→3,2%) mas resta
uma cauda. **Ação:** apertar o `role_category` (exigir corroboração honorífico+cargo; excluir tokens de
localidade/genéricos). Validar contra `DATA-BENCHMARK.md`.

### 4. Estender o re-extract ao RESTO da base — grande, OPS
Só a banda **>50 qualificados** foi limpa. Falta: **<50**, e os **live não-qualificados**. Além disso ~**1743
sites orfanaram** no reextract (sem snapshot completo → fetch completo → timeout em sites lentos/mortos). **Ação:**
correr `enqueue-reextract.js --min-score=40/30/…` (ou `--all`) por bandas, com PACING (não estourar a fila `fetch`
partilhada). Para a cauda lenta/morta: OU um `fetch` timeout maior no reextract, OU marcar sites persistentemente
mortos (`is_live=false` após N falhas) e saltá-los. Limpar orphans com `{mode:clean}` quando `pending==0`.

### 5. Extração do nº de registo (Org.nr/VAT) — alto valor, alimenta a Fase 5
O caminho de ALTA qualidade para os registos de empresas ([[company-registry-enrichment]]) é o **nº de registo
EXATO do site** (rodapé: "Org.nr 123 456 789", "NO123456789 MVA", "SE55…01", etc.). **Ação:** extrair no
`fingerprint`/`contacts` (regex ANCORADA por país — ver [[extraction-runon-regex-hazard]]) → `companies.org_number`
→ `lib/company-registry.js lookupByOrgNumber` → inserir os **decisores nomeados** como `contacts` (source=`registry`,
alta confiança) + `employees`/CAE. Isto **contorna** o problema #1 (nomes envenenados) e dá o sinal mais forte.

## Como executar (playbook)

- **Re-extract por banda:** `node enqueue-reextract.js --min-score=N --by-score` (topo→baixo). Métricas de saúde
  por banda: `has_decision_maker` (%) e média de contactos/site (poison infla ambos). Orphans: monitorizar o consumer
  `fetch` em `/api/queues`; `POST /api/queues/fetch/orphans {"mode":"clean"}` quando `pending==0`.
- **Fixes de extractor (#1,#2,#3):** editar `lib/contacts.js`/`lib/fingerprints.js` **com cuidado** (regex ancorada/
  limitada; coordenar com sessões ativas), validar contra `DATA-BENCHMARK.md` (2 sites ground-truth) ANTES de re-correr
  a base. Depois um re-extract completo propaga o fix.
- **Convergência da frota (gotcha):** o hel1 tem `SKIP_GIT` (só workers locais via restart manual); os remotos
  auto-pullam (~5 min). **Correr as bandas só depois da frota ter o código novo** (senão workers old-code marcam sites
  como feitos sem limpar). Confirmar com um reextract de teste que loga `reextract <dom>: -N contactos obsoletos`.

## Verificação
- Antes/depois por banda: `has_decision_maker` %, média contactos/site, amostra manual de 5 sites (nomes/emails sãos?).
- `company.name`: contar nomes-lixo (regex de "not found"/genéricos) antes/depois.
- Registo (#5): num site com Org.nr conhecido, confirmar decisores nomeados inseridos + `has_decision_maker`.

## Ficheiros-chave
`worker/handlers.mjs` (handleFetch/handleContacts/ensureCompany) · `lib/contacts.js` · `lib/fingerprints.js` ·
`lib/pgwrite.js` (`pgDeleteStaleSiteContacts`) · `enqueue-reextract.js` · `lib/company-registry.js` ·
`DATA-BENCHMARK.md` (ground truth) · dashboard `/api/queues/fetch/orphans`.

## Riscos
- O re-extract re-busca sites live (carga) → pace por banda; cauda lenta/morta orfana (aceitar+limpar ou timeout maior).
- A purga preserva `reviewed`/DNC/verificados/emailed — **edições manuais TÊM de pôr `reviewed=true`**.
- Mudanças na lógica do extractor (#2,#3) arriscam regressões → validar em `DATA-BENCHMARK.md` primeiro.
