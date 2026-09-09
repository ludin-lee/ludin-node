// Usage: node scripts/bump.mjs 0.3.2
// Sets every package.json (root + packages/*) and the UI version string in
// core/src/handler.ts to the given version. The release workflow refuses to
// publish unless the git tag matches packages/core/package.json exactly.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? '')) {
  console.error('Usage: node scripts/bump.mjs <version>   e.g. 0.3.2');
  process.exit(1);
}

const manifests = ['package.json', ...readdirSync('packages').map((d) => `packages/${d}/package.json`)];
for (const f of manifests) {
  const j = JSON.parse(readFileSync(f, 'utf8'));
  j.version = version;
  writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  console.log(`${f} → ${version}`);
}

const h = 'packages/core/src/handler.ts';
writeFileSync(h, readFileSync(h, 'utf8').replace(/version: '[^']+'/, `version: '${version}'`));
console.log(`${h} → ${version}`);
console.log(`\nNext:\n  pnpm build && pnpm test\n  git commit -am "chore(release): ${version}"\n  git push && git tag v${version} && git push origin v${version}`);
