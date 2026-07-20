/** Componentes de dados/filtros: Facet (dropdown de filtro) e Table (tabela do directório). */
import React from 'react';

export function Facet({ label, active, open, onToggle, children }) {
  return (
    <div className={`np-facet${active ? ' on' : ''}`}>
      <button onClick={onToggle}>{label}<span style={{ opacity: .6 }}>▾</span></button>
      {open && <div className="np-facet-dd">{children}</div>}
    </div>
  );
}

export function FacetOption({ children, onClick }) {
  return <div className="np-menuitem" onClick={onClick}>{children}</div>;
}

export function Table({ columns = [], rows = [] }) {
  return (
    <div className="np-tablewrap">
      <table className="np-table">
        <thead><tr>{columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{columns.map((c) => <td key={c.key}>{c.render ? c.render(r) : r[c.key]}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
