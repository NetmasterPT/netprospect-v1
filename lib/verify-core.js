// lib/verify-core.js
// Núcleo PARTILHADO de verificação de email por domínio — usado tanto pelo
// verify-emails.js (standalone) como pelo handler `verify` do worker distribuído
// (worker/handlers.mjs → jobs.verify). Uma decisão de catch-all por domínio;
// routing big-provider→API-first / corporativo→Reacher-first; persiste em Directus.
//
// Capacidade: a quota free (QEV 100/dia, etc.) esgota-se. `hasCapacity()` diz se
// ainda há verificador disponível; verifyDomain LANÇA quando fica sem quota a meio
// (em vez de marcar tudo 'unknown'), para o job voltar à fila (nak) e os contactos
// não-processados ficarem com email_status=null → re-enfileirados no lote seguinte.

import { updateItem } from '@directus/sdk';
import { generatePatterns, resolveMx, syntaxValid, isRoleLocal, isDisposable, classifyCatchAll } from './email-verify.js';
import { providerClass, isBigProvider } from './reacher.js';

const acc = (status) => status === 'valid' || status === 'catch_all';

export class PoolExhaustedError extends Error {
  constructor() { super('verify pool exhausted — sem quota; retry mais tarde'); this.exhausted = true; }
}

// Ainda há algum verificador com quota?
export const hasCapacity = (providers, reacher) => providers.anyLeft() || reacher.enabled();

// Verifica UM email. Routing: big providers (Gmail/M365/…) → API primeiro (fiável);
// corporativo → Reacher primeiro (se ligado), API como fallback.
export function makeVerifyOne(providers, reacher) {
  return async function verifyOne(email, mx, domain) {
    const cls = providerClass(mx);
    const viaApi = async () => {
      if (!providers.anyLeft()) return null;
      const r = await providers.verify(email);
      return r ? { status: r.status, accepted: acc(r.status), source: 'api:' + r.provider } : null;
    };
    const viaReacher = async () => {
      if (!reacher.enabled()) return null;
      const r = await reacher.verify(email, { mxHosts: mx, domain });
      return r.status !== 'unknown' ? { status: r.status, accepted: acc(r.status), source: r.source } : null;
    };
    const order = isBigProvider(cls) ? [viaApi, viaReacher] : [viaReacher, viaApi];
    for (const step of order) { const r = await step(); if (r) return r; }
    return { status: 'unknown', accepted: false, source: (reacher.enabled() || providers.count) ? 'unknown' : 'no-verifier' };
  };
}

// Verifica todos os `contacts` de UM domínio (catch-all decidido uma vez). Persiste
// email_status/email/email_verified/email_source em Directus. Devolve contagem por
// status. `mxCache` (Map) opcional para reuso entre domínios/jobs. Lança
// PoolExhaustedError se ficar sem quota antes de terminar (contactos já feitos ficam).
export async function verifyDomain(client, { domain, contacts }, { providers, reacher, maxCand = 4, dry = false, mxCache = null } = {}) {
  const counts = {};
  const bump = (st) => { counts[st] = (counts[st] || 0) + 1; };
  const verifyOne = makeVerifyOne(providers, reacher);
  const need = () => { if (!dry && !hasCapacity(providers, reacher)) throw new PoolExhaustedError(); };

  const mx = mxCache?.has(domain) ? mxCache.get(domain) : await resolveMx(domain);
  // resolveMx devolve null em erro TRANSITÓRIO de DNS (≠ [] = "sem MX" real). NÃO cachear o erro nem
  // classificar: deixar os contactos com email_status=NULL para re-verify num lote futuro (evita o
  // falso 'no_mx' terminal que os marcava como "feitos" sem terem sido verificados).
  if (mx === null) return counts;
  if (mxCache) mxCache.set(domain, mx);

  const persist = async (c, patch) => {
    bump(patch.email_status);
    if (!dry) await client.request(updateItem('contacts', c.id, { ...patch, verified_at: new Date().toISOString() }));
  };

  // Pré-filtro por domínio (grátis, sem quota).
  if (isDisposable(domain)) { for (const c of contacts) await persist(c, { email_status: 'disposable', email_verified: false }); return counts; }
  if (!mx.length) { for (const c of contacts) await persist(c, { email_status: 'no_mx', email_verified: false }); return counts; }

  // Catch-all (uma vez por domínio) — consome quota.
  let catchAll = false;
  if (!dry) { need(); catchAll = await classifyCatchAll(domain, (e) => verifyOne(e, mx, domain).then((r) => r.accepted)); }

  for (const c of contacts) {
    // Email departamental existente → role (sem probe).
    if (c.email && isRoleLocal(c.email)) { await persist(c, { email_status: 'role', email: c.email, email_verified: false, email_source: 'existing' }); continue; }
    const candidates = (c.email ? [c.email] : generatePatterns(c.name, domain)).filter(syntaxValid).slice(0, maxCand);
    if (!candidates.length) { await persist(c, { email_status: 'unknown', email_verified: false }); continue; }
    if (dry) continue;
    if (catchAll) { await persist(c, { email: candidates[0], email_status: 'catch_all', email_verified: false, email_source: 'pattern_guess' }); continue; }

    need(); // sem quota → lança; contacto fica null → re-enfileirado
    let done = false, sawUnknown = false;
    for (const cand of candidates) {
      const r = await verifyOne(cand, mx, domain);
      if (r.status === 'valid') { await persist(c, { email: cand, email_status: 'valid', email_verified: true, email_source: r.source }); done = true; break; }
      if (r.status === 'catch_all') { await persist(c, { email: cand, email_status: 'catch_all', email_verified: false, email_source: r.source }); done = true; break; }
      if (r.status === 'disposable' || r.status === 'role') { await persist(c, { email: cand, email_status: r.status, email_verified: false, email_source: r.source }); done = true; break; }
      if (r.status === 'unknown') sawUnknown = true;
    }
    if (!done) await persist(c, { email_status: sawUnknown ? 'unknown' : 'invalid', email_verified: false });
  }
  return counts;
}
