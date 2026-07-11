// lib/audit/nuclei.js
// Scanner de segurança do BATCH (ProjectDiscovery Nuclei, sem limite de API).
// Corre em todos (qualificados→resto). Conta findings por severidade e devolve o
// máximo. Guarda-se depois em site_reports(kind:'nuclei'). O WPScan fica só p/
// on-demand (25/dia).

import { execFile } from 'node:child_process';

const SEV_ORDER = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

export function runNuclei(url, { bin = process.env.NUCLEI_BIN || 'nuclei', timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-u', url,
      '-jsonl', '-silent', '-no-color',
      '-severity', 'low,medium,high,critical',
      '-tags', 'cve,misconfig,exposure',
      '-rate-limit', '20', '-timeout', '10',
      '-disable-update-check',
    ];
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      // Nuclei sai 0 mesmo com findings; erro real = binário em falta / timeout.
      if (err && err.code === 'ENOENT') return reject(new Error('nuclei não instalado'));
      const results = [];
      for (const line of (stdout || '').split('\n')) {
        if (!line.trim()) continue;
        try { results.push(JSON.parse(line)); } catch { /* linha não-JSON */ }
      }
      let severity = null, max = -1;
      const bySev = {};
      for (const r of results) {
        const s = (r.info?.severity || '').toLowerCase();
        bySev[s] = (bySev[s] || 0) + 1;
        if (SEV_ORDER[s] > max) { max = SEV_ORDER[s]; severity = s; }
      }
      resolve({
        findings: results.length,
        severity,
        bySeverity: bySev,
        results: results.map((r) => ({ template: r['template-id'] || r.templateID, name: r.info?.name, severity: r.info?.severity, matched: r['matched-at'] || r.matched })),
      });
    });
  });
}
