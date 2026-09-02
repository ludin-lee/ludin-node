import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

function scrypt(pw: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(pw, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;

/** Produce a `$scrypt$N$r$p$salt$hash` string (all base64url). */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await scrypt(plain, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }));
  return `$scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function isHashed(value: string): boolean {
  return /^\$(scrypt|2a|2b|2y|argon2(i|d|id))\$/.test(value);
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verify `plain` against `stored`, which may be plain text (binding mode) or
 * one of the supported hash formats. bcrypt / argon2 require the optional
 * `bcryptjs` / `argon2` packages.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (typeof stored !== 'string' || typeof plain !== 'string') return false;

  if (stored.startsWith('$scrypt$')) {
    const [, , n, r, p, salt, hash] = stored.split('$');
    const key = (await scrypt(plain, Buffer.from(salt, 'base64url'), KEYLEN, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    }));
    return safeEqual(key, Buffer.from(hash, 'base64url'));
  }

  if (/^\$2[aby]\$/.test(stored)) {
    const bcrypt = await optionalImport<{ compare(a: string, b: string): Promise<boolean> }>('bcryptjs');
    return bcrypt.compare(plain, stored);
  }

  if (stored.startsWith('$argon2')) {
    const argon2 = await optionalImport<{ verify(hash: string, plain: string): Promise<boolean> }>('argon2');
    return argon2.verify(stored, plain);
  }

  // Plain text (binding mode).
  return safeEqual(Buffer.from(plain), Buffer.from(stored));
}

async function optionalImport<T>(name: string): Promise<T> {
  try {
    const mod = (await import(name)) as { default?: T } & T;
    return (mod.default ?? mod) as T;
  } catch {
    throw new Error(
      `[rudin] A password uses the ${name} format but the "${name}" package is not installed. ` +
        `Run: npm i ${name}`,
    );
  }
}
