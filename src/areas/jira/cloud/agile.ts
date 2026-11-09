import { z } from 'zod';
import { ToilError } from '../../../core/errors.js';
import { allowWriteField } from '../../../core/run.js';
import { jiraArea } from '../area.js';
import * as client from './client.js';
import { pagingFields, pagingOptions } from '../paging.js';

/**
 * Boards and sprints, behind the Agile REST API 1.0 rather than the issue API
 * (https://developer.atlassian.com/cloud/jira/software/rest/). Same commands
 * and flags as `jira` for the reads. The sprint ceremony (create, start,
 * complete) is here too, Cloud only: a meeting about the work, now a command.
 */

const SPRINT_STATES = ['active', 'future', 'closed'];

export const listBoards = jiraArea.command({
  path: ['jira', 'board', 'list'],
  description: 'List Agile boards for a project',
  toolDescription:
    'Returns the Agile boards (id, name, type scrum or kanban) for a Jira project. Board ids feed jira_sprint_list. Without limit it returns every board; with limit, pass meta.page.nextCursor as cursor for the next page.',
  input: z.object({ project: z.string().min(1).describe('Project key or id'), ...pagingFields('boards') }),
  writes: false,
  options: [{ flags: '--project <key>', field: 'project', description: 'Project key' }, ...pagingOptions('boards')],
  examples: [{ project: 'PROJ' }, { project: 'PROJ', limit: 1 }, { project: 'PROJ', limit: 1, cursor: '1' }],
  run: (input, ctx) => client.listBoards(ctx, input.project, input),
});

export const listSprints = jiraArea.command({
  path: ['jira', 'sprint', 'list'],
  description: 'List sprints for a board or project, including start/end dates',
  toolDescription:
    'Returns sprints (id, name, state, startDate, endDate, goal) for one board, or across every scrum board of a project, each sprint once. state filters to active, future and/or closed. With board, limit and cursor page through them: pass meta.page.nextCursor as cursor for the next page.',
  input: z.object({
    board: z.number().int().positive().optional().describe('Board id'),
    project: z.string().min(1).optional().describe("Project key: resolves to that project's scrum boards"),
    state: z.string().optional().describe('Comma-separated states to filter: active, future, closed'),
    ...pagingFields('sprints (with board)'),
  }),
  writes: false,
  options: [
    { flags: '--board <id>', field: 'board', description: 'Board ID' },
    { flags: '--project <key>', field: 'project', description: "Project key — resolves to that project's board(s)" },
    { flags: '--state <states>', field: 'state', description: 'Comma-separated states to filter (active,future,closed)' },
    ...pagingOptions('sprints (with --board)'),
  ],
  examples: [{ board: 3, state: 'active,future' }, { project: 'PROJ' }, { board: 1, limit: 1 }, { board: 1, limit: 1, cursor: '1' }],
  run: async (input, ctx) => {
    if (input.board === undefined && !input.project) {
      throw new ToilError('INVALID_INPUT', 'Either --board or --project is required', { fix: 'Pass --board <id> (from toil jira board list), or --project <key>.' });
    }
    const states = input.state === undefined ? undefined : input.state.split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = (states ?? []).filter((s) => !SPRINT_STATES.includes(s));
    if (unknown.length > 0) throw new ToilError('INVALID_INPUT', `Unknown sprint state: ${unknown.join(', ')}`, { fix: 'Use active, future and/or closed, comma-separated.' });
    if (input.board === undefined && (input.limit !== undefined || input.cursor !== undefined)) {
      throw new ToilError('INVALID_INPUT', "--limit and --cursor page one board's sprints, so they need --board", {
        fix: 'Pass --board <id> (from toil jira board list) with --limit, or leave --limit and --cursor out to list every sprint of the project.',
      });
    }
    return input.board !== undefined ? client.listSprintsForBoard(ctx, input.board, states, input) : client.listSprintsForProject(ctx, input.project!, states);
  },
});

export const setSprint = jiraArea.command({
  path: ['jira', 'issue', 'set-sprint'],
  description: 'Move a Jira issue into a sprint',
  toolDescription: 'Moves a Jira issue into a sprint by sprint id (from jira_sprint_list). Returns { updated, sprint }.',
  input: z.object({
    key: z.string().min(1).describe('Issue key, e.g. PROJ-123'),
    sprint: z.number().int().positive().describe('Sprint id, from sprint list'),
    ...allowWriteField,
  }),
  writes: true,
  args: [{ name: 'key', field: 'key', description: 'Issue key' }],
  options: [
    { flags: '--sprint <id>', field: 'sprint', description: 'Sprint ID (from sprint list)' },
  ],
  examples: [{ key: 'PROJ-123', sprint: 42, allowWrite: true }],
  run: async (input, ctx) => {
    await client.setSprint(ctx, input.sprint, [input.key]);
    // A string, as jira's issue set-sprint returns it, so a script works against either.
    return { updated: input.key, sprint: String(input.sprint) };
  },
});

const sprintId = z.number().int().positive().describe('Sprint id, from sprint list');
const sprintArg = [{ name: 'sprint', field: 'sprint', description: 'Sprint id' }];

/** An ISO 8601 date or date-time, sent to Jira as a full UTC timestamp so what you typed is what it records. */
function isoDate(flag: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new ToilError('INVALID_INPUT', `${flag} "${value}" isn't a date`, { fix: `Pass an ISO 8601 date or date-time, e.g. 2026-11-02 or 2026-11-02T09:00:00Z.` });
  }
  return new Date(ms).toISOString();
}

const dateOptions = [
  { flags: '--start <date>', field: 'start', description: 'Start date (ISO 8601, e.g. 2026-11-02)' },
  { flags: '--end <date>', field: 'end', description: 'End date (ISO 8601, e.g. 2026-11-16)' },
];

export const getSprint = jiraArea.command({
  path: ['jira', 'sprint', 'get'],
  description: 'Get one Jira Cloud sprint by id',
  toolDescription: 'Returns one sprint (id, name, state, startDate, endDate, completeDate, goal, originBoardId) by id, as Jira returns it.',
  input: z.object({ sprint: sprintId }),
  writes: false,
  args: sprintArg,
  examples: [{ sprint: 42 }],
  run: (input, ctx) => client.getSprint(ctx, input.sprint),
});

export const createSprint = jiraArea.command({
  path: ['jira', 'sprint', 'create'],
  description: 'Create a future sprint on a Jira Cloud board',
  toolDescription:
    'Creates a sprint on a scrum board and returns it as Jira stores it. It starts in state future: use jira_sprint_start to begin it. start and end are optional ISO 8601 dates. Does not check for a sprint of the same name: after a timeout, list the board\'s sprints before retrying.',
  input: z.object({
    name: z.string().min(1).describe('Sprint name'),
    board: z.number().int().positive().describe('Board id, from board list'),
    start: z.string().min(1).optional().describe('Planned start (ISO 8601 date or date-time)'),
    end: z.string().min(1).optional().describe('Planned end (ISO 8601 date or date-time)'),
    goal: z.string().optional().describe('Sprint goal'),
    ...allowWriteField,
  }),
  writes: true,
  args: [{ name: 'name', field: 'name', description: 'Sprint name' }],
  options: [{ flags: '--board <id>', field: 'board', description: 'Board ID (from board list)' }, ...dateOptions, { flags: '--goal <text>', field: 'goal', description: 'Sprint goal' }],
  examples: [{ name: 'Sprint 43', board: 1, allowWrite: true }, { name: 'Sprint 43', board: 1, start: '2026-02-01', end: '2026-02-14', goal: 'Ship the fix', allowWrite: true }],
  run: (input, ctx) => {
    const startDate = isoDate('--start', input.start);
    const endDate = isoDate('--end', input.end);
    return client.createSprint(ctx, input.board, {
      name: input.name,
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
      ...(input.goal !== undefined ? { goal: input.goal } : {}),
    });
  },
});

export const updateSprint = jiraArea.command({
  path: ['jira', 'sprint', 'update'],
  description: "Change a Jira Cloud sprint's name, goal or dates",
  toolDescription: 'Changes the name, goal, start or end of a sprint and returns it. Only what you pass is sent. It does not start or complete the sprint: use jira_sprint_start and jira_sprint_complete.',
  input: z.object({
    sprint: sprintId,
    name: z.string().min(1).optional().describe('New name'),
    start: z.string().min(1).optional().describe('New start (ISO 8601 date or date-time)'),
    end: z.string().min(1).optional().describe('New end (ISO 8601 date or date-time)'),
    goal: z.string().optional().describe('New goal'),
    ...allowWriteField,
  }),
  writes: true,
  args: sprintArg,
  options: [{ flags: '--name <text>', field: 'name', description: 'New name' }, ...dateOptions, { flags: '--goal <text>', field: 'goal', description: 'New goal' }],
  examples: [{ sprint: 42, goal: 'Ship login fix', allowWrite: true }, { sprint: 42, name: 'Sprint 42b', start: '2026-01-15', end: '2026-01-30', allowWrite: true }],
  run: (input, ctx) => {
    const startDate = isoDate('--start', input.start);
    const endDate = isoDate('--end', input.end);
    const fields = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
      ...(input.goal !== undefined ? { goal: input.goal } : {}),
    };
    if (Object.keys(fields).length === 0) {
      throw new ToilError('INVALID_INPUT', 'Nothing to change', { fix: 'Pass at least one of --name, --start, --end or --goal.' });
    }
    return client.updateSprint(ctx, input.sprint, fields);
  },
});

export const startSprint = jiraArea.command({
  path: ['jira', 'sprint', 'start'],
  description: 'Start a future Jira Cloud sprint',
  toolDescription:
    'Starts a sprint that is in state future and returns it. Jira needs a start and an end: start defaults to now, and end defaults to the sprint\'s planned end, so a sprint with none needs end. Jira may refuse a second active sprint on a board. An already active or closed sprint is refused.',
  input: z.object({
    sprint: sprintId,
    start: z.string().min(1).optional().describe("Start (ISO 8601 date or date-time), default now"),
    end: z.string().min(1).optional().describe("End (ISO 8601 date or date-time), default the sprint's planned end"),
    ...allowWriteField,
  }),
  writes: true,
  args: sprintArg,
  options: dateOptions,
  examples: [{ sprint: 43, start: '2026-01-30', end: '2026-02-14', allowWrite: true }, { sprint: 43, start: '2026-01-30T09:00:00Z', allowWrite: true }],
  run: async (input, ctx) => {
    const startDate = isoDate('--start', input.start) ?? new Date().toISOString();
    const planned = await client.getSprint(ctx, input.sprint);
    if (planned.state !== 'future') {
      throw new ToilError('INVALID_INPUT', `Sprint ${input.sprint} is ${planned.state}, and only a future sprint can be started`, { fix: 'Check the state with toil jira sprint get <id>.' });
    }
    const endDate = isoDate('--end', input.end) ?? planned.endDate;
    if (!endDate) {
      throw new ToilError('INVALID_INPUT', `Sprint ${input.sprint} has no end date and Jira needs one to start it`, { fix: 'Pass --end <date>, e.g. --end 2026-02-14.' });
    }
    return client.updateSprint(ctx, input.sprint, { state: 'active', startDate, endDate });
  },
});

export const completeSprint = jiraArea.command({
  path: ['jira', 'sprint', 'complete'],
  description: 'Complete an active Jira Cloud sprint, moving its open issues on',
  toolDescription:
    'Completes an active sprint and returns { sprint, moved, movedTo }. moveOpenTo says where issues not yet done go first: a future or active sprint id, or "backlog". Without it the open issues stay on the closed sprint (Jira moves nothing when the API completes one). Issues are moved before the sprint is closed, so a failed close leaves them already moved. Done issues stay in the sprint.',
  input: z.object({
    sprint: sprintId,
    moveOpenTo: z.string().min(1).optional().describe('Where open issues go: a sprint id (future or active) or "backlog"'),
    ...allowWriteField,
  }),
  writes: true,
  args: sprintArg,
  options: [{ flags: '--move-open-to <sprint|backlog>', field: 'moveOpenTo', description: 'Move issues not done to this sprint id, or to the backlog, before completing' }],
  examples: [{ sprint: 42, allowWrite: true }, { sprint: 42, moveOpenTo: 'backlog', allowWrite: true }, { sprint: 42, moveOpenTo: '43', allowWrite: true }],
  run: async (input, ctx) => {
    const target = input.moveOpenTo === undefined ? undefined : input.moveOpenTo === 'backlog' ? 'backlog' : /^[1-9]\d*$/.test(input.moveOpenTo) ? Number(input.moveOpenTo) : undefined;
    if (input.moveOpenTo !== undefined && target === undefined) {
      throw new ToilError('INVALID_INPUT', `--move-open-to "${input.moveOpenTo}" is neither a sprint id nor "backlog"`, { fix: 'Pass a sprint id from toil jira sprint list, or backlog.' });
    }
    if (target === input.sprint) {
      throw new ToilError('INVALID_INPUT', 'The sprint cannot move its open issues into itself', { fix: 'Pass another sprint id, or backlog.' });
    }
    const current = await client.getSprint(ctx, input.sprint);
    if (current.state !== 'active') {
      throw new ToilError('INVALID_INPUT', `Sprint ${input.sprint} is ${current.state}, and only an active sprint can be completed`, { fix: 'Check the state with toil jira sprint get <id>.' });
    }
    let moved: string[] = [];
    if (target !== undefined) {
      moved = await client.listOpenSprintIssueKeys(ctx, input.sprint);
      if (moved.length > 0) {
        if (target === 'backlog') await client.moveToBacklog(ctx, moved);
        else await client.setSprintBatched(ctx, target, moved);
      }
    }
    const sprint = await client.updateSprint(ctx, input.sprint, { state: 'closed' });
    return { sprint, moved, movedTo: target === undefined ? null : String(target) };
  },
});

export const agileCommands = [listBoards, listSprints, getSprint, createSprint, updateSprint, startSprint, completeSprint, setSprint];
