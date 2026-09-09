import { Auditor } from './audit.js';
import { createIpMatcher, isLocalhost, resolveClientIp } from './ip.js';
import { lintSpec } from './lint.js';
import { Lockout } from './lockout.js';
import { buildSampleInput, generateSamples } from './samples.js';
import { buildSearchIndex } from './search.js';
import { responseSchemaFor, validateAgainstSchema } from './validate.js';
import { verifyPassword, isHashed } from './password.js';
import { Readme, ReadmeError } from './readme.js';
import { RoleRegistry } from './roles.js';
import { SessionSigner, parseCookies, parseDuration, serializeCookie } from './session.js';
import { SpecLoader, applyVisibility, serverOrigins, toYaml } from './spec.js';
import { Directory } from './users.js';
import { UI_HTML } from './ui-bundle.js';
import type {
  AuthUser,
  Permission,
  LudinHandler,
  LudinOptions,
  LudinRequest,
  LudinResponse,
} from './types.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

interface Ctx {
  req: LudinRequest;
  ip: string;
  user: AuthUser | null;
  /** true when access is granted by IP (ipPolicy 'or') or auth is disabled */
  anonymous: boolean;
}

export function createLudin(options: LudinOptions): LudinHandler {
  if (!options || !options.spec) throw new Error('[ludin] `spec` is required.');

  const basePath = normalizeBase(options.basePath ?? '/docs');
  const authEnabled = options.auth !== false;
  const auth = options.auth === false ? undefined : options.auth ?? {};
  const directory = new Directory(auth?.users ?? []);
  const roles = new RoleRegistry(options.roles);
  const specs = new SpecLoader(options.spec);
  const readme = Readme.from(options.readme);
  const auditor = new Auditor(options.audit);
  const ttlSec = parseDuration(auth?.session?.ttl, 12 * 3600);
  const signer = new SessionSigner(auth?.session?.secret ?? process.env.LUDIN_SESSION_SECRET, ttlSec);
  const cookieName = auth?.session?.cookieName ?? 'ludin_session';
  const lockout = new Lockout(auth?.lockout?.attempts ?? 5, parseDuration(auth?.lockout?.window, 15 * 60) * 1000);
  const ipPolicy = options.ipPolicy ?? 'and';
  const allowLocalhost = options.allowLocalhost ?? true;
  const anonymousRole = options.ipAllowlistRole ?? 'developer';
  const ipRules = options.ipAllowlist ?? [];
  const ipMatcher = ipRules.length ? createIpMatcher(ipRules) : null;

  // Validate configured users early.
  if (authEnabled && !auth?.verify && (auth?.users?.length ?? 0) === 0) {
    console.warn('[ludin] auth is enabled but no users are configured – nobody will be able to log in.');
  }
  for (const u of auth?.users ?? []) {
    if (!isHashed(u.password)) {
      console.warn(`[ludin] User ${u.email} has a plain-text password. Prefer a hash: npx ludin hash`);
    }
    if (u.role && !roles.exists(u.role)) throw new Error(`[ludin] Unknown role "${u.role}" for ${u.email}`);
  }
  for (const role of readme?.visibleTo ?? []) {
    if (!roles.exists(role)) throw new Error(`[ludin] Unknown role "${role}" in readme.visibleTo`);
  }

  // -------------------------------------------------------------------------
  async function handle(req: LudinRequest): Promise<LudinResponse> {
    const ip = resolveClientIp(req.remoteAddress, req.headers, options.trustProxy);
    try {
      // 1. Global IP check ---------------------------------------------------
      const bypass = process.env.LUDIN_BYPASS_IP_CHECK === '1' || (allowLocalhost && isLocalhost(ip));
      const ipMatched = ipMatcher ? ipMatcher(ip) : true;
      if (ipMatcher && !ipMatched && !bypass) {
        await auditor.emit({ type: 'ip.blocked', ip, user: null, detail: { path: req.path } });
        throw new HttpError(options.hideOnBlock ? 404 : 403, options.hideOnBlock ? 'Not Found' : 'Your IP address is not allowed.', 'ip_blocked');
      }

      // 2. Identity -----------------------------------------------------------
      const cookies = parseCookies(req.headers['cookie']);
      const session = authEnabled ? signer.verify(cookies[cookieName]) : null;
      let user: AuthUser | null = session
        ? { id: session.sub, email: session.email, role: session.role, name: session.name, ipAllowlist: session.ipAllowlist }
        : null;

      let anonymous = false;
      if (!user && (!authEnabled || (ipPolicy === 'or' && ipMatcher && ipMatched))) {
        user = { id: 'anonymous', email: 'anonymous', role: anonymousRole };
        anonymous = true;
      }
      // Per-user IP restriction
      if (user && !anonymous && user.ipAllowlist?.length && !bypass) {
        if (!createIpMatcher(user.ipAllowlist)(ip)) {
          await auditor.emit({ type: 'ip.blocked', ip, user: pick(user), detail: { path: req.path, scope: 'user' } });
          throw new HttpError(403, 'Your IP address is not allowed for this account.', 'ip_blocked');
        }
      }
      const ctx: Ctx = { req, ip, user, anonymous };

      // 3. Routing ------------------------------------------------------------
      const path = req.path.replace(/\/+$/, '') || '/';
      if (path.startsWith('/api/')) return await api(ctx, path);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method Not Allowed');
      if (path === '/readme') return await readmePage(ctx);
      return html(ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        const wantsJson = req.path.startsWith('/api/') || (req.headers['accept'] ?? '').toString().includes('application/json');
        if (wantsJson) return json(err.status, { error: err.message, code: err.code });
        return { status: err.status, headers: { 'content-type': 'text/html; charset=utf-8' }, body: errorPage(err) };
      }
      console.error('[ludin] unhandled error', err);
      return json(500, { error: 'Internal error' });
    }
  }

  // -------------------------------------------------------------------------
  function html(ctx: Ctx): LudinResponse {
    const boot = {
      basePath,
      authEnabled,
      theme: options.theme ?? {},
      readme: readme ? { label: readme.label, url: `${basePath === '/' ? '' : basePath}/readme` } : null,
      version: '0.2.0',
    };
    const page = UI_HTML.replace(
      '<!--LUDIN_CONFIG-->',
      `<script>window.__LUDIN__=${JSON.stringify(boot).replace(/</g, '\\u003c')}</script>`,
    );
    return {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
      },
      body: page,
    };
  }

  /**
   * The configured HTML page, served untouched. The docs UI frames it, so it
   * goes out sandboxed: its scripts run in an opaque origin where they can
   * neither read the session cookie nor reach into the docs DOM.
   */
  async function readmePage(ctx: Ctx): Promise<LudinResponse> {
    if (!readme) throw new HttpError(404, 'No readme page is configured.', 'not_found');
    require(ctx, 'docs:read');
    if (!readme.visibleFor(ctx.user!.role)) throw new HttpError(403, 'This page is not available for your role.', 'forbidden');
    let body: string;
    try {
      body = await readme.html();
    } catch (err) {
      if (err instanceof ReadmeError) {
        console.error(`[ludin] ${err.message}`);
        throw new HttpError(404, 'The readme page is unavailable.', 'readme_unavailable');
      }
      throw err;
    }
    await auditor.emit({ type: 'docs.readme', ip: ctx.ip, user: pick(ctx.user) });
    return {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // Opaque origin: no cookie, no storage, no access to the parent page.
        'content-security-policy': 'sandbox allow-scripts allow-popups allow-forms allow-modals',
        'x-frame-options': 'SAMEORIGIN',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      },
      body,
    };
  }

  // -------------------------------------------------------------------------
  async function api(ctx: Ctx, path: string): Promise<LudinResponse> {
    const { req } = ctx;
    const isMutation = req.method !== 'GET' && req.method !== 'HEAD';
    if (isMutation && req.headers['x-requested-with'] !== 'ludin') {
      throw new HttpError(403, 'Missing X-Requested-With header', 'csrf');
    }

    // Public (pre-login) routes ------------------------------------------------
    switch (path) {
      case '/api/me':
        return json(200, me(ctx));
      case '/api/login':
        return login(ctx);
      case '/api/logout':
        return logout(ctx);
    }

    // Authenticated routes -----------------------------------------------------
    switch (path) {
      case '/api/specs':
        require(ctx, 'docs:read');
        return json(200, { specs: specs.listFor(ctx.user!.role) });
      case '/api/spec': {
        require(ctx, 'docs:read');
        const visible = await visibleSpec(ctx);
        await auditor.emit({ type: 'docs.view', ip: ctx.ip, user: pick(ctx.user), detail: { spec: visible.name } });
        return json(200, visible.doc);
      }
      case '/api/spec.json':
      case '/api/spec.yaml':
        require(ctx, 'docs:read');
        return exportSpec(ctx, path.endsWith('.yaml') ? 'yaml' : 'json');
      case '/api/try':
        require(ctx, 'docs:try');
        return tryProxy(ctx);
      case '/api/samples':
        require(ctx, 'docs:read');
        return samplesRoute(ctx);
      case '/api/search-index': {
        require(ctx, 'docs:read');
        requireMethod(ctx, 'GET');
        const { doc } = await visibleSpec(ctx);
        return json(200, { index: buildSearchIndex(doc) });
      }
      case '/api/lint': {
        require(ctx, 'docs:read');
        requireMethod(ctx, 'GET');
        const { name, doc } = await visibleSpec(ctx);
        const result = lintSpec(doc);
        return json(200, { spec: name, ...result, issues: result.issues.slice(0, 200) });
      }
      case '/api/admin':
        require(ctx, 'admin:read');
        return admin(ctx);
    }
    throw new HttpError(404, 'Not Found');
  }

  /**
   * Code samples for one operation, generated from the role-filtered document:
   * an operation the caller may not see yields a 404, never a sample.
   */
  async function samplesRoute(ctx: Ctx): Promise<LudinResponse> {
    requireMethod(ctx, 'GET');
    const { method, path: opPath, server } = ctx.req.query;
    if (!method || !opPath) throw new HttpError(400, 'method and path are required');
    const { doc } = await visibleSpec(ctx);
    if (server && !serverOrigins(doc).some((o) => server.startsWith(o)) && !doc.servers?.some((s: any) => s?.url === server)) {
      throw new HttpError(400, 'Unknown server');
    }
    const input = buildSampleInput(doc, method, opPath, server);
    if (!input) throw new HttpError(404, 'Operation not found');
    return json(200, { request: { method: input.method, url: input.url }, samples: generateSamples(input) });
  }

  /** Loads the requested spec, already filtered for the caller's role. */
  async function visibleSpec(ctx: Ctx): Promise<{ name: string; doc: Record<string, any> }> {
    const name = ctx.req.query.name || specs.entries[0].name;
    if (!specs.listFor(ctx.user!.role).some((s) => s.name === name)) throw new HttpError(404, 'Spec not found');
    const doc = await specs.load(name);
    if (!doc) throw new HttpError(404, 'Spec not found');
    return { name, doc: applyVisibility(doc, options.visibility, ctx.user!.role) };
  }

  /**
   * Hand the document out as a file. It goes through the same visibility filter
   * as the rendered docs, so what a customer downloads is exactly what they are
   * allowed to see – and the download is audited.
   */
  async function exportSpec(ctx: Ctx, format: 'json' | 'yaml'): Promise<LudinResponse> {
    requireMethod(ctx, 'GET');
    const { name, doc } = await visibleSpec(ctx);
    await auditor.emit({ type: 'docs.export', ip: ctx.ip, user: pick(ctx.user), detail: { spec: name, format } });
    const base = String(doc.info?.title ?? name).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60) || 'openapi';
    return {
      status: 200,
      headers: {
        'content-type': format === 'json' ? 'application/json; charset=utf-8' : 'application/yaml; charset=utf-8',
        'content-disposition': `attachment; filename="${base}.${format}"`,
        'cache-control': 'no-store',
      },
      body: format === 'json' ? JSON.stringify(doc, null, 2) : toYaml(doc),
    };
  }

  function require(ctx: Ctx, perm: Permission) {
    if (!ctx.user) throw new HttpError(401, 'Login required', 'unauthenticated');
    if (!roles.has(ctx.user.role, perm)) throw new HttpError(403, `Missing permission: ${perm}`, 'forbidden');
  }

  function requireMethod(ctx: Ctx, ...methods: string[]) {
    if (!methods.includes(ctx.req.method)) throw new HttpError(405, 'Method Not Allowed');
  }

  function me(ctx: Ctx) {
    return {
      authenticated: !!ctx.user,
      anonymous: ctx.anonymous,
      user: ctx.user ? { email: ctx.user.email, name: ctx.user.name, role: ctx.user.role } : null,
      permissions: ctx.user ? roles.permissions(ctx.user.role) : [],
      readme: readme && ctx.user && readme.visibleFor(ctx.user.role) ? { label: readme.label } : null,
      authEnabled,
    };
  }

  // -- auth ------------------------------------------------------------------
  function startSession(ctx: Ctx, user: AuthUser): LudinResponse {
    const { token, exp } = signer.issue(user);
    const res = json(200, me({ ...ctx, user, anonymous: false }));
    res.headers['set-cookie'] = serializeCookie(cookieName, token, {
      path: basePath,
      secure: isSecure(ctx.req),
      maxAge: exp - Math.floor(Date.now() / 1000),
    });
    return res;
  }

  async function login(ctx: Ctx): Promise<LudinResponse> {
    if (!authEnabled) throw new HttpError(400, 'Authentication is disabled');
    requireMethod(ctx, 'POST');
    const body = parseJson(ctx.req.body) as { email?: string; password?: string };
    const email = (body.email ?? '').trim();
    const password = body.password ?? '';
    if (!email || !password) throw new HttpError(400, 'Email and password are required');

    const locked = lockout.check(ctx.ip, email);
    if (locked) throw new HttpError(429, `Too many attempts. Try again in ${locked}s.`, 'locked');

    let user: AuthUser | null = null;
    if (auth?.verify) {
      user = await auth.verify(email, password);
    } else {
      const found = directory.findByEmail(email);
      if (found && found.passwordHash && (await verifyPassword(password, found.passwordHash))) {
        user = { id: found.id, email: found.email, role: found.role, name: found.name, ipAllowlist: found.ipAllowlist };
      }
    }

    if (!user) {
      lockout.fail(ctx.ip, email);
      await auditor.emit({ type: 'login.failure', ip: ctx.ip, user: null, detail: { email } });
      throw new HttpError(401, 'Invalid email or password', 'bad_credentials');
    }
    if (!roles.exists(user.role)) throw new HttpError(500, `Unknown role "${user.role}"`);
    if (user.ipAllowlist?.length && !createIpMatcher(user.ipAllowlist)(ctx.ip) && !(allowLocalhost && isLocalhost(ctx.ip))) {
      await auditor.emit({ type: 'ip.blocked', ip: ctx.ip, user: pick(user), detail: { scope: 'user', stage: 'login' } });
      throw new HttpError(403, 'Your IP address is not allowed for this account.', 'ip_blocked');
    }

    lockout.reset(ctx.ip, email);
    await auditor.emit({ type: 'login.success', ip: ctx.ip, user: pick(user) });
    return startSession(ctx, user);
  }

  async function logout(ctx: Ctx): Promise<LudinResponse> {
    requireMethod(ctx, 'POST');
    if (ctx.user && !ctx.anonymous) await auditor.emit({ type: 'logout', ip: ctx.ip, user: pick(ctx.user) });
    const res = json(200, { ok: true });
    res.headers['set-cookie'] = serializeCookie(cookieName, '', { path: basePath, secure: isSecure(ctx.req), maxAge: 0, expires: new Date(0) });
    return res;
  }

  // -- admin -----------------------------------------------------------------
  /**
   * A read-only view of what this deployment is configured with. Accounts, IP
   * rules and roles live in your code, so this screen explains them; changing
   * them is a redeploy, never a click.
   */
  async function admin(ctx: Ctx): Promise<LudinResponse> {
    requireMethod(ctx, 'GET');
    const users = directory.list().map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      ipAllowlist: u.ipAllowlist ?? [],
      hashed: isHashed(u.passwordHash),
    }));
    return json(200, {
      users,
      customVerifier: !!auth?.verify,
      ipRules,
      ipPolicy,
      allowLocalhost,
      trustProxy: options.trustProxy ?? false,
      roles: roles.names().map((name) => ({ name, permissions: roles.permissions(name) })),
      visibility: options.visibility ?? {},
      readme: readme ? { label: readme.label, path: readme.path, visibleTo: readme.visibleTo ?? [] } : null,
      audit: { sink: options.audit?.sink === false ? 'disabled' : options.audit?.sink ? 'custom' : 'stdout' },
    });
  }

  // -------------------------------------------------------------------------
  async function tryProxy(ctx: Ctx): Promise<LudinResponse> {
    requireMethod(ctx, 'POST');
    const body = parseJson(ctx.req.body) as {
      method?: string;
      url?: string;
      headers?: Record<string, string>;
      body?: string | null;
      spec?: string;
      /** The documented operation behind this call – enables response validation. */
      op?: { method?: string; path?: string };
    };
    if (!body.url || !body.method) throw new HttpError(400, 'method and url are required');

    // Resolve relative URLs against the incoming host.
    const selfOrigin = requestOrigin(ctx.req);
    const target = new URL(body.url, selfOrigin);

    // Only allow origins from the spec's servers, explicit allowedTargets, or ourselves.
    const specName = body.spec || specs.entries[0].name;
    const doc = await specs.load(specName);
    const allowed = new Set([selfOrigin, ...(doc ? serverOrigins(doc) : []), ...(options.allowedTargets ?? [])]);
    if (!allowed.has(target.origin)) {
      throw new HttpError(403, `Target origin ${target.origin} is not allowed. Add it to allowedTargets.`, 'target_not_allowed');
    }
    // Never let the proxy call ludin itself.
    if (target.origin === selfOrigin && target.pathname.startsWith(basePath)) {
      throw new HttpError(400, 'Cannot proxy to ludin itself');
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.headers ?? {})) {
      if (!/^(host|content-length|connection|cookie)$/i.test(k) && typeof v === 'string') headers[k] = v;
    }
    headers['x-forwarded-for'] = ctx.ip;
    headers['x-ludin-user'] = ctx.user!.email;

    const started = Date.now();
    const method = body.method.toUpperCase();
    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : body.body ?? undefined,
        redirect: 'manual',
      });
    } catch (err) {
      await auditor.emit({
        type: 'docs.try',
        ip: ctx.ip,
        user: pick(ctx.user),
        detail: { method, url: target.toString(), error: String(err), ms: Date.now() - started },
      });
      return json(200, { status: 0, error: `Request failed: ${(err as Error).message}`, ms: Date.now() - started });
    }
    const resHeaders: Record<string, string> = {};
    upstream.headers.forEach((v, k) => (resHeaders[k] = v));
    const buf = Buffer.from(await upstream.arrayBuffer());
    const ms = Date.now() - started;
    const isText = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|problem\+json))/i.test(
      resHeaders['content-type'] ?? '',
    );

    await auditor.emit({
      type: 'docs.try',
      ip: ctx.ip,
      user: pick(ctx.user),
      detail: {
        method,
        url: target.toString(),
        status: upstream.status,
        ms,
        requestHeaders: auditor.maskObject(headers),
        ...(auditor.recordBodies
          ? { requestBody: body.body ?? null, responseBody: isText ? buf.toString('utf8').slice(0, 10_000) : `<${buf.length} bytes>` }
          : {}),
      },
    });

    return json(200, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: resHeaders,
      ms,
      size: buf.length,
      body: isText ? buf.toString('utf8') : null,
      bodyBase64: isText ? null : buf.toString('base64'),
      validation: validateTryResponse(ctx, doc, body.op, upstream.status, resHeaders['content-type'], isText ? buf.toString('utf8') : null),
    });
  }

  /**
   * Compare a Try-it-out response with the documented schema. Validation runs
   * against the role-filtered document, so an operation hidden from the caller
   * is simply "unchecked" – it never leaks that a schema exists.
   */
  function validateTryResponse(
    ctx: Ctx,
    doc: Record<string, any> | null,
    op: { method?: string; path?: string } | undefined,
    status: number,
    contentType: string | undefined,
    text: string | null,
  ): { checked: boolean; reason?: string; issues?: Array<{ path: string; message: string }> } {
    if (!doc || !op?.method || !op.path) return { checked: false, reason: 'no_operation' };
    if (text == null || !/json/i.test(contentType ?? '')) return { checked: false, reason: 'not_json' };
    const filtered = applyVisibility(doc, options.visibility, ctx.user!.role);
    const schema = responseSchemaFor(filtered, op.method, op.path, status);
    if (!schema) return { checked: false, reason: 'no_schema' };
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { checked: false, reason: 'invalid_json' };
    }
    return { checked: true, issues: validateAgainstSchema(filtered, schema, value) };
  }

  return { handle, options };
}

// ---------------------------------------------------------------------------
function json(status: number, data: unknown): LudinResponse {
  return { status, headers: { ...JSON_HEADERS }, body: JSON.stringify(data) };
}

function parseJson(body: LudinRequest['body']): unknown {
  if (body == null || body === '') return {};
  try {
    return JSON.parse(typeof body === 'string' ? body : body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function pick(u: AuthUser | null) {
  return u ? { email: u.email, role: u.role } : null;
}

function normalizeBase(p: string): string {
  if (!p.startsWith('/')) p = '/' + p;
  return p.replace(/\/+$/, '') || '/';
}

function isSecure(req: LudinRequest): boolean {
  const xfp = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(xfp) ? xfp[0] : xfp) ?? req.protocol;
  return proto === 'https';
}

function requestOrigin(req: LudinRequest): string {
  const xfh = req.headers['x-forwarded-host'];
  const host = (Array.isArray(xfh) ? xfh[0] : xfh) ?? (req.headers['host'] as string) ?? 'localhost';
  return `${isSecure(req) ? 'https' : 'http'}://${host}`;
}

function errorPage(err: HttpError): string {
  return `<!doctype html><meta charset="utf-8"><title>${err.status}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#0f1115;color:#e6e8ee}
main{text-align:center}h1{font-size:64px;margin:0 0 8px;font-weight:600}p{opacity:.7}</style>
<main><h1>${err.status}</h1><p>${escapeHtml(err.message)}</p></main>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
