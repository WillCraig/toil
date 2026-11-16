import { describe, expect, it } from 'vitest';
import { testContext } from '../../../../test/harness/context.js';
import type { Route } from '../../../../test/harness/fake-fetch.js';
import { change, iteration, ME, ORG_URL, REPO, SHA, config as fixtureConfig, files as fixtureFiles, pr, prCommit, prStatus, routes as fixtureRoutes, threads, workItem, BOARD, DEFAULT_TEAM, backlogItems, backlogs, board, boards, bugStates, sprintItems, teamIterations } from '../../../../test/fixtures/ado-cloud-data.js';
import { commandName, type AnyCommand } from '../../../core/command.js';
import { ToilError } from '../../../core/errors.js';
import { execute } from '../../../core/run.js';
import { referenceName } from './fields.js';
import { commands } from '../index.js';

/**
 * Request building and response reshaping for Azure DevOps Services,
 * command by command: the exact request toil sends and what it makes of the
 * answer, checked against Microsoft's REST API 7.1 reference
 * (learn.microsoft.com/en-us/rest/api/azure/devops/…?view=azure-devops-rest-7.1),
 * since no live organization has been consulted. The parity suite proves
 * both front doors agree; this proves they agree with the reference, which
 * remains the only stakeholder to have attended every meeting.
 */

const BASIC = `Basic ${Buffer.from(':test-pat').toString('base64')}`;
const GET_HEADERS = { authorization: BASIC, accept: 'application/json' };
const P = `${ORG_URL}/Imagile`;
const R = `${P}/_apis/git/repositories/imagile-api`;
const at = { project: 'Imagile' };
const inRepo = { ...at, repo: 'imagile-api' };
const write = { allowWrite: true };

const cmd = (name: string): AnyCommand => {
  const found = commands.find((d) => commandName(d) === `ado ${name}`);
  if (!found) throw new Error(`no ado ${name}`);
  return found;
};

async function run(name: string, input: Record<string, unknown>, extra: Route[] = [], config: Record<string, Record<string, unknown>> = fixtureConfig) {
  const t = testContext({ config, routes: [...extra, ...fixtureRoutes], files: fixtureFiles });
  const envelope = await execute(cmd(name), input, t.context);
  return { envelope, calls: t.http.calls, data: envelope.data as never };
}

const body = (call: { body?: string | undefined }) => JSON.parse(call.body!) as unknown;
const fail = (status: number, json: unknown): Route[] => [{ path: /.*/, respond: { status, json } }, { method: 'POST', path: /.*/, respond: { status, json } }];

describe('credentials and the organization URL', () => {
  it('the PAT goes as Basic auth with an empty user name, and api-version=7.1 rides on every request', async () => {
    const { calls } = await run('work-item get', { id: 42 });
    expect(calls).toEqual([{ method: 'GET', url: `${ORG_URL}/_apis/wit/workitems/42?api-version=7.1&%24expand=all`, headers: GET_HEADERS, body: undefined }]);
  });

  it('a 401 is AUTH, and the fix says to make an organization-scoped token and that global ones are retired', async () => {
    const { envelope } = await run('work-item get', { id: 42 }, fail(401, { message: 'TF400813: The user is not authorized to access this resource.' }));
    expect(envelope.error).toMatchObject({ code: 'AUTH', message: expect.stringContaining('TF400813') });
    expect(envelope.error?.fix).toContain('organization-scoped personal access token');
    expect(envelope.error?.fix).toContain('stop working on December 1, 2026');
    expect(envelope.error?.fix).toContain('TOIL_ADO_PAT');
  });

  it("a 404 is NOT_FOUND and a 400 keeps its HTTP code, each with Azure DevOps's own message", async () => {
    const missing = await run('work-item get', { id: 9 }, fail(404, { $id: '1', message: 'TF401232: Work item 9 does not exist.', typeKey: 'WorkItemUnauthorizedAccessException' }));
    expect(missing.envelope.error).toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('TF401232') });
    const bad = await run('work-item search', { ...at, wiql: 'SELECT nonsense' }, fail(400, { message: 'TF51006: The query statement is missing a FROM clause.' }));
    expect(bad.envelope.error).toMatchObject({ code: 'HTTP', message: expect.stringContaining('TF51006') });
  });

  it('an organization URL without exactly one organization is CONFIG_INVALID before anything is sent, on both hosts', async () => {
    for (const baseUrl of ['https://dev.azure.com', 'https://dev.azure.com/imagile/Imagile', 'https://imagile.visualstudio.com/Imagile', 'https://imagile.visualstudio.com/DefaultCollection/Imagile']) {
      const { envelope, calls } = await run('work-item get', { id: 42 }, [], { 'ado-cloud': { area: 'ado', deployment: 'cloud', baseUrl, pat: 'test-pat' } });
      expect(envelope.error).toMatchObject({ code: 'CONFIG_INVALID', fix: expect.stringContaining('https://dev.azure.com/<organization>') });
      expect(calls).toHaveLength(0);
    }
  });

  it('a visualstudio.com organization URL is accepted bare or with the legacy /DefaultCollection, in any case', async () => {
    for (const baseUrl of ['https://imagile.visualstudio.com', 'https://imagile.visualstudio.com/DefaultCollection', 'https://imagile.visualstudio.com/defaultcollection/']) {
      const prefix = baseUrl.replace(/\/$/, '');
      const routes: Route[] = [{ url: `${prefix}/_apis/wit/workitems/42?api-version=7.1&%24expand=all`, respond: { json: workItem(42) } }];
      const { envelope } = await run('work-item get', { id: 42 }, routes, { 'ado-cloud': { area: 'ado', deployment: 'cloud', baseUrl, pat: 'test-pat' } });
      expect(envelope.ok, baseUrl).toBe(true);
    }
  });

  it("an organization URL with a trailing slash, as Azure Pipelines' System.CollectionUri has, is accepted", async () => {
    const routes: Route[] = [{ url: 'https://dev.azure.com/imagile/_apis/wit/workitems/42?api-version=7.1&%24expand=all', respond: { json: workItem(42) } }];
    const { envelope } = await run('work-item get', { id: 42 }, routes, { 'ado-cloud': { area: 'ado', deployment: 'cloud', baseUrl: 'https://dev.azure.com/imagile/', pat: 'test-pat' } });
    expect(envelope.ok).toBe(true);
  });

  it('a project-scoped command without a project says so, naming --project', async () => {
    const { envelope, calls } = await run('work-item search', { wiql: 'SELECT [System.Id] FROM WorkItems' });
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('No Azure DevOps project given') });
    expect(calls).toHaveLength(0);
  });
});

describe('work items', () => {
  it('create sends a JSON Patch to the $Type path in the project, resolving aliases', async () => {
    const { calls } = await run('work-item create', { ...at, type: 'User Story', title: 'T', priority: 2, field: ['story points=3', 'MyOrg.Team=Core', 'effortdays=4'], ...write }, [], {
      'ado-cloud': { ...fixtureConfig['ado-cloud'], fieldAliases: { effortdays: 'MyOrg.EffortDays' } },
    });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${P}/_apis/wit/workitems/%24User%20Story?api-version=7.1`, headers: { 'content-type': 'application/json-patch+json' } });
    expect(body(calls[0]!)).toEqual([
      { op: 'add', path: '/fields/System.Title', value: 'T' },
      { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: 2 },
      { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints', value: '3' },
      { op: 'add', path: '/fields/MyOrg.Team', value: 'Core' },
      { op: 'add', path: '/fields/MyOrg.EffortDays', value: '4' },
    ]);
  });

  it('update with --rev tests the revision first, at the organization level', async () => {
    const { calls } = await run('work-item update', { id: 42, field: ['state=Active'], rev: 3, ...write });
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: `${ORG_URL}/_apis/wit/workitems/42?api-version=7.1` });
    expect(body(calls[0]!)).toEqual([
      { op: 'test', path: '/rev', value: 3 },
      { op: 'add', path: '/fields/System.State', value: 'Active' },
    ]);
  });

  it('a --field without = is refused before anything is sent', async () => {
    const { envelope, calls } = await run('work-item update', { id: 42, field: ['state'], ...write });
    expect(envelope.error?.code).toBe('INVALID_INPUT');
    expect(calls).toHaveLength(0);
  });

  it('search ANDs --updated-since onto the WHERE clause and turns on time precision', async () => {
    const { calls } = await run('work-item search', { ...at, wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'A' OR [System.State] = 'B' ORDER BY [System.Id]", updatedSince: '2026-10-01' });
    expect(calls[0]!.url).toBe(`${P}/_apis/wit/wiql?api-version=7.1&timePrecision=true`);
    expect(body(calls[0]!)).toEqual({ query: "SELECT [System.Id] FROM WorkItems WHERE ([System.State] = 'A' OR [System.State] = 'B') AND [System.ChangedDate] >= '2026-10-01T00:00:00.000Z' ORDER BY [System.Id]" });
  });

  it('search with --limit asks for one more than the page and hands back an offset cursor', async () => {
    const first = await run('work-item search', { ...at, wiql: 'SELECT [System.Id] FROM WorkItems', limit: 1 });
    expect(first.calls[0]!.url).toBe(`${P}/_apis/wit/wiql?api-version=7.1&%24top=2`);
    expect(first.data).toMatchObject({ workItems: [{ id: 42 }] });
    expect(first.envelope.meta.page).toEqual({ nextCursor: '1', limit: 1 });
    const second = await run('work-item search', { ...at, wiql: 'SELECT [System.Id] FROM WorkItems', limit: 1, cursor: '1' });
    expect(second.data).toMatchObject({ workItems: [{ id: 7 }] });
    expect(second.envelope.meta.page).toEqual({ nextCursor: null, limit: 1 });
  });

  it('search refuses a zoneless --updated-since and a link query', async () => {
    const zoneless = await run('work-item search', { ...at, wiql: 'SELECT [System.Id] FROM WorkItems', updatedSince: '2026-10-01T09:00:00' });
    expect(zoneless.envelope.error?.code).toBe('INVALID_INPUT');
    const link = await run('work-item search', { ...at, wiql: 'SELECT [System.Id] FROM WorkItemLinks', limit: 5 });
    expect(link.envelope.error?.code).toBe('INVALID_INPUT');
    expect(zoneless.calls.length + link.calls.length).toBe(0);
  });

  it('revisions page by $top and $skip at the organization level until a short page', async () => {
    const { calls, data } = await run('work-item history', { id: 42 });
    expect(calls.map((c) => c.url)).toEqual([`${ORG_URL}/_apis/wit/workItems/42/revisions?api-version=7.1&%24top=100&%24skip=0`]);
    expect((data as Array<{ rev: number }>).map((r) => r.rev)).toEqual([1, 2]);
  });

  it('get-many posts 200 ids a request, keeps the order asked, and lists what is missing', async () => {
    const ids = [404, ...Array.from({ length: 200 }, (_, i) => i + 1)];
    const { calls, data, envelope } = await run('work-item get-many', { id: ids, fields: 'System.Title,System.State' });
    expect(calls.map((c) => c.url)).toEqual([`${ORG_URL}/_apis/wit/workitemsbatch?api-version=7.1`, `${ORG_URL}/_apis/wit/workitemsbatch?api-version=7.1`]);
    expect(body(calls[0]!)).toMatchObject({ fields: ['System.Title', 'System.State'], errorPolicy: 'omit' });
    expect((body(calls[0]!) as { ids: number[] }).ids).toHaveLength(200);
    expect(data).toMatchObject({ count: 200, missing: [404] });
    expect((data as { value: Array<{ id: number }> }).value[0]!.id).toBe(1);
    expect(envelope.meta.warnings).toEqual([expect.objectContaining({ code: 'ADO_WORK_ITEMS_MISSING' })]);
  });

  it('get-many over 1,000 ids is refused before anything is sent', async () => {
    const { envelope, calls } = await run('work-item get-many', { id: Array.from({ length: 1001 }, (_, i) => i + 1) });
    expect(envelope.error?.code).toBe('INVALID_INPUT');
    expect(calls).toHaveLength(0);
  });

  it('comments follows the body continuation token, with the preview api-version, and pages through meta.page', async () => {
    const all = await run('work-item comments', { ...at, id: 42 });
    expect(all.calls.map((c) => c.url)).toEqual([
      `${P}/_apis/wit/workItems/42/comments?api-version=7.1-preview.4&%24top=200`,
      `${P}/_apis/wit/workItems/42/comments?api-version=7.1-preview.4&%24top=200&continuationToken=abc12345`,
    ]);
    expect((all.data as Array<{ id: number }>).map((c) => c.id)).toEqual([3, 2, 1]);
    const first = await run('work-item comments', { ...at, id: 42, limit: 2 });
    expect(first.calls).toHaveLength(1);
    const second = await run('work-item comments', { ...at, id: 42, limit: 2, cursor: first.envelope.meta.page!.nextCursor! });
    expect((second.data as Array<{ id: number }>).map((c) => c.id)).toEqual([1]);
    expect(second.envelope.meta.page).toEqual({ nextCursor: null, limit: 2 });
  });

  it('add-comment posts the text with the preview api-version', async () => {
    const { calls } = await run('work-item comment', { ...at, id: 42, body: 'Hi', ...write });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${P}/_apis/wit/workItems/42/comments?api-version=7.1-preview.4` });
    expect(body(calls[0]!)).toEqual({ text: 'Hi' });
  });

  it('iterations reads the classification tree to depth 10 by default', async () => {
    const { calls } = await run('work-item iterations', at);
    expect(calls[0]!.url).toBe(`${P}/_apis/wit/classificationnodes/iterations?api-version=7.1&%24depth=10`);
  });

  it('field names resolve through the connection, then the built-in aliases, ignoring case, spaces and dashes', () => {
    expect(referenceName('Story-Points')).toBe('Microsoft.VSTS.Scheduling.StoryPoints');
    expect(referenceName('Effort Days', { effortdays: 'MyOrg.EffortDays' })).toBe('MyOrg.EffortDays');
    expect(referenceName('state', { State: 'MyOrg.State' })).toBe('MyOrg.State');
    expect(referenceName('Custom.Thing')).toBe('Custom.Thing');
  });
});

describe('projects and repositories', () => {
  it('project list follows the x-ms-continuationtoken header', async () => {
    const { calls, data } = await run('project list', {});
    expect(calls.map((c) => c.url)).toEqual([`${ORG_URL}/_apis/projects?api-version=7.1`, `${ORG_URL}/_apis/projects?api-version=7.1&continuationToken=abc12345`]);
    expect((data as Array<{ name: string }>).map((p) => p.name)).toEqual(['Imagile', 'Imagile Ops']);
  });

  it('--cursor without --limit is refused', async () => {
    const { envelope } = await run('project list', { cursor: 'abc' });
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: '--cursor needs --limit' });
  });

  it('repo get reads the repository under the project', async () => {
    const { calls } = await run('repo get', inRepo);
    expect(calls[0]!.url).toBe(`${R}?api-version=7.1`);
  });

  it('an id with path or query syntax in it goes in as one encoded segment, not refused, since a name made through the API may hold any of them', async () => {
    const any: Route[] = [{ path: /.*/, respond: { json: {} } }];
    expect((await run('repo get', { project: 'a/b?c=d', repo: 'p1#hot' }, any)).calls[0]!.url).toBe(`${ORG_URL}/a%2Fb%3Fc%3Dd/_apis/git/repositories/p1%23hot?api-version=7.1`);
    expect((await run('project get', { name: 'p1#hot?' }, any)).calls[0]!.url).toBe(`${ORG_URL}/_apis/projects/p1%23hot%3F?api-version=7.1`);
    // From the connection too: a % is legal in a project name, so it is encoded rather than refused.
    const config = { 'ado-cloud': { ...fixtureConfig['ado-cloud'], project: '100% Done', repo: 'r' } };
    expect((await run('repo get', {}, any, config)).calls[0]!.url).toBe(`${ORG_URL}/100%25%20Done/_apis/git/repositories/r?api-version=7.1`);
  });

  it('a write encodes the ids in its path; one that would still name a .. segment is INVALID_INPUT before anything is sent', async () => {
    const any: Route[] = [{ method: 'POST', path: /.*/, respond: { json: {} } }];
    const comment = await run('work-item comment', { project: 'a/b?c=d', id: 42, body: 'x', ...write }, any);
    expect(comment.calls[0]).toMatchObject({ method: 'POST', url: `${ORG_URL}/a%2Fb%3Fc%3Dd/_apis/wit/workItems/42/comments?api-version=7.1-preview.4` });
    const dots = await run('work-item comment', { project: '..', id: 42, body: 'x', ...write }, any);
    expect(dots.envelope.error?.code).toBe('INVALID_INPUT');
    expect(dots.calls).toHaveLength(0);
  });
});

describe('pull requests', () => {
  it('pr list pages by $skip with the search criteria, dates as zoned instants', async () => {
    const { calls } = await run('pr list', { ...inRepo, state: 'all', creator: 'abc', createdAfter: '2026-09-01' });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/imagile/Imagile/_apis/git/repositories/imagile-api/pullrequests');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      'api-version': '7.1',
      'searchCriteria.status': 'all',
      'searchCriteria.creatorId': 'abc',
      'searchCriteria.queryTimeRangeType': 'created',
      'searchCriteria.minTime': '2026-09-01T00:00:00.000Z',
      $top: '100',
      $skip: '0',
    });
  });

  it('pr list --updated-since keeps active PRs and those created or closed since, counting kept ones against --limit', async () => {
    const listed = [
      pr(1, { status: 'completed', creationDate: '2026-08-01T00:00:00Z', closedDate: '2026-08-02T00:00:00Z' }),
      pr(2, { status: 'active', creationDate: '2026-01-01T00:00:00Z' }),
      pr(3, { status: 'abandoned', creationDate: '2026-08-01T00:00:00Z', closedDate: '2026-09-02T00:00:00Z' }),
      pr(4, { status: 'completed', creationDate: '2026-09-01T00:00:00Z', closedDate: '2026-09-01T06:00:00Z' }),
      pr(5, { status: 'completed', creationDate: '2026-07-01T00:00:00Z', closedDate: '2026-08-31T23:59:59Z' }),
    ];
    const paged: Route = { path: `${REPO}/pullrequests`, respond: (r) => ({ json: { value: new URL(r.url).searchParams.get('$skip') === '0' ? listed : [] } }) };
    const all = await run('pr list', { ...inRepo, state: 'all', reviewer: 'abc', createdAfter: '2026-01-01', updatedSince: '2026-09-01' }, [paged]);
    expect((all.data as Array<{ pullRequestId: number }>).map((p) => p.pullRequestId)).toEqual([2, 3, 4]);
    // Nothing about it goes to the server: the filter is toil's, on top of the created range.
    expect(all.calls.map((c) => c.url)).toEqual([
      `${R}/pullrequests?api-version=7.1&searchCriteria.status=all&searchCriteria.reviewerId=abc&searchCriteria.queryTimeRangeType=created&searchCriteria.minTime=2026-01-01T00%3A00%3A00.000Z&%24top=100&%24skip=0`,
    ]);
    const limited = await run('pr list', { ...inRepo, state: 'all', updatedSince: '2026-09-01T02:00:00+02:00', limit: 2 }, [paged]);
    expect((limited.data as Array<{ pullRequestId: number }>).map((p) => p.pullRequestId)).toEqual([2, 3]);
    expect(limited.envelope.meta.page?.nextCursor).toEqual(expect.any(String));
    // A zoneless date-time is refused, as the area's other date flags refuse it.
    const bad = await run('pr list', { ...inRepo, updatedSince: '2026-09-01T09:00' });
    expect(bad.calls).toEqual([]);
    expect(bad.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('Invalid --updated-since value "2026-09-01T09:00"') });
  });

  it('pr get without --include is the one request and the pull request as it came', async () => {
    const { calls, data } = await run('pr get', { ...inRepo, id: 42 });
    expect(calls).toEqual([{ method: 'GET', url: `${R}/pullrequests/42?api-version=7.1`, headers: GET_HEADERS, body: undefined }]);
    expect(data).toEqual(pr(42));
  });

  it('pr get --include reads each list asked for, in a fixed order, every page, into data.included', async () => {
    const { calls, data } = await run('pr get', { ...inRepo, id: 42, include: ' Files, reviews,,CHECKS,commits,reviews ' });
    expect(calls.map((c) => c.url)).toEqual([
      `${R}/pullrequests/42?api-version=7.1`,
      `${R}/pullrequests/42/threads?api-version=7.1`,
      `${R}/pullrequests/42/statuses?api-version=7.1`,
      `${R}/pullrequests/42/commits?api-version=7.1`,
      `${R}/pullrequests/42/commits?api-version=7.1&continuationToken=abc12345`,
      `${R}/pullrequests/42/iterations?api-version=7.1`,
      `${R}/pullrequests/42/iterations/2/changes?api-version=7.1`,
      `${R}/pullrequests/42/iterations/2/changes?api-version=7.1&%24skip=1`,
    ]);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    const got = data as Record<string, unknown> & { included: Record<string, unknown[]> };
    expect(Object.keys(got.included)).toEqual(['reviews', 'checks', 'commits', 'files']);
    expect(got.included.reviews).toEqual(threads);
    expect(got.included.checks).toEqual([prStatus]);
    expect(got.included.commits).toEqual([prCommit(SHA), prCommit('def67890abc12345def67890abc12345def67890')]);
    expect(got.included.files).toEqual([change(1, '/src/app.ts'), change(2, '/README.md')]);
    const rest = Object.fromEntries(Object.entries(got).filter(([key]) => key !== 'included'));
    expect(rest).toEqual(pr(42));
  });

  it('pr get --include files takes the highest iteration id, and no iterations is an empty list', async () => {
    const extra: Route[] = [
      { path: `${REPO}/pullrequests/42/iterations`, respond: { json: { count: 3, value: [iteration(3), iteration(1), iteration(2)] } } },
      { path: `${REPO}/pullrequests/42/iterations/3/changes`, respond: { json: { changeEntries: [change(9, '/a.ts')] } } },
    ];
    const { calls, data } = await run('pr get', { ...inRepo, id: 42, include: 'files' }, extra);
    expect(calls[2]!.url).toBe(`${R}/pullrequests/42/iterations/3/changes?api-version=7.1`);
    expect((data as { included: unknown }).included).toEqual({ files: [change(9, '/a.ts')] });
    const none = await run('pr get', { ...inRepo, id: 42, include: 'files' }, [{ path: `${REPO}/pullrequests/42/iterations`, respond: { json: { count: 0, value: [] } } }]);
    expect(none.calls).toHaveLength(2);
    expect((none.data as { included: unknown }).included).toEqual({ files: [] });
  });

  it('pr get refuses an unknown --include before any request, naming it and the allowed ones', async () => {
    const { calls, envelope } = await run('pr get', { ...inRepo, id: 42, include: 'reviews,builds' });
    expect(calls).toEqual([]);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Unknown --include value "builds". Allowed: reviews, checks, commits, files.', fix: expect.stringContaining('--include reviews,checks') });
    expect((await run('pr get', { ...inRepo, id: 42, include: ' , ' })).calls).toHaveLength(1);
  });

  it('pr create adds refs/heads/ to a branch name only, and leaves out what was not given', async () => {
    const { calls } = await run('pr create', { ...inRepo, title: 'T', source: 'feature/x', target: 'refs/heads/develop', ...write });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${R}/pullrequests?api-version=7.1` });
    expect(body(calls[0]!)).toEqual({ title: 'T', sourceRefName: 'refs/heads/feature/x', targetRefName: 'refs/heads/develop' });
  });

  it('pr update sends only the fields given', async () => {
    const { calls } = await run('pr update', { ...inRepo, id: 42, target: 'release/1.2', draft: false, ...write });
    expect(body(calls[0]!)).toEqual({ targetRefName: 'refs/heads/release/1.2', isDraft: false });
  });

  it('pr merge reads the source commit, then asks for completion with the strategy', async () => {
    const { calls } = await run('pr merge', { ...inRepo, id: 42, strategy: 'squash', deleteSource: true, message: 'm', ...write });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${R}/pullrequests/42?api-version=7.1`, `PATCH ${R}/pullrequests/42?api-version=7.1`]);
    expect(body(calls[1]!)).toEqual({
      status: 'completed',
      lastMergeSourceCommit: { commitId: 'abc12345def67890abc12345def67890abc12345' },
      completionOptions: { mergeStrategy: 'squash', deleteSourceBranch: true, mergeCommitMessage: 'm' },
    });
  });

  it('pr merge on a pull request with no source commit yet is INVALID_INPUT, and nothing is patched', async () => {
    const routes: Route[] = [{ path: '/imagile/Imagile/_apis/git/repositories/imagile-api/pullrequests/42', respond: { json: { pullRequestId: 42, status: 'active', mergeStatus: 'queued' } } }];
    const { envelope, calls } = await run('pr merge', { ...inRepo, id: 42, ...write }, routes);
    expect(envelope.error).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'Pull request 42 has no source commit to complete yet.',
      fix: 'Check data.mergeStatus with ado pr get, and retry once the server has merged the source branch.',
    });
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('an unknown merge strategy is refused before anything is sent', async () => {
    const { envelope, calls } = await run('pr merge', { ...inRepo, id: 42, strategy: 'fastForward', ...write });
    expect(envelope.error?.code).toBe('INVALID_INPUT');
    expect(calls).toHaveLength(0);
  });

  it("a vote is cast as the token's own identity, read from connection data", async () => {
    const { calls, data } = await run('pr wait-for-author', { ...inRepo, id: 42, ...write });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${ORG_URL}/_apis/connectionData?api-version=7.1-preview.1`, `PUT ${R}/pullrequests/42/reviewers/${ME}?api-version=7.1`]);
    expect(body(calls[1]!)).toEqual({ vote: -5 });
    expect(data).toMatchObject({ vote: -5 });
  });

  it('a write without --allow-write is refused before anything is sent', async () => {
    const { envelope, calls } = await run('pr abandon', { ...inRepo, id: 42 });
    expect(envelope.error?.code).toBe('WRITE_DISABLED');
    expect(calls).toHaveLength(0);
  });
});

describe('pull request comments', () => {
  it('comments flattens live threads oldest first and leaves out system comments unless asked', async () => {
    const plain = await run('pr comments', { ...inRepo, id: 42 });
    expect((plain.data as Array<{ id: number; threadId: number; threadContext: unknown }>).map((c) => [c.id, c.threadId])).toEqual([
      [3, 8],
      [1, 7],
    ]);
    const all = await run('pr comments', { ...inRepo, id: 42, includeSystem: true });
    expect((all.data as Array<{ id: number }>).map((c) => c.id)).toEqual([3, 5, 1]);
    const inline = await run('pr comments', { ...inRepo, id: 42, inlineOnly: true });
    expect((inline.data as Array<{ threadContext: { filePath: string } }>).map((c) => c.threadContext.filePath)).toEqual(['/src/app.ts']);
  });

  it('threads returns the threads as the server sent them, deleted ones left out', async () => {
    const { data } = await run('pr threads', { ...inRepo, id: 42 });
    expect((data as Array<{ id: number }>).map((t) => t.id)).toEqual([7, 8, 10]);
  });

  it('add-inline-comment roots the path and anchors on the side asked', async () => {
    const { calls } = await run('pr comment-inline', { ...inRepo, id: 42, path: 'src/app.ts', line: 3, body: 'Why?', lineType: 'left', ...write });
    expect(body(calls[0]!)).toEqual({
      comments: [{ parentCommentId: 0, content: 'Why?', commentType: 'text' }],
      status: 'active',
      threadContext: { filePath: '/src/app.ts', leftFileStart: { line: 3, offset: 1 }, leftFileEnd: { line: 3, offset: 1 } },
    });
  });

  it('reply-comment replies under the thread and resolve-comment sets fixed by default', async () => {
    const reply = await run('pr reply', { ...inRepo, id: 42, threadId: 7, body: 'Done', ...write });
    expect(reply.calls[0]).toMatchObject({ method: 'POST', url: `${R}/pullrequests/42/threads/7/comments?api-version=7.1` });
    expect(body(reply.calls[0]!)).toEqual({ parentCommentId: 1, content: 'Done', commentType: 'text' });
    const resolve = await run('pr resolve', { ...inRepo, id: 42, threadId: 7, ...write });
    expect(body(resolve.calls[0]!)).toEqual({ status: 'fixed' });
  });
});

describe('work item type states', () => {
  it('states reads the type under the project and returns its states, categories included', async () => {
    const { calls, data, envelope } = await run('work-item states', { ...at, type: 'Bug' });
    expect(calls).toEqual([{ method: 'GET', url: `${P}/_apis/wit/workitemtypes/Bug/states?api-version=7.1`, headers: GET_HEADERS, body: undefined }]);
    expect(data).toEqual(bugStates);
    expect(envelope.meta.warnings).toBeUndefined();
  });

  it('a type the project has no states for comes back empty with a warning, since the server sends no 404', async () => {
    const { calls, data, envelope } = await run('work-item states', { ...at, type: 'User Story' });
    expect(calls[0]!.url).toBe(`${P}/_apis/wit/workitemtypes/User%20Story/states?api-version=7.1`);
    expect(data).toEqual([]);
    expect(envelope.meta.warnings).toEqual([expect.objectContaining({ code: 'ADO_TYPE_UNKNOWN', message: expect.stringContaining('"User Story"') })]);
  });
});

describe('team settings: sprints, backlogs and boards', () => {
  const T = `${P}/${DEFAULT_TEAM}`;
  const named = { ...at, team: 'Imagile Team' };

  it("without --team, reads the project's default team first and puts its id in the path", async () => {
    const { calls, data, envelope } = await run('sprint list', at);
    expect(envelope.meta.warnings).toEqual([{ code: 'ADO_DEFAULT_TEAM', message: `No team given, so this read the project's default team, "Imagile Team" (${DEFAULT_TEAM}). Pass --team to read another.` }]);
    expect(calls).toEqual([
      { method: 'GET', url: `${ORG_URL}/_apis/projects/Imagile?api-version=7.1`, headers: GET_HEADERS, body: undefined },
      { method: 'GET', url: `${T}/_apis/work/teamsettings/iterations?api-version=7.1`, headers: GET_HEADERS, body: undefined },
    ]);
    expect(data).toEqual(teamIterations);
  });

  it('with --team, sends the name in the path and reads nothing else', async () => {
    const { calls, envelope } = await run('sprint list', named);
    expect(calls.map((c) => c.url)).toEqual([`${P}/Imagile%20Team/_apis/work/teamsettings/iterations?api-version=7.1`]);
    expect(envelope.meta.warnings).toBeUndefined();
    expect(envelope.meta.context?.inputs?.team).toEqual({ value: 'Imagile Team', source: 'input' });
  });

  it('the team comes from the connection when the call names none', async () => {
    const { calls } = await run('board list', at, [], { 'ado-cloud': { ...fixtureConfig['ado-cloud'], team: 'Imagile Team' } });
    expect(calls.map((c) => c.url)).toEqual([`${P}/Imagile%20Team/_apis/work/boards?api-version=7.1`]);
  });

  it('a project with no default team is NOT_FOUND, naming --team', async () => {
    const { envelope, calls } = await run('backlog list', at, [{ path: '/imagile/_apis/projects/Imagile', respond: { json: { id: 'abc12345-0000-0000-0000-000000000000', name: 'Imagile' } } }]);
    expect(envelope.error).toMatchObject({ code: 'NOT_FOUND', fix: expect.stringContaining('--team') });
    expect(calls).toHaveLength(1);
  });

  it('sprint list --state keeps the time frames named, from the team settings, even for sprints with no dates', async () => {
    const current = await run('sprint list', { ...named, state: 'current' });
    expect(current.data).toEqual([teamIterations[0]]);
    expect((current.data as Array<{ name: string }>)[0]!.name).toBe('Sprint 1');
    const ahead = await run('sprint list', { ...named, state: 'Future, current' });
    expect((ahead.data as Array<{ name: string }>).map((s) => s.name)).toEqual(['Sprint 1', 'Sprint 2', 'Sprint 3']);
    expect((await run('sprint list', { ...named, state: 'past' })).data).toEqual([]);
  });

  it('an unknown sprint state is refused before anything is sent', async () => {
    const { envelope, calls } = await run('sprint list', { ...named, state: 'active' });
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Unknown sprint state: active', fix: expect.stringContaining('past, current and/or future') });
    expect(calls).toEqual([]);
  });

  it("sprint items reads the sprint's work items under the team, as the server sends them", async () => {
    const { calls, data } = await run('sprint items', { ...named, id: teamIterations[0]!.id });
    expect(calls.map((c) => c.url)).toEqual([`${P}/Imagile%20Team/_apis/work/teamsettings/iterations/${teamIterations[0]!.id}/workitems?api-version=7.1`]);
    expect(data).toEqual(sprintItems);
  });

  it('backlog list returns the levels, and backlog items one level in backlog order', async () => {
    const list = await run('backlog list', named);
    expect(list.calls.map((c) => c.url)).toEqual([`${P}/Imagile%20Team/_apis/work/backlogs?api-version=7.1`]);
    expect(list.data).toEqual(backlogs);
    const items = await run('backlog items', { ...named, id: 'Microsoft.RequirementCategory' });
    expect(items.calls.map((c) => c.url)).toEqual([`${P}/Imagile%20Team/_apis/work/backlogs/Microsoft.RequirementCategory/workItems?api-version=7.1`]);
    expect(items.data).toEqual(backlogItems);
  });

  it('board list returns the boards, and board get one by name or id with the state under each column', async () => {
    const list = await run('board list', named);
    expect(list.calls.map((c) => c.url)).toEqual([`${P}/Imagile%20Team/_apis/work/boards?api-version=7.1`]);
    expect(list.data).toEqual(boards);
    const byName = await run('board get', { ...named, id: 'Backlog items' });
    expect(byName.calls.map((c) => c.url)).toEqual([`${P}/Imagile%20Team/_apis/work/boards/Backlog%20items?api-version=7.1`]);
    expect(byName.data).toEqual(board);
    const columns = (byName.data as typeof board).columns.map((c) => [c.name, c.stateMappings.Bug]);
    expect(columns).toEqual([['To Do', 'New'], ['Doing', 'Approved'], ['Testing', 'Committed'], ['Done', 'Done']]);
    const byId = await run('board get', { ...at, id: BOARD });
    expect(byId.calls.map((c) => c.url)).toEqual([`${ORG_URL}/_apis/projects/Imagile?api-version=7.1`, `${T}/_apis/work/boards/${BOARD}?api-version=7.1`]);
  });

  it("a team or board the server doesn't know is NOT_FOUND with its own message", async () => {
    const { envelope } = await run('board get', { ...named, id: 'Nope' }, fail(404, { message: 'TF401501: The board does not exist.', typeKey: 'BoardDoesNotExistException' }));
    expect(envelope.error).toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('TF401501') });
  });

  it('every team command needs a project, and says so', async () => {
    const { envelope, calls } = await run('board list', {});
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('--project') });
    expect(calls).toEqual([]);
  });
});

describe('api passthrough', () => {
  it('sends the path under the organization URL with the same credential', async () => {
    const { calls, envelope } = await run('api', { method: 'GET', path: '_apis/projects', query: ['api-version=7.1'] });
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${ORG_URL}/_apis/projects?api-version=7.1`, headers: { authorization: BASIC } });
    expect(envelope.meta.response).toMatchObject({ status: 200 });
  });

  it('maps a 401 to AUTH with the same fix as every other command', async () => {
    const { envelope } = await run('api', { method: 'GET', path: '_apis/projects' }, fail(401, { message: 'Unauthorized' }));
    expect(envelope.error).toMatchObject({ code: 'AUTH', fix: expect.stringContaining('December 1, 2026') });
  });
});

describe('work-item feed (the reporting feed)', () => {
  it('has ten minutes, since --limit is how a caller stops early', () => {
    const feeds = commands.filter((c) => commandName(c as AnyCommand) === 'ado work-item feed');
    expect(feeds.length).toBeGreaterThan(0);
    for (const c of feeds) expect((c as AnyCommand).timeLimitMs).toBe(600_000);
  });

  it('reads the feed from a start date, then follows the continuation token without the date', async () => {
    const { calls, data, envelope } = await run('work-item feed', { project: 'Imagile', updatedSince: '2026-09-01', fields: 'System.State, System.IterationPath' });
    expect(calls.map((c) => c.url)).toEqual([
      `${ORG_URL}/Imagile/_apis/wit/reporting/workitemrevisions?api-version=7.1&fields=System.State,System.IterationPath&startDateTime=2026-09-01T00%3A00%3A00.000Z`,
      `${ORG_URL}/Imagile/_apis/wit/reporting/workitemrevisions?api-version=7.1&fields=System.State,System.IterationPath&continuationToken=abc12345`,
    ]);
    expect((data as Array<{ id: number; rev: number }>).map((r) => `${r.id}@${r.rev}`)).toEqual(['42@1', '42@2', '7@1', '42@3']);
    expect(envelope.meta.page).toBeUndefined();
  });

  it('without a start date or fields it sends neither', async () => {
    const { calls } = await run('work-item feed', { project: 'Imagile' });
    expect(calls.map((c) => c.url)).toEqual([`${ORG_URL}/Imagile/_apis/wit/reporting/workitemrevisions?api-version=7.1`, `${ORG_URL}/Imagile/_apis/wit/reporting/workitemrevisions?api-version=7.1&continuationToken=abc12345`]);
  });

  it('--limit stops inside a batch, and the cursor resumes from the token without the start date', async () => {
    const first = await run('work-item feed', { project: 'Imagile', updatedSince: '2026-09-01', limit: 2 });
    expect(first.calls).toHaveLength(1);
    expect((first.data as Array<{ rev: number }>).map((r) => r.rev)).toEqual([1, 2]);
    expect(first.envelope.meta.page).toEqual({ nextCursor: expect.any(String), limit: 2 });
    const second = await run('work-item feed', { project: 'Imagile', updatedSince: '2026-09-01', limit: 2, cursor: first.envelope.meta.page!.nextCursor });
    expect((second.data as Array<{ id: number; rev: number }>).map((r) => `${r.id}@${r.rev}`)).toEqual(['7@1', '42@3']);
    expect(second.envelope.meta.page).toEqual({ nextCursor: null, limit: 2 });
  });

  it('refuses a zoneless start, and a cursor without a limit, before anything is sent', async () => {
    const zoneless = await run('work-item feed', { project: 'Imagile', updatedSince: '2026-09-01T09:00:00' });
    const cursor = await run('work-item feed', { project: 'Imagile', cursor: 'abc' });
    expect(zoneless.envelope.error?.code).toBe('INVALID_INPUT');
    expect(cursor.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: '--cursor needs --limit' });
    expect(zoneless.calls.length + cursor.calls.length).toBe(0);
  });

  it('a cancellation between batches stops the feed with CANCELLED instead of reading on', async () => {
    const controller = new AbortController();
    const first: Route = { path: /reporting\/workitemrevisions$/, respond: () => { controller.abort(new ToilError('CANCELLED', 'cancelled')); return { json: { values: [], continuationToken: 'abc12345', isLastBatch: false } }; } };
    const t = testContext({ config: fixtureConfig, routes: [first, ...fixtureRoutes] });
    const envelope = await execute(cmd('work-item feed'), { project: 'Imagile' }, { ...t.context, signal: controller.signal });
    expect(envelope.error?.code).toBe('CANCELLED');
    expect(t.http.calls).toHaveLength(1);
  });
});

describe('the writes demo seeding needed (#618)', () => {
  const PATCH_JSON = { 'content-type': 'application/json-patch+json' };

  it('repo create reads the project for its id and sends it beside the name', async () => {
    const { calls, envelope } = await run('repo create', { ...at, name: 'imagile-new', ...write });
    expect(envelope.ok).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${ORG_URL}/_apis/projects/Imagile?api-version=7.1`, `POST ${P}/_apis/git/repositories?api-version=7.1`]);
    expect(body(calls[1]!)).toEqual({ name: 'imagile-new', project: { id: 'abc12345-0000-0000-0000-000000000070' } });
  });

  it('work-item assign patches System.AssignedTo and needs no project', async () => {
    const { calls } = await run('work-item assign', { id: 42, assignee: 'you@example.com', ...write });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: `${ORG_URL}/_apis/wit/workitems/42?api-version=7.1`, headers: PATCH_JSON });
    expect(body(calls[0]!)).toEqual([{ op: 'add', path: '/fields/System.AssignedTo', value: 'you@example.com' }]);
  });

  it('work-item link --target adds a work item relation by the organization URL', async () => {
    const { calls } = await run('work-item link', { id: 42, target: '8', type: 'child', ...write });
    expect(body(calls[0]!)).toEqual([{ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Forward', url: `${ORG_URL}/_apis/wit/workItems/8` } }]);
  });

  it('work-item link --pr reads the repository for its ids and adds an artifact link', async () => {
    const { calls } = await run('work-item link', { ...inRepo, id: 42, pr: 44, ...write });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${R}?api-version=7.1`, `PATCH ${ORG_URL}/_apis/wit/workitems/42?api-version=7.1`]);
    expect(body(calls[1]!)).toEqual([
      { op: 'add', path: '/relations/-', value: { rel: 'ArtifactLink', url: 'vstfs:///Git/PullRequestId/abc12345-0000-0000-0000-000000000070%2Fabc12345-0000-0000-0000-000000000003%2F44', attributes: { name: 'Pull Request' } } },
    ]);
  });

  it('work-item link refuses both or neither of --target and --pr, --type with --pr, and a --pr without a repo, before anything is sent', async () => {
    const both = await run('work-item link', { ...inRepo, id: 42, target: '7', pr: 44, ...write });
    const neither = await run('work-item link', { id: 42, ...write });
    const typed = await run('work-item link', { ...inRepo, id: 42, pr: 44, type: 'child', ...write });
    const noRepo = await run('work-item link', { id: 42, pr: 44, ...write });
    const notId = await run('work-item link', { id: 42, target: 'seven', ...write });
    for (const r of [both, neither, typed, noRepo, notId]) {
      expect(r.envelope.error?.code).toBe('INVALID_INPUT');
      expect(r.calls).toHaveLength(0);
    }
  });

  it('pr create --work-item sends workItemRefs', async () => {
    const { calls } = await run('pr create', { ...inRepo, title: 'Add retries', source: 'feature/retries', workItem: [42, 7], ...write });
    expect(body(calls[0]!)).toMatchObject({ workItemRefs: [{ id: '42' }, { id: '7' }] });
  });

  it('work-item delete-comment sends DELETE at the comments preview version and is never an MCP tool', async () => {
    const { calls, data } = await run('work-item delete-comment', { ...at, id: 42, commentId: 4, ...write });
    expect(calls).toEqual([{ method: 'DELETE', url: `${P}/_apis/wit/workItems/42/comments/4?api-version=7.1-preview.4`, headers: GET_HEADERS, body: undefined }]);
    expect(data).toEqual({ deleted: true });
    expect(cmd('work-item delete-comment').mcp).toBe(false);
  });

  describe('sprint update', () => {
    const NODE = `${P}/_apis/wit/classificationnodes/iterations`;

    it('finds the sprint by name in the iteration tree and patches its dates as midnight UTC days', async () => {
      const { calls, envelope } = await run('sprint update', { ...at, sprint: 'Sprint 1', start: '2026-11-16', end: '2026-11-27T17:00:00-05:00', ...write });
      expect(envelope.ok).toBe(true);
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${NODE}?api-version=7.1&%24depth=10`, `PATCH ${NODE}/Sprint%201?api-version=7.1`]);
      expect(body(calls[1]!)).toEqual({ attributes: { startDate: '2026-11-16T00:00:00Z', finishDate: '2026-11-27T00:00:00Z' } });
      expect(envelope.meta.warnings).toEqual([{ code: 'ADO_SPRINT_DAY', message: expect.stringContaining('--end 2026-11-27T17:00:00-05:00 was sent as 2026-11-27') }]);
    });

    it('takes the id or the team iteration path, renames, and keeps the date not given', async () => {
      const byId = await run('sprint update', { ...at, sprint: 'abc12345-0000-0000-0000-000000000102', name: 'Sprint 1b', end: '2026-11-28', ...write });
      expect(body(byId.calls[1]!)).toEqual({ name: 'Sprint 1b', attributes: { startDate: '2026-10-01T00:00:00Z', finishDate: '2026-11-28T00:00:00Z' } });
      const byPath = await run('sprint update', { ...at, sprint: 'Imagile\\Sprint 1', name: 'Sprint 1c', ...write });
      expect(byPath.calls[1]!.url).toBe(`${NODE}/Sprint%201?api-version=7.1`);
      expect(body(byPath.calls[1]!)).toEqual({ name: 'Sprint 1c' });
    });

    it('takes the node path form, refuses a name two sprints share, and refuses an end before the start', async () => {
      const node = await run('sprint update', { ...at, sprint: '\\Imagile\\Iteration\\Sprint 1', name: 'Sprint 1d', ...write });
      expect(node.calls[1]!.url).toBe(`${NODE}/Sprint%201?api-version=7.1`);
      const twin = { name: 'Sprint 1', path: '\\Imagile\\Iteration\\Release 1\\Sprint 1' };
      const tree: Route[] = [{ path: '/imagile/Imagile/_apis/wit/classificationnodes/iterations', respond: { json: { name: 'Imagile', path: '\\Imagile\\Iteration', children: [{ name: 'Release 1', children: [twin] }, { name: 'Release 2', children: [{ name: 'Sprint 1' }] }] } } }];
      const shared = await run('sprint update', { ...at, sprint: 'Sprint 1', start: '2026-11-16', end: '2026-11-27', ...write }, tree);
      expect(shared.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('Release 1\\Sprint 1') });
      expect(shared.calls).toHaveLength(1);
      const undated = await run('sprint update', { ...at, sprint: 'Release 1\\Sprint 1', start: '2026-11-16', ...write }, tree);
      expect(undated.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('no end date') });
      const backwards = await run('sprint update', { ...at, sprint: 'Sprint 1', start: '2026-11-27', end: '2026-11-16', ...write });
      expect(backwards.envelope.error?.code).toBe('INVALID_INPUT');
      expect(backwards.calls).toHaveLength(1);
    });

    it('refuses a date with trailing words or a day that does not exist', async () => {
      for (const start of ['2026-11-16 junk', '2026-02-30', '2026-11-16T09:00']) {
        const r = await run('sprint update', { ...at, sprint: 'Sprint 1', start, ...write });
        expect(r.envelope.error?.code).toBe('INVALID_INPUT');
        expect(r.calls).toHaveLength(0);
      }
    });

    it('refuses nothing to change and a bad date before anything is sent, and an unknown sprint after reading the tree', async () => {
      const nothing = await run('sprint update', { ...at, sprint: 'Sprint 1', ...write });
      const badDate = await run('sprint update', { ...at, sprint: 'Sprint 1', start: 'next monday', ...write });
      expect([nothing.envelope.error?.code, badDate.envelope.error?.code]).toEqual(['INVALID_INPUT', 'INVALID_INPUT']);
      expect(nothing.calls.length + badDate.calls.length).toBe(0);
      const unknown = await run('sprint update', { ...at, sprint: 'Sprint 9', start: '2026-11-16', ...write });
      expect(unknown.envelope.error?.code).toBe('NOT_FOUND');
      expect(unknown.calls).toHaveLength(1);
    });
  });

  describe('commit create', () => {
    const ZERO = '0000000000000000000000000000000000000000';
    const b64 = (text: string) => Buffer.from(text).toString('base64');

    it('moves an existing branch from its head, editing a path the base has and adding one it has not', async () => {
      const { calls, envelope } = await run('commit create', { ...inRepo, branch: 'main', message: 'Update', inputFile: ['README.md', 'src/retry.js'], ...write });
      expect(envelope.ok).toBe(true);
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        `GET ${R}?api-version=7.1`,
        `GET ${R}/refs?api-version=7.1&filter=heads%2Fmain`,
        `GET ${R}/items?api-version=7.1&scopePath=%2F&recursionLevel=Full&versionDescriptor.version=${SHA}&versionDescriptor.versionType=commit`,
        `POST ${R}/pushes?api-version=7.1`,
      ]);
      expect(body(calls[3]!)).toEqual({
        refUpdates: [{ name: 'refs/heads/main', oldObjectId: SHA }],
        commits: [
          {
            comment: 'Update',
            changes: [
              { changeType: 'edit', item: { path: '/README.md' }, newContent: { content: b64('# imagile-api\n'), contentType: 'base64encoded' } },
              { changeType: 'add', item: { path: '/src/retry.js' }, newContent: { content: b64('export const retries = 3;\n'), contentType: 'base64encoded' } },
            ],
          },
        ],
      });
    });

    it('starts a new branch from --from', async () => {
      const { calls } = await run('commit create', { ...inRepo, branch: 'feature/retries', from: 'main', message: 'Add retries', inputFile: ['src/retry.js'], ...write });
      expect(calls[1]!.url).toBe(`${R}/refs?api-version=7.1&filter=heads%2Ffeature%2Fretries`);
      expect(calls[2]!.url).toBe(`${R}/refs?api-version=7.1&filter=heads%2Fmain`);
      expect((body(calls[4]!) as { refUpdates: unknown }).refUpdates).toEqual([{ name: 'refs/heads/feature/retries', oldObjectId: SHA }]);
    });

    it("starts a new branch with no --from at the repository's default branch, and lists only the folder the files share", async () => {
      const { calls } = await run('commit create', { ...inRepo, branch: 'feature/retries', message: 'Add retries', inputFile: ['src/retry.js'], ...write });
      expect(calls[2]!.url).toBe(`${R}/refs?api-version=7.1&filter=heads%2Fmain`);
      expect(calls[3]!.url).toContain('scopePath=%2Fsrc&');
      expect((body(calls[4]!) as { refUpdates: unknown }).refUpdates).toEqual([{ name: 'refs/heads/feature/retries', oldObjectId: SHA }]);
    });

    it('commits into a folder the base does not have yet, every file an add, when its listing answers 404', async () => {
      const missing: Route[] = [{ path: '/imagile/Imagile/_apis/git/repositories/imagile-api/items', respond: { status: 404, json: { message: 'TF401174: The item \'/newdir\' could not be found.' } } }];
      const { calls, envelope } = await run('commit create', { ...inRepo, branch: 'main', message: 'New', inputFile: ['src/retry.js'], ...write }, missing);
      expect(envelope.ok).toBe(true);
      expect((body(calls[3]!) as { commits: Array<{ changes: Array<{ changeType: string }> }> }).commits[0]!.changes.map((c) => c.changeType)).toEqual(['add']);
    });

    it('makes the first commit of an empty repository from the zero object id, every file an add', async () => {
      const empty: Route[] = [
        { path: `/imagile/Imagile/_apis/git/repositories/imagile-api`, respond: { json: { id: 'abc12345-0000-0000-0000-000000000003', name: 'imagile-api' } } },
        { path: `/imagile/Imagile/_apis/git/repositories/imagile-api/refs`, respond: { json: { count: 0, value: [] } } },
      ];
      const { calls } = await run('commit create', { ...inRepo, branch: 'main', message: 'First', inputFile: ['README.md'], ...write }, empty);
      expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'POST']);
      const sent = body(calls[2]!) as { refUpdates: unknown; commits: Array<{ changes: Array<{ changeType: string }> }> };
      expect(sent.refUpdates).toEqual([{ name: 'refs/heads/main', oldObjectId: ZERO }]);
      expect(sent.commits[0]!.changes.map((c) => c.changeType)).toEqual(['add']);
    });

    it('refuses a path outside the workspace, a file named twice, a missing file and a missing --from before pushing', async () => {
      for (const file of [['../secret.txt'], ['/etc/hosts'], ['README.md', './README.md']]) {
        const r = await run('commit create', { ...inRepo, branch: 'main', message: 'x', inputFile: file, ...write });
        expect(r.envelope.error?.code).toBe('INVALID_INPUT');
        expect(r.calls).toHaveLength(0);
      }
      const missing = await run('commit create', { ...inRepo, branch: 'main', message: 'x', inputFile: ['nope.txt'], ...write });
      expect(missing.envelope.ok).toBe(false);
      expect(missing.calls).toHaveLength(0);
      const noBase = await run('commit create', { ...inRepo, branch: 'feature/x', from: 'develop', message: 'x', inputFile: ['README.md'], ...write });
      expect(noBase.envelope.error?.code).toBe('NOT_FOUND');
      expect(noBase.calls.some((c) => c.method === 'POST')).toBe(false);
    });
  });
});

describe('work-item tag and untag on Services', () => {
  const tagged = (tags: string | undefined): Route[] => [{ path: /^\/imagile\/_apis\/wit\/workitems\/42$/, respond: { json: { id: 42, rev: 7, fields: tags === undefined ? {} : { 'System.Tags': tags } } } }];
  const PATCH_JSON = { 'content-type': 'application/json-patch+json' };

  it('tag reads the item, then adds the new ones after a test of its revision, keeping case and order', async () => {
    const { calls } = await run('work-item tag', { id: 42, tags: 'UI; urgent,Backend', ...write }, tagged('ui; backend'));
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${ORG_URL}/_apis/wit/workitems/42?api-version=7.1`, `PATCH ${ORG_URL}/_apis/wit/workitems/42?api-version=7.1`]);
    expect(calls[1]).toMatchObject({ headers: PATCH_JSON });
    expect(body(calls[1]!)).toEqual([{ op: 'test', path: '/rev', value: 7 }, { op: 'add', path: '/fields/System.Tags', value: 'ui; backend; urgent' }]);
  });

  it('untag replaces the list with what is left, and removes the field when nothing is', async () => {
    const some = await run('work-item untag', { id: 42, tags: 'UI', ...write }, tagged('ui; backend'));
    expect(body(some.calls[1]!)).toEqual([{ op: 'test', path: '/rev', value: 7 }, { op: 'replace', path: '/fields/System.Tags', value: 'backend' }]);
    const last = await run('work-item untag', { id: 42, tags: 'ui,BACKEND', ...write }, tagged('ui; backend'));
    expect(body(last.calls[1]!)).toEqual([{ op: 'test', path: '/rev', value: 7 }, { op: 'remove', path: '/fields/System.Tags' }]);
  });

  it('sends no write when nothing changes, and returns the item as read', async () => {
    const already = await run('work-item tag', { id: 42, tags: 'UI', ...write }, tagged('ui'));
    const absent = await run('work-item untag', { id: 42, tags: 'urgent', ...write }, tagged(undefined));
    expect([already.calls.length, absent.calls.length]).toEqual([1, 1]);
    expect(already.envelope.data).toMatchObject({ id: 42, rev: 7 });
  });

  it('tags an untagged item with add, and counts a tag named twice in any case once', async () => {
    const { calls } = await run('work-item tag', { id: 42, tags: 'Urgent; urgent,URGENT', ...write }, tagged(undefined));
    expect(body(calls[1]!)).toEqual([{ op: 'test', path: '/rev', value: 7 }, { op: 'add', path: '/fields/System.Tags', value: 'Urgent' }]);
  });

  it('refuses an empty tag list before anything is sent', async () => {
    for (const tags of ['', ' ; , ']) {
      const r = await run('work-item untag', { id: 42, tags, ...write }, tagged('ui'));
      expect(r.envelope.error?.code).toBe('INVALID_INPUT');
      expect(r.calls).toHaveLength(0);
    }
  });

  it('says plainly when the item changed between the read and the write', async () => {
    const moved: Route[] = [{ method: 'PATCH', path: /^\/imagile\/_apis\/wit\/workitems\/42$/, respond: { status: 412, json: { message: 'TF26071: This work item has been changed by someone else since you opened it.' } } }];
    const { envelope } = await run('work-item tag', { id: 42, tags: 'urgent', ...write }, [...moved, ...tagged('ui')]);
    expect(envelope.error).toMatchObject({ code: 'HTTP', message: expect.stringContaining('changed after toil read its tags (revision 7)'), fix: expect.stringContaining('Run the same command again') });
  });
});
