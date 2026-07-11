// Pool de contas de APIs de verificação de email (free-tier), com rotação de
// contas + de proxies, para MAXIMIZAR os limites gratuitos.
//
// Config em config/verify-providers.json (GITIGNORED). Cada entrada:
//   { "provider": "quickemailverification", "apiKey": "K", "dailyLimit": 100 }
//   { "provider": "mailboxlayer", "apiKeys": ["K1","K2"], "dailyLimit": 100 }  // MULTI-KEY
//   { "provider": "eva" }                                                       // keyless (free)
// Multi-key: `apiKeys:[...]` expande em várias contas (mais quota free). Providers
// keyless (eva/disify) não precisam de chave — a quota é por IP, por isso beneficiam
// do ROUTING por proxy (uma quota por IP). Ver config/verify-providers.example.json.
//
// Routing por proxy (opcional): rota HTTP dos pedidos por proxies (undici ProxyAgent)
// para os providers limitados por IP terem uma quota free por proxy. Lê o campo
// `http` (ex. "http://user:pass@p1.dominio:8888") das entradas de config/verify-proxies.json;
// SOCKS5 puro não é suportado por fetch (usar um proxy HTTP nas VMs — ver docs).
//
// verify(email) → { status, provider } ou null (pool esgotado). status normalizado:
//   valid | invalid | catch_all | disposable | role | unknown
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProxyAgent } from 'undici';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'verify-providers.json');
const PROXIES_PATH = path.join(__dirname, '..', 'config', 'verify-proxies.json');

class QuotaError extends Error { constructor(m) { super(m); this.quota = true; } }

// Timeout duro por chamada: um provider lento/inacessível (ex. host que aceita a
// ligação mas nunca responde) bloquearia o pool durante o timeout TCP do SO (~min).
const CALL_TIMEOUT_MS = parseInt(process.env.VERIFY_TIMEOUT_MS || '8000', 10);

async function getJson(url, opts = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS), ...opts });
  if (res.status === 402 || res.status === 429) throw new QuotaError(`HTTP ${res.status}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (/credit|quota|limit|insufficient|exhaust/i.test(JSON.stringify(body))) throw new QuotaError(JSON.stringify(body));
    throw new Error(`HTTP ${res.status}`);
  }
  return body;
}

// Cada adapter devolve { status } normalizado. `key` pode ser '' (keyless). `d` =
// { dispatcher } opcional (proxy). Lança QuotaError quando sem créditos.
const ADAPTERS = {
  async quickemailverification(email, key, d) {
    const b = await getJson(`https://api.quickemailverification.com/v1/verify?email=${encodeURIComponent(email)}&apikey=${encodeURIComponent(key)}`, d);
    if (b.disposable === 'true' || b.disposable === true) return { status: 'disposable' };
    if (b.role === 'true' || b.role === true) return { status: 'role' };
    if (b.accept_all === 'true' || b.accept_all === true || b.catch_all === 'true') return { status: 'catch_all' };
    if (b.result === 'valid') return { status: 'valid' };
    if (b.result === 'invalid') return { status: 'invalid' };
    return { status: 'unknown' };
  },
  async emailable(email, key, d) {
    const b = await getJson(`https://api.emailable.com/v1/verify?email=${encodeURIComponent(email)}&api_key=${encodeURIComponent(key)}`, d);
    if (b.disposable) return { status: 'disposable' };
    if (b.role) return { status: 'role' };
    if (b.accept_all || b.state === 'risky') return { status: 'catch_all' };
    if (b.state === 'deliverable') return { status: 'valid' };
    if (b.state === 'undeliverable') return { status: 'invalid' };
    return { status: 'unknown' };
  },
  async abstractapi(email, key, d) {
    const b = await getJson(`https://emailvalidation.abstractapi.com/v1/?api_key=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}`, d);
    if (b.is_disposable_email?.value) return { status: 'disposable' };
    if (b.is_role_email?.value) return { status: 'role' };
    if (b.is_catchall_email?.value) return { status: 'catch_all' };
    if (b.deliverability === 'DELIVERABLE') return { status: 'valid' };
    if (b.deliverability === 'UNDELIVERABLE') return { status: 'invalid' };
    return { status: 'unknown' };
  },
  async clearout(email, key, d) {
    const b = await getJson('https://api.clearout.io/v2/email_verify/instant', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer:${key}` }, body: JSON.stringify({ email }), ...d });
    const x = b.data || {};
    if (x.disposable === 'yes') return { status: 'disposable' };
    if (x.role === 'yes') return { status: 'role' };
    if (x.email_type === 'catch_all' || x.status === 'catch_all') return { status: 'catch_all' };
    if (x.status === 'valid') return { status: 'valid' };
    if (x.status === 'invalid') return { status: 'invalid' };
    return { status: 'unknown' };
  },
  // https://apilayer.com/marketplace/email_verification-api — 100/mês free por conta
  async mailboxlayer(email, key, d) {
    const b = await getJson(`https://apilayer.net/api/check?access_key=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}&smtp=1&format=1`, d);
    if (b.error) throw (/quota|limit|subscription/i.test(JSON.stringify(b.error)) ? new QuotaError('mailboxlayer') : new Error('mailboxlayer'));
    if (b.disposable) return { status: 'disposable' };
    if (b.role) return { status: 'role' };
    if (b.catch_all) return { status: 'catch_all' };
    if (b.format_valid && b.mx_found && b.smtp_check) return { status: 'valid' };
    if (b.format_valid === false || b.mx_found === false || b.smtp_check === false) return { status: 'invalid' };
    return { status: 'unknown' };
  },
  // https://hunter.io/api/email-verifier — 25/mês free
  async hunter(email, key, d) {
    const b = await getJson(`https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${encodeURIComponent(key)}`, d);
    const x = b.data || {};
    if (x.disposable) return { status: 'disposable' };
    if (x.webmail === false && x.status === 'accept_all') return { status: 'catch_all' };
    if (x.status === 'valid' || x.result === 'deliverable') return { status: 'valid' };
    if (x.status === 'invalid' || x.result === 'undeliverable') return { status: 'invalid' };
    return { status: 'unknown' };
  },
  // https://eva.pingutil.com — FREE, sem chave, limitado por IP (→ routing por proxy multiplica).
  async eva(email, _key, d) {
    const b = await getJson(`https://api.eva.pingutil.com/email?email=${encodeURIComponent(email)}`, d);
    const x = b.data || {};
    if (x.disposable) return { status: 'disposable' };
    if (x.deliverability === 'DELIVERABLE') return { status: 'valid' };
    if (x.deliverability === 'UNDELIVERABLE') return { status: 'invalid' };
    if (x.valid_syntax === false) return { status: 'invalid' };
    return { status: 'unknown' };
  },
  // https://disify.com — FREE, sem chave. Só format/disposable/MX (não existência) →
  // útil como pré-filtro barato (disposable/no_mx), nunca dá 'valid'.
  async disify(email, _key, d) {
    const b = await getJson(`https://disify.com/api/email/${encodeURIComponent(email)}`, d);
    if (b.disposable) return { status: 'disposable' };
    if (b.dns === false || b.format === false) return { status: b.format === false ? 'invalid' : 'no_mx' };
    return { status: 'unknown' };
  },
  // https://myemailverifier.com — 100/dia recorrente (FREE). GET com a chave no path.
  async myemailverifier(email, key, d) {
    const b = await getJson(`https://client.myemailverifier.com/verifier/validate_single/${encodeURIComponent(email)}/${encodeURIComponent(key)}`, d);
    const st = String(b.Status || '').toLowerCase();
    if (/disposable/i.test(String(b.Disposable_Domain))) return { status: 'disposable' };
    if (/true|yes/i.test(String(b.Role_Based))) return { status: 'role' };
    if (st.includes('catch')) return { status: 'catch_all' };
    if (st === 'valid') return { status: 'valid' };
    if (st === 'invalid') return { status: 'invalid' };
    return { status: 'unknown' };
  },
  // https://reoon.com/articles/api-documentation-of-reoon-email-verifier — ~600/mês recorrente.
  // mode=power = SMTP/inbox/catch-all completo; quick = só sintaxe/MX/disposable.
  async reoon(email, key, d) {
    const b = await getJson(`https://emailverifier.reoon.com/api/v1/verify?email=${encodeURIComponent(email)}&key=${encodeURIComponent(key)}&mode=power`, d);
    if (b.is_disposable) return { status: 'disposable' };
    if (b.is_role_account) return { status: 'role' };
    const st = String(b.status || '').toLowerCase();
    if (st === 'safe' || st === 'valid') return { status: 'valid' };
    if (st === 'invalid') return { status: 'invalid' };
    if (b.can_connect_smtp === true && b.is_catch_all) return { status: 'catch_all' };
    return { status: 'unknown' };
  },
  // https://www.mailboxvalidator.com/api-email-free — 300/mês recorrente (auto-renew).
  async mailboxvalidator(email, key, d) {
    const b = await getJson(`https://api.mailboxvalidator.com/v2/validation/single?email=${encodeURIComponent(email)}&key=${encodeURIComponent(key)}&format=json`, d);
    if (b.error_code) throw (/plan|credit|quota|limit/i.test(JSON.stringify(b)) ? new QuotaError('mailboxvalidator') : new Error('mailboxvalidator'));
    const yes = (v) => /true/i.test(String(v));
    if (yes(b.is_disposable)) return { status: 'disposable' };
    if (yes(b.is_role)) return { status: 'role' };
    if (yes(b.is_catchall)) return { status: 'catch_all' };
    if (yes(b.is_verified) && yes(b.is_smtp)) return { status: 'valid' };
    if (String(b.status) === 'False') return { status: 'invalid' };
    return { status: 'unknown' };
  },
  // https://www.zerobounce.net/apis/email-validation-api — 100/mês recorrente (até 5 chaves/conta).
  async zerobounce(email, key, d) {
    const b = await getJson(`https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}`, d);
    const st = String(b.status || '').toLowerCase();
    if (st === 'do_not_mail' && /disposable|toxic/i.test(String(b.sub_status))) return { status: 'disposable' };
    if (st === 'do_not_mail' && /role/i.test(String(b.sub_status))) return { status: 'role' };
    if (st === 'catch-all') return { status: 'catch_all' };
    if (st === 'valid') return { status: 'valid' };
    if (st === 'invalid') return { status: 'invalid' };
    return { status: 'unknown' };
  },
};

// Constrói dispatchers de proxy HTTP a partir de config/verify-proxies.json (campo `http`).
function loadProxyDispatchers() {
  try {
    const proxies = JSON.parse(fs.readFileSync(PROXIES_PATH, 'utf8')).filter((p) => p && p.http);
    return proxies.map((p) => new ProxyAgent(p.http));
  } catch { return []; }
}

export function makeProviderPool(configPath = CONFIG_PATH) {
  let accounts = [];
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    for (const a of raw) {
      if (!ADAPTERS[a.provider]) continue;
      const keys = Array.isArray(a.apiKeys) ? a.apiKeys : (a.apiKey ? [a.apiKey] : ['']); // keyless → ['']
      for (const k of keys) accounts.push({ provider: a.provider, apiKey: k, dailyLimit: a.dailyLimit || 0, used: 0, exhausted: false });
    }
  } catch { accounts = []; }

  const dispatchers = loadProxyDispatchers();
  let di = 0;
  const nextDispatcher = () => (dispatchers.length ? { dispatcher: dispatchers[di++ % dispatchers.length] } : {});

  let idx = 0;
  async function verify(email) {
    for (let tried = 0; tried < accounts.length; tried++) {
      const acc = accounts[idx++ % accounts.length];
      if (acc.exhausted) continue;
      try {
        const r = await ADAPTERS[acc.provider](email, acc.apiKey, nextDispatcher());
        acc.used++;
        if (acc.dailyLimit && acc.used >= acc.dailyLimit) acc.exhausted = true;
        return { ...r, provider: acc.provider };
      } catch (e) {
        if (e.quota) { acc.exhausted = true; console.error(`  provider ${acc.provider}: sem créditos, a passar ao próximo.`); }
        // transitório/sem-créditos → próxima conta
      }
    }
    return null;
  }

  return {
    verify,
    anyLeft: () => accounts.some((a) => !a.exhausted),
    count: accounts.length,
    proxies: dispatchers.length,
    accounts,
  };
}
