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
// Mapeia as tecnologias detetadas (tech_detected) → tags do Nuclei relevantes. Um site WordPress
// não deve testar templates de nodejs/c#/etc. — só WP + gerais de web/PHP + servidor. Reduz o nº de
// templates (de ~5000 p/ centenas) → o scan COMPLETA (o problema era não completar em tempo).
const TECH_TAG = {
  wordpress: ['wordpress', 'wp-plugin', 'wp-theme'], woocommerce: ['woocommerce', 'wordpress'],
  joomla: ['joomla'], drupal: ['drupal'], magento: ['magento'], prestashop: ['prestashop'],
  shopify: ['shopify'], wix: ['wix'], typo3: ['typo3'], moodle: ['moodle'], laravel: ['laravel'],
  php: ['php'], apache: ['apache'], nginx: ['nginx'], iis: ['iis', 'aspnet'], tomcat: ['tomcat'],
  jenkins: ['jenkins'], gitlab: ['gitlab'], phpmyadmin: ['phpmyadmin'], cpanel: ['cpanel'], plesk: ['plesk'],
};
export function nucleiTagsForTech(tech) {
  const tags = new Set(['exposure', 'misconfig', 'default-login']); // gerais de web, sempre
  for (const t of (Array.isArray(tech) ? tech : [])) {
    const slug = String((t && (t.slug || t.name)) || t || '').toLowerCase();
    for (const [k, v] of Object.entries(TECH_TAG)) if (slug.includes(k)) v.forEach((x) => tags.add(x));
  }
  return [...tags];
}
export function runNuclei(url, {
  bin = process.env.NUCLEI_BIN || 'nuclei',
  timeoutMs = Number(process.env.NUCLEI_TIMEOUT_MS || 240000),
  tags = null,   // tags específicas (tech-aware). null → geral cve,misconfig,exposure
  full = false,  // ON-DEMAND: corre TUDO, sem filtro de tags/severidade, sem timeout prático (report exaustivo)
} = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-u', url,
      '-jsonl', '-silent', '-no-color',
      '-no-interactsh',
      '-rate-limit', process.env.NUCLEI_RATE || '150',
      '-c', process.env.NUCLEI_CONC || '30',
      '-timeout', '10',
      '-disable-update-check',
    ];
    if (full) {
      // On-demand: relatório super-completo — todas as severidades, todos os templates (menos os
      // que penduram), timeout 1h. Demora mas é on-demand (o utilizador quer tudo).
      args.push('-severity', 'info,low,medium,high,critical', '-exclude-tags', 'dos');
      timeoutMs = Number(process.env.NUCLEI_FULL_TIMEOUT_MS || 3600000);
    } else {
      // Batch tech-aware: só templates relevantes p/ a stack → completa em tempo.
      args.push('-severity', process.env.NUCLEI_SEVERITY || 'low,medium,high,critical');
      args.push('-tags', (tags && tags.length ? tags : ['cve', 'misconfig', 'exposure']).join(','));
      args.push('-exclude-tags', process.env.NUCLEI_EXCLUDE_TAGS || 'fuzzing,dos,brute-force,intrusive');
    }
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
