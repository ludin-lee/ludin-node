# Ludin Feature Specification v0.1

> An API documentation library for Node.js. Does everything existing OpenAPI documentation tools do, and adds a layer of **authentication · accounts · IP control · audit logging · theming** on top.
> Written: 2026-09-02 · Status: draft

---

## 1. Positioning

- One-line definition: **"a security/operations layer on top of your OpenAPI docs"**
- The reason to switch from existing documentation tools is not rendering — it is these four things:
  1. No access to the docs without logging in
  2. Developer invitations and role-based access control
  3. IP allowlist
  4. A beautiful, customizable UI
- On top of that, an **audit log** (who ran which API, and when). It is only possible because login exists, and it is the feature enterprise customers love most.
- The primary target is teams that want to expose docs in production but have been making do with nginx basic auth — or turning the docs off entirely.

---

## 2. Distribution & the two operating modes

A single plain npm middleware. Storage of accounts / IP rules / sessions / logs is separated behind a **storage adapter**, and which adapter you use determines which of the two modes you run in.

| | Code-binding mode (default) | Store mode |
|---|---|---|
| Where config lives | code + `process.env` | a DB (sqlite, postgres, mysql, mongo, redis, …) |
| Account / IP management | **read-only** — the admin screen only shows the current config | **editable** — invites, role changes, IP editing, all in the UI |
| Sessions | signed JWT cookie (stateless) | DB sessions (force logout · session revocation) |
| Audit log | stdout / custom sink callback | stored in DB + browsable in the UI |
| Invitations | not available (an explanatory notice is shown) | invite links / email delivery |
| Dependencies | as close to zero as possible | each adapter package carries its own DB driver |
| Target | individuals · small teams · 5-minute adoption | growing teams · company-wide shared docs |

**Design principle**: do not force the two modes to be identical. In binding mode, anything edited through the UI would be lost on the next deploy — so the editing UI is disabled entirely, with a notice saying "connect a store to use this".

### 2.1 Minimal usage example (binding mode)

```ts
import { ludin } from 'ludin';

app.use('/docs', ludin({
  spec: './openapi.json',
  auth: {
    users: [
      { email: 'admin@example.com', password: process.env.LUDIN_ADMIN_PW, role: 'admin' },
      { email: 'dev@example.com',   password: process.env.LUDIN_DEV_PW,   role: 'developer' },
    ],
  },
  ipAllowlist: (process.env.LUDIN_IPS ?? '').split(','),
  theme: { primary: '#0f766e', logo: '/logo.svg' },
}));
```

### 2.2 Switching to store mode

```ts
import { sqliteStore } from '@ludin/store-sqlite';

app.use('/docs', ludin({
  spec: './openapi.json',
  store: sqliteStore('./ludin.db'),
}));
```

One added `store` line switches the mode; every other option remains valid. If bound config and a store are both present, **the bound values are used only as seed (initial) data** — from then on the store is the source of truth.

---

## 3. Feature specification

### 3.1 OpenAPI rendering (parity with existing tools)

- OpenAPI 3.0 / 3.1 support; OpenAPI 2.0 (the legacy spec) is converted automatically
- Input: JSON/YAML file path, object, URL, or a function (dynamic generation)
- Grouping by tag, path/method listing, schema viewer (nested · recursive · oneOf/anyOf/allOf)
- Try it out: parameter forms, request body editor, response display, copy as cURL
- Security scheme support: apiKey, http (basic/bearer), oauth2, openIdConnect — entered credentials are kept in the browser session only
- Search (path · summary · tag), deep links (`#tag/operationId`)
- Multiple specs (switch between several services' docs inside one Ludin instance)

### 3.2 Login

- Default: email + password (bcrypt/argon2 hash). In binding mode, env values may be **plain text or a hash** (hash recommended, distinguished by prefix)
- Sessions: signed JWT cookie (HttpOnly, SameSite, Secure automatically), configurable expiry
- Without login, **every route** is blocked — the docs, the spec JSON, the Try-it-out proxy, all of it
- Brute-force protection: failure-count-based delay/lockout (in memory or in the store)
- Extension adapters (post-v1): OAuth2/OIDC (Google, GitHub, Keycloak, …), and a custom `verify(email, password)` callback to hook into existing in-house auth
- Optional: disable login entirely (`auth: false`) — for teams that only want IP restrictions

### 3.3 Account management · roles

Three roles ship by default; custom roles can be added.

| Role | View docs | Try it out | View audit log | Manage accounts/IPs |
|---|---|---|---|---|
| viewer | ○ | ✕ | ✕ | ✕ |
| developer | ○ | ○ | own entries only | ✕ |
| admin | ○ | ○ | ○ | ○ (store mode) |

- **Invitations (store mode)**: admin enters an email + role → an invite token is issued → copy the link or send it by email (the mail sender is injected via callback/adapter) → the invitee sets a password → account activated. Token expiry and re-issuing supported
- Account states: active / invited / disabled
- **Document visibility control**: specify `visibleTo: ['admin', 'partner']` at the tag / path / operationId level → the spec itself is filtered by role before it is served (removed on the server, not hidden in the UI). A key differentiator existing documentation tools cannot offer
- Binding mode: the account list and roles are displayed read-only; the invite button is disabled with a notice

### 3.4 IP allowlist

- Single IPs, CIDR (`10.0.0.0/8`), ranges, IPv6
- Proxy environments: `trustProxy` option handles `X-Forwarded-For` / `X-Real-IP` (configurable number of trusted hops)
- How IP rules combine with login is configurable: `ipPolicy: 'and' | 'or'`
  - `and` (default): must be an allowlisted IP **and** logged in
  - `or`: allowlisted IPs skip login; everyone else must log in
- Per-role / per-account IP restrictions (store mode): e.g. a specific account only from the office IP
- **Lockout escape hatch**: the `LUDIN_BYPASS_IP_CHECK=1` env var, or an option to always allow localhost. Prevents accidentally locking yourself out by blocking your own IP
- On block: log the event and respond with 404 or 403 (choose 404 to hide that the docs exist at all)

### 3.5 Audit log

- Recorded events: login success/failure, logout, docs viewed, Try-it-out executions (method · path · status code · duration; bodies optional and maskable), account/IP config changes, IP blocks
- Binding mode: structured JSON to stdout or an `onAudit(event)` callback (connect your own logger)
- Store mode: stored in the DB; filter (user · time range · path), search, and CSV export in the UI; configurable retention period
- Sensitive-data masking rules (the `Authorization` header, field-name patterns)

### 3.6 UI · theming

Scope is deliberately limited to **theming**. Component-level customization is out of scope for v1 (to avoid a maintenance explosion).

- Options: logo, favicon, service name, primary/accent colors, font, radius/density, light · dark · system mode
- Custom CSS injection (`customCss`), customizable login-screen copy and background
- Configurable sidebar group order and collapsed state
- Faster initial load than existing documentation UIs (code splitting, virtual scrolling for large specs)
- Responsive (docs readable on mobile)

---

## 4. Architecture

### 4.1 Package structure

```
ludin                  core (handler, auth, IP, audit, UI bundle, in-memory stores) — one runtime dep (yaml)
@ludin/store-sqlite    built-in node:sqlite, falling back to better-sqlite3          [shipped]
@ludin/store-postgres  based on pg                                                   [planned]
@ludin/store-prisma    reuses an existing Prisma client                              [planned]
@ludin/store-redis     lightweight store for sessions · logs only                    [planned]
@ludin/auth-oidc       OAuth2/OIDC adapter                                           [post-v1]
```

Stores are separate packages so that binding-mode users never install a DB driver. For development and tests, `createMemoryStore()` from the core offers the full store-mode surface without persistence.

### 4.2 Storage adapter interface

```ts
interface LudinStore {
  readonly?: boolean;                    // true for the built-in binding-mode store
  users: {
    findByEmail(email): Promise<StoredUser | null>;
    findById?(id): Promise<StoredUser | null>;
    list(): Promise<StoredUser[]>;
    create?(input: NewUser): Promise<StoredUser>;
    update?(id, patch): Promise<StoredUser>;
    remove?(id): Promise<void>;
  };
  ipRules: { list(): Promise<IpRule[]>; upsert?(rule): Promise<IpRule>; remove?(id): Promise<void> };
  invites?: {
    create(invite: Invite): Promise<Invite>;
    findByTokenHash(tokenHash): Promise<Invite | null>;
    list(): Promise<Invite[]>;
    markAccepted(id, at): Promise<void>;
    remove(id): Promise<void>;
  };
  sessions?: {
    create(session: Session): Promise<Session>;
    get(id): Promise<Session | null>;
    touch?(id, at): Promise<void>;
    listForUser(userId): Promise<Session[]>;
    revoke(id): Promise<void>;
    revokeAllForUser(userId): Promise<void>;
  };
  audit?: {
    append(event: AuditEvent): Promise<void>;
    query?(filter: AuditFilter): Promise<Page<AuditEvent>>;
    prune?(before: string): Promise<number>;   // retention
  };
}
```

Everything past `users` / `ipRules` is optional: a store advertises what it can do simply by implementing it, and the core reports that back to the UI as capabilities (`users`, `invites`, `ipRules`, `sessions`, `auditQuery`), which is what enables or disables each button.

Security-relevant work stays in the core, never in an adapter: password hashing, invitation token generation (only a SHA-256 hash reaches the store), session ids, and the guards that refuse a last-admin removal or a self-lockout.

Binding mode internally uses a **read-only in-memory implementation** of this interface. In other words, the core always accesses data through a store — the difference between modes is nothing more than a difference of adapters.

### 4.3 Framework adapters

The core is written as a framework-agnostic handler of the form `(standard Request object) → Response`, wrapped by thin adapters.

| Package | Framework | Mount |
|---|---|---|
| `@ludin/express` | Express 4 / 5 | `app.use('/docs', ludin({ ... }))` |
| `@ludin/fastify` | Fastify 4 / 5 | `app.register(ludin({ ... }), { prefix: '/docs' })` |
| `@ludin/koa` | Koa 2 | `app.use(ludin({ basePath: '/docs', ... }))` |
| `@ludin/hono` | Hono 4 (Node · Bun · Deno · edge) | `mountLudin(app, { basePath: '/docs', ... })` |
| `@ludin/nestjs` | NestJS 9 / 10 / 11 | `setupLudin(app, '/docs', document)` or `LudinModule.forRoot({ ... })` |
| `@ludin/node` | plain `node:http`, connect, polka | `docs(req, res, next)` or `createLudinServer({ ... })` |

- Adapters only translate request / response shapes; every route still goes through the core pipeline (§4.4). Adding a framework means adding an adapter package, never touching the core.
- Runtimes that do not expose the peer address (Cloudflare Workers, Vercel Edge …) need `trustProxy` plus a proxy header for the IP rules to work.
- This must be settled in the initial design so it never has to be ripped out later

### 4.4 Request processing order

```
request → IP check → (per ipPolicy) session check → role check
   → spec filtering (visibleTo) → render / API response → audit log entry
```

### 4.5 Store-mode API surface

All of these sit behind the same pipeline (§4.4) and need `admin:write` unless noted. When the installed store cannot do the job they answer `501 store_required`, which is exactly what binding mode returns.

| Method · path | Purpose |
|---|---|
| `POST /api/admin/users` · `PATCH|DELETE /api/admin/users/:id` | create / edit / delete accounts |
| `POST /api/admin/users/:id/revoke-sessions` | force sign-out |
| `POST /api/session/revoke-all` | sign out everywhere (any signed-in user) |
| `POST /api/admin/ip` · `DELETE /api/admin/ip/:id` | edit IP rules (refuses self-lockout unless `force`) |
| `POST /api/admin/invites` · `DELETE /api/admin/invites/:id` | issue / revoke an invitation |
| `GET /api/invites/info` · `POST /api/invites/accept` | **public**: the accept screen and setting the password |
| `GET /api/audit` · `GET /api/audit.csv` | browse / export (`audit:read`, or `audit:read:self` scoped to yourself) |

---

## 5. Options schema summary

```ts
interface LudinOptions {
  spec: string | object | (() => Promise<object>) | SpecEntry[];
  store?: LudinStore;
  auth?: false | {
    users?: BoundUser[];                 // binding mode
    session?: { secret?: string; ttl?: string };
    verify?: (email, password) => Promise<User | null>;
    providers?: AuthProvider[];          // OIDC etc.
    lockout?: { attempts: number; window: string };
  };
  ipAllowlist?: string[];
  ipPolicy?: 'and' | 'or';
  trustProxy?: boolean | number;
  roles?: Record<string, Permission[]>;  // custom roles
  visibility?: Record<string, string[]>; // tag/path → roles
  audit?: { sink?: (e: AuditEvent) => void; mask?: string[]; retentionDays?: number };
  theme?: ThemeOptions;
  basePath?: string;
}
```

---

## 6. Roadmap

| Stage | Status | Scope |
|---|---|---|
| **v0.1 (MVP)** | done | OpenAPI 3.x rendering + Try it out, email/password login (JWT cookie), binding-mode accounts · IPs (read-only), IP allowlist (CIDR, trustProxy, escape hatch), basic theme options, stdout audit log, Express · Fastify adapters |
| **v0.2** | done | Store mode (sqlite), invitation flow, role-editing UI, IP-editing UI, DB sessions · force logout, audit log UI · CSV · retention, per-account IP restrictions |
| **v0.3** | done | Document visibility control (visibleTo), multiple specs, better search · deep links, NestJS module · Koa · Hono · node:http adapters, custom CSS · dark mode |
| **v1.0** | planned | OIDC/OAuth2 adapters, Postgres · Prisma · Redis stores, stable API frozen |

---

## 7. Open decisions

- Confirm whether the `ludin` package name is available on npm
- Frontend stack (React vs Preact vs Svelte — Preact/Svelte if bundle size wins)
- Binding-mode passwords: allow plain-text env values, or hashes only (adoption ease vs security)
- Ship a default invitation-email implementation (nodemailer dependency) vs callback only
- Default for recording Try-it-out request/response bodies in the audit log (off recommended)
