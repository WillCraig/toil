export const REQUIRED: string[];
export function allowed(path: string): boolean;
export function packageProblems(pkg: Record<string, unknown> & { scripts?: Record<string, string> }, toilVersion: string): string[];
export function npmCli(env?: Record<string, string | undefined>, execPath?: string): string;
export const AGENT_PEERS: string[];
export const SPAWNERS: string[];
export function lockfileProblems(lock: { packages?: Record<string, { version?: string; resolved?: string; integrity?: string; dependencies?: Record<string, string> }> }, pin: string, installed: string | null): string[];
export function lockfileLag(lock: { packages?: Record<string, { version?: string; resolved?: string; integrity?: string; dependencies?: Record<string, string> }> }, pin: string, installed: string | null): string | null;
