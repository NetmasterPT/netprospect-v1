import React, { useState } from 'react';
import { Button, Segmented, Badge, Chip, IconButton, Input } from './primitives.jsx';

export default { title: 'UI/Primitivos', parameters: { layout: 'padded' } };

const Row = ({ children }) => <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>{children}</div>;

export const Buttons = () => (
  <Row>
    <Button variant="primary">Ação primária</Button>
    <Button>Secundária</Button>
    <Button variant="primary" size="sm">Primária sm</Button>
    <Button size="sm">Secundária sm</Button>
  </Row>
);

export const Segmentado = () => {
  const [v, setV] = useState('all');
  return <Segmented value={v} onChange={setV} options={[
    { value: 'all', label: 'Todos' }, { value: 'live', label: 'Ativos' }, { value: 'qual', label: 'Qualificados' },
  ]} />;
};

export const Badges = () => (
  <Row>
    <Badge tone="ok">Ativo</Badge>
    <Badge tone="warn">Pendente</Badge>
    <Badge tone="info">Info</Badge>
    <Badge tone="danger">Erro</Badge>
    <Badge tone="neutral">Neutro</Badge>
    <Badge tone="brand">Marca</Badge>
  </Row>
);

export const Chips = () => (
  <Row>
    <Chip>default</Chip>
    <Chip variant="tag">#tag</Chip>
    <Chip variant="mini">atualizado ontem</Chip>
    <Chip variant="warn">aviso</Chip>
  </Row>
);

export const IconButtons = () => (
  <div style={{ background: 'var(--np-chrome)', padding: 14, borderRadius: 10, display: 'flex', gap: 8 }}>
    <IconButton label="Notificações">🔔</IconButton>
    <IconButton label="Definições">⚙️</IconButton>
    <IconButton label="Ajuda">?</IconButton>
  </div>
);

export const Inputs = () => (
  <div style={{ maxWidth: 320, display: 'grid', gap: 10 }}>
    <Input placeholder="Ex.: hotel@exemplo.pt" />
    <Input placeholder="Desativado" disabled />
  </div>
);
