import type { RecordedRequest, Route } from '../harness/fake-fetch.js';
import { defineFixture } from '../harness/fixtures.js';
import * as cloud from './jira-cloud-data.js';

/**
 * Canned Jira Data Center responses for every request the jira examples send,
 * so the parity suite runs every command offline through both front doors.
 *
 * Provenance: the attachment, board, sprint, search and field-schema shapes
 * are the ones the command contract's recorded examples use, which were
 * captured against real Jira Data Center servers. The rest (issue, transition,
 * comment, worklog, link type, createmeta) are invented from Atlassian's
 * documented /rest/api/2 and /rest/agile/1.0 responses, trimmed to the fields
 * that matter, and are labelled "invented from the docs" below.
 */

export const JIRA = 'https://jira.imagile.dev';
const api = (path: string) => new RegExp(`^${JIRA.replace(/\./g, '\\.')}/rest/api/2${path}$`);
const agile = (path: string) => new RegExp(`^${JIRA.replace(/\./g, '\\.')}/rest/agile/1\\.0${path}$`);

const user = (name: string, displayName: string) => ({ self: `${JIRA}/rest/api/2/user?username=${name}`, name, key: name, displayName, active: true });

// Invented from the docs: GET /rest/api/2/issue/{key}.
export const issue = (key: string, id = '10123') => ({
  expand: 'renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations',
  id,
  self: `${JIRA}/rest/api/2/issue/${id}`,
  key,
  fields: {
    summary: 'Login broken on Safari',
    status: { self: `${JIRA}/rest/api/2/status/3`, name: 'In Progress', id: '3' },
    priority: { self: `${JIRA}/rest/api/2/priority/2`, name: 'High', id: '2' },
    assignee: user('jsmith', 'J. Smith'),
    reporter: user('alice', 'Alice'),
    labels: ['frontend'],
    issuetype: { self: `${JIRA}/rest/api/2/issuetype/1`, name: 'Bug', id: '1', subtask: false },
    project: { self: `${JIRA}/rest/api/2/project/10000`, id: '10000', key: 'PROJ', name: 'Project' },
    created: '2024-01-15T09:00:00.000+0000',
    updated: '2024-01-16T11:30:00.000+0000',
    customfield_10016: 5,
  },
});

// From the command contract's recorded examples.
const attachment = {
  self: `${JIRA}/rest/api/2/attachment/10001`,
  id: '10001',
  filename: 'screenshot.png',
  author: user('jsmith', 'J. Smith'),
  created: '2024-01-01T00:00:00.000+0000',
  size: 4,
  mimeType: 'image/png',
  content: `${JIRA}/secure/attachment/10001/screenshot.png`,
};

const searchIssues = Array.from({ length: 3 }, (_, i) => issue(`PROJ-${i + 1}`, String(10001 + i)));

const json = (body: unknown, status = 200) => ({ status, json: body });
const empty = { status: 204 };

const comments = [
  { id: '10200', author: user('jsmith', 'J. Smith'), body: 'Reproduced on staging.', created: '2024-01-16T12:00:00.000+0000', updated: '2024-01-16T12:00:00.000+0000' },
  { id: '10201', author: user('alice', 'Alice'), body: 'Fixed in 1.4.2.', created: '2024-01-17T08:00:00.000+0000', updated: '2024-01-17T08:00:00.000+0000' },
];

const boards = [
  { id: 1, name: 'PROJ board', type: 'scrum' },
  { id: 2, name: 'PROJ kanban', type: 'kanban' },
];

// Invented from the docs: the changelog's histories, in the Change History schema of /rest/api/2/issue.
const histories = [
  { id: '10500', author: user('alice', 'Alice'), created: '2024-01-15T10:00:00.000+0000', items: [{ field: 'status', fieldtype: 'jira', from: '1', fromString: 'To Do', to: '3', toString: 'In Progress' }] },
  { id: '10501', author: user('jsmith', 'J. Smith'), created: '2024-01-16T11:30:00.000+0000', items: [{ field: 'labels', fieldtype: 'jira', from: null, fromString: '', to: null, toString: 'frontend' }] },
];

export const routes: Route[] = [
  // Issue reads. The attachment-only read comes first: same path, with a query.
  { url: api('/issue/PROJ-123\\?fields=attachment'), respond: json({ id: '10123', key: 'PROJ-123', fields: { attachment: [attachment] } }) },
  // Invented from the docs: Jira's 404 for a key that doesn't exist, for issue get's bulk read.
  { url: api('/issue/PROJ-404'), respond: json({ errorMessages: ['Issue Does Not Exist'], errors: {} }, 404) },
  // Invented from the docs: GET /rest/api/2/issue/{key}?expand=changelog, the issue with its histories.
  { url: api('/issue/PROJ-123\\?expand=changelog&fields=summary'), respond: json({ id: '10123', key: 'PROJ-123', fields: { summary: 'Login broken on Safari' }, changelog: { startAt: 0, maxResults: 2, total: 2, histories } }) },
  // Invented from the docs: GET /rest/api/2/myself, for --updated-since's time zone.
  { url: api('/myself'), respond: json({ ...user('jsmith', 'J. Smith'), emailAddress: 'you@example.com', timeZone: 'Europe/London' }) },
  // Invented from the docs: the issue with only its type and status, and the transitions it offers, which --to resolves against.
  {
    path: '/rest/api/2/issue/PROJ-123',
    query: { fields: 'issuetype,status', expand: 'transitions' },
    respond: json({
      expand: 'transitions',
      id: '10123',
      key: 'PROJ-123',
      fields: { issuetype: { id: '10001', name: 'Story' }, status: { name: 'In Progress', id: '3', statusCategory: { id: 4, key: 'indeterminate', name: 'In Progress' } } },
      transitions: [
        { id: '41', name: 'Submit for Review', to: { name: 'In Review', id: '10100', statusCategory: { id: 4, key: 'indeterminate', name: 'In Progress' } } },
        { id: '31', name: 'Done', to: { name: 'Done', id: '10001', statusCategory: { id: 3, key: 'done', name: 'Done' } } },
      ],
    }),
  },
  { url: api('/issue/(PROJ-\\d+)'), respond: (req: RecordedRequest) => json(issue(new URL(req.url).pathname.split('/').pop()!)) },
  // Invented from the docs: POST /rest/api/2/issue answers 201 with id, key and self.
  { method: 'POST', url: api('/issue'), respond: json({ id: '10124', key: 'PROJ-124', self: `${JIRA}/rest/api/2/issue/10124` }, 201) },
  { method: 'PUT', url: api('/issue/PROJ-123'), respond: empty },
  { method: 'PUT', url: api('/issue/PROJ-123/assignee'), respond: empty },

  // Invented from the docs: transitions.
  {
    url: api('/issue/PROJ-123/transitions'),
    respond: json({
      expand: 'transitions',
      transitions: [
        { id: '11', name: 'To Do', to: { name: 'To Do', id: '10000' } },
        { id: '21', name: 'In Progress', to: { name: 'In Progress', id: '3' } },
        { id: '31', name: 'Done', to: { name: 'Done', id: '10001' } },
      ],
    }),
  },
  { method: 'POST', url: api('/issue/PROJ-123/transitions'), respond: empty },

  // Invented from the docs: comments and worklogs.
  {
    method: 'POST',
    url: api('/issue/PROJ-123/comment'),
    respond: (req: RecordedRequest) =>
      json({ self: `${JIRA}/rest/api/2/issue/10123/comment/10200`, id: '10200', author: user('jsmith', 'J. Smith'), body: JSON.parse(req.body!).body, created: '2024-01-16T12:00:00.000+0000', updated: '2024-01-16T12:00:00.000+0000' }, 201),
  },
  {
    // Answers the page startAt asks for, so --cursor resumes.
    url: api('/issue/PROJ-123/comment\\?startAt=(0|1)&maxResults=100'),
    respond: (req: RecordedRequest) => {
      const startAt = Number(new URL(req.url).searchParams.get('startAt'));
      return json({ startAt, maxResults: 100, total: comments.length, comments: comments.slice(startAt) });
    },
  },
  {
    method: 'POST',
    url: api('/issue/PROJ-123/worklog'),
    respond: (req: RecordedRequest) => {
      const body = JSON.parse(req.body!) as { timeSpent: string; comment?: string; started?: string };
      return json(
        {
          self: `${JIRA}/rest/api/2/issue/10123/worklog/10300`,
          id: '10300',
          issueId: '10123',
          author: user('jsmith', 'J. Smith'),
          comment: body.comment ?? '',
          started: body.started ?? '2024-01-16T12:00:00.000+0000',
          timeSpent: body.timeSpent,
          timeSpentSeconds: body.timeSpent === '1d' ? 28800 : 9000,
          created: '2024-01-16T12:00:00.000+0000',
          updated: '2024-01-16T12:00:00.000+0000',
        },
        201,
      );
    },
  },

  // Search: the recorded examples' shape. Answers the page the body asks for.
  {
    method: 'POST',
    url: api('/search'),
    respond: (req: RecordedRequest) => {
      const body = JSON.parse(req.body!) as { startAt: number; maxResults: number; expand?: string[] };
      // Invented from the docs: with expand=changelog each issue carries the changelog object.
      const page = searchIssues.slice(body.startAt, body.startAt + body.maxResults).map((i) => (body.expand?.includes('changelog') ? { ...i, changelog: { startAt: 0, maxResults: 100, total: 1, histories: [{ id: '10100', author: { name: 'jsmith', displayName: 'J. Smith' }, created: '2026-10-01T09:30:00.000+0000', items: [{ field: 'status', fieldtype: 'jira', from: '1', fromString: 'To Do', to: '3', toString: 'In Progress' }] }] } } : i));
      return json({ expand: 'schema,names', startAt: body.startAt, maxResults: body.maxResults, total: searchIssues.length, issues: page });
    },
  },

  // Invented from the docs: link types.
  {
    url: api('/issueLinkType'),
    respond: json({
      issueLinkTypes: [
        { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks', self: `${JIRA}/rest/api/2/issueLinkType/10000` },
        { id: '10001', name: 'Relates', inward: 'relates to', outward: 'relates to', self: `${JIRA}/rest/api/2/issueLinkType/10001` },
      ],
    }),
  },
  { method: 'POST', url: api('/issueLink'), respond: { status: 201 } },

  // Attachments: the recorded examples' shape.
  { method: 'POST', url: api('/issue/PROJ-123/attachments'), respond: json([attachment]) },
  { url: new RegExp(`^${JIRA.replace(/\./g, '\\.')}/secure/attachment/10001/screenshot\\.png$`), respond: { text: 'PNG!', headers: { 'content-type': 'image/png' } } },

  // check-toil-project's project lookup. Invented from the docs: GET /rest/api/2/project/{key}.
  { url: api('/project/PROJ'), respond: json({ id: '10000', key: 'PROJ', name: 'Project', issueTypes: [{ id: '10001', name: 'Bug' }] }) },

  // Fields: the recorded examples' schema shapes.
  {
    url: api('/field'),
    respond: json([
      { id: 'summary', name: 'Summary', custom: false, orderable: true, navigable: true, searchable: true, clauseNames: ['summary'], schema: { type: 'string', system: 'summary' } },
      { id: 'customfield_10016', name: 'Story Points', custom: true, orderable: true, navigable: true, searchable: true, clauseNames: ['cf[10016]', 'Story Points'], schema: { type: 'number', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float', customId: 10016 } },
      { id: 'customfield_10100', name: 'Epic Link', custom: true, orderable: true, navigable: true, searchable: true, clauseNames: ['cf[10100]', 'Epic Link'], schema: { type: 'any', custom: 'com.pyxis.greenhopper.jira:gh-epic-link', customId: 10100 } },
      { id: 'customfield_10200', name: 'Crew', custom: true, orderable: true, navigable: true, searchable: true, clauseNames: ['cf[10200]', 'Crew'], schema: { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select', customId: 10200 } },
    ]),
  },
  // Invented from the docs: the classic createmeta, expanded.
  {
    url: api('/issue/createmeta\\?projectKeys=PROJ&expand=projects\\.issuetypes\\.fields'),
    respond: json({
      projects: [
        {
          key: 'PROJ',
          issuetypes: [
            { name: 'Bug', fields: { customfield_10200: { allowedValues: [{ id: '10400', value: 'Platform' }, { id: '10401', value: 'Payments' }] } } },
            { name: 'Story', fields: { customfield_10200: { allowedValues: [{ id: '10402', value: 'Growth' }] } } },
          ],
        },
      ],
    }),
  },

  // Agile: the recorded examples' shapes, with the isLast the real API sends.
  {
    url: agile('/board\\?projectKeyOrId=PROJ&startAt=(0|1)&maxResults=100'),
    respond: (req: RecordedRequest) => {
      const startAt = Number(new URL(req.url).searchParams.get('startAt'));
      return json({ maxResults: 100, startAt, total: boards.length, isLast: true, values: boards.slice(startAt) });
    },
  },
  {
    // No total, as the real sprint list has none: paging asks for one more,
    // empty page (startAt=2), as the contract specifies.
    url: agile('/board/(1|3)/sprint\\?startAt=(0|1|2)&maxResults=100(&state=active,future)?'),
    respond: (req: RecordedRequest) => {
      const startAt = Number(new URL(req.url).searchParams.get('startAt'));
      return json({ maxResults: 100, startAt, isLast: true, values: sprints.slice(startAt) });
    },
  },
  { method: 'POST', url: agile('/sprint/42/issue'), respond: empty },
];

const sprints = [
  { id: 41, self: `${JIRA}/rest/agile/1.0/sprint/41`, state: 'closed', name: 'Sprint 41', startDate: '2026-01-01T00:00:00.000Z', endDate: '2026-01-14T00:00:00.000Z', originBoardId: 1 },
  { id: 42, self: `${JIRA}/rest/agile/1.0/sprint/42`, state: 'active', name: 'Sprint 42', startDate: '2026-01-15T00:00:00.000Z', endDate: '2026-01-28T00:00:00.000Z', originBoardId: 1, goal: 'Ship login fix' },
];

/** Local files the examples read: input files, a JQL file, an upload. */
export const files: Record<string, string> = {
  'issue.json': JSON.stringify({ project: 'PROJ', issueType: 'Story', fields: { summary: 'From a file', description: '@desc.html', labels: ['a', 'b'], priority: 'High' } }),
  'update.json': JSON.stringify({ fields: { description: '@desc.html', customfield_10050: 'Acceptance criteria' } }),
  'fields.json': JSON.stringify({ fixVersions: [{ name: '1.4.2' }], 'Story Points': 3 }),
  'desc.html': '<p>Long description</p>',
  'ac.md': '- [ ] works on Safari\n',
  'query.jql': 'project = PROJ ORDER BY created DESC\n',
  'screenshot.png': 'PNG!',
  'comment.json': JSON.stringify({ body: 'Posted through jira api' }),
};

export const config = {
  jira: {
    baseUrl: JIRA,
    apiToken: 'test-token',
    customFields: [{ id: 'customfield_10016', name: 'Story Points', type: 'number' }],
    writes: true,
  },
};

/**
 * The toil project the examples run with, for check-toil-project. Only reference data and
 * a field alias: a `project` here would change every other example's project.
 */
export const toilProject = { name: 'payments', jira: { projects: ['PROJ'], fields: { storyPoints: 'customfield_10016' } } };

/**
 * Both deployments, side by side: Data Center's connection (`jira`, the area's
 * default) and Cloud's (`jira-cloud`, deployment cloud), each with the routes
 * and files its examples read. Cloud's routes are pinned to its own origin, so
 * the two sets of agile paths can't answer for each other.
 */
export const fixture = defineFixture({
  area: 'jira',
  routes: [...routes, ...cloud.routes.map((r) => (r.path !== undefined && r.origin === undefined ? { ...r, origin: cloud.SITE } : r))],
  config: { ...config, ...cloud.config },
  deployments: { server: 'jira', cloud: 'jira-cloud' },
  files: { ...files, ...cloud.files },
  toilProject,
});
