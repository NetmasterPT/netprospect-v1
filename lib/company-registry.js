// lib/company-registry.js — enriquecimento via REGISTOS DE EMPRESAS oficiais (grátis/abertos).
// Dá: nº de registo, dimensão (nº empregados), CAE/indústria e, sobretudo, DECISORES NOMEADOS
// (administração/gerência) — o sinal mais valioso que o site raramente expõe.
//
// ⚠️ MATCHING: procurar por NOME é pouco fiável (o company.name do dataset está frequentemente envenenado —
// ex. "Nothing found for" — e a pesquisa por nome devolve homónimos). O caminho de ALTA QUALIDADE é o
// nº de registo EXATO extraído do próprio site (Org.nr NO / Org.nummer SE / VAT). searchByName fica para
// um 1.º palpite com `confidence` baixa (a marcar como não-confirmado).
//
// Registos suportados: NO (Brønnøysund, `data.brreg.no` — aberto, sem key). SE/FI/NL/PT = stubs a ligar
// (Bolagsverket/PRH·YTJ/KVK/Racius) — mesma forma de saída. Ver .claude/plans/dev/prospecting.md.

const UA = 'netprospect-enrich/1.0 (+https://netmaster.pt; prospecao B2B)';
const TIMEOUT_MS = 12000;

async function getJson(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(to); }
}

// --- Normalização de papéis (registo → o nosso role_category) --------------------------------
// decision_maker = quem manda (presidente do conselho, CEO/diretor-geral, sócio-gerente).
// manager = administração restante; staff = suplentes; unknown = o resto.
const NO_ROLE_MAP = [
  [/dagl(ig)?\s*leder|adm(inistrerende)?\s*dir/i, 'decision_maker'],   // CEO / managing director
  [/styrets?\s*leder|styreleder/i, 'decision_maker'],                  // chair of the board
  [/innehaver|deltaker|komplementar/i, 'decision_maker'],              // sole prop / partner
  [/nestleder/i, 'manager'],                                           // deputy chair
  [/styremedlem/i, 'manager'],                                         // board member
  [/varamedlem|varamann/i, 'staff'],                                   // deputy
];
function mapRole(desc, table = NO_ROLE_MAP) {
  for (const [re, cat] of table) if (re.test(desc || '')) return cat;
  return 'unknown';
}
const isDecisionMaker = (cat) => cat === 'decision_maker';

// --- Norway (Brønnøysundregistrene) ----------------------------------------------------------
const NO_ORG = /^\d{9}$/;
export function normalizeOrgNumber(raw, country = 'NO') {
  const digits = String(raw || '').replace(/\D/g, '');
  if (country === 'NO') return NO_ORG.test(digits) ? digits : null;
  return digits || null;
}

async function brregEntity(org) {
  const e = await getJson(`https://data.brreg.no/enhetsregisteret/api/enheter/${org}`);
  if (!e || !e.organisasjonsnummer) return null;
  return {
    org_number: e.organisasjonsnummer,
    name: e.navn || null,
    employees: e.antallAnsatte ?? null,
    industry_code: e.naeringskode1?.kode || null,
    industry: e.naeringskode1?.beskrivelse || null,
    registered: e.registreringsdatoEnhetsregisteret || null,
    bankrupt: !!e.konkurs,
    country: 'NO',
    source: 'brreg',
  };
}
async function brregRoles(org) {
  const r = await getJson(`https://data.brreg.no/enhetsregisteret/api/enheter/${org}/roller`);
  const out = [];
  for (const grp of r?.rollegrupper || []) {
    for (const rol of grp.roller || []) {
      const p = rol.person;
      if (!p || rol.fratraadt) continue; // só pessoas ativas (não os que saíram)
      const nm = p.navn || {};
      const name = [nm.fornavn, nm.mellomnavn, nm.etternavn].filter(Boolean).join(' ').trim();
      if (!name) continue;
      const desc = rol.type?.beskrivelse || '';
      out.push({ name, role: desc, role_category: mapRole(desc) });
    }
  }
  // dedup por nome (a mesma pessoa pode ter vários papéis) — fica com o mais sénior
  const rank = { decision_maker: 3, manager: 2, staff: 1, unknown: 0 };
  const best = new Map();
  for (const c of out) { const k = c.name.toLowerCase(); if (!best.has(k) || rank[c.role_category] > rank[best.get(k).role_category]) best.set(k, c); }
  return [...best.values()];
}

// --- API pública -----------------------------------------------------------------------------
// lookupByOrgNumber: match EXATO (alta confiança). Devolve { ...empresa, roles:[], confidence:1 } ou null.
export async function lookupByOrgNumber(orgNumber, country = 'NO') {
  const org = normalizeOrgNumber(orgNumber, country);
  if (!org) return null;
  if (country !== 'NO') return null; // outros registos: a ligar (stub)
  const [ent, roles] = await Promise.all([brregEntity(org), brregRoles(org)]);
  if (!ent) return null;
  return { ...ent, roles, has_decision_maker: roles.some((r) => isDecisionMaker(r.role_category)), confidence: 1 };
}

// searchByName: 1.º palpite (confidence baixa — NÃO confirmar sem corroboração, ex. cidade/indústria).
// Devolve candidatos [{org_number, name, employees, industry, confidence}].
export async function searchByName(name, country = 'NO', { limit = 5 } = {}) {
  if (!name || country !== 'NO') return [];
  const d = await getJson(`https://data.brreg.no/enhetsregisteret/api/enheter?navn=${encodeURIComponent(name)}&size=${limit}`);
  const ents = d?._embedded?.enheter || [];
  const q = String(name).toLowerCase().trim();
  return ents.map((e) => ({
    org_number: e.organisasjonsnummer, name: e.navn || null,
    employees: e.antallAnsatte ?? null, industry: e.naeringskode1?.beskrivelse || null,
    // confiança grosseira: match exato de nome = 0.6; senão 0.3 (só-nome nunca é 1 — precisa de corroboração)
    confidence: String(e.navn || '').toLowerCase().trim() === q ? 0.6 : 0.3,
  }));
}

export const _internal = { mapRole, brregEntity, brregRoles }; // p/ testes
