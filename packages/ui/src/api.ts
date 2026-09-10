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
  /** Set when the viewer arrived through a share link. */
  share: { canTry: boolean; expiresAt: string } | null;
  shareEnabled?: boolean;
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
  /** Comparison against the documented response schema (core-side). */
  validation?: {
    checked: boolean;
    reason?: string;
    documented?: string[];
    status?: number;
    issues?: Array<{ path: string; message: string }>;
  };
}

export interface SearchEntry {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  tags: string[];
  fields: string[];
}

export interface DiffInfo {
  spec: string;
  changes: Array<{ kind: string; breaking: boolean; at: string; detail: string; params?: Record<string, string> }>;
  breaking: number;
  nonBreaking: number;
  versions: { before?: string; after?: string };
}

export interface LintInfo {
  spec: string;
  score: number;
  checks: number;
  passed: number;
  counts: { error: number; warn: number; info: number };
  issues: Array<{ rule: string; severity: 'error' | 'warn' | 'info'; path: string; message: string; params?: Record<string, string> }>;
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
  specs: () => call<{ specs: Array<{ name: string; hasBaseline?: boolean }> }>('/specs'),
  spec: (name: string) => call<any>(`/spec?name=${encodeURIComponent(name)}`),
  try: (payload: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string | null;
    spec: string;
    op?: { method: string; path: string };
  }) => send<TryResult>('POST', '/try', payload),

  samples: (spec: string, method: string, path: string) =>
    call<{ request: { method: string; url: string }; samples: Record<string, string> }>(
      `/samples?name=${encodeURIComponent(spec)}&method=${encodeURIComponent(method)}&path=${encodeURIComponent(path)}`,
    ),
  searchIndex: (spec: string) => call<{ index: SearchEntry[] }>(`/search-index?name=${encodeURIComponent(spec)}`),
  lint: (spec: string) => call<LintInfo>(`/lint?name=${encodeURIComponent(spec)}`),
  diff: (spec: string) => call<DiffInfo>(`/diff?name=${encodeURIComponent(spec)}`),

  specDownloadUrl: (name: string, format: 'json' | 'yaml') =>
    `${boot.basePath}/api/spec.${format}?name=${encodeURIComponent(name)}`,

  admin: () => call<AdminInfo>('/admin'),
  createShare: (body: { role: string; ttl?: string; spec?: string; canTry?: boolean; label?: string }) =>
    send<{ url: string; expiresAt: string; role: string; canTry: boolean; spec: string | null }>('POST', '/share', body),
};
