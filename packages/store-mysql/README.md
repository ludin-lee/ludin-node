# @ludin/store-mysql

Mysql / mariadb store for [ludin](https://github.com/ludin-lee/ludin-node) — API docs with login, accounts & roles, IP allowlist and an audit log.

```bash
npm i ludin @ludin/store-mysql mysql2
```

```ts
import { mysqlStore } from '@ludin/store-mysql';

app.use('/docs', ludin({ spec: './openapi.yaml', store: mysqlStore(process.env.DATABASE_URL!) }));
```

Accepts a connection URL, a `mysql2` config object, or a pool you already own (a pool you pass in is never closed by the store). Several app instances share one source of truth, so revoking a session or disabling an account takes effect everywhere.

Adding a store turns the admin screen editable: invitations, roles, IP rules, revocable sessions and a browsable audit log.

All options, roles and store modes are documented in the [main README](https://github.com/ludin-lee/ludin-node#readme).

MIT
