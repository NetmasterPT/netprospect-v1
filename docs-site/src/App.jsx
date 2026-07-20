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
const ContentCtx = createContext(initialContent);
const useContent = () => useContext(ContentCtx);
const Chev = ({ size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
);

// pesquisa partilhada (sidebar + drawer de pesquisa)
function searchPages(pages, q) {
  const s = q.trim().toLowerCase();
  if (!s) return null;
  return pages.map((p) => {
    let sc = 0;
    if (p.title.toLowerCase().includes(s)) sc += 10;
    if ((p.tags || []).some((t) => String(t).toLowerCase().includes(s))) sc += 5;
    if ((p.title + ' ' + (p.tags || []).join(' ') + ' ' + p.text).toLowerCase().includes(s)) sc += 1;
    return { p, sc };
  }).filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc).slice(0, 40).map((x) => x.p);
}
const Dot = ({ type }) => <span className="np-dot" style={{ background: TYPE_COLOR[type] || '#8595AB', width: 8, height: 8, borderRadius: 999, flex: '0 0 auto' }} />;

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

function Topbar({ theme, toggleTheme, q, setQ, onRefresh, refreshing, onMic, recording, onHamburger, onSearch, onGraph }) {
  return (
    <div className="np-topbar">
      <button className="np-iconbtn np-hamburger" onClick={onHamburger} aria-label="Menu"><Icon name="menu" size={18} /></button>
      <Link to="/"><Brandmark pill="Docs" /></Link>
      <SearchBox placeholder="Procurar na documentação…" value={q} onChange={setQ} onMic={onMic} recording={recording} />
      <div className="np-head-actions">
        <button className="np-iconbtn np-searchbtn" onClick={onSearch} title="Pesquisar" aria-label="Pesquisar"><Icon name="search" size={16} /></button>
        <button className="np-iconbtn" onClick={onGraph} title="Grafo do conhecimento" aria-label="Grafo"><Icon name="activity" size={16} /></button>
        <button className={`np-iconbtn${refreshing ? ' rec' : ''}`} onClick={onRefresh} title="Atualizar" aria-label="Atualizar"><Icon name="refresh" size={16} /></button>
        <ThemeToggleButton theme={theme} onToggle={toggleTheme} />
        <ProfileMenu name="NetProspect" role="Documentação" />
      </div>
    </div>
  );
}

function Sidebar({ q, groups, navOpen, onCloseNav, onSearch, onGraph }) {
  const content = useContent();
  const [open, setOpen] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('np-docs-nav') || '[]')); } catch { return new Set(); }
  });
  const toggle = useCallback((name) => setOpen((s) => {
    const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name);
    try { localStorage.setItem('np-docs-nav', JSON.stringify([...n])); } catch {}
    return n;
  }), []);
  const results = useMemo(() => searchPages(content.pages, q), [q, content]);
  const row = (p) => (
    <Link key={p.slug} to={'/' + p.slug} className="np-nav-row" onClick={onCloseNav}>
      <Dot type={p.type} /><span>{p.title}</span>
    </Link>
  );
  return (
    <aside className={`np-nav${navOpen ? ' open' : ''}`}>
      <div className="np-nav-actions">
        <button className="np-iconbtn" onClick={onSearch} title="Pesquisar"><Icon name="search" size={16} /></button>
        <button className="np-iconbtn" onClick={onGraph} title="Grafo do conhecimento"><Icon name="activity" size={16} /></button>
        <a href="/docs/storybook/" target="_blank" rel="noreferrer" className="np-iconbtn" title="Storybook"><Icon name="sparkles" size={16} /></a>
      </div>
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

// Drawer de PESQUISA (docs) — input + resultados.
function SearchDrawer({ open, onClose }) {
  const content = useContent();
  const [q, setQ] = useState('');
  useEffect(() => { if (!open) setQ(''); }, [open]);
  const results = useMemo(() => searchPages(content.pages, q) || [], [q, content]);
  return (
    <>
      <div className={`np-scrim${open ? ' open' : ''}`} onClick={onClose} />
      <aside className={`np-drawer np-drawer--wide${open ? ' open' : ''}`} role="dialog" aria-hidden={!open}>
        {open && (
          <div className="np-chatwrap" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div className="np-drawer-h">
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, background: 'var(--np-surface-2)', border: '1px solid var(--np-border)', borderRadius: 'var(--np-radius)', padding: '0 12px', height: 38 }}>
                <Icon name="search" size={16} />
                <input autoFocus placeholder="Procurar na documentação…" value={q} onChange={(e) => setQ(e.target.value)}
                  style={{ flex: 1, border: 'none', background: 'none', color: 'var(--np-text)', font: 'inherit', fontSize: 14, outline: 'none' }} />
              </div>
              <button className="np-iconbtn" onClick={onClose} aria-label="Fechar" style={{ borderColor: 'var(--np-border)', color: 'var(--np-text-2)' }}><Icon name="x" size={16} /></button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
              {q.trim() === '' && <p className="muted" style={{ padding: 12, fontSize: 13, textAlign: 'center' }}>Escreve para procurar em {content.pages.length} docs.</p>}
              {q.trim() !== '' && results.length === 0 && <p className="muted" style={{ padding: 12, fontSize: 13 }}>Sem resultados.</p>}
              {results.map((p) => (
                <Link key={p.slug} to={'/' + p.slug} onClick={onClose} className="np-menuitem" style={{ color: 'var(--np-text)' }}>
                  <Dot type={p.type} /><span>{p.title}</span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}

// Chat de IA (bare = dentro do bottom-sheet do grafo). Citações acendem os nós.
function GraphChat({ bare, onClose, onCites, onHover }) {
  const [providers, setProviders] = useState([]);
  const [provider, setProvider] = useState('');
  const [input, setInput] = useState('');
  const [msgs, setMsgs] = useState([]);
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
    <div className={bare ? 'np-chatwrap' : 'np-card'} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: bare ? 0 : 420 }}>
      <div className="np-drawer-h">
        <h2 style={{ fontSize: 15, fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="sparkles" size={16} /> Pesquisa IA</h2>
        <div className="np-head-actions">
          {providers.length > 0 && (
            <Segmented value={provider} onChange={setProvider}
              options={providers.map((p) => ({ value: p.id, label: p.available ? p.label.split(' · ')[0] : `${p.label} (off)` }))} />
          )}
          {onClose && (
            <button className="np-iconbtn" onClick={onClose} aria-label="Fechar" style={{ borderColor: 'var(--np-border)', color: 'var(--np-text-2)' }}><Icon name="x" size={16} /></button>
          )}
        </div>
      </div>
      <div ref={bodyRef} style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {msgs.length === 0 && (
          <div className="muted" style={{ fontSize: 13.5, maxWidth: 560, margin: '16px auto', textAlign: 'center' }}>
            <div style={{ marginBottom: 8 }}><Icon name="sparkles" size={26} /></div>
            Pergunta algo sobre a documentação. As respostas citam as fontes e <b>acendem os nós</b> no grafo.
          </div>
        )}
        {msgs.map((m, i) => (
          <div className="np-chatmsg" key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'stretch', maxWidth: m.role === 'user' ? '85%' : '100%' }}>
            <div style={{ background: m.role === 'user' ? 'var(--np-brand-soft)' : 'var(--np-surface-2)', color: m.role === 'user' ? 'var(--np-brand-ink)' : 'var(--np-text)',
              border: '1px solid var(--np-border)', borderRadius: 'var(--np-radius)', padding: '10px 13px', fontSize: 14, whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>
              {m.text || (m.role === 'assistant' && busy ? '▋' : '')}
            </div>
            {m.cites && m.cites.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
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
      <div style={{ borderTop: '1px solid var(--np-divider)', padding: 12, display: 'flex', gap: 8 }}>
        <input className="np-input" placeholder="Perguntar à documentação…" value={input}
          onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask()} disabled={busy} autoFocus />
        <Button variant="primary" onClick={ask} disabled={busy || !input.trim()}><Icon name="send" size={15} /></Button>
        <Button size="sm" onClick={() => window.open('/notebook/', '_blank')} title="Aprofundar no Open Notebook (Fase 3)"><Icon name="ext" size={14} /></Button>
      </div>
    </div>
  );
}

// Drawer do GRAFO — ForceGraph + chat como bottom-sheet.
function GraphDrawer({ open, onClose }) {
  const content = useContent();
  const navigate = useNavigate();
  const [dim, setDim] = useState({ w: 600, h: 500 });
  const [hi, setHi] = useState(() => new Set());
  const [hover, setHover] = useState(null);
  const [chatOpen, setChatOpen] = useState(false);
  const wrapRef = useRef(null);
  useEffect(() => { if (!open) { setChatOpen(false); } }, [open]);
  useEffect(() => {
    if (!open) return;
    const fit = () => { const el = wrapRef.current; if (el) setDim({ w: Math.max(280, el.clientWidth - 2), h: Math.max(320, el.clientHeight - 2) }); };
    const t = setTimeout(fit, 90); window.addEventListener('resize', fit);
    return () => { clearTimeout(t); window.removeEventListener('resize', fit); };
  }, [open]);
  const data = useMemo(() => ({ nodes: content.graph.nodes.map((n) => ({ ...n })), links: content.graph.links.map((l) => ({ ...l })) }), [content]);
  const active = hi.size > 0 || hover;
  const isOn = (id) => hover === id || hi.has(id);
  const nodeColor = (n) => { const base = TYPE_COLOR[n.type] || '#9ca3af'; return !active ? base : (isOn(n.id) ? base : 'rgba(128,128,128,0.16)'); };
  return (
    <>
      <div className={`np-scrim${open ? ' open' : ''}`} onClick={onClose} />
      <aside className={`np-drawer np-drawer--wide${open ? ' open' : ''}`} role="dialog" aria-hidden={!open}>
        <div className="np-drawer-h">
          <h2 style={{ fontSize: 15, fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="activity" size={16} /> Grafo do conhecimento</h2>
          <div className="np-head-actions">
            <span className="muted" style={{ fontSize: 12 }}>{data.nodes.length} docs · {data.links.length} ligações</span>
            <button className="np-iconbtn" onClick={onClose} aria-label="Fechar" style={{ borderColor: 'var(--np-border)', color: 'var(--np-text-2)' }}><Icon name="x" size={16} /></button>
          </div>
        </div>
        <div ref={wrapRef} style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          {open && (
            <ForceGraph2D graphData={data} width={dim.w} height={dim.h} nodeLabel="title" nodeRelSize={4}
              nodeVal={(n) => 1 + (n.deg || 0)} nodeColor={nodeColor}
              linkColor={() => active ? 'rgba(128,128,128,0.08)' : 'rgba(128,128,128,0.22)'}
              cooldownTicks={120} onNodeClick={(n) => { onClose(); navigate('/' + n.id); }} />
          )}
          {!chatOpen && (
            <Button variant="primary" onClick={() => setChatOpen(true)}
              style={{ position: 'absolute', right: 16, bottom: 16, boxShadow: 'var(--np-shadow-brand)', zIndex: 3 }}>
              <Icon name="sparkles" size={15} /> Pesquisa IA
            </Button>
          )}
          <div className="np-sheet" data-open={chatOpen ? 'true' : 'false'}>
            {chatOpen && <GraphChat bare onClose={() => setChatOpen(false)} onCites={(slugs) => setHi(new Set(slugs))} onHover={setHover} />}
          </div>
        </div>
      </aside>
    </>
  );
}

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const [q, setQ] = useState('');
  const [content, setContent] = useState(initialContent);
  const [refreshing, setRefreshing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [nav, setNav] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const recognitionRef = useRef(null);
  const location = useLocation();

  useEffect(() => { initPosthog().then((ph) => { if (ph) ph.capture('$pageview'); }); }, []);
  // fecha os drawers ao navegar; #/graph abre o grafo
  useEffect(() => { setNav(false); setSearchOpen(false); if (location.pathname === '/graph') setGraphOpen(true); else setGraphOpen(false); }, [location.pathname]);
  const only = (which) => { setNav(which === 'nav'); setSearchOpen(which === 'search'); setGraphOpen(which === 'graph'); };

  const groups = useMemo(() => {
    const g = {};
    for (const p of content.pages) (g[p.type] ||= []).push(p);
    for (const k in g) g[k].sort((a, b) => a.title.localeCompare(b.title));
    return g;
  }, [content]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { const r = await fetch(`content.json?t=${Date.now()}`, { cache: 'no-store' }); if (r.ok) setContent(await r.json()); } catch {}
    setTimeout(() => setRefreshing(false), 400);
  }, []);

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
        onRefresh={onRefresh} refreshing={refreshing} onMic={onMic} recording={recording}
        onHamburger={() => { setSearchOpen(false); setGraphOpen(false); setNav((v) => !v); }}
        onSearch={() => only('search')} onGraph={() => only('graph')} />
      {/* scrim do nav (mobile) */}
      <div className={`np-scrim${nav ? ' open' : ''}`} onClick={() => setNav(false)} />
      <div className="np-shell">
        <Sidebar q={q} groups={groups} navOpen={nav} onCloseNav={() => setNav(false)}
          onSearch={() => only('search')} onGraph={() => only('graph')} />
        <Routes>
          <Route path="/*" element={<Page />} />
        </Routes>
      </div>
      <SearchDrawer open={searchOpen} onClose={() => setSearchOpen(false)} />
      <GraphDrawer open={graphOpen} onClose={() => setGraphOpen(false)} />
    </ContentCtx.Provider>
  );
}
