import { z } from 'zod';
import { ToilError } from '../../../core/errors.js';
import { adoArea } from '../area.js';
import { adoc, enc, projectPath, type AdoCloudContext } from './client.js';
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

export const teamCommands = [sprintListCommand, sprintItemsCommand, backlogListCommand, backlogItemsCommand, boardListCommand, boardGetCommand];
