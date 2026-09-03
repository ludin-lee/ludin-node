import type { AuditEvent, AuditOptions, LudinStore } from './types.js';

const DEFAULT_MASK = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'password', 'token', 'secret'];

export class Auditor {
  private readonly mask: Set<string>;
  private readonly sink: AuditOptions['sink'];
  constructor(private readonly opts: AuditOptions = {}, private readonly store?: LudinStore) {
    this.mask = new Set([...DEFAULT_MASK, ...(opts.mask ?? [])].map((s) => s.toLowerCase()));
    this.sink = opts.sink === undefined ? defaultSink : opts.sink;
  }

  private lastPrune = 0;

  get recordBodies(): boolean {
    return !!this.opts.recordBodies;
  }

  maskObject<T extends Record<string, unknown>>(obj: T | undefined): T | undefined {
    if (!obj) return obj;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = this.mask.has(k.toLowerCase()) ? '***' : v;
    }
    return out as T;
  }

  async emit(event: Omit<AuditEvent, 'ts'>): Promise<void> {
    const full: AuditEvent = { ts: new Date().toISOString(), ...event };
    try {
      if (this.sink) await this.sink(full);
      if (this.store?.audit) await this.store.audit.append(full);
    } catch (err) {
      console.error('[ludin] audit sink failed', err);
    }
    void this.prune();
  }

  /** Retention: drop old events, at most once an hour. */
  private async prune(): Promise<void> {
    const days = this.opts.retentionDays;
    if (!days || !this.store?.audit?.prune) return;
    const now = Date.now();
    if (now - this.lastPrune < 3600_000) return;
    this.lastPrune = now;
    try {
      await this.store.audit.prune(new Date(now - days * 86400_000).toISOString());
    } catch (err) {
      console.error('[ludin] audit prune failed', err);
    }
  }
}

function defaultSink(e: AuditEvent) {
  process.stdout.write(JSON.stringify({ ludin: true, ...e }) + '\n');
}
