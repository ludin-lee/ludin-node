# ludin

**API docs, but with a front door.** Login, accounts & roles, IP allowlist, audit log and a fast, themeable UI for any OpenAPI 3 document.

This is the framework-agnostic core: a `Request → Response` handler plus the auth, IP, visibility and audit logic, with the UI compiled in. Install it together with the adapter for your framework:

| Framework | Package |
|---|---|
| Express | [`@ludin/express`](https://www.npmjs.com/package/@ludin/express) |
| Fastify | [`@ludin/fastify`](https://www.npmjs.com/package/@ludin/fastify) |
| Koa | [`@ludin/koa`](https://www.npmjs.com/package/@ludin/koa) |
| Hono | [`@ludin/hono`](https://www.npmjs.com/package/@ludin/hono) |
| NestJS | [`@ludin/nestjs`](https://www.npmjs.com/package/@ludin/nestjs) |
| plain `node:http` | [`@ludin/node`](https://www.npmjs.com/package/@ludin/node) |

```bash
npm i ludin @ludin/express
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
