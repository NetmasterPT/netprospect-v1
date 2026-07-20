import React from 'react';
import { PageHeader, SectionTitle, Eyebrow, Text, Muted } from './typography.jsx';
import { Button } from './primitives.jsx';

export default { title: 'UI/Tipografia', parameters: { layout: 'padded' } };

export const CabecalhoDePagina = () => (
  <PageHeader eyebrow="Conhecimento" title="Grafo do conhecimento"
    sub="78 docs · 214 ligações (wikilinks). Clica num nó para abrir."
    actions={<Button variant="primary" size="sm">Nova página</Button>} />
);

export const TituloDeSeccao = () => (
  <div>
    <SectionTitle>Arquitetura da plataforma</SectionTitle>
    <Text>Um bloco de texto de corpo (np-text) por baixo de um título de secção.</Text>
  </div>
);

export const BlocosDeTexto = () => (
  <div style={{ maxWidth: 640 }}>
    <Eyebrow>Referência</Eyebrow>
    <Text>Parágrafo de corpo com o token de tamanho base (14px) e altura de linha 1.5, na cor de texto secundária.</Text>
    <Text>Segundo parágrafo. <Muted>Este trecho usa o estilo "muted" para notas laterais.</Muted></Text>
  </div>
);

export const Escala = () => (
  <div style={{ display: 'grid', gap: 6 }}>
    <div style={{ fontSize: 'var(--np-fs-display)', fontWeight: 800 }}>Display 26 — Montserrat 800</div>
    <div style={{ fontSize: 'var(--np-fs-h1)', fontWeight: 800 }}>H1 20</div>
    <div style={{ fontSize: 'var(--np-fs-h2)', fontWeight: 800 }}>H2 16</div>
    <div style={{ fontSize: 'var(--np-fs-body)' }}>Body 14</div>
    <div style={{ fontSize: 'var(--np-fs-sm)', color: 'var(--np-text-3)' }}>Small 13</div>
    <div style={{ fontSize: 'var(--np-fs-xs)', color: 'var(--np-text-3)' }}>XS 12</div>
  </div>
);
