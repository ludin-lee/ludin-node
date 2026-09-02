import { Inject, Module, RequestMethod } from '@nestjs/common';
import type { DynamicModule, INestApplication, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { rudin as rudinExpress } from '@rudin/express';
import type { RudinMiddleware } from '@rudin/express';
import type { RudinOptions } from 'rudin';

export type { RudinOptions } from 'rudin';
export { hashPassword } from 'rudin';

export const RUDIN_OPTIONS = Symbol('RUDIN_OPTIONS');

export interface RudinModuleOptions extends Omit<RudinOptions, 'basePath'> {
  /** Mount path. Default '/docs'. */
  path?: string;
}

/**
 * Drop-in replacement for `SwaggerModule.setup()`:
 *
 * ```ts
 * const document = SwaggerModule.createDocument(app, config);
 * setupRudin(app, '/docs', document, { auth: { users: [...] } });
 * ```
 */
export function setupRudin(
  app: INestApplication,
  path: string,
  document: RudinOptions['spec'],
  options: Omit<RudinModuleOptions, 'path' | 'spec'> = {},
): RudinMiddleware {
  const basePath = normalize(path);
  const mw = rudinExpress({ ...options, spec: document, basePath });
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
 * Module form – `RudinModule.forRoot({ path: '/docs', spec: () => document, auth: {...} })`.
 * Useful when the spec is produced by a provider or you prefer DI configuration.
 */
@Module({})
export class RudinModule implements NestModule {
  static forRoot(options: RudinModuleOptions): DynamicModule {
    return {
      module: RudinModule,
      providers: [{ provide: RUDIN_OPTIONS, useValue: options }],
      exports: [RUDIN_OPTIONS],
    };
  }

  static forRootAsync(opts: {
    imports?: DynamicModule['imports'];
    inject?: unknown[];
    useFactory: (...args: unknown[]) => RudinModuleOptions | Promise<RudinModuleOptions>;
  }): DynamicModule {
    return {
      module: RudinModule,
      imports: opts.imports ?? [],
      providers: [{ provide: RUDIN_OPTIONS, inject: opts.inject as never[], useFactory: opts.useFactory }],
      exports: [RUDIN_OPTIONS],
    };
  }

  constructor(@Inject(RUDIN_OPTIONS) private readonly options: RudinModuleOptions) {}

  configure(consumer: MiddlewareConsumer) {
    const basePath = normalize(this.options.path ?? '/docs');
    const { path: _p, ...rest } = this.options;
    const mw = rudinExpress({ ...rest, basePath });
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
