# Templates de email

Assunto + corpo com `{{variáveis}}` do dataset dos contactos, reutilizáveis por subscrições, ICPs e
campanhas. Página **`#/templates`** (menu Comercial).

## Colecção `email_templates`

| Campo | Tipo | Notas |
|---|---|---|
| `name` | string | nome do template (obrigatório) |
| `subject` | string | assunto (com `{{variáveis}}`) |
| `body` | text | corpo (com `{{variáveis}}`) |
| `variables` | json | variáveis usadas — **auto-detetadas** do assunto+corpo ao guardar |
| `tags` | json | array de strings |
| `category` | string | categoria livre |
| `business_type` | string | tipo de negócio |
| `language` | string | língua (ex.: `pt`) |
| `icp_ids` | json | ids de [ICPs](icps.md) |
| `segment_ids` | json | ids de [segmentos](segmentos.md) |
| `client_ids` | json | ids de empresas-cliente |
| `campaign_ids` | json | ids de [campanhas](campanhas.md) |
| `contact_ids` | json | ids de [contactos](contactos.md) adicionados manualmente |
| `active`, `notes`, `sort`, `date_created` | — | estado + metadados |

## Variáveis

Paleta de variáveis do dataset **contacto + site + empresa** — clica para inserir no cursor do último
campo focado (assunto ou corpo): `{{greeting}}`, `{{name}}`, `{{first_name}}`, `{{company}}`,
`{{domain}}`, `{{city}}`, `{{industry}}`, `{{platform}}`, `{{platform_word}}`, `{{seo_score}}`,
`{{ssl_days_left}}`, `{{cms_version}}`, `{{dns_provider}}`. São as **mesmas** que a geração por IA das
campanhas usa (ver `buildVariables`/`renderTemplate` em `lib/campaign-ai.js`; o dashboard espelha-as em
`subVars`/`subRender` porque a imagem do dashboard não inclui `lib/`). Ao guardar, o campo `variables`
é preenchido automaticamente com as que aparecem no assunto+corpo (para filtrar/consultar).

## Directório + filtros

A página é um directório de cards com **filtros por relação**: ICP, Segmento, Categoria, Tipo de
negócio, Língua e Tag (filtragem client-side sobre a lista carregada).

## Contactos manuais

- **Popup de pesquisa** (botão "+ Adicionar contactos" no editor): pesquisa contactos por nome/email/
  empresa (`/api/contacts-search`), seleção múltipla, adiciona a `contact_ids`.
- **A partir de uma empresa**: no drawer do site (secção Contactos → **"+ a template"**) adicionam-se
  os contactos com email dessa empresa a um template à escolha — ver [empresas.md](empresas.md).

## API

- `GET /api/email-templates` → `{ items, refs: { segments, campaigns, clients, icps } }`.
- `POST /api/email-templates` · `PUT /api/email-templates/:id` · `DELETE /api/email-templates/:id`
  (helper genérico `idArrayCrud`).
- `POST /api/email-templates/:id/contacts` — `{ add:[ids], remove:[ids] }` (usado pelo popup e pela
  vista de empresa).
- `GET /api/contacts-search?q=&limit=` · `GET /api/contacts-by-ids?ids=` · `GET /api/email-templates-list`.

## Uso a jusante

- Nas [subscrições](subscricoes.md) por multi-seleção (`template_ids`).
- No "Criar campanha" de uma subscrição: escolhido um template, os e-mails da campanha são preenchidos
  com o assunto/corpo do template e as `{{variáveis}}` substituídas por contacto — ver [campanhas.md](campanhas.md).
