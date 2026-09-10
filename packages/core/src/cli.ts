import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { diffSpecs, toMarkdown } from './diff.js';
import { buildPostmanCollection, generateTypes } from './export.js';
import { lintSpec } from './lint.js';
import { hashPassword } from './password.js';
import { parseSpecText } from './spec.js';

const [cmd, ...rest] = process.argv.slice(2);

async function main() {
  if (cmd === 'hash') {
    let plain = rest[0];
    if (!plain) {
      plain = await prompt('Password: ');
    }
    if (!plain) {
      console.error('Usage: ludin hash [password]');
      process.exit(1);
    }
    console.log(await hashPassword(plain));
    return;
  }
  if (cmd === 'lint') {
    return lint(rest);
  }
  if (cmd === 'diff') {
    return diff(rest);
  }
  if (cmd === 'export') {
    return exportSpec(rest);
  }
  console.log(`ludin – commands:
  ludin hash [password]        Print a $scrypt$ hash to use in auth.users[].password / env
  ludin lint <spec> [options]  Check an OpenAPI document and print a health score
      --min <n>          Exit 1 when the score is below n
      --ignore <rules>   Comma-separated rule names to skip (e.g. param-description,op-tags)
      --json             Machine-readable output
  ludin diff <before> <after> [options]  Compare two documents and classify breaking changes
      --fail-on-breaking  Exit 1 when a breaking change is found
      --markdown          Release notes as Markdown
      --json              Machine-readable output
  ludin export <spec> --format postman|types [options]  Generate a client artifact
      --out <file>        Write to a file instead of stdout

  export works from the whole document: the CLI has no identity, so unlike
  GET /docs/api/export/* nothing is filtered by role.`);
}

async function lint(args: string[]) {
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Usage: ludin lint <spec.json|spec.yaml> [--min <score>] [--ignore <rules>] [--json]');
    process.exit(1);
  }
  const min = Number(args[args.indexOf('--min') + 1] ?? NaN);
  const ignore = args.includes('--ignore') ? (args[args.indexOf('--ignore') + 1] ?? '').split(',').filter(Boolean) : undefined;
  const doc = parseSpecText(await readFile(file, 'utf8'), file);
  const result = lintSpec(doc, { ignore });

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const mark = { error: '✖', warn: '▲', info: '·' } as const;
    for (const i of result.issues) console.log(`${mark[i.severity]} [${i.rule}] ${i.path} — ${i.message}`);
    if (result.issues.length) console.log('');
    console.log(
      `Health score: ${result.score}/100  (${result.passed}/${result.checks} checks · ` +
      `${result.counts.error} errors · ${result.counts.warn} warnings · ${result.counts.info} hints)`,
    );
  }
  if (!Number.isNaN(min) && result.score < min) process.exit(1);
}

async function diff(args: string[]) {
  const [beforeFile, afterFile] = args.filter((a) => !a.startsWith('--'));
  if (!beforeFile || !afterFile) {
    console.error('Usage: ludin diff <before.yaml> <after.yaml> [--fail-on-breaking] [--json]');
    process.exit(1);
  }
  const before = parseSpecText(await readFile(beforeFile, 'utf8'), beforeFile);
  const after = parseSpecText(await readFile(afterFile, 'utf8'), afterFile);
  const result = diffSpecs(before, after);

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else if (args.includes('--markdown')) {
    process.stdout.write(toMarkdown(result));
  } else if (result.changes.length === 0) {
    console.log('No changes.');
  } else {
    for (const c of result.changes.filter((x) => x.breaking)) console.log(`✖ [${c.kind}] ${c.at} — ${c.detail}`);
    for (const c of result.changes.filter((x) => !x.breaking)) console.log(`· [${c.kind}] ${c.at} — ${c.detail}`);
    console.log(`\n${result.breaking} breaking · ${result.nonBreaking} compatible` +
      (result.versions.before || result.versions.after ? `  (${result.versions.before ?? '?'} → ${result.versions.after ?? '?'})` : ''));
  }
  if (args.includes('--fail-on-breaking') && result.breaking > 0) process.exit(1);
}

/**
 * The same generators the server route uses (spec §3.13). The CLI has no
 * caller, so there is no role to filter by: it works from the whole document
 * and is meant for code-generation pipelines and CI artifacts.
 */
async function exportSpec(args: string[]) {
  const flagValue = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const format = flagValue('--format');
  const out = flagValue('--out');
  const file = args.filter((a) => !a.startsWith('--') && a !== format && a !== out)[0];
  if (!file || (format !== 'postman' && format !== 'types')) {
    console.error('Usage: ludin export <spec.json|spec.yaml> --format postman|types [--out <file>]');
    process.exit(1);
  }
  const doc = parseSpecText(await readFile(file, 'utf8'), file);
  const text = format === 'postman'
    ? JSON.stringify(buildPostmanCollection(doc), null, 2) + '\n'
    : generateTypes(doc);
  if (out) {
    await writeFile(out, text);
    console.error(`Wrote ${out}`);
  } else {
    process.stdout.write(text);
  }
}

function prompt(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => (rl.close(), res(a))));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
