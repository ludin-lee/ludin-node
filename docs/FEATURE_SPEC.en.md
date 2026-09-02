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
import { sqliteStore } from 'ludin/store-sqlite';

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
ludin                 core (middleware, renderer, auth, IP, adapter interfaces) — minimal deps
ludin/store-sqlite    based on better-sqlite3
ludin/store-postgres  based on pg
ludin/store-prisma    reuses an existing Prisma client
ludin/store-redis     lightweight store for sessions · logs only
ludin/auth-oidc       OAuth2/OIDC adapter (post-v1)
```

Split via subpath exports so that binding-mode users never install native DB drivers.

### 4.2 Storage adapter interface (draft)

```ts
interface LudinStore {
  users: {
    findByEmail(email: string): Promise<User | null>;
    list(): Promise<User[]>;
    create(input: NewUser): Promise<User>;
    update(id: string, patch: Partial<User>): Promise<User>;
    remove(id: string): Promise<void>;
  };
  invites: {
    create(email: string, role: string, ttl: number): Promise<Invite>;
    consume(token: string): Promise<Invite | null>;
  };
  ipRules: {
    list(): Promise<IpRule[]>;
    upsert(rule: IpRule): Promise<void>;
    remove(id: string): Promise<void>;
  };
  sessions: {
    create(userId: string, meta: SessionMeta): Promise<Session>;
    get(id: string): Promise<Session | null>;
    revoke(id: string): Promise<void>;
    revokeAllForUser(userId: string): Promise<void>;
  };
  audit: {
    append(event: AuditEvent): Promise<void>;
    query(filter: AuditFilter): Promise<Page<AuditEvent>>;
  };
  readonly?: boolean;   // true for the built-in binding-mode store
}
```

Binding mode internally uses a **read-only in-memory implementation** of this interface. In other words, the core always accesses data through a store — the difference between modes is nothing more than a difference of adapters.

### 4.3 Framework adapters

The core is written as a framework-agnostic handler of the form `(standard Request object) → Response`, wrapped by thin adapters.

- Express, Fastify, Koa, NestJS (module provided), Hono / plain Node `http`
- This must be settled in the initial design so it never has to be ripped out later

### 4.4 Request processing order

```
request → IP check → (per ipPolicy) session check → role check
   → spec filtering (visibleTo) → render / API response → audit log entry
```

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

| Stage | Scope |
|---|---|
| **v0.1 (MVP)** | OpenAPI 3.x rendering + Try it out, email/password login (JWT cookie), binding-mode accounts · IPs (read-only), IP allowlist (CIDR, trustProxy, escape hatch), basic theme options, stdout audit log, Express · Fastify adapters |
| **v0.2** | Store mode (sqlite, postgres), invitation flow, role-editing UI, IP-editing UI, DB sessions · force logout, audit log UI |
| **v0.3** | Document visibility control (visibleTo), multiple specs, better search · deep links, NestJS module · Koa · Hono adapters, custom CSS · dark mode |
| **v1.0** | OIDC/OAuth2 adapters, Prisma · Redis stores, per-account IP restrictions, CSV export · retention policy, stable API frozen |

---

## 7. Open decisions

- Confirm whether the `ludin` package name is available on npm
- Frontend stack (React vs Preact vs Svelte — Preact/Svelte if bundle size wins)
- Binding-mode passwords: allow plain-text env values, or hashes only (adoption ease vs security)
- Ship a default invitation-email implementation (nodemailer dependency) vs callback only
- Default for recording Try-it-out request/response bodies in the audit log (off recommended)
