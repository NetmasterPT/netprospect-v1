# Contactos

Pessoas e endereços de email associados às empresas/sites. Página **`#/contacts`** (paginada no
servidor). Alimentam campanhas, templates e a verificação de email.

## Colecção `contacts`

| Campo | Notas |
|---|---|
| `name`, `role`, `role_category` | nome + cargo + categoria (`decision_maker`/`manager`/`dpo`/`staff`/`general`/`unknown`) |
| `email`, `phone`, `phone_country` | contactos |
| `email_status` | `null`(por verificar) · `valid`/`invalid`/`catch_all`/`role`/`unknown`/`no_mx`/`disposable` |
| `email_verified`, `verified_at`, `email_source` | resultado da verificação |
| `source`, `source_detail`, `social_profiles` | proveniência |
| `gdpr_basis`, `do_not_contact` | base legal RGPD + exclusão de contacto |
| `responded`, `responded_at`, `esp_engaged` | sinais de engagement |
| `reviewed`, `reviewed_at` | revisto manualmente (protege de re-classificação automática) |
| `company` (m2o), `site` (m2o) | ligação à empresa e ao site |

## Página

- Lista paginada (`?page=&limit=`) com **pesquisa** (`q` sobre nome/email/empresa) e filtros por
  **cargo** (`roles=`) e **categoria** (`rolecat=`), verificação (`verif=`), tem-decisor (`dm=`), etc.
- Ordenação server-side (`?sort=&dir=` whitelisted: name/role/email/phone/company/source).
- **Edição/reclassificação manual** (drawer do site ou card): editar nome/cargo/`role_category`,
  marcar "não contactar" — qualquer edição marca `reviewed=true`. `PATCH /api/contacts/:id`.

## Verificação de email

Job `verify` (role `verify`, VMs com IP próprio): pré-filtra (no_mx/role/disposable, sem quota) e
valida os restantes via APIs free (`config/verify-providers.json`, ~100/dia) — ver a cobertura em
[[fleet-runbooks]] e o fix da métrica em `LOAD-DISTRIBUTION.md §5b`. Contactos com `email_status=null`
são os que faltam verificar.

## API (relevante para outreach)

- `GET /api/contacts?page=&limit=&q=&roles=&rolecat=&verif=&dm=&sort=&dir=` — lista paginada.
- `PATCH /api/contacts/:id` — edição/reclassificação manual.
- `GET /api/contacts-search?q=&limit=` — pesquisa leve (id/name/email/company/site) para o popup dos
  [templates](templates.md).
- `GET /api/contacts-by-ids?ids=` — resolve ids → detalhes (mostrar os contactos de um template).

## Ligações

- **Templates**: `contact_ids` — adicionados via popup ou a partir de uma empresa.
- **Campanhas**: cada `email` liga a um `contact`. A audiência sai dos filtros do segmento
  (`contactAudienceParts`), sobre contactos **com email** e **sem** `do_not_contact`.
