/** Tipografia do design-system: cabeçalhos de página, títulos de secção, blocos de texto. */
import React from 'react';

export function PageHeader({ eyebrow, title, sub, actions }) {
  return (
    <header className="np-head">
      <div>
        {eyebrow && <div className="np-eyebrow">{eyebrow}</div>}
        <h1 className="np-h1">{title}</h1>
        {sub && <p className="np-sub">{sub}</p>}
      </div>
      {actions && <div className="np-head-actions">{actions}</div>}
    </header>
  );
}

export function SectionTitle({ children }) {
  return <h2 className="np-h2">{children}</h2>;
}

export function Eyebrow({ children }) {
  return <div className="np-eyebrow">{children}</div>;
}

export function Text({ children }) {
  return <p className="np-text">{children}</p>;
}

export function Muted({ children }) {
  return <span className="muted">{children}</span>;
}
