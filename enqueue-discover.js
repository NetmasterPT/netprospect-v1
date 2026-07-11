// enqueue-discover.js
// Produtor da DESCOBERTA-como-job: para um TLD, obtém a lista de blocos do índice
// colunar do Common Crawl e publica UM `jobs.discover` por bloco. Os workers base
// colhem cada bloco (byte-range independente → sharding natural entre IPs/servidores,
// Fase C) e publicam `jobs.fetch` por domínio, alimentando o DAG fino.
//
// Uso: node enqueue-discover.js --tld=pt [--crawls=1]
//   (mantém-se também o modo standalone `node tld-domains-v2.js pt`)

import { getBlocks, CRAWL_IDS } from './tld-domains-v2.js';
import { connectJobs, ensureStream, publishJob, SUBJECTS } from './lib/jobs.js';

const argv = process.argv.slice(2);
const flag = (n, d) => { const f = argv.find((a) => a.startsWith(`--${n}=`)); return f ? f.split('=')[1] : d; };
const TLD = (flag('tld', 'pt')).replace(/^\.+/, '').toLowerCase();
const NUM_CRAWLS = Math.max(1, parseInt(flag('crawls', '1'), 10) || 1);

async function main() {
  const nc = await connectJobs();
  await ensureStream(nc);
  const js = nc.jetstream();
  let total = 0;
  for (const crawlId of CRAWL_IDS.slice(0, NUM_CRAWLS)) {
    let blocks;
    try { blocks = await getBlocks(crawlId, TLD); }
    catch (e) { console.error(`${crawlId}: cluster.idx falhou (${e.message}) — a saltar.`); continue; }
    for (const block of blocks) { await publishJob(js, SUBJECTS.discover, { crawlId, block, tld: TLD }, { msgId: `discover:${crawlId}:${TLD}:${block.i}` }); total++; }
    console.log(`${crawlId} .${TLD}: ${blocks.length} blocos enfileirados.`);
  }
  console.log(`Concluído. ${total} jobs.discover publicados p/ .${TLD}.`);
  await nc.drain();
}

main().catch((err) => { console.error('Erro fatal:', err.message); process.exit(1); });
