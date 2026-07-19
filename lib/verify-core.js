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
// Empacota o detalhe rico do Reacher (email_verify_detail) — a API só dá um label.
const reacherDetail = (r) => ({
  reachable: r.reachable, deliverable: r.deliverable, catch_all: r.catchAll, role: r.role,
  disabled: r.disabled, full_inbox: r.fullInbox, disposable: r.disposable,
  smtp_reason: r.smtpReason ? String(r.smtpReason).slice(0, 200) : null, source: r.source || 'reacher',
});

export function makeVerifyOne(providers, reacher) {
  return async function verifyOne(email, mx, domain) {
    const cls = providerClass(mx);
    const big = isBigProvider(cls);
    const viaApi = async () => {
      if (!providers.anyLeft()) return null;
      const r = await providers.verify(email);
      return r ? { status: r.status, accepted: acc(r.status), source: 'api:' + r.provider } : null;
    };
    const viaReacher = async () => {
      if (!reacher.enabled()) return null;
      const r = await reacher.verify(email, { mxHosts: mx, domain });
      return r.status !== 'unknown' ? { status: r.status, accepted: acc(r.status), source: r.source, detail: reacherDetail(r) } : null;
    };
    // Big providers (Gmail/M365/Yahoo, detetados por MX) BLOQUEIAM IPs datacenter (ex.: S3140 da Microsoft) →
    // o Reacher devolveria um 'unknown' FALSO que marcava o contacto (nunca mais retentado). Usar SÓ a API para
    // estes; se a API esgotou, DEFER (fica null → retry quando a quota renovar) em vez de sondar o Reacher em vão.
    const order = big ? [viaApi] : [viaReacher, viaApi];
    for (const step of order) { const r = await step(); if (r) return r; }
    if (big && !providers.anyLeft()) return { status: 'deferred', accepted: false, source: 'api-exhausted', deferred: true };
    return { status: 'unknown', accepted: false, source: (reacher.enabled() || providers.count) ? 'unknown' : 'no-verifier' };
  };
}

// Verifica todos os `contacts` de UM domínio (catch-all decidido uma vez). Persiste
// email_status/email/email_verified/email_source em Directus. Devolve contagem por
// status. `mxCache` (Map) opcional para reuso entre domínios/jobs. Lança
// PoolExhaustedError se ficar sem quota antes de terminar (contactos já feitos ficam).
export async function verifyDomain(client, { domain, contacts }, { providers, reacher, maxCand = 4, dry = false, mxCache = null, deadlineMs = 0 } = {}) {
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
    // Deadline por job: domínios B2C (ex. jouwweb.nl, online.no) têm centenas de contactos-null —
    // processá-los todos em série estoura o hang-timeout do dispatch (0.85×ackWait). Paramos ao chegar
    // ao deadline; os já-feitos ficam gravados, os restantes ficam NULL e re-verificam num lote futuro.
    if (deadlineMs && Date.now() > deadlineMs) { bump('deferred'); break; }
    // Email departamental existente → role (sem probe).
    if (c.email && isRoleLocal(c.email)) { await persist(c, { email_status: 'role', email: c.email, email_verified: false, email_source: 'existing' }); continue; }
    const candidates = (c.email ? [c.email] : generatePatterns(c.name, domain)).filter(syntaxValid).slice(0, maxCand);
    if (!candidates.length) { await persist(c, { email_status: 'unknown', email_verified: false }); continue; }
    if (dry) continue;
    if (catchAll) { await persist(c, { email: candidates[0], email_status: 'catch_all', email_verified: false, email_source: 'pattern_guess' }); continue; }

    need(); // sem quota → lança; contacto fica null → re-enfileirado
    let done = false, sawUnknown = false, dfr = false;
    for (const cand of candidates) {
      need(); // RE-CHECK antes de CADA candidato: se a quota esgotou entre candidatos, lança AQUI (contacto
              // fica NULL para retry) em vez de o loop devolver 'unknown' por falta de quota e o marcar.
      const r = await verifyOne(cand, mx, domain);
      if (r.deferred) { dfr = true; break; } // (a) big provider + API esgotada → deixa NULL p/ retry (não sonda o Reacher bloqueado)
      const det = r.detail ? { email_verify_detail: r.detail } : {}; // (b) detalhe rico do Reacher (a API só dá o label)
      if (r.status === 'valid') { await persist(c, { email: cand, email_status: 'valid', email_verified: true, email_source: r.source, ...det }); done = true; break; }
      if (r.status === 'catch_all') { await persist(c, { email: cand, email_status: 'catch_all', email_verified: false, email_source: r.source, ...det }); done = true; break; }
      if (r.status === 'disposable' || r.status === 'role') { await persist(c, { email: cand, email_status: r.status, email_verified: false, email_source: r.source, ...det }); done = true; break; }
      if (r.status === 'unknown') sawUnknown = true;
    }
    if (dfr) { bump('deferred'); continue; } // não persiste — re-verifica quando a API renovar a quota
    // BUG-FIX: um 'unknown' com o pool JÁ esgotado = NÃO foi verificado (a quota esgotou DURANTE a última
    // sondagem, que devolveu unknown por falta de créditos). Marcá-lo 'unknown' classificava-o (e o job fazia
    // ACK) sem verificação real → nunca mais era retentado. Lança → contacto fica NULL, job faz nak → retry.
    if (!done && sawUnknown && !hasCapacity(providers, reacher)) throw new PoolExhaustedError();
    if (!done) await persist(c, { email_status: sawUnknown ? 'unknown' : 'invalid', email_verified: false });
  }
  return counts;
}
