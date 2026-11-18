import type { RecordedRequest, Route } from '../harness/fake-fetch.js';

/**
 * Canned Azure DevOps Services responses for every request the Services
 * examples of `ado` send, so the parity suite runs them offline through both
 * front doors. Not a fixture of its own: Services is a deployment of the ado
 * area, and ado.fixture.ts brings its connection and these routes in beside
 * Server's.
 *
 * Provenance: most shapes here are invented from Microsoft's Azure DevOps
 * Services REST API 7.1 reference
 * (https://learn.microsoft.com/en-us/rest/api/azure/devops/?view=azure-devops-rest-7.1),
 * trimmed to the fields that matter. The team settings (sprints, backlogs,
 * boards), work item type states and the project's defaultTeam were captured
 * from a live Scrum organization (#320) and sanitized to placeholders; each
 * says so where it's defined. The organization URL is a placeholder host with the
 * organization `imagile` as its first path segment, as on dev.azure.com.
 * Paged lists answer by whether the request carries a continuation token or
 * a `$skip` past the first page. An organization that exists only on paper
 * is, for once, exactly what the paperwork calls for.
 */

export const ORG_URL = 'https://ado-cloud.imagile.dev/imagile';
export const HOST = 'https://ado-cloud.imagile.dev';
export const ORG = '/imagile';
export const PROJ = `${ORG}/Imagile`;
export const REPO = `${PROJ}/_apis/git/repositories/imagile-api`;
export const SHA = 'abc12345def67890abc12345def67890abc12345';
export const ME = 'abc12345-0000-0000-0000-00000000000a';

/** The Services connection, named `ado-cloud`: an ordinary ado connection with deployment cloud. */
export const config = { 'ado-cloud': { area: 'ado', deployment: 'cloud', baseUrl: ORG_URL, pat: 'test-pat', writes: true } };

/** An identity as Services returns one: an Entra (aad.) descriptor, the user's email as uniqueName, and links on vssps. */
export const identity = (id: string, name: string) => ({
  displayName: name,
  url: `https://vssps.ado-cloud.imagile.dev/imagile/_apis/Identities/${id}`,
  id,
  uniqueName: 'you@example.com',
  imageUrl: `${ORG_URL}/_api/_common/identityImage?id=${id}`,
  descriptor: 'aad.YWJjMTIzNDUtMDAwMC0wMDAwLTAwMDAtMDAwMDAwMDAwMDBh',
});

// Invented from the docs' pattern for the undocumented GET {organization}/_apis/connectionData.
export const connectionData = {
  authenticatedUser: { id: ME, descriptor: `Microsoft.IdentityModel.Claims.ClaimsIdentity;abc12345-0000-0000-0000-000000000000\\you@example.com`, providerDisplayName: 'Jane Doe', isActive: true, properties: {} },
  authorizedUser: { id: ME, descriptor: `Microsoft.IdentityModel.Claims.ClaimsIdentity;abc12345-0000-0000-0000-000000000000\\you@example.com`, providerDisplayName: 'Jane Doe', isActive: true, properties: {} },
  instanceId: 'abc12345-0000-0000-0000-000000000001',
  deploymentId: 'abc12345-0000-0000-0000-000000000002',
  deploymentType: 'hosted',
  locationServiceData: { serviceOwner: '00025394-6065-48ca-87d9-7f5672854ef7', defaultAccessMappingMoniker: 'PublicAccessMapping' },
};

// Invented from Projects - List / Get.
export const project = (name: string) => ({ id: `abc12345-0000-0000-0000-0000000000${name.length}0`, name, description: 'Team project', url: `${ORG_URL}/_apis/projects/abc12345-0000-0000-0000-0000000000${name.length}0`, state: 'wellFormed', revision: 41, visibility: 'private', lastUpdateTime: '2026-09-01T12:00:00Z' });

// Invented from Work Items - Get Work Item with $expand=all.
export const workItem = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  rev: 3,
  fields: {
    'System.AreaPath': 'Imagile',
    'System.TeamProject': 'Imagile',
    'System.IterationPath': 'Imagile\\Sprint 1',
    'System.WorkItemType': 'Bug',
    'System.State': 'Active',
    'System.Title': `Item ${id}`,
    'System.AssignedTo': identity(ME, 'Jane Doe'),
    'System.CreatedDate': '2026-09-01T12:00:00Z',
    'System.ChangedDate': '2026-10-02T12:00:00Z',
    'Microsoft.VSTS.Common.Priority': 2,
    'System.Tags': 'ui; backend',
  },
  relations: [{ rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${ORG_URL}/_apis/wit/workItems/7`, attributes: { isLocked: false, name: 'Parent' } }],
  _links: { self: { href: `${ORG_URL}/_apis/wit/workItems/${id}` } },
  url: `${ORG_URL}/_apis/wit/workItems/${id}`,
  ...extra,
});

// Invented from Revisions - List: the whole item as of each revision.
const revision = (rev: number, state: string) => ({
  id: 42,
  rev,
  fields: { 'System.WorkItemType': 'Bug', 'System.State': state, 'System.Title': 'Item 42', 'System.ChangedDate': `2026-09-0${rev}T12:00:00Z`, 'System.ChangedBy': identity(ME, 'Jane Doe') },
  url: `${ORG_URL}/_apis/wit/workItems/42/revisions/${rev}`,
});

// Invented from Comments - Get Comments (7.1-preview.4).
export const comment = (id: number) => ({ workItemId: 42, id, version: 1, text: `Comment ${id}`, createdBy: identity(ME, 'Jane Doe'), createdDate: `2026-09-0${id}T12:00:00Z`, modifiedBy: identity(ME, 'Jane Doe'), modifiedDate: `2026-09-0${id}T12:00:00Z`, isDeleted: false, url: `${ORG_URL}/abc12345-0000-0000-0000-000000000070/_apis/wit/workItems/42/comments/${id}` });

// Written from the Classification Nodes - Get reference (structureType area), not captured from a server.
const areas = {
  id: 3,
  identifier: 'abc12345-0000-0000-0000-000000000103',
  name: 'Imagile',
  structureType: 'area',
  hasChildren: true,
  path: '\\Imagile\\Area',
  children: [{ id: 4, identifier: 'abc12345-0000-0000-0000-000000000104', name: 'Web', structureType: 'area', hasChildren: false, path: '\\Imagile\\Area\\Web' }],
  url: `${ORG_URL}/Imagile/_apis/wit/classificationNodes/Areas`,
};

const iterations = {
  id: 1,
  identifier: 'abc12345-0000-0000-0000-000000000101',
  name: 'Imagile',
  structureType: 'iteration',
  hasChildren: true,
  path: '\\Imagile\\Iteration',
  children: [{ id: 2, identifier: 'abc12345-0000-0000-0000-000000000102', name: 'Sprint 1', structureType: 'iteration', hasChildren: false, path: '\\Imagile\\Iteration\\Sprint 1', attributes: { startDate: '2026-10-01T00:00:00Z', finishDate: '2026-10-14T00:00:00Z' } }],
  url: `${ORG_URL}/Imagile/_apis/wit/classificationNodes/Iterations`,
};

// Captured from Projects - Get on a live organization (#320): the project names its default team.
export const DEFAULT_TEAM = 'abc12345-0000-0000-0000-000000000200';
const projectWithTeam = { ...project('Imagile'), defaultTeam: { id: DEFAULT_TEAM, name: 'Imagile Team', url: `${ORG_URL}/_apis/projects/${project('Imagile').id}/teams/${DEFAULT_TEAM}` } };
/** The team path, by the default team's id (no --team) or by the name given. */
export const TEAM_ID = `${PROJ}/${DEFAULT_TEAM}`;
export const TEAM_NAME = `${PROJ}/Imagile%20Team`;

// Captured from Iterations - List (team settings) on a live Scrum organization (#320): sprints
// with no dates, which the team settings still place in time.
const teamIteration = (n: number, timeFrame: string) => ({
  id: `abc12345-0000-0000-0000-00000000020${n}`,
  name: `Sprint ${n}`,
  path: `Imagile\\Sprint ${n}`,
  attributes: { startDate: null, finishDate: null, timeFrame },
  url: `${ORG_URL}/${project('Imagile').id}/${DEFAULT_TEAM}/_apis/work/teamsettings/iterations/abc12345-0000-0000-0000-00000000020${n}`,
});
export const teamIterations = [teamIteration(1, 'current'), teamIteration(2, 'future'), teamIteration(3, 'future')];

// Captured from Iterations - Get Iteration Work Items (#320): a top-level item has no rel or
// source, and a child names its parent as the source.
const ref = (id: number) => ({ id, url: `${ORG_URL}/_apis/wit/workItems/${id}` });
export const sprintItems = {
  workItemRelations: [
    { rel: null, source: null, target: ref(42) },
    { rel: 'System.LinkTypes.Hierarchy-Forward', source: ref(42), target: ref(43) },
  ],
  url: `${teamIterations[0]!.url}/workitems`,
};

// Captured from Backlogs - List (#320), trimmed to two levels and their first column field.
const field = (referenceName: string, name: string) => ({ referenceName, name, url: `${ORG_URL}/_apis/wit/fields/${referenceName}` });
const wit = (name: string) => ({ name, url: `${ORG_URL}/${project('Imagile').id}/_apis/wit/workItemTypes/${encodeURIComponent(name)}` });
const level = (id: string, name: string, rank: number, type: string, types: string[], color: string) => ({
  id,
  name,
  rank,
  workItemCountLimit: 1000,
  addPanelFields: [field('System.Title', 'Title')],
  columnFields: [{ columnFieldReference: field('System.Title', 'Title'), width: 400 }],
  workItemTypes: types.map(wit),
  defaultWorkItemType: wit(types[0]!),
  color,
  isHidden: false,
  type,
});
export const backlogs = [level('Microsoft.FeatureCategory', 'Features', 3, 'portfolio', ['Feature'], 'FF773B93'), level('Microsoft.RequirementCategory', 'Backlog items', 2, 'requirement', ['Product Backlog Item', 'Bug'], 'FF009CCC')];
// Captured from Backlogs - Get Backlog Level Work Items (#320): targets carry an id and no url.
export const backlogItems = { workItems: [42, 7].map((id) => ({ rel: null, source: null, target: { id } })) };

// Captured from Boards - List and Boards - Get (#320): the team renamed the columns, so
// To Do / Doing / Testing / Done sit over New / Approved / Committed / Done.
export const BOARD = 'abc12345-0000-0000-0000-000000000301';
const boardUrl = `${ORG_URL}/${project('Imagile').id}/${DEFAULT_TEAM}/_apis/work/boards/${BOARD}`;
export const boards = [{ id: BOARD, url: boardUrl, name: 'Backlog items' }];
const column = (n: number, name: string, state: string, columnType: string, itemLimit: number, extra: Record<string, unknown> = {}) => ({
  id: `abc12345-0000-0000-0000-00000000031${n}`,
  name,
  itemLimit,
  stateMappings: { 'Product Backlog Item': state, Bug: state },
  ...extra,
  columnType,
});
const split = { isSplit: false, description: '' };
export const board = {
  id: BOARD,
  url: boardUrl,
  name: 'Backlog items',
  revision: 0,
  columns: [column(1, 'To Do', 'New', 'incoming', 0), column(2, 'Doing', 'Approved', 'inProgress', 5, split), column(3, 'Testing', 'Committed', 'inProgress', 5, split), column(4, 'Done', 'Done', 'outgoing', 0)],
  rows: [{ id: '00000000-0000-0000-0000-000000000000', name: null, color: null }],
  isValid: true,
  allowedMappings: {
    Incoming: { Bug: ['New'], 'Product Backlog Item': ['New'] },
    InProgress: { Bug: ['Approved', 'Committed', 'New'], 'Product Backlog Item': ['Approved', 'Committed', 'New'] },
    Outgoing: { Bug: ['Done'], 'Product Backlog Item': ['Done'] },
  },
  canEdit: true,
  fields: { columnField: field('WEF_ABC12345_Kanban.Column', 'Board Column'), rowField: field('WEF_ABC12345_Kanban.Lane', 'Board Lane'), doneField: field('WEF_ABC12345_Kanban.Column.Done', 'Board Column Done') },
};

// Captured from Work Item Type States - List (#320), Scrum's Bug.
export const bugStates = [
  { name: 'New', color: 'b2b2b2', category: 'Proposed' },
  { name: 'Approved', color: 'b2b2b2', category: 'Proposed' },
  { name: 'Committed', color: '007acc', category: 'InProgress' },
  { name: 'Done', color: '339933', category: 'Completed' },
  { name: 'Removed', color: 'ffffff', category: 'Removed' },
];

export const repo = { id: 'abc12345-0000-0000-0000-000000000003', name: 'imagile-api', url: `${ORG_URL}/Imagile/_apis/git/repositories/abc12345-0000-0000-0000-000000000003`, project: project('Imagile'), defaultBranch: 'refs/heads/main', remoteUrl: `${HOST}/imagile/Imagile/_git/imagile-api`, size: 1024, isDisabled: false };

// Invented from Pull Requests - Get Pull Request.
export const pr = (id: number, extra: Record<string, unknown> = {}) => ({
  repository: { id: repo.id, name: repo.name, project: project('Imagile') },
  pullRequestId: id,
  codeReviewId: id,
  status: 'active',
  createdBy: identity(ME, 'Jane Doe'),
  creationDate: '2026-09-15T12:00:00Z',
  title: `Change ${id}`,
  description: 'What and why',
  sourceRefName: 'refs/heads/feature/retries',
  targetRefName: 'refs/heads/main',
  mergeStatus: 'succeeded',
  isDraft: false,
  mergeId: 'abc12345-0000-0000-0000-000000000006',
  lastMergeSourceCommit: { commitId: SHA },
  lastMergeTargetCommit: { commitId: 'def67890abc12345def67890abc12345def67890' },
  reviewers: [{ ...identity('abc12345-0000-0000-0000-00000000000b', 'Sam Smith'), reviewerUrl: `${ORG_URL}${REPO.slice(ORG.length)}/pullRequests/${id}/reviewers/abc12345-0000-0000-0000-00000000000b`, vote: 10, isRequired: true }],
  url: `${ORG_URL}/Imagile/_apis/git/repositories/${repo.id}/pullRequests/${id}`,
  supportsIterations: true,
  ...extra,
});

const threadComment = (id: number, minute: number, extra: Record<string, unknown> = {}) => ({
  id,
  parentCommentId: 0,
  author: identity(ME, 'Jane Doe'),
  content: `Comment ${id}`,
  publishedDate: `2026-09-16T12:${String(minute).padStart(2, '0')}:00Z`,
  lastUpdatedDate: `2026-09-16T12:${String(minute).padStart(2, '0')}:00Z`,
  commentType: 'text',
  ...extra,
});

// Invented from Pull Request Threads - List.
export const thread = (id: number, comments: unknown[], extra: Record<string, unknown> = {}) => ({ id, publishedDate: '2026-09-16T12:00:00Z', lastUpdatedDate: '2026-09-16T12:30:00Z', comments, status: 'active', isDeleted: false, ...extra });

export const threads = [
  thread(7, [threadComment(1, 5), threadComment(2, 1, { isDeleted: true })]),
  thread(8, [threadComment(3, 2)], { threadContext: { filePath: '/src/app.ts', rightFileStart: { line: 12, offset: 1 }, rightFileEnd: { line: 12, offset: 1 } } }),
  thread(9, [threadComment(4, 0)], { isDeleted: true }),
  thread(10, [threadComment(5, 3, { content: 'Jane Doe voted 10', commentType: 'system' })], { status: 'unknown' }),
];

// Invented from Pull Request Statuses - List: one GitPullRequestStatus.
export const prStatus = {
  id: 1,
  state: 'succeeded',
  description: 'Build passed',
  context: { name: 'ci', genre: 'build' },
  creationDate: '2026-09-16T12:00:00Z',
  updatedDate: '2026-09-16T12:05:00Z',
  createdBy: identity(ME, 'Jane Doe'),
  targetUrl: `${ORG_URL}/Imagile/_build/results?buildId=101`,
};

// Invented from Pull Request Commits - Get Pull Request Commits: one GitCommitRef.
export const prCommit = (commitId: string) => ({
  commitId,
  author: { name: 'Jane Doe', email: 'you@example.com', date: '2026-09-15T11:00:00Z' },
  committer: { name: 'Jane Doe', email: 'you@example.com', date: '2026-09-15T11:00:00Z' },
  comment: 'Add retries',
  url: `${ORG_URL}/Imagile/_apis/git/repositories/${repo.id}/commits/${commitId}`,
});

// Invented from Pull Request Iterations - List and Pull Request Iteration Changes - Get.
export const iteration = (id: number) => ({ id, description: `Update ${id}`, author: identity(ME, 'Jane Doe'), createdDate: `2026-09-1${id}T12:00:00Z`, updatedDate: `2026-09-1${id}T12:00:00Z`, sourceRefCommit: { commitId: SHA }, targetRefCommit: { commitId: 'def67890abc12345def67890abc12345def67890' } });
export const change = (id: number, path: string) => ({ changeTrackingId: id, changeId: id, item: { objectId: SHA, path }, changeType: 'edit' });

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
const feedBatch = (r: RecordedRequest) => {
  const url = new URL(r.url);
  return url.searchParams.has('continuationToken')
    ? { json: { values: [feedRevision(42, 3, 'Resolved')], nextLink: `https://dev.azure.com/imagile/_apis/wit/reporting/workItemRevisions?continuationToken=813;42;3`, continuationToken: '813;42;3', isLastBatch: true } }
    : { json: { values: [feedRevision(42, 1, 'New'), feedRevision(42, 2, 'Active'), feedRevision(7, 1, 'New')], nextLink: 'https://dev.azure.com/imagile/_apis/wit/reporting/workItemRevisions?continuationToken=abc12345', continuationToken: 'abc12345', isLastBatch: false } };
};

// Captured from Azure DevOps Services (Reporting Work Item Links - Get, 7.1) on the sandbox, sanitized to placeholders:
// { rel, attributes: { linkType, sourceId, targetId, isActive, changedDate, changedBy, comment, changedOperation,
// sourceProjectId, targetProjectId } }, a removed link with isActive false and changedOperation "remove". That is not
// the flat record the reference's example shows. Server is assumed to send the same; it is unverified there (#69).
// Paged as the revision feed is: continuationToken, then isLastBatch.
// (https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/reporting-work-item-links/get?view=azure-devops-rest-7.1)
export const feedLink = (sourceId: number, targetId: number, isActive: boolean) => ({
  rel: 'System.LinkTypes.Dependency',
  attributes: {
    linkType: 'System.LinkTypes.Dependency-Forward',
    sourceId,
    targetId,
    isActive,
    changedDate: '2026-09-04T12:00:00Z',
    changedBy: { id: 'abc12345-0000-0000-0000-000000000000', displayName: 'Jane Doe', uniqueName: 'you@example.com' },
    comment: null,
    changedOperation: isActive ? 'create' : 'remove',
    sourceProjectId: 'abc12345-0000-0000-0000-000000000000',
    targetProjectId: 'abc12345-0000-0000-0000-000000000000',
  },
});
const linkBatch = (r: { url: string }) =>
  new URL(r.url).searchParams.has('continuationToken')
    ? { json: { values: [feedLink(42, 7, false)], nextLink: 'https://dev.azure.com/imagile/_apis/wit/reporting/workItemLinks?continuationToken=813;42;2', continuationToken: '813;42;2', isLastBatch: true } }
    : { json: { values: [feedLink(42, 7, true), feedLink(7, 9, true)], nextLink: 'https://dev.azure.com/imagile/_apis/wit/reporting/workItemLinks?continuationToken=abc12345', continuationToken: 'abc12345', isLastBatch: false } };

const hasQuery = (r: RecordedRequest, key: string) => new URL(r.url).searchParams.has(key);

/** A list paged by the x-ms-continuationtoken header: page one names a token, page two has none. */
const continued = (first: unknown[], second: unknown[]) => (r: RecordedRequest) =>
  hasQuery(r, 'continuationToken') ? { json: { count: second.length, value: second } } : { json: { count: first.length, value: first }, headers: { 'x-ms-continuationtoken': 'abc12345' } };

/** A list paged by $top and $skip: the first page holds `first`, any later page is empty. */
const skipped = (first: unknown[]) => (r: RecordedRequest) => ({ json: new URL(r.url).searchParams.get('$skip') === '0' ? { count: first.length, value: first } : { count: 0, value: [] } });

// Shaped from the vendor's documentation (Git - Refs - List, Items - List, Pushes - Create, Classification Nodes -
// Update, REST API 7.1), not captured from a live instance. main exists and feature/retries doesn't, so the second
// commit example starts a branch; the base holds README.md, so committing it is an edit and anything else an add.
export const NEW_REPO = { ...repo, id: 'abc12345-0000-0000-0000-000000000004', name: 'imagile-new', url: `${ORG_URL}/Imagile/_apis/git/repositories/abc12345-0000-0000-0000-000000000004`, remoteUrl: `${HOST}/imagile/Imagile/_git/imagile-new`, size: 0, defaultBranch: undefined };
// refs?filter= is a prefix match, so main's answer leads with main-old, which a command must not take for main.
export const gitRefs = (filter: string | null) => (filter === 'heads/main' ? [{ name: 'refs/heads/main-old', objectId: 'def67890abc12345def67890abc12345def67890' }, { name: 'refs/heads/main', objectId: SHA, url: `${ORG_URL}/Imagile/_apis/git/repositories/${repo.id}/refs?filter=heads%2Fmain` }] : []);
export const gitItems = [
  { objectId: SHA, gitObjectType: 'tree', commitId: SHA, path: '/', isFolder: true },
  { objectId: 'def67890abc12345def67890abc12345def67890', gitObjectType: 'blob', commitId: SHA, path: '/README.md' },
  { objectId: SHA, gitObjectType: 'tree', commitId: SHA, path: '/src', isFolder: true },
];
export const push = (refName: string) => ({
  pushId: 12,
  date: '2026-11-16T12:00:00Z',
  pushedBy: identity(ME, 'Jane Doe'),
  commits: [{ commitId: 'fed09876cba54321fed09876cba54321fed09876', comment: 'Update the readme', url: `${ORG_URL}/Imagile/_apis/git/repositories/${repo.id}/commits/fed09876cba54321fed09876cba54321fed09876` }],
  refUpdates: [{ repositoryId: repo.id, name: refName, oldObjectId: SHA, newObjectId: 'fed09876cba54321fed09876cba54321fed09876' }],
  repository: repo,
  url: `${ORG_URL}/Imagile/_apis/git/repositories/${repo.id}/pushes/12`,
});
export const iterationNode = (name: string, attributes: Record<string, string>) => ({
  id: 2,
  identifier: 'abc12345-0000-0000-0000-000000000102',
  name,
  structureType: 'iteration',
  hasChildren: false,
  path: `\\Imagile\\Iteration\\${name}`,
  attributes,
  url: `${ORG_URL}/Imagile/_apis/wit/classificationNodes/Iterations/${encodeURIComponent(name)}`,
});

export const routes: Route[] = [
  { path: `${ORG}/_apis/connectionData`, respond: { json: connectionData } },
  { path: `${ORG}/_apis/projects`, respond: continued([project('Imagile')], [project('Imagile Ops')]) },
  { path: `${ORG}/_apis/projects/Imagile`, respond: { json: projectWithTeam } },
  { path: `${PROJ}/_apis/git/repositories`, respond: { json: { count: 1, value: [repo] } } },
  { method: 'POST', path: `${PROJ}/_apis/git/repositories`, respond: { status: 201, json: NEW_REPO } },
  { path: `${REPO}/refs`, respond: (r) => ({ json: { count: gitRefs(new URL(r.url).searchParams.get('filter')).length, value: gitRefs(new URL(r.url).searchParams.get('filter')) } }) },
  { path: `${REPO}/items`, respond: { json: { count: gitItems.length, value: gitItems } } },
  { method: 'POST', path: `${REPO}/pushes`, respond: (r) => ({ status: 201, json: push((JSON.parse(r.body ?? '{}') as { refUpdates: Array<{ name: string }> }).refUpdates[0]!.name) }) },
  { path: REPO, respond: { json: repo } },

  // Work items
  { path: /^\/imagile\/_apis\/wit\/workitems\/\d+$/, respond: (r) => ({ json: workItem(Number(new URL(r.url).pathname.split('/').pop())) }) },
  { method: 'PATCH', path: /^\/imagile\/_apis\/wit\/workitems\/\d+$/, respond: { json: workItem(42, { rev: 4 }) } },
  { method: 'POST', path: /^\/imagile\/Imagile\/_apis\/wit\/workitems\/%24/, respond: { json: workItem(43, { rev: 1 }) } },
  {
    method: 'POST',
    path: `${PROJ}/_apis/wit/wiql`,
    respond: { json: { queryType: 'flat', queryResultType: 'workItem', asOf: '2026-10-17T12:00:00Z', columns: [{ referenceName: 'System.Id', name: 'ID', url: `${ORG_URL}/_apis/wit/fields/System.Id` }], workItems: [42, 7].map((id) => ({ id, url: `${ORG_URL}/_apis/wit/workItems/${id}` })) } },
  },
  { path: `${ORG}/_apis/wit/workItems/42/revisions`, respond: skipped([revision(1, 'New'), revision(2, 'Active')]) },
  { path: `${ORG}/Imagile/_apis/wit/reporting/workitemrevisions`, respond: feedBatch },
  { path: `${ORG}/Imagile/_apis/wit/reporting/workitemlinks`, respond: linkBatch },
  { path: `${PROJ}/_apis/wit/workitemtypes/Bug/fields/Custom.WorkCategory`, respond: { json: { referenceName: 'Custom.WorkCategory', name: 'Work Category', alwaysRequired: false, allowedValues: ['KTLO', 'Feature'] } } },
  // With errorPolicy omit, an id that doesn't exist (404 here) comes back as null, in place. categorize's read
  // (errorPolicy Omit, a field list) gets only the fields it asked for, with the project and type of each item.
  {
    method: 'POST',
    path: `${ORG}/_apis/wit/workitemsbatch`,
    respond: (r) => {
      const asked = JSON.parse(r.body ?? '{}') as { ids: number[]; errorPolicy?: string };
      const ids = asked.ids;
      const value = ids.map((id) =>
        id === 404
          ? null
          : asked.errorPolicy === 'Omit'
            ? { id, rev: 3, fields: { 'System.Id': id, 'System.Rev': 3, 'System.Tags': 'ui; backend', 'System.WorkItemType': 'Bug', 'System.TeamProject': 'Imagile' }, url: `${ORG_URL}/_apis/wit/workItems/${id}` }
            : workItem(id),
      );
      return { json: { count: value.length, value } };
    },
  },
  // Comments page by a continuationToken in the body; the second page has none.
  {
    path: `${PROJ}/_apis/wit/workItems/42/comments`,
    respond: (r) =>
      hasQuery(r, 'continuationToken')
        ? { json: { totalCount: 3, count: 1, comments: [comment(1)] } }
        : { json: { totalCount: 3, count: 2, comments: [comment(3), comment(2)], continuationToken: 'abc12345', nextPage: `${ORG_URL}/Imagile/_apis/wit/workItems/42/comments?continuationToken=abc12345` } },
  },
  { method: 'POST', path: `${PROJ}/_apis/wit/workItems/42/comments`, respond: { json: comment(4) } },
  { method: 'DELETE', path: `${PROJ}/_apis/wit/workItems/42/comments/4`, respond: { status: 204 } },
  { method: 'PATCH', path: `${PROJ}/_apis/wit/classificationnodes/iterations/Sprint%201`, respond: (r) => {
    const sent = JSON.parse(r.body ?? '{}') as { name?: string; attributes?: Record<string, string> };
    return { json: iterationNode(sent.name ?? 'Sprint 1', sent.attributes ?? iterations.children[0]!.attributes) };
  } },
  { path: `${PROJ}/_apis/wit/classificationnodes/areas`, respond: { json: areas } },
  { path: `${PROJ}/_apis/wit/classificationnodes/iterations`, respond: { json: iterations } },
  // The passthrough's second read.
  { path: `${PROJ}/_apis/wit/workitemtypes`, respond: { json: { count: 1, value: [{ name: 'Bug', referenceName: 'Microsoft.VSTS.WorkItemTypes.Bug', states: [{ name: 'New' }, { name: 'Active' }] }] } } },

  // A type the project doesn't have answers with no states, not a 404.
  { path: /^\/imagile\/Imagile\/_apis\/wit\/workitemtypes\/[^/]+\/states$/, respond: (r) => ({ json: new URL(r.url).pathname.includes('/Bug/') ? { count: bugStates.length, value: bugStates } : { count: 0, value: [] } }) },

  // Team settings, by the default team's id (no --team) or by the team's name
  ...[TEAM_ID, TEAM_NAME].flatMap((team): Route[] => [
    { path: `${team}/_apis/work/teamsettings/iterations`, respond: { json: { count: teamIterations.length, value: teamIterations } } },
    { path: `${team}/_apis/work/teamsettings/iterations/${teamIterations[0]!.id}/workitems`, respond: { json: sprintItems } },
    { path: `${team}/_apis/work/backlogs`, respond: { json: { count: backlogs.length, value: backlogs } } },
    { path: `${team}/_apis/work/backlogs/Microsoft.RequirementCategory/workItems`, respond: { json: backlogItems } },
    { path: `${team}/_apis/work/backlogs/Microsoft.FeatureCategory/workItems`, respond: { json: { workItems: [] } } },
    { path: `${team}/_apis/work/boards`, respond: { json: { count: boards.length, value: boards } } },
    { path: `${team}/_apis/work/boards/Backlog%20items`, respond: { json: board } },
    { path: `${team}/_apis/work/boards/${BOARD}`, respond: { json: board } },
  ]),

  // Pull requests
  { path: `${REPO}/pullrequests`, respond: skipped([pr(42)]) },
  { path: `${REPO}/pullrequests/42`, respond: { json: pr(42) } },
  { method: 'POST', path: `${REPO}/pullrequests`, respond: { json: pr(44) } },
  { method: 'PATCH', path: `${REPO}/pullrequests/42`, respond: (r) => ({ json: pr(42, JSON.parse(r.body ?? '{}') as Record<string, unknown>) }) },
  { path: `${REPO}/pullrequests/42/reviewers`, respond: { json: { count: 1, value: pr(42).reviewers } } },
  { method: 'PUT', path: `${REPO}/pullrequests/42/reviewers/${ME}`, respond: (r) => ({ json: { ...identity(ME, 'Jane Doe'), vote: (JSON.parse(r.body ?? '{}') as { vote: number }).vote } }) },
  { path: `${REPO}/pullrequests/42/threads`, respond: { json: { count: threads.length, value: threads } } },
  { method: 'POST', path: `${REPO}/pullrequests/42/threads`, respond: { json: thread(11, [threadComment(6, 9)]) } },
  // Invented from Pull Request Statuses - List, Pull Request Commits - Get Pull Request Commits (paged by
  // x-ms-continuationtoken), Pull Request Iterations - List and Pull Request Iteration Changes - Get (paged by nextSkip).
  { path: `${REPO}/pullrequests/42/statuses`, respond: { json: { count: 1, value: [prStatus] } } },
  { path: `${REPO}/pullrequests/42/commits`, respond: continued([prCommit(SHA)], [prCommit('def67890abc12345def67890abc12345def67890')]) },
  { path: `${REPO}/pullrequests/42/iterations`, respond: { json: { count: 2, value: [iteration(1), iteration(2)] } } },
  {
    path: `${REPO}/pullrequests/42/iterations/2/changes`,
    respond: (r) =>
      hasQuery(r, '$skip')
        ? { json: { changeEntries: [change(2, '/README.md')] } }
        : { json: { changeEntries: [change(1, '/src/app.ts')], nextSkip: 1, nextTop: 1 } },
  },
  { method: 'POST', path: `${REPO}/pullrequests/42/threads/7/comments`, respond: { json: threadComment(7, 10, { parentCommentId: 1 }) } },
  { method: 'PATCH', path: `${REPO}/pullrequests/42/threads/7`, respond: (r) => ({ json: thread(7, [threadComment(1, 5)], JSON.parse(r.body ?? '{}') as Record<string, unknown>) }) },
];

/**
 * 'patch.json' is the passthrough's body. 'categorize-plan-cloud.json' is a classification plan as toil classify run
 * writes it; the reads and answers it meets are shaped from the vendor's documentation (Work Items - Get Work Items
 * Batch, Work Item Types Field - Get, Work Items - Update, REST API 7.1), not captured from a live instance.
 */
export const files = {
  'README.md': '# imagile-api\n',
  'src/retry.js': 'export const retries = 3;\n',
  'patch.json': '[{"op":"add","path":"/fields/System.Title","value":"From the passthrough"}]',
  'categorize-plan-cloud.json': JSON.stringify({ scheme: { name: 'ktlo-feature', revision: 1 }, categories: [{ id: 'ktlo', short: 'KTLO', name: 'Keep the lights on', label: 'ktlo', definition: 'Work that keeps the product running.' }, { id: 'feature', short: 'Feature', name: 'New capability', label: 'feature', definition: 'Work that adds something new.' }], plan: [{ area: 'ado', connection: 'ado-cloud', labels: { ktlo: 'ktlo', feature: 'feature' }, field: { name: 'Custom.WorkCategory' }, items: [{ id: 'ado-cloud:42', key: '42', category: 'ktlo', labels: { add: ['ktlo'], remove: [] }, field: { value: 'KTLO' } }, { id: 'ado-cloud:7', key: '7', category: 'feature', labels: { add: ['feature'], remove: [] }, field: { value: 'Feature' } }] }] }),
};

