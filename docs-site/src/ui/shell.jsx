/** Chrome estrutural: marca (brandmark), Topbar e contentor de shell (topbar + nav + main). */
import React from 'react';
import { Icon } from './icons.jsx';

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
      {/* mobile: só o nome da app (ex.: "Docs"), sem "NetProspect" — CSS mostra só ≤820px */}
      <span className="np-appname">{pill || label}</span>
    </span>
  );
}

export function SearchBox({ placeholder = 'Procurar…', value, onChange, onMic, recording = false }) {
  return (
    <div className="np-tsearch">
      <Icon name="search" size={16} />
      <input placeholder={placeholder} value={value} onChange={(e) => onChange && onChange(e.target.value)} />
      <button type="button" className={`np-mic${recording ? ' rec' : ''}`} onClick={onMic}
        title="Falar (voz → texto)" aria-label="Pesquisa por voz">
        <Icon name="mic" size={16} />
      </button>
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
  // Igual ao dashboard: botão só-ícone (sol no escuro → passa a claro; lua no claro → passa a escuro).
  return (
    <button className="np-iconbtn" onClick={onToggle} title="Alternar tema" aria-label="Alternar tema">
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
    </button>
  );
}
