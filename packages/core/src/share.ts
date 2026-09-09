import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Expiring share links (spec §3.10, v0.4).
 *
 * A share link is a signed, stateless grant — there is no store to revoke it
 * from, so every restriction has to travel inside the token and be re-checked
 * on use. Three rules hold the design together:
 *
 *  1. It is an identity, not a bypass. A shared request walks the same pipeline
 *     as everyone else (§4.4): the IP allowlist still applies, roles still
 *     apply, `visibility` still filters the document.
 *  2. It can never reach the admin surface, and it cannot execute requests
 *     unless the link was explicitly created that way.
 *  3. It is signed in its own namespace, so a share token can never be
 *     presented as a session cookie, nor a session as a share.
 */

export interface SharePayload {
  kind: 'share';
  role: string;
  /** Restrict the link to a single spec by name. */
  spec?: string;
  /** Whether Try it out is allowed. Default false: a share link reads. */
  canTry: boolean;
  /** Free-text note shown in the audit log, e.g. the partner's name. */
  label?: string;
  iat: number;
  exp: number;
}

/** HMAC namespace: keeps share tokens and session cookies mutually unusable. */
const DOMAIN = 'ludin.share.v1';

export class ShareSigner {
  private readonly secret: Buffer;

  constructor(secret: string | undefined) {
    this.secret = Buffer.from(secret ?? randomBytes(32).toString('hex'));
  }

  issue(input: Omit<SharePayload, 'kind' | 'iat' | 'exp'>, ttlSec: number): { token: string; exp: number } {
    const now = Math.floor(Date.now() / 1000);
    const payload: SharePayload = { ...input, kind: 'share', iat: now, exp: now + ttlSec };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return { token: `${body}.${this.sign(body)}`, exp: payload.exp };
  }

  verify(token: string | undefined): SharePayload | null {
    if (!token) return null;
    const idx = token.lastIndexOf('.');
    if (idx <= 0) return null;
    const body = token.slice(0, idx);
    const sig = Buffer.from(token.slice(idx + 1));
    const expected = Buffer.from(this.sign(body));
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as SharePayload;
      if (payload.kind !== 'share') return null;
      if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
      if (typeof payload.role !== 'string' || !payload.role) return null;
      return { ...payload, canTry: payload.canTry === true };
    } catch {
      return null;
    }
  }

  private sign(data: string): string {
    return createHmac('sha256', this.secret).update(`${DOMAIN}.${data}`).digest('base64url');
  }
}
