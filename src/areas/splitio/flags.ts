import { z } from 'zod';
import { ToilError } from '../../core/errors.js';
import { allowWriteField } from '../../core/run.js';
import { splitioArea } from './area.js';
import {
  crBody,
  crFields,
  crOptions,
  getDefinition,
  intText,
  parseIntText,
  parseJson,
  seg,
  split,
  submitCr,
  workspaceOf,
  writableDefinition,
  type CrInput,
  type SplitioContext,
} from './client.js';

/**
 * The flag commands. `list` and `get` read; every other command files a
 * change request against one environment, which Split's approvers then
 * accept or reject. No flag is changed by toil itself: it only submits the
 * form, and the form is reviewed by a committee toil has never met.
 */

const flagField = { flag: z.string().describe('Feature flag name') };
const environmentField = { environment: z.string().describe('Environment ID') };
const flagArg = { name: 'flag', field: 'flag', description: 'Feature flag name' };
const environmentOption = { flags: '--environment <id>', field: 'environment', description: 'Environment ID' };

/** What a change-request example needs besides its own fields. */
const CR = { workspace: 'ws-abc12345', mnemonic: 'flag-change', description: 'Rollout step', changeNumber: 'CHG0001234', approvers: 'you@example.com', rolloutStatus: 'abc12345-0000-0000-0000-000000000000', allowWrite: true } as const;

const WEIGHTS_FIX = 'Pass --weights as a JSON array such as [{"treatment":"on","size":50},{"treatment":"off","size":50}], or use --treatment.';

export const flagsListCommand = splitioArea.command({
  path: ['splitio', 'flag', 'list'],
  description: 'List feature flags in a workspace',
  input: z.object({
    limit: intText.optional().describe('Maximum number of flags to return (Split allows up to 50) (default: "50")'),
    offset: intText.optional().describe('Pagination offset (default: "0")'),
    flagSet: z.string().optional().describe('Filter by flag set name'),
  }),
  writes: false,
  context: { workspace: 'required' },
  options: [
    { flags: '--limit <n>', field: 'limit', description: 'Maximum number of flags to return (Split allows up to 50) (default: "50")' },
    { flags: '--offset <n>', field: 'offset', description: 'Pagination offset (default: "0")' },
    { flags: '--flag-set <name>', field: 'flagSet', description: 'Filter by flag set name' },
  ],
  examples: [{ workspace: 'ws-abc12345' }, { workspace: 'ws-abc12345', limit: '10', offset: '20', flagSet: 'checkout' }],
  run: async (input, ctx) => {
    if (input.flagSet) {
      // #79 item 14: still unsettled, so the parameter is sent as specified and the caller is told.
      ctx.warn({
        code: 'SPLITIO_FLAG_SET_FILTER',
        message: "Split's List feature flags reference documents no flag-set filter; flagSetName is sent, but compare totalCount with an unfiltered list before relying on it.",
      });
    }
    // GET /splits/ws/{workspace}?offset&limit, answered with { objects, offset, limit, totalCount }. https://docs.split.io/reference/list-feature-flags
    const body = await split<{ objects?: unknown[]; totalCount?: number }>(ctx, `/splits/ws/${seg(workspaceOf(ctx))}`, {
      query: { limit: parseIntText(input.limit, '50'), offset: parseIntText(input.offset, '0'), ...(input.flagSet ? { flagSetName: input.flagSet } : {}) },
    });
    const flags = body.objects ?? [];
    return { count: flags.length, totalCount: body.totalCount, flags };
  },
});

export const flagsGetCommand = splitioArea.command({
  path: ['splitio', 'flag', 'get'],
  description: 'Get a flag definition',
  input: z.object({
    ...flagField,
    environment: z.string().optional().describe('Environment ID or name; include targeting rules for this environment'),
  }),
  writes: false,
  context: { workspace: 'required' },
  args: [flagArg],
  options: [{ flags: '--environment <id>', field: 'environment', description: 'Environment ID or name; include targeting rules for this environment' }],
  examples: [
    { workspace: 'ws-abc12345', flag: 'new_checkout' },
    { workspace: 'ws-abc12345', flag: 'new_checkout', environment: 'env-abc12345' },
  ],
  run: async (input, ctx) => {
    if (input.environment) return getDefinition(ctx, input.flag, input.environment);
    // GET /splits/ws/{workspace}/{flag}. https://docs.split.io/reference/get-feature-flag
    return split<unknown>(ctx, `/splits/ws/${seg(workspaceOf(ctx))}/${seg(input.flag)}`);
  },
});

export const flagsUpdateCommand = splitioArea.command({
  path: ['splitio', 'flag', 'update'],
  description: "Submit a Change Request to replace a flag's full definition in an environment",
  input: z.object({
    ...flagField,
    ...environmentField,
    ...crFields,
    inputFile: z.string().optional().describe('JSON file with the complete flag definition (treatments, defaultTreatment, rules, defaultRule, ...); "-" = stdin on the CLI'),
    ...allowWriteField,
  }),
  writes: true,
  context: { workspace: 'required' },
  args: [flagArg],
  options: [
    environmentOption,
    ...crOptions,
    { flags: '--input-file <path>', field: 'inputFile', description: 'JSON file with the complete flag definition (treatments, defaultTreatment, rules, defaultRule, ...); "-" = stdin on the CLI' },
  ],
  examples: [{ ...CR, flag: 'new_checkout', environment: 'env-abc12345', inputFile: 'definition.json' }],
  run: async (input, ctx) => {
    if (!input.inputFile) throw new ToilError('INVALID_INPUT', '--input-file is required for flag update', { fix: 'Pass --input-file <path> with the flag definition as JSON; get the current one with toil splitio flag get <flag> --environment <id>.' });
    const definition = parseJson(await ctx.files.readText(input.inputFile), '--input-file', 'The file holds one JSON object: the flag definition, as flag get --environment returns it.');
    if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
      throw new ToilError('INVALID_INPUT', '--input-file must hold a JSON object: the flag definition.', { fix: 'Start from the output of toil splitio flag get <flag> --environment <id>.' });
    }
    return submitCr(ctx, input.environment, crBody(input, 'UPDATE', { ...(definition as Record<string, unknown>), name: input.flag }));
  },
});

export const flagsSetRuleCommand = splitioArea.command({
  path: ['splitio', 'flag', 'set-rule'],
  description: 'Change one targeting rule without altering the rest of the flag definition',
  input: z.object({
    ...flagField,
    ...environmentField,
    ruleIndex: intText.describe('Zero-based index of the targeting rule to update'),
    treatment: z.string().optional().describe('Treatment to assign to the entire rule bucket'),
    weights: z.string().optional().describe('JSON array of {treatment, size} objects, sizes in percent summing to 100'),
    ...crFields,
    ...allowWriteField,
  }),
  writes: true,
  context: { workspace: 'required' },
  args: [flagArg],
  options: [
    environmentOption,
    { flags: '--rule-index <n>', field: 'ruleIndex', description: 'Zero-based index of the targeting rule to update' },
    { flags: '--treatment <name>', field: 'treatment', description: 'Treatment to assign to the entire rule bucket' },
    { flags: '--weights <json>', field: 'weights', description: 'JSON array of {treatment, size} objects, sizes in percent summing to 100' },
    ...crOptions,
  ],
  examples: [
    { ...CR, flag: 'new_checkout', environment: 'env-abc12345', ruleIndex: '0', treatment: 'on' },
    { ...CR, flag: 'new_checkout', environment: 'env-abc12345', ruleIndex: '1', weights: '[{"treatment":"on","size":20},{"treatment":"off","size":80}]', approvers: 'you@example.com, lead@example.com' },
  ],
  run: async (input, ctx) => {
    if (!input.treatment && !input.weights) throw new ToilError('INVALID_INPUT', 'Either --treatment or --weights must be specified', { fix: WEIGHTS_FIX });
    const current = await getDefinition(ctx, input.flag, input.environment);
    const rules = (Array.isArray(current.rules) ? [...current.rules] : []) as Array<Record<string, unknown>>;
    const idx = parseIntText(input.ruleIndex, '');
    if (Number.isNaN(idx) || idx < 0 || idx >= rules.length) {
      throw new ToilError('INVALID_INPUT', `Rule index ${Number.isNaN(idx) ? JSON.stringify(String(input.ruleIndex)) : idx} is out of range (flag has ${rules.length} rules)`, {
        fix: 'Run toil splitio flag get <flag> --environment <id> to see the rules; --rule-index counts from 0.',
      });
    }
    // Bucket sizes are percentages: Submit Change Request's example writes a whole bucket as 100.
    const buckets = input.treatment ? [{ treatment: input.treatment, size: 100 }] : parseJson(input.weights!, '--weights', WEIGHTS_FIX);
    if (!Array.isArray(buckets)) throw new ToilError('INVALID_INPUT', '--weights must be a JSON array of {treatment, size} objects.', { fix: WEIGHTS_FIX });
    rules[idx] = { ...rules[idx], buckets };
    return submitCr(ctx, input.environment, crBody(input, 'UPDATE', writableDefinition(input.flag, current, { rules })));
  },
});

export const flagsSetDefaultCommand = splitioArea.command({
  path: ['splitio', 'flag', 'set-default'],
  description: 'Update the fallback default rule for traffic matching no targeting rule',
  input: z.object({
    ...flagField,
    ...environmentField,
    treatment: z.string().describe('Treatment to assign as the default'),
    ...crFields,
    ...allowWriteField,
  }),
  writes: true,
  context: { workspace: 'required' },
  args: [flagArg],
  options: [environmentOption, { flags: '--treatment <name>', field: 'treatment', description: 'Treatment to assign as the default' }, ...crOptions],
  examples: [{ ...CR, flag: 'new_checkout', environment: 'env-abc12345', treatment: 'off' }],
  run: async (input, ctx) => {
    const current = await getDefinition(ctx, input.flag, input.environment);
    return submitCr(ctx, input.environment, crBody(input, 'UPDATE', writableDefinition(input.flag, current, { defaultRule: [{ treatment: input.treatment, size: 100 }] })));
  },
});

/** kill, restore and toggle: a change request naming only the flag. https://developer.harness.io/docs/feature-management-experimentation/api/approvals */
function killOrRestore(ctx: SplitioContext, input: CrInput & { flag: string; environment: string }, operation: 'KILL' | 'RESTORE') {
  return submitCr(ctx, input.environment, crBody(input, operation, { name: input.flag }));
}

export const flagsToggleCommand = splitioArea.command({
  path: ['splitio', 'flag', 'toggle'],
  description: 'Enable or disable a single flag via a Change Request',
  input: z.object({
    ...flagField,
    ...environmentField,
    enabled: z.string().describe('true to restore / false to kill the flag'),
    ...crFields,
    ...allowWriteField,
  }),
  writes: true,
  context: { workspace: 'required' },
  args: [flagArg],
  options: [environmentOption, { flags: '--enabled <bool>', field: 'enabled', description: 'true to restore / false to kill the flag' }, ...crOptions],
  examples: [
    { ...CR, flag: 'new_checkout', environment: 'env-abc12345', enabled: 'false' },
    { ...CR, flag: 'new_checkout', environment: 'env-abc12345', enabled: 'true' },
  ],
  run: async (input, ctx) => {
    // Suspected bug (#79 item 11), kept: anything but "false" (any case) or "0" restores, "off" and "no" included.
    const enable = input.enabled.toLowerCase() !== 'false' && input.enabled !== '0';
    if (enable && !['true', '1'].includes(input.enabled.toLowerCase())) {
      ctx.warn({
        code: 'SPLITIO_TOGGLE_RESTORED',
        message: `--enabled "${input.enabled}" isn't true or false, and anything but false or 0 counts as true, so this filed a RESTORE change request for ${input.flag}. If you meant to kill it, withdraw this request and run again with --enabled false.`,
      });
    }
    return killOrRestore(ctx, input, enable ? 'RESTORE' : 'KILL');
  },
});

interface BatchEntry {
  flag: string;
  enabled: boolean;
}

export const flagsBatchToggleCommand = splitioArea.command({
  path: ['splitio', 'flag', 'toggle-many'],
  description: 'Enable or disable multiple flags from a JSON file (each creates its own Change Request)',
  input: z.object({
    ...environmentField,
    ...crFields,
    mnemonic: z.string().describe('Short Change Request title prefix (mnemonic)'),
    inputFile: z.string().optional().describe('JSON file: array of {flag, enabled} objects; "-" = stdin on the CLI'),
    ...allowWriteField,
  }),
  writes: true,
  context: { workspace: 'required' },
  options: [
    environmentOption,
    ...crOptions.map((o) => (o.field === 'mnemonic' ? { ...o, description: 'Short Change Request title prefix (mnemonic)' } : o)),
    { flags: '--input-file <path>', field: 'inputFile', description: 'JSON file: array of {flag, enabled} objects; "-" = stdin on the CLI' },
  ],
  examples: [{ ...CR, environment: 'env-abc12345', inputFile: 'toggles.json' }],
  run: async (input, ctx) => {
    if (!input.inputFile) throw new ToilError('INVALID_INPUT', '--input-file is required for flag toggle-many', { fix: 'Pass --input-file <path> holding a JSON array such as [{"flag":"new_checkout","enabled":false}].' });
    const entries = parseJson(await ctx.files.readText(input.inputFile), '--input-file', 'The file holds a JSON array of {flag, enabled} objects.') as BatchEntry[];
    if (!Array.isArray(entries)) throw new ToilError('INVALID_INPUT', 'Input file must be a JSON array of {flag, enabled} objects', { fix: 'Wrap the entries in [ ].' });
    // Every entry is checked before the first request, so a bad one can't leave half the batch filed.
    const bad = entries.findIndex((e: unknown) => typeof e !== 'object' || e === null || typeof (e as BatchEntry).flag !== 'string' || !(e as BatchEntry).flag);
    if (bad !== -1) {
      throw new ToilError('INVALID_INPUT', `Entry ${bad} of --input-file needs a "flag" name; no change requests were filed.`, { fix: 'Each entry is {"flag": "<name>", "enabled": true|false}.' });
    }

    const results: Array<{ flag: string; ok: boolean; id?: string; error?: string }> = [];
    for (const entry of entries) {
      try {
        // Suspected bug (#79 item 12), kept: enabled is read by truthiness, so "false" as a string restores.
        const operation = entry.enabled ? 'RESTORE' : 'KILL';
        const cr = await submitCr<{ id: string }>(ctx, input.environment, crBody(input, operation, { name: entry.flag }, `${input.mnemonic} — ${entry.flag}`));
        results.push({ flag: entry.flag, ok: true, id: cr.id });
      } catch (err) {
        // A cancel or a timeout ends the batch; the requests already filed stay filed.
        if (ctx.signal.aborted) throw err;
        results.push({ flag: entry.flag, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    // Suspected bug (#79 item 12), kept: the envelope is ok even when entries failed. The warning is new.
    const failed = results.filter((r) => !r.ok).length;
    if (failed > 0) ctx.warn({ code: 'SPLITIO_BATCH_PARTIAL', message: `${failed} of ${results.length} change requests failed; see results[].error.` });
    return { submitted: results.length, results };
  },
});

export const flagsKillCommand = splitioArea.command({
  path: ['splitio', 'flag', 'kill'],
  description: 'Submit a Change Request to kill (disable) a flag',
  input: z.object({ ...flagField, ...environmentField, ...crFields, ...allowWriteField }),
  writes: true,
  context: { workspace: 'required' },
  args: [flagArg],
  options: [environmentOption, ...crOptions],
  examples: [{ ...CR, flag: 'new_checkout', environment: 'env-abc12345' }],
  run: async (input, ctx) => killOrRestore(ctx, input, 'KILL'),
});

export const flagsRestoreCommand = splitioArea.command({
  path: ['splitio', 'flag', 'restore'],
  description: 'Submit a Change Request to restore a killed flag',
  input: z.object({ ...flagField, ...environmentField, ...crFields, ...allowWriteField }),
  writes: true,
  context: { workspace: 'required' },
  args: [flagArg],
  options: [environmentOption, ...crOptions],
  examples: [{ ...CR, flag: 'new_checkout', environment: 'env-abc12345' }],
  run: async (input, ctx) => killOrRestore(ctx, input, 'RESTORE'),
});

export const flagsArchiveCommand = splitioArea.command({
  path: ['splitio', 'flag', 'archive'],
  description: "Submit a Change Request to remove a flag's definition from an environment",
  input: z.object({ ...flagField, ...environmentField, ...crFields, ...allowWriteField }),
  writes: true,
  context: { workspace: 'required' },
  args: [flagArg],
  options: [environmentOption, ...crOptions],
  examples: [{ ...CR, flag: 'old_banner', environment: 'env-abc12345' }],
  // It removes a flag definition, and deletes never go through MCP.
  mcp: false,
  // ARCHIVE removes the definition from one environment; it isn't Split's flag archive API. https://docs.split.io/reference/create-change-request
  run: async (input, ctx) => submitCr(ctx, input.environment, crBody(input, 'ARCHIVE', { name: input.flag })),
});

export const flagsCommands = [
  flagsListCommand,
  flagsGetCommand,
  flagsUpdateCommand,
  flagsSetRuleCommand,
  flagsSetDefaultCommand,
  flagsToggleCommand,
  flagsBatchToggleCommand,
  flagsKillCommand,
  flagsRestoreCommand,
  flagsArchiveCommand,
];
