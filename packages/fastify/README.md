# @ludin/fastify

Fastify plugin for [ludin](https://github.com/ludin-lee/ludin-node) — API docs with login, accounts & roles, IP allowlist and an audit log.

```bash
npm i ludin @ludin/fastify
```

```ts
import { ludin } from '@ludin/fastify';

await app.register(ludin({
  spec: './openapi.yaml',
  auth: { users: [{ email: 'admin@acme.io', password: process.env.DOCS_ADMIN_PW!, role: 'admin' }] },
}), { prefix: '/docs' });
```

The mount path comes from the register prefix. Body parsing is replaced **inside the plugin scope only**, so the rest of your app is untouched.

All options and roles are documented in the [main README](https://github.com/ludin-lee/ludin-node#readme).

MIT
