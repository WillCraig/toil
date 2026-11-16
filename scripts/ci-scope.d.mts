// Types for scripts/ci-scope.mjs, so test/ci-scope.test.ts can import it.

export function needsFullRun(paths: string[]): boolean;
export function keptBy(paths: string[]): string[];
