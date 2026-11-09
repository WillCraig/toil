// @vitest-environment node
/**
 * A GitHub toil project with no project board, end to end through toil's own
 * `execute()` from `@imagile-dev/toil/api`, with only `fetch` stubbed: GitHub
 * answers with REST payloads shaped like the real ones (issues, timelines, pull
 * requests and check runs, trimmed to the fields toil reads), and the sync,
 * the cache and the loader run unchanged. toil's home is a throwaway folder,
 * never the real ~/.toil, and nothing reaches a network: a request no route
 * answers fails the test. Twenty-five issues and not one of them on a board,
 * which is how most repositories are run, whatever the planning deck says.
 */

import { execute, mapOwi } from '@imagile-dev/toil/api';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Cache } from '../server/cache.ts';
import type { RequestContext } from '../server/context.ts';
import { sqliteStore } from '../server/store.ts';
import { SKEW_MS, SyncService } from '../server/sync.ts';
import { CHECKED_CLOSED_PRS, CLOSED_ISSUE_HISTORIES, checkedPrs, historyNumbers, loadToilProject } from '../src/load.ts';
import { columns } from '../src/model/board.ts';
import { flows } from '../src/model/flow.ts';
import { dependencyGraph } from '../src/model/graph.ts';
import { health } from '../src/model/sprint.ts';
import type { Change, Execute } from '../src/toil.ts';

const API = 'https://api.github.com';
const REPO = `${API}/repos/imagile/payments-sandbox`;
const HTML = 'https://github.com/imagile/payments-sandbox';
const ctx: RequestContext = { viewer: { id: 'local', name: 'you', via: 'loopback' }, signal: new AbortController().signal };

const user = (login: string) => ({ login, id: 1, type: 'User', html_url: `https://github.com/${login}` });
const label = (name: string) => ({ id: 1, name, color: 'c5def5' });
function issue(number: number, title: string, state: 'open' | 'closed', updated: string, extra: Record<string, unknown> = {}) {
  return {
    url: `${REPO}/issues/${number}`,
    html_url: `${HTML}/issues/${number}`,
    number,
    title,
    state,
    state_reason: state === 'closed' ? 'completed' : null,
    user: user('you'),
    labels: [label('type: bug'), label('points: 3')],
    assignee: null,
    assignees: [],
    milestone: { number: 2, title: 'Sprint 42', state: 'open', due_on: '2026-10-26T07:00:00Z' },
    comments: 0,
    created_at: '2026-10-19T22:02:30Z',
    updated_at: updated,
    closed_at: state === 'closed' ? updated : null,
    body: 'Test data.',
    ...extra,
  };
}
const event = (name: string, at: string, extra: Record<string, unknown> = {}) => ({ event: name, created_at: at, actor: user('you'), ...extra });
const pr = (number: number, title: string, body: string, head: string, extra: Record<string, unknown> = {}) => ({
  url: `${REPO}/pulls/${number}`,
  html_url: `${HTML}/pull/${number}`,
  number,
  state: 'open',
  title,
  body,
  draft: false,
  user: user('you'),
  created_at: '2026-10-19T22:03:20Z',
  updated_at: '2026-10-19T22:03:20Z',
  closed_at: null,
  merged_at: null,
  merge_commit_sha: null,
  head: { ref: `branch-${number}`, sha: head },
  base: { ref: 'main', sha: '0000000' },
  ...extra,
});
const check = (name: string, conclusion: string) => ({
  id: 1,
  name,
  head_sha: 'x',
  status: 'completed',
  conclusion,
  started_at: '2026-10-19T22:03:30Z',
  completed_at: '2026-10-19T22:03:40Z',
  html_url: `${HTML}/actions/runs/1/job/1`,
});

interface Github {
  issues: ReturnType<typeof issue>[];
  urls: string[];
}

/** GitHub's REST API, as far as these calls go, routed by method and path. */
function stubGithub(): Github {
  const gh: Github = {
    issues: [
      issue(7, 'Tokenise stored cards at the edge so the core service never sees a PAN', 'open', '2026-10-19T22:02:40Z'),
      issue(8, 'Rotate the card vault encryption keys without downtime', 'open', '2026-10-19T22:03:01Z', { body: 'Blocked by #7.' }),
      issue(14, 'Settlement glossary for new engineers', 'closed', '2026-10-19T22:03:25Z'),
    ],
    urls: [],
  };
  const timelines: Record<number, unknown[]> = {
    7: [event('labeled', '2026-10-19T22:02:38Z', { label: label('type: bug') }), event('cross-referenced', '2026-10-19T22:03:01Z', { source: { type: 'issue', issue: { number: 8, html_url: `${HTML}/issues/8`, repository: { full_name: 'imagile/payments-sandbox' } } } })],
    8: [event('labeled', '2026-10-19T22:02:39Z', { label: label('blocked') })],
    14: [event('closed', '2026-10-19T22:03:25Z')],
  };
  const pulls = [
    pr(26, 'docs: settlement glossary', 'Closes #14.', 'aaaaaaa', { state: 'closed', merged_at: '2026-10-19T22:03:25Z', merge_commit_sha: 'bbbbbbb', closed_at: '2026-10-19T22:03:25Z' }),
    pr(29, 'fix: back off payout retries exponentially', 'Closes #7.', 'ccccccc'),
  ];
  const checks: Record<string, unknown[]> = {
    aaaaaaa: [check('build', 'success'), check('test', 'success')],
    // The push and the pull request each ran both jobs.
    ccccccc: [check('test', 'failure'), check('build', 'success'), check('build', 'success'), check('test', 'failure')],
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    gh.urls.push(`${method} ${url.pathname}${url.search}`);
    if (method !== 'GET') throw new Error(`The stub answers GETs only, not ${method} ${url.href}`);
    const path = url.pathname.replace('/repos/imagile/payments-sandbox', '');
    if (path === '/issues') {
      const since = url.searchParams.get('since');
      return json(gh.issues.filter((i) => !since || i.updated_at >= since));
    }
    const timeline = /^\/issues\/(\d+)\/timeline$/.exec(path);
    if (timeline) return json(timelines[Number(timeline[1])] ?? []);
    if (path === '/pulls') {
      // With --updated-since, toil asks newest-updated first and stops at an older one.
      return json(url.searchParams.get('sort') === 'updated' ? [...pulls].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)) : pulls);
    }
    const one = /^\/pulls\/(\d+)$/.exec(path);
    if (one) return json({ ...pulls.find((p) => p.number === Number(one[1]))!, mergeable: true, additions: 12, deletions: 3, changed_files: 2 });
    // pr get --include: no reviews yet, no commits worth reading, and two files.
    if (/^\/pulls\/\d+\/(reviews|commits)$/.test(path)) return json([]);
    if (/^\/pulls\/\d+\/files$/.test(path)) return json([{ filename: 'src/payout.ts', additions: 10, deletions: 3 }, { filename: 'docs/glossary.md', additions: 2, deletions: 0 }]);
    const runs = /^\/commits\/(\w+)\/check-runs$/.exec(path);
    if (runs) return json({ total_count: checks[runs[1]!]!.length, check_runs: checks[runs[1]!] });
    // No CODEOWNERS in this repository, wherever GitHub would look.
    if (/^\/contents\/(\.github\/|docs\/)?CODEOWNERS$/.test(path)) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    throw new Error(`No GitHub route for ${method} ${url.href}`);
  });
  return gh;
}

const saved: Record<string, string | undefined> = {};
const folders: string[] = [];
const caches: Cache[] = [];

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'toil-ui-github-'));
  folders.push(home);
  mkdirSync(join(home, '.toil', 'projects'), { recursive: true });
  writeFileSync(join(home, '.toil', 'config.json'), JSON.stringify({ version: 2, connections: { github: { area: 'github', baseUrl: API } }, audit: { enabled: false } }));
  writeFileSync(join(home, '.toil', 'projects', 'sandbox.json'), JSON.stringify({ name: 'sandbox', repos: [], github: { connection: 'github', owner: 'imagile', repo: 'payments-sandbox' } }));
  for (const key of ['HOME', 'USERPROFILE', 'TOIL_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GITHUB_API_URL', 'TOIL_TOIL_PROJECT', 'TOIL_TOIL_PROJECT_PATHS']) saved[key] = process.env[key];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.TOIL_GITHUB_TOKEN = 'test-token';
  for (const key of ['GITHUB_TOKEN', 'GITHUB_API_URL', 'TOIL_TOIL_PROJECT', 'TOIL_TOIL_PROJECT_PATHS']) delete process.env[key];
});

afterEach(() => {
  vi.unstubAllGlobals();
  while (caches.length) caches.pop()!.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (folders.length) rmSync(folders.pop()!, { recursive: true, force: true, maxRetries: 3 });
});

async function syncOnce(start: string) {
  const dataDir = mkdtempSync(join(tmpdir(), 'toil-ui-github-cache-'));
  folders.push(dataDir);
  let clock = Date.parse(start);
  const now = () => new Date(clock);
  const cache = await Cache.open(dataDir, { retentionDays: 30, now });
  caches.push(cache);
  const sync = new SyncService({ cache, execute: execute as unknown as ConstructorParameters<typeof SyncService>[0]['execute'], mapOwi, now });
  const store = sqliteStore(() => cache, execute as unknown as Execute, { version: 'x', contractVersion: 1 });
  const viaStore: Execute = (command, input = {}) => store.execute(ctx, command, input, 'read');
  return { cache, sync, viaStore, advance: (ms: number) => (clock += ms) };
}

describe('a GitHub Toil project with no project board', () => {
  it("reads the repository's issues, their timelines, pull requests and checks, and the dashboard renders them from the cache", async () => {
    const gh = stubGithub();
    const { sync, viaStore } = await syncOnce('2026-10-19T22:10:00Z');
    const job = await sync.run(ctx);
    expect(job.error).toBeNull();
    expect(sync.status().toilProjects.find((d) => d.name === 'sandbox')?.sources).toEqual([expect.objectContaining({ area: 'github', status: 'ok' })]);

    // Every request was a GET to the configured host, and the issues were asked for open and closed.
    expect(gh.urls.every((u) => u.startsWith('GET /repos/imagile/payments-sandbox/'))).toBe(true);
    expect(gh.urls.some((u) => /\/issues\?.*state=all/.test(u))).toBe(true);
    expect(gh.urls.filter((u) => u.includes('/timeline'))).toHaveLength(3);

    const data = await loadToilProject(viaStore, 'sandbox', { mapOwi });
    expect(data.items.map((i) => [i.id, i.statusCategory]).sort()).toEqual([
      ['github:imagile/payments-sandbox#14', 'DONE'],
      ['github:imagile/payments-sandbox#7', 'TODO'],
      ['github:imagile/payments-sandbox#8', 'TODO'],
    ]);
    // Issues with no issue type are work: they're on the board, not left off as containers.
    expect(columns(data.items).map((c) => [c.category, c.items.length])).toEqual([['TODO', 2], ['IN_PROGRESS', 0], ['DONE', 1]]);
    const feature = { ...data.items[0]!, type: 'OTHER' as const, typeName: 'Feature' };
    expect([flows(data.items[0]!), flows(feature), flows({ ...feature, type: 'EPIC' as const, typeName: 'Epic' })]).toEqual([true, false, false]);
    const prs = data.changes.filter((c) => c.kind === 'pull-request');
    expect(prs.map((p) => [p.title, p.items])).toEqual([
      ['docs: settlement glossary', ['github:imagile/payments-sandbox#14']],
      ['fix: back off payout retries exponentially', ['github:imagile/payments-sandbox#7']],
    ]);
    // A job that ran for both the push and the pull request is named once.
    const failing = data.changes.find((c) => c.kind === 'build' && c.outcome === 'failed');
    expect([failing?.title, failing?.state]).toEqual(['test, build', 'failure (test)']);

    // With no board, the milestone is the sprint, the points label the estimate, and the body's Blocked by a link (#298).
    const sprint = health(data.items, data.changes, '2026-10-19T22:10:00Z');
    expect([sprint?.sprint.name, sprint?.sprint.start, sprint?.sprint.end, sprint?.items.length]).toEqual(['Sprint 42', '2026-10-12T07:00:00.000Z', '2026-10-26T07:00:00.000Z', 3]);
    expect([sprint?.done.points, sprint?.remaining.points]).toEqual([3, 6]);
    expect(data.items.find((i) => i.id.endsWith('#7'))?.estimate).toEqual({ value: 3, unit: 'points', field: 'label:points: 3' });
    expect(sprint?.risks).toEqual([
      { id: 'github:imagile/payments-sandbox#7', reasons: [{ code: 'failing-build', change: 'github:imagile/payments-sandbox#29/checks' }] },
      { id: 'github:imagile/payments-sandbox#8', reasons: [{ code: 'blocked', by: 'github:imagile/payments-sandbox#7' }] },
    ]);
    expect(dependencyGraph(data.items).edges.map((e) => [e.type, e.source, e.target])).toEqual([['blocks', 'github:imagile/payments-sandbox#7', 'github:imagile/payments-sandbox#8']]);
  });

  it("maps with the section's OWI fields, and leaves its --field aliases to the area's commands", async () => {
    stubGithub();
    const { sync, viaStore } = await syncOnce('2026-10-19T22:10:00Z');
    const toilProject = join(process.env.HOME!, '.toil', 'projects', 'sandbox.json');
    writeFileSync(toilProject, JSON.stringify({ name: 'sandbox', repos: [], github: { connection: 'github', owner: 'imagile', repo: 'payments-sandbox', fields: { estimateLabel: 'size/{n}', iterationDays: '7', storyPoints: 'Story Points' } } }));
    await sync.run(ctx);
    const data = await loadToilProject(viaStore, 'sandbox', { mapOwi });
    const item = data.items.find((i) => i.id.endsWith('#7'))!;
    expect(item.estimate).toBeNull();
    expect(item.iteration).toMatchObject({ name: 'Sprint 42', start: '2026-10-19T07:00:00.000Z' });
  });

  it('asks the next sync only for issues updated since the last one, and refetches only their timelines', async () => {
    const gh = stubGithub();
    const { sync, advance, viaStore } = await syncOnce('2026-10-19T22:10:00Z');
    await sync.run(ctx);
    advance(60 * 60_000);
    gh.urls.length = 0;
    gh.issues[1] = { ...gh.issues[1]!, state: 'closed', state_reason: 'completed', updated_at: '2026-10-19T23:05:00Z', closed_at: '2026-10-19T23:05:00Z' };
    await sync.run(ctx);

    const since = new Date(Date.parse('2026-10-19T22:10:00Z') - SKEW_MS).toISOString();
    const issues = gh.urls.filter((u) => u.includes('/issues?'));
    expect(issues).toHaveLength(1);
    expect(Date.parse(new URL(`https://x${issues[0]!.slice(4)}`).searchParams.get('since')!)).toBe(Date.parse(since));
    expect(gh.urls.filter((u) => u.includes('/timeline'))).toEqual(['GET /repos/imagile/payments-sandbox/issues/8/timeline?per_page=100&page=1']);

    const data = await loadToilProject(viaStore, 'sandbox', { mapOwi });
    expect(data.items).toHaveLength(3);
    expect(data.items.find((i) => i.id.endsWith('#8'))?.statusCategory).toBe('DONE');
  });
});

describe('the pull requests read in full', () => {
  const change = (n: number, state: Change['state'], at: string) => ({ id: `#${n}`, state, created: at, updated: at, closedAt: state === 'MERGED' ? at : null, mergedAt: state === 'MERGED' ? at : null });

  it('are every open one and only the newest closed ones', () => {
    const closed = Array.from({ length: CHECKED_CLOSED_PRS + 5 }, (_, i) => change(i, 'MERGED', new Date(Date.UTC(2026, 0, 1 + i)).toISOString()));
    const open = change(999, 'OPEN', '2020-01-01T00:00:00.000Z');
    const kept = checkedPrs([open, ...closed]);
    expect(kept).toHaveLength(CHECKED_CLOSED_PRS + 1);
    expect(kept).toContain(open);
    expect(kept.some((p) => p.id === '#0')).toBe(false);
    expect(kept.some((p) => p.id === `#${CHECKED_CLOSED_PRS + 4}`)).toBe(true);
  });
});

describe('the issues whose timelines are read', () => {
  it('are every open one and only the most recently closed ones', () => {
    const closed = Array.from({ length: CLOSED_ISSUE_HISTORIES + 5 }, (_, i) => ({ number: i + 1, state: 'closed', closed_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() }));
    const open = { number: 9999, state: 'open', closed_at: null, updated_at: '2020-01-01T00:00:00Z' };
    const kept = historyNumbers([open, ...closed, { state: 'open' }]);
    expect(kept).toHaveLength(CLOSED_ISSUE_HISTORIES + 1);
    expect(kept).toContain(9999);
    expect(kept).not.toContain(1);
    expect(kept).toContain(CLOSED_ISSUE_HISTORIES + 5);
  });
});
