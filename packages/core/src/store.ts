import { createHash, randomUUID } from 'node:crypto';
import type {
  AuditEvent,
  AuditFilter,
  BoundUser,
  Invite,
  IpRule,
  LudinStore,
  NewUser,
  Notice,
  Page,
  Session,
  StoredUser,
} from './types.js';

function idFor(email: string): string {
  return createHash('sha1').update(email.toLowerCase()).digest('hex').slice(0, 12);
}

function toStored(u: BoundUser): StoredUser {
  if (!u.email || typeof u.password !== 'string') {
    throw new Error(`[ludin] Each bound user needs an email and password (got ${JSON.stringify(u.email)}).`);
  }
  return {
    id: idFor(u.email),
    email: u.email,
    name: u.name,
    role: u.role ?? 'developer',
    passwordHash: u.password,
    status: 'active',
    ipAllowlist: u.ipAllowlist,
  };
}

/**
 * Read-only store backed by the `auth.users` / `ipAllowlist` options.
 * This is what "binding mode" uses under the hood, so the core only ever
 * talks to a store.
 */
export function createBindingStore(users: BoundUser[] = [], ipAllowlist: string[] = []): LudinStore {
  const stored = users.map(toStored);
  const rules: IpRule[] = ipAllowlist.map((cidr, i) => ({ id: `bound-${i}`, cidr }));

  return {
    readonly: true,
    users: {
      async findByEmail(email) {
        const e = email.toLowerCase();
        return stored.find((u) => u.email.toLowerCase() === e) ?? null;
      },
      async findById(id) {
        return stored.find((u) => u.id === id) ?? null;
      },
      async list() {
        return stored.slice();
      },
    },
    ipRules: {
      async list() {
        return rules.slice();
      },
    },
  };
}

export interface MemoryStoreSeed {
  users?: BoundUser[];
  ipAllowlist?: string[];
}

/**
 * Writable in-memory store – the full store-mode surface (accounts, invites,
 * sessions, audit queries) without a database.
 *
 * Everything is lost on restart, so it is meant for development, tests and
 * demos. Use `@ludin/store-sqlite` (or another adapter) in production.
 */
export function createMemoryStore(seed: MemoryStoreSeed = {}): LudinStore {
  const users: StoredUser[] = (seed.users ?? []).map((u) => ({ ...toStored(u), createdAt: new Date().toISOString() }));
  const rules: IpRule[] = (seed.ipAllowlist ?? []).map((cidr, i) => ({ id: `seed-${i}`, cidr }));
  const invites: Invite[] = [];
  const notices: Notice[] = [];
  const sessions = new Map<string, Session>();
  /** Newest first. */
  const events: AuditEvent[] = [];

  const find = (id: string) => users.find((u) => u.id === id);

  return {
    readonly: false,
    users: {
      async findByEmail(email) {
        const e = email.toLowerCase();
        return users.find((u) => u.email.toLowerCase() === e) ?? null;
      },
      async findById(id) {
        return find(id) ?? null;
      },
      async list() {
        return users.slice();
      },
      async create(input: NewUser) {
        const user: StoredUser = {
          id: idFor(input.email),
          email: input.email,
          name: input.name,
          role: input.role,
          passwordHash: input.passwordHash,
          status: input.status,
          ipAllowlist: input.ipAllowlist,
          createdAt: new Date().toISOString(),
        };
        if (users.some((u) => u.email.toLowerCase() === user.email.toLowerCase())) {
          throw new Error(`[ludin] A user with email ${user.email} already exists.`);
        }
        users.push(user);
        return user;
      },
      async update(id, patch) {
        const user = find(id);
        if (!user) throw new Error(`[ludin] No such user: ${id}`);
        Object.assign(user, patch);
        return user;
      },
      async remove(id) {
        const i = users.findIndex((u) => u.id === id);
        if (i >= 0) users.splice(i, 1);
      },
    },
    ipRules: {
      async list() {
        return rules.slice();
      },
      async upsert(rule) {
        const existing = rules.find((r) => r.id === rule.id);
        if (existing) Object.assign(existing, rule);
        else rules.push(rule);
        return rule;
      },
      async remove(id) {
        const i = rules.findIndex((r) => r.id === id);
        if (i >= 0) rules.splice(i, 1);
      },
    },
    invites: {
      async create(invite) {
        invites.push(invite);
        return invite;
      },
      async findByTokenHash(tokenHash) {
        return invites.find((i) => i.tokenHash === tokenHash) ?? null;
      },
      async list() {
        return invites.slice();
      },
      async markAccepted(id, at) {
        const invite = invites.find((i) => i.id === id);
        if (invite) invite.acceptedAt = at;
      },
      async remove(id) {
        const i = invites.findIndex((x) => x.id === id);
        if (i >= 0) invites.splice(i, 1);
      },
    },
    notices: {
      async list() {
        return notices.slice();
      },
      async get(id) {
        return notices.find((n) => n.id === id) ?? null;
      },
      async create(notice) {
        notices.unshift(notice);
        return notice;
      },
      async update(id, patch) {
        const notice = notices.find((n) => n.id === id);
        if (!notice) throw new Error(`[ludin] No such notice: ${id}`);
        Object.assign(notice, patch);
        return notice;
      },
      async remove(id) {
        const i = notices.findIndex((n) => n.id === id);
        if (i >= 0) notices.splice(i, 1);
      },
    },
    sessions: {
      async create(session) {
        sessions.set(session.id, session);
        return session;
      },
      async get(id) {
        return sessions.get(id) ?? null;
      },
      async touch(id, at) {
        const s = sessions.get(id);
        if (s) s.lastSeenAt = at;
      },
      async listForUser(userId) {
        return [...sessions.values()].filter((s) => s.userId === userId);
      },
      async revoke(id) {
        sessions.delete(id);
      },
      async revokeAllForUser(userId) {
        for (const [id, s] of sessions) if (s.userId === userId) sessions.delete(id);
      },
    },
    audit: {
      async append(event) {
        events.unshift(event);
      },
      async query(filter) {
        return queryEvents(events, filter);
      },
      async prune(before) {
        const keep = events.filter((e) => e.ts >= before);
        const removed = events.length - keep.length;
        events.length = 0;
        events.push(...keep);
        return removed;
      },
    },
  };
}

/**
 * Filter + paginate audit events held in memory. Exported so simple store
 * adapters can reuse it; SQL adapters push this down into the query instead.
 */
export function queryEvents(newestFirst: AuditEvent[], filter: AuditFilter = {}): Page<AuditEvent> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  const offset = Number(filter.cursor ?? 0) || 0;
  const needle = filter.q?.toLowerCase();

  const matched = newestFirst.filter((e) => {
    if (filter.user && e.user?.email?.toLowerCase() !== filter.user.toLowerCase()) return false;
    if (filter.type && e.type !== filter.type) return false;
    if (filter.from && e.ts < filter.from) return false;
    if (filter.to && e.ts > filter.to) return false;
    if (needle) {
      const hay = `${e.type} ${e.ip} ${e.user?.email ?? ''} ${JSON.stringify(e.detail ?? {})}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  const items = matched.slice(offset, offset + limit);
  const next = offset + limit;
  return { items, nextCursor: next < matched.length ? String(next) : null };
}

export function newSessionId(): string {
  return randomUUID();
}
