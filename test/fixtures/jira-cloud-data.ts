import type { RecordedRequest, Route } from '../harness/fake-fetch.js';

/**
 * Canned Jira Cloud responses for every request the Cloud examples of `jira`
 * send, so the parity suite runs them offline through both front doors. Not a
 * fixture of its own: Cloud is a deployment of the jira area, and
 * jira.fixture.ts brings its connection and these routes in beside Data Center's.
 *
 * Provenance: every shape here is invented from Atlassian's documented Jira
 * Cloud REST API 3 and Agile REST API 1.0 (the OpenAPI specs behind
 * developer.atlassian.com/cloud/jira/platform/rest/v3 and
 * developer.atlassian.com/cloud/jira/software/rest), trimmed to the fields that
 * matter. None was captured from a live site; the specification has been
 * accepted as its own witness, pending cross-examination. Rich text is Atlassian Document
 * Format, and people carry an accountId and no username, as the docs show.
 */

export const SITE = 'https://jira-cloud.imagile.dev';
const API = '/rest/api/3';
const AGILE = '/rest/agile/1.0';

export const ACCOUNT = '5b10ac8d82e05b22cc7d4ef5';
const user = (accountId: string, displayName: string) => ({ self: `${SITE}${API}/user?accountId=${accountId}`, accountId, accountType: 'atlassian', displayName, active: true });

/** An ADF document with one paragraph per string. */
export const doc = (...paragraphs: string[]) => ({ type: 'doc', version: 1, content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })) });

// Invented from the docs: GET /rest/api/3/issue/{issueIdOrKey}.
export const issue = (key: string, id = '10123') => ({
  expand: 'renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations',
  id,
  self: `${SITE}${API}/issue/${id}`,
  key,
  fields: {
    summary: 'Login broken on Safari',
    description: doc('Steps to reproduce are in the attached HAR.', 'Seen on 17.x only.'),
    status: { self: `${SITE}${API}/status/3`, name: 'In Progress', id: '3' },
    priority: { self: `${SITE}${API}/priority/2`, name: 'High', id: '2' },
    assignee: user(ACCOUNT, 'J. Smith'),
    reporter: user('abc12345-0000-0000-0000-000000000000', 'Alice'),
    labels: ['frontend'],
    issuetype: { self: `${SITE}${API}/issuetype/10001`, name: 'Bug', id: '10001', subtask: false },
    project: { self: `${SITE}${API}/project/10000`, id: '10000', key: 'PROJ', name: 'Project' },
    created: '2026-01-15T09:00:00.000+0000',
    updated: '2026-01-16T11:30:00.000+0000',
  },
});

const searchIssues = Array.from({ length: 3 }, (_, i) => issue(`PROJ-${i + 1}`, String(10001 + i)));

const json = (body: unknown, status = 200) => ({ status, json: body });
const empty = { status: 204 };

const comment = (id: string, author: ReturnType<typeof user>, body: unknown) => ({
  self: `${SITE}${API}/issue/10123/comment/${id}`,
  id,
  author,
  body,
  updateAuthor: author,
  created: '2026-01-16T12:00:00.000+0000',
  updated: '2026-01-16T12:00:00.000+0000',
  jsdPublic: true,
});

export const sprints = [
  { id: 41, self: `${SITE}${AGILE}/sprint/41`, state: 'closed', name: 'Sprint 41', startDate: '2026-01-01T00:00:00.000Z', endDate: '2026-01-14T00:00:00.000Z', originBoardId: 3 },
  { id: 42, self: `${SITE}${AGILE}/sprint/42`, state: 'active', name: 'Sprint 42', startDate: '2026-01-15T00:00:00.000Z', endDate: '2026-01-28T00:00:00.000Z', originBoardId: 3, goal: 'Ship login fix' },
];

/** A planned sprint, not in the board listing, so the start example has a future one to start. */
const futureSprint = { id: 43, self: `${SITE}${AGILE}/sprint/43`, state: 'future', name: 'Sprint 43', endDate: '2026-02-11T00:00:00.000Z', originBoardId: 3 };

export const projects = [
  { self: `${SITE}${API}/project/10000`, id: '10000', key: 'PROJ', name: 'Project', projectTypeKey: 'software', simplified: false, style: 'classic' },
  { self: `${SITE}${API}/project/10001`, id: '10001', key: 'IMG', name: 'Imagile web', projectTypeKey: 'software', simplified: true, style: 'next-gen' },
];

// Invented from the docs: an attachment, whose content URL Jira builds from its own base URL.
export const attachment = {
  self: `${SITE}${API}/attachment/10001`,
  id: '10001',
  filename: 'screenshot.png',
  author: user(ACCOUNT, 'J. Smith'),
  created: '2026-01-16T12:00:00.000+0000',
  size: 4,
  mimeType: 'image/png',
  content: `${SITE}${API}/attachment/content/10001`,
};

/** startAt and maxResults from a request's query, with the documented defaults. */
const paging = (req: RecordedRequest) => {
  const params = new URL(req.url).searchParams;
  return { startAt: Number(params.get('startAt') ?? 0), maxResults: Number(params.get('maxResults') ?? 50) };
};

// Invented from the docs: changelog entries, as the Get changelogs example shows them.
const histories = [
  { id: '10500', author: user('abc12345-0000-0000-0000-000000000000', 'Alice'), created: '2026-01-15T10:00:00.000+0000', items: [{ field: 'status', fieldtype: 'jira', fieldId: 'status', from: '10000', fromString: 'To Do', to: '3', toString: 'In Progress' }] },
  { id: '10501', author: user(ACCOUNT, 'J. Smith'), created: '2026-01-16T11:30:00.000+0000', items: [{ field: 'labels', fieldtype: 'jira', fieldId: 'labels', from: null, fromString: '', to: null, toString: 'frontend' }] },
];

export const routes: Route[] = [
  // check-toil-project's project lookup. Invented from the docs: GET /rest/api/3/project/{key}.
  { method: 'GET', path: `${API}/project/PROJ`, respond: json({ id: '10000', key: 'PROJ', name: 'Project', issueTypes: [{ id: '10001', name: 'Bug' }] }) },
  // The attachment-only read first: same path as issue get, with a query.
  { method: 'GET', path: `${API}/issue/PROJ-123`, query: { fields: 'attachment' }, respond: json({ id: '10123', key: 'PROJ-123', fields: { attachment: [attachment] } }) },
  { method: 'GET', path: `${API}/attachment/content/10001`, query: { redirect: 'false' }, respond: { text: 'PNG!', headers: { 'content-type': 'image/png' } } },
  { method: 'POST', path: `${API}/issue/PROJ-123/attachments`, respond: json([attachment]) },
  {
    method: 'POST',
    path: `${API}/issue/PROJ-123/worklog`,
    respond: (req: RecordedRequest) => {
      const body = JSON.parse(req.body!) as { timeSpent: string; started: string; comment?: unknown };
      return json(
        {
          self: `${SITE}${API}/issue/10123/worklog/10300`,
          id: '10300',
          issueId: '10123',
          author: user(ACCOUNT, 'J. Smith'),
          ...(body.comment ? { comment: body.comment } : {}),
          started: body.started,
          timeSpent: body.timeSpent,
          timeSpentSeconds: body.timeSpent === '1d' ? 28800 : 9000,
          created: '2026-01-16T12:00:00.000+0000',
          updated: '2026-01-16T12:00:00.000+0000',
        },
        201,
      );
    },
  },
  {
    method: 'GET',
    path: `${API}/field`,
    respond: json([
      { id: 'summary', key: 'summary', name: 'Summary', custom: false, orderable: true, navigable: true, searchable: true, clauseNames: ['summary'], schema: { type: 'string', system: 'summary' } },
      { id: 'customfield_10016', key: 'customfield_10016', name: 'Story Points', custom: true, orderable: true, navigable: true, searchable: true, clauseNames: ['cf[10016]', 'Story Points'], schema: { type: 'number', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float', customId: 10016 } },
      { id: 'customfield_10200', key: 'customfield_10200', name: 'Crew', custom: true, orderable: true, navigable: true, searchable: true, clauseNames: ['cf[10200]', 'Crew'], schema: { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select', customId: 10200 } },
    ]),
  },
  // Invented from the docs: the paged createmeta that replaced the classic one on Cloud.
  {
    method: 'GET',
    path: `${API}/issue/createmeta/PROJ/issuetypes`,
    query: { startAt: '0', maxResults: '50' },
    respond: json({ startAt: 0, maxResults: 50, total: 2, issueTypes: [{ id: '10001', name: 'Bug' }, { id: '10002', name: 'Story' }] }),
  },
  {
    method: 'GET',
    path: `${API}/issue/createmeta/PROJ/issuetypes/10001`,
    query: { startAt: '0', maxResults: '50' },
    respond: json({ startAt: 0, maxResults: 50, total: 1, fields: [{ fieldId: 'customfield_10200', key: 'customfield_10200', name: 'Crew', required: false, allowedValues: [{ id: '10400', value: 'Platform' }, { id: '10401', value: 'Payments' }] }] }),
  },
  // Invented from the docs: the issue with only its type and status, and the transitions it offers, which --to resolves against.
  {
    path: `${API}/issue/PROJ-123`,
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
  {
    method: 'POST',
    path: `${API}/issue/PROJ-123/comment`,
    respond: (req: RecordedRequest) => json(comment('10200', user(ACCOUNT, 'J. Smith'), (JSON.parse(req.body!) as { body: unknown }).body), 201),
  },
  { path: /^\/rest\/api\/3\/issue\/PROJ-\d+$/, method: 'GET', respond: (req: RecordedRequest) => json(issue(new URL(req.url).pathname.split('/').pop()!)) },
  // Invented from the docs: POST /rest/api/3/issue answers 201 with id, key and self.
  { method: 'POST', path: `${API}/issue`, respond: json({ id: '10124', key: 'PROJ-124', self: `${SITE}${API}/issue/10124` }, 201) },
  { method: 'PUT', path: `${API}/issue/PROJ-123`, respond: empty },
  { method: 'PUT', path: `${API}/issue/PROJ-123/assignee`, respond: empty },
  {
    method: 'GET',
    path: `${API}/issue/PROJ-123/transitions`,
    respond: json({
      expand: 'transitions',
      transitions: [
        { id: '11', name: 'To Do', to: { name: 'To Do', id: '10000' } },
        { id: '21', name: 'In Progress', to: { name: 'In Progress', id: '3' } },
        { id: '31', name: 'Done', to: { name: 'Done', id: '10001' } },
      ],
    }),
  },
  { method: 'POST', path: `${API}/issue/PROJ-123/transitions`, respond: empty },
  {
    // Answers the page startAt asks for, so --cursor resumes.
    method: 'GET',
    path: `${API}/issue/PROJ-123/comment`,
    respond: (req: RecordedRequest) => {
      const { startAt, maxResults } = paging(req);
      const comments = [comment('10200', user(ACCOUNT, 'J. Smith'), doc('Reproduced on staging.')), comment('10201', user('abc12345-0000-0000-0000-000000000000', 'Alice'), doc('Fixed in 1.4.2.'))];
      return json({ startAt, maxResults, total: comments.length, comments: comments.slice(startAt, startAt + maxResults) });
    },
  },
  // Invented from the docs: GET /rest/api/3/issue/{issueIdOrKey}/changelog, a PageBeanChangelog.
  {
    method: 'GET',
    path: `${API}/issue/PROJ-123/changelog`,
    respond: (req: RecordedRequest) => {
      const { startAt, maxResults } = paging(req);
      const values = histories.slice(startAt, startAt + maxResults);
      return json({ self: `${SITE}${API}/issue/PROJ-123/changelog?startAt=${startAt}&maxResults=${maxResults}`, maxResults, startAt, total: histories.length, isLast: startAt + values.length >= histories.length, values });
    },
  },
  // Invented from the docs: POST /rest/api/3/issue/bulkfetch. Issues come back in id order, and a key
  // that doesn't exist is simply absent (it isn't an issueError, which is for retriable failures).
  {
    method: 'POST',
    path: `${API}/issue/bulkfetch`,
    respond: (req: RecordedRequest) => {
      const asked = (JSON.parse(req.body!) as { issueIdsOrKeys: string[] }).issueIdsOrKeys;
      const found = asked.filter((k) => /^PROJ-[1-9]\d{0,2}$/.test(k) && k !== 'PROJ-404').map((k) => issue(k, String(10100 + Number(k.slice(5)))));
      return json({ expand: 'schema,names', issueErrors: [], issues: found.sort((a, b) => Number(a.id) - Number(b.id)) });
    },
  },
  // Invented from the docs: GET /rest/api/3/myself, for --updated-since's time zone.
  { method: 'GET', path: `${API}/myself`, respond: json({ ...user(ACCOUNT, 'J. Smith'), emailAddress: 'you@example.com', timeZone: 'Australia/Sydney' }) },

  // The enhanced search: a token per page and no total. Three issues, then no token.
  {
    method: 'POST',
    path: `${API}/search/jql`,
    // Invented from the docs: with expand=changelog each issue carries the changelog object.
    respond: (req) => {
      const expand = (JSON.parse(req.body!) as { expand?: string }).expand;
      return json({ issues: expand === 'changelog' ? searchIssues.map((i) => ({ ...i, changelog: { startAt: 0, maxResults: 100, total: 1, histories: [{ id: '10100', author: { accountId: ACCOUNT, displayName: 'J. Smith' }, created: '2026-10-01T09:30:00.000+0000', items: [{ field: 'status', fieldtype: 'jira', fieldId: 'status', from: '1', fromString: 'To Do', to: '3', toString: 'In Progress' }] }] } })) : searchIssues, isLast: true });
    },
  },

  {
    method: 'GET',
    path: `${API}/issueLinkType`,
    respond: json({
      issueLinkTypes: [
        { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks', self: `${SITE}${API}/issueLinkType/10000` },
        { id: '10001', name: 'Relates', inward: 'relates to', outward: 'relates to', self: `${SITE}${API}/issueLinkType/10001` },
      ],
    }),
  },
  { method: 'POST', path: `${API}/issueLink`, respond: { status: 201 } },

  // Projects: one page, isLast. The query filter is the server's.
  {
    method: 'GET',
    path: `${API}/project/search`,
    respond: (req: RecordedRequest) => {
      const query = new URL(req.url).searchParams.get('query');
      const { startAt, maxResults } = paging(req);
      const matching = query ? projects.filter((p) => `${p.key} ${p.name}`.toLowerCase().includes(query.toLowerCase())) : projects;
      const values = matching.slice(startAt, startAt + maxResults);
      return json({ self: `${SITE}${API}/project/search`, maxResults, startAt, total: matching.length, isLast: startAt + values.length >= matching.length, values });
    },
  },
  { method: 'GET', path: `${API}/project/PROJ`, respond: json({ ...projects[0], description: '', lead: user(ACCOUNT, 'J. Smith'), issueTypes: [{ id: '10001', name: 'Bug' }] }) },
  // A bare list, as the docs show. Answers from startAt, so --cursor resumes.
  {
    method: 'GET',
    path: `${API}/user/search`,
    respond: (req: RecordedRequest) => {
      const { startAt, maxResults } = paging(req);
      const users = [{ ...user(ACCOUNT, 'J. Smith'), emailAddress: 'you@example.com' }, user('abc12345-0000-0000-0000-000000000000', 'Alice Smith')];
      return json(users.slice(startAt, startAt + maxResults));
    },
  },

  // Agile. Board lists answer the page startAt asks for.
  {
    method: 'GET',
    path: `${AGILE}/board`,
    respond: (req: RecordedRequest) => {
      const { startAt, maxResults } = paging(req);
      const boards = [{ id: 3, name: 'PROJ board', type: 'scrum' }, { id: 4, name: 'PROJ kanban', type: 'kanban' }, { id: 5, name: 'PROJ team board', type: 'simple' }];
      const values = boards.slice(startAt, startAt + maxResults);
      return json({ maxResults, startAt, total: boards.length, isLast: startAt + values.length >= boards.length, values });
    },
  },
  { method: 'GET', path: `${AGILE}/board/3/sprint`, respond: json({ maxResults: 50, startAt: 0, isLast: true, values: sprints }) },
  {
    method: 'GET',
    path: `${AGILE}/board/1/sprint`,
    respond: (req: RecordedRequest) => {
      const { startAt, maxResults } = paging(req);
      const values = sprints.slice(startAt, startAt + maxResults);
      return json({ maxResults, startAt, isLast: startAt + values.length >= sprints.length, values });
    },
  },
  // Invented from the docs: a team-managed board with sprints turned off.
  { method: 'GET', path: `${AGILE}/board/5/sprint`, respond: json({ errorMessages: ['The board does not support sprints'], errors: {} }, 400) },
  { method: 'POST', path: `${AGILE}/sprint/42/issue`, respond: empty },
  { method: 'POST', path: `${AGILE}/sprint/43/issue`, respond: empty },
  { method: 'POST', path: `${AGILE}/backlog/issue`, respond: empty },

  // Sprint ceremony. Invented from the docs: the Agile API's sprint object,
  // an active sprint (42) to complete and a future one (43) to start. The
  // fixture holds no state, so a start answers with what it was asked for.
  { method: 'GET', path: `${AGILE}/sprint/42`, respond: json(sprints[1]) },
  { method: 'GET', path: `${AGILE}/sprint/43`, respond: json(futureSprint) },
  { method: 'GET', path: `${AGILE}/sprint/42/issue`, respond: json({ maxResults: 50, startAt: 0, total: 1, isLast: true, issues: [{ id: '10123', key: 'PROJ-9', fields: { summary: 'Still open' } }] }) },
  { method: 'POST', path: `${AGILE}/sprint`, respond: json({ ...futureSprint, id: 44, self: `${SITE}${AGILE}/sprint/44`, name: 'Sprint 44' }, 201) },
  { method: 'POST', path: `${AGILE}/sprint/42`, respond: (req: RecordedRequest) => json({ ...sprints[1], ...(JSON.parse(req.body ?? '{}') as object) }) },
  { method: 'POST', path: `${AGILE}/sprint/43`, respond: (req: RecordedRequest) => json({ ...futureSprint, ...(JSON.parse(req.body ?? '{}') as object) }) },
];

/** Local files the examples read. */
export const files: Record<string, string> = {
  'cloud-issue.json': JSON.stringify({ project: 'PROJ', issueType: 'Story', fields: { summary: 'From a file', description: '@desc.txt', labels: ['a', 'b'], priority: 'High' } }),
  'cloud-update.json': JSON.stringify({ fields: { description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'As ADF' }] }] }, customfield_10050: 'Acceptance criteria' } }),
  'fields.json': JSON.stringify({ fixVersions: [{ name: '1.4.2' }], 'Story Points': 3 }),
  'desc.txt': 'A long description.\n\nIn two paragraphs.',
  'query.jql': 'project = PROJ ORDER BY created DESC\n',
  'screenshot.png': 'PNG!',
};

/** The Cloud connection, named `jira-cloud`: an ordinary jira connection with deployment cloud. */
export const config = {
  'jira-cloud': {
    area: 'jira',
    deployment: 'cloud',
    baseUrl: SITE,
    email: 'you@example.com',
    apiToken: 'test-token',
    project: 'PROJ',
    customFields: [
      { id: 'customfield_10016', name: 'Story Points', type: 'number' },
      { id: 'customfield_10300', name: 'Reviewer', type: 'user' },
    ],
    writes: true,
  },
};
