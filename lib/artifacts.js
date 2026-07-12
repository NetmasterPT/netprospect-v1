// lib/artifacts.js
// Armazém de SNAPSHOTS de páginas (MinIO / S3). Um job `fetch` guarda o bundle da
// página UMA vez; os jobs de análise (fingerprint/social/locality/industry/…) leem
// daqui em vez de refazer o fetch. Versionado por site+timestamp → alimenta também
// a deteção de mudanças (Fase E).
//
// Bundle: { finalUrl, status, headers, setCookies, html, pages:[{url,html}], fetchedAt }
// Chaves: `<siteId>/<ts>.json` (histórico) + `<siteId>/latest.json` (ponteiro).

import { Client } from 'minio';
import { gzipSync, gunzipSync } from 'node:zlib';

const BUCKET = process.env.MINIO_BUCKET || 'snapshots';
// Relatórios INTEGRAIS de auditoria (Lighthouse/Nuclei). Bucket próprio: perfil de acesso
// diferente dos snapshots (escreve-se 1×, lê-se raramente — ao gerar o PDF para o cliente),
// logo pode viver em disco barato (HDD) e ter lifecycle próprio. Ver docs/runbook-minio-de1.md.
const REPORTS_BUCKET = process.env.MINIO_REPORTS_BUCKET || 'reports';
let _client = null;

function client() {
  if (_client) return _client;
  const url = new URL(process.env.MINIO_URL || 'http://minio:9000');
  _client = new Client({
    endPoint: url.hostname,
    port: Number(url.port) || (url.protocol === 'https:' ? 443 : 9000),
    useSSL: url.protocol === 'https:',
    accessKey: process.env.MINIO_ROOT_USER || 'netprospect',
    secretKey: process.env.MINIO_ROOT_PASSWORD || 'change-me-minio',
  });
  return _client;
}

export async function ensureBucket() {
  const c = client();
  if (!(await c.bucketExists(BUCKET))) await c.makeBucket(BUCKET);
}

// Guarda o bundle. Devolve a key da versão. Best-effort no ponteiro latest.
export async function putSnapshot(siteId, bundle) {
  const c = client();
  const ts = (bundle.fetchedAt || new Date().toISOString());
  const body = Buffer.from(JSON.stringify({ ...bundle, fetchedAt: ts }));
  const key = `${siteId}/${ts.replace(/[:.]/g, '-')}.json`;
  await c.putObject(BUCKET, key, body, body.length, { 'Content-Type': 'application/json' });
  try { await c.putObject(BUCKET, `${siteId}/latest.json`, body, body.length, { 'Content-Type': 'application/json' }); } catch { /* ponteiro opcional */ }
  return key;
}

// Lê um snapshot (key específica ou o latest do site). null se não existir.
export async function getSnapshot(siteId, key) {
  const c = client();
  const objKey = key || `${siteId}/latest.json`;
  try {
    const stream = await c.getObject(BUCKET, objKey);
    const chunks = [];
    for await (const ch of stream) chunks.push(ch);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    if (/NoSuchKey|NotFound|does not exist/i.test(e.message || '')) return null;
    throw e;
  }
}

// --- Relatórios integrais de auditoria (object storage) -----------------------------
// O Postgres guarda só o RESUMO (rápido, para o dashboard); o relatório integral vive aqui,
// gzipado. Medido num site real: o lhr completo são 899 KB (396 KB gzip) mas 82% disso são
// screenshots em base64 — que NÃO comprimem. Sem eles: 435 KB → 71 KB gzip, sem perder um
// único dado acionável. A 1M sites: ~71 GB (vs ~396 GB com as imagens).
export async function ensureReportsBucket() {
  const c = client();
  if (!(await c.bucketExists(REPORTS_BUCKET))) await c.makeBucket(REPORTS_BUCKET);
}

// Guarda o relatório integral gzipado. FAIL-SOFT: uma falha do storage nunca pode matar
// a auditoria (devolve null e o site_reports fica só com o resumo).
export async function putReport(siteId, kind, obj) {
  if (!obj) return null;
  try {
    const c = client();
    const body = gzipSync(Buffer.from(JSON.stringify(obj)));
    const key = `${siteId}/${kind}.json.gz`;
    await c.putObject(REPORTS_BUCKET, key, body, body.length, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
    return { bucket: REPORTS_BUCKET, key, bytes: body.length };
  } catch { return null; }
}

// Lê um relatório integral (para gerar o PDF/relatório do cliente). null se não existir.
export async function getReport(key, bucket = REPORTS_BUCKET) {
  try {
    const stream = await client().getObject(bucket, key);
    const chunks = [];
    for await (const ch of stream) chunks.push(ch);
    return JSON.parse(gunzipSync(Buffer.concat(chunks)).toString('utf8'));
  } catch (e) {
    if (/NoSuchKey|NotFound|does not exist/i.test(e.message || '')) return null;
    throw e;
  }
}

// Lista as versões (keys) de um site, mais recentes primeiro (para diffs na Fase E).
export async function listVersions(siteId) {
  const c = client();
  const out = [];
  const stream = c.listObjectsV2(BUCKET, `${siteId}/`, true);
  for await (const obj of stream) if (!obj.name.endsWith('/latest.json')) out.push(obj.name);
  return out.sort().reverse();
}
