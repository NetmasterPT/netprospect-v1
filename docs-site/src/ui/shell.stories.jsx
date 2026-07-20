import React, { useState } from 'react';
import { Topbar, Brandmark, SearchBox, ThemeToggleButton } from './shell.jsx';
import { IconButton } from './primitives.jsx';
import { ProfileMenu } from './overlays.jsx';
import { Icon } from './icons.jsx';

export default { title: 'UI/Topbar', parameters: { layout: 'fullscreen' } };

export const Completa = () => {
  const [q, setQ] = useState('');
  const [prof, setProf] = useState(false);
  return (
    <Topbar
      brand={<Brandmark label="NetProspect" pill="Docs" />}
      search={<SearchBox placeholder="Procurar na documentação…" value={q} onChange={setQ} />}
      actions={<>
        <IconButton label="Atualizar"><Icon name="refresh" /></IconButton>
        <IconButton label="Notificações"><Icon name="bell" /></IconButton>
        <ThemeToggleButton theme="dark" onToggle={() => {}} />
        <ProfileMenu name="Gonçalo Pedro" role="Sales · Admin" email="gpedro.work@gmail.com" open={prof} onToggle={() => setProf((v) => !v)}
          items={[{ icon: <Icon name="gear" size={14} />, label: ' Definições' }, { icon: <Icon name="ext" size={14} />, label: ' Sair' }]} />
      </>}
    />
  );
};

export const SoMarca = () => <Topbar brand={<Brandmark label="NetProspect" pill="Docs" />} />;

export const IconesDaTopbar = () => (
  <Topbar actions={<>
    <IconButton label="Atualizar"><Icon name="refresh" /></IconButton>
    <IconButton label="Notificações"><Icon name="bell" /></IconButton>
    <IconButton label="Importar"><Icon name="upload" /></IconButton>
    <IconButton label="Definições"><Icon name="gear" /></IconButton>
  </>} />
);
IconesDaTopbar.storyName = 'Topbar Icon Buttons';
