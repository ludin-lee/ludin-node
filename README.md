# ludin

**API docs, but with a front door.** Login, accounts & roles, IP allowlist, audit log and a fast, themeable UI — for any OpenAPI 3 document, in Express, Fastify, Koa, Hono, NestJS or plain `node:http`.

📄 Feature spec: [English](docs/FEATURE_SPEC.en.md) · [한국어](docs/FEATURE_SPEC.md)

- 🔐 **Login required** – nobody sees the docs, the spec JSON or *Try it out* without signing in
- 👥 **Accounts & roles** – `viewer` / `developer` / `admin` (or your own), per-tag / per-path visibility
- 🌐 **IP allowlist** – CIDR, ranges, IPv6, proxy-aware, lockout-proof
- 📝 **Audit log** – who logged in, who called what, from where (JSON lines, your own sink, or a browsable table)
- 🎨 **Beautiful UI** – 78 KB total (23 KB gzip), light/dark, brand colors, logo, custom CSS
- ⚡ **Zero-config binding mode** – users & IPs from code / `process.env`, no database needed
- 🗄 **Store mode** – add a database and the admin screen turns editable: invitations, roles, IP rules, forced sign-out, audit browsing

## Quick start (Express)

```bash
npm i ludin @ludin/express
```

```ts
import express from 'express';
import { ludin } from '@ludin/express';

const app = express();

app.use('/docs', ludin({
  spec: './openapi.yaml',                         // path, URL, object or async function
  auth: {
    users: [
      { email: 'admin@acme.io', password: process.env.DOCS_ADMIN_PW!, role: 'admin' },
      { email: 'dev@acme.io',   password: process.env.DOCS_DEV_PW!,   role: 'developer' },
      { email: 'qa@acme.io',    password: process.env.DOCS_QA_PW!,    role: 'viewer' },
    ],
    session: { secret: process.env.DOCS_SESSION_SECRET },
  },
  ipAllowlist: ['10.0.0.0/8', '203.0.113.42'],
  visibility: { 'tag:Internal': ['admin'] },
  theme: { title: 'Acme API', primary: '#0f766e', logo: '/logo.svg' },
}));
```

Passwords may be plain text (quick start) or hashes — generate one with `npx ludin hash`. Supported: `$scrypt$` (built in, zero deps), bcrypt (`npm i bcryptjs`), argon2 (`npm i argon2`).

## Quick start (NestJS)

```bash
npm i ludin @ludin/express @ludin/nestjs
```

`setupLudin` is a drop-in for `SwaggerModule.setup`:

```ts
import { setupLudin } from '@ludin/nestjs';

const document = SwaggerModule.createDocument(app, config);
setupLudin(app, '/docs', document, {
  auth: { users: [{ email: 'admin@acme.io', password: process.env.DOCS_ADMIN_PW!, role: 'admin' }] },
});
```

Or as a module: `LudinModule.forRoot({ path: '/docs', spec: () => document, auth: {...} })`.

## Other frameworks

Same options everywhere — only the mount differs. Every adapter is a thin wrapper around the same core handler, so login, IP rules, visibility filtering and the audit log behave identically.

```ts
// Fastify — npm i ludin @ludin/fastify
import { ludin } from '@ludin/fastify';
await app.register(ludin({ spec, auth }), { prefix: '/docs' });

// Koa — npm i ludin @ludin/koa
import { ludin } from '@ludin/koa';
app.use(ludin({ spec, auth, basePath: '/docs' }));   // other paths fall through to next()

// Hono — npm i ludin @ludin/hono
import { mountLudin } from '@ludin/hono';
mountLudin(app, { spec, auth, basePath: '/docs' });

// plain node:http / connect / polka — npm i ludin @ludin/node
import { ludin } from '@ludin/node';
const docs = ludin({ spec, auth, basePath: '/docs' });
http.createServer((req, res) => docs(req, res, () => { res.statusCode = 404; res.end(); })).listen(3000);
```

On runtimes that do not expose the client address (Cloudflare Workers, Vercel Edge …) set `trustProxy` so IP rules can read `X-Forwarded-For`; without it every request looks address-less and is blocked.

## Two modes

| | Binding mode (default) | Store mode |
|---|---|---|
| Users / IP rules live in | code + `process.env` | a database (`store: sqliteStore(...)` / `mysqlStore(...)`) |
| Admin screen | **read-only** view of the config | invite users, edit roles & IP rules |
| Sessions | signed JWT cookie, stateless | DB sessions, revocable |
| Audit log | stdout / `audit.sink` callback | stored + browsable + CSV export |

Binding mode is deliberately read-only: settings edited in a UI would be lost on the next deploy. The admin screen shows the effective config and explains what a store unlocks.

### Store mode

```bash
npm i ludin @ludin/express @ludin/store-sqlite
```

```ts
import { sqliteStore } from '@ludin/store-sqlite';

app.use('/docs', ludin({
  spec: './openapi.yaml',
  store: sqliteStore('./ludin.db'),
  auth: { users: [{ email: 'admin@acme.io', password: process.env.DOCS_ADMIN_PW!, role: 'admin' }] },
  audit: { retentionDays: 90 },
}));
```

One line and the same deployment gains:

- **Invitations** – admins create a link, the invitee picks their own password. Only a SHA-256 hash of the token is stored, and the link is single-use.
- **Editable accounts** – add people, change roles, disable, reset passwords, per-account IP restrictions.
- **Revocable sessions** – "sign out everywhere", or force-sign-out anyone from the admin screen. Disabling an account or changing its role or password kills its live cookies on the next request.
- **Audit browser** – filter by event, user, date and free text, paginate, export CSV. `developer` sees only their own trail, `admin` sees everyone's.
- **Editable IP rules** – with a guard that refuses any change that would lock *you* out (`force: true` overrides).

`auth.users` and `ipAllowlist` still work: they are used **once**, as a seed, while the database is empty — after that the store is the truth. Plain-text seed passwords are hashed on the way in.

Storage adapters:

| Adapter | Backend | Notes |
|---|---|---|
| `@ludin/store-sqlite` | a file (`./ludin.db`) | built-in `node:sqlite`, or `better-sqlite3` if installed. One app instance. |
| `@ludin/store-mysql` | MySQL 8 / MariaDB | needs `mysql2`. Pass a URL, a config object, or a pool you already own — several app instances then share one source of truth. |
| `createMemoryStore()` | process memory | same feature set, no persistence. Dev, tests, demos. |

```ts
import { mysqlStore } from '@ludin/store-mysql';

store: mysqlStore(process.env.DATABASE_URL!)          // mysql://user:pass@host:3306/db
store: mysqlStore(existingPool, { tablePrefix: 'docs_' })   // reuse the app's own pool
```

Both SQL adapters are thin: the queries, row mapping and keyset pagination live in `createSqlStore()` in the core, so the engines cannot drift apart. An adapter supplies a driver and its DDL — which is all a Postgres adapter will need too.

## Options

```ts
interface LudinOptions {
  spec: string | object | (() => object | Promise<object>) | SpecEntry[];  // multiple specs supported
  store?: LudinStore;              // store mode: sqliteStore('./ludin.db'), createMemoryStore(), …
  auth?: false | {
    users?: BoundUser[];
    verify?: (email, password) => AuthUser | null;   // plug in your own auth
    session?: { secret?: string; ttl?: '12h'; cookieName?: string };
    lockout?: { attempts?: 5; window?: '15m' };
  };
  ipAllowlist?: string[];          // '10.0.0.0/8', '2001:db8::/32', '1.2.3.4-1.2.3.9', '*'
  ipPolicy?: 'and' | 'or';         // and: IP AND login (default) · or: matching IP skips login
  ipAllowlistRole?: Role;          // role for IP-only visitors (default 'developer')
  trustProxy?: boolean | number;   // honour X-Forwarded-For (hops to trust)
  allowLocalhost?: boolean;        // default true – never lock yourself out
  hideOnBlock?: boolean;           // 404 instead of 403 for blocked IPs
  roles?: Record<string, Permission[]>;
  visibility?: Record<string, Role[]>;  // 'tag:Admin', '/admin/*', 'DELETE /users/{id}'
  audit?: { sink?: (e) => void | false; mask?: string[]; recordBodies?: boolean; retentionDays?: number };
  theme?: { title, logo, favicon, primary, accent, font, radius, density, mode, customCss, loginHeadline, loginDescription };
  allowedTargets?: string[];       // extra origins Try-it-out may call
}
```

Roles and permissions (defaults):

| role | docs:read | docs:try | audit:read | admin:read/write |
|---|---|---|---|---|
| viewer | ✓ | | | |
| developer | ✓ | ✓ | self | |
| admin | ✓ | ✓ | ✓ | ✓ |

Escape hatch if you lock yourself out: `LUDIN_BYPASS_IP_CHECK=1`.

## How Try-it-out works

Requests go through a server-side proxy (`POST /docs/api/try`) so that every call is audited and attributed to the signed-in user, CORS is never an issue, and only origins listed in the spec's `servers` (or `allowedTargets`) can be reached. The upstream receives `X-Ludin-User` and `X-Forwarded-For`.

## Repository layout

```
packages/core      ludin – framework-agnostic handler, auth, IP, audit, embedded UI
packages/express   @ludin/express
packages/fastify   @ludin/fastify
packages/koa       @ludin/koa
packages/hono      @ludin/hono
packages/node      @ludin/node   (plain node:http, connect, polka)
packages/nestjs    @ludin/nestjs
packages/store-sqlite  @ludin/store-sqlite – accounts, invites, sessions, audit in a file
packages/store-mysql   @ludin/store-mysql  – the same, in MySQL / MariaDB
packages/ui        Preact + Vite, built into a single HTML string in core
examples/express   Petstore demo on :3000
examples/nest      @nestjs/swagger demo on :3001
```

```bash
pnpm install
pnpm build            # ui → core → adapters
pnpm test             # core + adapter tests
pnpm dev:express      # http://localhost:3000/docs  (admin@example.com / admin)
pnpm dev:express:store  # same demo in store mode (./ludin.db)
pnpm dev:nest         # http://localhost:3001/docs
CHROMIUM_PATH=... node scripts/e2e.mjs         # browser test + screenshots (needs dev:express running)
CHROMIUM_PATH=... node scripts/e2e-store.mjs   # store-mode browser test (boots its own server)
LUDIN_MYSQL_DOCKER=1 pnpm --filter @ludin/store-mysql test   # MySQL tests in a throwaway container
```

## Roadmap

- **v0.2** ✅ store mode: SQLite & MySQL adapters, invitations, editable roles / IP rules, DB sessions + force logout, audit log browser, CSV export & retention
- **v0.3** OIDC / OAuth2 (Google, GitHub, Keycloak), Postgres / Prisma / Redis stores
- **v1.0** stable API

MIT
