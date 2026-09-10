import { deref, MAX_DEPTH } from './schema.js';
import type { OpenApiDoc } from './spec.js';

/**
 * Spec diff with breaking-change classification (spec §3.9, v0.4).
 *
 * "Breaking" is judged from the caller's side, and direction decides it: a
 * request may accept less than before, a response may promise less. So the
 * same edit is breaking in one place and harmless in the other — adding a
 * required property breaks requests, removing a property breaks responses.
 *
 * Like every other analysis in the core, this runs on the role-filtered
 * document: an operation someone may not see must not surface in their diff.
 */

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

export type ChangeKind =
  | 'path-added' | 'path-removed'
  | 'operation-added' | 'operation-removed' | 'operation-deprecated'
  | 'param-added-required' | 'param-added-optional' | 'param-removed' | 'param-required-added'
  | 'property-added-required' | 'property-added' | 'property-removed'
  | 'type-changed' | 'enum-value-removed' | 'enum-value-added'
  | 'response-added' | 'response-removed'
  | 'request-body-required'
  | 'security-added' | 'security-removed';

export interface SpecChange {
  kind: ChangeKind;
  breaking: boolean;
  /** Where it happened: 'GET /pets', 'GET /pets → 200', 'GET /pets → body'. */
  at: string;
  /** English sentence; the UI can localize from `kind` + `params`. */
  detail: string;
  params?: Record<string, string>;
}

export interface DiffResult {
  changes: SpecChange[];
  breaking: number;
  nonBreaking: number;
  versions: { before?: string; after?: string };
}

/** Which side of the wire a schema sits on — it decides what counts as breaking. */
type Direction = 'request' | 'response';

export function diffSpecs(before: OpenApiDoc, after: OpenApiDoc): DiffResult {
  const changes: SpecChange[] = [];
  const add = (kind: ChangeKind, breaking: boolean, at: string, detail: string, params?: Record<string, string>) =>
    changes.push({ kind, breaking, at, detail, ...(params ? { params } : {}) });

  const beforePaths = (before.paths ?? {}) as Record<string, any>;
  const afterPaths = (after.paths ?? {}) as Record<string, any>;

  for (const path of Object.keys(beforePaths)) {
    if (!afterPaths[path]) add('path-removed', true, path, `Path ${path} was removed.`, { path });
  }
  for (const path of Object.keys(afterPaths)) {
    if (!beforePaths[path]) add('path-added', false, path, `Path ${path} was added.`, { path });
  }

  for (const path of Object.keys(afterPaths)) {
    const oldItem = beforePaths[path];
    const newItem = afterPaths[path];
    if (!oldItem || typeof newItem !== 'object') continue;

    for (const method of HTTP_METHODS) {
      const oldOp = oldItem[method];
      const newOp = newItem[method];
      const at = `${method.toUpperCase()} ${path}`;
      if (oldOp && !newOp) { add('operation-removed', true, at, `${at} was removed.`); continue; }
      if (!oldOp && newOp) { add('operation-added', false, at, `${at} was added.`); continue; }
      if (!oldOp || !newOp) continue;

      if (!oldOp.deprecated && newOp.deprecated) {
        add('operation-deprecated', false, at, `${at} is now deprecated.`);
      }
      diffSecurity(before, after, oldOp, newOp, at, add);
      diffParameters(before, after, oldItem, newItem, oldOp, newOp, at, add);
      diffRequestBody(before, after, oldOp, newOp, at, add);
      diffResponses(before, after, oldOp, newOp, at, add);
    }
  }

  const breaking = changes.filter((c) => c.breaking).length;
  return {
    changes,
    breaking,
    nonBreaking: changes.length - breaking,
    versions: { before: before.info?.version, after: after.info?.version },
  };
}

/**
 * The same classified list as release notes (spec §3.9, v0.6). The CLI writes
 * this English rendering; the Changes screen builds the same shape from the
 * `/api/diff` response in the viewer's language. Classification itself stays
 * here, so the two can never disagree about what breaks.
 */
export function toMarkdown(result: DiffResult, labels: MarkdownLabels = {}): string {
  const l = { ...DEFAULT_LABELS, ...labels };
  const out: string[] = [];
  const { before, after } = result.versions;
  if (before || after) out.push(`## ${before ?? '?'} → ${after ?? '?'}`, '');
  if (!result.changes.length) return [...out, l.noChanges].join('\n') + '\n';

  for (const [heading, breaking] of [[l.breaking, true], [l.other, false]] as const) {
    const group = result.changes.filter((c) => c.breaking === breaking);
    if (!group.length) continue;
    out.push(`### ${heading}`, '');
    // Grouped by location, in the order the diff produced them.
    const byLocation = new Map<string, SpecChange[]>();
    for (const c of group) byLocation.set(c.at, [...(byLocation.get(c.at) ?? []), c]);
    for (const [at, items] of byLocation) {
      out.push(`- \`${at}\``);
      for (const c of items) out.push(`  - ${c.detail}`);
    }
    out.push('');
  }
  out.push(l.summary(result.breaking, result.nonBreaking), '');
  return out.join('\n');
}

export interface MarkdownLabels {
  breaking?: string;
  other?: string;
  noChanges?: string;
  summary?: (breaking: number, compatible: number) => string;
}

const DEFAULT_LABELS: Required<MarkdownLabels> = {
  breaking: 'Breaking changes',
  other: 'Other changes',
  noChanges: 'No changes.',
  summary: (b, c) => `_${b} breaking · ${c} compatible_`,
};

type Add = (kind: ChangeKind, breaking: boolean, at: string, detail: string, params?: Record<string, string>) => void;

/** Requiring auth where there was none locks out existing callers. */
function diffSecurity(before: OpenApiDoc, after: OpenApiDoc, oldOp: any, newOp: any, at: string, add: Add) {
  const had = (oldOp.security ?? before.security ?? []).length > 0;
  const has = (newOp.security ?? after.security ?? []).length > 0;
  if (!had && has) add('security-added', true, at, `${at} now requires authentication.`);
  if (had && !has) add('security-removed', false, at, `${at} no longer requires authentication.`);
}

function diffParameters(
  before: OpenApiDoc, after: OpenApiDoc,
  oldItem: any, newItem: any, oldOp: any, newOp: any, at: string, add: Add,
) {
  const collect = (doc: OpenApiDoc, item: any, op: any) => {
    const map = new Map<string, any>();
    for (const raw of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
      const p = deref(doc, raw);
      if (p && typeof p === 'object' && p.name) map.set(`${p.in}:${p.name}`, p);
    }
    return map;
  };
  const oldParams = collect(before, oldItem, oldOp);
  const newParams = collect(after, newItem, newOp);

  for (const [key, p] of oldParams) {
    if (!newParams.has(key)) {
      // A parameter the server no longer reads: callers still sending it are fine.
      add('param-removed', false, at, `Parameter "${p.name}" (${p.in}) was removed.`, { name: p.name, in: p.in });
    }
  }
  for (const [key, p] of newParams) {
    const old = oldParams.get(key);
    if (!old) {
      const kind = p.required ? 'param-added-required' : 'param-added-optional';
      add(kind, !!p.required, at,
        `${p.required ? 'Required parameter' : 'Parameter'} "${p.name}" (${p.in}) was added.`,
        { name: p.name, in: p.in });
      continue;
    }
    if (!old.required && p.required) {
      add('param-required-added', true, at, `Parameter "${p.name}" (${p.in}) is now required.`, { name: p.name, in: p.in });
    }
    diffSchema(before, after, old.schema, p.schema, `${at} → ${p.in}:${p.name}`, 'request', add);
  }
}

function diffRequestBody(before: OpenApiDoc, after: OpenApiDoc, oldOp: any, newOp: any, at: string, add: Add) {
  const oldBody = deref(before, oldOp.requestBody);
  const newBody = deref(after, newOp.requestBody);
  if (!oldBody && !newBody) return;
  if (!oldBody?.required && newBody?.required) {
    add('request-body-required', true, at, `${at} now requires a request body.`);
  }
  const oldSchema = jsonSchemaOf(oldBody);
  const newSchema = jsonSchemaOf(newBody);
  if (oldSchema || newSchema) {
    diffSchema(before, after, oldSchema, newSchema, `${at} → body`, 'request', add);
  }
}

function diffResponses(before: OpenApiDoc, after: OpenApiDoc, oldOp: any, newOp: any, at: string, add: Add) {
  const oldRes = (oldOp.responses ?? {}) as Record<string, any>;
  const newRes = (newOp.responses ?? {}) as Record<string, any>;
  for (const code of Object.keys(oldRes)) {
    if (!newRes[code]) {
      // Dropping a documented success response changes what callers can expect.
      add('response-removed', /^2/.test(code), `${at} → ${code}`, `Response ${code} was removed.`, { code });
    }
  }
  for (const code of Object.keys(newRes)) {
    if (!oldRes[code]) {
      add('response-added', false, `${at} → ${code}`, `Response ${code} was added.`, { code });
      continue;
    }
    diffSchema(
      before, after,
      jsonSchemaOf(deref(before, oldRes[code])),
      jsonSchemaOf(deref(after, newRes[code])),
      `${at} → ${code}`, 'response', add,
    );
  }
}

function jsonSchemaOf(node: any): any {
  const content = node?.content;
  if (!content) return null;
  const type = Object.keys(content).find((t) => /json/i.test(t));
  return type ? content[type].schema ?? null : null;
}

/**
 * Compare two schemas. `direction` decides who is hurt: a request must keep
 * accepting what callers send, a response must keep providing what callers read.
 */
function diffSchema(
  before: OpenApiDoc, after: OpenApiDoc,
  oldRaw: any, newRaw: any, at: string, direction: Direction, add: Add,
  depth = 0, seen = new Set<string>(),
) {
  if (depth > MAX_DEPTH) return;
  const oldS = deref(before, oldRaw);
  const newS = deref(after, newRaw);
  if (!oldS || !newS || typeof oldS !== 'object' || typeof newS !== 'object') return;

  const guard = `${at}|${depth}`;
  if (seen.has(guard)) return;
  seen.add(guard);

  const oldType = Array.isArray(oldS.type) ? oldS.type.join('|') : oldS.type;
  const newType = Array.isArray(newS.type) ? newS.type.join('|') : newS.type;
  if (oldType && newType && oldType !== newType) {
    add('type-changed', true, at, `Type changed from ${oldType} to ${newType}.`, { from: oldType, to: newType });
    return; // a different shape makes deeper comparison meaningless
  }

  if (Array.isArray(oldS.enum) || Array.isArray(newS.enum)) {
    const oldEnum = new Set((oldS.enum ?? []).map((v: unknown) => JSON.stringify(v)));
    const newEnum = new Set((newS.enum ?? []).map((v: unknown) => JSON.stringify(v)));
    for (const v of oldEnum) {
      // Requests: callers may still send a value the server dropped.
      if (!newEnum.has(v)) add('enum-value-removed', direction === 'request', at, `Enum value ${v} was removed.`, { value: String(v) });
    }
    for (const v of newEnum) {
      // Responses: callers may not handle a value they have never seen.
      if (!oldEnum.has(v)) add('enum-value-added', direction === 'response', at, `Enum value ${v} was added.`, { value: String(v) });
    }
  }

  const oldProps = (oldS.properties ?? {}) as Record<string, any>;
  const newProps = (newS.properties ?? {}) as Record<string, any>;
  const oldRequired = new Set<string>(oldS.required ?? []);
  const newRequired = new Set<string>(newS.required ?? []);

  for (const name of Object.keys(oldProps)) {
    if (!(name in newProps)) {
      // Responses: a field callers read is gone. Requests: the server ignores it.
      add('property-removed', direction === 'response', `${at}.${name}`, `Property "${name}" was removed.`, { name });
    }
  }
  for (const name of Object.keys(newProps)) {
    if (!(name in oldProps)) {
      const required = newRequired.has(name);
      add(required ? 'property-added-required' : 'property-added',
        required && direction === 'request', `${at}.${name}`,
        `${required ? 'Required property' : 'Property'} "${name}" was added.`, { name });
      continue;
    }
    if (!oldRequired.has(name) && newRequired.has(name) && direction === 'request') {
      add('property-added-required', true, `${at}.${name}`, `Property "${name}" is now required.`, { name });
    }
    diffSchema(before, after, oldProps[name], newProps[name], `${at}.${name}`, direction, add, depth + 1, seen);
  }

  if (oldS.items || newS.items) {
    diffSchema(before, after, oldS.items, newS.items, `${at}[]`, direction, add, depth + 1, seen);
  }
}
