import '../src/styles.css';

/** @type { import('@storybook/react').Preview } */
export default {
  parameters: {
    layout: 'centered',
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    backgrounds: {
      default: 'dark',
      values: [{ name: 'dark', value: '#0f1115' }, { name: 'light', value: '#ffffff' }],
    },
  },
};
