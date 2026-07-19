// API HTTP de conhecimento (para o site /api/kb/search + humanos + agentes por HTTP).
// Serve na tailnet (nunca público). Env: KB_HTTP_HOST, KB_HTTP_PORT.
import express from 'express';
import { searchDocs, getDoc, listRelated, meta } from './tools.mjs';

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true, ...meta() }));
app.post('/search', async (req, res) => {
  try { res.json(await searchDocs(req.body?.query, req.body?.limit)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// GET p/ conveniência do site: /search?q=...&limit=...
app.get('/search', async (req, res) => {
  try { res.json(await searchDocs(req.query.q, req.query.limit)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/doc', (req, res) => {
  const d = getDoc(req.query.slug || '');
  d ? res.json(d) : res.status(404).json({ error: 'not found' });
});
app.get('/related', (req, res) => res.json(listRelated(req.query.slug || '')));

const PORT = +(process.env.KB_HTTP_PORT || 8099);
const HOST = process.env.KB_HTTP_HOST || '127.0.0.1';
app.listen(PORT, HOST, () => console.log(`kb-http em http://${HOST}:${PORT} — ${JSON.stringify(meta())}`));
