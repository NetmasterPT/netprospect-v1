/** Navegação lateral (chrome): item de menu e grupo colapsável — espelha a sidebar do dashboard. */
import React, { useState } from 'react';

export function MenuItem({ icon, label, count, active, onClick, dot }) {
  return (
    <div className={`np-nav-row${active ? ' is-active' : ''}`} onClick={onClick}>
      {dot && <span style={{ width: 8, height: 8, borderRadius: 999, background: dot, flex: '0 0 auto' }} />}
      {icon}
      <span>{label}</span>
      {count != null && <span className="np-nav-count">{count}</span>}
    </div>
  );
}

export function CollapsibleMenu({ title, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`np-nav-group${open ? '' : ' collapsed'}`}>
      <div className="np-nav-head" onClick={() => setOpen((v) => !v)}>
        <span>{title}</span>
        <span className="np-nav-chev" aria-hidden>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
            <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </div>
      <div className="np-nav-sub">{children}</div>
    </div>
  );
}
