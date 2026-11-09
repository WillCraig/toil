/**
 * What a pasted secret looks like when it arrives, checked before it goes to
 * the OS credential store (#358). One function, `checkSecret()`, decides every
 * case, and every way of entering a secret uses it: the CLI's terminal
 * prompter (through `askCheckedSecret()`), a host's `person` through the API,
 * and Toil UI's password fields, which run it in the page. So a terminal and
 * a form say the same thing in the same words, and can't drift apart.
 *
 * Nothing here shows any part of the value: not a prefix, not a suffix, not a
 * hash. What it reports is the length, the whitespace it took off the ends,
 * and the wrapper it found ("Bearer ", "token ", quotes), which is boilerplate
 * and never the secret. A paste is checked for the usual accidents, the way a
 * form is checked for a missing signature, except that this one tells you which box.
 */

import type { Prompter } from './prompt.js';
import { ToilError } from './errors.js';

/** How a secret is asked for. */
export interface SecretRules {
  /** A password rather than a token: a space inside it is allowed, since people put them in passwords. */
  password?: boolean;
  /**
   * What an empty answer means: ask again, since the connection needs one
   * (`required`); keep the secret already stored (`keep`, `login` on an
   * existing connection); or store none (`skip`, an optional one).
   */
  empty: 'required' | 'keep' | 'skip';
  /**
   * The env vars that define this connection with no file at all
   * (`TOIL_CONN_<NAME>_AREA=<area>`, then each setting and secret), named in
   * the fix for an empty required secret, so a machine with no credential store
   * has a way out that isn't Ctrl+C alone. Only the whole set works: a variable
   * for a connection that was never saved names no connection.
   */
  envVars?: readonly string[];
}

/** A wrapper around the value that the person is asked to remove: quotes, or a `Bearer ` / `token ` prefix. */
export interface SecretWrapper {
  /** The value without it. */
  without: string;
  /** Its length, in characters. */
  withoutLength: number;
  /** The question: `This starts with "Bearer ". Store it without that? [Y/n]`. */
  question: string;
  /** What it is, for a button: `"Bearer "`, `the quotes`. */
  what: string;
}

export type SecretCheck =
  | {
      status: 'empty';
      empty: SecretRules['empty'];
      /** `Kept the existing secret.`, or why an empty answer won't do. */
      message: string;
      /** Set when it's refused (`required`): what to do instead. */
      fix: string | null;
    }
  | {
      status: 'refused';
      /** Why: a line break, or a space, inside the value. */
      message: string;
      fix: string;
      length: number;
    }
  | {
      status: 'ok';
      /** The value with surrounding whitespace removed: what is stored, unless the wrapper is removed too. */
      value: string;
      length: number;
      /** What trimming took off, in words (`a trailing newline`), or null. */
      removed: string | null;
      /** `Received 40 characters (removed a trailing newline).` */
      received: string;
      wrapper: SecretWrapper | null;
    };

/** Characters, as a person counts them: one per code point, so an emoji is one, as it is one bullet. */
export function characters(value: string): number {
  return Array.from(value).length;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n === 1 ? 'a' : n} ${n === 1 ? one : many}`;

/** `a trailing newline`, `2 leading spaces`, `3 trailing whitespace characters`, for one end. */
function describeEnd(ws: string, end: 'leading' | 'trailing'): string | null {
  if (ws === '') return null;
  const newlines = (ws.match(/\r\n|\r|\n/g) ?? []).length;
  const spaces = (ws.match(/ /g) ?? []).length;
  const tabs = (ws.match(/\t/g) ?? []).length;
  const total = characters(ws.replace(/\r\n/g, '\n'));
  if (newlines === total) return plural(newlines, `${end} newline`);
  if (spaces === total) return plural(spaces, `${end} space`);
  if (tabs === total) return plural(tabs, `${end} tab`);
  return plural(total, `${end} whitespace character`);
}

const WHITESPACE = /\s/u;
const QUOTES: ReadonlyArray<[string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['`', '`'],
  ['“', '”'],
  ['‘', '’'],
];
const PREFIX = /^(bearer|token)[ \t]+/i;
/** A paste from a shell or a .env file: `GITHUB_TOKEN=...` or `export GITHUB_TOKEN=...`. The name is boilerplate, never the secret. */
const ENV_ASSIGNMENT = /^(?:export[ \t]+)?[A-Z][A-Z0-9_]{2,}=/;

/** The value with quotes and a `Bearer ` / `token ` prefix taken off, and what was taken. */
function unwrap(value: string): { inner: string; quoted: boolean; prefix: string | null } {
  let inner = value;
  let quoted = false;
  // A pair of quotes with nothing inside is the value, not a wrapper: removing them would store nothing.
  const pair = QUOTES.find(([open, close]) => inner.length > open.length + close.length && inner.startsWith(open) && inner.endsWith(close));
  if (pair) {
    inner = inner.slice(pair[0].length, inner.length - pair[1].length);
    quoted = true;
  }
  // An env-var paste comes off first, and what follows may itself be quoted.
  const env = ENV_ASSIGNMENT.exec(inner);
  if (env && env[0].length < inner.length) {
    const name = env[0].replace(/^export[ \t]+/, '');
    inner = inner.slice(env[0].length);
    const again = QUOTES.find(([open, close]) => inner.length > open.length + close.length && inner.startsWith(open) && inner.endsWith(close));
    if (again) inner = inner.slice(again[0].length, inner.length - again[1].length);
    return { inner, quoted: quoted || Boolean(again), prefix: name };
  }
  const match = PREFIX.exec(inner);
  // "Bearer" alone, or "token" alone, is a word, not a prefix: there must be something after it.
  const prefix = match && match[0].length < inner.length ? `${match[1]} ` : null;
  if (match && prefix) inner = inner.slice(match[0].length);
  return { inner, quoted, prefix };
}

/**
 * Checks a secret as it was typed or pasted, before anything stores it.
 * Surrounding whitespace is trimmed and reported; quotes or a `Bearer ` /
 * `token ` prefix are found and asked about, never removed silently; a line
 * break inside the value (or, for a token, a space or tab) is refused, since
 * the paste most likely took two lines; and an empty answer is reported by
 * what it means under `rules.empty`.
 */
export function checkSecret(raw: string, rules: SecretRules): SecretCheck {
  const value = raw.trim();
  if (value === '') {
    if (rules.empty === 'keep') return { status: 'empty', empty: 'keep', message: 'Kept the existing secret.', fix: null };
    if (rules.empty === 'skip') return { status: 'empty', empty: 'skip', message: 'Nothing was entered, so none is stored.', fix: null };
    return { status: 'empty', empty: 'required', message: 'Nothing was entered, and this one is required.', fix: `Paste or type the secret, then press Enter.${rules.envVars?.length ? ` To define this connection with env vars instead, cancel and set ${rules.envVars.join(', ')}.` : ''}` };
  }
  const length = characters(value);
  const lead = raw.slice(0, raw.length - raw.trimStart().length);
  const trail = raw.slice(raw.trimEnd().length);
  const parts = [describeEnd(lead, 'leading'), describeEnd(trail, 'trailing')].filter((p): p is string => p !== null);
  const removed = parts.length ? parts.join(' and ') : null;

  const { inner, quoted, prefix } = unwrap(value);
  // Checked on the value inside any wrapper, so the space after "Bearer" isn't counted against it.
  const breaks = /[\r\n]/.test(inner);
  const spaced = !rules.password && [...inner].some((c) => WHITESPACE.test(c));
  if (breaks || spaced) {
    const what = rules.password ? 'password' : 'token';
    return {
      status: 'refused',
      message: breaks
        ? 'This has a line break in the middle, so the paste most likely took two lines. Nothing was stored.'
        : `This has ${inner.includes('\t') ? 'a tab' : 'a space'} in the middle, so the paste most likely took more than the token. Nothing was stored.`,
      fix: `Copy just the ${what}, on its own, and paste it again.`,
      length,
    };
  }

  const what = quoted && prefix ? `the quotes and "${prefix}"` : quoted ? 'the quotes' : prefix ? `"${prefix}"` : null;
  const wrapper: SecretWrapper | null = what
    ? {
        without: inner,
        withoutLength: characters(inner),
        what,
        question: quoted && prefix ? `This is in quotes and starts with "${prefix}". Store it without them? [Y/n]` : quoted ? 'This is in quotes. Store it without them? [Y/n]' : `This starts with "${prefix}". Store it without that? [Y/n]`,
      }
    : null;

  return { status: 'ok', value, length, removed, received: receivedLine(length, removed), wrapper };
}

/** `Received 40 characters.`, or `Received 40 characters (removed a trailing newline).` */
export function receivedLine(length: number, removed: string | null): string {
  return `Received ${length} character${length === 1 ? '' : 's'}${removed ? ` (removed ${removed})` : ''}.`;
}

/** A yes or no to a wrapper question: empty is yes, as `[Y/n]` says; anything else is undefined. */
export function answerYes(answer: string): boolean | undefined {
  const a = answer.trim().toLowerCase();
  if (a === '' || a === 'y' || a === 'yes') return true;
  if (a === 'n' || a === 'no') return false;
  return undefined;
}

/**
 * Asks for a secret through `prompt` and checks it with `checkSecret()`,
 * returning what to store, or '' when nothing should be (a kept or skipped
 * one). A terminal (`prompt.canAskAgain`) hears each line and is asked again
 * after a refusal; a host's `person` can't be, so a refusal there is an
 * `INVALID_INPUT` with the same message and fix. A wrapper is asked about as
 * the `unwrap:<key>` question, so a host answers it by id.
 */
export async function askCheckedSecret(prompt: Prompter, question: string, key: string, rules: SecretRules): Promise<string> {
  const note = (line: string) => prompt.note?.(line);
  for (;;) {
    const check = checkSecret(await prompt.askSecret(question, `secret:${key}`), rules);
    if (check.status === 'empty') {
      note(check.message);
      if (check.empty !== 'required') return '';
      if (!prompt.canAskAgain) throw new ToilError('INVALID_INPUT', `${key}: ${check.message} Nothing was saved.`, { fix: check.fix ?? 'Enter it and try again.' });
      continue;
    }
    if (check.status === 'refused') {
      note(`${check.message} ${check.fix}`);
      if (!prompt.canAskAgain) throw new ToilError('INVALID_INPUT', `${key}: ${check.message}`, { fix: check.fix });
      continue;
    }
    note(check.received);
    if (!check.wrapper) return check.value;
    for (;;) {
      const yes = answerYes(await prompt.ask(check.wrapper.question, undefined, `unwrap:${key}`));
      if (yes === true) {
        note(`Removed ${check.wrapper.what}: ${check.wrapper.withoutLength} character${check.wrapper.withoutLength === 1 ? '' : 's'} left.`);
        return check.wrapper.without;
      }
      if (yes === false) return check.value;
      if (!prompt.canAskAgain) throw new ToilError('INVALID_INPUT', `The answer to "${check.wrapper.question}" must be y or n.`, { fix: 'Answer y to store it without that, or n to store it as entered.' });
    }
  }
}
