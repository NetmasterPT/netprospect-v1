/** Cartões: contentor genérico (Card), cartão de estatística (StatCard/KPI) e grelha de KPIs. */
import React from 'react';
import { Icon, hasIcon } from './icons.jsx';

export function Card({ title, actions, children, padded = true }) {
  return (
    <section className="np-card">
      {(title || actions) && (
        <div className="np-card-h">
          {title ? <h2>{title}</h2> : <span />}
          {actions && <div className="np-head-actions">{actions}</div>}
        </div>
      )}
      <div className={padded ? 'np-card-b' : undefined}>{children}</div>
    </section>
  );
}

export function StatCard({ label, icon, value, sub, href }) {
  const Tag = href ? 'a' : 'div';
  return (
    <Tag className="np-kpi" href={href} style={href ? { display: 'block' } : undefined}>
      <div className="np-kpi-l">
        {icon && <span className="np-kpi-ic">{hasIcon(icon) ? <Icon name={icon} size={15} /> : icon}</span>}
        <span>{label}</span>
      </div>
      <div className="np-kpi-v tnum">{value}</div>
      {sub && <div className="np-kpi-sub">{sub}</div>}
    </Tag>
  );
}

export function StatGrid({ children }) {
  return <div className="np-kpis">{children}</div>;
}
