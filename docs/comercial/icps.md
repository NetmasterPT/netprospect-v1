# Públicos-alvo (ICPs)

Ideal Customer Profiles — descrições dos públicos-alvo da Netmaster, reutilizáveis por subscrições,
templates e campanhas. Página **`#/icps`** (menu Comercial).

## Colecção `icps`

| Campo | Tipo | Notas |
|---|---|---|
| `name` | string | nome do ICP (obrigatório) |
| `description` | text | descrição escrita do público-alvo |
| `tags` | json | array de strings |
| `category` | string | categoria livre |
| `language` | string | língua (ex.: `pt`) |
| `template_ids` | json | ids de [templates](templates.md) |
| `client_ids` | json | ids de empresas-cliente ([empresas](empresas.md)) |
| `campaign_ids` | json | ids de [campanhas](campanhas.md) |
| `segment_ids` | json | ids de [segmentos](segmentos.md) |
| `active`, `notes`, `sort`, `date_created` | — | estado + metadados |

## Página

- Lista de cards (nome, categoria/língua, excerto da descrição, tags, contagens de relações) +
  **"+ Novo ICP"**.
- Editor: nome/categoria/língua, descrição, tags (vírgula), e **Ligações** por multi-seleção a
  templates, segmentos, clientes e campanhas.

## API

- `GET /api/icps` → `{ items, refs: { segments, campaigns, clients, templates } }`.
- `POST /api/icps` · `PUT /api/icps/:id` · `DELETE /api/icps/:id`.
- Implementado pelo helper genérico `idArrayCrud` em `dashboard/server.mjs` (partilhado com os
  templates).

## Uso nas subscrições

Na [subscrição](subscricoes.md) os ICPs entram por multi-seleção (`icp_ids`) — os inputs "bebem" desta
colecção (`refs.icps`), tal como Segmentos, Clientes e Campanhas.
