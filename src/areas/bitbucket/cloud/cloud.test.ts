import { describe, expect, it } from 'vitest';
import { testContext } from '../../../../test/harness/context.js';
import type { Route } from '../../../../test/harness/fake-fetch.js';
import { API, BASE_HASH, DIFF, HASH, LOG, activity, comments, config as fixtureConfig, diffstat, statuses, files as fixtureFiles, pipeline, pullRequest, repo as fixtureRepo, routes as fixtureRoutes } from '../../../../test/fixtures/bitbucket-cloud-data.js';
import type { AnyCommand } from '../../../core/command.js';
import { execute } from '../../../core/run.js';
import { errorMessage } from './endpoint.js';
import { exampleCursor, reviewerRefs } from './client.js';
import { addCommentCommand, addInlineCommentCommand, commentCommands, deleteCommentCommand, listCommentsCommand, replyCommentCommand, resolveCommentCommand } from './comments.js';
import { getPipelineCommand, getStepLogCommand, listPipelinesCommand, listPipelineStepsCommand, pipelineCommands, uuid } from './pipelines.js';
import { createPrCommand, currentPrCommand, declinePrCommand, getPrCommand, listPrsCommand, mergePrCommand, pullRequestCommands, updatePrCommand } from './pull-requests.js';
import { createBranchCommand, createRepoCommand, createTagCommand, getCommitCommand, getFileCommand, getRepoCommand, listBranchesCommand, listCommitsCommand, listDirCommand, listReposCommand, listTagsCommand, repoCommands } from './repos.js';
import { approveCommand, diffCommand, getBuildStatusCommand, listBuildsCommand, listDefaultReviewersCommand, listFilesCommand, listReviewersCommand, requestChangesCommand, reviewCommands, unapproveCommand } from './review.js';
import { bitbucketApi } from './api.js';
import { bitbucketArea } from '../area.js';

/**
 * Request building and response reshaping for Bitbucket Cloud, command by
 * command: the exact request toil sends and what it makes of the answer,
 * checked against Atlassian's documented REST API 2.0, since no live
 * workspace has been consulted. The parity suite proves both front doors
 * agree; this proves they agree with the documentation, which has signed
 * off on itself.
 */

const R = `${API}/repositories/imagile/toil`;
const BASIC = `Basic ${Buffer.from('you@example.com:test-token').toString('base64')}`;
const GET_HEADERS = { authorization: BASIC, accept: 'application/json' };
const JSON_HEADERS = { ...GET_HEADERS, 'content-type': 'application/json' };
const at = { workspace: 'imagile', repo: 'toil' };
const write = { allowWrite: true };
const own = fixtureConfig['bitbucket-cloud'];
const SPEC = `${HASH.slice(0, 12)}..${BASE_HASH.slice(0, 12)}`;

async function run(def: AnyCommand, input: Record<string, unknown>, routes: Route[] = fixtureRoutes, options: { config?: Record<string, Record<string, unknown>>; repo?: typeof fixtureRepo } = {}) {
  const t = testContext({ config: options.config ?? fixtureConfig, routes, files: fixtureFiles, ...(options.repo ? { repo: options.repo } : {}) });
  const envelope = await execute(def, input, t.context);
  return { envelope, calls: t.http.calls };
}

const body = (call: { body?: string | undefined }) => JSON.parse(call.body!) as Record<string, unknown>;
const urls = (calls: Array<{ url: string }>) => calls.map((c) => c.url);

describe('credentials', () => {
  it('an API token goes as Basic auth with the account email', async () => {
    const { calls } = await run(getRepoCommand, at);
    expect(calls).toEqual([{ method: 'GET', url: R, headers: GET_HEADERS, body: undefined }]);
  });

  it('an access token goes as Bearer, with no email needed', async () => {
    const { calls, envelope } = await run(getRepoCommand, at, fixtureRoutes, { config: { 'bitbucket-cloud': { area: 'bitbucket', deployment: 'cloud', baseUrl: API, accessToken: 'repo-token' } } });
    expect(envelope.ok).toBe(true);
    expect(calls[0]!.headers).toEqual({ authorization: 'Bearer repo-token', accept: 'application/json' });
  });

  it('both tokens on one connection is CONFIG_INVALID before anything is sent', async () => {
    const { calls, envelope } = await run(getRepoCommand, at, fixtureRoutes, { config: { 'bitbucket-cloud': { ...own, accessToken: 'repo-token' } } });
    expect(envelope.error).toMatchObject({ code: 'CONFIG_INVALID', message: expect.stringContaining('both an accessToken and an apiToken') });
    expect(calls).toHaveLength(0);
  });

  it('neither token is NOT_CONFIGURED naming both env vars; an API token without its email says so', async () => {
    const none = await run(getRepoCommand, at, fixtureRoutes, { config: { 'bitbucket-cloud': { area: 'bitbucket', deployment: 'cloud', baseUrl: API } } });
    expect(none.envelope.error).toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(none.envelope.error?.fix).toContain('TOIL_BITBUCKET_ACCESS_TOKEN');
    expect(none.envelope.error?.fix).toContain('TOIL_BITBUCKET_API_TOKEN');
    const noEmail = await run(getRepoCommand, at, fixtureRoutes, { config: { 'bitbucket-cloud': { area: 'bitbucket', deployment: 'cloud', baseUrl: API, apiToken: 'test-token' } } });
    expect(noEmail.envelope.error).toMatchObject({ code: 'NOT_CONFIGURED', message: expect.stringContaining('no email'), fix: expect.stringContaining('TOIL_BITBUCKET_EMAIL') });
    expect(none.calls.length + noEmail.calls.length).toBe(0);
  });

  it('a 401 is AUTH naming the API token to create, with its scopes, and that app passwords are gone', async () => {
    const { envelope } = await run(getRepoCommand, at, [{ path: /.*/, respond: { status: 401, json: { type: 'error', error: { message: 'Unauthorized' } } } }]);
    expect(envelope.error).toMatchObject({ code: 'AUTH', message: expect.stringContaining('Unauthorized') });
    expect(envelope.error?.fix).toContain('Create an API token with scopes at https://id.atlassian.com/manage-profile/security/api-tokens');
    expect(envelope.error?.fix).toContain('read:repository:bitbucket');
    expect(envelope.error?.fix).toContain('App passwords no longer work');
  });

  it('a 401 on an access token names the access token to create instead', async () => {
    const { envelope } = await run(getRepoCommand, at, [{ path: /.*/, respond: { status: 401, json: { type: 'error', error: { message: 'Unauthorized' } } } }], { config: { 'bitbucket-cloud': { area: 'bitbucket', deployment: 'cloud', baseUrl: API, accessToken: 'repo-token' } } });
    expect(envelope.error?.code).toBe('AUTH');
    expect(envelope.error?.fix).toContain('Create a new access token in Bitbucket');
    expect(envelope.error?.fix).toContain('TOIL_BITBUCKET_ACCESS_TOKEN');
  });

  it('a 410 Gone is AUTH with the same fix, not a bare HTTP failure', async () => {
    const { envelope } = await run(listReposCommand, { workspace: 'imagile' }, [{ path: /.*/, respond: { status: 410, json: { type: 'error', error: { message: 'This API is no longer available' } } } }]);
    expect(envelope.error).toMatchObject({ code: 'AUTH', message: 'This API is no longer available', details: { status: 410 } });
    expect(envelope.error?.fix).toContain('App passwords no longer work');
    expect(envelope.error?.fix).toContain("A 410 means Bitbucket retired either this way of signing in or this endpoint; if the message says the API is no longer available, the endpoint is gone and a new credential won't help.");
  });

  it('the api passthrough maps a 410 the same way, since it goes through the same hook', async () => {
    const { envelope } = await run(bitbucketApi, { method: 'GET', path: 'repositories/imagile' }, [{ path: /.*/, respond: { status: 410, json: { type: 'error', error: { message: 'Gone' } } } }]);
    expect(envelope.error).toMatchObject({ code: 'AUTH', message: 'Gone' });
  });

  it("Bitbucket's error body is read as message, detail and each field's complaints", async () => {
    const error = { type: 'error', error: { message: 'Bad request', detail: 'You must specify a valid source branch.', fields: { src: ['This field is required.'] } } };
    const { envelope } = await run(createPrCommand, { ...at, title: 'T', source: 'gone', ...write }, [{ method: 'POST', path: /.*/, respond: { status: 400, json: error } }]);
    expect(envelope.error).toMatchObject({ code: 'HTTP', message: 'Bad request; You must specify a valid source branch.; src: This field is required.' });
    expect(errorMessage('not json')).toBeUndefined();
    expect(errorMessage(JSON.stringify({ error: {} }))).toBeUndefined();
  });

  it('a 404 stays NOT_FOUND, and any other failure keeps its HTTP code', async () => {
    const missing = await run(getRepoCommand, at, [{ path: /.*/, respond: { status: 404, json: { type: 'error', error: { message: 'Repository not found' } } } }]);
    expect(missing.envelope.error).toMatchObject({ code: 'NOT_FOUND', message: 'Repository not found' });
    const bad = await run(getRepoCommand, at, [{ path: /.*/, respond: { status: 400, json: { type: 'error', error: { message: 'Bad request' } } } }]);
    expect(bad.envelope.error?.code).toBe('HTTP');
  });
});

describe('context', () => {
  it('no workspace is INVALID_INPUT pointing at --ws, not toil’s own --workspace; no repo names --repo', async () => {
    const ws = await run(getRepoCommand, { repo: 'toil' });
    expect(ws.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('Pass --ws <slug>') });
    const repo = await run(getRepoCommand, { workspace: 'imagile' });
    expect(repo.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('Pass --repo <slug>') });
    expect(ws.calls.length + repo.calls.length).toBe(0);
  });

  it('the connection supplies workspace and repo; slugs are encoded as one segment each', async () => {
    const { calls } = await run(getRepoCommand, {}, [{ path: /.*/, respond: { json: {} } }], { config: { 'bitbucket-cloud': { ...own, workspace: 'my team', repo: '{abc12345-0000-0000-0000-000000000000}' } } });
    expect(calls[0]!.url).toBe(`${API}/repositories/my%20team/%7Babc12345-0000-0000-0000-000000000000%7D`);
  });

  it('a workspace or repo with path syntax in it is refused before anything is sent, since slugs never hold / \\ ? # or %', async () => {
    for (const where of [{ workspace: 'x/../y', repo: 'toil' }, { workspace: 'imagile', repo: 'a/b?c=d' }, { workspace: 'imagile', repo: 'p1#hot' }, { workspace: 'imag%2Fle', repo: 'toil' }]) {
      const { calls, envelope } = await run(getRepoCommand, where, [{ path: /.*/, respond: { json: {} } }]);
      expect(envelope.error?.code).toBe('INVALID_INPUT');
      expect(calls).toHaveLength(0);
    }
  });

  it('a repo with path syntax in it is refused for a write, and when the connection supplies it', async () => {
    const write1 = await run(approveCommand, { workspace: 'imagile', repo: 'toil/../other', id: 42, ...write }, [{ path: /.*/, respond: { json: {} } }]);
    expect(write1.envelope.error?.code).toBe('INVALID_INPUT');
    expect(write1.calls).toHaveLength(0);
    const fromConnection = await run(getRepoCommand, {}, [{ path: /.*/, respond: { json: {} } }], { config: { 'bitbucket-cloud': { ...own, workspace: 'imagile', repo: 'toil?x=1' } } });
    expect(fromConnection.envelope.error?.code).toBe('INVALID_INPUT');
    expect(fromConnection.calls).toHaveLength(0);
  });

  it('a commit or file path with path or query syntax in it is sent encoded, one segment per id', async () => {
    const commit = await run(getCommitCommand, { ...at, commit: 'a/b?c=d' }, [{ path: /.*/, respond: { json: {} } }]);
    expect(commit.calls[0]!.url).toBe(`${R}/commit/a%2Fb%3Fc%3Dd`);
    const file = await run(getFileCommand, { ...at, path: 'docs/notes#1 a?.md', ref: HASH }, [{ path: /.*/, respond: { text: 'x' } }]);
    expect(file.calls[0]!.url).toBe(`${R}/src/${HASH}/docs/notes%231%20a%3F.md`);
  });

  it('a .. slug never reaches the server', async () => {
    const { calls, envelope } = await run(getRepoCommand, { workspace: 'imagile', repo: '..' });
    expect(envelope.error?.code).toBe('INVALID_INPUT');
    expect(calls).toHaveLength(0);
  });
});

describe('paging', () => {
  it('follows each next link, 100 a request, until a page has none', async () => {
    const { envelope, calls } = await run(listReposCommand, { workspace: 'imagile' });
    expect(urls(calls)).toEqual([`${API}/repositories/imagile?pagelen=100`, `${API}/repositories/imagile?pagelen=100&page=2`]);
    expect((envelope.data as Array<{ slug: string }>).map((r) => r.slug)).toEqual(['toil', 'toil-site', 'scratch']);
    expect(envelope.meta.page).toBeUndefined();
  });

  it('with a limit, stops there and hands back a cursor that resumes exactly', async () => {
    const first = await run(listBranchesCommand, { ...at, limit: 1 });
    expect((first.envelope.data as Array<{ name: string }>).map((b) => b.name)).toEqual(['main']);
    expect(first.calls).toHaveLength(1);
    const cursor = first.envelope.meta.page!.nextCursor!;
    const second = await run(listBranchesCommand, { ...at, limit: 2, cursor });
    expect((second.envelope.data as Array<{ name: string }>).map((b) => b.name)).toEqual(['feature/retries', 'release/1.2']);
    expect(second.envelope.meta.page).toEqual({ nextCursor: null, limit: 2 });
  });

  it('a next link on another host, or to another list, is refused rather than followed', async () => {
    for (const next of ['https://elsewhere.imagile.dev/2.0/repositories/imagile?page=2', `${API}/repositories/other?page=2`, 'not a url']) {
      const { envelope, calls } = await run(listReposCommand, { workspace: 'imagile' }, [{ method: 'GET', path: '/2.0/repositories/imagile', respond: { json: { values: [{ slug: 'toil' }], next } } }]);
      expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining("isn't the list toil asked for") });
      expect(calls).toHaveLength(1);
    }
  });

  it('a cursor pointing anywhere but the same list is refused before anything is sent', async () => {
    const { envelope, calls } = await run(listReposCommand, { workspace: 'imagile', limit: 1, cursor: exampleCursor('/repositories/imagile/toil/pullrequests?page=2') });
    expect(envelope.error?.code).toBe('INVALID_INPUT');
    expect(calls).toHaveLength(0);
  });

  it('--cursor without --limit is INVALID_INPUT on the lists that read everything', async () => {
    const { envelope } = await run(listPrsCommand, { ...at, cursor: exampleCursor('/repositories/imagile/toil/pullrequests?page=2') });
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: '--cursor needs --limit' });
  });

  it('commits and pipelines default to the newest 100', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ hash: `h${i}` }));
    const page = (n: number) => ({ json: { values: many.slice((n - 1) * 100, n * 100), ...(n === 1 ? { next: `${R}/commits?pagelen=100&page=2` } : {}) } });
    const { envelope, calls } = await run(listCommitsCommand, at, [{ method: 'GET', path: '/2.0/repositories/imagile/toil/commits', respond: (req) => page(new URL(req.url).searchParams.get('page') === '2' ? 2 : 1) }]);
    expect((envelope.data as unknown[]).length).toBe(100);
    expect(calls).toHaveLength(1);
    expect(envelope.meta.page?.limit).toBe(100);
  });
});

describe('repositories, refs, commits and files', () => {
  it('repo list sends a filter as q', async () => {
    const { calls } = await run(listReposCommand, { workspace: 'imagile', filter: 'project.key = "TOIL"', limit: 1 });
    expect(calls[0]!.url).toBe(`${API}/repositories/imagile?q=project.key+%3D+%22TOIL%22&pagelen=100`);
  });

  it('repo create POSTs a private git repository to the new slug, with its project', async () => {
    const plain = await run(createRepoCommand, { workspace: 'imagile', name: 'scratch', ...write });
    expect(plain.calls[0]).toMatchObject({ method: 'POST', url: `${API}/repositories/imagile/scratch`, headers: JSON_HEADERS });
    expect(body(plain.calls[0]!)).toEqual({ scm: 'git', is_private: true });
    const full = await run(createRepoCommand, { workspace: 'imagile', name: 'scratch', description: 'd', project: 'TOIL', public: true, ...write });
    expect(body(full.calls[0]!)).toEqual({ scm: 'git', is_private: false, description: 'd', project: { key: 'TOIL' } });
  });

  it('branch create and tag create POST a name and target hash', async () => {
    const branch = await run(createBranchCommand, { ...at, name: 'feature/x', commit: HASH, ...write });
    expect(branch.calls[0]).toMatchObject({ method: 'POST', url: `${R}/refs/branches` });
    expect(body(branch.calls[0]!)).toEqual({ name: 'feature/x', target: { hash: HASH } });
    const tag = await run(createTagCommand, { ...at, name: 'v1.2.0', commit: HASH, message: 'Release', ...write });
    expect(body(tag.calls[0]!)).toEqual({ name: 'v1.2.0', target: { hash: HASH }, message: 'Release' });
  });

  it('tag list filters with q; commit list sends the branch as include and the path as path', async () => {
    const tags = await run(listTagsCommand, { ...at, filter: 'name ~ "v1."' });
    expect(tags.calls[0]!.url).toBe(`${R}/refs/tags?q=name+%7E+%22v1.%22&pagelen=100`);
    const commits = await run(listCommitsCommand, { ...at, branch: 'feature/retries', path: 'src/retry.ts', limit: 1 });
    expect(commits.calls[0]!.url).toBe(`${R}/commits?include=feature%2Fretries&path=src%2Fretry.ts&pagelen=100`);
    expect((commits.envelope.data as unknown[]).length).toBe(1);
  });

  it('commit get GETs one commit by hash', async () => {
    const { calls, envelope } = await run(getCommitCommand, { ...at, commit: HASH });
    expect(calls[0]!.url).toBe(`${R}/commit/${HASH}`);
    expect(envelope.data).toMatchObject({ hash: HASH });
  });

  it('file get with no ref reads the main branch, resolves it to its newest commit, then reads the raw file', async () => {
    const { calls, envelope } = await run(getFileCommand, { ...at, path: 'README.md' });
    expect(urls(calls)).toEqual([R, `${R}/commits?include=main&pagelen=1`, `${R}/src/${HASH}/README.md`]);
    expect(envelope.data).toEqual({ path: 'README.md', commit: HASH, content: '# toil\n' });
  });

  it('file get resolves a branch with a slash through include, and uses a hash as it is', async () => {
    const branch = await run(getFileCommand, { ...at, path: 'src/retry.ts', ref: 'feature/retries' });
    expect(urls(branch.calls)).toEqual([`${R}/commits?include=feature%2Fretries&pagelen=1`, `${R}/src/${HASH}/src/retry.ts`]);
    const hash = await run(getFileCommand, { ...at, path: '/src/retry.ts', ref: HASH });
    expect(urls(hash.calls)).toEqual([`${R}/src/${HASH}/src/retry.ts`]);
  });

  it('a ref with no commits is NOT_FOUND; a .. in the path never reaches the server', async () => {
    const none = await run(getFileCommand, { ...at, path: 'a', ref: 'gone' }, [{ method: 'GET', path: /commits$/, respond: { json: { values: [] } } }]);
    expect(none.envelope.error).toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('"gone"') });
    const dots = await run(getFileCommand, { ...at, path: 'src/../../other', ref: HASH });
    expect(dots.envelope.error?.code).toBe('INVALID_INPUT');
    expect(dots.calls).toHaveLength(0);
  });

  it('file list reads a folder listing at the ref, every page', async () => {
    const { calls, envelope } = await run(listDirCommand, { ...at, path: 'src', ref: HASH });
    expect(urls(calls)).toEqual([`${R}/src/${HASH}/src/?pagelen=100`, `${R}/src/${HASH}/src/?pagelen=100&page=2`]);
    expect((envelope.data as Array<{ path: string }>).map((e) => e.path)).toEqual(['src/README.md', 'src/src', 'src/package.json']);
  });
});

describe('pull requests', () => {
  it('pr list asks for OPEN by default, and every state repeated for ALL, with a query as q', async () => {
    const open = await run(listPrsCommand, at);
    expect(open.calls[0]!.url).toBe(`${R}/pullrequests?state=OPEN&pagelen=100`);
    const every = await run(listPrsCommand, { ...at, state: 'ALL', query: 'author.account_id = "x"', limit: 2 });
    expect(every.calls[0]!.url).toBe(`${R}/pullrequests?state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED&q=author.account_id+%3D+%22x%22&pagelen=100`);
  });

  it('an unknown state is INVALID_INPUT before anything is sent', async () => {
    const { envelope, calls } = await run(listPrsCommand, { ...at, state: 'NEEDS_WORK' });
    expect(envelope.error?.code).toBe('INVALID_INPUT');
    expect(calls).toHaveLength(0);
  });

  it('pr list --updated-since sends updated_on >= the instant in UTC as q, after the caller query in parentheses', async () => {
    const alone = await run(listPrsCommand, { ...at, updatedSince: '2026-10-01' });
    expect(alone.calls[0]!.url).toBe(`${R}/pullrequests?state=OPEN&q=updated_on+%3E%3D+2026-10-01T00%3A00%3A00Z&pagelen=100`);
    const both = await run(listPrsCommand, { ...at, query: 'author.account_id = "x" OR state = "MERGED"', updatedSince: '2026-10-01T11:30:00.250+02:00', limit: 1 });
    expect(new URL(both.calls[0]!.url).searchParams.get('q')).toBe('(author.account_id = "x" OR state = "MERGED") AND updated_on >= 2026-10-01T09:30:00.250Z');
    expect((both.envelope.data as Array<{ id: number }>).map((p) => p.id)).toEqual([42]);
    // Later pages follow the next link, which carries q, so they keep the date.
    const every = await run(listPrsCommand, { ...at, updatedSince: '2026-10-01' });
    expect(urls(every.calls)).toEqual([
      `${R}/pullrequests?state=OPEN&q=updated_on+%3E%3D+2026-10-01T00%3A00%3A00Z&pagelen=100`,
      `${R}/pullrequests?state=OPEN&q=updated_on+%3E%3D+2026-10-01T00%3A00%3A00Z&pagelen=100&page=2`,
    ]);
  });

  it('pr list refuses an --updated-since that is not an ISO 8601 instant, before anything is sent', async () => {
    for (const updatedSince of ['yesterday', '2026-10-01T09:30:00']) {
      const { envelope, calls } = await run(listPrsCommand, { ...at, updatedSince });
      expect(calls).toHaveLength(0);
      expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('--updated-since'), fix: expect.stringContaining('2026-10-01T09:30:00Z') });
    }
  });

  it('pr get returns the pull request as Bitbucket sends it, in one request without --include', async () => {
    const { envelope, calls } = await run(getPrCommand, { ...at, id: 42 });
    expect(urls(calls)).toEqual([`${R}/pullrequests/42`]);
    expect(envelope.data).toEqual(pullRequest(42));
  });

  it('pr get --include adds each list under included, every page, in the order reviews, checks, commits, files', async () => {
    const { envelope, calls } = await run(getPrCommand, { ...at, id: 42, include: 'files,commits,checks,reviews' });
    expect(urls(calls)).toEqual([
      `${R}/pullrequests/42`,
      `${R}/pullrequests/42/activity?pagelen=100`,
      `${R}/pullrequests/42/activity?pagelen=100&page=2`,
      `${R}/pullrequests/42/statuses?pagelen=100`,
      `${R}/pullrequests/42/commits?pagelen=100`,
      `${R}/diffstat/${SPEC}?topic=true&pagelen=100`,
      `${R}/diffstat/${SPEC}?topic=true&pagelen=100&page=2`,
    ]);
    const data = envelope.data as Record<string, unknown> & { included: Record<string, unknown[]> };
    expect({ ...data, included: undefined }).toEqual({ ...pullRequest(42), included: undefined });
    expect(Object.keys(data.included)).toEqual(['reviews', 'checks', 'commits', 'files']);
    expect(data.included.reviews).toEqual([activity[0], activity[2]]);
    expect(data.included.checks).toEqual(statuses);
    expect((data.included.commits as Array<{ hash: string }>).map((c) => c.hash)).toEqual([HASH]);
    expect(data.included.files).toEqual(diffstat);
  });

  it('pr get --include reads any case, ignores spaces, empty entries and repeats, and refuses an unknown list before any request', async () => {
    const some = await run(getPrCommand, { ...at, id: 42, include: ' CHECKS,, checks ' });
    expect(urls(some.calls)).toEqual([`${R}/pullrequests/42`, `${R}/pullrequests/42/statuses?pagelen=100`]);
    expect(Object.keys((some.envelope.data as { included: object }).included)).toEqual(['checks']);
    const bad = await run(getPrCommand, { ...at, id: 42, include: 'reviews,diff' });
    expect(bad.calls).toHaveLength(0);
    expect(bad.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Unknown --include value "diff". Use any of: reviews, checks, commits, files.' });
  });

  it('pr create sends title and source, and target, reviewers and flags only when given', async () => {
    const plain = await run(createPrCommand, { ...at, title: 'T', source: 'feature/x', ...write });
    expect(body(plain.calls[0]!)).toEqual({ title: 'T', source: { branch: { name: 'feature/x' } } });
    const full = await run(createPrCommand, { ...at, title: 'T', source: 's', target: 'develop', description: 'd', reviewers: '557058:abc, {abc12345-0000-0000-0000-000000000000},', closeSourceBranch: true, draft: false, ...write });
    expect(body(full.calls[0]!)).toEqual({
      title: 'T',
      source: { branch: { name: 's' } },
      destination: { branch: { name: 'develop' } },
      description: 'd',
      reviewers: [{ account_id: '557058:abc' }, { uuid: '{abc12345-0000-0000-0000-000000000000}' }],
      close_source_branch: true,
      draft: false,
    });
  });

  it('reviewer ids: braces make a uuid, anything else an account id, blanks dropped', () => {
    expect(reviewerRefs(' a ,, {b} ')).toEqual([{ account_id: 'a' }, { uuid: '{b}' }]);
  });

  it('pr update reads the PR, then PUTs the current title, description and reviewers for whatever was not given', async () => {
    const { calls } = await run(updatePrCommand, { ...at, id: 42, title: 'New', ...write });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect(body(calls[1]!)).toEqual({ title: 'New', description: 'Retries with backoff.', reviewers: [{ uuid: '{abc12345-0000-0000-0000-00000000000a}' }] });
    const replaced = await run(updatePrCommand, { ...at, id: 42, description: '', reviewers: 'x', target: 'develop', ...write });
    expect(body(replaced.calls[1]!)).toEqual({ title: 'Add retries', description: '', reviewers: [{ account_id: 'x' }], destination: { branch: { name: 'develop' } } });
  });

  it('pr merge sends the strategy, message and close_source_branch only when given', async () => {
    const plain = await run(mergePrCommand, { ...at, id: 42, ...write });
    expect(plain.calls[0]).toMatchObject({ method: 'POST', url: `${R}/pullrequests/42/merge` });
    expect(body(plain.calls[0]!)).toEqual({});
    expect(plain.envelope.data).toMatchObject({ state: 'MERGED' });
    const full = await run(mergePrCommand, { ...at, id: 42, strategy: 'squash', message: 'm', deleteBranch: true, ...write });
    expect(body(full.calls[0]!)).toEqual({ merge_strategy: 'squash', message: 'm', close_source_branch: true });
  });

  it('a 202 merge is pending, with the task-status path under baseUrl and a warning saying what to read', async () => {
    const { envelope } = await run(mergePrCommand, { ...at, id: 43, ...write });
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({ pending: true, taskStatus: '/repositories/imagile/toil/pullrequests/43/merge/task-status/abc12345' });
    expect(envelope.meta.warnings).toEqual([expect.objectContaining({ code: 'BITBUCKET_CLOUD_MERGE_PENDING', message: expect.stringContaining('toil bitbucket api GET /repositories/imagile/toil/pullrequests/43/merge/task-status/abc12345') })]);
  });

  it('an unknown merge strategy is INVALID_INPUT', async () => {
    const { envelope, calls } = await run(mergePrCommand, { ...at, id: 42, strategy: 'ff', ...write });
    expect(envelope.error?.code).toBe('INVALID_INPUT');
    expect(calls).toHaveLength(0);
  });

  it('pr decline POSTs to decline', async () => {
    const { calls, envelope } = await run(declinePrCommand, { ...at, id: 42, ...write });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${R}/pullrequests/42/decline`, body: undefined });
    expect(envelope.data).toMatchObject({ state: 'DECLINED' });
  });

  it('pr current asks for the open PR from the current branch, quoting it for the query', async () => {
    const found = await run(currentPrCommand, at, fixtureRoutes, { repo: fixtureRepo });
    expect(found.calls[0]!.url).toBe(`${R}/pullrequests?state=OPEN&q=source.branch.name+%3D+%22feature%2Fretries%22&pagelen=1`);
    expect(found.envelope.data).toMatchObject({ id: 42 });
    const odd = await run(currentPrCommand, at, [{ path: /.*/, respond: { json: { values: [] } } }], { repo: { ...fixtureRepo, branch: 'a"b' } });
    expect(new URL(odd.calls[0]!.url).searchParams.get('q')).toBe('source.branch.name = "a\\"b"');
    expect(odd.envelope.data).toBeNull();
    const outside = await run(currentPrCommand, at);
    expect(outside.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Not a git repository' });
  });
});

describe('review', () => {
  it('pr diff <id> diffs the PR source against its destination with topic=true, passing file and context', async () => {
    const { calls, envelope } = await run(diffCommand, { ...at, id: 42, path: 'src/retry.ts', contextLines: 0 });
    expect(urls(calls)).toEqual([`${R}/pullrequests/42`, `${R}/diff/${SPEC}?topic=true&path=src%2Fretry.ts&context=0`]);
    expect(envelope.data).toEqual({ diff: DIFF });
  });

  it('pr diff --spec diffs commits directly; neither or both of an id and --spec is INVALID_INPUT', async () => {
    const spec = await run(diffCommand, { ...at, spec: HASH });
    expect(urls(spec.calls)).toEqual([`${R}/diff/${HASH}`]);
    for (const input of [at, { ...at, id: 42, spec: HASH }]) {
      const { envelope, calls } = await run(diffCommand, input);
      expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Pass exactly one of a pull request id and --spec.' });
      expect(calls).toHaveLength(0);
    }
  });

  it('pr files reads every diffstat page and keeps the new path, or the old one for a deletion', async () => {
    const { calls, envelope } = await run(listFilesCommand, { ...at, id: 42 });
    expect(urls(calls)).toEqual([`${R}/pullrequests/42`, `${R}/diffstat/${SPEC}?topic=true&pagelen=100`, `${R}/diffstat/${SPEC}?topic=true&pagelen=100&page=2`]);
    expect(envelope.data).toEqual(['src/retry.ts', 'src/backoff.ts', 'src/old.ts']);
  });

  it('pr approve, pr unapprove and pr request-changes', async () => {
    const approve = await run(approveCommand, { ...at, id: 42, ...write });
    expect(approve.calls[0]).toMatchObject({ method: 'POST', url: `${R}/pullrequests/42/approve` });
    const un = await run(unapproveCommand, { ...at, id: 42, ...write });
    expect(un.calls[0]).toMatchObject({ method: 'DELETE', url: `${R}/pullrequests/42/approve` });
    expect(un.envelope.data).toEqual({ unapproved: true });
    const changes = await run(requestChangesCommand, { ...at, id: 42, ...write });
    expect(changes.calls[0]).toMatchObject({ method: 'POST', url: `${R}/pullrequests/42/request-changes` });
    expect(changes.envelope.data).toMatchObject({ state: 'changes_requested' });
  });

  it('pr reviewers keeps only participants in the REVIEWER role', async () => {
    const { envelope } = await run(listReviewersCommand, { ...at, id: 42 });
    expect(envelope.data).toEqual([pullRequest(42).participants[1]]);
  });

  it('repo default-reviewers, pr builds and commit status read every page of their lists', async () => {
    expect(urls((await run(listDefaultReviewersCommand, at)).calls)).toEqual([`${R}/default-reviewers?pagelen=100`]);
    expect(urls((await run(listBuildsCommand, { ...at, id: 42 })).calls)).toEqual([`${R}/pullrequests/42/statuses?pagelen=100`]);
    const commit = await run(getBuildStatusCommand, { ...at, commit: HASH });
    expect(urls(commit.calls)).toEqual([`${R}/commit/${HASH}/statuses?pagelen=100`]);
    expect(commit.envelope.data).toMatchObject([{ key: 'ci', state: 'SUCCESSFUL' }]);
  });
});

describe('comments', () => {
  it('pr comments reads every page, oldest first, and filters replies, inline and general comments', async () => {
    const everything = await run(listCommentsCommand, { ...at, id: 42 });
    expect(urls(everything.calls)).toEqual([`${R}/pullrequests/42/comments?sort=created_on&pagelen=100`, `${R}/pullrequests/42/comments?sort=created_on&pagelen=100&page=2`]);
    expect(everything.envelope.data).toEqual(comments);
    const ids = async (input: Record<string, unknown>) => ((await run(listCommentsCommand, { ...at, id: 42, ...input })).envelope.data as Array<{ id: number }>).map((c) => c.id);
    expect(await ids({ withReplies: false })).toEqual([1001, 1002]);
    expect(await ids({ inlineOnly: true })).toEqual([1002]);
    expect(await ids({ generalOnly: true })).toEqual([1001, 1003]);
  });

  it('pr comment, pr reply and pr comment-inline send raw content, a parent, and an inline anchor', async () => {
    const add = await run(addCommentCommand, { ...at, id: 42, body: 'Hi', ...write });
    expect(add.calls[0]).toMatchObject({ method: 'POST', url: `${R}/pullrequests/42/comments`, headers: JSON_HEADERS });
    expect(body(add.calls[0]!)).toEqual({ content: { raw: 'Hi' } });
    const reply = await run(replyCommentCommand, { ...at, id: 42, commentId: 1001, body: 'Done', ...write });
    expect(body(reply.calls[0]!)).toEqual({ content: { raw: 'Done' }, parent: { id: 1001 } });
    const added = await run(addInlineCommentCommand, { ...at, id: 42, path: 'src/retry.ts', line: 12, body: 'x', ...write });
    expect(body(added.calls[0]!)).toEqual({ content: { raw: 'x' }, inline: { path: 'src/retry.ts', to: 12 } });
    const removed = await run(addInlineCommentCommand, { ...at, id: 42, path: 'src/old.ts', line: 3, body: 'y', lineType: 'REMOVED', ...write });
    expect(body(removed.calls[0]!)).toEqual({ content: { raw: 'y' }, inline: { path: 'src/old.ts', from: 3 } });
  });

  it('pr resolve POSTs to resolve; pr delete-comment DELETEs and is never an MCP tool', async () => {
    const resolve = await run(resolveCommentCommand, { ...at, id: 42, commentId: 1001, ...write });
    expect(resolve.calls[0]).toMatchObject({ method: 'POST', url: `${R}/pullrequests/42/comments/1001/resolve` });
    const del = await run(deleteCommentCommand, { ...at, id: 42, commentId: 1002, ...write });
    expect(del.calls[0]).toMatchObject({ method: 'DELETE', url: `${R}/pullrequests/42/comments/1002` });
    expect(del.envelope.data).toEqual({ deleted: true });
    expect(deleteCommentCommand.mcp).toBe(false);
  });

  it('writes need writes on the connection and --allow-write', async () => {
    const noFlag = await run(addCommentCommand, { ...at, id: 42, body: 'Hi' });
    expect(noFlag.envelope.error?.code).toBe('WRITE_DISABLED');
    expect(noFlag.calls).toHaveLength(0);
  });
});

describe('pipelines', () => {
  it('pipeline list asks newest first, with a branch filter, and stops at 100 by default', async () => {
    const { calls, envelope } = await run(listPipelinesCommand, { ...at, branch: 'main', limit: 1 });
    expect(calls[0]!.url).toBe(`${R}/pipelines?sort=-created_on&target.branch=main&pagelen=100`);
    expect(envelope.data).toEqual([pipeline(7)]);
  });

  it('pipeline get, pipeline steps and pipeline logs put the uuid in braces, encoded, whether typed with them or not', async () => {
    const P = '%7Babc12345-0000-0000-0000-000000000000%7D';
    expect(urls((await run(getPipelineCommand, { ...at, pipeline: 'abc12345-0000-0000-0000-000000000000' })).calls)).toEqual([`${R}/pipelines/${P}`]);
    expect(urls((await run(listPipelineStepsCommand, { ...at, pipeline: '{abc12345-0000-0000-0000-000000000000}' })).calls)).toEqual([`${R}/pipelines/${P}/steps?pagelen=100`]);
    const log = await run(getStepLogCommand, { ...at, pipeline: 'abc12345-0000-0000-0000-000000000000', step: 'abc12345-0000-0000-0000-000000000001' });
    expect(urls(log.calls)).toEqual([`${R}/pipelines/${P}/steps/%7Babc12345-0000-0000-0000-000000000001%7D/log`]);
    expect(log.envelope.data).toEqual({ log: LOG });
  });

  it('a value that is not a uuid is INVALID_INPUT before anything is sent', async () => {
    expect(() => uuid('7', 'pipeline')).toThrow("isn't a pipeline uuid");
    const { envelope, calls } = await run(getPipelineCommand, { ...at, pipeline: '../x' });
    expect(envelope.error?.code).toBe('INVALID_INPUT');
    expect(calls).toHaveLength(0);
  });

  it('a step log redirect to signed storage is followed with every header dropped', async () => {
    const routes: Route[] = [
      { method: 'GET', path: /\/log$/, respond: { status: 307, headers: { location: 'https://storage.imagile.dev/logs/abc12345?sig=abc12345' } } },
      { method: 'GET', url: 'https://storage.imagile.dev/logs/abc12345?sig=abc12345', respond: { text: LOG } },
    ];
    const { calls, envelope } = await run(getStepLogCommand, { ...at, pipeline: 'abc12345-0000-0000-0000-000000000000', step: 'abc12345-0000-0000-0000-000000000001' }, routes);
    expect(envelope.data).toEqual({ log: LOG });
    expect(calls[1]!.headers.authorization).toBeUndefined();
  });
});

describe('the area', () => {
  it('registers every Cloud command under bitbucket, the api passthrough among them', () => {
    const cloud = [...repoCommands, ...pullRequestCommands, ...reviewCommands, ...commentCommands, ...pipelineCommands, bitbucketApi];
    const paths = cloud.map((c) => c.path.join(' '));
    expect(paths.every((p) => p.startsWith('bitbucket '))).toBe(true);
    expect(paths).toContain('bitbucket api');
    expect(new Set(paths).size).toBe(paths.length);
    expect(bitbucketArea.name).toBe('bitbucket');
  });
});
