import { describe, expect, it } from 'vitest';
import { files } from '../../../test/fixtures/util.fixture.js';
import { runCli } from '../../../test/harness/cli.js';
import { testContext } from '../../../test/harness/context.js';
import type { Warning } from '../../core/envelope.js';
import { execute } from '../../core/run.js';
import { grammarFor, type AnyGrammar } from '../../core/versions.js';
import { commands } from './index.js';
import { Verifier } from './kit/verify.js';
import { checkNormalized, checkRange, PAIRWISE_LIMIT, sortEntries, type Entry } from './semver-run.js';
import { semverBumpCommand, semverCompareCommand, semverSatisfiesCommand, semverSortCommand } from './semver.js';

/**
 * `util semver` end to end, and its self-checks bitten: each check is fed a
 * grammar broken on purpose and has to catch it. A comparison that
 * disagrees with itself is otherwise very hard to spot, which is how most of
 * them get through review.
 */

const ctx = () => testContext({ files }).context;
const run = async (def: Parameters<typeof execute>[0], input: Record<string, unknown>) => execute(def, input, ctx());

const verifier = () => {
  const warnings: Warning[] = [];
  return { v: new Verifier((w) => warnings.push(w)), warnings };
};

const entries = (...values: string[]): Entry[] => values.map((value, i) => ({ value, line: i + 1 }));

describe('util semver compare', () => {
  it('orders two npm versions by SemVer 2.0.0, names the part they differ in, and passes its checks', async () => {
    const envelope = await run(semverCompareCommand, { a: '1.0.0-rc.10', b: '1.0.0-rc.9' });
    expect(envelope.data).toMatchObject({ ecosystem: 'npm', order: 1, higher: 'a', difference: 'prerelease', normalized: { a: '1.0.0-rc.10', b: '1.0.0-rc.9' }, verified: { passed: true } });
  });

  it('reads Maven and NuGet versions in their own grammars', async () => {
    expect((await run(semverCompareCommand, { a: '2.17.1', b: '2.17.1.Final', ecosystem: 'maven' })).data).toMatchObject({ order: 0, higher: null, difference: null, normalized: { a: '2.17.1', b: '2.17.1' } });
    expect((await run(semverCompareCommand, { a: '1.0.0-Beta', b: '1.0.0-beta', ecosystem: 'nuget' })).data).toMatchObject({ order: 0 });
    expect((await run(semverCompareCommand, { a: '1-SNAPSHOT', b: '1', ecosystem: 'maven' })).data).toMatchObject({ order: -1, difference: 'qualifier' });
  });

  it('reports a version that does not parse, with why and a fix, and never coerces it', async () => {
    const envelope = await run(semverCompareCommand, { a: '1.2', b: '1.2.0' });
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('Version a, "1.2" is not an npm version') });
    expect(envelope.error?.fix).toContain('--ecosystem nuget');
    expect((await run(semverCompareCommand, { a: '${project.version}', b: '1.0', ecosystem: 'maven' })).error?.code).toBe('INVALID_INPUT');
  });
});

describe('util semver satisfies', () => {
  it('leaves prereleases out of an npm range unless asked, and says how it normalised the range', async () => {
    expect((await run(semverSatisfiesCommand, { version: '1.3.0-rc.1', range: '^1.2.0' })).data).toMatchObject({ satisfies: false, normalizedRange: '>=1.2.0 <2.0.0-0', verified: { passed: true } });
    expect((await run(semverSatisfiesCommand, { version: '1.3.0-rc.1', range: '^1.2.0', includePrerelease: true })).data).toMatchObject({ satisfies: true, normalizedRange: '>=1.2.0 <2.0.0-0' });
  });

  it('reads NuGet and Maven interval notation', async () => {
    expect((await run(semverSatisfiesCommand, { version: '14.0.0', range: '[12.0.1,14.0)', ecosystem: 'nuget' })).data).toMatchObject({ satisfies: false, normalizedRange: '[12.0.1, 14.0.0)' });
    expect((await run(semverSatisfiesCommand, { version: '1.1', range: '(,1.0],[1.2,)', ecosystem: 'maven' })).data).toMatchObject({ satisfies: false });
  });

  it('warns that a bare Maven version is a soft requirement that any version satisfies', async () => {
    const envelope = await run(semverSatisfiesCommand, { version: '9.0', range: '1.0', ecosystem: 'maven' });
    expect(envelope.data).toMatchObject({ satisfies: true });
    expect(envelope.meta.warnings?.map((w) => w.code)).toEqual(expect.arrayContaining(['MAVEN_SOFT_REQUIREMENT', 'UNVERIFIED']));
  });

  it('refuses a range that does not parse, a NuGet floating version, and includePrerelease outside npm', async () => {
    expect((await run(semverSatisfiesCommand, { version: '1.0.0', range: '>=1.x.5' })).error?.code).toBe('INVALID_INPUT');
    expect((await run(semverSatisfiesCommand, { version: '1.0.0', range: '1.*', ecosystem: 'nuget' })).error?.message).toContain('interval notation');
    expect((await run(semverSatisfiesCommand, { version: '1.0', range: '[1.0,)', ecosystem: 'maven', includePrerelease: true })).error?.message).toContain('npm ranges only');
  });
});

describe('util semver sort', () => {
  it('sorts the sample npm list, reports what is not a version, and finds the highest in a range', async () => {
    const envelope = await run(semverSortCommand, { inputFile: 'versions/npm.txt', range: '^5.0.0' });
    expect(envelope.data).toMatchObject({
      sorted: ['4.9.5', '5.0.4', '5.3.3', '5.4.0-beta', '5.4.1-rc', '5.4.2', '5.4.5', '5.5.0-dev.20240308'],
      invalid: [
        { value: 'latest', line: 5, reason: expect.any(String) },
        { value: '5.4', line: 9, reason: expect.any(String) },
      ],
      satisfying: ['5.0.4', '5.3.3', '5.4.2', '5.4.5'],
      highest: '5.4.5',
      verified: { passed: true },
    });
    expect(envelope.meta.warnings?.[0]).toMatchObject({ code: 'SEMVER_INVALID_VERSION', message: expect.stringContaining('2 of 10 entries') });
    const checks = (envelope.data as { verified: { checks: { check: string; status: string }[] } }).verified.checks;
    expect(Object.fromEntries(checks.map((c) => [c.check, c.status]))).toEqual({
      'input.complete': 'passed',
      'sort.complete': 'passed',
      'sort.transitive': 'passed',
      'sort.antisymmetric': 'passed',
      'range.boundaries': 'passed',
      'range.answers': 'passed',
    });
  });

  it('sorts NuGet and Maven lists in their own order', async () => {
    expect((await run(semverSortCommand, { inputFile: 'versions/nuget.txt', ecosystem: 'nuget', range: '[12.0,13.0)' })).data).toMatchObject({
      sorted: ['9.0.1', '10.0.3', '11.0.2', '12.0.1', '12.0.2', '12.0.3', '13.0.1-beta1', '13.0.1', '13.0.2', '13.0.3'],
      highest: '12.0.3',
    });
    expect((await run(semverSortCommand, { text: '1.0 1.0-SNAPSHOT 1.0-rc1 1.0-sp1 1.0-alpha2 1.0.1', ecosystem: 'maven' })).data).toMatchObject({
      sorted: ['1.0-alpha2', '1.0-rc1', '1.0-SNAPSHOT', '1.0', '1.0-sp1', '1.0.1'],
    });
  });

  it('lists a deeply nested Maven version in data.invalid instead of overflowing the stack', async () => {
    // 40,001 characters: one line (under the 64 KiB line cut), and tens of thousands of nested lists if it were parsed.
    const deep = `1${'a1'.repeat(20000)}`;
    const envelope = await run(semverSortCommand, { text: `2.0\n${deep}\n1.0`, ecosystem: 'maven' });
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toMatchObject({ sorted: ['1.0', '2.0'], invalid: [{ line: 2, reason: 'longer than 256 characters' }], verified: { passed: true } });
  });

  it('refuses an empty list, and includePrerelease with no range', async () => {
    expect((await run(semverSortCommand, { text: '  \n ' })).error?.message).toContain('No versions');
    expect((await run(semverSortCommand, { text: '1.0.0', includePrerelease: true })).error?.message).toContain('no range');
  });
});

describe('util semver bump', () => {
  it("bumps as npm version does, and checks the result is higher", async () => {
    expect((await run(semverBumpCommand, { version: '1.2.3', release: 'prerelease', preid: 'rc' })).data).toMatchObject({ result: '1.2.4-rc.0', verified: { passed: true } });
    expect((await run(semverBumpCommand, { version: '1.2.4-rc.0', release: 'prerelease', preid: 'rc' })).data).toMatchObject({ result: '1.2.4-rc.1' });
    expect((await run(semverBumpCommand, { version: '3.1.1.5-beta', release: 'major', ecosystem: 'nuget' })).data).toMatchObject({ result: '4.0.0' });
  });

  it('refuses a release the ecosystem has no rule for, and a preid on a plain bump', async () => {
    expect((await run(semverBumpCommand, { version: '1.0', release: 'prerelease', ecosystem: 'maven' })).error?.message).toContain('use major, minor, patch');
    expect((await run(semverBumpCommand, { version: '1.2.3', release: 'minor', preid: 'rc' })).error?.code).toBe('INVALID_INPUT');
    expect((await run(semverBumpCommand, { version: '1.2.3', release: 'release' })).error?.message).toContain('not a prerelease');
  });
});

describe('the self-checks catch a broken result', async () => {
  const npm = await grammarFor('npm');

  it('sort.transitive catches a comparison that goes round in a circle', () => {
    // Rock, paper, scissors: each beats the next, so no order is consistent.
    const rank: Record<string, number> = { '1.0.0': 0, '2.0.0': 1, '3.0.0': 2 };
    const circular: AnyGrammar = { ...npm, compare: (a, b) => {
      const d = (rank[npm.format(a)]! - rank[npm.format(b)]! + 3) % 3;
      return d === 0 ? 0 : d === 1 ? 1 : -1;
    } };
    const { v, warnings } = verifier();
    sortEntries(circular, entries('3.0.0', '1.0.0', '2.0.0'), v);
    const verified = v.done();
    expect(verified.passed).toBe(false);
    expect(verified.checks.find((c) => c.check === 'sort.transitive')).toMatchObject({ status: 'failed', failed: 1 });
    expect(warnings[0]).toMatchObject({ code: 'SEMVER_SORT_INCONSISTENT' });
  });

  it('sort.antisymmetric catches a comparison that says a < b and b < a', () => {
    const { v } = verifier();
    sortEntries({ ...npm, compare: (a, b) => (npm.compare(a, b) === 0 ? 0 : -1) }, entries('1.0.0', '2.0.0'), v);
    expect(v.done().checks.find((c) => c.check === 'sort.antisymmetric')?.status).toBe('failed');
  });

  it('sort.transitive checks every pair up to the limit, and says when it checked neighbours only', () => {
    const many = entries(...Array.from({ length: PAIRWISE_LIMIT + 1 }, (_, i) => `1.0.${i}`));
    const { v, warnings } = verifier();
    sortEntries(npm, many, v);
    const check = v.done().checks.find((c) => c.check === 'sort.transitive');
    expect(check).toMatchObject({ status: 'approximated', checked: PAIRWISE_LIMIT });
    expect(warnings[0]).toMatchObject({ code: 'APPROXIMATED' });
  });

  it('range.boundaries and range.answers catch a satisfies that is off by one at a bound', () => {
    // A satisfies that forgets an upper bound is exclusive.
    const broken: AnyGrammar = { ...npm, satisfies: (range, version, options) => npm.satisfies(range, version, options) || npm.format(version) === '2.0.0-0' || npm.format(version) === '2.0.0' };
    const parsed = npm.parseRange('^1.2.3', {});
    if (!parsed.ok) throw new Error('range');
    const two = npm.parse('2.0.0');
    if (!two.ok) throw new Error('version');
    const { v, warnings } = verifier();
    checkRange(broken, v, parsed.value, [two.value], {});
    const checks = v.done().checks;
    expect(checks.find((c) => c.check === 'range.boundaries')).toMatchObject({ status: 'failed', failures: [{ at: 'boundary 2.0.0-0', expected: false, actual: true }] });
    expect(checks.find((c) => c.check === 'range.answers')).toMatchObject({ status: 'failed', failures: [{ at: '2.0.0', expected: false, actual: true }] });
    expect(warnings[0]).toMatchObject({ code: 'SEMVER_RANGE_MISMATCH' });
  });

  it('version.normalized catches a normalised form that reads back as another version', () => {
    const v1 = npm.parse('1.2.3');
    if (!v1.ok) throw new Error('version');
    const { v } = verifier();
    checkNormalized({ ...npm, format: () => '1.2.4' }, v, v1.value, 'a');
    expect(v.done().checks[0]).toMatchObject({ check: 'version.normalized', status: 'failed' });
  });

  it('bump.increases catches a bump that goes nowhere', async () => {
    const broken = { ...npm, bump: (version: unknown) => ({ ok: true as const, value: version }) };
    const npmModule = await import('../../core/versions/npm.js');
    const original = npmModule.npmGrammar.bump;
    Object.assign(npmModule.npmGrammar, { bump: broken.bump });
    try {
      const envelope = await run(semverBumpCommand, { version: '1.2.3', release: 'patch' });
      expect(envelope.data).toMatchObject({ result: '1.2.3', verified: { passed: false } });
      expect(envelope.meta.warnings?.[0]).toMatchObject({ code: 'SEMVER_BUMP_MISMATCH' });
    } finally {
      Object.assign(npmModule.npmGrammar, { bump: original });
    }
  });
});

describe('util semver on the CLI', () => {
  it('takes positionals and flags, and reads the list from stdin', async () => {
    const compare = await runCli(['util', 'semver', 'compare', '1.2.3', '1.10.0', '--ecosystem', 'nuget'], { commands, context: ctx() });
    expect(compare.envelope?.data).toMatchObject({ ecosystem: 'nuget', order: -1, difference: 'minor' });
    const sort = await runCli(['util', 'semver', 'sort', '--input-file', '-', '--range', '~1.2'], { commands, context: testContext({ stdin: '1.2.9\n1.3.0\r\n1.2.0\n' }).context });
    expect(sort.envelope?.data).toMatchObject({ sorted: ['1.2.0', '1.2.9', '1.3.0'], highest: '1.2.9' });
    // stdin has no size to compare the bytes read with, and says so.
    expect(sort.envelope?.meta.warnings?.map((w) => w.code)).toEqual(['UNVERIFIED']);
  });
});
