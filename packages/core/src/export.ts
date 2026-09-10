import { resolveRequest } from './samples.js';
import { deref } from './schema.js';
import type { OpenApiDoc } from './spec.js';

/**
 * Export to the tools people already use (spec §3.13, v0.6): a Postman v2.1
 * collection and a TypeScript declaration file. Both are generated in the
 * core from the role-filtered document. The type file additionally restricts
 * itself to schemas reachable from visible operations — the visibility filter
 * removes operations but leaves `components` alone, and a schema name is
 * enough to give a hidden operation away.
 */

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

// ----------------------------------------------------------------- Postman

export interface PostmanCollection {
  info: { name: string; description?: string; schema: string };
  variable: Array<{ key: string; value: string; type?: string }>;
  auth?: PostmanAuth;
  item: PostmanItem[];
}

type PostmanAuth =
  | { type: 'noauth' }
  | { type: 'bearer'; bearer: PostmanKv[] }
  | { type: 'basic'; basic: PostmanKv[] }
  | { type: 'apikey'; apikey: PostmanKv[] };

interface PostmanKv { key: string; value: string; type: 'string' }

interface PostmanItem {
  name: string;
  description?: string;
  item?: PostmanItem[];
  request?: {
    method: string;
    description?: string;
    header: Array<{ key: string; value: string }>;
    url: {
      raw: string;
      host: string[];
      path: string[];
      query?: Array<{ key: string; value: string }>;
      variable?: Array<{ key: string; value: string }>;
    };
    body?: { mode: 'raw'; raw: string; options: { raw: { language: 'json' } } };
    auth?: PostmanAuth;
  };
}

/**
 * A Postman v2.1 collection: one folder per tag (in the sidebar's order), one
 * request per operation. The server URL and every credential are collection
 * variables, so no secret lands in the file. Webhooks are calls the API makes
 * to you, so they are not requests and are left out.
 *
 * `origin` resolves a relative server URL ('/api' — what most in-process
 * documents declare) into something a client can actually send to. The server
 * route passes the request's own origin; the CLI has none, so there the value
 * stays relative for the user to fill in.
 */
export function buildPostmanCollection(doc: OpenApiDoc, origin?: string): PostmanCollection {
  const folders = new Map<string, PostmanItem>();
  const folderFor = (tag: string): PostmanItem => {
    let f = folders.get(tag);
    if (!f) {
      const meta = (doc.tags ?? []).find((t: any) => t?.name === tag);
      f = { name: tag, ...(meta?.description ? { description: String(meta.description) } : {}), item: [] };
      folders.set(tag, f);
    }
    return f;
  };
  for (const t of doc.tags ?? []) if (typeof t?.name === 'string') folderFor(t.name);

  const used = new Set<string>();     // credential variables referenced by any request
  const collectionAuth = authFor(doc, (doc.security ?? [])[0], used);

  for (const [path, item] of Object.entries<any>(doc.paths ?? {})) {
    if (!item || typeof item !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      const r = resolveRequest(doc, method, path);
      if (!r) continue;

      const segments = path.replace(/^\/+/, '').split('/').filter(Boolean)
        .map((s) => s.replace(/\{([^}]+)\}/g, (_, n) => `:${n}`));
      const query = r.query.map(([key, value]) => ({ key, value }));
      const raw = `{{baseUrl}}/${segments.join('/')}` + (query.length ? '?' + query.map((q) => `${q.key}=${q.value}`).join('&') : '');

      const request: NonNullable<PostmanItem['request']> = {
        method: method.toUpperCase(),
        ...(op.description || op.summary ? { description: String(op.description ?? op.summary) } : {}),
        header: r.headers.map(([key, value]) => ({ key, value })),
        url: {
          raw,
          host: ['{{baseUrl}}'],
          path: segments,
          ...(query.length ? { query } : {}),
          ...(r.pathParams.length ? { variable: r.pathParams.map(([key, value]) => ({ key, value })) } : {}),
        },
      };
      if (r.body != null) {
        request.header.push({ key: 'Content-Type', value: r.contentType ?? 'application/json' });
        request.body = { mode: 'raw', raw: r.body, options: { raw: { language: 'json' } } };
      }
      // Operation-level security overrides the document's, and `security: []`
      // means this operation needs none – it has to say so explicitly, or
      // Postman falls back to the collection's auth and sends a token to an
      // endpoint documented as public.
      if (Array.isArray(op.security)) {
        request.auth = op.security.length ? authFor(doc, op.security[0], used) : { type: 'noauth' };
      }

      const name = typeof op.summary === 'string' && op.summary.trim()
        ? op.summary.trim()
        : `${method.toUpperCase()} ${path}`;
      const tag = Array.isArray(op.tags) && typeof op.tags[0] === 'string' ? op.tags[0] : 'default';
      folderFor(tag).item!.push({ name, request });
    }
  }

  let baseUrl = String(doc.servers?.[0]?.url ?? origin ?? 'http://localhost')
    .replace(/\/+$/, '')
    .replace(/\{([^}]+)\}/g, (_, n) => String(doc.servers?.[0]?.variables?.[n]?.default ?? 'x'));
  if (origin && !/^https?:\/\//i.test(baseUrl)) baseUrl = origin.replace(/\/+$/, '') + (baseUrl.startsWith('/') ? baseUrl : `/${baseUrl}`);
  const variable: PostmanCollection['variable'] = [{ key: 'baseUrl', value: baseUrl, type: 'string' }];
  for (const key of ['token', 'username', 'password', 'apiKey']) {
    if (used.has(key)) variable.push({ key, value: '', type: 'string' });
  }

  return {
    info: {
      name: String(doc.info?.title ?? 'API'),
      ...(doc.info?.description ? { description: String(doc.info.description) } : {}),
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    variable,
    ...(collectionAuth ? { auth: collectionAuth } : {}),
    item: [...folders.values()].filter((f) => f.item!.length > 0),
  };
}

/** Postman auth for one security requirement; credentials are always variables. */
function authFor(doc: OpenApiDoc, requirement: any, used: Set<string>): PostmanAuth | undefined {
  if (!requirement || typeof requirement !== 'object') return undefined;
  const name = Object.keys(requirement)[0];
  if (!name) return { type: 'noauth' };
  const scheme = deref(doc, doc.components?.securitySchemes?.[name]);
  const kv = (key: string, value: string): PostmanKv => ({ key, value, type: 'string' });
  if (scheme?.type === 'http' && scheme.scheme === 'basic') {
    used.add('username'); used.add('password');
    return { type: 'basic', basic: [kv('username', '{{username}}'), kv('password', '{{password}}')] };
  }
  if (scheme?.type === 'apiKey' && (scheme.in === 'header' || scheme.in === 'query')) {
    used.add('apiKey');
    return { type: 'apikey', apikey: [kv('key', String(scheme.name)), kv('value', '{{apiKey}}'), kv('in', scheme.in)] };
  }
  if (scheme?.type === 'http' || scheme?.type === 'oauth2' || scheme?.type === 'openIdConnect') {
    used.add('token');
    return { type: 'bearer', bearer: [kv('token', '{{token}}')] };
  }
  return undefined;
}

// -------------------------------------------------------------- TypeScript

const TS_MAX_DEPTH = 12;
const SCHEMA_REF = '#/components/schemas/';

/**
 * A `.d.ts` with one named type per reachable component schema and an
 * `operations` interface keyed by operationId. Whatever the generator cannot
 * express stays `unknown`; it never narrows on a guess.
 */
export function generateTypes(doc: OpenApiDoc): string {
  const schemas: Record<string, any> = doc.components?.schemas ?? {};
  const reachable = reachableSchemas(doc);

  // Stable, collision-free identifiers for the schemas we will emit.
  const names = new Map<string, string>();
  const taken = new Set<string>(['operations']);
  for (const key of Object.keys(schemas)) {
    if (!reachable.has(key)) continue;
    let id = key.replace(/[^A-Za-z0-9_$]/g, '_');
    if (/^[0-9]/.test(id)) id = `_${id}`;
    let candidate = id;
    for (let n = 2; taken.has(candidate); n++) candidate = `${id}_${n}`;
    taken.add(candidate);
    names.set(key, candidate);
  }

  const ctx: TsCtx = { doc, names };
  const out: string[] = [];
  const title = [doc.info?.title, doc.info?.version].filter(Boolean).join(' ');
  out.push(`// Generated by ludin${title ? ` from ${title}` : ''}. Do not edit.`, '');

  for (const [key, id] of names) {
    const schema = schemas[key];
    const jsdoc = docComment(schema, '');
    const body = tsType(ctx, schema, 0, '');
    if (jsdoc) out.push(jsdoc);
    // Plain objects read better as interfaces; anything else is a type alias.
    if (body.startsWith('{') && body.endsWith('}') && isPlainObject(ctx, schema)) out.push(`export interface ${id} ${body}`);
    else out.push(`export type ${id} = ${body};`);
    out.push('');
  }

  out.push('export interface operations {');
  const opKeys = new Set<string>();
  const containers: Array<[Record<string, any>, boolean]> = [[doc.paths ?? {}, false], [doc.webhooks ?? {}, true]];
  for (const [container, webhook] of containers)
  for (const [path, item] of Object.entries<any>(container)) {
    if (!item || typeof item !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      let key = typeof op.operationId === 'string' && op.operationId.trim()
        ? op.operationId.trim()
        : `${method}_${path.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
      let candidate = key;
      for (let n = 2; opKeys.has(candidate); n++) candidate = `${key}_${n}`;
      opKeys.add(candidate);
      key = candidate;

      const lines: string[] = [];
      const summary = [webhook ? 'Webhook: the payload you will receive.' : '', op.summary].filter(Boolean).join(' ');
      if (summary || op.deprecated) lines.push(docLines(summary, !!op.deprecated, '  '));
      lines.push(`  ${propKey(key)}: {`);
      lines.push(...operationMembers(ctx, doc, item, op, '    '));
      lines.push('  };');
      out.push(lines.join('\n'));
    }
  }
  out.push('}', '');
  return out.join('\n');
}

interface TsCtx { doc: OpenApiDoc; names: Map<string, string> }

function operationMembers(ctx: TsCtx, doc: OpenApiDoc, item: any, op: any, indent: string): string[] {
  const lines: string[] = [];
  const params = [...(item.parameters ?? []), ...(op.parameters ?? [])]
    .map((p: any) => deref(doc, p))
    .filter((p: any) => p && typeof p === 'object' && typeof p.name === 'string');
  const groups: Record<string, any[]> = {};
  for (const p of params) (groups[p.in] ??= []).push(p);

  const inner = indent + '  ';
  const groupLines: string[] = [];
  for (const where of ['path', 'query', 'header', 'cookie']) {
    const ps = groups[where];
    if (!ps?.length) continue;
    const members = ps.map((p) => {
      const required = where === 'path' || !!p.required;
      const jsdoc = docComment(p, inner + '  ');
      return `${jsdoc ? jsdoc + '\n' : ''}${inner}  ${propKey(p.name)}${required ? '' : '?'}: ${tsType(ctx, p.schema ?? {}, 1, inner + '  ')};`;
    });
    const allOptional = ps.every((p) => where !== 'path' && !p.required);
    groupLines.push(`${inner}${where}${allOptional ? '?' : ''}: {\n${members.join('\n')}\n${inner}};`);
  }
  if (groupLines.length) lines.push(`${indent}parameters: {`, ...groupLines, `${indent}};`);

  const body = deref(doc, op.requestBody);
  const bodySchema = jsonSchemaOf(body?.content);
  if (body?.content) {
    lines.push(`${indent}requestBody${body.required ? '' : '?'}: ${bodySchema ? tsType(ctx, bodySchema, 1, indent) : 'unknown'};`);
  }

  const responses = Object.entries<any>(op.responses ?? {});
  if (responses.length) {
    lines.push(`${indent}responses: {`);
    for (const [code, raw] of responses) {
      const res = deref(doc, raw);
      const schema = jsonSchemaOf(res?.content);
      const type = schema ? tsType(ctx, schema, 1, inner) : res?.content ? 'unknown' : 'undefined';
      const jsdoc = docComment(res, inner);
      if (jsdoc) lines.push(jsdoc);
      lines.push(`${inner}${propKey(code)}: ${type};`);
    }
    lines.push(`${indent}};`);
  }
  return lines;
}

function jsonSchemaOf(content: any): any | undefined {
  if (!content || typeof content !== 'object') return undefined;
  const type = Object.keys(content).find((t) => /json/i.test(t)) ?? Object.keys(content)[0];
  return type ? content[type]?.schema : undefined;
}

/** Render one schema as a TypeScript type expression. */
function tsType(ctx: TsCtx, schema: any, depth: number, indent: string): string {
  if (!schema || typeof schema !== 'object') return 'unknown';
  if (depth > TS_MAX_DEPTH) return 'unknown';
  if (typeof schema.$ref === 'string') {
    if (schema.$ref.startsWith(SCHEMA_REF)) {
      const id = ctx.names.get(decodePointer(schema.$ref.slice(SCHEMA_REF.length)));
      return id ?? 'unknown';
    }
    const target = deref(ctx.doc, schema);
    return target === schema ? 'unknown' : tsType(ctx, target, depth + 1, indent);
  }

  const parts: string[] = [];
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    parts.push(schema.allOf.map((s: any) => paren(tsType(ctx, s, depth + 1, indent))).join(' & '));
  }
  const variants = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(variants) && variants.length) {
    parts.push(variants.map((s: any) => paren(tsType(ctx, s, depth + 1, indent))).join(' | '));
  }

  let own: string | undefined;
  if (schema.const !== undefined) own = literal(schema.const);
  else if (Array.isArray(schema.enum) && schema.enum.length) own = schema.enum.map(literal).join(' | ');
  else {
    const types: string[] = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
    const inferred = types.length ? types : schema.properties || schema.additionalProperties ? ['object'] : schema.items ? ['array'] : [];
    const rendered = inferred.map((t: string) => {
      switch (t) {
        case 'object': return objectType(ctx, schema, depth, indent);
        case 'array': return `Array<${tsType(ctx, schema.items ?? {}, depth + 1, indent)}>`;
        case 'integer':
        case 'number': return 'number';
        case 'string': return 'string';
        case 'boolean': return 'boolean';
        case 'null': return 'null';
        default: return 'unknown';
      }
    });
    if (rendered.length) own = rendered.join(' | ');
  }
  if (own) parts.push(parts.length && own.includes('|') ? `(${own})` : own);

  let result = parts.length ? parts.join(' & ') : 'unknown';
  if (schema.nullable === true && !/\bnull\b/.test(result)) result = `${paren(result)} | null`;
  return result;
}

function objectType(ctx: TsCtx, schema: any, depth: number, indent: string): string {
  const props = Object.entries<any>(schema.properties ?? {});
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
  const inner = indent + '  ';
  const members = props.map(([name, prop]) => {
    const jsdoc = docComment(prop, inner);
    return `${jsdoc ? jsdoc + '\n' : ''}${inner}${propKey(name)}${required.has(name) ? '' : '?'}: ${tsType(ctx, prop, depth + 1, inner)};`;
  });
  const extra = schema.additionalProperties;
  if (extra === true || (extra && typeof extra === 'object')) {
    members.push(`${inner}[key: string]: ${extra === true ? 'unknown' : tsType(ctx, extra, depth + 1, inner)};`);
  }
  if (!members.length) return 'Record<string, unknown>';
  return `{\n${members.join('\n')}\n${indent}}`;
}

/** A schema that renders as a single object literal – the interface candidates. */
function isPlainObject(ctx: TsCtx, schema: any): boolean {
  return !!schema && typeof schema === 'object' && !schema.$ref && !schema.allOf && !schema.oneOf && !schema.anyOf
    && schema.enum === undefined && schema.const === undefined && schema.nullable !== true
    && (schema.type === 'object' || (!schema.type && !!schema.properties));
}

function literal(v: unknown): string {
  return v === null ? 'null' : typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? JSON.stringify(v) : 'unknown';
}

function paren(t: string): string {
  return /[|&]/.test(t) && !t.startsWith('{') ? `(${t})` : t;
}

function propKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function decodePointer(seg: string): string {
  return seg.replace(/~1/g, '/').replace(/~0/g, '~');
}

function docComment(node: any, indent: string): string {
  if (!node || typeof node !== 'object') return '';
  const text = typeof node.description === 'string' ? node.description.trim() : '';
  if (!text && !node.deprecated) return '';
  return docLines(text, node.deprecated === true, indent);
}

function docLines(text: string, deprecated: boolean, indent: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\*\//g, '* /').trimEnd()).filter((l, i, a) => l || (i > 0 && i < a.length - 1));
  if (deprecated) lines.push('@deprecated');
  if (lines.length === 1) return `${indent}/** ${lines[0]} */`;
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l}`.trimEnd()).join('\n')}\n${indent} */`;
}

/**
 * Component schemas reachable through `$ref` from any operation in the
 * document — the only ones the type file may name. Walks parameters, request
 * bodies and responses (including component-hosted ones), then closes over
 * schema-to-schema references.
 */
export function reachableSchemas(doc: OpenApiDoc): Set<string> {
  const found = new Set<string>();
  const queue: string[] = [];
  const visited = new Set<any>();

  const walk = (node: any, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 40 || visited.has(node)) return;
    visited.add(node);
    if (typeof node.$ref === 'string') {
      if (node.$ref.startsWith(SCHEMA_REF)) {
        const key = decodePointer(node.$ref.slice(SCHEMA_REF.length));
        if (!found.has(key) && doc.components?.schemas?.[key]) { found.add(key); queue.push(key); }
        return;
      }
      if (node.$ref.startsWith('#/')) walk(deref(doc, node), depth + 1);
      return;
    }
    for (const value of Array.isArray(node) ? node : Object.values(node)) walk(value, depth + 1);
  };

  for (const container of [doc.paths, doc.webhooks]) {
    for (const item of Object.values<any>(container ?? {})) {
      if (!item || typeof item !== 'object') continue;
      walk(item.parameters, 0);
      for (const method of HTTP_METHODS) {
        const op = item[method];
        if (!op) continue;
        walk(op.parameters, 0);
        walk(op.requestBody, 0);
        walk(op.responses, 0);
        walk(op.callbacks, 0);
      }
    }
  }
  while (queue.length) walk(doc.components?.schemas?.[queue.shift()!], 0);
  return found;
}
