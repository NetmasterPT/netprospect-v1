import React, { useState } from 'react';
import { Drawer, NotificationsDrawer, ProfileMenu } from './overlays.jsx';
import { Button } from './primitives.jsx';
import { Icon } from './icons.jsx';

export default { title: 'UI/Sobreposições', parameters: { layout: 'fullscreen' } };

export const SideDrawer = () => {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ padding: 20 }}>
      <Button variant="primary" onClick={() => setOpen(true)}>Abrir drawer</Button>
      <Drawer open={open} onClose={() => setOpen(false)} title="Detalhe do site"
        actions={<Button size="sm">Editar</Button>}>
        <p className="np-text">Painel deslizante à direita, com scrim. Conteúdo arbitrário aqui.</p>
        <p className="np-text">Fecha no ✕, no scrim, ou por código.</p>
      </Drawer>
    </div>
  );
};

export const NotificationsDrawerStory = () => {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ padding: 20 }}>
      <Button onClick={() => setOpen(true)}><Icon name="bell" size={14} /> Notificações</Button>
      <NotificationsDrawer open={open} onClose={() => setOpen(false)} items={[
        { tone: 'ok', icon: 'check', title: 'Verify concluído', body: '1.204 contactos verificados', time: 'há 5 min' },
        { tone: 'warn', icon: 'activity', title: 'Backlog de subdomains', body: '~12k pendentes', time: 'há 1 h' },
        { tone: 'danger', icon: 'power', title: 'Worker de1 offline', body: 'Sem heartbeat há 10 min', time: 'há 12 min' },
        { tone: 'info', icon: 'sparkles', title: 'Novo band pronto', body: 'Score >60 limpo', time: 'ontem' },
      ]} />
    </div>
  );
};
NotificationsDrawerStory.storyName = 'Notifications Drawer';

export const TopbarProfileMenu = () => {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ background: 'var(--np-chrome)', padding: 14, display: 'flex', justifyContent: 'flex-end' }}>
      <ProfileMenu name="Gonçalo Pedro" role="Sales · Admin" email="gpedro.work@gmail.com" open={open} onToggle={() => setOpen((v) => !v)}
        items={[{ icon: <Icon name="gear" size={14} />, label: ' Definições' }, { icon: <Icon name="moon" size={14} />, label: ' Tema' }, { icon: <Icon name="ext" size={14} />, label: ' Sair' }]} />
    </div>
  );
};
TopbarProfileMenu.storyName = 'Topbar Profile Menu';
