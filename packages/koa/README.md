# @ludin/koa

Koa middleware for [ludin](https://github.com/ludin-lee/ludin-node) — API docs with login, accounts & roles, IP allowlist and an audit log.

```bash
npm i ludin @ludin/koa
```

```ts
import { ludin } from '@ludin/koa';

app.use(ludin({
  spec: './openapi.yaml',
  basePath: '/docs',
  auth: { users: [{ email: 'admin@acme.io', password: process.env.DOCS_ADMIN_PW!, role: 'admin' }] },
}));
```

Requests outside `basePath` are passed to `next()`. Works under `koa-mount` too, and reuses a body already read by a body parser.

All options, roles and store modes are documented in the [main README](https://github.com/ludin-lee/ludin-node#readme).

MIT
