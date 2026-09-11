// Builds the static demo: the real UI bundle with an in-page server (scripts/demo/shim.ts)
// so the docs work without Node – on GitHub Pages, as an artifact, from a file.
//
//   cd packages/core && node --import tsx ../../scripts/build-demo.mts [out.html]
//
// Run from packages/core so `tsx` and `esbuild` resolve; the UI must have been built
// into core first (pnpm build), since the page starts from src/ui-bundle.ts.
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UI_HTML } from '../packages/core/src/ui-bundle.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? resolve(root, 'site/demo/index.html'));

const shim = await build({
  entryPoints: [resolve(root, 'scripts/demo/shim.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  plugins: [
    {
      // spec.ts imports fs/path for file-backed specs; the demo never loads one.
      name: 'stub-node',
      setup(b) {
        b.onResolve({ filter: /^node:(fs\/promises|path)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const readFile = () => { throw new Error("not available in the demo"); }; export const resolve = (p) => p;',
          loader: 'js',
        }));
      },
    },
  ],
});

const boot = {
  basePath: '/docs',
  authEnabled: true,
  theme: {
    title: 'Petstore API',
    logo:
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0f766e"/>' +
          '<path d="M9 21c0-4 3-7 7-7s7 3 7 7" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round"/>' +
          '<circle cx="12" cy="11" r="2.2" fill="#fff"/><circle cx="20" cy="11" r="2.2" fill="#fff"/></svg>',
      ),
    primary: '#0f766e',
    accent: '#f59e0b',
    loginHeadline: 'Petstore developer docs (demo)',
    loginDescription: 'Try admin@example.com / admin, dev@example.com / dev, or viewer@example.com / viewer. Everything runs in this page — nothing is sent anywhere.',
  },
  readme: null,
  version: 'demo',
};

const page = UI_HTML
  .replace('<title>API Docs</title>', '<title>ludin demo · Petstore API</title>')
  .replace(
    '<!--LUDIN_CONFIG-->',
    `<script>window.__LUDIN__=${JSON.stringify(boot).replace(/</g, '\\u003c')}</script>\n<script>${shim.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script>`,
  );

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page);
console.log(`${out}: ${(page.length / 1024).toFixed(0)} KB (shim ${(shim.outputFiles[0].text.length / 1024).toFixed(0)} KB)`);
