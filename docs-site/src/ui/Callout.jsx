/** Callout estilo Obsidian, agora sobre os tokens do design-system (note/tip/warning/danger/info). */
import React from 'react';

const KIND = {
  note: { tone: 'info', icon: 'ℹ️' },
  info: { tone: 'info', icon: 'ℹ️' },
  tip: { tone: 'ok', icon: '💡' },
  warning: { tone: 'warn', icon: '⚠️' },
  danger: { tone: 'danger', icon: '🔥' },
};

export function Callout({ type = 'note', title, children }) {
  const k = KIND[type] || KIND.note;
  return (
    <div style={{
      borderLeft: `3px solid var(--np-${k.tone}-mark)`,
      background: `var(--np-${k.tone}-soft)`,
      color: 'var(--np-text-2)', padding: '11px 15px', borderRadius: '0 var(--np-radius) var(--np-radius) 0',
      fontSize: 'var(--np-fs-body)', lineHeight: 'var(--np-lh-body)', margin: '14px 0',
    }}>
      <div style={{ fontWeight: 700, color: `var(--np-${k.tone})`, marginBottom: children ? 4 : 0 }}>
        {k.icon} {title || type.toUpperCase()}
      </div>
      {children && <div>{children}</div>}
    </div>
  );
}
