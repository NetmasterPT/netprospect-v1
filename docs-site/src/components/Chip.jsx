/** Chip de metadata (design-system np-*). variantes: default / tag / mini / warn. */
export function Chip({ children, variant = 'default' }) {
  return <span className={variant === 'default' ? 'np-chip' : `np-chip np-chip--${variant}`}>{children}</span>;
}
