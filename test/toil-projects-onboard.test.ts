import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { bitbucketArea } from '../src/areas/bitbucket/area.js';
import { githubArea } from '../src/areas/github/area.js';
import { connectionsCommands } from '../src/connections/commands.js';
import { defineArea, type AnyArea } from '../src/core/area.js';
import { loadConfig } from '../src/core/config.js';
import type { Context } from '../src/core/context.js';
import { hostMatches, selectorHost } from '../src/core/toil-project.js';
import type { Prompter } from '../src/core/prompt.js';
import { toilProjectBuildCommands, forSharing } from '../src/projects/build.js';
import { toilProjectsCommands } from '../src/projects/commands.js';
import { toilProjectOnboardCommands, suggestedBaseUrl, suggestedSettings } from '../src/projects/onboard.js';
import { runCli } from './harness/cli.js';
import { TEST_VERSION } from './harness/context.js';
import { toilProjectDisk, type ToilProjectDisk } from './harness/toil-projects.js';
import { fakeFetch, type Route } from './harness/fake-fetch.js';
import { fakeStore, type FakeStore } from './harness/fake-store.js';
import { memoryFiles } from './harness/files.js';
import { connectMcp } from './harness/mcp.js';

/**
 * `toil projects onboard`, and toil projects that are shareable by default: a
 * checked-in toil project on a real temp disk, a real config file, a fake
 * credential store and a scripted terminal. `hub` is a code host whose API is
 * on another host (as GitHub's is on api.github.com); `board` is a tracker
 * whose connections live under an organization path (as Azure DevOps
 * Services' do). Nothing here touches the network.
 */
const hub = defineArea({
  name: 'hub',
  description: 'A code host with its API on another host',
  connection: z.object({ baseUrl: z.url().describe('API root'), token: z.string().min(1).describe('Token') }),
  secrets: ['token'],
  siteApis: { 'hub.imagile.dev': 'https://api.hub.imagile.dev' },
  probe: () => ({ path: '/user' }),
  request: (c) => ({ baseUrl: c.baseUrl, headers: { Authorization: `Bearer ${c.token}` }, service: 'Hub', authFix: 'Create a new token.' }),
});
const board = defineArea({
  name: 'board',
  description: 'A tracker whose connections name an organization',
  connection: z.object({ baseUrl: z.url().describe('Organization URL'), pat: z.string().min(1).describe('Personal access token') }),
  secrets: ['pat'],
  context: { project: { description: 'Project', flags: '--project <project>' } },
  probe: () => ({ path: '/_apis/connectionData' }),
  request: (c) => ({ baseUrl: c.baseUrl, headers: { Authorization: `Basic ${c.pat}` }, service: 'Board', authFix: 'Create a new PAT.' }),
});
const areas: AnyArea[] = [hub, board];
const commands = [...connectionsCommands(areas), ...toilProjectsCommands(areas), ...toilProjectBuildCommands(areas), ...toilProjectOnboardCommands(areas)];
const HUB_TOKEN = 'hub-token-abc12345';
const BOARD_PAT = 'board-pat-abc12345';

const routes: Route[] = [
  { path: '/user', origin: 'https://api.hub.imagile.dev', respond: { json: { login: 'pat-ex' } } },
  { path: '/org1/_apis/connectionData', origin: 'https://board.imagile.dev', respond: { json: { authenticatedUser: { id: 'abc12345' } } } },
];

/** Checked into the repository the workspace is: the code host by host, the tracker by host with a project. */
const team = { name: 'team', hub: { host: 'hub.imagile.dev', owner: 'imagile' }, board: { host: 'board.imagile.dev', project: 'Sandbox' } };

const disks: ToilProjectDisk[] = [];
afterEach(() => {
  for (const d of disks.splice(0)) d.cleanup();
});

function repoDisk(toilProject: unknown = team): ToilProjectDisk {
  const d = toilProjectDisk({ 'work/.toil/projects/team.json': toilProject, 'work/.git/HEAD': 'ref: refs/heads/main\n', 'work/.git/config': '[remote "origin"]\n\turl = https://hub.imagile.dev/imagile/sandbox.git\n' });
  disks.push(d);
  return d;
}

/** A scripted terminal: answers by the question's start, and records every question. */
function terminal(answers: Array<[string, string]>) {
  const asked: Array<{ question: string; hidden: boolean }> = [];
  const answer = (question: string, hidden: boolean) => {
    asked.push({ question, hidden });
    return answers.find(([start]) => question.startsWith(start))?.[1];
  };
  const prompt: Prompter = { ask: async (q, fallback) => answer(q, false) || fallback || '', askSecret: async (q) => answer(q, true) ?? '' };
  return { prompt, asked };
}

function context(d: ToilProjectDisk, options: { prompt?: Prompter; store?: FakeStore; env?: NodeJS.ProcessEnv } = {}) {
  const env = options.env ?? {};
  const config = loadConfig({ env, cwd: d.workspace, home: d.home, areas: areas.map((a) => ({ name: a.name, contextInputs: Object.keys(a.context), ...(a.siteApis ? { siteApis: a.siteApis } : {}) })) });
  const http = fakeFetch(routes);
  const ctx: Context = {
    config,
    fetch: http.fetch,
    files: memoryFiles(),
    env,
    version: TEST_VERSION,
    verbose: false,
    debug: () => {},
    secrets: options.store ?? fakeStore(),
    toilProjects: d.catalog(config, { areas: areas.map((a) => ({ name: a.name, context: Object.keys(a.context), ...(a.siteApis ? { siteApis: a.siteApis } : {}) })) }),
    ...(options.prompt ? { prompt: options.prompt } : {}),
  };
  return { ctx, http };
}

const configFile = (d: ToilProjectDisk) => JSON.parse(readFileSync(join(d.home, '.toil', 'config.json'), 'utf8')) as { connections: Record<string, Record<string, unknown>> };

describe('toil projects onboard', () => {
  it("adds each connection the checked-in toil project needs through connections add, offering the host's API, then checks it and tests each", async () => {
    const d = repoDisk();
    const store = fakeStore();
    const answers = terminal([
      ['Toil project team', 'y'],
      ['token', HUB_TOKEN],
      ['pat', BOARD_PAT],
    ]);
    // The code host's offered base URL is kept; the tracker's names an organization, which a host can't, so the person types it.
    const typed: Prompter = {
      ask: async (q, fallback) => (q.startsWith('baseUrl') && fallback === 'https://board.imagile.dev' ? 'https://board.imagile.dev/org1' : answers.prompt.ask(q, fallback)),
      askSecret: (q) => answers.prompt.askSecret(q),
    };
    const { ctx, http } = context(d, { prompt: typed, store });
    const run = await runCli(['projects', 'onboard'], { commands, context: ctx });

    expect(run.envelope?.ok).toBe(true);
    expect(run.exitCode).toBe(0);
    const data = run.envelope!.data as { ok: boolean; plan: boolean; areas: Array<Record<string, unknown>>; check: { ok: boolean } };
    expect(data).toMatchObject({ ok: true, plan: false, check: { ok: true } });
    expect(data.areas).toEqual([
      { area: 'hub', env: null, path: 'hub', selects: { host: 'hub.imagile.dev' }, status: 'created', connection: 'hub', test: { ok: true, request: 'GET /user', live: true } },
      { area: 'board', env: null, path: 'board', selects: { host: 'board.imagile.dev' }, status: 'created', connection: 'board', test: { ok: true, request: 'GET /_apis/connectionData', live: true } },
    ]);
    // The toil project's host offered the API's base URL; the token was asked for hidden, and kept only in the store.
    const questions = answers.asked.map((a) => a.question);
    expect(questions).toContain('Name for the new hub connection');
    expect(answers.asked.find((a) => a.question.startsWith('token'))?.hidden).toBe(true);
    expect(configFile(d).connections).toEqual({
      hub: { area: 'hub', baseUrl: 'https://api.hub.imagile.dev', token: 'keychain:hub.token' },
      board: { area: 'board', baseUrl: 'https://board.imagile.dev/org1', pat: 'keychain:board.pat' },
    });
    expect(store.entries.get('hub.token')).toBe(HUB_TOKEN);
    expect(run.stdout + run.stderr).not.toContain(HUB_TOKEN);
    expect(http.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET https://api.hub.imagile.dev/user', 'GET https://board.imagile.dev/org1/_apis/connectionData']);
  });

  it('with no terminal, changes nothing and says what each area needs and how to set it up', async () => {
    const d = repoDisk();
    const { ctx, http } = context(d);
    const run = await runCli(['projects', 'onboard'], { commands, context: ctx });
    expect(run.exitCode).toBe(1);
    const data = run.envelope!.data as { ok: boolean; plan: boolean; areas: Array<{ status: string; problem?: { fix?: string } }> };
    expect(data).toMatchObject({ ok: false, plan: true });
    expect(data.areas.map((a) => a.status)).toEqual(['missing', 'missing']);
    expect(data.areas[0]!.problem?.fix).toBe('Run toil projects onboard team in a terminal, or toil connections add hub --area hub with a base URL on hub.imagile.dev (https://api.hub.imagile.dev).');
    expect((data.areas[0] as { suggest?: unknown }).suggest).toEqual({ name: 'hub', baseUrl: 'https://api.hub.imagile.dev' });
    expect(run.envelope!.meta.warnings?.map((w) => w.code)).toContain('ONBOARD_NO_TERMINAL');
    expect(existsSync(join(d.home, '.toil', 'config.json'))).toBe(false);
    expect(http.calls).toEqual([]);
  });

  it('--plan asks nothing even on a terminal, and reports a connection already on the host as matched', async () => {
    const d = repoDisk();
    const env = { TOIL_CONN_WORK_HUB_AREA: 'hub', TOIL_CONN_WORK_HUB_BASE_URL: 'https://api.hub.imagile.dev', TOIL_CONN_WORK_HUB_TOKEN: HUB_TOKEN };
    const { prompt, asked } = terminal([]);
    const { ctx } = context(d, { prompt, env });
    const run = await runCli(['projects', 'onboard', '--plan'], { commands, context: ctx });
    expect(asked).toEqual([]);
    const data = run.envelope!.data as { areas: Array<{ status: string; connection: string | null; test: unknown }> };
    expect(data.areas.map((a) => [a.status, a.connection])).toEqual([
      ['matched', 'work-hub'],
      ['missing', null],
    ]);
    expect(data.areas[0]!.test).toEqual({ ok: true, request: 'GET /user', live: true });
  });

  it("refuses a new connection that isn't on the toil project's host before saving it, and goes on to the next area", async () => {
    const d = repoDisk({ name: 'team', hub: { host: 'hub.imagile.dev' } });
    const { prompt } = terminal([
      ['Toil project team', 'y'],
      ['baseUrl', 'https://elsewhere.imagile.dev'],
      ['token', HUB_TOKEN],
    ]);
    const store = fakeStore();
    const { ctx } = context(d, { prompt, store });
    const run = await runCli(['projects', 'onboard'], { commands, context: ctx });
    expect(run.exitCode).toBe(1);
    expect((run.envelope!.data as { areas: Array<{ status: string }> }).areas[0]!.status).toBe('missing');
    expect(run.envelope!.meta.warnings?.find((w) => w.code === 'ONBOARD_NOT_ADDED')?.message).toContain("isn't on hub.imagile.dev");
    expect(store.entries.size).toBe(0);
    expect(existsSync(join(d.home, '.toil', 'config.json'))).toBe(false);
  });

  it('pins one of several matching connections in your own copy, which then applies, and says so', async () => {
    const d = repoDisk({ name: 'team', hub: { host: 'hub.imagile.dev' } });
    const env = {
      TOIL_CONN_HUB_A_AREA: 'hub', TOIL_CONN_HUB_A_BASE_URL: 'https://api.hub.imagile.dev', TOIL_CONN_HUB_A_TOKEN: 'a',
      TOIL_CONN_HUB_B_AREA: 'hub', TOIL_CONN_HUB_B_BASE_URL: 'https://hub.imagile.dev/api', TOIL_CONN_HUB_B_TOKEN: 'b',
    };
    const viaFlag = context(d, { env });
    const plan = await runCli(['projects', 'onboard', '--plan'], { commands, context: viaFlag.ctx });
    expect((plan.envelope!.data as { areas: Array<{ status: string; candidates?: string[] }> }).areas[0]).toMatchObject({ status: 'ambiguous', candidates: ['hub-a', 'hub-b'] });

    const { prompt, asked } = terminal([['Several', 'hub-a']]);
    const { ctx } = context(d, { prompt, env });
    const run = await runCli(['projects', 'onboard'], { commands, context: ctx });
    expect(asked.map((a) => a.question)).toEqual(["Several of your hub connections fit toil project team's hub: hub-a, hub-b. Which should your own copy of it use?"]);
    const data = run.envelope!.data as { ok: boolean; ownCopy: string; areas: Array<{ status: string; connection: string }> };
    expect(data.areas[0]).toMatchObject({ status: 'pinned', connection: 'hub-a' });
    expect(data.ownCopy).toBe(join(d.home, '.toil', 'projects', 'team.json').replace(/\\/g, '/'));
    expect(JSON.parse(readFileSync(join(d.home, '.toil', 'projects', 'team.json'), 'utf8'))).toMatchObject({ name: 'team', hub: { connection: 'hub-a' } });
    expect(run.envelope!.meta.warnings?.map((w) => w.code)).toContain('ONBOARD_OWN_COPY');

    // Pinned now, so a second run matches it by name, and --pin is refused for a connection you don't have.
    const again = await runCli(['projects', 'onboard', '--plan'], { commands, context: context(d, { env }).ctx });
    expect((again.envelope!.data as { areas: Array<{ status: string }> }).areas[0]!.status).toBe('matched');
    const wrong = await runCli(['projects', 'onboard', '--pin', 'hub=nope'], { commands, context: context(d, { env }).ctx });
    expect(wrong.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: 'You have no hub connection named nope.' });
  });

  it("pins an environment's section apart from the area's own, by its key path", async () => {
    const d = repoDisk({ name: 'team', hub: { host: 'hub.imagile.dev' }, environments: { prod: { hub: { host: 'hub.imagile.dev' } } } });
    const env = {
      TOIL_CONN_HUB_A_AREA: 'hub', TOIL_CONN_HUB_A_BASE_URL: 'https://api.hub.imagile.dev', TOIL_CONN_HUB_A_TOKEN: 'a',
      TOIL_CONN_HUB_B_AREA: 'hub', TOIL_CONN_HUB_B_BASE_URL: 'https://hub.imagile.dev/api', TOIL_CONN_HUB_B_TOKEN: 'b',
    };
    const run = await runCli(['projects', 'onboard', '--plan', '--pin', 'hub=hub-a', '--pin', 'environments.prod.hub=hub-b'], { commands, context: context(d, { env }).ctx });
    expect((run.envelope!.data as { areas: Array<{ path: string; connection: string }> }).areas.map((a) => [a.path, a.connection])).toEqual([
      ['hub', 'hub-a'],
      ['environments.prod.hub', 'hub-b'],
    ]);
    expect(JSON.parse(readFileSync(join(d.home, '.toil', 'projects', 'team.json'), 'utf8'))).toMatchObject({ hub: { connection: 'hub-a' }, environments: { prod: { hub: { connection: 'hub-b' } } } });
    const wrong = await runCli(['projects', 'onboard', '--plan', '--pin', 'environments.test.hub=hub-a'], { commands, context: context(d, { env }).ctx });
    expect(wrong.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Toil project team has no environments.test.hub section to pin.' });
  });

  it('is never an MCP tool', async () => {
    const d = repoDisk();
    const session = await connectMcp({ commands, context: context(d).ctx, areas: ['projects'] });
    try {
      const tools = (await session.client.listTools()).tools.map((t) => t.name);
      expect(tools).not.toContain('projects_onboard');
      expect(tools).toContain('projects_check');
    } finally {
      await session.close();
    }
  });
});

describe('shareable toil projects by default', () => {
  it("matches a host to a connection on the API the area names for it, and shares that connection as the host people know", () => {
    expect(hostMatches({ baseUrl: 'https://api.hub.imagile.dev' }, 'hub.imagile.dev', hub.siteApis)).toBe(true);
    expect(hostMatches({ baseUrl: 'https://api.hub.imagile.dev' }, 'hub.imagile.dev')).toBe(false);
    expect(hostMatches({ baseUrl: 'https://api.hub.imagile.dev' }, 'hub.imagile.dev:443', hub.siteApis)).toBe(false);
    expect(selectorHost({ baseUrl: 'https://api.hub.imagile.dev' }, hub.siteApis)).toBe('hub.imagile.dev');
    expect(selectorHost({ baseUrl: 'https://board.imagile.dev:8443/org1' })).toBe('board.imagile.dev:8443');
    expect(suggestedBaseUrl(hub, 'hub.imagile.dev')).toBe('https://api.hub.imagile.dev');
    // The real code hosts: github.com's API is api.github.com, and Enterprise Server's is on its own host.
    expect(hostMatches({ baseUrl: 'https://api.github.com' }, 'github.com', githubArea.siteApis)).toBe(true);
    expect(hostMatches({ baseUrl: 'https://ghe.imagile.dev/api/v3' }, 'ghe.imagile.dev', githubArea.siteApis)).toBe(true);
    expect(selectorHost({ baseUrl: 'https://api.bitbucket.org/2.0' }, bitbucketArea.siteApis)).toBe('bitbucket.org');
    expect(suggestedBaseUrl(githubArea, 'github.com')).toBe('https://api.github.com');
    // bitbucket.org is the hosted one, so a person onboarding it is offered deployment cloud; a server's host is not.
    expect(suggestedSettings(bitbucketArea, 'bitbucket.org')).toEqual({ baseUrl: 'https://api.bitbucket.org/2.0', deployment: 'cloud' });
    expect(suggestedSettings(bitbucketArea, 'bitbucket.imagile.dev')).toEqual({ baseUrl: 'https://bitbucket.imagile.dev' });
    expect(suggestedSettings(githubArea, 'github.com')).toEqual({ baseUrl: 'https://api.github.com' });
    expect(suggestedBaseUrl(board, 'board.imagile.dev')).toBe('https://board.imagile.dev');
    const config = loadConfig({ env: { TOIL_CONN_MINE_AREA: 'hub', TOIL_CONN_MINE_BASE_URL: 'https://api.hub.imagile.dev', TOIL_CONN_MINE_TOKEN: 't' }, cwd: '/', home: '/nonexistent-home', areas: [{ name: 'hub' }] });
    const shared = forSharing({ name: 'team', repos: [], sections: { hub: { connection: 'mine' } }, environments: {}, people: [] }, config, areas);
    expect(shared.toilProject.sections.hub).toEqual({ host: 'hub.imagile.dev' });
  });

  it('init --shared creates the toil project in the repository, and a link there records the connection\'s host', async () => {
    const d = repoDisk({ name: 'other' });
    const env = { TOIL_CONN_MINE_AREA: 'hub', TOIL_CONN_MINE_BASE_URL: 'https://api.hub.imagile.dev', TOIL_CONN_MINE_TOKEN: 't' };
    const init = await runCli(['projects', 'init', 'sandbox', '--shared'], { commands, context: context(d, { env }).ctx });
    expect(init.envelope).toMatchObject({ ok: true, data: { name: 'sandbox', source: 'repo', file: join(d.workspace, '.toil', 'projects', 'sandbox.json').replace(/\\/g, '/') } });

    // No terminal: the host is recorded, and a warning says so.
    const link = await runCli(['projects', 'link', 'sandbox', 'hub', '--connection', 'mine'], { commands, context: context(d, { env }).ctx });
    expect(link.envelope).toMatchObject({ ok: true, data: { section: { host: 'hub.imagile.dev' } } });
    expect(link.envelope!.meta.warnings?.map((w) => w.code)).toEqual(['TOIL_PROJECT_HOST_RECORDED']);

    // On a terminal it asks, and a person who says no keeps the name, with a warning that check repeats.
    const { prompt, asked } = terminal([['', 'n']]);
    const keep = await runCli(['projects', 'link', 'sandbox', 'hub', '--connection', 'mine', '--replace'], { commands, context: context(d, { env, prompt }).ctx });
    expect(asked[0]!.question).toContain('Record host hub.imagile.dev instead of connection mine?');
    expect(keep.envelope).toMatchObject({ ok: true, data: { section: { connection: 'mine' } } });
    const check = await runCli(['projects', 'check', 'sandbox'], { commands, context: context(d, { env }).ctx });
    expect((check.envelope!.data as { problems: unknown[] }).problems).toEqual([
      {
        level: 'warning',
        code: 'TOIL_PROJECT_CONNECTION_SHARED',
        path: 'hub.connection',
        message: 'This shared toil project selects connection "mine" by name, which works only for readers who named theirs the same. Select it by host instead: "host": "hub.imagile.dev" (toil projects link sandbox hub --host hub.imagile.dev --replace).',
      },
    ]);
  });

  it('init --repo needs --shared, and --shared needs a repository', async () => {
    const d = repoDisk();
    const repoOnly = await runCli(['projects', 'init', 'x', '--repo', '.'], { commands, context: context(d).ctx });
    expect(repoOnly.envelope?.error?.code).toBe('INVALID_INPUT');
    const notRepo = toilProjectDisk();
    disks.push(notRepo);
    const outside = await runCli(['projects', 'init', 'x', '--shared'], { commands, context: context(notRepo).ctx });
    expect(outside.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: "A shared toil project goes in a repository, and this folder isn't in one." });
  });
});
