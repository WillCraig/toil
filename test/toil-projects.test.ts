import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResolvedConfig, Settings, Source } from '../src/core/config.js';
import type { Envelope } from '../src/core/envelope.js';
import { forwardSlashes } from '../src/core/files.js';
import { toolName } from '../src/core/command.js';
import { allowWriteField, inFieldNames } from '../src/core/run.js';
import { currentPrCommand } from '../src/areas/bitbucket/server/pull-requests.js';
import { adoArea } from '../src/areas/ado/area.js';
import { workUpdateCommand } from '../src/areas/ado/server/work.js';
import { toilProjectBuildCommands } from '../src/projects/build.js';
import { toilProjectsCommands } from '../src/projects/commands.js';
import { areas as realAreas } from '../src/registry.js';
import { demoCommands, demoArea } from './fixtures/demo-commands.js';
import { demoContextArea, demoContextCommands } from './fixtures/demo-context-commands.js';
import { runCli } from './harness/cli.js';
import { testContext } from './harness/context.js';
import { toilProjectDisk, type ToilProjectDisk } from './harness/toil-projects.js';
import type { Route } from './harness/fake-fetch.js';
import { connectMcp, type McpSession } from './harness/mcp.js';

/**
 * Toil projects end to end, on real files in a temp folder and the test-only
 * demo-context area: which toil project applies (named, from TOIL_PROJECT, or
 * matched by the folder's repository), what it supplies to core's resolver,
 * host selectors, environments, the write rule, validation on every read,
 * and the bounds on a toil project path. Each case runs through the CLI and MCP
 * and compares the envelopes, since resolving identically on both doors is
 * the point.
 */

/** A write that names no project: it reads none of the group's context inputs. */
const pingWidgets = demoContextArea.command({
  path: ['demo-context', 'ping-widgets'],
  description: 'Ping the widget service',
  input: z.object({ ...allowWriteField }),
  writes: true,
  examples: [{ allowWrite: true }],
  run: async (_input, ctx) => {
    const res = await ctx.fetch(new URL('/api/ping', ctx.connection.baseUrl), { method: 'PUT', headers: { Authorization: `Bearer ${ctx.connection.token ?? ''}` } });
    return (await res.json()) as unknown;
  },
});

const commands = [pingWidgets, ...demoContextCommands, ...demoCommands, currentPrCommand, ...toilProjectsCommands([demoContextArea, demoArea]), ...toilProjectBuildCommands([demoContextArea, demoArea])];

/** Two demo-context connections on different hosts, writes on for both, prod the default. */
function configOf(extra: Partial<ResolvedConfig> = {}): ResolvedConfig {
  const connections: Record<string, Settings & { area: string }> = {
    prod: { area: 'demo-context', baseUrl: 'https://demo.imagile.dev', env: 'production', project: 'PRD', token: 'p', writes: true },
    stage: { area: 'demo-context', baseUrl: 'https://demo-stage.imagile.dev', env: 'staging', project: 'STG', token: 's', writes: true },
    demo: { area: 'demo', token: 't' },
  };
  const sources: Record<string, Source> = {};
  for (const [name, conn] of Object.entries(connections)) for (const key of Object.keys(conn)) sources[`${name}.${key}`] = 'env';
  return { connections, defaults: { 'demo-context': { connection: 'prod' }, demo: { connection: 'demo' } }, sources, files: { global: '/home/test/.toil/config.json' }, warnings: [], ...extra };
}

const routes: Route[] = [
  { path: /^\/api\/projects\/[A-Z0-9]+\/widgets\/W-\d+$/, respond: (req) => ({ json: { id: new URL(req.url).pathname.split('/').pop(), name: 'Widget' } }) },
  { method: 'PUT', path: /^\/api\/projects\/[A-Z0-9]+\/widgets\/W-\d+$/, respond: { json: { ok: true } } },
  { method: 'PUT', path: '/api/ping', respond: { json: { ok: true } } },
];

const disks: ToilProjectDisk[] = [];
const sessions: McpSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  for (const d of disks.splice(0)) d.cleanup();
});

function disk(files: Record<string, unknown> = {}): ToilProjectDisk {
  const d = toilProjectDisk(files);
  disks.push(d);
  return d;
}

/** The workspace as a git repository whose origin carries a token, as a clone made with one does. */
function asRepo(d: ToilProjectDisk, origin = 'https://ci-user:t0ken@git.imagile.dev/pay/payments-api.git'): void {
  d.write('work/.git/HEAD', 'ref: refs/heads/main\n');
  d.write('work/.git/config', `[remote "origin"]\n\turl = ${origin}\n`);
}

/** The same call through both doors; the envelopes must match, and the CLI's is returned. */
async function both(d: ToilProjectDisk, argv: string[], tool: string, args: Record<string, unknown>, options: { env?: NodeJS.ProcessEnv; config?: ResolvedConfig } = {}): Promise<{ envelope: Envelope; calls: Array<{ method: string; url: string }> }> {
  const config = options.config ?? configOf();
  const make = () => {
    const { context, http } = testContext({ routes });
    return { context: { ...context, config, toilProjects: d.catalog(config, { ...(options.env ? { env: options.env } : {}) }) }, http };
  };
  const cli = make();
  const viaCli = await runCli(argv, { commands, context: cli.context });
  const mcp = make();
  const session = await connectMcp({ commands, context: mcp.context, areas: ['demo-context', 'demo', 'projects', 'bitbucket'] });
  sessions.push(session);
  const viaMcp = await session.call(tool, args);
  const strip = (e: Envelope | undefined) => e && { ...e, meta: { ...e.meta, durationMs: 0 } };
  // Over MCP an input error names fields rather than flags (inFieldNames); everything else is identical.
  const def = commands.find((c) => toolName(c) === tool)!;
  expect(strip(viaMcp.envelope), 'CLI and MCP resolve identically').toEqual(strip(viaCli.envelope && inFieldNames(def, viaCli.envelope)));
  expect(mcp.http.calls).toEqual(cli.http.calls);
  return { envelope: viaCli.envelope!, calls: cli.http.calls };
}

const payments = {
  name: 'payments',
  description: 'Payments platform',
  repos: [{ name: 'payments-api', remotes: ['git@git.imagile.dev:pay/payments-api.git'] }, { name: 'ledger-svc', remotes: ['https://git.imagile.dev/pay/ledger-svc'] }],
  'demo-context': { project: { 'payments-api': 'PAY', 'ledger-svc': 'LEDG' }, projects: ['PAY', 'LEDG'] },
};

describe('which toil project applies', () => {
  it("matches the folder's origin to a repo's remote across SSH and HTTPS, and supplies that repo's keys", async () => {
    const d = disk({ 'home/.toil/projects/payments.json': payments });
    asRepo(d);
    const { envelope, calls } = await both(d, ['demo-context', 'get-widget', 'W-1'], 'demo_context_get_widget', { id: 'W-1' });
    expect(envelope.ok).toBe(true);
    expect(calls[0]?.url).toBe('https://demo.imagile.dev/api/projects/PAY/widgets/W-1?board=main');
    expect(envelope.meta.context).toEqual({
      toilProject: { name: 'payments', source: 'user', file: forwardSlashes(join(d.home, '.toil', 'projects', 'payments.json')), by: 'folder', match: 'remote', repo: 'payments-api', folder: { path: forwardSlashes(d.workspace), from: 'cwd' } },
      connection: { value: 'prod', source: 'default', default: 'named' },
      inputs: { project: { value: 'PAY', source: 'toil-project' }, board: { value: 'main', source: 'default' } },
    });
  });

  describe("a per-repo value when the folder is none of the toil project's repos (#540)", () => {
    // `project` is per repo and `board` is plain: the pair must come from the toil project or not at all.
    const perRepo = { ...payments, 'demo-context': { project: { 'payments-api': 'PAY', 'ledger-svc': 'LEDG' }, board: 'ops' } };
    const stranded = (envelope: Envelope) => {
      expect(envelope.ok).toBe(false);
      expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('payments-api, ledger-svc') });
      expect(envelope.error?.fix).toContain('--cwd');
      expect(envelope.meta.context?.inputs?.project).toBeUndefined();
    };

    it("reads the matching repo's value, and the plain one beside it", async () => {
      const d = disk({ 'home/.toil/projects/payments.json': perRepo });
      asRepo(d);
      const { envelope } = await both(d, ['demo-context', 'get-widget', 'W-1'], 'demo_context_get_widget', { id: 'W-1' });
      expect(envelope.meta.context?.inputs).toMatchObject({ project: { value: 'PAY', source: 'toil-project' }, board: { value: 'ops', source: 'toil-project' } });
    });

    it("refuses an unrelated repository's folder rather than pair the toil project's value with its git remote", async () => {
      const d = disk({ 'home/.toil/projects/payments.json': perRepo });
      asRepo(d, 'https://git.imagile.dev/other/unrelated.git');
      const { envelope, calls } = await both(d, ['demo-context', 'get-widget', 'W-1', '--toil-project', 'payments'], 'demo_context_get_widget', { id: 'W-1', toilProject: 'payments' });
      stranded(envelope);
      expect(calls).toEqual([]);
    });

    it("refuses a folder with no git rather than fall to the connection's own project", async () => {
      const d = disk({ 'home/.toil/projects/payments.json': perRepo });
      const { envelope, calls } = await both(d, ['demo-context', 'get-widget', 'W-1', '--toil-project', 'payments'], 'demo_context_get_widget', { id: 'W-1', toilProject: 'payments' });
      stranded(envelope);
      expect(calls).toEqual([]);
    });

    it("treats another per-repo input the call names itself as the caller's choice of target", async () => {
      const d = disk({ 'home/.toil/projects/payments.json': { ...payments, 'demo-context': { project: { 'payments-api': 'PAY' }, board: { 'payments-api': 'ops' } } } });
      const { envelope } = await both(d, ['demo-context', 'get-widget', 'W-1', '--toil-project', 'payments', '--board', 'mine'], 'demo_context_get_widget', { id: 'W-1', toilProject: 'payments', board: 'mine' });
      expect(envelope.ok).toBe(true);
      expect(envelope.meta.context?.inputs).toMatchObject({ board: { value: 'mine', source: 'input' }, project: { value: 'PRD', source: 'connection' } });
      const warning = envelope.meta.warnings?.find((w) => w.code === 'TOIL_PROJECT_REPO_UNMATCHED');
      expect(warning?.message).toContain('sets demo-context project per repo');
      expect(warning?.message).toContain("project came from the connection's setting instead");
      expect(warning?.message).toContain('Pass --project too');
    });

    it('keeps the old fall-through for a folder that matches a repo the per-repo map leaves out', async () => {
      const d = disk({ 'home/.toil/projects/payments.json': { ...payments, 'demo-context': { project: { 'ledger-svc': 'LEDG' } } } });
      asRepo(d);
      const { envelope } = await both(d, ['demo-context', 'get-widget', 'W-1', '--toil-project', 'payments'], 'demo_context_get_widget', { id: 'W-1', toilProject: 'payments' });
      expect(envelope.ok).toBe(true);
      expect(envelope.meta.context?.toilProject).toMatchObject({ repo: 'payments-api' });
      expect(envelope.meta.context?.inputs?.project).toEqual({ value: 'PRD', source: 'connection' });
      expect(envelope.meta.warnings?.map((w) => w.code) ?? []).not.toContain('TOIL_PROJECT_REPO_UNMATCHED');
    });

    it("counts only the area's context inputs as the caller choosing a target, not a flag like fields", () => {
      const d = disk({ 'home/.toil/projects/payments.json': { ...perRepo, 'demo-context': { ...perRepo['demo-context'], fields: { points: 'customfield_1' } } } });
      const { lookup } = d.catalog(configOf()).place({ toilProject: 'payments' });
      expect(() => lookup('demo-context', 'project', { fields: 'System.Title' })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    });

    it('lets the call name the input itself, and leaves an input the command never needs unresolved', async () => {
      const d = disk({ 'home/.toil/projects/payments.json': perRepo });
      const explicit = await both(d, ['demo-context', 'get-widget', 'W-1', '--toil-project', 'payments', '--project', 'OWN'], 'demo_context_get_widget', { id: 'W-1', toilProject: 'payments', project: 'OWN' });
      expect(explicit.envelope.ok).toBe(true);
      expect(explicit.envelope.meta.context?.inputs).toMatchObject({ project: { value: 'OWN', source: 'input' }, board: { value: 'ops', source: 'toil-project' } });
      const unneeded = await both(d, ['demo-context', 'echo-filters', '--toil-project', 'payments'], 'demo_context_echo_filters', { toilProject: 'payments' });
      expect(unneeded.envelope.ok).toBe(true);
      expect(unneeded.envelope.meta.context?.inputs?.project).toBeUndefined();
    });

    it.each([
      ['an unrelated git repository', true],
      ['a folder with no git', false],
    ])('warns, naming the toil project, its repos and the fix, when an optional input is left unresolved in %s', async (_name, git) => {
      const d = disk({ 'home/.toil/projects/payments.json': perRepo });
      if (git) asRepo(d, 'https://git.imagile.dev/other/unrelated.git');
      const { envelope } = await both(d, ['demo-context', 'echo-filters', '--toil-project', 'payments'], 'demo_context_echo_filters', { toilProject: 'payments' });
      expect(envelope.meta.context?.inputs?.project).toBeUndefined();
      const warning = envelope.meta.warnings?.find((w) => w.code === 'TOIL_PROJECT_REPO_UNMATCHED');
      expect(warning?.message).toContain('Toil project payments sets demo-context project per repo');
      expect(warning?.message).toContain('payments-api, ledger-svc');
      expect(warning?.message).toContain('--cwd');
    });
  });

  it('matches a repo by its path, and lets an explicit value win over the toil project', async () => {
    const d = disk();
    d.write('home/.toil/projects/payments.json', { ...payments, repos: [{ name: 'ledger-svc', path: d.workspace }] });
    const fromPath = await both(d, ['demo-context', 'get-widget', 'W-1'], 'demo_context_get_widget', { id: 'W-1' });
    expect(fromPath.envelope.meta.context?.toilProject).toMatchObject({ match: 'path', repo: 'ledger-svc' });
    expect(fromPath.envelope.meta.context?.inputs?.project).toEqual({ value: 'LEDG', source: 'toil-project' });
    const explicit = await both(d, ['demo-context', 'get-widget', 'W-1', '--project', 'OWN'], 'demo_context_get_widget', { id: 'W-1', project: 'OWN' });
    expect(explicit.envelope.meta.context?.inputs?.project).toEqual({ value: 'OWN', source: 'input' });
  });

  it('applies a toil project checked into the repository, and takes --toil-project and cwd by name or path on both doors', async () => {
    const d = disk({ 'other/.toil/projects/team.json': { name: 'team', 'demo-context': { project: 'TEAM' } } });
    d.write('other/.git/HEAD', 'ref: refs/heads/main\n');
    const other = join(d.root, 'other');
    const viaCwd = await both(d, ['demo-context', 'get-widget', 'W-1', '--cwd', other], 'demo_context_get_widget', { id: 'W-1', cwd: other });
    expect(viaCwd.envelope.meta.context?.toilProject).toMatchObject({ name: 'team', source: 'repo', by: 'folder', match: 'checked-in', folder: { from: 'input' } });
    expect(viaCwd.envelope.meta.context?.inputs?.project).toEqual({ value: 'TEAM', source: 'toil-project' });

    d.write('work/projects/loose.json', { name: 'loose', 'demo-context': { project: 'LOOSE' } });
    const viaPath = await both(d, ['demo-context', 'get-widget', 'W-1', '--toil-project', 'projects/loose.json'], 'demo_context_get_widget', { id: 'W-1', toilProject: 'projects/loose.json' });
    expect(viaPath.envelope.meta.context?.toilProject).toMatchObject({ name: 'loose', source: 'file', by: 'input' });
    expect(viaPath.envelope.meta.context?.inputs?.project).toEqual({ value: 'LOOSE', source: 'toil-project' });
  });

  it('takes TOIL_PROJECT, and a listed folder from TOIL_PROJECT_PATHS or projectPaths', async () => {
    const d = disk({ 'shared/team.json': { name: 'team', 'demo-context': { project: 'TEAM' } } });
    const shared = join(d.root, 'shared');
    for (const options of [{ env: { TOIL_PROJECT: 'team', TOIL_PROJECT_PATHS: shared } }, { env: { TOIL_PROJECT: 'team' }, config: configOf({ projectPaths: [shared] }) }]) {
      const { envelope } = await both(d, ['demo-context', 'get-widget', 'W-1'], 'demo_context_get_widget', { id: 'W-1' }, options);
      expect(envelope.meta.context?.toilProject).toMatchObject({ name: 'team', source: 'listed', by: 'env' });
      expect(envelope.meta.context?.inputs?.project?.value).toBe('TEAM');
    }
  });

  it('prefers your own copy over a listed folder over the repository, and says the name is in several places', async () => {
    const d = disk({
      'home/.toil/projects/payments.json': { ...payments, 'demo-context': { project: 'MINE' } },
      'work/.toil/projects/payments.json': { ...payments, 'demo-context': { project: 'REPO' } },
    });
    asRepo(d);
    const { envelope } = await both(d, ['demo-context', 'get-widget', 'W-1'], 'demo_context_get_widget', { id: 'W-1' });
    expect(envelope.meta.context?.inputs?.project?.value).toBe('MINE');
    expect(envelope.meta.warnings?.map((w) => w.code)).toContain('TOIL_PROJECT_DUPLICATE_NAME');
  });

  it('refuses to guess between two different toil projects that both match, on both doors', async () => {
    const d = disk({ 'home/.toil/projects/payments.json': payments, 'work/.toil/projects/payments-team.json': { name: 'payments-team' } });
    asRepo(d);
    const { envelope, calls } = await both(d, ['demo-context', 'get-widget', 'W-1'], 'demo_context_get_widget', { id: 'W-1' });
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('2 toil projects apply'), fix: expect.stringContaining('--toil-project <name>') });
    expect(calls).toEqual([]);
    const chosen = await both(d, ['demo-context', 'get-widget', 'W-1', '--toil-project', 'payments-team'], 'demo_context_get_widget', { id: 'W-1', toilProject: 'payments-team' });
    expect(chosen.envelope.ok).toBe(true);
  });

  it("doesn't fail a call that never reaches the toil project step on an ambiguous folder, and reports no toil project", async () => {
    const d = disk({ 'home/.toil/projects/payments.json': payments, 'work/.toil/projects/payments-team.json': { name: 'payments-team' } });
    asRepo(d);
    // An area with nothing set up, answered by the command itself.
    const unconfigured = await both(d, ['bitbucket', 'pr', 'current'], 'bitbucket_pr_current', {});
    expect(unconfigured.envelope).toMatchObject({ ok: true, data: { message: 'Requires Bitbucket config. Available after toil connections add.' } });
    expect(unconfigured.envelope.meta.context?.toilProject).toBeUndefined();
    // Every input and the connection given: the toil project is never asked.
    const explicit = await both(d, ['demo-context', 'get-widget', 'W-1', '--connection', 'prod', '--project', 'OWN', '--board', 'ops'], 'demo_context_get_widget', { id: 'W-1', connection: 'prod', project: 'OWN', board: 'ops' });
    expect(explicit.envelope.ok).toBe(true);
    expect(explicit.envelope.meta.context).toEqual({ connection: { value: 'prod', source: 'input' }, inputs: { project: { value: 'OWN', source: 'input' }, board: { value: 'ops', source: 'input' } } });
    expect(explicit.envelope.meta.warnings).toBeUndefined();
  });

  it('still checks a toil project the call names, or TOIL_PROJECT names, on a call that never consults it', async () => {
    const d = disk({ 'home/.toil/projects/payments.json': payments, 'home/.toil/config.json': { version: 2, connections: {} } });
    d.write('home/.toil/projects/broken.json', '{"name": "broken", "name": "broken", "repos": "nope"}');
    asRepo(d);
    const explicit = ['demo-context', 'get-widget', 'W-1', '--connection', 'prod', '--project', 'OWN', '--board', 'ops'];
    const explicitArgs = { id: 'W-1', connection: 'prod', project: 'OWN', board: 'ops' };
    const cases: Array<[string, string, RegExp]> = [
      ['nope', 'INVALID_INPUT', /no toil project named "nope"/],
      ['broken', 'CONFIG_INVALID', /broken\.json can't be used/],
      [join(d.home, '.toil', 'config.json'), 'INVALID_INPUT', /one of toil's own files/],
      ['missing.json', 'INVALID_INPUT', /doesn't exist where toil is running/],
    ];
    for (const [toilProject, code, message] of cases) {
      for (const [argv, tool, args] of [
        [explicit, 'demo_context_get_widget', explicitArgs],
        [['bitbucket', 'pr', 'current'], 'bitbucket_pr_current', {}],
      ] as const) {
        const { envelope, calls } = await both(d, [...argv, '--toil-project', toilProject], tool, { ...args, toilProject });
        expect(envelope.error, `${argv.join(' ')} --toil-project ${toilProject}`).toMatchObject({ code, message: expect.stringMatching(message) });
        expect(calls).toEqual([]);
      }
    }
    const fromEnv = await both(d, explicit, 'demo_context_get_widget', explicitArgs, { env: { TOIL_PROJECT: 'nope' } });
    expect(fromEnv.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('no toil project named "nope"') });
    // A named toil project that's fine runs the call as it would have, and is reported, since the call named it.
    const fine = await both(d, [...explicit, '--toil-project', 'payments'], 'demo_context_get_widget', { ...explicitArgs, toilProject: 'payments' });
    expect(fine.envelope.ok).toBe(true);
    expect(fine.envelope.meta.context?.toilProject).toMatchObject({ name: 'payments', by: 'input' });
    expect(fine.envelope.meta.context?.inputs?.project).toEqual({ value: 'OWN', source: 'input' });
  });

  it('has no toil project outside every match, and the call still needs its keys', async () => {
    const d = disk({ 'home/.toil/projects/payments.json': payments });
    const { envelope } = await both(d, ['demo-context', 'get-widget', 'W-1'], 'demo_context_get_widget', { id: 'W-1' });
    expect(envelope.meta.context?.toilProject).toBeUndefined();
    expect(envelope.meta.context?.inputs?.project).toEqual({ value: 'PRD', source: 'connection' });
  });
});

describe('a running MCP server', () => {
  it('reads toil projects on every call, so an edit applies from the next one, and its tools never depend on them', async () => {
    const d = disk({ 'home/.toil/projects/payments.json': payments });
    asRepo(d);
    const config = configOf();
    const { context } = testContext({ routes });
    const session = await connectMcp({ commands, context: { ...context, config, toilProjects: d.catalog(config, { mcp: true }) }, areas: ['demo-context'] });
    sessions.push(session);
    const before = (await session.client.listTools()).tools;
    expect((await session.call('demo_context_get_widget', { id: 'W-1' })).envelope.meta.context?.inputs?.project?.value).toBe('PAY');
    d.write('home/.toil/projects/payments.json', { ...payments, 'demo-context': { project: 'EDITED' } });
    const after = await session.call('demo_context_get_widget', { id: 'W-1' });
    expect(after.envelope.meta.context?.inputs?.project?.value).toBe('EDITED');
    expect(after.envelope.meta.context?.toilProject?.folder).toEqual({ path: forwardSlashes(d.workspace), from: 'mcp-root' });
    expect((await session.client.listTools()).tools).toEqual(before);
  });
});

describe('connections a toil project selects', () => {
  it('selects by host, compared and never contacted, and reports the host', async () => {
    const d = disk({ 'home/.toil/projects/payments.json': { ...payments, 'demo-context': { host: 'DEMO-STAGE.imagile.dev' } } });
    asRepo(d);
    const { envelope, calls } = await both(d, ['demo-context', 'get-widget', 'W-1'], 'demo_context_get_widget', { id: 'W-1' });
    expect(envelope.meta.context?.connection).toEqual({ value: 'stage', source: 'toil-project', host: 'DEMO-STAGE.imagile.dev' });
    expect(calls[0]?.url).toBe('https://demo-stage.imagile.dev/api/projects/STG/widgets/W-1?board=main');
  });

  it('fails loudly when a host selects none or several of your connections, never falling back to the default', async () => {
    const d = disk({ 'home/.toil/projects/payments.json': { ...payments, 'demo-context': { host: 'nowhere.imagile.dev' } } });
    asRepo(d);
    const none = await both(d, ['demo-context', 'get-widget', 'W-1'], 'demo_context_get_widget', { id: 'W-1' });
    expect(none.envelope.error).toMatchObject({ code: 'NOT_CONFIGURED', message: expect.stringContaining('nowhere.imagile.dev') });
    expect(none.calls).toEqual([]);

    const twins = configOf();
    twins.connections.prod2 = { ...twins.connections.prod!, env: 'production-2' };
    d.write('home/.toil/projects/payments.json', { ...payments, 'demo-context': { host: 'demo.imagile.dev' } });
    const several = await both(d, ['demo-context', 'get-widget', 'W-1'], 'demo_context_get_widget', { id: 'W-1' }, { config: twins });
    expect(several.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('prod, prod2') });
  });

  it("feeds the toil project's environment into the area's own --env, and an explicit --env picks that environment's section", async () => {
    const d = disk({
      'home/.toil/projects/payments.json': {
        ...payments,
        env: 'staging',
        environments: { staging: { 'demo-context': { project: 'STG2' } }, production: { 'demo-context': { project: 'PRD2' } } },
      },
    });
    asRepo(d);
    const implied = await both(d, ['demo-context', 'get-widget', 'W-1'], 'demo_context_get_widget', { id: 'W-1' });
    expect(implied.envelope.meta.context).toMatchObject({ connection: { value: 'stage', source: 'toil-project', via: 'env' }, inputs: { env: { value: 'staging', source: 'toil-project' }, project: { value: 'STG2', source: 'toil-project' } } });
    const explicit = await both(d, ['demo-context', 'get-widget', 'W-1', '--env', 'production'], 'demo_context_get_widget', { id: 'W-1', env: 'production' });
    expect(explicit.envelope.meta.context).toMatchObject({ connection: { value: 'prod', source: 'input', via: 'env' }, inputs: { project: { value: 'PRD2', source: 'toil-project' } } });
  });
});

describe('writes through a toil project', () => {
  const rename = (extra: string[] = []) => ['demo-context', 'rename-widget', 'W-1', '--name', 'N', '--allow-write', ...extra];
  const renameArgs = { id: 'W-1', name: 'N', allowWrite: true };

  it("refuses a write on a connection a checked-in toil project chose, until you import it; reads follow it", async () => {
    const d = disk({ 'work/.toil/projects/payments.json': { ...payments, 'demo-context': { connection: 'stage', project: 'STG' } } });
    asRepo(d);
    const refused = await both(d, rename(), 'demo_context_rename_widget', renameArgs);
    expect(refused.envelope.error).toMatchObject({ code: 'WRITE_DISABLED', message: expect.stringContaining('connection stage was chosen by your toil project') });
    expect(refused.calls).toEqual([]);
    const read = await both(d, ['demo-context', 'get-widget', 'W-1'], 'demo_context_get_widget', { id: 'W-1' });
    expect(read.envelope.meta.context?.connection).toEqual({ value: 'stage', source: 'toil-project' });
    // Naming the connection isn't enough while the toil project still sets the project; naming both is.
    const named = await both(d, rename(['--connection', 'stage', '--project', 'STG']), 'demo_context_rename_widget', { ...renameArgs, connection: 'stage', project: 'STG' });
    expect(named.envelope.ok).toBe(true);
  });

  it('lets a write follow your own toil project: its bindings are yours', async () => {
    const d = disk({ 'home/.toil/projects/payments.json': { ...payments, 'demo-context': { connection: 'stage', project: 'STG' } } });
    asRepo(d);
    const { envelope, calls } = await both(d, rename(), 'demo_context_rename_widget', renameArgs);
    expect(envelope.ok).toBe(true);
    expect(calls.map((c) => [c.method, c.url])).toEqual([['PUT', 'https://demo-stage.imagile.dev/api/projects/STG/widgets/W-1']]);
  });

  it('takes the default connection for a section with no binding, which was always yours', async () => {
    const d = disk({ 'work/.toil/projects/payments.json': { ...payments, 'demo-context': { project: 'STG' } } });
    asRepo(d);
    const { envelope } = await both(d, rename(['--project', 'STG']), 'demo_context_rename_widget', { ...renameArgs, project: 'STG' });
    expect(envelope.ok).toBe(true);
    expect(envelope.meta.context?.connection).toMatchObject({ value: 'prod', source: 'default' });
  });
});

describe('a write takes its target only from a toil project you adopted', () => {
  const rename = (extra: string[] = []) => ['demo-context', 'rename-widget', 'W-1', '--name', 'N', '--allow-write', ...extra];
  const checkedIn = () => {
    const d = disk({ 'work/.toil/projects/payments.json': { ...payments, 'demo-context': { project: 'OTHER' } } });
    asRepo(d);
    return d;
  };
  /** The CLI and MCP separately: their fix text differs, since only the CLI can adopt a toil project. */
  async function doors(d: ToilProjectDisk, argv: string[], args: Record<string, unknown>) {
    const config = configOf();
    const make = () => {
      const { context, http } = testContext({ routes });
      return { context: { ...context, config, toilProjects: d.catalog(config) }, http };
    };
    const cli = make();
    const viaCli = await runCli(argv, { commands, context: cli.context });
    const mcp = make();
    const session = await connectMcp({ commands, context: mcp.context, areas: ['demo-context', 'projects'] });
    sessions.push(session);
    const viaMcp = await session.call('demo_context_rename_widget', args);
    return { cli: viaCli.envelope!, mcp: viaMcp.envelope, calls: [...cli.http.calls, ...mcp.http.calls] };
  }

  it("refuses a write whose project came from a checked-in toil project, on a writes-on default connection, before any request", async () => {
    const d = checkedIn();
    const { cli, mcp, calls } = await doors(d, rename(), { id: 'W-1', name: 'N', allowWrite: true });
    expect(calls).toEqual([]);
    expect(cli.meta.context?.connection).toMatchObject({ value: 'prod', source: 'default' });
    expect(cli.error).toMatchObject({ code: 'WRITE_DISABLED', message: expect.stringContaining("project came from toil project payments, which you haven't adopted"), fix: expect.stringContaining('toil projects import payments (the CLI only), or pass --project yourself') });
    expect(mcp.error).toMatchObject({ code: 'WRITE_DISABLED', fix: expect.stringContaining('Ask the user to adopt it') });
  });

  it('lets the same write through once the toil project is imported', async () => {
    const d = checkedIn();
    const config = configOf();
    const { context } = testContext({ routes });
    const imported = await runCli(['projects', 'import', join(d.workspace, '.toil', 'projects', 'payments.json')], { commands, context: { ...context, config, toilProjects: d.catalog(config) } });
    expect(imported.envelope?.ok, JSON.stringify(imported.envelope?.error)).toBe(true);
    const { envelope, calls } = await both(d, rename(), 'demo_context_rename_widget', { id: 'W-1', name: 'N', allowWrite: true });
    expect(envelope.ok).toBe(true);
    expect(calls.map((c) => [c.method, c.url])).toEqual([['PUT', 'https://demo.imagile.dev/api/projects/OTHER/widgets/W-1']]);
  });

  it('lets an explicit --project override the toil project and pass', async () => {
    const { envelope, calls } = await both(checkedIn(), rename(['--project', 'PRD']), 'demo_context_rename_widget', { id: 'W-1', name: 'N', allowWrite: true, project: 'PRD' });
    expect(envelope.ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(['https://demo.imagile.dev/api/projects/PRD/widgets/W-1']);
  });

  it("doesn't refuse a write over a toil project input the write never uses", async () => {
    const { envelope, calls } = await both(checkedIn(), ['demo-context', 'ping-widgets', '--allow-write'], 'demo_context_ping_widgets', { allowWrite: true });
    expect(envelope.ok, JSON.stringify(envelope.error)).toBe(true);
    expect(envelope.meta.context?.inputs?.project).toEqual({ value: 'OTHER', source: 'toil-project' });
    expect(calls.map((c) => c.method + ' ' + new URL(c.url).pathname)).toEqual(['PUT /api/ping']);
  });

  it("an ado work-item update, which names no project or repo, isn't refused over a checked-in toil project's", async () => {
    const d = disk({ 'work/.toil/projects/payments.json': { ...payments, ado: { project: 'PAY', repo: 'payments-api' } } });
    asRepo(d);
    const config: ResolvedConfig = {
      connections: { ado: { area: 'ado', baseUrl: 'https://ado.imagile.dev/tfs', pat: 'p', collection: 'DefaultCollection', writes: true } },
      defaults: {},
      sources: { 'ado.baseUrl': 'env', 'ado.pat': 'env', 'ado.collection': 'env', 'ado.writes': 'env' },
      files: { global: '/home/test/.toil/config.json' },
      warnings: [],
    };
    const { context, http } = testContext({ routes: [{ method: 'PATCH', url: /workitems\/42/, respond: { json: { id: 42 } } }] });
    const run = await runCli(['ado', 'work-item', 'update', '42', '--field', 'System.Title=T', '--allow-write'], { commands: [workUpdateCommand], context: { ...context, config, toilProjects: d.catalog(config, { areas: [{ name: adoArea.name, context: Object.keys(adoArea.context) }] }) } });
    expect(run.envelope?.ok, JSON.stringify(run.envelope?.error)).toBe(true);
    expect(run.envelope?.meta.context?.inputs?.project).toEqual({ value: 'PAY', source: 'toil-project' });
    expect(http.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['PATCH /tfs/DefaultCollection/_apis/wit/workitems/42']);
  });

  it('lets a write follow a toil project in your own folder', async () => {
    const d = disk({ 'home/.toil/projects/payments.json': { ...payments, 'demo-context': { project: 'OTHER' } } });
    asRepo(d);
    const { envelope } = await both(d, rename(), 'demo_context_rename_widget', { id: 'W-1', name: 'N', allowWrite: true });
    expect(envelope.ok).toBe(true);
    expect(envelope.meta.context?.inputs?.project).toEqual({ value: 'OTHER', source: 'toil-project' });
  });

  it('leaves reads alone: they follow a checked-in toil project straight away', async () => {
    const { envelope, calls } = await both(checkedIn(), ['demo-context', 'get-widget', 'W-1'], 'demo_context_get_widget', { id: 'W-1' });
    expect(envelope.ok).toBe(true);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/api/projects/OTHER/widgets/W-1']);
  });
});

describe('validation on every read', () => {
  it('reports a key set twice and a remote with a credential in meta.warnings, without the credential', async () => {
    const d = disk();
    d.write('home/.toil/projects/payments.json', '{"name": "payments", "repos": [{"name": "payments-api", "remotes": ["https://bob:hunter2@git.imagile.dev/pay/payments-api.git"]}], "demo-context": {"project": "A", "project": "B"}}');
    asRepo(d);
    const { envelope } = await both(d, ['demo-context', 'get-widget', 'W-1'], 'demo_context_get_widget', { id: 'W-1' });
    expect(envelope.meta.context?.inputs?.project?.value).toBe('B');
    const warnings = envelope.meta.warnings ?? [];
    expect(warnings.map((w) => w.code).sort()).toEqual(['TOIL_PROJECT_DUPLICATE_KEY', 'TOIL_PROJECT_REMOTE_USERINFO']);
    expect(warnings.find((w) => w.code === 'TOIL_PROJECT_DUPLICATE_KEY')?.message).toContain('(demo-context.project)');
    expect(JSON.stringify(envelope)).not.toContain('hunter2');
  });

  it('skips a broken file with a warning, and refuses one named outright with the file and key, never its content', async () => {
    const d = disk({ 'home/.toil/projects/payments.json': payments, 'home/.toil/projects/broken.json': { name: 'Not A Name', token: 'secret-value' } });
    asRepo(d);
    const skipped = await both(d, ['demo-context', 'get-widget', 'W-1'], 'demo_context_get_widget', { id: 'W-1' });
    expect(skipped.envelope.ok).toBe(true);
    expect(skipped.envelope.meta.warnings?.find((w) => w.code === 'TOIL_PROJECT_INVALID')?.message).toContain('broken.json (name)');
    const named = await both(d, ['demo-context', 'get-widget', 'W-1', '--toil-project', 'broken'], 'demo_context_get_widget', { id: 'W-1', toilProject: 'broken' });
    expect(named.envelope.error).toMatchObject({ code: 'CONFIG_INVALID', message: expect.stringContaining('broken.json can\'t be used: name:') });
    expect(JSON.stringify(named.envelope)).not.toContain('secret-value');
  });
});

describe('where a toil project path may point', () => {
  it("refuses toil's own config, a file that isn't .json, one outside the workspace and toil project folders, and one that doesn't exist", async () => {
    const d = disk({ 'home/.toil/config.json': { version: 2, connections: {} }, 'elsewhere/x.json': { name: 'x' }, 'work/notes.txt': 'hi' });
    const cases: Array<[string, RegExp]> = [
      [join(d.home, '.toil', 'config.json'), /one of toil's own files/],
      ['notes.txt', /ends in \.json/],
      [join(d.root, 'elsewhere', 'x.json'), /outside the workspace/],
      ['missing.json', /doesn't exist where toil is running/],
    ];
    for (const [path, message] of cases) {
      const { envelope, calls } = await both(d, ['demo-context', 'get-widget', 'W-1', '--toil-project', path], 'demo_context_get_widget', { id: 'W-1', toilProject: path });
      expect(envelope.error, path).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(message) });
      expect(calls).toEqual([]);
    }
  });

  it("skips a repository's toil project folder or file that links out of it, so no other JSON on the machine reads as a toil project", async () => {
    const d = disk({ 'outside/x.json': { name: 'x', 'demo-context': { project: 'OUT' } } });
    asRepo(d);
    mkdirSync(join(d.workspace, '.toil'), { recursive: true });
    try {
      // A junction needs no privilege on Windows; elsewhere this is a plain directory symlink.
      symlinkSync(join(d.root, 'outside'), join(d.workspace, '.toil', 'projects'), 'junction');
    } catch {
      return; // the platform refused to make one, so there's nothing to get around
    }
    const { envelope } = await both(d, ['demo-context', 'get-widget', 'W-1'], 'demo_context_get_widget', { id: 'W-1' });
    expect(envelope.meta.context?.toilProject).toBeUndefined();
    expect(envelope.meta.warnings).toEqual([expect.objectContaining({ code: 'TOIL_PROJECT_PATH_INVALID', message: expect.stringContaining("it's a link to a folder outside") })]);
  });

  it("says a cwd that doesn't exist where toil runs doesn't, rather than finding no toil project", async () => {
    const d = disk();
    const missing = join(d.root, 'not-here');
    const { envelope } = await both(d, ['demo-context', 'get-widget', 'W-1', '--cwd', missing], 'demo_context_get_widget', { id: 'W-1', cwd: missing });
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining("doesn't exist where toil is running") });
  });
});

describe('toil projects list, show, check and context', () => {
  it('lists every toil project with its source, the one that shadows it, and broken files', async () => {
    const d = disk({ 'home/.toil/projects/payments.json': payments, 'home/.toil/projects/bad.json': '{', 'work/.toil/projects/payments.json': payments });
    asRepo(d);
    const { envelope } = await both(d, ['projects', 'list'], 'projects_list', {});
    const data = envelope.data as { toilProjects: Array<{ name: string; source: string; shadowedBy: string | null }>; broken: Array<{ file: string; problems: Array<{ message: string }> }>; places: { repo: string | null } };
    expect(data.toilProjects.map((x) => [x.name, x.source, x.shadowedBy !== null])).toEqual([
      ['payments', 'user', false],
      ['payments', 'repo', true],
    ]);
    expect(data.broken[0]?.problems[0]?.message).toMatch(/isn't valid JSON: .* at line 1, column 2/);
    expect(data.places.repo).toMatch(/work\/\.toil\/projects$/);
  });

  it('shows what each area would use, with the binding, writes, environment and inputs', async () => {
    const d = disk({
      'work/.toil/projects/payments.json': { ...payments, env: 'staging', environments: { staging: { 'demo-context': { host: 'demo-stage.imagile.dev' } } }, nonesuch: { a: 1 } },
    });
    asRepo(d);
    const { envelope } = await both(d, ['projects', 'show'], 'projects_show', {});
    expect(envelope.data).toMatchObject({
      name: 'payments',
      source: 'repo',
      by: 'folder',
      // Checked into the repository, and it lists the repository too: the remote is the more specific reason.
      match: 'remote',
      repo: 'payments-api',
      adopted: false,
      areas: { 'demo-context': { connection: { value: 'stage', source: 'toil-project', host: 'demo-stage.imagile.dev' }, writes: true, env: 'staging', inputs: { project: 'PAY' } } },
      problems: [{ level: 'warning', code: 'TOIL_PROJECT_UNKNOWN_SECTION', path: 'nonesuch' }],
    });
    expect((envelope.data as { toilProject: { repos: unknown[] } }).toilProject.repos).toEqual(payments.repos);
  });

  it('reports a connection deployment only for an area whose variants are keyed on it, not a db engine', async () => {
    const d = disk({ 'work/.toil/projects/payments.json': { ...payments, db: { connection: 'warehouse' }, confluence: { connection: 'wiki' } } });
    asRepo(d);
    const config = configOf({
      connections: {
        warehouse: { area: 'db', engine: 'postgres', host: 'db.imagile.dev' },
        wiki: { area: 'confluence', deployment: 'cloud', baseUrl: 'https://confluence-cloud.imagile.dev' },
      },
      defaults: {},
    });
    const { context } = testContext();
    const result = await runCli(['projects', 'show', 'payments'], { commands: toilProjectsCommands(realAreas), context: { ...context, config, toilProjects: d.catalog(config, {}) } });
    expect(result.envelope?.error).toBeNull();
    const shown = (result.envelope!.data as { areas: Record<string, { connection: Record<string, unknown> }> }).areas;
    expect(shown.db!.connection).toMatchObject({ value: 'warehouse' });
    expect(shown.db!.connection).not.toHaveProperty('deployment');
    expect(shown.confluence!.connection).toMatchObject({ value: 'wiki', deployment: 'cloud' });
  });

  it('checks locally: unknown connections and unmatched hosts are errors, a writes binding in a shared toil project a warning, and the CLI exits 1', async () => {
    const d = disk({
      'work/.toil/projects/payments.json': { ...payments, 'demo-context': { connection: 'stage' }, environments: { qa: { 'demo-context': { host: 'qa.imagile.dev' } }, dev: { demo: { connection: 'ghost' } } } },
    });
    asRepo(d);
    const { envelope } = await both(d, ['projects', 'check', 'payments'], 'projects_check', { toilProject: 'payments' });
    const data = envelope.data as { ok: boolean; problems: Array<{ level: string; code: string; path: string }> };
    expect(data.ok).toBe(false);
    expect(data.problems.map((p) => [p.level, p.code, p.path])).toEqual([
      ['warning', 'TOIL_PROJECT_CONNECTION_SHARED', 'demo-context.connection'],
      ['warning', 'TOIL_PROJECT_WRITES_BINDING', 'demo-context'],
      ['error', 'TOIL_PROJECT_HOST_UNMATCHED', 'environments.qa.demo-context.host'],
      ['error', 'TOIL_PROJECT_UNKNOWN_CONNECTION', 'environments.dev.demo.connection'],
    ]);
    const { context } = testContext({ routes });
    const config = configOf();
    const run = await runCli(['projects', 'check', 'payments'], { commands, context: { ...context, config, toilProjects: d.catalog(config) } });
    expect(run.exitCode).toBe(1);
  });

  it('reports a broken toil project as check results rather than failing', async () => {
    const d = disk({ 'home/.toil/projects/broken.json': { name: 'broken', repos: 'nope' } });
    const { envelope } = await both(d, ['projects', 'check', 'broken'], 'projects_check', { toilProject: 'broken' });
    expect(envelope.data).toMatchObject({ ok: false, problems: [{ level: 'error', code: 'TOIL_PROJECT_INVALID', path: 'repos' }] });
  });

  it('refuses a toil project that uses a reserved key, at the top or under environments: check says where, and a call that names it fails before any request', async () => {
    // Written as text: an object literal can't hold a __proto__ key, which is the point.
    const base = JSON.stringify({ name: 'payments', repos: payments.repos }).slice(0, -1);
    const files = {
      top: `${base}, "__proto__": { "demo-context": { "connection": "stage" } } }`,
      env: `${base}, "env": "qa", "environments": { "qa": { "__proto__": { "demo-context": { "connection": "stage" } } } } }`,
      named: `${base}, "constructor": { "connection": "stage" } }`,
    };
    for (const [label, text] of Object.entries(files)) {
      const d = disk();
      d.write('home/.toil/projects/payments.json', text);
      const check = await both(d, ['projects', 'check', 'payments'], 'projects_check', { toilProject: 'payments' });
      const data = check.envelope.data as { ok: boolean; problems: Array<{ level: string; code: string; path: string; message: string }> };
      expect(data.ok, label).toBe(false);
      expect(data.problems, label).toContainEqual(expect.objectContaining({ level: 'error', code: 'TOIL_PROJECT_INVALID', message: expect.stringContaining('reserved') }));
      const call = await both(d, ['demo-context', 'get-widget', 'W-1', '--toil-project', 'payments'], 'demo_context_get_widget', { id: 'W-1', toilProject: 'payments' });
      expect(call.envelope.error, label).toMatchObject({ code: 'CONFIG_INVALID', message: expect.stringContaining('reserved') });
      expect(call.calls, label).toEqual([]);
    }
  });

  it('refuses a toil project file larger than the size bound without parsing it, in check and on a call', async () => {
    const d = disk();
    const padding = Array.from({ length: 12_000 }, (_, i) => `REF-${String(i).padStart(90, '0')}`);
    d.write('home/.toil/projects/payments.json', { ...payments, 'demo-context': { ...payments['demo-context'], projects: padding } });
    const check = await both(d, ['projects', 'check', 'payments'], 'projects_check', { toilProject: 'payments' });
    expect(check.envelope.data).toMatchObject({ ok: false, problems: [{ level: 'error', code: 'TOIL_PROJECT_INVALID', path: '', message: expect.stringContaining('larger than 1 MiB') }] });
    const call = await both(d, ['demo-context', 'get-widget', 'W-1', '--toil-project', 'payments'], 'demo_context_get_widget', { id: 'W-1', toilProject: 'payments' });
    expect(call.envelope.error).toMatchObject({ code: 'CONFIG_INVALID', message: expect.stringContaining('larger than 1 MiB') });
    expect(call.calls).toEqual([]);
  });

  it("says what a folder resolves to and why, origin credentials stripped, and lists the candidates when it's ambiguous", async () => {
    const d = disk({ 'home/.toil/projects/payments.json': payments });
    asRepo(d);
    const one = await both(d, ['projects', 'context'], 'projects_context', {});
    expect(one.envelope.data).toMatchObject({
      repo: { origin: 'https://git.imagile.dev/pay/payments-api.git' },
      toilProject: { name: 'payments', match: 'remote', repo: 'payments-api' },
    });
    d.write('work/.toil/projects/other.json', { name: 'other' });
    const two = await both(d, ['projects', 'context'], 'projects_context', {});
    expect(two.envelope.data).toMatchObject({ toilProject: null, candidates: [{ name: 'payments' }, { name: 'other' }] });
  });

  it('reads a home that is itself a repository as one toil project folder, not two', async () => {
    const d = disk({ 'home/.toil/projects/payments.json': payments });
    mkdirSync(join(d.home, '.git'), { recursive: true });
    d.write('home/.git/HEAD', 'ref: refs/heads/main\n');
    const { envelope } = await both(d, ['projects', 'list', '--cwd', d.home], 'projects_list', { cwd: d.home });
    expect((envelope.data as { toilProjects: unknown[] }).toilProjects).toHaveLength(1);
  });
});
