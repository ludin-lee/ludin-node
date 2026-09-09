import { createLudin } from 'ludin';
import type { LudinHandler, LudinOptions, LudinRequest, LudinResponse } from 'ludin';

export type { LudinOptions, LudinHandler } from 'ludin';
export { hashPassword } from 'ludin';

/** Structural subset of Hono's context – keeps this package dependency-free. */
export interface HonoContextLike {
  req: { raw: Request };
  env?: unknown;
}

export interface LudinHonoHandler {
  (c: HonoContextLike): Promise<Response>;
  ludin: LudinHandler;
}

/** Structural subset of a Hono app. */
export interface HonoAppLike {
  all(path: string, handler: (c: any) => Response | Promise<Response>): unknown;
}

/**
 * Create a Hono handler:
 *
 * ```ts
 * const docs = ludin({ spec: './openapi.json', basePath: '/docs', auth: { users: [...] } });
 * app.all('/docs', docs);
 * app.all('/docs/*', docs);
 * // or simply: mountLudin(app, { spec, basePath: '/docs' })
 * ```
 *
 * On runtimes where the client address is not exposed (Cloudflare Workers,
 * Vercel Edge …) `remoteAddress` is empty, so IP rules need `trustProxy` plus a
 * proxy header such as `X-Forwarded-For`.
 */
export function ludin(options: LudinOptions): LudinHonoHandler {
  const basePath = normalize(options.basePath ?? '/docs');
  const handler = createLudin({ ...options, basePath });

  const honoHandler = (async (c: HonoContextLike) => {
    const out = await handler.handle(await toRequest(c, basePath));
    return toResponse(out);
  }) as LudinHonoHandler;

  honoHandler.ludin = handler;
  return honoHandler;
}

export default ludin;

/** Register the docs routes (`/docs` and `/docs/*`) on a Hono app. */
export function mountLudin(app: HonoAppLike, options: LudinOptions): LudinHonoHandler {
  const handler = ludin(options);
  const basePath = normalize(options.basePath ?? '/docs');
  app.all(basePath, handler as unknown as (c: any) => Promise<Response>);
  app.all(`${basePath === '/' ? '' : basePath}/*`, handler as unknown as (c: any) => Promise<Response>);
  return handler;
}

export async function toRequest(c: HonoContextLike, basePath: string): Promise<LudinRequest> {
  const req = c.req.raw;
  const url = new URL(req.url);
  const base = basePath === '/' ? '' : basePath;
  const path = base && url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;

  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => (query[k] = v));
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k] = v));

  return {
    method: req.method,
    path: path || '/',
    query,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? null : await req.text(),
    remoteAddress: remoteAddress(c),
    protocol: url.protocol === 'https:' ? 'https' : 'http',
  };
}

export function toResponse(out: LudinResponse): Response {
  const headers = new Headers();
  for (const [k, v] of Object.entries(out.headers)) {
    if (Array.isArray(v)) for (const one of v) headers.append(k, one);
    else headers.set(k, v);
  }
  const empty = out.status === 204 || out.status === 304;
  const body = empty || out.body == null ? null : typeof out.body === 'string' ? out.body : new Uint8Array(out.body);
  return new Response(body, { status: out.status, headers });
}

/** Best-effort client address across the runtimes Hono targets. */
function remoteAddress(c: HonoContextLike): string {
  const env = c.env as any;
  if (!env) return '';
  try {
    // @hono/node-server
    const node = env.incoming?.socket?.remoteAddress;
    if (typeof node === 'string') return node;
    // Deno.serve
    const deno = env.remoteAddr?.hostname;
    if (typeof deno === 'string') return deno;
    // Bun.serve – `env` is the server, or holds it under `server`
    const server = typeof env.requestIP === 'function' ? env : env.server;
    const bun = server?.requestIP?.(c.req.raw)?.address;
    if (typeof bun === 'string') return bun;
  } catch {
    /* runtime does not expose the peer address */
  }
  return '';
}

function normalize(p: string): string {
  if (!p.startsWith('/')) p = '/' + p;
  return p.replace(/\/+$/, '') || '/';
}
