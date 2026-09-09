# @ludin-docs/hono

Hono handler for [ludin](https://github.com/ludin-lee/ludin-node) — API docs with login, accounts & roles, IP allowlist and an audit log.

```bash
npm i @ludin-docs/core @ludin-docs/hono
```

```ts
import { mountLudin } from '@ludin-docs/hono';

mountLudin(app, {
  spec: './openapi.yaml',
  basePath: '/docs',
  auth: { users: [{ email: 'admin@acme.io', password: process.env.DOCS_ADMIN_PW!, role: 'admin' }] },
});
```

On runtimes that do not expose the client address (Cloudflare Workers, Vercel Edge …) set `trustProxy` so IP rules can read `X-Forwarded-For`; without it every request looks address-less and is blocked.

All options and roles are documented in the [main README](https://github.com/ludin-lee/ludin-node#readme).

MIT
