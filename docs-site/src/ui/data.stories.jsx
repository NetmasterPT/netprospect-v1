import React, { useState } from 'react';
import { Facet, FacetOption, Table } from './data.jsx';
import { Badge } from './primitives.jsx';

export default { title: 'UI/Dados', parameters: { layout: 'padded' } };

export const FiltroFacet = () => {
  const [open, setOpen] = useState(true);
  const [sel, setSel] = useState('Todos');
  return (
    <div style={{ minHeight: 260 }}>
      <Facet label={`Plataforma: ${sel}`} active={sel !== 'Todos'} open={open} onToggle={() => setOpen((v) => !v)}>
        {['Todos', 'WordPress', 'Wix', 'Shopify', 'Squarespace'].map((p) => (
          <FacetOption key={p} onClick={() => { setSel(p); setOpen(false); }}>{p}</FacetOption>
        ))}
      </Facet>
    </div>
  );
};

export const Tabela = () => (
  <Table
    columns={[
      { key: 'site', label: 'Site' },
      { key: 'plat', label: 'Plataforma' },
      { key: 'score', label: 'Score' },
      { key: 'status', label: 'Estado', render: (r) => <Badge tone={r.tone}>{r.status}</Badge> },
    ]}
    rows={[
      { site: 'hotel-abc.pt', plat: 'WordPress', score: 82, status: 'Qualificado', tone: 'ok' },
      { site: 'restaurante-xy.pt', plat: 'Wix', score: 61, status: 'Pendente', tone: 'warn' },
      { site: 'clinica-z.pt', plat: 'Shopify', score: 44, status: 'Baixo', tone: 'neutral' },
    ]}
  />
);
