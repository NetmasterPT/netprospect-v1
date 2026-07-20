import '../src/theme.css';
import '../src/ui.css';

/** @type { import('@storybook/react').Preview } */
export default {
  parameters: {
    layout: 'centered',
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    backgrounds: {
      default: 'dark',
      values: [{ name: 'dark', value: '#0A0E16' }, { name: 'light', value: '#EEF1F6' }],
    },
  },
  decorators: [(Story, ctx) => {
    if (typeof document !== 'undefined') document.documentElement.setAttribute('data-theme', ctx.globals.backgrounds?.value === '#EEF1F6' ? 'light' : 'dark');
    return Story();
  }],
};
