import { deref } from './schema.js';
import type { OpenApiDoc } from './spec.js';

/**
 * `ludin lint` + documentation health score (spec §6, v0.3). The score is the
 * share of checks that pass — explainable, and stable across spec sizes.
 */

export type LintSeverity = 'error' | 'warn' | 'info';

export interface LintIssue {
  rule: string;
  severity: LintSeverity;
  path: string;       // 'GET /pets' or 'info'
  message: string;    // English; the UI translates via `rule` + `params`
  params?: Record<string, string>;
}

export interface LintResult {
  score: number;      // 0–100, % of checks passing
  checks: number;
  passed: number;
  counts: Record<LintSeverity, number>;
  issues: LintIssue[];
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

export interface LintOptions {
  /** Rule names to skip entirely – they count neither as checks nor as issues, so the score reflects only the rules you care about. */
  ignore?: string[];
}

export function lintSpec(doc: OpenApiDoc, options: LintOptions = {}): LintResult {
  const ignored = new Set(options.ignore ?? []);
  const issues: LintIssue[] = [];
  let checks = 0;
  const check = (ok: boolean, rule: string, severity: LintSeverity, path: string, message: string, params?: Record<string, string>) => {
    if (ignored.has(rule)) return;
    checks++;
    if (!ok) issues.push({ rule, severity, path, message, ...(params ? { params } : {}) });
  };

  check(!!doc.info?.description, 'info-description', 'warn', 'info', 'The document has no info.description.');
  check((doc.servers ?? []).length > 0, 'servers', 'warn', 'servers', 'No servers are declared; Try it out and code samples have no base URL.');

  const containers = [doc.paths ?? {}, doc.webhooks ?? {}];
  for (const container of containers)
  for (const [path, item] of Object.entries<any>(container)) {
    if (!item || typeof item !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      const at = `${method.toUpperCase()} ${path}`;

      check(!!op.summary, 'op-summary', 'warn', at, 'Operation has no summary.');
      check(!!op.operationId, 'op-id', 'warn', at, 'Operation has no operationId (deep links and samples degrade).');
      check((op.tags ?? []).length > 0, 'op-tags', 'info', at, 'Operation is untagged; it lands in a default group.');

      for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])].map((x: any) => deref(doc, x))) {
        if (p && typeof p === 'object' && p.name) {
          check(!!p.description, 'param-description', 'info', at, `Parameter "${p.name}" has no description.`, { name: String(p.name) });
        }
      }

      const body = deref(doc, op.requestBody);
      if (body) {
        const hasSchema = Object.values<any>(body.content ?? {}).some((m) => m?.schema);
        check(hasSchema, 'body-schema', 'error', at, 'Request body declares no schema.');
      }

      const responses = Object.entries<any>(op.responses ?? {});
      check(
        responses.some(([code]) => /^2/.test(code)),
        'success-response', 'error', at, 'No 2xx response is documented.',
      );
      for (const [code, resRef] of responses) {
        const res = deref(doc, resRef);
        check(!!res?.description, 'response-description', 'info', `${at} → ${code}`, `Response ${code} has no description.`, { code });
        if (/^2/.test(code) && method !== 'head') {
          const hasSchema = !res?.content || Object.values<any>(res.content).some((m) => m?.schema);
          check(hasSchema, 'response-schema', 'warn', `${at} → ${code}`, `Response ${code} declares content without a schema.`, { code });
        }
      }
    }
  }

  const counts: Record<LintSeverity, number> = { error: 0, warn: 0, info: 0 };
  for (const i of issues) counts[i.severity]++;
  const passed = checks - issues.length;
  return {
    score: checks === 0 ? 100 : Math.round((passed / checks) * 100),
    checks,
    passed,
    counts,
    issues,
  };
}
