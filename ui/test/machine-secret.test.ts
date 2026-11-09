// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COOKIE_MAX_AGE_SECONDS, SECRET_BYTES, SECRET_FILE, cookieNamed, issueCookie, loadMachineSecret, verifyCookie } from '../server/machine-secret.ts';

const made: string[] = [];
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), 'toil-ui-secret-'));
  made.push(dir);
  return dir;
};
afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('the machine secret file', () => {
  it('makes 32 random bytes on the first run, once, and reads the same ones on every later start', () => {
    const dir = join(folder(), 'data');
    const warnings: string[] = [];
    const first = loadMachineSecret(dir, (m) => warnings.push(m));
    expect(first).toHaveLength(SECRET_BYTES);
    expect(readFileSync(join(dir, SECRET_FILE)).equals(first)).toBe(true);
    const mtime = statSync(join(dir, SECRET_FILE)).mtimeMs;
    expect(loadMachineSecret(dir, (m) => warnings.push(m)).equals(first)).toBe(true);
    expect(statSync(join(dir, SECRET_FILE)).mtimeMs).toBe(mtime);
    expect(warnings).toEqual([]);
    expect(loadMachineSecret(join(folder(), 'other')).equals(first)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('is mode 0600 in a 0700 folder on POSIX (Windows has no mode: the profile folder applies)', () => {
    const dir = join(folder(), 'data');
    loadMachineSecret(dir);
    expect(statSync(join(dir, SECRET_FILE)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('replaces a short, long or empty file with a new secret and a warning that never holds the secret', () => {
    for (const bad of [Buffer.alloc(0), Buffer.from('short'), Buffer.alloc(SECRET_BYTES + 1, 7), Buffer.from('not hex, not binary, and 32 chars? no')]) {
      const dir = folder();
      writeFileSync(join(dir, SECRET_FILE), bad);
      const warnings: string[] = [];
      const secret = loadMachineSecret(dir, (m) => warnings.push(m));
      expect(secret).toHaveLength(SECRET_BYTES);
      expect(readFileSync(join(dir, SECRET_FILE)).equals(secret)).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`${bad.length} bytes, not ${SECRET_BYTES}`);
      for (const needle of [secret.toString('hex'), secret.toString('base64'), secret.toString('base64url')]) expect(warnings[0]).not.toContain(needle);
      expect(existsSync(`${join(dir, SECRET_FILE)}.${process.pid}.tmp`)).toBe(false);
      expect(loadMachineSecret(dir).equals(secret)).toBe(true);
    }
  });

  it('refuses, with the fix, a secret it cannot read or write, rather than run without one', () => {
    const dir = folder();
    // A path through a file: Windows says it isn't there and the write then fails, Linux fails the read first (ENOTDIR); either way it refuses.
    writeFileSync(join(dir, 'x'), '');
    expect(() => loadMachineSecret(join(dir, 'x', 'sub'))).toThrow(/can't (read|write) its machine secret/);
  });
});

describe('the cookie', () => {
  const secret = Buffer.alloc(SECRET_BYTES, 1);
  const now = Date.UTC(2026, 10, 5);

  it('holds a random id, the issue time and an HMAC, and verifies within its age only', () => {
    const value = issueCookie(secret, now);
    const [id, iat, mac] = value.split('.');
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(iat).toBe(String(Math.floor(now / 1000)));
    expect(mac).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issueCookie(secret, now)).not.toBe(value);
    expect(verifyCookie(secret, value, now)).toBe(true);
    expect(verifyCookie(secret, value, now + (COOKIE_MAX_AGE_SECONDS - 1) * 1000)).toBe(true);
    expect(verifyCookie(secret, value, now + (COOKIE_MAX_AGE_SECONDS + 1) * 1000)).toBe(false);
    expect(verifyCookie(secret, value, now - 3600 * 1000)).toBe(false);
    expect(verifyCookie(Buffer.alloc(SECRET_BYTES, 2), value, now)).toBe(false);
    for (const bad of [undefined, '', 'a', 'a.b', 'a.b.c.d', `${id}.${iat}.`, `${id}..${mac}`]) expect(verifyCookie(secret, bad, now)).toBe(false);
  });

  it('finds one cookie among others in a Cookie header', () => {
    expect(cookieNamed('a=1; toil-ui=abc; b=2', 'toil-ui')).toBe('abc');
    expect(cookieNamed('xtoil-ui=abc', 'toil-ui')).toBeUndefined();
    expect(cookieNamed(undefined, 'toil-ui')).toBeUndefined();
  });
});
