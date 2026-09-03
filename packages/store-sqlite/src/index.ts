import { createSqlStore } from 'ludin';
import type { LudinStore, SqlExecutor, SqlTables } from 'ludin';

/** The slice of better-sqlite3 / node:sqlite we rely on. */
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close?(): unknown;
}
export interface SqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteStoreOptions {
  /** Table name prefix. Default `ludin_`. */
  tablePrefix?: string;
}

/**
 * SQLite-backed store: accounts, invites, sessions and the audit log live in a
 * file, so the admin screens become editable and sessions revocable.
 *
 * ```ts
 * import { sqliteStore } from '@ludin/store-sqlite';
 * app.use('/docs', ludin({ spec, store: sqliteStore('./ludin.db') }));
 * ```
 *
 * Uses Node's built-in `node:sqlite` when available (Node 22.5+, stable from
 * Node 24) and falls back to `better-sqlite3` if that package is installed. You
 * can also hand it a database instance you opened yourself.
 */
export function sqliteStore(target: string | SqliteDatabase, options: SqliteStoreOptions = {}): LudinStore {
  return createSqlStore({
    dialect: 'sqlite',
    tablePrefix: options.tablePrefix,
    connect: async () => toExecutor(await openDatabase(target)),
    migrate: async (exec, tables) => {
      for (const pragma of ['PRAGMA journal_mode = WAL', 'PRAGMA busy_timeout = 5000']) {
        await exec.all(pragma, []);
      }
      for (const statement of ddl(tables)) await exec.run(statement, []);
    },
  });
}

function toExecutor(db: SqliteDatabase): SqlExecutor {
  return {
    async all(sql, params) {
      return db.prepare(sql).all(...params) as Record<string, any>[];
    },
    async run(sql, params) {
      db.prepare(sql).run(...params);
    },
    close() {
      db.close?.();
    },
  };
}

async function openDatabase(target: string | SqliteDatabase): Promise<SqliteDatabase> {
  if (typeof target !== 'string') return target;
  try {
    const { DatabaseSync } = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    };
    return new DatabaseSync(target);
  } catch (nodeErr) {
    try {
      // Indirect specifier: `better-sqlite3` is an optional peer, so it must not
      // become a hard type/runtime dependency of this package.
      const specifier = 'better-sqlite3';
      const mod = (await import(specifier)) as { default: new (path: string) => SqliteDatabase };
      return new mod.default(target);
    } catch {
      throw new Error(
        '[ludin] No SQLite driver available. Use Node 22.5+ (built-in node:sqlite, stable from Node 24) ' +
          `or install better-sqlite3: npm i better-sqlite3. Original error: ${(nodeErr as Error).message}`,
      );
    }
  }
}

function ddl(T: SqlTables): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${T.users} (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT,
      role TEXT NOT NULL,
      password_hash TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      ip_allowlist TEXT,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS ${T.ipRules} (
      id TEXT PRIMARY KEY,
      cidr TEXT NOT NULL UNIQUE,
      note TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS ${T.invites} (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      created_by TEXT,
      expires_at TEXT NOT NULL,
      accepted_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS ${T.sessions} (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT,
      ip TEXT,
      user_agent TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS ${T.sessions}_user ON ${T.sessions} (user_id)`,
    `CREATE TABLE IF NOT EXISTS ${T.notices} (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'published',
      pinned INTEGER NOT NULL DEFAULT 0,
      visible_to TEXT,
      author_email TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${T.audit} (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      user_email TEXT,
      user_role TEXT,
      ip TEXT,
      detail TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS ${T.audit}_ts ON ${T.audit} (ts)`,
  ];
}
