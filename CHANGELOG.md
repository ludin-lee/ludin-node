# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the packages are
versioned together.

## [0.2.0] — unreleased

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
