// ---------------------------------------------------------------------------
// Public option types
// ---------------------------------------------------------------------------

export type Role = 'viewer' | 'developer' | 'admin' | (string & {});

export type Permission =
  | 'docs:read'
  | 'docs:try'
  | 'audit:read'
  | 'audit:read:self'
  | 'admin:read'
  | 'admin:write'
  | 'notices:write';

export interface BoundUser {
  email: string;
  /** Plain text or a hash (`$scrypt$…`, `$2a$/$2b$` bcrypt, `$argon2…`). */
  password: string;
  role?: Role;
  name?: string;
  /** Per-user IP allowlist (CIDR / single IP). Overrides global when set. */
  ipAllowlist?: string[];
}

export interface SpecEntry {
  name: string;
  spec: SpecSource;
  /** Roles that can see this spec. Default: everyone logged in. */
  visibleTo?: Role[];
}

export type SpecSource =
  | string // file path (.json/.yaml) or http(s) URL
  | object // an OpenAPI document (e.g. from @nestjs/swagger)
  | (() => object | Promise<object>);

export interface ThemeOptions {
  title?: string;
  logo?: string; // URL or data URI, shown top-left
  /** Alternate logo for dark mode (a light-background logo vanishes otherwise). */
  logoDark?: string;
  favicon?: string; // URL or data URI
  primary?: string; // any CSS color
  accent?: string;
  font?: string; // CSS font-family
  radius?: 'none' | 'sm' | 'md' | 'lg';
  density?: 'compact' | 'comfortable';
  mode?: 'light' | 'dark' | 'system';
  customCss?: string;
  loginHeadline?: string;
  loginDescription?: string;
}

export interface AuditEvent {
  ts: string;
  type:
    | 'login.success'
    | 'login.failure'
    | 'logout'
    | 'docs.view'
    | 'docs.export'
    | 'docs.try'
    | 'ip.blocked'
    | 'auth.denied'
    | 'admin.user.create'
    | 'admin.user.update'
    | 'admin.user.remove'
    | 'admin.ip.create'
    | 'admin.ip.remove'
    | 'admin.sessions.revoke'
    | 'invite.create'
    | 'invite.accept'
    | 'invite.revoke'
    | 'notice.create'
    | 'notice.update'
    | 'notice.remove';
  user?: { email: string; role: Role } | null;
  ip: string;
  detail?: Record<string, unknown>;
}

export interface AuditOptions {
  /** Custom sink. Default: JSON lines to stdout. Pass `false` to disable. */
  sink?: ((e: AuditEvent) => void | Promise<void>) | false;
  /** Header / field names to mask in `docs.try` events. */
  mask?: string[];
  /** Record request/response bodies of Try-it-out calls. Default: false. */
  recordBodies?: boolean;
  /** Store mode: delete events older than this many days (needs `store.audit.prune`). */
  retentionDays?: number;
}

export interface AuthOptions {
  /** Static users (binding mode). Ignored for auth when `verify` is set. */
  users?: BoundUser[];
  /** Custom verifier – hook into your own auth system. */
  verify?: (email: string, password: string) => Promise<AuthUser | null> | AuthUser | null;
  session?: {
    /** HMAC secret for session cookies. Falls back to LUDIN_SESSION_SECRET, then a random per-process secret. */
    secret?: string;
    /** e.g. '12h', '7d', or seconds. Default '12h'. */
    ttl?: string | number;
    cookieName?: string;
  };
  lockout?: {
    /** Failed attempts before lockout. Default 5. */
    attempts?: number;
    /** Window / lock duration. Default '15m'. */
    window?: string | number;
  };
}

export interface LudinOptions {
  spec: SpecSource | SpecEntry[];
  /** `false` disables login entirely (IP allowlist only). */
  auth?: false | AuthOptions;
  ipAllowlist?: string[];
  /** 'and' (default): IP must match AND user must log in. 'or': matching IP skips login. */
  ipPolicy?: 'and' | 'or';
  /** Role granted to visitors admitted by IP only (ipPolicy 'or') or when auth is disabled. Default 'developer'. */
  ipAllowlistRole?: Role;
  /** Trust X-Forwarded-For. `true` = first hop, number = hops to trust. */
  trustProxy?: boolean | number;
  /** Respond with 404 instead of 403 when IP is blocked. Default false. */
  hideOnBlock?: boolean;
  /** Allow localhost regardless of allowlist. Default true. */
  allowLocalhost?: boolean;
  /** Custom / extra roles → permissions. Merged over defaults. */
  roles?: Record<string, Permission[]>;
  /** Tag or path visibility: `{ 'tag:Internal': ['admin'], '/admin/*': ['admin'] }`. */
  visibility?: Record<string, Role[]>;
  audit?: AuditOptions;
  theme?: ThemeOptions;
  /** Mount path (used for cookie path and asset links). Adapters usually set this. */
  basePath?: string;
  /** Extra hosts Try-it-out proxy may call, besides the spec's `servers`. */
  allowedTargets?: string[];
  store?: LudinStore;
}

// ---------------------------------------------------------------------------
// Store adapter
//
// The core only ever touches data through this interface. Binding mode plugs in
// a read-only in-memory implementation, store mode a database-backed one, so
// "mode" is nothing more than which adapter is installed.
//
// Everything past `users` / `ipRules` is optional: a store advertises what it
// can do simply by implementing it, and the core reports that back to the UI as
// capabilities.
// ---------------------------------------------------------------------------

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  name?: string;
  ipAllowlist?: string[];
}

export type UserStatus = 'active' | 'invited' | 'disabled';

export interface StoredUser extends AuthUser {
  passwordHash: string;
  status: UserStatus;
  createdAt?: string;
  lastLoginAt?: string;
}

/** A user to create. `passwordHash` is always hashed by the core first. */
export interface NewUser {
  email: string;
  role: Role;
  name?: string;
  passwordHash: string;
  status: UserStatus;
  ipAllowlist?: string[];
}

export interface IpRule {
  id: string;
  cidr: string;
  note?: string;
}

export interface Invite {
  id: string;
  email: string;
  role: Role;
  /** SHA-256 of the token – the raw token is only ever returned at creation. */
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  createdBy?: string;
  acceptedAt?: string | null;
}

export interface Session {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt?: string;
  ip?: string;
  userAgent?: string;
}

/**
 * A post on the notice board – release notes, onboarding instructions, the
 * README you want a client to read before they call anything. Store mode only:
 * a notice written into a binding-mode config would be lost on the next deploy.
 */
export interface Notice {
  id: string;
  title: string;
  /** Markdown. Rendered read-only in the docs UI. */
  body: string;
  status: 'draft' | 'published';
  pinned: boolean;
  /** Roles that may read it. Empty / undefined = everyone who can read the docs. */
  visibleTo?: Role[];
  authorEmail?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditFilter {
  /** Email of the acting user. */
  user?: string;
  type?: AuditEvent['type'];
  /** ISO timestamps (inclusive). */
  from?: string;
  to?: string;
  /** Free text over path / detail. */
  q?: string;
  limit?: number;
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string | null;
}

export interface LudinStore {
  /** Binding mode's built-in store sets this; the admin UI turns read-only. */
  readonly?: boolean;
  users: {
    findByEmail(email: string): Promise<StoredUser | null>;
    findById?(id: string): Promise<StoredUser | null>;
    list(): Promise<StoredUser[]>;
    create?(input: NewUser): Promise<StoredUser>;
    update?(id: string, patch: Partial<Omit<StoredUser, 'id'>>): Promise<StoredUser>;
    remove?(id: string): Promise<void>;
  };
  ipRules: {
    list(): Promise<IpRule[]>;
    upsert?(rule: IpRule): Promise<IpRule>;
    remove?(id: string): Promise<void>;
  };
  invites?: {
    create(invite: Invite): Promise<Invite>;
    findByTokenHash(tokenHash: string): Promise<Invite | null>;
    list(): Promise<Invite[]>;
    markAccepted(id: string, at: string): Promise<void>;
    remove(id: string): Promise<void>;
  };
  sessions?: {
    create(session: Session): Promise<Session>;
    get(id: string): Promise<Session | null>;
    touch?(id: string, at: string): Promise<void>;
    listForUser(userId: string): Promise<Session[]>;
    revoke(id: string): Promise<void>;
    revokeAllForUser(userId: string): Promise<void>;
  };
  notices?: {
    list(): Promise<Notice[]>;
    get(id: string): Promise<Notice | null>;
    create(notice: Notice): Promise<Notice>;
    update(id: string, patch: Partial<Omit<Notice, 'id'>>): Promise<Notice>;
    remove(id: string): Promise<void>;
  };
  audit?: {
    append(event: AuditEvent): Promise<void>;
    query?(filter: AuditFilter): Promise<Page<AuditEvent>>;
    /** Delete events older than the given ISO timestamp (retention). */
    prune?(before: string): Promise<number>;
  };
  /** Release DB handles. Called by nothing in the core – yours to use. */
  close?(): Promise<void> | void;
}

/** What the installed store can actually do – surfaced to the admin UI. */
export interface StoreCapabilities {
  users: boolean;
  invites: boolean;
  ipRules: boolean;
  sessions: boolean;
  auditQuery: boolean;
  notices: boolean;
}

// ---------------------------------------------------------------------------
// Framework-agnostic request / response
// ---------------------------------------------------------------------------

export interface LudinRequest {
  method: string;
  /** Path relative to the mount point, starting with '/'. */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  /** Raw body (already read). */
  body?: string | Buffer | null;
  /** Socket remote address. */
  remoteAddress: string;
  /** 'http' | 'https' as seen by Node (before proxy headers). */
  protocol?: string;
}

export interface LudinResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body?: string | Buffer;
}

export interface LudinHandler {
  handle(req: LudinRequest): Promise<LudinResponse>;
  options: Readonly<LudinOptions>;
}
