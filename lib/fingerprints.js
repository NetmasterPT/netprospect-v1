// Deteção por fingerprint (HTML + cabeçalhos + cookies) das plataformas-alvo,
// deteção de CDN, idioma e extração de contactos gerais.
//
// Estas regras determinam a decisão FIÁVEL de `qualified` (o simple-wappalyzer
// acrescenta deteção mais ampla, mas a qualificação é feita aqui).

import { extractPhones } from './phone.js';
import { isJunkEmail } from './email-junk.js';

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
export function extractContacts(html, { defaultCountry = 'PT' } = {}) {
  const s = html || '';
  let email = null;

  // Emails: primeiro os de mailto:, depois regex genérica; descarta lixo.
  // O mailto: captura SÓ o email válido — os page-builders metem o href dentro de
  // JSON com &quot; codificado, e um [^"'] corria centenas de chars de lixo.
  const candidates = [];
  for (const m of s.matchAll(/mailto:\s*([a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24})/gi)) candidates.push(m[1]);
  for (const m of s.matchAll(EMAIL_RE)) candidates.push(m[0]);
  for (const c of candidates) {
    const e = c.trim().toLowerCase();
    if (EMAIL_VALID.test(e) && !isJunkEmail(e)) {
      email = e;
      break;
    }
  }

  // Telefones gerais (internacional, E.164) — TODOS os únicos (fixos+móveis), no país
  // do site. `phone`/`phone_country` = 1.º (retrocompat); `phones` = lista completa.
  const list = extractPhones(s, { defaultCountry, limit: 6 });
  return { email, phone: list[0]?.e164 || null, phone_country: list[0]?.country || null, phones: list.map((p) => p.e164) };
}
