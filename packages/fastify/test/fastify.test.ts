import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { ludin } from '../src/index.js';

const spec = {
  openapi: '3.0.3',
  info: { title: 'T', version: '1' },
  paths: { '/pets': { get: { tags: ['Public'], responses: { 200: { description: 'ok' } } } } },
};

const options = {
  spec,
  auth: { users: [{ email: 'a@x.io', password: 'p', role: 'admin' as const }], session: { secret: 'test' } },
  audit: { sink: false as const },
};

async function start(prefix: string | undefined = '/docs') {
  const app = Fastify();
  app.post('/echo', async (req) => ({ got: req.body }));
  const plugin = ludin(prefix ? options : { ...options, basePath: '/docs' });
  await app.register(plugin, prefix ? { prefix } : {});
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as { port: number };
  return { app, base: `http://127.0.0.1:${port}` };
}

test('fastify: serves docs, guards the api, logs in', async (t) => {
  const { app, base } = await start();
  t.after(() => app.close());

  const page = await fetch(`${base}/docs`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /window\.__LUDIN__/);

  const locked = await fetch(`${base}/docs/api/spec`);
  assert.equal(locked.status, 401);

  const login = await fetch(`${base}/docs/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'ludin' },
    body: JSON.stringify({ email: 'a@x.io', password: 'p' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];

  const doc = await fetch(`${base}/docs/api/spec?name=default`, { headers: { cookie } });
  assert.equal(doc.status, 200);
  assert.ok((await doc.json()).paths['/pets']);
});

test('fastify: other routes keep their own body parsing and 404s', async (t) => {
  const { app, base } = await start();
  t.after(() => app.close());

  const echo = await fetch(`${base}/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hi: 1 }),
  });
  assert.deepEqual(await echo.json(), { got: { hi: 1 } });

  assert.equal((await fetch(`${base}/nope`)).status, 404);
});

test('fastify: mounts at basePath without a register prefix', async (t) => {
  const { app, base } = await start(undefined);
  t.after(() => app.close());
  assert.equal((await fetch(`${base}/docs`)).status, 200);
  assert.equal((await fetch(`${base}/docs/api/me`)).status, 200);
});
