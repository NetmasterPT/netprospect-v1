// lib/metrics.js — Fase E: séries temporais + deteção de mudança (ClickHouse).
//
// Fail-soft por design: analytics NUNCA pode partir a pipeline. Se CLICKHOUSE_URL
// não estiver definido, tudo é no-op. Erros são engolidos (log de debug apenas).
//
// Uso principal — `recordRun(site, metrics, {runId})`:
//   1. lê a última observação de cada métrica deste site (1 query);
//   2. insere as novas observações;
//   3. compara nova vs última e insere change_events (só quando há histórico).
// Opcionalmente também faz capture() para PostHog se POSTHOG_* estiver definido.

const CH_URL = (process.env.CLICKHOUSE_URL || '').replace(/\/$/, '');
const CH_DB = process.env.CLICKHOUSE_DB || 'netprospect';
const CH_USER = process.env.CLICKHOUSE_USER || 'netprospect';
const CH_PASS = process.env.CLICKHOUSE_PASSWORD || '';
// No DAG event-driven, o `score` dispara ~7x por passagem (à medida que os sinais
// chegam). Sem throttle isso criaria observações duplicadas + score_up espúrios.
// Só gravamos 1 snapshot por site por janela (default 60 min): a rajada de
// convergência colapsa num registo; as re-passagens (re-crawl, dias depois) são
// cada uma capturada. 0 desliga o throttle.
const THROTTLE_MS = (parseInt(process.env.METRICS_THROTTLE_MIN || '60', 10) || 0) * 60000;
export const metricsEnabled = () => !!CH_URL;

// PostHog (opcional) — captura os change_events como eventos de produto. Funciona
// contra PostHog self-hosted (perfil posthog) OU cloud. Vazio = desligado.
const PH_HOST = (process.env.POSTHOG_HOST || '').replace(/\/$/, '');
const PH_KEY = process.env.POSTHOG_KEY || '';
export const posthogEnabled = () => !!(PH_HOST && PH_KEY);
export async function capture(event, distinctId, properties = {}) {
  if (!PH_HOST || !PH_KEY) return;
  try {
    await fetch(`${PH_HOST}/capture/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: PH_KEY, event, distinct_id: String(distinctId || 'netprospect'), properties }) });
  } catch { /* fail-soft */ }
}

const authHeaders = () => ({
  'X-ClickHouse-User': CH_USER,
  'X-ClickHouse-Key': CH_PASS,
  'Content-Type': 'text/plain',
});

// POST livre (INSERT/DDL). Nunca lança — devolve true/false.
async function chExec(query, body = '') {
  if (!CH_URL) return false;
  try {
    const url = `${CH_URL}/?database=${encodeURIComponent(CH_DB)}&query=${encodeURIComponent(query)}`;
    const r = await fetch(url, { method: 'POST', headers: authHeaders(), body });
    if (!r.ok) { await r.text().catch(() => {}); return false; }
    return true;
  } catch { return false; }
}

// SELECT … FORMAT JSON → array de linhas (ou [] em erro).
async function chQuery(query) {
  if (!CH_URL) return [];
  try {
    const url = `${CH_URL}/?database=${encodeURIComponent(CH_DB)}`;
    const r = await fetch(url, { method: 'POST', headers: authHeaders(), body: `${query} FORMAT JSON` });
    if (!r.ok) return [];
    const j = await r.json();
    return j.data || [];
  } catch { return []; }
}

// Aplica o esquema (idempotente). Usado por bootstrap-clickhouse.js.
export async function ensureSchema(schemaSql) {
  // ClickHouse HTTP corre uma statement por pedido → dividir por ';'.
  const stmts = schemaSql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
  let ok = true;
  for (const s of stmts) ok = (await chExec(s)) && ok;
  return ok;
}

const esc = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
// Literal SQL seguro (escapa \ e ') para interpolar input do dashboard em queries CH.
const sqlStr = (s) => `'${String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// --- Leitura (dashboard) -----------------------------------------------------
// Timeline de um site: todas as observações (metric, valor, ts) por ordem cronológica.
export async function getTimeline(siteId, { metrics } = {}) {
  if (!CH_URL || !siteId) return [];
  const mf = Array.isArray(metrics) && metrics.length ? ` AND metric IN (${metrics.map(sqlStr).join(',')})` : '';
  return chQuery(`SELECT metric, value_num, value_str, toUnixTimestamp(ts) AS ts FROM ${CH_DB}.observations WHERE site_id = ${Number(siteId)}${mf} ORDER BY ts`);
}
// Feed de gatilhos (change_events) recentes, com filtros opcionais.
export async function getTriggers({ limit = 100, severity, event, domain, sinceDays } = {}) {
  if (!CH_URL) return [];
  const w = [];
  if (severity) w.push(`severity IN (${String(severity).split(',').filter(Boolean).map(sqlStr).join(',')})`);
  if (event) w.push(`event = ${sqlStr(event)}`);
  if (domain) w.push(`domain = ${sqlStr(domain)}`);
  if (sinceDays) w.push(`ts >= now() - INTERVAL ${Number(sinceDays) || 30} DAY`);
  const where = w.length ? `WHERE ${w.join(' AND ')}` : '';
  return chQuery(`SELECT site_id, domain, event, old_value, new_value, severity, toUnixTimestamp(ts) AS ts FROM ${CH_DB}.change_events ${where} ORDER BY ts DESC LIMIT ${Math.min(500, Number(limit) || 100)}`);
}

// Regras de mudança: dado (métrica, valor antigo, valor novo) → evento|null.
// old === null significa "sem histórico" → nunca é mudança (é a 1.ª observação).
const CHANGE_RULES = {
  lead_score: (o, n) => (isNum(o) && isNum(n) && Math.abs(n - o) >= 10 ? { event: n > o ? 'score_up' : 'score_down', severity: n > o ? 'good' : 'warning' } : null),
  qualified: (o, n) => (o === 0 && n === 1 ? { event: 'qualified', severity: 'good' } : o === 1 && n === 0 ? { event: 'disqualified', severity: 'warning' } : null),
  platform: (o, n) => (o && n && o !== n ? { event: 'platform_changed', severity: 'info' } : null),
  spf_status: (o, n) => (o === 'ok' && ['missing', 'weak', 'invalid'].includes(n) ? { event: 'spf_broke', severity: 'warning' } : ['missing', 'weak', 'invalid'].includes(o) && n === 'ok' ? { event: 'spf_fixed', severity: 'good' } : null),
  dmarc_status: (o, n) => (o === 'ok' && ['missing', 'weak', 'invalid'].includes(n) ? { event: 'dmarc_broke', severity: 'warning' } : null),
  ssl_days_left: (o, n) => (isNum(n) && n >= 0 && n <= 30 && (!isNum(o) || o > 30) ? { event: 'cert_expiring', severity: 'critical' } : null),
  expiring_soon: (o, n) => (o === 0 && n === 1 ? { event: 'domain_expiring', severity: 'critical' } : null),
  cms_outdated: (o, n) => (o === 0 && n === 1 ? { event: 'cms_went_stale', severity: 'warning' } : null),
  security_severity: (o, n) => (['high', 'critical'].includes(n) && !['high', 'critical'].includes(o || '') ? { event: 'security_worsened', severity: 'critical' } : null),
  seo_score: (o, n) => (isNum(o) && isNum(n) && o - n >= 15 ? { event: 'seo_regressed', severity: 'warning' } : null),
};

// Normaliza um objeto de métricas em linhas {metric, num, str} (ignora null/undefined).
function toRows(metrics) {
  const rows = [];
  for (const [metric, v] of Object.entries(metrics)) {
    if (v == null) continue;
    if (typeof v === 'boolean') rows.push({ metric, num: v ? 1 : 0, str: '' });
    else if (isNum(v)) rows.push({ metric, num: v, str: '' });
    else rows.push({ metric, num: null, str: String(v) });
  }
  return rows;
}

// Grava uma corrida de observações + deteta mudanças. `metrics` = { lead_score, qualified,
// platform, spf_status, ... }. Booleanos viram 0/1; strings vão para value_str.
export async function recordRun(site, metrics, { runId = '' } = {}) {
  if (!CH_URL || !site?.id) return;
  try {
    const rows = toRows(metrics);
    if (!rows.length) return;
    const domain = site.domain || '';

    // 1) última observação de cada métrica (p/ comparar) + ts da mais recente (throttle).
    const last = {};
    let newestMs = 0;
    const prev = await chQuery(`SELECT metric, argMax(value_num, ts) AS num, argMax(value_str, ts) AS str, toUnixTimestamp(max(ts)) AS mts FROM ${CH_DB}.observations WHERE site_id = ${Number(site.id)} GROUP BY metric`);
    for (const p of prev) { last[p.metric] = { num: p.num == null ? null : Number(p.num), str: p.str || '' }; newestMs = Math.max(newestMs, Number(p.mts) * 1000 || 0); }
    // Throttle: se já há observação recente (mesma passagem), não regravar.
    if (THROTTLE_MS && newestMs && Date.now() - newestMs < THROTTLE_MS) return [];

    // 2) inserir observações novas (JSONEachRow).
    const obsBody = rows.map((r) => JSON.stringify({ site_id: Number(site.id), domain, metric: r.metric, value_num: r.num, value_str: r.str, run_id: runId })).join('\n');
    await chExec(`INSERT INTO ${CH_DB}.observations (site_id, domain, metric, value_num, value_str, run_id) FORMAT JSONEachRow`, obsBody);

    // 3) change_events (só quando há histórico anterior).
    const events = [];
    for (const r of rows) {
      const rule = CHANGE_RULES[r.metric];
      if (!rule || !(r.metric in last)) continue;
      const oldV = r.num == null ? last[r.metric].str : last[r.metric].num;
      const newV = r.num == null ? r.str : r.num;
      const hit = rule(oldV, newV);
      if (hit) events.push({ site_id: Number(site.id), domain, event: hit.event, old_value: String(oldV ?? ''), new_value: String(newV ?? ''), severity: hit.severity });
    }
    if (events.length) {
      await chExec(`INSERT INTO ${CH_DB}.change_events (site_id, domain, event, old_value, new_value, severity) FORMAT JSONEachRow`, events.map((e) => JSON.stringify(e)).join('\n'));
      // PostHog (se ligado): cada gatilho vira um evento de produto.
      if (PH_HOST && PH_KEY) for (const e of events) await capture(`np_${e.event}`, domain, { site_id: Number(site.id), domain, old_value: e.old_value, new_value: e.new_value, severity: e.severity });
    }
    return events;
  } catch { /* fail-soft */ }
}
