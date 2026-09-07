import type { AuditEvent, AuditOptions } from './types.js';

const DEFAULT_MASK = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'password', 'token', 'secret'];

export class Auditor {
  private readonly mask: Set<string>;
  private readonly sink: AuditOptions['sink'];
  constructor(private readonly opts: AuditOptions = {}) {
    this.mask = new Set([...DEFAULT_MASK, ...(opts.mask ?? [])].map((s) => s.toLowerCase()));
    this.sink = opts.sink === undefined ? defaultSink : opts.sink;
  }

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
    } catch (err) {
      console.error('[ludin] audit sink failed', err);
    }
  }
}

function defaultSink(e: AuditEvent) {
  process.stdout.write(JSON.stringify({ ludin: true, ...e }) + '\n');
}
