// Carregador endurecido do conjunto de "domínios conhecidos" (usado p/ dedup no discover
// e corroboração de fusões de empresa por email em orgDomain). Vive em lib/ DE PROPÓSITO:
// lib/ é volume-mounted nos workers (deploy/worker/docker-compose.yml + docker/docker-compose.yml),
// por isso o fix chega à frota no próximo recreate SEM rebuild da imagem (enrich-sites.js, na
// raiz, é COPY'd/baked e não atualizaria com COMPOSE_BUILD=0).
//
// Corrige o incidente do "base-worker domain-reload storm":
//  (a) PG DIRETO — o read (~1,5M linhas) passa a ser SELECT direto (via PgBouncer) em vez de
//      readItems('sites') pelo Directus de 4c. Vários workers a recarregar em uníssono já não
//      pressionam o control-plane → sem cascata 503 → timeouts → ciclos.
//  (b) GUARD — retry com backoff; NUNCA fica com 0 domínios em SILÊNCIO (o bug antigo do
//      `catch { /* coleção vazia */ }`). Se falhar mesmo, avisa ALTO (degradado visível).
//  (c) JITTER (opcional) — atraso 0-10s p/ dessincronizar arranques simultâneos da frota.
import { getDomain } from 'tldts';
import { readItems } from '@directus/sdk';
import { pgEnabled, getPool } from './pgwrite.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} client  cliente Directus (usado só no fallback quando DIRECT_PG_WRITE off)
 * @param {{jitter?: boolean, attempts?: number}} opts
 * @returns {Promise<Set<string>>}  conjunto de domínios registados (pode estar vazio se degradado)
 */
export async function loadKnownDomains(client, { jitter = false, attempts = 5 } = {}) {
  const known = new Set();
  // (c) jitter — código de worker (runtime Node), Math.random é permitido aqui.
  if (jitter) {
    const ms = Math.floor(Math.random() * 10000);
    if (ms) await sleep(ms);
  }
  const usePg = pgEnabled();
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      known.clear();
      if (usePg) {
        // (a) PG direto — não passa pelo Directus.
        const { rows } = await getPool().query('SELECT domain FROM sites WHERE domain IS NOT NULL');
        for (const r of rows) known.add(getDomain(r.domain) || r.domain);
      } else {
        const all = await client.request(readItems('sites', { fields: ['domain'], limit: -1 }));
        for (const s of all) known.add(getDomain(s.domain) || s.domain);
      }
      if (known.size > 0) return known;
      throw new Error('0 linhas devolvidas');
    } catch (e) {
      // (b) guard — retenta; só desiste (degradado, mas ALTO) na última tentativa.
      if (attempt === attempts) {
        console.warn(`⚠⚠ carga de domínios conhecidos falhou após ${attempts} tentativas (${usePg ? 'PG direto' : 'Directus'}): ${e.message} — worker DEGRADADO (dedup/merge por-domínio off até próximo restart)`);
        return known;
      }
      await sleep(attempt * 2000); // backoff 2/4/6/8s
    }
  }
  return known;
}
