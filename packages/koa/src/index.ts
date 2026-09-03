import type { IncomingMessage } from 'node:http';
import { createLudin } from 'ludin';
import type { LudinHandler, LudinOptions, LudinRequest } from 'ludin';

export type { LudinOptions, LudinHandler } from 'ludin';
export { hashPassword } from 'ludin';

/** Structural subset of Koa's context – keeps this package dependency-free. */
export interface KoaContextLike {
  method: string;
  path: string;
  originalUrl: string;
  querystring: string;
  headers: Record<string, string | string[] | undefined>;
  req: IncomingMessage;
  request: { body?: unknown; rawBody?: string };
  status: number;
  body: unknown;
  set(field: string, value: string | string[]): void;
}

export interface LudinKoaMiddleware {
  (ctx: KoaContextLike, next: () => Promise<void>): Promise<void>;
  ludin: LudinHandler;
}

/**
 * Create a Koa middleware. Mount it on the app – it matches `basePath` itself:
 *
 * ```ts
 * app.use(ludin({ spec: './openapi.json', basePath: '/docs', auth: { users: [...] } }));
 * ```
 *
 * It also works under `koa-mount('/docs', ludin({ ..., basePath: '/docs' }))`;
 * requests that do not target `basePath` are passed straight to `next()`.
 */
export function ludin(options: LudinOptions): LudinKoaMiddleware {
  const basePath = normalize(options.basePath ?? '/docs');
  const handler = createLudin({ ...options, basePath });

  const middleware = (async (ctx, next) => {
    const path = relativePath(ctx, basePath);
    if (path == null) return next();

    const out = await handler.handle(await toRequest(ctx, path));
    ctx.status = out.status;
    for (const [k, v] of Object.entries(out.headers)) ctx.set(k, v);
    ctx.body = out.body ?? null;
  }) as LudinKoaMiddleware;

  middleware.ludin = handler;
  return middleware;
}

export default ludin;

/** Path relative to the mount point, or `null` when the request is not ours. */
function relativePath(ctx: KoaContextLike, basePath: string): string | null {
  const base = basePath === '/' ? '' : basePath;
  if (!base) return ctx.path || '/';
  if (ctx.path === base || ctx.path.startsWith(base + '/')) return ctx.path.slice(base.length) || '/';
  // Mounted (koa-mount rewrote ctx.path): fall back to the original URL.
  const original = (ctx.originalUrl ?? '').split('?', 1)[0];
  if (original === base || original.startsWith(base + '/')) return ctx.path || '/';
  return null;
}

export async function toRequest(ctx: KoaContextLike, path: string): Promise<LudinRequest> {
  const query: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(ctx.querystring ?? '')) query[k] = v;

  const socket = ctx.req.socket as { remoteAddress?: string; encrypted?: boolean } | undefined;
  return {
    method: ctx.method,
    path,
    query,
    headers: ctx.headers,
    body: await readBody(ctx),
    remoteAddress: socket?.remoteAddress ?? '',
    protocol: socket?.encrypted ? 'https' : 'http',
  };
}

/** Raw body, reusing whatever a body parser already consumed. */
function readBody(ctx: KoaContextLike): Promise<string | null> {
  if (ctx.method === 'GET' || ctx.method === 'HEAD') return Promise.resolve(null);
  if (typeof ctx.request.rawBody === 'string') return Promise.resolve(ctx.request.rawBody);
  const parsed = ctx.request.body;
  if (typeof parsed === 'string') return Promise.resolve(parsed);
  if (Buffer.isBuffer(parsed)) return Promise.resolve(parsed.toString('utf8'));
  if (parsed && typeof parsed === 'object' && Object.keys(parsed as object).length > 0) {
    return Promise.resolve(JSON.stringify(parsed));
  }
  const req = ctx.req;
  if (req.readableEnded || req.complete) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function normalize(p: string): string {
  if (!p.startsWith('/')) p = '/' + p;
  return p.replace(/\/+$/, '') || '/';
}
