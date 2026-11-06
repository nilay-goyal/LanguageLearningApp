import preact from '@preact/preset-vite';
import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: '.',
  vite: () => ({
    plugins: [preact()],
    // Shown on the development label, to tell builds apart.
    define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(5, 16).replace('T', ' ')) },
  }),
  manifest: ({ mode }) => ({
    name: 'Subtitle Learning (dev)',
    description: 'Learn French or Spanish while you watch. Your subtitles change a little at a time.',
    permissions: ['storage'],
    action: { default_title: 'Subtitle Learning' },
    // Narrowed to the deployed Worker's own address before any public release.
    host_permissions: [
      'https://www.netflix.com/*',
      'https://*.workers.dev/*',
      ...(mode === 'development' ? ['http://localhost/*'] : []),
    ],
  }),
});
