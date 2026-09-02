import type { Permission, Role } from './types.js';

export const DEFAULT_ROLES: Record<string, Permission[]> = {
  viewer: ['docs:read'],
  developer: ['docs:read', 'docs:try', 'audit:read:self'],
  admin: ['docs:read', 'docs:try', 'audit:read', 'audit:read:self', 'admin:read', 'admin:write'],
};

export class RoleRegistry {
  private readonly map: Record<string, Set<Permission>>;
  constructor(custom: Record<string, Permission[]> = {}) {
    this.map = {};
    for (const [role, perms] of Object.entries({ ...DEFAULT_ROLES, ...custom })) {
      this.map[role] = new Set(perms);
    }
  }
  has(role: Role, perm: Permission): boolean {
    return this.map[role]?.has(perm) ?? false;
  }
  permissions(role: Role): Permission[] {
    return [...(this.map[role] ?? [])];
  }
  exists(role: Role): boolean {
    return role in this.map;
  }
  names(): string[] {
    return Object.keys(this.map);
  }
}
