// enqueue-domain-health.js — Fase D backfill.
// Publica os jobs finos de saúde de domínio para o conjunto QUALIFICADO (vivo),
// que foi enriquecido pelo path standalone e por isso não tem ssl_grade/dns_provider/
// whois/cms preenchidos (esses campos só populam em corridas NOVAS do DAG).
//
// Uso:
//   node enqueue-domain-health.js                          # ssl+dnsprovider, qualificados sem ssl_grade
//   node enqueue-domain-health.js --only=ssl,dnsprovider,whois,cms
//   node enqueue-domain-health.js --tld=se --limit=5000
//   node enqueue-domain-health.js --force                  # inclui os já feitos
//
// only:
//   ssl         → jobs.ssl          (handshake TLS; grade + expiração)
//   dnsprovider → jobs.dnsprovider  (NS autoritativo)
//   whois       → jobs.whois        (registrar/datas; ATENÇÃO: os WHOIS servers têm
//                                     rate-limit — correr em lotes/off-peak, não a 379k)
//   cms         → jobs.fingerprint  (re-fetch da homepage → cms_version/cms_outdated)
//
// Resume: por omissão salta os sites cujo campo do 1.º job pedido já está preenchido
// (ex.: ssl_grade IS NOT NULL). `--force` reprocessa tudo. Dedup por Nats-Msg-Id (24h).

import { readItems } from '@directus/sdk';
import { makeClient } from './lib/directus.js';
import { connectJobs, ensureStream, publishJob, SUBJECTS } from './lib/jobs.js';

const argv = process.argv.slice(2);
const flag = (n, d) => { const f = argv.find((a) => a.startsWith(`--${n}=`)); return f ? f.split('=')[1] : d; };
const LIMIT = flag('limit', null) ? parseInt(flag('limit'), 10) : null;
const TLD = flag('tld', null);
const FORCE = argv.includes('--force');
const ONLY = flag('only', 'ssl,dnsprovider').split(',').map((s) => s.trim()).filter(Boolean);
const PAGE = 500;

const SUBJ = { ssl: SUBJECTS.ssl, dnsprovider: SUBJECTS.dnsprovider, whois: SUBJECTS.whois, cms: SUBJECTS.fingerprint };
// NOTA: o resume do cms NÃO pode ser 'cms_version' — só ~5% dos sites expõem versão de CMS, logo
// os restantes ficavam NULL e eram re-enfileirados para SEMPRE (loop infinito de re-fingerprint).
// 'tech_detected' é o que o fingerprint escreve sempre que corre com sucesso. (O ideal seria uma
// coluna cms_checked_at, como o whois_checked_at — ver follow-up.)
const RESUME_FIELD = { ssl: 'ssl_grade', dnsprovider: 'dns_provider', whois: 'whois_checked_at', cms: 'tech_detected' };

// Sharding por hash do domínio p/ dar uma fatia DISJUNTA a uma fila dedicada (ex.: DE1):
//   --shard=i/N        → SÓ os domínios com hash%N==i        (o feeder do DE1)
//   --shard-not=i/N    → SALTA esses                          (o enqueue principal salta o shard do DE1)
//   --subject-prefix=X → publica em `X`+subject (ex.: "de1." → de1.jobs.fingerprint)
// O hash é igual dos dois lados ⇒ shards complementares ⇒ zero duplicados.
const SHARD = flag('shard', null);
const SHARD_NOT = flag('shard-not', null);
const SUBJ_PREFIX = flag('subject-prefix', '');
const dhash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h; };
const shardKeep = (domain) => {
  if (SHARD) { const [i, n] = SHARD.split('/').map(Number); return dhash(domain) % n === i; }
  if (SHARD_NOT) { const [i, n] = SHARD_NOT.split('/').map(Number); return dhash(domain) % n !== i; }
  return true;
};

async function main() {
  const bad = ONLY.filter((o) => !SUBJ[o]);
  if (bad.length) { console.error(`--only inválido: ${bad.join(',')} (válidos: ${Object.keys(SUBJ).join(',')})`); process.exit(1); }
  const client = makeClient();
  const nc = await connectJobs();
  await ensureStream(nc);
  const js = nc.jetstream();

  const base = { qualified: { _eq: true }, is_live: { _eq: true } };
  if (TLD) base.domain = { _ends_with: `.${TLD}` };
  const resumeField = RESUME_FIELD[ONLY[0]];
  if (!FORCE && resumeField) base[resumeField] = { _null: true };

  console.log(`Backfill saúde de domínio → ${ONLY.join('+')} | qualificados vivos${TLD ? ` .${TLD}` : ''}${FORCE ? ' (force)' : ` (só ${resumeField} IS NULL)`}${LIMIT ? ` | limite ${LIMIT}` : ''}`);
  let lastId = 0, sites = 0, jobs = 0;
  for (;;) {
    if (LIMIT && sites >= LIMIT) break;
    // Ao fazer shard lemos a página cheia (a maioria é saltada) — o LIMIT conta os MANTIDOS.
    const pageSize = (SHARD || SHARD_NOT) ? PAGE : (LIMIT ? Math.min(PAGE, LIMIT - sites) : PAGE);
    const rows = await client.request(readItems('sites', { filter: { ...base, id: { _gt: lastId } }, fields: ['id', 'domain'], sort: ['id'], limit: pageSize }));
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id;
    for (const s of rows) {
      if (!shardKeep(s.domain)) continue;
      if (LIMIT && sites >= LIMIT) break;
      for (const o of ONLY) { await publishJob(js, SUBJ_PREFIX + SUBJ[o], { domain: s.domain, siteId: s.id, force: FORCE }, { msgId: `${o}:${s.domain}` }); jobs++; }
      sites++;
    }
    console.log(`  ${sites} sites / ${jobs} jobs enfileirados`);
  }
  console.log(`Concluído. ${sites} sites, ${jobs} jobs publicados (${ONLY.join('+')}).`);
  await nc.drain();
}

main().catch((err) => { console.error('Erro fatal:', err.errors ? JSON.stringify(err.errors) : err.message); process.exit(1); });
