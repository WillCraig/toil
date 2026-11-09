/**
 * Pointing npm at the organization's registry (Artifactory and its kin), for
 * an Install that failed because npm could not reach the public one. Writes
 * exactly one line, `registry=<url>`, to the person's user-level npmrc
 * (npm's own `userconfig`, so `npm_config_userconfig` wins over ~/.npmrc),
 * keeps every other line as it was, and never touches or reads a credential:
 * `_authToken` and `_auth` lines are the person's, made by `npm login`. A URL
 * with a username, a password, a query or a fragment is refused, so a secret
 * pasted into the box never reaches the file. The change is shown to the
 * person before and after it is made (agent-install.tsx). One line in a
 * ledger, initialled by the person it changes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class RegistryError extends Error {
  constructor(message: string, readonly fix: string) {
    super(message);
  }
}

/** The user-level npmrc npm itself would read, as a path. */
export function npmrcPath(env: Record<string, string | undefined>, home: string): string {
  return env.npm_config_userconfig || env.NPM_CONFIG_USERCONFIG || join(home, '.npmrc');
}

/** The registry URL as npm wants it (a trailing slash), or a RegistryError saying what is wrong. */
export function checkRegistry(input: unknown): string {
  const text = typeof input === 'string' ? input.trim() : '';
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new RegistryError(`"${text.slice(0, 80)}" isn't a web address.`, 'Paste the registry URL your organization gives you, for example https://artifactory.example.com/artifactory/api/npm/npm-virtual/.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new RegistryError('A registry address starts with https://.', 'Paste the full https:// address of your npm registry.');
  if (url.username || url.password) throw new RegistryError('That address has a username or password in it, and Toil UI never writes a credential into a file.', 'Remove it from the address. Sign in with npm login --registry <address> in your own terminal.');
  if (url.search || url.hash) throw new RegistryError('A registry address has no ? or # part.', 'Paste the address without anything after the path.');
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

export interface RegistryChange {
  file: string;
  registry: string;
  /** What the file said before, or null when it had no registry line. */
  previous: string | null;
}

/** Sets `registry=` in the file, replacing a registry line there or adding one, and leaving the rest byte for byte. */
export function setRegistry(file: string, registry: string, read: (p: string) => string | null = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null), write: (p: string, t: string) => void = (p, t) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); }): RegistryChange {
  const url = checkRegistry(registry);
  const text = read(file) ?? '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const at = lines.findIndex((l) => /^\s*registry\s*=/.test(l));
  const previous = at >= 0 ? lines[at]!.replace(/^\s*registry\s*=\s*/, '').trim() : null;
  if (at >= 0) lines[at] = `registry=${url}`;
  else {
    lines.push(`registry=${url}`);
  }
  write(file, `${lines.join(eol)}${eol}`);
  return { file, registry: url, previous };
}
