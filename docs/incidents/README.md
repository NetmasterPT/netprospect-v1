---
title: "Relatórios de incidentes"
type: reference
tags: [incidents, template]
related: []
owner: infra
status: living
updated: 2026-07-16
visibility: internal
---

# Relatórios de incidentes

Um ficheiro por incidente, criado/expandido pelo monitor de saúde (loop de 15 min). Nome:
`YYYYMMDD-<slug>.md`. Indexados em [`../../DEBUG-FOUND.md`](../../DEBUG-FOUND.md).

## Estrutura de um relatório

```
# <título curto do incidente>

- **Estado:** OPEN | CLOSED
- **Primeiro visto:** <ISO>
- **Último visto:** <ISO>
- **Job/host afetado:** <ex.: nuclei @ de1>
- **Relacionado com DEBUGGING-TODO:** <item, se aplicável>

## Sintoma
<o que se observa>

## Evidência
<linhas de log, contagens de fila, telemetria — datadas>

## Origem provável (contexto de código, NÃO corrigido)
<ficheiro:linha onde o erro surge; 1 linha de hipótese>

## Observações (cronológico — o monitor acrescenta a cada recorrência)
- <ISO> — <o que se viu nesta ronda>
```
