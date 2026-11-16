import { z } from 'zod';
import { defineCommand } from '../../core/command.js';
import { ECOSYSTEMS } from '../../core/versions.js';
import { fileArgument, inputFields, inputFileOption, textOption } from './kit/input.js';
import * as work from './semver-run.js';

/**
 * `util semver compare | satisfies | sort | bump`: versions and ranges in
 * the grammar of the ecosystem they come from, npm, NuGet or Maven. Local
 * only, no connection. The work and its self-checks are in ./semver-run.ts,
 * imported statically: it reads input through kit/input.ts, which imports
 * zod, and a lazily loaded module that imports zod breaks the bundle (#188).
 * The grammars, which import nothing of the kind, load only when a command
 * runs (grammarFor in src/core/versions.ts), since a version comparison
 * should not hold up the queue for anything else.
 */

const ECOSYSTEM = 'The version grammar: npm (SemVer 2.0.0 and npm ranges, the default), nuget or maven';
const INCLUDE_PRERELEASE = 'npm only: let a range match prereleases of any version, not only those of a version the range names';

const ecosystemField = { ecosystem: z.enum(ECOSYSTEMS).optional().describe(ECOSYSTEM) };
const ecosystemOption = { flags: '--ecosystem <ecosystem>', field: 'ecosystem', description: ECOSYSTEM };
const includePrereleaseOption = { flags: '--include-prerelease', field: 'includePrerelease', description: INCLUDE_PRERELEASE };

const VERIFIED = 'verified { passed, checks[] } says what was checked';

export const semverCompareCommand = defineCommand({
  path: ['util', 'semver', 'compare'],
  description: 'Compare two versions and name the part they differ in (local only, no network)',
  toolDescription: `Compares two versions in the chosen ecosystem's grammar (npm, the default; nuget; maven). Returns { ecosystem, a, b, order: -1 | 0 | 1 (a against b), higher: "a" | "b" | null, difference: major | minor | patch | revision | prerelease | qualifier | null, normalized { a, b }, ${VERIFIED} }. Build metadata never counts. A version that doesn't parse in that grammar is an INVALID_INPUT error naming why, never coerced. Local only.`,
  input: z.object({
    a: z.string().describe('The first version'),
    b: z.string().describe('The second version'),
    ...ecosystemField,
  }),
  writes: false,
  args: [
    { name: 'a', field: 'a', description: 'The first version' },
    { name: 'b', field: 'b', description: 'The second version' },
  ],
  options: [ecosystemOption],
  examples: [{ a: '1.2.3', b: '1.10.0-rc.1' }, { a: '2.17.1', b: '2.17.1.Final', ecosystem: 'maven' }, { a: '13.0.1', b: '13.0.1.0-Beta1', ecosystem: 'nuget' }],
  run: (input, ctx) => work.compare({ ...input, ecosystem: input.ecosystem ?? 'npm' }, ctx),
});

export const semverSatisfiesCommand = defineCommand({
  path: ['util', 'semver', 'satisfies'],
  description: 'Check whether a version satisfies a range (local only, no network)',
  toolDescription: `Whether a version satisfies a range, in the chosen ecosystem's grammar: npm ranges (^1.2.3, ~1.2, 1.x, >=1 <2, 1 - 2, ||), NuGet interval notation (1.0, [1.0,2.0), (,2.0]) or Maven ranges ([1.0,2.0), (,1.0],[1.2,); a bare Maven version is a soft requirement any version satisfies, and says so in meta.warnings). Returns { ecosystem, version, range, normalizedRange, satisfies, ${VERIFIED} }: the answer is cross-checked against the range's intervals at its boundary versions. npm leaves prereleases out unless the range names one of the same major.minor.patch, or includePrerelease is set. NuGet floating versions (1.*) are refused. Local only.`,
  input: z.object({
    version: z.string().describe('The version to check'),
    range: z.string().describe('The range to check it against'),
    ...ecosystemField,
    includePrerelease: z.boolean().optional().describe(INCLUDE_PRERELEASE),
  }),
  writes: false,
  args: [
    { name: 'version', field: 'version', description: 'The version to check' },
    { name: 'range', field: 'range', description: 'The range to check it against' },
  ],
  options: [ecosystemOption, includePrereleaseOption],
  examples: [
    { version: '1.3.0-rc.1', range: '^1.2.0' },
    { version: '1.3.0-rc.1', range: '^1.2.0', includePrerelease: true },
    { version: '13.0.3', range: '[12.0.1,14.0)', ecosystem: 'nuget' },
    { version: '5.3.39', range: '[5.0,6.0)', ecosystem: 'maven' },
  ],
  run: (input, ctx) => work.satisfies({ ...input, ecosystem: input.ecosystem ?? 'npm' }, ctx),
});

export const semverSortCommand = defineCommand({
  path: ['util', 'semver', 'sort'],
  description: 'Sort versions, and find the highest that satisfies a range (local only, no network)',
  toolDescription: `Sorts a list of versions (one per line or separated by spaces, from inputFile or text) lowest first, in the chosen ecosystem's grammar (npm, the default; nuget; maven). Returns { ecosystem, count, sorted[], invalid[] of { value, line, reason }, ${VERIFIED} }; with range, also { range, normalizedRange, satisfying[], highest }. An entry that doesn't parse is listed in invalid and warned about, never coerced. The sort is checked pair by pair for consistency (up to 2,000 versions; neighbours only past that), and each range answer against the range's intervals. Local only.`,
  input: z.object({
    ...inputFields,
    ...ecosystemField,
    range: z.string().optional().describe('Also list the versions that satisfy this range, and the highest of them'),
    includePrerelease: z.boolean().optional().describe(`${INCLUDE_PRERELEASE}. Needs range`),
  }),
  writes: false,
  args: [fileArgument],
  options: [inputFileOption, textOption, ecosystemOption, { flags: '--range <range>', field: 'range', description: 'Also list the versions that satisfy this range, and the highest of them' }, includePrereleaseOption],
  examples: [
    { inputFile: 'versions/npm.txt' },
    { inputFile: 'versions/npm.txt', range: '^5.0.0' },
    { inputFile: 'versions/npm.txt', range: '>=5.4.0', includePrerelease: true },
    { inputFile: 'versions/nuget.txt', ecosystem: 'nuget', range: '[12.0,13.0)' },
    { text: '2.17.1 2.14.1 2.17.0-rc1 2.0-beta9 2.17.1.Final 2.17.2-SNAPSHOT', ecosystem: 'maven' },
  ],
  run: (input, ctx) => work.sort({ ...input, ecosystem: input.ecosystem ?? 'npm' }, ctx),
});

const RELEASE = 'major, minor or patch; npm also takes premajor, preminor, prepatch, prerelease and release';

export const semverBumpCommand = defineCommand({
  path: ['util', 'semver', 'bump'],
  description: 'Bump a version: the next major, minor, patch or prerelease (local only, no network)',
  toolDescription: `The next version: major, minor or patch in every ecosystem, and premajor, preminor, prepatch, prerelease (with an optional preid such as rc) and release for npm, the bumps npm publishes with. NuGet results are three-part with the revision and labels dropped; Maven bumps the leading numbers and drops the qualifier. Returns { ecosystem, version, release, preid?, result, ${VERIFIED} }: the result is checked to be higher than the version. Local only.`,
  input: z.object({
    version: z.string().describe('The version to bump'),
    release: z.string().describe(RELEASE),
    ...ecosystemField,
    preid: z.string().optional().describe('npm prerelease bumps: the prerelease identifier, such as rc or beta'),
  }),
  writes: false,
  args: [
    { name: 'version', field: 'version', description: 'The version to bump' },
    { name: 'release', field: 'release', description: RELEASE },
  ],
  options: [ecosystemOption, { flags: '--preid <id>', field: 'preid', description: 'npm prerelease bumps: the prerelease identifier, such as rc or beta' }],
  examples: [
    { version: '1.2.3', release: 'minor' },
    { version: '1.2.3', release: 'prerelease', preid: 'rc' },
    { version: '3.1.1', release: 'major', ecosystem: 'nuget' },
  ],
  run: (input, ctx) => work.bump({ ...input, ecosystem: input.ecosystem ?? 'npm' }, ctx),
});

export const semverCommands = [semverCompareCommand, semverSatisfiesCommand, semverSortCommand, semverBumpCommand];
