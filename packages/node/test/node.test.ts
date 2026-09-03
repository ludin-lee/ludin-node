import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createLudinServer, ludin } from '../src/index.js';

const spec = {
  openapi: '3.0.3',
  info: { title: 'T', version: '1' },
  paths: { '/pets': { get: { responses: { 200: { description: 'ok' } } } } },
};

const options = {
  spec,
  basePath: '/docs',
  auth: { users: [{ email: 'a@x.io', password: 'p', role: 'admin' as const }], session: { secret: 'test' } },
  audit: { sink: false as const },
};

async function listen(server: ReturnType<typeof createServer>) {
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

test('node: docs served, other routes fall through to next()', async (t) => {
  const docs = ludin(options);
  const server = createServer((req, res) =>
    docs(req, res, () => {
      res.statusCode = 418;
      res.end('app route');
    }),
  );
  const base = await listen(server);
  t.after(() => server.close());

  const page = await fetch(`${base}/docs`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /window\.__LUDIN__/);

  assert.equal((await fetch(`${base}/docs/api/spec`)).status, 401);

  const login = await fetch(`${base}/docs/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'ludin' },
    body: JSON.stringify({ email: 'a@x.io', password: 'p' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const doc = await fetch(`${base}/docs/api/spec?name=default`, { headers: { cookie } });
  assert.ok((await doc.json()).paths['/pets']);

  const other = await fetch(`${base}/elsewhere`);
  assert.equal(other.status, 418);
  assert.equal(await other.text(), 'app route');
});

test('node: createLudinServer 404s outside basePath', async (t) => {
  const server = createLudinServer(options);
  const base = await listen(server);
  t.after(() => server.close());

  assert.equal((await fetch(`${base}/docs/api/me`)).status, 200);
  assert.equal((await fetch(`${base}/`)).status, 404);
});
