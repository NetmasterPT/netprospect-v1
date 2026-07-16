// lib/audit/ssllabs.js
// Análise PROFUNDA do SSL via Qualys SSL Labs API v3. Complementa o job `ssl` (que já captura
// emissor/grade/dias/validação/wildcard num handshake rápido): o SSL Labs avalia a CONFIGURAÇÃO
// (protocolos, cifras, cadeia, Heartbleed/ROBOT/etc.) e dá uma nota A+…F com avisos.
//
// LENTO (~1–3 min/host) e RATE-LIMITED (máx ~7 assessments concorrentes por IP, cool-off 1s). Só
// faz sentido on-demand (botão no drawer) ou num batch PEQUENO de leads de topo — nunca a base toda.

const API = 'https://api.ssllabs.com/api/v3';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Corre a análise e devolve { status, grade, hasWarnings, ipAddress, endpoints[], testTime }.
// fromCache: usa um resultado em cache <maxAgeH horas (não queima assessment); senão startNew.
export async function analyzeSslLabs(host, { fromCache = true, maxAgeH = 24, timeoutMs = 300000, pollMs = 15000 } = {}) {
  const started = Date.now();
  const base = `${API}/analyze?host=${encodeURIComponent(host)}&all=done`;
  let url = fromCache ? `${base}&fromCache=on&maxAge=${maxAgeH}` : `${base}&startNew=on`;
  let first = true;
  for (;;) {
    if (Date.now() - started > timeoutMs) return { status: 'TIMEOUT' };
    const r = await fetch(url).catch(() => null);
    if (!r) { await sleep(pollMs); continue; }
    if (r.status === 429 || r.status === 529 || r.status === 503) { await sleep(pollMs * 2); continue; } // rate/sobrecarga → espera
    const j = await r.json().catch(() => null);
    if (!j) { await sleep(pollMs); continue; }
    if (j.status === 'READY') {
      const ep = (j.endpoints || []).filter((e) => e.grade);
      const best = ep[0] || {};
      return {
        status: 'READY',
        grade: best.grade || null,
        gradeTrustIgnored: best.gradeTrustIgnored || null,
        hasWarnings: !!best.hasWarnings,
        ipAddress: best.ipAddress || null,
        endpoints: ep.map((e) => ({ ip: e.ipAddress, grade: e.grade, warnings: !!e.hasWarnings, statusMessage: e.statusMessage })),
        testTime: j.testTime || null,
      };
    }
    if (j.status === 'ERROR') return { status: 'ERROR', error: j.statusMessage || 'erro' };
    // IN_PROGRESS / DNS → continuar poll SEM startNew (senão reinicia a análise).
    url = base;
    if (first) { first = false; await sleep(5000); } else await sleep(pollMs);
  }
}
