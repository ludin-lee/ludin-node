import { isIP } from 'node:net';

/** Normalise IPv4-mapped IPv6 (::ffff:1.2.3.4) to plain IPv4. */
export function normalizeIp(ip: string): string {
  ip = ip.trim();
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m) return m[1];
  // strip zone id (fe80::1%eth0)
  const z = ip.indexOf('%');
  if (z > 0) ip = ip.slice(0, z);
  return ip;
}

function ipToBigInt(ip: string): { value: bigint; bits: number } | null {
  ip = normalizeIp(ip);
  const v = isIP(ip);
  if (v === 4) {
    const parts = ip.split('.').map(Number);
    let n = 0n;
    for (const p of parts) n = (n << 8n) | BigInt(p);
    return { value: n, bits: 32 };
  }
  if (v === 6) {
    // Expand :: and possible embedded IPv4
    let [head, tail] = ip.split('::');
    const headParts = head ? head.split(':') : [];
    const tailParts = tail ? tail.split(':') : [];
    const expand = (parts: string[]) =>
      parts.flatMap((p) => {
        if (p.includes('.')) {
          const v4 = ipToBigInt(p)!.value;
          return [Number(v4 >> 16n), Number(v4 & 0xffffn)];
        }
        return [parseInt(p, 16)];
      });
    const h = expand(headParts);
    const t = expand(tailParts);
    const missing = 8 - h.length - t.length;
    const groups = [...h, ...Array(Math.max(missing, 0)).fill(0), ...t];
    let n = 0n;
    for (const g of groups) n = (n << 16n) | BigInt(g);
    return { value: n, bits: 128 };
  }
  return null;
}

export interface IpMatcher {
  (ip: string): boolean;
  rules: string[];
}

/**
 * Build a matcher from rules: single IPs, CIDR ranges (`10.0.0.0/8`,
 * `2001:db8::/32`), ranges (`192.168.1.10-192.168.1.20`), or `*`.
 */
export function createIpMatcher(rules: string[] = []): IpMatcher {
  const compiled: Array<(v: bigint, bits: number) => boolean> = [];
  const cleaned = rules.map((r) => r.trim()).filter(Boolean);

  for (const rule of cleaned) {
    if (rule === '*') {
      compiled.push(() => true);
      continue;
    }
    if (rule.includes('-') && !rule.includes(':')) {
      const [a, b] = rule.split('-').map((s) => ipToBigInt(s));
      if (!a || !b) throw new Error(`[ludin] Invalid IP range: ${rule}`);
      compiled.push((v, bits) => bits === a.bits && v >= a.value && v <= b.value);
      continue;
    }
    const [base, prefixStr] = rule.split('/');
    const parsed = ipToBigInt(base);
    if (!parsed) throw new Error(`[ludin] Invalid IP / CIDR: ${rule}`);
    const prefix = prefixStr == null ? parsed.bits : Number(prefixStr);
    if (Number.isNaN(prefix) || prefix < 0 || prefix > parsed.bits) {
      throw new Error(`[ludin] Invalid CIDR prefix: ${rule}`);
    }
    const shift = BigInt(parsed.bits - prefix);
    const network = parsed.value >> shift;
    compiled.push((v, bits) => bits === parsed.bits && v >> shift === network);
  }

  const matcher = ((ip: string) => {
    const parsed = ipToBigInt(ip);
    if (!parsed) return false;
    return compiled.some((fn) => fn(parsed.value, parsed.bits));
  }) as IpMatcher;
  matcher.rules = cleaned;
  return matcher;
}

export function isLocalhost(ip: string): boolean {
  ip = normalizeIp(ip);
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.');
}

/**
 * Resolve the client IP honouring `trustProxy`.
 * `true` → trust one hop (last address in X-Forwarded-For chain added by our proxy);
 * a number → number of trusted proxies.
 */
export function resolveClientIp(
  remoteAddress: string,
  headers: Record<string, string | string[] | undefined>,
  trustProxy: boolean | number | undefined,
): string {
  if (!trustProxy) return normalizeIp(remoteAddress);
  const hops = trustProxy === true ? 1 : trustProxy;
  const xff = headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff.join(',') : xff;
  if (raw) {
    const chain = raw.split(',').map((s) => s.trim()).filter(Boolean);
    // chain = [client, proxy1, proxy2 ...]; remoteAddress is the last proxy.
    const idx = Math.max(chain.length - hops, 0);
    return normalizeIp(chain[idx]);
  }
  const real = headers['x-real-ip'];
  if (typeof real === 'string' && real) return normalizeIp(real);
  return normalizeIp(remoteAddress);
}
