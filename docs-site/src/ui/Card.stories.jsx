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
    <StatCard label="Sites" icon="directory" value="78.204" href="#" />
    <StatCard label="Live" icon="power" value="72.140" href="#" />
    <StatCard label="Qualificados" icon="check" value="38.412" href="#" />
    <StatCard label="Empresas" icon="server" value="41.905" />
    <StatCard label="Contactos" icon="contacts" value="162.330" />
    <StatCard label="E-mails verif." icon="mail" value="12.901" />
  </StatGrid>
);
