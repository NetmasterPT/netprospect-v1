// enqueue-email-verification.js
// Enfileira jobs `jobs.verify` (um por DOMÍNIO da empresa) para a frota de workers
// de verificação (VMs remotas, WORKER_ROLES=verify). PRIORIZA leads valiosas:
// percorre os contactos por-verificar ordenados pelo lead_score do site (desc), e
// publica cada org_domain uma vez. O worker valida TODOS os contactos-null desse
// domínio (uma decisão de catch-all por domínio) usando as chaves free LOCAIS ao IP.
//
// Auto-throttling: cada worker pára quando esgota a quota free do dia; os contactos
// não processados ficam email_status=null e voltam no lote seguinte. Por isso corre
// isto UMA VEZ POR DIA com --limit ≈ capacidade da frota (em domínios).
//
// Uso:
//   node enqueue-email-verification.js --limit=500            # top-500 domínios por lead_score
//   node enqueue-email-verification.js --tld=pt --limit=300
//   node enqueue-email-verification.js --dry-run --limit=20   # mostra sem publicar
//
// Capacidade: emails/dia ≈ domínios × (contactos/domínio). Ver o README (§ frota de
// verificação) para a matemática por provider/IP/conta.

import { readItems } from '@directus/sdk';
import { makeClient } from './lib/directus.js';
import { connectJobs, ensureStream, publishJob, SUBJECTS } from './lib/jobs.js';

const argv = process.argv.slice(2);
const flag = (n, d) => { const f = argv.find((a) => a.startsWith(`--${n}=`)); return f ? f.split('=').slice(1).join('=') : d; };
const LIMIT = flag('limit', null) ? parseInt(flag('limit'), 10) : 1000; // domínios por lote (default seguro)
const MIN_SCORE = flag('min-score', null) ? parseInt(flag('min-score'), 10) : null; // só sites com lead_score >= N
const TLD = flag('tld', null);
const DRY = argv.includes('--dry-run');
const PAGE = 500;

async function main() {
  const client = makeClient();
  // lead_score nnull → o sort -site.lead_score fica correto (Postgres põe NULLs primeiro
  // em DESC; os 571 sites sem score, ~0.1%, ficam p/ uma passagem final sem prioridade).
  const filter = { email_status: { _null: true }, company: { org_domain: { _nnull: true } }, site: { lead_score: { _nnull: true } } };
  if (MIN_SCORE != null) filter.site.lead_score = { _gte: MIN_SCORE };
  if (TLD) filter.site.domain = { _ends_with: '.' + TLD.replace(/^\.+/, '').toLowerCase() };

  let js = null, nc = null;
  if (!DRY) { nc = await connectJobs(); await ensureStream(nc); js = nc.jetstream(); }

  console.log(`A enfileirar verify (top ${LIMIT} domínios por lead_score)${TLD ? ` .${TLD}` : ''}${DRY ? '  [DRY-RUN]' : ''}...`);
  const seen = new Set();
  let offset = 0, jobs = 0, scanned = 0;
  outer: for (;;) {
    // Contactos por-verificar ordenados pelo lead_score do SEU site (desc) → prioridade.
    const rows = await client.request(readItems('contacts', {
      filter, fields: ['company.org_domain', 'site.lead_score'], sort: ['-site.lead_score'], limit: PAGE, offset,
    }));
    if (!rows.length) break;
    offset += rows.length; scanned += rows.length;
    for (const c of rows) {
      const dom = c.company?.org_domain;
      if (!dom || seen.has(dom)) continue;
      seen.add(dom);
      if (DRY) { if (jobs < 40) console.log(`  ${dom}  (lead_score do site: ${c.site?.lead_score ?? '-'})`); }
      else await publishJob(js, SUBJECTS.verify, { domain: dom }, { msgId: `verify:${dom}` });
      if (++jobs >= LIMIT) break outer;
    }
    if (rows.length < PAGE) break;
  }

  console.log(`\n${DRY ? 'Enfileiraria' : 'Enfileirados'} ${jobs} domínios (de ${scanned} contactos-null percorridos).`);
  if (DRY) console.log('[DRY-RUN] nada publicado. Correr sem --dry-run para enfileirar.');
  else { console.log('Workers verify (WORKER_ROLES=verify) vão drenar jobs.verify. Ver README § frota de verificação.'); await nc.drain(); }
}

main().catch((e) => { console.error('Erro fatal:', e.errors ? JSON.stringify(e.errors) : e.message); process.exit(1); });
