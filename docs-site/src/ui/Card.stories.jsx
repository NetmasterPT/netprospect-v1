import React from 'react';
import { Card, StatCard, StatGrid } from './Card.jsx';
import { Button, Badge } from './primitives.jsx';

export default { title: 'UI/Cartões', parameters: { layout: 'padded' } };

export const CartaoDeConteudo = () => (
  <div style={{ maxWidth: 560 }}>
    <Card title="Cobertura de dados" actions={<Button size="sm">Ver tudo</Button>}>
      <p className="np-text">Conteúdo do cartão. Cabeçalho com título e ações, corpo com padding.</p>
      <Badge tone="ok">38.412 qualificados</Badge>
    </Card>
  </div>
);

export const CartaoSimples = () => (
  <div style={{ maxWidth: 560 }}>
    <Card>Um cartão sem cabeçalho, só corpo.</Card>
  </div>
);

export const CartoesDeEstatistica = () => (
  <StatGrid>
    <StatCard label="Sites .pt" icon="◆" value="78.204" delta="+1,2%" deltaDir="up" />
    <StatCard label="Qualificados" icon="✓" value="38.412" delta="+3,4%" deltaDir="up" />
    <StatCard label="Verificados" icon="✉" value="12.901" delta="−0,4%" deltaDir="down" />
    <StatCard label="Contactos" icon="☎" value="162.330" />
  </StatGrid>
);
