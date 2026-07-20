/** Sobreposições do chrome: scrim, side drawer, drawer de notificações e menu de perfil da topbar. */
import React from 'react';

export function Scrim({ open, onClick }) {
  return <div className={`np-scrim${open ? ' open' : ''}`} onClick={onClick} />;
}

/** Painel deslizante à direita. `open` controla o estado; usar com <Scrim>. */
export function Drawer({ open, onClose, title, actions, children }) {
  return (
    <>
      <Scrim open={open} onClick={onClose} />
      <aside className={`np-drawer${open ? ' open' : ''}`} role="dialog" aria-hidden={!open}>
        <div className="np-drawer-h">
          <strong>{title}</strong>
          <div className="np-head-actions">
            {actions}
            <button className="np-iconbtn" onClick={onClose} aria-label="Fechar"
              style={{ borderColor: 'var(--np-border)', color: 'var(--np-text-2)' }}>✕</button>
          </div>
        </div>
        <div className="np-drawer-b">{children}</div>
      </aside>
    </>
  );
}

const NOTIF_TONE = { ok: 'var(--np-ok-mark)', warn: 'var(--np-warn-mark)', info: 'var(--np-info-mark)', danger: 'var(--np-danger-mark)', neutral: 'var(--np-neutral-mark)' };

export function NotificationsDrawer({ open, onClose, items = [] }) {
  return (
    <Drawer open={open} onClose={onClose} title="Notificações">
      {items.length === 0 && <p className="muted" style={{ padding: '4px 0' }}>Sem notificações.</p>}
      {items.map((n, i) => (
        <div className="np-notif" key={i}>
          <span className="np-notif-dot" style={{ background: NOTIF_TONE[n.tone] || NOTIF_TONE.neutral }} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 13 }}>{n.title}</div>
            <div className="muted" style={{ fontSize: 12 }}>{n.body}</div>
            {n.time && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{n.time}</div>}
          </div>
        </div>
      ))}
    </Drawer>
  );
}

/** Avatar da topbar + dropdown de perfil. `name` gera as iniciais. */
export function ProfileMenu({ name = 'NetProspect', email, items = [], open, onToggle }) {
  const initials = name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div className="np-profile">
      <div className="np-avatar" onClick={onToggle} title={name}>{initials}</div>
      {open && (
        <div className="np-profile-dd">
          <div className="np-profile-head">
            <div style={{ fontWeight: 700, fontSize: 13 }}>{name}</div>
            {email && <div className="muted" style={{ fontSize: 12 }}>{email}</div>}
          </div>
          {items.map((it, i) => (
            <div className="np-menuitem" key={i} onClick={it.onClick}>{it.icon}{it.label}</div>
          ))}
        </div>
      )}
    </div>
  );
}
