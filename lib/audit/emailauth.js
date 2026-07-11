// lib/audit/emailauth.js
// Verifica SPF (TXT do apex) e DMARC (TXT de _dmarc.<domínio>) via DNS.
// Estados: ok / weak / missing / invalid. Falha de resolução transitória
// (SERVFAIL/timeout) devolve `null` (desconhecido) — o caller NÃO grava, para não
// marcar falsamente "missing". Cache por domínio (o mesmo apex repete-se).

import dns from 'node:dns/promises';

const spfCache = new Map();
const dmarcCache = new Map();
const MISSING_CODES = new Set(['ENODATA', 'ENOTFOUND', 'NODATA', 'NXDOMAIN']);

function classifySpf(spf) {
  const s = spf.toLowerCase();
  if (/\+all/.test(s)) return 'invalid'; // passa qualquer origem = pior que nada
  if (/[~-]all/.test(s)) return 'ok';    // softfail (~all) ou fail (-all)
  if (/\?all/.test(s)) return 'weak';    // neutral
  return 'weak';                          // sem mecanismo "all" => neutro implícito
}

function classifyDmarc(rec) {
  const m = rec.toLowerCase().match(/\bp\s*=\s*(none|quarantine|reject)/);
  if (!m) return 'invalid'; // v=DMARC1 sem policy é inválido
  return (m[1] === 'reject' || m[1] === 'quarantine') ? 'ok' : 'weak'; // p=none => weak
}

async function txtRecords(name) {
  const chunks = await dns.resolveTxt(name); // [['v=spf1 ...'], ...]
  return chunks.map((parts) => parts.join(''));
}

export async function checkSpf(domain) {
  if (spfCache.has(domain)) return spfCache.get(domain);
  let status;
  try {
    const recs = (await txtRecords(domain)).filter((r) => /^v=spf1\b/i.test(r.trim()));
    status = recs.length === 0 ? 'missing' : recs.length > 1 ? 'invalid' : classifySpf(recs[0]);
  } catch (e) {
    status = MISSING_CODES.has(e?.code) ? 'missing' : null;
  }
  spfCache.set(domain, status);
  return status;
}

export async function checkDmarc(domain) {
  if (dmarcCache.has(domain)) return dmarcCache.get(domain);
  let status;
  try {
    const recs = (await txtRecords(`_dmarc.${domain}`)).filter((r) => /^v=dmarc1\b/i.test(r.trim()));
    status = recs.length === 0 ? 'missing' : recs.length > 1 ? 'invalid' : classifyDmarc(recs[0]);
  } catch (e) {
    status = MISSING_CODES.has(e?.code) ? 'missing' : null;
  }
  dmarcCache.set(domain, status);
  return status;
}

// Conveniência: ambos de uma vez.
export async function checkEmailAuth(domain) {
  const [spf, dmarc] = await Promise.all([checkSpf(domain), checkDmarc(domain)]);
  return { spf, dmarc };
}
