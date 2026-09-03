import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthUser } from './types.js';

export interface SessionPayload {
  sub: string;
  /** Store-mode session id – lets the server revoke this cookie. */
  sid?: string;
  email: string;
  role: string;
  name?: string;
  ipAllowlist?: string[];
  iat: number;
  exp: number;
}

export function parseDuration(value: string | number | undefined, fallbackSec: number): number {
  if (value == null) return fallbackSec;
  if (typeof value === 'number') return value;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(value.trim());
  if (!m) throw new Error(`[ludin] Invalid duration: ${value}`);
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  const mult: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 };
  return Math.round(n * mult[unit]);
}

function b64u(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export class SessionSigner {
  private readonly secret: Buffer;
  constructor(secret: string | undefined, private readonly ttlSec: number) {
    if (!secret) {
      secret = randomBytes(32).toString('hex');
      if (process.env.NODE_ENV === 'production') {
        console.warn(
          '[ludin] No session secret configured – using a random one. Sessions will not survive restarts. ' +
            'Set auth.session.secret or LUDIN_SESSION_SECRET.',
        );
      }
    }
    this.secret = Buffer.from(secret);
  }

  issue(user: AuthUser, sid?: string): { token: string; exp: number } {
    const now = Math.floor(Date.now() / 1000);
    const payload: SessionPayload = {
      sub: user.id,
      sid,
      email: user.email,
      role: user.role,
      name: user.name,
      ipAllowlist: user.ipAllowlist,
      iat: now,
      exp: now + this.ttlSec,
    };
    const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = b64u(JSON.stringify(payload));
    const sig = this.sign(`${header}.${body}`);
    return { token: `${header}.${body}.${sig}`, exp: payload.exp };
  }

  verify(token: string | undefined): SessionPayload | null {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const expected = this.sign(`${header}.${body}`);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as SessionPayload;
      if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
      return payload;
    } catch {
      return null;
    }
  }

  private sign(data: string): string {
    return createHmac('sha256', this.secret).update(data).digest('base64url');
  }
}

export function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = Array.isArray(header) ? header.join('; ') : header;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function serializeCookie(
  name: string,
  value: string,
  opts: { path: string; maxAge?: number; secure: boolean; expires?: Date },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path}`, 'HttpOnly', 'SameSite=Lax'];
  if (opts.secure) parts.push('Secure');
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
  return parts.join('; ');
}
