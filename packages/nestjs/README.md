# @ludin-docs/nestjs

Nestjs module for [ludin](https://github.com/ludin-lee/ludin-node) — API docs with login, accounts & roles, IP allowlist and an audit log.

```bash
npm i ludin @ludin-docs/express @ludin-docs/nestjs
```

`setupLudin` is a drop-in for `SwaggerModule.setup`:

```ts
import { setupLudin } from '@ludin-docs/nestjs';

const document = SwaggerModule.createDocument(app, config);
setupLudin(app, '/docs', document, {
  auth: { users: [{ email: 'admin@acme.io', password: process.env.DOCS_ADMIN_PW!, role: 'admin' }] },
});
```

Or as a module: `LudinModule.forRoot({ path: '/docs', spec: () => document, auth: { ... } })`.

All options and roles are documented in the [main README](https://github.com/ludin-lee/ludin-node#readme).

MIT
