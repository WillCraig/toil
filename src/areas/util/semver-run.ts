import type { CommandContext } from '../../core/context.js';
import { ToilError } from '../../core/errors.js';
import { grammarFor, type AnyGrammar, type RangeOptions, type Release, type VersionEcosystem } from '../../core/versions.js';
import { sign } from '../../core/versions/shared.js';
import { openInput } from './kit/input.js';
import { Verifier } from './kit/verify.js';

/**
 * The work behind `util semver compare | satisfies | sort | bump`. The
 * grammars are core's (src/core/versions/), loaded on first use; this
 * module reads the input, refuses what doesn't parse, and checks its own
 * answers:
 *
 * - a sort is checked pair by pair across the whole result, so a comparison
 *   that isn't transitive (a < b, b < c, but c < a) can't go unnoticed;
 * - a range answer is checked against the range's intervals, worked out by
 *   comparison alone, at the range's boundary versions and at every version
 *   asked about;
 * - a normalised version is parsed again and compared with the original.
 *
 * Nothing that fails to parse is coerced into a version. It is reported,
 * with the reason, which is the only form of version control that requires
 * no approval.
 */

type Ctx = CommandContext<unknown, Record<string, string | undefined>>;

const NAMES: Record<VersionEcosystem, string> = { npm: 'npm', nuget: 'NuGet', maven: 'Maven' };
/** The name with its article, for 'is not an npm version'. */
const A: Record<VersionEcosystem, string> = { npm: 'an npm', nuget: 'a NuGet', maven: 'a Maven' };

const VERSION_FIX: Record<VersionEcosystem, string> = {
  npm: 'An npm version is SemVer 2.0.0: major.minor.patch, then an optional -prerelease and +build, as 1.2.3 or 1.2.3-rc.1. For NuGet or Maven versions, pass --ecosystem nuget or --ecosystem maven.',
  nuget: 'A NuGet version is one to four numbers, then an optional -prerelease and +metadata, as 1.2, 1.2.3.4 or 1.2.3-beta.1.',
  maven: 'A Maven version is letters, digits, ".", "-", "_" and "+" with at least one digit, as 1.2.3, 1.0-SNAPSHOT or 2.0.0.Final. Resolve any ${property} first.',
};

const RANGE_FIX: Record<VersionEcosystem, string> = {
  npm: 'An npm range is what package.json takes: ^1.2.3, ~1.2, 1.x, >=1.0.0 <2.0.0, 1.0.0 - 2.0.0, joined with ||.',
  nuget: 'A NuGet range is interval notation: 1.0 (at least 1.0), [1.0], [1.0,2.0), (,2.0] and the like.',
  maven: 'A Maven range is [1.0,2.0), [1.0], (,1.0],[1.2,) and the like; a bare version is a soft requirement.',
};

/** What `util semver` hands every grammar call: the ecosystem and its options. */
export interface SemverOptions {
  ecosystem: VersionEcosystem;
  includePrerelease?: boolean | undefined;
}

function rangeOptions(o: SemverOptions): RangeOptions {
  if (o.includePrerelease && o.ecosystem !== 'npm') {
    throw new ToilError('INVALID_INPUT', `includePrerelease applies to npm ranges only: ${A[o.ecosystem]} range already includes the prereleases inside its bounds.`, { fix: 'Drop --include-prerelease, or pass --ecosystem npm.' });
  }
  return o.includePrerelease ? { includePrerelease: true } : {};
}

function parseVersion(g: AnyGrammar, text: string, what: string): unknown {
  const parsed = g.parse(text);
  if (!parsed.ok) throw new ToilError('INVALID_INPUT', `${what} "${text}" is not ${A[g.ecosystem]} version: ${parsed.reason}.`, { fix: VERSION_FIX[g.ecosystem] });
  return parsed.value;
}

function parseRange(g: AnyGrammar, text: string, options: RangeOptions): unknown {
  const parsed = g.parseRange(text, options);
  if (!parsed.ok) throw new ToilError('INVALID_INPUT', `"${text}" is not ${A[g.ecosystem]} range: ${parsed.reason}.`, { fix: RANGE_FIX[g.ecosystem] });
  return parsed.value;
}

/** That the normalised form of `value` reads back as the same version. */
export function checkNormalized(g: AnyGrammar, v: Verifier, value: unknown, at: string): void {
  const text = g.format(value);
  const again = g.parse(text);
  if (!again.ok) {
    // Maven reduces 0-alpha to "alpha", which isn't a version on its own.
    v.unchecked('version.normalized', `the normalised form of ${at}, "${text}", isn't a version on its own`);
    return;
  }
  v.expect('version.normalized', g.compare(again.value, value) === 0, { at, expected: text, actual: g.format(again.value) }, { code: 'SEMVER_NORMALIZED_MISMATCH' });
}

/**
 * That every answer `satisfies` gives agrees with the range's intervals,
 * tested at each boundary version of the range and at each version asked
 * about. A range with no bounds at all (`*`, a Maven soft requirement) has no
 * boundary to test, and says so.
 */
export function checkRange(g: AnyGrammar, v: Verifier, range: unknown, versions: unknown[], options: RangeOptions): void {
  const intervals = g.intervals(range);
  const inIntervals = (version: unknown) => intervals.some((i) => g.inInterval(i, version, options));
  const boundaries = new Map<string, unknown>();
  for (const i of intervals) for (const bound of [i.lower, i.upper]) if (bound) boundaries.set(g.format(bound.version), bound.version);
  if (boundaries.size === 0) v.unchecked('range.boundaries', 'the range has no lower or upper bound to test');
  for (const [text, version] of boundaries) {
    const expected = inIntervals(version);
    const actual = g.satisfies(range, version, options);
    v.expect('range.boundaries', actual === expected, { at: `boundary ${text}`, expected, actual }, { code: 'SEMVER_RANGE_MISMATCH' });
  }
  for (const version of versions) {
    const expected = inIntervals(version);
    const actual = g.satisfies(range, version, options);
    v.expect('range.answers', actual === expected, { at: g.format(version), expected, actual }, { code: 'SEMVER_RANGE_MISMATCH' });
  }
}

/** A Maven bare version is a soft requirement: it says so rather than let "1.0" look like "exactly 1.0". */
function warnSoft(g: AnyGrammar, range: unknown, ctx: Ctx) {
  if (g.ecosystem === 'maven' && (range as { recommended?: unknown }).recommended !== undefined) {
    ctx.warn({ code: 'MAVEN_SOFT_REQUIREMENT', message: 'Maven reads a bare version as a soft requirement, which any version satisfies. For exactly that version, write it as [1.0].' });
  }
}

export async function compare(input: SemverOptions & { a: string; b: string }, ctx: Ctx) {
  const g = await grammarFor(input.ecosystem);
  const a = parseVersion(g, input.a, 'Version a,');
  const b = parseVersion(g, input.b, 'Version b,');
  const v = new Verifier(ctx.warn);
  const order = sign(g.compare(a, b));
  const reverse = sign(g.compare(b, a));
  v.expect('compare.antisymmetric', reverse === -order, { at: `${input.b} against ${input.a}`, expected: -order, actual: reverse }, { code: 'SEMVER_COMPARE_INCONSISTENT' });
  const difference = g.diff(a, b);
  v.expect('diff.consistent', (difference === null) === (order === 0), { at: `${input.a} and ${input.b}`, expected: order === 0 ? null : 'a difference', actual: difference }, { code: 'SEMVER_COMPARE_INCONSISTENT' });
  checkNormalized(g, v, a, 'a');
  checkNormalized(g, v, b, 'b');
  return {
    ecosystem: input.ecosystem,
    a: input.a,
    b: input.b,
    order,
    higher: order > 0 ? 'a' : order < 0 ? 'b' : null,
    difference,
    normalized: { a: g.format(a), b: g.format(b) },
    verified: v.done(),
  };
}

export async function satisfies(input: SemverOptions & { version: string; range: string }, ctx: Ctx) {
  const options = rangeOptions(input);
  const g = await grammarFor(input.ecosystem);
  const version = parseVersion(g, input.version, 'The version');
  const range = parseRange(g, input.range, options);
  warnSoft(g, range, ctx);
  const v = new Verifier(ctx.warn);
  const answer = g.satisfies(range, version, options);
  checkRange(g, v, range, [version], options);
  checkNormalized(g, v, version, 'the version');
  return { ecosystem: input.ecosystem, version: input.version, range: input.range, normalizedRange: g.formatRange(range), satisfies: answer, verified: v.done() };
}

/** One whitespace-separated entry of the list to sort, and the line it came from. */
export interface Entry {
  value: string;
  line: number;
}

export interface Invalid extends Entry {
  reason: string;
}

/** Every pair is checked up to this many versions; past it, neighbours only. */
export const PAIRWISE_LIMIT = 2000;

/**
 * Sorts the entries that parse, lowest first (equal versions keep their
 * order), and checks the result: every pair in order (which is transitivity
 * across the input, since a < b < c sorted means a before c), each
 * neighbouring pair compared both ways round, and nothing lost.
 */
export function sortEntries(g: AnyGrammar, entries: Entry[], v: Verifier): { sorted: { entry: Entry; version: unknown }[]; invalid: Invalid[] } {
  const valid: { entry: Entry; version: unknown }[] = [];
  const invalid: Invalid[] = [];
  for (const entry of entries) {
    const parsed = g.parse(entry.value);
    if (parsed.ok) valid.push({ entry, version: parsed.value });
    else invalid.push({ ...entry, reason: parsed.reason });
  }
  const sorted = [...valid].sort((x, y) => g.compare(x.version, y.version));
  v.equal('sort.complete', entries.length, sorted.length + invalid.length, { code: 'SEMVER_SORT_INCONSISTENT' });
  const show = (i: number) => `${sorted[i]!.entry.value} (line ${sorted[i]!.entry.line})`;
  const pair = (i: number, j: number) => {
    const c = g.compare(sorted[i]!.version, sorted[j]!.version);
    v.expect('sort.transitive', c <= 0, { at: `${show(i)} before ${show(j)}`, expected: 'lower or equal', actual: 'higher' }, { code: 'SEMVER_SORT_INCONSISTENT' });
  };
  if (sorted.length <= PAIRWISE_LIMIT) {
    for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) pair(i, j);
  } else {
    for (let i = 0; i + 1 < sorted.length; i++) pair(i, i + 1);
    v.approximated('sort.transitive', `more than ${PAIRWISE_LIMIT} versions, so each was checked against its neighbour rather than every other one`);
  }
  for (let i = 0; i + 1 < sorted.length; i++) {
    const forward = sign(g.compare(sorted[i]!.version, sorted[i + 1]!.version));
    const back = sign(g.compare(sorted[i + 1]!.version, sorted[i]!.version));
    v.expect('sort.antisymmetric', back === -forward, { at: `${show(i)} and ${show(i + 1)}`, expected: -forward, actual: back }, { code: 'SEMVER_SORT_INCONSISTENT' });
  }
  return { sorted, invalid };
}

export async function sort(input: SemverOptions & { inputFile?: string | undefined; text?: string | undefined; range?: string | undefined }, ctx: Ctx) {
  const options = rangeOptions(input);
  if (input.includePrerelease && input.range === undefined) {
    throw new ToilError('INVALID_INPUT', 'includePrerelease changes what a range matches, and no range was given.', { fix: 'Pass --range too, or drop --include-prerelease.' });
  }
  const g = await grammarFor(input.ecosystem);
  const range = input.range === undefined ? undefined : parseRange(g, input.range, options);
  if (range !== undefined) warnSoft(g, range, ctx);
  const source = await openInput(ctx, input);
  const entries: Entry[] = [];
  const cut: Invalid[] = [];
  for await (const line of source.lines()) {
    if (line.cut) {
      cut.push({ value: `${line.text.slice(0, 40)}…`, line: line.number, reason: 'the line is longer than 64 KiB, so it was not read' });
      continue;
    }
    for (const value of line.text.split(/\s+/)) if (value) entries.push({ value, line: line.number });
  }
  if (entries.length === 0 && cut.length === 0) {
    throw new ToilError('INVALID_INPUT', `No versions in ${source.label}.`, { fix: 'List the versions one per line, or separated by spaces.' });
  }
  const v = new Verifier(ctx.warn);
  v.inputComplete(source);
  const { sorted, invalid: unparsed } = sortEntries(g, entries, v);
  const invalid = [...cut, ...unparsed].sort((x, y) => x.line - y.line);
  if (invalid.length) {
    const first = invalid[0]!;
    ctx.warn({
      code: 'SEMVER_INVALID_VERSION',
      message: `${invalid.length} of ${entries.length + cut.length} entries are not ${NAMES[g.ecosystem]} versions and were left out of the sort, the first "${first.value}" on line ${first.line}: ${first.reason}. They're listed in data.invalid.`,
    });
  }
  const result = {
    ecosystem: input.ecosystem,
    count: sorted.length,
    sorted: sorted.map((s) => s.entry.value),
    invalid,
  };
  if (range === undefined) return { ...result, verified: v.done() };
  const satisfying = sorted.filter((s) => g.satisfies(range, s.version, options));
  checkRange(g, v, range, sorted.map((s) => s.version), options);
  return {
    ...result,
    range: input.range,
    normalizedRange: g.formatRange(range),
    satisfying: satisfying.map((s) => s.entry.value),
    highest: satisfying.at(-1)?.entry.value ?? null,
    verified: v.done(),
  };
}

export async function bump(input: SemverOptions & { version: string; release: string; preid?: string | undefined }, ctx: Ctx) {
  const g = await grammarFor(input.ecosystem);
  const release = input.release as Release;
  if (!g.releases.includes(release)) {
    throw new ToilError('INVALID_INPUT', `"${input.release}" is not ${A[g.ecosystem]} release to bump: use ${g.releases.join(', ')}.`, {
      fix: g.ecosystem === 'npm' ? 'Pass one of the releases listed.' : 'Prerelease bumps are npm only (--ecosystem npm); NuGet and Maven take major, minor or patch.',
    });
  }
  if (input.preid !== undefined && !release.startsWith('pre')) {
    throw new ToilError('INVALID_INPUT', `preid names the prerelease of a premajor, preminor, prepatch or prerelease bump, and this is a ${release} bump.`, { fix: 'Drop --preid, or bump premajor, preminor, prepatch or prerelease.' });
  }
  const version = parseVersion(g, input.version, 'The version');
  const bumped = g.bump(version, release, input.preid);
  if (!bumped.ok) throw new ToilError('INVALID_INPUT', `Can't bump ${input.version} (${release}): ${bumped.reason}.`, { fix: VERSION_FIX[g.ecosystem] });
  const v = new Verifier(ctx.warn);
  const result = g.format(bumped.value);
  v.expect('bump.increases', g.compare(bumped.value, version) > 0, { at: `${input.version} to ${result}`, expected: 'higher', actual: g.compare(bumped.value, version) === 0 ? 'equal' : 'lower' }, { code: 'SEMVER_BUMP_MISMATCH' });
  checkNormalized(g, v, bumped.value, 'the result');
  return { ecosystem: input.ecosystem, version: input.version, release, ...(input.preid === undefined ? {} : { preid: input.preid }), result, verified: v.done() };
}
