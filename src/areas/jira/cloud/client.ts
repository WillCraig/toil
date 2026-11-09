import type { z } from 'zod';
import type { Connection } from '../../../core/area.js';
import type { CommandContext } from '../../../core/context.js';
import { apiRequest } from '../../../core/api.js';
import { ToilError } from '../../../core/errors.js';
import type { JiraIssueWithTransitions } from '../../../core/transition-intent.js';
import { paginate, type Paged, type PageStyle } from '../../../core/paginate.js';
import type { QueryParam } from '../../../core/rest.js';
import { textToAdf, type AdfDocument } from './adf.js';
import { jiraArea, type CustomFieldDefinition } from '../area.js';
import { suggestedType } from './custom-fields.js';
import type { BulkError } from '../bulk.js';
import type { PageOpts } from '../paging.js';

/**
 * Every request toil sends to Jira Cloud, each from Atlassian's REST API 3
 * reference (https://developer.atlassian.com/cloud/jira/platform/rest/v3/) or
 * the Agile REST API reference
 * (https://developer.atlassian.com/cloud/jira/software/rest/). Commands say
 * what they want; this module knows the endpoints, the paging and where the
 * Cloud API parts company with Data Center: accountIds for people, ADF for
 * rich text, and a token-paged JQL search with no total. The departure was
 * announced in a changelog, which is the closest thing to consent on record.
 */

export type JiraCloudConnection = Connection<z.output<typeof jiraArea.connection>>;
export type JiraCloudContext = CommandContext<JiraCloudConnection>;

const API = '/rest/api/3';
const AGILE_API = '/rest/agile/1.0';
/** Page size for startAt/maxResults lists. The Agile and project APIs cap at 50 or 100; toil follows whatever page the server returns. */
const PAGE = 50;
/** Issues per JQL search request; Jira may return fewer when many fields are asked for. */
const SEARCH_PAGE = 100;

export interface JiraCloudIssue {
  id: string;
  key: string;
  fields: Record<string, unknown>;
  [key: string]: unknown;
}

export interface JiraCloudTransition {
  id: string;
  name: string;
  to?: { name: string };
}

export interface JiraCloudBoard {
  id: number;
  name: string;
  type: string;
}

export interface JiraCloudSprint {
  id: number;
  name: string;
  state: string;
  startDate?: string;
  endDate?: string;
  goal?: string;
  originBoardId?: number;
  [key: string]: unknown;
}

/** A key or id as one path segment, encoded, so `PROJ-1/comment` can't change which endpoint is called. */
const seg = (value: string | number) => encodeURIComponent(String(value));

interface Request {
  method?: 'GET' | 'POST' | 'PUT';
  query?: Record<string, QueryParam>;
  body?: unknown;
}

export function jiraCloud<T>(ctx: JiraCloudContext, path: string, req: Request = {}): Promise<T> {
  return apiRequest<T>(jiraArea, ctx, path, {
    method: req.method ?? 'GET',
    ...(req.query ? { query: req.query } : {}),
    ...(req.body !== undefined ? { json: req.body } : {}),
  });
}

/**
 * startAt/maxResults paging, for a list kept under `field`. It stops on an
 * empty page, when `isLast` is true (the Agile and project lists), or once
 * `total` is reached (comments), and never on a short page, since Jira may
 * return fewer than asked for.
 */
function offsetPages<T>(field: string): PageStyle<T> {
  return {
    kind: 'offset',
    startParam: 'startAt',
    limitParam: 'maxResults',
    pageSize: PAGE,
    items: (body) => ((body as Record<string, T[] | undefined>)[field] ?? []),
    total: (body) => {
      const page = body as { isLast?: unknown; startAt?: unknown; total?: unknown } & Record<string, unknown>;
      const got = Array.isArray(page[field]) ? (page[field] as unknown[]).length : 0;
      if (page.isLast === true && typeof page.startAt === 'number') return page.startAt + got;
      return typeof page.total === 'number' ? page.total : undefined;
    },
  };
}

/** The items of a paged list. With a limit it stops there and meta.page.nextCursor is the startAt to carry on from; a cursor starts there. */
async function every<T>(ctx: JiraCloudContext, what: string, field: string, fetchPage: (paging: Record<string, string | number>) => Promise<unknown>, page: PageOpts = {}): Promise<T[]> {
  const { items } = await paginate<T>(offsetPages<T>(field), async (paging) => ({ body: await fetchPage(paging) }), {
    what,
    ...(page.limit !== undefined ? { cap: page.limit, setPage: ctx.setPage } : {}),
    ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
  });
  return items;
}

// GET /rest/api/3/issue/{issueIdOrKey}
export function getIssue(ctx: JiraCloudContext, key: string): Promise<JiraCloudIssue> {
  return jiraCloud<JiraCloudIssue>(ctx, `${API}/issue/${seg(key)}`);
}

/**
 * POST /rest/api/3/issue/bulkfetch
 * (https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-bulkfetch-post):
 * up to 100 issues in one request, every field as GET issue returns them
 * (`*all`). Jira answers in id order, leaves out a key it can't find or won't
 * show, returns a moved issue under its new key, and lists one it couldn't
 * fetch under issueErrors by id alone. So each answer is matched back to a
 * key asked for, by key (case-insensitively) or by id.
 *
 * A key nothing matched is reported once, and only as honestly as the answer
 * allows. When every returned issue and every issueError is accounted for, the
 * key is NOT_FOUND. When some aren't, the answer doesn't say which belongs to
 * which key (the response carries no key history to match a moved issue by,
 * short of expanding every issue's changelog), so the key is UNMATCHED, with a
 * message naming the issues and errors it may be. Unaccounted issues are still
 * returned, after the rest, and unaccounted errors aren't counted again, so
 * there is never more than one error per key asked for.
 */
export async function getIssues(ctx: JiraCloudContext, keys: string[]): Promise<{ issues: JiraCloudIssue[]; errors: BulkError[] }> {
  const body = await jiraCloud<{ issues?: JiraCloudIssue[]; issueErrors?: Array<{ id?: string; errorMessage?: string }> }>(ctx, `${API}/issue/bulkfetch`, {
    method: 'POST',
    body: { issueIdsOrKeys: keys, fields: ['*all'] },
  });
  const returned = body.issues ?? [];
  const failed = (body.issueErrors ?? []).map((e) => ({ id: String(e.id ?? ''), message: e.errorMessage ?? 'Jira Cloud could not fetch this issue.' }));
  const usedIssues = new Set<JiraCloudIssue>();
  const usedErrors = new Set<(typeof failed)[number]>();
  const matched = new Map<string, JiraCloudIssue | BulkError>();
  for (const key of keys) {
    const issue = returned.find((i) => !usedIssues.has(i) && (i.key.toLowerCase() === key.toLowerCase() || i.id === key));
    if (issue) {
      usedIssues.add(issue);
      matched.set(key, issue);
      continue;
    }
    // Asked for by id, so Jira's id-keyed error is this key's.
    const error = failed.find((e) => !usedErrors.has(e) && e.id === key);
    if (error) {
      usedErrors.add(error);
      matched.set(key, { key, code: 'HTTP', message: error.message });
    }
  }
  const strayIssues = returned.filter((i) => !usedIssues.has(i));
  const strayErrors = failed.filter((e) => !usedErrors.has(e));
  const unaccounted = [
    ...(strayIssues.length ? [`returned under another key: ${strayIssues.map((i) => i.key).join(', ')} (a moved issue comes back under its new key)`] : []),
    ...(strayErrors.length ? [`couldn't fetch, by id: ${strayErrors.map((e) => `${e.id} (${e.message})`).join(', ')}`] : []),
  ];
  const issues: JiraCloudIssue[] = [];
  const errors: BulkError[] = [];
  for (const key of keys) {
    const found = matched.get(key);
    if (found && 'fields' in found) issues.push(found);
    else if (found) errors.push(found as BulkError);
    else if (unaccounted.length === 0) errors.push({ key, code: 'NOT_FOUND', message: `Jira Cloud returned no issue for ${key}: it doesn't exist, or this account can't see it.` });
    else errors.push({ key, code: 'UNMATCHED', message: `Jira Cloud returned no issue under ${key}, and its answer doesn't say which of these it is, if any: ${unaccounted.join('; ')}.` });
  }
  issues.push(...strayIssues);
  return { issues, errors };
}

/**
 * GET /rest/api/3/issue/{issueIdOrKey}/changelog: the change history, oldest
 * first, paged by startAt/maxResults with isLast
 * (https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-changelog-get).
 */
export function getChangelog(ctx: JiraCloudContext, key: string, page: PageOpts = {}): Promise<Array<Record<string, unknown>>> {
  return every(ctx, `Jira Cloud changelog for ${key}`, 'values', (paging) => jiraCloud(ctx, `${API}/issue/${seg(key)}/changelog`, { query: paging }), page);
}

/** The time zone of the account, from GET /rest/api/3/myself, which JQL's absolute dates are read in. */
export async function myTimeZone(ctx: JiraCloudContext): Promise<string | undefined> {
  const me = await jiraCloud<{ timeZone?: unknown }>(ctx, `${API}/myself`);
  return typeof me.timeZone === 'string' && me.timeZone !== '' ? me.timeZone : undefined;
}

export interface IssueFieldsInput {
  summary?: string | undefined;
  /** Plain text (sent as ADF), or an ADF document from an input file (sent as it is). */
  description?: string | AdfDocument | undefined;
  priority?: string | undefined;
  assignee?: string | undefined;
  labels?: string[] | undefined;
  customFieldValues?: Record<string, unknown> | undefined;
}

/** The `fields` for a create or edit: only what was given, rich text as ADF, people by accountId. */
export function issueFields(opts: IssueFieldsInput): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (opts.summary) fields.summary = opts.summary;
  if (opts.description) fields.description = typeof opts.description === 'string' ? textToAdf(opts.description) : opts.description;
  if (opts.priority) fields.priority = { name: opts.priority };
  if (opts.assignee) fields.assignee = { accountId: opts.assignee };
  if (opts.labels?.length) fields.labels = opts.labels;
  Object.assign(fields, opts.customFieldValues ?? {});
  return fields;
}

export interface CreateIssueOpts extends IssueFieldsInput {
  project: string;
  issueType: string;
  summary: string;
  parent?: string | undefined;
}

/** POST /rest/api/3/issue, then reads the issue back so the caller gets all of it, not just its key. */
export async function createIssue(ctx: JiraCloudContext, opts: CreateIssueOpts): Promise<JiraCloudIssue> {
  const fields = {
    project: { key: opts.project },
    issuetype: { name: opts.issueType },
    ...issueFields(opts),
    ...(opts.parent ? { parent: { key: opts.parent } } : {}),
  };
  const created = await jiraCloud<{ id: string; key: string }>(ctx, `${API}/issue`, { method: 'POST', body: { fields } });
  return getIssue(ctx, created.key);
}

// PUT /rest/api/3/issue/{issueIdOrKey}
export async function editIssue(ctx: JiraCloudContext, key: string, body: Record<string, unknown>): Promise<void> {
  await jiraCloud<void>(ctx, `${API}/issue/${seg(key)}`, { method: 'PUT', body });
}

// GET /rest/api/3/issue/{issueIdOrKey}/transitions
export async function listTransitions(ctx: JiraCloudContext, key: string): Promise<JiraCloudTransition[]> {
  const result = await jiraCloud<{ transitions?: JiraCloudTransition[] }>(ctx, `${API}/issue/${seg(key)}/transitions`);
  return result.transitions ?? [];
}

// GET /rest/api/3/issue/{issueIdOrKey}?fields=issuetype,status&expand=transitions
/** The issue's type and status with the transitions it offers, in one read: what `--to` resolves against. */
export function issueWithTransitions(ctx: JiraCloudContext, key: string): Promise<JiraIssueWithTransitions> {
  return jiraCloud<JiraIssueWithTransitions>(ctx, `${API}/issue/${seg(key)}`, { query: { fields: 'issuetype,status', expand: 'transitions' } });
}

// POST /rest/api/3/issue/{issueIdOrKey}/transitions
export async function transitionIssue(ctx: JiraCloudContext, key: string, transitionId: string): Promise<void> {
  await jiraCloud<void>(ctx, `${API}/issue/${seg(key)}/transitions`, { method: 'POST', body: { transition: { id: transitionId } } });
}

// POST /rest/api/3/issue/{issueIdOrKey}/comment, with the body as ADF.
export function addComment(ctx: JiraCloudContext, key: string, body: AdfDocument): Promise<Record<string, unknown>> {
  return jiraCloud(ctx, `${API}/issue/${seg(key)}/comment`, { method: 'POST', body: { body } });
}

// GET /rest/api/3/issue/{issueIdOrKey}/comment, every page.
export function listComments(ctx: JiraCloudContext, key: string, page: PageOpts = {}): Promise<Array<Record<string, unknown>>> {
  return every(ctx, `Jira Cloud comments for ${key}`, 'comments', (paging) => jiraCloud(ctx, `${API}/issue/${seg(key)}/comment`, { query: paging }), page);
}

// PUT /rest/api/3/issue/{issueIdOrKey}/assignee
export async function assignIssue(ctx: JiraCloudContext, key: string, accountId: string): Promise<void> {
  await jiraCloud<void>(ctx, `${API}/issue/${seg(key)}/assignee`, { method: 'PUT', body: { accountId } });
}

/** POST /rest/api/3/issueLink: `key` inward, `target` outward. A type name or either phrase resolves to its id from GET /rest/api/3/issueLinkType. */
export async function linkIssue(ctx: JiraCloudContext, opts: { key: string; linkType: string; target: string }): Promise<void> {
  let linkTypeId = opts.linkType;
  if (!/^\d+$/.test(opts.linkType)) {
    const types = await jiraCloud<{ issueLinkTypes?: Array<{ id: string; name: string; inward: string; outward: string }> }>(ctx, `${API}/issueLinkType`);
    const all = types.issueLinkTypes ?? [];
    const wanted = opts.linkType.toLowerCase();
    const found = all.find((t) => t.name.toLowerCase() === wanted || t.inward.toLowerCase() === wanted || t.outward.toLowerCase() === wanted);
    if (!found) {
      throw new ToilError('INVALID_INPUT', `Link type not found: ${opts.linkType}`, {
        fix: `Use one of: ${all.map((t) => t.name).join(', ') || '(Jira Cloud reported none)'}, or a link type id.`,
      });
    }
    linkTypeId = found.id;
  }
  await jiraCloud<void>(ctx, `${API}/issueLink`, {
    method: 'POST',
    body: { type: { id: linkTypeId }, inwardIssue: { key: opts.key }, outwardIssue: { key: opts.target } },
  });
}

export const STANDARD_SEARCH_FIELDS = ['summary', 'status', 'priority', 'assignee', 'issuetype', 'project', 'created', 'updated', 'labels', 'reporter'];

/**
 * POST /rest/api/3/search/jql, the enhanced search that replaced
 * /rest/api/3/search (https://developer.atlassian.com/changelog/#CHANGE-2046).
 * It pages by `nextPageToken` and reports no total, so `cap` and `cursor` go
 * through core's token paging and meta.page carries where to resume.
 */
export function search(
  ctx: JiraCloudContext,
  jql: string,
  opts: { fields: string[]; cap?: number | undefined; cursor?: string | undefined; changelog?: boolean | undefined },
): Promise<Paged<JiraCloudIssue>> {
  const maxResults = Math.min(SEARCH_PAGE, opts.cap ?? SEARCH_PAGE);
  return paginate<JiraCloudIssue>(
    { kind: 'nextPageKey', param: 'nextPageToken', key: (body) => (body as { nextPageToken?: string }).nextPageToken, items: (body) => (body as { issues?: JiraCloudIssue[] }).issues ?? [] },
    async (paging) => ({ body: await jiraCloud(ctx, `${API}/search/jql`, { method: 'POST', body: { jql, maxResults, fields: opts.fields, ...(opts.changelog ? { expand: 'changelog' } : {}), ...paging } }) }),
    { what: 'Jira Cloud search', ...(opts.cap !== undefined ? { cap: opts.cap, setPage: ctx.setPage } : {}), ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}) },
  );
}

// PUT /rest/api/3/issue/{issueIdOrKey} with label operations.
export async function changeLabels(ctx: JiraCloudContext, key: string, op: 'add' | 'remove', labels: string[]): Promise<void> {
  await editIssue(ctx, key, { update: { labels: labels.map((l) => ({ [op]: l })) } });
}

// GET /rest/api/3/project/search, every page.
export function listProjects(ctx: JiraCloudContext, query?: string, page: PageOpts = {}): Promise<Array<Record<string, unknown>>> {
  return every(ctx, 'Jira Cloud projects', 'values', (paging) => jiraCloud(ctx, `${API}/project/search`, { query: { ...(query ? { query } : {}), ...paging } }), page);
}

// GET /rest/api/3/project/{projectIdOrKey}
export function getProject(ctx: JiraCloudContext, project: string): Promise<Record<string, unknown>> {
  return jiraCloud(ctx, `${API}/project/${seg(project)}`);
}

/**
 * GET /rest/api/3/user/search: one page, since the endpoint stops at the
 * thousandth match anyway. It answers a bare list with no total, so a full
 * page says there may be more: meta.page.nextCursor is the startAt after it,
 * and a short page ends the list.
 */
export async function searchUsers(ctx: JiraCloudContext, query: string, maxResults: number, cursor?: string): Promise<Array<Record<string, unknown>>> {
  if (cursor !== undefined && !/^\d+$/.test(cursor)) {
    throw new ToilError('INVALID_INPUT', `"${cursor}" isn't a cursor this command hands out.`, {
      fix: 'Pass meta.page.nextCursor from the previous page unchanged, or leave the cursor out to start at the beginning.',
    });
  }
  const startAt = cursor === undefined ? 0 : Number(cursor);
  const users = await jiraCloud<Array<Record<string, unknown>>>(ctx, `${API}/user/search`, { query: { query, maxResults, ...(cursor === undefined ? {} : { startAt }) } });
  ctx.setPage({ nextCursor: Array.isArray(users) && users.length >= maxResults ? String(startAt + users.length) : null, limit: maxResults });
  return users;
}

// GET /rest/agile/1.0/board?projectKeyOrId=, every page.
export function listBoards(ctx: JiraCloudContext, project: string, page: PageOpts = {}): Promise<JiraCloudBoard[]> {
  return every(ctx, `Jira Cloud boards for project ${project}`, 'values', (paging) => jiraCloud(ctx, `${AGILE_API}/board`, { query: { projectKeyOrId: project, ...paging } }), page);
}

// GET /rest/agile/1.0/board/{boardId}/sprint, every page.
export function listSprintsForBoard(ctx: JiraCloudContext, boardId: number, states?: string[], page: PageOpts = {}): Promise<JiraCloudSprint[]> {
  return every(
    ctx,
    `Jira Cloud sprints for board ${boardId}`,
    'values',
    (paging) => jiraCloud(ctx, `${AGILE_API}/board/${seg(boardId)}/sprint`, { query: { ...paging, ...(states?.length ? { state: states.join(',') } : {}) } }),
    page,
  );
}

/**
 * Sprints across a project's boards, once each: a sprint can sit on several
 * boards. Kanban boards have none and are skipped. A team-managed project's
 * board is `simple`, which has sprints only when the project turned them on;
 * Jira answers 400 for one that hasn't, so that board is skipped with a
 * warning naming it rather than failing the whole list or vanishing silently.
 */
export async function listSprintsForProject(ctx: JiraCloudContext, project: string, states?: string[]): Promise<JiraCloudSprint[]> {
  const sprints: JiraCloudSprint[] = [];
  const seen = new Set<number>();
  const skipped: string[] = [];
  for (const board of await listBoards(ctx, project)) {
    if (board.type === 'kanban') continue;
    let list: JiraCloudSprint[];
    try {
      list = await listSprintsForBoard(ctx, board.id, states);
    } catch (err) {
      const status = err instanceof ToilError ? (err.details as { status?: unknown } | undefined)?.status : undefined;
      if (board.type !== 'simple' || status !== 400) throw err;
      skipped.push(`${board.name} (${board.id})`);
      continue;
    }
    for (const sprint of list) {
      if (seen.has(sprint.id)) continue;
      seen.add(sprint.id);
      sprints.push(sprint);
    }
  }
  if (skipped.length > 0) {
    ctx.warn({ code: 'JIRA_CLOUD_NO_SPRINTS', message: `Jira Cloud said these team-managed boards don't support sprints, so they were skipped: ${skipped.join(', ')}.` });
  }
  return sprints;
}

// POST /rest/agile/1.0/sprint/{sprintId}/issue
export async function setSprint(ctx: JiraCloudContext, sprintId: number, issueKeys: string[]): Promise<void> {
  await jiraCloud<void>(ctx, `${AGILE_API}/sprint/${seg(sprintId)}/issue`, { method: 'POST', body: { issues: issueKeys } });
}

export interface SprintFields {
  name?: string;
  goal?: string;
  startDate?: string;
  endDate?: string;
}

// GET /rest/agile/1.0/sprint/{sprintId}
export function getSprint(ctx: JiraCloudContext, sprintId: number): Promise<JiraCloudSprint> {
  return jiraCloud<JiraCloudSprint>(ctx, `${AGILE_API}/sprint/${seg(sprintId)}`);
}

// POST /rest/agile/1.0/sprint: a new sprint is always future until it is started.
export function createSprint(ctx: JiraCloudContext, boardId: number, fields: SprintFields & { name: string }): Promise<JiraCloudSprint> {
  return jiraCloud<JiraCloudSprint>(ctx, `${AGILE_API}/sprint`, { method: 'POST', body: { originBoardId: boardId, ...fields } });
}

// POST /rest/agile/1.0/sprint/{sprintId}: the partial update, so only what is sent changes (PUT would blank the rest).
export function updateSprint(ctx: JiraCloudContext, sprintId: number, fields: SprintFields & { state?: 'active' | 'closed' }): Promise<JiraCloudSprint> {
  return jiraCloud<JiraCloudSprint>(ctx, `${AGILE_API}/sprint/${seg(sprintId)}`, { method: 'POST', body: fields });
}

// GET /rest/agile/1.0/sprint/{sprintId}/issue?jql=, every page: the keys of the issues still open.
export async function listOpenSprintIssueKeys(ctx: JiraCloudContext, sprintId: number): Promise<string[]> {
  const issues = await every<{ key: string }>(ctx, `Jira Cloud issues in sprint ${sprintId}`, 'issues', (paging) =>
    jiraCloud(ctx, `${AGILE_API}/sprint/${seg(sprintId)}/issue`, { query: { ...paging, jql: 'statusCategory != Done', fields: 'summary' } }),
  );
  return issues.map((issue) => issue.key);
}

// POST /rest/agile/1.0/backlog/issue, which takes at most 50 issues a call.
export async function moveToBacklog(ctx: JiraCloudContext, issueKeys: string[]): Promise<void> {
  for (let i = 0; i < issueKeys.length; i += 50) {
    await jiraCloud<void>(ctx, `${AGILE_API}/backlog/issue`, { method: 'POST', body: { issues: issueKeys.slice(i, i + 50) } });
  }
}

/** setSprint in batches of 50, the most Jira takes in one call. */
export async function setSprintBatched(ctx: JiraCloudContext, sprintId: number, issueKeys: string[]): Promise<void> {
  for (let i = 0; i < issueKeys.length; i += 50) await setSprint(ctx, sprintId, issueKeys.slice(i, i + 50));
}

// POST /rest/api/3/issue/{issueIdOrKey}/worklog, with the comment as ADF.
export function addWorklog(ctx: JiraCloudContext, key: string, opts: { timeSpent: string; started: string; comment?: string | undefined }): Promise<Record<string, unknown>> {
  return jiraCloud(ctx, `${API}/issue/${seg(key)}/worklog`, {
    method: 'POST',
    body: { timeSpent: opts.timeSpent, started: opts.started, ...(opts.comment ? { comment: textToAdf(opts.comment) } : {}) },
  });
}

export interface JiraCloudAttachment {
  id: string;
  filename: string;
  size?: number;
  mimeType?: string;
  content?: string;
  [key: string]: unknown;
}

// POST /rest/api/3/issue/{issueIdOrKey}/attachments: one multipart part named file, with the no-check header Jira requires.
export function uploadAttachment(ctx: JiraCloudContext, key: string, fileName: string, data: Uint8Array): Promise<JiraCloudAttachment[]> {
  return apiRequest<JiraCloudAttachment[]>(jiraArea, ctx, `${API}/issue/${seg(key)}/attachments`, {
    method: 'POST',
    headers: { 'X-Atlassian-Token': 'no-check' },
    multipart: [{ name: 'file', fileName, data }],
  });
}

// GET /rest/api/3/issue/{issueIdOrKey}?fields=attachment
export async function listAttachments(ctx: JiraCloudContext, key: string): Promise<JiraCloudAttachment[]> {
  const result = await jiraCloud<{ fields?: { attachment?: JiraCloudAttachment[] } }>(ctx, `${API}/issue/${seg(key)}`, { query: { fields: 'attachment' } });
  return result.fields?.attachment ?? [];
}

/**
 * GET /rest/api/3/attachment/content/{id}?redirect=false: Jira answers with
 * the bytes itself rather than redirecting to its media service, so the
 * request never leaves the connection's host and the credential goes nowhere else.
 */
export function downloadAttachment(ctx: JiraCloudContext, id: string): Promise<Uint8Array> {
  return apiRequest<Uint8Array>(jiraArea, ctx, `${API}/attachment/content/${seg(id)}`, { query: { redirect: false }, headers: { Accept: '*/*' }, as: 'bytes' });
}

export interface JiraCloudFieldInfo {
  id: string;
  name: string;
  custom: boolean;
  schema?: { type: string; custom?: string };
  allowedValues?: unknown[];
  /** The `customFields` type that suits this field. */
  suggestedType?: CustomFieldDefinition['type'];
  [key: string]: unknown;
}

// GET /rest/api/3/field, each with a suggested customFields type.
export async function fetchFields(ctx: JiraCloudContext): Promise<JiraCloudFieldInfo[]> {
  const fields = await jiraCloud<JiraCloudFieldInfo[]>(ctx, `${API}/field`);
  return fields.map((f) => {
    const type = suggestedType(f.schema);
    return type ? { ...f, suggestedType: type } : f;
  });
}

/**
 * Fields with `allowedValues` for a project (and optionally one issue type),
 * from the paged createmeta endpoints: GET
 * /rest/api/3/issue/createmeta/{project}/issuetypes, then
 * /issuetypes/{issueTypeId} per type. The classic createmeta is deprecated on
 * Cloud (CHANGE-1304), so there is no fallback; a failure is the command's error.
 */
export async function fetchFieldsWithAllowedValues(ctx: JiraCloudContext, project: string, issueType?: string): Promise<JiraCloudFieldInfo[]> {
  const fields = await fetchFields(ctx);
  const types = await every<{ id: string; name: string }>(ctx, `Jira Cloud issue types for project ${project}`, 'issueTypes', (paging) =>
    jiraCloud(ctx, `${API}/issue/createmeta/${seg(project)}/issuetypes`, { query: paging }),
  );
  const matching = issueType ? types.filter((t) => t.name.toLowerCase() === issueType.toLowerCase()) : types;
  if (issueType && matching.length === 0) {
    throw new ToilError('INVALID_INPUT', `Issue type not found in project ${project}: ${issueType}`, {
      fix: `Use one of: ${types.map((t) => t.name).join(', ') || '(none you can create)'}.`,
    });
  }
  const allowed = new Map<string, Array<{ id?: string }>>();
  for (const type of matching) {
    const meta = await every<{ fieldId: string; allowedValues?: Array<{ id?: string }> }>(ctx, `Jira Cloud fields for ${project} ${type.name}`, 'fields', (paging) =>
      jiraCloud(ctx, `${API}/issue/createmeta/${seg(project)}/issuetypes/${seg(type.id)}`, { query: paging }),
    );
    for (const field of meta) {
      if (!field.allowedValues?.length) continue;
      const list = allowed.get(field.fieldId) ?? [];
      const seen = new Set(list.map((v) => v.id));
      for (const value of field.allowedValues) if (!seen.has(value.id)) list.push(value);
      allowed.set(field.fieldId, list);
    }
  }
  return fields.map((f) => (allowed.has(f.id) ? { ...f, allowedValues: allowed.get(f.id) } : f));
}
