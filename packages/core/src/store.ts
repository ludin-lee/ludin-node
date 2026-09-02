import { createHash } from 'node:crypto';
import type { BoundUser, IpRule, RudinStore, StoredUser } from './types.js';

/**
 * Read-only store backed by the `auth.users` / `ipAllowlist` options.
 * This is what "binding mode" uses under the hood, so the core only ever
 * talks to a store.
 */
export function createBindingStore(users: BoundUser[] = [], ipAllowlist: string[] = []): RudinStore {
  const stored: StoredUser[] = users.map((u) => {
    if (!u.email || typeof u.password !== 'string') {
      throw new Error(`[rudin] Each bound user needs an email and password (got ${JSON.stringify(u.email)}).`);
    }
    return {
      id: createHash('sha1').update(u.email.toLowerCase()).digest('hex').slice(0, 12),
      email: u.email,
      name: u.name,
      role: u.role ?? 'developer',
      passwordHash: u.password,
      status: 'active',
      ipAllowlist: u.ipAllowlist,
    };
  });
  const rules: IpRule[] = ipAllowlist.map((cidr, i) => ({ id: `bound-${i}`, cidr }));

  return {
    readonly: true,
    users: {
      async findByEmail(email) {
        const e = email.toLowerCase();
        return stored.find((u) => u.email.toLowerCase() === e) ?? null;
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
