import { Auditor } from './audit.js';
import { createIpMatcher, isLocalhost, resolveClientIp } from './ip.js';
import { Lockout } from './lockout.js';
import { verifyPassword, isHashed } from './password.js';
import { RoleRegistry } from './roles.js';
import { SessionSigner, parseCookies, parseDuration, serializeCookie } from './session.js';
import { SpecLoader, applyVisibility, serverOrigins } from './spec.js';
import { createBindingStore } from './store.js';
import { UI_HTML } from './ui-bundle.js';
import type {
  AuthUser,
  Permission,
  RudinHandler,
  RudinOptions,
  RudinRequest,
  RudinResponse,
  RudinStore,
} from './types.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

interface Ctx {
  req: RudinRequest;
  ip: string;
  user: AuthUser | null;
  /** true when access is granted by IP (ipPolicy 'or') or auth is disabled */
  anonymous: boolean;
}

export function createRudin(options: RudinOptions): RudinHandler {
  if (!options || !options.spec) throw new Error('[rudin] `spec` is required.');

  const basePath = normalizeBase(options.basePath ?? '/docs');
  const authEnabled = options.auth !== false;
  const auth = options.auth === false ? undefined : options.auth ?? {};
  const store: RudinStore = options.store ?? createBindingStore(auth?.users ?? [], options.ipAllowlist ?? []);
  const roles = new RoleRegistry(options.roles);
  const specs = new SpecLoader(options.spec);
  const auditor = new Auditor(options.audit, options.store);
  const signer = new SessionSigner(
    auth?.session?.secret ?? process.env.RUDIN_SESSION_SECRET,
    parseDuration(auth?.session?.ttl, 12 * 3600),
  );
  const cookieName = auth?.session?.cookieName ?? 'rudin_session';
  const lockout = new Lockout(auth?.lockout?.attempts ?? 5, parseDuration(auth?.lockout?.window, 15 * 60) * 1000);
  const ipPolicy = options.ipPolicy ?? 'and';
  const allowLocalhost = options.allowLocalhost ?? true;
  const anonymousRole = options.ipAllowlistRole ?? 'developer';

  // Validate bound users early.
  if (authEnabled && !auth?.verify && (auth?.users?.length ?? 0) === 0 && !options.store) {
    console.warn('[rudin] auth is enabled but no users are configured – nobody will be able to log in.');
  }
  for (const u of auth?.users ?? []) {
    if (!isHashed(u.password)) {
      console.warn(`[rudin] User ${u.email} has a plain-text password. Prefer a hash: npx rudin hash`);
    }
    if (u.role && !roles.exists(u.role)) throw new Error(`[rudin] Unknown role "${u.role}" for ${u.email}`);
  }

  async function globalIpMatcher() {
    const rules = (await store.ipRules.list()).map((r) => r.cidr);
    return rules.length ? createIpMatcher(rules) : null;
  }

  // -------------------------------------------------------------------------
  async function handle(req: RudinRequest): Promise<RudinResponse> {
    const ip = resolveClientIp(req.remoteAddress, req.headers, options.trustProxy);
    try {
      // 1. Global IP check ---------------------------------------------------
      const matcher = await globalIpMatcher();
      const bypass = process.env.RUDIN_BYPASS_IP_CHECK === '1' || (allowLocalhost && isLocalhost(ip));
      const ipMatched = matcher ? matcher(ip) : true;
      if (matcher && !ipMatched && !bypass) {
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
      if (!user && (!authEnabled || (ipPolicy === 'or' && matcher && ipMatched))) {
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
      return html(ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        const wantsJson = req.path.startsWith('/api/') || (req.headers['accept'] ?? '').toString().includes('application/json');
        if (wantsJson) return json(err.status, { error: err.message, code: err.code });
        return { status: err.status, headers: { 'content-type': 'text/html; charset=utf-8' }, body: errorPage(err) };
      }
      console.error('[rudin] unhandled error', err);
      return json(500, { error: 'Internal error' });
    }
  }

  // -------------------------------------------------------------------------
  function html(ctx: Ctx): RudinResponse {
    const boot = {
      basePath,
      authEnabled,
      theme: options.theme ?? {},
      readonly: !!store.readonly,
      version: '0.1.0',
    };
    const page = UI_HTML.replace(
      '<!--RUDIN_CONFIG-->',
      `<script>window.__RUDIN__=${JSON.stringify(boot).replace(/</g, '\\u003c')}</script>`,
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

  // -------------------------------------------------------------------------
  async function api(ctx: Ctx, path: string): Promise<RudinResponse> {
    const { req } = ctx;
    const isMutation = req.method !== 'GET' && req.method !== 'HEAD';
    if (isMutation && req.headers['x-requested-with'] !== 'rudin') {
      throw new HttpError(403, 'Missing X-Requested-With header', 'csrf');
    }

    switch (path) {
      case '/api/me':
        return json(200, me(ctx));
      case '/api/login':
        return login(ctx);
      case '/api/logout':
        return logout(ctx);
      case '/api/specs':
        require(ctx, 'docs:read');
        return json(200, { specs: specs.listFor(ctx.user!.role) });
      case '/api/spec': {
        require(ctx, 'docs:read');
        const name = req.query.name || specs.entries[0].name;
        if (!specs.listFor(ctx.user!.role).some((s) => s.name === name)) throw new HttpError(404, 'Spec not found');
        const doc = await specs.load(name);
        if (!doc) throw new HttpError(404, 'Spec not found');
        await auditor.emit({ type: 'docs.view', ip: ctx.ip, user: pick(ctx.user), detail: { spec: name } });
        return json(200, applyVisibility(doc, options.visibility, ctx.user!.role));
      }
      case '/api/try':
        require(ctx, 'docs:try');
        return tryProxy(ctx);
      case '/api/admin':
        require(ctx, 'admin:read');
        return admin(ctx);
      case '/api/audit':
        require(ctx, 'audit:read');
        throw new HttpError(501, 'Audit log browsing requires a store (coming in v0.2). Events are sent to the configured sink.');
      default:
        throw new HttpError(404, 'Not Found');
    }
  }

  function require(ctx: Ctx, perm: Permission) {
    if (!ctx.user) throw new HttpError(401, 'Login required', 'unauthenticated');
    if (!roles.has(ctx.user.role, perm)) throw new HttpError(403, `Missing permission: ${perm}`, 'forbidden');
  }

  function me(ctx: Ctx) {
    return {
      authenticated: !!ctx.user,
      anonymous: ctx.anonymous,
      user: ctx.user ? { email: ctx.user.email, name: ctx.user.name, role: ctx.user.role } : null,
      permissions: ctx.user ? roles.permissions(ctx.user.role) : [],
      readonly: !!store.readonly,
      authEnabled,
    };
  }

  async function login(ctx: Ctx): Promise<RudinResponse> {
    if (!authEnabled) throw new HttpError(400, 'Authentication is disabled');
    if (ctx.req.method !== 'POST') throw new HttpError(405, 'Method Not Allowed');
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
      const stored = await store.users.findByEmail(email);
      if (stored && stored.status === 'active' && (await verifyPassword(password, stored.passwordHash))) {
        user = { id: stored.id, email: stored.email, role: stored.role, name: stored.name, ipAllowlist: stored.ipAllowlist };
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
    const { token, exp } = signer.issue(user);
    await auditor.emit({ type: 'login.success', ip: ctx.ip, user: pick(user) });
    const res = json(200, { ...me({ ...ctx, user, anonymous: false }) });
    res.headers['set-cookie'] = serializeCookie(cookieName, token, {
      path: basePath,
      secure: isSecure(ctx.req),
      maxAge: exp - Math.floor(Date.now() / 1000),
    });
    return res;
  }

  async function logout(ctx: Ctx): Promise<RudinResponse> {
    if (ctx.req.method !== 'POST') throw new HttpError(405, 'Method Not Allowed');
    if (ctx.user && !ctx.anonymous) await auditor.emit({ type: 'logout', ip: ctx.ip, user: pick(ctx.user) });
    const res = json(200, { ok: true });
    res.headers['set-cookie'] = serializeCookie(cookieName, '', { path: basePath, secure: isSecure(ctx.req), maxAge: 0, expires: new Date(0) });
    return res;
  }

  async function admin(ctx: Ctx): Promise<RudinResponse> {
    const users = (await store.users.list()).map((u) => ({
      email: u.email,
      name: u.name,
      role: u.role,
      status: u.status,
      ipAllowlist: u.ipAllowlist ?? [],
      hashed: isHashed(u.passwordHash),
    }));
    const ipRules = await store.ipRules.list();
    return json(200, {
      readonly: !!store.readonly,
      users,
      ipRules,
      ipPolicy,
      allowLocalhost,
      trustProxy: options.trustProxy ?? false,
      roles: roles.names().map((name) => ({ name, permissions: roles.permissions(name) })),
      visibility: options.visibility ?? {},
      audit: { sink: options.audit?.sink === false ? 'disabled' : options.audit?.sink ? 'custom' : 'stdout' },
    });
  }

  // -------------------------------------------------------------------------
  async function tryProxy(ctx: Ctx): Promise<RudinResponse> {
    if (ctx.req.method !== 'POST') throw new HttpError(405, 'Method Not Allowed');
    const body = parseJson(ctx.req.body) as {
      method?: string;
      url?: string;
      headers?: Record<string, string>;
      body?: string | null;
      spec?: string;
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
    // Never let the proxy call rudin itself.
    if (target.origin === selfOrigin && target.pathname.startsWith(basePath)) {
      throw new HttpError(400, 'Cannot proxy to rudin itself');
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.headers ?? {})) {
      if (!/^(host|content-length|connection|cookie)$/i.test(k) && typeof v === 'string') headers[k] = v;
    }
    headers['x-forwarded-for'] = ctx.ip;
    headers['x-rudin-user'] = ctx.user!.email;

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
    });
  }

  return { handle, options };
}

// ---------------------------------------------------------------------------
function json(status: number, data: unknown): RudinResponse {
  return { status, headers: { ...JSON_HEADERS }, body: JSON.stringify(data) };
}

function parseJson(body: RudinRequest['body']): unknown {
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

function isSecure(req: RudinRequest): boolean {
  const xfp = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(xfp) ? xfp[0] : xfp) ?? req.protocol;
  return proto === 'https';
}

function requestOrigin(req: RudinRequest): string {
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
