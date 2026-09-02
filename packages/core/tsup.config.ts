import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'node18',
    external: ['bcryptjs', 'argon2'],
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    target: 'node18',
    banner: { js: '#!/usr/bin/env node' },
  },
]);
