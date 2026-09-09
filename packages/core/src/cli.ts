import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
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
  console.log(`ludin – commands:
  ludin hash [password]        Print a $scrypt$ hash to use in auth.users[].password / env
  ludin lint <spec> [options]  Check an OpenAPI document and print a health score
      --min <n>   Exit 1 when the score is below n
      --json      Machine-readable output`);
}

async function lint(args: string[]) {
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Usage: ludin lint <spec.json|spec.yaml> [--min <score>] [--json]');
    process.exit(1);
  }
  const min = Number(args[args.indexOf('--min') + 1] ?? NaN);
  const doc = parseSpecText(await readFile(file, 'utf8'), file);
  const result = lintSpec(doc);

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

function prompt(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => (rl.close(), res(a))));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
