import '../src/theme.css';
import '../src/ui.css';

// Viewports p/ validar responsividade (toolbar de viewport do addon-essentials).
const VIEWPORTS = {
  mobile: { name: 'Mobile · 390', styles: { width: '390px', height: '780px' } },
  phablet: { name: 'Phablet · 480', styles: { width: '480px', height: '860px' } },
  tablet: { name: 'Tablet · 768', styles: { width: '768px', height: '1024px' } },
  laptop: { name: 'Laptop · 1024', styles: { width: '1024px', height: '720px' } },
  desktop: { name: 'Desktop · 1280', styles: { width: '1280px', height: '860px' } },
};

// Toolbar de tema global (claro/escuro) → aplica-se a TODAS as stories.
export const globalTypes = {
  theme: {
    name: 'Tema',
    description: 'Claro / Escuro',
    defaultValue: 'dark',
    toolbar: {
      icon: 'circlehollow',
      items: [{ value: 'dark', title: '🌙 Escuro' }, { value: 'light', title: '☀️ Claro' }],
      dynamicTitle: true,
    },
  },
};

export default {
  parameters: {
    layout: 'centered',
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    viewport: { viewports: VIEWPORTS },
    backgrounds: { disable: true }, // o fundo segue o tema (decorator abaixo)
  },
  decorators: [(Story, ctx) => {
    const theme = ctx.globals.theme || 'dark';
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme);
      document.body.style.background = theme === 'light' ? '#EEF1F6' : '#0A0E16';
    }
    return Story();
  }],
};
