import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createLudin } from 'ludin';
import type { LudinRequest, LudinResponse } from 'ludin';
import { mysqlStore } from '../src/index.js';

/**
 * Runs against `LUDIN_MYSQL_URL` when set. With `LUDIN_MYSQL_DOCKER=1` it boots
 * a throwaway MySQL container instead. Without either, the suite skips – tests
 * should not silently require a database daemon.
 */
const URL_FROM_ENV = process.env.LUDIN_MYSQL_URL;
const USE_DOCKER = !URL_FROM_ENV && process.env.LUDIN_MYSQL_DOCKER === '1' && hasDocker();
const ENABLED = !!URL_FROM_ENV || USE_DOCKER;
const IMAGE = process.env.LUDIN_MYSQL_IMAGE ?? 'mysql:8.4';

let url = URL_FROM_ENV ?? '';
let container = '';

function hasDocker(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

before(async () => {
  if (!USE_DOCKER) return;
  container = docker(
    'run', '-d', '--rm',
    '-e', 'MYSQL_ROOT_PASSWORD=ludin',
    '-e', 'MYSQL_DATABASE=ludin',
    '-p', '127.0.0.1::3306',
    IMAGE,
  );
  const port = docker('port', container, '3306').split(':').pop();
  url = `mysql://root:ludin@127.0.0.1:${port}/ludin`;

  // Wait for the server to accept connections (first boot initialises the data dir).
  const mysql = await import('mysql2/promise');
  for (let i = 0; i < 120; i++) {
    try {
      const conn = await mysql.createConnection(url);
      await conn.query('SELECT 1');
      await conn.end();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('MySQL container did not become ready');
});

after(() => {
  if (container) docker('rm', '-f', container);
});

function req(partial: Partial<LudinRequest>): LudinRequest {
  return {
    method: 'GET',
    path: '/',
    query: {},
    headers: { host: 'localhost:3000' },
    remoteAddress: '203.0.113.10',
    body: null,
    ...partial,
  };
}

function post(method: string, path: string, body: unknown, cookie?: string) {
  return req({
    method,
    path,
    body: body == null ? null : JSON.stringify(body),
    headers: { host: 'localhost:3000', 'x-requested-with': 'ludin', ...(cookie ? { cookie } : {}) },
  });
}

const bodyOf = (res: LudinResponse) => JSON.parse(String(res.body));
const cookieOf = (res: LudinResponse) => String(res.headers['set-cookie']).split(';')[0];

const spec = {
  openapi: '3.0.3',
  info: { title: 'T', version: '1' },
  paths: { '/pets': { get: { responses: { 200: { description: 'ok' } } } } },
};

/** Each test gets its own table prefix, so they share the container safely. */
function app(prefix: string) {
  return createLudin({
    spec,
    store: mysqlStore(url, { tablePrefix: prefix }),
    auth: {
      users: [{ email: 'admin@x.io', password: 'admin-password', role: 'admin', name: 'Admin' }],
      session: { secret: 'test' },
    },
    audit: { sink: false },
  });
}

const login = async (ludin: ReturnType<typeof createLudin>, email: string, password: string) => {
  const res = await ludin.handle(post('POST', '/api/login', { email, password }));
  assert.equal(res.status, 200, `login failed: ${res.body}`);
  return cookieOf(res);
};

test('mysql store: seeds, persists across handlers and matches emails case-insensitively', { skip: !ENABLED }, async () => {
  const first = app('t1_');
  const cookie = await login(first, 'admin@x.io', 'admin-password');
  const created = await first.handle(
    post('POST', '/api/admin/users', { email: 'Dev@X.io', password: 'dev-password', role: 'developer' }, cookie),
  );
  assert.equal(created.status, 201);

  const second = app('t1_');
  // Same database, different handler instance: no re-seeding, and email casing does not matter.
  assert.ok(await login(second, 'dev@x.io', 'dev-password'));
  const admin = bodyOf(await second.handle(req({ path: '/api/admin', headers: { host: 'x', cookie } })));
  assert.deepEqual(admin.users.map((u: { email: string }) => u.email).sort(), ['Dev@X.io', 'admin@x.io']);
  assert.equal(admin.users.find((u: { email: string }) => u.email === 'admin@x.io').hashed, true);

  const dupe = await second.handle(
    post('POST', '/api/admin/users', { email: 'DEV@x.io', password: 'other-password' }, cookie),
  );
  assert.equal(dupe.status, 409, 'a differently-cased duplicate is refused');
});

test('mysql store: sessions revoked in one instance are dead in the other', { skip: !ENABLED }, async () => {
  const a = app('t2_');
  const adminCookie = await login(a, 'admin@x.io', 'admin-password');
  await a.handle(post('POST', '/api/admin/users', { email: 'dev@x.io', password: 'dev-password', role: 'developer' }, adminCookie));
  const devCookie = await login(a, 'dev@x.io', 'dev-password');
  assert.equal((await a.handle(req({ path: '/api/specs', headers: { host: 'x', cookie: devCookie } }))).status, 200);

  const b = app('t2_');
  const admin = bodyOf(await b.handle(req({ path: '/api/admin', headers: { host: 'x', cookie: adminCookie } })));
  const dev = admin.users.find((u: { email: string }) => u.email === 'dev@x.io');
  assert.equal(dev.sessions, 1);
  assert.equal((await b.handle(post('POST', `/api/admin/users/${dev.id}/revoke-sessions`, null, adminCookie))).status, 200);
  assert.equal((await a.handle(req({ path: '/api/specs', headers: { host: 'x', cookie: devCookie } }))).status, 401);
});

test('mysql store: invites, IP rules and audit paging round-trip', { skip: !ENABLED }, async () => {
  const ludin = app('t3_');
  const cookie = await login(ludin, 'admin@x.io', 'admin-password');

  const invited = await ludin.handle(post('POST', '/api/admin/invites', { email: 'new@x.io', role: 'viewer' }, cookie));
  assert.equal(invited.status, 201);
  const { token } = bodyOf(invited);
  const other = app('t3_');
  assert.equal(bodyOf(await other.handle(req({ path: '/api/invites/info', query: { token } }))).email, 'new@x.io');
  const accepted = await other.handle(post('POST', '/api/invites/accept', { token, password: 'invitee-password' }));
  assert.equal(accepted.status, 200);
  assert.equal((await other.handle(post('POST', '/api/invites/accept', { token, password: 'invitee-password' }))).status, 404);

  const rule = await ludin.handle(post('POST', '/api/admin/ip', { cidr: '203.0.113.0/24', note: 'office' }, cookie));
  assert.equal(rule.status, 201);
  const admin = bodyOf(await ludin.handle(req({ path: '/api/admin', headers: { host: 'x', cookie } })));
  assert.equal(admin.ipRules.length, 1);
  assert.equal(admin.ipRules[0].note, 'office');

  const page = bodyOf(await ludin.handle(req({ path: '/api/audit', query: { limit: '2' }, headers: { host: 'x', cookie } })));
  assert.equal(page.items.length, 2);
  assert.ok(page.nextCursor);
  const next = bodyOf(
    await ludin.handle(req({ path: '/api/audit', query: { limit: '2', cursor: page.nextCursor }, headers: { host: 'x', cookie } })),
  );
  assert.ok(next.items.length > 0);
  assert.notDeepEqual(next.items[0], page.items[0]);
  assert.ok(next.items.every((e: { ts: string }) => e.ts <= page.items[page.items.length - 1].ts));

  const filtered = bodyOf(
    await ludin.handle(req({ path: '/api/audit', query: { type: 'invite.accept' }, headers: { host: 'x', cookie } })),
  );
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0].type, 'invite.accept');
});
