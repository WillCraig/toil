/**
 * `node:sqlite`, loaded quietly. It is built into Node 24, so the cache needs
 * no native module (#206), but Node 24 still marks it experimental and prints
 * an `ExperimentalWarning` to stderr the first time it loads. That line would
 * land in the user's terminal on every start, beside the URL, saying
 * something they can do nothing about. So the module is imported dynamically
 * (never at the top of the bundle) with that one warning filtered out, and
 * every other warning still printed. Once Node calls it stable the filter
 * simply never matches.
 *
 * The API Toil UI uses is the small, settled part (`DatabaseSync`, `exec`,
 * `prepare`, `run`, `get`, `all`), and ui/test/cache.test.ts exercises all of
 * it, so a change in a later Node fails the tests rather than a user's sync.
 * A library that apologises for itself on import, politely muted.
 */

export type { DatabaseSync, StatementSync } from 'node:sqlite';

let loaded: Promise<typeof import('node:sqlite')> | undefined;

/** True for the one warning this filters: node:sqlite's own "experimental" notice. */
export function isSqliteNotice(warning: unknown, typeOrOptions: unknown): boolean {
  const type = typeof typeOrOptions === 'string' ? typeOrOptions : (typeOrOptions as { type?: unknown } | undefined)?.type;
  const name = warning instanceof Error ? warning.name : type;
  const message = warning instanceof Error ? warning.message : String(warning);
  return name === 'ExperimentalWarning' && /\bSQLite\b/.test(message);
}

/** Loads node:sqlite once, without its experimental notice. */
export function loadSqlite(): Promise<typeof import('node:sqlite')> {
  loaded ??= (async () => {
    const original = process.emitWarning;
    process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
      if (isSqliteNotice(warning, rest[0])) return;
      return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
    } as typeof process.emitWarning;
    try {
      return await import('node:sqlite');
    } finally {
      process.emitWarning = original;
    }
  })();
  return loaded;
}
