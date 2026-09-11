# Ludin — Feature Spec v0.6

> An API documentation library for Node.js. Everything existing OpenAPI documentation tools do, plus a layer of **authentication · accounts · IP control · audit logging · theming** on top.
> Written: 2026-09-02 · Updated: 2026-09-10 · Status: draft

---

## 1. Positioning

- One line: **"a security / operations layer on top of OpenAPI docs"**
- The reason to switch away from existing documentation tools is not rendering, it is these four:
  1. No login, no docs
  2. Role-based access control and role-aware document filtering
  3. IP allowlist
  4. A beautiful, customizable UI
- On top of that, an **audit log** (who ran which API, and when). It is only possible once there is a login, and it is the feature enterprise customers like most.
- The first target: teams that want docs in production but end up patching over it with nginx basic auth, or just turning docs off.

---

## 2. Shape of the deployment

A single npm middleware. **No database, no build step, no extra service.** Accounts, IP rules and roles all come from code and `process.env`, and changing them is a redeploy.

| | |
|---|---|
| Configuration lives in | code + `process.env` |
| Account / IP management | **read-only** — the admin screen shows the current configuration |
| Sessions | signed JWT cookie (stateless) |
| Audit log | stdout / custom sink callback |
| Runtime dependencies | one in the core (`yaml`) |

**Design principle**: nothing that is not needed to guard a document. Editing accounts from the UI drags in a database, migrations and a session store, and all it buys is "add an account without a redeploy". Keep accounts in code, and keep the library focused on watching the front door.

### 2.1 Minimal example

```ts
import { ludin } from '@ludin-docs/express';

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

### 2.2 Attaching your own HTML page

```ts
app.use('/docs', ludin({
  spec: './openapi.json',
  readme: { enabled: true, path: './docs/guide.html', label: 'Guide' },
}));
```

One `readme` line adds a button to the top bar and puts that HTML file behind **the same login, IP and role checks** as the reference. Details in §3.7.

---

## 3. Features

### 3.1 OpenAPI rendering (parity with existing tools)

- OpenAPI 3.0 / 3.1, with OpenAPI 2.0 (the older spec) converted automatically
- Input: a JSON/YAML file path, an object, a URL, or a function (generated at runtime)
- Grouping by tag, path/method lists, schema viewer (nested, recursive, oneOf/anyOf/allOf)
- Try it out: parameter form, request body editor, response view, cURL copy
- APIs that authenticate with a session cookie (an `/admin` or `/console` living next to the docs) can be tried too: with `forwardCookies` on, the proxy hands the caller's **own** cookies to the target. Only when it shares the docs' **origin** — cookies for any other origin never reach ludin, so there is nothing to forward. Ludin's own session and share cookies are always left out, and a list of names narrows it further. Off by default. A `Set-Cookie` in the response comes back as data rather than landing in the browser, so sign in to the target first
- Security schemes: apiKey, http (basic/bearer), oauth2, openIdConnect — credentials entered stay in the browser session only
- Search (path, summary, tag) and deep links (`#tag/operationId`)
- Multiple specs (switch between several services in one ludin)
- Spec export: download the document as JSON/YAML from the overview screen. What goes out is **filtered for the caller's role**, and each download is recorded as a `docs.export` audit event

### 3.2 Login

- Default: email + password (scrypt built in, bcrypt/argon2 optional). Values from env may be **plain text or a hash** (a hash is recommended; the prefix tells them apart)
- Session: signed JWT cookie (HttpOnly, SameSite, Secure automatically), configurable expiry
- Without a login, **every route** is blocked: the docs, the spec JSON, the readme page, the Try-it-out proxy
- Brute-force protection: delay / lockout based on failed attempts (in memory)
- Extension adapters (post-v1): OAuth2/OIDC (Google, GitHub, Keycloak …). Today a custom `verify(email, password)` callback already plugs into your own auth system
- Optional: turn login off entirely (`auth: false`) — for IP-only restriction

### 3.3 Accounts · roles

Three roles out of the box, custom roles supported.

| Role | Read docs | Try it out | View configuration |
|---|---|---|---|
| viewer | ○ | ✕ | ✕ |
| developer | ○ | ○ | ✕ |
| admin | ○ | ○ | ○ |

- Accounts come from the `auth.users` array or the `auth.verify` callback. The admin screen is **read-only**: the account list, IP rules, roles and permissions, visibility rules, and the configured readme page
- **Document visibility**: mark a tag, path or operationId with `visibleTo: ['admin', 'partner']` and the spec itself is filtered per role (removed on the server, not hidden in the UI). The key differentiator existing documentation tools cannot offer
- Per-account IP restriction: attach `ipAllowlist` to an account and it can only log in and read from those addresses

### 3.4 IP allowlist

- Single IPs, CIDR (`10.0.0.0/8`), ranges, IPv6
- Behind a proxy: `trustProxy` handles `X-Forwarded-For` / `X-Real-IP` (number of hops to trust)
- How it combines with login: `ipPolicy: 'and' | 'or'`
  - `and` (default): the IP must match **and** the user must log in
  - `or`: a matching IP skips the login, anything else must log in
- Per-account IP restriction: this account only from the office
- **Lockout escape hatch**: `LUDIN_BYPASS_IP_CHECK=1`, or the automatic localhost bypass. Blocking your own address must not lock you out
- Blocked requests are logged, and answer 403 or 404 (404 when the deployment should not even admit it exists)

### 3.5 Audit log

- Recorded events: login success/failure, logout, docs view, spec download, readme view, Try-it-out calls (method, path, status, duration; bodies optional and maskable), IP blocks
- Structured JSON goes to stdout or the `audit.sink(event)` callback. Retention, querying and search belong to the log pipeline you already run
- Masking rules for sensitive data (the `Authorization` header, field-name patterns)

### 3.6 UI · theming

Customization is deliberately capped at **theme level**. Swapping components out is excluded from v1 (it explodes the maintenance surface).

- Options: logo (URL or data URI, with a separate `logoDark` for dark mode), favicon, service name (platform title), primary/accent colors, font, radius/density, light/dark/system mode
- Custom CSS injection (`customCss`), custom login-screen copy and background
- Sidebar group order and collapsed state
- Faster first load than existing documentation UIs (a single ~110 KB HTML bundle, 36 KB gzipped)
- The UI chrome ships in 9 languages (English default; Korean, Japanese, Chinese, Spanish, French, German, Portuguese, Russian): auto-detected from the browser, switchable in the user menu (persisted per viewer), or forced with `theme.language`. Spec content (summaries, descriptions) is never translated — it belongs to the document
- Responsive (docs are readable on mobile)

### 3.7 Readme page (your HTML, directly)

The reference is rarely the whole story: a guide, an onboarding checklist, release notes. If you already have the HTML, all ludin needs is the path to the file.

```ts
readme: { enabled: true, path: './docs/guide.html', label: 'Guide', visibleTo: ['admin'] }
readme: './docs/guide.html'   // shorthand, everything else default
```

| Option | Meaning |
|---|---|
| `enabled` | `false` hides the button without deleting the config. Default `true` |
| `path` | Path to the HTML file. Absolute, or relative to `process.cwd()` |
| `label` | Text of the top-bar button. Default `README` |
| `visibleTo` | Roles that may open it. Default: every role that can read the docs |

- The page is served at `GET {basePath}/readme` and goes through **exactly the same pipeline** as every other route (IP → session → role). Each view is recorded as a `docs.readme` audit event
- The file goes out untouched. Instead, the response carries `Content-Security-Policy: sandbox`, putting it in an **opaque origin**, and the UI frames it in an iframe with the `sandbox` attribute → the file's own CSS and scripts work, while nothing in it can reach the session cookie or the docs UI's DOM
- It is cached by mtime and re-read when the file changes, so editing the page needs no restart
- Size limit 5 MB. A missing or oversized file is logged with the reason on the server and answered with `404`

### 3.8 Docs you can trust (v0.3)

Four features that make the reference something a reader can rely on. All the heavy work happens in the core (the bundle budget, §6); the UI only renders `/api/*` responses.

- **Code samples** — ready-to-paste snippets per operation in six flavours (cURL, fetch, axios, Python, Go, `.http`), generated by the core with path parameters, required query/header parameters, the auth header of the effective security scheme, and a request-body example filled in. Built from the **role-filtered** document: a hidden operation yields a 404, never a sample. `GET /api/samples?method=&path=`
- **⌘K command palette** — searches paths, summaries, operationIds, tags **and schema field names** (request and response, `$ref`s resolved). The index comes from `GET /api/search-index`, built server-side from the filtered document; the UI only fuzzy-matches. A field match shows a `field:` badge and jumps to the owning operation.
- **Response validation for Try it out** — every proxied JSON response is compared with the documented schema for its status code (exact code, `2XX` class, then `default`), and the result rides along in the `/api/try` response (`validation`). Checks: type, required, enum, nullable, format (date-time, date, email, uuid, uri), oneOf/anyOf. A deliberate minimal validator of our own — the zero-dependency rule (§7) — that reports drift rather than certifying conformance. Hidden operations come back `checked: false`, leaking nothing.
**Two things that decide whether the badge can be trusted:**

- **Envelope APIs.** When every response is wrapped — `{ success, message, data }` from a framework interceptor, say — the documented schema describes what sits inside `data`, not the whole body. Without knowing that, validation flags every single endpoint. Tell it once:
  ```ts
  validate: { envelope: { dataPath: 'data' } }   // optionally + schema, to check the wrapper too
  ```
  Real drift inside the payload is still reported, with `$.data.…` paths. A response that arrives unwrapped is validated whole, since some endpoints legitimately answer raw and crying wolf on those would teach people to ignore the badge.
- **Undocumented status codes are reported, not skipped.** If a POST answers `201` while the document only declares `200` (the NestJS default, unless `@HttpCode` or `@ApiCreatedResponse` says otherwise), there is nothing to compare against — and staying silent would let the absence of a badge read as "the response matches". Ludin names the status and lists what *is* documented.
- **`ludin lint` + health score** — `npx ludin lint spec.yaml [--min 80] [--json]` checks the document (missing summaries, operationIds, descriptions, untagged operations, bodies and responses without schemas, no 2xx, no servers) and prints a health score: the percentage of checks passing, stable across spec sizes. The same result is served at `GET /api/lint` on the filtered document, and the overview screen shows it as a scorecard with the issue list a click away. Rules a team deliberately does not follow can be skipped — `lint: { ignore: ['param-description'] }` in the options, or `--ignore` on the CLI — so the score and the CI gate reflect only the rules that matter.

### 3.9 Changes you can follow (v0.4)

Point ludin at the previous version of a document and it says what moved — and, more importantly, **what breaks callers**.

```ts
ludin({ spec: './openapi.yaml', diff: { baseline: './openapi.v1.yaml' } })
// per spec: { name: 'Partner', spec: current, baseline: previous }
```

- `GET /api/diff` returns the classified changes; a **Changes** button appears in the top bar when a baseline is configured
- `ludin diff before.yaml after.yaml [--fail-on-breaking] [--json]` puts the same check in CI
- **Direction decides what breaks.** A request must keep accepting what callers send; a response must keep providing what callers read. So a newly required property breaks requests, a removed property breaks responses, a narrowed enum breaks requests, a widened one breaks responses
- Classified as breaking: removed path or operation, newly required parameter or property, parameter that became required, changed type, removed 2xx response, request body that became required, newly required authentication
- Both sides go through the role filter, so a diff never reveals an operation the viewer cannot otherwise see
- The baseline is passed in, never written by ludin — the "no persistent state" constraint (§6) holds

**Release notes (v0.6).** The classified change list is release-note material as it stands. The same list goes out as Markdown from two places:

- `ludin diff before.yaml after.yaml --markdown` — writes Markdown to stdout in two sections, **Breaking** and **Other changes**, grouped by path. Meant to be piped straight into a GitHub release body or a PR comment from CI; English only
- The **Copy as release notes** button on the Changes screen — turns the `/api/diff` response the UI already holds into Markdown of the same shape, in the UI's current language. No new API call, no new work in the core

The two outputs share one structure and differ only in language. Classification happens in exactly one place (`diff.ts`), so the CLI and the screen cannot disagree.

### 3.10 Expiring share links (v0.4)

Hand a partner a link that opens the documentation for three days and then stops working — without creating an account for them.

```ts
ludin({ spec: './openapi.yaml', share: { enabled: true, maxTtl: '30d' }, auth: { ... } })
```

An admin mints one from the administration screen (or `POST /api/share`), choosing the role, the lifetime, optionally a single spec, and whether *Try it out* is allowed.

**A link is an identity, not a bypass.** It resolves *inside* the pipeline (§4.4), after the IP check and before the role check, so:

- the **IP allowlist still applies** — a partner outside it still cannot get in; widen the allowlist deliberately if that is the intent
- `visibility` still filters the document for the link's role
- the link **can never reach the admin surface**, and an admin-capable role is refused when the link is minted *and* re-checked on every request
- *Try it out* is **off unless the link was created with it on** — a share link reads
- a link may be **locked to one spec**, and then the other specs are not even listed

The token is signed in its own HMAC namespace, so a share token can never be presented as a session cookie, nor a session as a share. On first use it moves from the URL into an HttpOnly cookie, so it stops travelling in referrers, history and screenshots.

**The honest limitation**: the grant is stateless, because there is no store to keep it in (§6). A single link therefore cannot be revoked — rotating the session secret invalidates all of them at once. Creation is recorded as a `share.created` audit event, and every request made through a link is attributed to `share:<label>`.

### 3.11 OpenAPI 3.1 webhooks (v0.5)

A 3.1 document can declare `webhooks` alongside `paths`: operations **the API calls on you**, rather than ones you call. Until now they rendered as nothing at all.

- Webhooks appear in the sidebar and the ⌘K index, marked, and default to a `webhooks` group when untagged
- The operation page frames them correctly: the request body is labelled *the payload you will receive*, and there is no Try it out — you cannot send a call that someone else makes
- **`visibility` filters them exactly like paths.** Without this an operation hidden from a role could leak simply by living in the other container, which would quietly undo §3.3
- Lint and the health score cover webhook operations as well

Note: an endpoint a *provider* calls on your server (a payment or billing callback, say) is an ordinary path, and is correctly documented under `paths`. The `webhooks` section is for the other direction — calls your API makes to its consumers.
### 3.12 MCP endpoint (v0.5)

An agent that can read your API documentation is useful; an agent that can read *everything* is a liability. The MCP endpoint hands an agent the **same document a person with that identity would get**, under the same rules.

```ts
ludin({ spec, mcp: { enabled: true }, share: { enabled: true }, auth: { ... } })
```

`POST {basePath}/api/mcp` speaks JSON-RPC 2.0 (`initialize`, `tools/list`, `tools/call`). Tools:

| tool | |
|---|---|
| `list_operations` | the operations this caller may see |
| `search_operations` | by path, summary, tag — and by **schema field name** |
| `get_operation` | parameters, body schema, responses, code samples |
| `call_operation` | execute one; offered **only** when the caller has `docs:try` |

**Authentication reuses what already exists** — this closes the open decision in §7. An agent presents a share link as `Authorization: Bearer <token>`, or a session cookie for a person's own agent. No new credential type, which means no second thing to leak, expire or revoke.

The guarantees are the pipeline's, not the endpoint's:

- the **IP allowlist** applies, because identity is resolved after it (§4.4)
- documents are **role-filtered**; an operation hidden from that role is absent from the listing, the search index and `get_operation` alike
- **execution needs `docs:try`** — a read-only share link is not even *offered* `call_operation`, and is refused if it asks anyway
- calls leave through the **same egress path** as the browser's Try it out, so the origin allowlist, header scrubbing and audit trail cannot be sidestepped by using the other entry point
- every tool call is audited as `mcp.tool`, attributed to `share:<label>` or the signed-in user

### 3.13 Take it to the tools you use (v0.6)

Reading a document and working with it are different things. Developers call from an API client and type against the schemas in code. The core generates both from the **role-filtered document**. There is no new configuration — nothing here reveals more than `/api/spec.json` already does.

| Endpoint | Output |
|---|---|
| `GET /api/export/postman` | Postman Collection v2.1 JSON. The other major API clients import the same format, so one format is enough |
| `GET /api/export/types.d.ts` | A TypeScript declaration file |

Both need `docs:read`, take `?spec=` to pick a document, and are recorded as a `docs.export` audit event carrying the `format`. They sit next to the download buttons on the overview screen, and a visitor on a share link can fetch them too — read access is export access.

**The collection.** The sidebar's tag groups become folders. Each request is built from the same input as the code samples (§3.8) — path parameters as variables filled with example values, required query and header parameters, the auth of the effective security scheme, a JSON body example — so the samples and the collection never describe different requests. The server URL is a `{{baseUrl}}` variable and credentials are `{{token}}` / `{{apiKey}}` variables, so no secret ever lands in the collection file. Webhooks (§3.11) are left out: they are calls you cannot make.

**The types.** A generator of our own, under the zero-dependency rule (§6). The output has two parts:

- `components.schemas` → `export interface` / `export type` under their own names. `$ref` becomes a type-name reference, `allOf` an intersection, `oneOf` / `anyOf` a union, `enum` a union of literals, `nullable` a `| null`, `additionalProperties` a `Record`, properties outside `required` are optional, and `description` becomes JSDoc. Whatever cannot be expressed stays `unknown`; the generator never narrows on a guess
- `operations` → per `operationId` (method + path when there is none): `parameters.path` / `query` / `header`, `requestBody`, and `responses` per status code. Webhooks are included as *the payload you will receive* — that is the type the handler author needs

**Only reachable components are exported.** The `visibility` filter removes operations but leaves `components` alone. Schema names and fields give away the existence of a hidden operation on their own, so the type file carries **only the schemas reachable through `$ref` from visible operations**. It is the same rule the search index and the samples already follow; the collection is per-operation and satisfies it by construction.

**CLI.** `ludin export <spec> --format postman|types [--out <file>]` runs the same generators without a server. Like `lint` and `diff` it has no identity, so it works from the whole, unfiltered document — for code-generation pipelines and CI artifacts.

---

## 4. Architecture

### 4.1 Package structure

```
@ludin-docs/core            core (handler, auth, IP, audit, UI bundle) — 1 runtime dependency (yaml)
@ludin-docs/express         Express 4 / 5                                                 [released]
@ludin-docs/fastify         Fastify 4 / 5                                                 [released]
@ludin-docs/koa             Koa 2                                                         [released]
@ludin-docs/hono            Hono 4 (Node · Bun · Deno · edge)                             [released]
@ludin-docs/node            plain node:http, connect, polka                               [released]
@ludin-docs/nestjs          NestJS 9 / 10 / 11                                            [released]
@ludin-docs/auth-oidc       OAuth2/OIDC adapter                                           [v0.7]
```

The core has exactly one runtime dependency, `yaml`. The UI (`packages/ui`, Preact + Vite) is built into a single HTML string compiled into the core, so nothing static needs to be served after install.

### 4.2 Where accounts and configuration come from

```ts
interface BoundUser {
  email: string;
  password: string;        // plain text or a hash ($scrypt$ · bcrypt · argon2)
  role?: Role;             // default 'developer'
  name?: string;
  ipAllowlist?: string[];  // IP restriction for this account only
}
```

- Accounts come from either `auth.users` (a static list) or `auth.verify(email, password)` (your own auth system). The core consults it only at login, and puts the result into a signed cookie
- IP rules come from the `ipAllowlist` array, roles from `roles`, visibility from `visibility`. All of it is validated at startup: an unknown role name or a malformed CIDR throws immediately
- Everything security-related lives in the core: password hashing and verification, session signing, IP matching, brute-force lockout, and reading the readme file with its sandbox headers

### 4.3 Framework adapters

The core is a framework-agnostic `(standard Request) → Response` handler, wrapped by thin adapters.

| Package | Framework | Mount |
|---|---|---|
| `@ludin-docs/express` | Express 4 / 5 | `app.use('/docs', ludin({ ... }))` |
| `@ludin-docs/fastify` | Fastify 4 / 5 | `app.register(ludin({ ... }), { prefix: '/docs' })` |
| `@ludin-docs/koa` | Koa 2 | `app.use(ludin({ basePath: '/docs', ... }))` |
| `@ludin-docs/hono` | Hono 4 (Node · Bun · Deno · edge) | `mountLudin(app, { basePath: '/docs', ... })` |
| `@ludin-docs/nestjs` | NestJS 9 / 10 / 11 | `setupLudin(app, '/docs', document)` or `LudinModule.forRoot({ ... })` |
| `@ludin-docs/node` | plain Node `http`, connect, polka | `docs(req, res, next)` or `createLudinServer({ ... })` |

- An adapter only converts request/response shapes; every route still goes through the core pipeline (§4.4). Supporting a new framework = a new adapter package, no core changes.
- Runtimes that do not expose the peer address (Cloudflare Workers, Vercel Edge …) need `trustProxy` plus proxy headers for IP rules to work.

### 4.4 Request pipeline

```
request → IP check → (per ipPolicy) session check → role check
   → spec filtering (visibleTo) → render / API response → audit event
```

### 4.5 API surface

Everything goes through the same pipeline (§4.4). No route bypasses it.

| Method · path | Purpose |
|---|---|
| `GET /` | The docs UI (a single HTML page) |
| `GET /readme` | The configured HTML page (`docs:read` + `visibleTo`, sandbox headers) |
| `GET /api/me` | **public**: session state, permissions, whether the readme button shows |
| `POST /api/login` · `POST /api/logout` | **public**: login / logout |
| `GET /api/specs` · `GET /api/spec` | Spec list / role-filtered document (`docs:read`) |
| `GET /api/spec.json` · `GET /api/spec.yaml` | The role-filtered document as a file (`docs:read`) |
| `POST /api/try` | Server-side Try-it-out proxy, with response validation (`docs:try`) |
| `GET /api/samples` | Code samples for one operation, from the filtered document (`docs:read`) |
| `GET /api/search-index` | ⌘K index: operations + schema field names, filtered (`docs:read`) |
| `GET /api/lint` | Documentation health score for the filtered document (`docs:read`) |
| `GET /api/diff` | Classified changes against the configured baseline (`docs:read`) |
| `GET /api/export/postman` | Postman v2.1 collection, from the filtered document (`docs:read`) |
| `GET /api/export/types.d.ts` | TypeScript declarations, only schemas reachable from visible operations (`docs:read`) |
| `POST /api/mcp` | MCP JSON-RPC endpoint for agents (`docs:read`; execution needs `docs:try`) |
| `POST /api/share` | Mint an expiring share link (`admin:read`) |
| `GET /api/admin` | The current configuration (`admin:read`, read-only) |

Mutating requests require the `X-Requested-With: ludin` header (CSRF protection).

---

## 5. Configuration schema (summary)

```ts
interface LudinOptions {
  spec: string | object | (() => Promise<object>) | SpecEntry[];
  auth?: false | {
    users?: BoundUser[];
    session?: { secret?: string; ttl?: string; cookieName?: string };
    verify?: (email, password) => Promise<AuthUser | null>;
    lockout?: { attempts: number; window: string };
  };
  ipAllowlist?: string[];
  ipPolicy?: 'and' | 'or';
  ipAllowlistRole?: Role;
  trustProxy?: boolean | number;
  allowLocalhost?: boolean;
  hideOnBlock?: boolean;
  roles?: Record<string, Permission[]>;  // custom roles
  visibility?: Record<string, string[]>; // tag/path → roles
  readme?: string | { enabled?: boolean; path: string; label?: string; visibleTo?: Role[] };
  audit?: { sink?: (e: AuditEvent) => void | false; mask?: string[]; recordBodies?: boolean };
  lint?: { ignore?: string[] };
  validate?: { envelope?: { dataPath: string; schema?: object } };
  diff?: { baseline?: SpecSource };
  mcp?: { enabled?: boolean };
  share?: { enabled?: boolean; maxTtl?: string };
  theme?: ThemeOptions;
  allowedTargets?: string[];
  forwardCookies?: boolean | string[];
  basePath?: string;
}
```

---

## 6. Roadmap

| Stage | Status | Scope |
|---|---|---|
| **v0.1 (MVP)** | done | OpenAPI 3.x rendering + Try it out, email/password login (JWT cookie), accounts & IP configuration (read-only admin screen), IP allowlist (CIDR, trustProxy, escape hatch), basic theme options, stdout audit log, Express & NestJS adapters |
| **v0.2** | done | Readme page (your HTML, directly), spec export, document visibility (visibleTo), multiple specs, logo & dark-mode branding, Fastify / Koa / Hono / node:http adapters |
| **v0.3 — "docs you can trust"** | done | Code samples in six flavours (curl, fetch, axios, python, go, `.http`, with server URL, auth header and body example filled in), ⌘K command palette (searching **schema field names** as well as paths, summaries and operationIds), response schema validation for Try it out, `ludin lint` + a documentation health score (§3.8) |
| **v0.4 — "changes you can follow"** | done | Spec diff and breaking-change classification (removed path, new required field, narrowed enum, changed type, dropped response code), global server selector + auth chaining, expiring share links (§3.9 · §3.10) |
| **v0.5 — "a catalogue, and agents"** | done | MCP endpoint (with the per-role spec filter applied as-is), OpenAPI 3.1 webhooks rendering, envelope-aware validation + reporting of undocumented status codes (§3.11 · §3.12) |
| **v0.6 — "take it to the tools you use"** | planned | Postman collection · TypeScript type export (role-filtered, reachable schemas only), `ludin export` CLI, diff → release-notes Markdown (`--markdown` + copy from the screen), CHANGELOG backfill for 0.3–0.5 (§3.13 · §3.9) |
| **v0.7 — "sign in with your company account"** | planned | `@ludin-docs/auth-oidc` — OIDC / OAuth2 login (discovery, PKCE, JWKS), claims → role mapping, coexists with users/verify, stays stateless (state and nonce in signed cookies) |
| **v1.0** | planned | Stable API |

The "generated changelog page" listed under v0.4 became the release-notes export in v0.6; the collection and type export listed under v0.5 moved to v0.6; the OIDC adapter moved to v0.7.

During v0.2 a database-backed store mode (account editing, invitations, session revocation, an audit log browser) was built and then removed before release. It was not needed to guard the front door of a document, and the database, migrations and drivers raised the cost of adopting the library. Accounts belong in code; logs belong in the log pipeline you already run.

Two constraints run across the whole roadmap:

- **The bundle budget.** The UI is a single HTML file (26 KB gzip today) and `vite-plugin-singlefile` rules out code splitting. So heavy work — diffing, linting, the search index, code sample generation — happens in the core, and the UI only renders the `/api/*` response.
- **No persistent state.** Files, env and `localStorage` are all there is. Features that need storage — comments, read receipts, shared history — are answered with an integration, not with a refusal.

---

## 7. Open decisions

- ~~Confirm whether the `ludin` package name is available on npm~~ → blocked by the similar-name policy, published as `@ludin-docs/core` (2026-09-09)
- Passwords: allow plain text from env, or hashes only (ease of adoption vs security)
- Whether to grow the readme page into several pages (tabs), or keep it single
- Whether `readme.path` should also accept a Markdown (`.md`) file (HTML only today)
- Default for recording Try-it-out request/response bodies in the audit log (off recommended)
- ~~Where the baseline snapshot for a spec diff comes from~~ → passed in the config (`diff.baseline` / `SpecEntry.baseline`); ludin writes nothing (2026-09-09)
- ~~How a share link passes the request pipeline~~ → resolved as an identity inside the pipeline, never a separate route (2026-09-09)
- ~~Authentication for the MCP endpoint~~ → share links presented as `Authorization: Bearer`, or a session cookie; no new credential type (2026-09-10)
- Whether to bring store mode back: hold until demand for comments and read receipts actually accumulates vs ship it as a separate opt-in package
