import { z } from 'zod';
import { ToilError } from '../../core/errors.js';
import { allowWriteField } from '../../core/run.js';
import { splitioArea } from './area.js';
import {
  intText,
  itemsOf,
  parseIntText,
  parseJson,
  seg,
  segmentCrBody,
  segmentCrFields,
  segmentCrOptions,
  split,
  submitCr,
  totalOf,
  workspaceOf,
  type SplitioContext,
} from './client.js';

/**
 * Segments, in Split's three kinds. Standard segments hold a list of keys per
 * environment, which toil can read and change; large segments are read only,
 * since their keys go up to a pre-signed URL on another host; rule-based
 * segments hold targeting rules, which toil can read and replace. Every change
 * is filed as a change request, so a key joins a segment only after a form has
 * been approved by someone who has never met the key.
 */

const environmentField = { environment: z.string().describe('Environment ID') };
const environmentOption = { flags: '--environment <id>', field: 'environment', description: 'Environment ID' };
const optionalEnvironment = { environment: z.string().optional().describe('Environment ID or name; list only what is enabled there') };
const optionalEnvironmentOption = { flags: '--environment <id>', field: 'environment', description: 'Environment ID or name; list only what is enabled there' };

/** What a change-request example needs besides its own fields. */
const CR = { workspace: 'ws-abc12345', mnemonic: 'segment-change', description: 'Beta cohort', changeNumber: 'CHG0001234', approvers: 'you@example.com', allowWrite: true } as const;

/** Split takes at most 10,000 new keys in one call. https://docs.split.io/reference/update-segment-keys-in-environment-via-json */
export const MAX_KEYS = 10_000;

// ---- standard segments ----

const segmentField = { segment: z.string().describe('Segment name') };
const segmentArg = { name: 'segment', field: 'segment', description: 'Segment name' };

export const segmentListCommand = splitioArea.command({
  path: ['splitio', 'segment', 'list'],
  description: 'List segments in a workspace, or those enabled in one environment',
  input: z.object({
    ...optionalEnvironment,
    limit: intText.optional().describe('Maximum number of segments to return (Split allows up to 50) (default: "50")'),
    offset: intText.optional().describe('Pagination offset (default: "0")'),
  }),
  writes: false,
  context: { workspace: 'required' },
  options: [
    optionalEnvironmentOption,
    { flags: '--limit <n>', field: 'limit', description: 'Maximum number of segments to return (Split allows up to 50) (default: "50")' },
    { flags: '--offset <n>', field: 'offset', description: 'Pagination offset (default: "0")' },
  ],
  examples: [{ workspace: 'ws-abc12345' }, { workspace: 'ws-abc12345', environment: 'env-abc12345', limit: '10', offset: '20' }],
  run: async (input, ctx) => {
    // GET /segments/ws/{ws}, or /segments/ws/{ws}/environments/{env}, each ?offset&limit, answered with { objects, offset, limit, totalCount }.
    // https://docs.split.io/reference/list-segments, https://docs.split.io/reference/list-segments-in-environment
    const base = `/segments/ws/${seg(workspaceOf(ctx))}`;
    const body = await split<unknown>(ctx, input.environment ? `${base}/environments/${seg(input.environment)}` : base, {
      query: { offset: parseIntText(input.offset, '0'), limit: parseIntText(input.limit, '50') },
    });
    const segments = itemsOf(body, 'segments');
    return { count: segments.length, totalCount: totalOf(body), segments };
  },
});

export const segmentKeysCommand = splitioArea.command({
  path: ['splitio', 'segment', 'keys'],
  description: 'List the keys in a segment in one environment',
  input: z.object({
    ...segmentField,
    ...environmentField,
    limit: intText.optional().describe('Maximum number of keys to return (Split allows up to 100) (default: "100")'),
    offset: intText.optional().describe('Pagination offset (default: "0")'),
  }),
  writes: false,
  args: [segmentArg],
  options: [
    environmentOption,
    { flags: '--limit <n>', field: 'limit', description: 'Maximum number of keys to return (Split allows up to 100) (default: "100")' },
    { flags: '--offset <n>', field: 'offset', description: 'Pagination offset (default: "0")' },
  ],
  examples: [{ segment: 'beta_users', environment: 'env-abc12345' }, { segment: 'beta_users', environment: 'env-abc12345', limit: '50', offset: '100' }],
  run: async (input, ctx) => {
    // GET /segments/{env}/{segment}/keys?offset&limit, answered with { keys: [{ key }], count, offset, limit }; no workspace in the path.
    // https://docs.split.io/reference/get-segment-keys-in-environment
    const body = await split<{ keys?: Array<{ key?: unknown }>; count?: unknown }>(ctx, `/segments/${seg(input.environment)}/${seg(input.segment)}/keys`, {
      query: { offset: parseIntText(input.offset, '0'), limit: parseIntText(input.limit, '100') },
    });
    if (!Array.isArray(body.keys) || body.keys.some((k) => typeof k?.key !== 'string')) {
      throw new ToilError('HTTP', `Split answered the keys of segment ${input.segment} without a list of string keys.`, {
        fix: 'Check the segment name and that it is enabled in this environment (toil splitio segment list --environment <id>), then run with --verbose.',
      });
    }
    // Plain strings, so a page pipes straight into segment add-keys or remove-keys.
    const keys = body.keys.map((k) => k.key as string);
    // Suspected bug (#79 item 15), kept: Split's count is read as the segment's total, not this page's length (its example: count 200 beside five keys).
    return { count: keys.length, totalCount: typeof body.count === 'number' ? body.count : null, keys };
  },
});

const keysInput = {
  ...segmentField,
  ...environmentField,
  key: z.array(z.string()).optional().describe('A key (repeatable)'),
  keysFile: z.string().optional().describe('File of keys: one per line, a JSON array of strings, or segment keys output; "-" = stdin on the CLI'),
  ...segmentCrFields,
  ...allowWriteField,
};
const keysOptions = [
  environmentOption,
  { flags: '--key <key>', field: 'key', description: 'A key (repeatable)' },
  { flags: '--keys-file <path>', field: 'keysFile', description: 'File of keys: one per line, a JSON array of strings, or segment keys output; "-" = stdin on the CLI' },
  ...segmentCrOptions,
];

const KEYS_FILE_FIX = 'Hold a JSON array of strings such as ["user-1","user-2"], the output of toil splitio segment keys, or one key per line.';

/**
 * The keys in a file: one per line, or JSON. JSON may be an array of strings,
 * `{ keys: [...] }` as `segment keys` returns, or a whole toil envelope around
 * either (stdout from `segment keys`, with or without `--select keys`), so the
 * two commands pipe. Any other JSON is refused, never read line by line, which
 * would file the braces as keys.
 */
function keysInFile(text: string): string[] {
  if (!/^[[{]/.test(text.trimStart())) return text.split(/\r?\n/);
  let value = parseJson(text, '--keys-file', KEYS_FILE_FIX);
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'ok' in value && 'data' in value) value = (value as { data: unknown }).data;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) value = (value as { keys?: unknown }).keys;
  if (!Array.isArray(value) || value.some((k) => typeof k !== 'string')) {
    throw new ToilError('INVALID_INPUT', '--keys-file holds JSON that is not a list of keys.', { fix: KEYS_FILE_FIX });
  }
  return value as string[];
}

/** The keys from --key and --keys-file together, each once, checked against Split's limit before anything is sent. */
async function keysOf(ctx: SplitioContext, input: { key?: string[] | undefined; keysFile?: string | undefined }, verb: string): Promise<string[]> {
  const keys = [...(input.key ?? [])];
  if (input.keysFile) keys.push(...keysInFile(await ctx.files.readText(input.keysFile)));
  const unique = [...new Set(keys.map((k) => k.trim()).filter(Boolean))];
  if (unique.length === 0) {
    throw new ToilError('INVALID_INPUT', `No keys to ${verb}; no change request was filed.`, { fix: 'Pass --key <key> (repeatable), or --keys-file <path> with one key per line.' });
  }
  if (unique.length > MAX_KEYS) {
    throw new ToilError('INVALID_INPUT', `${unique.length} keys is more than the ${MAX_KEYS} Split takes in one change; no change request was filed.`, {
      fix: `Split the keys into files of at most ${MAX_KEYS} and run once per file.`,
    });
  }
  return unique;
}

export const segmentAddKeysCommand = splitioArea.command({
  path: ['splitio', 'segment', 'add-keys'],
  description: 'Submit a Change Request to add keys to a segment in an environment',
  input: z.object(keysInput),
  writes: true,
  context: { workspace: 'required' },
  args: [segmentArg],
  options: keysOptions,
  examples: [
    { ...CR, segment: 'beta_users', environment: 'env-abc12345', key: ['user-1', 'user-2'] },
    { ...CR, segment: 'beta_users', environment: 'env-abc12345', keysFile: 'keys.txt' },
  ],
  run: async (input, ctx) => {
    const keys = await keysOf(ctx, input, 'add');
    // operationType CREATE adds the keys. https://docs.split.io/reference/create-change-request (Standard segments)
    return submitCr(ctx, input.environment, segmentCrBody(input, 'segment', 'CREATE', { name: input.segment, keys }));
  },
});

export const segmentRemoveKeysCommand = splitioArea.command({
  path: ['splitio', 'segment', 'remove-keys'],
  description: 'Submit a Change Request to remove keys from a segment in an environment',
  input: z.object(keysInput),
  writes: true,
  context: { workspace: 'required' },
  args: [segmentArg],
  options: keysOptions,
  examples: [
    { ...CR, segment: 'beta_users', environment: 'env-abc12345', key: ['user-1'] },
    { ...CR, segment: 'beta_users', environment: 'env-abc12345', keysFile: 'keys.txt' },
  ],
  run: async (input, ctx) => {
    const keys = await keysOf(ctx, input, 'remove');
    // operationType ARCHIVE removes the keys; Split keeps the name "for historical compatibility". https://docs.split.io/reference/create-change-request
    return submitCr(ctx, input.environment, segmentCrBody(input, 'segment', 'ARCHIVE', { name: input.segment, keys }));
  },
});

// ---- large segments ----

export const largeSegmentListCommand = splitioArea.command({
  path: ['splitio', 'large-segment', 'list'],
  description: 'List large segments in a workspace, or those enabled in one environment',
  input: z.object({ ...optionalEnvironment }),
  writes: false,
  context: { workspace: 'required' },
  options: [optionalEnvironmentOption],
  examples: [{ workspace: 'ws-abc12345' }, { workspace: 'ws-abc12345', environment: 'env-abc12345' }],
  run: async (input, ctx) => {
    // GET /large-segments/ws/{ws}, or .../environments/{env}, unpaged as the reference documents it (#79 item 17). https://docs.split.io/reference/listlargesegments, https://docs.split.io/reference/listlargesegmentsinenvironment
    const base = `/large-segments/ws/${seg(workspaceOf(ctx))}`;
    const body = await split<unknown>(ctx, input.environment ? `${base}/environments/${seg(input.environment)}` : base);
    const largeSegments = itemsOf(body, 'large segments');
    return { count: largeSegments.length, largeSegments };
  },
});

export const largeSegmentGetCommand = splitioArea.command({
  path: ['splitio', 'large-segment', 'get'],
  description: 'Get a large segment by name',
  input: z.object({ name: z.string().describe('Large segment name') }),
  writes: false,
  context: { workspace: 'required' },
  args: [{ name: 'name', field: 'name', description: 'Large segment name' }],
  examples: [{ workspace: 'ws-abc12345', name: 'all_customers' }],
  // GET /large-segments/ws/{ws}/{name}. https://docs.split.io/reference/getlargesegmentbyname
  run: async (input, ctx) => split<unknown>(ctx, `/large-segments/ws/${seg(workspaceOf(ctx))}/${seg(input.name)}`),
});

// ---- rule-based segments ----

const rbsField = { name: z.string().describe('Rule-based segment name') };
const rbsArg = { name: 'name', field: 'name', description: 'Rule-based segment name' };

export const ruleBasedSegmentListCommand = splitioArea.command({
  path: ['splitio', 'rule-based-segment', 'list'],
  description: 'List rule-based segments in a workspace, or those enabled in one environment',
  input: z.object({ ...optionalEnvironment }),
  writes: false,
  context: { workspace: 'required' },
  options: [optionalEnvironmentOption],
  examples: [{ workspace: 'ws-abc12345' }, { workspace: 'ws-abc12345', environment: 'env-abc12345' }],
  run: async (input, ctx) => {
    // GET /rule-based-segments/ws/{ws}, or .../environments/{env}, answered with { objects }, unpaged (#79 item 17).
    // https://docs.split.io/reference/get_internal-api-v2-rule-based-segments-ws-workspace-id
    const base = `/rule-based-segments/ws/${seg(workspaceOf(ctx))}`;
    const body = await split<unknown>(ctx, input.environment ? `${base}/environments/${seg(input.environment)}` : base);
    const ruleBasedSegments = itemsOf(body, 'rule-based segments');
    return { count: ruleBasedSegments.length, ruleBasedSegments };
  },
});

export const ruleBasedSegmentGetCommand = splitioArea.command({
  path: ['splitio', 'rule-based-segment', 'get'],
  description: 'Get a rule-based segment by name',
  input: z.object({ ...rbsField }),
  writes: false,
  context: { workspace: 'required' },
  args: [rbsArg],
  examples: [{ workspace: 'ws-abc12345', name: 'beta_testers' }],
  // GET /rule-based-segments/ws/{ws}/{name}. https://docs.split.io/reference/get_internal-api-v2-rule-based-segments-ws-workspace-id-rb-segment-name
  run: async (input, ctx) => split<unknown>(ctx, `/rule-based-segments/ws/${seg(workspaceOf(ctx))}/${seg(input.name)}`),
});

/** The fields of a rule-based segment definition a change request carries. */
const RBS_WRITABLE = ['rules', 'excludedKeys', 'excludedSegments'] as const;

export const ruleBasedSegmentUpdateCommand = splitioArea.command({
  path: ['splitio', 'rule-based-segment', 'update'],
  description: "Submit a Change Request to replace a rule-based segment's rules in an environment",
  input: z.object({
    ...rbsField,
    ...environmentField,
    inputFile: z.string().optional().describe('JSON file with the definition: rules, excludedKeys, excludedSegments; "-" = stdin on the CLI'),
    ...segmentCrFields,
    ...allowWriteField,
  }),
  writes: true,
  context: { workspace: 'required' },
  args: [rbsArg],
  options: [
    environmentOption,
    { flags: '--input-file <path>', field: 'inputFile', description: 'JSON file with the definition: rules, excludedKeys, excludedSegments; "-" = stdin on the CLI' },
    ...segmentCrOptions,
  ],
  examples: [{ ...CR, name: 'beta_testers', environment: 'env-abc12345', inputFile: 'rbs.json' }],
  run: async (input, ctx) => {
    if (!input.inputFile) {
      throw new ToilError('INVALID_INPUT', '--input-file is required for rule-based-segment update', { fix: 'Pass --input-file <path> with the definition as JSON: {"rules": [...], "excludedKeys": [], "excludedSegments": []}.' });
    }
    const definition = parseJson(await ctx.files.readText(input.inputFile), '--input-file', 'The file holds one JSON object: rules, excludedKeys and excludedSegments.');
    if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
      throw new ToilError('INVALID_INPUT', '--input-file must hold a JSON object: the rule-based segment definition.', { fix: 'Start from the output of toil splitio rule-based-segment get <name>.' });
    }
    // operationType UPDATE under ruleBasedSegment with the definition Split documents, and nothing else from the file:
    // get's output also carries title and comment, which belong to the segment, not to the request.
    // https://docs.split.io/reference/createrbschangerequest
    // A whole envelope saved from `get` on the CLI is unwrapped, as segment keys output is for add-keys.
    let record = definition as Record<string, unknown>;
    if ('ok' in record && typeof record.data === 'object' && record.data !== null && !Array.isArray(record.data)) record = record.data as Record<string, unknown>;
    const body: Record<string, unknown> = { name: input.name };
    for (const key of RBS_WRITABLE) if (record[key] !== undefined) body[key] = record[key];
    // A request carrying only the name would most likely clear the rules on approval, so it is never sent.
    if (Object.keys(body).length === 1) {
      throw new ToilError('INVALID_INPUT', '--input-file holds none of rules, excludedKeys or excludedSegments; no change request was filed.', {
        fix: 'Start from the output of toil splitio rule-based-segment get <name>, and keep its rules, excludedKeys and excludedSegments.',
      });
    }
    return submitCr(ctx, input.environment, segmentCrBody(input, 'ruleBasedSegment', 'UPDATE', body));
  },
});

export const segmentsCommands = [
  segmentListCommand,
  segmentKeysCommand,
  segmentAddKeysCommand,
  segmentRemoveKeysCommand,
  largeSegmentListCommand,
  largeSegmentGetCommand,
  ruleBasedSegmentListCommand,
  ruleBasedSegmentGetCommand,
  ruleBasedSegmentUpdateCommand,
];
