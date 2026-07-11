// Acesso partilhado ao PostgreSQL público do crt.sh (Certificate Transparency).
// Usado por crtsh-enum.js (CLI) e enrich-subdomains.js (preencher sites.hostnames).
//
// NOTA: a base `guest` é uma RÉPLICA que cancela queries abrangentes (TLD inteiro)
// e tem limites de ligações. Usar por domínio específico e sem paralelismo agressivo.
import pg from 'pg';

const DB_CONFIG = { host: 'crt.sh', port: 5432, user: 'guest', database: 'certwatch' };
const DEFAULT_DELAY_MS = 500;
const DEFAULT_MAX_RETRIES = 5;

// Aceita apenas hostnames plausíveis (exclui nomes de organização, emails, etc.).
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const isTransient = (err) =>
  /conflict with recovery|terminating connection|max_client_conn|too many clients|Connection terminated|ECONNRESET|server closed the connection/i.test(
    err.message || ''
  );

async function connect() {
  const client = new pg.Client(DB_CONFIG);
  // Evita que um erro FATAL da réplica derrube o processo (evento 'error' não tratado).
  client.on('error', () => {});
  await client.connect();
  return client;
}

// Corre uma query com nova ligação por tentativa e backoff em erros transitórios.
export async function runQuery(sql, params, { maxRetries = DEFAULT_MAX_RETRIES, delayMs = DEFAULT_DELAY_MS, onRetry } = {}) {
  for (let attempt = 1; ; attempt++) {
    let client;
    try {
      client = await connect();
      const { rows } = await client.query(sql, params);
      await client.end().catch(() => {});
      return rows;
    } catch (err) {
      try { await client?.end(); } catch {}
      if (!isTransient(err) || attempt > maxRetries) throw err;
      // Backoff exponencial + jitter (evita "thundering herd" quando vários
      // workers batem no limite de ligações do crt.sh ao mesmo tempo).
      const backoff = delayMs * 2 ** attempt + Math.floor(Math.random() * 400);
      if (onRetry) onRetry(attempt, maxRetries, err, backoff);
      await sleep(backoff);
    }
  }
}

// Devolve os hostnames (do CT) que terminam em `.term`.
//   - term = domínio específico (ex: dns.pt)  -> subdomínios *.dns.pt
//   - term = TLD (ex: pt)                       -> demasiado abrangente, evita (a réplica cancela)
// Retorna { names: string[], scanned: number }.
export async function fetchNames(term, { activeOnly = false, ...opts } = {}) {
  const t = term.replace(/^\.+/, '').toLowerCase().trim();
  const query = `
    SELECT DISTINCT cai.name_value AS name
    FROM certificate_and_identities cai
    WHERE plainto_tsquery('certwatch', $1) @@ identities(cai.certificate)
      AND cai.name_type = 'san:dNSName'
      AND cai.name_value ILIKE ('%.' || $1)
      ${activeOnly ? 'AND x509_notAfter(cai.certificate) > statement_timestamp()' : ''}
  `;
  const rows = await runQuery(query, [t], opts);
  const seen = new Set();
  const suffix = `.${t}`;
  for (const row of rows) {
    let d = (row.name || '').toLowerCase().trim();
    if (d.startsWith('*.')) d = d.slice(2);
    if (d.endsWith(suffix) && HOSTNAME_RE.test(d)) seen.add(d);
  }
  return { names: [...seen].sort(), scanned: rows.length };
}
