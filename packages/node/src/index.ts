import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createLudin } from 'ludin';
import type { LudinHandler, LudinOptions, LudinRequest } from 'ludin';

export type { LudinOptions, LudinHandler } from 'ludin';
export { hashPassword } from 'ludin';

export interface LudinNodeHandler {
  /** Connect-style: serves the docs, or calls `next()` / 404s for other URLs. */
  (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void): void;
  ludin: LudinHandler;
  /** Serve the request; resolves `false` when the URL is outside `basePath`. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

/**
 * Adapter for a plain `node:http` server (also works with connect/polka):
 *
 * ```ts
 * const docs = ludin({ spec: './openapi.json', basePath: '/docs', auth: { users: [...] } });
 * http.createServer((req, res) => docs(req, res, () => { res.statusCode = 404; res.end(); })).listen(3000);
 * ```
 */
export function ludin(options: LudinOptions): LudinNodeHandler {
  const basePath = normalize(options.basePath ?? '/docs');
  const handler = createLudin({ ...options, basePath });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = relativePath(req.url ?? '/', basePath);
    if (path == null) return false;
    const out = await handler.handle(await toRequest(req, path));
    res.statusCode = out.status;
    for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
    res.end(out.body);
    return true;
  }

  const middleware = ((req, res, next) => {
    handle(req, res)
      .then((handled) => {
        if (handled) return;
        if (next) return next();
        res.statusCode = 404;
        res.end('Not Found');
      })
      .catch((err) => {
        if (next) return next(err);
        console.error('[ludin] request failed', err);
        res.statusCode = 500;
        res.end('Internal error');
      });
  }) as LudinNodeHandler;

  middleware.ludin = handler;
  middleware.handle = handle;
  return middleware;
}

export default ludin;

/** A standalone docs server – handy for serving a spec without an app. */
export function createLudinServer(options: LudinOptions): Server & { ludin: LudinHandler } {
  const docs = ludin(options);
  const server = createServer(docs) as Server & { ludin: LudinHandler };
  server.ludin = docs.ludin;
  return server;
}

/** Path relative to the mount point, or `null` when the request is not ours. */
function relativePath(url: string, basePath: string): string | null {
  const pathname = url.split('?', 1)[0];
  const base = basePath === '/' ? '' : basePath;
  if (!base) return pathname || '/';
  if (pathname === base || pathname.startsWith(base + '/')) return pathname.slice(base.length) || '/';
  return null;
}

export async function toRequest(req: IncomingMessage, path: string): Promise<LudinRequest> {
  const rawQuery = (req.url ?? '').split('?', 2)[1] ?? '';
  const query: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(rawQuery)) query[k] = v;

  const socket = req.socket as { remoteAddress?: string; encrypted?: boolean } | undefined;
  return {
    method: req.method ?? 'GET',
    path,
    query,
    headers: req.headers,
    body: await readBody(req),
    remoteAddress: socket?.remoteAddress ?? '',
    protocol: socket?.encrypted ? 'https' : 'http',
  };
}

function readBody(req: IncomingMessage): Promise<string | null> {
  if (req.method === 'GET' || req.method === 'HEAD') return Promise.resolve(null);
  const parsed = (req as { body?: unknown }).body;
  if (typeof parsed === 'string') return Promise.resolve(parsed);
  if (Buffer.isBuffer(parsed)) return Promise.resolve(parsed.toString('utf8'));
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
