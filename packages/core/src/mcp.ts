import { buildSampleInput, generateSamples } from './samples.js';
import { buildSearchIndex } from './search.js';
import type { OpenApiDoc } from './spec.js';

/**
 * MCP (Model Context Protocol) endpoint — JSON-RPC 2.0 over HTTP POST.
 *
 * The point is to hand an agent the *same* documentation a person gets, under
 * the *same* rules: the caller is an identity in the request pipeline (§4.4),
 * every document it reads is role-filtered, and executing a request needs
 * `docs:try` just as the browser does. An agent with a read-only share link
 * can read the reference and nothing else.
 *
 * This module is deliberately transport-only: it decides nothing about who the
 * caller is. The handler resolves identity first and passes the capabilities
 * this caller actually has.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface McpRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, any>;
}

/** What the handler lets this caller do. Every function is already role-scoped. */
export interface McpCapabilities {
  serverName: string;
  serverVersion: string;
  canTry: boolean;
  /** Specs this caller may see. */
  listSpecs(): Array<{ name: string }>;
  /** The role-filtered document for a spec, or null when it is not visible. */
  loadSpec(name?: string): Promise<OpenApiDoc | null>;
  /** Execute one documented operation. Only called when `canTry`. */
  execute(input: {
    spec?: string;
    method: string;
    path: string;
    pathParams?: Record<string, string>;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: unknown;
    server?: string;
  }): Promise<unknown>;
  /** Record that a tool ran, for the audit log. */
  audit(tool: string, detail: Record<string, unknown>): Promise<void>;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

function tools(canTry: boolean) {
  const list = [
    {
      name: 'list_operations',
      description:
        'List the API operations this caller is allowed to see, with method, path, summary and tags. ' +
        'The document is filtered by role, so the result is exactly what this caller may know about.',
      inputSchema: {
        type: 'object',
        properties: {
          spec: { type: 'string', description: 'Spec name, when the deployment serves several.' },
          tag: { type: 'string', description: 'Only operations carrying this tag.' },
        },
      },
    },
    {
      name: 'search_operations',
      description:
        'Search operations by path, summary, operationId, tag — and by schema field name, ' +
        'which is how to find "which endpoint returns createdAt".',
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string' },
          spec: { type: 'string' },
        },
      },
    },
    {
      name: 'get_operation',
      description:
        'Full detail for one operation: parameters, request body schema, responses, security, ' +
        'and ready-to-paste code samples.',
      inputSchema: {
        type: 'object',
        required: ['method', 'path'],
        properties: {
          method: { type: 'string', description: 'GET, POST, …' },
          path: { type: 'string', description: 'The templated path, e.g. /pets/{petId}' },
          spec: { type: 'string' },
        },
      },
    },
  ];

  if (canTry) {
    list.push({
      name: 'call_operation',
      description:
        'Execute a documented operation against the API and return the response. ' +
        'Only operations in the filtered document can be called, and the call is audited and ' +
        'attributed to this caller. Path parameters are substituted for you.',
      inputSchema: {
        type: 'object',
        required: ['method', 'path'],
        properties: {
          method: { type: 'string' },
          path: { type: 'string', description: 'The templated path, exactly as documented.' },
          pathParams: { type: 'object', description: 'Values for {placeholders} in the path.' },
          query: { type: 'object', description: 'Query string parameters.' },
          headers: { type: 'object', description: 'Extra request headers.' },
          body: { description: 'Request body, as a JSON value.' },
          server: { type: 'string', description: 'Which declared server to call.' },
          spec: { type: 'string' },
        },
      } as any,
    });
  }
  return list;
}

const ok = (id: McpRequest['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
const fail = (id: McpRequest['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const text = (value: unknown) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

/**
 * Handle one JSON-RPC message. Returns null for notifications, which by the
 * JSON-RPC contract get no response at all.
 */
export async function handleMcp(req: McpRequest, caps: McpCapabilities): Promise<object | null> {
  const { id, method, params = {} } = req;
  if (!method) return fail(id, -32600, 'Invalid request: method is required');
  if (method.startsWith('notifications/')) return null;

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: caps.serverName, version: caps.serverVersion },
        instructions:
          'This server exposes an OpenAPI document filtered for your identity. ' +
          'Start with list_operations or search_operations, then get_operation for detail.' +
          (caps.canTry ? ' call_operation executes a request against the API.' : ' Execution is not permitted for this caller.'),
      });

    case 'ping':
      return ok(id, {});

    case 'tools/list':
      return ok(id, { tools: tools(caps.canTry) });

    case 'tools/call': {
      const name = params.name as string;
      const args = (params.arguments ?? {}) as Record<string, any>;
      try {
        const result = await runTool(name, args, caps);
        await caps.audit(name, { spec: args.spec, path: args.path, method: args.method });
        return ok(id, result);
      } catch (err) {
        // Tool failures are results, not protocol errors: the agent should see
        // the reason and correct itself rather than lose the connection.
        return ok(id, { ...text(`Error: ${(err as Error).message}`), isError: true });
      }
    }

    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

async function runTool(name: string, args: Record<string, any>, caps: McpCapabilities) {
  switch (name) {
    case 'list_operations': {
      const doc = await requireSpec(caps, args.spec);
      const out: any[] = [];
      for (const [container, webhook] of [[doc.paths ?? {}, false], [doc.webhooks ?? {}, true]] as const) {
        for (const [path, item] of Object.entries<any>(container)) {
          for (const m of HTTP_METHODS) {
            const op = item?.[m];
            if (!op) continue;
            if (args.tag && !(op.tags ?? []).includes(args.tag)) continue;
            out.push({
              method: m.toUpperCase(),
              path,
              operationId: op.operationId,
              summary: op.summary,
              tags: op.tags ?? [],
              ...(webhook ? { webhook: true } : {}),
            });
          }
        }
      }
      return text({ specs: caps.listSpecs().map((s) => s.name), operations: out });
    }

    case 'search_operations': {
      const doc = await requireSpec(caps, args.spec);
      const needle = String(args.query ?? '').toLowerCase();
      if (!needle) throw new Error('query is required');
      const hits = buildSearchIndex(doc)
        .map((e) => {
          const hay = `${e.method} ${e.path} ${e.operationId ?? ''} ${e.summary ?? ''} ${e.tags.join(' ')}`.toLowerCase();
          const field = e.fields.find((f) => f.toLowerCase().includes(needle));
          if (hay.includes(needle)) return { ...e, matchedOn: 'operation' };
          if (field) return { ...e, matchedOn: `field:${field}` };
          return null;
        })
        .filter(Boolean)
        .slice(0, 50);
      return text({ query: args.query, results: hits });
    }

    case 'get_operation': {
      const doc = await requireSpec(caps, args.spec);
      const method = String(args.method ?? '').toLowerCase();
      const path = String(args.path ?? '');
      const op = doc.paths?.[path]?.[method] ?? doc.webhooks?.[path]?.[method];
      if (!op) throw new Error(`Operation ${args.method} ${path} is not in the document you can see.`);
      const input = buildSampleInput(doc, method, path);
      return text({
        method: method.toUpperCase(),
        path,
        operationId: op.operationId,
        summary: op.summary,
        description: op.description,
        tags: op.tags ?? [],
        deprecated: !!op.deprecated,
        parameters: [...(doc.paths?.[path]?.parameters ?? []), ...(op.parameters ?? [])],
        requestBody: op.requestBody,
        responses: op.responses,
        security: op.security ?? doc.security,
        samples: input ? generateSamples(input) : undefined,
      });
    }

    case 'call_operation': {
      if (!caps.canTry) throw new Error('This caller may read the documentation but not execute requests.');
      const doc = await requireSpec(caps, args.spec);
      const method = String(args.method ?? '').toLowerCase();
      const path = String(args.path ?? '');
      if (!doc.paths?.[path]?.[method]) {
        throw new Error(`Operation ${args.method} ${path} is not in the document you can see.`);
      }
      const result = await caps.execute({
        spec: args.spec,
        method,
        path,
        pathParams: args.pathParams,
        query: args.query,
        headers: args.headers,
        body: args.body,
        server: args.server,
      });
      return text(result);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function requireSpec(caps: McpCapabilities, name?: string): Promise<OpenApiDoc> {
  const doc = await caps.loadSpec(name);
  if (!doc) throw new Error(name ? `Spec "${name}" is not available to you.` : 'No spec is available to you.');
  return doc;
}
