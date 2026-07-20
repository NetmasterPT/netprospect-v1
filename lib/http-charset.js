// lib/http-charset.js
// Decodifica o corpo HTML respeitando o charset REAL: cabeçalho HTTP → <meta charset> → UTF-8.
//
// PORQUÊ: fetch()/Response.text() só honra o charset do CABEÇALHO HTTP. Páginas Latin-1/Windows-1252
// que declaram o charset SÓ no <meta> (comum em CMS/sites antigos nórdicos) eram lidas como UTF-8 →
// os bytes dos acentos (å/ö/ä) viravam o caráter de substituição U+FFFD ('�') → "Strömsund" → "Str�msund".
// Isto contaminava business_city/business_address E nomes de contactos.

const ALIASES = {
  latin1: 'windows-1252', 'iso-8859-1': 'windows-1252', iso8859_1: 'windows-1252',
  'iso-8859-15': 'windows-1252', 'us-ascii': 'utf-8', 'ascii': 'utf-8', utf8: 'utf-8',
};
const norm = (cs) => {
  if (!cs) return null;
  const c = cs.trim().toLowerCase().replace(/^["']+|["']+$/g, '');
  return ALIASES[c] || c;
};

const fromHeader = (ct) => {
  const m = /charset\s*=\s*([^;]+)/i.exec(ct || '');
  return norm(m && m[1]);
};

// Sniff do <meta> nos primeiros bytes. Os nomes de charset são sempre ASCII → decodificar o cabeçalho
// como latin1 é seguro para os encontrar, mesmo que o corpo real seja outro encoding.
const fromMeta = (bytes) => {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  let m = /<meta[^>]+charset\s*=\s*["']?\s*([\w:.-]+)/i.exec(head);
  if (m) return norm(m[1]);
  m = /<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([\w:.-]+)/i.exec(head);
  return norm(m && m[1]);
};

// Lê o corpo do Response UMA vez e devolve o texto decodificado com o charset correto.
// Ordem: charset do cabeçalho → <meta> → UTF-8. Charset desconhecido pelo TextDecoder → cai em UTF-8.
export async function decodeHtmlBody(r) {
  const bytes = new Uint8Array(await r.arrayBuffer());
  const cs = fromHeader(r.headers.get('content-type')) || fromMeta(bytes) || 'utf-8';
  try { return new TextDecoder(cs, { fatal: false }).decode(bytes); }
  catch { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); }
}
