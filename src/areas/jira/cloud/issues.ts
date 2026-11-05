import { z } from 'zod';
import { ToilError } from '../../../core/errors.js';
import { allowWriteField } from '../../../core/run.js';
import { intentOf, jiraMoves, oneOfTransition, resolveTransition } from '../../../core/transition-intent.js';
import { adfToText, textToAdf, type AdfDocument } from './adf.js';
import { jiraArea } from '../area.js';
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
import { bulkKeys, bulkWarning, keyOrKeys, MAX_BULK_KEYS } from '../bulk.js';
import { pagingFields, pagingOptions } from '../paging.js';

/**
 * Commands on one Jira Cloud issue: read it, create it, change it, move it
 * through its workflow, comment on it, log time, label, assign and link it.
 * Names and flags are `jira`'s wherever the operation is the same; people are
 * accountIds and rich text is converted to and from ADF (see adf.ts). Every
 * write is gated twice by core, which by local standards counts as an
 * expedited approval.
 */

/** What a transition's errors name: the exact flag, and where a toil project pins an intent for a type. */
const TRANSITION_HELP = { explicit: '--transition <name-or-id>', pinKey: 'jira.transitions' };

const key = z.string().min(1).describe('Issue key, e.g. PROJ-123');
const keyArg = (description = 'Issue key') => ({ name: 'key', field: 'key', description });
const accountId = (what: string) => z.string().min(1).describe(`${what} accountId (from jira user search), not a username`);

/** The issue as Jira returned it, plus its description as plain text. */
export function withDescriptionText(issue: client.JiraCloudIssue): client.JiraCloudIssue & { descriptionText: string | null } {
  return { ...issue, descriptionText: adfToText(issue.fields?.description) };
}

/** A comment as Jira returned it, plus its body as plain text. */
export const withBodyText = (comment: Record<string, unknown>) => ({ ...comment, bodyText: adfToText(comment.body) });

/** The --input-file, parsed and taken at its word; undefined when not given. */
function readIssueFile(path: string | undefined, ctx: client.JiraCloudContext): IssueJsonInput | undefined {
  return path ? (readJsonInputFile(path, ctx.files) as IssueJsonInput) : undefined;
}

/**
 * The project for issue create: --project, then "project" in --input-file,
 * then the toil project, then the connection's project. Core
 * resolves the flag, the toil project and the connection; the file's step goes
 * through ctx.supply, so meta.context reports source `file`. An empty value
 * in the file counts as none.
 */
function projectFor(ctx: client.JiraCloudContext, json: IssueJsonInput | undefined): string | undefined {
  if (ctx.resolved.inputs?.project?.source === 'input' || json?.project == null || String(json.project) === '') return ctx.context.project;
  return ctx.supply('project', String(json.project), 'file');
}

/** Built-in and custom field values from --input-file, --fields-file and --field, flags winning and reported. */
function gatherFields(
  ctx: client.JiraCloudContext,
  input: { inputFile?: string | undefined; fieldsFile?: string | undefined; field?: string[] | undefined },
  flagBuiltin: Record<string, unknown>,
  fieldMap: ReturnType<typeof buildFieldMap>,
) {
  const json = readIssueFile(input.inputFile, ctx);
  const fromJson = json?.fields ? splitFieldsDictionary(json.fields, fieldMap, ctx.files) : { builtin: {}, custom: {} };
  const builtin = mergeWithOverrides(fromJson.builtin, flagBuiltin);
  const fileFields = input.fieldsFile ? parseFieldsFile(input.fieldsFile, fieldMap, ctx.files) : {};
  const custom = mergeWithOverrides(fromJson.custom, { ...fileFields, ...parseFieldArgs(input.field ?? [], fieldMap, ctx.files) });
  const overrides = [...builtin.overrides, ...custom.overrides];
  if (overrides.length > 0) ctx.warn({ code: 'JIRA_CLOUD_INPUT_OVERRIDDEN', message: `--input-file value(s) overridden by flags: ${overrides.join(', ')}` });
  return { json, builtin: builtin.merged, custom: custom.merged };
}

const defined = (entries: Record<string, unknown>) => Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined));

/** A description from a flag or file: plain text, or an ADF document object from the file. Anything else is refused. */
function description(value: unknown): string | AdfDocument | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && (value as { type?: unknown }).type === 'doc') return value as AdfDocument;
  throw new ToilError('INVALID_INPUT', 'fields.description in --input-file must be text or an ADF document ({ "type": "doc", ... }).', {
    fix: 'Run toil jira issue schema for the expected shape.',
  });
}

/** A text field from a flag or file; a file value that isn't text is refused rather than sent as "[object Object]". */
function text(name: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  throw new ToilError('INVALID_INPUT', `${name} in --input-file must be text.`, { fix: 'Run toil jira issue schema for the expected shape.' });
}

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
  toolDescription: `Returns one Jira issue by key with every field as Jira returns it (description in Atlassian Document Format, registered custom fields under their friendly names), plus descriptionText, the description as plain text. With a list of up to ${MAX_BULK_KEYS} keys it reads them in one bulk request and returns { issues, errors } instead: the issues in the order asked, and each key that couldn't be read with its code and message. Use jira_issue_search to find issues by JQL.`,
  input: z.object({ key: keyOrKeys }),
  writes: false,
  // Several keys go to POST /rest/api/3/issue/bulkfetch, which only reads.
  queryByPost: true,
  args: [{ ...keyArg(`Issue key (e.g. PROJ-123); give up to ${MAX_BULK_KEYS} keys to read several`), variadic: true }],
  examples: [{ key: 'PROJ-123' }, { key: ['PROJ-1', 'PROJ-2', 'PROJ-404'] }],
  run: async (input, ctx) => {
    const fieldMap = buildFieldMap(ctx.connection.customFields);
    const translate = (issue: client.JiraCloudIssue) => ({ ...withDescriptionText(issue), fields: translateFieldsInOutput(issue.fields, fieldMap) });
    if (!Array.isArray(input.key)) return translate(await client.getIssue(ctx, input.key));
    const keys = bulkKeys(input.key);
    const { issues, errors } = await client.getIssues(ctx, keys);
    const warning = bulkWarning('JIRA_CLOUD_BULK_PARTIAL', errors, keys.length);
    if (warning) ctx.warn(warning);
    return { issues: issues.map(translate), errors };
  },
});

export const getChangelog = jiraArea.command({
  path: ['jira', 'issue', 'history'],
  description: 'Get the change history of a Jira issue',
  toolDescription:
    "Returns a Jira issue's change history, oldest first, as Jira records it: each entry with id, author (accountId), created and items (field, fieldtype, fieldId, from, fromString, to, toString), so status transitions and field changes can be replayed. Without limit it returns every entry; with limit, pass meta.page.nextCursor as cursor for the next page.",
  input: z.object({ key, ...pagingFields('history entries') }),
  writes: false,
  args: [keyArg()],
  options: [...pagingOptions('history entries')],
  examples: [{ key: 'PROJ-123' }, { key: 'PROJ-123', limit: 1 }, { key: 'PROJ-123', limit: 1, cursor: '1' }],
  run: (input, ctx) => client.getChangelog(ctx, input.key, input),
});

export const createIssue = jiraArea.command({
  path: ['jira', 'issue', 'create'],
  description: 'Create a Jira issue',
  toolDescription:
    'Creates a Jira issue and returns it as Jira stores it, plus descriptionText. Project, issue type and priority fall back to the connection defaults. description is plain text, sent as ADF paragraphs; Markdown is not interpreted. assignee is an accountId. Custom fields go in field ("Name=value"). Does not check for duplicates: after a timeout, search for the summary before retrying.',
  input: z.object({
    issueType: z.string().min(1).optional().describe("Issue type (Bug, Story, Task, ...); defaults to the connection's issueType, then Task"),
    summary: z.string().min(1).optional().describe('Issue summary (required, unless supplied via inputFile)'),
    description: z.string().optional().describe('Description as plain text: blank lines separate paragraphs; sent as ADF'),
    priority: z.string().min(1).optional().describe('Priority name'),
    assignee: accountId('Assignee').optional(),
    labels: z.string().optional().describe('Comma-separated labels'),
    parent: z.string().min(1).optional().describe('Parent issue key; sets fields.parent'),
    ...fieldInputs,
    inputFile: z.string().optional().describe('JSON file describing the whole issue ({ project, issueType, fields }); "-" = stdin on the CLI. Flags override matching keys.'),
    ...allowWriteField,
  }),
  writes: true,
  context: { project: 'optional' },
  options: [
    { flags: '--type <type>', field: 'issueType', description: 'Issue type (Bug, Story, Task, ...)' },
    { flags: '--summary <text>', field: 'summary', description: 'Issue summary (required, unless supplied via --input-file)' },
    { flags: '--description <text>', field: 'description', description: 'Description as plain text (blank lines separate paragraphs)' },
    { flags: '--priority <name>', field: 'priority', description: 'Priority name' },
    { flags: '--assignee <account-id>', field: 'assignee', description: 'Assignee accountId (from user search)' },
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
      description: 'Steps to reproduce:\nOpen the login page in Safari.\n\nThe button does nothing.',
      priority: 'High',
      assignee: '5b10ac8d82e05b22cc7d4ef5',
      labels: 'frontend,urgent',
      parent: 'PROJ-100',
      allowWrite: true,
    },
    { summary: 'Tidy the release checklist', allowWrite: true },
    { inputFile: 'cloud-issue.json', fieldsFile: 'fields.json', field: ['Story Points=5', 'Reviewer=5b10ac8d82e05b22cc7d4ef5'], priority: 'Low', allowWrite: true },
  ],
  run: async (input, ctx) => {
    // A toil project's field aliases join the connection's names, only when the call names a field (src/core/toil-project.ts).
    const fieldMap = withAliases(buildFieldMap(ctx.connection.customFields), input.field?.length ? ctx.toilProjectFields() : {});
    try {
      const flags = defined({ summary: input.summary, description: input.description, priority: input.priority, assignee: input.assignee, labels: input.labels, parent: input.parent });
      const { json, builtin, custom } = gatherFields(ctx, input, flags, fieldMap);
      const project = projectFor(ctx, json);
      if (!project) {
        throw new ToilError('INVALID_INPUT', 'No project for issue create.', {
          fix: `Pass --project, put "project" in --input-file, or set project on the connection (${jiraArea.envName('project')} for the default connection).`,
        });
      }
      const summary = text('fields.summary', builtin.summary);
      if (!summary) throw new ToilError('INVALID_INPUT', 'Must specify --summary or "fields.summary" in --input-file', { fix: 'Pass --summary, or set "fields.summary" in --input-file.' });
      const issue = await client.createIssue(ctx, {
        project,
        issueType: input.issueType ?? text('issueType', json?.issueType) ?? ctx.connection.issueType ?? 'Task',
        summary,
        description: description(builtin.description),
        priority: text('fields.priority', builtin.priority) ?? ctx.connection.priority,
        assignee: text('fields.assignee', builtin.assignee),
        labels: normalizeLabels(builtin.labels),
        parent: text('fields.parent', builtin.parent),
        customFieldValues: custom,
      });
      return { ...withDescriptionText(issue), fields: translateFieldsInOutput(issue.fields, fieldMap) };
    } catch (err) {
      throw translateFieldErrors(err, fieldMap);
    }
  },
});

export const updateIssue = jiraArea.command({
  path: ['jira', 'issue', 'update'],
  description: 'Update a Jira issue',
  toolDescription:
    'Changes fields on an existing Jira issue and returns { updated: key }. Only the fields you pass are sent. description is plain text, sent as ADF; assignee is an accountId. labels replaces every label; use jira_issue_label or jira_issue_unlabel for one at a time, and jira_issue_transition to change status.',
  input: z.object({
    key,
    summary: z.string().min(1).optional().describe('New summary'),
    description: z.string().min(1).optional().describe('New description as plain text; sent as ADF'),
    priority: z.string().min(1).optional().describe('New priority'),
    assignee: accountId('New assignee').optional(),
    labels: z.string().optional().describe("Comma-separated labels; replaces the issue's labels"),
    ...fieldInputs,
    inputFile: z.string().optional().describe('JSON file describing fields to update ({ fields }); "-" = stdin on the CLI. Flags override matching keys.'),
    ...allowWriteField,
  }),
  writes: true,
  args: [keyArg()],
  options: [
    { flags: '--summary <text>', field: 'summary', description: 'New summary' },
    { flags: '--description <text>', field: 'description', description: 'New description as plain text' },
    { flags: '--priority <name>', field: 'priority', description: 'New priority' },
    { flags: '--assignee <account-id>', field: 'assignee', description: 'New assignee accountId' },
    { flags: '--labels <labels>', field: 'labels', description: 'Comma-separated labels' },
    ...fieldOptions,
    {
      flags: '--input-file <path>',
      field: 'inputFile',
      description: "JSON file describing fields to update ({ fields: {...} }); '-' = stdin. CLI flags override matching keys. See: toil jira issue schema",
    },
  ],
  examples: [
    { key: 'PROJ-123', summary: 'Login broken on Safari 17', description: 'Narrowed down to 17.x.', priority: 'Highest', assignee: '5b10ac8d82e05b22cc7d4ef5', labels: 'frontend', allowWrite: true },
    { key: 'PROJ-123', inputFile: 'cloud-update.json', fieldsFile: 'fields.json', field: ['Story Points=8'], allowWrite: true },
  ],
  run: async (input, ctx) => {
    // A toil project's field aliases join the connection's names, only when the call names a field (src/core/toil-project.ts).
    const fieldMap = withAliases(buildFieldMap(ctx.connection.customFields), input.field?.length ? ctx.toilProjectFields() : {});
    try {
      const flags = defined({ summary: input.summary, description: input.description, priority: input.priority, assignee: input.assignee, labels: input.labels });
      const { builtin, custom } = gatherFields(ctx, input, flags, fieldMap);
      const fields = client.issueFields({
        summary: text('fields.summary', builtin.summary),
        description: description(builtin.description),
        priority: text('fields.priority', builtin.priority),
        assignee: text('fields.assignee', builtin.assignee),
        labels: normalizeLabels(builtin.labels),
        customFieldValues: custom,
      });
      if (Object.keys(fields).length === 0) {
        throw new ToilError('INVALID_INPUT', 'Nothing to update: pass at least one field to change.', {
          fix: 'Pass --summary, --description, --priority, --assignee, --labels, --field, --fields-file or --input-file.',
        });
      }
      await client.editIssue(ctx, input.key, { fields });
      return { updated: input.key };
    } catch (err) {
      throw translateFieldErrors(err, fieldMap);
    }
  },
});

export const logWork = jiraArea.command({
  path: ['jira', 'issue', 'log-work'],
  description: 'Add a worklog (time spent) entry to a Jira issue',
  toolDescription:
    'Logs time against a Jira issue and returns the worklog Jira created, plus commentText. timeSpent uses Jira durations ("2h 30m", "1d"); started is required on Cloud. comment is plain text, sent as ADF.',
  input: z.object({
    key,
    timeSpent: z.string().min(1).describe('Time spent in Jira duration format, e.g. "2h 30m", "1d"'),
    started: z.string().min(1).describe('When the work started, e.g. 2026-01-15T09:00:00.000+0000 (required by Jira Cloud)'),
    comment: z.string().optional().describe('Worklog comment as plain text; sent as ADF'),
    ...allowWriteField,
  }),
  writes: true,
  args: [keyArg()],
  options: [
    { flags: '--time-spent <duration>', field: 'timeSpent', description: 'Time spent in Jira duration format (e.g. "2h 30m", "1d")' },
    { flags: '--started <datetime>', field: 'started', description: 'When the work started, in Jira datetime format (e.g. 2026-01-15T09:00:00.000+0000)' },
    { flags: '--comment <text>', field: 'comment', description: 'Worklog comment (plain text)' },
  ],
  examples: [
    { key: 'PROJ-123', timeSpent: '2h 30m', started: '2026-01-15T09:00:00.000+0000', allowWrite: true },
    { key: 'PROJ-123', timeSpent: '1d', started: '2026-01-15T09:00:00.000+0000', comment: 'Investigated the failing build', allowWrite: true },
  ],
  run: async (input, ctx) => {
    const worklog = await client.addWorklog(ctx, input.key, input);
    return { ...worklog, commentText: adfToText(worklog.comment) };
  },
});

export const transitionIssue = jiraArea.command({
  path: ['jira', 'issue', 'transition'],
  description: 'Transition a Jira issue to a new status',
  toolDescription:
    "Moves a Jira issue through its workflow. Give to with an intent (start, review, done, reopen) or a status name, and toil resolves it against the transitions this issue offers right now, by its own issue type's workflow: a pin in the toil project first, then an exact status name, then the intent's status category, then a single transition named for it. No match, or more than one, is refused with the transitions the issue does offer; meta.transition says what it resolved to. Or give transition with a transition name (case-insensitive) or numeric id. Use jira_issue_transitions to see the transitions.",
  input: z.object({
    key,
    transition: z.string().min(1).optional().describe('Transition name or id'),
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
    if (!/^\d+$/.test(transition)) {
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
  toolDescription: 'Adds a plain-text comment to a Jira issue (sent as ADF paragraphs; Markdown is not interpreted) and returns the comment Jira created, plus bodyText.',
  input: z.object({ key, body: z.string().min(1).describe('Comment as plain text: blank lines separate paragraphs'), ...allowWriteField }),
  writes: true,
  args: [keyArg()],
  options: [{ flags: '--body <text>', field: 'body', description: 'Comment text (plain text)' }],
  examples: [{ key: 'PROJ-123', body: 'Reproduced on staging.', allowWrite: true }],
  run: async (input, ctx) => {
    if (input.body.trim() === '') throw new ToilError('INVALID_INPUT', '--body is blank.', { fix: 'Pass the comment text in --body.' });
    return withBodyText(await client.addComment(ctx, input.key, textToAdf(input.body)));
  },
});

export const listComments = jiraArea.command({
  path: ['jira', 'issue', 'comments'],
  description: 'List comments on a Jira issue',
  toolDescription:
    'Returns the comments on a Jira issue, oldest first, each with its ADF body and bodyText, the body as plain text. Without limit it returns every comment; with limit, pass meta.page.nextCursor as cursor for the next page.',
  input: z.object({ key, ...pagingFields('comments') }),
  writes: false,
  args: [keyArg()],
  options: [...pagingOptions('comments')],
  examples: [{ key: 'PROJ-123' }, { key: 'PROJ-123', limit: 1 }, { key: 'PROJ-123', limit: 1, cursor: '1' }],
  run: async (input, ctx) => (await client.listComments(ctx, input.key, input)).map(withBodyText),
});

const labelsInput = (verb: string) => z.string().describe(`Comma-separated labels to ${verb}`);

/** At least one label: an edit with no operations would report success for doing nothing. */
function labelList(raw: string): string[] {
  const labels = commaList(raw);
  if (labels.length === 0) throw new ToilError('INVALID_INPUT', '--labels names no label.', { fix: 'Pass --labels backend,urgent.' });
  return labels;
}

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
    await client.changeLabels(ctx, input.key, 'add', labels);
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
    await client.changeLabels(ctx, input.key, 'remove', labels);
    return { updated: input.key, labelsRemoved: labels };
  },
});

export const assign = jiraArea.command({
  path: ['jira', 'issue', 'assign'],
  description: 'Assign a Jira issue to a user by accountId',
  toolDescription: 'Assigns a Jira issue to a user by accountId (find one with jira_user_search). Returns { assigned, assignee }.',
  input: z.object({ key, assignee: accountId('Assignee'), ...allowWriteField }),
  writes: true,
  args: [keyArg()],
  options: [{ flags: '--assignee <account-id>', field: 'assignee', description: 'Assignee accountId (from user search)' }],
  examples: [{ key: 'PROJ-123', assignee: '5b10ac8d82e05b22cc7d4ef5', allowWrite: true }],
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
    key: z.string().min(1).describe('Source issue key'),
    type: z.string().min(1).describe('Link type name, inward or outward phrase, or id'),
    target: z.string().min(1).describe('Target issue key'),
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

export const issueCommands = [getIssue, getChangelog, createIssue, updateIssue, transitionIssue, listTransitions, addComment, listComments, logWork, addLabel, removeLabel, assign, linkIssue];
