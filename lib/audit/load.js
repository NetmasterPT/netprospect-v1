// lib/audit/load.js
// Tempo de carregamento (time-to-last-byte da homepage) → balde fast/medium/slow/
// very_slow. `bucketLoad(ms)` é puro (reutilizado no enrich, que já cronometra o
// fetch de liveness); `measureLoad(url)` faz um fetch dedicado para o backfill.

export function bucketLoad(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  if (ms < 800) return 'fast';
  if (ms < 2500) return 'medium';
  if (ms < 5000) return 'slow';
  return 'very_slow';
}

export async function measureLoad(url, { timeoutMs = 15000, ua } = {}) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: ua ? { 'User-Agent': ua } : undefined,
    });
    try { await r.arrayBuffer(); } catch { /* corpo abortado — TTLB parcial */ }
    const ms = Math.round(performance.now() - t0);
    return { ms, bucket: bucketLoad(ms), status: r.status };
  } catch {
    return { ms: null, bucket: null, status: null };
  } finally {
    clearTimeout(to);
  }
}
