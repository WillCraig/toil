import { z } from 'zod';
import { ToilError } from './errors.js';

/**
 * Request paths built from ids. An id names one resource, so each value put
 * into a path goes in as exactly one segment: `apiPath` encodes every
 * interpolated value with `encodeURIComponent`, so a `/`, `?`, `#` or `%` in
 * an owner, a repo, a key or a page title is part of that name and never path
 * or query syntax. Literal text in the template is left as written.
 *
 *   apiPath`/repos/${owner}/${repo}/issues/${number}/labels/${label}`
 *
 * A value that genuinely spans several segments (a file path in a
 * repository) goes through `segments()`, which encodes each part on its own
 * and refuses a `.` or `..` part. `rawPath()` passes text the area has
 * already encoded, for the rare value that is itself a fragment of path.
 *
 * Context inputs that land in a path also get `pathIdSchema()`, so a value
 * with path syntax in it is refused when it arrives (a flag, the toil project, an
 * env var, a git remote) rather than encoded into a name nobody has. The
 * request layer backs both up (src/core/rest.ts). One id, one segment, one
 * resource: the filing system's oldest rule, now enforced.
 */

/** Text already encoded as path, put in as it is. Made by `rawPath()` and `segments()`. */
export class RawPath {
  constructor(readonly text: string) {}
  toString(): string {
    return this.text;
  }
}

export type PathValue = string | number | RawPath;

/** A path template whose every interpolated value is encoded as one path segment. */
export function apiPath(strings: TemplateStringsArray, ...values: readonly PathValue[]): string {
  let out = strings[0]!;
  values.forEach((value, i) => {
    out += (value instanceof RawPath ? value.text : encodeURIComponent(String(value))) + strings[i + 1]!;
  });
  return out;
}

/** Text the caller has already encoded, for `apiPath` to leave alone. */
export function rawPath(text: string): RawPath {
  return new RawPath(text);
}

/**
 * `a/b c.md` -> `a/b%20c.md`: a value that is several segments (a file path,
 * a nested group), each encoded on its own. A `.` or `..` part is
 * INVALID_INPUT, since it would name a different resource once parsed. `what`
 * names the value in the message.
 */
export function segments(value: string, what = 'The path'): RawPath {
  const parts = value.split('/');
  const dot = parts.find((p) => p === '.' || p === '..');
  if (dot !== undefined) {
    throw new ToilError('INVALID_INPUT', `${what} "${value}" has a "${dot}" part, which would name a different resource.`, {
      fix: 'Name it from its top, with no . or .. parts.',
    });
  }
  return new RawPath(parts.map(encodeURIComponent).join('/'));
}

/** What a path-bound id may not hold: a slash of either kind, `?`, `#`, `%`, or a control character. */
// eslint-disable-next-line no-control-regex -- control characters are what it refuses
export const PATH_ID = /^[^/\\?#%\u0000-\u001f\u007f]*$/;

/**
 * A context input or id that is put into a request path as one segment. It
 * refuses the characters that would be path or query syntax there, so the
 * value is checked however it arrived (core validates toil project, env, git and
 * setting values against the same schema). Empty is allowed, so a command's
 * own "could not determine" error still words a missing value.
 */
export function pathIdSchema(what: string) {
  return z.string().regex(PATH_ID, { message: `${what} can't contain /, \\, ?, #, % or a control character` });
}
