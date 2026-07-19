// lib/audit/locality.js
// Extrai a localidade do NEGÓCIO (cidade/região/morada) do HTML — distinta do
// `ip_city` (cidade do ALOJAMENTO). Ordem: JSON-LD PostalAddress → <address> →
// código postal PT (\d{4}-\d{3} cidade) por linha, que também preenche a morada.
// Best-effort; cobertura parcial. Quando existir GMB essa é a fonte de verdade.

import { parseJsonLd } from './jsonld.js';

const clip = (v, n) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, n) : null) || null;
// Comentários HTML (<!-- … -->) têm de ser removidos como UNIDADE: o `<[^>]+>` sozinho
// pára no 1.º '>' interno e deixa um '-->' a vazar para a morada (bug do galeriado).
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, ' ');
const stripTags = (s) => stripComments(s).replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();

// HTML → linhas (comentários fora; tags de bloco → \n) para isolar a linha da morada
// sem misturar o título do widget/label vizinho nem o telefone da linha seguinte.
function htmlToLines(html) {
  return stripComments(html)
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/td|\/tr|\/section|\/address)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .split('\n').map((l) => l.trim()).filter(Boolean);
}

const PC_RE = /\b(\d{4}-\d{3})\s+([A-ZÀ-Ú][\wÀ-ú .'-]{1,40})/;
// CP internacionais (SE '123 45', NL '1234 AB', NO/FI/DE '1234'/'12345') → cidade a seguir.
// Formatos ESPECÍFICOS (o \d{4,5} genérico apanhava produto/preço tipo '136 Livsmedel'): SE '123 45',
// NL '1234 AB'. NO/FI/DE (só \d{4,5}) ficam para o JSON-LD/<address> — melhor sem cidade que uma errada.
const PC_INTL_RE = /\b(\d{3}\s\d{2}|\d{4}\s?[A-Z]{2})\s+([A-ZÀ-Ü][\p{L}.'-]{1,40}(?:\s+[A-ZÀ-Ü][\p{L}.'-]{1,40}){0,2})/u;
// Nomes de PAÍS (PT + nativos das geografias do pipeline) — NUNCA são a cidade do negócio. Um JSON-LD/GMB mal
// rotulado punha city="Suécia"/"Portugal". Guarda: rejeita país no campo cidade (melhor sem cidade que errada).
const COUNTRY_RE = /^(portugal|espanha|spain|espa[ñn]a|fran[çc]a|france|su[eé]cia|sweden|sverige|noruega|norway|norge|finl[âa]ndia|finland|suomi|pa[ií]ses baixos|netherlands|nederland|holanda|holland|alemanha|germany|deutschland|it[aá]lia|italy|reino unido|united kingdom|b[eé]lgica|belgium|dinamarca|denmark|irlanda|ireland|su[ií][çc]a|switzerland|[aá]ustria|austria|pol[oó]nia|poland)$/i;
const notCountry = (s) => (s && !COUNTRY_RE.test(String(s).trim()) ? s : null);

function titleCity(s) {
  const c = clip(s, 120);
  if (!c) return null;
  return notCountry(c.split(/[,;|\n]/)[0].trim().slice(0, 120) || null);
}

// Remove rótulos comuns no início ("Morada:", "Sede:", "Endereço:") e corta ruído no
// fim (telefone/email/horário na mesma linha).
function cleanAddress(line) {
  let a = String(line || '').replace(/^\s*(moradas?|endere[çc]o|sede|address|local(iza[çc][aã]o)?)\s*[:\-–]?\s*/i, '');
  a = a.split(/\s(?:tel\.?|telef\w*|telm\.?|telem\w*|phone|fax|e-?mail|hor[aá]rio)\b/i)[0];
  return clip(a, 255);
}

function fromPostalAddress(addr) {
  if (!addr || typeof addr !== 'object') return null;
  const city = notCountry(clip(addr.addressLocality, 120));
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
      if (res.city && res.address) return res;
    }
  }

  // 2) <address> HTML (comentários já removidos por stripTags → sem '-->')
  const am = html.match(/<address[^>]*>([\s\S]{1,600}?)<\/address>/i);
  if (am) {
    const text = stripTags(am[1]);
    if (text) res.address = res.address || cleanAddress(text);
    const pc = text.match(PC_RE);
    if (pc) { res.postalCode = res.postalCode || pc[1]; res.city = res.city || titleCity(pc[2]); }
  }

  // 3) Fallback: código postal PT por LINHA → preenche morada (linha inteira, limpa) +
  //    cidade + código postal. Cobre moradas em <div>/<p> de rodapé (sem <address>).
  if (!res.address || !res.city) {
    for (const line of htmlToLines(html)) {
      const pc = line.match(PC_RE) || line.match(PC_INTL_RE);
      if (!pc) continue;
      if (!res.address) res.address = cleanAddress(line);
      if (!res.postalCode) res.postalCode = pc[1];
      if (!res.city) res.city = titleCity(pc[2]);
      break;
    }
  }

  return res;
}
