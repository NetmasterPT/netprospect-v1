---
title: Design-system (componentes np-*)
type: reference
module: dashboard/docs
tags: [docs, design-system, ui, storybook]
visibility: internal
status: living
updated: 2026-07-20
---

# Design-system

Os componentes do site de docs replicam **pixel-a-pixel** o dashboard base (`dashboard/public/index.html`),
reimplementados como componentes React em `docs-site/src/ui/` e documentados no **Storybook** (secção *UI* em
`/docs/storybook/`). Fonte de verdade visual: os tokens `np-*` em `docs-site/src/theme.css` (derivados de
`dashboard/public/netprospect.css`).

## Tokens (`theme.css`)

Temas claro (`:root`) / escuro (`[data-theme="dark"]`); fonte Montserrat; marca `#EA0B2A`. Famílias: superfícies
(`--np-bg/surface/surface-2/3`), chrome (nav/topbar), texto (`--np-text/2/3/faint`), estados (ok/warn/info/
danger/neutral com `-soft`/`-soft-bd`), raios, sombras, z-index, durações/ease.

## Componentes (`src/ui/`)

| Ficheiro | Componentes |
|---|---|
| `primitives.jsx` | Button, Segmented, Badge, Chip, IconButton, Input |
| `typography.jsx` | PageHeader, SectionTitle, Eyebrow, Text, Muted |
| `Card.jsx` | Card (info card), StatCard + StatGrid (KPI) |
| `nav.jsx` | MenuItem, CollapsibleMenu |
| `overlays.jsx` | Scrim, Drawer, NotificationsDrawer, ProfileMenu |
| `shell.jsx` | Brandmark, SearchBox, Topbar, ThemeToggleButton |
| `data.jsx` | Facet (dropdown de filtro), Table |
| `Callout.jsx` | note/tip/warning/danger/info |
| `icons.jsx` | `Icon` — réplica do `ic()`/ICONS do dashboard (SVG 24×24, stroke) |

## Regras

- **Ícones:** usar sempre o conjunto de `icons.jsx` (mesmos paths/nomes do dashboard) — não emoji.
- **Fidelidade:** ao alterar um componente, comparar contra o dashboard original (screenshots) — foi assim que
  se apanharam diferenças de topbar/notificações/statistics-cards.
- **Stories:** cada componente tem uma story em `UI/*`; `npm run storybook:build` gera `/docs/storybook/`.

Ver [[README|visão geral da plataforma]] e [[kb-architecture]].
