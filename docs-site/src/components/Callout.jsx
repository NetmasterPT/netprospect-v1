/** Callout estilo Obsidian (note/tip/warning/danger/info). Design-system do site de docs. */
const STYLES = {
  note: { border: '#60a5fa', bg: 'rgba(96,165,250,.10)', icon: '📝' },
  tip: { border: '#34d399', bg: 'rgba(52,211,153,.10)', icon: '💡' },
  warning: { border: '#fbbf24', bg: 'rgba(251,191,36,.12)', icon: '⚠️' },
  danger: { border: '#f87171', bg: 'rgba(248,113,113,.12)', icon: '🔥' },
  info: { border: '#a78bfa', bg: 'rgba(167,139,250,.10)', icon: 'ℹ️' },
};

export function Callout({ type = 'note', title, children }) {
  const s = STYLES[type] || STYLES.note;
  return (
    <div style={{
      borderLeft: `3px solid ${s.border}`, background: s.bg, padding: '10px 14px',
      borderRadius: '0 8px 8px 0', maxWidth: 540, color: 'var(--fg, #e6e8eb)',
      font: '14px/1.55 -apple-system, "Segoe UI", Roboto, sans-serif',
    }}>
      <div style={{ fontWeight: 700, marginBottom: children ? 4 : 0 }}>
        {s.icon} {title || type.toUpperCase()}
      </div>
      {children && <div style={{ opacity: 0.9 }}>{children}</div>}
    </div>
  );
}
