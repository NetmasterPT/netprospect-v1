/** Primitivos do design-system NetProspect (classes np-*, ver ui.css). */
import React from 'react';

export function Button({ variant = 'default', size = 'md', children, ...rest }) {
  const cls = ['np-btn', variant === 'primary' && 'np-btn--primary', size === 'sm' && 'np-btn--sm'].filter(Boolean).join(' ');
  return <button className={cls} {...rest}>{children}</button>;
}

export function Segmented({ options = [], value, onChange }) {
  return (
    <div className="np-seg">
      {options.map((o) => (
        <button key={o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange && onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Badge({ tone = 'neutral', children }) {
  return <span className={`np-badge ${tone}`}>{children}</span>;
}

export function Chip({ variant = 'default', children }) {
  return <span className={variant === 'default' ? 'np-chip' : `np-chip np-chip--${variant}`}>{children}</span>;
}

export function IconButton({ children, label, ...rest }) {
  return <button className="np-iconbtn" aria-label={label} title={label} {...rest}>{children}</button>;
}

export function Input({ ...rest }) {
  return <input className="np-input" {...rest} />;
}
