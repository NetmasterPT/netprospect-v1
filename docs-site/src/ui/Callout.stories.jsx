import React from 'react';
import { Callout } from './Callout.jsx';

export default { title: 'UI/Callout', component: Callout, parameters: { layout: 'padded' } };

export const Todos = () => (
  <div style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
    <Callout type="note" title="Nota">Callout informativo sobre os tokens do design-system.</Callout>
    <Callout type="tip" title="Dica">Usa `bash deploy/docs/build.sh` no np-server (sem node no host).</Callout>
    <Callout type="warning" title="Atenção">O proxy_pass do /docs/ vai sem barra final.</Callout>
    <Callout type="danger" title="Perigo">Nunca misturar envio-frio com o IP do WHM.</Callout>
    <Callout type="info" title="Info">Acesso no telefone via Tailscale Serve entretanto.</Callout>
  </div>
);

export const SemTitulo = () => <Callout type="tip">Callout sem título — usa o tipo como rótulo.</Callout>;
