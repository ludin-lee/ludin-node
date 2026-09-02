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

export interface Me {
  authenticated: boolean;
  anonymous: boolean;
  user: { email: string; name?: string; role: string } | null;
  permissions: string[];
  readonly: boolean;
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

export interface AdminInfo {
  readonly: boolean;
  users: Array<{ email: string; name?: string; role: string; status: string; ipAllowlist: string[]; hashed: boolean }>;
  ipRules: Array<{ id: string; cidr: string; note?: string }>;
  ipPolicy: 'and' | 'or';
  allowLocalhost: boolean;
  trustProxy: boolean | number;
  roles: Array<{ name: string; permissions: string[] }>;
  visibility: Record<string, string[]>;
  audit: { sink: string };
}

export const api = {
  me: () => call<Me>('/me'),
  login: (email: string, password: string) => call<Me>('/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => call<{ ok: true }>('/logout', { method: 'POST' }),
  specs: () => call<{ specs: Array<{ name: string }> }>('/specs'),
  spec: (name: string) => call<any>(`/spec?name=${encodeURIComponent(name)}`),
  try: (payload: { method: string; url: string; headers: Record<string, string>; body: string | null; spec: string }) =>
    call<TryResult>('/try', { method: 'POST', body: JSON.stringify(payload) }),
  admin: () => call<AdminInfo>('/admin'),
};
