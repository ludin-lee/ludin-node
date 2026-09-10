# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the packages are
versioned together.

## [0.6.0] — 2026-09-10

### Added

- **Export to the tools you use.** `GET /docs/api/export/postman` hands out a
  Postman v2.1 collection and `GET /docs/api/export/types.d.ts` a TypeScript
  declaration file, both generated from the role-filtered document and
  recorded as `docs.export`. Credentials are collection variables
  (`{{token}}`, `{{apiKey}}`), never literals, and `{{baseUrl}}` resolves a
  relative server URL against the request origin. The type file carries only
  schemas reachable by `$ref` from operations the caller can see — the
  visibility filter removes operations but leaves `components` alone, and a
  schema name is enough to give a hidden operation away. Read access is
  export access, so a share link can fetch both.
- **`ludin export <spec> --format postman|types [--out file]`** runs the same
  generators without a server. Like `lint` and `diff` it has no caller and so
  no role, and works from the whole document.
- **Release notes from a diff.** `ludin diff a.yaml b.yaml --markdown` prints
  the classified changes as Markdown (Breaking / Other changes, grouped by
  path), and the Changes screen gains *Copy as release notes* in the viewer's
  language. Classification still happens only in the core, so the CLI and the
  screen cannot disagree about what breaks.

### Changed

- Code samples and the Postman collection are built from one resolver, so the
  two can no longer describe different requests.
- The express example configures `diff.baseline`, so the Changes screen is
  reachable in the demo.
- CHANGELOG entries for 0.3.0 through 0.5.0 were written after the fact; the
  0.2.0 section is marked unpublished, since it shipped inside 0.3.0.

## [0.5.0] — 2026-09-10

### Added

- **MCP endpoint for agents.** `mcp: { enabled: true }` serves JSON-RPC 2.0
  at `POST /docs/api/mcp` with four tools: `list_operations`,
  `search_operations` (schema field names included), `get_operation` (with
  code samples) and `call_operation`. An agent authenticates the way a person
  does — a session cookie, or a share link as `Authorization: Bearer` — so
  the IP allowlist, roles and `visibility` all apply, `call_operation` is only
  offered to callers with `docs:try`, and calls leave through the same proxy
  as the browser's Try it out. Every tool call is audited as `mcp.tool`.
- **OpenAPI 3.1 webhooks.** `webhooks` render alongside `paths`, marked in
  the sidebar and the ⌘K index, with the request body shown as the payload
  you will receive and no Try it out. `visibility` filters them exactly like
  paths, and lint includes them.
- **Envelope-aware validation.** `validate: { envelope: { dataPath: 'data',
  schema? } }` tells the response validator that the documented schema
  describes the payload inside a wrapper. Unwrapped responses are still
  checked whole.

### Changed

- The validator now reports a response whose status code is not documented
  (a `201` where only `200` is described) instead of silently skipping it,
  listing the codes the document does have.

## [0.4.0] — 2026-09-09

### Added

- **Spec diff with breaking-change classification.** `diff: { baseline }` (or
  `baseline` per spec entry) enables `GET /docs/api/diff` and a *Changes*
  button in the top bar; `ludin diff before.yaml after.yaml
  [--fail-on-breaking] [--json]` runs the same check in CI. Direction decides
  what breaks: a newly required property breaks requests, a removed one
  breaks responses. Both sides are role-filtered.
- **Expiring share links.** `share: { enabled: true, maxTtl }` lets an admin
  mint a link (from the Administration screen or `POST /docs/api/share`)
  with a role, a lifetime, optionally one spec and optionally Try it out. A
  link is an identity inside the pipeline: the IP allowlist and `visibility`
  still apply, it can never reach admin, and every request is attributed to
  `share:<label>`. Tokens are signed in their own HMAC namespace and move
  from the URL into an HttpOnly cookie on first use.
- **Auth chaining.** A token found in a Try-it-out response (`accessToken`,
  `access_token`, `token`, `jwt`, …) is reused for later requests under every
  token-bearing security scheme; a checkbox turns capture off.
- **Copy response / Copy report.** The report bundles endpoint, request,
  response, timing and any schema mismatch into one pasteable block, with
  `Authorization`, `Cookie` and api-key headers masked.
- Try-it-out inputs persist per operation, with a history of the last 20
  sends; pin operations to the top of the sidebar.
- `lint: { ignore: [...] }` and `ludin lint --ignore` drop rules a team does
  not enforce from the score and the CI gate.
- Lint issue messages are localized in the UI via stable rule keys.

## [0.3.2] — 2026-09-09

### Added

- A global server selector in the top bar: pick the base URL once and every
  operation's Try it out follows it. The per-operation server field is gone.
- Sidebar sort toggle: order each tag group by method (GET → DELETE).

## [0.3.1] — 2026-09-09

### Added

- UI chrome in nine languages (English, Korean, Japanese, Chinese, Spanish,
  French, German, Portuguese, Russian), resolved from the viewer's choice,
  `theme.language`, then the browser. Spec content is never translated.
- Collapsible JSON tree for examples and Try-it-out responses.
- Resizable sidebar; nav items show operation summaries with a toggle to
  paths.

### Fixed

- The health score reads as a percentage, and opening the issue list no
  longer reflows the overview cards.

## [0.3.0] — 2026-09-09

First published release. Everything listed under 0.2.0 below shipped here.

### Added

- **Code samples** for every operation in cURL, fetch, axios, Python, Go and
  `.http`, with path parameters, required query/header parameters, the auth
  header of the effective security scheme and a request body example filled
  in. `GET /docs/api/samples?method=&path=`, generated from the role-filtered
  document.
- **⌘K command palette** searching paths, summaries, operationIds, tags and
  schema field names (`$ref` resolved). The index comes from
  `GET /docs/api/search-index`.
- **Try-it-out response validation** against the documented schema for the
  status code (exact → `2XX` class → `default`), reported in the `validation`
  field of `/docs/api/try`.
- **`ludin lint`** with a documentation health score (`--min N`, `--json`),
  also served as `GET /docs/api/lint` and shown as a card on the overview.

### Changed

- **Package names.** npm rejects the unscoped name `ludin`, so the core is
  published as `@ludin-docs/core` and the adapters as `@ludin-docs/<framework>`.
  The CLI bin name stays `ludin`.

## [0.2.0] — unpublished

### Added

- **Your own HTML page.** `readme: { enabled, path, label, visibleTo }` (or
  just `readme: './guide.html'`) puts a file of yours behind a button in the
  top bar — a guide, onboarding steps, release notes. It is served under the
  same IP, login and role checks as the reference, re-read whenever it changes
  on disk, and recorded as a `docs.readme` audit event. The file goes out into
  a sandboxed frame in an opaque origin (`Content-Security-Policy: sandbox`),
  so its own CSS and scripts work while staying walled off from the docs UI and
  the session cookie.
- **Spec download.** `GET /docs/api/spec.json` and `.yaml` hand out the
  document filtered for the caller's role, as a file, recorded as a
  `docs.export` audit event.
- `theme.logoDark` for a dark-mode logo, and the top-left logo falls back to
  the letter mark when the image fails to load.
- OpenAPI descriptions render as Markdown, escaped before decoration so a
  document cannot inject markup.
- **Framework adapters**: `@ludin-docs/fastify`, `@ludin-docs/koa`, `@ludin-docs/hono` and
  `@ludin-docs/node` (plain `node:http`, connect, polka).
- CI on every pull request (build, typecheck, tests, browser e2e) and a
  tag-triggered npm release workflow.

### Changed

- The Administration screen is a read-only view of the running configuration:
  accounts, IP rules, roles, visibility rules and the configured readme page.

### Removed

- The database-backed store mode, before it ever shipped: `@ludin-docs/store-sqlite`,
  `@ludin-docs/store-mysql`, `createSqlStore()`, `createMemoryStore()`, the `store`
  option and everything that depended on it — invitations, editable accounts,
  server-side sessions and the audit log browser. Accounts, IP rules and roles
  come from your code again, which is all ludin needs to guard a document.
- The notice board, along with the `notices:write` permission. A `readme` page
  covers the same ground without a database behind it.
- `audit.retentionDays` (there is no stored log to prune) and the `audit:read`
  / `audit:read:self` permissions. Audit events still go to stdout or your own
  `audit.sink`.

## [0.1.0] — 2026-09-02

### Added

- OpenAPI 3.x rendering with tag grouping, schema viewer, search, deep links
  and multiple specs.
- Try it out through a server-side proxy, so calls are audited, attributed and
  limited to the spec's `servers` (plus `allowedTargets`).
- Email + password login with signed JWT cookies, scrypt/bcrypt/argon2 hashes
  and brute-force lockout.
- Roles and permissions (`viewer` / `developer` / `admin`, plus custom roles)
  and server-side spec filtering by tag, path or operation (`visibility`).
- IP allowlist with CIDR, ranges, IPv6, `trustProxy`, a localhost bypass and
  the `LUDIN_BYPASS_IP_CHECK` escape hatch.
- Audit events to stdout or a custom sink, with header/field masking.
- Themeable UI (logo, colors, fonts, density, light/dark, custom CSS).
- `ludin` core with the `@ludin-docs/express` and `@ludin-docs/nestjs` adapters, and the
  `ludin hash` CLI.
