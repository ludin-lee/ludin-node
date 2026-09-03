import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLudin } from 'ludin';
import type { LudinRequest, LudinResponse } from 'ludin';
import { sqliteStore } from '../src/index.js';

const spec = {
  openapi: '3.0.3',
  info: { title: 'T', version: '1' },
  paths: { '/pets': { get: { responses: { 200: { description: 'ok' } } } } },
};

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

function send(method: string, path: string, body: unknown, cookie?: string) {
  return req({
    method,
    path,
    body: body == null ? null : JSON.stringify(body),
    headers: { host: 'localhost:3000', 'x-requested-with': 'ludin', ...(cookie ? { cookie } : {}) },
  });
}

const bodyOf = (res: LudinResponse) => JSON.parse(String(res.body));
const cookieOf = (res: LudinResponse) => String(res.headers['set-cookie']).split(';')[0];

async function withDb(): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'ludin-sqlite-'));
  return { file: join(dir, 'ludin.db'), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function app(file: string) {
  return createLudin({
    spec,
    store: sqliteStore(file),
    auth: {
      // Binding users act as a seed the first time the database is empty.
      users: [{ email: 'admin@x.io', password: 'admin-password', role: 'admin', name: 'Admin' }],
      session: { secret: 'test' },
    },
    audit: { sink: false },
  });
}

test('sqlite store: seeds from auth.users, then survives a restart', async (t) => {
  const { file, cleanup } = await withDb();
  t.after(cleanup);

  const first = app(file);
  const login = await first.handle(send('POST', '/api/login', { email: 'admin@x.io', password: 'admin-password' }));
  assert.equal(login.status, 200, String(login.body));
  const cookie = cookieOf(login);

  const created = await first.handle(
    send('POST', '/api/admin/users', { email: 'dev@x.io', password: 'dev-password', role: 'developer' }, cookie),
  );
  assert.equal(created.status, 201);
  await first.handle(send('POST', '/api/admin/ip', { cidr: '203.0.113.0/24', note: 'office' }, cookie));

  // A fresh handler over the same file – nothing is re-seeded, everything persists.
  const second = app(file);
  const devLogin = await second.handle(send('POST', '/api/login', { email: 'dev@x.io', password: 'dev-password' }));
  assert.equal(devLogin.status, 200, 'account created in the previous process still works');

  const adminCookie = cookieOf(await second.handle(send('POST', '/api/login', { email: 'admin@x.io', password: 'admin-password' })));
  const admin = bodyOf(await second.handle(req({ path: '/api/admin', headers: { host: 'x', cookie: adminCookie } })));
  assert.equal(admin.readonly, false);
  assert.deepEqual(
    admin.users.map((u: { email: string }) => u.email).sort(),
    ['admin@x.io', 'dev@x.io'],
  );
  assert.equal(admin.users.find((u: { email: string }) => u.email === 'admin@x.io').hashed, true, 'seeded password is hashed');
  assert.equal(admin.ipRules.length, 1);
  assert.equal(admin.ipRules[0].cidr, '203.0.113.0/24');
});

test('sqlite store: sessions are revocable across handlers', async (t) => {
  const { file, cleanup } = await withDb();
  t.after(cleanup);

  const a = app(file);
  const adminCookie = cookieOf(await a.handle(send('POST', '/api/login', { email: 'admin@x.io', password: 'admin-password' })));
  await a.handle(send('POST', '/api/admin/users', { email: 'dev@x.io', password: 'dev-password', role: 'developer' }, adminCookie));
  const devCookie = cookieOf(await a.handle(send('POST', '/api/login', { email: 'dev@x.io', password: 'dev-password' })));
  assert.equal((await a.handle(req({ path: '/api/specs', headers: { host: 'x', cookie: devCookie } }))).status, 200);

  const b = app(file);
  const admin = bodyOf(await b.handle(req({ path: '/api/admin', headers: { host: 'x', cookie: adminCookie } })));
  const dev = admin.users.find((u: { email: string }) => u.email === 'dev@x.io');
  assert.equal(dev.sessions, 1);
  assert.equal((await b.handle(send('POST', `/api/admin/users/${dev.id}/revoke-sessions`, null, adminCookie))).status, 200);

  // Revoked in one process, refused in the other.
  assert.equal((await a.handle(req({ path: '/api/specs', headers: { host: 'x', cookie: devCookie } }))).status, 401);
});

test('sqlite store: invites and audit queries round-trip through the database', async (t) => {
  const { file, cleanup } = await withDb();
  t.after(cleanup);

  const ludin = app(file);
  const cookie = cookieOf(await ludin.handle(send('POST', '/api/login', { email: 'admin@x.io', password: 'admin-password' })));

  const invited = await ludin.handle(send('POST', '/api/admin/invites', { email: 'new@x.io', role: 'viewer' }, cookie));
  assert.equal(invited.status, 201);
  const { token } = bodyOf(invited);

  const reopened = app(file);
  const info = bodyOf(await reopened.handle(req({ path: '/api/invites/info', query: { token } })));
  assert.equal(info.email, 'new@x.io');
  const accepted = await reopened.handle(send('POST', '/api/invites/accept', { token, password: 'invitee-password' }));
  assert.equal(accepted.status, 200);
  assert.equal(bodyOf(accepted).user.role, 'viewer');
  assert.equal(
    (await reopened.handle(send('POST', '/api/invites/accept', { token, password: 'invitee-password' }))).status,
    404,
    'the token is single-use',
  );

  const page = bodyOf(await reopened.handle(req({ path: '/api/audit', headers: { host: 'x', cookie } })));
  assert.ok(page.items.some((e: { type: string }) => e.type === 'invite.accept'));
  assert.ok(page.items.some((e: { type: string }) => e.type === 'login.success'));

  const paged = bodyOf(
    await reopened.handle(req({ path: '/api/audit', query: { limit: '2' }, headers: { host: 'x', cookie } })),
  );
  assert.equal(paged.items.length, 2);
  assert.ok(paged.nextCursor, 'pagination cursor is returned');
  const next = bodyOf(
    await reopened.handle(
      req({ path: '/api/audit', query: { limit: '2', cursor: paged.nextCursor }, headers: { host: 'x', cookie } }),
    ),
  );
  assert.ok(next.items.length > 0);
  assert.notDeepEqual(next.items[0], paged.items[0]);

  const byType = bodyOf(
    await reopened.handle(req({ path: '/api/audit', query: { type: 'invite.create' }, headers: { host: 'x', cookie } })),
  );
  assert.ok(byType.items.length === 1 && byType.items[0].detail.email === 'new@x.io');
});
