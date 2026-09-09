# @ludin-docs/koa

Koa middleware for [ludin](https://github.com/ludin-lee/ludin-node) — API docs with login, accounts & roles, IP allowlist and an audit log.

```bash
npm i @ludin-docs/core @ludin-docs/koa
```

```ts
import { ludin } from '@ludin-docs/koa';

app.use(ludin({
  spec: './openapi.yaml',
  basePath: '/docs',
  auth: { users: [{ email: 'admin@acme.io', password: process.env.DOCS_ADMIN_PW!, role: 'admin' }] },
}));
```

Requests outside `basePath` are passed to `next()`. Works under `koa-mount` too, and reuses a body already read by a body parser.

All options and roles are documented in the [main README](https://github.com/ludin-lee/ludin-node#readme).

MIT
