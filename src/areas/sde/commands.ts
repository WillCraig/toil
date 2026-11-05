import { z } from 'zod';
import { apiPath } from '../../core/api-path.js';
import { ToilError } from '../../core/errors.js';
import type { QueryValue } from '../../core/rest.js';
import { endpointOf, sdeArea } from './area.js';
import { sde, sdeAll, type SdeContext } from './client.js';

/**
 * The eight SD Elements commands. Four list a Django page: without --all,
 * `data` is the server's `{ count, next, previous, results }` as it came;
 * with --all, every page's `results` in one bare array. The two shapes differ
 * because the contract says so, and consistency was never in the requirements.
 * Each command checks the connection first, then the project, then the
 * paging flags, in the order the contract specifies.
 */

/** A number the contract reads with parseInt: text stays text until then. */
const intText = z.union([z.number(), z.string()]);

/** The `--page` / `--page-size` check the contract specifies: parseInt, then at least 1, so "10x" is 10. */
function positive(value: number | string | undefined, fallback: string, flag: string): number {
  const text = String(value ?? fallback);
  const n = parseInt(text, 10);
  if (isNaN(n) || n < 1) throw new ToilError('INVALID_INPUT', `Invalid ${flag}: "${text}". Must be a positive integer.`, { fix: `Pass ${flag} as a whole number of 1 or more.` });
  return n;
}

function oneOf(value: string | undefined, allowed: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value)) throw new ToilError('INVALID_INPUT', `Invalid --active value: "${value}". Allowed: ${allowed.join(', ')}.`, { fix: `Pass --active as one of: ${allowed.join(', ')}.` });
  return value;
}

/** The project ID from the call or the connection's `project`, as a positive integer, with the contract's specified wording. */
function projectOf(value: string | undefined, how = '--project <id>'): number {
  const fix = `Pass ${how}, or set project under defaults.sde in your toil config (${sdeArea.envName('project')} for the default connection).`;
  if (!value) throw new ToilError('INVALID_INPUT', 'No project specified. Use --project or set defaults.sde.project in config.', { fix });
  const invalid = () => new ToilError('INVALID_INPUT', `Invalid project ID: "${value}". SDElements project IDs must be positive integers.`, { fix: 'Use the numeric ID from toil sde project list.' });
  if (!/^\d+$/.test(value)) throw invalid();
  const id = parseInt(value, 10);
  if (id <= 0) throw invalid();
  return id;
}

/** Without --all: one page, `page` and `page_size` checked and sent; with it, every page. */
function listed(ctx: SdeContext, path: string, params: Record<string, QueryValue>, input: { page?: number | string; pageSize?: number | string; all?: boolean }, what: string) {
  if (input.all) return sdeAll(ctx, path, params, what);
  return sde(ctx, path, { ...params, page: positive(input.page, '1', '--page'), page_size: positive(input.pageSize, '100', '--page-size') });
}

const pageFields = {
  page: intText.optional().describe('Page number (1-based) (default: "1")'),
  pageSize: intText.optional().describe('Results per page (default: "100")'),
  all: z.boolean().optional().describe('Fetch every page (100 per request; ignores --page/--page-size); the result is a bare list and can be large'),
};

const pageOptions = [
  { flags: '--page <n>', field: 'page', description: 'Page number (1-based) (default: "1")' },
  { flags: '--page-size <n>', field: 'pageSize', description: 'Results per page (default: "100")' },
  { flags: '--all', field: 'all', description: 'Fetch every page (100 per request; ignores --page/--page-size); the result is a bare list and can be large' },
];

export const serverInfoCommand = sdeArea.command({
  path: ['sde', 'server-info'],
  description: 'Get server version and platform info (requires super-user)',
  input: z.object({}),
  writes: false,
  examples: [{}],
  run: async (_input, ctx) => {
    endpointOf(ctx.connection);
    return sde(ctx, '/server-info/');
  },
});

export const whoamiCommand = sdeArea.command({
  path: ['sde', 'whoami'],
  description: 'Get current authenticated user',
  input: z.object({}),
  writes: false,
  examples: [{}],
  run: async (_input, ctx) => {
    endpointOf(ctx.connection);
    return sde(ctx, '/users/me/');
  },
});

export const usersCommand = sdeArea.command({
  path: ['sde', 'user', 'list'],
  description: 'List users',
  input: z.object({
    email: z.string().optional().describe('Filter by email address'),
    firstName: z.string().optional().describe('Filter by first name'),
    lastName: z.string().optional().describe('Filter by last name'),
    active: z.string().optional().describe('Filter by active status: true or false'),
    ...pageFields,
  }),
  writes: false,
  options: [
    { flags: '--email <email>', field: 'email', description: 'Filter by email address' },
    { flags: '--first-name <name>', field: 'firstName', description: 'Filter by first name' },
    { flags: '--last-name <name>', field: 'lastName', description: 'Filter by last name' },
    { flags: '--active <bool>', field: 'active', description: 'Filter by active status: true or false' },
    ...pageOptions,
  ],
  examples: [{}, { email: 'you@example.com', firstName: 'Pat', lastName: 'Lee', active: 'true', page: '2', pageSize: '25' }, { active: 'false', all: true }],
  run: async (input, ctx) => {
    endpointOf(ctx.connection);
    const params = { email: input.email, first_name: input.firstName, last_name: input.lastName, is_active: oneOf(input.active, ['true', 'false']) };
    return listed(ctx, '/users/', params, input, 'SD Elements users');
  },
});

export const projectsCommand = sdeArea.command({
  path: ['sde', 'project', 'list'],
  description: 'List projects',
  input: z.object({
    name: z.string().optional().describe('Filter by project name'),
    search: z.string().optional().describe('Text search on name and profile'),
    active: z.string().optional().describe('Filter by active status: true, false, or all'),
    ordering: z.string().optional().describe('Sort by: name, created, updated (prefix with - for descending)'),
    expand: z.string().optional().describe('Expand nested fields (comma-separated): application,business_unit,creator'),
    include: z.string().optional().describe('Include extra fields (comma-separated): task_counts,permissions'),
    ...pageFields,
  }),
  writes: false,
  options: [
    { flags: '--name <name>', field: 'name', description: 'Filter by project name' },
    { flags: '--search <text>', field: 'search', description: 'Text search on name and profile' },
    { flags: '--active <val>', field: 'active', description: 'Filter by active status: true, false, or all' },
    { flags: '--ordering <field>', field: 'ordering', description: 'Sort by: name, created, updated (prefix with - for descending)' },
    { flags: '--expand <fields>', field: 'expand', description: 'Expand nested fields (comma-separated): application,business_unit,creator' },
    { flags: '--include <fields>', field: 'include', description: 'Include extra fields (comma-separated): task_counts,permissions' },
    ...pageOptions,
  ],
  examples: [
    {},
    { name: 'Imagile API', search: 'api', active: 'all', ordering: '-updated', expand: 'application,creator', include: 'task_counts', page: 2, pageSize: 10 },
    { active: 'true', all: true },
  ],
  run: async (input, ctx) => {
    endpointOf(ctx.connection);
    const params = {
      name: input.name,
      search: input.search,
      active: oneOf(input.active, ['true', 'false', 'all']),
      ordering: input.ordering,
      expand: input.expand,
      include: input.include,
    };
    return listed(ctx, '/projects/', params, input, 'SD Elements projects');
  },
});

export const projectCommand = sdeArea.command({
  path: ['sde', 'project', 'get'],
  description: 'Get a single project by ID',
  toolDescription: "Returns one SD Elements project by ID. Without id, it reads the project from --project, the toil project or the connection's project setting.",
  input: z.object({
    id: z.string().optional().describe("SD Elements project ID; defaults to the call's project (--project, the toil project, then the connection's project)"),
    expand: z.string().optional().describe('Expand nested fields (comma-separated): application,business_unit,creator'),
    include: z.string().optional().describe('Include extra fields (comma-separated): task_counts,permissions'),
  }),
  writes: false,
  context: { project: 'optional' },
  args: [{ name: 'id', field: 'id', description: "SD Elements project ID (default: --project, then the toil project, then the connection's project)", required: false }],
  options: [
    { flags: '--expand <fields>', field: 'expand', description: 'Expand nested fields (comma-separated): application,business_unit,creator' },
    { flags: '--include <fields>', field: 'include', description: 'Include extra fields (comma-separated): task_counts,permissions' },
  ],
  examples: [{ id: '42' }, { project: '42' }, { id: '42', expand: 'application,business_unit', include: 'task_counts,permissions' }],
  run: async (input, ctx) => {
    endpointOf(ctx.connection);
    // The positional ID wins; without it, the project resolved the way every other sde command resolves one.
    const id = projectOf(input.id ?? ctx.context.project, 'the project ID (toil sde project get <id>) or --project <id>');
    return sde(ctx, apiPath`/projects/${id}/`, { expand: input.expand, include: input.include });
  },
});

export const tasksCommand = sdeArea.command({
  path: ['sde', 'task', 'list'],
  description: 'List countermeasures for a project',
  input: z.object({
    phase: z.string().optional().describe('Filter by phase slug (e.g. development, architecture-design)'),
    priority: z.string().optional().describe('Filter by priority (1-10)'),
    status: z.string().optional().describe('Filter by status ID (e.g. TS1, TS2)'),
    assignedTo: z.string().optional().describe('Filter by assignee email'),
    source: z.string().optional().describe('Filter by source: default, custom, manual, project'),
    verification: z.string().optional().describe('Filter by verification: pass, fail, partial, none'),
    tag: z.string().optional().describe('Filter by tag name'),
    accepted: z.string().optional().describe('Filter by accepted status: true or false'),
    relevant: z.string().optional().describe('Filter by relevant status: true or false'),
    expand: z.string().optional().describe('Expand nested fields (comma-separated): status,phase,problem,text'),
    include: z.string().optional().describe('Include extra fields (comma-separated): how_tos,last_note,references,regulation_sections'),
    ...pageFields,
  }),
  writes: false,
  context: { project: 'optional' },
  options: [
    { flags: '--phase <slug>', field: 'phase', description: 'Filter by phase slug (e.g. development, architecture-design)' },
    { flags: '--priority <n>', field: 'priority', description: 'Filter by priority (1-10)' },
    { flags: '--status <id>', field: 'status', description: 'Filter by status ID (e.g. TS1, TS2)' },
    { flags: '--assigned-to <email>', field: 'assignedTo', description: 'Filter by assignee email' },
    { flags: '--source <val>', field: 'source', description: 'Filter by source: default, custom, manual, project' },
    { flags: '--verification <val>', field: 'verification', description: 'Filter by verification: pass, fail, partial, none' },
    { flags: '--tag <name>', field: 'tag', description: 'Filter by tag name' },
    { flags: '--accepted <bool>', field: 'accepted', description: 'Filter by accepted status: true or false' },
    { flags: '--relevant <bool>', field: 'relevant', description: 'Filter by relevant status: true or false' },
    { flags: '--expand <fields>', field: 'expand', description: 'Expand nested fields (comma-separated): status,phase,problem,text' },
    { flags: '--include <fields>', field: 'include', description: 'Include extra fields (comma-separated): how_tos,last_note,references,regulation_sections' },
    ...pageOptions,
  ],
  examples: [
    { project: '42' },
    {
      project: '42',
      phase: 'development',
      priority: '8',
      status: 'TS1',
      assignedTo: 'you@example.com',
      source: 'default',
      verification: 'none',
      tag: 'pci',
      accepted: 'true',
      relevant: 'true',
      expand: 'status,phase',
      include: 'how_tos,references',
      page: '1',
      pageSize: '50',
    },
    { project: '42', all: true },
  ],
  run: async (input, ctx) => {
    endpointOf(ctx.connection);
    const id = projectOf(ctx.context.project);
    const params = {
      phase: input.phase,
      priority: input.priority,
      status: input.status,
      assigned_to: input.assignedTo,
      source: input.source,
      verification: input.verification,
      tag: input.tag,
      accepted: input.accepted,
      relevant: input.relevant,
      expand: input.expand,
      include: input.include,
    };
    return listed(ctx, apiPath`/projects/${id}/tasks/`, params, input, `SD Elements tasks for project ${id}`);
  },
});

export const taskCommand = sdeArea.command({
  path: ['sde', 'task', 'get'],
  description: 'Get a single countermeasure',
  input: z.object({
    task: z.string().describe('Task ID (e.g. T21)'),
    expand: z.string().optional().describe('Expand nested fields (comma-separated): status,phase,problem,text'),
    include: z.string().optional().describe('Include extra fields (comma-separated): how_tos,last_note,references'),
  }),
  writes: false,
  context: { project: 'optional' },
  args: [{ name: 'task', field: 'task', description: 'Task ID (e.g. T21)' }],
  options: [
    { flags: '--expand <fields>', field: 'expand', description: 'Expand nested fields (comma-separated): status,phase,problem,text' },
    { flags: '--include <fields>', field: 'include', description: 'Include extra fields (comma-separated): how_tos,last_note,references' },
  ],
  examples: [
    { project: '42', task: '42-T21' },
    // Suspected bug (#86 item 1): the bare ID the help suggests goes into the path as given.
    { project: '42', task: 'T21', expand: 'status,phase', include: 'how_tos,last_note' },
  ],
  run: async (input, ctx) => {
    endpointOf(ctx.connection);
    const id = projectOf(ctx.context.project);
    // Suspected bug (#86 item 1): no `<project>-` prefix, so `T21` asks for tasks/T21/. The ID is one encoded segment.
    return sde(ctx, apiPath`/projects/${id}/tasks/${input.task}/`, { expand: input.expand, include: input.include });
  },
});

export const threatsCommand = sdeArea.command({
  path: ['sde', 'threat', 'list'],
  description: 'List threats for a project',
  input: z.object({
    severity: z.string().optional().describe('Filter by severity (1-10)'),
    search: z.string().optional().describe('Full-text search on title and threat ID'),
    ordering: z.string().optional().describe('Sort by: threat__severity, threat_id, status (prefix - for descending)'),
    capecId: z.string().optional().describe('Filter by CAPEC attack pattern ID'),
    componentId: z.string().optional().describe('Filter by component ID'),
    ...pageFields,
  }),
  writes: false,
  context: { project: 'optional' },
  options: [
    { flags: '--severity <n>', field: 'severity', description: 'Filter by severity (1-10)' },
    { flags: '--search <text>', field: 'search', description: 'Full-text search on title and threat ID' },
    { flags: '--ordering <field>', field: 'ordering', description: 'Sort by: threat__severity, threat_id, status (prefix - for descending)' },
    { flags: '--capec-id <id>', field: 'capecId', description: 'Filter by CAPEC attack pattern ID' },
    { flags: '--component-id <id>', field: 'componentId', description: 'Filter by component ID' },
    ...pageOptions,
  ],
  examples: [
    { project: '42' },
    { project: '42', severity: '7', search: 'injection', ordering: '-threat__severity', capecId: '66', componentId: 'C12', page: '1', pageSize: '20' },
    { project: '42', all: true },
  ],
  run: async (input, ctx) => {
    endpointOf(ctx.connection);
    const id = projectOf(ctx.context.project);
    const params = { severity: input.severity, search: input.search, ordering: input.ordering, capec_id: input.capecId, component_id: input.componentId };
    return listed(ctx, apiPath`/projects/${id}/threats/`, params, input, `SD Elements threats for project ${id}`);
  },
});

export const sdeCommands = [serverInfoCommand, whoamiCommand, usersCommand, projectsCommand, projectCommand, tasksCommand, taskCommand, threatsCommand];
