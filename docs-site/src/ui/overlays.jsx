/** Sobreposições do chrome: scrim, side drawer, drawer de notificações e menu de perfil da topbar. */
import React from 'react';
import { Icon, hasIcon } from './icons.jsx';

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
              style={{ borderColor: 'var(--np-border)', color: 'var(--np-text-2)' }}><Icon name="x" size={16} /></button>
          </div>
        </div>
        <div className="np-drawer-b">{children}</div>
      </aside>
    </>
  );
}

const NOTIF_ICON = { ok: 'check', warn: 'bell', info: 'activity', danger: 'x', neutral: 'dash' };

export function NotificationsDrawer({ open, onClose, items = [] }) {
  return (
    <Drawer open={open} onClose={onClose} title="Notificações">
      {items.length === 0 && <p className="muted" style={{ padding: '4px 0' }}>Sem notificações.</p>}
      {items.map((n, i) => {
        const tone = n.tone || 'neutral';
        const iconName = n.icon || NOTIF_ICON[tone];
        return (
          <div className="np-notif" key={i}>
            <span className="np-kpi-ic" style={{ background: `var(--np-${tone}-soft)`, color: `var(--np-${tone})` }}>
              {hasIcon(iconName) ? <Icon name={iconName} size={15} /> : iconName}
            </span>
            <div style={{ flex: 1 }}>
              <div className="np-notif-t">{n.title}</div>
              <div className="np-notif-d">{n.body}{n.time ? ` · ${n.time}` : ''}</div>
            </div>
          </div>
        );
      })}
    </Drawer>
  );
}

/** Perfil da topbar: avatar + nome/papel (como no dashboard). Clicável abre um dropdown (extensão). */
export function ProfileMenu({ name = 'NetProspect', role, email, items = [], open, onToggle }) {
  const initials = name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const hasMenu = items.length > 0 || email;
  return (
    <div className="np-profile" style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 6 }}>
      <span className="np-avatar" onClick={hasMenu ? onToggle : undefined} title={name}>{initials}</span>
      <div style={{ fontSize: 12, lineHeight: 1.2, cursor: hasMenu ? 'pointer' : 'default' }} onClick={hasMenu ? onToggle : undefined}>
        <div style={{ fontWeight: 700, color: 'var(--np-chrome-text)' }}>{name}</div>
        {role && <div style={{ color: 'var(--np-chrome-text-2)' }}>{role}</div>}
      </div>
      {open && hasMenu && (
        <div className="np-profile-dd">
          {email && (
            <div className="np-profile-head">
              <div style={{ fontWeight: 700, fontSize: 13 }}>{name}</div>
              <div className="muted" style={{ fontSize: 12 }}>{email}</div>
            </div>
          )}
          {items.map((it, i) => (
            <div className="np-menuitem" key={i} onClick={it.onClick}>{it.icon}{it.label}</div>
          ))}
        </div>
      )}
    </div>
  );
}
