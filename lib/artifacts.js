// lib/artifacts.js
// Armazém de SNAPSHOTS de páginas (MinIO / S3). Um job `fetch` guarda o bundle da
// página UMA vez; os jobs de análise (fingerprint/social/locality/industry/…) leem
// daqui em vez de refazer o fetch. Versionado por site+timestamp → alimenta também
// a deteção de mudanças (Fase E).
//
// Bundle: { finalUrl, status, headers, setCookies, html, pages:[{url,html}], fetchedAt }
// Chaves: `<siteId>/<ts>.json` (histórico) + `<siteId>/latest.json` (ponteiro).

import { Client } from 'minio';

const BUCKET = process.env.MINIO_BUCKET || 'snapshots';
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

// Lista as versões (keys) de um site, mais recentes primeiro (para diffs na Fase E).
export async function listVersions(siteId) {
  const c = client();
  const out = [];
  const stream = c.listObjectsV2(BUCKET, `${siteId}/`, true);
  for await (const obj of stream) if (!obj.name.endsWith('/latest.json')) out.push(obj.name);
  return out.sort().reverse();
}
