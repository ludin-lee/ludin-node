# ludin

**API docs, but with a front door.** Login, accounts & roles, IP allowlist, audit log and a fast, themeable UI for any OpenAPI 3 document.

This is the framework-agnostic core: a `Request → Response` handler plus the auth, IP, visibility and audit logic, with the UI compiled in. Install it together with the adapter for your framework:

| Framework | Package |
|---|---|
| Express | [`@ludin-docs/express`](https://www.npmjs.com/package/@ludin-docs/express) |
| Fastify | [`@ludin-docs/fastify`](https://www.npmjs.com/package/@ludin-docs/fastify) |
| Koa | [`@ludin-docs/koa`](https://www.npmjs.com/package/@ludin-docs/koa) |
| Hono | [`@ludin-docs/hono`](https://www.npmjs.com/package/@ludin-docs/hono) |
| NestJS | [`@ludin-docs/nestjs`](https://www.npmjs.com/package/@ludin-docs/nestjs) |
| plain `node:http` | [`@ludin-docs/node`](https://www.npmjs.com/package/@ludin-docs/node) |

```bash
npm i @ludin-docs/core @ludin-docs/express
```

```ts
app.use('/docs', ludin({
  spec: './openapi.yaml',
  auth: { users: [{ email: 'admin@acme.io', password: process.env.DOCS_ADMIN_PW!, role: 'admin' }] },
  ipAllowlist: ['10.0.0.0/8'],
  visibility: { 'tag:Internal': ['admin'] },
}));
```

Point `readme` at an HTML file of your own — a guide, onboarding steps, release notes — and it appears next to the reference, behind the same login:

```ts
readme: { enabled: true, path: './docs/guide.html', label: 'Guide' }
```

`npx ludin hash` prints a password hash to use in `auth.users`.

Full documentation: [https://github.com/ludin-lee/ludin-node#readme](https://github.com/ludin-lee/ludin-node#readme)

MIT
