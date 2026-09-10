import { deref, MAX_DEPTH } from './schema.js';
import type { OpenApiDoc } from './spec.js';

/**
 * Response validation for Try it out (spec §6, v0.3). Deliberately a minimal
 * validator of our own — type, required, enum, nullable, format — instead of a
 * JSON Schema library, to keep the core's zero-dependency rule (open decision
 * §7). It reports drift, it does not certify conformance.
 */

export interface ValidationIssue {
  path: string;      // '$.items[0].id'
  message: string;
}

const MAX_ISSUES = 20;

const FORMATS: Record<string, RegExp> = {
  'date-time': /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  uri: /^[a-z][a-z0-9+.-]*:/i,
};

export function validateAgainstSchema(doc: OpenApiDoc, schema: any, value: unknown, basePath = '$'): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  walk(doc, schema, value, basePath, issues, 0, new Set());
  return issues;
}

function walk(doc: OpenApiDoc, schema: any, value: unknown, path: string, issues: ValidationIssue[], depth: number, seen: Set<any>): void {
  if (issues.length >= MAX_ISSUES || depth > MAX_DEPTH) return;
  schema = deref(doc, schema);
  if (!schema || typeof schema !== 'object' || seen.has(schema)) return;

  if (value === null) {
    const nullOk = schema.nullable === true || schema.type === 'null' || (Array.isArray(schema.type) && schema.type.includes('null'));
    if (!nullOk && schema.type) issues.push({ path, message: `expected ${schema.type}, got null` });
    return;
  }

  // Composition: pass when any branch validates cleanly; allOf must all pass.
  const variants = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(variants) && variants.length) {
    const branches = variants.map((v: any) => {
      const sub: ValidationIssue[] = [];
      walk(doc, v, value, path, sub, depth + 1, seen);
      return sub;
    });
    if (!branches.some((b) => b.length === 0)) {
      issues.push({ path, message: `matches none of the ${variants.length} ${schema.oneOf ? 'oneOf' : 'anyOf'} variants` });
    }
    return;
  }
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) walk(doc, part, value, path, issues, depth + 1, seen);
  }

  const actual = Array.isArray(value) ? 'array' : typeof value;
  const declared = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (declared.length) {
    const ok = declared.some((t: string) =>
      t === actual ||
      (t === 'integer' && actual === 'number' && Number.isInteger(value)) ||
      (t === 'number' && actual === 'number') ||
      (t === 'null' && value === null),
    );
    if (!ok) {
      issues.push({ path, message: `expected ${declared.join(' | ')}, got ${actual}` });
      return; // wrong shape – deeper checks would only cascade
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e: unknown) => deepEqual(e, value))) {
    issues.push({ path, message: `value ${short(value)} is not in enum [${schema.enum.map(short).join(', ')}]` });
  }
  if (typeof value === 'string' && schema.format && FORMATS[schema.format] && !FORMATS[schema.format].test(value)) {
    issues.push({ path, message: `${short(value)} does not look like a ${schema.format}` });
  }

  seen.add(schema);
  if (Array.isArray(value)) {
    value.slice(0, 20).forEach((item, i) => walk(doc, schema.items ?? {}, item, `${path}[${i}]`, issues, depth + 1, seen));
  } else if (actual === 'object') {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in obj)) issues.push({ path, message: `missing required property "${req}"` });
    }
    for (const [name, prop] of Object.entries<any>(schema.properties ?? {})) {
      if (name in obj) walk(doc, prop, obj[name], `${path}.${name}`, issues, depth + 1, seen);
    }
  }
  seen.delete(schema);
}

/** The declared schema for one operation response (status, else default), JSON media only. */
/**
 * Why a response could not be compared — the distinction matters. A documented
 * response that simply carries no schema is nothing to report; a status code the
 * document never mentions is drift in its own right, and staying silent about it
 * would let "no warning" be read as "the response matches".
 */
export type ResponseLookup =
  | { schema: any; code: string }
  | { schema: null; reason: 'undocumented_status'; documented: string[] }
  | { schema: null; reason: 'no_schema'; code: string };

export function lookupResponseSchema(doc: OpenApiDoc, method: string, path: string, status: number): ResponseLookup | null {
  const op = doc.paths?.[path]?.[method.toLowerCase()];
  if (!op?.responses) return null;   // the operation documents nothing at all

  const exact = String(status);
  const wildcard = `${exact[0]}XX`;
  const code = op.responses[exact] ? exact : op.responses[wildcard] ? wildcard : op.responses.default ? 'default' : null;
  if (!code) {
    return { schema: null, reason: 'undocumented_status', documented: Object.keys(op.responses) };
  }

  const content = deref(doc, op.responses[code])?.content;
  const jsonType = content && Object.keys(content).find((t) => /json/i.test(t));
  const schema = jsonType ? content[jsonType].schema ?? null : null;
  return schema ? { schema, code } : { schema: null, reason: 'no_schema', code };
}

/** Back-compatible helper: the schema alone, or null for any reason. */
export function responseSchemaFor(doc: OpenApiDoc, method: string, path: string, status: number): any | null {
  const found = lookupResponseSchema(doc, method, path, status);
  return found && found.schema ? found.schema : null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function short(v: unknown): string {
  const s = JSON.stringify(v);
  return s && s.length > 40 ? s.slice(0, 40) + '…' : String(s);
}
