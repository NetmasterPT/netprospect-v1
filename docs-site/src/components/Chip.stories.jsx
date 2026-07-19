import { Chip } from './Chip.jsx';

export default {
  title: 'Docs/Chip',
  component: Chip,
  tags: ['autodocs'],
  argTypes: {
    variant: { control: 'select', options: ['default', 'tag', 'warn', 'mini'] },
    children: { control: 'text' },
  },
};

export const Default = { args: { children: 'reference' } };
export const Tag = { args: { children: '#infra', variant: 'tag' } };
export const Warn = { args: { children: 'interno', variant: 'warn' } };
export const Mini = { args: { children: 'atualizado 2026-07-19', variant: 'mini' } };

export const MetaBar = {
  name: 'Barra de metadata (como no doc)',
  render: () => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      <Chip>how-to</Chip>
      <Chip>stable</Chip>
      <Chip variant="warn">interno</Chip>
      <Chip variant="mini">atualizado 2026-07-19</Chip>
      <Chip variant="tag">#infra</Chip>
      <Chip variant="tag">#runbook</Chip>
    </div>
  ),
};
