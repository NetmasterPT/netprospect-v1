// Cliente da API de conhecimento (kb-http via nginx /api/kb/) + init PostHog para o SPA dos docs.
const BASE = '/api/kb';

export async function kbModules(profile) {
  const r = await fetch(`${BASE}/modules${profile ? `?profile=${encodeURIComponent(profile)}` : ''}`);
  if (!r.ok) throw new Error(`modules HTTP ${r.status}`);
  return r.json();
}

export async function kbProviders() {
  try { const r = await fetch(`${BASE}/chat/providers`); return r.ok ? r.json() : []; }
  catch { return []; }
}

export async function kbSearch(query, { profile, limit = 8 } = {}) {
  const qs = new URLSearchParams({ q: query, limit: String(limit), ...(profile ? { profile } : {}) });
  const r = await fetch(`${BASE}/search?${qs}`);
  return r.ok ? r.json() : [];
}

// Stream do chat via SSE (fetch + reader; EventSource não faz POST). Callbacks: onCite/onToken/onDone/onError.
export async function kbChatStream({ query, profile, source, model, provider, distinctId }, { onCite, onToken, onDone, onError } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, profile, source, model: model || provider, distinctId }),
    });
  } catch (e) { onError && onError(e); return; }
  if (!res.ok || !res.body) { onError && onError(new Error(`chat HTTP ${res.status}`)); return; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const ev = /^event: (.+)$/m.exec(raw)?.[1];
      const dm = /^data: ([\s\S]+)$/m.exec(raw)?.[1];
      if (!ev || !dm) continue;
      let data; try { data = JSON.parse(dm); } catch { continue; }
      if (ev === 'cite') onCite && onCite(data);
      else if (ev === 'token') onToken && onToken(data.t);
      else if (ev === 'done') onDone && onDone(data);
      else if (ev === 'error') onError && onError(new Error(data.error));
    }
  }
}

// PostHog: init a partir de /api/kb/posthog-config (public key p/ o browser). Fail-soft.
let _ph = null;
export async function initPosthog() {
  if (_ph) return _ph;
  try {
    const cfg = await fetch(`${BASE}/posthog-config`).then((r) => r.json());
    if (!cfg.enabled || !cfg.key) return null;
    const { default: posthog } = await import('posthog-js');
    posthog.init(cfg.key, { api_host: cfg.host, capture_pageview: false, persistence: 'localStorage+cookie' });
    posthog.register({ app_name: 'docs' });
    _ph = posthog;
    return posthog;
  } catch { return null; }
}
export const posthog = () => _ph;
