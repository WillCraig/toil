import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkToilProject as jiraCheckToilProject } from '../src/areas/jira/server/check-toil-project.js';
import { createIssue } from '../src/areas/jira/server/issues.js';
import { toilProjectConnection, type ToilProjectLookup } from '../src/core/call-context.js';
import { StrandedInput } from '../src/core/errors.js';
import type { AnyCommand } from '../src/core/command.js';
import { toolName } from '../src/core/command.js';
import type { ResolvedConfig, Settings, Source } from '../src/core/config.js';
import type { Envelope } from '../src/core/envelope.js';
import { forwardSlashes } from '../src/core/files.js';
import { toilProjectBuildCommands } from '../src/projects/build.js';
import { toilProjectsCommands } from '../src/projects/commands.js';
import { areas } from '../src/registry.js';
import { reposCommands } from '../src/repos/commands.js';
import { demoContextArea, demoContextCommands } from './fixtures/demo-context-commands.js';
import { demoArea, demoCommands } from './fixtures/demo-commands.js';
import { JIRA, routes as jiraRoutes } from './fixtures/jira.fixture.js';
import { runCli } from './harness/cli.js';
import { testContext } from './harness/context.js';
import { toilProjectDisk, type ToilProjectDisk } from './harness/toil-projects.js';
import type { Route } from './harness/fake-fetch.js';
import { connectMcp, type McpSession } from './harness/mcp.js';

/**
 * Building and sharing toil projects end to end, on real files: the issue's own
 * "done when". Discovery finds a product's repositories, the toil project commands
 * build a toil project from them and export it into one repository, and a command
 * run inside one of them gets the toil project's keys, fields and connection with
 * no flags. Around that: the duplicate refusals, the MCP rule on bindings to a
 * connection with writes on, import as adoption, the bounds on export, field
 * aliases on Jira, and Jira's check-toil-project.
 */

const all = [...areas, demoContextArea, demoArea];
const toilProjectAreas = all.map((a) => ({ name: a.name, context: Object.keys(a.context) }));
const commands: AnyCommand[] = [...demoContextCommands, ...demoCommands, createIssue, jiraCheckToilProject, ...toilProjectsCommands(all), ...toilProjectBuildCommands(all), ...reposCommands()];

function configOf(extra: Record<string, Settings & { area: string }> = {}): ResolvedConfig {
  const connections: Record<string, Settings & { area: string }> = {
    prod: { area: 'demo-context', baseUrl: 'https://demo.imagile.dev', env: 'production', project: 'PRD', token: 'p', writes: true },
    stage: { area: 'demo-context', baseUrl: 'https://demo-stage.imagile.dev', env: 'staging', project: 'STG', token: 's' },
    demo: { area: 'demo', token: 't' },
    jira: { area: 'jira', baseUrl: JIRA, apiToken: 'test-token', customFields: [{ id: 'customfield_10016', name: 'Story Points', type: 'number' }], writes: true },
    ...extra,
  };
  const sources: Record<string, Source> = {};
  for (const [name, conn] of Object.entries(connections)) for (const key of Object.keys(conn)) sources[`${name}.${key}`] = 'env';
  return { connections, defaults: { 'demo-context': { connection: 'prod' }, demo: { connection: 'demo' }, jira: { connection: 'jira' } }, sources, files: { global: '/home/test/.toil/config.json' }, warnings: [] };
}

const routes: Route[] = [
  { path: /^\/api\/projects\/[A-Z0-9]+\/widgets\/W-\d+$/, respond: (req) => ({ json: { id: new URL(req.url).pathname.split('/').pop(), name: 'Widget' } }) },
  { method: 'PUT', path: /^\/api\/projects\/[A-Z0-9]+\/widgets\/W-\d+$/, respond: { json: { ok: true } } },
  // Jira's answer for a project that doesn't exist.
  { url: `${JIRA}/rest/api/2/project/GONE`, respond: { status: 404, json: { errorMessages: ["No project could be found with key 'GONE'."], errors: {} } } },
  ...jiraRoutes,
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

/** A clone under the workspace, whose origin carries a token. */
function clone(d: ToilProjectDisk, name: string): string {
  d.write(`work/${name}/.git/HEAD`, 'ref: refs/heads/main\n');
  d.write(`work/${name}/.git/refs/heads/main`, `${'a'.repeat(40)}\n`);
  d.write(`work/${name}/.git/config`, `[remote "origin"]\n\turl = https://ci:t0ken@git.imagile.dev/pay/${name}.git\n`);
  return join(d.workspace, name);
}

interface Run {
  envelope: Envelope;
  calls: Array<{ method: string; url: string; body: string | undefined }>;
  exitCode: number;
}

async function cli(d: ToilProjectDisk, argv: string[], options: { config?: ResolvedConfig; base?: string } = {}): Promise<Run> {
  const config = options.config ?? configOf();
  const { context, http } = testContext({ routes });
  const run = await runCli(argv, { commands, context: { ...context, config, toilProjects: d.catalog(config, { areas: toilProjectAreas, ...(options.base ? { workspace: options.base } : {}) }) } });
  return { envelope: run.envelope!, calls: http.calls, exitCode: run.exitCode };
}

async function mcp(d: ToilProjectDisk, tool: string, args: Record<string, unknown>, options: { config?: ResolvedConfig } = {}): Promise<Run> {
  const config = options.config ?? configOf();
  const { context, http } = testContext({ routes });
  const session = await connectMcp({ commands, context: { ...context, config, toilProjects: d.catalog(config, { areas: toilProjectAreas, mcp: true }) }, areas: ['demo-context', 'jira', 'projects', 'repos'] });
  sessions.push(session);
  const result = await session.call(tool, args);
  return { envelope: result.envelope, calls: http.calls, exitCode: result.envelope.ok ? 0 : 1 };
}

const ok = (run: Run) => {
  expect(run.envelope.ok, JSON.stringify(run.envelope.error)).toBe(true);
  return run.envelope.data as Record<string, unknown>;
};

describe('an agent building a toil project over MCP, from discovery to a shared file', () => {
  it('scans, builds, exports into a repository, and a command in either repo then gets its keys and connection with no flags', async () => {
    const d = disk();
    const api = clone(d, 'payments-api');
    const ledger = clone(d, 'ledger-svc');
    d.write('work/payments-api/src/.keep', '');

    // Discovery: the product's repositories, credentials stripped.
    const scanned = ok(await mcp(d, 'repos_scan', {}));
    expect(scanned.repos).toEqual([
      { name: 'ledger-svc', path: forwardSlashes(ledger), branch: 'main', remotes: { origin: 'https://git.imagile.dev/pay/ledger-svc.git' } },
      { name: 'payments-api', path: forwardSlashes(api), branch: 'main', remotes: { origin: 'https://git.imagile.dev/pay/payments-api.git' } },
    ]);

    // Build: every step a validated command; a host selector, since this one is for sharing.
    ok(await mcp(d, 'projects_init', { name: 'payments', description: 'Payments platform' }));
    for (const repo of scanned.repos as Array<{ path: string }>) ok(await mcp(d, 'projects_add_repo', { toilProject: 'payments', location: repo.path }));
    ok(await mcp(d, 'projects_link', { toilProject: 'payments', area: 'demo-context', host: 'demo-stage.imagile.dev' }));
    ok(await mcp(d, 'projects_link', { toilProject: 'payments', area: 'demo-context', set: ['project=PAY'], forRepo: 'payments-api' }));
    ok(await mcp(d, 'projects_link', { toilProject: 'payments', area: 'demo-context', set: ['project=LEDG'], forRepo: 'ledger-svc', add: ['boards=Payments Team'] }));
    ok(await mcp(d, 'projects_field', { toilProject: 'payments', area: 'jira', alias: 'storyPoints', id: 'customfield_10016' }));
    expect(ok(await mcp(d, 'projects_check', { toilProject: 'payments' })).ok).toBe(true);

    // Share: into one repository's .toil/projects, paths dropped, never committed.
    const exported = ok(await mcp(d, 'projects_export', { toilProject: 'payments', repo: api }));
    expect(exported).toMatchObject({ file: forwardSlashes(join(api, '.toil', 'projects', 'payments.json')), droppedPaths: 2, hosts: [] });
    const shared = JSON.parse(readFileSync(join(api, '.toil', 'projects', 'payments.json'), 'utf8')) as { repos: Array<Record<string, unknown>> };
    expect(shared.repos).toEqual([
      { name: 'ledger-svc', remotes: ['https://git.imagile.dev/pay/ledger-svc.git'] },
      { name: 'payments-api', remotes: ['https://git.imagile.dev/pay/payments-api.git'] },
    ]);
    expect(JSON.stringify(shared)).not.toContain('t0ken');

    // Use: inside each repo, no flags. Yours wins over the exported copy of the same name.
    for (const [repo, project] of [[ledger, 'LEDG'], [api, 'PAY']] as const) {
      const used = await cli(d, ['demo-context', 'get-widget', 'W-1', '--cwd', repo]);
      expect(used.envelope.meta.context).toMatchObject({
        toilProject: { name: 'payments', source: 'user', match: 'path' },
        connection: { value: 'stage', source: 'toil-project', host: 'demo-stage.imagile.dev' },
        inputs: { project: { value: project, source: 'toil-project' } },
      });
      expect(used.calls[0]?.url).toBe(`https://demo-stage.imagile.dev/api/projects/${project}/widgets/W-1?board=main`);
    }

    // A teammate with only the exported file: matched by remote, from the checked-in copy.
    const teammate = disk();
    const theirs = clone(teammate, 'payments-api');
    teammate.write('work/payments-api/.toil/projects/payments.json', readFileSync(join(api, '.toil', 'projects', 'payments.json'), 'utf8'));
    const used = await cli(teammate, ['demo-context', 'get-widget', 'W-1', '--cwd', theirs]);
    expect(used.envelope.meta.context).toMatchObject({ toilProject: { source: 'repo', match: 'remote', repo: 'payments-api' }, inputs: { project: { value: 'PAY', source: 'toil-project' } } });
  });
});

describe('the toil project commands name the area a retired one became', () => {
  it('link to jira-cloud says it is now jira with deployment cloud, not that toil has no such area', async () => {
    const d = disk();
    ok(await cli(d, ['projects', 'init', 'payments']));
    const run = await cli(d, ['projects', 'link', 'payments', 'jira-cloud', '--set', 'project=PAY']);
    expect(run.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'toil jira-cloud no longer exists.', fix: expect.stringContaining('TOIL_JIRA_DEPLOYMENT=cloud') });
  });
});

describe('the toil project commands never add a duplicate', () => {
  it('refuses a repo, a value, a list item or a field alias already there, naming it, unless --replace', async () => {
    const d = disk();
    ok(await cli(d, ['projects', 'init', 'payments']));
    ok(await cli(d, ['projects', 'add-repo', 'payments', 'git@git.imagile.dev:pay/api.git', '--name', 'api']));
    const sameRemote = await cli(d, ['projects', 'add-repo', 'payments', 'https://git.imagile.dev/pay/api', '--name', 'other']);
    expect(sameRemote.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('already has https://git.imagile.dev/pay/api as repo "api"') });
    ok(await cli(d, ['projects', 'link', 'payments', 'demo-context', '--set', 'project=PAY', '--add', 'boards=Ops']));
    // The same value again changes nothing.
    expect(ok(await cli(d, ['projects', 'link', 'payments', 'demo-context', '--set', 'project=PAY'])).changed).toBe(false);
    const other = await cli(d, ['projects', 'link', 'payments', 'demo-context', '--set', 'project=LEDG']);
    expect(other.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'project is already "PAY" (toil project payments, demo-context).', fix: 'Pass --replace to change it.' });
    expect(ok(await cli(d, ['projects', 'link', 'payments', 'demo-context', '--set', 'project=LEDG', '--replace'])).changed).toBe(true);
    expect((await cli(d, ['projects', 'link', 'payments', 'demo-context', '--add', 'boards=Ops'])).envelope.error?.message).toContain('boards already lists Ops');
    ok(await cli(d, ['projects', 'field', 'payments', 'jira', 'storyPoints', 'customfield_10016']));
    expect((await cli(d, ['projects', 'field', 'payments', 'jira', 'points', 'customfield_10016'])).envelope.error?.message).toContain('already has the alias "storyPoints"');
    expect((await cli(d, ['projects', 'field', 'payments', 'jira', 'storyPoints', 'customfield_1'])).envelope.error?.message).toContain('"storyPoints" already names customfield_10016');
    expect((await cli(d, ['projects', 'init', 'payments'])).envelope.error?.message).toContain('You already have a toil project named "payments"');
  });

  it('validates a value against the area before writing, and writes nothing when it fails', async () => {
    const d = disk();
    ok(await cli(d, ['projects', 'init', 'payments']));
    const before = readFileSync(join(d.home, '.toil', 'projects', 'payments.json'), 'utf8');
    const bad = await cli(d, ['projects', 'link', 'payments', 'demo-context', '--set', 'project=lower']);
    expect(bad.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('a project key is upper-case letters and digits') });
    const badHost = await cli(d, ['projects', 'link', 'payments', 'demo-context', '--host', 'https://x.imagile.dev/path']);
    expect(badHost.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('Nothing was written') });
    expect(readFileSync(join(d.home, '.toil', 'projects', 'payments.json'), 'utf8')).toBe(before);
    expect((await cli(d, ['projects', 'link', 'payments', 'nonesuch'])).envelope.error?.message).toBe('toil has no area named "nonesuch".');
    expect((await cli(d, ['projects', 'link', 'payments', 'demo-context', '--connection', 'ghost'])).envelope.error?.message).toContain('You have no demo-context connection named "ghost"');
  });
});

describe('an agent never points a toil project at a connection with writes on', () => {
  it('refuses a binding that would select one over MCP, and lets a person make it on the CLI', async () => {
    const d = disk();
    ok(await mcp(d, 'projects_init', { name: 'payments' }));
    // stage has writes off: fine over MCP.
    ok(await mcp(d, 'projects_link', { toilProject: 'payments', area: 'demo-context', connection: 'stage' }));
    // prod has writes on, and is the default: unbinding would fall back to it.
    for (const args of [{ connection: 'prod', replace: true }, { unbind: true }, { host: 'demo.imagile.dev', replace: true }]) {
      const refused = await mcp(d, 'projects_link', { toilProject: 'payments', area: 'demo-context', ...args });
      expect(refused.envelope.error, JSON.stringify(args)).toMatchObject({ code: 'WRITE_DISABLED', message: expect.stringContaining('connection prod, which has writes on') });
    }
    // A non-default environment's binding never decides a call: one with --env picks its connection by that input itself.
    ok(await mcp(d, 'projects_env', { toilProject: 'payments', env: 'prod', area: 'demo-context', connection: 'prod' }));
    // Making it the default would: refused.
    expect((await mcp(d, 'projects_env', { toilProject: 'payments', env: 'prod', area: 'demo-context', default: true })).envelope.error?.code).toBe('WRITE_DISABLED');
    expect(ok(await cli(d, ['projects', 'link', 'payments', 'demo-context', '--connection', 'prod', '--replace']))).toMatchObject({ changed: true });
  });

  it('still reads the rest of the binding when a selecting input is held per repo and the check has no repo to read it for (#540)', () => {
    // The toil project commands ask with no repo by design; a per-repo `env` gives way, and the toil project's `connection` still decides.
    const lookup: ToilProjectLookup = (_area, key) => {
      if (key === 'env') throw new StrandedInput('INVALID_INPUT', 'stranded');
      return key === 'connection' ? 'prod' : undefined;
    };
    expect(toilProjectConnection(configOf(), demoContextArea, lookup)).toMatchObject({ value: 'prod', source: 'toil-project' });
  });

  it("judges a change by the call's own resolver, so an environment that selects a connection with writes on is refused too", async () => {
    // stage (writes off) is the default here, and prod (writes on) is the one whose env is "production".
    const config = configOf();
    config.defaults['demo-context'] = { connection: 'stage' };
    const d = disk();
    ok(await mcp(d, 'projects_init', { name: 'payments' }, { config }));
    ok(await mcp(d, 'projects_env', { toilProject: 'payments', env: 'production', area: 'demo-context', set: ['project=PRD'] }, { config }));
    // The reviewer's bypass: making that environment the toil project's default retargets every call, and writes, to prod.
    const bypass = await mcp(d, 'projects_env', { toilProject: 'payments', env: 'production', area: 'demo-context', default: true }, { config });
    expect(bypass.envelope.error).toMatchObject({ code: 'WRITE_DISABLED', message: expect.stringContaining('connection prod, which has writes on') });
    // A person can, on the CLI; then import and export of it over MCP are refused for the same reason.
    ok(await cli(d, ['projects', 'env', 'payments', 'production', 'demo-context', '--default'], { config }));
    const exported = await mcp(d, 'projects_export', { toilProject: 'payments', file: 'payments.json' }, { config });
    expect(exported.envelope.error).toMatchObject({ code: 'WRITE_DISABLED', message: expect.stringContaining('makes demo-context calls use connection prod') });
    // And a call from that toil project really does go to prod, so the rule judged what a call does.
    const used = await cli(d, ['demo-context', 'get-widget', 'W-1', '--toil-project', 'payments'], { config });
    expect(used.envelope.meta.context?.connection).toEqual({ value: 'prod', source: 'toil-project', via: 'env' });
  });

  it('refuses --set env, which a call would never read, and says how to set the environment', async () => {
    const d = disk();
    ok(await cli(d, ['projects', 'init', 'payments']));
    const run = await cli(d, ['projects', 'link', 'payments', 'demo-context', '--set', 'env=staging']);
    expect(run.envelope.error).toMatchObject({ code: 'INVALID_INPUT', fix: expect.stringContaining('toil projects env payments <env> demo-context --default') });
    d.write('home/.toil/projects/hand.json', { name: 'hand', 'demo-context': { env: 'staging' } });
    const shown = ok(await cli(d, ['projects', 'check', 'hand'])) as { problems: Array<{ code: string; path: string }> };
    expect(shown.problems).toEqual([expect.objectContaining({ code: 'TOIL_PROJECT_UNUSED_KEY', path: 'demo-context.env' })]);
  });

  it("checks an import source's bounds before looking at it, so MCP can't probe whether a folder exists", async () => {
    const d = disk();
    mkdirSync(join(d.root, 'there'));
    for (const source of [join(d.root, 'there'), join(d.root, 'not-there')]) {
      const run = await mcp(d, 'projects_import', { source });
      expect(run.envelope.error, source).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining("it's outside the workspace") });
    }
    const missingInside = await mcp(d, 'projects_import', { source: 'not-there' });
    expect(missingInside.envelope.error?.message).toContain("doesn't exist where toil is running");
    const toilProjectPath = await cli(d, ['demo-context', 'get-widget', 'W-1', '--toil-project', join(d.root, 'nope.json')]);
    expect(toilProjectPath.envelope.error?.message).toContain("it's outside the workspace");
  });

  it('adopts with import on the CLI, after which a write follows the binding; MCP refuses that import', async () => {
    const d = disk({ 'work/.toil/projects/payments.json': { name: 'payments', 'demo-context': { connection: 'prod', project: 'PRD' } } });
    d.write('work/.git/HEAD', 'ref: refs/heads/main\n');
    const write = ['demo-context', 'rename-widget', 'W-1', '--name', 'N', '--allow-write'];
    expect((await cli(d, write)).envelope.error).toMatchObject({ code: 'WRITE_DISABLED', fix: expect.stringContaining('projects import') });

    const refused = await mcp(d, 'projects_import', { source: '.toil/projects/payments.json' });
    expect(refused.envelope.error).toMatchObject({ code: 'WRITE_DISABLED', message: expect.stringContaining("toil won't import toil project payments") });
    expect(existsSync(join(d.home, '.toil', 'projects', 'payments.json'))).toBe(false);

    const imported = ok(await cli(d, ['projects', 'import', '.toil/projects/payments.json']));
    expect(imported).toMatchObject({ imported: [{ name: 'payments', file: forwardSlashes(join(d.home, '.toil', 'projects', 'payments.json')) }], toSetUp: [], failed: [] });
    const now = await cli(d, write);
    expect(now.envelope.ok, JSON.stringify(now.envelope.error)).toBe(true);
    expect(now.envelope.meta.context?.toilProject).toMatchObject({ source: 'user' });
    expect((await cli(d, ['projects', 'import', '.toil/projects/payments.json'])).envelope.error?.message).toContain('Nothing was imported');
  });

  it('lists what an imported toil project names that you lack, and reports a broken file by key path only', async () => {
    const d = disk({
      'work/shared/team.json': { name: 'team', 'demo-context': { host: 'nowhere.imagile.dev' }, demo: { connection: 'ghost' } },
      'work/shared/bad.json': '{"name": "bad", "repos": "s3cret-value"}',
    });
    const run = await cli(d, ['projects', 'import', 'shared']);
    expect(run.exitCode).toBe(1);
    const data = run.envelope.data as { imported: unknown[]; toSetUp: Array<{ area: string }>; failed: Array<{ problems: Array<{ path: string }> }> };
    expect(data.imported).toHaveLength(1);
    expect(data.toSetUp.map((t) => t.area).sort()).toEqual(['demo', 'demo-context']);
    expect(data.failed[0]?.problems).toEqual([{ path: 'repos', message: '"repos" must be a list of repositories.' }]);
    expect(JSON.stringify(run.envelope)).not.toContain('s3cret-value');
  });
});

describe('meta.context on a call that fails after its connection is chosen', () => {
  it('still names the host selector that chose it', async () => {
    const d = disk({ 'home/.toil/projects/payments.json': { name: 'payments', 'demo-context': { host: 'demo-stage.imagile.dev' } } });
    const config = configOf({ stage: { area: 'demo-context', baseUrl: 'https://demo-stage.imagile.dev', token: 's' } });
    const run = await cli(d, ['demo-context', 'get-widget', 'W-1', '--toil-project', 'payments'], { config });
    expect(run.envelope.error?.code).toBe('INVALID_INPUT');
    expect(run.envelope.meta.context?.connection).toEqual({ value: 'stage', source: 'toil-project', host: 'demo-stage.imagile.dev' });
  });
});

describe('where export may write', () => {
  it('needs a repository root, never overwrites anything but a toil project, and replaces one only with --replace', async () => {
    const d = disk({ 'work/notes.json': '{"not": "a toil project"}' });
    const api = clone(d, 'payments-api');
    ok(await cli(d, ['projects', 'init', 'payments']));
    expect((await cli(d, ['projects', 'export', 'payments', '--repo', join(api, '.git', '..', '..')])).envelope.error?.message).toContain("isn't the root of a git repository");
    expect((await cli(d, ['projects', 'export', 'payments', '--file', 'notes.json', '--replace'])).envelope.error?.message).toContain("isn't a valid toil project");
    expect((await cli(d, ['projects', 'export', 'payments', '--file', join(d.home, '.toil', 'config.json')])).envelope.error?.message).toContain("one of toil's own files");
    expect((await cli(d, ['projects', 'export', 'payments', '--file', join(d.root, 'elsewhere.json')])).envelope.error?.message).toContain('outside the workspace');
    ok(await cli(d, ['projects', 'export', 'payments', '--repo', api]));
    expect((await cli(d, ['projects', 'export', 'payments', '--repo', api])).envelope.error?.message).toContain('a file is already there');
    ok(await cli(d, ['projects', 'export', 'payments', '--repo', api, '--replace']));
  });

  it("turns a connection name into that connection's host, so a teammate's own connection matches", async () => {
    const d = disk();
    ok(await cli(d, ['projects', 'init', 'payments']));
    ok(await cli(d, ['projects', 'link', 'payments', 'demo-context', '--connection', 'stage']));
    const out = ok(await cli(d, ['projects', 'export', 'payments', '--file', 'payments.json']));
    expect(out.hosts).toEqual([{ area: 'demo-context', env: null, connection: 'stage', host: 'demo-stage.imagile.dev' }]);
    expect(JSON.parse(readFileSync(join(d.workspace, 'payments.json'), 'utf8'))['demo-context']).toEqual({ host: 'demo-stage.imagile.dev' });
  });
});

describe('field aliases and check-toil-project on Jira', () => {
  const jiraToilProject = { name: 'payments', jira: { projects: ['PROJ', 'GONE'], fields: { storyPoints: 'customfield_10016', ghost: 'customfield_99999' } } };

  it('lets --field use a toil project alias, typed as the connection registers the field', async () => {
    const d = disk({ 'home/.toil/projects/payments.json': jiraToilProject });
    const run = await cli(d, ['jira', 'issue', 'create', '--project', 'PROJ', '--summary', 'S', '--field', 'storyPoints=5', '--toil-project', 'payments', '--allow-write']);
    expect(run.envelope.ok, JSON.stringify(run.envelope.error)).toBe(true);
    const post = run.calls.find((c) => c.method === 'POST');
    expect(JSON.parse(post!.body!).fields).toMatchObject({ customfield_10016: 5 });
    expect(run.envelope.meta.context?.toilProject).toMatchObject({ name: 'payments', by: 'input' });
  });

  it("checks each project and field id the toil project names, and exits 1 for the ones Jira hasn't got", async () => {
    const d = disk({ 'home/.toil/projects/payments.json': jiraToilProject });
    const run = await cli(d, ['jira', 'check-toil-project', '--toil-project', 'payments']);
    expect(run.exitCode).toBe(1);
    expect(run.envelope.data).toMatchObject({
      toilProject: { name: 'payments', source: 'user' },
      connection: 'jira',
      ok: false,
      checks: [
        { path: 'jira.projects[0]', kind: 'project', value: 'PROJ', found: true },
        { path: 'jira.projects[1]', kind: 'project', value: 'GONE', found: false },
        { path: 'jira.fields.storyPoints', kind: 'field', value: 'customfield_10016', found: true },
        { path: 'jira.fields.ghost', kind: 'field', value: 'customfield_99999', found: false },
      ],
    });
    const none = await cli(disk(), ['jira', 'check-toil-project']);
    expect(none.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'No toil project applies to this call, so there is nothing to check.' });
  });
});

describe('repos scan and remove', () => {
  it("stays inside the workspace, doesn't enter a repository or follow skipped folders, and honours depth", async () => {
    const d = disk();
    clone(d, 'a');
    d.write('work/deep/er/b/.git/HEAD', 'ref: refs/heads/main\n');
    d.write('work/node_modules/c/.git/HEAD', 'ref: refs/heads/main\n');
    d.write('work/a/nested/.git/HEAD', 'ref: refs/heads/main\n');
    const all = ok(await cli(d, ['repos', 'scan'])) as { repos: Array<{ name: string }> };
    expect(all.repos.map((r) => r.name)).toEqual(['a', 'b']);
    expect((ok(await cli(d, ['repos', 'scan', '--depth', '1'])) as { repos: Array<{ name: string }> }).repos.map((r) => r.name)).toEqual(['a']);
    mkdirSync(join(d.root, 'outside'));
    expect((await cli(d, ['repos', 'scan', join(d.root, 'outside')])).envelope.error?.message).toContain('outside the workspace');
  });

  it('removes only your own toil project, on the CLI only', async () => {
    const d = disk({ 'work/.toil/projects/team.json': { name: 'team' } });
    d.write('work/.git/HEAD', 'ref: refs/heads/main\n');
    ok(await cli(d, ['projects', 'init', 'payments']));
    expect(ok(await cli(d, ['projects', 'remove', 'payments']))).toMatchObject({ deleted: true });
    expect(existsSync(join(d.home, '.toil', 'projects', 'payments.json'))).toBe(false);
    expect((await cli(d, ['projects', 'remove', 'team'])).envelope.error?.fix).toContain('Only your own toil projects can be removed here.');
    const { context } = testContext();
    const session = await connectMcp({ commands, context, areas: ['projects'] });
    sessions.push(session);
    expect((await session.client.listTools()).tools.map((t) => t.name)).not.toContain(toolName(commands.find((c) => c.path.join(' ') === 'projects remove')!));
  });
});


describe('credentials in stored remotes, and removing a section', () => {
  const withToken = (extra: Record<string, unknown> = {}) => ({
    'home/.toil/projects/pay.json': { name: 'pay', repos: [{ name: 'api', remotes: ['https://ci:t0ken@git.imagile.dev/pay/api.git'] }], ...extra },
  });
  const stored = (d: ToilProjectDisk) => readFileSync(join(d.home, '.toil', 'projects', 'pay.json'), 'utf8');

  it('re-adding a repo whose stored remote has a credential writes it out, and says so', async () => {
    const d = disk(withToken());
    const run = await cli(d, ['projects', 'add-repo', 'pay', 'https://git.imagile.dev/pay/api.git', '--name', 'api']);
    expect(ok(run)).toMatchObject({ changed: true, credentialsRemoved: ['repos[0].remotes[0]'], repo: { name: 'api', remotes: ['https://git.imagile.dev/pay/api.git'] } });
    expect(run.envelope.meta.warnings?.map((w) => w.message).join(' ')).toContain('Removed the credential from repos[0].remotes[0]');
    expect(stored(d)).not.toContain('t0ken');
    // Clean now: the same add changes nothing and says nothing about credentials.
    const again = ok(await cli(d, ['projects', 'add-repo', 'pay', 'https://git.imagile.dev/pay/api.git', '--name', 'api']));
    expect(again).toMatchObject({ changed: false });
    expect(again).not.toHaveProperty('credentialsRemoved');
  });

  it('cleans a credential in a second remote when the repo is re-added by its first, keeping both remotes', async () => {
    const d = disk({ 'home/.toil/projects/pay.json': { name: 'pay', repos: [{ name: 'api', remotes: ['https://git.imagile.dev/pay/api.git', 'https://ci:t0ken@git.imagile.dev/pay/api-mirror.git'] }] } });
    const run = ok(await cli(d, ['projects', 'add-repo', 'pay', 'https://git.imagile.dev/pay/api.git', '--name', 'api']));
    expect(run).toMatchObject({ changed: true, credentialsRemoved: ['repos[0].remotes[1]'], repo: { remotes: ['https://git.imagile.dev/pay/api.git', 'https://git.imagile.dev/pay/api-mirror.git'] } });
    expect(JSON.parse(stored(d)).repos).toEqual([{ name: 'api', remotes: ['https://git.imagile.dev/pay/api.git', 'https://git.imagile.dev/pay/api-mirror.git'] }]);
    // A remote it doesn't list is still a different repo, refused without --replace.
    expect((await cli(d, ['projects', 'add-repo', 'pay', 'https://git.imagile.dev/pay/other.git', '--name', 'api'])).envelope.error?.code).toBe('INVALID_INPUT');
  });

  it('any edit that writes reports the credentials it took out of other repos', async () => {
    const d = disk(withToken());
    expect(ok(await cli(d, ['projects', 'link', 'pay', 'jira', '--set', 'project=PAY']))).toMatchObject({ changed: true, credentialsRemoved: ['repos[0].remotes[0]'] });
    expect(stored(d)).not.toContain('t0ken');
  });

  it('unlink removes a section, an environment left empty, and that environment as the default; unknown areas too', async () => {
    const d = disk(withToken({ jira: { project: 'PAY' }, wiki: { space: 'X' }, env: 'prod', environments: { prod: { openshift: { namespace: 'pay-prod' } }, test: { openshift: { namespace: 'pay-test' }, sonar: {} } } }));
    expect(ok(await cli(d, ['projects', 'unlink', 'pay', '--area', 'jira']))).toMatchObject({ changed: true, area: 'jira', env: null, removed: { project: 'PAY' } });
    ok(await cli(d, ['projects', 'unlink', 'pay', '--area', 'wiki']));
    ok(await cli(d, ['projects', 'unlink', 'pay', '--area', 'openshift', '--env', 'prod']));
    ok(await cli(d, ['projects', 'unlink', 'pay', '--area', 'openshift', '--env', 'test']));
    const file = JSON.parse(stored(d)) as Record<string, unknown>;
    expect(file).not.toHaveProperty('jira');
    expect(file).not.toHaveProperty('wiki');
    expect(file).not.toHaveProperty('env');
    expect(file.environments).toEqual({ test: { sonar: {} } });
    expect(stored(d)).not.toContain('t0ken');
    const missing = await cli(d, ['projects', 'unlink', 'pay', '--area', 'jira']);
    expect(missing.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Toil project pay has no jira section.' });
    expect(missing.envelope.error?.fix).toContain('sonar --env test');
  });

  it('unlink is CLI only', async () => {
    const { context } = testContext();
    const session = await connectMcp({ commands, context, areas: ['projects'] });
    sessions.push(session);
    expect((await session.client.listTools()).tools.map((t) => t.name)).not.toContain(toolName(commands.find((c) => c.path.join(' ') === 'projects unlink')!));
  });
});

describe('people and the work-in-progress limit', () => {
  const file = (d: ToilProjectDisk) => JSON.parse(readFileSync(join(d.home, '.toil', 'projects', 'pay.json'), 'utf8')) as Record<string, unknown>;
  const fresh = () => disk({ 'home/.toil/projects/pay.json': { name: 'pay' } });

  it('adds a person, then more identities, and refuses to change one already set unless --replace', async () => {
    const d = fresh();
    expect(ok(await cli(d, ['projects', 'person', 'pay', 'Pat Example', '--id', 'jira=pat', '--email', 'you@example.com']))).toMatchObject({ changed: true, person: { name: 'Pat Example', email: 'you@example.com', ids: { jira: 'pat' } } });
    ok(await cli(d, ['projects', 'person', 'pay', 'pat example', '--id', 'github=pat-ex']));
    expect(file(d).people).toEqual([{ name: 'Pat Example', email: 'you@example.com', ids: { jira: 'pat', github: 'pat-ex' } }]);
    // The same again changes nothing and writes nothing.
    expect(ok(await cli(d, ['projects', 'person', 'pay', 'Pat Example', '--id', 'github=PAT-EX']))).toMatchObject({ changed: false });
    const conflict = await cli(d, ['projects', 'person', 'pay', 'Pat Example', '--id', 'jira=pexample']);
    expect(conflict.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: "Pat Example's jira identity is already pat (toil project pay).", fix: 'Pass --replace to change it.' });
    ok(await cli(d, ['projects', 'person', 'pay', 'Pat Example', '--id', 'jira=pexample', '--replace']));
    expect((file(d).people as Array<{ ids: Record<string, string> }>)[0]!.ids.jira).toBe('pexample');
    expect((await cli(d, ['projects', 'person', 'pay', 'Pat Example', '--email', 'pat@example.com'])).envelope.error?.message).toContain('email is already you@example.com');
  });

  it("gives one account to one person, refuses an area toil hasn't got, a token-shaped identity, and a bad email", async () => {
    const d = fresh();
    ok(await cli(d, ['projects', 'person', 'pay', 'Pat', '--id', 'github=pat-ex']));
    const twice = await cli(d, ['projects', 'person', 'pay', 'Sam', '--id', 'github=Pat-Ex']);
    expect(twice.envelope.error?.message).toBe("The github identity Pat-Ex is already Pat's (toil project pay).");
    expect(twice.envelope.error?.fix).toBe('One account can only be one person\'s. Remove it from them first: toil projects person pay "Pat" --id github=Pat-Ex --remove.');
    expect((await cli(d, ['projects', 'person', 'pay', 'Sam', '--id', 'nonesuch=sam'])).envelope.error?.message).toBe('toil has no area named "nonesuch".');
    const token = await cli(d, ['projects', 'person', 'pay', 'Sam', '--id', 'github=ghp_abcdefghijklmnopqrstuvwxyz0123456789']);
    expect(token.envelope.error?.message).toContain("The github identity can't be used: it's shaped like a credential");
    expect(JSON.stringify(token.envelope)).not.toContain('ghp_');
    expect((await cli(d, ['projects', 'person', 'pay', 'Sam', '--email', 'sam'])).envelope.error?.message).toBe("--email isn't an email address (toil project pay).");
    // A token pasted anywhere is refused and never repeated: as an --id with no area, as an email, as a name.
    const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    for (const argv of [['Sam', '--id', TOKEN], ['Sam', '--id', `${TOKEN}==`], ['Sam', '--email', TOKEN], ['Sam', '--email', `x@${TOKEN}`], [TOKEN]]) {
      const run = await cli(d, ['projects', 'person', 'pay', ...argv]);
      expect(run.envelope.error?.code, argv.join(' ')).toBe('INVALID_INPUT');
      expect(JSON.stringify(run.envelope), argv.join(' ')).not.toContain('ghp_');
    }
    expect((await cli(d, ['projects', 'person', 'pay', 'Sam', '--id', TOKEN])).envelope.error?.fix).toBe('For example --id github=pat-ex.');
    expect(file(d).people).toEqual([{ name: 'Pat', ids: { github: 'pat-ex' } }]);
  });

  it('lists an agent by kind, and changes a kind only with --replace', async () => {
    const d = fresh();
    ok(await cli(d, ['projects', 'person', 'pay', 'Claude', '--kind', 'agent', '--id', 'github=claude']));
    expect((await cli(d, ['projects', 'person', 'pay', 'Claude', '--kind', 'human'])).envelope.error?.message).toBe('Claude is already listed as agent (toil project pay).');
    ok(await cli(d, ['projects', 'person', 'pay', 'Claude', '--kind', 'human', '--replace']));
    expect(file(d).people).toEqual([{ name: 'Claude', ids: { github: 'claude' } }]);
  });

  it('removes an identity or a person on the CLI only, and an agent may add people over MCP', async () => {
    const d = fresh();
    expect(ok(await mcp(d, 'projects_person', { toilProject: 'pay', name: 'Pat', id: ['jira=pat', 'github=pat-ex'] }))).toMatchObject({ changed: true });
    const refused = await mcp(d, 'projects_person', { toilProject: 'pay', name: 'Pat', remove: true });
    expect(refused.envelope.error).toMatchObject({ code: 'INVALID_INPUT', fix: 'Only a person can make this call, on the CLI with toil projects person.' });
    expect(refused.envelope.error?.message).toContain('Removing a person or an identity is a delete');
    expect(ok(await cli(d, ['projects', 'person', 'pay', 'Pat', '--id', 'jira=pat', '--remove']))).toMatchObject({ person: { ids: { github: 'pat-ex' } }, removed: { jira: 'pat' } });
    expect((await cli(d, ['projects', 'person', 'pay', 'Pat', '--id', 'jira=pat', '--remove'])).envelope.error?.message).toBe('Pat has no jira identity pat (toil project pay).');
    expect(ok(await cli(d, ['projects', 'person', 'pay', 'Pat', '--remove']))).toMatchObject({ person: null, removed: { name: 'Pat' } });
    expect(file(d)).not.toHaveProperty('people');
    expect((await cli(d, ['projects', 'person', 'pay', 'Pat', '--remove'])).envelope.error?.fix).toBe('It has: (nobody yet).');
  });

  it("removes an identity the reader kept under an area this toil hasn't got", async () => {
    const d = disk({ 'home/.toil/projects/pay.json': { name: 'pay', people: [{ name: 'Pat', ids: { githb: 'pat', jira: 'pat' } }] } });
    expect((await cli(d, ['projects', 'person', 'pay', 'Pat', '--id', 'githb=pat'])).envelope.error?.message).toBe('toil has no area named "githb".');
    expect(ok(await cli(d, ['projects', 'person', 'pay', 'Pat', '--id', 'githb=pat', '--remove']))).toMatchObject({ person: { ids: { jira: 'pat' } } });
  });

  it('sets the limit, changes it only with --replace, and clears it on the CLI only', async () => {
    const d = fresh();
    expect(ok(await mcp(d, 'projects_wip_limit', { toilProject: 'pay', limit: 3 }))).toMatchObject({ changed: true, wipLimit: 3 });
    expect((await cli(d, ['projects', 'wip-limit', 'pay', '4'])).envelope.error?.message).toBe("Toil project pay's limit is already 3.");
    ok(await cli(d, ['projects', 'wip-limit', 'pay', '4', '--replace']));
    expect(file(d).wipLimit).toBe(4);
    expect((await cli(d, ['projects', 'wip-limit', 'pay', '0'])).envelope.error?.code).toBe('INVALID_INPUT');
    expect((await cli(d, ['projects', 'wip-limit', 'pay'])).envelope.error?.message).toBe('Pass a limit, or --clear, and not both.');
    expect((await mcp(d, 'projects_wip_limit', { toilProject: 'pay', clear: true })).envelope.error?.message).toContain('Clearing the limit is a delete');
    expect(ok(await cli(d, ['projects', 'wip-limit', 'pay', '--clear']))).toMatchObject({ changed: true, wipLimit: null });
    expect(file(d)).not.toHaveProperty('wipLimit');
  });

  it('keeps people and the limit when the toil project is exported for sharing', async () => {
    const d = disk({ 'home/.toil/projects/pay.json': { name: 'pay', people: [{ name: 'Pat', ids: { jira: 'pat' } }], wipLimit: 2 } });
    d.write('work/.git/HEAD', 'ref: refs/heads/main\n');
    ok(await cli(d, ['projects', 'export', 'pay', '--repo', '.']));
    const shared = JSON.parse(readFileSync(join(d.workspace, '.toil', 'projects', 'pay.json'), 'utf8')) as Record<string, unknown>;
    expect(shared).toMatchObject({ people: [{ name: 'Pat', ids: { jira: 'pat' } }], wipLimit: 2 });
  });
});

describe('renaming and describing a toil project', () => {
  const at = (d: ToilProjectDisk, name: string) => join(d.home, '.toil', 'projects', `${name}.json`);
  const read = (d: ToilProjectDisk, name: string) => JSON.parse(readFileSync(at(d, name), 'utf8')) as Record<string, unknown>;
  const full = { name: 'pay', description: 'Payments', repos: [{ name: 'api', remotes: ['https://git.imagile.dev/pay/api.git'] }], jira: { project: 'PAY' }, people: [{ name: 'Pat', ids: { jira: 'pat' } }], wipLimit: 3, env: 'prod', environments: { prod: { openshift: { namespace: 'pay-prod' } } } };

  it('sets the description, as one line, and an edit that changes nothing writes nothing', async () => {
    const d = disk({ 'home/.toil/projects/pay.json': { name: 'pay' } });
    expect(ok(await mcp(d, 'projects_describe', { toilProject: 'pay', description: '  Card payments\n  v2 ' }))).toMatchObject({ name: 'pay', changed: true, renamed: null, description: 'Card payments v2' });
    expect(read(d, 'pay').description).toBe('Card payments v2');
    expect(ok(await cli(d, ['projects', 'describe', 'pay', '--description', 'Card payments v2']))).toMatchObject({ changed: false });
    expect((await cli(d, ['projects', 'describe', 'pay'])).envelope.error?.message).toBe('Pass --name, --description, or both.');
    expect((await cli(d, ['projects', 'describe', 'pay', '--description', '   '])).envelope.error?.message).toBe('The description is empty.');
  });

  it('renames: the file moves, and every section, repo, person and environment goes with it', async () => {
    const d = disk({ 'home/.toil/projects/pay.json': full });
    const run = ok(await cli(d, ['projects', 'describe', 'pay', '--name', 'card-payments', '--description', 'Card payments v2']));
    expect(run).toMatchObject({ name: 'card-payments', file: forwardSlashes(at(d, 'card-payments')), changed: true, renamed: { from: 'pay', to: 'card-payments', previousFile: forwardSlashes(at(d, 'pay')) } });
    expect(existsSync(at(d, 'pay'))).toBe(false);
    expect(read(d, 'card-payments')).toEqual({ ...full, name: 'card-payments', description: 'Card payments v2' });
    // The new name resolves; the old one is gone.
    expect(ok(await cli(d, ['projects', 'show', 'card-payments']))).toMatchObject({ name: 'card-payments' });
    expect((await cli(d, ['projects', 'show', 'pay'])).envelope.ok).toBe(false);
  });

  it('refuses a name that is taken or invalid, leaving the toil project where it was', async () => {
    const d = disk({ 'home/.toil/projects/pay.json': { name: 'pay' }, 'home/.toil/projects/ledger.json': { name: 'ledger' } });
    const taken = await mcp(d, 'projects_describe', { toilProject: 'pay', name: 'ledger' });
    expect(taken.envelope.error?.message).toBe(`You already have a toil project named "ledger" (${forwardSlashes(at(d, 'ledger'))}).`);
    expect((await cli(d, ['projects', 'describe', 'pay', '--name', 'Pay Two'])).envelope.error?.message).toBe('"Pay Two" isn\'t a valid toil project name.');
    expect(read(d, 'pay')).toEqual({ name: 'pay' });
    expect(read(d, 'ledger')).toEqual({ name: 'ledger' });
  });

  it("refuses a rename onto a file that holds another toil project, with a fix it can follow, and keeps credentialsRemoved on a rename", async () => {
    const d = disk({ 'home/.toil/projects/pay.json': { name: 'pay', repos: [{ name: 'api', remotes: ['https://ci:t0ken@git.imagile.dev/pay/api.git'] }] }, 'home/.toil/projects/ledger.json': { name: 'other' } });
    const taken = await cli(d, ['projects', 'describe', 'pay', '--name', 'ledger']);
    expect(taken.envelope.error).toMatchObject({ code: 'INVALID_INPUT', fix: 'Choose another name, or move that file out of your toil project folder first.' });
    expect(taken.envelope.error?.message).toContain("is already there, so toil project pay can't be renamed to \"ledger\".");
    expect(read(d, 'ledger')).toEqual({ name: 'other' });
    expect(ok(await cli(d, ['projects', 'describe', 'pay', '--name', 'payments']))).toMatchObject({ name: 'payments', credentialsRemoved: ['repos[0].remotes[0]'] });
    expect(JSON.stringify(read(d, 'payments'))).not.toContain('t0ken');
  });

  it('renames a file named for the new name in place', async () => {
    const d = disk({ 'home/.toil/projects/pay.json': { name: 'payments' } });
    expect(ok(await cli(d, ['projects', 'describe', 'payments', '--name', 'pay']))).toMatchObject({ name: 'pay', renamed: { from: 'payments', to: 'pay' } });
    expect(read(d, 'pay')).toMatchObject({ name: 'pay' });
  });

  it("refuses a checked-in toil project, naming toil projects import", async () => {
    const d = disk({ 'work/.toil/projects/team.json': { name: 'team' } });
    d.write('work/.git/HEAD', 'ref: refs/heads/main\n');
    const run = await cli(d, ['projects', 'describe', 'team', '--description', 'Ours now']);
    expect(run.envelope.error?.message).toContain("is checked into a repository");
    expect(run.envelope.error?.fix).toContain('projects import');
    expect(JSON.parse(readFileSync(join(d.workspace, '.toil', 'projects', 'team.json'), 'utf8'))).toEqual({ name: 'team' });
  });
});