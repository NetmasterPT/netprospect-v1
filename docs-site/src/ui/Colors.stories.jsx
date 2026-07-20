import React from 'react';

export default { title: 'UI/Cores', parameters: { layout: 'padded' } };

const GROUPS = {
  'Superfícies': ['bg', 'bg-2', 'surface', 'surface-2', 'surface-3', 'surface-sel'],
  'Chrome (nav/topbar)': ['chrome', 'chrome-2', 'chrome-text', 'chrome-text-2'],
  'Texto': ['text', 'text-2', 'text-3', 'text-faint'],
  'Bordas': ['border', 'border-2', 'divider'],
  'Marca': ['brand', 'brand-ink', 'brand-hover', 'brand-fill', 'brand-soft', 'brand-soft-bd'],
  'Estado — OK': ['ok', 'ok-mark', 'ok-soft', 'ok-soft-bd'],
  'Estado — Warn': ['warn', 'warn-mark', 'warn-soft', 'warn-soft-bd'],
  'Estado — Info': ['info', 'info-mark', 'info-soft', 'info-soft-bd'],
  'Estado — Danger': ['danger', 'danger-mark', 'danger-soft', 'danger-soft-bd'],
  'Estado — Neutral': ['neutral', 'neutral-mark', 'neutral-soft', 'neutral-soft-bd'],
};

const Swatch = ({ name }) => (
  <div className="np-swatch">
    <div className="c" style={{ background: `var(--np-${name})` }} />
    <div className="n">--np-{name}</div>
  </div>
);

export const Paleta = () => (
  <div style={{ display: 'grid', gap: 20 }}>
    {Object.entries(GROUPS).map(([g, names]) => (
      <div key={g}>
        <h3 className="np-h2" style={{ margin: '0 0 8px' }}>{g}</h3>
        <div className="np-swatches">{names.map((n) => <Swatch key={n} name={n} />)}</div>
      </div>
    ))}
    <p className="muted" style={{ fontSize: 12 }}>
      As cores respondem ao tema (alterna claro/escuro na toolbar do Storybook). Fonte de verdade: <code>theme.css</code> (do dashboard <code>netprospect.css</code>).
    </p>
  </div>
);
