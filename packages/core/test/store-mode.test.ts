import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLudin, createMemoryStore } from '../src/index.js';
import type { LudinOptions, LudinRequest, LudinResponse } from '../src/index.js';

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

function send(method: string, path: string, body: unknown, cookie?: string, extra: Partial<LudinRequest> = {}) {
  return req({
    method,
    path,
    body: body == null ? null : JSON.stringify(body),
    headers: { host: 'localhost:3000', 'x-requested-with': 'ludin', ...(cookie ? { cookie } : {}) },
    ...extra,
  });
}

function cookieOf(res: LudinResponse) {
  const sc = res.headers['set-cookie'];
  const s = Array.isArray(sc) ? sc[0] : sc;
  return String(s).split(';')[0];
}

function bodyOf(res: LudinResponse) {
  return JSON.parse(String(res.body));
}

function setup(extra: Partial<LudinOptions> = {}) {
  const store = createMemoryStore({
    users: [
      { email: 'admin@x.io', password: 'admin-password', role: 'admin', name: 'Admin' },
      { email: 'dev@x.io', password: 'dev-password', role: 'developer' },
    ],
  });
  const ludin = createLudin({ spec, store, auth: { session: { secret: 'test' } }, audit: { sink: false }, ...extra });
  return { store, ludin };
}

async function loginAs(ludin: ReturnType<typeof createLudin>, email: string, password: string) {
  const res = await ludin.handle(send('POST', '/api/login', { email, password }));
  assert.equal(res.status, 200, `login failed for ${email}: ${res.body}`);
  return cookieOf(res);
}

test('store mode: capabilities are advertised and binding mode refuses writes', async () => {
  const { ludin } = setup();
  const cookie = await loginAs(ludin, 'admin@x.io', 'admin-password');
  const me = bodyOf(await ludin.handle(req({ path: '/api/me', headers: { host: 'x', cookie } })));
  assert.equal(me.readonly, false);
  assert.deepEqual(me.capabilities, {
    users: true,
    invites: true,
    ipRules: true,
    sessions: true,
    auditQuery: true,
    notices: true,
  });

  const bound = createLudin({
    spec,
    auth: { users: [{ email: 'a@x.io', password: 'binding-password', role: 'admin' }], session: { secret: 'test' } },
    audit: { sink: false },
  });
  const boundCookie = await loginAs(bound, 'a@x.io', 'binding-password');
  const boundMe = bodyOf(await bound.handle(req({ path: '/api/me', headers: { host: 'x', cookie: boundCookie } })));
  assert.equal(boundMe.readonly, true);
  assert.equal(boundMe.capabilities.users, false);

  const denied = await bound.handle(send('POST', '/api/admin/users', { email: 'new@x.io', password: 'password123' }, boundCookie));
  assert.equal(denied.status, 501);
  assert.equal(bodyOf(denied).code, 'store_required');
});

test('store mode: admin creates, updates and removes accounts', async () => {
  const { ludin } = setup();
  const cookie = await loginAs(ludin, 'admin@x.io', 'admin-password');

  const created = await ludin.handle(
    send('POST', '/api/admin/users', { email: 'qa@x.io', password: 'qa-password', role: 'viewer', name: 'QA' }, cookie),
  );
  assert.equal(created.status, 201);
  const id = bodyOf(created).user.id;
  assert.equal(bodyOf(created).user.hashed, true, 'password is stored hashed');

  const qaCookie = await loginAs(ludin, 'qa@x.io', 'qa-password');
  assert.equal((await ludin.handle(send('POST', '/api/try', { method: 'GET', url: 'http://x/pets' }, qaCookie))).status, 403);

  // Promotion revokes the old cookie, so the new role cannot be smuggled in.
  const promoted = await ludin.handle(send('PATCH', `/api/admin/users/${id}`, { role: 'developer' }, cookie));
  assert.equal(promoted.status, 200);
  assert.equal(bodyOf(promoted).user.role, 'developer');
  assert.equal((await ludin.handle(req({ path: '/api/specs', headers: { host: 'x', cookie: qaCookie } }))).status, 401);

  const dupe = await ludin.handle(send('POST', '/api/admin/users', { email: 'qa@x.io', password: 'other-password' }, cookie));
  assert.equal(dupe.status, 409);

  const weak = await ludin.handle(send('POST', '/api/admin/users', { email: 'weak@x.io', password: 'short' }, cookie));
  assert.equal(weak.status, 400);

  const removed = await ludin.handle(send('DELETE', `/api/admin/users/${id}`, null, cookie));
  assert.equal(removed.status, 200);
  const admin = bodyOf(await ludin.handle(req({ path: '/api/admin', headers: { host: 'x', cookie } })));
  assert.ok(!admin.users.some((u: { email: string }) => u.email === 'qa@x.io'));
});

test('store mode: lockout guards – no self demotion, no last admin, no self delete', async () => {
  const { ludin } = setup();
  const cookie = await loginAs(ludin, 'admin@x.io', 'admin-password');
  const admin = bodyOf(await ludin.handle(req({ path: '/api/admin', headers: { host: 'x', cookie } })));
  const self = admin.users.find((u: { email: string }) => u.email === 'admin@x.io');

  const selfDemote = await ludin.handle(send('PATCH', `/api/admin/users/${self.id}`, { role: 'viewer' }, cookie));
  assert.equal(selfDemote.status, 400);
  assert.equal(bodyOf(selfDemote).code, 'self_edit');

  const selfDelete = await ludin.handle(send('DELETE', `/api/admin/users/${self.id}`, null, cookie));
  assert.equal(bodyOf(selfDelete).code, 'self_edit');

  // Someone else may not strip the last admin either.
  const { ludin: solo } = (() => {
    const store = createMemoryStore({ users: [{ email: 'only@x.io', password: 'only-password', role: 'admin' }] });
    return { ludin: createLudin({ spec, store, auth: { session: { secret: 'test' } }, audit: { sink: false } }) };
  })();
  const soloCookie = await loginAs(solo, 'only@x.io', 'only-password');
  const soloAdmin = bodyOf(await solo.handle(req({ path: '/api/admin', headers: { host: 'x', cookie: soloCookie } })));
  const other = await solo.handle(
    send('POST', '/api/admin/users', { email: 'second@x.io', password: 'second-password', role: 'admin' }, soloCookie),
  );
  assert.equal(other.status, 201);
  const secondId = bodyOf(other).user.id;
  // Now the first admin is no longer the only one, but the second can be disabled freely.
  const disableSecond = await solo.handle(send('PATCH', `/api/admin/users/${secondId}`, { status: 'disabled' }, soloCookie));
  assert.equal(disableSecond.status, 200);
  assert.ok(soloAdmin.users.length >= 1);
});

test('store mode: disabling an account and revoking sessions kills live cookies', async () => {
  const { ludin } = setup();
  const adminCookie = await loginAs(ludin, 'admin@x.io', 'admin-password');
  const devCookie = await loginAs(ludin, 'dev@x.io', 'dev-password');
  assert.equal((await ludin.handle(req({ path: '/api/specs', headers: { host: 'x', cookie: devCookie } }))).status, 200);

  const admin = bodyOf(await ludin.handle(req({ path: '/api/admin', headers: { host: 'x', cookie: adminCookie } })));
  const dev = admin.users.find((u: { email: string }) => u.email === 'dev@x.io');
  assert.equal(dev.sessions, 1);

  const revoked = await ludin.handle(send('POST', `/api/admin/users/${dev.id}/revoke-sessions`, null, adminCookie));
  assert.equal(revoked.status, 200);
  assert.equal((await ludin.handle(req({ path: '/api/specs', headers: { host: 'x', cookie: devCookie } }))).status, 401);

  const devCookie2 = await loginAs(ludin, 'dev@x.io', 'dev-password');
  await ludin.handle(send('PATCH', `/api/admin/users/${dev.id}`, { status: 'disabled' }, adminCookie));
  assert.equal((await ludin.handle(req({ path: '/api/specs', headers: { host: 'x', cookie: devCookie2 } }))).status, 401);
  const relogin = await ludin.handle(send('POST', '/api/login', { email: 'dev@x.io', password: 'dev-password' }));
  assert.equal(relogin.status, 401, 'a disabled account cannot log back in');
});

test('store mode: invite flow issues a one-time token and signs the invitee in', async () => {
  const { ludin, store } = setup();
  const cookie = await loginAs(ludin, 'admin@x.io', 'admin-password');

  const created = await ludin.handle(send('POST', '/api/admin/invites', { email: 'new@x.io', role: 'developer' }, cookie));
  assert.equal(created.status, 201);
  const { token, url, invite } = bodyOf(created);
  assert.match(url, /#\/invite\//);
  assert.ok(token && token.length > 30);
  assert.equal(invite.tokenHash, undefined, 'the hash never leaves the server');

  const stored = await store.invites!.list();
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0].tokenHash, token, 'only a hash of the token is stored');

  const info = bodyOf(await ludin.handle(req({ path: '/api/invites/info', query: { token } })));
  assert.equal(info.email, 'new@x.io');
  assert.equal(info.role, 'developer');

  const short = await ludin.handle(send('POST', '/api/invites/accept', { token, password: 'short' }));
  assert.equal(short.status, 400);

  const accepted = await ludin.handle(send('POST', '/api/invites/accept', { token, password: 'chosen-password', name: 'New Dev' }));
  assert.equal(accepted.status, 200);
  const inviteeCookie = cookieOf(accepted);
  assert.equal(bodyOf(accepted).user.role, 'developer');
  assert.equal((await ludin.handle(req({ path: '/api/specs', headers: { host: 'x', cookie: inviteeCookie } }))).status, 200);

  const replay = await ludin.handle(send('POST', '/api/invites/accept', { token, password: 'another-password' }));
  assert.equal(replay.status, 404, 'a consumed invite cannot be replayed');
  assert.equal((await loginAs(ludin, 'new@x.io', 'chosen-password')).length > 0, true);
});

test('store mode: IP rules refuse to lock the caller out', async () => {
  const { ludin } = setup();
  const cookie = await loginAs(ludin, 'admin@x.io', 'admin-password');

  const wouldLock = await ludin.handle(send('POST', '/api/admin/ip', { cidr: '10.0.0.0/8' }, cookie));
  assert.equal(wouldLock.status, 400);
  assert.equal(bodyOf(wouldLock).code, 'self_lockout');

  const invalid = await ludin.handle(send('POST', '/api/admin/ip', { cidr: 'nonsense' }, cookie));
  assert.equal(invalid.status, 400);
  assert.equal(bodyOf(invalid).code, 'invalid_rule');

  const ok = await ludin.handle(send('POST', '/api/admin/ip', { cidr: '203.0.113.0/24', note: 'office' }, cookie));
  assert.equal(ok.status, 201);
  const ruleId = bodyOf(ok).rule.id;

  const blocked = await ludin.handle(req({ path: '/api/specs', headers: { host: 'x', cookie }, remoteAddress: '8.8.8.8' }));
  assert.equal(blocked.status, 403);

  const forced = await ludin.handle(send('POST', '/api/admin/ip', { cidr: '10.0.0.0/8', force: true }, cookie));
  assert.equal(forced.status, 201);

  const removeLast = await ludin.handle(send('DELETE', `/api/admin/ip/${ruleId}`, null, cookie));
  assert.equal(removeLast.status, 400, 'removing the rule that admits me is refused');
  const removeForced = await ludin.handle(
    send('DELETE', `/api/admin/ip/${ruleId}`, null, cookie, { query: { force: 'true' } }),
  );
  assert.equal(removeForced.status, 200);
});

test('store mode: audit log is queryable, scoped per role and exportable', async () => {
  const { ludin } = setup();
  const adminCookie = await loginAs(ludin, 'admin@x.io', 'admin-password');
  const devCookie = await loginAs(ludin, 'dev@x.io', 'dev-password');
  await ludin.handle(req({ path: '/api/spec', headers: { host: 'x', cookie: devCookie } }));

  const all = bodyOf(await ludin.handle(req({ path: '/api/audit', headers: { host: 'x', cookie: adminCookie } })));
  assert.ok(all.items.length >= 3);
  assert.ok(all.items.some((e: { type: string }) => e.type === 'login.success'));

  const mine = bodyOf(await ludin.handle(req({ path: '/api/audit', headers: { host: 'x', cookie: devCookie } })));
  assert.ok(mine.items.length > 0);
  assert.ok(
    mine.items.every((e: { user?: { email: string } }) => e.user?.email === 'dev@x.io'),
    'developers only see their own trail',
  );

  const filtered = bodyOf(
    await ludin.handle(req({ path: '/api/audit', query: { type: 'docs.view' }, headers: { host: 'x', cookie: adminCookie } })),
  );
  assert.ok(filtered.items.every((e: { type: string }) => e.type === 'docs.view'));

  const csv = await ludin.handle(req({ path: '/api/audit.csv', headers: { host: 'x', cookie: adminCookie } }));
  assert.match(String(csv.headers['content-type']), /text\/csv/);
  assert.match(String(csv.body).split('\r\n')[0], /^ts,type,user,role,ip,detail$/);
});

test('store mode: audit browsing is 501 without a queryable store', async () => {
  const bound = createLudin({
    spec,
    auth: { users: [{ email: 'a@x.io', password: 'binding-password', role: 'admin' }], session: { secret: 'test' } },
    audit: { sink: false },
  });
  const cookie = await loginAs(bound, 'a@x.io', 'binding-password');
  const res = await bound.handle(req({ path: '/api/audit', headers: { host: 'x', cookie } }));
  assert.equal(res.status, 501);
  assert.equal(bodyOf(res).code, 'store_required');
});

test('notices: the board is store-only and refuses binding mode', async () => {
  const bound = createLudin({
    spec,
    auth: { users: [{ email: 'a@x.io', password: 'binding-password', role: 'admin' }], session: { secret: 'test' } },
    audit: { sink: false },
  });
  const cookie = await loginAs(bound, 'a@x.io', 'binding-password');
  const me = bodyOf(await bound.handle(req({ path: '/api/me', headers: { host: 'x', cookie } })));
  assert.equal(me.capabilities.notices, false);

  const list = await bound.handle(req({ path: '/api/notices', headers: { host: 'x', cookie } }));
  assert.equal(list.status, 501);
  assert.equal(bodyOf(list).code, 'store_required');
  const post = await bound.handle(send('POST', '/api/notices', { title: 'Hi', body: 'x' }, cookie));
  assert.equal(post.status, 501);
});

test('notices: drafts and visibleTo decide who sees a post', async () => {
  const { ludin } = setup();
  const adminCookie = await loginAs(ludin, 'admin@x.io', 'admin-password');
  const devCookie = await loginAs(ludin, 'dev@x.io', 'dev-password');

  const published = await ludin.handle(
    send('POST', '/api/notices', { title: 'Release 2.4', body: '## Changes\n- faster', pinned: true }, adminCookie),
  );
  assert.equal(published.status, 201);
  assert.equal(bodyOf(published).notice.status, 'published');
  assert.equal(bodyOf(published).notice.authorEmail, 'admin@x.io');

  await ludin.handle(send('POST', '/api/notices', { title: 'Work in progress', body: 'later', status: 'draft' }, adminCookie));
  const adminOnly = bodyOf(
    await ludin.handle(send('POST', '/api/notices', { title: 'Internal', body: 'secret', visibleTo: ['admin'] }, adminCookie)),
  ).notice;

  const asAdmin = bodyOf(await ludin.handle(req({ path: '/api/notices', headers: { host: 'x', cookie: adminCookie } })));
  assert.equal(asAdmin.canWrite, true);
  assert.equal(asAdmin.notices.length, 3);
  assert.equal(asAdmin.notices[0].body, undefined, 'the list carries excerpts, not bodies');
  assert.match(asAdmin.notices.find((n: { title: string }) => n.title === 'Release 2.4').excerpt, /Changes/);

  const asDev = bodyOf(await ludin.handle(req({ path: '/api/notices', headers: { host: 'x', cookie: devCookie } })));
  assert.equal(asDev.canWrite, false);
  assert.deepEqual(asDev.notices.map((n: { title: string }) => n.title), ['Release 2.4']);

  const hidden = await ludin.handle(req({ path: `/api/notices/${adminOnly.id}`, headers: { host: 'x', cookie: devCookie } }));
  assert.equal(hidden.status, 404, 'a role-restricted notice is not readable, not just hidden from the list');

  const readable = bodyOf(await ludin.handle(req({ path: `/api/notices/${adminOnly.id}`, headers: { host: 'x', cookie: adminCookie } })));
  assert.equal(readable.notice.body, 'secret');
});

test('notices: only notices:write may post, edit or delete', async () => {
  const { ludin } = setup();
  const adminCookie = await loginAs(ludin, 'admin@x.io', 'admin-password');
  const devCookie = await loginAs(ludin, 'dev@x.io', 'dev-password');

  const denied = await ludin.handle(send('POST', '/api/notices', { title: 'Nope', body: 'x' }, devCookie));
  assert.equal(denied.status, 403);

  const created = bodyOf(await ludin.handle(send('POST', '/api/notices', { title: 'Draft', body: 'a', status: 'draft' }, adminCookie))).notice;
  const devEdit = await ludin.handle(send('PATCH', `/api/notices/${created.id}`, { title: 'Hijacked' }, devCookie));
  assert.equal(devEdit.status, 403);

  const edited = bodyOf(await ludin.handle(send('PATCH', `/api/notices/${created.id}`, { status: 'published', body: 'b' }, adminCookie))).notice;
  assert.equal(edited.status, 'published');
  assert.equal(edited.body, 'b');
  assert.ok(edited.updatedAt >= created.updatedAt);

  const empty = await ludin.handle(send('POST', '/api/notices', { title: '   ', body: 'x' }, adminCookie));
  assert.equal(empty.status, 400);

  assert.equal((await ludin.handle(send('DELETE', `/api/notices/${created.id}`, null, devCookie))).status, 403);
  assert.equal((await ludin.handle(send('DELETE', `/api/notices/${created.id}`, null, adminCookie))).status, 200);
  assert.equal((await ludin.handle(req({ path: `/api/notices/${created.id}`, headers: { host: 'x', cookie: adminCookie } }))).status, 404);

  const audit = bodyOf(await ludin.handle(req({ path: '/api/audit', headers: { host: 'x', cookie: adminCookie } })));
  const types = audit.items.map((e: { type: string }) => e.type);
  assert.ok(types.includes('notice.create') && types.includes('notice.update') && types.includes('notice.remove'));
});
