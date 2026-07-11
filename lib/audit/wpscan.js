// lib/audit/wpscan.js
// SÓ on-demand (botão "Auditar agora" no drawer), para sites WordPress. Token
// grátis = 25/dia → nunca em batch (o batch de segurança é o Nuclei). Devolve o
// nº de vulnerabilidades + o relatório completo (guardado em site_reports).

import { execFile } from 'node:child_process';

export function runWpscan(url, { token = process.env.WPSCAN_API_TOKEN, timeoutMs = 240000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '--url', url,
      '--format', 'json', '--no-banner',
      '--enumerate', 'vp', // vulnerable plugins/themes + version
      '--random-user-agent', '--disable-tls-checks',
      '--request-timeout', '30', '--connect-timeout', '15',
    ];
    if (token) args.push('--api-token', token);
    execFile('wpscan', args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err && err.code === 'ENOENT') return reject(new Error('wpscan não instalado'));
      // WPScan sai !=0 quando encontra vulnerabilidades — o JSON está no stdout.
      let data = null;
      try { data = JSON.parse(stdout); } catch { if (err && !stdout) return reject(err); }
      let vulnCount = 0;
      if (data) {
        const add = (o) => { if (o && Array.isArray(o.vulnerabilities)) vulnCount += o.vulnerabilities.length; };
        add(data.version); add(data.main_theme);
        for (const grp of ['plugins', 'themes']) for (const k in (data[grp] || {})) add(data[grp][k]);
      }
      resolve({ vulnCount, report: data });
    });
  });
}
