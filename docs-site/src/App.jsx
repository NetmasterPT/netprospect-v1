import React, { useMemo, useState, useEffect } from 'react';
import { Routes, Route, Link, useParams, useLocation } from 'react-router-dom';
import content from './content.json';

const TYPE_ORDER = ['explanation', 'how-to', 'tutorial', 'reference', 'incident', 'working'];
const TYPE_LABEL = {
  explanation: '🧠 Explanation', 'how-to': '🛠️ How-to', tutorial: '🚀 Tutorials',
  reference: '📖 Reference', incident: '🚨 Incidents', working: '📝 Working docs',
};
const bySlug = Object.fromEntries(content.pages.map((p) => [p.slug, p]));

function Sidebar() {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const g = {};
    for (const p of content.pages) (g[p.type] ||= []).push(p);
    for (const k in g) g[k].sort((a, b) => a.title.localeCompare(b.title));
    return g;
  }, []);
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return null;
    return content.pages
      .map((p) => {
        const hay = (p.title + ' ' + (p.tags || []).join(' ') + ' ' + p.text).toLowerCase();
        let score = 0;
        if (p.title.toLowerCase().includes(s)) score += 10;
        if ((p.tags || []).some((t) => String(t).toLowerCase().includes(s))) score += 5;
        if (hay.includes(s)) score += 1;
        return { p, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40);
  }, [q]);

  return (
    <aside className="sidebar">
      <Link to="/" className="brand">NetProspect · <b>Docs</b></Link>
      <input className="search" placeholder="Procurar…" value={q} onChange={(e) => setQ(e.target.value)} />
      {results ? (
        <nav className="nav">
          <div className="group-title">{results.length} resultado(s)</div>
          {results.map(({ p }) => (
            <Link key={p.slug} to={'/' + p.slug} className="nav-link">
              {p.title} <span className="chip mini">{p.type}</span>
            </Link>
          ))}
        </nav>
      ) : (
        <nav className="nav">
          {TYPE_ORDER.filter((t) => groups[t]).map((t) => (
            <div key={t} className="group">
              <div className="group-title">{TYPE_LABEL[t] || t}</div>
              {groups[t].map((p) => (
                <Link key={p.slug} to={'/' + p.slug} className="nav-link">{p.title}</Link>
              ))}
            </div>
          ))}
        </nav>
      )}
    </aside>
  );
}

function Page() {
  const slug = useParams()['*'] || content.home;
  const location = useLocation();
  const page = bySlug[slug] || bySlug[content.home];
  useEffect(() => { window.scrollTo(0, 0); }, [location.pathname]);
  if (!page) return <main className="content"><h1>404</h1><p>Página não encontrada.</p></main>;
  return (
    <main className="content">
      <div className="meta">
        <span className="chip">{page.type}</span>
        {page.status && <span className="chip">{page.status}</span>}
        {page.visibility === 'internal' && <span className="chip warn">interno</span>}
        {page.updated && <span className="chip mini">atualizado {page.updated}</span>}
        {(page.tags || []).map((t) => <span key={t} className="chip tag">#{t}</span>)}
      </div>
      <article className="prose" dangerouslySetInnerHTML={{ __html: page.html }} />
      <footer className="pagefoot">
        <span>{page.slug}.md</span>
        {page.owner && <span> · owner: {page.owner}</span>}
      </footer>
    </main>
  );
}

export default function App() {
  return (
    <div className="layout">
      <Sidebar />
      <Routes>
        <Route path="/*" element={<Page />} />
      </Routes>
    </div>
  );
}
