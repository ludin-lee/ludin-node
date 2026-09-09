import { Inject, Module, RequestMethod } from '@nestjs/common';
import type { DynamicModule, INestApplication, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ludin as ludinExpress } from '@ludin-docs/express';
import type { LudinMiddleware } from '@ludin-docs/express';
import type { LudinOptions } from 'ludin';

export type { LudinOptions } from 'ludin';
export { hashPassword } from 'ludin';

export const LUDIN_OPTIONS = Symbol('LUDIN_OPTIONS');

export interface LudinModuleOptions extends Omit<LudinOptions, 'basePath'> {
  /** Mount path. Default '/docs'. */
  path?: string;
}

/**
 * Drop-in replacement for `SwaggerModule.setup()`:
 *
 * ```ts
 * const document = SwaggerModule.createDocument(app, config);
 * setupLudin(app, '/docs', document, { auth: { users: [...] } });
 * ```
 */
export function setupLudin(
  app: INestApplication,
  path: string,
  document: LudinOptions['spec'],
  options: Omit<LudinModuleOptions, 'path' | 'spec'> = {},
): LudinMiddleware {
  const basePath = normalize(path);
  const mw = ludinExpress({ ...options, spec: document, basePath });
  const adapter = app.getHttpAdapter();
  const instance = adapter.getInstance?.() as { use?: (p: string, fn: unknown) => void } | undefined;
  if (typeof instance?.use === 'function') {
    instance.use(basePath, mw);
  } else {
    adapter.use(basePath, mw);
  }
  return mw;
}

/**
 * Module form – `LudinModule.forRoot({ path: '/docs', spec: () => document, auth: {...} })`.
 * Useful when the spec is produced by a provider or you prefer DI configuration.
 */
@Module({})
export class LudinModule implements NestModule {
  static forRoot(options: LudinModuleOptions): DynamicModule {
    return {
      module: LudinModule,
      providers: [{ provide: LUDIN_OPTIONS, useValue: options }],
      exports: [LUDIN_OPTIONS],
    };
  }

  static forRootAsync(opts: {
    imports?: DynamicModule['imports'];
    inject?: unknown[];
    useFactory: (...args: unknown[]) => LudinModuleOptions | Promise<LudinModuleOptions>;
  }): DynamicModule {
    return {
      module: LudinModule,
      imports: opts.imports ?? [],
      providers: [{ provide: LUDIN_OPTIONS, inject: opts.inject as never[], useFactory: opts.useFactory }],
      exports: [LUDIN_OPTIONS],
    };
  }

  constructor(@Inject(LUDIN_OPTIONS) private readonly options: LudinModuleOptions) {}

  configure(consumer: MiddlewareConsumer) {
    const basePath = normalize(this.options.path ?? '/docs');
    const { path: _p, ...rest } = this.options;
    const mw = ludinExpress({ ...rest, basePath });
    // Apply on every route and let the middleware decide by prefix – this
    // keeps us compatible with both path-to-regexp v0 (Nest ≤10) and v8 (Nest 11).
    consumer
      .apply((req: { originalUrl?: string; url?: string }, res: unknown, next: () => void) => {
        const url = req.originalUrl ?? req.url ?? '';
        if (url === basePath || url.startsWith(basePath + '/') || url.startsWith(basePath + '?')) {
          return mw(req as never, res as never, next);
        }
        next();
      })
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}

function normalize(p: string): string {
  if (!p.startsWith('/')) p = '/' + p;
  return p.replace(/\/+$/, '') || '/';
}
