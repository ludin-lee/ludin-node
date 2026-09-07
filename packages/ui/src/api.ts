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

export interface Me {
  authenticated: boolean;
  anonymous: boolean;
  user: { email: string; name?: string; role: string } | null;
  permissions: string[];
  /** Present when a readme page is configured and visible to this role. */
  readme: { label: string } | null;
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
  ipAllowlist: string[];
  hashed: boolean;
}

export interface AdminInfo {
  users: AdminUser[];
  /** Accounts are checked by your own `auth.verify`, so the list may be empty. */
  customVerifier: boolean;
  ipRules: string[];
  ipPolicy: 'and' | 'or';
  allowLocalhost: boolean;
  trustProxy: boolean | number;
  roles: Array<{ name: string; permissions: string[] }>;
  visibility: Record<string, string[]>;
  readme: { label: string; path: string; visibleTo: string[] } | null;
  audit: { sink: string };
}

export const api = {
  me: () => call<Me>('/me'),
  login: (email: string, password: string) => send<Me>('POST', '/login', { email, password }),
  logout: () => send<{ ok: true }>('POST', '/logout'),
  specs: () => call<{ specs: Array<{ name: string }> }>('/specs'),
  spec: (name: string) => call<any>(`/spec?name=${encodeURIComponent(name)}`),
  try: (payload: { method: string; url: string; headers: Record<string, string>; body: string | null; spec: string }) =>
    send<TryResult>('POST', '/try', payload),

  specDownloadUrl: (name: string, format: 'json' | 'yaml') =>
    `${boot.basePath}/api/spec.${format}?name=${encodeURIComponent(name)}`,

  admin: () => call<AdminInfo>('/admin'),
};
