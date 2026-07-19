// lib/reacher.js — Fase 1 (validação de emails).
// Wrapper do motor Reacher (self-hosted, HTTP) que faz o handshake SMTP via os
// NOSSOS proxies SOCKS5 limpos (Dante em VMs datacenter com PTR alinhado). O
// Reacher aceita `proxy` + `hello_name` por pedido, por isso cada verificação sai
// de um IP de validação — nunca desta máquina.
//
// A orquestração (prefilter barato, routing por provider, resume no Directus) fica
// em verify-emails.js. Este módulo: chama o Reacher, mapeia a resposta para o nosso
// vocabulário `email_status`, e gere a rotação de proxies + cooldowns por IP/provider.
//
// Ver docs/outreach-ops/02-reacher.md e 01-validation-fleet.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REACHER_URL = (process.env.REACHER_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const FROM_EMAIL = process.env.REACHER_FROM_EMAIL || process.env.EMAIL_FROM || '';
const PROXIES_PATH = path.join(__dirname, '..', 'config', 'verify-proxies.json');

// Cooldowns por IP e por classe de provider (ms). Corporativo é por (IP, domínio).
const COOLDOWN = { gmail: 12000, microsoft: 15000, yahoo: 30000, corp: 2000 };

// Classe de provider a partir dos hosts MX (routing + cooldown). Os grandes
// providers greylistam IPs frescos → verify-emails.js cruza com o pool de APIs.
export function providerClass(mxHosts = []) {
  const h = mxHosts.join(' ').toLowerCase();
  if (/google\.com|googlemail|gmail/.test(h)) return 'gmail';
  if (/outlook|office365|microsoft|hotmail/.test(h)) return 'microsoft';
  if (/yahoodns|yahoo\.com|yahoo\.|aol\./.test(h)) return 'yahoo';
  return 'corp';
}
export const isBigProvider = (cls) => cls === 'gmail' || cls === 'microsoft' || cls === 'yahoo';

// Mapeia a resposta do Reacher para o nosso email_status.
// (valid | invalid | catch_all | role | disposable | no_mx | unknown)
export function mapReacher(j) {
  const smtp = j?.smtp || {}; const misc = j?.misc || {}; const mx = j?.mx || {}; const syntax = j?.syntax || {};
  const reachable = j?.is_reachable || 'unknown';
  let status;
  if (syntax.is_valid_syntax === false) status = 'invalid';
  else if (mx.accepts_mail === false) status = 'no_mx';
  else if (misc.is_disposable) status = 'disposable';
  else if (misc.is_role_account) status = 'role';
  else if (smtp.is_catch_all) status = 'catch_all';
  else if (reachable === 'safe') status = 'valid';
  else if (reachable === 'invalid') status = 'invalid';
  else status = 'unknown'; // risky | unknown → o orquestrador decide fallback p/ API
  return {
    status, reachable,
    catchAll: !!smtp.is_catch_all, role: !!misc.is_role_account, disposable: !!misc.is_disposable,
    canConnect: smtp.can_connect_smtp !== false,
    // Detalhe rico (persistido em email_verify_detail): o Reacher separa sinais que a API colapsa num label.
    deliverable: smtp.is_deliverable === true, disabled: !!smtp.is_disabled, fullInbox: !!smtp.has_full_inbox,
    smtpReason: (smtp.error && (smtp.error.message || smtp.error.type)) || null,
  };
}

// Uma verificação. `proxy` = {host,port,user,pass}; `helloName` = PTR do proxy.
export async function checkEmail(email, { proxy, helloName, fromEmail = FROM_EMAIL, reacherUrl = REACHER_URL, timeoutMs = 12000 } = {}) {
  // Reacher v0.11.6 quer um Duration {secs,nanos} — o int `8` dava HTTP 400 ("expected struct Duration"),
  // o que fazia TODAS as sondagens falharem → unknown (Reacher inútil). Bound cada probe SMTP a 8s.
  const body = { to_email: email, smtp_timeout: { secs: 8, nanos: 0 } };
  if (fromEmail) body.from_email = fromEmail;
  if (helloName) body.hello_name = helloName;
  if (proxy) body.proxy = { host: proxy.host, port: proxy.port, username: proxy.user, password: proxy.pass };
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${reacherUrl}/v1/check_email`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!r.ok) return { status: 'unknown', error: `reacher HTTP ${r.status}` };
    const j = await r.json();
    return { ...mapReacher(j), raw: j };
  } catch (e) {
    return { status: 'unknown', error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(to); }
}

// Pool de proxies limpos + cooldowns. Carrega config/verify-proxies.json.
// verify(email, {mxHosts, domain}) escolhe um proxy livre (round-robin, respeitando
// cooldown por IP+classe), chama o Reacher e devolve o resultado mapeado.
export function makeReacherPool({ configPath = PROXIES_PATH, reacherUrl = REACHER_URL } = {}) {
  let proxies = [];
  try { proxies = JSON.parse(fs.readFileSync(configPath, 'utf8')).filter((p) => p.host && p.port); } catch { proxies = []; }
  const enabled = () => proxies.length > 0;
  let idx = 0;
  // last[proxyId][key] = timestamp. key = classe, ou `corp:<domínio>` p/ corporativos.
  const last = new Map();
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  const cooldownKey = (cls, domain) => (cls === 'corp' ? `corp:${domain}` : cls);
  const remaining = (p, cls, domain) => {
    const m = last.get(p.id) || {};
    const t = m[cooldownKey(cls, domain)] || 0;
    const left = (COOLDOWN[cls] || COOLDOWN.corp) - (Date.now() - t);
    return left > 0 ? left : 0;
  };
  const stamp = (p, cls, domain) => {
    const m = last.get(p.id) || {}; m[cooldownKey(cls, domain)] = Date.now(); last.set(p.id, m);
  };

  async function verify(email, { mxHosts = [], domain } = {}) {
    if (!enabled()) return { status: 'unknown', source: 'no-proxy' };
    const cls = providerClass(mxHosts);
    const dom = domain || email.split('@')[1] || '';
    // procura um proxy sem cooldown; se todos em cooldown, espera o menor.
    let pick = null; let minLeft = Infinity;
    for (let i = 0; i < proxies.length; i++) {
      const p = proxies[(idx + i) % proxies.length];
      const left = remaining(p, cls, dom);
      if (left === 0) { pick = p; idx = (idx + i + 1) % proxies.length; break; }
      if (left < minLeft) { minLeft = left; pick = p; }
    }
    if (remaining(pick, cls, dom) > 0) await sleep(Math.min(minLeft, COOLDOWN[cls] || 5000));
    stamp(pick, cls, dom);
    const res = await checkEmail(email, { proxy: { host: pick.host, port: pick.port, user: pick.user, pass: pick.pass }, helloName: pick.helo, reacherUrl });
    return { ...res, source: 'reacher', proxyId: pick.id, providerClass: cls };
  }

  return { enabled, count: proxies.length, proxies, verify, providerClass, isBigProvider };
}
