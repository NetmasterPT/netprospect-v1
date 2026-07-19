// Cliente REST mínimo do Qdrant (vector store). Sem deps (fetch nativo).
const base = () => (process.env.QDRANT_URL || 'http://127.0.0.1:6333').replace(/\/$/, '');

async function req(method, path, body, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(base() + path, {
        method,
        headers: body ? { 'content-type': 'application/json', connection: 'close' } : { connection: 'close' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!r.ok) throw new Error(`qdrant ${method} ${path} → HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
      return r.json();
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message) + ' ' + String(e?.cause?.message || '');
      if (!/fetch failed|ECONNRESET|other side closed|socket|EPIPE/i.test(msg)) throw e;  // erro real → propaga
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));                              // socket morto → retry
    }
  }
  throw lastErr;
}

export async function ensureCollection(name, dim) {
  const r = await fetch(`${base()}/collections/${name}`);
  if (r.ok) return false;                                        // já existe
  await req('PUT', `/collections/${name}`, { vectors: { size: dim, distance: 'Cosine' } });
  return true;                                                    // criada
}
export const upsert = (name, points) => req('PUT', `/collections/${name}/points?wait=true`, { points });
export const search = (name, vector, limit = 8, filter) =>
  req('POST', `/collections/${name}/points/search`, { vector, limit, with_payload: true, ...(filter ? { filter } : {}) })
    .then((r) => r.result);
export const count = (name) => req('POST', `/collections/${name}/points/count`, { exact: true }).then((r) => r.result.count);
