import React, { useMemo, useState, useEffect, useCallback, useRef, createContext, useContext } from 'react';
import { Routes, Route, Link, useParams, useLocation, useNavigate } from 'react-router-dom';
import ForceGraph2D from 'react-force-graph-2d';
import initialContent from './content.json';
import { Chip, Button, Segmented } from './ui/primitives.jsx';
import { Brandmark, SearchBox, ThemeToggleButton } from './ui/shell.jsx';
import { ProfileMenu } from './ui/overlays.jsx';
import { Icon } from './ui/icons.jsx';
import { kbChatStream, kbProviders, initPosthog } from './kb.js';

const TYPE_ORDER = ['explanation', 'how-to', 'tutorial', 'reference', 'incident', 'working'];
const TYPE_LABEL = {
  explanation: 'Explanation', 'how-to': 'How-to', tutorial: 'Tutorials',
  reference: 'Reference', incident: 'Incidents', working: 'Working docs',
};
const TYPE_COLOR = {
  explanation: '#a78bfa', 'how-to': '#34d399', tutorial: '#f472b6',
  reference: '#60a5fa', incident: '#f87171', working: '#fbbf24',
};
// Conteúdo em contexto → o botão "Atualizar" refaz o fetch sem reload da página.
const ContentCtx = createContext(initialContent);
const useContent = () => useContext(ContentCtx);
const Chev = ({ size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
);

// ---------- tema ----------
function useTheme() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('np-theme') || 'dark'; } catch { return 'dark'; }
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('np-theme', theme); } catch {}
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}

function Topbar({ theme, toggleTheme, q, setQ, onRefresh, refreshing, onMic, recording }) {
  return (
    <div className="np-topbar">
      <Link to="/"><Brandmark pill="Docs" /></Link>
      <SearchBox placeholder="Procurar na documentação…" value={q} onChange={setQ} onMic={onMic} recording={recording} />
      <div className="np-head-actions">
        <button className={`np-iconbtn${refreshing ? ' rec' : ''}`} onClick={onRefresh} title="Atualizar" aria-label="Atualizar">
          <Icon name="refresh" size={16} />
        </button>
        <ThemeToggleButton theme={theme} onToggle={toggleTheme} />
        <ProfileMenu name="NetProspect" role="Documentação" />
      </div>
    </div>
  );
}

function Sidebar({ q, groups }) {
  const content = useContent();
  const [open, setOpen] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('np-docs-nav') || '[]')); } catch { return new Set(); }
  });
  const toggle = useCallback((name) => setOpen((s) => {
    const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name);
    try { localStorage.setItem('np-docs-nav', JSON.stringify([...n])); } catch {}
    return n;
  }), []);
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return null;
    return content.pages
      .map((p) => {
        let sc = 0;
        if (p.title.toLowerCase().includes(s)) sc += 10;
        if ((p.tags || []).some((t) => String(t).toLowerCase().includes(s))) sc += 5;
        if ((p.title + ' ' + (p.tags || []).join(' ') + ' ' + p.text).toLowerCase().includes(s)) sc += 1;
        return { p, sc };
      })
      .filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc).slice(0, 40).map((x) => x.p);
  }, [q]);

  const row = (p) => (
    <Link key={p.slug} to={'/' + p.slug} className="np-nav-row">
      <span className="np-dot" style={{ background: TYPE_COLOR[p.type] || '#8595AB', width: 7, height: 7, borderRadius: 999, flex: '0 0 auto' }} />
      <span>{p.title}</span>
    </Link>
  );

  return (
    <aside className="np-nav">
      <Link to="/graph" className="np-nav-row" style={{ fontWeight: 700 }}><Icon name="activity" size={16} /><span>Grafo do conhecimento</span></Link>
      <a href="/docs/storybook/" target="_blank" rel="noreferrer" className="np-nav-row" style={{ fontWeight: 700 }}><Icon name="sparkles" size={16} /><span>Storybook</span><span className="np-nav-count"><Icon name="ext" size={13} /></span></a>
      {results ? (
        <div className="np-nav-group">
          <div className="np-nav-head"><span>{results.length} resultado(s)</span></div>
          <div className="np-nav-sub">{results.map(row)}</div>
        </div>
      ) : (
        TYPE_ORDER.filter((t) => groups[t]).map((t) => {
          const collapsed = open.has(t);
          return (
            <div key={t} className={`np-nav-group ${collapsed ? 'collapsed' : ''}`}>
              <div className="np-nav-head" onClick={() => toggle(t)}>
                <span>{TYPE_LABEL[t] || t}</span><span className="np-nav-chev"><Chev /></span>
              </div>
              <div className="np-nav-sub">{groups[t].map(row)}</div>
            </div>
          );
        })
      )}
    </aside>
  );
}

function Page() {
  const content = useContent();
  const bySlug = useMemo(() => Object.fromEntries(content.pages.map((p) => [p.slug, p])), [content]);
  const slug = useParams()['*'] || content.home;
  const location = useLocation();
  const page = bySlug[slug] || bySlug[content.home];
  useEffect(() => { window.scrollTo(0, 0); }, [location.pathname]);
  if (!page) return <main className="np-main"><h1 className="np-h1">404</h1><p className="muted">Página não encontrada.</p></main>;
  const badgeCls = { incident: 'warn', working: 'warn', reference: 'info', explanation: 'brand', 'how-to': 'ok' }[page.type] || 'neutral';
  return (
    <main className="np-main">
      <div className="docmeta">
        <span className={`np-badge ${badgeCls}`}>{page.type}</span>
        {page.status && <Chip>{page.status}</Chip>}
        {page.visibility === 'internal' && <span className="np-badge warn">interno</span>}
        {page.updated && <Chip variant="mini">atualizado {page.updated}</Chip>}
        {(page.tags || []).map((t) => <Chip key={t} variant="tag">#{t}</Chip>)}
      </div>
      <article className="prose" dangerouslySetInnerHTML={{ __html: page.html }} />
      <footer className="pagefoot">{page.slug}.md{page.owner ? ` · owner: ${page.owner}` : ''}</footer>
    </main>
  );
}

// Painel de chat de IA sobre o grafo (RAG federado). Citações acendem os nós + linkam às páginas.
function GraphChat({ onCites, onHover }) {
  const [providers, setProviders] = useState([]);
  const [provider, setProvider] = useState('');
  const [input, setInput] = useState('');
  const [msgs, setMsgs] = useState([]); // {role:'user'|'assistant', text, cites?}
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef(null);
  useEffect(() => { kbProviders().then((p) => { setProviders(p); const d = p.find((x) => x.available); if (d) setProvider(d.id); }); }, []);
  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [msgs]);

  const ask = useCallback(async () => {
    const query = input.trim(); if (!query || busy) return;
    setInput(''); setBusy(true);
    setMsgs((m) => [...m, { role: 'user', text: query }, { role: 'assistant', text: '', cites: [] }]);
    const patchLast = (fn) => setMsgs((m) => { const c = [...m]; c[c.length - 1] = fn(c[c.length - 1]); return c; });
    await kbChatStream({ query, provider }, {
      onCite: (cites) => { patchLast((a) => ({ ...a, cites })); onCites && onCites(cites.map((c) => c.slug)); },
      onToken: (t) => patchLast((a) => ({ ...a, text: a.text + t })),
      onError: (e) => patchLast((a) => ({ ...a, text: (a.text || '') + `\n⚠️ ${e.message}` })),
    });
    setBusy(false);
  }, [input, busy, provider, onCites]);

  return (
    <div className="np-card" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 420 }}>
      <div className="np-card-h">
        <h2 style={{ fontSize: 14 }}><Icon name="sparkles" size={15} /> Pesquisa IA no grafo</h2>
        {providers.length > 0 && (
          <Segmented value={provider} onChange={setProvider}
            options={providers.map((p) => ({ value: p.id, label: p.available ? p.label.split(' · ')[0] : `${p.label} (off)` }))} />
        )}
      </div>
      <div ref={bodyRef} style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {msgs.length === 0 && <p className="muted" style={{ fontSize: 13 }}>Pergunta algo sobre a documentação. As respostas citam as fontes e acendem os nós no grafo.</p>}
        {msgs.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'stretch', maxWidth: m.role === 'user' ? '85%' : '100%' }}>
            <div style={{ background: m.role === 'user' ? 'var(--np-brand-soft)' : 'var(--np-surface-2)', color: m.role === 'user' ? 'var(--np-brand-ink)' : 'var(--np-text)',
              border: '1px solid var(--np-border)', borderRadius: 'var(--np-radius)', padding: '9px 12px', fontSize: 13.5, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
              {m.text || (m.role === 'assistant' && busy ? '…' : '')}
            </div>
            {m.cites && m.cites.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {m.cites.map((c) => (
                  <Link key={c.slug} to={'/' + c.slug} className="np-chip" style={{ cursor: 'pointer' }}
                    onMouseEnter={() => onHover && onHover(c.slug)} onMouseLeave={() => onHover && onHover(null)}
                    title={`${c.module} · ${c.slug}`}>
                    <span className="np-dot" style={{ width: 7, height: 7, borderRadius: 999, background: TYPE_COLOR[c.module?.split('/')[0]] || 'var(--np-brand)' }} />
                    [{c.n}] {c.title}
                  </Link>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div style={{ borderTop: '1px solid var(--np-divider)', padding: 10, display: 'flex', gap: 8 }}>
        <input className="np-input" placeholder="Perguntar à documentação…" value={input}
          onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask()} disabled={busy} />
        <Button variant="primary" onClick={ask} disabled={busy || !input.trim()}><Icon name="send" size={15} /></Button>
      </div>
      <div style={{ padding: '0 10px 10px' }}>
        <Button size="sm" onClick={() => window.open('/notebook/', '_blank')} title="Aprofundar no Open Notebook (Fase 3)">
          <Icon name="ext" size={13} /> Aprofundar no Notebook
        </Button>
      </div>
    </div>
  );
}

function GraphView() {
  const content = useContent();
  const navigate = useNavigate();
  const [dim, setDim] = useState({ w: 640, h: 600 });
  const [hi, setHi] = useState(() => new Set());     // slugs acesos (citações)
  const [hover, setHover] = useState(null);
  const wrapRef = useRef(null);
  useEffect(() => {
    const fit = () => {
      const w = wrapRef.current?.clientWidth || (window.innerWidth - 340);
      setDim({ w: Math.max(320, w - 2), h: Math.max(420, window.innerHeight - 240) });
    };
    fit(); window.addEventListener('resize', fit); return () => window.removeEventListener('resize', fit);
  }, []);
  const data = useMemo(() => ({
    nodes: content.graph.nodes.map((n) => ({ ...n })),
    links: content.graph.links.map((l) => ({ ...l })),
  }), [content]);
  const active = hi.size > 0 || hover;
  const isOn = (id) => hover === id || hi.has(id);
  const nodeColor = (n) => {
    const base = TYPE_COLOR[n.type] || '#9ca3af';
    if (!active) return base;
    return isOn(n.id) ? base : 'rgba(128,128,128,0.18)';   // dim os não-citados
  };
  return (
    <main className="np-main graphview" style={{ maxWidth: 1280 }}>
      <div className="np-head"><div><div className="np-eyebrow">Conhecimento</div><h1 className="np-h1">Grafo do conhecimento</h1>
        <div className="np-sub">{data.nodes.length} docs · {data.links.length} ligações. Pergunta à IA (direita) — as citações acendem os nós.</div></div></div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'stretch', flexWrap: 'wrap' }}>
        <div ref={wrapRef} className="np-card" style={{ overflow: 'hidden', flex: '1 1 560px', minWidth: 320 }}>
          <ForceGraph2D graphData={data} width={dim.w} height={dim.h} nodeLabel="title" nodeRelSize={4}
            nodeVal={(n) => 1 + (n.deg || 0)} nodeColor={nodeColor}
            linkColor={() => active ? 'rgba(128,128,128,0.10)' : 'rgba(128,128,128,0.22)'}
            cooldownTicks={120} onNodeClick={(n) => navigate('/' + n.id)} />
        </div>
        <div style={{ flex: '1 1 360px', minWidth: 300, maxWidth: 460 }}>
          <GraphChat onCites={(slugs) => setHi(new Set(slugs))} onHover={setHover} />
        </div>
      </div>
    </main>
  );
}

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const [q, setQ] = useState('');
  const [content, setContent] = useState(initialContent);
  const [refreshing, setRefreshing] = useState(false);
  const [recording, setRecording] = useState(false);
  const recognitionRef = useRef(null);

  // PostHog (flags de módulo/feature + $ai + $pageview). Fail-soft se não configurado.
  useEffect(() => { initPosthog().then((ph) => { if (ph) ph.capture('$pageview'); }); }, []);

  const groups = useMemo(() => {
    const g = {};
    for (const p of content.pages) (g[p.type] ||= []).push(p);
    for (const k in g) g[k].sort((a, b) => a.title.localeCompare(b.title));
    return g;
  }, [content]);

  // Atualizar: refaz o fetch do content.json (asset estático) sem reload da página.
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await fetch(`content.json?t=${Date.now()}`, { cache: 'no-store' });
      if (r.ok) setContent(await r.json());
    } catch {}
    setTimeout(() => setRefreshing(false), 400);
  }, []);

  // STT: pesquisa por voz via Web Speech API (pt-PT). Sem suporte → no-op.
  const onMic = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    if (recognitionRef.current) { recognitionRef.current.stop(); return; }
    const rec = new SR();
    rec.lang = 'pt-PT'; rec.interimResults = false; rec.maxAlternatives = 1;
    rec.onresult = (e) => setQ(e.results[0][0].transcript);
    rec.onend = () => { recognitionRef.current = null; setRecording(false); };
    rec.onerror = () => { recognitionRef.current = null; setRecording(false); };
    recognitionRef.current = rec; rec.start(); setRecording(true);
  }, []);

  return (
    <ContentCtx.Provider value={content}>
      <Topbar theme={theme} toggleTheme={toggleTheme} q={q} setQ={setQ}
        onRefresh={onRefresh} refreshing={refreshing} onMic={onMic} recording={recording} />
      <div className="np-shell">
        <Sidebar q={q} groups={groups} />
        <Routes>
          <Route path="/graph" element={<GraphView />} />
          <Route path="/*" element={<Page />} />
        </Routes>
      </div>
    </ContentCtx.Provider>
  );
}
