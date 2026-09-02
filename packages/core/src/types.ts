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
  | 'admin:write';

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
  logo?: string; // URL or data URI
  favicon?: string;
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
    | 'docs.try'
    | 'ip.blocked'
    | 'auth.denied';
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
}

export interface AuthOptions {
  /** Static users (binding mode). Ignored for auth when `verify` is set. */
  users?: BoundUser[];
  /** Custom verifier – hook into your own auth system. */
  verify?: (email: string, password: string) => Promise<AuthUser | null> | AuthUser | null;
  session?: {
    /** HMAC secret for session cookies. Falls back to RUDIN_SESSION_SECRET, then a random per-process secret. */
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

export interface RudinOptions {
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
  store?: RudinStore;
}

// ---------------------------------------------------------------------------
// Store adapter (v0.2 will ship DB implementations; v0.1 uses the read-only
// binding store internally).
// ---------------------------------------------------------------------------

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  name?: string;
  ipAllowlist?: string[];
}

export interface StoredUser extends AuthUser {
  passwordHash: string;
  status: 'active' | 'invited' | 'disabled';
}

export interface IpRule {
  id: string;
  cidr: string;
  note?: string;
}

export interface RudinStore {
  readonly?: boolean;
  users: {
    findByEmail(email: string): Promise<StoredUser | null>;
    list(): Promise<StoredUser[]>;
  };
  ipRules: {
    list(): Promise<IpRule[]>;
  };
  audit?: {
    append(event: AuditEvent): Promise<void>;
  };
}

// ---------------------------------------------------------------------------
// Framework-agnostic request / response
// ---------------------------------------------------------------------------

export interface RudinRequest {
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

export interface RudinResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body?: string | Buffer;
}

export interface RudinHandler {
  handle(req: RudinRequest): Promise<RudinResponse>;
  options: Readonly<RudinOptions>;
}
