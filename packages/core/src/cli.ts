import { createInterface } from 'node:readline';
import { hashPassword } from './password.js';

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
  console.log(`ludin – commands:
  ludin hash [password]   Print a $scrypt$ hash to use in auth.users[].password / env`);
}

function prompt(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => (rl.close(), res(a))));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
