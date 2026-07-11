# NetMaster Design System

> **NetMaster** (`netmaster.pt`) is a Portuguese digital agency offering web
> **hosting / alojamento**, **web & software development**, and **digital
> marketing** services. The brand voice is confident and technical but
> approachable; the visual identity is bold, high-contrast and energetic —
> a signature **red** over cool slate neutrals, big uppercase Montserrat
> headlines, and a playful rainbow "infinity loop" logo.

Tagline: **"power to do more."**
Primary language: **Portuguese (pt-PT)**. Contact: `geral@netmaster.pt` · `+351 91 706 10 69`

---

## Sources

- **Figma:** `Netmaster.fig` (attached as a virtual filesystem). 32 marketing
  page/section frames: Navigation, Heros, Pricing (Planos de Preço), Feature
  Icons/Cards, FAQs, Testimonials (Testemunhos), Portfolio, Blog, Case Study,
  Timeline, Methodology (Metodologia), About (Quem Somos), Contact, Footer.
  All values are raw (no Figma Variables/text-styles were defined), so the
  token system in `tokens/` was authored by hand from observed values.
- No codebase or live site was provided. UI kit recreations are built from the
  Figma frames.

---

## What this is

This is a **marketing-website** design system. There is no app/dashboard
product — the surfaces are landing-page sections for an agency site. The UI kit
recreates the public website (nav, hero, services, pricing, portfolio, footer).

---

## CONTENT FUNDAMENTALS

How NetMaster writes copy.

- **Language:** European Portuguese. Keep diacritics correct (Portfólio, Preço,
  Questões, Proteção). UI labels and nav are uppercase Portuguese
  (`MARKETING DIGITAL`, `ALOJAMENTO`, `DESENVOLVIMENTO`, `PORTFÓLIO`, `LOJA`,
  `CONTACTOS`). Some service nouns stay in English (Cloud Infrastructure,
  Network Security, Managed IT Services) — the brand mixes PT + EN tech terms.
- **Voice:** Direct, benefit-led, second person formal/neutral ("Escolha o
  plano ideal", "Peça a sua proposta", "Subscreva a nossa Newsletter"). It
  addresses the customer ("a sua", "o seu negócio") rather than talking about
  itself. Confident, not salesy-hype.
- **Headlines:** Short, punchy, UPPERCASE for hero/section display
  (`SOCIAL MEDIA MARKETING`, `DIZEM SOBRE NÓS`). Often paired with a small
  red **eyebrow** label above (`AINDA TEM QUESTÕES?`, `O QUE`).
- **Subheads / body:** Sentence case, calm slate-grey, one or two lines.
  Explains the benefit plainly ("Seu servidor fica online em menos de 60
  segundos após a confirmação do pagamento.").
- **CTAs:** Imperative verbs — `PEÇA A SUA PROPOSTA`, `Começar Agora`,
  `Selecionar Plano`, `Subscrever`. Primary CTAs are uppercase + bold when on
  chrome (top bar), title-case on cards.
- **Badges / flags:** Tiny uppercase, wide-tracked — `MAIS POPULAR`.
- **Numbers / pricing:** Big red price + light grey unit ("3.99€ **/mês**").
  Euro currency, comma-or-dot decimals as written.
- **Emoji:** **Not used.** Iconography is line/solid vector icons, never emoji.
- **Vibe:** Trustworthy IT partner — "we keep you online, we help you grow."

---

## VISUAL FOUNDATIONS

- **Color:** A single dominant **brand red `#EA0B2A`** does the heavy lifting —
  CTAs, prices, eyebrows, icons, accents, focus. Everything else is a cool
  **slate** neutral ramp (`#0F172A` ink → `#64748B` body → `#E2E8F0` borders →
  `#F8FAFC` surfaces). Page background is a barely-warm paper `#F8F5F6`. Chrome
  (top bar, footer) and the testimonial section go **near-black** (`#323232` /
  `#121212`). Two warm accents from the logo appear sparingly: **amber `#F2B234`**
  (newsletter band, tagline) and **green `#22C55E`** (success / logo). Use red
  with restraint on dark surfaces; let it pop.
- **Type:** **Montserrat** throughout. Display = **Black (900) / ExtraBold (800)
  UPPERCASE**, slightly negative tracking, very tight line-height (~1.05).
  Headings = Bold (700) title-case. Body/UI = Regular/Medium. Poppins is an
  occasional body alternate. Eyebrows are small, Bold, UPPERCASE, wide-tracked,
  red.
- **Backgrounds:** Mostly flat solid colors (white cards on paper). Heros use a
  **full-bleed photo** under a **dark teal/navy tint overlay** with faint
  floating circular icon "bubbles". No mesh gradients, no noise. The newsletter
  uses a solid amber band. Avoid bluish-purple gradients entirely.
- **Cards:** White, **radius 12–16px**, hairline `#E5E7EB` border, very soft
  shadow (`0 1px 2px rgba(0,0,0,0.05)`). A *featured* card swaps the border for
  **brand red** and floats a red `MAIS POPULAR` pill over its top edge. Sunken
  cards use `#F8FAFC`/`#F1F5F9` fills with no shadow.
- **Icon tiles:** Rounded square (radius ~16px), **light-red `#FDE2E4` fill**,
  **red line icon** centered.
- **Buttons:** Primary = solid red, white bold label, **radius 2–8px** (sharp on
  chrome, softer on cards), optional red glow shadow. Secondary = light slate
  fill, dark label. Hover darkens red (`#E41937`); press darkens further +
  subtle shrink. Top-bar CTA is `radius 2px`, uppercase, wide-tracked.
- **Borders & dividers:** 1px hairlines; `#E5E7EB` on light, `rgba(255,255,255,0.1–0.2)`
  on dark chrome. Vertical rule separates top-bar contact items.
- **Shadows:** Two tiers only — hairline card drop and a soft hover lift. The
  **red glow** (`rgba(234,11,42,0.2–0.4)`) is reserved for the primary CTA.
- **Radii:** chrome `2px`, inputs `6px`, buttons `8px`, cards `12px`, big cards &
  tiles `16px`, badges/pills/dots **full**.
- **Layout:** 1280px container, **80px** side gutters, generous ~96px vertical
  section padding. Center-aligned section headers (eyebrow + big head + sub) are
  common; content rows are 2–3 column grids with `gap`.
- **Imagery:** Real photography, slightly cool/saturated, often under a dark
  tint for text legibility. Portfolio uses bright product/web mockup shots.
- **Motion:** Subtle. Fades and short ease-out transitions (`cubic-bezier(.16,1,.3,1)`,
  ~200ms). Hover = color shift + tiny lift; press = slight scale-down. Carousels
  for testimonials (dot indicators). No bounces, no infinite decorative loops.
- **Transparency / blur:** Minimal — dark photo tints and 10–20% white borders on
  chrome. No glassmorphism.

---

## ICONOGRAPHY

- The Figma art rasterized most icons, but they are a consistent **line/outline
  style in brand red** (rocket, shield-lock, check-circle, chevrons, phone,
  envelope, paper-plane, social glyphs). One `Material Symbols Outlined` glyph
  was detected.
- **This system standardizes on [Lucide](https://lucide.dev) (CDN)** — clean
  2px-stroke open icons that match NetMaster's look. **⚠️ Substitution:** the
  original raster icons could not be extracted as vectors, so Lucide is the
  closest faithful match. If you have the brand's own icon source, drop it into
  `assets/icons/` and update this section.
- **Usage:** icons sit inside red icon-tiles (`#FDE2E4` bg) for features; inline
  red icons for list checks (`check-circle`) and contact rows; white icons on
  dark chrome (social row). Stroke ~2px, size 16–24px inline, 28–32px in tiles.
- Social glyphs (Facebook, Instagram, X/Twitter, LinkedIn, WhatsApp) appear in
  the top bar (red) and footer (white). Use Lucide brand-ish icons or Simple
  Icons for exact social marks.
- **Emoji:** never. **Unicode dingbats:** never. Icons are always vector.

---

## Foundations & assets

- `tokens/` — `fonts.css`, `colors.css`, `typography.css`, `spacing.css`
  (radius/shadow/layout/motion). All reached from root `styles.css`.
- `assets/` — `logo-netmaster.png` (color on light), `logo-netmaster-white.png`
  (color loop + white wordmark, for dark), hero + portfolio photography.

## Index / manifest

- `styles.css` — global entry (import this). Reaches all of `tokens/`.
- `tokens/` — `fonts.css`, `colors.css`, `typography.css`, `spacing.css`.
- `guidelines/` — foundation specimen cards (Design System tab):
  color (brand / neutrals / accents), type (display / body / labels),
  spacing (scale / radius / shadows), brand (logo).
- `components/` — reusable React primitives. Load `_ds_bundle.js`, read from
  `window.NetmasterDesignSystem_afcc6f`:
  - `core/` — **Button**, **Badge**, **Card**, **Input**, **IconTile**
  - `marketing/` — **SectionHeader**, **FeatureCard**, **PricingCard**,
    **FAQItem**, **TestimonialCard**
  - Each has a `.d.ts` (props), a `.prompt.md` (usage), and one `@dsCard` HTML.
- `ui_kits/website/` — full interactive NetMaster marketing-site recreation
  (`index.html`, `chrome.jsx`, `sections.jsx`, `Site.jsx`, `README.md`).
- `assets/` — `logo-netmaster.png` (light), `logo-netmaster-white.png` (dark),
  `hero-marketing.png`, `portfolio-1..3.png`.
- `SKILL.md` — portable skill manifest for Claude Code.

### Starting points
- **Button** (Core) · **SectionHeader** (Marketing) · **Marketing Site** screen
  (Website).

### Notes & substitutions
- **Icons:** Lucide (CDN) stands in for the brand's raster icons.
- **Fonts:** Montserrat + Poppins loaded from Google Fonts (no local binaries).
- **No slide template** existed in the source, so no sample deck was authored.
