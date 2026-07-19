// lib/wordfence.js
// Wordfence Intelligence — base de vulnerabilidades WordPress LOCAL. Enriquece a enumeração KEYLESS do
// wpscan (plugins/temas/versão) com vulns conhecidas SEM gastar a quota da WPScan API (25/dia/key).
//
// A API v3 exige Bearer token (WORDFENCE_API_KEY — registo grátis em
// https://www.wordfence.com/products/wordfence-intelligence/). O updater (update-wordfence.js, agendado a
// cada WORDFENCE_UPDATE_DAYS) descarrega o feed 'production', constrói um índice COMPACTO por (tipo, slug)
// e guarda-o gzip em MinIO (reports bucket, objeto wordfence/index.json.gz). Os workers carregam-no (cache
// 6h) e fazem match. Env-gated: sem índice em MinIO, matchWpscanVulns devolve null (no-op — keyless na mesma).

import { Client } from 'minio';
import { gzipSync, gunzipSync } from 'node:zlib';

const FEED_URL = 'https://www.wordfence.com/api/intelligence/v3/vulnerabilities/production';
const INDEX_KEY = 'wordfence/index.json.gz';
const REPORTS_BUCKET = process.env.MINIO_REPORTS_BUCKET || 'reports';

function mclient() {
  const url = new URL(process.env.MINIO_URL || 'http://localhost:9000');
  return new Client({
    endPoint: url.hostname, port: +url.port || 9000, useSSL: url.protocol === 'https:',
    accessKey: process.env.MINIO_ROOT_USER, secretKey: process.env.MINIO_ROOT_PASSWORD,
  });
}

// Compara versões "1.2.3" numericamente (-1/0/1). Partes em falta = 0.
function cmpVer(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}
// `v` está dentro do range afetado? '*'/vazio nos limites = extremo aberto.
function inRange(v, { from, fromIncl, to, toIncl }) {
  if (from && from !== '*') { const c = cmpVer(v, from); if (c < 0 || (c === 0 && !fromIncl)) return false; }
  if (to && to !== '*') { const c = cmpVer(v, to); if (c > 0 || (c === 0 && !toIncl)) return false; }
  return true;
}

// Índice compacto a partir do feed v3 (aceita array ou objeto {id: record}).
function buildIndex(feed) {
  const records = Array.isArray(feed) ? feed : Object.values(feed || {});
  const index = { plugin: {}, theme: {}, core: [] };
  for (const rec of records) {
    const cve = Array.isArray(rec.cve) ? rec.cve[0] : rec.cve;
    const meta = { title: rec.title, cve: cve || null, cvss: rec.cvss?.score ?? null, rating: rec.cvss?.rating ?? null };
    for (const sw of (rec.software || [])) {
      const ranges = Object.values(sw.affected_versions || {}).map((r) => ({ from: r.from_version, fromIncl: r.from_inclusive, to: r.to_version, toIncl: r.to_inclusive }));
      if (!ranges.length) continue;
      const entry = { ...meta, ranges };
      if (sw.type === 'core') index.core.push(entry);
      else if (sw.type === 'plugin' || sw.type === 'theme') { const slug = (sw.slug || '').toLowerCase(); if (slug) (index[sw.type][slug] ||= []).push(entry); }
    }
  }
  return index;
}

// Descarrega o feed + guarda o índice em MinIO. Chamado pelo updater (cron). Devolve contagens.
export async function updateWordfenceDb() {
  const key = process.env.WORDFENCE_API_KEY;
  if (!key) throw new Error('WORDFENCE_API_KEY em falta (registo grátis em wordfence.com/products/wordfence-intelligence)');
  const r = await fetch(FEED_URL, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`Wordfence feed HTTP ${r.status}`);
  const index = buildIndex(await r.json());
  const body = gzipSync(Buffer.from(JSON.stringify(index)));
  const c = mclient();
  if (!(await c.bucketExists(REPORTS_BUCKET))) await c.makeBucket(REPORTS_BUCKET);
  await c.putObject(REPORTS_BUCKET, INDEX_KEY, body, body.length, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
  return { plugins: Object.keys(index.plugin).length, themes: Object.keys(index.theme).length, core: index.core.length, bytes: body.length };
}

// Carrega o índice de MinIO (cache em memória, refresh 6h). null se ainda não descarregado / MinIO em baixo.
let _index = null, _at = 0;
async function loadIndex() {
  if (_index && Date.now() - _at < 6 * 3600e3) return _index;
  try {
    const stream = await mclient().getObject(REPORTS_BUCKET, INDEX_KEY);
    const chunks = []; for await (const ch of stream) chunks.push(ch);
    _index = JSON.parse(gunzipSync(Buffer.concat(chunks)).toString()); _at = Date.now();
    return _index;
  } catch { return null; }
}

// Dado o report parseado do wpscan (keyless), devolve { vulnCount, vulns } ou null (sem índice → no-op).
export async function matchWpscanVulns(wpscanReport) {
  const index = await loadIndex();
  if (!index || !wpscanReport) return null;
  const vulns = [];
  const check = (type, slug, version) => {
    if (!slug || !version) return;
    for (const v of (index[type][String(slug).toLowerCase()] || [])) if (v.ranges.some((rg) => inRange(version, rg))) vulns.push({ type, slug, version, ...v });
  };
  for (const [grp, type] of [['plugins', 'plugin'], ['themes', 'theme']]) {
    for (const [slug, info] of Object.entries(wpscanReport[grp] || {})) check(type, slug, info?.version?.number || info?.version || null);
  }
  const coreVer = wpscanReport.version?.number || null;
  if (coreVer) for (const v of index.core) if (v.ranges.some((rg) => inRange(coreVer, rg))) vulns.push({ type: 'core', slug: 'wordpress', version: coreVer, ...v });
  return { vulnCount: vulns.length, vulns };
}
