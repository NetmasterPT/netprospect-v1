/** Chrome estrutural: marca (brandmark), Topbar e contentor de shell (topbar + nav + main). */
import React from 'react';

export function Brandmark({ label = 'NetProspect', pill }) {
  // Espelha o dashboard: "Net" + "Prospect" a vermelho de marca.
  const word = label === 'NetProspect'
    ? <>Net<span style={{ color: 'var(--np-brand)' }}>Prospect</span></>
    : label;
  return (
    <span className="np-brand">
      <span className="np-brandmark"><i /></span>
      <span className="np-word">{word}</span>
      {pill && <span className="np-pilltag">{pill}</span>}
    </span>
  );
}

export function SearchBox({ placeholder = 'Procurar…', value, onChange }) {
  return (
    <div className="np-tsearch">
      <span style={{ opacity: .6 }}>⌕</span>
      <input placeholder={placeholder} value={value} onChange={(e) => onChange && onChange(e.target.value)} />
      <span className="np-kbd">↩</span>
    </div>
  );
}

/** Barra superior (chrome escuro): marca à esquerda, pesquisa ao centro, acções à direita. */
export function Topbar({ brand, search, actions }) {
  return (
    <div className="np-topbar">
      {brand || <Brandmark />}
      {search}
      <div className="np-head-actions">{actions}</div>
    </div>
  );
}

export function ThemeToggleButton({ theme = 'dark', onToggle }) {
  return (
    <button className="np-iconbtn np-themebtn" onClick={onToggle} title="Alternar tema">
      {theme === 'dark' ? '☀️ Claro' : '🌙 Escuro'}
    </button>
  );
}
