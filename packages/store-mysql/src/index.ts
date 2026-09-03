import { createSqlStore } from 'ludin';
import type { LudinStore, SqlExecutor, SqlTables } from 'ludin';

/** Structural subset of a `mysql2/promise` pool or connection. */
export interface MysqlConnectionLike {
  query(sql: string, params?: unknown[]): Promise<any>;
  execute(sql: string, params?: unknown[]): Promise<any>;
  end?(): Promise<unknown>;
}

export interface MysqlStoreOptions {
  /** Table name prefix. Default `ludin_`. */
  tablePrefix?: string;
  /** Extra options handed to `mysql2.createPool` when we open the pool. */
  pool?: Record<string, unknown>;
}

/**
 * MySQL / MariaDB store: accounts, invites, sessions and the audit log live in
 * your database, so several app instances share one source of truth.
 *
 * ```ts
 * import { mysqlStore } from '@ludin/store-mysql';
 * app.use('/docs', ludin({ spec, store: mysqlStore(process.env.DATABASE_URL!) }));
 * ```
 *
 * Pass a connection URL, a `mysql2` config object, or a pool you already own
 * (handy when the rest of the app is on the same database). Requires the
 * `mysql2` package: `npm i mysql2`.
 */
export function mysqlStore(
  target: string | MysqlConnectionLike | Record<string, unknown>,
  options: MysqlStoreOptions = {},
): LudinStore {
  return createSqlStore({
    dialect: 'mysql',
    tablePrefix: options.tablePrefix,
    connect: async () => toExecutor(await openPool(target, options), typeof target === 'string' || !isConnection(target)),
    migrate: async (exec, tables) => {
      for (const statement of ddl(tables)) await exec.run(statement, []);
    },
  });
}

function isConnection(value: unknown): value is MysqlConnectionLike {
  return typeof value === 'object' && value !== null && typeof (value as MysqlConnectionLike).execute === 'function';
}

/** `owned` pools are closed by `store.close()`; a pool you passed in is left alone. */
function toExecutor(pool: MysqlConnectionLike, owned: boolean): SqlExecutor {
  // DDL and session-level statements are not preparable everywhere, so they go
  // through `query`; everything with user data uses prepared statements.
  const isDdl = (sql: string) => /^\s*(CREATE|ALTER|DROP|SET|PRAGMA)/i.test(sql);
  const call = (sql: string, params: unknown[]) => (isDdl(sql) ? pool.query(sql) : pool.execute(sql, params));
  return {
    async all(sql, params) {
      const [rows] = await call(sql, params);
      return Array.isArray(rows) ? (rows as Record<string, any>[]) : [];
    },
    async run(sql, params) {
      await call(sql, params);
    },
    async close() {
      if (owned) await pool.end?.();
    },
  };
}

async function openPool(
  target: string | MysqlConnectionLike | Record<string, unknown>,
  options: MysqlStoreOptions,
): Promise<MysqlConnectionLike> {
  if (isConnection(target)) return target;
  let mysql: { createPool(config: unknown): MysqlConnectionLike };
  try {
    // Indirect specifier: mysql2 is a peer dependency, resolved at runtime only.
    const specifier = 'mysql2/promise';
    mysql = (await import(specifier)) as unknown as { createPool(config: unknown): MysqlConnectionLike };
  } catch (err) {
    throw new Error(`[ludin] @ludin/store-mysql needs the mysql2 package. Run: npm i mysql2. (${(err as Error).message})`);
  }
  const base = typeof target === 'string' ? { uri: target } : target;
  return mysql.createPool({ connectionLimit: 5, ...base, ...(options.pool ?? {}) });
}

function ddl(T: SqlTables): string[] {
  const charset = 'CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci';
  return [
    `CREATE TABLE IF NOT EXISTS ${T.users} (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      name VARCHAR(200) NULL,
      role VARCHAR(64) NOT NULL,
      password_hash VARCHAR(255) NOT NULL DEFAULT '',
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      ip_allowlist TEXT NULL,
      created_at CHAR(24) NOT NULL,
      last_login_at CHAR(24) NULL,
      UNIQUE KEY ${T.users}_email (email)
    ) ENGINE=InnoDB ${charset}`,
    `CREATE TABLE IF NOT EXISTS ${T.ipRules} (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      cidr VARCHAR(128) NOT NULL,
      note VARCHAR(200) NULL,
      UNIQUE KEY ${T.ipRules}_cidr (cidr)
    ) ENGINE=InnoDB ${charset}`,
    `CREATE TABLE IF NOT EXISTS ${T.invites} (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      role VARCHAR(64) NOT NULL,
      token_hash CHAR(64) NOT NULL,
      created_at CHAR(24) NOT NULL,
      created_by VARCHAR(255) NULL,
      expires_at CHAR(24) NOT NULL,
      accepted_at CHAR(24) NULL,
      UNIQUE KEY ${T.invites}_token (token_hash)
    ) ENGINE=InnoDB ${charset}`,
    `CREATE TABLE IF NOT EXISTS ${T.sessions} (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      created_at CHAR(24) NOT NULL,
      expires_at CHAR(24) NOT NULL,
      last_seen_at CHAR(24) NULL,
      ip VARCHAR(64) NULL,
      user_agent VARCHAR(300) NULL,
      KEY ${T.sessions}_user (user_id)
    ) ENGINE=InnoDB ${charset}`,
    `CREATE TABLE IF NOT EXISTS ${T.audit} (
      seq BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      ts CHAR(24) NOT NULL,
      type VARCHAR(64) NOT NULL,
      user_email VARCHAR(255) NULL,
      user_role VARCHAR(64) NULL,
      ip VARCHAR(64) NULL,
      detail TEXT NULL,
      KEY ${T.audit}_ts (ts),
      KEY ${T.audit}_user (user_email)
    ) ENGINE=InnoDB ${charset}`,
  ];
}
