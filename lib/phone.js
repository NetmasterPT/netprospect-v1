// lib/phone.js
// Extração de telefones INTERNACIONAL (PT/NO/SE/FI/NL/…) com libphonenumber-js.
// Substitui as regexes só-PT antigas. Estratégia:
//   1. links tel:  -> parse com o país por omissão do site (do TLD, senão ip_country)
//   2. candidatos de texto (sequências plausíveis de dígitos/espaços/(). +) -> parse
//   Fica com os que `isValid()`; devolve E.164 + país ISO2.

import { parsePhoneNumberFromString } from 'libphonenumber-js';

// TLD -> país por omissão (para números nacionais sem indicativo).
const TLD_COUNTRY = {
  pt: 'PT', no: 'NO', se: 'SE', fi: 'FI', nl: 'NL', es: 'ES', fr: 'FR',
  de: 'DE', it: 'IT', uk: 'GB', ie: 'IE', dk: 'DK', be: 'BE', at: 'AT', ch: 'CH', pl: 'PL',
};

export function tldToCountry(domainOrTld, ipCountry) {
  const tld = String(domainOrTld || '').split('.').pop().toLowerCase();
  return TLD_COUNTRY[tld] || (ipCountry ? String(ipCountry).toUpperCase().slice(0, 2) : null) || 'PT';
}

// Sequências candidatas a telefone no texto visível (limitadas para não explodir
// em blobs). Aceita +, dígitos, espaços, () . - entre 6 e 20 chars de "corpo".
const TEL_HREF_RE = /tel:([+0-9][0-9\s().\-/]{5,25})/gi;
const TEXT_CAND_RE = /(?:\+|00)?\d[\d\s().\-/]{6,20}\d/g;

function tryParse(raw, country) {
  if (!raw) return null;
  // normaliza 00 -> + (prefixo internacional europeu)
  let s = String(raw).trim().replace(/^00/, '+');
  const p = parsePhoneNumberFromString(s, s.startsWith('+') ? undefined : country);
  if (p && p.isValid()) return { e164: p.number, country: p.country || country || null, national: p.formatNational() };
  return null;
}

// Devolve o primeiro telefone válido do HTML (ou null). Usado como "geral".
export function extractPhone(html, { defaultCountry = 'PT' } = {}) {
  const list = extractPhones(html, { defaultCountry, limit: 1 });
  return list[0] || null;
}

// Devolve até `limit` telefones válidos únicos (E.164). tel: primeiro (mais fiável).
export function extractPhones(html, { defaultCountry = 'PT', limit = 5 } = {}) {
  const s = html || '';
  const out = [];
  const seen = new Set();
  const add = (parsed) => {
    if (!parsed || seen.has(parsed.e164)) return;
    seen.add(parsed.e164);
    out.push(parsed);
  };
  // 1) tel: hrefs
  TEL_HREF_RE.lastIndex = 0;
  let m;
  while ((m = TEL_HREF_RE.exec(s)) && out.length < limit) add(tryParse(m[1], defaultCountry));
  // 2) texto visível (só se ainda faltam) — mais ruidoso, valida sempre com isValid()
  if (out.length < limit) {
    const stripped = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
    TEXT_CAND_RE.lastIndex = 0;
    let c, guard = 0;
    while ((c = TEXT_CAND_RE.exec(stripped)) && out.length < limit && guard++ < 4000) {
      const digits = c[0].replace(/\D/g, '');
      if (digits.length < 8 || digits.length > 15) continue; // fora do intervalo E.164 plausível
      add(tryParse(c[0], defaultCountry));
    }
  }
  return out.slice(0, limit);
}
