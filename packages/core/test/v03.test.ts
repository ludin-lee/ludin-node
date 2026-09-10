import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSampleInput, generateSamples, buildSearchIndex,
  validateAgainstSchema, responseSchemaFor, lintSpec, createLudin, hashPassword,
} from '../src/index.js';
import type { LudinRequest } from '../src/index.js';
import { ShareSigner } from '../src/share.js';

const spec = {
  openapi: '3.0.3',
  info: { title: 'T', version: '1', description: 'demo' },
  servers: [{ url: 'http://api.example.com' }],
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    schemas: {
      Pet: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          status: { type: 'string', enum: ['available', 'sold'] },
          bornAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  security: [{ bearer: [] }],
  paths: {
    '/pets/{petId}': {
      get: {
        operationId: 'getPet',
        summary: 'Fetch one pet',
        tags: ['Pets'],
        parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer', example: 7 }, description: 'id' }],
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } },
      },
    },
    '/pets': {
      post: {
        operationId: 'createPet',
        summary: 'Create',
        tags: ['Pets'],
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
        responses: { 201: { description: 'created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } },
      },
    },
    '/internal/flags': {
      get: { operationId: 'flags', tags: ['Internal'], responses: { 200: { description: 'ok' } } },
    },
  },
};

// --- samples ---------------------------------------------------------------

test('samples: path params, auth header and body example are filled in', () => {
  const input = buildSampleInput(spec, 'GET', '/pets/{petId}')!;
  assert.equal(input.url, 'http://api.example.com/pets/7');
  assert.deepEqual(input.headers, [['Authorization', 'Bearer $TOKEN']]);
  const s = generateSamples(input);
  assert.match(s.curl, /curl -X GET 'http:\/\/api\.example\.com\/pets\/7'/);
  assert.match(s.fetch, /await fetch\("http:\/\/api\.example\.com\/pets\/7"/);
  assert.match(s.python, /requests\.get\(/);
  assert.match(s.go, /http\.NewRequest\("GET"/);
  assert.match(s.http, /^GET http:\/\/api\.example\.com\/pets\/7$/m);

  const post = buildSampleInput(spec, 'POST', '/pets')!;
  assert.ok(post.body!.includes('"name": "string"'));
  assert.ok(post.headers.some(([k]) => k === 'Content-Type'));
  assert.match(generateSamples(post).curl, /-d '/);
});

// --- search index ----------------------------------------------------------

test('search index: operations carry schema field names', () => {
  const index = buildSearchIndex(spec);
  const get = index.find((e) => e.operationId === 'getPet')!;
  assert.equal(get.method, 'GET');
  assert.ok(get.fields.includes('petId'));
  assert.ok(get.fields.includes('bornAt'));   // from the response schema, via $ref
  const post = index.find((e) => e.operationId === 'createPet')!;
  assert.ok(post.fields.includes('status'));  // from the request body
});

// --- response validation ---------------------------------------------------

test('validator: type, required, enum, format', () => {
  const schema = { $ref: '#/components/schemas/Pet' };
  assert.deepEqual(validateAgainstSchema(spec, schema, { id: 1, name: 'a', status: 'available' }), []);
  const issues = validateAgainstSchema(spec, schema, { id: 'x', status: 'lost', bornAt: 'yesterday' });
  const messages = issues.map((i) => `${i.path} ${i.message}`).join('\n');
  assert.match(messages, /\$\.id expected integer, got string/);
  assert.match(messages, /missing required property "name"/);
  assert.match(messages, /not in enum/);
  assert.match(messages, /does not look like a date-time/);
});

test('validator: arrays and null handling', () => {
  const schema = { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } };
  assert.equal(validateAgainstSchema(spec, schema, [{ id: 1 }, {}]).length, 1);
  assert.equal(validateAgainstSchema(spec, { type: 'string', nullable: true }, null).length, 0);
  assert.equal(validateAgainstSchema(spec, { type: 'string' }, null).length, 1);
});

test('responseSchemaFor picks status, XX class and default', () => {
  assert.ok(responseSchemaFor(spec, 'GET', '/pets/{petId}', 200));
  assert.equal(responseSchemaFor(spec, 'GET', '/pets/{petId}', 404), null);
  const withDefault = structuredClone(spec) as any;
  withDefault.paths['/pets/{petId}'].get.responses.default =
    { description: 'err', content: { 'application/json': { schema: { type: 'object' } } } };
  assert.ok(responseSchemaFor(withDefault, 'GET', '/pets/{petId}', 500));
});

// --- lint ------------------------------------------------------------------

test('lint: scores and reports the untidy operation', () => {
  const result = lintSpec(spec);
  assert.ok(result.score > 0 && result.score < 100);
  const rules = result.issues.map((i) => i.rule);
  assert.ok(rules.includes('op-summary'));            // /internal/flags has none
  assert.ok(result.issues.some((i) => i.path === 'GET /internal/flags'));
  assert.equal(lintSpec({ openapi: '3.0.3', info: { description: 'd' }, servers: [{ url: 'x' }], paths: {} }).score, 100);
});

// --- routes ----------------------------------------------------------------

function req(partial: Partial<LudinRequest>): LudinRequest {
  return { method: 'GET', path: '/', query: {}, headers: { host: 'localhost:3000' }, remoteAddress: '127.0.0.1', body: null, ...partial };
}

test('routes: samples / search-index / lint respect roles and visibility', async () => {
  const ludin = createLudin({
    spec,
    auth: { users: [{ email: 'd@x.io', password: await hashPassword('pw'), role: 'developer' }] },
    visibility: { 'tag:Internal': ['admin'] },
  });
  const login = await ludin.handle(req({
    method: 'POST', path: '/api/login', body: JSON.stringify({ email: 'd@x.io', password: 'pw' }),
    headers: { host: 'localhost:3000', 'x-requested-with': 'ludin' },
  }));
  const cookie = String(Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'][0] : login.headers['set-cookie']).split(';')[0];
  const get = (path: string, query: Record<string, string> = {}) =>
    ludin.handle(req({ path, query, headers: { host: 'localhost:3000', cookie } }));

  // Samples for a visible operation, 404 for a hidden one, 401 anonymous.
  const ok = await get('/api/samples', { method: 'GET', path: '/pets/{petId}' });
  assert.equal(ok.status, 200);
  assert.match(JSON.parse(String(ok.body)).samples.curl, /pets\/7/);
  assert.equal((await get('/api/samples', { method: 'GET', path: '/internal/flags' })).status, 404);
  assert.equal((await ludin.handle(req({ path: '/api/samples', query: { method: 'GET', path: '/pets' } }))).status, 401);

  // The search index never names hidden operations.
  const index = JSON.parse(String((await get('/api/search-index')).body)).index;
  assert.ok(index.some((e: any) => e.operationId === 'getPet'));
  assert.ok(!index.some((e: any) => e.operationId === 'flags'));

  // Lint runs on the filtered document.
  const lint = JSON.parse(String((await get('/api/lint')).body));
  assert.ok(lint.score > 0);
  assert.ok(!lint.issues.some((i: any) => i.path.includes('/internal/flags')));
});

test('lint: ignored rules count neither as checks nor issues', () => {
  const full = lintSpec(spec);
  const trimmed = lintSpec(spec, { ignore: ['op-summary', 'op-tags'] });
  assert.ok(trimmed.checks < full.checks);
  assert.ok(!trimmed.issues.some((i) => i.rule === 'op-summary' || i.rule === 'op-tags'));
  assert.ok(trimmed.score >= full.score);
});

// --- share links -----------------------------------------------------------

function shareLudin(extra: Record<string, any> = {}) {
  return createLudin({
    spec: [
      { name: 'Public', spec },
      { name: 'Partner', spec: { openapi: '3.0.3', info: { title: 'P', version: '1' }, paths: {} } },
    ],
    auth: { users: [{ email: 'a@x.io', password: 'pw', role: 'admin' }], session: { secret: 'test-secret' } },
    share: { enabled: true },
    ...extra,
  });
}

async function adminCookie(ludin: ReturnType<typeof createLudin>, from = '203.0.113.10') {
  const res = await ludin.handle(req({
    method: 'POST', path: '/api/login', body: JSON.stringify({ email: 'a@x.io', password: 'pw' }),
    remoteAddress: from,
    headers: { host: 'localhost:3000', 'x-requested-with': 'ludin' },
  }));
  const sc = res.headers['set-cookie'];
  return String(Array.isArray(sc) ? sc[0] : sc).split(';')[0];
}

async function mintShare(ludin: ReturnType<typeof createLudin>, cookie: string, body: Record<string, unknown>, from = '203.0.113.10') {
  const res = await ludin.handle(req({
    method: 'POST', path: '/api/share', body: JSON.stringify(body),
    remoteAddress: from,
    headers: { host: 'localhost:3000', 'x-requested-with': 'ludin', cookie },
  }));
  return { status: res.status, data: JSON.parse(String(res.body)) };
}

test('share: read-only by default, never admin, spec-locked', async () => {
  const ludin = shareLudin();
  const cookie = await adminCookie(ludin);

  const { data } = await mintShare(ludin, cookie, { role: 'viewer', spec: 'Public', label: 'Acme' });
  assert.ok(data.token && data.url.includes('share='));
  const withShare = (path: string, query: Record<string, string> = {}) =>
    ludin.handle(req({ path, query: { share: data.token, ...query }, headers: { host: 'localhost:3000' } }));

  // reads the document it was scoped to
  assert.equal((await withShare('/api/spec')).status, 200);
  // but only that spec – the other one is not even listed
  assert.deepEqual(JSON.parse(String((await withShare('/api/specs')).body)).specs.map((s: any) => s.name), ['Public']);
  assert.equal((await withShare('/api/spec', { name: 'Partner' })).status, 404);
  // cannot execute requests…
  assert.equal((await ludin.handle(req({
    method: 'POST', path: '/api/try', query: { share: data.token },
    body: JSON.stringify({ method: 'GET', url: 'http://api.example.com/pets' }),
    headers: { host: 'localhost:3000', 'x-requested-with': 'ludin' },
  }))).status, 403);
  // …and can never administer
  assert.equal((await withShare('/api/admin')).status, 403);
  assert.equal((await withShare('/api/share')).status, 403);
});

test('share: an admin-capable role is refused at creation', async () => {
  const ludin = shareLudin();
  const cookie = await adminCookie(ludin);
  const { status, data } = await mintShare(ludin, cookie, { role: 'admin' });
  assert.equal(status, 400);
  assert.equal(data.code, 'bad_role');
});

test('share: canTry opens Try it out explicitly', async () => {
  const ludin = shareLudin();
  const cookie = await adminCookie(ludin);
  const { data } = await mintShare(ludin, cookie, { role: 'developer', canTry: true });
  const res = await ludin.handle(req({
    method: 'POST', path: '/api/try', query: { share: data.token },
    body: JSON.stringify({ method: 'GET', url: 'http://api.example.com/pets' }),
    headers: { host: 'localhost:3000', 'x-requested-with': 'ludin' },
  }));
  assert.notEqual(res.status, 403);   // reaches the proxy instead of being refused
});

test('share: tokens and session cookies are not interchangeable', async () => {
  const ludin = shareLudin();
  const cookie = await adminCookie(ludin);
  const { data } = await mintShare(ludin, cookie, { role: 'viewer' });
  const sessionToken = cookie.split('=')[1];

  // a session token presented as a share grant is ignored
  assert.equal((await ludin.handle(req({ path: '/api/spec', query: { share: sessionToken }, headers: { host: 'localhost:3000' } }))).status, 401);
  // a share token presented as a session cookie is ignored
  assert.equal((await ludin.handle(req({ path: '/api/spec', headers: { host: 'localhost:3000', cookie: `ludin_session=${data.token}` } }))).status, 401);
  // a tampered share token is rejected
  assert.equal((await ludin.handle(req({ path: '/api/spec', query: { share: data.token.slice(0, -2) + 'xx' }, headers: { host: 'localhost:3000' } }))).status, 401);
});

test('share: expiry is enforced and capped by maxTtl', async () => {
  const ludin = shareLudin({ share: { enabled: true, maxTtl: '1h' } });
  const cookie = await adminCookie(ludin);
  const { data } = await mintShare(ludin, cookie, { role: 'viewer', ttl: '30d' });
  const capped = (new Date(data.expiresAt).getTime() - Date.now()) / 1000;
  assert.ok(capped <= 3600 + 5, `ttl should be capped, got ${capped}s`);

  // an already-expired token is refused
  const expired = new ShareSigner('test-secret').issue({ role: 'viewer', canTry: false }, -10);
  assert.equal((await ludin.handle(req({ path: '/api/spec', query: { share: expired.token }, headers: { host: 'localhost:3000' } }))).status, 401);
});

test('share: the IP allowlist still applies', async () => {
  const ludin = shareLudin({ ipAllowlist: ['10.0.0.0/8'], allowLocalhost: false });
  const cookie = await adminCookie(ludin, '10.1.2.3');
  const { data } = await mintShare(ludin, cookie, { role: 'viewer' }, '10.1.2.3');
  const outside = await ludin.handle(req({ path: '/api/spec', query: { share: data.token }, remoteAddress: '203.0.113.9', headers: { host: 'localhost:3000' } }));
  assert.equal(outside.status, 403);
  const inside = await ludin.handle(req({ path: '/api/spec', query: { share: data.token }, remoteAddress: '10.1.2.3', headers: { host: 'localhost:3000' } }));
  assert.equal(inside.status, 200);
});

test('share: disabled by default', async () => {
  const ludin = createLudin({ spec, auth: { users: [{ email: 'a@x.io', password: 'pw', role: 'admin' }], session: { secret: 's' } } });
  const cookie = await adminCookie(ludin);
  const { status } = await mintShare(ludin, cookie, { role: 'viewer' });
  assert.equal(status, 400);
});

// --- spec diff -------------------------------------------------------------

import { diffSpecs } from '../src/index.js';

const v1 = {
  openapi: '3.0.3',
  info: { title: 'T', version: '1.0.0' },
  components: {
    schemas: {
      Pet: { type: 'object', required: ['id'], properties: {
        id: { type: 'integer' }, name: { type: 'string' }, status: { type: 'string', enum: ['available', 'sold'] } } },
    },
  },
  paths: {
    '/pets': {
      get: { operationId: 'list', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } } },
      post: { operationId: 'create',
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
        responses: { 201: { description: 'made' } } },
    },
    '/legacy': { get: { operationId: 'legacy', responses: { 200: { description: 'ok' } } } },
  },
};

function v2(): any {
  const d = structuredClone(v1) as any;
  d.info.version = '2.0.0';
  delete d.paths['/legacy'];                                            // breaking: path removed
  d.paths['/pets'].get.parameters.push({ name: 'cursor', in: 'query', required: true, schema: { type: 'string' } }); // breaking
  d.paths['/pets'].delete = { operationId: 'wipe', responses: { 204: { description: 'gone' } } };                    // additive
  d.components.schemas.Pet.required.push('name');                       // breaking for the request body
  d.components.schemas.Pet.properties.tag = { type: 'string' };         // additive
  return d;
}

test('diff: classifies breaking vs compatible changes', () => {
  const r = diffSpecs(v1, v2());
  const kinds = r.changes.map((c) => c.kind);
  assert.ok(kinds.includes('path-removed'));
  assert.ok(kinds.includes('param-added-required'));
  assert.ok(kinds.includes('operation-added'));
  assert.equal(r.versions.before, '1.0.0');
  assert.equal(r.versions.after, '2.0.0');
  assert.ok(r.breaking >= 2 && r.nonBreaking >= 2);
  // the additive ones must not be flagged
  assert.equal(r.changes.find((c) => c.kind === 'operation-added')!.breaking, false);
  assert.equal(r.changes.find((c) => c.kind === 'path-removed')!.breaking, true);
});

test('diff: direction decides – requests and responses break differently', () => {
  const before = {
    openapi: '3.0.3', info: { title: 'T', version: '1' },
    paths: { '/x': { post: {
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { a: { type: 'string' }, s: { type: 'string', enum: ['x', 'y'] } } } } } },
      responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { b: { type: 'string' }, t: { type: 'string', enum: ['p'] } } } } } } },
    } } },
  };
  const after = structuredClone(before) as any;
  after.paths['/x'].requestBody = undefined;
  const req = after.paths['/x'].post.requestBody.content['application/json'].schema;
  req.required = ['a'];                      // request: newly required → breaking
  req.properties.s.enum = ['x'];             // request: enum narrowed → breaking
  const res = after.paths['/x'].post.responses[200].content['application/json'].schema;
  delete res.properties.b;                   // response: property removed → breaking
  res.properties.t.enum = ['p', 'q'];        // response: enum widened → breaking
  const r = diffSpecs(before, after);
  const byKind = (k: string) => r.changes.filter((c) => c.kind === k);
  assert.equal(byKind('property-added-required')[0]?.breaking, true);
  assert.equal(byKind('enum-value-removed')[0]?.breaking, true);   // request side
  assert.equal(byKind('property-removed')[0]?.breaking, true);     // response side
  assert.equal(byKind('enum-value-added')[0]?.breaking, true);     // response side
});

test('diff: identical documents produce no changes', () => {
  const r = diffSpecs(v1, structuredClone(v1));
  assert.deepEqual(r.changes, []);
  assert.equal(r.breaking, 0);
});

// --- response validation: undocumented status & envelopes -------------------

import { lookupResponseSchema } from '../src/index.js';

const envSpec = {
  openapi: '3.0.3',
  info: { title: 'Enveloped', version: '1' },
  servers: [{ url: 'http://api.example.com' }],
  paths: {
    '/items': {
      get: { operationId: 'items', responses: { 200: { description: 'ok', content: { 'application/json': {
        schema: { type: 'object', required: ['list'], properties: { list: { type: 'array', items: { type: 'string' } } } } } } } } },
      // NestJS answers 201 to a POST by default while @ApiOkResponse documents 200.
      post: { operationId: 'make', responses: { 200: { description: 'ok', content: { 'application/json': {
        schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } } } } },
    },
  },
};

test('lookupResponseSchema separates an undocumented status from a missing schema', () => {
  const documented = lookupResponseSchema(envSpec, 'GET', '/items', 200)!;
  assert.ok(documented.schema);

  const undoc = lookupResponseSchema(envSpec, 'POST', '/items', 201)!;
  assert.equal(undoc.schema, null);
  assert.equal((undoc as any).reason, 'undocumented_status');
  assert.deepEqual((undoc as any).documented, ['200']);

  const noSchema = lookupResponseSchema(
    { openapi: '3.0.3', info: {}, paths: { '/x': { get: { responses: { 200: { description: 'ok' } } } } } },
    'GET', '/x', 200,
  )!;
  assert.equal((noSchema as any).reason, 'no_schema');
});

async function tryIt(ludin: ReturnType<typeof createLudin>, body: Record<string, unknown>) {
  const res = await ludin.handle(req({
    method: 'POST', path: '/api/try', body: JSON.stringify(body),
    headers: { host: 'localhost:3000', 'x-requested-with': 'ludin' },
  }));
  return JSON.parse(String(res.body));
}

test('envelope: the documented schema is compared against the wrapped payload', async (t) => {
  const upstream = { success: true, message: 'ok', data: { list: ['a'] } };
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify(upstream), { status: 200, headers: { 'content-type': 'application/json' } }));

  // Without the envelope configured, the wrapper looks like a violation…
  const plain = createLudin({ spec: envSpec, auth: false });
  const bare = await tryIt(plain, { method: 'GET', url: 'http://api.example.com/items', op: { method: 'get', path: '/items' } });
  assert.equal(bare.validation.checked, true);
  assert.match(bare.validation.issues[0].message, /missing required property "list"/);

  // …and with it, the payload is validated and the noise is gone.
  const wrapped = createLudin({ spec: envSpec, auth: false, validate: { envelope: { dataPath: 'data' } } });
  const ok = await tryIt(wrapped, { method: 'GET', url: 'http://api.example.com/items', op: { method: 'get', path: '/items' } });
  assert.deepEqual(ok.validation.issues, []);
});

test('envelope: real drift inside the payload is still reported, with a data-scoped path', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ success: true, data: { list: [1, 2] } }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const ludin = createLudin({ spec: envSpec, auth: false, validate: { envelope: { dataPath: 'data' } } });
  const r = await tryIt(ludin, { method: 'GET', url: 'http://api.example.com/items', op: { method: 'get', path: '/items' } });
  assert.equal(r.validation.issues.length, 2);
  assert.equal(r.validation.issues[0].path, '$.data.list[0]');
  assert.match(r.validation.issues[0].message, /expected string, got number/);
});

test('envelope: an unwrapped response is still validated whole', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ list: ['a'] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const ludin = createLudin({ spec: envSpec, auth: false, validate: { envelope: { dataPath: 'data' } } });
  const r = await tryIt(ludin, { method: 'GET', url: 'http://api.example.com/items', op: { method: 'get', path: '/items' } });
  assert.deepEqual(r.validation.issues, []);   // matches the documented schema at the root
});

test('try: an undocumented status code is reported instead of silently skipped', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ success: true, data: { id: 'x' } }), { status: 201, headers: { 'content-type': 'application/json' } }));
  const ludin = createLudin({ spec: envSpec, auth: false, validate: { envelope: { dataPath: 'data' } } });
  const r = await tryIt(ludin, { method: 'POST', url: 'http://api.example.com/items', op: { method: 'post', path: '/items' } });
  assert.equal(r.validation.checked, false);
  assert.equal(r.validation.reason, 'undocumented_status');
  assert.equal(r.validation.status, 201);
  assert.deepEqual(r.validation.documented, ['200']);
});
