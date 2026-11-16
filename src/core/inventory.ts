import { z } from 'zod';
import { ToilError } from './errors.js';
import { STDIN_OVER_MCP, type FileAccess } from './files.js';

/**
 * Reading a dependency inventory that `toil deps scan` wrote, for the
 * commands that check one against a source (`artifactory package outdated`, `osv
 * vulns`, `sonatypeiq evaluate`): `--input-file <path>`, or stdin when it's left
 * out (`toil deps scan | toil osv vulns`). They read an inventory; none of
 * them scans a repository itself (principle 3). One reader, so every source
 * accepts the same three shapes and refuses a bad one in the same words. An
 * inventory of the inventory was proposed, and deferred to the next audit.
 */

export const inventoryPackage = z.object({
  name: z.string(),
  version: z.string(),
  ecosystem: z.string(),
  source: z.string().optional(),
  type: z.string().optional(),
  scope: z.string().optional(),
});
export type InventoryPackage = z.output<typeof inventoryPackage>;

/** The `--input-file` field and flag description every inventory reader shares. */
export const INVENTORY_FROM_DESCRIPTION =
  'Inventory to check: a file holding toil deps scan output (its envelope, its data, or a list of packages). Omitted, it is read from stdin on the CLI';

/**
 * How a source words the reader's refusals. Each defaults to core's own
 * words; a source that shipped with its own keeps them, so its messages
 * don't change when it moves onto this reader.
 */
export interface InventoryOptions {
  /** The command to pipe into, for the fix: `toil artifactory <command>`. Defaults to `toil <command>`. */
  pipeTo?: string;
  /** The verb in "No inventory to <verb>". Defaults to `check`. */
  verb?: string;
  /** What `from` should name, over MCP with no stdin. Defaults to `a file holding toil deps scan output`. */
  holds?: string;
  /** The fix for that. */
  missingFix?: string;
  /** The fix for input that isn't JSON or has no packages list; replaces the one `pipeTo` builds. */
  fix?: string;
  /** The fix for a package missing its name, version or ecosystem. */
  packageFix?: string;
}

/**
 * The inventory's packages. Accepts `deps scan`'s whole envelope, its `data`,
 * or a bare list, so a hand-made list works too. A failed scan's envelope,
 * non-JSON, a missing list or a package without a name, version or ecosystem
 * is INVALID_INPUT saying which.
 */
export async function readInventory(ctx: { files: FileAccess }, from: string | undefined, options: InventoryOptions = {}): Promise<InventoryPackage[]> {
  const where = from === undefined || from === '-' ? 'stdin' : `"${from}"`;
  let text: string;
  try {
    text = await ctx.files.readText(from ?? '-');
  } catch (err) {
    if (err === STDIN_OVER_MCP && from === undefined) {
      throw new ToilError('INVALID_INPUT', `No inventory to ${options.verb ?? 'check'}: pass inputFile, ${options.holds ?? 'a file holding toil deps scan output'}. Over MCP there is no stdin to read it from.`, {
        fix: options.missingFix ?? 'Write toil deps scan output to a file in the workspace, then pass its path as inputFile.',
      });
    }
    throw err;
  }
  const fix = options.fix ?? `Pass the output of toil deps scan, e.g. toil deps scan | ${options.pipeTo ?? 'toil <command>'}, or --input-file <path> holding it.`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ToilError('INVALID_INPUT', `The inventory from ${where} isn't JSON.`, { fix });
  }
  const record = (value: unknown) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
  const envelope = record(parsed);
  if (envelope?.ok === false) {
    const message = record(envelope.error)?.message;
    throw new ToilError('INVALID_INPUT', `The inventory from ${where} is a failed result${typeof message === 'string' ? `: ${message}` : ''}.`, {
      fix: 'Fix what made the scan fail, then run it again.',
    });
  }
  const list = Array.isArray(parsed) ? parsed : (record(envelope?.data)?.packages ?? envelope?.packages);
  if (!Array.isArray(list)) {
    throw new ToilError('INVALID_INPUT', `The inventory from ${where} has no packages list.`, { fix });
  }
  const packages = z.array(inventoryPackage).safeParse(list);
  if (!packages.success) {
    const issue = packages.error.issues[0];
    throw new ToilError('INVALID_INPUT', `The inventory from ${where} has a package without a usable ${String(issue?.path.at(-1) ?? 'field')} (packages[${String(issue?.path[0] ?? '?')}]).`, {
      fix: options.packageFix ?? 'Each package needs a name, version and ecosystem, as toil deps scan writes them.',
      details: packages.error.issues.slice(0, 5).map((i) => ({ path: i.path, message: i.message })),
    });
  }
  return packages.data;
}
