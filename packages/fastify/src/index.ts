import { createLudin } from 'ludin';
import type { LudinHandler, LudinOptions, LudinRequest } from 'ludin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export type { LudinOptions, LudinHandler } from 'ludin';
export { hashPassword } from 'ludin';

export interface LudinPlugin {
  (fastify: FastifyInstance, opts: unknown): Promise<void>;
  /** Available after the plugin has been registered. */
  ludin: LudinHandler;
}

/**
 * Create a Fastify plugin. Register it with a prefix:
 *
 * ```ts
 * await app.register(ludin({ spec: './openapi.json', auth: { users: [...] } }), { prefix: '/docs' });
 * ```
 *
 * The mount path is taken from the register prefix, so `basePath` is optional.
 * Without a prefix, routes are registered under `basePath` (default `/docs`).
 */
export function ludin(options: LudinOptions): LudinPlugin {
  const plugin = (async (fastify: FastifyInstance) => {
    const basePath = normalize(options.basePath ?? fastify.prefix ?? '/docs');
    const handler = createLudin({ ...options, basePath });
    plugin.ludin = handler;

    // Take over body parsing inside this (encapsulated) scope: ludin needs the
    // raw body, and the docs routes must accept any content type.
    fastify.removeAllContentTypeParsers?.();
    fastify.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));

    // With a register prefix Fastify prepends it for us; otherwise mount at basePath.
    const prefix = fastify.prefix ? '' : basePath;
    const respond = async (request: FastifyRequest, reply: FastifyReply) => {
      const out = await handler.handle(toRequest(request, basePath));
      reply.status(out.status);
      for (const [k, v] of Object.entries(out.headers)) reply.header(k, v);
      return reply.send(out.body);
    };
    fastify.all(prefix || '/', respond);
    fastify.all(`${prefix}/*`, respond);
  }) as unknown as LudinPlugin;

  return plugin;
}

export default ludin;

export function toRequest(request: FastifyRequest, basePath: string): LudinRequest {
  const url = request.raw.url ?? '/';
  const [rawPath, rawQuery = ''] = url.split('?', 2);
  const base = basePath === '/' ? '' : basePath;
  const path = base && rawPath.startsWith(base) ? rawPath.slice(base.length) : rawPath;
  const query: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(rawQuery)) query[k] = v;

  const socket = request.raw.socket as { remoteAddress?: string; encrypted?: boolean } | undefined;
  return {
    method: request.method,
    path: path || '/',
    query,
    headers: request.headers as LudinRequest['headers'],
    body: typeof request.body === 'string' ? request.body : request.body ? JSON.stringify(request.body) : null,
    remoteAddress: socket?.remoteAddress ?? '',
    protocol: socket?.encrypted ? 'https' : 'http',
  };
}

function normalize(p: string): string {
  if (!p.startsWith('/')) p = '/' + p;
  return p.replace(/\/+$/, '') || '/';
}
