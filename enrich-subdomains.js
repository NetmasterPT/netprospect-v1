// enrich-subdomains.js
//
// Para cada site no Directus, enumera os subdomínios via crt.sh (Certificate
// Transparency) e grava-os em `sites.hostnames`. É uma fase posterior à
// descoberta+enriquecimento: expande a superfície conhecida de cada domínio
// (ex: loja.empresa.pt, dev.empresa.pt) para prospeção/análise.
//
// Uso:
//   node enrich-subdomains.js                     (todos os sites live sem hostnames)
//   node enrich-subdomains.js --qualified-only     (só sites qualificados)
//   node enrich-subdomains.js --limit=20 --active-only --force
//
// NOTA: o crt.sh é um serviço partilhado e limita ligações — concorrência baixa
// por omissão (4) e uma pausa entre pedidos. Não aumentar agressivamente.

import { readItems, updateItem } from '@directus/sdk';
import { makeClient } from './lib/directus.js';
import { fetchNames } from './lib/crtsh.js';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const f = argv.find((a) => a.startsWith(`--${name}=`));
  return f ? f.split('=').slice(1).join('=') : dflt;
};
const LIMIT = flag('limit', null) ? parseInt(flag('limit'), 10) : null;
const CONCURRENCY = Math.max(1, parseInt(flag('concurrency', '2'), 10) || 2);
const QUALIFIED_ONLY = argv.includes('--qualified-only');
const ACTIVE_ONLY = argv.includes('--active-only');
const FORCE = argv.includes('--force');
const DELAY_MS = 400; // pausa entre domínios, por respeito ao crt.sh

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

  // Sites a processar: live, (opcional) qualificados, e ainda sem hostnames
  // (salvo --force). O filtro hostnames _null evita reprocessar.
  const filter = { is_live: { _eq: true } };
  if (QUALIFIED_ONLY) filter.qualified = { _eq: true };
  if (!FORCE) filter.hostnames = { _null: true };

  let sites = await client.request(
    readItems('sites', { filter, fields: ['id', 'domain'], limit: LIMIT || -1, sort: ['domain'] })
  );
  if (!sites.length) {
    console.log('Nada a fazer (todos os sites já têm hostnames, ou nenhum corresponde ao filtro).');
    return;
  }
  console.log(`A enumerar subdomínios de ${sites.length} sites via crt.sh (concorrência ${CONCURRENCY})...`);

  let done = 0, withSubs = 0, totalSubs = 0, failed = 0;
  await pool(sites, CONCURRENCY, async (site) => {
    try {
      const { names } = await fetchNames(site.domain, { activeOnly: ACTIVE_ONLY });
      // Exclui o próprio apex e o www (queremos subdomínios "reais").
      const subs = names.filter((n) => n !== site.domain && n !== `www.${site.domain}`);
      await client.request(updateItem('sites', site.id, { hostnames: subs }));
      done++;
      if (subs.length) { withSubs++; totalSubs += subs.length; }
      if (done % 10 === 0 || done === sites.length) {
        console.log(`  ${done}/${sites.length} | com subdomínios: ${withSubs} | total subdomínios: ${totalSubs} | falhas: ${failed}`);
      }
    } catch (e) {
      failed++;
      console.error(`  ! ${site.domain}: ${e.message?.trim() || e.code || e.name || 'crt.sh transitório (fica p/ retentar)'}`);
      // hostnames fica null -> será tentado de novo numa próxima corrida.
    }
    await sleep(DELAY_MS);
  });

  console.log(`\nConcluído. Processados: ${done} | com subdomínios: ${withSubs} | subdomínios totais: ${totalSubs} | falhas: ${failed}`);
}

main().catch((err) => {
  console.error('Erro fatal:', err.errors ? JSON.stringify(err.errors, null, 2) : err);
  process.exit(1);
});
