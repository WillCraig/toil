/**
 * The machine secret and the cookie it signs (#561). Toil UI has no launch
 * token and no sign-in: the first time `toil-ui` runs it makes 32 random bytes
 * in its own data folder (`machine-secret`), and every later start reads the
 * same file, so a browser that was let in once stays let in across restarts
 * with nothing in the URL and nothing in the page's storage.
 *
 * The secret only ever signs. The cookie holds a random id and the time it was
 * issued, and an HMAC-SHA256 of those two with the secret; nothing else, and
 * nothing a script on the page can read (it is `HttpOnly`). The secret is never
 * logged, echoed, put in a response or sent anywhere. It does not leave the
 * machine and is no use off it.
 *
 * Permissions: on POSIX the file is mode 0600 in a 0700 folder. On Windows the
 * file takes the permissions of the user's profile folder; restricting its ACL
 * would mean running `icacls`, a program toil does not add (No Executables), so
 * the profile folder's own protection is what applies and docs/decisions says so.
 * Access is granted by a file only the account that owns it can read, which is
 * the same arrangement as the building's master key, left in the care of the
 * building's one tenant.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SECRET_BYTES = 32;
export const SECRET_FILE = 'machine-secret';
/** How long a cookie stays good, from its issue time. */
export const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
/** A clock may be a little behind the one that issued the cookie. */
const SKEW_SECONDS = 300;

export class MachineSecretError extends Error {
  constructor(message: string, readonly fix: string) {
    super(message);
  }
}

const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

/**
 * Reads the secret in `dir`, or makes it: once when there is no file, and again,
 * with a warning, when the file is not exactly 32 bytes (a copy cut short, an
 * editor's save). A corrupt secret is replaced, never half-used, so every
 * cookie it signed stops working and the browser is let in again on its next visit to the page.
 */
export function loadMachineSecret(dir: string, warn: (message: string) => void = () => undefined): Buffer {
  const file = join(dir, SECRET_FILE);
  let existing: Buffer | null = null;
  try {
    existing = readFileSync(file);
  } catch (e) {
    if (code(e) !== 'ENOENT') throw new MachineSecretError(`Toil UI can't read its machine secret, ${file}: ${(e as Error).message}`, `Fix the permissions on ${dir}, or delete ${file} to have a new one made.`);
  }
  if (existing?.length === SECRET_BYTES) return existing;
  const secret = randomBytes(SECRET_BYTES);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!existing) {
      try {
        // `wx`: if another toil-ui made it a moment ago, theirs stands and ours is dropped.
        writeFileSync(file, secret, { flag: 'wx', mode: 0o600 });
        return secret;
      } catch (e) {
        if (code(e) !== 'EEXIST') throw e;
        const winner = readFileSync(file);
        if (winner.length === SECRET_BYTES) return winner;
        existing = winner;
      }
    }
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, secret, { mode: 0o600 });
    renameSync(temp, file);
  } catch (e) {
    throw new MachineSecretError(`Toil UI can't write its machine secret, ${file}: ${(e as Error).message}`, `Fix the permissions on ${dir}, or start toil-ui with --data-dir <a folder you can write>.`);
  }
  warn(`${file} was ${existing?.length ?? 0} bytes, not ${SECRET_BYTES}, so it was replaced. Browsers that were let in before are let in again the next time they open the page.`);
  return secret;
}

const mac = (secret: Buffer, payload: string) => createHmac('sha256', secret).update(payload).digest();

/** A cookie value: a random id, the issue time in seconds, and the HMAC of both. */
export function issueCookie(secret: Buffer, nowMs: number = Date.now()): string {
  const payload = `${randomBytes(16).toString('base64url')}.${Math.floor(nowMs / 1000)}`;
  return `${payload}.${mac(secret, payload).toString('base64url')}`;
}

/** Whether a cookie value was signed by this secret and is still within its age. Compared in constant time. */
export function verifyCookie(secret: Buffer, value: string | undefined, nowMs: number = Date.now()): boolean {
  const parts = (value ?? '').split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]{22}$/.test(parts[0]!) || !/^\d{1,12}$/.test(parts[1]!)) return false;
  const given = Buffer.from(parts[2]!, 'base64url');
  const expected = mac(secret, `${parts[0]}.${parts[1]}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  const age = Math.floor(nowMs / 1000) - Number(parts[1]);
  return age >= -SKEW_SECONDS && age <= COOKIE_MAX_AGE_SECONDS;
}

/** The value of one cookie in a `Cookie` header, or undefined. */
export function cookieNamed(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
