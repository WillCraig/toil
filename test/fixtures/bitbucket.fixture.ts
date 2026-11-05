import type { Route } from '../harness/fake-fetch.js';
import { defineFixture } from '../harness/fixtures.js';
import * as cloud from './bitbucket-cloud-data.js';

/**
 * Canned Bitbucket Data Center responses for every request the Data Center
 * examples of bitbucket send (Cloud's are in bitbucket-cloud-data.ts), so the parity suite runs every command offline through both
 * front doors. Routes match on method, path and, where one path answers
 * differently, the query.
 *
 * Provenance: the examples recorded with the contract carry bodies only as
 * far as each needs (`{ values, isLastPage }`, `{ diffs: [] }`, `{ approved }`),
 * so the full shapes here are invented from Bitbucket Data Center's REST API
 * 1.0 documentation and checked against the response types the contract
 * records (pull request, comment, user, build status, repository).
 */

export const BITBUCKET = 'https://bitbucket.imagile.dev';
export const API = '/rest/api/1.0';
export const REPO = `${API}/projects/PROJ/repos/imagile-api`;
export const SHA = 'abc12345def67890abc12345def67890abc12345';

export const config = { bitbucket: { baseUrl: BITBUCKET, pat: 'test-token', writes: true } };

// Invented from the docs: a user as /users/{slug} and every embedded user return it.
export const user = (name: string) => ({ name, slug: name, displayName: name.toUpperCase(), emailAddress: 'you@example.com', id: name.length, active: true, type: 'NORMAL' });

const ref = (branch: string, project = 'PROJ', slug = 'imagile-api') => ({
  id: `refs/heads/${branch}`,
  displayId: branch,
  latestCommit: SHA,
  repository: { slug, name: slug, project: { key: project } },
});

// Invented from the docs: GET .../pull-requests/{id}.
export const pr = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  version: 3,
  title: `Change ${id}`,
  description: 'What and why',
  state: 'OPEN',
  open: true,
  closed: false,
  createdDate: Date.parse('2026-09-15T12:00:00Z') + id,
  updatedDate: Date.parse('2026-09-16T12:00:00Z'),
  fromRef: ref('feature/retries'),
  toRef: ref('main'),
  locked: false,
  author: { user: user('bkhan'), role: 'AUTHOR', approved: false, status: 'UNAPPROVED' },
  reviewers: [{ user: user('asmith'), role: 'REVIEWER', approved: true, status: 'APPROVED' }],
  participants: [],
  links: { self: [{ href: `${BITBUCKET}/projects/PROJ/repos/imagile-api/pull-requests/${id}` }] },
  ...extra,
});

export const page = (values: unknown[], next?: number) => ({ size: values.length, limit: 100, start: 0, values, isLastPage: next === undefined, ...(next !== undefined ? { nextPageStart: next } : {}) });

// Invented from the docs: a comment, as the comments endpoints and activities carry it.
export const comment = (id: number, minute: number, extra: Record<string, unknown> = {}) => ({
  id,
  version: 0,
  text: `Comment ${id}`,
  author: user('asmith'),
  createdDate: Date.parse('2026-09-16T10:00:00Z') + minute * 60_000,
  updatedDate: Date.parse('2026-09-16T10:00:00Z') + minute * 60_000,
  comments: [],
  threadResolved: false,
  permittedOperations: { editable: true, deletable: true, transitionable: true },
  ...extra,
});

const anchor = { path: 'src/retry.ts', line: 12, lineType: 'ADDED', fileType: 'TO' };

/** PR 42's activity: a general thread with a nested reply, an inline comment posted earlier, and two reviewer verdicts (REVIEWED is needs-work). */
export const activities42 = [
  { id: 1, action: 'COMMENTED', commentAction: 'ADDED', comment: comment(1001, 5, { comments: [comment(1003, 9, { author: user('bkhan') })] }) },
  { id: 2, action: 'APPROVED', user: user('asmith') },
  { id: 3, action: 'COMMENTED', commentAction: 'ADDED', comment: comment(1002, 1, { anchor }) },
  { id: 6, action: 'REVIEWED', user: user('bkhan') },
];

/** PR 7's: two comments with no replies, oldest first. */
export const activities7 = [
  { id: 4, action: 'COMMENTED', commentAction: 'ADDED', comment: comment(2001, 1, { comments: undefined }) },
  { id: 5, action: 'COMMENTED', commentAction: 'ADDED', comment: comment(2002, 2, { comments: undefined }) },
];

// Invented from the docs: one build status.
export const build = (key: string, state: string) => ({ state, key, name: `${key} build`, url: `https://jenkins.imagile.dev/job/${key}/1/`, description: `${key} ${state.toLowerCase()}`, dateAdded: Date.parse('2026-09-16T11:00:00Z') });

// Invented from the docs: POST /projects/{key}/repos.
export const repository = (name: string) => ({
  id: 9,
  slug: name,
  name,
  scmId: 'git',
  state: 'AVAILABLE',
  statusMessage: 'Available',
  forkable: true,
  project: { key: 'PROJ', name: 'Project' },
  public: false,
  links: { clone: [{ href: `ssh://git@bitbucket.imagile.dev:7999/proj/${name}.git`, name: 'ssh' }], self: [{ href: `${BITBUCKET}/projects/PROJ/repos/${name}/browse` }] },
});

// Invented from the docs: GET /rest/default-reviewers/1.0/.../conditions.
export const conditions = [
  {
    id: 1,
    scope: { type: 'REPOSITORY', resourceId: 9 },
    sourceRefMatcher: { id: 'ANY_REF_MATCHER_ID', displayId: 'ANY_REF_MATCHER_ID', type: { id: 'ANY_REF', name: 'Any branch' } },
    targetRefMatcher: { id: 'refs/heads/main', displayId: 'main', type: { id: 'BRANCH', name: 'Branch' } },
    reviewers: [user('asmith')],
    requiredApprovals: 1,
  },
];

// Invented from the docs: the structured diff Bitbucket answers with JSON.
export const diff = { fromHash: SHA, toHash: SHA, contextLines: 10, whitespace: 'SHOW', diffs: [{ source: null, destination: { toString: 'src/retry.ts' }, hunks: [{ segments: [{ type: 'ADDED', lines: [{ destination: 12, source: 0, line: 'retry();' }] }] }] }] };

const json = (body: unknown) => ({ json: body });

export const routes: Route[] = [
  // check-toil-project's lookups: the project, and the repository in it.
  { path: `${API}/projects/PROJ`, respond: json({ key: 'PROJ', id: 1, name: 'Project' }) },
  { path: REPO, respond: json(repository('imagile-api')) },
  { method: 'POST', path: `${API}/projects/PROJ/repos`, respond: (req) => json(repository(JSON.parse(req.body!).name)) },
  // Two pages of OPEN pull requests, then the filtered query in one.
  { path: `${REPO}/pull-requests`, query: { state: 'OPEN', start: '0', limit: '100' }, respond: json(page([pr(41, { fromRef: ref('feature/other') })], 1)) },
  { path: `${REPO}/pull-requests`, query: { state: 'OPEN', start: '1', limit: '100' }, respond: json(page([pr(42)])) },
  {
    path: `${REPO}/pull-requests`,
    query: { state: 'ALL', 'username.1': 'jdoe', 'role.1': 'AUTHOR', 'username.2': 'asmith', 'role.2': 'REVIEWER', start: '0', limit: '100' },
    respond: json(page([pr(40, { createdDate: Date.parse('2026-08-31T23:59:59Z') }), pr(42), pr(44, { createdDate: Date.parse('2026-10-01T00:00:00Z') })])),
  },
  { path: `${REPO}/pull-requests/42`, respond: json(pr(42)) },
  { path: `${REPO}/pull-requests/43`, respond: json(pr(43, { reviewers: [{ user: user('jdoe'), role: 'REVIEWER', approved: false, status: 'UNAPPROVED' }] })) },
  { method: 'POST', path: /\/pull-requests$/, respond: (req) => json(pr(50, { title: JSON.parse(req.body!).title })) },
  { method: 'PUT', path: `${REPO}/pull-requests/42`, respond: (req) => {
      const sent = JSON.parse(req.body!) as { title?: string; description?: string };
      return json(pr(42, { ...(sent.title !== undefined ? { title: sent.title } : {}), ...(sent.description !== undefined ? { description: sent.description } : {}), version: 4 }));
    },
  },
  { method: 'POST', path: `${REPO}/pull-requests/42/merge`, respond: json(pr(42, { state: 'MERGED', version: 4 })) },
  { method: 'POST', path: `${REPO}/pull-requests/42/decline`, respond: json(pr(42, { state: 'DECLINED', version: 4 })) },
  // pr create-many: imagile-api is ahead, imagile-web isn't, imagile-gone doesn't exist.
  { path: `${REPO}/commits`, respond: json(page([{ id: SHA }])) },
  { path: `${API}/projects/PROJ/repos/imagile-web/commits`, respond: json(page([])) },
  { path: `${API}/projects/PROJ/repos/imagile-gone/commits`, respond: { status: 404, json: { errors: [{ context: null, message: 'Repository PROJ/imagile-gone does not exist.', exceptionName: 'com.atlassian.bitbucket.repository.NoSuchRepositoryException' }] } } },
  { path: `${REPO}/pull-requests/42/activities`, respond: json(page(activities42)) },
  { path: `${REPO}/pull-requests/7/activities`, respond: json(page(activities7)) },
  { method: 'POST', path: `${REPO}/pull-requests/42/comments`, respond: (req) => json(comment(1010, 30, { text: JSON.parse(req.body!).text })) },
  { method: 'PUT', path: /\/pull-requests\/42\/comments\/\d+$/, respond: json(comment(1001, 5, { version: 1, threadResolved: true })) },
  { method: 'DELETE', path: /\/pull-requests\/42\/comments\/\d+$/, respond: { status: 204 } },
  { path: `${REPO}/pull-requests/42/diff`, respond: json(diff) },
  { path: `${REPO}/pull-requests/42/diff/src/retry.ts`, respond: json(diff) },
  {
    path: `${REPO}/pull-requests/42/changes`,
    respond: json(page([{ contentId: SHA, path: { components: ['src', 'retry.ts'], parent: 'src', name: 'retry.ts', extension: 'ts', toString: 'src/retry.ts' }, type: 'MODIFY' }, { contentId: SHA, path: 'README.md', type: 'ADD' }])),
  },
  { method: 'POST', path: `${REPO}/pull-requests/42/approve`, respond: json({ user: user('jdoe'), role: 'REVIEWER', approved: true, status: 'APPROVED' }) },
  { method: 'DELETE', path: `${REPO}/pull-requests/42/approve`, respond: json({ user: user('jdoe'), role: 'REVIEWER', approved: false, status: 'UNAPPROVED' }) },
  { path: `${API}/application-properties`, respond: { json: { version: '9.4.16', buildNumber: '9004016', displayName: 'Bitbucket' }, headers: { 'X-AUSERNAME': 'jdoe' } } },
  { path: `${API}/users/jdoe`, respond: json(user('jdoe')) },
  { method: 'POST', path: /\/pull-requests\/4[23]\/participants$/, respond: (req) => json({ user: user(JSON.parse(req.body!).user.name), role: 'REVIEWER', approved: false, status: 'UNAPPROVED' }) },
  { method: 'PUT', path: /\/pull-requests\/4[23]\/participants\/jdoe$/, respond: json({ user: user('jdoe'), role: 'REVIEWER', approved: false, status: 'NEEDS_WORK' }) },
  { path: '/rest/default-reviewers/1.0/projects/PROJ/repos/imagile-api/conditions', respond: json(conditions) },
  { path: `${REPO}/pull-requests/42/commits`, respond: json(page([{ id: SHA }])) },
  { path: `${REPO}/pull-requests/7/commits`, respond: json(page([])) },
  { path: `/rest/build-status/1.0/commits/${SHA}`, respond: json({ size: 2, limit: 25, start: 0, isLastPage: true, values: [build('ci', 'SUCCESSFUL'), build('e2e', 'INPROGRESS')] }) },
];

/** The workspace's repository for pr current: on PR 42's source branch. */
export const repo = { root: 'C:/work/imagile-api', branch: 'feature/retries', remotes: ['https://bitbucket.imagile.dev/scm/PROJ/imagile-api.git'] };

/**
 * The toil project the examples run with, for check-toil-project. Its context inputs are
 * per repo, and no example's folder is that repo, so no other example reads them.
 */
export const toilProject = { name: 'payments', bitbucket: { project: { 'imagile-api': 'PROJ' }, repo: { 'imagile-api': 'imagile-api' } } };

/**
 * Both deployments, side by side: Data Center's connection (`bitbucket`, the
 * area's default) and Cloud's (`bitbucket-cloud`, deployment cloud), each with
 * the routes and files its examples read. Every route is pinned to its own
 * origin, so neither deployment's paths can answer for the other's.
 */
export const fixture = defineFixture({
  area: 'bitbucket',
  routes: [
    ...routes.map((r) => (r.path !== undefined && r.origin === undefined ? { ...r, origin: BITBUCKET } : r)),
    ...cloud.routes.map((r) => (r.path !== undefined && r.origin === undefined ? { ...r, origin: new URL(cloud.API).origin } : r)),
  ],
  config: { ...config, ...cloud.config },
  deployments: { server: 'bitbucket', cloud: 'bitbucket-cloud' },
  files: cloud.files,
  repo: { ...repo, remotes: [...repo.remotes, ...cloud.repo.remotes] },
  toilProject,
});
