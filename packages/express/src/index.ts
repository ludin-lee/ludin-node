import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLudin } from 'ludin';
import type { LudinHandler, LudinOptions, LudinRequest } from 'ludin';

export type { LudinOptions, LudinHandler } from 'ludin';
export { hashPassword } from 'ludin';

type Next = (err?: unknown) => void;
type ExpressLikeReq = IncomingMessage & {
  baseUrl?: string;
  originalUrl?: string;
  path?: string;
  query?: unknown;
  body?: unknown;
  ip?: string;
  protocol?: string;
};

export interface LudinMiddleware {
  (req: ExpressLikeReq, res: ServerResponse, next: Next): void;
  ludin: LudinHandler;
}

/**
 * Create an Express middleware. Mount it with `app.use('/docs', ludin({...}))`.
 * The mount path is detected from `req.baseUrl`, so `basePath` is optional.
 */
export function ludin(options: LudinOptions): LudinMiddleware {
  let handler: LudinHandler | null = null;
  let resolvedBase: string | undefined = options.basePath;

  const middleware = ((req, res, next) => {
    // Lazily create so the mount path (baseUrl) is known.
    if (!handler) {
      resolvedBase = resolvedBase ?? (req.baseUrl || '/');
      handler = createLudin({ ...options, basePath: resolvedBase });
      middleware.ludin = handler;
    }
    toRequest(req, resolvedBase!)
      .then((r) => handler!.handle(r))
      .then((out) => {
        res.statusCode = out.status;
        for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
        res.end(out.body);
      })
      .catch(next);
  }) as LudinMiddleware;

  // Eager handler for `.ludin` access before first request when basePath is given.
  if (options.basePath) {
    handler = createLudin(options);
    middleware.ludin = handler;
  } else {
    middleware.ludin = undefined as unknown as LudinHandler;
  }
  return middleware;
}

export async function toRequest(req: ExpressLikeReq, basePath: string): Promise<LudinRequest> {
  const original = req.originalUrl ?? req.url ?? '/';
  const base = (req.baseUrl || basePath || '').replace(/\/+$/, '');
  const full = base && original.startsWith(base) ? original.slice(base.length) : original;
  const [rawPath, rawQuery = ''] = full.split('?', 2);
  const query: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(rawQuery)) query[k] = v;

  return {
    method: req.method ?? 'GET',
    path: rawPath || '/',
    query,
    headers: req.headers as LudinRequest['headers'],
    body: await readBody(req),
    remoteAddress: req.socket?.remoteAddress ?? '',
    protocol: req.protocol ?? ((req.socket as { encrypted?: boolean } | undefined)?.encrypted ? 'https' : 'http'),
  };
}

/** Read the raw body unless a body-parser already consumed it. */
function readBody(req: ExpressLikeReq): Promise<string | null> {
  if (req.method === 'GET' || req.method === 'HEAD') return Promise.resolve(null);
  if (req.body !== undefined) {
    if (typeof req.body === 'string') return Promise.resolve(req.body);
    if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body.toString('utf8'));
    if (req.body && typeof req.body === 'object' && Object.keys(req.body as object).length > 0) {
      return Promise.resolve(JSON.stringify(req.body));
    }
  }
  if ((req as { readableEnded?: boolean }).readableEnded || (req as { complete?: boolean }).complete) {
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
