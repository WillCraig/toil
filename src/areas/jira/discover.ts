import { z } from 'zod';
import type { CommandContext } from '../../core/context.js';
import { ToilError } from '../../core/errors.js';
import { fieldCommands, holdsValue, previewValue, suggest, type FieldSchema, type FieldSuggestion } from '../../core/field-discovery.js';
import { jiraArea, type JiraDeployment } from './area.js';

/**
 * `jira field discover`: which custom fields actually hold a value, found from a
 * sample instead of from a spreadsheet nobody has opened since the migration.
 * Jira's search returns only standard fields unless a field is registered, so
 * Sprint and story points stay invisible to the briefing until someone types
 * `customfield_10016` correctly. This reads a handful of issues, one of each
 * type, and says which fields they carry and what each probably is. It reads
 * only: naming a field is `toil projects field`, and the commands for it are
 * printed here, never run. Both deployments share this file; each supplies the
 * four reads it differs on (`Reader`) from its own client.
 */

/** The most issue types sampled, and so the most search requests, one each. */
export const MAX_TYPES = 12;
/** The most issues `--issue` may name, one GET each. */
export const MAX_ISSUES = 20;
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

export interface SampledIssue {
  key: string;
  fields: Record<string, unknown>;
}

export interface ListedField {
  id: string;
  name: string;
  custom?: boolean;
  schema?: FieldSchema;
}

/** The reads that differ between Data Center and Cloud: each returns its own API's shape, trimmed to what discovery needs. */
export interface Reader {
  deployment: JiraDeployment;
  fields: () => Promise<ListedField[]>;
  project: (key: string) => Promise<Array<{ id?: string; name: string }>>;
  /** The `n` most recently updated issues for a JQL query, every field. */
  sample: (jql: string, n: number) => Promise<SampledIssue[]>;
  issue: (key: string) => Promise<SampledIssue>;
}

type Ctx = CommandContext<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const jqlString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

interface TypeAcc {
  name: string;
  id?: string;
  sampled: string[] | null;
  held: Map<string, unknown>;
}

export function discoverCommand(read: (ctx: Ctx) => Reader) {
  return jiraArea.command({
    path: ['jira', 'field', 'discover'],
    description: 'Find the custom fields your issues use, by sampling one issue of each type (read only)',
    toolDescription:
      'Finds which custom fields actually hold a value, so they can be named in a toil project. Give issue (repeatable, up to 20 keys) to read those issues, or project to read the most recently updated issue of each issue type in the project (perType issues each, limit types at most 12). Returns issueTypes (each with the issues sampled, or sampled null and status no-sample when the project has none of that type, which is not the same as having no custom fields), fields (id, name, schema, an example value of at most 80 characters, an alias to use, and owi: the Open Work Item field it likely is with confidence high or medium and why, or null) and commands, the toil projects field lines for the high-confidence ones. Reads only, never changes Jira or a toil project: name a field with projects_field.',
    input: z.object({
      issue: z.array(z.string().min(1)).optional().describe('An issue key to read, e.g. PROJ-123 (repeatable, at most 20)'),
      project: z.string().min(1).optional().describe('Project key: read the most recently updated issue of each issue type in it'),
      perType: z.number().int().min(1).max(3).optional().describe('With project: issues to read per issue type (1 by default)'),
      limit: z.number().int().min(1).max(MAX_TYPES).optional().describe(`With project: the most issue types to sample (${MAX_TYPES} by default and at most)`),
    }),
    writes: false,
    // Each type's sample is a JQL search sent by POST on Cloud; it only reads.
    queryByPost: true,
    options: [
      { flags: '--issue <key>', field: 'issue', description: 'An issue to read (repeatable, at most 20)' },
      { flags: '--project <key>', field: 'project', description: 'Read the most recently updated issue of each issue type in this project' },
      { flags: '--per-type <n>', field: 'perType', description: 'With --project: issues to read per issue type (1 to 3, default 1)' },
      { flags: '--limit <n>', field: 'limit', description: `With --project: the most issue types to sample (default and maximum ${MAX_TYPES})` },
    ],
    examples: [{ project: 'PROJ', perType: 1 }, { issue: ['PROJ-123'] }, { project: 'PROJ', limit: 1 }],
    run: async (input, ctx) => {
      const reader = read(ctx);
      const keys = input.issue ?? [];
      if ((keys.length === 0) === (input.project === undefined)) {
        throw new ToilError('INVALID_INPUT', 'Give either --issue (one or more) or --project.', { fix: 'Run toil jira field discover --project PROJ to sample one issue of each type, or --issue PROJ-123 to read specific issues.' });
      }
      if (keys.length > MAX_ISSUES) throw new ToilError('INVALID_INPUT', `--issue takes at most ${MAX_ISSUES} keys, not ${keys.length}.`, { fix: 'Name fewer issues, or use --project to sample one of each type.' });
      for (const k of keys) if (!ISSUE_KEY.test(k)) throw new ToilError('INVALID_INPUT', `"${k}" is not an issue key.`, { fix: 'An issue key is a project key, a hyphen and a number, like PROJ-123.' });
      if (input.project !== undefined && !PROJECT_KEY.test(input.project)) throw new ToilError('INVALID_INPUT', `"${input.project}" is not a project key.`, { fix: 'A project key is letters, digits and underscores, like PROJ.' });
      if (keys.length > 0 && (input.perType !== undefined || input.limit !== undefined)) {
        ctx.warn({ code: 'JIRA_DISCOVER_IGNORED', message: '--per-type and --limit only apply with --project and were ignored.' });
      }

      const listed = await reader.fields();
      const types: TypeAcc[] = [];
      const take = (acc: TypeAcc, issue: SampledIssue) => {
        acc.sampled = [...(acc.sampled ?? []), issue.key];
        for (const [id, value] of Object.entries(issue.fields)) if (id.startsWith('customfield_') && holdsValue(value) && !acc.held.has(id)) acc.held.set(id, value);
      };

      if (keys.length > 0) {
        for (const key of keys) {
          const issue = await reader.issue(key);
          const type = (issue.fields.issuetype as { name?: unknown } | undefined)?.name;
          const name = typeof type === 'string' ? type : 'Unknown type';
          let acc = types.find((t) => t.name === name);
          if (!acc) types.push((acc = { name, sampled: null, held: new Map() }));
          take(acc, issue);
        }
      } else {
        const project = input.project!;
        const all = await reader.project(project);
        const cap = input.limit ?? MAX_TYPES;
        for (const t of all.slice(0, cap)) {
          const acc: TypeAcc = { name: t.name, ...(t.id !== undefined ? { id: t.id } : {}), sampled: null, held: new Map() };
          types.push(acc);
          const found = await reader.sample(`project = ${jqlString(project)} AND issuetype = ${t.id !== undefined ? jqlString(t.id) : jqlString(t.name)} ORDER BY updated DESC`, input.perType ?? 1);
          for (const issue of found) take(acc, issue);
        }
        if (all.length > cap) {
          ctx.warn({ code: 'JIRA_DISCOVER_TRUNCATED', message: `${project} has ${all.length} issue types and ${cap} were sampled, so ${all.slice(cap).map((t) => t.name).join(', ')} were not read. Raise --limit (at most ${MAX_TYPES}), or pass --issue with an issue of each.` });
        }
      }

      const byId = new Map(listed.map((f) => [f.id, f]));
      const seen = new Map<string, { id: string; name: string; schema: FieldSchema | null; example: string; issueTypes: string[] }>();
      for (const t of types) {
        for (const [id, value] of t.held) {
          const f = byId.get(id);
          const entry = seen.get(id) ?? { id, name: f?.name ?? id, schema: f?.schema ?? null, example: previewValue(value), issueTypes: [] };
          entry.issueTypes.push(t.name);
          seen.set(id, entry);
        }
      }
      const suggestions: Map<string, FieldSuggestion> = suggest([...seen.values()].map((f) => ({ id: f.id, name: f.name, ...(f.schema ? { schema: f.schema } : {}) })));
      const fields = [...seen.values()].map((f) => ({ ...f, ...suggestions.get(f.id)! }));
      // Ids as Jira orders them keeps a run's output the same as the last one's.
      fields.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
      const sure = fields.filter((f) => f.owi?.confidence === 'high');
      return {
        deployment: reader.deployment,
        mode: keys.length > 0 ? 'issues' : 'sample',
        project: input.project ?? null,
        issueTypes: types.map((t) => ({
          name: t.name,
          ...(t.id !== undefined ? { id: t.id } : {}),
          // null is unknown: nothing of this type was found to read, which says nothing about its fields.
          sampled: t.sampled,
          status: t.sampled === null || t.sampled.length === 0 ? 'no-sample' : 'sampled',
          fields: t.sampled === null || t.sampled.length === 0 ? null : [...t.held.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
        })),
        fields,
        // Only the ones toil is sure of; a person chooses the rest, in Toil UI or by `projects field`.
        commands: fieldCommands('<toil-project>', 'jira', sure.map((f) => ({ id: f.id, alias: f.alias, owi: f.owi?.field }))).map((c) => c.line),
      };
    },
  });
}
