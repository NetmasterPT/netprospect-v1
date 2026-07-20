import React, { useState } from 'react';
import { Topbar, Brandmark, SearchBox, ThemeToggleButton } from './shell.jsx';
import { IconButton } from './primitives.jsx';
import { ProfileMenu } from './overlays.jsx';

export default { title: 'UI/Topbar', parameters: { layout: 'fullscreen' } };

export const Completa = () => {
  const [q, setQ] = useState('');
  const [prof, setProf] = useState(false);
  return (
    <Topbar
      brand={<Brandmark label="NetProspect" pill="Docs" />}
      search={<SearchBox placeholder="Procurar na documentação…" value={q} onChange={setQ} />}
      actions={<>
        <IconButton label="Notificações">🔔</IconButton>
        <ThemeToggleButton theme="dark" onToggle={() => {}} />
        <ProfileMenu name="Gonçalo Pedro" email="gpedro.work@gmail.com" open={prof} onToggle={() => setProf((v) => !v)}
          items={[{ icon: '⚙️ ', label: 'Definições' }, { icon: '↩ ', label: 'Sair' }]} />
      </>}
    />
  );
};

export const SoMarca = () => <Topbar brand={<Brandmark label="NetProspect" pill="Docs" />} />;

export const IconesDaTopbar = () => (
  <Topbar actions={<>
    <IconButton label="Notificações">🔔</IconButton>
    <IconButton label="Ajuda">?</IconButton>
    <IconButton label="Definições">⚙️</IconButton>
  </>} />
);
IconesDaTopbar.storyName = 'Topbar Icon Buttons';
