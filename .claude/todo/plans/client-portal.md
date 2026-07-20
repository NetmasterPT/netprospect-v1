# Plano — Client Portal (Fase 6a, read-only, sem pagamentos)

> A fatia SEGURA e de arranque da Fase 6 ([[phase6-store-stripe-portal-plan]]): um portal **só-leitura**
> onde cada cliente vê a sua conta (subscrições, avenças, faturas) sem tocar em pagamentos nem em dados de
> cartão. Reutiliza o padrão token-gated de `/r/:token` e `/book/:token`. NÃO overwrite — plano próprio.

## Contexto / objetivo

67 empresas `is_client`. Hoje não têm forma de ver o seu estado (subscrições/faturas) — só o staff, no
dashboard atrás do Authentik. Um portal público **token-gated** dá-lhes isso, com zero risco (read-only) e
prepara o terreno para o checkout (6b) mais tarde. É também um sinal de profissionalismo para fechar/reter clientes.

## Dados — já existem todos (auditado)

| O quê | Fonte | Ligação ao cliente |
|---|---|---|
| Faturas/recibos/NC | `moloni_documents` (number, date, net, vat, total, status, document_type) | `moloni_documents.company` (m2o) |
| Avenças/recorrências | `moloni_avencas` (name, amount, period, next_date, active) | `moloni_avencas.company` (m2o) |
| Subscrições (oferta) | `subscriptions` (name, frequency, price_inc_vat, features, category) | `subscriptions.client_ids` (m2m) |
| Cliente | `companies` (name, nif, client_since, client_mrr, general_email) | a própria empresa |
| PDF da fatura | `GET /api/moloni/documents/:id/pdf` (já existe; staff) | precisa de wrapper token-scoped (ver segurança) |

## Design

### Schema (`bootstrap-directus.js`) — mínimo
- `companies.portal_token` (str, único) — gerado 1× por cliente; é a chave de acesso ao portal.
- `companies.portal_enabled` (bool, default false) — permite ligar/desligar o portal por cliente.

### Auth = token (padrão `/r/`,`/book/`)
- `GET /portal/:token` → resolve a empresa por `portal_token` (+ `portal_enabled` + `is_client`). Token longo
  aleatório (crypto). Sem password. **Excluir `/portal/*` e `/api/portal/*` do Authentik no NPMplus** (como `/r/*`,`/t/*`).
- **Geração do link:** ação no drawer/página do cliente (staff) — `POST /api/clients/:companyId` (já existe;
  acrescentar) OU um `POST /api/portal/:companyId/link` que gera/roda o token e devolve o URL para o staff copiar/enviar.

### Rotas
- `GET /portal/:token` — página HTML self-contained (estilo `bookHtml`): cabeçalho (nome + cliente desde),
  **subscrições ativas** (nome/preço/frequência/features), **avenças** (valor/período/próxima data), **faturas**
  (nº/data/total/estado + link PDF). Tema claro, responsivo, sem deps externas.
- `GET /api/portal/:token` — JSON com os dados acima (a página pode ser server-rendered e dispensar este, mas
  fica útil p/ refresh). Junta por `company = <id do token>`.
- `GET /api/portal/:token/document/:docId/pdf` — **wrapper token-scoped** do PDF: VALIDA que
  `moloni_documents.id=docId AND company=<id do token>` antes de servir (senão um cliente via o PDF de outro).
  Reusa a lógica do `/api/moloni/documents/:id/pdf` existente.

### Renderer
Reutilizar o padrão `bookHtml` (shell + inline CSS + `_bEsc`), sem JS pesado (é read-only; um `<a>` para cada PDF).

## Segurança (crítico — é público)
- Token = única credencial → **longo + aleatório** (`crypto.randomBytes(24).toString('hex')`), rotável.
- **Read-only** absoluto: nenhuma escrita, nenhum pagamento, nenhum dado de cartão.
- **Isolamento por cliente:** TODAS as queries filtram `company = <id resolvido do token>`. O PDF valida o
  `company` do documento (senão enumera faturas alheias). NUNCA expor o endpoint staff `/api/moloni/documents/:id/pdf`
  ao público — só o wrapper token-scoped.
- `portal_enabled=false` ou `is_client=false` → 404 (não vaza existência).
- Excluir `/portal/*` + `/api/portal/*` do Authentik (senão bate no login).

## Ficheiros
`bootstrap-directus.js` (portal_token, portal_enabled) · `dashboard/server.mjs` (rotas + renderer + geração do
token; reusar `d`/`dwrite`/o padrão `_bLookup`/`bookHtml` de `/book/`) · `docs/reference/http-api.md` +
`TODO-KEYS.md` (nota de exclusão Authentik) · (nav opcional: botão "Portal" no drawer do cliente em `index.html`).

## Verificação
1. `node bootstrap-directus.js` → os 2 campos existem.
2. Gerar token p/ 1 cliente real com faturas/avenças; abrir `/portal/:token` → vê subscrições/avenças/faturas.
3. **Segurança:** token errado → 404; PDF de uma fatura de OUTRO cliente via este token → 403; `/api/moloni/...`
   staff continua atrás do Authentik.
4. Confirmar responsivo (telemóvel) + sem chamadas externas.

## Fora de âmbito (fica para 6b/6c)
Checkout Stripe, webhooks, pagamentos, self-service de compra, geração de fatura — tudo isso é a fatia
sensível (precisa das decisões de negócio em [[phase6-store-stripe-portal-plan]]). Este plano é **só o portal read-only**.

## Decisão aberta (1)
**Como é que o cliente recebe o link?** (a) staff gera e envia à mão (mais simples — recomendado p/ começar);
(b) auto-email no onboarding; (c) no rodapé das faturas. Começar por (a) — o botão "gerar link do portal" no
drawer do cliente — e evoluir depois.
