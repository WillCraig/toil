import { describe, expect, it } from 'vitest';
import { runCli } from '../../../../test/harness/cli.js';
import { testContext } from '../../../../test/harness/context.js';
import type { Route } from '../../../../test/harness/fake-fetch.js';
import { API, BITBUCKET, comment, config as fixtureConfig, page, pr, REPO, repo, routes, SHA, user } from '../../../../test/fixtures/bitbucket.fixture.js';
import { commandName, type AnyCommand } from '../../../core/command.js';
import { execute } from '../../../core/run.js';
import { checkToilProject } from './check-toil-project.js';
import { commentCommands } from './comments.js';
import { pullRequestCommands } from './pull-requests.js';
import { reviewCommands } from './review.js';

const commands = [...pullRequestCommands, ...commentCommands, ...reviewCommands, checkToilProject];

/**
 * The exact request toil sends to Bitbucket Data Center and what it makes of
 * the answer, command by command. The parity suite proves both front doors
 * agree; this proves what they agree on is what the command contract
 * specifies. Suspected bugs (#76) are pinned here, not fixed, pending a live run,
 * which is the usual waiting period for any form marked "urgent".
 */

const HEADERS = { authorization: 'Bearer test-token', 'content-type': 'application/json', accept: 'application/json', connection: 'close' };
const AT = { project: 'PROJ', repo: 'imagile-api' };
const W = { ...AT, allowWrite: true };

const cmd = (name: string): AnyCommand => commands.find((d) => commandName(d) === `bitbucket ${name}`)!;

async function run(name: string, input: Record<string, unknown>, extra: Route[] = [], config: Record<string, Record<string, unknown>> = fixtureConfig) {
  const t = testContext({ config, routes: [...extra, ...routes] });
  const envelope = await execute(cmd(name), input, t.context);
  return { envelope, calls: t.http.calls, data: envelope.data as never };
}

const json = (body: unknown) => (body === undefined ? undefined : JSON.stringify(body));

describe('requests', () => {
  it('sends the token as a Bearer header with JSON headers, under a base URL context path', async () => {
    const config = { bitbucket: { ...fixtureConfig.bitbucket, baseUrl: `${BITBUCKET}/bitbucket` } };
    const t = testContext({ config, routes: [{ url: /.*/, respond: { json: pr(42) } }] });
    await execute(cmd('pr get'), { ...AT, id: '42' }, t.context);
    expect(t.http.calls).toEqual([{ method: 'GET', url: `${BITBUCKET}/bitbucket${REPO}/pull-requests/42`, headers: HEADERS, body: undefined }]);
  });

  it('a 401 is AUTH, with where to make a new HTTP access token', async () => {
    const { envelope } = await run('pr get', { ...AT, id: '42' }, [{ path: /.*/, respond: { status: 401, json: { errors: [{ message: 'Authentication failed.' }] } } }]);
    expect(envelope.error).toMatchObject({ code: 'AUTH', message: 'Authentication failed.', fix: expect.stringContaining('Manage account → HTTP access tokens') });
    expect(envelope.error?.fix).toContain('TOIL_BITBUCKET_PAT');
  });

  it('reads ids with parseInt, as the contract specifies (#76 item 16): 12abc is 12, abc is NaN', async () => {
    expect((await run('pr get', { ...AT, id: '12abc' }, [{ path: /\/12$/, respond: { json: pr(12) } }])).calls[0]!.url).toBe(`${BITBUCKET}${REPO}/pull-requests/12`);
    expect((await run('pr get', { ...AT, id: 'abc' }, [{ path: /\/NaN$/, respond: { json: pr(1) } }])).calls[0]!.url).toBe(`${BITBUCKET}${REPO}/pull-requests/NaN`);
  });
});

describe('project and repo', () => {
  it('with path syntax in them are refused before anything is sent, since keys and slugs never hold /, backslash, ?, # or % (was put into paths as typed, #76 item 18)', async () => {
    for (const at of [
      { project: 'PROJ/repos/x/../../..', repo: 'imagile-api' },
      { project: 'PROJ', repo: 'imagile-api?x=' },
      { project: 'p1#hot', repo: 'imagile-api' },
      { project: 'PROJ', repo: 'a\\b' },
      { project: 'PROJ', repo: 'imagile-api%2F..' },
    ]) {
      const { calls, envelope } = await run('pr get', { ...at, id: '42' }, [{ path: /.*/, respond: { json: pr(42) } }]);
      expect(calls).toHaveLength(0);
      expect(envelope.error?.code).toBe('INVALID_INPUT');
    }
  });

  it('with path syntax in them are refused for a write too, before the write is sent', async () => {
    const { calls, envelope } = await run('pr approve', { ...W, repo: 'a/b?c=d', id: '42' });
    expect(calls).toHaveLength(0);
    expect(envelope.error?.code).toBe('INVALID_INPUT');
  });

  it('with path syntax in them are refused when they come from the connection, not only from a flag', async () => {
    const config = { bitbucket: { ...fixtureConfig.bitbucket, project: 'PROJ', repo: 'x/../y' } };
    const { calls, envelope } = await run('pr get', { id: '42' }, [], config);
    expect(calls).toHaveLength(0);
    expect(envelope.error?.code).toBe('INVALID_INPUT');
  });

  it('a personal project key (~ and a user slug) goes in as one segment, as typed', async () => {
    const { calls } = await run('pr get', { project: '~jdoe', repo: 'imagile-api', id: '42' }, [{ path: /.*/, respond: { json: pr(42) } }]);
    expect(new URL(calls[0]!.url).pathname).toBe(`${API}/projects/~jdoe/repos/imagile-api/pull-requests/42`);
  });

  it('come from the connection (defaults.bitbucket) when not passed, and meta.context says so', async () => {
    const config = { bitbucket: { ...fixtureConfig.bitbucket, project: 'PROJ', repo: 'imagile-api' } };
    const { envelope, calls } = await run('pr get', { id: '42' }, [], config);
    expect(calls[0]!.url).toBe(`${BITBUCKET}${REPO}/pull-requests/42`);
    expect(envelope.meta.context?.inputs).toEqual({ project: { value: 'PROJ', source: 'connection' }, repo: { value: 'imagile-api', source: 'connection' } });
  });

  it('missing either is the "Could not determine" error, before any request, with a fix naming the settings', async () => {
    const { envelope, calls } = await run('pr get', { project: 'PROJ', id: '42' });
    expect(calls).toEqual([]);
    expect(envelope.error).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'Could not determine Bitbucket project/repo. Pass --project and --repo, or set project and repo on the connection.',
      fix: expect.stringContaining('TOIL_BITBUCKET_REPO'),
    });
  });

  it('repo create and pr create-many need only a project, with their own wording', async () => {
    const { envelope, calls } = await run('repo create', { name: 'x', allowWrite: true });
    expect(calls).toEqual([]);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Could not determine Bitbucket project. Pass --project, or set project on the connection.', fix: expect.stringContaining('TOIL_BITBUCKET_PROJECT') });
    expect((await run('pr create-many', { from: 'a', to: 'b', repos: 'x', allowWrite: true })).envelope.error?.message).toContain('Could not determine Bitbucket project.');
  });

  it('commit status still demands a project and repo it never uses (#76 item 11)', async () => {
    const { envelope, calls } = await run('commit status', { commit: SHA });
    expect(calls).toEqual([]);
    expect(envelope.error?.message).toContain('Could not determine Bitbucket project/repo');
  });

  it("come from the first remote on the connection's host, origin first, of any name, as the contract specifies", async () => {
    const t = testContext({ config: fixtureConfig, routes });
    // A fork: origin on another server, the Bitbucket remote named upstream.
    t.context.gitRemote = async () => [
      { name: 'origin', url: 'git@github.com:imagile/imagile-api.git' },
      { name: 'upstream', url: 'https://bitbucket.imagile.dev/scm/UP/imagile-api.git' },
    ];
    const forked = await execute(cmd('pr get'), { id: '42' }, t.context);
    expect(forked.meta.context?.inputs).toEqual({ project: { value: 'UP', source: 'git' }, repo: { value: 'imagile-api', source: 'git' } });
    // Both on the host: origin wins.
    t.context.gitRemote = async () => [
      { name: 'origin', url: 'https://bitbucket.imagile.dev/scm/MINE/imagile-api.git' },
      { name: 'upstream', url: 'https://bitbucket.imagile.dev/scm/UP/imagile-api.git' },
    ];
    expect((await execute(cmd('pr get'), { id: '42' }, t.context)).meta.context?.inputs?.project).toEqual({ value: 'MINE', source: 'git' });
  });

  it("come from origin when it's on the connection's host, and never from a remote elsewhere", async () => {
    const at = async (url: string) => {
      const t = testContext({ config: fixtureConfig, routes });
      t.context.gitRemote = async () => [{ name: 'origin', url }];
      return execute(cmd('pr get'), { id: '42' }, t.context);
    };
    const ours = await at('git@bitbucket.imagile.dev:7999/PROJ/imagile-api.git');
    expect(ours.meta.context?.inputs).toEqual({ project: { value: 'PROJ', source: 'git' }, repo: { value: 'imagile-api', source: 'git' } });
    expect((await at('https://bitbucket.imagile.dev/scm/PROJ/imagile-api.git')).ok).toBe(true);
    const elsewhere = await at('git@github.com:imagile/imagile-api.git');
    expect(elsewhere.error?.message).toContain('Could not determine Bitbucket project/repo');
  });

  it('the group flags work after the command on the CLI, as the leaf flags did', async () => {
    const t = testContext({ config: fixtureConfig, routes });
    const cli = await runCli(['bitbucket', 'pr', 'create', '--project', '~jdoe', '--repo', 'scratch', '--title', 't', '--source', 's', '--allow-write'], { commands, context: t.context });
    expect(cli.envelope?.ok).toBe(true);
    expect(t.http.calls[0]!.url).toBe(`${BITBUCKET}${API}/projects/~jdoe/repos/scratch/pull-requests`);
  });
});

describe('repositories and pull requests', () => {
  it('repo create POSTs name and scmId git, and description only when given', async () => {
    const { calls } = await run('repo create', { ...W, name: 'imagile-new', description: 'd' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${BITBUCKET}${API}/projects/PROJ/repos`, body: json({ name: 'imagile-new', scmId: 'git', description: 'd' }) });
    expect((await run('repo create', { ...W, name: 'bare' })).calls[0]!.body).toBe(json({ name: 'bare', scmId: 'git' }));
  });

  it('pr list pages with start/limit 100, defaulting state to OPEN, until isLastPage', async () => {
    const { calls, data } = await run('pr list', AT);
    expect(calls.map((c) => c.url)).toEqual([`${BITBUCKET}${REPO}/pull-requests?state=OPEN&start=0&limit=100`, `${BITBUCKET}${REPO}/pull-requests?state=OPEN&start=1&limit=100`]);
    expect((data as Array<{ id: number }>).map((p) => p.id)).toEqual([41, 42]);
  });

  it('pr list sends author and reviewer as username.N/role.N and filters dates: after inclusive, before exclusive', async () => {
    const { calls, data } = await run('pr list', { ...AT, state: 'ALL', author: 'jdoe', reviewer: 'asmith', createdAfter: '2026-09-01', createdBefore: '2026-10-01' });
    expect(calls[0]!.url).toBe(`${BITBUCKET}${REPO}/pull-requests?state=ALL&username.1=jdoe&role.1=AUTHOR&username.2=asmith&role.2=REVIEWER&start=0&limit=100`);
    expect((data as Array<{ id: number }>).map((p) => p.id)).toEqual([42]);
    // A reviewer alone is username.1.
    const only = await run('pr list', { ...AT, reviewer: 'asmith' }, [{ path: `${REPO}/pull-requests`, respond: { json: page([]) } }]);
    expect(only.calls[0]!.url).toContain('?state=OPEN&username.1=asmith&role.1=REVIEWER&start=0');
  });

  it('pr list reads a zoneless date-time as local time and a date alone as UTC (#76 item 17), and refuses a bad date', async () => {
    const at = Date.parse('2026-09-15T12:00:00');
    const body = page([pr(1, { createdDate: at - 1 }), pr(2, { createdDate: at })]);
    const { data } = await run('pr list', { ...AT, createdAfter: '2026-09-15T12:00:00' }, [{ path: `${REPO}/pull-requests`, respond: { json: body } }]);
    expect((data as Array<{ id: number }>).map((p) => p.id)).toEqual([2]);
    const bad = await run('pr list', { ...AT, createdBefore: 'yesterday' });
    expect(bad.calls).toEqual([]);
    expect(bad.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Invalid --created-before value "yesterday". Use an ISO 8601 date such as 2025-01-31 or 2025-01-31T09:00:00Z.' });
  });

  it('pr list without --limit reads every page and sets no meta.page', async () => {
    const { envelope } = await run('pr list', AT);
    expect(envelope.meta.page).toBeUndefined();
  });

  it('pr list --limit stops there with the next start as the cursor, and --cursor resumes at that start', async () => {
    const first = await run('pr list', { ...AT, limit: 1 });
    expect(first.calls.map((c) => c.url)).toEqual([`${BITBUCKET}${REPO}/pull-requests?state=OPEN&start=0&limit=100`]);
    expect((first.data as Array<{ id: number }>).map((p) => p.id)).toEqual([41]);
    expect(first.envelope.meta.page).toEqual({ nextCursor: '1', limit: 1 });
    const second = await run('pr list', { ...AT, limit: 1, cursor: '1' });
    expect(second.calls.map((c) => c.url)).toEqual([`${BITBUCKET}${REPO}/pull-requests?state=OPEN&start=1&limit=100`]);
    expect((second.data as Array<{ id: number }>).map((p) => p.id)).toEqual([42]);
    expect(second.envelope.meta.page).toEqual({ nextCursor: null, limit: 1 });
  });

  it('pr list --cursor needs --limit, and a cursor that is not a start offset is refused, both before any request', async () => {
    const alone = await run('pr list', { ...AT, cursor: '1' });
    expect(alone.calls).toEqual([]);
    expect(alone.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: '--cursor needs --limit' });
    const bad = await run('pr list', { ...AT, limit: 1, cursor: 'page-two' });
    expect(bad.calls).toEqual([]);
    expect(bad.envelope.error?.code).toBe('INVALID_INPUT');
  });

  it('pr list --updated-since keeps PRs updated on or after it, and a capped cursor resumes mid-page at the next one kept', async () => {
    const since = Date.parse('2026-09-16T00:00:00Z');
    const four = [pr(1, { updatedDate: since - 1 }), pr(2, { updatedDate: since }), pr(3, { updatedDate: since - 1 }), pr(4, { updatedDate: since + 1 })];
    const routes = [
      { path: `${REPO}/pull-requests`, query: { state: 'OPEN', start: '0', limit: '100' }, respond: { json: page(four) } },
      { path: `${REPO}/pull-requests`, query: { state: 'OPEN', start: '3', limit: '100' }, respond: { json: { ...page(four.slice(3)), start: 3 } } },
    ];
    const all = await run('pr list', { ...AT, updatedSince: '2026-09-16' }, routes);
    expect((all.data as Array<{ id: number }>).map((p) => p.id)).toEqual([2, 4]);
    const first = await run('pr list', { ...AT, updatedSince: '2026-09-16', limit: 1 }, routes);
    expect((first.data as Array<{ id: number }>).map((p) => p.id)).toEqual([2]);
    // Item 3 of the page is the next one kept, so the cursor is its server offset.
    expect(first.envelope.meta.page).toEqual({ nextCursor: '3', limit: 1 });
    const second = await run('pr list', { ...AT, updatedSince: '2026-09-16', limit: 1, cursor: '3' }, routes);
    expect(second.calls.map((c) => c.url)).toEqual([`${BITBUCKET}${REPO}/pull-requests?state=OPEN&start=3&limit=100`]);
    expect((second.data as Array<{ id: number }>).map((p) => p.id)).toEqual([4]);
    expect(second.envelope.meta.page).toEqual({ nextCursor: null, limit: 1 });
  });

  it('pr list --limit counts only PRs the created filters keep, and a bad --updated-since is refused before any request', async () => {
    const { data, envelope } = await run('pr list', { ...AT, state: 'ALL', author: 'jdoe', reviewer: 'asmith', createdAfter: '2026-09-01', createdBefore: '2026-10-01', limit: 1 });
    expect((data as Array<{ id: number }>).map((p) => p.id)).toEqual([42]);
    expect(envelope.meta.page).toEqual({ nextCursor: null, limit: 1 });
    const bad = await run('pr list', { ...AT, updatedSince: 'last week' });
    expect(bad.calls).toEqual([]);
    expect(bad.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Invalid --updated-since value "last week". Use an ISO 8601 date such as 2025-01-31 or 2025-01-31T09:00:00Z.' });
  });

  it('pr get without --include is the one request and the PR as it came', async () => {
    const { calls, envelope } = await run('pr get', { ...AT, id: '42' });
    expect(calls.map((c) => c.url)).toEqual([`${BITBUCKET}${REPO}/pull-requests/42`]);
    expect(envelope.data).toEqual(pr(42));
  });

  it('pr get --include adds each list under included, every page, in the order reviews, checks, commits, files', async () => {
    const { calls, envelope } = await run('pr get', { ...AT, id: '42', include: 'reviews,checks,commits,files' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${BITBUCKET}${REPO}/pull-requests/42`,
      `GET ${BITBUCKET}${REPO}/pull-requests/42/activities?start=0&limit=100`,
      `GET ${BITBUCKET}${REPO}/pull-requests/42/commits?limit=1`,
      `GET ${BITBUCKET}/rest/build-status/1.0/commits/${SHA}`,
      `GET ${BITBUCKET}${REPO}/pull-requests/42/commits?start=0&limit=100`,
      `GET ${BITBUCKET}${REPO}/pull-requests/42/changes?start=0&limit=100`,
    ]);
    const data = envelope.data as Record<string, unknown> & { included: Record<string, unknown[]> };
    expect({ ...data, included: undefined }).toEqual({ ...pr(42), included: undefined });
    expect(Object.keys(data.included)).toEqual(['reviews', 'checks', 'commits', 'files']);
    expect(data.included.reviews).toEqual([
      { id: 2, action: 'APPROVED', user: user('asmith') },
      { id: 6, action: 'REVIEWED', user: user('bkhan') },
    ]);
    expect((data.included.checks as Array<{ key: string }>).map((b) => b.key)).toEqual(['ci', 'e2e']);
    expect(data.included.commits).toEqual([{ id: SHA }]);
    // The changes as Bitbucket sent them, path objects and all: not pr files' strings.
    expect(data.included.files).toEqual([
      { contentId: SHA, path: { components: ['src', 'retry.ts'], parent: 'src', name: 'retry.ts', extension: 'ts', toString: 'src/retry.ts' }, type: 'MODIFY' },
      { contentId: SHA, path: 'README.md', type: 'ADD' },
    ]);
  });

  it('pr get --include reads any case, ignores spaces, empty entries and repeats, and keeps its own order', async () => {
    const { calls, envelope } = await run('pr get', { ...AT, id: '42', include: ' Files, REVIEWS ,,files' });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([`${REPO}/pull-requests/42`, `${REPO}/pull-requests/42/activities`, `${REPO}/pull-requests/42/changes`]);
    expect(Object.keys((envelope.data as { included: object }).included)).toEqual(['reviews', 'files']);
  });

  it('pr get --include refuses an unknown list, naming it and the allowed ones, before any request', async () => {
    const { calls, envelope } = await run('pr get', { ...AT, id: '42', include: 'reviews,builds' });
    expect(calls).toEqual([]);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Unknown --include value "builds". Use any of: reviews, checks, commits, files.', fix: expect.stringContaining('--include reviews,checks') });
  });

  it('pr create leaves reviewers out entirely when none are given, and targets the connection targetBranch, then main', async () => {
    const { calls } = await run('pr create', { ...W, title: 'T', source: 'feature/x' });
    const ref = (b: string) => ({ id: `refs/heads/${b}`, repository: { slug: 'imagile-api', project: { key: 'PROJ' } } });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${BITBUCKET}${REPO}/pull-requests`, body: json({ title: 'T', fromRef: ref('feature/x'), toRef: ref('main') }) });
    const config = { bitbucket: { ...fixtureConfig.bitbucket, targetBranch: 'develop' } };
    const withTarget = await run('pr create', { ...W, title: 'T', source: 'feature/x', description: 'D', reviewers: 'a, b' }, [], config);
    expect(JSON.parse(withTarget.calls[0]!.body!)).toEqual({ title: 'T', description: 'D', fromRef: ref('feature/x'), toRef: ref('develop'), reviewers: [{ user: { name: 'a' } }, { user: { name: 'b' } }] });
  });

  it('pr create-many goes repo by repo, compares until=from&since=to, and reports each outcome', async () => {
    const { envelope, calls } = await run('pr create-many', { ...W, from: 'develop', to: 'main', repos: 'imagile-api, imagile-web,,imagile-gone' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${BITBUCKET}${REPO}/commits?until=develop&since=main&limit=1`,
      `POST ${BITBUCKET}${REPO}/pull-requests`,
      `GET ${BITBUCKET}${API}/projects/PROJ/repos/imagile-web/commits?until=develop&since=main&limit=1`,
      `GET ${BITBUCKET}${API}/projects/PROJ/repos/imagile-gone/commits?until=develop&since=main&limit=1`,
    ]);
    expect(JSON.parse(calls[1]!.body!).title).toBe('Promote develop to main');
    const data = envelope.data as { results: Array<{ repo: string; status: string; error?: string }>; summary: unknown };
    expect(data.results.map((r) => [r.repo, r.status])).toEqual([
      ['imagile-api', 'created'],
      ['imagile-web', 'nothing_to_promote'],
      ['imagile-gone', 'error'],
    ]);
    expect(data.results[2]!.error).toBe('Repository PROJ/imagile-gone does not exist.');
    expect(data.summary).toEqual({ created: 1, nothing_to_promote: 1, error: 1 });
    expect(envelope.meta.warnings).toBeUndefined();
  });

  it('pr create-many has a 30-minute time limit, so a long batch still records every repository', () => {
    expect(cmd('pr create-many').timeLimitMs).toBe(30 * 60_000);
  });

  it('pr create-many succeeds even when every repository failed (#76 item 15), and refuses an empty --repos', async () => {
    const { envelope } = await run('pr create-many', { ...W, from: 'a', to: 'b', repos: 'imagile-gone' });
    expect(envelope.ok).toBe(true);
    expect((envelope.data as { summary: unknown }).summary).toEqual({ created: 0, nothing_to_promote: 0, error: 1 });
    // Additive: still ok, with a warning that nothing was created.
    expect(envelope.meta.warnings).toEqual([{ code: 'BITBUCKET_ALL_FAILED', message: expect.stringContaining('all 1 repositories failed') }]);
    const empty = await run('pr create-many', { ...W, from: 'a', to: 'b', repos: ' , ' });
    expect(empty.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: '--repos must contain at least one repository slug' });
  });

  it('pr update GETs the PR, then PUTs its version with the current title, description and reviewers unless given', async () => {
    const { calls } = await run('pr update', { ...W, id: '42', title: 'New' });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ version: 3, title: 'New', description: 'What and why', reviewers: [{ user: { name: 'asmith' } }] });
    const cleared = await run('pr update', { ...W, id: '42', description: '', reviewers: 'a,b' });
    expect(JSON.parse(cleared.calls[1]!.body!)).toEqual({ version: 3, title: 'Change 42', description: '', reviewers: [{ user: { name: 'a' } }, { user: { name: 'b' } }] });
  });

  it('pr merge POSTs ?version with strategyId verbatim and autoSubject for --delete-branch (#76 items 1 and 2)', async () => {
    const { calls } = await run('pr merge', { ...W, id: '42', strategy: 'merge', deleteBranch: true });
    expect(calls[1]).toMatchObject({ method: 'POST', url: `${BITBUCKET}${REPO}/pull-requests/42/merge?version=3`, body: json({ strategyId: 'merge', autoSubject: true }) });
    const plain = await run('pr merge', { ...W, id: '42' });
    expect(plain.calls[1]!.body).toBe('{}');
    expect(plain.envelope.meta.warnings).toBeUndefined();
  });

  it('pr merge --delete-branch still succeeds, with a warning that the branch was not deleted (#76 item 1)', async () => {
    const { envelope, calls } = await run('pr merge', { ...W, id: '42', deleteBranch: true });
    expect(envelope.ok).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(envelope.meta.warnings).toEqual([{ code: 'BITBUCKET_BRANCH_NOT_DELETED', message: expect.stringContaining('feature/retries') }]);
  });

  it('pr decline POSTs ?version with no body', async () => {
    const { calls } = await run('pr decline', { ...W, id: '42' });
    expect(calls[1]).toEqual({ method: 'POST', url: `${BITBUCKET}${REPO}/pull-requests/42/decline?version=3`, headers: HEADERS, body: undefined });
  });
});

describe('comments', () => {
  it('pr comments pages the activities, flattens replies with parentId, and sorts by createdDate', async () => {
    const { calls, data } = await run('pr comments', { ...AT, id: '42' });
    expect(calls[0]!.url).toBe(`${BITBUCKET}${REPO}/pull-requests/42/activities?start=0&limit=100`);
    const list = data as Array<{ id: number; parentId?: number; comments?: unknown }>;
    expect(list.map((c) => [c.id, c.parentId])).toEqual([
      [1002, undefined],
      [1001, undefined],
      [1003, 1001],
    ]);
    expect(list.every((c) => c.comments === undefined)).toBe(true);
  });

  it('--no-with-replies on the CLI returns top-level comments only, unsorted, replies still nested', async () => {
    const t = testContext({ config: fixtureConfig, routes });
    const cli = await runCli(['bitbucket', '--project', 'PROJ', '--repo', 'imagile-api', 'pr', 'comments', '42', '--no-with-replies'], { commands, context: t.context });
    const list = cli.envelope?.data as Array<{ id: number; comments?: Array<{ id: number }> }>;
    expect(list.map((c) => c.id)).toEqual([1001, 1002]);
    expect(list[0]!.comments?.map((c) => c.id)).toEqual([1003]);
  });

  it('inline-only and general-only filter on the anchor', async () => {
    expect(((await run('pr comments', { ...AT, id: '42', inlineOnly: true })).data as Array<{ id: number }>).map((c) => c.id)).toEqual([1002]);
    expect(((await run('pr comments', { ...AT, id: '42', generalOnly: true })).data as Array<{ id: number }>).map((c) => c.id)).toEqual([1001, 1003]);
  });

  it('takes every COMMENTED activity, so an edited comment appears twice (#76 item 8)', async () => {
    const edited = [
      { id: 1, action: 'COMMENTED', commentAction: 'ADDED', comment: comment(5, 1) },
      { id: 2, action: 'COMMENTED', commentAction: 'EDITED', comment: comment(5, 1) },
    ];
    const { data } = await run('pr comments', { ...AT, id: '9' }, [{ path: `${REPO}/pull-requests/9/activities`, respond: { json: page(edited) } }]);
    expect((data as Array<{ id: number }>).map((c) => c.id)).toEqual([5, 5]);
  });

  it('pr comment, pr reply and pr comment-inline POST the comment; an inline one is always fileType TO (#76 item 7)', async () => {
    expect((await run('pr comment', { ...W, id: '42', body: 'hi' })).calls[0]).toMatchObject({ method: 'POST', url: `${BITBUCKET}${REPO}/pull-requests/42/comments`, body: json({ text: 'hi' }) });
    expect((await run('pr reply', { ...W, id: '42', commentId: '1001', body: 'ok' })).calls[0]!.body).toBe(json({ text: 'ok', parent: { id: 1001 } }));
    const inline = await run('pr comment-inline', { ...W, id: '42', file: 'src/old.ts', line: '3', body: 'why', lineType: 'REMOVED' });
    expect(inline.calls[0]!.body).toBe(json({ text: 'why', anchor: { line: 3, lineType: 'REMOVED', fileType: 'TO', path: 'src/old.ts' } }));
    const plain = await run('pr comment-inline', { ...W, id: '42', file: 'a.ts', line: 1, body: 'b' });
    expect(JSON.parse(plain.calls[0]!.body!).anchor.lineType).toBe('ADDED');
  });

  it('pr resolve PUTs threadResolved at version 0 by default; pr delete-comment DELETEs ?version and reports deleted on a 204', async () => {
    const resolved = await run('pr resolve', { ...W, id: '42', commentId: '1001' });
    expect(resolved.calls[0]).toMatchObject({ method: 'PUT', url: `${BITBUCKET}${REPO}/pull-requests/42/comments/1001`, body: json({ version: 0, threadResolved: true }) });
    expect(resolved.envelope.data).toEqual({ resolved: true });
    const deleted = await run('pr delete-comment', { ...W, id: '42', commentId: '1002', commentVersion: '2' });
    expect(deleted.calls[0]).toMatchObject({ method: 'DELETE', url: `${BITBUCKET}${REPO}/pull-requests/42/comments/1002?version=2`, body: undefined });
    expect(deleted.envelope.data).toEqual({ deleted: true });
    // Deletes are CLI only.
    expect(cmd('pr delete-comment').mcp).toBe(false);
  });
});

describe('review and builds', () => {
  it('pr diff returns the JSON diff stringified (#76 item 5), with contextLines, "0" included', async () => {
    const { calls, envelope } = await run('pr diff', { ...AT, id: '42', contextLines: '0' }, [{ path: `${REPO}/pull-requests/42/diff`, respond: { json: { diffs: [] } } }]);
    expect(calls[0]!.url).toBe(`${BITBUCKET}${REPO}/pull-requests/42/diff?contextLines=0`);
    expect(envelope.data).toEqual({ diff: '{"diffs":[]}' });
  });

  it('pr diff --file encodes each segment of the path, so a # or ? stays in the file name (was appended as typed, #76 item 6)', async () => {
    const { calls } = await run('pr diff', { ...AT, id: '42', file: 'docs/notes#1 a?.md' }, [{ path: /\/diff\/docs\//, respond: { json: {} } }]);
    expect(new URL(calls[0]!.url).pathname).toBe(`${REPO}/pull-requests/42/diff/docs/notes%231%20a%3F.md`);
    expect(calls[0]!.url).toBe(`${BITBUCKET}${REPO}/pull-requests/42/diff/docs/notes%231%20a%3F.md`);
  });

  it('pr diff --file with a . or .. part is INVALID_INPUT before anything is sent', async () => {
    const { calls, envelope } = await run('pr diff', { ...AT, id: '42', file: 'src/../../../../admin' });
    expect(calls).toHaveLength(0);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('--file path') });
  });

  it('pr files reads one page of up to 1000 and stringifies path objects (#76 items 3 and 4)', async () => {
    const { calls, data } = await run('pr files', { ...AT, id: '42' });
    expect(calls.map((c) => c.url)).toEqual([`${BITBUCKET}${REPO}/pull-requests/42/changes?limit=1000`]);
    expect((data as string[])[0]).toMatch(/^\{"components":\["src","retry.ts"\]/);
    expect((data as string[])[1]).toBe('README.md');
  });

  it('pr approve POSTs and pr unapprove DELETEs /approve, with no body', async () => {
    expect((await run('pr approve', { ...W, id: '42' })).calls[0]).toEqual({ method: 'POST', url: `${BITBUCKET}${REPO}/pull-requests/42/approve`, headers: HEADERS, body: undefined });
    expect((await run('pr unapprove', { ...W, id: '42' })).calls[0]).toMatchObject({ method: 'DELETE', url: `${BITBUCKET}${REPO}/pull-requests/42/approve` });
  });

  it('pr needs-work finds the caller from X-AUSERNAME, adds them as a reviewer when they are not one, then PUTs NEEDS_WORK', async () => {
    const { calls, envelope } = await run('pr needs-work', { ...W, id: '42' });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`).sort()).toEqual(
      [`GET ${API}/application-properties`, `GET ${API}/users/jdoe`, `GET ${REPO}/pull-requests/42`, `POST ${REPO}/pull-requests/42/participants`, `PUT ${REPO}/pull-requests/42/participants/jdoe`].sort(),
    );
    expect(calls.find((c) => c.method === 'POST')!.body).toBe(json({ user: { name: 'jdoe' }, role: 'REVIEWER' }));
    expect(calls.at(-1)!.body).toBe(json({ status: 'NEEDS_WORK' }));
    expect(envelope.data).toMatchObject({ status: 'NEEDS_WORK' });
    // Already a reviewer: straight to the PUT.
    expect((await run('pr needs-work', { ...W, id: '43' })).calls.map((c) => c.method)).not.toContain('POST');
  });

  it('pr needs-work looks the username up as a slug, encoded (#76 item 13), and fails plainly without X-AUSERNAME', async () => {
    const odd = [{ path: `${API}/application-properties`, respond: { json: {}, headers: { 'X-AUSERNAME': 'jdoe@example.com' } } }, { path: `${API}/users/jdoe%40example.com`, respond: { json: user('jdoe_example.com') } }];
    expect((await run('pr needs-work', { ...W, id: '43' }, odd)).calls.some((c) => c.url.endsWith('/users/jdoe%40example.com'))).toBe(true);
    const none = await run('pr needs-work', { ...W, id: '42' }, [{ path: `${API}/application-properties`, respond: { json: {} } }]);
    expect(none.envelope.error).toMatchObject({ code: 'HTTP', message: 'Could not determine current Bitbucket user: X-AUSERNAME header was absent from the server response' });
  });

  it('pr needs-work leaves the reviewer it added when the status change fails (#76 item 14)', async () => {
    const { calls, envelope } = await run('pr needs-work', { ...W, id: '42' }, [{ method: 'PUT', path: /\/participants\/jdoe$/, respond: { status: 409, json: { errors: [{ message: 'Conflict' }] } } }]);
    expect(envelope.ok).toBe(false);
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/participants'))).toBe(true);
  });

  it('pr reviewers returns the PR reviewers; repo default-reviewers encodes project and repo in the plugin path', async () => {
    expect((await run('pr reviewers', { ...AT, id: '42' })).envelope.data).toEqual(pr(42).reviewers);
    const { calls } = await run('repo default-reviewers', { project: '~jdoe', repo: 'a b' }, [{ path: /conditions$/, respond: { json: { not: 'a list' } } }]);
    expect(calls[0]!.url).toBe(`${BITBUCKET}/rest/default-reviewers/1.0/projects/~jdoe/repos/a%20b/conditions`);
  });

  it('pr builds takes the newest commit, then one page of its build statuses with no limit (#76 item 12); no commits is []', async () => {
    const { calls, data } = await run('pr builds', { ...AT, id: '42' });
    expect(calls.map((c) => c.url)).toEqual([`${BITBUCKET}${REPO}/pull-requests/42/commits?limit=1`, `${BITBUCKET}/rest/build-status/1.0/commits/${SHA}`]);
    expect((data as Array<{ key: string }>).map((b) => b.key)).toEqual(['ci', 'e2e']);
    const none = await run('pr builds', { ...AT, id: '7' });
    expect(none.calls).toHaveLength(1);
    expect(none.envelope.data).toEqual([]);
  });
});

describe('pr current', () => {
  const at = (options: { config?: Record<string, Record<string, unknown>>; repository?: typeof repo | undefined; input?: Record<string, unknown> } = {}) => {
    const t = testContext({ config: options.config ?? fixtureConfig, routes, ...(options.repository ? { repo: options.repository } : {}) });
    return { t, done: execute(cmd('pr current'), options.input ?? AT, t.context) };
  };

  it("lists every OPEN pull request and returns the one whose source is the current branch", async () => {
    const { t, done } = at({ repository: repo });
    const envelope = await done;
    expect(t.http.calls.map((c) => c.url)).toEqual([`${BITBUCKET}${REPO}/pull-requests?state=OPEN&start=0&limit=100`, `${BITBUCKET}${REPO}/pull-requests?state=OPEN&start=1&limit=100`]);
    expect((envelope.data as { id: number }).id).toBe(42);
  });

  it('is null when no open pull request comes from the branch, and git current-pr is an alias', async () => {
    expect((await at({ repository: { ...repo, branch: 'nobody' } }).done).data).toBeNull();
    expect(cmd('pr current').aliases).toEqual([['git', 'current-pr']]);
  });

  it("succeeds with a message, sending nothing, when Bitbucket isn't set up or the connection lacks pat", async () => {
    const none = at({ config: {}, repository: repo, input: {} });
    expect(await none.done).toMatchObject({ ok: true, data: { message: 'Requires Bitbucket config. Available after toil connections add.' } });
    expect(none.t.http.calls).toEqual([]);
    const partial = await at({ config: { bitbucket: { baseUrl: BITBUCKET } }, repository: repo, input: {} }).done;
    expect(partial).toMatchObject({ ok: true, data: { message: expect.stringContaining('Requires Bitbucket config') } });
    expect(partial.meta.warnings?.[0]?.code).toBe('CONFIG_INCOMPLETE');
  });

  it("fails as specified outside a repository, on an unreadable branch, and with no project or repo", async () => {
    expect((await at().done).error).toMatchObject({ code: 'INVALID_INPUT', message: 'Not a git repository' });
    expect((await at({ repository: { ...repo, branch: 'unknown' } }).done).error?.message).toBe('Could not determine current branch');
    expect((await at({ repository: repo, input: {} }).done).error).toMatchObject({ code: 'INVALID_INPUT', message: 'Could not determine Bitbucket project/repo' });
  });
});
