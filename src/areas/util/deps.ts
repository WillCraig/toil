import { z } from 'zod';
import { defineCommand } from '../../core/command.js';
import type { CommandContext } from '../../core/context.js';
import { ToilError } from '../../core/errors.js';
import type { GitCall } from '../../core/git.js';
import { compareSemver } from '../../core/versions.js';
import { runGit } from '../git/runner.js';
import { buildScanData, scanFiles, type Ecosystem, type ReadFile, type ScanData, type ScanOptions } from './manifests.js';

/**
 * `util deps scan` and `util deps diff`: the local dependency inventory, from
 * the manifests and lockfiles in the workspace, and how it changed between
 * two git refs. No connection, no host, no network. The inventory is what the
 * vulnerability and licence sources read (`toil util deps scan | toil osv
 * vulns`); none of them scans a repository itself (principle 3).
 *
 * `scan` walks the workspace with core's `.gitignore`-aware listing and runs
 * nothing. `diff` reads files at a ref, so it runs git, through
 * src/core/git.ts like every git-backed command. `deps scan` and
 * `deps diff` paths stay as aliases. Neither command decides anything about
 * the dependencies it finds; that is a separate committee.
 */

type Ctx = CommandContext<unknown, Record<string, string | undefined>>;

/** What each git call could print before it counted as a failure: the 10 MB buffer the contract specifies for these reads. */
const MAX_BUFFER = 10 * 1024 * 1024;

const ECOSYSTEM = 'Filter to one ecosystem: npm, nuget, maven, all (default: "all")';
const INCLUDE_DEV = 'Include dev/test dependencies (default: false)';

/**
 * A working-tree file's text, or null. A file that isn't there is null
 * quietly, as the Directory.Packages.props walk expects. One that is there
 * and can't be read (refused by the workspace bound, say) is skipped too, as
 * before, but a warning names it rather than let it vanish.
 */
function treeReader(ctx: Ctx): ReadFile {
  return async (relPath) => {
    try {
      return await ctx.files.readText(relPath);
    } catch (err) {
      let present: boolean;
      try {
        present = ctx.files.exists(relPath);
      } catch {
        present = true;
      }
      if (present) ctx.warn({ code: 'DEPS_FILE_SKIPPED', message: `${relPath} was skipped: ${(err as Error).message}` });
      return null;
    }
  };
}

/** The workspace's inventory, from every file the `.gitignore`-aware listing returns. */
function scanTree(ctx: Ctx, opts: ScanOptions): Promise<ScanData> {
  return scanFiles(ctx.files.list('.', { warn: (w) => ctx.warn(w) }), opts, treeReader(ctx));
}

/**
 * git's stdout, or null when git ran and failed or printed more than the
 * specified 10 MB buffer. No git to run, a cancel, a timeout or an argument core refuses
 * still reject: those aren't git's answer.
 */
async function gitText(ctx: Ctx, call: GitCall): Promise<string | null> {
  const result = await runGit(ctx, call);
  if (result.exitCode !== 0 || Buffer.byteLength(result.stdout, 'utf8') > MAX_BUFFER) return null;
  return result.stdout;
}

/**
 * The inventory at `ref`: `git ls-tree -r --name-only` for the files, then
 * `git show <ref>:./<path>` for each one read. git runs in the workspace, so
 * both are relative to it (`./` keeps `show` there too). A ref git can't
 * read gives an empty inventory, so a bad `--from` reports every package as
 * added (#91 item 20), and paths git quotes (non-ASCII) don't match (item 25).
 */
async function scanAtRef(ctx: Ctx, ref: string, opts: ScanOptions): Promise<ScanData> {
  const listing = await gitText(ctx, { subcommand: 'ls-tree', options: ['-r', '--name-only'], revisions: [ref] });
  if (listing === null) return buildScanData([], []);
  const files = listing.trim().split('\n').filter(Boolean);
  return scanFiles(files, opts, (relPath) => gitText(ctx, { subcommand: 'show', revisions: [`${ref}:./${relPath}`] }));
}

type ChangeType = 'added' | 'removed' | 'upgraded' | 'downgraded';

export interface PackageChange {
  name: string;
  ecosystem: Ecosystem;
  change: ChangeType;
  from: string | null;
  to: string | null;
  source: string;
}

export interface DiffData {
  from: string;
  to: string;
  changes: PackageChange[];
  summary: { added: number; removed: number; upgraded: number; downgraded: number; unchanged: number };
}

/**
 * The changes between two inventories, keyed on ecosystem, name and source.
 * One version per key survives, the last one parsed, so a package present at
 * two versions shows phantom changes or hides real ones (#91 item 19). The
 * name is what sits between the first and last `:`, so Maven's
 * `group:artifact` survives. Unchanged packages are counted, not listed.
 */
export function diffScans(from: string, to: string | undefined, fromScan: ScanData, toScan: ScanData): DiffData {
  const fromMap = new Map<string, string>();
  const toMap = new Map<string, string>();
  for (const pkg of fromScan.packages) fromMap.set(`${pkg.ecosystem}:${pkg.name}:${pkg.source}`, pkg.version);
  for (const pkg of toScan.packages) toMap.set(`${pkg.ecosystem}:${pkg.name}:${pkg.source}`, pkg.version);
  const changes: PackageChange[] = [];
  const allKeys = new Set([...fromMap.keys(), ...toMap.keys()]);
  for (const key of allKeys) {
    const parts = key.split(':');
    const fromVer = fromMap.get(key) ?? null;
    const toVer = toMap.get(key) ?? null;
    let change: ChangeType;
    if (!fromVer) change = 'added';
    else if (!toVer) change = 'removed';
    else if (fromVer === toVer) continue;
    else change = compareSemver(toVer, fromVer) < 0 ? 'downgraded' : 'upgraded';
    changes.push({ name: parts.slice(1, -1).join(':'), ecosystem: parts[0] as Ecosystem, change, from: fromVer, to: toVer, source: parts[parts.length - 1] ?? '' });
  }
  const summary = { added: 0, removed: 0, upgraded: 0, downgraded: 0, unchanged: 0 };
  for (const c of changes) summary[c.change]++;
  summary.unchanged = [...allKeys].filter((k) => {
    const fv = fromMap.get(k);
    const tv = toMap.get(k);
    return fv !== undefined && tv !== undefined && fv === tv;
  }).length;
  return { from, to: to ?? 'working tree', changes, summary };
}

export const depsScanCommand = defineCommand({
  path: ['util', 'deps', 'scan'],
  description: 'Inventory all dependencies from manifest files (local only, no network)',
  toolDescription:
    'The dependency inventory of the workspace, from npm (package-lock.json, yarn.lock, pnpm-lock.yaml, package.json), NuGet (packages.lock.json, .csproj/.fsproj/.vbproj, packages.config, Directory.Packages.props) and Maven/Gradle (pom.xml, build.gradle(.kts), gradle.lockfile) files, skipping what .gitignore ignores. A lockfile wins over its manifest. Returns { ecosystems, manifests[], packages[] of { name, version, ecosystem, source, type, scope }, summary }. Direct production dependencies only unless includeTransitive / includeDev. Reads files only; no network, no git needed. Its output is the inventory osv_vulns, ossindex_vulns, sonatypeiq_evaluate and artifactory_package_outdated read. To compare two git refs use util_deps_diff.',
  input: z.object({
    ecosystem: z.string().optional().describe(ECOSYSTEM),
    includeTransitive: z.boolean().optional().describe('Include transitive dependencies (default: false)'),
    includeDev: z.boolean().optional().describe(INCLUDE_DEV),
  }),
  writes: false,
  options: [
    { flags: '--ecosystem <ecosystem>', field: 'ecosystem', description: ECOSYSTEM },
    { flags: '--include-transitive', field: 'includeTransitive', description: 'Include transitive dependencies (default: false)' },
    { flags: '--include-dev', field: 'includeDev', description: INCLUDE_DEV },
  ],
  aliases: [['deps', 'scan']],
  examples: [{}, { ecosystem: 'npm', includeTransitive: true, includeDev: true }],
  run: async (input, ctx) => {
    if (!ctx.repo()) {
      throw new ToilError('INVALID_INPUT', 'Not inside a git repository. deps commands require a git repo root.', {
        fix: 'Run it inside a git clone, or point --workspace at one.',
      });
    }
    return scanTree(ctx, { ecosystem: input.ecosystem ?? 'all', includeTransitive: input.includeTransitive ?? false, includeDev: input.includeDev ?? false });
  },
});

export const depsDiffCommand = defineCommand({
  path: ['util', 'deps', 'diff'],
  description: 'Show dependency changes between two git refs (local only, no network)',
  toolDescription:
    'How the dependency inventory changed between two git refs of the repository in the workspace: from (required) and to (default: the working tree). Transitive dependencies are always included; dev ones with includeDev. Returns { from, to, changes[] of { name, ecosystem, change: added | removed | upgraded | downgraded, from, to, source }, summary } with unchanged packages counted but not listed. A ref git cannot read gives an empty inventory for that side. Runs the git on PATH; no network. For the inventory itself use util_deps_scan.',
  input: z.object({
    from: z.string().describe('Base git ref (commit, tag, or branch)'),
    to: z.string().optional().describe('Target git ref (default: working tree)'),
    ecosystem: z.string().optional().describe(ECOSYSTEM),
    includeDev: z.boolean().optional().describe(INCLUDE_DEV),
  }),
  writes: false,
  options: [
    { flags: '--from <ref>', field: 'from', description: 'Base git ref (commit, tag, or branch)' },
    { flags: '--to <ref>', field: 'to', description: 'Target git ref (default: working tree)' },
    { flags: '--ecosystem <ecosystem>', field: 'ecosystem', description: ECOSYSTEM },
    { flags: '--include-dev', field: 'includeDev', description: INCLUDE_DEV },
  ],
  aliases: [['deps', 'diff']],
  examples: [{ from: 'main' }, { from: 'v1.0.0', to: 'main', ecosystem: 'npm', includeDev: true }],
  run: async (input, ctx) => {
    if (!ctx.repo()) {
      // A machine with no git hears that first, wherever it runs a git command (#68).
      await runGit(ctx, { subcommand: 'version' });
      throw new ToilError('INVALID_INPUT', 'Not inside a git repository.', { fix: 'Run it inside a git clone, or point --workspace at one.' });
    }
    const opts: ScanOptions = { ecosystem: input.ecosystem ?? 'all', includeTransitive: true, includeDev: input.includeDev ?? false };
    const fromScan = await scanAtRef(ctx, input.from, opts);
    const toScan = input.to ? await scanAtRef(ctx, input.to, opts) : await scanTree(ctx, opts);
    return diffScans(input.from, input.to, fromScan, toScan);
  },
});

export const depsCommands = [depsScanCommand, depsDiffCommand];
