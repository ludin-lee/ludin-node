/** In-memory brute-force guard keyed by `ip|email`. */
export class Lockout {
  private readonly attempts = new Map<string, { count: number; first: number; lockedUntil?: number }>();
  constructor(private readonly max: number, private readonly windowMs: number) {}

  private key(ip: string, email: string) {
    return `${ip}|${email.toLowerCase()}`;
  }

  /** Returns remaining lock seconds or 0. */
  check(ip: string, email: string): number {
    const e = this.attempts.get(this.key(ip, email));
    if (!e) return 0;
    const now = Date.now();
    if (e.lockedUntil && e.lockedUntil > now) return Math.ceil((e.lockedUntil - now) / 1000);
    if (now - e.first > this.windowMs) {
      this.attempts.delete(this.key(ip, email));
    }
    return 0;
  }

  fail(ip: string, email: string): void {
    const k = this.key(ip, email);
    const now = Date.now();
    const e = this.attempts.get(k);
    if (!e || now - e.first > this.windowMs) {
      this.attempts.set(k, { count: 1, first: now });
      return;
    }
    e.count += 1;
    if (e.count >= this.max) e.lockedUntil = now + this.windowMs;
  }

  reset(ip: string, email: string): void {
    this.attempts.delete(this.key(ip, email));
  }
}
