# @ludin/express

Express adapter for [ludin](https://github.com/ludin-lee/ludin-node) — API docs with login, accounts & roles, IP allowlist and an audit log.

```bash
npm i ludin @ludin/express
```

```ts
import express from 'express';
import { ludin } from '@ludin/express';

const app = express();
app.use('/docs', ludin({
  spec: './openapi.yaml',
  auth: { users: [{ email: 'admin@acme.io', password: process.env.DOCS_ADMIN_PW!, role: 'admin' }] },
  ipAllowlist: ['10.0.0.0/8'],
}));
```

The mount path is read from `req.baseUrl`, so `basePath` is optional.

All options and roles are documented in the [main README](https://github.com/ludin-lee/ludin-node#readme).

MIT
