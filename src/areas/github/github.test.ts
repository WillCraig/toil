import { describe, expect, it } from 'vitest';
import { runCli } from '../../../test/harness/cli.js';
import { testContext } from '../../../test/harness/context.js';
import type { Route } from '../../../test/harness/fake-fetch.js';
import { API, checkRun, DIFF, file, fixture, GHE, label, prCommit, prStatusNode, pullRequest, REPO, review, thread, user } from '../../../test/fixtures/github.fixture.js';
import type { AnyCommand } from '../../core/command.js';
import type { Context } from '../../core/context.js';
import { execute } from '../../core/run.js';
import { checkSecret } from '../../core/secret-input.js';
import { graphqlUrl } from './client.js';
import { commands } from './index.js';
import { addAssigneesCommand, addLabelsCommand, createIssueCommand, createRepoCommand, removeLabelCommand } from './issues.js';
import { repoFileCommand } from './files.js';
import { enableAutoMergeCommand, enqueuePrCommand, prStatusCommand } from './merging.js';
import { createPrCommand, diffCommand, getPrCommand, listPrsCommand, mergePrCommand } from './prs.js';
import { listReviewThreadsCommand, removeReviewersCommand, resolveThreadCommand } from './reviews.js';
import { getStatusCommand, listChecksCommand } from './status.js';

/**
 * The exact requests toil sends to GitHub and what it makes of the answers,
 * command by command. The parity suite proves the CLI and MCP agree; this
 * proves what they agree on is what the command contract specifies.
 * Suspected bugs (#72) are pinned here, not fixed, in keeping with the
 * longstanding practice of documenting a hazard instead of removing it.
 */

const HEADERS = {
  authorization: 'Bearer test-token',
  'content-type': 'application/json',
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  connection: 'close',
};
const BASE = { owner: 'imagile', repo: 'toil-probe' };
type Settings = Record<string, unknown>;

function setup(routes: Route[], settings: Settings = {}, extra: Partial<Context> = {}) {
  const t = testContext({ config: { github: { ...fixture.config!.github, ...settings } }, routes, files: fixture.files! });
  Object.assign(t.context, extra);
  return t;
}

async function run(def: AnyCommand, input: Record<string, unknown>, routes: Route[] = fixture.routes!, settings: Settings = {}, extra: Partial<Context> = {}) {
  const t = setup(routes, settings, extra);
  const envelope = await execute(def, input, t.context);
  return { envelope, calls: t.http.calls };
}

const ok = (json: unknown): Route => ({ url: /.*/, method: 'GET', respond: { json } });
const remote = (url: string): Partial<Context> => ({ gitRemote: async () => [{ name: 'origin', url }] });

describe('requests', () => {
  it('sends the token and the pinned headers to the REST root, keeping /api/v3', async () => {
    const { envelope, calls } = await run(getPrCommand, { ...BASE, number: '7' });
    expect(calls).toEqual([{ method: 'GET', url: `${API}/repos/imagile/toil-probe/pulls/7`, headers: HEADERS, body: undefined }]);
    expect(envelope.data).toEqual(pullRequest(7));
  });

  // Both kinds of personal access token are sent the same way, and nothing in toil refuses either shape (#561).
  it.each([
    ['a classic token', 'ghp_0000000000000000000000000000000000AB'],
    ['a fine-grained token', 'github_pat_00000000000000000000_0000000000000000000000000000000000000000000000000000000000000AB'],
  ])('accepts %s and sends it as a Bearer token', async (_kind, token) => {
    const { envelope, calls } = await run(getPrCommand, { ...BASE, number: '7' }, fixture.routes!, { token });
    expect(envelope.ok).toBe(true);
    expect(calls[0]!.headers).toEqual({ ...HEADERS, authorization: `Bearer ${token}` });
    // The paste checks take either as it is, and look through a pasted wrapper to the same value.
    expect(checkSecret(token, { empty: 'required' })).toMatchObject({ status: 'ok', value: token, wrapper: null });
    expect(checkSecret(`Bearer ${token}`, { empty: 'required' })).toMatchObject({ status: 'ok', wrapper: { without: token } });
    expect(checkSecret(`GITHUB_TOKEN=${token}`, { empty: 'required' })).toMatchObject({ status: 'ok', wrapper: { without: token } });
  });

  it('a 401 is AUTH, naming where to make a token and the GITHUB_TOKEN fallback', async () => {
    const { envelope } = await run(getPrCommand, { ...BASE, number: '7' }, [{ url: /.*/, respond: { status: 401, json: { message: 'Bad credentials' } } }]);
    expect(envelope.error).toMatchObject({ code: 'AUTH', message: 'Bad credentials', fix: expect.stringContaining('TOIL_GITHUB_TOKEN, or GITHUB_TOKEN') });
  });

  it('derives the GraphQL endpoint from the REST root as the contract specifies', () => {
    expect(graphqlUrl('https://api.github.com')).toBe('https://api.github.com/graphql');
    expect(graphqlUrl('https://api.github.com/')).toBe('https://api.github.com/graphql');
    expect(graphqlUrl(`${GHE}/api/v3`)).toBe(`${GHE}/api/graphql`);
    expect(graphqlUrl(`${GHE}/api/v3//`)).toBe(`${GHE}/api/graphql`);
  });

  it('suspected bug #72 item 9: numbers are parseInt-ed, so 12abc is PR 12 and abc is NaN', async () => {
    const twelve = await run(getPrCommand, { ...BASE, number: '12abc' }, [ok(pullRequest(12))]);
    expect(twelve.calls[0]!.url).toBe(`${API}/repos/imagile/toil-probe/pulls/12`);
    const nan = await run(getPrCommand, { ...BASE, number: 'abc' }, [{ url: /.*/, respond: { status: 404, json: { message: 'Not Found' } } }]);
    expect(nan.calls[0]!.url).toBe(`${API}/repos/imagile/toil-probe/pulls/NaN`);
    expect(nan.envelope.error).toMatchObject({ code: 'NOT_FOUND', message: 'Not Found' });
  });
});

describe('owner and repo', () => {
  it('fails before any request with the "Could not determine" error when neither is found', async () => {
    const { envelope, calls } = await run(getPrCommand, { number: '7' });
    expect(calls).toEqual([]);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/^Could not determine GitHub owner\/repo\. Pass --owner and --repo/), fix: expect.stringContaining('TOIL_GITHUB_OWNER') });
    // An empty --owner is "not found", not a validation error.
    expect((await run(getPrCommand, { owner: '', repo: 'r', number: '7' })).envelope.error?.message).toMatch(/^Could not determine/);
  });

  it('takes them from the connection (defaults.github) and says so', async () => {
    const { envelope, calls } = await run(getPrCommand, { number: '7' }, fixture.routes!, { owner: 'imagile', repo: 'toil-probe' });
    expect(calls[0]!.url).toBe(`${API}/repos/imagile/toil-probe/pulls/7`);
    expect(envelope.meta.context?.inputs).toEqual({ owner: { value: 'imagile', source: 'connection' }, repo: { value: 'toil-probe', source: 'connection' } });
  });

  it('reads the origin remote when its host is the connection\'s, in all three shapes, and reports the parsed value', async () => {
    for (const url of ['git@ghe.imagile.dev:imagile/toil-probe.git', 'ssh://git@ghe.imagile.dev:7999/imagile/toil-probe', 'https://GHE.imagile.dev:8443/imagile/toil-probe.git']) {
      const { envelope, calls } = await run(getPrCommand, { number: '7' }, fixture.routes!, { owner: 'other', repo: 'other' }, remote(url));
      expect(calls[0]!.url, url).toBe(`${API}/repos/imagile/toil-probe/pulls/7`);
      expect(envelope.meta.context?.inputs?.owner, url).toEqual({ value: 'imagile', source: 'git' });
    }
  });

  it("reads a remote of any name on the connection's host when origin is elsewhere, as the contract specifies", async () => {
    const remotes: Partial<Context> = { gitRemote: async () => [{ name: 'origin', url: 'git@github.com:me/toil-probe.git' }, { name: 'upstream', url: 'git@ghe.imagile.dev:imagile/toil-probe.git' }] };
    const { envelope, calls } = await run(getPrCommand, { number: '7' }, fixture.routes!, { owner: 'other', repo: 'other' }, remotes);
    expect(calls[0]!.url).toBe(`${API}/repos/imagile/toil-probe/pulls/7`);
    expect(envelope.meta.context?.inputs?.owner).toEqual({ value: 'imagile', source: 'git' });
  });

  it('maps an api.github.com base URL to github.com remotes', async () => {
    const { calls } = await run(getPrCommand, { number: '7' }, [ok(pullRequest(7))], { baseUrl: 'https://api.github.com' }, remote('git@github.com:imagile/toil-probe.git'));
    expect(calls[0]!.url).toBe('https://api.github.com/repos/imagile/toil-probe/pulls/7');
  });

  it('ignores a remote on another host, falling back to the connection, and never reports it', async () => {
    const { envelope, calls } = await run(getPrCommand, { number: '7' }, fixture.routes!, { owner: 'imagile', repo: 'toil-probe' }, remote('git@github.com:someone/else.git'));
    expect(calls[0]!.url).toBe(`${API}/repos/imagile/toil-probe/pulls/7`);
    expect(envelope.meta.context?.inputs?.owner).toEqual({ value: 'imagile', source: 'connection' });
    const none = await run(getPrCommand, { number: '7' }, [], {}, remote('git@github.com:someone/else.git'));
    expect(none.envelope.error?.message).toMatch(/^Could not determine/);
    expect(none.envelope.meta.context?.inputs).toBeUndefined();
  });

  it('suspected bug #72 item 10: an HTTPS remote with userinfo is never matched', async () => {
    for (const url of ['https://octo-dev@ghe.imagile.dev/imagile/toil-probe.git', 'https://x-access-token:secret@ghe.imagile.dev/imagile/toil-probe.git']) {
      const { envelope } = await run(getPrCommand, { number: '7' }, [], {}, remote(url));
      expect(envelope.error?.message, url).toMatch(/^Could not determine/);
      expect(JSON.stringify(envelope)).not.toContain('secret');
    }
  });

  it('a flag beats the remote', async () => {
    const { calls } = await run(getPrCommand, { owner: 'mine', repo: 'toil-probe', number: '7' }, [ok(pullRequest(7))], {}, remote('git@ghe.imagile.dev:imagile/x.git'));
    expect(calls[0]!.url).toBe(`${API}/repos/mine/toil-probe/pulls/7`);
  });

  it('pr create takes --owner/--repo after the leaf over the group\'s', async () => {
    const t = setup(fixture.routes!);
    const cli = await runCli(['github', '--owner', 'group-owner', '--repo', 'group-repo', 'pr', 'create', '--owner', 'imagile', '--repo', 'toil-probe', '--title', 'T', '--head', 'feature', '--allow-write'], { commands, context: t.context });
    expect(cli.envelope?.ok).toBe(true);
    expect(t.http.calls[0]!.url).toBe(`${API}/repos/imagile/toil-probe/pulls`);
    const group = setup(fixture.routes!);
    await runCli(['github', '--owner', 'imagile', '--repo', 'toil-probe', 'pr', 'create', '--title', 'T', '--head', 'feature', '--allow-write'], { commands, context: group.context });
    expect(group.http.calls[0]!.url).toBe(`${API}/repos/imagile/toil-probe/pulls`);
  });
});

describe('pull requests', () => {
  it('pr list pages 100 at a time from page 1, per_page first, and stops on a short page', async () => {
    const full = Array.from({ length: 100 }, (_, i) => pullRequest(i + 1));
    const routes: Route[] = [
      { path: `${REPO}/pulls`, query: { state: 'open', per_page: '100', page: '1' }, respond: { json: full } },
      { path: `${REPO}/pulls`, query: { state: 'open', per_page: '100', page: '2' }, respond: { json: [pullRequest(101)] } },
    ];
    const { envelope, calls } = await run(listPrsCommand, BASE, routes);
    expect(calls.map((c) => c.url)).toEqual([`${API}/repos/imagile/toil-probe/pulls?state=open&per_page=100&page=1`, `${API}/repos/imagile/toil-probe/pulls?state=open&per_page=100&page=2`]);
    expect((envelope.data as unknown[]).length).toBe(101);
  });

  it('pr list sends state, head and base, and filters author (any case) and dates after paging', async () => {
    const prs = [pullRequest(1), pullRequest(2, { user: user('someone-else') }), pullRequest(3, { created_at: '2025-02-01T00:00:00Z' }), pullRequest(4, { created_at: '2024-12-31T23:59:59Z' })];
    const routes: Route[] = [{ path: `${REPO}/pulls`, query: { state: 'all', head: 'imagile:feature', base: 'main', per_page: '100', page: '1' }, respond: { json: prs } }];
    const { envelope } = await run(listPrsCommand, { ...BASE, state: 'all', head: 'imagile:feature', base: 'main', author: 'OCTO-DEV', createdAfter: '2025-01-01', createdBefore: '2025-02-01T00:00:00Z' }, routes);
    // [after, before): PR 3 sits on the exclusive upper bound, PR 4 just before the lower one.
    expect((envelope.data as Array<{ number: number }>).map((p) => p.number)).toEqual([1]);
  });

  it('suspected bug #72 item 14: a date-only bound is UTC midnight', async () => {
    const routes: Route[] = [{ path: `${REPO}/pulls`, respond: { json: [pullRequest(1, { created_at: '2025-01-31T00:00:00Z' }), pullRequest(2, { created_at: '2025-01-30T23:59:59Z' })] } }];
    const { envelope } = await run(listPrsCommand, { ...BASE, createdAfter: '2025-01-31' }, routes);
    expect((envelope.data as Array<{ number: number }>).map((p) => p.number)).toEqual([1]);
  });

  it('pr list rejects a bad date before looking for a repo or sending anything', async () => {
    const { envelope, calls } = await run(listPrsCommand, { createdAfter: 'yesterday' }, []);
    expect(calls).toEqual([]);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Invalid --created-after value "yesterday". Use an ISO 8601 date such as 2025-01-31 or 2025-01-31T09:00:00Z.' });
  });

  it('pr list --updated-since asks for newest-updated first, keeps the fresh ones and stops after the page holding an older one', async () => {
    const fresh = Array.from({ length: 99 }, (_, i) => pullRequest(i + 1, { updated_at: '2025-01-20T00:00:00Z' }));
    const routes: Route[] = [
      // Page 1 is full, page 2 reaches a PR updated before the cut-off, page 3 must never be asked for.
      { path: `${REPO}/pulls`, query: { state: 'open', sort: 'updated', direction: 'desc', per_page: '100', page: '1' }, respond: { json: [...fresh, pullRequest(100, { updated_at: '2025-01-16T00:00:00Z' })] } },
      { path: `${REPO}/pulls`, query: { state: 'open', sort: 'updated', direction: 'desc', per_page: '100', page: '2' }, respond: { json: [pullRequest(101, { updated_at: '2025-01-16T00:00:00Z' }), pullRequest(102, { updated_at: '2025-01-15T23:59:59Z' }), ...Array.from({ length: 98 }, (_, i) => pullRequest(200 + i, { updated_at: '2025-01-01T00:00:00Z' }))] } },
    ];
    const { envelope, calls } = await run(listPrsCommand, { ...BASE, updatedSince: '2025-01-16' }, routes);
    expect(calls.map((c) => c.url)).toEqual([
      `${API}/repos/imagile/toil-probe/pulls?state=open&sort=updated&direction=desc&per_page=100&page=1`,
      `${API}/repos/imagile/toil-probe/pulls?state=open&sort=updated&direction=desc&per_page=100&page=2`,
    ]);
    // A date alone is UTC midnight, and the bound is inclusive: 100 and 101 sit on it.
    const numbers = (envelope.data as Array<{ number: number }>).map((p) => p.number);
    expect(numbers).toHaveLength(101);
    expect(numbers.slice(-2)).toEqual([100, 101]);
  });

  it('pr list --updated-since combines with --author, the created dates and --limit, and the cursor resumes', async () => {
    const page1 = [
      pullRequest(1, { updated_at: '2025-01-20T00:00:00Z' }),
      pullRequest(2, { updated_at: '2025-01-19T00:00:00Z', user: user('someone-else') }),
      pullRequest(3, { updated_at: '2025-01-18T00:00:00Z', created_at: '2024-12-01T00:00:00Z' }),
      pullRequest(4, { updated_at: '2025-01-17T00:00:00Z' }),
      pullRequest(5, { updated_at: '2025-01-10T00:00:00Z' }),
    ];
    const routes: Route[] = [{ path: `${REPO}/pulls`, query: { state: 'all', sort: 'updated', direction: 'desc', per_page: '100', page: '1' }, respond: { json: page1 } }];
    const input = { ...BASE, state: 'all', author: 'octo-dev', createdAfter: '2025-01-01', updatedSince: '2025-01-15T00:00:00Z', limit: 1 };
    const first = await run(listPrsCommand, input, routes);
    expect((first.envelope.data as Array<{ number: number }>).map((p) => p.number)).toEqual([1]);
    const cursor = first.envelope.meta.page?.nextCursor;
    expect(cursor).toEqual(expect.any(String));
    const second = await run(listPrsCommand, { ...input, cursor }, routes);
    expect((second.envelope.data as Array<{ number: number }>).map((p) => p.number)).toEqual([4]);
    // PR 5 is older than the cut-off, so that page was the last and there is nothing after 4.
    expect(second.envelope.meta.page?.nextCursor).toBeNull();
    expect(second.calls).toHaveLength(1);
  });

  it('pr list rejects a bad --updated-since before looking for a repo or sending anything, and sends no sort without it', async () => {
    const bad = await run(listPrsCommand, { updatedSince: 'last tuesday' }, []);
    expect(bad.calls).toEqual([]);
    expect(bad.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Invalid --updated-since value "last tuesday". Use an ISO 8601 date such as 2025-01-31 or 2025-01-31T09:00:00Z.' });
    const plain = await run(listPrsCommand, BASE);
    expect(plain.calls.map((c) => c.url)).toEqual([`${API}/repos/imagile/toil-probe/pulls?state=open&per_page=100&page=1`]);
  });

  it('pr get --include reads each list after the PR, in a fixed order, into included', async () => {
    const { envelope, calls } = await run(getPrCommand, { ...BASE, number: '7', include: ' Files, reviews,,CHECKS ,commits,reviews' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${API}/repos/imagile/toil-probe/pulls/7`,
      `GET ${API}/repos/imagile/toil-probe/pulls/7/reviews?per_page=100&page=1`,
      // The head commit of the PR just read (head.sha).
      `GET ${API}/repos/imagile/toil-probe/commits/abc1234/check-runs?per_page=100&page=1`,
      `GET ${API}/repos/imagile/toil-probe/pulls/7/commits?per_page=100&page=1`,
      `GET ${API}/repos/imagile/toil-probe/pulls/7/files?per_page=100&page=1`,
    ]);
    for (const call of calls) expect(call.headers).toEqual(HEADERS);
    expect(envelope.data).toEqual({ ...pullRequest(7), included: { reviews: [review()], checks: [checkRun()], commits: [prCommit()], files: [file()] } });
    expect(envelope.meta.warnings).toBeUndefined();
  });

  it('pr get --include holds only the lists asked for, and reads every page', async () => {
    const reviews = Array.from({ length: 100 }, () => review());
    const routes: Route[] = [
      { path: `${REPO}/pulls/7`, respond: { json: pullRequest(7) } },
      { path: `${REPO}/pulls/7/reviews`, query: { per_page: '100', page: '1' }, respond: { json: reviews } },
      { path: `${REPO}/pulls/7/reviews`, query: { per_page: '100', page: '2' }, respond: { json: [review('COMMENTED')] } },
    ];
    const { envelope, calls } = await run(getPrCommand, { ...BASE, number: '7', include: 'reviews' }, routes);
    expect(calls).toHaveLength(3);
    const data = envelope.data as { included: Record<string, unknown[]> };
    expect(Object.keys(data.included)).toEqual(['reviews']);
    expect(data.included.reviews).toHaveLength(101);
  });

  it('pr get --include warns when commits or files reach the most GitHub serves', async () => {
    const commits = Array.from({ length: 250 }, (_, i) => prCommit(`abc${i}`));
    const pages = (path: string, items: unknown[]): Route[] => Array.from({ length: Math.ceil(items.length / 100) + (items.length % 100 === 0 ? 1 : 0) }, (_, i) => ({ path, query: { per_page: '100', page: String(i + 1) }, respond: { json: items.slice(i * 100, i * 100 + 100) } }));
    const files = Array.from({ length: 3000 }, (_, i) => file(`src/f${i}.ts`));
    const routes: Route[] = [{ path: `${REPO}/pulls/7`, respond: { json: pullRequest(7) } }, ...pages(`${REPO}/pulls/7/commits`, commits), ...pages(`${REPO}/pulls/7/files`, files)];
    const { envelope } = await run(getPrCommand, { ...BASE, number: '7', include: 'commits,files' }, routes);
    expect(envelope.ok).toBe(true);
    expect(envelope.meta.warnings).toEqual([
      { code: 'GITHUB_LIST_CAPPED', message: 'GitHub serves at most 250 commits of a pull request, and PR #7 returned 250, so included.commits may be incomplete.' },
      { code: 'GITHUB_LIST_CAPPED', message: 'GitHub serves at most 3000 files of a pull request, and PR #7 returned 3000, so included.files may be incomplete.' },
    ]);
  });

  it('pr get refuses an unknown --include value before any request, and without --include sends one request unchanged', async () => {
    const bad = await run(getPrCommand, { number: '7', include: 'reviews,statuses' }, []);
    expect(bad.calls).toEqual([]);
    expect(bad.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Unknown --include value "statuses". Use any of reviews, checks, commits, files.', fix: expect.stringContaining('--include reviews,checks') });
    const blank = await run(getPrCommand, { ...BASE, number: '7', include: ' , ' });
    expect(blank.calls).toHaveLength(1);
    expect(blank.envelope.data).toEqual(pullRequest(7));
    const plain = await run(getPrCommand, { ...BASE, number: '7' });
    expect(plain.calls).toEqual([{ method: 'GET', url: `${API}/repos/imagile/toil-probe/pulls/7`, headers: HEADERS, body: undefined }]);
    expect(plain.envelope.data).toEqual(pullRequest(7));
  });

  it('pr create POSTs title, head and base, defaulting base to targetBranch then main; --body wins over --body-file', async () => {
    const plain = await run(createPrCommand, { ...BASE, title: 'T', head: 'feature', allowWrite: true });
    expect(plain.calls[0]).toMatchObject({ method: 'POST', url: `${API}/repos/imagile/toil-probe/pulls`, headers: HEADERS });
    expect(JSON.parse(plain.calls[0]!.body!)).toEqual({ title: 'T', head: 'feature', base: 'main' });
    const configured = await run(createPrCommand, { ...BASE, title: 'T', head: 'feature', bodyFile: 'pr-body.md', draft: false, allowWrite: true }, fixture.routes!, { targetBranch: 'develop' });
    expect(configured.calls[0]!.body).toBe(JSON.stringify({ title: 'T', head: 'feature', base: 'develop', body: 'Body from a file.\n', draft: false }));
    const both = await run(createPrCommand, { ...BASE, title: 'T', head: 'feature', body: 'inline', bodyFile: 'missing.md', allowWrite: true });
    expect(JSON.parse(both.calls[0]!.body!).body).toBe('inline');
  });

  it('pr merge: suspected bug #72 item 12, merge_method is always sent, defaulting to merge', async () => {
    const { calls, envelope } = await run(mergePrCommand, { ...BASE, number: '7', allowWrite: true });
    expect(calls[0]).toMatchObject({ method: 'PUT', url: `${API}/repos/imagile/toil-probe/pulls/7/merge` });
    expect(calls[0]!.body).toBe('{"merge_method":"merge"}');
    expect(envelope.data).toEqual({ sha: 'abc1234', merged: true, message: 'Pull Request successfully merged' });
    const squash = await run(mergePrCommand, { ...BASE, number: '7', method: 'squash', commitTitle: 't', commitMessage: 'm', allowWrite: true });
    expect(squash.calls[0]!.body).toBe('{"commit_title":"t","commit_message":"m","merge_method":"squash"}');
  });

  it('diff GETs the PR path with the diff media type and returns { diff }', async () => {
    const { calls, envelope } = await run(diffCommand, { ...BASE, number: '7' });
    expect(calls[0]).toEqual({ method: 'GET', url: `${API}/repos/imagile/toil-probe/pulls/7`, headers: { ...HEADERS, accept: 'application/vnd.github.v3.diff' }, body: undefined });
    expect(envelope.data).toEqual({ diff: DIFF });
  });

  it("diff: a non-OK body's message is the error", async () => {
    const { envelope } = await run(diffCommand, { ...BASE, number: '7' }, [{ url: /.*/, respond: { status: 406, json: { message: 'Sorry, the diff exceeded the maximum number of files' } } }]);
    expect(envelope.error).toMatchObject({ code: 'HTTP', message: 'Sorry, the diff exceeded the maximum number of files' });
  });

  it('diff: suspected bug #72 item 11, a 429 fails at once with the server message and no retry', async () => {
    const { envelope, calls } = await run(diffCommand, { ...BASE, number: '7' }, [{ url: /.*/, respond: { status: 429, json: { message: 'API rate limit exceeded' } } }]);
    expect(calls.length).toBe(1);
    expect(envelope.error).toMatchObject({ code: 'HTTP', message: 'API rate limit exceeded', details: { status: 429 } });
  });
});

describe('repo file', () => {
  it("reads one file through the contents API, with its text decoded beside GitHub's record", async () => {
    const { envelope, calls } = await run(repoFileCommand, { ...BASE, path: '/.github/CODEOWNERS' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${API}/repos/imagile/toil-probe/contents/.github/CODEOWNERS`]);
    expect(envelope.data).toMatchObject({ type: 'file', path: '.github/CODEOWNERS', text: '* @octo-dev\n' });
    const ref = await run(repoFileCommand, { ...BASE, path: 'docs/CODEOWNERS', ref: 'release/1.4' });
    expect(ref.calls[0]!.url).toBe(`${API}/repos/imagile/toil-probe/contents/docs/CODEOWNERS?ref=release%2F1.4`);
  });

  it('encodes each part of the path, and refuses a dot segment before any request', async () => {
    const spaced = await run(repoFileCommand, { ...BASE, path: 'docs/Read me.md' }, [ok({ type: 'file', encoding: 'base64', size: 2, content: Buffer.from('hi').toString('base64') })]);
    expect(spaced.calls[0]!.url).toBe(`${API}/repos/imagile/toil-probe/contents/docs/Read%20me.md`);
    const dots = await run(repoFileCommand, { ...BASE, path: 'docs/../../secrets' });
    expect(dots.calls).toEqual([]);
    expect(dots.envelope.error).toMatchObject({ code: 'INVALID_INPUT' });
    expect(dots.envelope.error!.fix).toContain('.github/CODEOWNERS');
  });

  it('refuses a folder, and says so when GitHub sends no content for a large file', async () => {
    const folder = await run(repoFileCommand, { ...BASE, path: 'docs' }, [ok([{ type: 'file', name: 'a.md' }])]);
    expect(folder.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'docs in imagile/toil-probe is a folder, not a file.' });
    const big = await run(repoFileCommand, { ...BASE, path: 'big.bin' }, [ok({ type: 'file', encoding: 'none', size: 5_000_000, content: '' })]);
    expect(big.envelope.data).toMatchObject({ text: null });
    expect(big.envelope.meta.warnings).toEqual([expect.objectContaining({ code: 'GITHUB_FILE_NOT_INLINED' })]);
  });
});

describe('GraphQL', () => {
  it('enable-auto-merge GETs the node id, then POSTs the mutation to /api/graphql with the method upper-cased', async () => {
    const { calls, envelope } = await run(enableAutoMergeCommand, { ...BASE, number: '7', method: 'squash', matchHeadCommit: 'abc1234', allowWrite: true });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${API}/repos/imagile/toil-probe/pulls/7`, `POST ${GHE}/api/graphql`]);
    expect(calls[1]!.headers).toEqual(HEADERS);
    const sent = JSON.parse(calls[1]!.body!) as { query: string; variables: unknown };
    expect(sent.query).toContain('enablePullRequestAutoMerge');
    expect(sent.variables).toEqual({ pullRequestId: 'PR_kwDOabc123457', mergeMethod: 'SQUASH', expectedHeadOid: 'abc1234' });
    expect(envelope.data).toMatchObject({ number: 7, autoMergeRequest: { enabledBy: { login: 'octo-dev' } } });
  });

  it('pr enqueue sends only the variables given and returns mergeQueueUrl', async () => {
    const { calls, envelope } = await run(enqueuePrCommand, { ...BASE, number: '7', allowWrite: true });
    expect(JSON.parse(calls[1]!.body!).variables).toEqual({ pullRequestId: 'PR_kwDOabc123457' });
    expect(envelope.data).toEqual({ mergeQueueUrl: `${GHE}/imagile/toil-probe/queue/main` });
  });

  it('GraphQL errors fail with the messages joined; null data fails too', async () => {
    const graphql = (json: unknown): Route[] => [{ method: 'POST', url: /graphql$/, respond: { json } }];
    const errors = await run(prStatusCommand, { ...BASE, number: '7' }, graphql({ data: null, errors: [{ message: 'one' }, { message: 'two' }] }));
    expect(errors.envelope.error).toMatchObject({ code: 'HTTP', message: 'GitHub GraphQL error: one; two' });
    const empty = await run(prStatusCommand, { ...BASE, number: '7' }, graphql({ data: null }));
    expect(empty.envelope.error).toMatchObject({ code: 'HTTP', message: expect.stringContaining('with no data') });
  });

  it('pr status: suspected bug #72 item 1, GraphQL\'s uppercase states all count as other', async () => {
    const { envelope, calls } = await run(prStatusCommand, { ...BASE, number: '7' });
    expect(JSON.parse(calls[0]!.body!).variables).toEqual({ owner: 'imagile', repo: 'toil-probe', number: 7 });
    expect(envelope.data).toMatchObject({
      number: 7,
      state: 'OPEN',
      autoMergeRequest: null,
      checks: { total: 2, passed: 0, failed: 0, pending: 0, other: 2, details: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'ci/legacy', status: 'PENDING', conclusion: null }] },
    });
  });

  it('pr status counts lowercase states and flattens enabledBy; suspected bug #72 item 2, only 100 contexts are asked for', async () => {
    const node = { ...prStatusNode([{ __typename: 'CheckRun', name: 'a', status: 'completed', conclusion: 'success' }, { __typename: 'CheckRun', name: 'b', status: 'completed', conclusion: 'timed_out' }, { __typename: 'StatusContext', context: 'c', state: 'pending' }, { __typename: 'CheckRun', name: 'd', status: 'completed', conclusion: 'skipped' }]), autoMergeRequest: { mergeMethod: 'SQUASH', enabledAt: 'x', enabledBy: { login: 'octo-dev' } } };
    const { envelope, calls } = await run(prStatusCommand, { ...BASE, number: '7' }, [{ method: 'POST', url: /graphql$/, respond: { json: { data: { repository: { pullRequest: node } } } } }]);
    expect(JSON.parse(calls[0]!.body!).query).toContain('contexts(first: 100)');
    expect(envelope.data).toMatchObject({ autoMergeRequest: { mergeMethod: 'SQUASH', enabledAt: 'x', enabledBy: 'octo-dev' }, checks: { total: 4, passed: 1, failed: 1, pending: 1, other: 1 } });
  });

  it('pr status: suspected bug #72 item 17, an auto-merge request with a null enabledBy fails instead of answering', async () => {
    const node = { ...prStatusNode([]), autoMergeRequest: { mergeMethod: 'SQUASH', enabledAt: 'x', enabledBy: null } };
    const { envelope } = await run(prStatusCommand, { ...BASE, number: '7' }, [{ method: 'POST', url: /graphql$/, respond: { json: { data: { repository: { pullRequest: node } } } } }]);
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.message).toContain('login');
  });

  it('pr threads warns past 100 threads; suspected bug #72 item 3, 10 comments per thread and no warning', async () => {
    const answer = { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: true }, nodes: [thread()] } } } } };
    const { envelope, calls } = await run(listReviewThreadsCommand, { ...BASE, number: '7' }, [{ method: 'POST', url: /graphql$/, respond: { json: answer } }]);
    expect(JSON.parse(calls[0]!.body!).query).toContain('comments(first: 10)');
    expect(envelope.data).toEqual([thread()]);
    expect(envelope.meta.warnings).toEqual([{ code: 'GITHUB_REVIEW_THREADS_TRUNCATED', message: 'more than 1 review threads on PR #7; only showing the first 1' }]);
  });

  it('pr resolve: suspected bug #72 item 8, it needs an owner and repo it never sends', async () => {
    const without = await run(resolveThreadCommand, { threadId: 'PRT_1', allowWrite: true });
    expect(without.calls).toEqual([]);
    expect(without.envelope.error?.message).toMatch(/^Could not determine/);
    const withRepo = await run(resolveThreadCommand, { ...BASE, threadId: 'PRT_1', allowWrite: true });
    expect(JSON.parse(withRepo.calls[0]!.body!).variables).toEqual({ threadId: 'PRT_1' });
    expect(withRepo.envelope.data).toMatchObject({ isResolved: true });
  });
});

describe('dot segments', () => {
  it('refuses a . or .. segment in any path value before sending, so a DELETE stays on the resource it names', async () => {
    const cases: Array<[AnyCommand, Record<string, unknown>]> = [
      [removeLabelCommand, { ...BASE, number: '7', label: '../../../../../repos/imagile/victim', allowWrite: true }],
      [removeLabelCommand, { ...BASE, number: '7', label: '..', allowWrite: true }],
      [removeLabelCommand, { ...BASE, number: '7', label: '..\\x', allowWrite: true }],
      [getPrCommand, { owner: 'imagile', repo: '..', number: '7' }],
      [getStatusCommand, { ...BASE, ref: 'a/./b' }],
      [diffCommand, { owner: '.', repo: 'toil-probe', number: '7' }],
      // Encoded, the slash is %2F, which core's check also reads as the end of a segment.
      [removeLabelCommand, { ...BASE, number: '7', label: '../x', allowWrite: true }],
    ];
    for (const [def, input] of cases) {
      const { envelope, calls } = await run(def, input, []);
      expect(calls, JSON.stringify(input)).toEqual([]);
      expect(envelope.error, JSON.stringify(input)).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('segment') });
    }
  });

  it('encodes what the URL parser would drop, so a label with tabs, line breaks or controls stays one segment', async () => {
    const any: Route[] = [{ method: 'DELETE', url: /.*/, respond: { json: [] } }];
    const cases: Array<[string, string]> = [
      [`${'.\t./'.repeat(2)}repos/o/r`, '.%09.%2F.%09.%2Frepos%2Fo%2Fr'],
      ['.\n./x', '.%0A.%2Fx'],
      ['.\r./x', '.%0D.%2Fx'],
      ['x/.. ', 'x%2F..%20'],
      ['x/..\u0000', 'x%2F..%00'],
    ];
    for (const [label, sent] of cases) {
      const { calls } = await run(removeLabelCommand, { ...BASE, number: '7', label, allowWrite: true }, any);
      expect(calls.map((c) => c.url), JSON.stringify(label)).toEqual([`${API}/repos/imagile/toil-probe/issues/7/labels/${sent}`]);
    }
  });

  it('refuses an owner or repo with path syntax in it before anything is sent', async () => {
    for (const input of [
      { owner: 'imagile', repo: 'x/pulls/9/merge?y=', number: '7' },
      { owner: 'a/b', repo: 'toil-probe', number: '7' },
      { owner: 'imagile', repo: 'toil#x', number: '7' },
      { owner: 'imagile', repo: 'to%2Fil', number: '7' },
      { owner: 'imagile', repo: 'a\\b', number: '7' },
      { owner: 'imagile', repo: 'a\u0001b', number: '7' },
    ]) {
      const { envelope, calls } = await run(getPrCommand, input, []);
      expect(calls, JSON.stringify(input)).toEqual([]);
      expect(envelope.error, JSON.stringify(input)).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining("can't contain") });
    }
  });

  it('refuses a repo with path syntax from the connection setting or the git remote too, naming where it came from', async () => {
    const fromSetting = await run(getPrCommand, { number: '7' }, [], { owner: 'imagile', repo: 'x/pulls/9/merge?y=' });
    expect(fromSetting.calls).toEqual([]);
    expect(fromSetting.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining("from the connection's repo setting") });
    const host = new URL(API).hostname;
    const fromGit = await run(getPrCommand, { number: '7' }, [], {}, remote(`git@${host}:imagile/x?y#z.git`));
    expect(fromGit.calls).toEqual([]);
    expect(fromGit.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('from the git remote') });
  });

  it('keeps dots inside a segment and leaves the query alone', async () => {
    const { calls } = await run(removeLabelCommand, { ...BASE, number: '7', label: 'v1..2', allowWrite: true }, [{ method: 'DELETE', url: /.*/, respond: { json: [] } }]);
    expect(calls[0]!.url).toBe(`${API}/repos/imagile/toil-probe/issues/7/labels/v1..2`);
  });

  it('keeps the five deletes off MCP', () => {
    const off = commands.filter((c) => c.mcp === false).map((c) => c.path.slice(1).join(' ')).sort();
    expect(off).toEqual(['issue unassign', 'issue unlabel', 'pr delete-comment', 'pr delete-review-comment', 'pr remove-reviewers']);
  });
});

describe('status and checks', () => {
  it('commit status: suspected bug #72 item 5, one request; the ref is encoded as one segment (item 13)', async () => {
    const { calls } = await run(getStatusCommand, { ...BASE, ref: 'probe#1' }, [{ url: /.*/, respond: { json: { state: 'success', statuses: [] } } }]);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(`${API}/repos/imagile/toil-probe/commits/probe%231/status`);
    const branch = await run(getStatusCommand, { ...BASE, ref: 'release/1.4' }, [{ url: /.*/, respond: { json: { state: 'success', statuses: [] } } }]);
    expect(branch.calls[0]!.url).toBe(`${API}/repos/imagile/toil-probe/commits/release%2F1.4/status`);
  });

  it('commit checks unwraps check_runs and pages until a short page', async () => {
    const routes: Route[] = [
      { path: `${REPO}/commits/abc1234/check-runs`, query: { per_page: '100', page: '1' }, respond: { json: { total_count: 101, check_runs: Array.from({ length: 100 }, (_, i) => checkRun(i)) } } },
      { path: `${REPO}/commits/abc1234/check-runs`, query: { per_page: '100', page: '2' }, respond: { json: { total_count: 101, check_runs: [checkRun(100)] } } },
    ];
    const { envelope } = await run(listChecksCommand, { ...BASE, ref: 'abc1234' }, routes);
    expect((envelope.data as unknown[]).length).toBe(101);
  });
});

describe('repositories, issues, labels, assignees and reviewers', () => {
  it('repo create: suspected bug #72 item 6, an explicit --owner is always an org; the remote and defaults are never read', async () => {
    const org = await run(createRepoCommand, { owner: 'imagile', name: 'toil-probe', allowWrite: true });
    expect(org.calls[0]).toMatchObject({ method: 'POST', url: `${API}/orgs/imagile/repos` });
    expect(org.calls[0]!.body).toBe('{"name":"toil-probe"}');
    const user = await run(createRepoCommand, { name: 'toil-probe', private: true, autoInit: true, description: 'd', allowWrite: true }, fixture.routes!, { owner: 'imagile', repo: 'x' }, remote('git@ghe.imagile.dev:imagile/x.git'));
    expect(user.calls[0]).toMatchObject({ method: 'POST', url: `${API}/user/repos` });
    expect(user.calls[0]!.body).toBe('{"name":"toil-probe","description":"d","private":true,"auto_init":true}');
    expect(user.envelope.meta.context?.inputs).toEqual({});
  });

  it('issue create sends labels and assignees only when given, and reads --body-file', async () => {
    const { calls } = await run(createIssueCommand, { ...BASE, title: 'T', bodyFile: 'issue-body.md', label: [], allowWrite: true });
    expect(calls[0]!.body).toBe(JSON.stringify({ title: 'T', body: 'Issue body from a file.\n' }));
    const full = await run(createIssueCommand, { ...BASE, title: 'T', label: ['bug'], assignee: ['octo-dev'], allowWrite: true });
    expect(full.calls[0]!.body).toBe(JSON.stringify({ title: 'T', labels: ['bug'], assignees: ['octo-dev'] }));
  });

  it('issue label needs a label, checked after the repo; data is GitHub\'s array as it came', async () => {
    expect((await run(addLabelsCommand, { number: '7', allowWrite: true })).envelope.error?.message).toMatch(/^Could not determine/);
    expect((await run(addLabelsCommand, { ...BASE, number: '7', allowWrite: true })).envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'At least one --label is required' });
    const { envelope, calls } = await run(addLabelsCommand, { ...BASE, number: '7', label: ['bug', 'needs-review'], allowWrite: true });
    expect(calls[0]!.body).toBe('{"labels":["bug","needs-review"]}');
    expect(envelope.data).toEqual([label('bug'), label('needs-review', 2)]);
  });

  it('issue unlabel: the label is encoded as one path segment, so #72 item 4 names the label it was given', async () => {
    const any: Route[] = [{ method: 'DELETE', url: /.*/, respond: { status: 200, json: [] } }];
    const cases: Array<[string, string]> = [
      ['needs review', `${API}/repos/imagile/toil-probe/issues/7/labels/needs%20review`],
      ['area/api', `${API}/repos/imagile/toil-probe/issues/7/labels/area%2Fapi`],
      ['needs-info?', `${API}/repos/imagile/toil-probe/issues/7/labels/needs-info%3F`],
      ['p1#hot', `${API}/repos/imagile/toil-probe/issues/7/labels/p1%23hot`],
      ['50%', `${API}/repos/imagile/toil-probe/issues/7/labels/50%25`],
      // A label really named with a percent-encoded dot is that name, not a dot segment.
      ['%2e%2E/x', `${API}/repos/imagile/toil-probe/issues/7/labels/%252e%252E%2Fx`],
    ];
    for (const [name, url] of cases) {
      const { envelope, calls } = await run(removeLabelCommand, { ...BASE, number: '7', label: name, allowWrite: true }, any);
      expect(calls[0]!.url, name).toBe(url);
      expect(envelope.data).toEqual({ removed: true, label: name });
    }
  });

  it('issue assign POSTs the logins; pr remove-reviewers DELETEs with a JSON body and returns { removed: true }', async () => {
    const add = await run(addAssigneesCommand, { ...BASE, number: '7', assignee: ['octo-dev'], allowWrite: true });
    expect(add.calls[0]).toMatchObject({ method: 'POST', url: `${API}/repos/imagile/toil-probe/issues/7/assignees`, body: '{"assignees":["octo-dev"]}' });
    const remove = await run(removeReviewersCommand, { ...BASE, number: '7', teamReviewer: ['platform'], allowWrite: true });
    expect(remove.calls[0]).toMatchObject({ method: 'DELETE', url: `${API}/repos/imagile/toil-probe/pulls/7/requested_reviewers`, body: '{"team_reviewers":["platform"]}' });
    expect(remove.envelope.data).toEqual({ removed: true });
    expect((await run(removeReviewersCommand, { ...BASE, number: '7', allowWrite: true })).envelope.error?.message).toBe('At least one --reviewer or --team-reviewer is required');
  });
});
