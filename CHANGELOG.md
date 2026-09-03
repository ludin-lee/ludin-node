# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the packages are
versioned together.

## [0.2.0] — unreleased

### Added

- **Store mode.** Point ludin at a database and the admin screen becomes
  editable: invitations, account and role editing, IP rules, revocable
  sessions and a browsable audit log. Binding mode is unchanged and still the
  default.
  - `@ludin/store-sqlite` — a file, through the built-in `node:sqlite`
    (Node 22.5+) or `better-sqlite3`.
  - `@ludin/store-mysql` — MySQL 8 / MariaDB through `mysql2`.
  - `createMemoryStore()` — the same feature set without persistence, for
    development and tests.
  - `createSqlStore()` — the shared SQL implementation both adapters build on;
    an adapter supplies only a driver and its DDL.
- **Invitations.** Admins issue a single-use link; the invitee sets their own
  password. Only a SHA-256 hash of the token is stored.
- **Sessions.** In store mode the cookie is a pointer: disabling an account,
  changing its role or resetting its password invalidates live cookies, and
  admins can force a sign-out. Users can sign out of every device.
- **Audit log browser** with filters, pagination, CSV export and a retention
  setting (`audit.retentionDays`).
- **Framework adapters**: `@ludin/fastify`, `@ludin/koa`, `@ludin/hono` and
  `@ludin/node` (plain `node:http`, connect, polka).
- Lockout guards: the last active admin cannot be demoted or deleted, you
  cannot change your own role or status, and an IP rule that would shut you out
  is refused unless forced.
- CI on every pull request (build, typecheck, tests, MySQL integration tests,
  browser e2e) and a tag-triggered npm release workflow.

### Changed

- `auth.users` / `ipAllowlist` act as a one-time seed when a store is attached
  and still empty; plain-text passwords are hashed on the way in.

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
- `ludin` core with the `@ludin/express` and `@ludin/nestjs` adapters, and the
  `ludin hash` CLI.
