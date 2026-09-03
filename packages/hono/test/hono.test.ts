import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { mountLudin } from '../src/index.js';

const spec = {
  openapi: '3.0.3',
  info: { title: 'T', version: '1' },
  paths: { '/pets': { get: { responses: { 200: { description: 'ok' } } } } },
};

function app(extra: Record<string, unknown> = {}) {
  const hono = new Hono();
  mountLudin(hono, {
    spec,
    basePath: '/docs',
    auth: { users: [{ email: 'a@x.io', password: 'p', role: 'admin' }], session: { secret: 'test' } },
    audit: { sink: false },
    ...extra,
  });
  hono.get('/health', (c) => c.text('ok'));
  return hono;
}

test('hono: serves docs, guards the api, logs in', async () => {
  const hono = app();

  const page = await hono.request('http://x/docs');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /window\.__LUDIN__/);

  assert.equal((await hono.request('http://x/docs/api/spec')).status, 401);

  const login = await hono.request('http://x/docs/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'ludin' },
    body: JSON.stringify({ email: 'a@x.io', password: 'p' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];

  const doc = await hono.request('http://x/docs/api/spec?name=default', { headers: { cookie } });
  assert.equal(doc.status, 200);
  assert.ok(((await doc.json()) as any).paths['/pets']);

  assert.equal((await hono.request('http://x/health')).status, 200);
});

test('hono: IP rules work through trustProxy when the runtime hides the peer', async () => {
  const hono = app({ ipAllowlist: ['10.0.0.0/8'], allowLocalhost: false, trustProxy: true });

  const blocked = await hono.request('http://x/docs', { headers: { 'x-forwarded-for': '8.8.8.8' } });
  assert.equal(blocked.status, 403);

  const allowed = await hono.request('http://x/docs', { headers: { 'x-forwarded-for': '10.1.2.3' } });
  assert.equal(allowed.status, 200);
});
