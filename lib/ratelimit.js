// lib/ratelimit.js — rate-limit por chave (ex.: registry host) via Redis, PARTILHADO entre
// os workers de uma VM (cada IP tem o seu orçamento → a frota escala mantendo a educação).
// Janela fixa por segundo. FAIL-OPEN (Redis em baixo → deixa passar). Respeita Retry-After.
import { createClient } from 'redis';

const URL = process.env.REDIS_URL || '';
let _c = null, _ready = false, _init = false;
async function redis() {
  if (!URL) return null;
  if (_init) return _ready ? _c : null;
  _init = true;
  _c = createClient({ url: URL });
  _c.on('error', () => { _ready = false; });
  try { await _c.connect(); _ready = true; } catch { _ready = false; _c = null; }
  return _ready ? _c : null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Consome 1 token do bucket `key` (orçamento `perSec`). Espera até `maxWaitMs` por espaço na
// janela; se não houver, LANÇA rateLimited → o job faz nak+backoff. Fail-open sem Redis.
export async function acquire(key, perSec = 2, { maxWaitMs = 3000 } = {}) {
  const c = await redis();
  if (!c) return true; // fail-open
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    if (await penalized(key)) { if (Date.now() >= deadline) throwRL(key); await sleep(500); continue; }
    const k = `rl:${key}:${Math.floor(Date.now() / 1000)}`;
    let n;
    try { n = await c.incr(k); if (n === 1) await c.expire(k, 2); } catch { return true; } // fail-open
    if (n <= perSec) return true;
    if (Date.now() >= deadline) throwRL(key);
    await sleep(200); // espera a janela rolar
  }
}
function throwRL(key) { const e = new Error(`rate-limit ${key} (429)`); e.rateLimited = true; throw e; }

// Penaliza uma chave por N segundos (quando o registry devolve Retry-After / 429).
export async function penalize(key, seconds = 5) {
  const c = await redis(); if (!c) return;
  try { await c.set(`rlpen:${key}`, '1', { EX: Math.min(600, Math.max(1, Math.round(seconds))) }); } catch { /* ignora */ }
}
export async function penalized(key) {
  const c = await redis(); if (!c) return false;
  try { return (await c.exists(`rlpen:${key}`)) === 1; } catch { return false; }
}
