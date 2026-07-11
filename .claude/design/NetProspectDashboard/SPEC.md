# NetProspect — design deliverable & component spec

Internal analytics + business-directory front-end for Netmaster's self-hosted B2B
prospecting platform. Desktop-first (@1440, responsive to tablet). Built on the
**Netmaster Design System** (signature red over a cool slate ramp, Montserrat),
extended with a data-dense semantic token layer supporting **light + dark** themes.

## Files

| File | What it is |
|---|---|
| `tokens/netprospect.css` | **The token sheet** — all design tokens as CSS custom properties (color roles light+dark, categorical, status, spacing, radii, type, shadows, z-index). Drop into your app; theme via `[data-theme="light|dark"]`. |
| `Tokens.dc.html` | Visual reference for every token in both themes. |
| `Components.dc.html` | Component gallery — every component in every state, with a live theme toggle. |
| `Shell.dc.html` | Shared app chrome (top bar + left nav + theme toggle). Imported by every screen. |
| `Overview.dc.html` | Screen 1 — Analytics: KPIs, qualification funnel, platform + hosting-ISP bars, geography, growth area, quick segments. |
| `Directory.dc.html` | Screen 2 — Business directory: filter bar, chips, sortable dense table, bulk actions, pagination, **detail drawer**. |
| `CompanyDetail.dc.html` | Screen 3 — Full-page company/site detail (the drawer's "expand" target). |
| `Contacts.dc.html` | Screen 4 — Contacts directory: people table, role + verification filters. |
| `Segments.dc.html` | Screen 5 — Saved segments (cards + shared-views table). |
| `Settings.dc.html` | Light settings sketch (profile, team, data sources, export, GDPR, appearance). |

## Theme

`data-theme` is set on `document.documentElement` and persisted to `localStorage`
(`np-theme`, default **dark**). The token sheet defines both `[data-theme="light"]`
and `[data-theme="dark"]`. Toggle lives in the top bar (and Settings › Aparência).

## Accessibility (WCAG AA)

- **Categorical (platform) colors** use the Okabe–Ito colorblind-safe ramp.
- **Status is never color-alone**: every status pairs an icon + text label
  (`Qualificado`, `Verificado`, `Catch-all`, `Role-based`, `Live`, `Offline`…).
- Text stays in the ink ramp (`--np-text*`); color carries identity only on marks
  and badge accents. Brand red gets a darker `--np-brand-ink` for AA on light.
- Tables are keyboard-navigable (row `tabindex`, ↑/↓ to move, Enter to open).
- Focus rings via `--np-focus`.

## Charts (per rules)

Bars, funnel, area, small-multiples only — **no pie, no dual-axis**. Recessive
axes/grid, thin marks, selective direct labels (only the final point of a series).
Every chart card has a **gráfico ↔ tabela** toggle and hover tooltips.

## Layout rules

- Filters reflected in the URL (`?q=&platform=&host=…`, `history.replaceState`).
- Wide tables/charts scroll inside their own container; the page body never
  scrolls horizontally.
- 1440 desktop → tablet via `auto-fit`/`minmax` grids.

---

## Component inventory

| Component | Variants / states | Used in |
|---|---|---|
| **Top bar** | brand, global search (⌘K), theme toggle, notifications, user | all screens |
| **Left nav** | item: default · hover · active (red inset bar); counts; saved-segment dots; data-freshness card | all screens |
| **Button** | primary (red +glow) · secondary · ghost · danger · disabled; sizes sm/md; optional icon | everywhere |
| **KPI / stat tile** | icon + label, tabular value, delta pill (up/down), sparkline; skeleton | Overview |
| **Status badge** | qualified · verified · catch-all · role-based · unverified · live · offline — each icon+label | Directory, Contacts, Detail, gallery |
| **Outreach badge** | novo · a contactar · contactado · respondeu | Directory, Detail |
| **Platform chip** | 9 platforms, categorical dot + label | Directory, Overview, Contacts |
| **Chart card** | bar · funnel · area · geo; legend, hover tooltip, chart/table toggle | Overview |
| **Data table** | sticky header, sort indicator (↕/▲/▼), row hover, selected (brand tint), checkbox, column config, pagination | Directory, Contacts |
| **Filter bar** | debounced search (+ spinner), facet buttons w/ active count, facet dropdown | Directory, Contacts |
| **Filter chip** | removable (×), "limpar tudo" | Directory, Contacts |
| **Bulk action bar** | appears on selection: count, export CSV, add to segment, clear | Directory, Contacts |
| **Detail drawer** | header (domain, company, qualified, platform), hosting grid, tech chips, subdomains, contacts (verif + mailto/tel), general contact, outreach workflow + note, GDPR footer; expand-to-page | Directory |
| **Form controls** | input (default·focus·error), select, textarea, checkbox, toggle, segmented control | Detail, Settings, filters |
| **Feedback** | skeleton (shimmer), empty state, error card, toast (success·info·danger) | all screens (system states) |
| **Segment card** | accent bar, count, sparkline, filter chips, shared tag, actions | Segments, Overview |
| **Misc** | pagination, avatar (monogram), icon tile | tables, chrome, tiles |

## Making it production self-contained

The mockups load Montserrat from Google Fonts and link `tokens/netprospect.css`
for readability. For the Node/Express + vanilla-JS target:

1. Inline `tokens/netprospect.css` (or ship as one static file).
2. Embed Montserrat (400/500/600/700/800/900) as `@font-face` data URIs.
3. The design-system bundle is **not used** by these screens (components are
   native to the token layer) and can be dropped.
4. Populate tables/charts at runtime from the paginated JSON API; the sample data
   in each file shows the exact shape each component expects.
