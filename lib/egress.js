// lib/egress.js
// Diversidade de IP: encaminha o egresso HTTP EXTERNO do worker (sites-alvo, GMB,
// crt.sh…) por um proxy — tipicamente um exit node Tailscale — SEM afetar as
// chamadas internas (directus/minio/ollama/nats), que continuam diretas.
//
// `EGRESS_PROXY` = URL do proxy HTTP (ex.: http://tailscale-egress:1055 do
// `tailscaled --outbound-http-proxy-listen`). Vazio = direto.
//   - fetch externo:  fetch(url, { dispatcher: egressDispatcher() })
//   - Chromium:       browserProxyArg() -> `--proxy-server=...`
//   - crt.sh (PG raw) NÃO passa por proxy HTTP → usar o modo KERNEL do sidecar
//     Tailscale (network_mode: service) p/ rotear TODO o egresso, incl. PG.

const PROXY = (process.env.EGRESS_PROXY || '').trim();
let _agent = null;

export function hasEgressProxy() { return !!PROXY; }

// Inicializa o ProxyAgent uma vez (chamar no arranque do worker). Devolve se ativo.
export async function initEgress() {
  if (!PROXY || _agent) return !!PROXY;
  if (/^socks/i.test(PROXY)) { console.warn('[egress] socks não suportado no fetch; usa o modo kernel do sidecar.'); return false; }
  try { const { ProxyAgent } = await import('undici'); _agent = new ProxyAgent(PROXY); console.log(`[egress] egresso externo por ${PROXY}`); return true; }
  catch (e) { console.warn(`[egress] falha a configurar proxy: ${e.message}`); return false; }
}

// Dispatcher undici (ProxyAgent) para fetches EXTERNOS; undefined se sem proxy
// (fetch usa o default = direto). Requer initEgress() prévio.
export function egressDispatcher() { return _agent || undefined; }

// Argumento p/ o Chromium (puppeteer/lighthouse). null quando sem proxy.
export function browserProxyArg() { return PROXY ? `--proxy-server=${PROXY}` : null; }
