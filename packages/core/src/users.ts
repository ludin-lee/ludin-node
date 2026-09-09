import { createHash } from 'node:crypto';
import type { AuthUser, BoundUser } from './types.js';

/** A configured account: an identity plus the credential to check against. */
export interface DirectoryUser extends AuthUser {
  passwordHash: string;
}

/** Stable id from the email, so sessions survive a restart. */
function idFor(email: string): string {
  return createHash('sha1').update(email.toLowerCase()).digest('hex').slice(0, 12);
}

/**
 * The accounts from `auth.users`, read-only by design: they live in your code
 * or environment, and a redeploy is what changes them.
 */
export class Directory {
  private readonly users: DirectoryUser[];

  constructor(users: BoundUser[] = []) {
    this.users = users.map((u) => {
      if (!u.email || typeof u.password !== 'string') {
        throw new Error(`[ludin] Each user needs an email and password (got ${JSON.stringify(u.email)}).`);
      }
      return {
        id: idFor(u.email),
        email: u.email,
        name: u.name,
        role: u.role ?? 'developer',
        passwordHash: u.password,
        ipAllowlist: u.ipAllowlist,
      };
    });
  }

  findByEmail(email: string): DirectoryUser | null {
    const needle = email.toLowerCase();
    return this.users.find((u) => u.email.toLowerCase() === needle) ?? null;
  }

  list(): DirectoryUser[] {
    return this.users.slice();
  }
}
