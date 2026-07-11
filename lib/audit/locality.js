// lib/audit/locality.js
// Extrai a localidade do NEGÓCIO (cidade/região/morada) do HTML — distinta do
// `ip_city` (cidade do ALOJAMENTO). Ordem: JSON-LD PostalAddress → <address> →
// código postal PT (\d{4}-\d{3} cidade) no HTML. Best-effort; cobertura parcial.
// Quando existir GMB (Fase 2) essa é a fonte de verdade e sobrepõe-se a isto.

import { parseJsonLd } from './jsonld.js';

const clip = (v, n) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, n) : null) || null;
const stripTags = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();

function titleCity(s) {
  const c = clip(s, 120);
  if (!c) return null;
  // corta em separadores comuns que às vezes entram no match
  return c.split(/[,;|\n]/)[0].trim().slice(0, 120) || null;
}

function fromPostalAddress(addr) {
  if (!addr || typeof addr !== 'object') return null;
  const city = clip(addr.addressLocality, 120);
  const region = clip(addr.addressRegion, 120);
  const street = clip(addr.streetAddress, 200);
  const pc = clip(addr.postalCode, 20);
  if (!city && !street && !pc) return null;
  const address = [street, [pc, city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null;
  return { city, region, address: address ? address.slice(0, 255) : null, postalCode: pc };
}

export function extractBusinessLocation(html) {
  const res = { city: null, region: null, address: null, postalCode: null };
  if (!html) return res;

  // 1) JSON-LD PostalAddress (o mais fiável)
  for (const node of parseJsonLd(html)) {
    const addr = node['@type'] === 'PostalAddress' ? node
      : (node.address && typeof node.address === 'object' && !Array.isArray(node.address) ? node.address : null);
    const got = fromPostalAddress(addr);
    if (got && (got.city || got.address)) {
      res.city = res.city || got.city;
      res.region = res.region || got.region;
      res.address = res.address || got.address;
      res.postalCode = res.postalCode || got.postalCode;
      if (res.city) return res;
    }
  }

  // 2) <address> HTML
  const am = html.match(/<address[^>]*>([\s\S]{1,400}?)<\/address>/i);
  if (am) {
    const text = stripTags(am[1]);
    if (text) res.address = res.address || text.slice(0, 255);
    const pc = text.match(/\b(\d{4}-\d{3})\s+([A-ZÀ-Ú][\wÀ-ú .'-]{1,40})/);
    if (pc) { res.postalCode = res.postalCode || pc[1]; res.city = res.city || titleCity(pc[2]); }
  }

  // 3) Código postal PT em qualquer parte do HTML (fallback)
  if (!res.city) {
    const pc = html.match(/\b(\d{4}-\d{3})\s+([A-ZÀ-Ú][\wÀ-ú .'-]{1,40})/);
    if (pc) { res.postalCode = res.postalCode || pc[1]; res.city = titleCity(pc[2]); }
  }

  return res;
}
