import { randomBytes } from 'node:crypto';
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
} from './types.js';

/**
 * The bit of a SQL driver a store adapter has to provide. Both statements take
 * positional `?` parameters, which sqlite, MySQL and MariaDB all understand.
 */
export interface SqlExecutor {
  all(sql: string, params: unknown[]): Promise<Record<string, any>[]>;
  run(sql: string, params: unknown[]): Promise<void>;
  close?(): Promise<void> | void;
}

export interface SqlTables {
  users: string;
  ipRules: string;
  invites: string;
  sessions: string;
  audit: string;
}

export interface SqlStoreOptions {
  /** Only two things actually differ between engines: upserts and case-insensitive matching. */
  dialect: 'sqlite' | 'mysql';
  /** Table name prefix. Default `ludin_`. */
  tablePrefix?: string;
  /** Opened lazily on first use, so constructing a store never blocks boot. */
  connect: () => Promise<SqlExecutor>;
  /** Runs once, right after connecting. */
  migrate: (exec: SqlExecutor, tables: SqlTables) => Promise<void>;
}

/**
 * Shared SQL implementation of `LudinStore`. Adapters (`@ludin/store-sqlite`,
 * `@ludin/store-mysql`, …) supply a driver and their DDL; everything below —
 * the queries, the row mapping, keyset pagination — is identical, so the
 * engines cannot drift apart in behaviour.
 */
export function createSqlStore(options: SqlStoreOptions): LudinStore {
  const p = options.tablePrefix ?? 'ludin_';
  const T: SqlTables = {
    users: `${p}users`,
    ipRules: `${p}ip_rules`,
    invites: `${p}invites`,
    sessions: `${p}sessions`,
    audit: `${p}audit`,
  };
  const sqlite = options.dialect === 'sqlite';
  // sqlite compares text case-sensitively unless told otherwise; MySQL's default
  // collations are already case-insensitive.
  const ci = (column: string) => (sqlite ? `${column} = ? COLLATE NOCASE` : `${column} = ?`);
  const upsert = (table: string, columns: string[]) =>
    sqlite
      ? `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
         ON CONFLICT(id) DO UPDATE SET ${columns.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')}`
      : `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
         ON DUPLICATE KEY UPDATE ${columns.filter((c) => c !== 'id').map((c) => `${c} = VALUES(${c})`).join(', ')}`;

  let exec: SqlExecutor | null = null;
  let opening: Promise<SqlExecutor> | null = null;
  async function ready(): Promise<SqlExecutor> {
    if (exec) return exec;
    opening ??= (async () => {
      const opened = await options.connect();
      await options.migrate(opened, T);
      exec = opened;
      return opened;
    })().catch((err) => {
      opening = null;
      throw err;
    });
    return opening;
  }

  const all = async (sql: string, ...params: unknown[]) => (await ready()).all(sql, params);
  const one = async (sql: string, ...params: unknown[]) => (await all(sql, ...params))[0] ?? null;
  const run = async (sql: string, ...params: unknown[]) => (await ready()).run(sql, params);
  /** LIMIT is inlined (as a checked integer) because prepared LIMIT parameters are not portable. */
  const limit = (n: number, max: number) => Math.min(Math.max(Math.trunc(n) || 1, 1), max);

  return {
    readonly: false,

    users: {
      async findByEmail(email) {
        return toUser(await one(`SELECT * FROM ${T.users} WHERE ${ci('email')}`, email));
      },
      async findById(id) {
        return toUser(await one(`SELECT * FROM ${T.users} WHERE id = ?`, id));
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
        const user = toUser(await one(`SELECT * FROM ${T.users} WHERE id = ?`, id));
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
        return (await all(`SELECT id, cidr, note FROM ${T.ipRules} ORDER BY cidr`)).map((r) => ({
          id: r.id,
          cidr: r.cidr,
          note: r.note ?? undefined,
        })) as IpRule[];
      },
      async upsert(rule) {
        await run(upsert(T.ipRules, ['id', 'cidr', 'note']), rule.id, rule.cidr, rule.note ?? null);
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
        return toInvite(await one(`SELECT * FROM ${T.invites} WHERE token_hash = ?`, tokenHash));
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
        const row = await one(`SELECT * FROM ${T.sessions} WHERE id = ?`, id);
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
        return (
          await all(
            `SELECT * FROM ${T.sessions} WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC`,
            userId,
            new Date().toISOString(),
          )
        ).map(toSession) as Session[];
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
          where.push(ci('user_email'));
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
        const n = limit(filter.limit ?? 50, 5000);
        const rows = await all(
          `SELECT * FROM ${T.audit} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY seq DESC LIMIT ${n + 1}`,
          ...params,
        );
        const page = rows.slice(0, n);
        return {
          items: page.map(toEvent),
          nextCursor: rows.length > n ? String(page[page.length - 1].seq) : null,
        };
      },
      async prune(before) {
        const row = await one(`SELECT COUNT(*) AS n FROM ${T.audit} WHERE ts < ?`, before);
        await run(`DELETE FROM ${T.audit} WHERE ts < ?`, before);
        return Number(row?.n ?? 0);
      },
    },

    async close() {
      await exec?.close?.();
      exec = null;
      opening = null;
    },
  };
}

function randomId(): string {
  return randomBytes(6).toString('hex');
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
    ipAllowlist: parseList(row.ip_allowlist),
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
    detail: parseJson(row.detail),
  };
}

/** JSON columns come back as text (sqlite) or already parsed (some MySQL setups). */
function parseJson(value: unknown): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (typeof value === 'object') return value as Record<string, unknown>;
  try {
    return JSON.parse(String(value));
  } catch {
    return undefined;
  }
}

function parseList(value: unknown): string[] | undefined {
  const parsed = value == null ? undefined : Array.isArray(value) ? value : parseJson(value);
  return Array.isArray(parsed) ? (parsed as string[]) : undefined;
}
