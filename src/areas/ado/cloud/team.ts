import { z } from 'zod';
import { ToilError } from '../../../core/errors.js';
import { allowWriteField } from '../../../core/run.js';
import { adoArea } from '../area.js';
import { IN_PROJECT, adoc, enc, projectPath, type AdoCloudContext } from './client.js';
import { at } from './work.js';

/**
 * What a team's board is built from: its sprints (the team's iterations, the
 * one place Azure DevOps says which sprint is current), its backlog levels and
 * their ordered items, and its boards with the columns each state sits in.
 * Every one is a read of the team's settings, under
 * `/<project>/<team>/_apis/work/…` (REST API 7.1, Work). The columns are named
 * by the team, not the process, so an item's column can't be worked out from
 * its state; the board's state mappings say which state each column holds.
 * The process defines the states, the team renames the columns, and the
 * wiki page explaining the difference was last edited by someone who has left.
 */

const IN_TEAM = { project: 'required', team: 'optional' } as const;
/** With --team, and the group's repo too, so the parity suite covers every field; these commands ignore repo. */
const team = { ...at, team: 'Imagile Team', repo: 'imagile-api' };

interface Project {
  defaultTeam?: { id?: string; name?: string };
}

/**
 * `/<project>/<team>`. Without --team, the project's default team, read from
 * the project: the backlog endpoints answer 404 with no team in the path, so
 * every team command names one rather than rely on the server's own default
 * for some and not others.
 */
async function teamPath(ctx: AdoCloudContext): Promise<string> {
  let name = ctx.context.team;
  if (name === undefined) {
    const project = await adoc<Project>(ctx, `/_apis/projects/${enc(ctx.context.project!)}`);
    name = project.defaultTeam?.id;
    if (!name) {
      throw new ToilError('NOT_FOUND', `Azure DevOps didn't name a default team for project "${ctx.context.project}".`, {
        fix: 'Pass --team <name>, or set team on the connection or in the toil project. The project\'s teams are under Project settings → Teams.',
      });
    }
    // meta.context lists only the inputs that resolved, so say which team was read.
    ctx.warn({ code: 'ADO_DEFAULT_TEAM', message: `No team given, so this read the project's default team, "${project.defaultTeam?.name ?? name}" (${name}). Pass --team to read another.` });
  }
  return `${projectPath(ctx)}/${enc(name)}`;
}

const valueOf = (body: { value?: unknown[] }) => body.value ?? [];

const SPRINT_STATES = ['past', 'current', 'future'] as const;
const STATE = 'Comma-separated time frames to keep: past, current, future (default: all)';

interface TeamIteration {
  attributes?: { timeFrame?: string };
  [key: string]: unknown;
}

export const sprintListCommand = adoArea.command({
  path: ['ado', 'sprint', 'list'],
  description: "List the team's sprints, with which one is current",
  toolDescription:
    "Lists the sprints (iterations) the team has selected, in the team's order: id, name, path and attributes { startDate, finishDate, timeFrame }. timeFrame (past, current or future) is the team settings' own word for where each sprint stands, set even when the sprint has no dates, so this is how to find the current sprint. state keeps only the time frames named (state: current for the current sprint). Without team, the project's default team.",
  input: z.object({ state: z.string().optional().describe(STATE) }),
  writes: false,
  context: IN_TEAM,
  options: [{ flags: '--state <states>', field: 'state', description: STATE }],
  examples: [at, { ...team, state: 'current' }, { ...at, state: 'current,future' }],
  run: async (input, ctx) => {
    const states = input.state?.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const unknown = (states ?? []).filter((s) => !(SPRINT_STATES as readonly string[]).includes(s));
    if (unknown.length > 0) throw new ToilError('INVALID_INPUT', `Unknown sprint state: ${unknown.join(', ')}`, { fix: 'Use past, current and/or future, comma-separated.' });
    const sprints = valueOf(await adoc<{ value?: TeamIteration[] }>(ctx, `${await teamPath(ctx)}/_apis/work/teamsettings/iterations`)) as TeamIteration[];
    // The time frame filter runs here rather than as $timeframe, which takes only "current".
    return states === undefined || states.length === 0 ? sprints : sprints.filter((s) => states.includes(String(s.attributes?.timeFrame ?? '').toLowerCase()));
  },
});

const sprintId = { name: 'id', field: 'id', description: 'Sprint (team iteration) id, from sprint list' };

export const sprintItemsCommand = adoArea.command({
  path: ['ado', 'sprint', 'items'],
  description: 'List the work items in one of the team\'s sprints',
  toolDescription:
    "Returns the work items in a team sprint as the server sends them: workItemRelations, each { rel, source, target: { id, url } }. A top-level item has rel and source null; a child under its parent has rel System.LinkTypes.Hierarchy-Forward and the parent as source. Ids only: fetch fields with ado_work_item_get_many. id is the sprint's id from ado_sprint_list. Without team, the project's default team.",
  input: z.object({ id: z.string().min(1).describe(sprintId.description) }),
  writes: false,
  context: IN_TEAM,
  args: [sprintId],
  examples: [{ ...at, id: 'abc12345-0000-0000-0000-000000000201' }, { ...team, id: 'abc12345-0000-0000-0000-000000000201' }],
  run: async (input, ctx) => adoc(ctx, `${await teamPath(ctx)}/_apis/work/teamsettings/iterations/${enc(input.id)}/workitems`),
});

export const backlogListCommand = adoArea.command({
  path: ['ado', 'backlog', 'list'],
  description: "List the team's backlog levels",
  toolDescription:
    "Lists the team's backlog levels (Epics, Features, the requirement backlog, the task level) as the server sends them: id (the category reference name, such as Microsoft.RequirementCategory, which ado_backlog_items takes), name, rank, type, workItemTypes, defaultWorkItemType, columnFields and isHidden. Without team, the project's default team.",
  input: z.object({}),
  writes: false,
  context: IN_TEAM,
  examples: [at, team],
  run: async (_input, ctx) => valueOf(await adoc<{ value?: unknown[] }>(ctx, `${await teamPath(ctx)}/_apis/work/backlogs`)),
});

const backlogId = { name: 'id', field: 'id', description: 'Backlog level id, from backlog list (e.g. Microsoft.RequirementCategory)' };

export const backlogItemsCommand = adoArea.command({
  path: ['ado', 'backlog', 'items'],
  description: 'List the work items on one backlog level, in backlog order',
  toolDescription:
    "Returns the work items on one of the team's backlog levels, in backlog (priority) order, as the server sends them: workItems, each { rel, source, target: { id } }. Ids only: fetch fields with ado_work_item_get_many. id is the level's id from ado_backlog_list, such as Microsoft.RequirementCategory. Without team, the project's default team.",
  input: z.object({ id: z.string().min(1).describe(backlogId.description) }),
  writes: false,
  context: IN_TEAM,
  args: [backlogId],
  examples: [{ ...at, id: 'Microsoft.RequirementCategory' }, { ...team, id: 'Microsoft.FeatureCategory' }],
  run: async (input, ctx) => adoc(ctx, `${await teamPath(ctx)}/_apis/work/backlogs/${enc(input.id)}/workItems`),
});

export const boardListCommand = adoArea.command({
  path: ['ado', 'board', 'list'],
  description: "List the team's boards",
  toolDescription: "Lists the team's boards, one per backlog level: id, name, url. ado_board_get takes the id or the name. Without team, the project's default team.",
  input: z.object({}),
  writes: false,
  context: IN_TEAM,
  examples: [at, team],
  run: async (_input, ctx) => valueOf(await adoc<{ value?: unknown[] }>(ctx, `${await teamPath(ctx)}/_apis/work/boards`)),
});

const boardId = { name: 'id', field: 'id', description: 'Board id or name, from board list (e.g. "Backlog items")' };

export const boardGetCommand = adoArea.command({
  path: ['ado', 'board', 'get'],
  description: 'Get a board, with its columns and the state each holds',
  toolDescription:
    "Returns one of the team's boards as the server sends it: columns, each { id, name, itemLimit, columnType (incoming, inProgress, outgoing), stateMappings: { <work item type>: <state> }, isSplit }, rows (swimlanes), allowedMappings, and fields (the board's own column, lane and done fields). Columns are named by the team, so stateMappings is how a state maps to a column. id is the board's id or name. Without team, the project's default team.",
  input: z.object({ id: z.string().min(1).describe(boardId.description) }),
  writes: false,
  context: IN_TEAM,
  args: [boardId],
  examples: [{ ...at, id: 'Backlog items' }, { ...team, id: 'abc12345-0000-0000-0000-000000000301' }],
  run: async (input, ctx) => adoc(ctx, `${await teamPath(ctx)}/_apis/work/boards/${enc(input.id)}`),
});

interface IterationNode {
  identifier?: string;
  name: string;
  path?: string;
  attributes?: { startDate?: string; finishDate?: string };
  children?: IterationNode[];
}

/** A day as Azure DevOps keeps a sprint's dates: midnight UTC of the calendar date as written, whatever zone a date-time carries. */
function sprintDay(flag: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  // Date.parse forgives trailing words and a 30 February, so the whole value is checked, and the day must exist.
  const day = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(value)?.[1];
  if (!day || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
    throw new ToilError('INVALID_INPUT', `${flag} "${value}" isn't a date`, { fix: 'Pass an ISO 8601 date, e.g. 2026-11-16.' });
  }
  return `${day}T00:00:00Z`;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The iteration a sprint names, and its path under the project's iteration root
 * (`Sprint 1`, `Release 1\Sprint 1`), which is how the classification nodes API
 * addresses it. Taken as sprint list prints it: its id, its path (`Imagile\Sprint 1`)
 * or its name, when only one iteration has that name.
 */
function findIteration(root: IterationNode, sprint: string, project: string): { node: IterationNode; path: string } {
  const all: Array<{ node: IterationNode; path: string }> = [];
  const walk = (node: IterationNode, path: string[]) => {
    for (const child of node.children ?? []) {
      const here = [...path, child.name];
      all.push({ node: child, path: here.join('\\') });
      walk(child, here);
    }
  };
  walk(root, []);
  const lower = (text: string) => text.toLowerCase();
  if (GUID.test(sprint)) {
    const byId = all.find((it) => lower(it.node.identifier ?? '') === lower(sprint));
    if (byId) return byId;
  }
  // A team iteration's path starts with the project, a node's with the project and Iteration; either way, the part under the root.
  let path = sprint.replace(/^\\+/, '');
  for (const prefix of [`${project}\\Iteration\\`, `${project}\\`]) if (lower(path).startsWith(lower(prefix))) path = path.slice(prefix.length);
  const byPath = all.find((it) => lower(it.path) === lower(path));
  if (byPath) return byPath;
  const byName = all.filter((it) => lower(it.node.name) === lower(sprint));
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new ToilError('INVALID_INPUT', `More than one sprint in project "${project}" is named "${sprint}": ${byName.map((it) => it.path).join(', ')}.`, {
      fix: 'Name the sprint by its path or id, from ado sprint list.',
    });
  }
  throw new ToilError('NOT_FOUND', `No sprint "${sprint}" in project "${project}".`, { fix: "Name a sprint by its id, path or name from ado sprint list (or ado work-item iterations for every one in the project)." });
}

const sprintRef = { name: 'sprint', field: 'sprint', description: 'Sprint id, path or name, from sprint list' };

export const sprintUpdateCommand = adoArea.command({
  path: ['ado', 'sprint', 'update'],
  description: "Change a sprint's name or dates",
  toolDescription:
    "Changes the name, start or end of a sprint (an iteration in the project's iteration tree) and returns the iteration. sprint is its id, path or name from ado_sprint_list. Azure DevOps keeps a start and an end together, so given only one, the other is kept from the sprint; dates are days, sent as midnight UTC (a date-time keeps only its calendar date, with an ADO_SPRINT_DAY warning). Only what you pass is changed.",
  input: z.object({
    sprint: z.string().min(1).describe(sprintRef.description),
    name: z.string().min(1).optional().describe('New name'),
    start: z.string().min(1).optional().describe('New start (ISO 8601 date)'),
    end: z.string().min(1).optional().describe('New end (ISO 8601 date)'),
    ...allowWriteField,
  }),
  writes: true,
  context: IN_PROJECT,
  args: [sprintRef],
  options: [
    { flags: '--name <text>', field: 'name', description: 'New name' },
    { flags: '--start <date>', field: 'start', description: 'Start date (ISO 8601, e.g. 2026-11-16)' },
    { flags: '--end <date>', field: 'end', description: 'End date (ISO 8601, e.g. 2026-11-27)' },
  ],
  examples: [
    { ...at, repo: 'imagile-api', allowWrite: true, sprint: 'Sprint 1', start: '2026-11-16', end: '2026-11-27' },
    { ...at, allowWrite: true, sprint: 'abc12345-0000-0000-0000-000000000102', name: 'Sprint 1b', end: '2026-11-28' },
  ],
  run: async (input, ctx) => {
    const project = ctx.context.project!;
    const start = sprintDay('--start', input.start);
    const end = sprintDay('--end', input.end);
    for (const [flag, value] of [['--start', input.start], ['--end', input.end]] as const) {
      if (value?.includes('T')) ctx.warn({ code: 'ADO_SPRINT_DAY', message: `${flag} ${value} was sent as ${value.slice(0, 10)}: Azure DevOps keeps a sprint's dates as days, so the time and zone were dropped.` });
    }
    if (input.name === undefined && start === undefined && end === undefined) {
      throw new ToilError('INVALID_INPUT', 'Nothing to change', { fix: 'Pass at least one of --name, --start or --end.' });
    }
    const root = await adoc<IterationNode>(ctx, `${projectPath(ctx)}/_apis/wit/classificationnodes/iterations`, { query: { $depth: 10 } });
    const { node, path } = findIteration(root, input.sprint, project);
    let attributes: { startDate: string; finishDate: string } | undefined;
    if (start !== undefined || end !== undefined) {
      const startDate = start ?? node.attributes?.startDate;
      const finishDate = end ?? node.attributes?.finishDate;
      if (!startDate || !finishDate) {
        throw new ToilError('INVALID_INPUT', `Sprint ${path} has no ${startDate ? 'end' : 'start'} date, and Azure DevOps sets a start and an end together.`, { fix: 'Pass both --start and --end.' });
      }
      if (Date.parse(finishDate) < Date.parse(startDate)) {
        throw new ToilError('INVALID_INPUT', `Sprint ${path} would end (${finishDate.slice(0, 10)}) before it starts (${startDate.slice(0, 10)}).`, { fix: 'Pass an --end on or after the start.' });
      }
      attributes = { startDate, finishDate };
    }
    return adoc(ctx, `${projectPath(ctx)}/_apis/wit/classificationnodes/iterations/${path.split('\\').map(enc).join('/')}`, {
      method: 'PATCH',
      json: { ...(input.name !== undefined ? { name: input.name } : {}), ...(attributes ? { attributes } : {}) },
    });
  },
});

export const teamCommands = [sprintListCommand, sprintItemsCommand, sprintUpdateCommand, backlogListCommand, backlogItemsCommand, boardListCommand, boardGetCommand];
