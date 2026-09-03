import { boot } from './config';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${boot.basePath}/api${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      'x-requested-with': 'ludin',
      ...(init.headers ?? {}),
    },
    credentials: 'same-origin',
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText, data?.code);
  return data as T;
}

const send = <T>(method: string, path: string, body?: unknown) =>
  call<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export interface Capabilities {
  users: boolean;
  invites: boolean;
  ipRules: boolean;
  sessions: boolean;
  auditQuery: boolean;
}

export interface Me {
  authenticated: boolean;
  anonymous: boolean;
  user: { email: string; name?: string; role: string } | null;
  permissions: string[];
  readonly: boolean;
  capabilities: Capabilities;
  authEnabled: boolean;
}

export interface TryResult {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  ms: number;
  size?: number;
  body?: string | null;
  bodyBase64?: string | null;
  error?: string;
}

export interface AdminUser {
  id: string;
  email: string;
  name?: string;
  role: string;
  status: 'active' | 'invited' | 'disabled';
  ipAllowlist: string[];
  hashed: boolean;
  createdAt?: string;
  lastLoginAt?: string;
  sessions: number;
}

export interface AdminInvite {
  id: string;
  email: string;
  role: string;
  createdAt: string;
  createdBy?: string;
  expiresAt: string;
  acceptedAt: string | null;
  expired: boolean;
}

export interface AdminInfo {
  readonly: boolean;
  capabilities: Capabilities;
  users: AdminUser[];
  ipRules: Array<{ id: string; cidr: string; note?: string }>;
  invites: AdminInvite[];
  ipPolicy: 'and' | 'or';
  allowLocalhost: boolean;
  trustProxy: boolean | number;
  roles: Array<{ name: string; permissions: string[] }>;
  visibility: Record<string, string[]>;
  audit: { sink: string; queryable: boolean; retentionDays: number | null };
}

export interface AuditEvent {
  ts: string;
  type: string;
  user?: { email: string; role: string } | null;
  ip: string;
  detail?: Record<string, unknown>;
}

export interface AuditFilter {
  user?: string;
  type?: string;
  from?: string;
  to?: string;
  q?: string;
  limit?: number;
  cursor?: string;
}

export interface UserPatch {
  role?: string;
  name?: string;
  status?: AdminUser['status'];
  password?: string;
  ipAllowlist?: string[];
}

function qs(filter: Record<string, string | number | undefined | null>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) if (v !== undefined && v !== '') params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : '';
}

export const api = {
  me: () => call<Me>('/me'),
  login: (email: string, password: string) => send<Me>('POST', '/login', { email, password }),
  logout: () => send<{ ok: true }>('POST', '/logout'),
  revokeOwnSessions: () => send<{ ok: true }>('POST', '/session/revoke-all'),
  specs: () => call<{ specs: Array<{ name: string }> }>('/specs'),
  spec: (name: string) => call<any>(`/spec?name=${encodeURIComponent(name)}`),
  try: (payload: { method: string; url: string; headers: Record<string, string>; body: string | null; spec: string }) =>
    send<TryResult>('POST', '/try', payload),

  admin: () => call<AdminInfo>('/admin'),
  createUser: (input: { email: string; password: string; role: string; name?: string; ipAllowlist?: string[] }) =>
    send<{ user: AdminUser }>('POST', '/admin/users', input),
  updateUser: (id: string, patch: UserPatch) => send<{ user: AdminUser }>('PATCH', `/admin/users/${encodeURIComponent(id)}`, patch),
  removeUser: (id: string) => send<{ ok: true }>('DELETE', `/admin/users/${encodeURIComponent(id)}`),
  revokeUserSessions: (id: string) => send<{ ok: true }>('POST', `/admin/users/${encodeURIComponent(id)}/revoke-sessions`),

  addIpRule: (input: { cidr: string; note?: string; force?: boolean }) =>
    send<{ rule: { id: string; cidr: string; note?: string } }>('POST', '/admin/ip', input),
  removeIpRule: (id: string, force = false) =>
    send<{ ok: true }>('DELETE', `/admin/ip/${encodeURIComponent(id)}${force ? '?force=true' : ''}`),

  createInvite: (input: { email: string; role: string; ttl?: string }) =>
    send<{ invite: AdminInvite; token: string; url: string }>('POST', '/admin/invites', input),
  revokeInvite: (id: string) => send<{ ok: true }>('DELETE', `/admin/invites/${encodeURIComponent(id)}`),
  inviteInfo: (token: string) => call<{ email: string; role: string; expiresAt: string }>(`/invites/info?token=${encodeURIComponent(token)}`),
  acceptInvite: (input: { token: string; password: string; name?: string }) => send<Me>('POST', '/invites/accept', input),

  audit: (filter: AuditFilter = {}) =>
    call<{ items: AuditEvent[]; nextCursor?: string | null }>(
      `/audit${qs(filter as Record<string, string | number | undefined>)}`,
    ),
  auditCsvUrl: (filter: AuditFilter = {}) =>
    `${boot.basePath}/api/audit.csv${qs({ ...filter, limit: undefined, cursor: undefined } as Record<string, string | number | undefined>)}`,
};
