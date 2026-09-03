# @ludin/store-sqlite

Sqlite store for [ludin](https://github.com/ludin-lee/ludin-node) — API docs with login, accounts & roles, IP allowlist and an audit log.

```bash
npm i ludin @ludin/store-sqlite
```

```ts
import { sqliteStore } from '@ludin/store-sqlite';

app.use('/docs', ludin({ spec: './openapi.yaml', store: sqliteStore('./ludin.db') }));
```

Adding a store turns the admin screen editable: invitations, roles, IP rules, revocable sessions and a browsable audit log.

Uses Node's built-in `node:sqlite` (Node 22.5+, stable from Node 24). On older runtimes install `better-sqlite3` and it is used automatically. You can also pass a database instance you opened yourself.

All options, roles and store modes are documented in the [main README](https://github.com/ludin-lee/ludin-node#readme).

MIT
