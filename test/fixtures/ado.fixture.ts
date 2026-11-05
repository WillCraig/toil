import type { RecordedRequest, Route } from '../harness/fake-fetch.js';
import { defineFixture } from '../harness/fixtures.js';
import * as cloud from './ado-cloud-data.js';

/**
 * Canned Azure DevOps Server responses for every request the ado examples
 * send, so the parity suite runs every command offline through both front
 * doors. Routes match on method and path; paged lists answer by whether the
 * request carries a continuation token or a `$skip`.
 *
 * Provenance: the examples recorded with the command contract carry only
 * what each needs (`{ value: [...] }`, an `x-ms-continuationtoken` header, a work
 * item's `relations`), so the full shapes are invented from the Azure DevOps
 * REST API 7.1 reference and checked against the response types the
 * contract records. Inventing a response from the documentation is
 * how most integrations are specified anyway; this one at least says so.
 */

export const ADO = 'https://ado.imagile.dev';
export const COLL = '/DefaultCollection';
export const PROJ = `${COLL}/Imagile`;
export const REPO = `${PROJ}/_apis/git/repositories/imagile-api`;
export const SHA = 'abc12345def67890abc12345def67890abc12345';
export const ME = 'abc12345-0000-0000-0000-00000000000a';
export const ATTACHMENT = 'abc12345-0000-0000-0000-000000000000';

export const config = { ado: { baseUrl: ADO, pat: 'test-pat', writes: true } };

const identity = (id: string, name: string) => ({ id, displayName: name, uniqueName: `${name.toLowerCase().replace(/ /g, '.')}@example.com`, url: `${ADO}/_apis/Identities/${id}`, descriptor: `win.${id}` });

// Invented from the docs: GET _apis/connectionData.
export const connectionData = {
  authenticatedUser: { id: ME, descriptor: `System.${ME}`, providerDisplayName: 'Jane Doe', isActive: true, properties: {} },
  authorizedUser: { id: ME, descriptor: `System.${ME}`, providerDisplayName: 'Jane Doe', isActive: true, properties: {} },
  instanceId: 'abc12345-0000-0000-0000-000000000001',
  deploymentId: 'abc12345-0000-0000-0000-000000000002',
  deploymentType: 'onPremises',
  webApplicationRelativeDirectory: '/',
};

export const project = (name: string) => ({ id: `abc12345-0000-0000-0000-0000000000${name.length}0`, name, description: 'Team project', url: `${ADO}${COLL}/_apis/projects/${name}`, state: 'wellFormed', revision: 41, visibility: 'private', lastUpdateTime: '2026-09-01T12:00:00Z' });

// Invented from the docs: a work item with $expand=all.
export const workItem = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  rev: 3,
  fields: { 'System.Title': `Item ${id}`, 'System.State': 'Active', 'System.WorkItemType': 'Bug', 'System.Tags': 'ui; backend' },
  relations: [
    { rel: 'AttachedFile', url: `${ADO}${COLL}/_apis/wit/attachments/${ATTACHMENT}`, attributes: { name: 'screenshot.png', resourceSize: 5, resourceCreatedDate: '2026-09-02T12:00:00Z', comment: 'Before' } },
    { rel: 'System.LinkTypes.Related', url: `${ADO}${COLL}/_apis/wit/workItems/7`, attributes: { isLocked: false } },
  ],
  _links: { self: { href: `${ADO}${COLL}/_apis/wit/workItems/${id}` } },
  url: `${ADO}${COLL}/_apis/wit/workItems/${id}`,
  ...extra,
});

// Invented from the docs: one entry of GET .../workItems/{id}/revisions, the whole item as of that revision.
const revision = (rev: number, state: string) => ({
  id: 42,
  rev,
  fields: { 'System.WorkItemType': 'Bug', 'System.State': state, 'System.Title': 'Item 42', 'System.ChangedDate': `2026-09-0${rev}T12:00:00Z`, 'System.ChangedBy': identity(ME, 'Jane Doe') },
  url: `${ADO}${COLL}/_apis/wit/workItems/42/revisions/${rev}`,
});

// Invented from Reporting Work Item Revisions - Read Reporting Revisions Get (7.1): { id, rev, fields }, people as
// "Name <email>" text, no url. Page one names a continuationToken and says isLastBatch false; page two has the last.
// (https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/reporting-work-item-revisions/read-reporting-revisions-get?view=azure-devops-rest-7.1)
export const feedRevision = (id: number, rev: number, state: string) => ({
  id,
  rev,
  fields: {
    'System.Id': id,
    'System.Rev': rev,
    'System.TeamProject': 'Imagile',
    'System.WorkItemType': 'Bug',
    'System.State': state,
    'System.IterationPath': 'Imagile\\Sprint 1',
    'System.Title': `Item ${id}`,
    'System.ChangedDate': `2026-09-0${rev}T12:00:00Z`,
    'System.ChangedBy': 'Jane Doe <jane.doe@example.com>',
  },
});
const feedBatch = (r: { url: string }) => {
  const url = new URL(r.url);
  return url.searchParams.has('continuationToken')
    ? { json: { values: [feedRevision(42, 3, 'Resolved')], nextLink: `https://dev.azure.com/imagile/_apis/wit/reporting/workItemRevisions?continuationToken=813;42;3`, continuationToken: '813;42;3', isLastBatch: true } }
    : { json: { values: [feedRevision(42, 1, 'New'), feedRevision(42, 2, 'Active'), feedRevision(7, 1, 'New')], nextLink: 'https://dev.azure.com/imagile/_apis/wit/reporting/workItemRevisions?continuationToken=abc12345', continuationToken: 'abc12345', isLastBatch: false } };
};

const comment = (id: number) => ({ id, workItemId: 42, version: 1, text: `Comment ${id}`, createdBy: identity(ME, 'Jane Doe'), createdDate: '2026-09-03T12:00:00Z', url: `${ADO}${PROJ}/_apis/wit/workItems/42/comments/${id}` });

const node = (structureType: string, name: string, children: unknown[] = []) => ({
  id: name.length,
  identifier: `abc12345-0000-0000-0000-00000000010${name.length % 10}`,
  name,
  structureType,
  path: `\\Imagile\\${structureType === 'area' ? 'Area' : 'Iteration'}\\${name}`,
  hasChildren: children.length > 0,
  ...(children.length > 0 ? { children } : {}),
  ...(structureType === 'iteration' ? { attributes: { startDate: '2026-10-01T00:00:00Z', finishDate: '2026-10-14T00:00:00Z' } } : {}),
  url: `${ADO}${PROJ}/_apis/wit/classificationNodes/${structureType}s/${name}`,
});

export const repo = { id: 'abc12345-0000-0000-0000-000000000003', name: 'imagile-api', url: `${ADO}${REPO}`, project: project('Imagile'), defaultBranch: 'refs/heads/main', remoteUrl: `${ADO}${PROJ}/_git/imagile-api`, isDisabled: false };

// Invented from the docs: GET .../pullrequests/{id}.
export const pr = (id: number, extra: Record<string, unknown> = {}) => ({
  pullRequestId: id,
  title: `Change ${id}`,
  description: 'What and why',
  status: 'active',
  createdBy: identity(ME, 'Jane Doe'),
  creationDate: '2026-09-15T12:00:00Z',
  sourceRefName: 'refs/heads/feature/retries',
  targetRefName: 'refs/heads/main',
  reviewers: [{ ...identity('abc12345-0000-0000-0000-00000000000b', 'Sam Smith'), vote: 10, isRequired: true }],
  lastMergeSourceCommit: { commitId: SHA },
  lastMergeTargetCommit: { commitId: 'def67890abc12345def67890abc12345def67890' },
  isDraft: false,
  url: `${ADO}${REPO}/pullRequests/${id}`,
  ...extra,
});

const threadComment = (id: number, minute: number, extra: Record<string, unknown> = {}) => ({
  id,
  parentCommentId: 0,
  author: identity(ME, 'Jane Doe'),
  content: `Comment ${id}`,
  commentType: 'text',
  publishedDate: `2026-09-16T12:${String(minute).padStart(2, '0')}:00Z`,
  lastUpdatedDate: `2026-09-16T12:${String(minute).padStart(2, '0')}:00Z`,
  ...extra,
});

export const thread = (id: number, comments: unknown[], extra: Record<string, unknown> = {}) => ({
  id,
  status: 'active',
  publishedDate: '2026-09-16T12:00:00Z',
  lastUpdatedDate: '2026-09-16T12:30:00Z',
  comments,
  isDeleted: false,
  ...extra,
});

export const threads = [
  thread(7, [threadComment(1, 5), threadComment(2, 1, { isDeleted: true })]),
  thread(8, [threadComment(3, 2)], { threadContext: { filePath: '/src/app.ts', rightFileStart: { line: 12, offset: 1 }, rightFileEnd: { line: 12, offset: 1 } } }),
  thread(9, [threadComment(4, 0)], { isDeleted: true }),
];

// Invented from the docs: one GitPullRequestStatus.
export const prStatus = {
  id: 1,
  state: 'succeeded',
  description: 'Build passed',
  context: { name: 'ci', genre: 'build' },
  creationDate: '2026-09-16T12:00:00Z',
  updatedDate: '2026-09-16T12:05:00Z',
  createdBy: identity(ME, 'Jane Doe'),
  targetUrl: `${ADO}${PROJ}/_build/results?buildId=101`,
};

// Invented from the docs: one GitCommitRef of a pull request.
export const prCommit = (commitId: string) => ({
  commitId,
  author: { name: 'Jane Doe', email: 'you@example.com', date: '2026-09-15T11:00:00Z' },
  committer: { name: 'Jane Doe', email: 'you@example.com', date: '2026-09-15T11:00:00Z' },
  comment: 'Add retries',
  url: `${ADO}${REPO}/commits/${commitId}`,
});

const definitionRef ={ id: 5, name: 'imagile-api-ci', path: '\\', type: 'build', queueStatus: 'enabled', revision: 4, project: project('Imagile'), url: `${ADO}${PROJ}/_apis/build/Definitions/5` };
export const definition = (id: number, name: string) => ({ ...definitionRef, id, name, url: `${ADO}${PROJ}/_apis/build/Definitions/${id}` });

export const build = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  buildNumber: `2026.10.${id}`,
  status: 'completed',
  result: 'succeeded',
  definition: { id: 5, name: 'imagile-api-ci' },
  project: project('Imagile'),
  sourceBranch: 'refs/heads/feature/retries',
  priority: 'normal',
  url: `${ADO}${PROJ}/_apis/build/Builds/${id}`,
  ...extra,
});

const log = (id: number) => ({ id, type: 'Container', lineCount: 12, createdOn: '2026-10-01T12:00:00Z', lastChangedOn: '2026-10-01T12:05:00Z', url: `${ADO}${PROJ}/_apis/build/builds/101/logs/${id}` });

const hasQuery = (r: RecordedRequest, key: string) => new URL(r.url).searchParams.has(key);

/** A continuation-token list: page one names a token, page two has none. */
const continued = (first: unknown[], second: unknown[]) => (r: RecordedRequest) =>
  hasQuery(r, 'continuationToken') ? { json: { count: second.length, value: second } } : { json: { count: first.length, value: first }, headers: { 'x-ms-continuationtoken': 'abc12345' } };

export const routes: Route[] = [
  // check-toil-project's project lookup. Invented from the docs: GET {collection}/_apis/projects/{project}. Its repo lookup is repo get's route.
  { path: `${COLL}/_apis/projects/Imagile`, query: { 'api-version': '7.1' }, respond: { json: project('Imagile') } },
  { path: `${COLL}/_apis/connectionData`, respond: { json: connectionData } },
  { path: '/_apis/projectCollections', respond: { json: { count: 1, value: [{ id: 'abc12345-0000-0000-0000-000000000004', name: 'DefaultCollection', url: `${ADO}/_apis/projectCollections/abc12345-0000-0000-0000-000000000004`, collectionUrl: `${ADO}${COLL}`, state: 'Started' }] } } },
  { path: `${COLL}/_apis/projects`, respond: continued([project('Imagile')], [project('Imagile Ops')]) },
  { path: `${COLL}/_apis/projects/Imagile`, respond: { json: project('Imagile') } },

  // Work items
  { path: /^\/DefaultCollection\/_apis\/wit\/workitems\/\d+$/, respond: { json: workItem(42) } },
  { method: 'PATCH', path: /^\/DefaultCollection\/_apis\/wit\/workitems\/\d+$/, respond: { json: workItem(42, { rev: 4 }) } },
  { method: 'POST', path: /^\/DefaultCollection\/Imagile\/_apis\/wit\/workitems\/%24/, respond: { json: workItem(43, { rev: 1 }) } },
  {
    method: 'POST',
    path: `${PROJ}/_apis/wit/wiql`,
    respond: { json: { queryType: 'flat', queryResultType: 'workItem', asOf: '2026-10-17T12:00:00Z', columns: [], workItems: [42, 7].map((id) => ({ id, url: `${ADO}${COLL}/_apis/wit/workItems/${id}` })) } },
  },
  // Revisions, by $top and $skip: two on the first page, none after. The shape follows the Revisions - List reference
  // (https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/revisions/list?view=azure-devops-server-rest-7.1).
  {
    path: `${PROJ}/_apis/wit/workItems/42/revisions`,
    respond: (r) => ({ json: new URL(r.url).searchParams.get('$skip') === '0' ? { count: 2, value: [revision(1, 'New'), revision(2, 'Active')] } : { count: 0, value: [] } }),
  },
  { path: `${PROJ}/_apis/wit/reporting/workitemrevisions`, respond: feedBatch },
  // The batch endpoint with errorPolicy omit: an id that doesn't exist (404 here) comes back as null, in place.
  // From the Get Work Items Batch reference (https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/get-work-items-batch?view=azure-devops-server-rest-7.1).
  {
    method: 'POST',
    path: `${PROJ}/_apis/wit/workitemsbatch`,
    respond: (r) => {
      const ids = (JSON.parse(r.body ?? '{}') as { ids: number[] }).ids;
      const value = ids.map((id) => (id === 404 ? null : workItem(id)));
      return { json: { count: value.length, value } };
    },
  },
  { path: `${PROJ}/_apis/wit/workItems/42/comments`, respond: { json: { totalCount: 2, count: 2, comments: [comment(1), comment(2)] } } },
  { method: 'POST', path: `${PROJ}/_apis/wit/workItems/42/comments`, respond: { json: comment(3) } },
  { method: 'POST', path: `${COLL}/_apis/wit/attachments`, respond: { json: { id: ATTACHMENT, url: `${ADO}${COLL}/_apis/wit/attachments/${ATTACHMENT}` } } },
  { path: `${COLL}/_apis/wit/attachments/${ATTACHMENT}`, respond: { text: 'bytes' } },
  { path: `${PROJ}/_apis/wit/classificationnodes/areas`, respond: { json: node('area', 'Imagile', [node('area', 'Web')]) } },
  { path: `${PROJ}/_apis/wit/classificationnodes/iterations`, respond: { json: node('iteration', 'Sprint 1') } },
  { path: `${PROJ}/_apis/wit/workitemtypes`, respond: { json: { count: 2, value: [{ name: 'Bug', fields: [{ referenceName: 'System.Title', alwaysRequired: true }, { referenceName: 'System.Description' }] }, { name: 'Task' }] } } },
  // Invented from the docs: the Agile process's Bug, whose Resolved state is what --to review finds.
  { path: '/DefaultCollection/Imagile/_apis/wit/workitemtypes/Bug/states', respond: { json: { count: 4, value: [{ name: 'New', color: 'b2b2b2', category: 'Proposed' }, { name: 'Active', color: '007acc', category: 'InProgress' }, { name: 'Resolved', color: 'ff9d00', category: 'Resolved' }, { name: 'Closed', color: '339933', category: 'Completed' }] } } },
  { path: /^\/DefaultCollection\/Imagile\/_apis\/wit\/workitemtypes\/[^/]+\/states$/, respond: { json: { count: 2, value: [{ name: 'New', color: 'b2b2b2', category: 'Proposed' }, { name: 'Active', color: '007acc', category: 'InProgress' }] } } },
  {
    path: `${COLL}/_apis/wit/fields`,
    respond: {
      json: {
        count: 3,
        value: [
          { referenceName: 'System.Title', name: 'Title', type: 'string', readOnly: false },
          { referenceName: 'Microsoft.VSTS.Scheduling.StoryPoints', name: 'Story Points', type: 'double', readOnly: false },
          { referenceName: 'MyOrg.Team', name: 'Team', type: 'string', readOnly: false, picklistId: 'abc12345-0000-0000-0000-000000000005' },
        ],
      },
    },
  },
  // As documented: type-scoped fields carry no type or readOnly (#69 item 18).
  { path: `${PROJ}/_apis/wit/workitemtypes/Bug/fields`, respond: { json: { count: 2, value: [{ referenceName: 'System.Title', name: 'Title', alwaysRequired: true }, { referenceName: 'MyOrg.Team', name: 'Team', alwaysRequired: false }] } } },

  // Repositories and pull requests
  { path: `${PROJ}/_apis/git/repositories`, respond: { json: { count: 1, value: [repo] } } },
  { method: 'POST', path: `${PROJ}/_apis/git/repositories`, respond: { json: { ...repo, name: 'imagile-new' } } },
  { path: REPO, respond: { json: repo } },
  { path: `${REPO}/pullrequests`, respond: (r) => ({ json: { count: 1, value: new URL(r.url).searchParams.get('$skip') === '0' ? [pr(42)] : [] } }) },
  { path: /\/pullrequests\/\d+$/, respond: { json: pr(42) } },
  { method: 'POST', path: `${REPO}/pullrequests`, respond: { json: pr(44, { isDraft: true }) } },
  { method: 'PATCH', path: /\/pullrequests\/\d+$/, respond: { json: pr(42, { status: 'completed' }) } },
  { path: `${REPO}/pullrequests/42/threads`, respond: { json: { count: threads.length, value: threads } } },
  { method: 'POST', path: `${REPO}/pullrequests/42/threads`, respond: { json: thread(10, [threadComment(5, 9)]) } },
  { method: 'POST', path: `${REPO}/pullrequests/42/threads/7/comments`, respond: { json: threadComment(6, 10) } },
  { method: 'PATCH', path: `${REPO}/pullrequests/42/threads/7`, respond: { json: thread(7, [threadComment(1, 5)], { status: 'fixed' }) } },
  { method: 'DELETE', path: `${REPO}/pullrequests/42/threads/7/comments/2`, respond: { status: 204 } },
  // Invented from the docs: Pull Request Statuses - List, and Pull Request Commits - Get Pull Request Commits (paged by x-ms-continuationtoken).
  { path: `${REPO}/pullrequests/42/statuses`, respond: { json: { count: 1, value: [prStatus] } } },
  { path: `${REPO}/pullrequests/42/commits`, respond: continued([prCommit(SHA)], [prCommit('def67890abc12345def67890abc12345def67890')]) },
  { path: `${REPO}/pullrequests/42/iterations`, respond: { json: { count: 2, value: [{ id: 1 }, { id: 2 }] } } },
  { path: `${REPO}/pullrequests/42/iterations/2/changes`, respond: { json: { changeEntries: [{ changeTrackingId: 1, changeId: 1, item: { objectId: SHA, path: '/src/app.ts' }, changeType: 'edit' }] } } },
  {
    path: `${REPO}/diffs/commits`,
    respond: {
      json: {
        allChangesIncluded: true,
        changeCounts: { Edit: 2 },
        changes: [
          { item: { objectId: SHA, path: '/src/app.ts', gitObjectType: 'blob' }, changeType: 'edit' },
          { item: { objectId: SHA, path: '/README.md', gitObjectType: 'blob' }, changeType: 'edit' },
        ],
        commonCommit: SHA,
        baseCommit: 'def67890abc12345def67890abc12345def67890',
        targetCommit: SHA,
        aheadCount: 2,
        behindCount: 0,
      },
    },
  },
  { path: `${REPO}/commits/${SHA}/statuses`, respond: { json: { count: 1, value: [{ id: 1, state: 'succeeded', description: 'Build passed', context: { name: 'ci', genre: 'build' }, targetUrl: `${ADO}${PROJ}/_build/results?buildId=101`, createdBy: identity(ME, 'Jane Doe'), creationDate: '2026-09-16T12:00:00Z' }] } } },
  {
    path: `${PROJ}/_apis/policy/configurations`,
    respond: {
      json: {
        count: 3,
        value: [
          { id: 1, isEnabled: true, type: { id: 'fd2167ab-b0be-447a-8ec8-39368250530e', displayName: 'Required reviewers' }, settings: { requiredReviewerIds: [ME], scope: [{ repositoryId: repo.id, refName: 'refs/heads/main' }] } },
          { id: 2, isEnabled: true, type: { id: 'fd2167ab-b0be-447a-8ec8-39368250530e', displayName: 'Required reviewers' }, settings: { requiredReviewerIds: [ME], scope: [{ repositoryId: 'abc12345-0000-0000-0000-000000000009' }] } },
          { id: 3, isEnabled: true, type: { id: 'fa4e907d-c16b-4a4c-9dfa-4906e5d171dd', displayName: 'Minimum number of reviewers' }, settings: { scope: [{ repositoryId: null }] } },
        ],
      },
    },
  },
  { method: 'PUT', path: `${REPO}/pullrequests/42/reviewers/${ME}`, respond: (r) => ({ json: { ...identity(ME, 'Jane Doe'), vote: (JSON.parse(r.body ?? '{}') as { vote: number }).vote } }) },

  // Pipelines
  { path: `${PROJ}/_apis/build/definitions`, respond: continued([definition(5, 'imagile-api-ci')], [definition(6, 'imagile-web-ci')]) },
  { path: `${PROJ}/_apis/build/definitions/5`, respond: { json: definition(5, 'imagile-api-ci') } },
  { method: 'POST', path: `${PROJ}/_apis/build/builds`, respond: { json: build(102, { status: 'notStarted', result: undefined }) } },
  { path: `${PROJ}/_apis/build/builds`, respond: (r) => (hasQuery(r, '$top') ? { json: { count: 2, value: [build(101), build(100)] } } : continued([build(101)], [build(100)])(r)) },
  { path: /\/_apis\/build\/builds\/\d+$/, respond: { json: build(101) } },
  { method: 'PATCH', path: /\/_apis\/build\/builds\/\d+$/, respond: { json: build(101, { status: 'cancelling' }) } },
  { path: `${PROJ}/_apis/build/builds/101/logs`, respond: { json: { count: 2, value: [log(1), log(3)] } } },
  { path: `${PROJ}/_apis/build/builds/101/logs/3`, respond: { text: '2026-10-01T12:00:00Z Starting: Build\n2026-10-01T12:05:00Z Finishing: Build\n' } },
];

export const files = {
  'work-item.json': JSON.stringify({ type: 'Task', fields: { Title: 'From the file', Description: '@desc.html', 'Acceptance Criteria': 'It works', Priority: 2 } }),
  'desc.html': '<p>Steps</p>',
  'screenshot.png': new Uint8Array([137, 80, 78, 71, 13]),
  'logs/run.txt': 'log line\n',
};

/**
 * The toil project the examples run with, for check-toil-project. Its context inputs are
 * per repo, and no example's folder is that repo, so no other example reads them.
 */
export const toilProject = { name: 'payments', ado: { collection: { 'imagile-api': 'DefaultCollection' }, project: { 'imagile-api': 'Imagile' }, repo: { 'imagile-api': 'imagile-api' } } };


/**
 * Both deployments, side by side: Server's connection (`ado`, the area's
 * default) and Services' (`ado-cloud`, deployment cloud), each with the routes
 * and files its examples read. Every route is pinned to its own origin, so the
 * two sets of paths can't answer for each other.
 */
const pinned = (list: Route[], origin: string): Route[] => list.map((r) => (r.path !== undefined && r.origin === undefined ? { ...r, origin } : r));

export const fixture = defineFixture({
  area: 'ado',
  routes: [...pinned(routes, ADO), ...pinned(cloud.routes, cloud.HOST)],
  config: { ...config, ...cloud.config },
  deployments: { server: 'ado', cloud: 'ado-cloud' },
  files: { ...files, ...cloud.files },
  toilProject,
});
