import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import Koa from 'koa';
import { ludin } from '../src/index.js';

const spec = {
  openapi: '3.0.3',
  info: { title: 'T', version: '1' },
  paths: { '/pets': { get: { responses: { 200: { description: 'ok' } } } } },
};

async function start() {
  const app = new Koa();
  app.use(ludin({
    spec,
    basePath: '/docs',
    auth: { users: [{ email: 'a@x.io', password: 'p', role: 'admin' }], session: { secret: 'test' } },
    audit: { sink: false },
  }));
  app.use(async (ctx) => {
    ctx.status = 404;
    ctx.body = 'passed through';
  });
  const server = createServer(app.callback()).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${port}` };
}

test('koa: serves docs, guards the api, logs in, passes other paths through', async (t) => {
  const { server, base } = await start();
  t.after(() => server.close());

  const page = await fetch(`${base}/docs`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /window\.__LUDIN__/);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);

  assert.equal((await fetch(`${base}/docs/api/spec`)).status, 401);

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

  const other = await fetch(`${base}/elsewhere`);
  assert.equal(other.status, 404);
  assert.equal(await other.text(), 'passed through');
});
