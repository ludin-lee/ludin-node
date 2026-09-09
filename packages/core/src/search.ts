import { collectFieldNames } from './schema.js';
import type { OpenApiDoc } from './spec.js';

/**
 * ⌘K search index (spec §6, v0.3). Built in the core from the role-filtered
 * document — the index can name schema fields, so it must never be built from
 * the unfiltered spec. The UI only fuzzy-matches over these entries.
 */

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

export interface SearchEntry {
  method: string;          // upper case
  path: string;
  operationId?: string;
  summary?: string;
  tags: string[];
  /** Property names from parameters, request body and responses. */
  fields: string[];
}

export function buildSearchIndex(doc: OpenApiDoc): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const [path, item] of Object.entries<any>(doc.paths ?? {})) {
    if (!item || typeof item !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      const fields = new Set<string>();
      for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
        if (p && typeof p === 'object' && typeof p.name === 'string') fields.add(p.name);
      }
      for (const media of Object.values<any>(op.requestBody?.content ?? {})) {
        collectFieldNames(doc, media?.schema, fields);
      }
      for (const res of Object.values<any>(op.responses ?? {})) {
        for (const media of Object.values<any>(res?.content ?? {})) {
          collectFieldNames(doc, media?.schema, fields);
        }
      }
      out.push({
        method: method.toUpperCase(),
        path,
        operationId: typeof op.operationId === 'string' ? op.operationId : undefined,
        summary: typeof op.summary === 'string' ? op.summary : undefined,
        tags: Array.isArray(op.tags) ? op.tags.filter((t: unknown) => typeof t === 'string') : [],
        fields: [...fields].slice(0, 60),
      });
    }
  }
  return out;
}
