// ---------------------------------------------------------------------------
// Public option types
// ---------------------------------------------------------------------------

export type Role = 'viewer' | 'developer' | 'admin' | (string & {});

export type Permission = 'docs:read' | 'docs:try' | 'admin:read';

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
  /** UI language: 'en' | 'ko' | 'ja' | 'zh' | 'es' | 'fr' | 'de' | 'pt' | 'ru'. Default: the browser language, falling back to English. Viewers can switch in the menu. */
  language?: string;
  loginHeadline?: string;
  loginDescription?: string;
}

/**
 * An HTML page of your own – a README, an onboarding guide, release notes –
 * served next to the reference under the same access rules.
 *
 * The file is served as-is into a sandboxed frame, so its own CSS and scripts
 * work while staying walled off from the docs UI and its session cookie.
 */
export interface ReadmeOptions {
  /** `false` hides the button without removing the config. Default true. */
  enabled?: boolean;
  /** Path to an `.html` file, absolute or relative to `process.cwd()`. */
  path: string;
  /** Button label in the top bar. Default 'README'. */
  label?: string;
  /** Roles that may open it. Default: everyone who can read the docs. */
  visibleTo?: Role[];
}

export interface AuditEvent {
  ts: string;
  type:
    | 'login.success'
    | 'login.failure'
    | 'logout'
    | 'docs.view'
    | 'docs.export'
    | 'docs.readme'
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
  /** Static users. Ignored for auth when `verify` is set. */
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
  /** Your own HTML page, shown behind a button in the top bar. */
  readme?: string | ReadmeOptions;
  audit?: AuditOptions;
  theme?: ThemeOptions;
  /** Mount path (used for cookie path and asset links). Adapters usually set this. */
  basePath?: string;
  /** Extra hosts Try-it-out proxy may call, besides the spec's `servers`. */
  allowedTargets?: string[];
}

/** The identity behind a session, however it was established. */
export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  name?: string;
  ipAllowlist?: string[];
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
