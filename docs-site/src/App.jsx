import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { Routes, Route, Link, useParams, useLocation, useNavigate } from 'react-router-dom';
import ForceGraph2D from 'react-force-graph-2d';
import content from './content.json';
import { Chip } from './ui/primitives.jsx';
import { Brandmark, SearchBox, ThemeToggleButton } from './ui/shell.jsx';
import { Icon } from './ui/icons.jsx';

const TYPE_ORDER = ['explanation', 'how-to', 'tutorial', 'reference', 'incident', 'working'];
const TYPE_LABEL = {
  explanation: 'Explanation', 'how-to': 'How-to', tutorial: 'Tutorials',
  reference: 'Reference', incident: 'Incidents', working: 'Working docs',
};
const TYPE_COLOR = {
  explanation: '#a78bfa', 'how-to': '#34d399', tutorial: '#f472b6',
  reference: '#60a5fa', incident: '#f87171', working: '#fbbf24',
};
const bySlug = Object.fromEntries(content.pages.map((p) => [p.slug, p]));
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

function Topbar({ theme, toggleTheme, q, setQ }) {
  return (
    <div className="np-topbar">
      <Link to="/"><Brandmark pill="Docs" /></Link>
      <SearchBox placeholder="Procurar na documentação…" value={q} onChange={setQ} />
      <ThemeToggleButton theme={theme} onToggle={toggleTheme} />
    </div>
  );
}

function Sidebar({ q, groups }) {
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

function GraphView() {
  const navigate = useNavigate();
  const [dim, setDim] = useState({ w: 800, h: 600 });
  useEffect(() => {
    const fit = () => setDim({ w: Math.max(320, window.innerWidth - 340), h: Math.max(400, window.innerHeight - 220) });
    fit(); window.addEventListener('resize', fit); return () => window.removeEventListener('resize', fit);
  }, []);
  const data = useMemo(() => ({
    nodes: content.graph.nodes.map((n) => ({ ...n })),
    links: content.graph.links.map((l) => ({ ...l })),
  }), []);
  return (
    <main className="np-main graphview">
      <div className="np-head"><div><div className="np-eyebrow">Conhecimento</div><h1 className="np-h1">Grafo do conhecimento</h1>
        <div className="np-sub">{data.nodes.length} docs · {data.links.length} ligações (wikilinks). Clica num nó para abrir.</div></div></div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, margin: '4px 0 12px', fontSize: 12, color: 'var(--np-text-3)' }}>
        {TYPE_ORDER.map((t) => (
          <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <i style={{ width: 11, height: 11, borderRadius: 999, background: TYPE_COLOR[t], display: 'inline-block' }} />{TYPE_LABEL[t]}
          </span>
        ))}
      </div>
      <div className="np-card" style={{ overflow: 'hidden' }}>
        <ForceGraph2D graphData={data} width={dim.w} height={dim.h} nodeLabel="title" nodeRelSize={4}
          nodeVal={(n) => 1 + (n.deg || 0)} nodeColor={(n) => TYPE_COLOR[n.type] || '#9ca3af'}
          linkColor={() => 'rgba(128,128,128,0.22)'} cooldownTicks={120} onNodeClick={(n) => navigate('/' + n.id)} />
      </div>
    </main>
  );
}

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const g = {};
    for (const p of content.pages) (g[p.type] ||= []).push(p);
    for (const k in g) g[k].sort((a, b) => a.title.localeCompare(b.title));
    return g;
  }, []);
  return (
    <>
      <Topbar theme={theme} toggleTheme={toggleTheme} q={q} setQ={setQ} />
      <div className="np-shell">
        <Sidebar q={q} groups={groups} />
        <Routes>
          <Route path="/graph" element={<GraphView />} />
          <Route path="/*" element={<Page />} />
        </Routes>
      </div>
    </>
  );
}
