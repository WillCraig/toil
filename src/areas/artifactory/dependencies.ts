import { z } from 'zod';
import { apiRequest } from '../../core/api.js';
import { apiPath, rawPath } from '../../core/api-path.js';
import { ToilError } from '../../core/errors.js';
import { INVENTORY_FROM_DESCRIPTION, readInventory as readSharedInventory, type InventoryPackage } from '../../core/inventory.js';
import { artifactoryArea } from './area.js';
import type { ArtifactoryConnection, ArtifactoryContext } from './client.js';
import { isNewer, updateType } from '../../core/versions.js';

/**
 * `package outdated` and `package license-check`: newer versions and licenses, from the
 * connection's npm, NuGet and Maven repositories, for the direct
 * dependencies in an inventory that `toil deps scan` wrote (`--from <file>`,
 * or stdin). `deps outdated` and `deps license-check` paths are
 * aliases. One request per package, one package at a time, after a ping that
 * must pass; a lookup that fails for any reason counts as no answer, not as
 * an error (suspected bug #91 item 23). The audit trail records that every
 * package was checked, which is true, in the sense that it was asked.
 */

/** The per-request timeout the contract specifies for these lookups. */
const LOOKUP_TIMEOUT_MS = 15_000;
/** One request per package, sequentially: ten minutes covers several hundred direct dependencies at the lookup timeout's worst. */
const TIME_LIMIT_MS = 600_000;

type Ecosystem = 'npm' | 'nuget' | 'maven';

const ECOSYSTEM_DESCRIPTION = 'Filter to one ecosystem: npm, nuget, maven, all (default: "all")';
const FROM_DESCRIPTION = INVENTORY_FROM_DESCRIPTION;

const fromField = z.string().optional().describe(FROM_DESCRIPTION);
const ecosystemField = z.string().optional().describe(ECOSYSTEM_DESCRIPTION);

/** The inventory, read by core's shared reader, with the fix naming this area's commands. */
function readInventory(ctx: ArtifactoryContext, from: string | undefined): Promise<InventoryPackage[]> {
  return readSharedInventory(ctx, from, { pipeTo: 'toil artifactory package <command>' });
}

/**
 * What is scanned: the chosen ecosystem (`all`, or one; any
 * other value matches nothing, suspected bug #91 item 24), direct
 * dependencies only, and production ones unless dev was asked for.
 */
function direct(packages: InventoryPackage[], ecosystem: string | undefined, includeDev: boolean): InventoryPackage[] {
  const eco = ecosystem ?? 'all';
  return packages.filter((p) => (eco === 'all' || p.ecosystem === eco) && p.type !== 'transitive' && (includeDev || p.scope !== 'dev'));
}

/**
 * The ping sent first, with only the token and the lookup timeout.
 * Anything but a success stops the command.
 */
async function requireReachable(ctx: ArtifactoryContext): Promise<void> {
  try {
    await apiRequest<string>(artifactoryArea, ctx, `api/system/ping`, { as: 'text', timeoutMs: LOOKUP_TIMEOUT_MS });
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    const cause = err instanceof ToilError ? err : undefined;
    throw new ToilError(cause?.code === 'AUTH' ? 'AUTH' : 'NETWORK', `Artifactory at ${ctx.connection.baseUrl} is not reachable or authentication failed. Run 'toil artifactory ping' to diagnose.`, {
      fix: `Run toil artifactory ping to see Artifactory's answer, then check baseUrl and token (${artifactoryArea.envName('baseUrl')}, ${artifactoryArea.envName('token')}).`,
      details: { status: 503, cause: cause?.message ?? (err instanceof Error ? err.message : String(err)) },
    });
  }
}

function repoFor(connection: ArtifactoryConnection, ecosystem: string): string | undefined {
  if (ecosystem === 'npm') return connection.npmRepo;
  if (ecosystem === 'nuget') return connection.nugetRepo;
  if (ecosystem === 'maven') return connection.mavenRepo;
  return undefined;
}

/** One lookup: its answer, or null for any failure at all. A cancelled command still stops. */
async function lookup<T>(ctx: ArtifactoryContext, path: string, as: 'json' | 'text' = 'json', query?: Record<string, string>): Promise<T | null> {
  try {
    return await apiRequest<T>(artifactoryArea, ctx, path, { as, timeoutMs: LOOKUP_TIMEOUT_MS, ...(query ? { query } : {}) });
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    return null;
  }
}

const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
/**
 * The repository key is one segment, and so is the package name: a scoped npm
 * name keeps its leading `@` and has its slash encoded, `@scope%2Fname`.
 */
const npmPath = (repo: string, name: string) => apiPath`api/npm/${repo}/${name.startsWith('@') ? rawPath(`@${encodeURIComponent(name.slice(1))}`) : name}`;

async function latestVersion(ctx: ArtifactoryContext, repo: string, pkg: InventoryPackage): Promise<string | null> {
  if (pkg.ecosystem === 'npm') {
    const latest = obj(obj(await lookup(ctx, npmPath(repo, pkg.name)))['dist-tags']).latest;
    return typeof latest === 'string' && latest ? latest : null;
  }
  if (pkg.ecosystem === 'nuget') {
    // Suspected bug #91 item 21: the last entry, prerelease or not.
    const versions = obj(await lookup(ctx, apiPath`api/nuget/v3/${repo}/flatcontainer/${pkg.name.toLowerCase()}/index.json`)).versions;
    const list = Array.isArray(versions) ? versions : [];
    return (list[list.length - 1] as string | undefined) ?? null;
  }
  if (pkg.ecosystem === 'maven') {
    const [groupId, artifactId] = pkg.name.split(':');
    if (!groupId || !artifactId) return null;
    const text = await lookup<string>(ctx, 'api/search/latestVersion', 'text', { g: groupId, a: artifactId, repos: repo });
    return text?.trim() || null;
  }
  return null;
}

async function license(ctx: ArtifactoryContext, repo: string, pkg: InventoryPackage): Promise<string | null> {
  if (pkg.ecosystem === 'npm') {
    // Suspected bug #91 item 23: the packument's top-level license, which is the latest version's.
    const value = obj(await lookup(ctx, npmPath(repo, pkg.name))).license;
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && value !== null) return (obj(value).type as string | undefined) ?? null;
    return null;
  }
  if (pkg.ecosystem === 'nuget') {
    // Suspected bug #91 item 22: a registration leaf keeps its license fields in catalogEntry, not here.
    const leaf = await lookup(ctx, apiPath`api/nuget/v3/${repo}/registration/${pkg.name.toLowerCase()}/${pkg.version}.json`);
    if (leaf === null) return null;
    const data = obj(leaf);
    return (data.licenseExpression as string | undefined) ?? (data.licenseUrl ? 'See licenseUrl' : null);
  }
  // Maven: the POM isn't read, so there is never a license.
  return null;
}

export const outdatedCommand = artifactoryArea.command({
  path: ['artifactory', 'package', 'outdated'],
  aliases: [['deps', 'outdated']],
  description: 'Check for newer versions available in Artifactory (requires Artifactory)',
  toolDescription:
    "Newer versions in the connection's npm, NuGet and Maven repositories for the direct production dependencies of an inventory from toil deps scan. Returns { outdated, uncheckedEcosystems, summary }; ecosystems with no repository configured are listed in uncheckedEcosystems.",
  input: z.object({
    from: fromField,
    ecosystem: ecosystemField,
    major: z.boolean().optional().describe('Only show major version bumps'),
    minor: z.boolean().optional().describe('Only show minor version bumps or higher'),
    patch: z.boolean().optional().describe('Only show patch version bumps or higher'),
  }),
  writes: false,
  timeLimitMs: TIME_LIMIT_MS,
  options: [
    { flags: '--from <file>', field: 'from', description: FROM_DESCRIPTION },
    { flags: '--ecosystem <ecosystem>', field: 'ecosystem', description: ECOSYSTEM_DESCRIPTION },
    { flags: '--major', field: 'major', description: 'Only show major version bumps' },
    { flags: '--minor', field: 'minor', description: 'Only show minor version bumps or higher' },
    { flags: '--patch', field: 'patch', description: 'Only show patch version bumps or higher' },
  ],
  examples: [
    { from: 'inventory.json' },
    { from: 'inventory.json', ecosystem: 'npm', minor: true },
    { from: 'inventory.json', major: true, patch: true },
  ],
  run: async (input, ctx) => {
    const packages = direct(await readInventory(ctx, input.from), input.ecosystem, false);
    await requireReachable(ctx);
    const filterType = input.major ? 'major' : input.minor ? 'minor' : input.patch ? 'patch' : undefined;
    const order = { major: 3, minor: 2, patch: 1 };
    const outdated: Array<{ name: string; ecosystem: Ecosystem; current: string; latest: string; updateType: 'major' | 'minor' | 'patch'; source: string }> = [];
    const unchecked = new Set<string>();
    for (const pkg of packages) {
      const repo = repoFor(ctx.connection, pkg.ecosystem);
      if (!repo) {
        unchecked.add(pkg.ecosystem);
        continue;
      }
      const latest = await latestVersion(ctx, repo, pkg);
      if (!latest || !isNewer(pkg.version, latest)) continue;
      const type = updateType(pkg.version, latest);
      if (filterType && order[type] < order[filterType]) continue;
      outdated.push({ name: pkg.name, ecosystem: pkg.ecosystem as Ecosystem, current: pkg.version, latest, updateType: type, source: pkg.source ?? '' });
    }
    const summary = { total: outdated.length, major: 0, minor: 0, patch: 0 };
    for (const pkg of outdated) summary[pkg.updateType]++;
    return { source: 'artifactory', artifactoryUrl: ctx.connection.baseUrl, outdated, uncheckedEcosystems: [...unchecked], summary };
  },
});

export const licenseCheckCommand = artifactoryArea.command({
  path: ['artifactory', 'package', 'license-check'],
  aliases: [['deps', 'license-check']],
  description: 'Report licenses for all direct dependencies via Artifactory (requires Artifactory)',
  toolDescription:
    "Licenses from the connection's npm and NuGet repositories for the direct dependencies of an inventory from toil deps scan. Returns { packages, summary }; license is null when unknown, and always null for Maven.",
  input: z.object({
    from: fromField,
    ecosystem: ecosystemField,
    includeDev: z.boolean().optional().describe('Include dev/test dependencies (default: false)'),
  }),
  writes: false,
  timeLimitMs: TIME_LIMIT_MS,
  options: [
    { flags: '--from <file>', field: 'from', description: FROM_DESCRIPTION },
    { flags: '--ecosystem <ecosystem>', field: 'ecosystem', description: ECOSYSTEM_DESCRIPTION },
    { flags: '--include-dev', field: 'includeDev', description: 'Include dev/test dependencies (default: false)' },
  ],
  examples: [{ from: 'inventory.json' }, { from: 'inventory.json', ecosystem: 'nuget', includeDev: true }],
  run: async (input, ctx) => {
    const packages = direct(await readInventory(ctx, input.from), input.ecosystem, input.includeDev === true);
    await requireReachable(ctx);
    const licensed: Array<{ name: string; version: string; ecosystem: Ecosystem; source: string; license: string | null }> = [];
    for (const pkg of packages) {
      const repo = repoFor(ctx.connection, pkg.ecosystem);
      licensed.push({ name: pkg.name, version: pkg.version, ecosystem: pkg.ecosystem as Ecosystem, source: pkg.source ?? '', license: repo ? await license(ctx, repo, pkg) : null });
    }
    const byLicense: Record<string, number> = {};
    let unknown = 0;
    for (const pkg of licensed) {
      if (!pkg.license) unknown++;
      else byLicense[pkg.license] = (byLicense[pkg.license] ?? 0) + 1;
    }
    return { source: 'artifactory', artifactoryUrl: ctx.connection.baseUrl, packages: licensed, summary: { total: licensed.length, byLicense, unknown } };
  },
});

export const dependencyCommands = [outdatedCommand, licenseCheckCommand];
