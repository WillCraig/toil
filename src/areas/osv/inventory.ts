import { z } from 'zod';
import type { CommandContext } from '../../core/context.js';
import { readInventory as readCoreInventory, type InventoryPackage } from '../../core/inventory.js';

/**
 * The dependency inventory the vulnerability sources check (`toil osv vulns`,
 * `toil ossindex vulns`): a JSON list of packages (or `toil deps scan` output) from `--from <file>` or
 * stdin, as its whole envelope, its `data`, or a bare list of packages, and
 * `deps frisk` filters over it. Each source reads the same inventory,
 * so the inventory is filed once and photocopied for every department. The
 * reader itself is core's (`src/core/inventory.ts`); this keeps their wording.
 */

/** The parts of a command's context an inventory read needs. */
export type InventoryContext = Pick<CommandContext<unknown>, 'files'>;

export const FROM_DESCRIPTION = 'Inventory to check: a JSON file holding a list of { name, version, ecosystem } packages, or toil deps scan output (its envelope or its data). Omitted, it is read from stdin on the CLI';
export const ECOSYSTEM_DESCRIPTION = 'Filter to one ecosystem: npm, nuget, maven, all (default: "all")';
export const DIRECT_ONLY_DESCRIPTION = 'Only scan direct dependencies (default: include transitive)';
export const INCLUDE_DEV_DESCRIPTION = 'Include dev/test dependencies (default: false)';

/** The input fields and CLI flags every vulnerability source shares. */
export const inventoryFields = {
  from: z.string().optional().describe(FROM_DESCRIPTION),
  ecosystem: z.string().optional().describe(ECOSYSTEM_DESCRIPTION),
  directOnly: z.boolean().optional().describe(DIRECT_ONLY_DESCRIPTION),
  includeDev: z.boolean().optional().describe(INCLUDE_DEV_DESCRIPTION),
};

export const inventoryOptions = [
  { flags: '--from <file>', field: 'from', description: FROM_DESCRIPTION },
  { flags: '--ecosystem <ecosystem>', field: 'ecosystem', description: ECOSYSTEM_DESCRIPTION },
  { flags: '--direct-only', field: 'directOnly', description: DIRECT_ONLY_DESCRIPTION },
  { flags: '--include-dev', field: 'includeDev', description: INCLUDE_DEV_DESCRIPTION },
];

/**
 * The inventory's packages, from `from` or stdin, through core's reader in
 * the words these two sources shipped with.
 */
export function readInventory(ctx: InventoryContext, from: string | undefined, command: string): Promise<InventoryPackage[]> {
  return readCoreInventory(ctx, from, {
    holds: 'a JSON file holding a list of { name, version, ecosystem } packages',
    missingFix: 'Write the package list to a file in the workspace, then pass its path as from.',
    fix: `Pass a JSON list of { name, version, ecosystem } packages to toil ${command}, with --from <file> or on stdin.`,
    packageFix: 'Each package needs a name, version and ecosystem, e.g. { "name": "lodash", "version": "4.17.20", "ecosystem": "npm" }.',
  });
}

/**
 * What `deps frisk` scanned: the chosen ecosystem (`all`, or one; any
 * other value matches nothing, suspected bug #91 item 24), transitive
 * dependencies unless `directOnly`, and production ones unless `includeDev`.
 */
export function selectPackages(packages: InventoryPackage[], input: { ecosystem?: string | undefined; directOnly?: boolean | undefined; includeDev?: boolean | undefined }): InventoryPackage[] {
  const eco = input.ecosystem ?? 'all';
  return packages.filter((p) => (eco === 'all' || p.ecosystem === eco) && !(input.directOnly === true && p.type === 'transitive') && (input.includeDev === true || p.scope !== 'dev'));
}

/** One finding, as `deps frisk` shaped it for every source. */
export interface Vulnerability {
  id: string;
  summary: string;
  severity: string;
  cvss: number | null;
  aliases: string[];
  remediation: { fixAvailable: boolean; fixedVersions: string[]; advice: string };
  references: string[];
}

export type VulnerablePackage = InventoryPackage & { vulnerabilities: Vulnerability[] };

/** `deps frisk` result for one source. `tier` is `full` whenever a source answered, which is every success. */
export function friskData(source: string, scanned: number, packages: VulnerablePackage[]) {
  return { tier: 'full' as const, source, sourcesQueried: [source], sourceErrors: [] as Array<{ source: string; error: string }>, scanned, vulnerable: packages.length, packages };
}

/** The per-request timeout the contract specifies for every source request. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** Batches go one after another; ten minutes covers a large monorepo's inventory at the request timeout's worst. */
export const TIME_LIMIT_MS = 600_000;
