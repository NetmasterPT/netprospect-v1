import { Callout } from './Callout.jsx';

export default {
  title: 'Docs/Callout',
  component: Callout,
  tags: ['autodocs'],
  argTypes: {
    type: { control: 'select', options: ['note', 'tip', 'warning', 'danger', 'info'] },
    title: { control: 'text' },
    children: { control: 'text' },
  },
};

export const Note = { args: { type: 'note', title: 'Nota', children: 'Um aparte informativo.' } };
export const Tip = { args: { type: 'tip', title: 'Dica', children: 'Uma boa prática.' } };
export const Warning = { args: { type: 'warning', title: 'Cuidado', children: 'Isto tem consequências (ex.: config fora do git).' } };
export const Danger = { args: { type: 'danger', title: 'Perigo', children: 'Irreversível / alto blast-radius.' } };
export const Info = { args: { type: 'info', title: 'Info', children: 'Contexto adicional.' } };

export const Todos = {
  name: 'Todos os tipos',
  render: () => (
    <div style={{ display: 'grid', gap: 12, width: 540 }}>
      {['note', 'tip', 'warning', 'danger', 'info'].map((t) => (
        <Callout key={t} type={t} title={t}>Exemplo de callout <b>{t}</b>.</Callout>
      ))}
    </div>
  ),
};
