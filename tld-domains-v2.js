// tld-domains-v2.js  (revisto)
//
// Descoberta de domínios de um TLD via ÍNDICE COLUNAR do Common Crawl em S3
// (data.commoncrawl.org) — a CDX API (index.commoncrawl.org) está inacessível.
//
// LIÇÕES / CORREÇÕES desta revisão:
//   * O data.commoncrawl.org (CloudFront) faz RATE-LIMIT e responde HTTP 403
//     quando há pedidos a mais. NÃO correr vários TLDs em paralelo nem com
//     concorrência alta — corre UM TLD de cada vez, concorrência baixa.
//   * 403/429/503 são tratados como TRANSITÓRIOS (backoff longo + jitter) — o
//     limite alivia se abrandarmos, por isso vale a pena esperar e repetir.
//   * Blocos que falham NÃO são dados como feitos (o checkpoint guarda o conjunto
//     de blocos concluídos com SUCESSO) e são repetidos em voltas extra.
//   * Logging detalhado (usa --verbose para ver cada tentativa).
//
// Uso:
//   node tld-domains-v2.js no                      (3 crawls, concorrência 6)
//   node tld-domains-v2.js no --crawls=1 --concurrency=4 --verbose
//   node tld-domains-v2.js no --restart

import fs from 'fs';
import path from 'path';
import zlib from 'node:zlib';
import { execFileSync } from 'child_process';
import { getDomain } from 'tldts';

export const CRAWL_IDS = ['CC-MAIN-2026-25', 'CC-MAIN-2026-21', 'CC-MAIN-2026-17'];
const S3 = 'https://data.commoncrawl.org/cc-index/collections';
// UA de browser: a CloudFront da CC tende a devolver 403 a UAs não-browser.
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAX_RETRIES = 8;
const RETRY_PASSES = 4;
const REQUEST_TIMEOUT_MS = 60000;

// Throttle GLOBAL: espaçamento mínimo entre pedidos (o IP deste ambiente é
// fortemente rate-limitado pela CC). --delay=<ms> ajusta; por omissão 800ms.
let _nextSlot = 0;
async function throttle(delayMs) {
  if (delayMs <= 0) return;
  const t = Date.now();
  const wait = Math.max(0, _nextSlot - t);
  _nextSlot = Math.max(t, _nextSlot) + delayMs;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith('--'));
const positional = argv.filter((a) => !a.startsWith('--'));
const TLD = (positional[0] || 'pt').replace(/^\.+/, '').toLowerCase().trim();
const OUTPUT_FILE = positional[1] || `out/dominios_${TLD.replace(/[^a-z0-9._-]/g, '_')}.txt`;
const RAW_FILE = `${OUTPUT_FILE}.raw`;
const PROGRESS_FILE = `${OUTPUT_FILE}.progress.json`;
const RESTART = flags.includes('--restart');
const VERBOSE = flags.includes('--verbose');
const getFlag = (n, d) => { const f = flags.find((x) => x.startsWith(`--${n}=`)); return f ? f.split('=')[1] : d; };
const NUM_CRAWLS = Math.max(1, parseInt(getFlag('crawls', '3'), 10) || 3);
const CONCURRENCY = Math.max(1, parseInt(getFlag('concurrency', '3'), 10) || 3);
const DELAY_MS = parseInt(getFlag('delay', '800'), 10) || 0; // espaçamento mínimo entre pedidos

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`${now()} ${m}`);
const vlog = (m) => { if (VERBOSE) console.log(`${now()}   ${m}`); };

const isTransient = (msg) => /HTTP (403|429|500|502|503)|aborted|timeout|fetch failed|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket/i.test(msg || '');

// Contadores globais para diagnóstico.
const stat = { req: 0, retry: 0, r403: 0, r503: 0, other: 0 };

async function fetchBuf(url, { range, label = 'req' } = {}) {
  for (let attempt = 1; ; attempt++) {
    await throttle(DELAY_MS);
    stat.req++;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, ...(range ? { Range: `bytes=${range}` } : {}) } });
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      const msg = err.message || String(err);
      if (/HTTP 403/.test(msg)) stat.r403++; else if (/HTTP 503|429/.test(msg)) stat.r503++; else stat.other++;
      if (!isTransient(msg) || attempt > MAX_RETRIES) throw new Error(msg);
      stat.retry++;
      // 403 = throttle da CloudFront -> esperar bastante mais.
      const base = /HTTP 403|429/.test(msg) ? 3000 : 1200;
      const backoff = Math.min(base * 2 ** (attempt - 1), 60000) + Math.floor(Math.random() * 800);
      vlog(`↻ ${label} tentativa ${attempt}/${MAX_RETRIES}: ${msg} — espera ${backoff}ms`);
      await sleep(backoff);
    } finally { clearTimeout(t); }
  }
}

// Exportado: lista de blocos (byte-ranges de shards CDX) que cobrem o TLD. Cada
// bloco é fetchável independentemente → unidade natural p/ sharding entre workers.
export async function getBlocks(crawlId, tld = TLD) {
  const idx = (await fetchBuf(`${S3}/${crawlId}/indexes/cluster.idx`, { label: 'cluster.idx' })).toString();
  const pref = tld + ',';
  const lines = idx.split('\n').filter(Boolean);
  const blocks = [];
  let prev = null;
  for (const line of lines) {
    const surt = line.split(' ')[0];
    const p = line.split('\t');
    const blk = { cdxFile: p[1], offset: +p[2], length: +p[3] };
    if (surt.startsWith(pref)) { if (!blocks.length && prev) blocks.push(prev); blocks.push(blk); }
    prev = blk;
  }
  return blocks.map((b, i) => ({ ...b, i }));
}

// Exportado: colhe os domínios apex de um bloco e DEVOLVE-os (para o job discover).
export async function harvestBlockDomains(crawlId, block, tld = TLD) {
  const buf = await fetchBuf(`${S3}/${crawlId}/indexes/${block.cdxFile}`, { range: `${block.offset}-${block.offset + block.length - 1}`, label: `bloco #${block.i}` });
  const text = zlib.gunzipSync(buf).toString();
  const pref = tld + ',';
  const suffix = '.' + tld;
  const out = new Set();
  for (const line of text.split('\n')) {
    if (!line.startsWith(pref)) continue;
    const cut = line.indexOf(')'); const sp = line.indexOf(' ');
    const hostPart = line.slice(0, cut >= 0 && cut < sp ? cut : sp);
    const apex = getDomain(hostPart.split(',').reverse().join('.'));
    if (apex && apex.endsWith(suffix)) out.add(apex.toLowerCase());
  }
  return [...out];
}

async function harvestBlock(crawlId, block, stream) {
  const doms = await harvestBlockDomains(crawlId, block);
  for (const d of doms) stream.write(d + '\n');
  return doms.length;
}

async function pool(items, n, worker) {
  let i = 0;
  const run = async () => { while (i < items.length) { const idx = i++; await worker(items[idx]); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}

async function main() {
  const dir = path.dirname(OUTPUT_FILE);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  let progress = { done: {}, finished: {} };
  if (RESTART) { try { fs.unlinkSync(RAW_FILE); } catch {} try { fs.unlinkSync(PROGRESS_FILE); } catch {} }
  else if (fs.existsSync(PROGRESS_FILE)) { try { const p = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); if (p.done) progress = p; } catch {} }

  const crawls = CRAWL_IDS.slice(0, NUM_CRAWLS);
  log(`[v2/S3] .${TLD} — crawls: ${crawls.join(', ')} | concorrência ${CONCURRENCY}${VERBOSE ? ' | verbose' : ''}`);
  log(`AVISO: correr só UM TLD de cada vez. 403 = rate-limit da CloudFront (concorrência/paralelismo a mais).`);

  const raw = fs.createWriteStream(RAW_FILE, { flags: 'a' });
  const save = () => fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ done: Object.fromEntries(Object.entries(progress.done).map(([k, v]) => [k, [...v]])), finished: progress.finished }));

  for (const crawlId of crawls) {
    if (progress.finished[crawlId]) { log(`${crawlId}: já concluído.`); continue; }
    let blocks;
    try { blocks = await getBlocks(crawlId); }
    catch (e) { log(`${crawlId}: cluster.idx falhou definitivamente (${e.message}). A saltar — reduz concorrência/para outros processos.`); continue; }

    const done = new Set(progress.done[crawlId] || []);
    progress.done[crawlId] = done;
    let pending = blocks.filter((b) => !done.has(b.i));
    log(`${crawlId}: ${blocks.length} blocos (${done.size} já feitos, ${pending.length} por fazer)`);

    let records = 0, processed = 0;
    for (let pass = 1; pass <= RETRY_PASSES && pending.length; pass++) {
      if (pass > 1) { const wait = 5000 * pass; log(`${crawlId}: volta ${pass} — ${pending.length} blocos por repetir (espera ${wait}ms para o rate-limit aliviar)…`); await sleep(wait); }
      const failed = [];
      await pool(pending, CONCURRENCY, async (blk) => {
        try {
          records += await harvestBlock(crawlId, blk, raw);
          done.add(blk.i); processed++;
          if (processed % 25 === 0) { save(); log(`${crawlId} | feitos ${done.size}/${blocks.length} | registos ${records} | 403:${stat.r403} 503:${stat.r503} retries:${stat.retry}`); }
        } catch (e) {
          failed.push(blk);
          log(`  ✗ ${crawlId} bloco #${blk.i} ${blk.cdxFile} -> ${e.message}`);
        }
      });
      save();
      pending = failed;
    }
    if (!pending.length) progress.finished[crawlId] = true;
    save();
    log(`${crawlId}: concluído ${done.size}/${blocks.length} blocos | ${pending.length} perdidos | ${records} registos`);
  }

  raw.end();
  await new Promise((r) => raw.on('finish', r));
  let count = 0;
  if (fs.existsSync(RAW_FILE)) {
    execFileSync('sort', ['-u', RAW_FILE, '-o', OUTPUT_FILE]);
    count = parseInt(execFileSync('wc', ['-l', OUTPUT_FILE]).toString().trim().split(/\s+/)[0], 10) || 0;
  } else fs.writeFileSync(OUTPUT_FILE, '');
  if (crawls.every((c) => progress.finished[c])) { try { fs.unlinkSync(RAW_FILE); } catch {} try { fs.unlinkSync(PROGRESS_FILE); } catch {} }
  log(`[v2] Concluído. ${count} domínios .${TLD} únicos em ${OUTPUT_FILE}. (pedidos: ${stat.req}, 403: ${stat.r403}, 503: ${stat.r503}, retries: ${stat.retry})`);
}

// Só corre o CLI quando invocado diretamente (não quando importado pelo worker).
if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error('Erro fatal:', err); process.exit(1); });
}
