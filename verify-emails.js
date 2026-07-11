// verify-emails.js
//
// Motor de verificação de emails EM CAMADAS, sem queimar reputação de IP:
//   0. Inferência de padrões (first.last@, flast@, ...) quando só há nome.
//   1. Pré-filtro local (grátis): sintaxe -> MX -> role/departamental ->
//      descartável -> catch-all (uma vez por domínio). Remove a maior parte.
//   2. Reacher (self-hosted) via os NOSSOS proxies SOCKS5 LIMPOS (Dante em VMs
//      datacenter com PTR alinhado) — o handshake SMTP RCPT sai de um IP de
//      validação, nunca desta máquina. Ver lib/reacher.js + docs/outreach-ops/.
//   3. Pool de contas de APIs free-tier — a via FIÁVEL para Gmail/M365/Yahoo
//      (accept-all a partir de IPs frescos → Reacher dá "unknown") e fallback geral.
//
// Routing por provider: Gmail/Microsoft/Yahoo -> API primeiro (fiável); resto
// (corporativo, ~60-70% da lista) -> Reacher via proxy limpo, com API como fallback.
// Concorrente (vários domínios em paralelo; cooldowns por IP+provider no reacher.js).
//
// Uso:
//   node verify-emails.js --dry-run                          (pré-filtro + inferência)
//   REACHER_URL=http://127.0.0.1:8080 node verify-emails.js --limit=500
//   node verify-emails.js --concurrency=5 --max-candidates=4 --force
//
// Requer: config/verify-proxies.json (proxies limpos) e/ou config/verify-providers.json
// (chaves de API) — ambos gitignored. EMAIL_FROM/REACHER_FROM_EMAIL = domínio descartável.

import { readItems } from '@directus/sdk';
import { makeClient } from './lib/directus.js';
import { makeProviderPool } from './lib/verify-providers.js';
import { makeReacherPool } from './lib/reacher.js';
import { verifyDomain, hasCapacity } from './lib/verify-core.js';

const argv = process.argv.slice(2);
const flag = (n, d) => { const f = argv.find((a) => a.startsWith(`--${n}=`)); return f ? f.split('=').slice(1).join('=') : d; };
const LIMIT = flag('limit', null) ? parseInt(flag('limit'), 10) : null;
const CONCURRENCY = Math.max(1, parseInt(flag('concurrency', '5'), 10) || 5);
const MAX_CAND = Math.max(1, parseInt(flag('max-candidates', '4'), 10) || 4);
const DRY = argv.includes('--dry-run');
const FORCE = argv.includes('--force');
const FROM = flag('from', process.env.REACHER_FROM_EMAIL || process.env.EMAIL_FROM || '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pool(items, n, worker) {
  let i = 0;
  async function next() {
    if (i >= items.length) return;
    const idx = i++;
    try { await worker(items[idx], idx); } catch (e) { console.error(`  ! ${items[idx]?.domain}: ${e.message}`); }
    return next();
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, next));
}

async function main() {
  const client = makeClient();
  const providers = makeProviderPool();
  const reacher = makeReacherPool();

  console.log(`APIs: ${providers.count} conta(s). Reacher proxies: ${reacher.count}. ${DRY ? 'DRY-RUN (sem probe).' : (FROM ? 'FROM=' + FROM : 'sem FROM (Reacher usa RCH_FROM_EMAIL).')}`);
  if (!DRY && providers.count === 0 && reacher.count === 0) {
    console.error('Nada para verificar: sem contas de API e sem proxies do Reacher. Usa --dry-run, ou preenche config/verify-providers.json e/ou config/verify-proxies.json.');
    process.exit(1);
  }

  // Contactos por processar: têm empresa e ainda não têm email_status.
  const filter = { company: { _nnull: true } };
  if (!FORCE) filter.email_status = { _null: true };
  const contacts = await client.request(
    readItems('contacts', { filter, fields: ['id', 'name', 'email', 'company.id', 'company.org_domain'], limit: LIMIT || -1 })
  );
  const withTarget = contacts.filter((c) => (c.name || c.email) && c.company?.org_domain);
  if (!withTarget.length) { console.log('Nada a fazer.'); return; }

  // Agrupa por domínio (uma decisão de catch-all por domínio).
  const byDomain = new Map();
  for (const c of withTarget) {
    const dom = c.company.org_domain;
    if (!byDomain.has(dom)) byDomain.set(dom, []);
    byDomain.get(dom).push(c);
  }
  const domains = [...byDomain.entries()].map(([domain, cs]) => ({ domain, contacts: cs }));
  console.log(`${withTarget.length} contactos em ${domains.length} domínios. Concorrência ${CONCURRENCY}.`);

  const mxCache = new Map();
  const counts = {};
  const merge = (c) => { for (const [k, v] of Object.entries(c)) counts[k] = (counts[k] || 0) + v; };
  let stopped = false;

  // Mesma lógica que o worker distribuído (lib/verify-core.js verifyDomain): uma
  // decisão de catch-all por domínio + routing API/Reacher. Quando a quota free
  // esgota (hasCapacity=false, ou PoolExhaustedError a meio) pára de alimentar
  // domínios — os contactos restantes ficam email_status=null p/ o próximo lote.
  await pool(domains, CONCURRENCY, async ({ domain, contacts: cs }) => {
    if (stopped || !hasCapacity(providers, reacher)) { stopped = true; return; }
    try {
      merge(await verifyDomain(client, { domain, contacts: cs }, { providers, reacher, maxCand: MAX_CAND, dry: DRY, mxCache }));
    } catch (e) {
      if (e.exhausted) { stopped = true; return; }
      throw e;
    }
    await sleep(100);
  });

  console.log(`\nConcluído. ${JSON.stringify(counts)}`);
  if (stopped) console.log('⚠ quota free esgotada — contactos restantes ficam por verificar (email_status=null) e voltam no próximo lote.');
  if (providers.count) console.log(`Contas API restantes com créditos: ${providers.accounts.filter((a) => !a.exhausted).length}/${providers.count}`);
}

main().catch((err) => {
  console.error('Erro fatal:', err.errors ? JSON.stringify(err.errors, null, 2) : err);
  process.exit(1);
});
