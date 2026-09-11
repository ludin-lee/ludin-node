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
  /** Previous version of this document, for the diff / changes view. */
  baseline?: SpecSource;
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
    | 'share.created'
    | 'mcp.tool'
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
  /** Lint tuning for /api/lint and the overview health score, e.g. { ignore: ['param-description'] }. */
  lint?: { ignore?: string[] };
  /** Try-it-out response validation. */
  validate?: {
    /**
     * For APIs that wrap every response in a common envelope. The documented
     * schema then describes what sits at `dataPath`, not the whole body — so
     * say so here instead of documenting the wrapper 300 times.
     *
     * ```ts
     * validate: { envelope: { dataPath: 'data' } }
     * ```
     *
     * Responses that lack the property are validated whole, as before: some
     * endpoints legitimately answer unwrapped, and crying wolf on those would
     * teach people to ignore the badge.
     */
    envelope?: {
      dataPath: string;
      /** Optional schema for the wrapper itself, checked alongside the payload. */
      schema?: Record<string, unknown>;
    };
  };
  /**
   * Expiring share links. Off unless enabled: it adds a way in, so it is opt-in.
   * A link is a signed grant that still walks the full pipeline — the IP
   * allowlist, roles and `visibility` all apply, and it can never reach admin.
   */
  /**
   * MCP endpoint for AI agents, at `{basePath}/api/mcp`. Off unless enabled:
   * it is another way in, so it is opt-in. An agent authenticates the same way
   * a person does — a session cookie, or a share link presented as
   * `Authorization: Bearer <token>` — and gets the same role-filtered document.
   * Executing a request still needs `docs:try`.
   */
  mcp?: { enabled?: boolean };
  share?: {
    enabled?: boolean;
    /** Upper bound for a link's lifetime. Default '30d'. */
    maxTtl?: string | number;
  };
  /** Baseline document for the changes view, used for every spec without its own `baseline`. */
  diff?: { baseline?: SpecSource };
  theme?: ThemeOptions;
  /** Mount path (used for cookie path and asset links). Adapters usually set this. */
  basePath?: string;
  /** Extra hosts Try-it-out proxy may call, besides the spec's `servers`. */
  allowedTargets?: string[];
  /**
   * Let Try it out reach APIs that authenticate with a session cookie — an
   * `/admin` or `/console` living next to the docs. Off by default.
   *
   * The browser already sends the caller's own cookies to the proxy when the
   * API shares the docs' origin; this hands them on to the API, exactly as a
   * direct call from the page would. Cookies for any other origin never reach
   * ludin, so nothing is ever forwarded cross-origin, and ludin's own session
   * and share cookies are always left out. `true` forwards the rest; a list
   * of names forwards only those.
   */
  forwardCookies?: boolean | string[];
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
