import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPostmanCollection, generateTypes, reachableSchemas,
  diffSpecs, toMarkdown, createLudin, buildSampleInput,
} from '../src/index.js';
import type { LudinRequest } from '../src/index.js';

/** v0.6: export to the tools you use (§3.13) and release notes from a diff (§3.9). */

const spec: any = {
  openapi: '3.1.0',
  info: { title: 'Pet API', version: '2.0', description: 'demo' },
  servers: [{ url: 'https://api.example.com/{stage}', variables: { stage: { default: 'v1' } } }],
  tags: [{ name: 'Pets', description: 'Pet things' }, { name: 'Internal' }],
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' }, key: { type: 'apiKey', in: 'header', name: 'X-Key' } },
    schemas: {
      Pet: {
        type: 'object',
        description: 'A pet.',
        required: ['id', 'name'],
        properties: {
          id: { type: 'integer' },
          name: { type: 'string', description: 'Display name' },
          status: { type: 'string', enum: ['available', 'sold'] },
          tag: { $ref: '#/components/schemas/Tag' },
          notes: { type: 'string', nullable: true },
          legacy: { type: 'string', deprecated: true },
        },
      },
      Tag: { type: 'object', properties: { label: { type: 'string' } } },
      SecretConfig: { type: 'object', properties: { rootToken: { type: 'string' } } },
      'Odd-Name': { type: 'string', enum: ['a', 'b'] },
    },
  },
  security: [{ bearer: [] }],
  paths: {
    '/pets/{petId}': {
      get: {
        operationId: 'getPet',
        summary: 'Fetch one pet',
        tags: ['Pets'],
        parameters: [
          { name: 'petId', in: 'path', required: true, schema: { type: 'integer', example: 7 } },
          { name: 'verbose', in: 'query', schema: { type: 'boolean' } },
          { name: 'X-Trace', in: 'header', required: true, schema: { type: 'string', example: 'abc' } },
        ],
        responses: {
          200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
          404: { description: 'missing' },
        },
      },
    },
    '/pets': {
      post: {
        operationId: 'createPet',
        summary: 'Create a pet',
        tags: ['Pets'],
        security: [{ key: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
        responses: { 201: { description: 'created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } },
      },
    },
    '/internal/flags': {
      get: {
        operationId: 'flags',
        tags: ['Internal'],
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/SecretConfig' } } } } },
      },
    },
  },
  webhooks: {
    petCreated: {
      post: {
        operationId: 'onPetCreated',
        tags: ['Pets'],
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Odd-Name' } } } },
        responses: { 200: { description: 'ack' } },
      },
    },
  },
};

// --- Postman ---------------------------------------------------------------

test('postman: folders follow tags, path params become variables, no secret in the file', () => {
  const c = buildPostmanCollection(spec);
  assert.equal(c.info.name, 'Pet API');

  const pets = c.item.find((i) => i.name === 'Pets')!;
  assert.equal(pets.description, 'Pet things');
  const get = pets.item!.find((i) => i.name === 'Fetch one pet')!.request!;
  assert.deepEqual(get.url.path, ['pets', ':petId']);
  assert.deepEqual(get.url.variable, [{ key: 'petId', value: '7' }]);
  assert.deepEqual(get.url.host, ['{{baseUrl}}']);

  // Required parameters only – an optional query param is not sent.
  assert.deepEqual(get.url.query, undefined);
  assert.deepEqual(get.header, [{ key: 'X-Trace', value: 'abc' }]);

  // Server variables are resolved into the baseUrl, credentials stay variables.
  assert.deepEqual(c.variable[0], { key: 'baseUrl', value: 'https://api.example.com/v1', type: 'string' });
  const raw = JSON.stringify(c);
  assert.ok(!/\$TOKEN|\$API_KEY/.test(raw), 'no sample credential literals');
  assert.deepEqual(c.auth, { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] });
  assert.ok(c.variable.some((v) => v.key === 'token' && v.value === ''));
});

test('postman: operation-level security overrides the document, body carries the example', () => {
  const c = buildPostmanCollection(spec);
  const post = c.item.find((i) => i.name === 'Pets')!.item!.find((i) => i.name === 'Create a pet')!.request!;
  assert.deepEqual(post.auth, {
    type: 'apikey',
    apikey: [{ key: 'key', value: 'X-Key', type: 'string' }, { key: 'value', value: '{{apiKey}}', type: 'string' }, { key: 'in', value: 'header', type: 'string' }],
  });
  assert.equal(post.body?.mode, 'raw');
  assert.equal(JSON.parse(post.body!.raw).name, 'string');
  assert.ok(post.header.some((h) => h.key === 'Content-Type' && h.value === 'application/json'));
  assert.ok(c.variable.some((v) => v.key === 'apiKey'));
});

test('postman: a relative server URL is resolved against the origin the route passes', () => {
  const relative: any = { ...spec, servers: [{ url: '/api' }] };
  // No origin (the CLI): the value stays as the document declared it.
  assert.equal(buildPostmanCollection(relative).variable[0].value, '/api');
  // The route passes the request's own origin.
  assert.equal(buildPostmanCollection(relative, 'https://docs.example.com').variable[0].value, 'https://docs.example.com/api');
  // An absolute server URL is never rewritten.
  assert.equal(buildPostmanCollection(spec, 'https://docs.example.com').variable[0].value, 'https://api.example.com/v1');
});

test('postman: webhooks are not requests, and empty tag folders are dropped', () => {
  const c = buildPostmanCollection(spec);
  const raw = JSON.stringify(c);
  assert.ok(!raw.includes('petCreated'), 'a webhook is a call you receive, not one you send');
  assert.ok(!c.item.some((i) => i.item!.length === 0));
});

test('postman: the collection describes the same request as the code samples', () => {
  const c = buildPostmanCollection(spec);
  const get = c.item.find((i) => i.name === 'Pets')!.item!.find((i) => i.name === 'Fetch one pet')!.request!;
  const sample = buildSampleInput(spec, 'GET', '/pets/{petId}')!;
  assert.ok(sample.url.endsWith('/pets/7'));
  assert.equal(get.url.variable![0].value, '7');
  assert.ok(sample.headers.some(([k, v]) => k === 'X-Trace' && v === 'abc'));
});

// --- TypeScript ------------------------------------------------------------

test('types: schemas become named types with optionality, enums, nullable and JSDoc', () => {
  const ts = generateTypes(spec);
  assert.match(ts, /export interface Pet \{/);
  assert.match(ts, /\/\*\* A pet\. \*\//);
  assert.match(ts, /id: number;/);
  assert.match(ts, /\/\*\* Display name \*\/\n\s+name: string;/);
  assert.match(ts, /status\?: "available" \| "sold";/);
  assert.match(ts, /tag\?: Tag;/);
  assert.match(ts, /notes\?: string \| null;/);
  assert.match(ts, /@deprecated/);
  // An invalid identifier is sanitised for the type name but kept for the ref.
  assert.match(ts, /export type Odd_Name = "a" \| "b";/);
});

test('types: operations carry parameters, body and responses – webhooks included', () => {
  const ts = generateTypes(spec);
  assert.match(ts, /getPet: \{/);
  assert.match(ts, /petId: number;/);
  assert.match(ts, /verbose\?: boolean;/);
  assert.match(ts, /requestBody: Pet;/);          // required body
  assert.match(ts, /"200": Pet;/);
  assert.match(ts, /"404": undefined;/);           // documented, no content
  assert.match(ts, /Webhook: the payload you will receive/);
  assert.match(ts, /onPetCreated: \{/);
});

test('types: only schemas reachable from visible operations are exported', () => {
  // The full document reaches SecretConfig through the internal operation.
  assert.ok(reachableSchemas(spec).has('SecretConfig'));

  // Filtered for a developer, that operation is gone – and so is its schema,
  // which would otherwise name a hidden operation's payload.
  const filtered = JSON.parse(JSON.stringify(spec));
  delete filtered.paths['/internal/flags'];
  const ts = generateTypes(filtered);
  assert.ok(!reachableSchemas(filtered).has('SecretConfig'));
  assert.ok(!ts.includes('SecretConfig'));
  assert.ok(!ts.includes('rootToken'));
  assert.ok(ts.includes('export interface Pet'));
});

test('types: a cyclic schema terminates instead of recursing forever', () => {
  const cyclic: any = {
    openapi: '3.0.3',
    info: { title: 'C', version: '1' },
    components: { schemas: { Node: { type: 'object', properties: { child: { $ref: '#/components/schemas/Node' } } } } },
    paths: { '/n': { get: { operationId: 'n', responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } } } } } },
  };
  const ts = generateTypes(cyclic);
  assert.match(ts, /child\?: Node;/);
});

// --- export routes ---------------------------------------------------------

function req(partial: Partial<LudinRequest>): LudinRequest {
  return { method: 'GET', path: '/', query: {}, headers: { host: 'localhost:3000' }, remoteAddress: '127.0.0.1', body: null, ...partial };
}

async function login(ludin: ReturnType<typeof createLudin>, email: string) {
  const res = await ludin.handle(req({
    method: 'POST', path: '/api/login', body: JSON.stringify({ email, password: 'pw' }),
    headers: { host: 'localhost:3000', 'x-requested-with': 'ludin' },
  }));
  const sc = res.headers['set-cookie'];
  return String(Array.isArray(sc) ? sc[0] : sc).split(';')[0];
}

test('export routes: role-filtered, audited, and closed to anonymous callers', async () => {
  const events: any[] = [];
  const ludin = createLudin({
    spec,
    auth: {
      users: [
        { email: 'd@x.io', password: 'pw', role: 'developer' },
        { email: 'a@x.io', password: 'pw', role: 'admin' },
      ],
      session: { secret: 'v06-secret' },
    },
    visibility: { 'tag:Internal': ['admin'] },
    audit: { sink: (e) => { events.push(e); } },
  });

  assert.equal((await ludin.handle(req({ path: '/api/export/postman' }))).status, 401);
  assert.equal((await ludin.handle(req({ path: '/api/export/types.d.ts' }))).status, 401);

  const dev = await login(ludin, 'd@x.io');
  const get = (path: string, cookie: string) => ludin.handle(req({ path, headers: { host: 'localhost:3000', cookie } }));

  const collection = await get('/api/export/postman', dev);
  assert.equal(collection.status, 200);
  assert.match(String(collection.headers['content-disposition']), /Pet-API\.postman_collection\.json/);
  const parsed = JSON.parse(String(collection.body));
  assert.ok(!JSON.stringify(parsed).includes('/internal/flags'), 'a hidden operation is not in the collection');

  const types = await get('/api/export/types.d.ts', dev);
  assert.equal(types.status, 200);
  assert.match(String(types.headers['content-disposition']), /Pet-API\.d\.ts/);
  assert.ok(!String(types.body).includes('SecretConfig'));

  // An admin sees the internal operation in both.
  const admin = await login(ludin, 'a@x.io');
  assert.ok(String((await get('/api/export/postman', admin)).body).includes('/internal/flags'));
  assert.ok(String((await get('/api/export/types.d.ts', admin)).body).includes('SecretConfig'));

  const exports = events.filter((e) => e.type === 'docs.export');
  assert.equal(exports.length, 4);
  assert.deepEqual(exports.map((e) => e.detail.format).sort(), ['postman', 'postman', 'types', 'types']);

  // POST is not how you fetch a file.
  assert.equal((await ludin.handle(req({
    method: 'POST', path: '/api/export/postman',
    headers: { host: 'localhost:3000', cookie: dev, 'x-requested-with': 'ludin' },
  }))).status, 405);
});

// --- release notes ---------------------------------------------------------

test('diff --markdown: breaking and compatible changes in separate sections', () => {
  const before: any = {
    openapi: '3.0.3', info: { title: 'T', version: '1.0' },
    paths: {
      '/pets': { get: { responses: { 200: { description: 'ok' } } }, delete: { responses: { 200: { description: 'ok' } } } },
    },
  };
  const after: any = {
    openapi: '3.0.3', info: { title: 'T', version: '2.0' },
    paths: {
      '/pets': {
        get: {
          parameters: [{ name: 'cursor', in: 'query', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'ok' } },
        },
      },
      '/tags': { get: { responses: { 200: { description: 'ok' } } } },
    },
  };
  const md = toMarkdown(diffSpecs(before, after));

  assert.match(md, /^## 1\.0 → 2\.0$/m);
  const breakingAt = md.indexOf('### Breaking changes');
  const otherAt = md.indexOf('### Other changes');
  assert.ok(breakingAt > -1 && otherAt > breakingAt, 'breaking changes come first');

  const breakingSection = md.slice(breakingAt, otherAt);
  assert.match(breakingSection, /DELETE \/pets/);
  assert.match(breakingSection, /cursor/);
  assert.ok(!breakingSection.includes('/tags'));
  assert.match(md.slice(otherAt), /\/tags/);
  assert.match(md, /_2 breaking · 1 compatible_/);
});

test('diff --markdown: no changes says so, and labels can be localized', () => {
  const doc: any = { openapi: '3.0.3', info: { title: 'T', version: '1' }, paths: {} };
  assert.match(toMarkdown(diffSpecs(doc, doc)), /No changes\./);

  const before: any = { openapi: '3.0.3', info: { title: 'T', version: '1' }, paths: { '/a': { get: { responses: {} } } } };
  const localized = toMarkdown(diffSpecs(before, doc), {
    breaking: '호환성 파괴',
    other: '그 외 변경',
    summary: (b, c) => `_파괴 ${b}건 · 호환 ${c}건_`,
  });
  assert.match(localized, /### 호환성 파괴/);
  assert.match(localized, /_파괴 1건 · 호환 0건_/);
});
