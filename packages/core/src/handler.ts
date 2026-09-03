import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Auditor } from './audit.js';
import { createIpMatcher, isLocalhost, resolveClientIp } from './ip.js';
import { Lockout } from './lockout.js';
import { hashPassword, verifyPassword, isHashed } from './password.js';
import { RoleRegistry } from './roles.js';
import { SessionSigner, parseCookies, parseDuration, serializeCookie } from './session.js';
import { SpecLoader, applyVisibility, serverOrigins } from './spec.js';
import { createBindingStore } from './store.js';
import { UI_HTML } from './ui-bundle.js';
import type {
  AuditEvent,
  AuditFilter,
  AuthUser,
  Invite,
  IpRule,
  Permission,
  LudinHandler,
  LudinOptions,
  LudinRequest,
  LudinResponse,
  LudinStore,
  Role,
  StoreCapabilities,
  StoredUser,
} from './types.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const MIN_PASSWORD = 8;

class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

interface Ctx {
  req: LudinRequest;
  ip: string;
  user: AuthUser | null;
  /** Store-mode session id backing the cookie, when there is one. */
  sid?: string;
  /** true when access is granted by IP (ipPolicy 'or') or auth is disabled */
  anonymous: boolean;
}

export function createLudin(options: LudinOptions): LudinHandler {
  if (!options || !options.spec) throw new Error('[ludin] `spec` is required.');

  const basePath = normalizeBase(options.basePath ?? '/docs');
  const authEnabled = options.auth !== false;
  const auth = options.auth === false ? undefined : options.auth ?? {};
  const store: LudinStore = options.store ?? createBindingStore(auth?.users ?? [], options.ipAllowlist ?? []);
  const roles = new RoleRegistry(options.roles);
  const specs = new SpecLoader(options.spec);
  const auditor = new Auditor(options.audit, store);
  const ttlSec = parseDuration(auth?.session?.ttl, 12 * 3600);
  const signer = new SessionSigner(auth?.session?.secret ?? process.env.LUDIN_SESSION_SECRET, ttlSec);
  const cookieName = auth?.session?.cookieName ?? 'ludin_session';
  const lockout = new Lockout(auth?.lockout?.attempts ?? 5, parseDuration(auth?.lockout?.window, 15 * 60) * 1000);
  const ipPolicy = options.ipPolicy ?? 'and';
  const allowLocalhost = options.allowLocalhost ?? true;
  const anonymousRole = options.ipAllowlistRole ?? 'developer';

  const capabilities: StoreCapabilities = {
    users: !!(store.users.create && store.users.update && store.users.remove),
    invites: !!(store.invites && store.users.create && store.users.update),
    ipRules: !!(store.ipRules.upsert && store.ipRules.remove),
    sessions: !!store.sessions,
    auditQuery: !!store.audit?.query,
  };

  // Validate bound users early.
  if (authEnabled && !auth?.verify && (auth?.users?.length ?? 0) === 0 && !options.store) {
    console.warn('[ludin] auth is enabled but no users are configured – nobody will be able to log in.');
  }
  for (const u of auth?.users ?? []) {
    if (!isHashed(u.password)) {
      console.warn(`[ludin] User ${u.email} has a plain-text password. Prefer a hash: npx ludin hash`);
    }
    if (u.role && !roles.exists(u.role)) throw new Error(`[ludin] Unknown role "${u.role}" for ${u.email}`);
  }

  /**
   * Store mode with binding options present: the bound users / IP rules are
   * only a seed (spec §2.2). They are written once, while the store is still
   * empty, and the store is the truth from then on. Plain-text passwords are
   * hashed on the way in – a database is not the place for them.
   */
  let seeded: Promise<void> | null = null;
  async function ensureSeeded(): Promise<void> {
    if (!options.store || !capabilities.users) return;
    seeded ??= (async () => {
      if ((auth?.users?.length ?? 0) > 0 && (await store.users.list()).length === 0) {
        for (const u of auth!.users!) {
          await store.users.create!({
            email: u.email,
            role: u.role ?? 'developer',
            name: u.name,
            passwordHash: isHashed(u.password) ? u.password : await hashPassword(u.password),
            status: 'active',
            ipAllowlist: u.ipAllowlist,
          });
        }
        console.info(`[ludin] Seeded ${auth!.users!.length} account(s) from auth.users into the store.`);
      }
      if (capabilities.ipRules && (options.ipAllowlist?.length ?? 0) > 0 && (await store.ipRules.list()).length === 0) {
        for (const cidr of options.ipAllowlist!) {
          await store.ipRules.upsert!({ id: randomUUID(), cidr, note: 'seeded from ipAllowlist' });
        }
      }
    })().catch((err) => {
      seeded = null;
      throw err;
    });
    return seeded;
  }

  async function globalIpMatcher() {
    const rules = (await store.ipRules.list()).map((r) => r.cidr);
    return rules.length ? createIpMatcher(rules) : null;
  }

  // -------------------------------------------------------------------------
  async function handle(req: LudinRequest): Promise<LudinResponse> {
    const ip = resolveClientIp(req.remoteAddress, req.headers, options.trustProxy);
    try {
      await ensureSeeded();

      // 1. Global IP check ---------------------------------------------------
      const matcher = await globalIpMatcher();
      const bypass = process.env.LUDIN_BYPASS_IP_CHECK === '1' || (allowLocalhost && isLocalhost(ip));
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
      let sid = session?.sid;

      // Store mode: the cookie is only a pointer – the session record and the
      // account behind it decide whether it is still valid, so revoking a
      // session or disabling an account takes effect on the next request.
      if (user && store.sessions) {
        const live = sid ? await store.sessions.get(sid) : null;
        if (!live || live.userId !== user.id || live.expiresAt <= new Date().toISOString()) {
          user = null;
          sid = undefined;
        } else {
          await store.sessions.touch?.(sid!, new Date().toISOString());
        }
      }
      if (user && !store.readonly && store.users.findById) {
        const fresh = await store.users.findById(user.id);
        if (!fresh || fresh.status !== 'active') {
          if (sid) await store.sessions?.revoke(sid);
          user = null;
          sid = undefined;
        } else {
          user = { id: fresh.id, email: fresh.email, role: fresh.role, name: fresh.name, ipAllowlist: fresh.ipAllowlist };
        }
      }

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
      const ctx: Ctx = { req, ip, user, sid, anonymous };

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
      readonly: !!store.readonly,
      capabilities,
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
      case '/api/invites/info':
        return inviteInfo(ctx);
      case '/api/invites/accept':
        return acceptInvite(ctx);
    }

    // Authenticated routes -----------------------------------------------------
    switch (path) {
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
      case '/api/session/revoke-all':
        return revokeOwnSessions(ctx);
      case '/api/admin':
        require(ctx, 'admin:read');
        return admin(ctx);
      case '/api/admin/users':
        require(ctx, 'admin:write');
        return createUser(ctx);
      case '/api/admin/ip':
        require(ctx, 'admin:write');
        return createIpRule(ctx);
      case '/api/admin/invites':
        require(ctx, 'admin:write');
        return createInvite(ctx);
      case '/api/audit':
        return auditQuery(ctx, 'json');
      case '/api/audit.csv':
        return auditQuery(ctx, 'csv');
    }

    let m: RegExpExecArray | null;
    if ((m = /^\/api\/admin\/users\/([^/]+)\/revoke-sessions$/.exec(path))) {
      require(ctx, 'admin:write');
      return revokeUserSessions(ctx, m[1]);
    }
    if ((m = /^\/api\/admin\/users\/([^/]+)$/.exec(path))) {
      require(ctx, 'admin:write');
      if (req.method === 'DELETE') return removeUser(ctx, m[1]);
      return updateUser(ctx, m[1]);
    }
    if ((m = /^\/api\/admin\/ip\/([^/]+)$/.exec(path))) {
      require(ctx, 'admin:write');
      return removeIpRule(ctx, m[1]);
    }
    if ((m = /^\/api\/admin\/invites\/([^/]+)$/.exec(path))) {
      require(ctx, 'admin:write');
      return revokeInvite(ctx, m[1]);
    }
    throw new HttpError(404, 'Not Found');
  }

  function require(ctx: Ctx, perm: Permission) {
    if (!ctx.user) throw new HttpError(401, 'Login required', 'unauthenticated');
    if (!roles.has(ctx.user.role, perm)) throw new HttpError(403, `Missing permission: ${perm}`, 'forbidden');
  }

  /** Guard for endpoints that need a writable store adapter. */
  function requireCapability(cap: keyof StoreCapabilities): void {
    if (capabilities[cap]) return;
    throw new HttpError(
      501,
      store.readonly
        ? 'This deployment runs in binding mode: accounts and IP rules come from your code, so they cannot be edited here. Connect a store (e.g. @ludin/store-sqlite) to enable it.'
        : `The configured store does not support "${cap}".`,
      'store_required',
    );
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
      readonly: !!store.readonly,
      capabilities,
      authEnabled,
    };
  }

  // -- auth ------------------------------------------------------------------
  async function startSession(ctx: Ctx, user: AuthUser): Promise<LudinResponse> {
    let sid: string | undefined;
    if (store.sessions) {
      sid = randomUUID();
      const now = new Date();
      await store.sessions.create({
        id: sid,
        userId: user.id,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlSec * 1000).toISOString(),
        ip: ctx.ip,
        userAgent: headerValue(ctx.req, 'user-agent')?.slice(0, 300),
      });
    }
    const { token, exp } = signer.issue(user, sid);
    const res = json(200, me({ ...ctx, user, sid, anonymous: false }));
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
      const stored = await store.users.findByEmail(email);
      if (stored && stored.status === 'active' && stored.passwordHash && (await verifyPassword(password, stored.passwordHash))) {
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
    if (!store.readonly && store.users.update && store.users.findById) {
      await store.users.update(user.id, { lastLoginAt: new Date().toISOString() }).catch(() => undefined);
    }
    await auditor.emit({ type: 'login.success', ip: ctx.ip, user: pick(user) });
    return startSession(ctx, user);
  }

  async function logout(ctx: Ctx): Promise<LudinResponse> {
    requireMethod(ctx, 'POST');
    if (ctx.sid) await store.sessions?.revoke(ctx.sid);
    if (ctx.user && !ctx.anonymous) await auditor.emit({ type: 'logout', ip: ctx.ip, user: pick(ctx.user) });
    const res = json(200, { ok: true });
    res.headers['set-cookie'] = serializeCookie(cookieName, '', { path: basePath, secure: isSecure(ctx.req), maxAge: 0, expires: new Date(0) });
    return res;
  }

  /** Sign out of every device (store mode). */
  async function revokeOwnSessions(ctx: Ctx): Promise<LudinResponse> {
    requireMethod(ctx, 'POST');
    if (!ctx.user || ctx.anonymous) throw new HttpError(401, 'Login required', 'unauthenticated');
    requireCapability('sessions');
    await store.sessions!.revokeAllForUser(ctx.user.id);
    await auditor.emit({ type: 'admin.sessions.revoke', ip: ctx.ip, user: pick(ctx.user), detail: { scope: 'self' } });
    const res = json(200, { ok: true });
    res.headers['set-cookie'] = serializeCookie(cookieName, '', { path: basePath, secure: isSecure(ctx.req), maxAge: 0, expires: new Date(0) });
    return res;
  }

  // -- admin -----------------------------------------------------------------
  async function admin(ctx: Ctx): Promise<LudinResponse> {
    const stored = await store.users.list();
    const sessionCounts = new Map<string, number>();
    if (store.sessions) {
      for (const u of stored.slice(0, 200)) {
        sessionCounts.set(u.id, (await store.sessions.listForUser(u.id)).length);
      }
    }
    const users = stored.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      status: u.status,
      ipAllowlist: u.ipAllowlist ?? [],
      hashed: isHashed(u.passwordHash),
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
      sessions: sessionCounts.get(u.id) ?? 0,
    }));
    const ipRules = await store.ipRules.list();
    const invites = store.invites ? (await store.invites.list()).map(publicInvite) : [];
    return json(200, {
      readonly: !!store.readonly,
      capabilities,
      users,
      ipRules,
      invites,
      ipPolicy,
      allowLocalhost,
      trustProxy: options.trustProxy ?? false,
      roles: roles.names().map((name) => ({ name, permissions: roles.permissions(name) })),
      visibility: options.visibility ?? {},
      audit: {
        sink: options.audit?.sink === false ? 'disabled' : options.audit?.sink ? 'custom' : 'stdout',
        queryable: capabilities.auditQuery,
        retentionDays: options.audit?.retentionDays ?? null,
      },
    });
  }

  async function loadUser(id: string): Promise<StoredUser> {
    const user = store.users.findById
      ? await store.users.findById(id)
      : (await store.users.list()).find((u) => u.id === id) ?? null;
    if (!user) throw new HttpError(404, 'No such account', 'not_found');
    return user;
  }

  /** Refuse changes that would leave the deployment without a way back in. */
  async function assertNotLastAdmin(target: StoredUser, next: { role?: Role; status?: string }) {
    const stillAdmin = (next.role ?? target.role) === 'admin' && (next.status ?? target.status) === 'active';
    if (target.role !== 'admin' || target.status !== 'active' || stillAdmin) return;
    const admins = (await store.users.list()).filter((u) => u.role === 'admin' && u.status === 'active');
    if (admins.length <= 1) {
      throw new HttpError(400, 'This is the last active admin – promote someone else first.', 'last_admin');
    }
  }

  async function createUser(ctx: Ctx): Promise<LudinResponse> {
    requireMethod(ctx, 'POST');
    requireCapability('users');
    const body = parseJson(ctx.req.body) as {
      email?: string;
      password?: string;
      role?: Role;
      name?: string;
      ipAllowlist?: string[];
    };
    const email = (body.email ?? '').trim();
    if (!email || !email.includes('@')) throw new HttpError(400, 'A valid email is required');
    const role = body.role ?? 'developer';
    if (!roles.exists(role)) throw new HttpError(400, `Unknown role "${role}"`);
    if (await store.users.findByEmail(email)) throw new HttpError(409, 'That email already has an account', 'duplicate');
    if (!body.password) throw new HttpError(400, 'A password is required – use an invite to let them pick their own.');
    if (body.password.length < MIN_PASSWORD && !isHashed(body.password)) {
      throw new HttpError(400, `Passwords must be at least ${MIN_PASSWORD} characters`);
    }
    const ipAllowlist = validIpList(body.ipAllowlist);

    const user = await store.users.create!({
      email,
      role,
      name: body.name,
      passwordHash: isHashed(body.password) ? body.password : await hashPassword(body.password),
      status: 'active',
      ipAllowlist,
    });
    await auditor.emit({ type: 'admin.user.create', ip: ctx.ip, user: pick(ctx.user), detail: { email: user.email, role: user.role } });
    return json(201, { user: publicUser(user) });
  }

  async function updateUser(ctx: Ctx, id: string): Promise<LudinResponse> {
    requireMethod(ctx, 'PATCH', 'POST');
    requireCapability('users');
    const target = await loadUser(id);
    const body = parseJson(ctx.req.body) as {
      role?: Role;
      name?: string;
      status?: StoredUser['status'];
      password?: string;
      ipAllowlist?: string[];
    };
    if (target.id === ctx.user!.id && (body.role !== undefined || body.status !== undefined)) {
      throw new HttpError(400, 'You cannot change your own role or status.', 'self_edit');
    }
    if (body.role !== undefined && !roles.exists(body.role)) throw new HttpError(400, `Unknown role "${body.role}"`);
    if (body.status !== undefined && !['active', 'invited', 'disabled'].includes(body.status)) {
      throw new HttpError(400, `Unknown status "${body.status}"`);
    }
    await assertNotLastAdmin(target, body);

    const patch: Partial<StoredUser> = {};
    if (body.role !== undefined) patch.role = body.role;
    if (body.name !== undefined) patch.name = body.name;
    if (body.status !== undefined) patch.status = body.status;
    if (body.ipAllowlist !== undefined) patch.ipAllowlist = validIpList(body.ipAllowlist);
    if (body.password) {
      if (body.password.length < MIN_PASSWORD && !isHashed(body.password)) {
        throw new HttpError(400, `Passwords must be at least ${MIN_PASSWORD} characters`);
      }
      patch.passwordHash = isHashed(body.password) ? body.password : await hashPassword(body.password);
    }
    if (Object.keys(patch).length === 0) throw new HttpError(400, 'Nothing to update');

    const updated = await store.users.update!(id, patch);
    // A disabled account, a new password or a demotion must not keep old cookies alive.
    if (store.sessions && (patch.status === 'disabled' || patch.passwordHash || patch.role)) {
      await store.sessions.revokeAllForUser(id);
    }
    await auditor.emit({
      type: 'admin.user.update',
      ip: ctx.ip,
      user: pick(ctx.user),
      detail: { email: updated.email, changed: Object.keys(patch).map((k) => (k === 'passwordHash' ? 'password' : k)) },
    });
    return json(200, { user: publicUser(updated) });
  }

  async function removeUser(ctx: Ctx, id: string): Promise<LudinResponse> {
    requireCapability('users');
    const target = await loadUser(id);
    if (target.id === ctx.user!.id) throw new HttpError(400, 'You cannot delete your own account.', 'self_edit');
    await assertNotLastAdmin(target, { status: 'disabled' });
    await store.sessions?.revokeAllForUser(id);
    await store.users.remove!(id);
    await auditor.emit({ type: 'admin.user.remove', ip: ctx.ip, user: pick(ctx.user), detail: { email: target.email } });
    return json(200, { ok: true });
  }

  async function revokeUserSessions(ctx: Ctx, id: string): Promise<LudinResponse> {
    requireMethod(ctx, 'POST');
    requireCapability('sessions');
    const target = await loadUser(id);
    await store.sessions!.revokeAllForUser(id);
    await auditor.emit({ type: 'admin.sessions.revoke', ip: ctx.ip, user: pick(ctx.user), detail: { email: target.email } });
    return json(200, { ok: true });
  }

  // -- ip rules ---------------------------------------------------------------
  /**
   * Refuse a rule set that would shut the caller out. Without this, one typo in
   * a CIDR locks everyone out of the docs until the next deploy.
   */
  async function assertNotSelfLockout(ctx: Ctx, rules: IpRule[], force: boolean) {
    if (force || !rules.length) return;
    if (process.env.LUDIN_BYPASS_IP_CHECK === '1' || (allowLocalhost && isLocalhost(ctx.ip))) return;
    if (createIpMatcher(rules.map((r) => r.cidr))(ctx.ip)) return;
    throw new HttpError(
      400,
      `These rules would lock you out: your address ${ctx.ip} does not match any of them. Add a rule covering it first, or repeat with force=true.`,
      'self_lockout',
    );
  }

  async function createIpRule(ctx: Ctx): Promise<LudinResponse> {
    requireMethod(ctx, 'POST');
    requireCapability('ipRules');
    const body = parseJson(ctx.req.body) as { cidr?: string; note?: string; force?: boolean };
    const cidr = (body.cidr ?? '').trim();
    if (!cidr) throw new HttpError(400, 'A rule is required, e.g. 10.0.0.0/8');
    try {
      createIpMatcher([cidr]);
    } catch (err) {
      throw new HttpError(400, (err as Error).message.replace('[ludin] ', ''), 'invalid_rule');
    }
    const existing = await store.ipRules.list();
    if (existing.some((r) => r.cidr === cidr)) throw new HttpError(409, 'That rule already exists', 'duplicate');

    const rule: IpRule = { id: randomUUID(), cidr, note: body.note?.slice(0, 200) };
    await assertNotSelfLockout(ctx, [...existing, rule], !!body.force);
    await store.ipRules.upsert!(rule);
    await auditor.emit({ type: 'admin.ip.create', ip: ctx.ip, user: pick(ctx.user), detail: { cidr } });
    return json(201, { rule });
  }

  async function removeIpRule(ctx: Ctx, id: string): Promise<LudinResponse> {
    requireCapability('ipRules');
    const existing = await store.ipRules.list();
    const rule = existing.find((r) => r.id === id);
    if (!rule) throw new HttpError(404, 'No such rule', 'not_found');
    await assertNotSelfLockout(ctx, existing.filter((r) => r.id !== id), ctx.req.query.force === 'true');
    await store.ipRules.remove!(id);
    await auditor.emit({ type: 'admin.ip.remove', ip: ctx.ip, user: pick(ctx.user), detail: { cidr: rule.cidr } });
    return json(200, { ok: true });
  }

  // -- invites ----------------------------------------------------------------
  async function createInvite(ctx: Ctx): Promise<LudinResponse> {
    requireMethod(ctx, 'POST');
    requireCapability('invites');
    const body = parseJson(ctx.req.body) as { email?: string; role?: Role; ttl?: string | number };
    const email = (body.email ?? '').trim();
    if (!email || !email.includes('@')) throw new HttpError(400, 'A valid email is required');
    const role = body.role ?? 'developer';
    if (!roles.exists(role)) throw new HttpError(400, `Unknown role "${role}"`);

    const existing = await store.users.findByEmail(email);
    if (existing && existing.status === 'active') {
      throw new HttpError(409, 'That email already has an active account', 'duplicate');
    }

    const token = randomBytes(32).toString('base64url');
    const ttlSeconds = parseDuration(body.ttl, 7 * 86400);
    const now = new Date();
    const invite: Invite = {
      id: randomUUID(),
      email,
      role,
      tokenHash: sha256(token),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
      createdBy: ctx.user!.email,
      acceptedAt: null,
    };
    await store.invites!.create(invite);
    if (existing) await store.users.update!(existing.id, { role, status: 'invited' });
    else await store.users.create!({ email, role, passwordHash: '', status: 'invited' });

    await auditor.emit({ type: 'invite.create', ip: ctx.ip, user: pick(ctx.user), detail: { email, role } });
    // The raw token is returned exactly once – only its hash is stored.
    return json(201, { invite: publicInvite(invite), token, url: `${basePath}#/invite/${token}` });
  }

  async function revokeInvite(ctx: Ctx, id: string): Promise<LudinResponse> {
    requireCapability('invites');
    const invite = (await store.invites!.list()).find((i) => i.id === id);
    if (!invite) throw new HttpError(404, 'No such invite', 'not_found');
    await store.invites!.remove(id);
    const user = await store.users.findByEmail(invite.email);
    if (user && user.status === 'invited' && store.users.remove) await store.users.remove(user.id);
    await auditor.emit({ type: 'invite.revoke', ip: ctx.ip, user: pick(ctx.user), detail: { email: invite.email } });
    return json(200, { ok: true });
  }

  async function findLiveInvite(token: string): Promise<Invite> {
    if (!token) throw new HttpError(400, 'A token is required');
    const invite = await store.invites!.findByTokenHash(sha256(token));
    if (!invite || invite.acceptedAt || invite.expiresAt <= new Date().toISOString()) {
      throw new HttpError(404, 'This invitation is invalid or has expired. Ask an admin for a new one.', 'invalid_invite');
    }
    return invite;
  }

  /** Public: lets the accept screen show who the invitation is for. */
  async function inviteInfo(ctx: Ctx): Promise<LudinResponse> {
    requireMethod(ctx, 'GET');
    requireCapability('invites');
    const invite = await findLiveInvite(ctx.req.query.token ?? '');
    return json(200, { email: invite.email, role: invite.role, expiresAt: invite.expiresAt });
  }

  /** Public: sets the password for an invited account and signs it in. */
  async function acceptInvite(ctx: Ctx): Promise<LudinResponse> {
    requireMethod(ctx, 'POST');
    requireCapability('invites');
    const locked = lockout.check(ctx.ip, 'invite');
    if (locked) throw new HttpError(429, `Too many attempts. Try again in ${locked}s.`, 'locked');

    const body = parseJson(ctx.req.body) as { token?: string; password?: string; name?: string };
    let invite: Invite;
    try {
      invite = await findLiveInvite(body.token ?? '');
    } catch (err) {
      lockout.fail(ctx.ip, 'invite');
      throw err;
    }
    const password = body.password ?? '';
    if (password.length < MIN_PASSWORD) throw new HttpError(400, `Passwords must be at least ${MIN_PASSWORD} characters`);

    const passwordHash = await hashPassword(password);
    const existing = await store.users.findByEmail(invite.email);
    const user = existing
      ? await store.users.update!(existing.id, {
          passwordHash,
          status: 'active',
          role: invite.role,
          ...(body.name ? { name: body.name } : {}),
        })
      : await store.users.create!({
          email: invite.email,
          role: invite.role,
          name: body.name,
          passwordHash,
          status: 'active',
        });

    await store.invites!.markAccepted(invite.id, new Date().toISOString());
    lockout.reset(ctx.ip, 'invite');
    await auditor.emit({ type: 'invite.accept', ip: ctx.ip, user: { email: user.email, role: user.role }, detail: { invitedBy: invite.createdBy } });
    return startSession(ctx, { id: user.id, email: user.email, role: user.role, name: user.name, ipAllowlist: user.ipAllowlist });
  }

  // -- audit ------------------------------------------------------------------
  async function auditQuery(ctx: Ctx, format: 'json' | 'csv'): Promise<LudinResponse> {
    requireMethod(ctx, 'GET');
    if (!ctx.user) throw new HttpError(401, 'Login required', 'unauthenticated');
    const all = roles.has(ctx.user.role, 'audit:read');
    if (!all && !roles.has(ctx.user.role, 'audit:read:self')) {
      throw new HttpError(403, 'Missing permission: audit:read', 'forbidden');
    }
    if (!capabilities.auditQuery) {
      throw new HttpError(
        501,
        'Audit log browsing needs a store that keeps events (e.g. @ludin/store-sqlite). Events are still delivered to the configured sink.',
        'store_required',
      );
    }
    const q = ctx.req.query;
    const filter: AuditFilter = {
      // Developers may only ever see their own trail.
      user: all ? q.user || undefined : ctx.user.email,
      type: (q.type as AuditEvent['type']) || undefined,
      from: q.from || undefined,
      to: q.to || undefined,
      q: q.q || undefined,
      limit: format === 'csv' ? 5000 : Number(q.limit) || 50,
      cursor: q.cursor || undefined,
    };
    const page = await store.audit!.query!(filter);
    if (format === 'json') return json(200, page);
    return {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="ludin-audit.csv"',
        'cache-control': 'no-store',
      },
      body: toCsv(page.items),
    };
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
    });
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function pick(u: AuthUser | null) {
  return u ? { email: u.email, role: u.role } : null;
}

function publicUser(u: StoredUser) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    ipAllowlist: u.ipAllowlist ?? [],
    hashed: isHashed(u.passwordHash),
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  };
}

/** Never leaks `tokenHash`. */
function publicInvite(i: Invite) {
  return {
    id: i.id,
    email: i.email,
    role: i.role,
    createdAt: i.createdAt,
    createdBy: i.createdBy,
    expiresAt: i.expiresAt,
    acceptedAt: i.acceptedAt ?? null,
    expired: i.expiresAt <= new Date().toISOString(),
  };
}

function validIpList(list: string[] | undefined): string[] | undefined {
  if (list === undefined) return undefined;
  const cleaned = list.map((s) => s.trim()).filter(Boolean);
  try {
    createIpMatcher(cleaned);
  } catch (err) {
    throw new HttpError(400, (err as Error).message.replace('[ludin] ', ''), 'invalid_rule');
  }
  return cleaned;
}

function headerValue(req: LudinRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function toCsv(events: AuditEvent[]): string {
  const rows = [
    ['ts', 'type', 'user', 'role', 'ip', 'detail'],
    ...events.map((e) => [e.ts, e.type, e.user?.email ?? '', e.user?.role ?? '', e.ip, JSON.stringify(e.detail ?? {})]),
  ];
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

function csvCell(value: string): string {
  // Neutralise spreadsheet formula injection before quoting.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
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
