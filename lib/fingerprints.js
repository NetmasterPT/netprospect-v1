// Deteção por fingerprint (HTML + cabeçalhos + cookies) das plataformas-alvo,
// deteção de CDN, idioma e extração de contactos gerais.
//
// Estas regras determinam a decisão FIÁVEL de `qualified` (o simple-wappalyzer
// acrescenta deteção mais ampla, mas a qualificação é feita aqui).

import { extractPhones } from './phone.js';
import { isJunkEmail } from './email-junk.js';
import { getDomain } from 'tldts';

// Plataformas que qualificam um site como alvo de prospeção.
export const TARGET_SLUGS = ['wordpress', 'woocommerce', 'prestashop', 'wix'];

// Prioridade para escolher a "plataforma principal" (e-commerce > CMS).
const PRIMARY_ORDER = [
  'woocommerce',
  'prestashop',
  'shopify',
  'wix',
  'squarespace',
  'joomla',
  'drupal',
  'wordpress',
];

// Deteta plataformas a partir do html e de uma string agregada de cabeçalhos+cookies.
export function detectPlatforms(html, headerBlob) {
  const s = (html || '').toLowerCase();
  const h = (headerBlob || '').toLowerCase();
  const matched = new Set();

  if (/wp-content|wp-includes|wp-json|api\.w\.org/.test(s) || /x-pingback/.test(h) || /content=["']wordpress/.test(s))
    matched.add('wordpress');
  if (/woocommerce/.test(s) || /woocommerce_|wp_woocommerce/.test(h)) matched.add('woocommerce');
  if (/prestashop/.test(s) || /prestashop-/.test(h)) matched.add('prestashop');
  if (/x-wix|wixstatic|_wixcidx|wix\.com/.test(s) || /x-wix/.test(h)) matched.add('wix');
  if (/cdn\.shopify\.com|myshopify\.com/.test(s) || /x-shopify|x-shopid/.test(h)) matched.add('shopify');
  if (/static1\.squarespace|squarespace\.com/.test(s)) matched.add('squarespace');
  if (/\/media\/jui\/|com_content|joomla/.test(s) || /joomla/.test(h)) matched.add('joomla');
  if (/\/sites\/default\/files|drupal-settings-json|content=["']drupal/.test(s) || /x-drupal|x-generator: *drupal/.test(h))
    matched.add('drupal');

  const matchedArr = [...matched];
  const qualified = matchedArr.some((m) => TARGET_SLUGS.includes(m));
  const primarySlug = PRIMARY_ORDER.find((p) => matched.has(p)) || null;
  return { qualified, primarySlug, matched: matchedArr };
}

// Deteta CDN/edge à frente do servidor de origem (o IP/PTR passa a ser o edge).
export function detectCDN(headers) {
  const server = (headers['server'] || '').toLowerCase();
  const has = (k) => k in headers;
  if (has('cf-ray') || server.includes('cloudflare')) return 'cloudflare';
  if (server.includes('fastly') || has('x-served-by') || has('fastly-debug-digest')) return 'fastly';
  if (has('x-sucuri-id') || has('x-sucuri-cache')) return 'sucuri';
  if (has('x-iinfo')) return 'incapsula';
  if (server.includes('akamai') || has('x-akamai-transformed')) return 'akamai';
  return null;
}

// Idioma declarado no <html lang="...">.
export function extractLang(html) {
  const m = (html || '').match(/<html[^>]*\blang=["']([a-zA-Z-]{2,10})["']/i);
  return m ? m[1] : null;
}

// Quantificadores LIMITADOS (RFC: local<=64, domínio<=255, TLD<=24). Sem os
// limites, um "x@" seguido de uma longa cadeia pontuada (ex.: "a.a.a…" num blob
// grande) faz backtracking catastrófico e bloqueia o event loop durante horas.
const EMAIL_RE = /[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,255}\.[a-z]{2,24}/gi;
const EMAIL_VALID = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}$/i; // full-match (rejeita over-long/lixo)

// Extrai um email e um telefone "gerais" da organização a partir do HTML.
// `defaultCountry` (ISO2) resolve números nacionais sem indicativo — passar o país
// do site (ver lib/phone.js tldToCountry). Devolve telefone em E.164 + país.
export function extractContacts(html, { defaultCountry = 'PT', siteDomain = null } = {}) {
  const s = html || '';

  // Emails: primeiro os de mailto:, depois regex genérica; descarta lixo.
  // O mailto: captura SÓ o email válido — os page-builders metem o href dentro de
  // JSON com &quot; codificado, e um [^"'] corria centenas de chars de lixo.
  const candidates = [];
  for (const m of s.matchAll(/mailto:\s*([a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24})/gi)) candidates.push(m[1]);
  for (const m of s.matchAll(EMAIL_RE)) candidates.push(m[0]);
  const valid = [];
  for (const c of candidates) { const e = c.trim().toLowerCase(); if (EMAIL_VALID.test(e) && !isJunkEmail(e) && !valid.includes(e)) valid.push(e); }
  // PREFERIR o email do PRÓPRIO domínio — senão apanhava o do web-developer/agência/parceiro no rodapé
  // (audit 2026-07-19: unik-seo.com, maastrichtuniversity.nl…). Só cai para off-domain se não houver próprio.
  const org = siteDomain ? getDomain(siteDomain) : null;
  const email = (org && valid.find((e) => getDomain(e.split('@')[1] || '') === org)) || valid[0] || null;

  // Telefones gerais (internacional, E.164) — TODOS os únicos (fixos+móveis), no país
  // do site. `phone`/`phone_country` = 1.º (retrocompat); `phones` = lista completa.
  const list = extractPhones(s, { defaultCountry, limit: 6 });
  return { email, phone: list[0]?.e164 || null, phone_country: list[0]?.country || null, phones: list.map((p) => p.e164) };
}

// Deteta a atribuição do web-developer no rodapé ("Desenvolvido por X", "Website by X", "Powered by X",
// "Ontwikkeld door X", "Utvecklad av X"…) → inteligência competitiva: quem faz os sites (da concorrência),
// ângulo de venda e diferenciação. Devolve {domain, name} do estúdio/agência/plataforma, ou null. Best-effort
// (só quando há a FRASE de crédito + um link off-site — evita apanhar links aleatórios do rodapé).
const DEV_CREDIT_RE = /(?:desenvolvid[oa]s?|criad[oa]s?|realizad[oa]|produzid[oa]|powered|website|webdesign|web[\s-]*design(?:ed)?|design(?:ed)?|developed|built|ontwikkeld|gemaakt|utvecklad|skapad|utviklet|laget|toteutus|erstellt|entwickelt|umgesetzt|site)\s*(?:por|by|av|door|von|da)\b[:\s]*/i;
const DEV_SKIP = /facebook|instagram|linkedin|twitter|\bx\.com|youtube|tiktok|whats|pinterest|google|gstatic|googleapis|googletagmanager|doubleclick|analytics|w3\.org|schema\.org|wordpress\.org|automattic|wp\.com|maps\.|cdn|jsdelivr|unpkg|jquery|bootstrap|cloudflare|fonts\.|ajax\.|polyfill|gravatar|sentry|hotjar/i;
export function detectWebDeveloper(html, siteDomain = null) {
  const s = html || '';
  const org = siteDomain ? getDomain(String(siteDomain)) : null;
  const re = new RegExp(DEV_CREDIT_RE.source + '([\\s\\S]{0,180})', 'gi');
  for (const m of s.matchAll(re)) {
    const seg = m[1] || '';
    const href = seg.match(/href=["']?\s*(https?:\/\/[^"'\s>]+)/i);
    if (!href) continue;
    const host = href[1].replace(/^https?:\/\//i, '').split(/[/?#]/)[0].toLowerCase();
    const dom = getDomain(host) || host;
    if (!dom || dom === org || DEV_SKIP.test(host)) continue;
    const txt = seg.match(/>\s*([^<>{}\n]{2,60}?)\s*</);
    return { domain: dom.slice(0, 120), name: (txt ? txt[1].replace(/\s+/g, ' ').trim() : dom).slice(0, 140) };
  }
  return null;
}
