import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLudin, createIpMatcher, hashPassword, resolveClientIp, applyVisibility } from '../src/index.js';
import type { LudinRequest, AuditEvent } from '../src/index.js';

const spec = {
  openapi: '3.0.3',
  info: { title: 'T', version: '1' },
  servers: [{ url: 'http://api.example.com' }],
  tags: [{ name: 'Public' }, { name: 'Internal' }],
  paths: {
    '/pets': { get: { tags: ['Public'], operationId: 'listPets', responses: { 200: { description: 'ok' } } } },
    '/admin/reset': { post: { tags: ['Internal'], operationId: 'reset', responses: { 200: { description: 'ok' } } } },
  },
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

function post(path: string, body: unknown, extra: Partial<LudinRequest> = {}) {
  return req({
    method: 'POST',
    path,
    body: JSON.stringify(body),
    headers: { host: 'localhost:3000', 'x-requested-with': 'ludin', ...extra.headers },
    ...extra,
  });
}

function cookieOf(res: { headers: Record<string, string | string[]> }) {
  const sc = res.headers['set-cookie'];
  const s = Array.isArray(sc) ? sc[0] : sc;
  return s.split(';')[0];
}

test('IP matcher: CIDR, single, range, v6', () => {
  const m = createIpMatcher(['10.0.0.0/8', '192.168.1.5', '172.16.0.1-172.16.0.9', '2001:db8::/32']);
  assert.equal(m('10.20.30.40'), true);
  assert.equal(m('11.0.0.1'), false);
  assert.equal(m('192.168.1.5'), true);
  assert.equal(m('192.168.1.6'), false);
  assert.equal(m('172.16.0.7'), true);
  assert.equal(m('172.16.0.10'), false);
  assert.equal(m('2001:db8:1::1'), true);
  assert.equal(m('2001:db9::1'), false);
  assert.equal(m('::ffff:10.1.1.1'), true);
});

test('resolveClientIp honours trustProxy hops', () => {
  const h = { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' };
  assert.equal(resolveClientIp('9.9.9.9', h, false), '9.9.9.9');
  assert.equal(resolveClientIp('9.9.9.9', h, true), '3.3.3.3');
  assert.equal(resolveClientIp('9.9.9.9', h, 2), '2.2.2.2');
  assert.equal(resolveClientIp('9.9.9.9', h, 10), '1.1.1.1');
});

test('visibility removes tagged / pathed operations', () => {
  const doc = applyVisibility(structuredClone(spec), { 'tag:Internal': ['admin'] }, 'developer');
  assert.equal(doc.paths['/admin/reset'], undefined);
  assert.ok(doc.paths['/pets']);
  assert.deepEqual(doc.tags.map((t: any) => t.name), ['Public']);
  const adminDoc = applyVisibility(structuredClone(spec), { 'tag:Internal': ['admin'] }, 'admin');
  assert.ok(adminDoc.paths['/admin/reset']);
  const byPath = applyVisibility(structuredClone(spec), { '/admin/*': ['admin'] }, 'viewer');
  assert.equal(byPath.paths['/admin/reset'], undefined);
});

test('login flow: html served, spec locked until login, cookie grants access', async () => {
  const events: AuditEvent[] = [];
  const hashed = await hashPassword('s3cret');
  const ludin = createLudin({
    spec,
    auth: {
      users: [
        { email: 'a@x.io', password: hashed, role: 'admin' },
        { email: 'v@x.io', password: 'plain', role: 'viewer' },
      ],
      session: { secret: 'test-secret' },
    },
    visibility: { 'tag:Internal': ['admin'] },
    audit: { sink: (e) => void events.push(e) },
  });

  const page = await ludin.handle(req({ path: '/' }));
  assert.equal(page.status, 200);
  assert.match(String(page.body), /window\.__LUDIN__/);

  const locked = await ludin.handle(req({ path: '/api/spec' }));
  assert.equal(locked.status, 401);

  const bad = await ludin.handle(post('/api/login', { email: 'a@x.io', password: 'nope' }));
  assert.equal(bad.status, 401);

  const ok = await ludin.handle(post('/api/login', { email: 'a@x.io', password: 's3cret' }));
  assert.equal(ok.status, 200);
  const cookie = cookieOf(ok);
  assert.match(cookie, /^ludin_session=/);

  const specRes = await ludin.handle(req({ path: '/api/spec', headers: { host: 'x', cookie } }));
  assert.equal(specRes.status, 200);
  const doc = JSON.parse(String(specRes.body));
  assert.ok(doc.paths['/admin/reset'], 'admin sees internal');

  const vLogin = await ludin.handle(post('/api/login', { email: 'v@x.io', password: 'plain' }));
  const vCookie = cookieOf(vLogin);
  const vSpec = JSON.parse(String((await ludin.handle(req({ path: '/api/spec', headers: { host: 'x', cookie: vCookie } }))).body));
  assert.equal(vSpec.paths['/admin/reset'], undefined, 'viewer does not see internal');

  const vTry = await ludin.handle(post('/api/try', { method: 'GET', url: 'http://api.example.com/pets' }, { headers: { cookie: vCookie } }));
  assert.equal(vTry.status, 403, 'viewer cannot try');

  const adminRes = await ludin.handle(req({ path: '/api/admin', headers: { host: 'x', cookie } }));
  const admin = JSON.parse(String(adminRes.body));
  assert.equal(admin.users.length, 2);
  assert.equal(admin.users[0].hashed, true);
  assert.equal(admin.users[1].hashed, false);
  assert.ok(!JSON.stringify(admin).includes('s3cret') && !JSON.stringify(admin).includes('plain"'));

  assert.ok(events.some((e) => e.type === 'login.failure'));
  assert.ok(events.some((e) => e.type === 'login.success' && e.user?.email === 'a@x.io'));
});

test('csrf header required for mutations', async () => {
  const ludin = createLudin({ spec, auth: { users: [{ email: 'a@x.io', password: 'p' }] } });
  const res = await ludin.handle(req({ method: 'POST', path: '/api/login', body: '{}' }));
  assert.equal(res.status, 403);
});

test('lockout after repeated failures', async () => {
  const ludin = createLudin({ spec, auth: { users: [{ email: 'a@x.io', password: 'p' }], lockout: { attempts: 3, window: '1m' } }, audit: { sink: false } });
  for (let i = 0; i < 3; i++) await ludin.handle(post('/api/login', { email: 'a@x.io', password: 'x' }));
  const res = await ludin.handle(post('/api/login', { email: 'a@x.io', password: 'p' }));
  assert.equal(res.status, 429);
});

test('ip allowlist: and / or policies, localhost bypass, hideOnBlock', async () => {
  const base = { spec, auth: { users: [{ email: 'a@x.io', password: 'p' }] }, ipAllowlist: ['10.0.0.0/8'], audit: { sink: false as const } };
  const and = createLudin(base);
  assert.equal((await and.handle(req({ remoteAddress: '8.8.8.8' }))).status, 403);
  assert.equal((await and.handle(req({ remoteAddress: '127.0.0.1' }))).status, 200, 'localhost bypass');
  assert.equal((await and.handle(req({ remoteAddress: '10.1.1.1', path: '/api/spec' }))).status, 401, 'and: still needs login');

  const or = createLudin({ ...base, ipPolicy: 'or' });
  assert.equal((await or.handle(req({ remoteAddress: '10.1.1.1', path: '/api/spec' }))).status, 200, 'or: ip is enough');
  const me = JSON.parse(String((await or.handle(req({ remoteAddress: '10.1.1.1', path: '/api/me' }))).body));
  assert.equal(me.anonymous, true);

  const hidden = createLudin({ ...base, hideOnBlock: true, allowLocalhost: false });
  assert.equal((await hidden.handle(req({ remoteAddress: '127.0.0.1' }))).status, 404);

  const proxied = createLudin({ ...base, trustProxy: true });
  assert.equal((await proxied.handle(req({ remoteAddress: '127.0.0.1', headers: { host: 'x', 'x-forwarded-for': '8.8.8.8' } }))).status, 403);
});

test('auth: false grants anonymous developer', async () => {
  const ludin = createLudin({ spec, auth: false, audit: { sink: false } });
  const me = JSON.parse(String((await ludin.handle(req({ path: '/api/me' }))).body));
  assert.equal(me.user.role, 'developer');
  assert.equal(me.authEnabled, false);
});

test('try proxy rejects unknown origins and self', async () => {
  const ludin = createLudin({ spec, auth: false, audit: { sink: false } });
  const bad = await ludin.handle(post('/api/try', { method: 'GET', url: 'http://evil.example/x' }));
  assert.equal(bad.status, 403);
  const self = await ludin.handle(post('/api/try', { method: 'GET', url: '/docs/api/me' }));
  assert.equal(self.status, 400);
});

test('try proxy: forwardCookies hands the caller\'s own cookies to same-origin APIs only', async (t) => {
  const seen: Array<Record<string, string>> = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    seen.push(init.headers as Record<string, string>);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const users = [{ email: 'a@x.io', password: 's3cret', role: 'admin' as const }];
  async function tryWith(opts: Record<string, unknown>, url: string) {
    const ludin = createLudin({ spec, auth: { users, session: { secret: 's' } }, audit: { sink: false }, ...opts });
    const session = cookieOf(await ludin.handle(post('/api/login', { email: 'a@x.io', password: 's3cret' })));
    // What a browser sends to /docs/api/try when a console session lives on the same origin.
    const cookie = `${session}; sid=abc; theme=dark; ludin_session_share=nope`;
    const res = await ludin.handle(post('/api/try', { method: 'GET', url, headers: { cookie: 'typed=by-hand' } }, {
      headers: { host: 'localhost:3000', 'x-requested-with': 'ludin', cookie },
    }));
    assert.equal(res.status, 200, String(res.body));
    return seen.pop()!;
  }

  // Off by default: nothing leaves, not even for the docs' own origin.
  assert.equal((await tryWith({}, '/console/me')).cookie, undefined);

  // On: the caller's cookies go along, ludin's own session and share cookies do not.
  assert.equal((await tryWith({ forwardCookies: true }, '/console/me')).cookie, 'sid=abc; theme=dark');

  // Never to another origin, even one the proxy may call.
  assert.equal((await tryWith({ forwardCookies: true }, 'http://api.example.com/pets')).cookie, undefined);

  // A list forwards only those names.
  assert.equal((await tryWith({ forwardCookies: ['sid'] }, '/console/me')).cookie, 'sid=abc');
  assert.equal((await tryWith({ forwardCookies: ['other'] }, '/console/me')).cookie, undefined);
});

test('custom verify hook', async () => {
  const ludin = createLudin({
    spec,
    auth: { verify: async (e, p) => (e === 'x' && p === 'y' ? { id: '1', email: 'x', role: 'viewer' } : null) },
    audit: { sink: false },
  });
  assert.equal((await ludin.handle(post('/api/login', { email: 'x', password: 'y' }))).status, 200);
  assert.equal((await ludin.handle(post('/api/login', { email: 'x', password: 'z' }))).status, 401);
});

test('spec export: JSON and YAML downloads respect visibility and are audited', async () => {
  const events: AuditEvent[] = [];
  const ludin = createLudin({
    spec,
    auth: { users: [{ email: 'a@x.io', password: 'p', role: 'admin' }, { email: 'v@x.io', password: 'p', role: 'viewer' }], session: { secret: 's' } },
    visibility: { 'tag:Internal': ['admin'] },
    audit: { sink: (e) => void events.push(e) },
  });
  const cookieFor = async (email: string) => cookieOf(await ludin.handle(post('/api/login', { email, password: 'p' })));
  const adminCookie = await cookieFor('a@x.io');
  const viewerCookie = await cookieFor('v@x.io');

  const asAdmin = await ludin.handle(req({ path: '/api/spec.json', headers: { host: 'x', cookie: adminCookie } }));
  assert.equal(asAdmin.status, 200);
  assert.match(String(asAdmin.headers['content-disposition']), /attachment; filename="T\.json"/);
  assert.ok(JSON.parse(String(asAdmin.body)).paths['/admin/reset'], 'admin downloads the internal operation');

  const asViewer = await ludin.handle(req({ path: '/api/spec.json', headers: { host: 'x', cookie: viewerCookie } }));
  assert.equal(JSON.parse(String(asViewer.body)).paths['/admin/reset'], undefined, 'the download is filtered like the docs');

  const yaml = await ludin.handle(req({ path: '/api/spec.yaml', headers: { host: 'x', cookie: viewerCookie } }));
  assert.match(String(yaml.headers['content-type']), /application\/yaml/);
  assert.match(String(yaml.body), /openapi: 3\.0\.3/);
  assert.ok(!String(yaml.body).includes('/admin/reset'));

  assert.equal((await ludin.handle(req({ path: '/api/spec.json' }))).status, 401, 'no download without a session');
  assert.equal(events.filter((e) => e.type === 'docs.export').length, 3);
});

// --- readme page -----------------------------------------------------------
function readmeFixture(html: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'ludin-readme-')), 'readme.html');
  writeFileSync(file, html);
  return file;
}

async function loginAs(ludin: ReturnType<typeof createLudin>, email: string, password: string) {
  return cookieOf(await ludin.handle(post('/api/login', { email, password })));
}

test('readme: served sandboxed to anyone who can read the docs, audited', async () => {
  const events: AuditEvent[] = [];
  const file = readmeFixture('<!doctype html><h1>Getting started</h1>');
  const ludin = createLudin({
    spec,
    readme: { enabled: true, path: file, label: 'Guide' },
    auth: { users: [{ email: 'v@x.io', password: 'plain', role: 'viewer' }], session: { secret: 's' } },
    audit: { sink: (e) => void events.push(e) },
  });

  // The button is advertised to the UI…
  const page = String((await ludin.handle(req({ path: '/' }))).body);
  assert.match(page, /"label":"Guide"/);
  assert.match(page, /"url":"\/docs\/readme"/);

  // …but the file itself still needs a session.
  assert.equal((await ludin.handle(req({ path: '/readme' }))).status, 401);

  const cookie = await loginAs(ludin, 'v@x.io', 'plain');
  const me = JSON.parse(String((await ludin.handle(req({ path: '/api/me', headers: { cookie } }))).body));
  assert.deepEqual(me.readme, { label: 'Guide' });

  const res = await ludin.handle(req({ path: '/readme', headers: { cookie } }));
  assert.equal(res.status, 200);
  assert.match(String(res.body), /Getting started/);
  assert.equal(res.headers['content-security-policy'], 'sandbox allow-scripts allow-popups allow-forms allow-modals');
  assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
  assert.ok(events.some((e) => e.type === 'docs.readme' && e.user?.email === 'v@x.io'));

  // Trailing slashes reach the same page.
  assert.equal((await ludin.handle(req({ path: '/readme/', headers: { cookie } }))).status, 200);
});

test('readme: visibleTo narrows it, enabled:false and a missing file hide it', async () => {
  const file = readmeFixture('<p>internal</p>');
  const users = [
    { email: 'a@x.io', password: 'adminpw', role: 'admin' },
    { email: 'v@x.io', password: 'viewerpw', role: 'viewer' },
  ];
  const restricted = createLudin({
    spec,
    readme: { path: file, visibleTo: ['admin'] },
    auth: { users, session: { secret: 's' } },
    audit: { sink: false },
  });
  const viewer = await loginAs(restricted, 'v@x.io', 'viewerpw');
  const admin = await loginAs(restricted, 'a@x.io', 'adminpw');
  assert.equal((await restricted.handle(req({ path: '/readme', headers: { cookie: viewer } }))).status, 403);
  assert.equal((await restricted.handle(req({ path: '/readme', headers: { cookie: admin } }))).status, 200);
  const viewerMe = JSON.parse(String((await restricted.handle(req({ path: '/api/me', headers: { cookie: viewer } }))).body));
  assert.equal(viewerMe.readme, null);

  const off = createLudin({ spec, readme: { path: file, enabled: false }, auth: { users, session: { secret: 's' } }, audit: { sink: false } });
  const offCookie = await loginAs(off, 'a@x.io', 'adminpw');
  assert.equal((await off.handle(req({ path: '/readme', headers: { cookie: offCookie } }))).status, 404);
  assert.match(String((await off.handle(req({ path: '/' }))).body), /"readme":null/);

  const missing = createLudin({ spec, readme: join(tmpdir(), 'ludin-no-such-readme.html'), auth: { users, session: { secret: 's' } }, audit: { sink: false } });
  const missingCookie = await loginAs(missing, 'a@x.io', 'adminpw');
  assert.equal((await missing.handle(req({ path: '/readme', headers: { cookie: missingCookie } }))).status, 404);
});
