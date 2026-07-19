/** Storybook 8 (Vite). Build → dist/storybook, servido pelo docs-web em /docs/storybook/. */
export default {
  stories: ['../src/**/*.stories.@(js|jsx|mjs)'],
  addons: ['@storybook/addon-essentials'],
  framework: { name: '@storybook/react-vite', options: {} },
  core: { disableTelemetry: true },
  // servido sob /docs/storybook/ → os assets têm de referir esse prefixo
  viteFinal: async (config) => { config.base = '/docs/storybook/'; return config; },
};
