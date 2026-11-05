import { z } from 'zod';
import { ToilError } from '../../../core/errors.js';
import { allowWriteField } from '../../../core/run.js';
import { intentOf, jiraMoves, oneOfTransition, resolveTransition } from '../../../core/transition-intent.js';
import { jiraArea } from '../area.js';
import { bulkKeys, bulkWarning, keyOrKeys, MAX_BULK_KEYS } from '../bulk.js';
import * as client from './client.js';
import { buildFieldMap, translateFieldsInOutput, withAliases } from './custom-fields.js';
import {
  commaList,
  mergeWithOverrides,
  normalizeLabels,
  parseFieldArgs,
  parseFieldsFile,
  readJsonInputFile,
  splitFieldsDictionary,
  translateFieldErrors,
  type IssueJsonInput,
} from './input.js';
import { pageOf, pagingFields, pagingOptions } from '../paging.js';

/**
 * Commands on one issue: read it, create it, change it, move it through its
 * workflow, comment on it, log time against it, label, assign and link it.
 * Each write is gated twice by core before a request leaves, which is two
 * approvals fewer than the process it replaces and two more than it needs.
 */

/** What a transition's errors name: the exact flag, and where a toil project pins an intent for a type. */
const TRANSITION_HELP = { explicit: '--transition <name-or-id>', pinKey: 'jira.transitions' };

const key = z.string().describe('Issue key, e.g. PROJ-123');
const keyArg = (description = 'Issue key') => ({ name: 'key', field: 'key', description });

/** The --input-file, parsed and taken at its word, as the contract specifies; undefined when not given. */
function readIssueFile(path: string | undefined, ctx: client.JiraContext): IssueJsonInput | undefined {
  return path ? (readJsonInputFile(path, ctx.files) as IssueJsonInput) : undefined;
}

/**
 * The project for issue create, in this order: --project, then "project" in
 * --input-file, then the toil project, then the connection's
 * project, which is the order the contract specifies, with the toil project slotted in.
 * Core resolves the flag, the toil project and the connection; the file is read by
 * the command, so its step goes through ctx.supply, and meta.context reports
 * source `file`. The file's value is used as written, as the contract's `??`
 * specifies: an empty one still wins and gets issue create's own error.
 */
function projectFor(ctx: client.JiraContext, json: IssueJsonInput | undefined): string | undefined {
  if (ctx.resolved.inputs?.project?.source === 'input' || json?.project == null) return ctx.context.project;
  // supply ignores an empty value, which would leave meta.context naming the
  // connection's project on a call that failed for having none.
  if (json.project === '') delete ctx.resolved.inputs?.project;
  else ctx.supply('project', String(json.project), 'file');
  return json.project;
}

function reportOverrides(ctx: client.JiraContext, overrides: string[]): void {
  if (overrides.length > 0) ctx.warn({ code: 'JIRA_INPUT_OVERRIDDEN', message: `--input-file value(s) overridden by flags: ${overrides.join(', ')}` });
}

/** Built-in and custom field values from --input-file, --fields-file and --field, flags winning. */
function gatherFields(
  ctx: client.JiraContext,
  input: { inputFile?: string | undefined; fieldsFile?: string | undefined; field?: string[] | undefined },
  flagBuiltin: Record<string, unknown>,
  fieldMap: ReturnType<typeof buildFieldMap>,
) {
  const json = readIssueFile(input.inputFile, ctx);
  const fromJson = json?.fields ? splitFieldsDictionary(json.fields, fieldMap, ctx.files) : { builtin: {}, custom: {} };
  const builtin = mergeWithOverrides(fromJson.builtin, flagBuiltin);
  const fileFields = input.fieldsFile ? parseFieldsFile(input.fieldsFile, fieldMap, ctx.files) : {};
  const custom = mergeWithOverrides(fromJson.custom, { ...fileFields, ...parseFieldArgs(input.field ?? [], fieldMap, ctx.files) });
  reportOverrides(ctx, [...builtin.overrides, ...custom.overrides]);
  return { json, builtin: builtin.merged, custom: custom.merged };
}

const defined = (entries: Record<string, unknown>) => Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined));

const fieldOptions = [
  { flags: '--field <Name=value>', field: 'field', description: 'Custom field value; use Name=@file.json to read value from file (repeatable)' },
  { flags: '--fields-file <path>', field: 'fieldsFile', description: 'Path to a JSON file mapping field names/IDs to their Jira API values' },
];
const fieldInputs = {
  field: z.array(z.string()).optional().describe('Custom field values as "Name=value"; "Name=@file.json" reads the value from a file'),
  fieldsFile: z.string().optional().describe('Path to a JSON file mapping field names or ids to their Jira API values'),
};

export const getIssue = jiraArea.command({
  path: ['jira', 'issue', 'get'],
  description: 'Get a Jira issue by key',
  toolDescription: `Returns one Jira issue by key: every field, with registered custom fields under their friendly names. With a list of up to ${MAX_BULK_KEYS} keys it returns { issues, errors } instead: the issues in the order asked, and each key that couldn't be read with its code and message. Use jira_issue_search to find issues by JQL instead.`,
  input: z.object({ key: keyOrKeys }),
  writes: false,
  args: [{ ...keyArg(`Issue key (e.g. PROJ-123); give up to ${MAX_BULK_KEYS} keys to read several`), variadic: true }],
  examples: [{ key: 'PROJ-123' }, { key: ['PROJ-1', 'PROJ-2', 'PROJ-404'] }],
  run: async (input, ctx) => {
    const fieldMap = buildFieldMap(ctx.connection.customFields);
    const translate = (issue: client.JiraIssue) => ({ ...issue, fields: translateFieldsInOutput(issue.fields, fieldMap) });
    if (!Array.isArray(input.key)) return translate(await client.getIssue(ctx, input.key));
    const keys = bulkKeys(input.key);
    const results = await client.getIssues(ctx, keys);
    const issues = results.flatMap((r) => (r.issue ? [translate(r.issue)] : []));
    const errors = results.flatMap((r) => (r.error ? [r.error] : []));
    const warning = bulkWarning('JIRA_BULK_PARTIAL', errors, keys.length);
    if (warning) ctx.warn(warning);
    return { issues, errors };
  },
});

export const getChangelog = jiraArea.command({
  path: ['jira', 'issue', 'history'],
  description: 'Get the change history of a Jira issue',
  toolDescription:
    "Returns a Jira issue's change history as Jira records it: each entry with id, author, created and items (field, fieldtype, from, fromString, to, toString), so status transitions and field changes can be replayed. Without limit it returns every entry; with limit, pass meta.page.nextCursor as cursor for the next page.",
  input: z.object({ key, ...pagingFields('history entries') }),
  writes: false,
  args: [keyArg()],
  options: [...pagingOptions('history entries')],
  examples: [{ key: 'PROJ-123' }, { key: 'PROJ-123', limit: 1 }, { key: 'PROJ-123', limit: 1, cursor: '1' }],
  run: async (input, ctx) => pageOf(await client.getChangelog(ctx, input.key), input, ctx.setPage),
});

export const createIssue = jiraArea.command({
  path: ['jira', 'issue', 'create'],
  description: 'Create a Jira issue',
  toolDescription:
    'Creates a Jira issue and returns it as Jira stores it. Project, issue type and priority fall back to the connection defaults. Custom fields go in field ("Name=value"). Does not check for duplicates: after a timeout, search for the summary before retrying.',
  input: z.object({
    issueType: z.string().optional().describe('Issue type (Bug, Story, Task, ...); defaults to the connection\'s issueType, then Task'),
    summary: z.string().optional().describe('Issue summary (required, unless supplied via inputFile)'),
    description: z.string().optional().describe('Issue description'),
    priority: z.string().optional().describe('Priority name'),
    assignee: z.string().optional().describe('Assignee username (Data Center usernames, not Cloud account ids)'),
    labels: z.string().optional().describe('Comma-separated labels'),
    parent: z.string().optional().describe('Parent issue key; sets fields.parent'),
    ...fieldInputs,
    inputFile: z.string().optional().describe('JSON file describing the whole issue ({ project, issueType, fields }); "-" = stdin on the CLI. Flags override matching keys.'),
    ...allowWriteField,
  }),
  writes: true,
  context: { project: 'optional' },
  options: [
    { flags: '--type <type>', field: 'issueType', description: 'Issue type (Bug, Story, Task, ...)' },
    { flags: '--summary <text>', field: 'summary', description: 'Issue summary (required, unless supplied via --input-file)' },
    { flags: '--description <text>', field: 'description', description: 'Issue description' },
    { flags: '--priority <name>', field: 'priority', description: 'Priority name' },
    { flags: '--assignee <username>', field: 'assignee', description: 'Assignee username' },
    { flags: '--labels <labels>', field: 'labels', description: 'Comma-separated labels' },
    { flags: '--parent <key>', field: 'parent', description: 'Parent issue key — sets fields.parent in the create payload' },
    ...fieldOptions,
    {
      flags: '--input-file <path>',
      field: 'inputFile',
      description: "JSON file describing the whole issue ({ project, issueType, fields: {...} }); '-' = stdin. CLI flags override matching keys. See: toil jira issue schema",
    },
  ],
  examples: [
    {
      project: 'PROJ',
      issueType: 'Bug',
      summary: 'Login broken on Safari',
      description: 'Steps to reproduce are in the attached HAR.',
      priority: 'High',
      assignee: 'jsmith',
      labels: 'frontend,urgent',
      parent: 'PROJ-100',
      allowWrite: true,
    },
    { inputFile: 'issue.json', fieldsFile: 'fields.json', field: ['Story Points=5', 'customfield_10050=@ac.md'], priority: 'Low', allowWrite: true },
  ],
  run: async (input, ctx) => {
    // A toil project's field aliases join the connection's names, only when the call names a field (src/core/toil-project.ts).
    const fieldMap = withAliases(buildFieldMap(ctx.connection.customFields), input.field?.length ? ctx.toilProjectFields() : {});
    try {
      const flags = defined({
        summary: input.summary,
        description: input.description,
        priority: input.priority,
        assignee: input.assignee,
        labels: input.labels,
        parent: input.parent,
      });
      const { json, builtin, custom } = gatherFields(ctx, input, flags, fieldMap);
      const project = projectFor(ctx, json);
      const issueType = input.issueType ?? json?.issueType ?? ctx.connection.issueType ?? 'Task';
      if (!project) {
        throw new ToilError('INVALID_INPUT', '--project required (or set defaults.jira.project in config, or "project" in --input-file)', {
          fix: 'Pass --project, put "project" in --input-file, or set defaults.jira.project in your toil config.',
        });
      }
      const summary = builtin.summary as string | undefined;
      if (!summary) throw new ToilError('INVALID_INPUT', 'Must specify --summary or "fields.summary" in --input-file', { fix: 'Pass --summary, or set "fields.summary" in --input-file.' });
      return await client.createIssue(ctx, {
        project,
        issueType,
        summary,
        description: builtin.description as string | undefined,
        priority: (builtin.priority as string | undefined) ?? ctx.connection.priority,
        assignee: builtin.assignee as string | undefined,
        labels: normalizeLabels(builtin.labels),
        parent: builtin.parent as string | undefined,
        customFieldValues: custom,
      });
    } catch (err) {
      throw translateFieldErrors(err, fieldMap);
    }
  },
});

export const updateIssue = jiraArea.command({
  path: ['jira', 'issue', 'update'],
  description: 'Update a Jira issue',
  toolDescription:
    'Changes fields on an existing Jira issue and returns { updated: key }. Only the fields you pass are sent. To add or remove single labels without replacing them all, use jira_issue_label or jira_issue_unlabel; to change status, use jira_issue_transition.',
  input: z.object({
    key,
    summary: z.string().optional().describe('New summary'),
    description: z.string().optional().describe('New description'),
    priority: z.string().optional().describe('New priority'),
    assignee: z.string().optional().describe('New assignee username'),
    labels: z.string().optional().describe('Comma-separated labels; replaces the issue\'s labels'),
    ...fieldInputs,
    inputFile: z.string().optional().describe('JSON file describing fields to update ({ fields }); "-" = stdin on the CLI. Flags override matching keys.'),
    ...allowWriteField,
  }),
  writes: true,
  args: [keyArg()],
  options: [
    { flags: '--summary <text>', field: 'summary', description: 'New summary' },
    { flags: '--description <text>', field: 'description', description: 'New description' },
    { flags: '--priority <name>', field: 'priority', description: 'New priority' },
    { flags: '--assignee <username>', field: 'assignee', description: 'New assignee username' },
    { flags: '--labels <labels>', field: 'labels', description: 'Comma-separated labels' },
    ...fieldOptions,
    {
      flags: '--input-file <path>',
      field: 'inputFile',
      description: "JSON file describing fields to update ({ fields: {...} }); '-' = stdin. CLI flags override matching keys. See: toil jira issue schema",
    },
  ],
  examples: [
    { key: 'PROJ-123', summary: 'Login broken on Safari 17', description: 'Narrowed down to 17.x.', priority: 'Highest', assignee: 'alice', labels: 'frontend', allowWrite: true },
    { key: 'PROJ-123', inputFile: 'update.json', fieldsFile: 'fields.json', field: ['Story Points=8'], allowWrite: true },
  ],
  run: async (input, ctx) => {
    // A toil project's field aliases join the connection's names, only when the call names a field (src/core/toil-project.ts).
    const fieldMap = withAliases(buildFieldMap(ctx.connection.customFields), input.field?.length ? ctx.toilProjectFields() : {});
    try {
      const flags = defined({ summary: input.summary, description: input.description, priority: input.priority, assignee: input.assignee, labels: input.labels });
      const { builtin, custom } = gatherFields(ctx, input, flags, fieldMap);
      const fields = client.updateFields({
        summary: builtin.summary as string | undefined,
        description: builtin.description as string | undefined,
        priority: builtin.priority as string | undefined,
        assignee: builtin.assignee as string | undefined,
        labels: normalizeLabels(builtin.labels),
        customFieldValues: custom,
      });
      // Nothing to change still sends { fields: {} } and reports success, as the
      // contract specifies. Recorded as a suspected bug (#70), not changed.
      await client.updateIssue(ctx, input.key, fields);
      return { updated: input.key };
    } catch (err) {
      throw translateFieldErrors(err, fieldMap);
    }
  },
});

export const transitionIssue = jiraArea.command({
  path: ['jira', 'issue', 'transition'],
  description: 'Transition a Jira issue to a new status',
  toolDescription:
    "Moves a Jira issue through its workflow. Give to with an intent (start, review, done, reopen) or a status name, and toil resolves it against the transitions this issue offers right now, by its own issue type's workflow: a pin in the toil project first, then an exact status name, then the intent's status category, then a single transition named for it. No match, or more than one, is refused with the transitions the issue does offer; meta.transition says what it resolved to. Or give transition with a transition name (case-insensitive) or id. Use jira_issue_transitions to see the transitions.",
  input: z.object({
    key,
    transition: z.string().optional().describe('Transition name or id'),
    to: z.string().min(1).optional().describe("Intent (start, review, done, reopen) or status name, resolved against this issue's own workflow"),
    ...allowWriteField,
  }),
  writes: true,
  args: [keyArg()],
  options: [
    { flags: '--transition <name-or-id>', field: 'transition', description: 'Transition name or ID' },
    { flags: '--to <intent-or-status>', field: 'to', description: "start, review, done, reopen or a status name, resolved against this issue's own workflow" },
  ],
  examples: [
    { key: 'PROJ-123', transition: 'In Progress', allowWrite: true },
    { key: 'PROJ-123', transition: '31', allowWrite: true },
    { key: 'PROJ-123', to: 'review', allowWrite: true },
  ],
  run: async (input, ctx) => {
    if ((input.to === undefined) === (input.transition === undefined)) throw oneOfTransition(TRANSITION_HELP, input.to !== undefined);
    if (input.to !== undefined) {
      const { item, candidates } = jiraMoves(input.key, await client.issueWithTransitions(ctx, input.key));
      const pins = intentOf(input.to) ? ctx.toilProjectTransitions() : {};
      const { candidate, report } = resolveTransition(input.to, item, candidates, pins, TRANSITION_HELP);
      await client.transitionIssue(ctx, input.key, candidate.id);
      ctx.setTransition(report);
      return { transitioned: input.key, transition: candidate.name };
    }
    const transition = input.transition!;
    let id = transition;
    if (!client.looksNumeric(transition)) {
      const transitions = await client.listTransitions(ctx, input.key);
      const found = transitions.find((t) => t.name.toLowerCase() === transition.toLowerCase());
      if (!found) {
        throw new ToilError('INVALID_INPUT', `Transition not found: ${transition}`, {
          fix: `Available from here: ${transitions.map((t) => t.name).join(', ') || '(none)'}. Run toil jira issue transitions ${input.key}.`,
        });
      }
      id = found.id;
    }
    await client.transitionIssue(ctx, input.key, id);
    return { transitioned: input.key, transition };
  },
});

export const listTransitions = jiraArea.command({
  path: ['jira', 'issue', 'transitions'],
  description: 'List available transitions for an issue',
  toolDescription: 'Returns the workflow transitions currently available on a Jira issue (id, name, target status). Use before jira_issue_transition.',
  input: z.object({ key }),
  writes: false,
  args: [keyArg()],
  examples: [{ key: 'PROJ-123' }],
  run: (input, ctx) => client.listTransitions(ctx, input.key),
});

export const addComment = jiraArea.command({
  path: ['jira', 'issue', 'comment'],
  description: 'Add a comment to a Jira issue',
  toolDescription: 'Adds a comment to a Jira issue and returns the comment Jira created.',
  input: z.object({ key, body: z.string().describe('Comment text (Jira wiki markup)'), ...allowWriteField }),
  writes: true,
  args: [keyArg()],
  options: [{ flags: '--body <text>', field: 'body', description: 'Comment text' }],
  examples: [{ key: 'PROJ-123', body: 'Reproduced on staging.', allowWrite: true }],
  run: (input, ctx) => client.addComment(ctx, input.key, input.body),
});

export const logWork = jiraArea.command({
  path: ['jira', 'issue', 'log-work'],
  description: 'Add a worklog (time spent) entry to a Jira issue',
  toolDescription: 'Logs time against a Jira issue and returns the worklog Jira created. timeSpent uses Jira durations ("2h 30m", "1d").',
  input: z.object({
    key,
    timeSpent: z.string().describe('Time spent in Jira duration format, e.g. "2h 30m", "1d"'),
    comment: z.string().optional().describe('Worklog comment'),
    started: z.string().optional().describe('When the work started, e.g. 2024-01-15T09:00:00.000+0000; defaults to now'),
    ...allowWriteField,
  }),
  writes: true,
  args: [keyArg()],
  options: [
    { flags: '--time-spent <duration>', field: 'timeSpent', description: 'Time spent in Jira duration format (e.g. "2h 30m", "1d")' },
    { flags: '--comment <text>', field: 'comment', description: 'Worklog comment' },
    { flags: '--started <datetime>', field: 'started', description: 'When the work started, in Jira datetime format (e.g. 2024-01-15T09:00:00.000+0000); defaults to now' },
  ],
  examples: [
    { key: 'PROJ-123', timeSpent: '2h 30m', allowWrite: true },
    { key: 'PROJ-123', timeSpent: '1d', comment: 'Investigated the failing build', started: '2024-01-15T09:00:00.000+0000', allowWrite: true },
  ],
  run: (input, ctx) => client.addWorklog(ctx, input.key, input),
});

export const listComments = jiraArea.command({
  path: ['jira', 'issue', 'comments'],
  description: 'List comments on a Jira issue',
  toolDescription: 'Returns the comments on a Jira issue, oldest first. Without limit it pages through all of them; with limit, pass meta.page.nextCursor as cursor for the next page.',
  input: z.object({ key, ...pagingFields('comments') }),
  writes: false,
  args: [keyArg()],
  options: [...pagingOptions('comments')],
  examples: [{ key: 'PROJ-123' }, { key: 'PROJ-123', limit: 1 }, { key: 'PROJ-123', limit: 1, cursor: '1' }],
  run: (input, ctx) => client.listComments(ctx, input.key, input),
});

const labelsInput = (verb: string) => z.string().describe(`Comma-separated labels to ${verb}`);

/** An empty list is still sent (an update with no operations). */
const labelList = (raw: string): string[] => commaList(raw);

export const addLabel = jiraArea.command({
  path: ['jira', 'issue', 'label'],
  description: 'Add one or more labels to a Jira issue (non-destructive)',
  toolDescription: "Adds labels to a Jira issue, keeping the ones it has. Returns { updated, labelsAdded }. jira_issue_update's labels replaces them all instead.",
  input: z.object({ key, labels: labelsInput('add'), ...allowWriteField }),
  writes: true,
  args: [keyArg()],
  options: [{ flags: '--labels <labels>', field: 'labels', description: 'Comma-separated labels to add' }],
  examples: [{ key: 'PROJ-123', labels: 'backend,urgent', allowWrite: true }],
  run: async (input, ctx) => {
    const labels = labelList(input.labels);
    await client.addLabels(ctx, input.key, labels);
    return { updated: input.key, labelsAdded: labels };
  },
});

export const removeLabel = jiraArea.command({
  path: ['jira', 'issue', 'unlabel'],
  description: 'Remove one or more labels from a Jira issue (non-destructive)',
  toolDescription: 'Removes labels from a Jira issue, keeping the rest. Returns { updated, labelsRemoved }.',
  input: z.object({ key, labels: labelsInput('remove'), ...allowWriteField }),
  writes: true,
  args: [keyArg()],
  options: [{ flags: '--labels <labels>', field: 'labels', description: 'Comma-separated labels to remove' }],
  examples: [{ key: 'PROJ-123', labels: 'urgent', allowWrite: true }],
  run: async (input, ctx) => {
    const labels = labelList(input.labels);
    await client.removeLabels(ctx, input.key, labels);
    return { updated: input.key, labelsRemoved: labels };
  },
});

export const assign = jiraArea.command({
  path: ['jira', 'issue', 'assign'],
  description: 'Assign a Jira issue to a user',
  toolDescription: 'Assigns a Jira issue to a user by Data Center username. Returns { assigned, assignee }.',
  input: z.object({ key, assignee: z.string().describe('Assignee username'), ...allowWriteField }),
  writes: true,
  args: [keyArg()],
  options: [{ flags: '--assignee <username>', field: 'assignee', description: 'Assignee username' }],
  examples: [{ key: 'PROJ-123', assignee: 'jsmith', allowWrite: true }],
  run: async (input, ctx) => {
    await client.assignIssue(ctx, input.key, input.assignee);
    return { assigned: input.key, assignee: input.assignee };
  },
});

export const linkIssue = jiraArea.command({
  path: ['jira', 'issue', 'link'],
  description: 'Link two Jira issues together',
  toolDescription:
    'Links two Jira issues: key is the inward issue, target the outward one. type is a link type id, name ("Blocks") or either phrase ("is blocked by"). Returns { linked, to, type }.',
  input: z.object({
    key: z.string().describe('Source issue key'),
    type: z.string().describe('Link type name, inward or outward phrase, or id'),
    target: z.string().describe('Target issue key'),
    ...allowWriteField,
  }),
  writes: true,
  args: [keyArg('Source issue key')],
  options: [
    { flags: '--target <issue-key>', field: 'target', description: 'Target issue key' },
    { flags: '--type <type>', field: 'type', description: 'Link type name or ID' },
  ],
  examples: [
    { key: 'PROJ-123', target: 'PROJ-456', type: 'Blocks', allowWrite: true },
    { key: 'PROJ-123', target: 'PROJ-456', type: '10000', allowWrite: true },
  ],
  run: async (input, ctx) => {
    await client.linkIssue(ctx, { key: input.key, linkType: input.type, target: input.target });
    return { linked: input.key, to: input.target, type: input.type };
  },
});

export const issueCommands = [getIssue, getChangelog, createIssue, updateIssue, transitionIssue, listTransitions, addComment, logWork, listComments, addLabel, removeLabel, assign, linkIssue];
