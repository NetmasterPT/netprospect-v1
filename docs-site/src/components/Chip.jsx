/** Chip de metadata do site de docs (type/status/tags/visibility). Estilo em styles.css (.chip). */
export function Chip({ children, variant = 'default' }) {
  const extra = variant === 'default' ? '' : ` ${variant}`;
  return <span className={`chip${extra}`}>{children}</span>;
}
