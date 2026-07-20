import React, { useState } from 'react';
import { MenuItem, CollapsibleMenu } from './nav.jsx';

export default { title: 'UI/Navegação', parameters: { layout: 'fullscreen' } };

// A nav vive no "chrome" escuro — envolver num contentor com o fundo certo.
const Chrome = ({ children }) => (
  <div style={{ background: 'var(--np-chrome)', width: 300, padding: '16px 12px', minHeight: 360 }}>{children}</div>
);

export const ItemDeMenu = () => {
  const [active, setActive] = useState('docs');
  return (
    <Chrome>
      <MenuItem icon="📄" label="Documentação" active={active === 'docs'} onClick={() => setActive('docs')} />
      <MenuItem icon="🕸️" label="Grafo" count="↗" active={active === 'graph'} onClick={() => setActive('graph')} />
      <MenuItem icon="🎨" label="Storybook" active={active === 'sb'} onClick={() => setActive('sb')} />
    </Chrome>
  );
};

export const ItemComPonto = () => (
  <Chrome>
    <MenuItem dot="#a78bfa" label="Explanation" count="12" />
    <MenuItem dot="#34d399" label="How-to" count="8" />
    <MenuItem dot="#60a5fa" label="Reference" count="21" />
    <MenuItem dot="#f87171" label="Incidents" count="3" />
  </Chrome>
);

export const MenuColapsavel = () => (
  <Chrome>
    <CollapsibleMenu title="Explanation" defaultOpen>
      <MenuItem dot="#a78bfa" label="Arquitetura" />
      <MenuItem dot="#a78bfa" label="Pipeline de dados" />
    </CollapsibleMenu>
    <CollapsibleMenu title="How-to" defaultOpen={false}>
      <MenuItem dot="#34d399" label="Adicionar um worker" />
      <MenuItem dot="#34d399" label="Configurar o NPMplus" />
    </CollapsibleMenu>
  </Chrome>
);
