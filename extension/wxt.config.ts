import preact from '@preact/preset-vite';
import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: '.',
  vite: () => ({ plugins: [preact()] }),
  manifest: {
    name: 'Subtitle Learning (dev)',
    description: 'Learn French or Spanish while you watch. Your subtitles change a little at a time.',
    permissions: ['storage'],
    action: { default_title: 'Subtitle Learning: click to switch on or off' },
    host_permissions: ['https://www.netflix.com/*'],
  },
});
