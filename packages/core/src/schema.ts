import type { OpenApiDoc } from './spec.js';

/**
 * Shared JSON-schema helpers for the v0.3 features (samples, search index,
 * response validation, lint). All of them walk untrusted documents, so every
 * walk here is depth-capped and cycle-guarded.
 */

export const MAX_DEPTH = 6;

/** Resolve a local `$ref` ('#/components/…'). Remote refs are left untouched. */
export function deref(doc: OpenApiDoc, node: any): any {
  let current = node;
  for (let hops = 0; hops < 10 && current && typeof current.$ref === 'string'; hops++) {
    if (!current.$ref.startsWith('#/')) return current;
    let target: any = doc;
    for (const seg of current.$ref.slice(2).split('/')) {
      target = target?.[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    if (!target) return current;
    current = target;
  }
  return current;
}

/** A plausible example value for a schema: examples win, then type defaults. */
export function exampleFromSchema(doc: OpenApiDoc, schema: any, depth = 0, seen = new Set<any>()): any {
  schema = deref(doc, schema);
  if (!schema || typeof schema !== 'object' || depth > MAX_DEPTH || seen.has(schema)) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const variants = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(variants) && variants.length) return exampleFromSchema(doc, variants[0], depth + 1, seen);
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    const merged: Record<string, any> = {};
    for (const part of schema.allOf) {
      const v = exampleFromSchema(doc, part, depth + 1, seen);
      if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(merged, v);
    }
    return merged;
  }

  seen.add(schema);
  try {
    const type = schema.type ?? (schema.properties ? 'object' : schema.items ? 'array' : undefined);
    switch (type) {
      case 'object': {
        const out: Record<string, any> = {};
        for (const [name, prop] of Object.entries<any>(schema.properties ?? {})) {
          out[name] = exampleFromSchema(doc, prop, depth + 1, seen);
        }
        return out;
      }
      case 'array':
        return [exampleFromSchema(doc, schema.items ?? {}, depth + 1, seen)];
      case 'integer':
      case 'number':
        return 0;
      case 'boolean':
        return true;
      case 'string':
        switch (schema.format) {
          case 'date-time': return '2026-01-01T00:00:00Z';
          case 'date': return '2026-01-01';
          case 'email': return 'user@example.com';
          case 'uuid': return '00000000-0000-0000-0000-000000000000';
          case 'uri': return 'https://example.com';
          case 'binary': return '<binary>';
          default: return 'string';
        }
      default:
        return null;
    }
  } finally {
    seen.delete(schema);
  }
}

/** Every property name reachable from a schema (deduped, capped). */
export function collectFieldNames(doc: OpenApiDoc, schema: any, out = new Set<string>(), depth = 0, seen = new Set<any>()): Set<string> {
  schema = deref(doc, schema);
  if (!schema || typeof schema !== 'object' || depth > MAX_DEPTH || seen.has(schema) || out.size >= 60) return out;
  seen.add(schema);
  for (const [name, prop] of Object.entries<any>(schema.properties ?? {})) {
    out.add(name);
    collectFieldNames(doc, prop, out, depth + 1, seen);
  }
  if (schema.items) collectFieldNames(doc, schema.items, out, depth + 1, seen);
  for (const part of [...(schema.allOf ?? []), ...(schema.oneOf ?? []), ...(schema.anyOf ?? [])]) {
    collectFieldNames(doc, part, out, depth + 1, seen);
  }
  seen.delete(schema);
  return out;
}
