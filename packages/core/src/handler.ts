import { Auditor } from './audit.js';
import { diffSpecs } from './diff.js';
import { buildPostmanCollection, generateTypes } from './export.js';
import { createIpMatcher, isLocalhost, resolveClientIp } from './ip.js';
import { handleMcp, MCP_PROTOCOL_VERSION, type McpCapabilities } from './mcp.js';
import { lintSpec } from './lint.js';
import { Lockout } from './lockout.js';
import { buildSampleInput, generateSamples } from './samples.js';
import { buildSearchIndex } from './search.js';
import { lookupResponseSchema, validateAgainstSchema } from './validate.js';
import { verifyPassword, isHashed } from './password.js';
import { Readme, ReadmeError } from './readme.js';
import { RoleRegistry } from './roles.js';
import { SessionSigner, parseCookies, parseDuration, serializeCookie } from './session.js';
import { ShareSigner, type SharePayload } from './share.js';
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
  /** Set when the caller arrived through a share link – a restricted identity. */
  share?: SharePayload;
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
  // Baselines for the changes view: per-spec `baseline`, else the shared `diff.baseline`.
  const baselineEntries = specs.entries
    .map((e) => ({ name: e.name, spec: e.baseline ?? options.diff?.baseline }))
    .filter((e): e is { name: string; spec: NonNullable<typeof e.spec> } => !!e.spec);
  const baselines = baselineEntries.length ? new SpecLoader(baselineEntries) : null;
  const auditor = new Auditor(options.audit);
  const ttlSec = parseDuration(auth?.session?.ttl, 12 * 3600);
  const signer = new SessionSigner(auth?.session?.secret ?? process.env.LUDIN_SESSION_SECRET, ttlSec);
  const cookieName = auth?.session?.cookieName ?? 'ludin_session';
  const mcpEnabled = options.mcp?.enabled === true;
  const shareEnabled = options.share?.enabled === true;
  const shareSigner = shareEnabled
    ? new ShareSigner(auth?.session?.secret ?? process.env.LUDIN_SESSION_SECRET)
    : null;
  const shareCookieName = `${cookieName}_share`;
  const shareMaxTtl = parseDuration(options.share?.maxTtl, 30 * 86400);
  const forwardCookies = options.forwardCookies ?? false;
  const forwardableCookieNames = Array.isArray(forwardCookies) ? new Set(forwardCookies) : null;
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

      // A share link is an identity, not a bypass: it is resolved after the IP
      // check above and before any role check below.
      let share: SharePayload | undefined;
      if (!user && shareSigner) {
        const auth = req.headers['authorization'];
        const bearer = typeof auth === 'string' && /^Bearer /i.test(auth) ? auth.slice(7).trim() : undefined;
        const presented = req.query.share || cookies[shareCookieName] || bearer;
        const payload = shareSigner.verify(presented);
        if (payload && roles.exists(payload.role) && !grantsAdmin(payload.role)) {
          share = payload;
          user = { id: 'share', email: `share:${payload.label || payload.role}`, role: payload.role };
        }
      }

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
      const ctx: Ctx = { req, ip, user, anonymous, share };

      // Move the token out of the URL into a cookie, so it stops travelling in
      // referrers, history and shared screenshots after the first click.
      if (share && req.query.share && !req.path.startsWith('/api/')) {
        return {
          status: 302,
          headers: {
            location: basePath === '/' ? '/' : `${basePath}/`,
            'set-cookie': serializeCookie(shareCookieName, req.query.share, {
              path: basePath,
              secure: isSecure(req),
              maxAge: Math.max(0, share.exp - Math.floor(Date.now() / 1000)),
            }),
            'cache-control': 'no-store',
          },
        };
      }

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
      version: '0.6.1',
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
        return json(200, {
          specs: specs
            .listFor(ctx.user!.role)
            .filter((s) => !ctx.share?.spec || s.name === ctx.share.spec)
            .map((s) => ({
              ...s,
              hasBaseline: !!baselines?.entries.some((b) => b.name === s.name),
            })),
        });
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
      case '/api/export/postman':
      case '/api/export/types.d.ts':
        require(ctx, 'docs:read');
        return exportGenerated(ctx, path.endsWith('postman') ? 'postman' : 'types');
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
      case '/api/diff': {
        require(ctx, 'docs:read');
        requireMethod(ctx, 'GET');
        const { name, doc } = await visibleSpec(ctx);
        if (!baselines?.entries.some((b) => b.name === name)) {
          throw new HttpError(404, 'No baseline is configured for this spec.', 'no_baseline');
        }
        const raw = await baselines.load(name);
        if (!raw) throw new HttpError(404, 'Baseline not found', 'no_baseline');
        // The baseline is filtered too – a hidden operation must not surface in the diff.
        const baseline = applyVisibility(raw, options.visibility, ctx.user!.role);
        return json(200, { spec: name, ...diffSpecs(baseline, doc) });
      }
      case '/api/lint': {
        require(ctx, 'docs:read');
        requireMethod(ctx, 'GET');
        const { name, doc } = await visibleSpec(ctx);
        const result = lintSpec(doc, options.lint);
        return json(200, { spec: name, ...result, issues: result.issues.slice(0, 200) });
      }
      case '/api/mcp':
        return mcpRoute(ctx);
      case '/api/share':
        require(ctx, 'admin:read');
        return createShare(ctx);
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
    const name = ctx.req.query.name || ctx.share?.spec || specs.entries[0].name;
    if (ctx.share?.spec && name !== ctx.share.spec) throw new HttpError(404, 'Spec not found');
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

  /**
   * A Postman collection or a TypeScript declaration file, generated from the
   * same role-filtered document the docs render (spec §3.13). Read access is
   * export access, so a share link can fetch these too – they never carry
   * anything `/api/spec.json` would not already hand out.
   */
  async function exportGenerated(ctx: Ctx, format: 'postman' | 'types'): Promise<LudinResponse> {
    requireMethod(ctx, 'GET');
    const { name, doc } = await visibleSpec(ctx);
    await auditor.emit({ type: 'docs.export', ip: ctx.ip, user: pick(ctx.user), detail: { spec: name, format } });
    const base = String(doc.info?.title ?? name).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60) || 'openapi';
    const postman = format === 'postman';
    return {
      status: 200,
      headers: {
        'content-type': postman ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="${base}${postman ? '.postman_collection.json' : '.d.ts'}"`,
        'cache-control': 'no-store',
      },
      body: postman
        ? JSON.stringify(buildPostmanCollection(doc, requestOrigin(ctx.req)), null, 2)
        : generateTypes(doc),
    };
  }

  function require(ctx: Ctx, perm: Permission) {
    if (!ctx.user) throw new HttpError(401, 'Login required', 'unauthenticated');
    if (ctx.share) {
      // Restrictions carried by the token, re-checked on every request.
      if (perm.startsWith('admin:')) throw new HttpError(403, 'Share links cannot administer.', 'forbidden');
      if (perm === 'docs:try' && !ctx.share.canTry) {
        throw new HttpError(403, 'This share link is read-only.', 'forbidden');
      }
    }
    if (!roles.has(ctx.user.role, perm)) throw new HttpError(403, `Missing permission: ${perm}`, 'forbidden');
  }

  /** Same rules as require(), as a question rather than a throw. */
  function canDo(ctx: Ctx, perm: Permission): boolean {
    try {
      require(ctx, perm);
      return true;
    } catch {
      return false;
    }
  }

  /** True when a role can reach the admin surface – never allowed for a share link. */
  function grantsAdmin(role: string): boolean {
    return roles.permissions(role).some((p) => p.startsWith('admin:'));
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
      share: ctx.share ? { canTry: ctx.share.canTry, expiresAt: new Date(ctx.share.exp * 1000).toISOString() } : null,
      shareEnabled,
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

  /**
   * The MCP endpoint. Identity is already resolved by the pipeline above, so
   * the agent gets exactly the documents its role can see, and `docs:try`
   * decides whether the execute tool is offered at all.
   */
  async function mcpRoute(ctx: Ctx): Promise<LudinResponse> {
    if (!mcpEnabled) throw new HttpError(404, 'Not Found');
    if (ctx.req.method === 'GET') {
      // Streamable HTTP allows a GET stream for server-initiated messages; we
      // have none, so say so rather than hold a socket open.
      throw new HttpError(405, 'This MCP endpoint is POST-only.');
    }
    requireMethod(ctx, 'POST');
    require(ctx, 'docs:read');

    const capabilities: McpCapabilities = {
      serverName: `ludin:${options.theme?.title ?? 'API docs'}`,
      serverVersion: MCP_PROTOCOL_VERSION,
      canTry: canDo(ctx, 'docs:try'),
      listSpecs: () => specs.listFor(ctx.user!.role).filter((s) => !ctx.share?.spec || s.name === ctx.share.spec),
      loadSpec: async (name?: string) => {
        const wanted = name || ctx.share?.spec || specs.entries[0].name;
        if (ctx.share?.spec && wanted !== ctx.share.spec) return null;
        if (!specs.listFor(ctx.user!.role).some((s) => s.name === wanted)) return null;
        const doc = await specs.load(wanted);
        return doc ? applyVisibility(doc, options.visibility, ctx.user!.role) : null;
      },
      execute: async (input) => {
        require(ctx, 'docs:try');
        const specName = input.spec || ctx.share?.spec || specs.entries[0].name;
        const doc = await specs.load(specName);
        const base = (input.server ?? doc?.servers?.[0]?.url ?? '').replace(/\/+$/, '').replace(/\{[^}]+\}/g, 'x');
        let path = input.path;
        for (const [k, v] of Object.entries(input.pathParams ?? {})) {
          path = path.replace(`{${k}}`, encodeURIComponent(String(v)));
        }
        const qs = new URLSearchParams(input.query ?? {}).toString();
        const url = `${base}${path}${qs ? `?${qs}` : ''}`;
        return await executeTry(ctx, {
          method: input.method.toUpperCase(),
          url,
          headers: input.headers ?? {},
          body: input.body === undefined ? null : typeof input.body === 'string' ? input.body : JSON.stringify(input.body),
          spec: specName,
          op: { method: input.method, path: input.path },
        });
      },
      audit: async (tool, detail) => {
        await auditor.emit({ type: 'mcp.tool', ip: ctx.ip, user: pick(ctx.user), detail: { tool, ...detail } });
      },
    };

    const result = await handleMcp(parseJson(ctx.req.body) as any, capabilities);
    // A notification gets no body, per JSON-RPC.
    return result ? json(200, result) : { status: 202, headers: { ...JSON_HEADERS } };
  }

  /**
   * Mint a share link. Everything the link may do is decided here and sealed
   * into the token: an admin-capable role is refused outright, Try it out is
   * off unless asked for, and the lifetime is capped by `share.maxTtl`.
   */
  async function createShare(ctx: Ctx): Promise<LudinResponse> {
    requireMethod(ctx, 'POST');
    if (!shareSigner) throw new HttpError(400, 'Share links are not enabled.', 'share_disabled');
    const body = parseJson(ctx.req.body) as { role?: string; ttl?: string | number; spec?: string; canTry?: boolean; label?: string };

    const role = body.role || 'viewer';
    if (!roles.exists(role)) throw new HttpError(400, `Unknown role "${role}"`, 'bad_role');
    if (grantsAdmin(role)) throw new HttpError(400, 'Share links cannot grant an admin role.', 'bad_role');
    if (body.spec && !specs.entries.some((e) => e.name === body.spec)) throw new HttpError(400, 'Unknown spec', 'bad_spec');

    const ttl = Math.min(parseDuration(body.ttl, 3 * 86400), shareMaxTtl);
    const { token, exp } = shareSigner.issue(
      { role, canTry: body.canTry === true, spec: body.spec, label: body.label?.slice(0, 60) },
      ttl,
    );
    await auditor.emit({
      type: 'share.created',
      ip: ctx.ip,
      user: pick(ctx.user),
      detail: { role, canTry: body.canTry === true, spec: body.spec, label: body.label, expiresAt: new Date(exp * 1000).toISOString() },
    });
    const origin = requestOrigin(ctx.req);
    return json(200, {
      token,
      url: `${origin}${basePath === '/' ? '' : basePath}/?share=${encodeURIComponent(token)}`,
      expiresAt: new Date(exp * 1000).toISOString(),
      role,
      canTry: body.canTry === true,
      spec: body.spec ?? null,
    });
  }

  // -------------------------------------------------------------------------
  interface TryPayload {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    body?: string | null;
    spec?: string;
    /** The documented operation behind this call – enables response validation. */
    op?: { method?: string; path?: string };
    /**
     * Cookies the docs UI holds for the target origin – ones a previous Try it
     * out response handed out via Set-Cookie (a login), kept in the browser and
     * sent back here. Lets a session-cookie API be used from the docs even when
     * it lives on another origin, since it is ludin that makes the call.
     */
    cookies?: Record<string, string>;
  }

  /** A cookie the upstream set, reduced to what the docs UI needs to keep it. */
  interface SetCookieEntry {
    name: string;
    value: string;
    /** Max-Age=0 or an Expires in the past: the upstream is asking to drop it. */
    expired: boolean;
  }

  /** Cookie names and values are restricted to what fits one `name=value` pair of a Cookie header. */
  const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  const COOKIE_VALUE = /^[^\s;,]*$/;

  function parseSetCookie(lines: string[]): SetCookieEntry[] {
    const out: SetCookieEntry[] = [];
    for (const line of lines) {
      const [pair, ...attrs] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!COOKIE_NAME.test(name) || !COOKIE_VALUE.test(value)) continue;
      let expired = false;
      for (const attr of attrs) {
        const [k, v = ''] = attr.split('=').map((s) => s.trim());
        if (/^max-age$/i.test(k) && Number(v) <= 0) expired = true;
        if (/^expires$/i.test(k)) {
          const when = Date.parse(v);
          if (!Number.isNaN(when) && when <= Date.now()) expired = true;
        }
      }
      out.push({ name, value, expired: expired || value === '' });
    }
    return out;
  }

  /** The incoming Cookie header minus ludin's own cookies, kept verbatim so values round-trip untouched. */
  function forwardableCookies(raw: string | string[] | undefined): string | undefined {
    if (!forwardCookies) return undefined;
    const header = Array.isArray(raw) ? raw.join('; ') : raw;
    if (!header) return undefined;
    const kept = header
      .split(';')
      .map((pair) => pair.trim())
      .filter((pair) => {
        const idx = pair.indexOf('=');
        const name = idx < 0 ? '' : pair.slice(0, idx).trim();
        if (!name || name === cookieName || name === shareCookieName) return false;
        return forwardableCookieNames ? forwardableCookieNames.has(name) : true;
      });
    return kept.length ? kept.join('; ') : undefined;
  }

  async function tryProxy(ctx: Ctx): Promise<LudinResponse> {
    requireMethod(ctx, 'POST');
    return json(200, await executeTry(ctx, parseJson(ctx.req.body) as TryPayload));
  }

  /**
   * The one place a request leaves ludin for the documented API. Both the
   * browser's Try it out and the MCP tool go through it, so the origin
   * allowlist, the header scrubbing and the audit trail cannot be sidestepped
   * by using the other entry point.
   */
  async function executeTry(ctx: Ctx, body: TryPayload): Promise<Record<string, unknown>> {
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
    // Session-cookie APIs on the docs' own origin, when the deployment opted
    // in. Only the caller's own cookies as the browser sent them to us — the
    // same ones a direct call from the page would carry — and never to another
    // origin, since cookies for other origins never reach ludin in the first
    // place. Ludin's own session and share cookies stay out.
    const cookiePairs: string[] = [];
    if (target.origin === selfOrigin) {
      const cookie = forwardableCookies(ctx.req.headers['cookie']);
      if (cookie) cookiePairs.push(cookie);
    }
    // The jar the UI keeps for this origin: cookies the target itself handed
    // out on an earlier call. They are the caller's own, so they may go to any
    // allowed origin – that is the whole point – but never under ludin's names,
    // and only as well-formed pairs so nothing can smuggle in a second header.
    for (const [name, value] of Object.entries(body.cookies ?? {})) {
      if (name === cookieName || name === shareCookieName) continue;
      if (typeof value !== 'string' || !COOKIE_NAME.test(name) || !COOKIE_VALUE.test(value)) continue;
      cookiePairs.push(`${name}=${value}`);
    }
    if (cookiePairs.length) headers['cookie'] = cookiePairs.join('; ');

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
      return { status: 0, error: `Request failed: ${(err as Error).message}`, ms: Date.now() - started };
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

    // Set-Cookie must be read through getSetCookie(): the generic accessor folds
    // several cookies into one comma-joined string that cannot be split safely.
    const setCookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];

    return {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: resHeaders,
      cookies: parseSetCookie(setCookies),
      ms,
      size: buf.length,
      body: isText ? buf.toString('utf8') : null,
      bodyBase64: isText ? null : buf.toString('base64'),
      validation: validateTryResponse(ctx, doc, body.op, upstream.status, resHeaders['content-type'], isText ? buf.toString('utf8') : null),
    };
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
  ): {
    checked: boolean;
    reason?: string;
    documented?: string[];
    status?: number;
    issues?: Array<{ path: string; message: string }>;
  } {
    if (!doc || !op?.method || !op.path) return { checked: false, reason: 'no_operation' };
    if (text == null || !/json/i.test(contentType ?? '')) return { checked: false, reason: 'not_json' };
    const filtered = applyVisibility(doc, options.visibility, ctx.user!.role);
    const found = lookupResponseSchema(filtered, op.method, op.path, status);
    if (!found) return { checked: false, reason: 'no_operation' };
    if ('reason' in found) {
      // An undocumented status is drift worth naming; a documented response
      // without a schema is simply nothing to compare against.
      return found.reason === 'undocumented_status'
        ? { checked: false, reason: 'undocumented_status', documented: found.documented, status }
        : { checked: false, reason: 'no_schema' };
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { checked: false, reason: 'invalid_json' };
    }

    // Envelope APIs: the documented schema describes the payload, not the wrapper.
    const envelope = options.validate?.envelope;
    if (envelope && value && typeof value === 'object' && envelope.dataPath in (value as object)) {
      const issues = envelope.schema
        ? validateAgainstSchema(filtered, envelope.schema, value)
        : [];
      const payload = (value as Record<string, unknown>)[envelope.dataPath];
      return {
        checked: true,
        issues: [...issues, ...validateAgainstSchema(filtered, found.schema, payload, `$.${envelope.dataPath}`)],
      };
    }

    return { checked: true, issues: validateAgainstSchema(filtered, found.schema, value) };
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
