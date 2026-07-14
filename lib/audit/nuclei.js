// lib/audit/nuclei.js
// Scanner de segurança do BATCH (ProjectDiscovery Nuclei, sem limite de API).
// Corre em todos (qualificados→resto). Conta findings por severidade e devolve o
// máximo. Guarda-se depois em site_reports(kind:'nuclei'). O WPScan fica só p/
// on-demand (25/dia).

import { execFile } from 'node:child_process';

const SEV_ORDER = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

// AFINAÇÃO (medido): com `-rate-limit 20` o scan NUNCA acabava — batia sempre no timeout de
// 180 s (medido: 180,1 s), o que fazia do Nuclei 87% do tempo de uma auditoria e punha o ETA
// do batch em ~27 dias. O default do Nuclei é 150 req/s; 20 era 7,5× mais lento sem ganho.
// Agora: 100 req/s (ainda educado com PMEs), 30 templates em paralelo, timeout 90 s, e sem a
// severidade `low` (ruído que não vende — o que vende é critical/high/medium).
// Env: NUCLEI_RATE / NUCLEI_CONC / NUCLEI_TIMEOUT_MS / NUCLEI_SEVERITY.
export function runNuclei(url, {
  bin = process.env.NUCLEI_BIN || 'nuclei',
  timeoutMs = Number(process.env.NUCLEI_TIMEOUT_MS || 150000),
} = {}) {
  return new Promise((resolve, reject) => {
    // CORREÇÃO (2026-07-14): a 90s o scan de 5.081 templates (~11k requests) NUNCA acabava →
    // parse parcial → 0 findings em TODOS os 14k sites. Fix: (1) timeout 150s; (2) excluir tags
    // lentas (fuzzing/dos/brute-force fazem N requests/template e não vendem); (3) -no-interactsh
    // (o polling OOB no fim adicionava segundos e erros); (4) rate 150 (default do nuclei, educado).
    const args = [
      '-u', url,
      '-jsonl', '-silent', '-no-color',
      '-severity', process.env.NUCLEI_SEVERITY || 'medium,high,critical',
      '-tags', 'cve,misconfig,exposure',
      '-exclude-tags', process.env.NUCLEI_EXCLUDE_TAGS || 'fuzzing,dos,brute-force,intrusive',
      '-no-interactsh',
      '-rate-limit', process.env.NUCLEI_RATE || '150',
      '-c', process.env.NUCLEI_CONC || '30',
      '-timeout', '10',
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
