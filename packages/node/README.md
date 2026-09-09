# @ludin-docs/node

Plain node:http adapter for [ludin](https://github.com/ludin-lee/ludin-node) — API docs with login, accounts & roles, IP allowlist and an audit log.

```bash
npm i ludin @ludin-docs/node
```

```ts
import http from 'node:http';
import { ludin } from '@ludin-docs/node';

const docs = ludin({ spec: './openapi.yaml', basePath: '/docs', auth: { users: [...] } });
http.createServer((req, res) => docs(req, res, () => { res.statusCode = 404; res.end(); })).listen(3000);
```

Also works with connect and polka. `createLudinServer(options)` returns a ready-made server when the docs are all you serve.

All options and roles are documented in the [main README](https://github.com/ludin-lee/ludin-node#readme).

MIT
