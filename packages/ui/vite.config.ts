import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  plugins: [preact(), viteSingleFile()],
  build: {
    outDir: 'dist',
    target: 'es2020',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    reportCompressedSize: true,
  },
  server: {
    port: 5173,
    proxy: { '/docs/api': 'http://localhost:3000' },
  },
});
