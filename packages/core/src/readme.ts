import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { ReadmeOptions, Role } from './types.js';

/** Refuse to hold a huge file in memory – this is a page, not a download. */
const MAX_BYTES = 5 * 1024 * 1024;

export class ReadmeError extends Error {}

/**
 * The optional HTML page (`readme`): a file on disk, re-read whenever it
 * changes so editing it does not need a restart, and cached in between.
 */
export class Readme {
  readonly label: string;
  readonly visibleTo?: Role[];
  readonly path: string;
  private cache: { key: string; html: string } | null = null;

  private constructor(options: ReadmeOptions) {
    this.path = isAbsolute(options.path) ? options.path : resolve(process.cwd(), options.path);
    this.label = options.label?.trim() || 'README';
    this.visibleTo = options.visibleTo?.length ? options.visibleTo : undefined;
  }

  /** `null` when no page is configured or it is switched off. */
  static from(option: string | ReadmeOptions | undefined): Readme | null {
    if (!option) return null;
    const options: ReadmeOptions = typeof option === 'string' ? { path: option } : option;
    if (options.enabled === false) return null;
    if (!options.path || typeof options.path !== 'string') {
      throw new Error('[ludin] `readme` needs a `path` to an HTML file.');
    }
    const readme = new Readme(options);
    // Fail loudly at boot rather than on the first click.
    void stat(readme.path).catch(() => console.warn(`[ludin] readme file not found: ${readme.path}`));
    return readme;
  }

  /** Visible to a role? Mirrors spec `visibleTo` semantics. */
  visibleFor(role: Role): boolean {
    return !this.visibleTo || this.visibleTo.includes(role);
  }

  async html(): Promise<string> {
    let info;
    try {
      info = await stat(this.path);
    } catch {
      throw new ReadmeError(`The configured readme file is missing: ${this.path}`);
    }
    if (!info.isFile()) throw new ReadmeError(`The configured readme path is not a file: ${this.path}`);
    if (info.size > MAX_BYTES) {
      throw new ReadmeError(`The readme file is larger than ${MAX_BYTES / 1024 / 1024} MB: ${this.path}`);
    }
    const key = `${info.mtimeMs}:${info.size}`;
    if (this.cache?.key === key) return this.cache.html;
    const html = await readFile(this.path, 'utf8');
    this.cache = { key, html };
    return html;
  }
}
