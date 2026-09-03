import type {
  AuditEvent,
  AuditFilter,
  Invite,
  IpRule,
  LudinStore,
  NewUser,
  Page,
  Session,
  StoredUser,
} from 'ludin';

/** The slice of better-sqlite3 / node:sqlite we rely on. */
export interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  close?(): unknown;
}
export interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteStoreOptions {
  /** Table name prefix. Default `ludin_`. */
  tablePrefix?: string;
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * SQLite-backed store: accounts, invites, sessions and the audit log live in a
 * file, so the admin screens become editable and sessions revocable.
 *
 * ```ts
 * import { sqliteStore } from '@ludin/store-sqlite';
 * app.use('/docs', ludin({ spec, store: sqliteStore('./ludin.db') }));
 * ```
 *
 * Uses Node's built-in `node:sqlite` when available (Node 22.5+ / 24), and
 * falls back to `better-sqlite3` if that package is installed. You can also
 * hand it a database instance you opened yourself.
 */
export function sqliteStore(target: string | SqliteDatabase, options: SqliteStoreOptions = {}): LudinStore {
  const p = options.tablePrefix ?? 'ludin_';
  const T = {
    users: `${p}users`,
    ipRules: `${p}ip_rules`,
    invites: `${p}invites`,
    sessions: `${p}sessions`,
    audit: `${p}audit`,
  };

  let db: SqliteDatabase | null = null;
  let opening: Promise<SqliteDatabase> | null = null;

  async function ready(): Promise<SqliteDatabase> {
    if (db) return db;
    opening ??= openDatabase(target).then((opened) => {
      migrate(opened, T);
      db = opened;
      return opened;
    });
    return opening;
  }

  const all = async (sql: string, ...params: unknown[]) => (await ready()).prepare(sql).all(...params) as any[];
  const get = async (sql: string, ...params: unknown[]) => (await ready()).prepare(sql).get(...params) as any;
  const run = async (sql: string, ...params: unknown[]) => void (await ready()).prepare(sql).run(...params);

  return {
    readonly: false,

    users: {
      async findByEmail(email) {
        return toUser(await get(`SELECT * FROM ${T.users} WHERE email = ? COLLATE NOCASE`, email));
      },
      async findById(id) {
        return toUser(await get(`SELECT * FROM ${T.users} WHERE id = ?`, id));
      },
      async list() {
        return (await all(`SELECT * FROM ${T.users} ORDER BY created_at`)).map(toUser) as StoredUser[];
      },
      async create(input: NewUser) {
        const user: StoredUser = {
          id: randomId(),
          email: input.email,
          name: input.name,
          role: input.role,
          passwordHash: input.passwordHash,
          status: input.status,
          ipAllowlist: input.ipAllowlist,
          createdAt: new Date().toISOString(),
        };
        await run(
          `INSERT INTO ${T.users} (id, email, name, role, password_hash, status, ip_allowlist, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          user.id,
          user.email,
          user.name ?? null,
          user.role,
          user.passwordHash,
          user.status,
          user.ipAllowlist?.length ? JSON.stringify(user.ipAllowlist) : null,
          user.createdAt,
        );
        return user;
      },
      async update(id, patch) {
        const columns: Record<string, unknown> = {};
        if (patch.email !== undefined) columns.email = patch.email;
        if (patch.name !== undefined) columns.name = patch.name ?? null;
        if (patch.role !== undefined) columns.role = patch.role;
        if (patch.passwordHash !== undefined) columns.password_hash = patch.passwordHash;
        if (patch.status !== undefined) columns.status = patch.status;
        if (patch.ipAllowlist !== undefined) {
          columns.ip_allowlist = patch.ipAllowlist?.length ? JSON.stringify(patch.ipAllowlist) : null;
        }
        if (patch.lastLoginAt !== undefined) columns.last_login_at = patch.lastLoginAt;
        const keys = Object.keys(columns);
        if (keys.length) {
          await run(
            `UPDATE ${T.users} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
            ...keys.map((k) => columns[k]),
            id,
          );
        }
        const user = toUser(await get(`SELECT * FROM ${T.users} WHERE id = ?`, id));
        if (!user) throw new Error(`[ludin] No such user: ${id}`);
        return user;
      },
      async remove(id) {
        await run(`DELETE FROM ${T.users} WHERE id = ?`, id);
        await run(`DELETE FROM ${T.sessions} WHERE user_id = ?`, id);
      },
    },

    ipRules: {
      async list() {
        return (await all(`SELECT * FROM ${T.ipRules} ORDER BY rowid`)).map((r) => ({
          id: r.id,
          cidr: r.cidr,
          note: r.note ?? undefined,
        })) as IpRule[];
      },
      async upsert(rule) {
        await run(
          `INSERT INTO ${T.ipRules} (id, cidr, note) VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET cidr = excluded.cidr, note = excluded.note`,
          rule.id,
          rule.cidr,
          rule.note ?? null,
        );
        return rule;
      },
      async remove(id) {
        await run(`DELETE FROM ${T.ipRules} WHERE id = ?`, id);
      },
    },

    invites: {
      async create(invite) {
        await run(
          `INSERT INTO ${T.invites} (id, email, role, token_hash, created_at, created_by, expires_at, accepted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
          invite.id,
          invite.email,
          invite.role,
          invite.tokenHash,
          invite.createdAt,
          invite.createdBy ?? null,
          invite.expiresAt,
        );
        return invite;
      },
      async findByTokenHash(tokenHash) {
        return toInvite(await get(`SELECT * FROM ${T.invites} WHERE token_hash = ?`, tokenHash));
      },
      async list() {
        return (await all(`SELECT * FROM ${T.invites} ORDER BY created_at DESC`)).map(toInvite) as Invite[];
      },
      async markAccepted(id, at) {
        await run(`UPDATE ${T.invites} SET accepted_at = ? WHERE id = ?`, at, id);
      },
      async remove(id) {
        await run(`DELETE FROM ${T.invites} WHERE id = ?`, id);
      },
    },

    sessions: {
      async create(session) {
        await run(
          `INSERT INTO ${T.sessions} (id, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          session.id,
          session.userId,
          session.createdAt,
          session.expiresAt,
          session.lastSeenAt ?? null,
          session.ip ?? null,
          session.userAgent ?? null,
        );
        return session;
      },
      async get(id) {
        const row = await get(`SELECT * FROM ${T.sessions} WHERE id = ?`, id);
        if (!row) return null;
        if (row.expires_at <= new Date().toISOString()) {
          await run(`DELETE FROM ${T.sessions} WHERE id = ?`, id);
          return null;
        }
        return toSession(row);
      },
      async touch(id, at) {
        await run(`UPDATE ${T.sessions} SET last_seen_at = ? WHERE id = ?`, at, id);
      },
      async listForUser(userId) {
        return (await all(
          `SELECT * FROM ${T.sessions} WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC`,
          userId,
          new Date().toISOString(),
        )).map(toSession) as Session[];
      },
      async revoke(id) {
        await run(`DELETE FROM ${T.sessions} WHERE id = ?`, id);
      },
      async revokeAllForUser(userId) {
        await run(`DELETE FROM ${T.sessions} WHERE user_id = ?`, userId);
      },
    },

    audit: {
      async append(event) {
        await run(
          `INSERT INTO ${T.audit} (ts, type, user_email, user_role, ip, detail) VALUES (?, ?, ?, ?, ?, ?)`,
          event.ts,
          event.type,
          event.user?.email ?? null,
          event.user?.role ?? null,
          event.ip,
          event.detail ? JSON.stringify(event.detail) : null,
        );
      },
      async query(filter: AuditFilter): Promise<Page<AuditEvent>> {
        const where: string[] = [];
        const params: unknown[] = [];
        if (filter.user) {
          where.push('user_email = ? COLLATE NOCASE');
          params.push(filter.user);
        }
        if (filter.type) {
          where.push('type = ?');
          params.push(filter.type);
        }
        if (filter.from) {
          where.push('ts >= ?');
          params.push(filter.from);
        }
        if (filter.to) {
          where.push('ts <= ?');
          params.push(filter.to);
        }
        if (filter.q) {
          where.push('(ip LIKE ? OR user_email LIKE ? OR type LIKE ? OR detail LIKE ?)');
          const like = `%${filter.q}%`;
          params.push(like, like, like, like);
        }
        // Keyset pagination: `seq` is monotonic, so "older than the last row" is exact.
        if (filter.cursor) {
          where.push('seq < ?');
          params.push(Number(filter.cursor));
        }
        const limit = Math.min(Math.max(filter.limit ?? 50, 1), 5000);
        const rows = await all(
          `SELECT * FROM ${T.audit} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`,
          ...params,
          limit + 1,
        );
        const page = rows.slice(0, limit);
        return {
          items: page.map(toEvent),
          nextCursor: rows.length > limit ? String(page[page.length - 1].seq) : null,
        };
      },
      async prune(before) {
        const row = await get(`SELECT COUNT(*) AS n FROM ${T.audit} WHERE ts < ?`, before);
        await run(`DELETE FROM ${T.audit} WHERE ts < ?`, before);
        return Number(row?.n ?? 0);
      },
    },

    async close() {
      if (db?.close) db.close();
      db = null;
      opening = null;
    },
  };
}

// ---------------------------------------------------------------------------
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

function migrate(db: SqliteDatabase, T: Record<string, string>): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${T.users} (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT,
      role TEXT NOT NULL,
      password_hash TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      ip_allowlist TEXT,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS ${T.ipRules} (
      id TEXT PRIMARY KEY,
      cidr TEXT NOT NULL UNIQUE,
      note TEXT
    );
    CREATE TABLE IF NOT EXISTS ${T.invites} (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      created_by TEXT,
      expires_at TEXT NOT NULL,
      accepted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS ${T.sessions} (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT,
      ip TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS ${T.sessions}_user ON ${T.sessions} (user_id);
    CREATE TABLE IF NOT EXISTS ${T.audit} (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      user_email TEXT,
      user_role TEXT,
      ip TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS ${T.audit}_ts ON ${T.audit} (ts);
  `);
}

function randomId(): string {
  let out = '';
  for (let i = 0; i < 12; i++) out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  return out;
}

function toUser(row: any): StoredUser | null {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name ?? undefined,
    role: row.role,
    passwordHash: row.password_hash ?? '',
    status: row.status,
    ipAllowlist: row.ip_allowlist ? JSON.parse(row.ip_allowlist) : undefined,
    createdAt: row.created_at ?? undefined,
    lastLoginAt: row.last_login_at ?? undefined,
  };
}

function toInvite(row: any): Invite | null {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    createdBy: row.created_by ?? undefined,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at ?? null,
  };
}

function toSession(row: any): Session {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at ?? undefined,
    ip: row.ip ?? undefined,
    userAgent: row.user_agent ?? undefined,
  };
}

function toEvent(row: any): AuditEvent {
  return {
    ts: row.ts,
    type: row.type,
    user: row.user_email ? { email: row.user_email, role: row.user_role } : null,
    ip: row.ip,
    detail: row.detail ? JSON.parse(row.detail) : undefined,
  };
}
