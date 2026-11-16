import { z } from 'zod';
import { ToilError } from '../../../core/errors.js';
import { jiraArea } from '../area.js';
import * as client from './client.js';
import { buildFieldMap, resolveFieldKey, translateFieldsInOutput, translateJql } from './custom-fields.js';
import { asInt, commaList, parseStartAt, resolveJql } from './input.js';
import { changelogField, changelogOption, warnTruncatedChangelogs } from '../changelog.js';
import { jqlInstant, parseUpdatedSince, updatedSinceField, updatedSinceOption, withUpdatedSince } from '../since.js';

/**
 * Finding issues with JQL, and finding out which fields exist to search on.
 * The query language is Jira's; toil only swaps friendly field names for ids
 * on the way in and back again on the way out, like a translator who has been
 * asked not to editorialise and, for once, doesn't.
 */

export const search = jiraArea.command({
  path: ['jira', 'issue', 'search'],
  description: 'Search Jira issues with JQL (consider --output-file for large results)',
  toolDescription:
    'Searches Jira issues with JQL and returns { issues, total, startAt, maxResults }. Without limit it pages through every match, so bound broad queries. meta.page.nextCursor is where the next page starts: pass it back as cursor (or startAt). updatedSince adds updated >= that instant to the JQL, in the time zone of your Jira profile. changelog adds Jira\'s own changelog of each issue inline, in the order Jira sends it (Cloud: newest first, at most 20 entries; jira_issue_history reads the whole history, oldest first), so one search replaces a history call per issue. A JIRA_CHANGELOG_TRUNCATED warning names issues that may be cut short. Use jira_issue_get for one issue by key.',
  input: z.object({
    jql: z.string().optional().describe('JQL query, e.g. project = PROJ AND status = "In Progress"'),
    jqlFile: z.string().optional().describe('Path to a file holding the JQL query ("-" = stdin on the CLI)'),
    limit: z.union([z.number(), z.string()]).optional().describe('Maximum number of issues to return; all matches when omitted'),
    startAt: z.union([z.number(), z.string()]).optional().describe('Index of the first result to return (a non-negative integer), for resuming or paging'),
    cursor: z.string().min(1).optional().describe('meta.page.nextCursor from the previous page, to carry on from there (the same as startAt)'),
    updatedSince: updatedSinceField,
    changelog: changelogField,
    fields: z.string().optional().describe('Comma-separated fields to return instead of the default set (names or ids, e.g. summary,status,"Story Points")'),
    moreFields: z.string().optional().describe('Comma-separated fields to return in addition to the default set, or to --fields when that is given (names or ids, e.g. fixVersions,components)'),
  }),
  writes: false,
  // POST /search, as Jira recommends for JQL too long for a URL. It only reads.
  queryByPost: true,
  options: [
    { flags: '--jql <query>', field: 'jql', description: 'JQL query string' },
    { flags: '--jql-file <path>', field: 'jqlFile', description: "Path to a file containing the JQL query ('-' = stdin)" },
    { flags: '--limit <n>', field: 'limit', description: 'Maximum number of results' },
    { flags: '--start-at <n>', field: 'startAt', description: 'Index of the first result to return (for resuming or paging)' },
    { flags: '--cursor <cursor>', field: 'cursor', description: 'meta.page.nextCursor from the previous page (the same as --start-at)' },
    updatedSinceOption,
    changelogOption,
    { flags: '--fields <list>', field: 'fields', description: 'Comma-separated fields to return instead of the default set (names or ids, e.g. summary,status,"Story Points")' },
    { flags: '--more-fields <list>', field: 'moreFields', description: 'Comma-separated fields to return in addition to the default set, or to --fields when that is given (names or ids, e.g. fixVersions,components)' },
  ],
  examples: [
    { jql: 'project = PROJ AND status = "In Progress"', limit: 2 },
    { jqlFile: 'query.jql', startAt: 1, fields: 'summary,status,Story Points' },
    // The cursor the first example hands back.
    { jql: 'project = PROJ AND status = "In Progress"', limit: 2, cursor: '2' },
    { jqlFile: 'query.jql', updatedSince: '2026-10-01T09:30:00Z', limit: 2 },
    { updatedSince: '2026-10-01' },
    { jql: 'project = PROJ', limit: 2, changelog: true },
    { jql: 'project = PROJ', limit: 2, moreFields: 'fixVersions,components' },
  ],
  run: async (input, ctx) => {
    const fieldMap = buildFieldMap(ctx.connection.customFields);
    // With --updated-since alone, the instant is the whole query.
    const jql = input.updatedSince !== undefined && input.jql === undefined && input.jqlFile === undefined ? undefined : await resolveJql(input.jql, input.jqlFile, ctx.files);
    const since = input.updatedSince === undefined ? undefined : parseUpdatedSince(input.updatedSince);
    if (input.cursor !== undefined && input.startAt !== undefined) {
      throw new ToilError('INVALID_INPUT', 'Cannot specify both --cursor and --start-at', { fix: 'Pass one of them: the cursor is the startAt of the next page.' });
    }
    let fields: string[];
    if (input.fields !== undefined) {
      fields = commaList(input.fields).map((name) => {
        const id = resolveFieldKey(name, fieldMap);
        if (id === undefined) {
          throw new ToilError('INVALID_INPUT', `Unknown field in --fields: "${name}".`, { fix: 'Use a field id, or a custom field name registered in customFields.' });
        }
        return id;
      });
      if (fields.length === 0) throw new ToilError('INVALID_INPUT', '--fields must list at least one field.', { fix: 'Pass --fields summary,status.' });
    } else {
      fields = [...client.STANDARD_SEARCH_FIELDS, ...ctx.connection.customFields.map((f) => f.id)];
    }
    // --more-fields adds to whichever set the call would have asked for, so
    // the default stays the default when a caller only wants one field extra.
    if (input.moreFields !== undefined) {
      const extra = commaList(input.moreFields).map((name) => {
        const id = resolveFieldKey(name, fieldMap);
        if (id === undefined) throw new ToilError('INVALID_INPUT', `Unknown field in --more-fields: "${name}".`, { fix: 'Use a field id, or a custom field name registered in customFields.' });
        return id;
      });
      if (extra.length === 0) throw new ToilError('INVALID_INPUT', '--more-fields must list at least one field.', { fix: 'Pass --more-fields fixVersions,components.' });
      fields = [...new Set([...fields, ...extra])];
    }
    // As the contract specifies: an empty --limit means all, and a
    // non-number reaches the request as null. --start-at is digits only.
    const maxResults = input.limit !== undefined && String(input.limit) !== '' ? asInt(input.limit) : undefined;
    const startAt = input.cursor !== undefined ? parseCursor(input.cursor) : parseStartAt(input.startAt);
    let query = jql === undefined ? undefined : translateJql(jql, fieldMap);
    if (since) {
      const zone = await client.myTimeZone(ctx);
      const instant = jqlInstant(since, zone, (asked) =>
        ctx.warn({ code: 'JIRA_TIME_ZONE', message: `Jira ${asked ? `named a time zone toil doesn't know (${asked})` : "didn't say which time zone your profile uses"}, so --updated-since was written in UTC.` }),
      );
      query = withUpdatedSince(query, instant);
    }
    const result = await client.search(ctx, query!, { maxResults, startAt, fields, changelog: input.changelog === true });
    if (input.changelog) warnTruncatedChangelogs(ctx.warn, 'JIRA_CHANGELOG_TRUNCATED', result.issues);
    const next = result.startAt + result.issues.length;
    ctx.setPage({ nextCursor: next < result.total ? String(next) : null, limit: maxResults ?? result.issues.length });
    return { ...result, issues: result.issues.map((issue) => ({ ...issue, fields: translateFieldsInOutput(issue.fields, fieldMap) })) };
  },
});

/** A cursor this command handed out: the startAt of the next page, digits only. */
function parseCursor(cursor: string): number {
  if (!/^\d+$/.test(cursor)) {
    throw new ToilError('INVALID_INPUT', `"${cursor}" isn't a cursor this command hands out.`, {
      fix: 'Pass meta.page.nextCursor from the previous page unchanged, or leave the cursor out to start at the beginning.',
    });
  }
  return Number(cursor);
}

export const fields = jiraArea.command({
  path: ['jira', 'issue', 'fields'],
  description: 'List custom fields (configured or discovered from Jira API) (consider --output-file for large results)',
  toolDescription:
    "Without discover, returns the custom fields registered on the connection. With discover, returns Jira's field list (id, name, schema, suggestedType), and with project also each field's allowedValues. Use it to find a field's id before setting it.",
  input: z.object({
    discover: z.boolean().optional().describe('Fetch field metadata from the Jira API instead of listing registered fields'),
    customOnly: z.boolean().optional().describe('Only custom fields (with discover)'),
    project: z.string().optional().describe("Project key: adds allowedValues for select fields from createmeta (with discover)"),
    issueType: z.string().optional().describe('Limit allowedValues to one issue type (with project)'),
  }),
  writes: false,
  options: [
    { flags: '--discover', field: 'discover', description: 'Fetch field metadata from Jira API' },
    { flags: '--custom-only', field: 'customOnly', description: 'Show only custom fields (requires --discover)' },
    { flags: '--project <key>', field: 'project', description: 'Project key — fetches allowedValues for select fields via createmeta (requires --discover)' },
    { flags: '--issue-type <type>', field: 'issueType', description: 'Filter allowedValues to a specific issue type (requires --project)' },
  ],
  examples: [{}, { discover: true, customOnly: true }, { discover: true, project: 'PROJ', issueType: 'Bug' }],
  run: async (input, ctx) => {
    if (!input.discover) {
      const ignored = (['customOnly', 'project', 'issueType'] as const).filter((k) => input[k] !== undefined);
      if (ignored.length > 0) ctx.warn({ code: 'JIRA_NEEDS_DISCOVER', message: `${ignored.join(', ')} only apply with --discover and were ignored.` });
      return ctx.connection.customFields;
    }
    const all = input.project ? await client.fetchFieldsWithAllowedValues(ctx, input.project, input.issueType) : await client.fetchFields(ctx);
    return input.customOnly ? all.filter((f) => f.custom) : all;
  },
});

export const searchCommands = [search, fields];
