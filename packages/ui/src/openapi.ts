export type Doc = any;

export const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'] as const;
export type Method = (typeof METHODS)[number];

export interface Operation {
  id: string;
  method: Method;
  path: string;
  /** OpenAPI 3.1 webhook: the API calls you, so there is nothing to send. */
  webhook?: boolean;
  op: any;
  tags: string[];
  summary: string;
  deprecated: boolean;
  parameters: any[];
}

export interface TagGroup {
  name: string;
  description?: string;
  operations: Operation[];
}

/** Resolve a local `$ref` (`#/components/schemas/Pet`). */
export function deref(doc: Doc, node: any, depth = 0): any {
  let cur = node;
  let guard = 0;
  while (cur && typeof cur === 'object' && typeof cur.$ref === 'string' && guard++ < 20) {
    const target = resolveRef(doc, cur.$ref);
    if (!target) return { description: `Unresolved $ref ${cur.$ref}` };
    const { $ref, ...rest } = cur;
    cur = { ...target, ...rest, __refName: refName($ref) };
  }
  return cur;
}

export function resolveRef(doc: Doc, ref: string): any {
  if (!ref.startsWith('#/')) return null;
  return ref
    .slice(2)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((acc, key) => (acc == null ? null : acc[key]), doc);
}

export function refName(ref: string): string {
  return ref.split('/').pop() ?? ref;
}

export function groupOperations(doc: Doc): TagGroup[] {
  const groups = new Map<string, TagGroup>();
  const tagMeta = new Map<string, any>((doc.tags ?? []).map((t: any) => [t.name, t]));
  for (const t of doc.tags ?? []) groups.set(t.name, { name: t.name, description: t.description, operations: [] });

  const containers: Array<[Record<string, any>, boolean]> = [
    [doc.paths ?? {}, false],
    [doc.webhooks ?? {}, true],
  ];
  for (const [container, webhook] of containers)
  for (const [path, item] of Object.entries<any>(container)) {
    if (!item) continue;
    const pathParams = item.parameters ?? [];
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const tags: string[] = op.tags?.length ? op.tags : webhook ? ['webhooks'] : ['default'];
      const params = mergeParams(doc, pathParams, op.parameters ?? []);
      const operation: Operation = {
        // Webhook ids are namespaced: a webhook and a path may share a name.
        id: (webhook ? 'wh-' : '') + (op.operationId || `${method}-${path}`.replace(/[^a-zA-Z0-9]+/g, '-')),
        method,
        path,
        ...(webhook ? { webhook: true } : {}),
        op,
        tags,
        summary: op.summary || op.description?.split('\n')[0] || `${method.toUpperCase()} ${path}`,
        deprecated: !!op.deprecated,
        parameters: params,
      };
      for (const tag of tags) {
        if (!groups.has(tag)) groups.set(tag, { name: tag, description: tagMeta.get(tag)?.description, operations: [] });
        groups.get(tag)!.operations.push(operation);
      }
    }
  }
  return [...groups.values()].filter((g) => g.operations.length > 0);
}

function mergeParams(doc: Doc, base: any[], own: any[]): any[] {
  const out = new Map<string, any>();
  for (const p of [...base, ...own]) {
    const r = deref(doc, p);
    if (!r?.name) continue;
    out.set(`${r.in}:${r.name}`, r);
  }
  return [...out.values()];
}

/** Build an example value from a schema (best-effort). */
export function exampleFor(doc: Doc, schema: any, depth = 0, seen = new Set<string>()): any {
  if (!schema || depth > 8) return undefined;
  const s = deref(doc, schema);
  if (s.example !== undefined) return s.example;
  if (s.examples?.length) return s.examples[0];
  if (s.default !== undefined) return s.default;
  if (s.enum?.length) return s.enum[0];
  if (s.const !== undefined) return s.const;
  const name = s.__refName;
  if (name && seen.has(name)) return {};
  const next = name ? new Set([...seen, name]) : seen;

  const variants = s.oneOf ?? s.anyOf;
  if (variants?.length) return exampleFor(doc, variants[0], depth + 1, next);
  if (s.allOf?.length) {
    return Object.assign({}, ...s.allOf.map((v: any) => exampleFor(doc, v, depth + 1, next) ?? {}));
  }
  const type = Array.isArray(s.type) ? s.type[0] : s.type ?? (s.properties ? 'object' : s.items ? 'array' : undefined);
  switch (type) {
    case 'object': {
      const obj: Record<string, any> = {};
      for (const [k, v] of Object.entries<any>(s.properties ?? {})) {
        if (v?.readOnly) continue;
        obj[k] = exampleFor(doc, v, depth + 1, next);
      }
      if (!Object.keys(obj).length && s.additionalProperties && typeof s.additionalProperties === 'object') {
        obj.key = exampleFor(doc, s.additionalProperties, depth + 1, next);
      }
      return obj;
    }
    case 'array':
      return [exampleFor(doc, s.items, depth + 1, next)].filter((v) => v !== undefined);
    case 'string':
      if (s.format === 'date-time') return new Date().toISOString();
      if (s.format === 'date') return new Date().toISOString().slice(0, 10);
      if (s.format === 'email') return 'user@example.com';
      if (s.format === 'uuid') return '3fa85f64-5717-4562-b3fc-2c963f66afa6';
      if (s.format === 'uri' || s.format === 'url') return 'https://example.com';
      if (s.format === 'binary') return '<binary>';
      if (s.pattern) return 'string';
      return s.minLength ? 'x'.repeat(s.minLength) : 'string';
    case 'integer':
      return s.minimum ?? 0;
    case 'number':
      return s.minimum ?? 0;
    case 'boolean':
      return true;
    case 'null':
      return null;
    default:
      return undefined;
  }
}

export function schemaTypeLabel(doc: Doc, schema: any): string {
  if (!schema) return 'any';
  const s = deref(doc, schema);
  if (s.__refName && !s.properties && !s.items && !s.type) return s.__refName;
  if (s.oneOf) return 'oneOf';
  if (s.anyOf) return 'anyOf';
  if (s.allOf) return 'allOf';
  let type = Array.isArray(s.type) ? s.type.join(' | ') : s.type;
  if (!type) type = s.properties ? 'object' : s.items ? 'array' : 'any';
  if (type === 'array') return `${schemaTypeLabel(doc, s.items)}[]`;
  if (type === 'object' && s.__refName) return s.__refName;
  if (s.format) return `${type}<${s.format}>`;
  return type;
}

export function securityRequirements(doc: Doc, op: any): Array<{ name: string; scheme: any }> {
  const reqs: any[] = op.security ?? doc.security ?? [];
  const schemes = doc.components?.securitySchemes ?? {};
  const out: Array<{ name: string; scheme: any }> = [];
  for (const r of reqs) {
    for (const name of Object.keys(r ?? {})) {
      if (schemes[name] && !out.some((o) => o.name === name)) out.push({ name, scheme: deref(doc, schemes[name]) });
    }
  }
  return out;
}

export function serverUrls(doc: Doc): string[] {
  const urls = (doc.servers ?? []).map((s: any) => expandServer(s)).filter(Boolean);
  return urls.length ? urls : [''];
}

function expandServer(s: any): string {
  if (typeof s?.url !== 'string') return '';
  return s.url.replace(/\{([^}]+)\}/g, (_: string, k: string) => s.variables?.[k]?.default ?? k);
}

/** Substitute path params and build a query string. */
export function buildUrl(server: string, path: string, params: any[], values: Record<string, string>): string {
  let p = path;
  const query: string[] = [];
  for (const param of params) {
    const v = values[`${param.in}:${param.name}`];
    if (param.in === 'path') {
      p = p.replace(`{${param.name}}`, encodeURIComponent(v ?? ''));
    } else if (param.in === 'query' && v != null && v !== '') {
      query.push(`${encodeURIComponent(param.name)}=${encodeURIComponent(v)}`);
    }
  }
  const base = server.replace(/\/+$/, '');
  return `${base}${p}${query.length ? `?${query.join('&')}` : ''}`;
}

export function toCurl(method: string, url: string, headers: Record<string, string>, body: string | null): string {
  const parts = [`curl -X ${method.toUpperCase()} '${url}'`];
  for (const [k, v] of Object.entries(headers)) parts.push(`  -H '${k}: ${v.replace(/'/g, "'\\''")}'`);
  if (body) parts.push(`  -d '${body.replace(/'/g, "'\\''")}'`);
  return parts.join(' \\\n');
}
