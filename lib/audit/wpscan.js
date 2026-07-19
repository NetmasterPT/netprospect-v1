// lib/audit/wpscan.js
// SÓ on-demand (botão "Auditar agora" no drawer), para sites WordPress. Token
// grátis = 25/dia → nunca em batch (o batch de segurança é o Nuclei). Devolve o
// nº de vulnerabilidades + o relatório completo (guardado em site_reports).

import { execFile } from 'node:child_process';

// `keyless` (batch): SEM key — enumera mas não traz o vuln-DB (poupa a quota 25/dia).
// Sem `keyless` (on-demand): usa a WPSCAN_API_TOKEN (env + --api-token) → traz vulns.
export function runWpscan(url, { token = process.env.WPSCAN_API_TOKEN, keyless = false, timeoutMs = 240000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '--url', url,
      '--format', 'json', '--no-banner',
      '--ignore-main-redirect', // não abortar quando o site redireciona p/ www
      '--enumerate', 'vp', // vulnerable plugins/themes + version
      '--random-user-agent', '--disable-tls-checks',
      '--request-timeout', '30', '--connect-timeout', '15',
    ];
    // Keyless REAL: o wpscan lê WPSCAN_API_TOKEN do ambiente automaticamente, por isso
    // não basta omitir --api-token — é preciso neutralizar a env var no processo-filho.
    const env = { ...process.env };
    if (keyless) {
      delete env.WPSCAN_API_TOKEN;
      // Batch keyless: enumeração passiva (rápida, não-intrusiva). A agressiva é lenta e
      // faz PMEs bloquearem-nos, e keyless não traz vuln-DB de qualquer forma.
      args.push('--detection-mode', 'passive');
    } else if (token) args.push('--api-token', token);
    // Egresso residencial: o wpscan é um CLI (não usa o dispatcher/undici), por isso passa-se o proxy
    // explicitamente. EGRESS_PROXY=http://tailscale-egress:1055 → sai pelo exit node (ex.: laptop
    // residencial) em vez do IP datacenter — evita queimar a reputação do IP em scans em massa.
    const proxy = (process.env.EGRESS_PROXY || '').trim();
    if (proxy) args.push('--proxy', proxy);
    execFile('wpscan', args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env }, (err, stdout) => {
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
