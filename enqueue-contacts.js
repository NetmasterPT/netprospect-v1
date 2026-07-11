// enqueue-contacts.js — publica jobs.contacts para sites QUALIFICADOS que ainda não
// têm contactos extraídos (contacts_checked_at null) + têm empresa. Para os sites
// enriquecidos pelo caminho standalone (que não faz extração). Retomável, dedup por
// Nats-Msg-Id. O worker (WORKER_ROLES=base) drena via handleContacts.
//
// Uso:  node enqueue-contacts.js --tld=nl
//       node enqueue-contacts.js --tld=nl --limit=1000 --force
import { readItems } from '@directus/sdk';
import { makeClient } from './lib/directus.js';
import { connectJobs, ensureStream, publishJob, SUBJECTS } from './lib/jobs.js';

const argv = process.argv.slice(2);
const flag = (n, d) => { const f = argv.find((a) => a.startsWith(`--${n}=`)); return f ? f.split('=').slice(1).join('=') : d; };
const LIMIT = flag('limit', null) ? parseInt(flag('limit'), 10) : null;
const TLD = flag('tld', null);
const FORCE = argv.includes('--force');

async function main() {
  const client = makeClient();
  const nc = await connectJobs();
  await ensureStream(nc);
  const js = nc.jetstream();

  const base = { qualified: { _eq: true }, company: { _nnull: true } };
  if (!FORCE) base.contacts_checked_at = { _null: true };
  if (TLD) base.domain = { _ends_with: '.' + TLD.replace(/^\.+/, '').toLowerCase() };

  let lastId = 0, jobs = 0;
  for (;;) {
    const rows = await client.request(readItems('sites', {
      filter: { ...base, id: { _gt: lastId } }, fields: ['id', 'domain'], sort: ['id'], limit: 500,
    }));
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id;
    for (const s of rows) {
      await publishJob(js, SUBJECTS.contacts, { domain: s.domain, siteId: s.id }, { msgId: `contacts:${s.domain}` });
      if (++jobs % 2000 === 0) console.log(`  ${jobs} jobs contacts publicados…`);
      if (LIMIT && jobs >= LIMIT) break;
    }
    if (LIMIT && jobs >= LIMIT) break;
  }
  console.log(`Concluído. ${jobs} jobs.contacts publicados${TLD ? ` (.${TLD})` : ''} (dedup por Nats-Msg-Id).`);
  await nc.drain();
}
main().catch((e) => { console.error('Erro:', e.errors ? JSON.stringify(e.errors) : e.message); process.exit(1); });
