# ludin

[![CI](https://github.com/ludin-lee/ludin-node/actions/workflows/ci.yml/badge.svg)](https://github.com/ludin-lee/ludin-node/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ludin.svg)](https://www.npmjs.com/package/ludin)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**API docs, but with a front door.** Login, accounts & roles, IP allowlist, audit log and a fast, themeable UI — for any OpenAPI 3 document, in Express, Fastify, Koa, Hono, NestJS or plain `node:http`. No database, no build step: one middleware and an options object.

📄 Feature spec: [English](docs/FEATURE_SPEC.en.md) · [한국어](docs/FEATURE_SPEC.md)

- 🔐 **Login required** – nobody sees the docs, the spec JSON or *Try it out* without signing in
- 👥 **Accounts & roles** – `viewer` / `developer` / `admin` (or your own), per-tag / per-path visibility
- 🌐 **IP allowlist** – CIDR, ranges, IPv6, proxy-aware, lockout-proof
- 📝 **Audit log** – who logged in, who called what, from where (JSON lines to stdout, or your own sink)
- 📄 **Your own HTML page** – point `readme` at a file and it appears next to the reference, behind the same login
- 📤 **Spec download** – hand a customer the JSON/YAML they are allowed to see, and log who took it
- 🧩 **Code samples** – cURL / fetch / axios / Python / Go / `.http` per operation, auth header and body example filled in
- ⌘K **Command palette** – search paths, summaries, operationIds *and schema field names*
- ✅ **Response validation** – every *Try it out* response is checked against the documented schema
- 🩺 **`ludin lint`** – a documentation health score, in the CLI, in CI (`--min 80`) and on the overview screen
- 🎨 **Beautiful UI** – 65 KB total (21 KB gzip), light/dark, your logo and brand colors, custom CSS
- ⚡ **No database** – accounts, IP rules and roles come from code / `process.env`; a redeploy is what changes them

## Quick start (Express)

```bash
npm i ludin @ludin-node/express
```

```ts
import express from 'express';
import { ludin } from '@ludin-node/express';

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
npm i ludin @ludin-node/express @ludin-node/nestjs
```

`setupLudin` is a drop-in for `SwaggerModule.setup`:

```ts
import { setupLudin } from '@ludin-node/nestjs';

const document = SwaggerModule.createDocument(app, config);
setupLudin(app, '/docs', document, {
  auth: { users: [{ email: 'admin@acme.io', password: process.env.DOCS_ADMIN_PW!, role: 'admin' }] },
});
```

Or as a module: `LudinModule.forRoot({ path: '/docs', spec: () => document, auth: {...} })`.

## Other frameworks

Same options everywhere — only the mount differs. Every adapter is a thin wrapper around the same core handler, so login, IP rules, visibility filtering and the audit log behave identically.

```ts
// Fastify — npm i ludin @ludin-node/fastify
import { ludin } from '@ludin-node/fastify';
await app.register(ludin({ spec, auth }), { prefix: '/docs' });

// Koa — npm i ludin @ludin-node/koa
import { ludin } from '@ludin-node/koa';
app.use(ludin({ spec, auth, basePath: '/docs' }));   // other paths fall through to next()

// Hono — npm i ludin @ludin-node/hono
import { mountLudin } from '@ludin-node/hono';
mountLudin(app, { spec, auth, basePath: '/docs' });

// plain node:http / connect / polka — npm i ludin @ludin-node/node
import { ludin } from '@ludin-node/node';
const docs = ludin({ spec, auth, basePath: '/docs' });
http.createServer((req, res) => docs(req, res, () => { res.statusCode = 404; res.end(); })).listen(3000);
```

On runtimes that do not expose the client address (Cloudflare Workers, Vercel Edge …) set `trustProxy` so IP rules can read `X-Forwarded-For`; without it every request looks address-less and is blocked.

## Your own page (`readme`)

An API reference is rarely the whole story: there is a guide, an onboarding
checklist, release notes. Point `readme` at an HTML file and it shows up as a
button in the top bar, behind the same login, IP rules and audit log:

```ts
app.use('/docs', ludin({
  spec: './openapi.yaml',
  readme: { enabled: true, path: './docs/guide.html', label: 'Guide' },
  auth: { users: [...] },
}));
```

| option | |
|---|---|
| `enabled` | `false` hides the button without deleting the config. Default `true` |
| `path` | the HTML file, absolute or relative to `process.cwd()` |
| `label` | the button's text. Default `README` |
| `visibleTo` | roles that may open it. Default: everyone who can read the docs |

`readme: './guide.html'` is shorthand for the same thing with the defaults.

The file is served as-is — it keeps its own CSS, fonts and scripts — into a
sandboxed frame in an opaque origin, so nothing in it can read the session
cookie or reach into the docs UI. It is re-read whenever it changes on disk, so
editing the page needs no restart, and every view is logged as a `docs.readme`
audit event.

## Options

```ts
interface LudinOptions {
  spec: string | object | (() => object | Promise<object>) | SpecEntry[];  // multiple specs supported
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
  readme?: string | { enabled?: boolean; path: string; label?: string; visibleTo?: Role[] };
  audit?: { sink?: (e) => void | false; mask?: string[]; recordBodies?: boolean };
  theme?: { title, logo, logoDark, favicon, primary, accent, font, radius, density, mode, customCss, loginHeadline, loginDescription };
  allowedTargets?: string[];       // extra origins Try-it-out may call
}
```

Roles and permissions (defaults):

| role | docs:read | docs:try | admin:read |
|---|---|---|---|
| viewer | ✓ | | |
| developer | ✓ | ✓ | |
| admin | ✓ | ✓ | ✓ |

`admin:read` opens the Administration screen: a read-only view of the accounts,
IP rules, roles and visibility rules this deployment is running with.

Escape hatch if you lock yourself out: `LUDIN_BYPASS_IP_CHECK=1`.

## Handing the docs to a customer

Everything a client sees is already filtered by their role, and the same is true of what they can take with them:

- **Download** – the Overview screen offers the document as JSON or YAML (`/docs/api/spec.json`, `/docs/api/spec.yaml`). The file goes through the same `visibility` filter as the rendered docs, and each download is recorded as a `docs.export` audit event.
- **A page of your own** – `readme` puts your guide, onboarding steps or release notes one click away from the reference, for the roles you choose.
- **Branding** – `theme.title` names the platform, `theme.logo` (any URL or data URI) is the icon in the top-left corner, `theme.logoDark` swaps it in dark mode, `theme.favicon` sets the tab icon.

OpenAPI descriptions are rendered as Markdown; the source is HTML-escaped before decoration and only `http(s)`, `mailto:` and relative links survive, so a document can never inject markup into the page. The `readme` file is the one place your own HTML runs — which is why it runs sandboxed, in a frame of its own.

## How Try-it-out works

Requests go through a server-side proxy (`POST /docs/api/try`) so that every call is audited and attributed to the signed-in user, CORS is never an issue, and only origins listed in the spec's `servers` (or `allowedTargets`) can be reached. The upstream receives `X-Ludin-User` and `X-Forwarded-For`.

## Repository layout

```
packages/core      ludin – framework-agnostic handler, auth, IP, audit, embedded UI
packages/express   @ludin-node/express
packages/fastify   @ludin-node/fastify
packages/koa       @ludin-node/koa
packages/hono      @ludin-node/hono
packages/node      @ludin-node/node   (plain node:http, connect, polka)
packages/nestjs    @ludin-node/nestjs
packages/ui        Preact + Vite, built into a single HTML string in core
examples/express   Petstore demo on :3000
examples/nest      @nestjs/swagger demo on :3001
```

```bash
pnpm install
pnpm build            # ui → core → adapters
pnpm typecheck        # tsc --noEmit across every package (sources + tests)
pnpm test             # core + adapter tests
pnpm dev:express      # http://localhost:3000/docs  (admin@example.com / admin)
pnpm dev:nest         # http://localhost:3001/docs
CHROMIUM_PATH=... node scripts/e2e.mjs   # browser test + screenshots (needs dev:express running)
```

## Contributing & releases

Every pull request runs the full matrix in GitHub Actions: build and tests on
Node 20, 22 and 24, `tsc --noEmit` over sources *and* tests, and the browser e2e
script (screenshots are uploaded as artifacts).

Releases are cut from a tag: bump the package versions, update
[CHANGELOG.md](CHANGELOG.md), then push `vX.Y.Z`. The release workflow verifies
the tag matches the version, rebuilds, retests and publishes every public
package with `pnpm publish -r` (which rewrites the `workspace:*` ranges). It
needs an `NPM_TOKEN` secret in the `npm` environment.

## Roadmap

- **v0.2** ✅ `readme` pages, spec download, branding, adapters for Fastify / Koa / Hono / `node:http`
- **v0.3** ✅ code samples, ⌘K palette (schema-field search), *Try it out* response validation, `ludin lint` + health score
- **v0.4** spec diff & breaking-change classification, generated changelog, environments, expiring share links
- **v0.5** MCP endpoint, OIDC / OAuth2 (Google, GitHub, Keycloak), collection & TypeScript type export
- **v1.0** stable API

MIT
