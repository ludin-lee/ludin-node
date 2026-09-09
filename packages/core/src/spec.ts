import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import YAML from 'yaml';
import type { Role, SpecEntry, SpecSource } from './types.js';

export type OpenApiDoc = Record<string, any>;

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

export class SpecLoader {
  private cache = new Map<string, { doc: OpenApiDoc; at: number }>();
  readonly entries: SpecEntry[];

  constructor(spec: SpecSource | SpecEntry[]) {
    this.entries = Array.isArray(spec) ? spec : [{ name: 'default', spec }];
    if (this.entries.length === 0) throw new Error('[ludin] At least one spec is required.');
  }

  /** Specs visible to a role (name + visibleTo only, no docs loaded). */
  listFor(role: Role | null): Array<{ name: string }> {
    return this.entries
      .filter((e) => !e.visibleTo || (role != null && e.visibleTo.includes(role)))
      .map((e) => ({ name: e.name }));
  }

  async load(name: string): Promise<OpenApiDoc | null> {
    const entry = this.entries.find((e) => e.name === name);
    if (!entry) return null;
    const src = entry.spec;

    if (typeof src === 'function') {
      return clone(await src()) as OpenApiDoc;
    }
    if (typeof src === 'object') {
      return clone(src) as OpenApiDoc;
    }
    // string: URL or file path — cached for 5s to avoid disk thrash while allowing edits.
    const cached = this.cache.get(name);
    if (cached && Date.now() - cached.at < 5000) return clone(cached.doc);
    let text: string;
    if (/^https?:\/\//.test(src)) {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`[ludin] Failed to fetch spec ${src}: ${res.status}`);
      text = await res.text();
    } else {
      text = await readFile(resolve(src), 'utf8');
    }
    const doc = parseSpecText(text, src);
    this.cache.set(name, { doc, at: Date.now() });
    return clone(doc);
  }
}

/** Serialise a document back to YAML (for the download button). */
export function toYaml(doc: OpenApiDoc): string {
  return YAML.stringify(doc);
}

export function parseSpecText(text: string, hint = ''): OpenApiDoc {
  const trimmed = text.trimStart();
  let doc: OpenApiDoc;
  if (trimmed.startsWith('{') || hint.endsWith('.json')) {
    doc = JSON.parse(text);
  } else {
    doc = YAML.parse(text);
  }
  if (doc && typeof doc === 'object' && 'swagger' in doc && !('openapi' in doc)) {
    console.warn('[ludin] Swagger 2.0 documents are rendered best-effort; convert to OpenAPI 3 for full support.');
  }
  return doc;
}

function clone<T>(v: T): T {
  return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
}

/**
 * Remove operations the role may not see.
 * Rules: `tag:Name` → operations carrying that tag, `/path/prefix/*` or exact
 * path → operations under the path, `METHOD /path` → one operation.
 */
export function applyVisibility(
  doc: OpenApiDoc,
  visibility: Record<string, Role[]> | undefined,
  role: Role | null,
): OpenApiDoc {
  if (!visibility || !doc.paths) return doc;
  const rules = Object.entries(visibility);
  const allowed = (roles: Role[]) => role != null && roles.includes(role);

  for (const [path, item] of Object.entries<any>(doc.paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      let hidden = false;
      for (const [rule, roles] of rules) {
        if (allowed(roles)) continue;
        if (rule.startsWith('tag:')) {
          const tag = rule.slice(4);
          if (Array.isArray(op.tags) && op.tags.includes(tag)) hidden = true;
        } else if (/^[A-Z]+ /.test(rule)) {
          const [m, p] = rule.split(/\s+/, 2);
          if (m.toLowerCase() === method && matchPath(p, path)) hidden = true;
        } else if (matchPath(rule, path)) {
          hidden = true;
        }
        if (hidden) break;
      }
      if (hidden) delete item[method];
    }
    if (!HTTP_METHODS.some((m) => item[m])) delete doc.paths[path];
  }

  // Drop tags with no remaining operations.
  if (Array.isArray(doc.tags)) {
    const used = new Set<string>();
    for (const item of Object.values<any>(doc.paths)) {
      for (const m of HTTP_METHODS) for (const t of item?.[m]?.tags ?? []) used.add(t);
    }
    doc.tags = doc.tags.filter((t: any) => used.has(t?.name));
  }
  return doc;
}

function matchPath(pattern: string, path: string): boolean {
  if (pattern.endsWith('/*')) return path === pattern.slice(0, -2) || path.startsWith(pattern.slice(0, -1));
  if (pattern.endsWith('*')) return path.startsWith(pattern.slice(0, -1));
  return pattern === path;
}

/** Hosts the Try-it-out proxy may call, derived from `servers`. */
export function serverOrigins(doc: OpenApiDoc): string[] {
  const out: string[] = [];
  for (const s of doc.servers ?? []) {
    if (typeof s?.url !== 'string') continue;
    try {
      const url = s.url.replace(/\{[^}]+\}/g, 'x');
      if (/^https?:\/\//.test(url)) out.push(new URL(url).origin);
    } catch {
      /* ignore */
    }
  }
  return out;
}
