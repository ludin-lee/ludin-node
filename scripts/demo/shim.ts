/**
 * The demo's "server", running inside the page.
 *
 * The real docs UI is compiled into one HTML file and talks to `/docs/api/*`.
 * For a static demo (GitHub Pages, an artifact) there is no Node process to
 * answer, so this shim patches `fetch` and answers those calls itself, using
 * the same pure core modules the real handler uses – visibility filtering,
 * code samples, search index, lint, diff, exports, response validation. Only
 * the parts that need a server are simulated: the session lives in
 * sessionStorage, passwords are compared in plain text, and Try it out is
 * served by an in-page petstore instead of a proxied upstream.
 *
 * Nothing here is a security boundary. It is a demo of what the product looks
 * like, kept faithful by reusing its code.
 */
import { applyVisibility, serverOrigins, toYaml } from '../../packages/core/src/spec.js';
import { buildSampleInput, generateSamples } from '../../packages/core/src/samples.js';
import { buildSearchIndex } from '../../packages/core/src/search.js';
import { lintSpec } from '../../packages/core/src/lint.js';
import { diffSpecs } from '../../packages/core/src/diff.js';
import { buildPostmanCollection, generateTypes } from '../../packages/core/src/export.js';
import { lookupResponseSchema, validateAgainstSchema } from '../../packages/core/src/validate.js';
import { RoleRegistry } from '../../packages/core/src/roles.js';
import { petstore, petstoreV1 } from '../../examples/express/src/petstore.js';

const BASE = '/docs';
const SPEC_NAME = 'Petstore';
const VISIBILITY = { 'tag:Admin': ['admin'] };
const USERS = [
  { id: 'admin', email: 'admin@example.com', password: 'admin', role: 'admin', name: 'Admin' },
  { id: 'dev', email: 'dev@example.com', password: 'dev', role: 'developer', name: 'Dev' },
  { id: 'viewer', email: 'viewer@example.com', password: 'viewer', role: 'viewer', name: undefined as string | undefined },
];
const roles = new RoleRegistry();
const SESSION_KEY = 'ludin-demo.session';

type User = { id: string; email: string; role: string; name?: string };
type Res = { status: number; headers?: Record<string, string>; body: string };

class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
const json = (status: number, data: unknown): Res => ({ status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(data) });

function session(): User | null {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}
function setSession(u: User | null) {
  try { u ? sessionStorage.setItem(SESSION_KEY, JSON.stringify(u)) : sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}
function require(user: User | null, perm: string) {
  if (!user) throw new HttpError(401, 'Login required', 'unauthenticated');
  if (!roles.has(user.role, perm as any)) throw new HttpError(403, `Missing permission: ${perm}`, 'forbidden');
}
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
function visibleDoc(user: User) {
  return applyVisibility(clone(petstore), VISIBILITY, user.role);
}
function me(user: User | null) {
  return {
    authenticated: !!user,
    anonymous: false,
    user: user ? { email: user.email, name: user.name, role: user.role } : null,
    permissions: user ? roles.permissions(user.role) : [],
    readme: null,
    share: null,
    shareEnabled: false,
    authEnabled: true,
  };
}

/* ---------------- the in-page petstore: what the proxy would call ---------------- */
const pets: Array<{ id: number; name: string; tag?: string }> = [
  { id: 1, name: 'Mochi', tag: 'cat' },
  { id: 2, name: 'Bori', tag: 'dog' },
];
function upstream(method: string, url: URL, headers: Record<string, string>, body: string | null): { status: number; headers: Record<string, string>; body: string | null } {
  const j = (status: number, data: unknown) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', 'x-powered-by': 'petstore-demo' }, body: JSON.stringify(data) });
  const p = url.pathname;
  const m = method.toUpperCase();
  if (m === 'GET' && p === '/api/pets') return j(200, pets.slice(0, Number(url.searchParams.get('limit')) || 100));
  if (m === 'POST' && p === '/api/pets') {
    let parsed: any = {};
    try { parsed = body ? JSON.parse(body) : {}; } catch { return j(400, { code: 400, message: 'invalid JSON' }); }
    const pet = { id: pets.length + 1, ...parsed };
    pets.push(pet);
    return j(201, pet);
  }
  const one = p.match(/^\/api\/pets\/(\d+)$/);
  if (one && m === 'GET') {
    const pet = pets.find((x) => x.id === Number(one[1]));
    return pet ? j(200, pet) : j(404, { code: 404, message: 'not found' });
  }
  if (one && m === 'DELETE') return { status: 204, headers: { 'x-powered-by': 'petstore-demo' }, body: null };
  if (m === 'POST' && p === '/api/admin/reset') { pets.splice(2); return j(200, { ok: true }); }
  if (m === 'GET' && p === '/api/secure/me') {
    return headers['authorization'] === 'Bearer letmein' ? j(200, { user: 'demo', via: headers['x-ludin-user'] }) : j(401, { message: 'bad token' });
  }
  return j(404, { code: 404, message: `no route for ${m} ${p}` });
}

function validate(doc: any, op: { method?: string; path?: string } | undefined, status: number, contentType: string | undefined, text: string | null) {
  if (!op?.method || !op.path) return { checked: false, reason: 'no_operation' };
  if (text == null || !/json/i.test(contentType ?? '')) return { checked: false, reason: 'not_json' };
  const found = lookupResponseSchema(doc, op.method, op.path, status);
  if (!found) return { checked: false, reason: 'no_operation' };
  if ('reason' in found) {
    return found.reason === 'undocumented_status'
      ? { checked: false, reason: 'undocumented_status', documented: (found as any).documented, status }
      : { checked: false, reason: 'no_schema' };
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { checked: false, reason: 'invalid_json' }; }
  return { checked: true, issues: validateAgainstSchema(doc, (found as any).schema, value) };
}

/* ---------------- routes, mirroring packages/core/src/handler.ts ---------------- */
async function api(method: string, path: string, query: URLSearchParams, headers: Record<string, string>, body: string | null): Promise<Res> {
  const user = session();
  const isMutation = method !== 'GET' && method !== 'HEAD';
  if (isMutation && headers['x-requested-with'] !== 'ludin') throw new HttpError(403, 'Missing X-Requested-With header', 'csrf');
  const parse = () => { try { return body ? JSON.parse(body) : {}; } catch { throw new HttpError(400, 'Invalid JSON body'); } };

  switch (path) {
    case '/api/me':
      return json(200, me(user));
    case '/api/login': {
      const { email, password } = parse();
      const u = USERS.find((x) => x.email === String(email ?? '').trim().toLowerCase());
      if (!u || u.password !== password) throw new HttpError(401, 'Invalid email or password', 'bad_credentials');
      const s: User = { id: u.id, email: u.email, role: u.role, name: u.name };
      setSession(s);
      return json(200, me(s));
    }
    case '/api/logout':
      setSession(null);
      return json(200, { ok: true });
  }

  switch (path) {
    case '/api/specs':
      require(user, 'docs:read');
      return json(200, { specs: [{ name: SPEC_NAME, hasBaseline: true }] });
    case '/api/spec':
      require(user, 'docs:read');
      return json(200, visibleDoc(user!));
    case '/api/spec.json':
      require(user, 'docs:read');
      return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(visibleDoc(user!), null, 2) };
    case '/api/spec.yaml':
      require(user, 'docs:read');
      return { status: 200, headers: { 'content-type': 'application/yaml; charset=utf-8' }, body: toYaml(visibleDoc(user!)) };
    case '/api/export/postman':
      require(user, 'docs:read');
      return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(buildPostmanCollection(visibleDoc(user!), location.origin), null, 2) };
    case '/api/export/types.d.ts':
      require(user, 'docs:read');
      return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: generateTypes(visibleDoc(user!)) };
    case '/api/samples': {
      require(user, 'docs:read');
      const m = query.get('method'), p = query.get('path'), server = query.get('server') ?? undefined;
      if (!m || !p) throw new HttpError(400, 'method and path are required');
      const doc = visibleDoc(user!);
      const input = buildSampleInput(doc, m, p, server);
      if (!input) throw new HttpError(404, 'Operation not found');
      return json(200, { request: { method: input.method, url: input.url }, samples: generateSamples(input) });
    }
    case '/api/search-index':
      require(user, 'docs:read');
      return json(200, { index: buildSearchIndex(visibleDoc(user!)) });
    case '/api/diff': {
      require(user, 'docs:read');
      const baseline = applyVisibility(clone(petstoreV1), VISIBILITY, user!.role);
      return json(200, { spec: SPEC_NAME, ...diffSpecs(baseline, visibleDoc(user!)) });
    }
    case '/api/lint': {
      require(user, 'docs:read');
      const result = lintSpec(visibleDoc(user!));
      return json(200, { spec: SPEC_NAME, ...result, issues: result.issues.slice(0, 200) });
    }
    case '/api/try': {
      require(user, 'docs:try');
      const b = parse() as { method?: string; url?: string; headers?: Record<string, string>; body?: string | null; op?: { method?: string; path?: string } };
      if (!b.url || !b.method) throw new HttpError(400, 'method and url are required');
      const doc = visibleDoc(user!);
      // Resolve against the page itself so this also works from a file:// open (origin "null").
      const target = new URL(b.url, location.href);
      const allowed = new Set([location.origin, ...serverOrigins(doc)]);
      if (!allowed.has(target.origin)) throw new HttpError(403, `Target origin ${target.origin} is not allowed. Add it to allowedTargets.`, 'target_not_allowed');
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(b.headers ?? {})) if (!/^(host|content-length|connection|cookie)$/i.test(k)) h[k.toLowerCase()] = v;
      h['x-ludin-user'] = user!.email;
      const started = performance.now();
      const up = upstream(b.method, target, h, b.body ?? null);
      await new Promise((r) => setTimeout(r, 40 + Math.random() * 80));
      const ms = Math.round(performance.now() - started);
      const text = up.body;
      return json(200, {
        status: up.status,
        statusText: up.status === 204 ? 'No Content' : up.status === 201 ? 'Created' : up.status >= 400 ? 'Error' : 'OK',
        headers: { ...up.headers, ...(text != null ? { 'content-length': String(new TextEncoder().encode(text).length) } : {}) },
        cookies: [],
        ms,
        size: text ? new TextEncoder().encode(text).length : 0,
        body: text,
        bodyBase64: null,
        validation: validate(doc, b.op, up.status, up.headers['content-type'], text),
      });
    }
    case '/api/admin':
      require(user, 'admin:read');
      return json(200, {
        users: USERS.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, ipAllowlist: [], hashed: false })),
        customVerifier: false,
        ipRules: [],
        ipPolicy: 'and',
        allowLocalhost: true,
        trustProxy: false,
        roles: roles.names().map((name) => ({ name, permissions: roles.permissions(name) })),
        visibility: VISIBILITY,
        readme: null,
        audit: { sink: 'stdout' },
      });
    case '/api/share':
      require(user, 'admin:read');
      throw new HttpError(400, 'Share links are not enabled in this demo.', 'share_disabled');
  }
  throw new HttpError(404, 'Not Found');
}

/* ---------------- fetch patch ---------------- */
const realFetch = window.fetch.bind(window);
window.fetch = async function demoFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith(`${BASE}/api/`)) return realFetch(input, init);
  const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
  const headers: Record<string, string> = {};
  new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined)).forEach((v, k) => (headers[k.toLowerCase()] = v));
  const body = typeof init?.body === 'string' ? init.body : null;
  const path = url.pathname.slice(BASE.length);
  let res: Res;
  try {
    res = await api(method, path, url.searchParams, headers, body);
  } catch (err) {
    if (err instanceof HttpError) res = json(err.status, { error: err.message, code: err.code });
    else { console.error('[ludin demo]', err); res = json(500, { error: 'Internal error' }); }
  }
  return new Response(res.body, { status: res.status, headers: res.headers });
};
