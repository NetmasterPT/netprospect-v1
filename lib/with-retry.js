// lib/with-retry.js — retry com backoff exponencial p/ integrações Google/Notion.
// Port do netmaster (sem deps). Predicados: isGoogleRetryable / isNotionRetryable /
// notionRetryAfterMs (honra o header Retry-After do Notion).
function jitter(ms) { return Math.floor(Math.random() * ms); }

export async function withRetry(fn, opts) {
  const max = opts.maxAttempts ?? 5;
  const base = opts.baseDelayMs ?? 500;
  const cap = opts.maxDelayMs ?? 8000;
  const label = opts.label || 'op';
  let lastErr;
  for (let attempt = 1; attempt <= max; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (attempt === max || !opts.isRetryable(err)) throw err;
      const explicit = opts.retryAfterMs ? opts.retryAfterMs(err) : null;
      const expBackoff = Math.min(base * 2 ** (attempt - 1), cap);
      const wait = explicit && explicit > 0 ? explicit : jitter(expBackoff);
      console.warn(`[retry:${label}] tentativa ${attempt} falhou; espera ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

const RETRYABLE_GOOGLE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'backendError', 'internalError']);
export function isGoogleRetryable(err) {
  if (!err || typeof err !== 'object') return false;
  const status = Number(err.code ?? err.status ?? err.response?.status ?? 0);
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  if (status === 403) { const reasons = (err.errors || []).map((x) => x.reason || ''); return reasons.some((r) => RETRYABLE_GOOGLE_REASONS.has(r)); }
  return false;
}

export function isNotionRetryable(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code === 'rate_limited') return true;
  if (err.status === 429) return true;
  if (typeof err.status === 'number' && err.status >= 500 && err.status < 600) return true;
  return false;
}

export function notionRetryAfterMs(err) {
  if (!err || typeof err !== 'object' || !err.headers) return null;
  let raw = null;
  if (typeof err.headers.get === 'function') raw = err.headers.get('retry-after');
  else raw = err.headers['retry-after'] || err.headers['Retry-After'] || null;
  if (!raw) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.ceil(seconds * 1000);
}
