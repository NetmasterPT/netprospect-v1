// lib/worker-telemetry.js — telemetria de workers via Redis (fail-soft).
// Cada worker regista-se (heartbeat) e conta jobs (ok/falha) + duração por consumer,
// e guarda as últimas linhas de log — para o dashboard mostrar workers a correr, a
// tarefa atual, contagens 1h/24h, durações e logs, sem depender do socket do Docker.
//
// REDIS_URL vazio → no-op (o worker corre na mesma). Chaves (TTL p/ auto-limpeza):
//   np:wk:<id>            HASH  {id, role, host, started, pid, beat, cur, cur_started, cur_role}
//   np:wk:index          ZSET  id -> last beat (para listar/expirar workers mortos)
//   np:wk:<id>:done:<h>  / :fail:<h>   counters por HORA (epoch-hour), EXPIRE 26h
//   np:wk:<id>:dur       LIST  últimas N durações (ms) p/ média
//   np:wk:<id>:log       LIST  últimas N linhas de log (mais recente à cabeça)
import { createClient } from 'redis';

const URL = process.env.REDIS_URL || '';
const WID = process.env.HOSTNAME || String(process.pid);
const ROLE = process.env.WORKER_ROLES || 'all';
// FLEET_HOST = a VM a que este worker pertence (hel1-docker/np-wk-de1/gpedro-laptop/…). Definido
// no .env de cada host. Sem ele, cai no HOSTNAME (o id do container). O dashboard mostra este `host`.
const FLEET_HOST = process.env.FLEET_HOST || process.env.HOSTNAME || '';
const LOG_KEEP = 200, DUR_KEEP = 200, TTL = 26 * 3600;
const hourBucket = () => Math.floor(Date.now() / 3600000);

let _c = null, _up = false, _init = false;
async function cli() {
  if (!URL) return null;
  if (_init) return _up ? _c : null;
  _init = true;
  try {
    _c = createClient({ url: URL });
    _c.on('error', () => { _up = false; });
    _c.on('ready', () => { _up = true; });
    await _c.connect(); _up = true;
  } catch { _c = null; _up = false; }
  return _up ? _c : null;
}
const key = (s) => `np:wk:${WID}${s}`;
// Chaves POR TIPO DE JOB (partilhadas por toda a frota — throughput/duração agregados por consumer,
// não por worker). Usadas pela página das Filas p/ capacidade (usada/total) e duração média.
const jkey = (consumer, s) => `np:job:${consumer}${s}`;
// Chaves POR HOST (throughput/duração agregados por VM/FLEET_HOST — estáveis aos restarts dos
// containers, ao contrário do id do worker). Para a capacidade 1h/24h/30d por servidor na página Servers.
const hkey = (s) => `np:host:${FLEET_HOST}${s}`;
const dayBucket = () => Math.floor(Date.now() / 86400000);
const DAY_TTL = 32 * 86400; // 30d + margem

// Load + cores do HOST (para as páginas Servers/VMs). Em LXC o /proc/loadavg é do host, mas
// os workers da mesma VM reportam o mesmo → o dashboard usa qualquer um por FLEET_HOST. Fresco por beat.
import os from 'os';
const CORES = os.cpus().length;
function hostLoad() { try { return +os.loadavg()[0].toFixed(2); } catch { return null; } }

// Regista o worker + arranca o heartbeat (a cada 10s). Chamar 1× no arranque.
export async function startTelemetry(extra = {}) {
  const c = await cli(); if (!c) return () => {};
  const now = Date.now();
  // Metadata estável — re-escrita a CADA heartbeat para AUTO-CURAR se o Redis (cache-only, sem
  // persistência) for reiniciado/limpo; senão os workers já a correr desaparecem do dashboard
  // (a hash de metadata perde-se e só o heartbeat a re-cria parcialmente → sem host/role).
  const meta = { id: WID, role: ROLE, host: FLEET_HOST, cores: String(CORES), pid: String(process.pid), started: String(now), ...extra };
  try {
    await c.hSet(key(''), { ...meta, load: String(hostLoad()), beat: String(now) });
    await c.expire(key(''), TTL);
    await c.zAdd('np:wk:index', { score: now, value: WID });
  } catch { /* fail-soft */ }
  const t = setInterval(async () => {
    const cc = await cli(); if (!cc) return;
    try { const n = Date.now(); await cc.hSet(key(''), { ...meta, load: String(hostLoad()), beat: String(n) }); await cc.expire(key(''), TTL); await cc.zAdd('np:wk:index', { score: n, value: WID }); } catch { /* */ }
  }, 10000);
  if (t.unref) t.unref();
  return () => clearInterval(t);
}

// Marca o início de uma tarefa (mostra "tarefa atual" no dashboard).
export async function taskStart(consumer, label) {
  const c = await cli(); if (!c) return Date.now();
  try { await c.hSet(key(''), { cur: label || consumer, cur_role: consumer, cur_started: String(Date.now()) }); } catch { /* */ }
  return Date.now();
}
// Marca o fim (ok/falha) + regista a duração + limpa a tarefa atual.
export async function taskEnd(consumer, startedAt, ok = true) {
  const c = await cli(); if (!c) return;
  const dur = Math.max(0, Date.now() - (startedAt || Date.now()));
  const h = hourBucket();
  try {
    const kind = ok ? 'done' : 'fail';
    await c.incr(`${key(':' + kind + ':')}${h}`); await c.expire(`${key(':' + kind + ':')}${h}`, TTL);
    await c.lPush(key(':dur'), String(dur)); await c.lTrim(key(':dur'), 0, DUR_KEEP - 1);
    await c.hSet(key(''), { cur: '', cur_role: '', cur_started: '' });
    // Agregados POR TIPO DE JOB (só concluídos): done/hora (26h), done/dia (32d) e durações (rolling).
    if (ok && consumer) {
      const d = dayBucket();
      await c.incr(`${jkey(consumer, ':done:')}${h}`); await c.expire(`${jkey(consumer, ':done:')}${h}`, TTL);
      await c.incr(`${jkey(consumer, ':dday:')}${d}`); await c.expire(`${jkey(consumer, ':dday:')}${d}`, DAY_TTL);
      await c.lPush(jkey(consumer, ':dur'), String(dur)); await c.lTrim(jkey(consumer, ':dur'), 0, DUR_KEEP - 1); await c.expire(jkey(consumer, ':dur'), TTL);
      // Mesmos agregados mas POR HOST (para a capacidade por servidor/VM).
      if (FLEET_HOST) {
        await c.incr(`${hkey(':done:')}${h}`); await c.expire(`${hkey(':done:')}${h}`, TTL);
        await c.incr(`${hkey(':dday:')}${d}`); await c.expire(`${hkey(':dday:')}${d}`, DAY_TTL);
        await c.lPush(hkey(':dur'), String(dur)); await c.lTrim(hkey(':dur'), 0, DUR_KEEP - 1); await c.expire(hkey(':dur'), TTL);
      }
    }
  } catch { /* */ }
}
// Acrescenta uma linha de log (mais recente à cabeça).
export async function logLine(line) {
  const c = await cli(); if (!c) return;
  try { await c.lPush(key(':log'), `${new Date().toISOString().slice(11, 19)} ${String(line).slice(0, 500)}`); await c.lTrim(key(':log'), 0, LOG_KEEP - 1); await c.expire(key(':log'), TTL); } catch { /* */ }
}

export const telemetryEnabled = () => !!URL;
