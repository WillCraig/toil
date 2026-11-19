/**
 * Reading a standard: the file a team keeps one set of ticket rules in. A
 * standard may be checked in and handed to toil by anyone who can open a pull
 * request, and its regular expressions run over text a tracker sent, so nothing
 * in it is taken on trust: shapes, lengths and one-line text are checked, a
 * value shaped like a credential is refused, and every pattern must compile,
 * stay short, and leave out the three constructions that let a regular
 * expression run far longer than its text: backreferences, a quantified group
 * that holds a quantifier or an alternation, and two repeats side by side that
 * can match the same characters. The reader is pure (no files), so
 * the catalog, the commands and a test all read a standard one way. A rule may
 * be as strict as the team likes; it may not be slow about it.
 */
import type { Warning } from '../envelope.js';
import { ToilError } from '../errors.js';
import { findSecrets } from '../secret-shapes.js';
import { readWhen } from '../classify/when.js';
import { CHECK_KINDS, STANDARD_NAME, STANDARD_RULE_ID, type CheckKind, type FailAs, type Place, type RuleCheck, type Standard, type StandardRule } from './types.js';

const TOP_KEYS = ['name', 'revision', 'description', 'rules'];
const RULE_KEYS = ['id', 'name', 'missing', 'text', 'when', 'fail', 'check'];
const CHECK_KEYS: Record<CheckKind, readonly string[]> = {
  pattern: ['kind', 'in', 'match', 'flags', 'labels'],
  section: ['kind', 'in', 'heading', 'minWords'],
  field: ['kind', 'in'],
  words: ['kind', 'in', 'min'],
  judge: ['kind', 'in'],
};

/** The caps a standard is held to; docs/bounds.md has no row for them because they bound a file's content, not a path. */
export const STANDARD_LIMITS = {
  description: 300,
  rules: 50,
  ruleName: 120,
  ruleText: 500,
  places: 5,
  patterns: 10,
  patternLength: 200,
  labelLength: 100,
  headings: 10,
  headingLength: 100,
  minWords: 1000,
  words: 10_000,
} as const;

/** A field a place names: an alias (`acceptanceCriteria`) or an id (`customfield_10042`, `Microsoft.VSTS.TCM.ReproSteps`). */
const FIELD_NAME = /^[A-Za-z0-9_][A-Za-z0-9_. :/-]{0,99}$/;
const PLAIN_PLACES = ['title', 'description', 'criteria'];

interface Problem {
  path: string;
  message: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isControl = (s: string) => [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

/** Why a text can't go in a standard, or undefined when it can: one line, within `max`, no credential shape. */
function textProblem(value: unknown, min: number, max: number): string | undefined {
  if (typeof value !== 'string') return 'must be text.';
  if (value.trim().length < min) return 'must not be empty.';
  if (value.length > max) return `is ${value.length} characters; the most is ${max}.`;
  // One line each: a rule's text reaches an AI agent's prompt, and a line break would let it pass as another instruction there.
  if (isControl(value)) return 'must be one line of text, with no line breaks or control characters.';
  if (findSecrets(value).length > 0) return 'holds something shaped like a credential, and a standard never holds one.';
  return undefined;
}

/**
 * The characters an atom may match, kept coarse on purpose: the 128 ASCII
 * characters one by one, and everything beyond ASCII as two lumps, its spaces
 * (so `\s*\S+` reads) and the rest. Two sets "may overlap" when they share an
 * ASCII character or a lump, which errs on the side of refusing.
 */
interface CharSet {
  ascii: Set<number>;
  /** Some character beyond ASCII that isn't a space. */
  other: boolean;
  /** Some space beyond ASCII (a no-break space, an em space). */
  otherSpace: boolean;
}

const ANY = (): CharSet => ({ ascii: new Set(range(0, 127)), other: true, otherSpace: true });
const range = (lo: number, hi: number): number[] => Array.from({ length: Math.max(0, hi - lo + 1) }, (_, k) => lo + k);
const DIGITS = range(48, 57);
const WORD = [...DIGITS, ...range(65, 90), ...range(97, 122), 95];
const SPACE = [9, 10, 11, 12, 13, 32];
const NONE = (): CharSet => ({ ascii: new Set(), other: false, otherSpace: false });
/** Every character not in `s`; beyond ASCII it keeps both lumps but the one `s` holds whole (\S has no wide space, \s no wide letter). */
const complement = (codes: Iterable<number>, wide: { other?: boolean; otherSpace?: boolean } = {}): CharSet => {
  const out = new Set(codes);
  return { ascii: new Set(range(0, 127).filter((c) => !out.has(c))), other: !wide.other, otherSpace: !wide.otherSpace };
};
const union = (a: CharSet, b: CharSet): CharSet => ({ ascii: new Set([...a.ascii, ...b.ascii]), other: a.other || b.other, otherSpace: a.otherSpace || b.otherSpace });
const overlaps = (a: CharSet, b: CharSet) => (a.other && b.other) || (a.otherSpace && b.otherSpace) || [...a.ascii].some((c) => b.ascii.has(c));
/** A positive set with both cases of every letter, since the `i` flag may be on and the guard never sees the flags. */
const folded = (s: CharSet): CharSet => {
  const out = new Set(s.ascii);
  for (const c of s.ascii) {
    if (c >= 65 && c <= 90) out.add(c + 32);
    if (c >= 97 && c <= 122) out.add(c - 32);
  }
  return { ...s, ascii: out };
};
/** One character; `fold` adds its other case, which a negated class must not have before it is complemented. */
const ofCode = (code: number, fold = true): CharSet => {
  if (code < 128) return fold ? folded({ ...NONE(), ascii: new Set([code]) }) : { ...NONE(), ascii: new Set([code]) };
  return /\s/.test(String.fromCharCode(code)) ? { ...NONE(), otherSpace: true } : { ...NONE(), other: true };
};
/** The class escapes, shared by an atom and a character class. */
const CLASS_ESCAPES: Record<string, () => CharSet> = {
  d: () => ({ ...NONE(), ascii: new Set(DIGITS) }),
  w: () => ({ ...NONE(), ascii: new Set(WORD) }),
  s: () => ({ ...NONE(), ascii: new Set(SPACE), otherSpace: true }),
  D: () => complement(DIGITS),
  W: () => complement(WORD),
  S: () => complement(SPACE, { otherSpace: true }),
};
const CONTROL_ESCAPES: Record<string, number> = { n: 10, r: 13, t: 9, f: 12, v: 11, '0': 0 };

/**
 * The escape at `i` (a backslash): how long it is, and the one character it
 * stands for (`code`) or the class it names (`set`). Hex and Unicode escapes
 * are read whole, so `\x41*` is one quantified atom and not `\x`, `4`, `1*`.
 */
function readEscape(source: string, i: number, inClass: boolean): { length: number; code?: number; set?: CharSet; zeroWidth?: boolean } {
  const next = source[i + 1] ?? '';
  if (CLASS_ESCAPES[next]) return { length: 2, set: CLASS_ESCAPES[next]() };
  if (next === 'b') return inClass ? { length: 2, code: 8 } : { length: 2, zeroWidth: true };
  if (next === 'B' && !inClass) return { length: 2, zeroWidth: true };
  if (next in CONTROL_ESCAPES) return { length: 2, code: CONTROL_ESCAPES[next] };
  const hex = (n: number) => {
    const digits = source.slice(i + 2, i + 2 + n);
    return new RegExp(`^[0-9A-Fa-f]{${n}}$`).test(digits) ? parseInt(digits, 16) : undefined;
  };
  if (next === 'x' && hex(2) !== undefined) return { length: 4, code: hex(2) };
  if (next === 'u' && hex(4) !== undefined) return { length: 6, code: hex(4) };
  if (next === 'c' && /[A-Za-z]/.test(source[i + 2] ?? '')) return { length: 3, code: source.charCodeAt(i + 2) % 32 };
  return { length: 2, code: next.charCodeAt(0) };
}

/** The character class starting at `i` (a `[`): where it ends and what it may match. JavaScript closes `[]` and `[^]` at once. */
function readClass(source: string, i: number): { end: number; set: CharSet } {
  let j = i + 1;
  const negated = source[j] === '^';
  if (negated) j++;
  let set = NONE();
  const one = (k: number): { next: number; code?: number; set?: CharSet } => {
    if (source[k] === '\\') {
      const e = readEscape(source, k, true);
      return { next: k + e.length, ...(e.code !== undefined ? { code: e.code } : {}), ...(e.set ? { set: e.set } : {}) };
    }
    return { next: k + 1, code: source.charCodeAt(k) };
  };
  while (j < source.length && source[j] !== ']') {
    const a = one(j);
    if (a.set) {
      set = union(set, a.set);
      j = a.next;
      continue;
    }
    if (source[a.next] === '-' && a.next + 1 < source.length && source[a.next + 1] !== ']') {
      const b = one(a.next + 1);
      if (b.code !== undefined && a.code !== undefined) {
        // Beyond ASCII a range may hold both lumps.
        set = union(set, { ascii: new Set(range(a.code, Math.min(b.code, 127))), other: b.code > 127, otherSpace: b.code > 127 });
        j = b.next;
        continue;
      }
    }
    set = union(set, ofCode(a.code!, false));
    j = a.next;
  }
  // A negated class is the complement of the unfolded set: a superset of what it matches with `i` on, which is the safe side.
  return { end: j + 1, set: negated ? complement(set.ascii) : folded(set) };
}

/** One open group (the pattern itself is the outermost) as the guard walks it. */
interface Frame {
  /** It holds a quantifier or an alternation, so repeating it is the exponential shape. */
  risky: boolean;
  /** Every character its atoms may match. */
  set: CharSet;
  /**
   * The repeats a next repeat could trade characters with: the last one, any
   * before it that only optional atoms separate, and any unbounded one that a
   * required atom it can also match follows (`.*` in `.*a`).
   */
  chain: { set: CharSet; text: string; unbounded: boolean }[];
  /** Some atom in it repeats without limit. */
  unbounded: boolean;
  /** The current alternative, and any earlier one, can match nothing. */
  branchEmpty: boolean;
  anyEmpty: boolean;
  /** A lookahead or lookbehind: it matches no characters, so it sits beside nothing. */
  zeroWidth: boolean;
  start: number;
}

/**
 * Why a regular expression can't be a rule's pattern, or undefined when it can.
 * Refused, each because it lets matching take far longer than the text is long:
 * - a backreference (`\1`, `\k<name>`);
 * - a group that holds a quantifier or an alternation and is itself repeated
 *   (`(a+)+`, `(a|ab)*`, `(\w+\s?){2,}`), which can take exponential time;
 * - two repeats side by side whose characters may overlap (`\s*\s*`, `\d+\d+`,
 *   `.*.*`, `a*a?`), where a repeat that may match nothing doesn't separate them
 *   (`\w+\s*\w+`, where `\s*` can be empty), and nor does a required
 *   character an unbounded repeat before it can also match (`.*a.*b`). Each such
 *   pair multiplies the ways to split a text: `\s*\s*\s*x` takes over a minute
 *   on 1,000 spaces, `.*a.*b` 11 seconds on 4,000 a's.
 * Matching is synchronous, so neither a time limit nor Ctrl+C could stop a slow
 * pattern once it starts; this refuses it while it is still text. It errs on the
 * side of refusing: characters are compared coarsely (anything beyond ASCII is
 * one lump, letters in both cases) and a group counts as every character it holds.
 */
export function patternProblem(source: string): string | undefined {
  const frame = (start: number, zeroWidth = false): Frame => ({ risky: false, set: NONE(), chain: [], unbounded: false, branchEmpty: true, anyEmpty: false, zeroWidth, start });
  const stack: Frame[] = [frame(0)];
  const top = () => stack[stack.length - 1]!;
  /** The quantifier starting at `i`, if any: its length and how many times it lets the atom match. */
  const quantifierAt = (i: number): { length: number; min: number; max: number } | undefined => {
    const c = source[i];
    let q: { length: number; min: number; max: number } | undefined;
    if (c === '*') q = { length: 1, min: 0, max: Infinity };
    else if (c === '+') q = { length: 1, min: 1, max: Infinity };
    else if (c === '?') q = { length: 1, min: 0, max: 1 };
    else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
      if (m) q = { length: m[0].length, min: Number(m[1]), max: m[2] === undefined ? Number(m[1]) : m[3] === '' ? Infinity : Number(m[3]) };
    }
    // A lazy suffix belongs to the quantifier.
    if (q && source[i + q.length] === '?') q.length++;
    return q;
  };
  /**
   * An atom ends at `end` in the current frame: it may match `set`, it varies in
   * length when `varies`, it may match nothing when `empty`, and it repeats
   * without limit when `unbounded`. A varying atom that overlaps a repeat in the
   * chain is refused. One that must match something ends the chain, except for
   * an unbounded repeat that can match it too: `.*a.*b` lets the two `.*` trade
   * every `a` between them, which is cubic on a text of a's.
   */
  const atom = (start: number, end: number, set: CharSet, varies: boolean, empty: boolean, unbounded: boolean): string | undefined => {
    const f = top();
    f.set = union(f.set, set);
    f.unbounded ||= unbounded;
    if (!empty) f.branchEmpty = false;
    const text = source.slice(start, end);
    if (varies) {
      const before = f.chain.find((prev) => overlaps(prev.set, set));
      if (before) {
        return `repeats ${JSON.stringify(text)} after ${JSON.stringify(before.text)} with nothing between them that only one could match, so the two can trade the same characters (like \\s*\\s*, \\d+\\d+, \\w+\\s*\\w+ or .*a.*b), which can take minutes on a long text; join them into one repeat, make them match different characters, or put a character only one of them matches between them (\\w+\\s+\\w+, [^,]*,.*b).`;
      }
      if (empty) f.chain.push({ set, text, unbounded });
      else f.chain = [{ set, text, unbounded }];
    } else if (!empty) f.chain = f.chain.filter((prev) => prev.unbounded && overlaps(prev.set, set));
    return undefined;
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    const start = i;
    let set: CharSet;
    if (c === '\\') {
      const next = source[i + 1];
      if (next !== undefined && /[1-9]/.test(next)) return 'uses a backreference (\\1 to \\9), which can take exponential time; write the pattern without one.';
      if (next === 'k' && source[i + 2] === '<') return 'uses a named backreference (\\k<name>), which can take exponential time; write the pattern without one.';
      const e = readEscape(source, i, false);
      i += e.length;
      if (e.zeroWidth) continue;
      set = e.set ?? ofCode(e.code!);
    } else if (c === '[') {
      const k = readClass(source, i);
      i = k.end;
      set = k.set;
    } else if (c === '(') {
      i++;
      let zeroWidth = false;
      // A group's own prefix (?:, ?=, ?!, ?<=, ?<!, ?<name>) is not a quantifier.
      if (source[i] === '?') {
        const m = /^\?(?::|=|!|<=|<!|<[A-Za-z_][A-Za-z0-9_]*>)/.exec(source.slice(i));
        zeroWidth = !!m && /^\?(?:=|!|<=|<!)$/.test(m[0]);
        i += m ? m[0].length : 1;
      }
      stack.push(frame(start, zeroWidth));
      continue;
    } else if (c === ')') {
      const g = stack.length > 1 ? stack.pop()! : frame(i);
      i++;
      const q = quantifierAt(i);
      if (q && q.max > 1 && g.risky) return 'repeats a group that itself holds a quantifier or an alternation (like (a+)+ or (a|ab)*), which can take exponential time; repeat a single character or class instead.';
      if (q || g.risky) top().risky = true;
      if (q) i += q.length;
      if (g.zeroWidth) continue;
      const empty = g.anyEmpty || g.branchEmpty || (q !== undefined && q.min === 0);
      const why = atom(g.start, i, g.set, g.risky || (q !== undefined && q.min !== q.max), empty, g.unbounded || q?.max === Infinity);
      if (why) return why;
      continue;
    } else if (c === '|') {
      const f = top();
      f.risky = true;
      f.anyEmpty ||= f.branchEmpty;
      f.branchEmpty = true;
      f.chain = [];
      i++;
      continue;
    } else if (c === '^' || c === '$') {
      i++;
      continue;
    } else {
      i++;
      set = c === '.' ? ANY() : ofCode(c.charCodeAt(0));
    }
    const q = quantifierAt(i);
    if (q) {
      top().risky = true;
      i += q.length;
    }
    const why = atom(start, i, set, q !== undefined && q.min !== q.max, q !== undefined && q.min === 0, q?.max === Infinity);
    if (why) return why;
  }
  return undefined;
}

/**
 * Validates a parsed standard and returns it normalised, with defaults filled in
 * and texts trimmed. `where` names the file (or "the built-in standard") in the
 * error; the first problem is in the message and up to five are in `details`.
 */
export function readStandard(raw: unknown, where: string): { standard: Standard; warnings: Warning[] } {
  const problems: Problem[] = [];
  const warnings: Warning[] = [];
  const bad = (path: string, message: string) => problems.push({ path, message });
  const unknown = (at: string, key: string, takes: readonly string[], what: string) =>
    warnings.push({ code: 'STANDARD_UNKNOWN_KEY', message: `${where} (${at}): "${key}" isn't ${what} key; ${what.replace(/^an? /, 'a ')} takes ${takes.join(', ')}. It was ignored.` });
  const fail = (): never => {
    const first = problems[0]!;
    const more = problems.length > 1 ? ` (and ${problems.length - 1} more problem${problems.length > 2 ? 's' : ''})` : '';
    throw new ToilError('CONFIG_INVALID', `Standard ${where} can't be used${first.path ? `: ${first.path}` : ''}: ${first.message}${more}`, {
      fix: `Fix it in ${where}; toil standards list --cwd <folder> reads it again.`,
      details: problems.slice(0, 5),
    });
  };
  if (!isRecord(raw)) {
    bad('', 'A standard must be a JSON object.');
    return fail();
  }
  for (const key of Object.keys(raw)) if (key !== '$schema' && !TOP_KEYS.includes(key)) unknown(key, key, TOP_KEYS, 'a standard');

  const name = raw.name;
  if (typeof name !== 'string' || !STANDARD_NAME.test(name)) bad('name', '"name" must be lowercase letters, digits and single hyphens, starting with a letter, e.g. "gherkin".');

  let revision = 1;
  if (raw.revision !== undefined) {
    if (typeof raw.revision === 'number' && Number.isInteger(raw.revision) && raw.revision > 0) revision = raw.revision;
    else bad('revision', '"revision" must be a whole number above 0.');
  }

  let description: string | undefined;
  if (raw.description !== undefined) {
    const why = textProblem(raw.description, 1, STANDARD_LIMITS.description);
    if (why) bad('description', `"description" ${why}`);
    else description = (raw.description as string).trim();
  }

  const rules: StandardRule[] = [];
  if (!Array.isArray(raw.rules) || raw.rules.length === 0) bad('rules', `"rules" must be a list of 1 to ${STANDARD_LIMITS.rules} rules, each { id, name, text, when, fail, check }.`);
  else {
    if (raw.rules.length > STANDARD_LIMITS.rules) bad('rules', `"rules" holds ${raw.rules.length}; the most is ${STANDARD_LIMITS.rules}.`);
    const seen = new Set<string>();
    raw.rules.forEach((r: unknown, i: number) => {
      const at = `rules[${i}]`;
      if (!isRecord(r)) return bad(at, 'Each rule must be an object { id, name, text, when, fail, check }.');
      for (const key of Object.keys(r)) if (!RULE_KEYS.includes(key)) unknown(`${at}.${key}`, key, RULE_KEYS, 'a rule');
      let ok = true;
      const no = (path: string, message: string) => {
        ok = false;
        bad(path, message);
      };
      if (typeof r.id !== 'string' || !STANDARD_RULE_ID.test(r.id)) no(`${at}.id`, '"id" must be lowercase letters, digits and single hyphens, starting with a letter, up to 41 characters.');
      else if (seen.has(r.id)) no(`${at}.id`, `"${r.id}" is used by two rules.`);
      else seen.add(r.id);
      for (const [key, max] of [['name', STANDARD_LIMITS.ruleName], ['text', STANDARD_LIMITS.ruleText]] as const) {
        const why = textProblem(r[key], 1, max);
        if (why) no(`${at}.${key}`, `"${key}" ${why}`);
      }
      if (r.missing !== undefined) {
        const why = textProblem(r.missing, 1, STANDARD_LIMITS.ruleName);
        if (why) no(`${at}.missing`, `"missing" ${why}`);
      }
      let when: StandardRule['when'];
      if (r.when !== undefined) {
        // Absent means every item; an empty object is a mistake, never a quiet "everything".
        when = readWhen(r.when, `${at}.when`, bad, textProblem);
        if (when === undefined) ok = false;
      }
      let failAs: FailAs = 'thin';
      if (r.fail !== undefined) {
        if (r.fail === 'thin' || r.fail === 'fail') failAs = r.fail;
        else no(`${at}.fail`, '"fail" must be "thin" (the item needs work) or "fail" (the item is not ready).');
      }
      const check = readCheck(r.check, `${at}.check`, no, unknown);
      if (ok && check) rules.push({ id: r.id as string, name: (r.name as string).trim(), ...(typeof r.missing === 'string' ? { missing: r.missing.trim() } : {}), text: (r.text as string).trim(), ...(when ? { when } : {}), fail: failAs, check });
    });
  }

  if (problems.length > 0) return fail();
  return { standard: { name: name as string, revision, ...(description !== undefined ? { description } : {}), rules }, warnings };
}

function readCheck(
  raw: unknown,
  at: string,
  no: (path: string, message: string) => void,
  unknown: (at: string, key: string, takes: readonly string[], what: string) => void,
): RuleCheck | undefined {
  if (!isRecord(raw)) {
    no(at, `"check" must be an object with a "kind": ${CHECK_KINDS.join(', ')}.`);
    return undefined;
  }
  const kind = raw.kind;
  if (typeof kind !== 'string' || !(CHECK_KINDS as readonly string[]).includes(kind)) {
    no(`${at}.kind`, `"kind" must be one of ${CHECK_KINDS.join(', ')}.`);
    return undefined;
  }
  const k = kind as CheckKind;
  for (const key of Object.keys(raw)) if (!CHECK_KEYS[k].includes(key)) unknown(`${at}.${key}`, key, CHECK_KEYS[k], `a ${k} check`);
  let ok = true;
  const bad = (path: string, message: string) => {
    ok = false;
    no(path, message);
  };

  // `judge` reads the description unless told otherwise; every other kind says where it looks.
  const places: Place[] = [];
  if (raw.in === undefined && k === 'judge') places.push('description');
  else if (!Array.isArray(raw.in) || raw.in.length === 0 || raw.in.length > STANDARD_LIMITS.places) {
    bad(`${at}.in`, `"in" must be a list of 1 to ${STANDARD_LIMITS.places} places: title, description, criteria, or field:<alias or id>.`);
  } else {
    raw.in.forEach((p: unknown, i: number) => {
      const path = `${at}.in[${i}]`;
      if (typeof p !== 'string') return bad(path, 'A place must be text: title, description, criteria, or field:<alias or id>.');
      const place = p.trim();
      if (PLAIN_PLACES.includes(place)) {
        if (places.includes(place as Place)) return bad(path, `"${place}" is listed twice.`);
        return void places.push(place as Place);
      }
      if (place.startsWith('field:')) {
        const field = place.slice('field:'.length).trim();
        if (!FIELD_NAME.test(field)) return bad(path, `"${p}" must name a field: field: then an alias or id of up to 100 letters, digits, spaces, ".", "_", ":", "/" or "-".`);
        if (findSecrets(field).length > 0) return bad(path, 'A field name holds something shaped like a credential, and a standard never holds one.');
        const norm = `field:${field}` as Place;
        if (places.includes(norm)) return bad(path, `"${norm}" is listed twice.`);
        return void places.push(norm);
      }
      bad(path, `"${p}" isn't a place a rule can look: title, description, criteria, or field:<alias or id>.`);
    });
  }

  switch (k) {
    case 'pattern': {
      let flags = '';
      if (raw.flags !== undefined) {
        if (typeof raw.flags !== 'string' || !/^[ims]{0,3}$/.test(raw.flags) || new Set(raw.flags).size !== raw.flags.length) bad(`${at}.flags`, '"flags" may hold only i (any case), m (^ and $ at each line) and s (. matches a line break), each once.');
        else flags = raw.flags;
      }
      const match: string[] = [];
      if (!Array.isArray(raw.match) || raw.match.length === 0 || raw.match.length > STANDARD_LIMITS.patterns) {
        bad(`${at}.match`, `"match" must be a list of 1 to ${STANDARD_LIMITS.patterns} regular expressions, every one of which must be found.`);
      } else {
        raw.match.forEach((m: unknown, i: number) => {
          const path = `${at}.match[${i}]`;
          if (typeof m !== 'string' || m.length === 0) return bad(path, 'A pattern must be a regular expression, as text.');
          if (m.length > STANDARD_LIMITS.patternLength) return bad(path, `A pattern is ${m.length} characters; the most is ${STANDARD_LIMITS.patternLength}.`);
          if (isControl(m)) return bad(path, 'A pattern must be one line, with no line breaks or control characters; write \\n for a line break.');
          if (findSecrets(m).length > 0) return bad(path, 'A pattern holds something shaped like a credential, and a standard never holds one.');
          const unsafe = patternProblem(m);
          if (unsafe) return bad(path, `The pattern ${unsafe}`);
          try {
            new RegExp(m, flags);
          } catch (err) {
            return bad(path, `The pattern doesn't compile: ${(err as Error).message}.`);
          }
          match.push(m);
        });
      }
      // Plain names for the patterns, one each, so a reason can say "Missing a Then line" to someone who doesn't read regex.
      let labels: string[] | undefined;
      if (raw.labels !== undefined) {
        if (!Array.isArray(raw.labels) || !Array.isArray(raw.match) || raw.labels.length !== raw.match.length) {
          bad(`${at}.labels`, `"labels" must be a list with one plain name per pattern in "match", in the same order, e.g. "a Given line".`);
        } else {
          labels = [];
          raw.labels.forEach((l: unknown, i: number) => {
            const why = textProblem(l, 1, STANDARD_LIMITS.labelLength);
            if (why) bad(`${at}.labels[${i}]`, `A label ${why}`);
            else labels!.push((l as string).trim());
          });
        }
      }
      return ok ? { kind: 'pattern', in: places, match, flags, ...(labels ? { labels } : {}) } : undefined;
    }
    case 'section': {
      const heading: string[] = [];
      if (!Array.isArray(raw.heading) || raw.heading.length === 0 || raw.heading.length > STANDARD_LIMITS.headings) {
        bad(`${at}.heading`, `"heading" must be a list of 1 to ${STANDARD_LIMITS.headings} headings, any one of which may start the section.`);
      } else {
        raw.heading.forEach((h: unknown, i: number) => {
          const why = textProblem(h, 1, STANDARD_LIMITS.headingLength);
          if (why) bad(`${at}.heading[${i}]`, `A heading ${why}`);
          else heading.push((h as string).trim());
        });
      }
      let minWords = 1;
      if (raw.minWords !== undefined) {
        if (typeof raw.minWords === 'number' && Number.isInteger(raw.minWords) && raw.minWords >= 1 && raw.minWords <= STANDARD_LIMITS.minWords) minWords = raw.minWords;
        else bad(`${at}.minWords`, `"minWords" must be a whole number from 1 to ${STANDARD_LIMITS.minWords}.`);
      }
      return ok ? { kind: 'section', in: places, heading, minWords } : undefined;
    }
    case 'words': {
      const min = raw.min;
      if (typeof min !== 'number' || !Number.isInteger(min) || min < 1 || min > STANDARD_LIMITS.words) {
        bad(`${at}.min`, `"min" must be a whole number of words from 1 to ${STANDARD_LIMITS.words}.`);
        return undefined;
      }
      return ok ? { kind: 'words', in: places, min } : undefined;
    }
    case 'field':
      return ok ? { kind: 'field', in: places } : undefined;
    case 'judge':
      return ok ? { kind: 'judge', in: places } : undefined;
  }
}

/** The file's text: a stable key order, two-space JSON, a trailing line feed. */
export function standardContent(standard: Standard): string {
  return `${JSON.stringify(standard, null, 2)}\n`;
}
