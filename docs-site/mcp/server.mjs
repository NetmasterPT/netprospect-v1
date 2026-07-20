// API HTTP de conhecimento (para o site /api/kb/search + humanos + agentes por HTTP).
// Serve na tailnet (nunca público). Env: KB_HTTP_HOST, KB_HTTP_PORT.
import express from 'express';
import { searchDocs, getDoc, listRelated, meta } from './tools.mjs';
import { modulesView } from '../kb/registry.mjs';
import { chatProviders, answer } from './chat.mjs';

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true, ...meta() }));
app.post('/search', async (req, res) => {
  try { res.json(await searchDocs(req.body?.query, req.body?.limit, req.body?.profile)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// GET p/ conveniência do site: /search?q=...&limit=...&profile=...
app.get('/search', async (req, res) => {
  try { res.json(await searchDocs(req.query.q, req.query.limit, req.query.profile)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/doc', (req, res) => {
  const d = getDoc(req.query.slug || '');
  d ? res.json(d) : res.status(404).json({ error: 'not found' });
});
app.get('/related', (req, res) => res.json(listRelated(req.query.slug || '')));

// Registry filtrado pelo perfil (p/ a UI: árvore de módulos + coleções + contagens + active).
app.get('/modules', (req, res) => {
  try { res.json({ profile: req.query.profile || process.env.DOCS_PROFILE || 'interno', modules: modulesView(req.query.profile) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Config PostHog p/ o SPA (não expõe segredos server-side; a public key é para o browser).
app.get('/posthog-config', (_req, res) => res.json({
  enabled: !!process.env.POSTHOG_PUBLIC_KEY,
  key: process.env.POSTHOG_PUBLIC_KEY || '',
  host: process.env.POSTHOG_PUBLIC_HOST || 'https://eu.i.posthog.com',
}));

// Chat de docs. GET /chat/providers lista os disponíveis; POST /chat faz stream SSE (event: cite|token|done).
app.get('/chat/providers', (_req, res) => res.json(chatProviders()));
app.post('/chat', async (req, res) => {
  const { query, profile, source, model, provider, distinctId } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query em falta' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    const r = await answer({ query, profile, source, model: model || provider, distinctId,
      onCite: (cites) => send('cite', cites),
      onToken: (t) => send('token', { t }) });
    send('done', { provider: r.provider, model: r.model, source: r.source, cites: r.cites, error: r.error || null });
  } catch (e) { send('error', { error: e.message }); }
  res.end();
});

const PORT = +(process.env.KB_HTTP_PORT || 8099);
const HOST = process.env.KB_HTTP_HOST || '127.0.0.1';
app.listen(PORT, HOST, () => console.log(`kb-http em http://${HOST}:${PORT} — ${JSON.stringify(meta())}`));
