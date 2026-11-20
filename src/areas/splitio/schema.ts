import { z } from 'zod';
import { splitioArea } from './area.js';
import { intText, itemsOf, parseIntText, seg, split, splitV3, workspaceOf } from './client.js';

/**
 * The workspace's own vocabulary: flag sets, traffic types, the attributes
 * a traffic type carries, and the rollout statuses a change request may set.
 * Each is a list someone set up once and everyone else has to look up, which
 * is the natural habitat of a reference table.
 */

/** A page of one of Split's marker-paged lists: `{ data, nextMarker, previousMarker }`. */
interface MarkerPage {
  data?: unknown[];
  nextMarker?: string | null;
  previousMarker?: string | null;
}

/** A marker of "" means the last page, as null does: Split's own example sends "" for both. */
const marker = (value: string | null | undefined) => (value ? value : null);

export const flagSetListCommand = splitioArea.command({
  path: ['splitio', 'flag-set', 'list'],
  description: 'List flag sets in a workspace',
  input: z.object({
    limit: intText.optional().describe('Maximum number of flag sets to return, up to 200 (default: "200")'),
    cursor: z.string().optional().describe('meta.page.nextCursor from the previous page'),
  }),
  writes: false,
  context: { workspace: 'required' },
  options: [
    { flags: '--limit <n>', field: 'limit', description: 'Maximum number of flag sets to return, up to 200 (default: "200")' },
    { flags: '--cursor <cursor>', field: 'cursor', description: 'meta.page.nextCursor from the previous page' },
  ],
  examples: [{ workspace: 'ws-abc12345' }, { workspace: 'ws-abc12345', limit: '20', cursor: 'marker-abc12345' }],
  run: async (input, ctx) => {
    const limit = parseIntText(input.limit, '200');
    // GET /internal/api/v3/flag-sets?workspace_id&limit&after, answered with { data, nextMarker, previousMarker, limit, count }.
    // https://docs.split.io/reference/list-flag-sets
    const body = await splitV3<MarkerPage>(ctx, '/flag-sets', {
      query: { workspace_id: workspaceOf(ctx), limit, ...(input.cursor ? { after: input.cursor } : {}) },
    });
    const flagSets = itemsOf(body, 'flag sets');
    const nextMarker = marker(body.nextMarker);
    ctx.setPage({ nextCursor: nextMarker, limit });
    // Split reports this page's count, not a total, so totalCount is null rather than a guess.
    return { count: flagSets.length, totalCount: null, flagSets, nextMarker, previousMarker: marker(body.previousMarker) };
  },
});

export const flagSetGetCommand = splitioArea.command({
  path: ['splitio', 'flag-set', 'get'],
  description: 'Get a flag set by ID',
  input: z.object({ id: z.string().describe('Flag set ID') }),
  writes: false,
  args: [{ name: 'id', field: 'id', description: 'Flag set ID' }],
  examples: [{ id: 'abc12345-0000-0000-0000-000000000000' }],
  // GET /internal/api/v3/flag-sets/{id}; no workspace in the path. https://docs.split.io/reference/get-flag-set-by-id
  run: async (input, ctx) => splitV3<unknown>(ctx, `/flag-sets/${seg(input.id)}`),
});

export const trafficTypeListCommand = splitioArea.command({
  path: ['splitio', 'traffic-type', 'list'],
  description: 'List traffic types in a workspace',
  input: z.object({}),
  writes: false,
  context: { workspace: 'required' },
  examples: [{ workspace: 'ws-abc12345' }],
  run: async (_input, ctx) => {
    // GET /trafficTypes/ws/{ws}, a bare array. https://docs.split.io/reference/get-traffic-types
    const trafficTypes = itemsOf(await split<unknown>(ctx, `/trafficTypes/ws/${seg(workspaceOf(ctx))}`), 'traffic types');
    return { count: trafficTypes.length, trafficTypes };
  },
});

export const attributeListCommand = splitioArea.command({
  path: ['splitio', 'attribute', 'list'],
  description: 'List the attributes of a traffic type',
  input: z.object({
    trafficType: z.string().describe('Traffic type ID'),
    prefix: z.string().optional().describe('Only attributes whose ID starts with this, in any letter case (Split searches on the server)'),
    limit: intText.optional().describe('Maximum number of attributes to return, up to 200 (default: "50")'),
    cursor: z.string().optional().describe('meta.page.nextCursor from the previous page'),
  }),
  writes: false,
  context: { workspace: 'required' },
  options: [
    { flags: '--traffic-type <id>', field: 'trafficType', description: 'Traffic type ID' },
    { flags: '--prefix <text>', field: 'prefix', description: 'Only attributes whose ID starts with this, in any letter case (Split searches on the server)' },
    { flags: '--limit <n>', field: 'limit', description: 'Maximum number of attributes to return, up to 200 (default: "50")' },
    { flags: '--cursor <cursor>', field: 'cursor', description: 'meta.page.nextCursor from the previous page' },
  ],
  examples: [
    { workspace: 'ws-abc12345', trafficType: 'tt-abc12345' },
    { workspace: 'ws-abc12345', trafficType: 'tt-abc12345', prefix: 'plan', limit: '20', cursor: 'marker-abc12345' },
  ],
  run: async (input, ctx) => {
    const limit = parseIntText(input.limit, '50');
    // GET /schema/ws/{ws}/trafficTypes/{tt}?Paginate=true&markerLimit&afterMarker&searchPrefix, answered with { data, nextMarker, previousMarker, limit, count }.
    // The unpaged form is deprecated, so toil always asks for pages; Paginate's capital P is #79 item 16, kept. https://docs.split.io/reference/get-attributes
    const body = await split<MarkerPage>(ctx, `/schema/ws/${seg(workspaceOf(ctx))}/trafficTypes/${seg(input.trafficType)}`, {
      query: { Paginate: 'true', markerLimit: limit, ...(input.cursor ? { afterMarker: input.cursor } : {}), ...(input.prefix ? { searchPrefix: input.prefix } : {}) },
    });
    const attributes = itemsOf(body, 'attributes');
    const nextMarker = marker(body.nextMarker);
    ctx.setPage({ nextCursor: nextMarker, limit });
    return { count: attributes.length, totalCount: null, attributes, nextMarker, previousMarker: marker(body.previousMarker) };
  },
});

export const rolloutStatusListCommand = splitioArea.command({
  path: ['splitio', 'rollout-status', 'list'],
  description: 'List the rollout statuses a Change Request can set (--rollout-status)',
  input: z.object({}),
  writes: false,
  context: { workspace: 'required' },
  examples: [{ workspace: 'ws-abc12345' }],
  run: async (_input, ctx) => {
    // GET /rolloutStatuses?wsId={ws}, a bare array of { id, name, description }. https://docs.split.io/reference/get-rollout-statuses
    const rolloutStatuses = itemsOf(await split<unknown>(ctx, '/rolloutStatuses', { query: { wsId: workspaceOf(ctx) } }), 'rollout statuses');
    return { count: rolloutStatuses.length, rolloutStatuses };
  },
});

export const schemaCommands = [flagSetListCommand, flagSetGetCommand, trafficTypeListCommand, attributeListCommand, rolloutStatusListCommand];
