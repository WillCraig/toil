import { z } from 'zod';
import { ToilError } from '../../../core/errors.js';
import { allowWriteField } from '../../../core/run.js';
import { adoMoves, intentOf, oneOfTransition, resolveTransition, type AdoState, type TransitionReport } from '../../../core/transition-intent.js';
import { adoArea } from '../area.js';
import { isConflict } from '../categorize.js';
import { API_COMMENTS, IN_PROJECT, PATCH, adoc, bodyTokenPages, cursorField, enc, exampleCursor, feedRevisions, limitField, pageOf, pageOptions, projectPath, repoPath, skipPages, type AdoCloudContext } from './client.js';
import { FEED_FIELDS, FEED_SINCE, REVISIONS_DESCRIPTION, fieldList, revisionsInput } from '../feed.js';
import { fieldPatch, parseFieldArgs, type JsonPatchOp } from './fields.js';
import { andWhere, checkFlat, wiqlInstant } from './wiql.js';

/**
 * Work items: read one or a batch, create and update them, query with WIQL,
 * walk their revisions and comments, and read the iteration tree. Every
 * change is a JSON Patch, so even a new title arrives as an amendment to the
 * record. A work item lives in the organization, not a project, so reading
 * or changing one by id needs no --project; creating, querying and commenting do.
 */

export const at = { project: 'Imagile' };
/** Both group inputs, set on one example of each command so the parity suite covers them; a command that doesn't use one ignores it. */
const all = { ...at, repo: 'imagile-api' };
const W = { ...at, allowWrite: true };
const id = z.number().int().positive().describe('Work item ID');
const idArg = { name: 'id', field: 'id', description: 'Work item ID' };

export interface WorkItem {
  id: number;
  rev?: number;
  fields: Record<string, unknown>;
  [key: string]: unknown;
}

const workItemPath = (n: number) => `/_apis/wit/workitems/${enc(n)}`;
/** What resolving `--to` needs to know about a work item: its type, state and project. */
const STATE_FIELDS = 'System.WorkItemType,System.State,System.TeamProject';

export const workGetCommand = adoArea.command({
  path: ['ado', 'work-item', 'get'],
  description: 'Get a work item by ID',
  toolDescription: 'Returns one work item by id with every field, its relations and links ($expand=all). Needs no project.',
  input: z.object({ id }),
  writes: false,
  args: [idArg],
  examples: [{ id: 42 }, { ...all, id: 7 }],
  run: (input, ctx) => adoc<WorkItem>(ctx, workItemPath(input.id), { query: { $expand: 'all' } }),
});

const fieldInput = z.array(z.string()).optional().describe('Field as name=value, by reference name or alias (repeatable)');
const fieldOption = { flags: '--field <name=value>', field: 'field', description: 'Field as name=value, by reference name or alias (repeatable)' };

export const workCreateCommand = adoArea.command({
  path: ['ado', 'work-item', 'create'],
  description: 'Create a work item',
  toolDescription:
    'Creates a work item of a type in the project and returns it as created. Title, description, assignee and priority have flags; any other field goes in field as name=value, by reference name (Microsoft.VSTS.Scheduling.StoryPoints) or alias (storypoints).',
  input: z.object({
    type: z.string().min(1).describe('Work item type (e.g. Bug, Task, User Story)'),
    title: z.string().min(1).describe('Work item title'),
    description: z.string().optional().describe('Description (HTML)'),
    assignee: z.string().optional().describe('Assigned to (email or display name)'),
    priority: z.number().int().optional().describe('Priority (1-4)'),
    field: fieldInput,
    ...allowWriteField,
  }),
  writes: true,
  context: IN_PROJECT,
  options: [
    { flags: '--type <type>', field: 'type', description: 'Work item type (e.g. Bug, Task, User Story)' },
    { flags: '--title <title>', field: 'title', description: 'Work item title' },
    { flags: '--description <text>', field: 'description', description: 'Description (HTML)' },
    { flags: '--assignee <user>', field: 'assignee', description: 'Assigned to (email or display name)' },
    { flags: '--priority <n>', field: 'priority', description: 'Priority (1-4)' },
    fieldOption,
  ],
  examples: [
    { ...W, repo: 'imagile-api', type: 'Bug', title: 'Login broken' },
    { ...W, type: 'User Story', title: 'Sign in with a passkey', description: '<p>As a user</p>', assignee: 'you@example.com', priority: 2, field: ['storypoints=3', 'MyOrg.Team=Core'] },
  ],
  run: async (input, ctx) => {
    const fields: Record<string, unknown> = {
      'System.Title': input.title,
      ...(input.description ? { 'System.Description': input.description } : {}),
      ...(input.assignee ? { 'System.AssignedTo': input.assignee } : {}),
      ...(input.priority !== undefined ? { 'Microsoft.VSTS.Common.Priority': input.priority } : {}),
    };
    const patch: JsonPatchOp[] = [...fieldPatch(fields), ...fieldPatch(parseFieldArgs(input.field ?? []), ctx.connection.fieldAliases)];
    // The type is a path segment with a $ in front, which is how the API tells it from an id.
    return adoc<WorkItem>(ctx, `${projectPath(ctx)}/_apis/wit/workitems/${enc(`$${input.type}`)}`, { method: 'POST', json: patch, headers: PATCH });
  },
});

export const workUpdateCommand = adoArea.command({
  path: ['ado', 'work-item', 'update'],
  description: 'Update work item fields',
  toolDescription:
    'Sets fields on a work item (field as name=value, by reference name or alias: state=Active, Microsoft.VSTS.Scheduling.StoryPoints=5) in one JSON Patch and returns the updated item. With rev, the change is refused if the item has moved past that revision. Needs no project.',
  input: z.object({
    id,
    field: z.array(z.string()).min(1).describe('Field to set as name=value (repeatable)'),
    rev: z.number().int().positive().optional().describe("Refuse the change unless the item's revision is still this one"),
    ...allowWriteField,
  }),
  writes: true,
  args: [idArg],
  options: [{ flags: '--field <name=value>', field: 'field', description: 'Field to set as name=value (repeatable)' }, { flags: '--rev <n>', field: 'rev', description: "Refuse the change unless the item's revision is still this one" }],
  examples: [
    { ...W, id: 42, field: ['state=Active', 'storypoints=5'] },
    { ...W, repo: 'imagile-api', id: 42, field: ['System.Title=Login broken on Safari'], rev: 3 },
  ],
  run: async (input, ctx) => {
    // A `test` operation first: the server rejects the whole patch if the revision moved.
    const patch: JsonPatchOp[] = [...(input.rev !== undefined ? [{ op: 'test' as const, path: '/rev', value: input.rev }] : []), ...fieldPatch(parseFieldArgs(input.field), ctx.connection.fieldAliases)];
    return adoc<WorkItem>(ctx, workItemPath(input.id), { method: 'PATCH', json: patch, headers: PATCH });
  },
});

/** What a transition's errors name: the exact flag, and where a toil project pins an intent for a type. */
const TRANSITION_HELP = { explicit: '--state <state>', pinKey: 'ado.transitions' };

export const workTransitionCommand = adoArea.command({
  path: ['ado', 'work-item', 'transition'],
  description: 'Set the state of a work item',
  toolDescription:
    "Sets System.State on a work item and returns it. Give state with an exact state, or to with an intent (start, review, done, reopen) or a state name, and toil resolves it against the states this item's own type has: a pin in the toil project first, then an exact state name, then the intent's state category (start InProgress, review Resolved, done Completed, reopen Proposed), then a single state named for it. No match, or more than one, is refused with the states the type does have; meta.transition says what it resolved to. Needs no project. ado_work_item_states lists the states a type has.",
  input: z.object({
    id,
    state: z.string().min(1).optional().describe('New state (e.g. Active, Resolved, Closed)'),
    to: z.string().min(1).optional().describe("Intent (start, review, done, reopen) or state name, resolved against this work item type's states"),
    ...allowWriteField,
  }),
  writes: true,
  args: [idArg],
  options: [
    { flags: '--state <state>', field: 'state', description: 'New state (e.g. Active, Resolved, Closed)' },
    { flags: '--to <intent-or-status>', field: 'to', description: "start, review, done, reopen or a state name, resolved against this work item type's states" },
  ],
  examples: [
    { ...W, id: 42, state: 'Resolved' },
    // The fixture's Bug is Scrum's, captured, which has no review state: done resolves.
    { ...all, allowWrite: true, id: 42, to: 'done' },
  ],
  run: async (input, ctx) => {
    if ((input.to === undefined) === (input.state === undefined)) throw oneOfTransition(TRANSITION_HELP, input.to !== undefined);
    let state = input.state!;
    let report: TransitionReport | undefined;
    if (input.to !== undefined) {
      const item = await adoc<WorkItem>(ctx, workItemPath(input.id), { query: { fields: STATE_FIELDS } });
      // A work item lives in the organization; its type's states live in its own project.
      const project = String(item.fields['System.TeamProject'] ?? '');
      const type = String(item.fields['System.WorkItemType'] ?? '');
      const states = await adoc<{ value?: AdoState[] }>(ctx, `/${enc(project)}/_apis/wit/workitemtypes/${enc(type)}/states`);
      const { item: moving, candidates } = adoMoves(input.id, item.fields, states.value ?? []);
      const resolved = resolveTransition(input.to, moving, candidates, intentOf(input.to) ? ctx.toilProjectTransitions() : {}, TRANSITION_HELP);
      state = resolved.candidate.id;
      report = resolved.report;
    }
    const updated = await adoc<WorkItem>(ctx, workItemPath(input.id), { method: 'PATCH', json: [{ op: 'add', path: '/fields/System.State', value: state }], headers: PATCH });
    if (report) ctx.setTransition(report);
    return updated;
  },
});

/** The most work items one WIQL query returns; a query matching more is refused by the server. */
export const WIQL_MAX = 20_000;
const UPDATED_SINCE =
  'Only work items changed at or after this ISO 8601 instant: a date (UTC midnight) or a date-time with its zone. ANDed onto the query as [System.ChangedDate] >= it. Turns on time precision for the whole query, so = on a date field matches one exact instant: use >= and < instead';

interface WiqlResult {
  workItems?: unknown[];
  [key: string]: unknown;
}

export const workSearchCommand = adoArea.command({
  path: ['ado', 'work-item', 'search'],
  description: 'Run a WIQL query (consider --output-file for large results)',
  toolDescription:
    "Runs a WIQL query in the project and returns the server's answer: the matching work item ids and urls (workItems), not their fields. Fetch fields with ado_work_item_get_many. updatedSince (an ISO 8601 date or zoned date-time) ANDs [System.ChangedDate] >= it onto a flat query and turns on time precision for the whole query, so = on any date field then matches one exact instant: write date conditions with >= and < instead. With limit, workItems holds at most that many; pass meta.page.nextCursor as cursor for the next page, which runs the query again.",
  input: z.object({
    wiql: z.string().min(1).describe('WIQL query string'),
    updatedSince: z.string().optional().describe(UPDATED_SINCE),
    limit: limitField('work items'),
    cursor: cursorField,
  }),
  writes: false,
  // The query goes in a POST body, as WIQL's endpoint requires; nothing is written.
  queryByPost: true,
  context: IN_PROJECT,
  options: [
    { flags: '--wiql <query>', field: 'wiql', description: 'WIQL query string' },
    { flags: '--updated-since <iso>', field: 'updatedSince', description: UPDATED_SINCE },
    ...pageOptions('work items'),
  ],
  examples: [
    { ...at, wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'Active'" },
    { ...at, wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'Active' OR [System.State] = 'New' ORDER BY [System.ChangedDate]", updatedSince: '2026-10-01T09:00:00Z' },
    { ...all, wiql: 'SELECT [System.Id] FROM WorkItems', limit: 1 },
    { ...at, wiql: 'SELECT [System.Id] FROM WorkItems', limit: 1, cursor: '1' },
  ],
  run: async (input, ctx) => {
    const page = pageOf(input);
    if (page.cursor !== undefined && !/^\d+$/.test(page.cursor)) {
      throw new ToilError('INVALID_INPUT', `"${page.cursor}" isn't a cursor this command hands out.`, { fix: 'Pass meta.page.nextCursor from the previous page unchanged, or leave out --cursor to start at the beginning.' });
    }
    const offset = page.cursor === undefined ? 0 : Number(page.cursor);
    let wiql = input.wiql;
    if (input.updatedSince !== undefined) wiql = andWhere(wiql, `[System.ChangedDate] >= '${wiqlInstant(input.updatedSince)}'`);
    else if (page.cap !== undefined) checkFlat(wiql);
    const query: Record<string, string | number> = {};
    if (page.cap !== undefined) {
      // One more than the page, so the answer says whether another page exists.
      const top = offset + page.cap + 1;
      if (top > WIQL_MAX) {
        throw new ToilError('INVALID_INPUT', `A WIQL query returns at most ${WIQL_MAX} work items, and this page would end at ${offset + page.cap}.`, {
          fix: 'Narrow the query (--updated-since, or a tighter WHERE clause) so it matches fewer work items.',
        });
      }
      query.$top = top;
    }
    // A time in the literal needs time precision; without it the server refuses the query.
    if (input.updatedSince !== undefined) query.timePrecision = 'true';
    const result = await adoc<WiqlResult>(ctx, `${projectPath(ctx)}/_apis/wit/wiql`, { method: 'POST', query, json: { query: wiql } });
    if (page.cap === undefined) return result;
    const all = result.workItems ?? [];
    ctx.setPage({ nextCursor: all.length > offset + page.cap ? String(offset + page.cap) : null, limit: page.cap });
    return { ...result, workItems: all.slice(offset, offset + page.cap) };
  },
});

const REVISIONS_PAGE = 100;

export const workRevisionsCommand = adoArea.command({
  path: ['ado', 'work-item', 'history'],
  description: 'List the revisions of a work item, oldest first',
  toolDescription:
    'Lists every revision of a work item, oldest first: each is the whole work item as it stood after that change (id, rev, fields, url), so comparing neighbours gives the history of states, assignees and other fields. Needs no project. With limit, returns at most that many; pass meta.page.nextCursor as cursor for the next page.',
  input: z.object({ id, limit: limitField('revisions'), cursor: cursorField }),
  writes: false,
  args: [idArg],
  options: pageOptions('revisions'),
  examples: [{ id: 42 }, { ...all, id: 42, limit: 1 }, { id: 42, limit: 1, cursor: exampleCursor('1', REVISIONS_PAGE) }],
  run: (input, ctx) => skipPages(ctx, `/_apis/wit/workItems/${enc(input.id)}/revisions`, {}, REVISIONS_PAGE, `revisions of Azure DevOps work item ${input.id}`, pageOf(input)),
});

export const workFeedCommand = adoArea.command({
  path: ['ado', 'work-item', 'feed'],
  description: 'The project\'s change feed: every work item\'s revisions since a date, as one list (work-item history is the revisions of one item)',
  toolDescription: REVISIONS_DESCRIPTION,
  input: z.object({ ...revisionsInput, limit: limitField('revisions'), cursor: cursorField }),
  writes: false,
  // Every revision of the project can be a long read, and a long read is the work, not a hang: --limit is the way to stop early.
  timeLimitMs: 600_000,
  context: IN_PROJECT,
  options: [
    { flags: '--updated-since <iso>', field: 'updatedSince', description: FEED_SINCE },
    { flags: '--fields <names>', field: 'fields', description: FEED_FIELDS },
    ...pageOptions('revisions'),
  ],
  examples: [
    { ...at },
    { ...all, updatedSince: '2026-10-01T09:00:00Z', fields: 'System.State, System.IterationPath' },
    { ...at, limit: 1 },
    { ...at, limit: 1, cursor: exampleCursor('813;42;2') },
  ],
  run: (input, ctx) => {
    const page = pageOf(input);
    const fields = fieldList(input.fields);
    // Every request names the same fields; startDateTime goes on the first only (feed.ts).
    return feedRevisions(ctx, `${projectPath(ctx)}/_apis/wit/reporting/workitemrevisions`, fields ? { fields } : {}, input.updatedSince === undefined ? undefined : wiqlInstant(input.updatedSince), `revisions of the work items in Azure DevOps project ${ctx.context.project}`, page);
  },
});

/** The most ids the batch endpoint takes in one request. */
export const BATCH_SIZE = 200;
/** The most ids one get-many call takes: five requests, then a bound rather than a loop. */
export const BATCH_MAX = 1000;

export const workGetBatchCommand = adoArea.command({
  path: ['ado', 'work-item', 'get-many'],
  description: 'Get several work items by ID in one call',
  toolDescription: `Returns several work items by id through the batch endpoint, ${BATCH_SIZE} per request, at most ${BATCH_MAX} ids: { count, value, missing }. value holds the items found, in the order asked, with every field and relation unless fields names the ones to return; missing lists each id that doesn't exist or the token can't see, with an ADO_WORK_ITEMS_MISSING warning. Needs no project.`,
  input: z.object({
    id: z.array(z.number().int().positive()).min(1).describe('Work item IDs'),
    fields: z.string().optional().describe('Comma-separated field reference names to return (default: every field, with relations)'),
  }),
  writes: false,
  // The ids go in a POST body, as the batch endpoint requires; nothing is written.
  queryByPost: true,
  args: [{ name: 'id', field: 'id', description: 'Work item IDs', variadic: true }],
  options: [
    { flags: '--fields <names>', field: 'fields', description: 'Comma-separated field reference names to return (default: every field, with relations)' },
  ],
  examples: [{ ...all, id: [42, 7] }, { id: [42, 404], fields: 'System.Title, System.State' }],
  run: async (input, ctx) => {
    const ids = [...new Set(input.id)];
    if (ids.length > BATCH_MAX) {
      throw new ToilError('INVALID_INPUT', `get-many takes at most ${BATCH_MAX} work item ids in one call, and this one has ${ids.length}.`, { fix: `Split the ids into calls of ${BATCH_MAX} or fewer.` });
    }
    const fields = input.fields?.split(',').map((f) => f.trim()).filter(Boolean);
    const found = new Map<number, WorkItem>();
    for (let start = 0; start < ids.length; start += BATCH_SIZE) {
      // Omit: an id that doesn't exist or can't be seen comes back null (or not at all) rather than failing the whole batch.
      const json = { ids: ids.slice(start, start + BATCH_SIZE), ...(fields?.length ? { fields } : { $expand: 'all' }), errorPolicy: 'omit' };
      const result = await adoc<{ value?: Array<WorkItem | null> }>(ctx, '/_apis/wit/workitemsbatch', { method: 'POST', json });
      for (const item of result.value ?? []) if (item && typeof item.id === 'number') found.set(item.id, item);
    }
    const value = ids.filter((n) => found.has(n)).map((n) => found.get(n)!);
    const missing = ids.filter((n) => !found.has(n));
    if (missing.length > 0) ctx.warn({ code: 'ADO_WORK_ITEMS_MISSING', message: `No work item with id ${missing.join(', ')}, or the token can't see ${missing.length === 1 ? 'it' : 'them'}.` });
    return { count: value.length, value, missing };
  },
});

/** Comments per request: the page size toil asks for; the server may send fewer and a continuation token. */
const COMMENTS_PAGE = 200;

export const workListCommentsCommand = adoArea.command({
  path: ['ado', 'work-item', 'comments'],
  description: 'List comments on a work item',
  toolDescription:
    "Lists every comment on a work item in the server's order (newest first in Microsoft's examples): id, text, createdBy, createdDate, modifiedDate, following continuation tokens to the end. With limit, returns at most that many; pass meta.page.nextCursor as cursor for the next page.",
  input: z.object({ id, limit: limitField('comments'), cursor: cursorField }),
  writes: false,
  context: IN_PROJECT,
  args: [idArg],
  options: pageOptions('comments'),
  examples: [{ ...at, id: 42 }, { ...all, id: 42, limit: 1 }, { ...at, id: 42, limit: 1, cursor: exampleCursor('abc12345') }],
  run: (input, ctx) =>
    bodyTokenPages(
      ctx,
      `${projectPath(ctx)}/_apis/wit/workItems/${enc(input.id)}/comments`,
      { $top: COMMENTS_PAGE, 'api-version': API_COMMENTS },
      (body) => (body as { comments?: unknown[] }).comments ?? [],
      `comments on Azure DevOps work item ${input.id}`,
      pageOf(input),
    ),
});

export const workAddCommentCommand = adoArea.command({
  path: ['ado', 'work-item', 'comment'],
  description: 'Add a comment to a work item',
  toolDescription: 'Adds a comment (HTML or plain text) to a work item and returns it.',
  input: z.object({ id, body: z.string().min(1).describe('Comment text'), ...allowWriteField }),
  writes: true,
  context: IN_PROJECT,
  args: [idArg],
  options: [{ flags: '--body <text>', field: 'body', description: 'Comment text' }],
  examples: [{ ...W, repo: 'imagile-api', id: 42, body: 'Looked into it.' }],
  run: (input, ctx) => adoc(ctx, `${projectPath(ctx)}/_apis/wit/workItems/${enc(input.id)}/comments`, { method: 'POST', query: { 'api-version': API_COMMENTS }, json: { text: input.body } }),
});

// Written for Services from the Classification Nodes reference
// (https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/classification-nodes/get-classification-node),
// to match Server's recorded command: the same path, flag and wording, the area tree where iterations has its dates.
export const workListAreasCommand = adoArea.command({
  path: ['ado', 'work-item', 'areas'],
  description: 'List classification areas for the team project (tree)',
  toolDescription: "Returns the project's area-path tree, to the given depth (10 by default).",
  input: z.object({ depth: z.number().int().min(0).optional().describe('Depth of the tree to retrieve (default: "10")') }),
  writes: false,
  context: IN_PROJECT,
  options: [{ flags: '--depth <n>', field: 'depth', description: 'Depth of the area tree to retrieve (default: "10")' }],
  examples: [at, { ...all, depth: 2 }],
  run: (input, ctx) => adoc(ctx, `${projectPath(ctx)}/_apis/wit/classificationnodes/areas`, { query: { $depth: input.depth ?? 10 } }),
});

const DEPTH = 'Depth of the iteration tree to retrieve (default: 10)';

export const workListIterationsCommand = adoArea.command({
  path: ['ado', 'work-item', 'iterations'],
  description: 'List the iteration tree for the project, with start and finish dates',
  toolDescription: "Returns the project's iteration tree (classification nodes) with start and finish dates, to the given depth (10 by default).",
  input: z.object({ depth: z.number().int().min(0).optional().describe(DEPTH) }),
  writes: false,
  context: IN_PROJECT,
  options: [{ flags: '--depth <n>', field: 'depth', description: DEPTH }],
  examples: [at, { ...all, depth: 2 }],
  run: (input, ctx) => adoc(ctx, `${projectPath(ctx)}/_apis/wit/classificationnodes/iterations`, { query: { $depth: input.depth ?? 10 } }),
});

export const workListStatesCommand = adoArea.command({
  path: ['ado', 'work-item', 'states'],
  description: 'List valid states for a work item type',
  toolDescription:
    "Lists the states a work item type has in the project's process (name, color, category), in workflow order. category (Proposed, InProgress, Resolved, Completed, Removed) is how a custom state is classified. A type the project doesn't have returns no states, with an ADO_TYPE_UNKNOWN warning.",
  input: z.object({ type: z.string().min(1).describe('Work item type name (e.g. Bug)') }),
  writes: false,
  context: IN_PROJECT,
  options: [{ flags: '--type <type>', field: 'type', description: 'Work item type name (e.g. Bug)' }],
  examples: [{ ...at, type: 'Bug' }, { ...all, type: 'Product Backlog Item' }],
  run: async (input, ctx) => {
    const states = (await adoc<{ value?: unknown[] }>(ctx, `${projectPath(ctx)}/_apis/wit/workitemtypes/${enc(input.type)}/states`)).value ?? [];
    // The server answers an unknown type with an empty list rather than a 404, so say so.
    if (states.length === 0) ctx.warn({ code: 'ADO_TYPE_UNKNOWN', message: `Project "${ctx.context.project}" has no states for work item type "${input.type}", which usually means it has no such type. The project's types are at GET <project>/_apis/wit/workitemtypes (ado api).` });
    return states;
  },
});

export const workAssignCommand = adoArea.command({
  path: ['ado', 'work-item', 'assign'],
  description: 'Assign a work item to a user',
  toolDescription: 'Sets System.AssignedTo on a work item (display name or email) and returns it.',
  input: z.object({ id, assignee: z.string().describe('User display name or email'), ...allowWriteField }),
  writes: true,
  args: [idArg],
  options: [{ flags: '--assignee <user>', field: 'assignee', description: 'User display name or email' }],
  examples: [{ ...W, repo: 'imagile-api', id: 42, assignee: 'you@example.com' }],
  run: (input, ctx) => adoc<WorkItem>(ctx, workItemPath(input.id), { method: 'PATCH', json: fieldPatch({ 'System.AssignedTo': input.assignee }), headers: PATCH }),
});

/** Link type words to Azure DevOps relation names, as Server's command reads them; anything else is sent as a relation name. */
const REL: Record<string, string> = {
  related: 'System.LinkTypes.Related',
  parent: 'System.LinkTypes.Hierarchy-Reverse',
  child: 'System.LinkTypes.Hierarchy-Forward',
  duplicate: 'System.LinkTypes.Duplicate-Forward',
  'duplicate-of': 'System.LinkTypes.Duplicate-Reverse',
};
const LINK_TYPE = 'Link type (related|parent|child|duplicate|duplicate-of) (default: "related")';
const LINK_PR = 'Pull request ID in --repo to link instead of a work item';

interface Repository {
  id: string;
  project: { id: string };
}

export const workLinkCommand = adoArea.command({
  path: ['ado', 'work-item', 'link'],
  description: 'Link a work item to another work item or a pull request',
  toolDescription:
    'Adds a relation from one work item to another (target; related by default, or parent, child, duplicate, duplicate-of, or a raw relation name), or to a pull request in the repository (pr), and returns the source item. Give target or pr, not both.',
  input: z.object({
    id: id.describe('Source work item ID'),
    // Text, as Server's recorded flag is: the one MCP tool's schema for a shared field is Server's, so an MCP caller sends a string, and the number is checked here.
    target: z.string().optional().describe('Target work item ID'),
    type: z.string().optional().describe(LINK_TYPE),
    pr: z.number().int().positive().optional().describe(LINK_PR),
    ...allowWriteField,
  }),
  writes: true,
  args: [{ name: 'id', field: 'id', description: 'Source work item ID' }],
  options: [
    { flags: '--target <id>', field: 'target', description: 'Target work item ID' },
    { flags: '--type <rel>', field: 'type', description: LINK_TYPE },
    { flags: '--pr <id>', field: 'pr', description: LINK_PR },
  ],
  examples: [
    { ...W, id: 42, target: '7' },
    { ...all, allowWrite: true, id: 42, target: '8', type: 'child' },
    { ...all, allowWrite: true, id: 42, pr: 44 },
  ],
  run: async (input, ctx) => {
    if ((input.target === undefined) === (input.pr === undefined)) {
      throw new ToilError('INVALID_INPUT', input.pr === undefined ? 'Nothing to link to' : 'Give --target or --pr, not both', {
        fix: 'Pass --target <work item id> to link two work items, or --pr <pull request id> with --repo to link a pull request.',
      });
    }
    if (input.pr === undefined) {
      if (!/^\d+$/.test(input.target!.trim())) throw new ToilError('INVALID_INPUT', `--target "${input.target}" isn't a work item ID`, { fix: 'Pass the target work item\'s number, e.g. --target 7.' });
      const type = input.type ?? 'related';
      const url = `${ctx.connection.baseUrl.replace(/\/+$/, '')}/_apis/wit/workItems/${enc(input.target!.trim())}`;
      return adoc<WorkItem>(ctx, workItemPath(input.id), { method: 'PATCH', json: [{ op: 'add', path: '/relations/-', value: { rel: REL[type] ?? type, url } }], headers: PATCH });
    }
    if (input.type !== undefined) throw new ToilError('INVALID_INPUT', '--type is for a link between work items', { fix: 'Leave out --type with --pr: a pull request link has one kind.' });
    const { project, repo } = ctx.context;
    if (!project || !repo) {
      throw new ToilError('INVALID_INPUT', 'Linking a pull request needs its repository', { fix: 'Pass --project <name> and --repo <name>, or set project and repo on the connection.' });
    }
    // An artifact link names the pull request by the ids of its project and repository, which the repository's own record holds.
    const repository = await adoc<Repository>(ctx, repoPath(ctx));
    const url = `vstfs:///Git/PullRequestId/${repository.project.id}%2F${repository.id}%2F${input.pr}`;
    return adoc<WorkItem>(ctx, workItemPath(input.id), {
      method: 'PATCH',
      json: [{ op: 'add', path: '/relations/-', value: { rel: 'ArtifactLink', url, attributes: { name: 'Pull Request' } } }],
      headers: PATCH,
    });
  },
});

export const workDeleteCommentCommand = adoArea.command({
  path: ['ado', 'work-item', 'delete-comment'],
  description: 'Delete a comment from a work item',
  toolDescription: 'Deletes one comment from a work item. CLI only.',
  input: z.object({ id, commentId: z.number().int().positive().describe('Comment ID'), ...allowWriteField }),
  writes: true,
  // A delete: CLI only, never an MCP tool (CLAUDE.md, Writes).
  mcp: false,
  context: IN_PROJECT,
  args: [idArg, { name: 'comment-id', field: 'commentId', description: 'Comment ID' }],
  examples: [{ ...W, repo: 'imagile-api', id: 42, commentId: 4 }],
  run: async (input, ctx) => {
    await adoc<void>(ctx, `${projectPath(ctx)}/_apis/wit/workItems/${enc(input.id)}/comments/${enc(input.commentId)}`, { method: 'DELETE', query: { 'api-version': API_COMMENTS } });
    return { deleted: true };
  },
});

const tagList = (tags: string) =>
  tags
    .split(/[;,]/)
    .map((t) => t.trim())
    .filter(Boolean);
const TAGS = 'System.Tags';

/** The tags a call names, refused when it names none: an empty list would quietly change nothing. */
function tagsAsked(text: string): string[] {
  const tags = tagList(text);
  if (tags.length === 0) throw new ToilError('INVALID_INPUT', 'No tags given.', { fix: 'Pass --tags with one or more tags, separated by ; or , (--tags "ui; backend").' });
  return tags;
}

/** A work item as it stands, with its tags and the revision a change is tested against. The whole item, so a call that changes nothing returns what a write would. */
async function tagsOf(ctx: AdoCloudContext, n: number): Promise<{ rev: number; tags: string[]; item: WorkItem }> {
  const item = await adoc<WorkItem>(ctx, workItemPath(n));
  if (typeof item.rev !== 'number') throw new ToilError('HTTP', `Azure DevOps returned work item ${n} with no revision, so a tag change can't be checked against it.`, { fix: 'Run it again; if it keeps happening, change the tags with ado work-item update.' });
  const tags = String(item.fields?.[TAGS] ?? '')
    .split(';')
    .map((t) => t.trim())
    .filter(Boolean);
  return { rev: item.rev, tags, item };
}

/**
 * Writes a work item's whole tag list in one JSON Patch, after a `test` of the revision it was read at, so a tag
 * someone added in between makes the server refuse the change rather than lose it. Azure DevOps reads `add` on
 * System.Tags as "add these", so taking a tag off needs `replace`, and the last one off needs `remove`. Nothing to
 * change sends nothing, and returns the item as read: a revision for no change is a form filed to say nothing happened.
 */
async function writeTags(ctx: AdoCloudContext, n: number, read: { rev: number; tags: string[]; item: WorkItem }, next: string[], removing: boolean): Promise<WorkItem> {
  if (next.length === read.tags.length && next.every((t, i) => t === read.tags[i])) return read.item;
  const op: JsonPatchOp = !removing ? { op: 'add', path: `/fields/${TAGS}`, value: next.join('; ') }
    : next.length === 0 ? { op: 'remove', path: `/fields/${TAGS}` }
    : { op: 'replace', path: `/fields/${TAGS}`, value: next.join('; ') };
  try {
    return await adoc<WorkItem>(ctx, workItemPath(n), { method: 'PATCH', json: [{ op: 'test', path: '/rev', value: read.rev }, op], headers: PATCH });
  } catch (err) {
    if (!isConflict(err)) throw err;
    throw new ToilError('HTTP', `Work item ${n} changed after toil read its tags (revision ${read.rev}), so the tag change wasn't made.`, { fix: 'Run the same command again: it reads the item afresh.' });
  }
}

export const workAddTagCommand = adoArea.command({
  path: ['ado', 'work-item', 'tag'],
  description: 'Add one or more tags to a work item (non-destructive)',
  toolDescription:
    "Adds tags to a work item, keeping the ones it has (matched ignoring case), and returns the item. It reads the tags, then writes the list with a test of the revision it read, so a change made in between is refused rather than lost. Tags it already has change nothing. Needs no project.",
  input: z.object({ id, tags: z.string().describe('Semicolon- or comma-separated tags to add'), ...allowWriteField }),
  writes: true,
  args: [idArg],
  options: [{ flags: '--tags <tags>', field: 'tags', description: 'Semicolon- or comma-separated tags to add' }],
  examples: [{ ...W, repo: 'imagile-api', id: 42, tags: 'ui; Backend,urgent' }],
  run: async (input, ctx) => {
    const asked = tagsAsked(input.tags);
    const read = await tagsOf(ctx, input.id);
    const have = new Set(read.tags.map((t) => t.toLowerCase()));
    const added: string[] = [];
    for (const t of asked) {
      if (have.has(t.toLowerCase())) continue;
      have.add(t.toLowerCase());
      added.push(t);
    }
    return writeTags(ctx, input.id, read, [...read.tags, ...added], false);
  },
});

export const workRemoveTagCommand = adoArea.command({
  path: ['ado', 'work-item', 'untag'],
  description: 'Remove one or more tags from a work item (non-destructive)',
  toolDescription:
    'Removes tags from a work item (matched ignoring case), keeping the rest, and returns the item. It reads the tags, then writes what is left with a test of the revision it read, so a change made in between is refused rather than lost. A tag the item does not have changes nothing. Needs no project.',
  input: z.object({ id, tags: z.string().describe('Semicolon- or comma-separated tags to remove'), ...allowWriteField }),
  writes: true,
  args: [idArg],
  options: [{ flags: '--tags <tags>', field: 'tags', description: 'Semicolon- or comma-separated tags to remove' }],
  examples: [{ ...W, repo: 'imagile-api', id: 42, tags: 'UI' }],
  run: async (input, ctx) => {
    const drop = new Set(tagsAsked(input.tags).map((t) => t.toLowerCase()));
    const read = await tagsOf(ctx, input.id);
    return writeTags(ctx, input.id, read, read.tags.filter((t) => !drop.has(t.toLowerCase())), true);
  },
});

export const workCommands = [workGetCommand, workCreateCommand, workUpdateCommand, workTransitionCommand, workSearchCommand, workRevisionsCommand, workFeedCommand, workGetBatchCommand, workListCommentsCommand, workAddCommentCommand, workListAreasCommand, workListIterationsCommand, workListStatesCommand, workAssignCommand, workLinkCommand, workDeleteCommentCommand, workAddTagCommand, workRemoveTagCommand];
