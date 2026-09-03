import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mysqlStore } from '../src/index.js';
import type { MysqlConnectionLike } from '../src/index.js';

/**
 * Driver-level checks that need no server: which statements are prepared, what
 * MySQL syntax is emitted, and how rows map back. The behavioural suite against
 * a real server lives in mysql.test.ts.
 */
interface Call {
  via: 'query' | 'execute';
  sql: string;
  params: unknown[];
}

function fakePool(rowsFor: (sql: string) => unknown[] = () => []) {
  const calls: Call[] = [];
  let ended = false;
  const pool: MysqlConnectionLike = {
    async query(sql, params = []) {
      calls.push({ via: 'query', sql, params });
      return [rowsFor(sql), []];
    },
    async execute(sql, params = []) {
      calls.push({ via: 'execute', sql, params });
      return [rowsFor(sql), []];
    },
    async end() {
      ended = true;
    },
  };
  return { pool, calls, ended: () => ended };
}

const find = (calls: Call[], needle: string) => calls.find((c) => c.sql.includes(needle));

test('mysql adapter: creates its schema through query(), not prepared statements', async () => {
  const { pool, calls } = fakePool();
  const store = mysqlStore(pool);
  await store.users.list();

  const ddl = calls.filter((c) => /CREATE TABLE/i.test(c.sql));
  assert.equal(ddl.length, 6, 'users, ip rules, invites, sessions, notices, audit');
  assert.ok(ddl.every((c) => c.via === 'query'), 'DDL is not preparable everywhere');
  assert.ok(ddl.every((c) => /ENGINE=InnoDB CHARACTER SET utf8mb4/.test(c.sql)));
  assert.ok(find(calls, 'AUTO_INCREMENT'), 'audit uses an auto-increment sequence');
  // No CREATE INDEX statements: MySQL has no `CREATE INDEX IF NOT EXISTS`, so
  // indexes are declared inline and re-running the DDL stays safe.
  assert.equal(calls.filter((c) => /^\s*CREATE INDEX/i.test(c.sql)).length, 0);
});

test('mysql adapter: statements with user data are prepared, with MySQL syntax', async () => {
  const { pool, calls } = fakePool();
  const store = mysqlStore(pool, { tablePrefix: 'docs_' });

  await store.users.findByEmail('A@X.io');
  const lookup = find(calls, 'FROM docs_users WHERE email')!;
  assert.equal(lookup.via, 'execute');
  assert.deepEqual(lookup.params, ['A@X.io']);
  assert.ok(!/COLLATE NOCASE/.test(lookup.sql), 'MySQL collations are already case-insensitive');

  await store.ipRules!.upsert!({ id: 'r1', cidr: '10.0.0.0/8', note: 'vpn' });
  const upsert = find(calls, 'INSERT INTO docs_ip_rules')!;
  assert.match(upsert.sql, /ON DUPLICATE KEY UPDATE/);
  assert.ok(!/ON CONFLICT/.test(upsert.sql), 'that is sqlite syntax');
  assert.deepEqual(upsert.params, ['r1', '10.0.0.0/8', 'vpn']);

  await store.audit!.query!({ user: 'dev@x.io', q: 'pets', cursor: '42', limit: 10 });
  const page = find(calls, 'FROM docs_audit')!;
  assert.match(page.sql, /ORDER BY seq DESC LIMIT 11/, 'LIMIT is inlined; +1 probes for a next page');
  assert.match(page.sql, /seq < \?/);
  assert.deepEqual(page.params, ['dev@x.io', '%pets%', '%pets%', '%pets%', '%pets%', 42]);
});

test('mysql adapter: rows map back to store types, and a borrowed pool is not closed', async () => {
  const { pool, calls, ended } = fakePool((sql) =>
    sql.includes('FROM u_users')
      ? [
          {
            id: 'u1',
            email: 'dev@x.io',
            name: 'Dev',
            role: 'developer',
            password_hash: '$scrypt$x',
            status: 'active',
            ip_allowlist: '["10.0.0.0/8"]',
            created_at: '2026-01-01T00:00:00.000Z',
            last_login_at: null,
          },
        ]
      : [],
  );
  const store = mysqlStore(pool, { tablePrefix: 'u_' });

  const user = await store.users.findById!('u1');
  assert.deepEqual(user, {
    id: 'u1',
    email: 'dev@x.io',
    name: 'Dev',
    role: 'developer',
    passwordHash: '$scrypt$x',
    status: 'active',
    ipAllowlist: ['10.0.0.0/8'],
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: undefined,
  });

  await store.close!();
  assert.equal(ended(), false, 'a pool handed to us belongs to the caller');
  assert.ok(calls.length > 0);
});
