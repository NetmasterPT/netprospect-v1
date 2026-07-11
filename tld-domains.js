// tld-domains.js
//
// Produz uma lista de domínios de um TLD (por omissão .pt) que estão REGISTADOS
// e COM SITE ATIVO — um domínio por empresa (forma apex/registável, ex:
// `empresa.pt`, `loja.com.pt`) — para servir de "semente" à pipeline de prospeção.
//
// Fonte: índice URL do Common Crawl (CDX). Reduz cada URL ao domínio registável
// (eTLD+1) via `tldts` (respeita sufixos de 2.º nível como com.pt).
//
// RESILIÊNCIA (o servidor de índice do CC é MUITO instável — 503 / fetch failed):
//   - RESUMÍVEL: escreve os domínios em `<saida>.raw` à medida que avança e guarda
//     o progresso em `<saida>.progress.json`. Se for interrompido, retomar continua
//     de onde parou (usa --restart para recomeçar do zero). No fim faz `sort -u`.
//   - collinfo em falta -> usa uma lista de crawls de reserva (não aborta).
//   - nº de páginas (numPages) em falta -> PAGINAÇÃO CEGA (página 0,1,2... até vazio),
//     em vez de saltar o crawl inteiro.
//   - Backoff exponencial com jitter e teto, mais tentativas.
//
// Uso:
//   node tld-domains.js pt                 (junta os 3 crawls mais recentes)
//   node tld-domains.js nl --crawls=2      (.nl é enorme; corre em background)
//   node tld-domains.js fi --restart       (ignora o checkpoint e recomeça)
//   node tld-domains.js pt out/pt.txt --max-pages=2   (debug)

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { getDomain } from 'tldts';

const COLLINFO_URL = 'https://index.commoncrawl.org/collinfo.json';
// Crawls de reserva (recentes) para quando o collinfo.json está indisponível.
const FALLBACK_CRAWL_IDS = ['CC-MAIN-2026-25', 'CC-MAIN-2026-21', 'CC-MAIN-2026-17'];
const REQUEST_TIMEOUT_MS = 60000;
const DELAY_MS = 300;
const MAX_RETRIES = 8;
const BLIND_END_STREAK = 3; // páginas vazias/falhadas seguidas => fim (paginação cega)

// --- Argumentos --------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith('--'));
const positional = argv.filter((a) => !a.startsWith('--'));

const TLD = (positional[0] || 'pt').replace(/^\.+/, '').toLowerCase().trim();
const OUTPUT_FILE = positional[1] || `out/dominios_${TLD.replace(/[^a-z0-9._-]/g, '_')}.txt`;
const RAW_FILE = `${OUTPUT_FILE}.raw`;
const PROGRESS_FILE = `${OUTPUT_FILE}.progress.json`;
const RESTART = flags.includes('--restart');

const getFlag = (name, dflt) => {
  const f = flags.find((x) => x.startsWith(`--${name}=`));
  return f ? f.split('=')[1] : dflt;
};
const NUM_CRAWLS = Math.max(1, parseInt(getFlag('crawls', '3'), 10) || 3);
const MAX_PAGES = getFlag('max-pages', null) ? parseInt(getFlag('max-pages'), 10) : null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- HTTP com timeout + retry ------------------------------------------------
const isTransient = (err) =>
  /aborted|timeout|fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|network|503|502|500|429|SlowDown/i.test(err.message || '');

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'netprospect-tld-domains' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function withRetry(fn, label) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransient(err) || attempt > MAX_RETRIES) throw err;
      const backoff = Math.min(DELAY_MS * 2 ** attempt, 30000) + Math.floor(Math.random() * 500);
      console.error(`  ${label}: tentativa ${attempt}/${MAX_RETRIES} falhou (${err.message}). A repetir em ${backoff}ms...`);
      await sleep(backoff);
    }
  }
}

// --- Common Crawl ------------------------------------------------------------
async function getRecentCrawls(n) {
  try {
    const list = JSON.parse(await withRetry(() => fetchText(COLLINFO_URL), 'collinfo'));
    return list.slice(0, n).map((c) => ({ id: c.id, cdx: c['cdx-api'] }));
  } catch (e) {
    console.error(`collinfo indisponível (${e.message}) — a usar lista de crawls de reserva.`);
    return FALLBACK_CRAWL_IDS.slice(0, n).map((id) => ({ id, cdx: `https://index.commoncrawl.org/${id}-index` }));
  }
}

const cdxQuery = (cdxApi, extra) => `${cdxApi}?url=${encodeURIComponent('*.' + TLD)}&output=json${extra}`;

async function getNumPages(cdxApi) {
  const text = await withRetry(() => fetchText(cdxQuery(cdxApi, '&showNumPages=true')), 'numPages');
  return JSON.parse(text).pages || 0;
}

const fetchPage = (cdxApi, page) => withRetry(() => fetchText(cdxQuery(cdxApi, `&fl=url&page=${page}`)), `página ${page}`);

// Escreve os domínios apex desta página no stream. Devolve o nº de registos vistos.
function harvestToStream(text, stream) {
  const suffix = '.' + TLD;
  let scanned = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let url;
    try { url = JSON.parse(line).url; } catch { continue; }
    scanned++;
    const apex = getDomain(url);
    if (apex && apex.endsWith(suffix)) stream.write(apex.toLowerCase() + '\n');
  }
  return scanned;
}

// --- Principal ---------------------------------------------------------------
async function main() {
  if (!TLD) {
    console.error('Uso: node tld-domains.js <tld> [ficheiro-saida] [--crawls=N] [--restart] [--max-pages=N]');
    process.exit(1);
  }
  const dir = path.dirname(OUTPUT_FILE);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });

  let progress = { doneByCrawl: {}, finished: {} };
  if (RESTART) {
    try { fs.unlinkSync(RAW_FILE); } catch { /* ok */ }
    try { fs.unlinkSync(PROGRESS_FILE); } catch { /* ok */ }
  } else if (fs.existsSync(PROGRESS_FILE)) {
    try { progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); } catch { /* ignora */ }
    console.log(`A retomar checkpoint: ${JSON.stringify(progress.doneByCrawl)}`);
  }

  console.log(`A descobrir domínios .${TLD} via Common Crawl (${NUM_CRAWLS} crawl(s))...`);
  const crawls = await getRecentCrawls(NUM_CRAWLS);
  console.log(`Crawls: ${crawls.map((c) => c.id).join(', ')}`);

  const raw = fs.createWriteStream(RAW_FILE, { flags: 'a' });
  const saveProgress = () => fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress));

  let totalScanned = 0;
  let failedPages = 0;

  for (const { id, cdx } of crawls) {
    if (progress.finished[id]) { console.log(`Crawl ${id}: já concluído, a saltar.`); continue; }

    let pages = null;
    try { pages = await getNumPages(cdx); }
    catch (e) { console.error(`Crawl ${id}: numPages falhou (${e.message}) — PAGINAÇÃO CEGA.`); pages = null; }

    const startPage = (progress.doneByCrawl[id] ?? -1) + 1;
    const hardLimit = MAX_PAGES ? MAX_PAGES : (pages ?? Infinity);
    console.log(`\n${id}: ${pages != null ? pages + ' páginas' : 'paginação cega'} — a começar na página ${startPage}`);

    let streak = 0;
    for (let p = startPage; p < hardLimit; p++) {
      let text = null;
      let ok = true;
      try { text = await fetchPage(cdx, p); }
      catch (e) { ok = false; failedPages++; console.error(`  ${id} pág ${p}: falhou (${e.message}). A continuar.`); }

      const scanned = ok ? harvestToStream(text, raw) : 0;
      totalScanned += scanned;
      progress.doneByCrawl[id] = p;
      if (p % 5 === 0) saveProgress();

      if (pages == null) { // paginação cega: detetar o fim
        if (!ok || scanned === 0) {
          if (++streak >= BLIND_END_STREAK) { console.log(`  ${id}: fim da paginação cega (pág ${p}).`); break; }
        } else streak = 0;
      }
      if (p % 10 === 0 || (pages != null && p === hardLimit - 1)) {
        console.log(`  ${id} | página ${p}${pages != null ? '/' + pages : ''} | registos: ${scanned}`);
      }
      await sleep(DELAY_MS);
    }
    progress.finished[id] = true;
    saveProgress();
  }

  raw.end();
  await new Promise((r) => raw.on('finish', r));

  // Dedup + ordena (external sort, seguro para TLDs enormes como .nl).
  let count = 0;
  if (fs.existsSync(RAW_FILE)) {
    execFileSync('sort', ['-u', RAW_FILE, '-o', OUTPUT_FILE]);
    count = parseInt(execFileSync('wc', ['-l', OUTPUT_FILE]).toString().trim().split(/\s+/)[0], 10) || 0;
  } else {
    fs.writeFileSync(OUTPUT_FILE, '');
  }

  // Limpeza dos ficheiros de trabalho (só quando tudo terminou).
  const allDone = crawls.every((c) => progress.finished[c.id]);
  if (allDone && !MAX_PAGES) {
    try { fs.unlinkSync(RAW_FILE); } catch { /* ok */ }
    try { fs.unlinkSync(PROGRESS_FILE); } catch { /* ok */ }
  }

  console.log(`\nConcluído. ${count} domínios .${TLD} únicos em ${OUTPUT_FILE} (registos: ${totalScanned}, páginas perdidas: ${failedPages}).`);
}

main().catch((err) => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
