import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commands as registryCommands } from '../src/registry.js';
import type { AnyCommand } from '../src/core/command.js';
import { aliasPaths, deprecatedPathsOf } from '../src/core/command.js';
import { migrateConfig, readConfigForEdit, CONFIG_VERSION, parseEnvName, type ResolvedConfig, type Settings, type Source } from '../src/core/config.js';
import type { Warning } from '../src/core/envelope.js';
import { runCommand } from '../src/core/run.js';
import { getWidget } from './fixtures/demo-context-commands.js';
import { runCli } from './harness/cli.js';
import { testContext, scriptedPrompter } from './harness/context.js';
import { connectMcp, type McpSession } from './harness/mcp.js';
import { toilProjectDisk, type ToilProjectDisk } from './harness/toil-projects.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * Dossiers became toil projects (#555). Every old name keeps answering for at least
 * one beta, with a TOIL_PROJECT_DEPRECATED_NAME warning that says what to type
 * instead, on the CLI and in env and config; MCP and the API take only the new
 * names. These tests hold each old name to that: the CLI path, the flag, the
 * env vars, the config key, both folders, and `toil projects migrate`. The old
 * names are retired with a farewell memo that nobody answered, which is the
 * form of consent this module relies on.
 */

const DEPRECATED = 'TOIL_PROJECT_DEPRECATED_NAME';

function configOf(): ResolvedConfig {
  const connections: Record<string, Settings & { area: string }> = {
    prod: { area: 'demo-context', baseUrl: 'https://demo.imagile.dev', env: 'production', project: 'PRD', token: 'p', writes: true },
  };
  const sources: Record<string, Source> = {};
  for (const [name, conn] of Object.entries(connections)) for (const key of Object.keys(conn)) sources[`${name}.${key}`] = 'env';
  return { connections, defaults: { 'demo-context': { connection: 'prod' } }, sources, files: { global: '/home/test/.toil/config.json' }, warnings: [] };
}

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

const payments = { name: 'payments', description: 'Payments platform', repos: [{ name: 'payments-api', remotes: ['git@git.imagile.dev:pay/payments-api.git'] }], 'demo-context': { project: 'PAY' } };
const warningCodes = (warnings: readonly Warning[] | undefined) => (warnings ?? []).map((w) => w.code);

describe('the old CLI paths', () => {
  it('`toil dossiers list` runs `toil projects list`, with a warning naming the new path, and --help leaves the old one out', async () => {
    const d = disk({ 'home/.toil/projects/payments.json': payments });
    const config = configOf();
    const { context } = testContext();
    const ctx = { ...context, config, toilProjects: d.catalog(config) };
    const fresh = await runCli(['projects', 'list'], { commands: registryCommands, context: ctx });
    const old = await runCli(['dossiers', 'list'], { commands: registryCommands, context: ctx });
    expect(fresh.envelope?.ok).toBe(true);
    expect(fresh.envelope?.meta.warnings?.map((w) => w.code) ?? []).not.toContain(DEPRECATED);
    expect(old.envelope?.ok).toBe(true);
    expect(old.envelope?.data).toEqual(fresh.envelope?.data);
    // meta.command names the command, never the path typed (as for an alias).
    expect(old.envelope?.meta.command).toBe('projects list');
    expect(old.envelope?.meta.warnings).toContainEqual(expect.objectContaining({ code: DEPRECATED, message: expect.stringContaining('toil projects list') }));
    const nested = await runCli(['dossiers', 'analyze', 'show'], { commands: registryCommands, context: ctx });
    expect(warningCodes(nested.envelope?.meta.warnings)).toContain(DEPRECATED);
    expect(nested.envelope?.meta.command).toBe('projects analyze show');
    const help = await runCli(['--help'], { commands: registryCommands, context: ctx });
    expect(help.stdout).toContain('projects');
    expect(help.stdout).not.toContain('dossiers');
  });

  it('`toil dossiers --help` lists the retired commands and says what replaced them, so the old group is a signpost', async () => {
    const { context } = testContext();
    const help = await runCli(['dossiers', '--help'], { commands: registryCommands, context });
    expect(help.stdout).toContain('retired: use toil projects');
    expect(help.stdout).toContain('list [options]');
    expect(help.stdout).toContain('show [options]');
  });

  it('every `projects` command has its `dossiers` twin, and every check-toil-project its check-dossier, as retired paths and not aliases', () => {
    const projects = registryCommands.filter((c) => c.path[0] === 'projects' && c.path[1] !== 'migrate');
    expect(projects.length).toBeGreaterThan(10);
    for (const def of projects) expect(deprecatedPathsOf(def), def.path.join(' ')).toEqual([['dossiers', ...def.path.slice(1)]]);
    expect(deprecatedPathsOf(registryCommands.find((c) => c.path.join(' ') === 'projects migrate')!)).toEqual([]);
    const checks = registryCommands.filter((c) => c.path.at(-1) === 'check-toil-project');
    expect(checks.map((c) => c.path[0]).sort()).toEqual(expect.arrayContaining(['ado', 'bitbucket', 'confluence', 'dynatrace', 'github', 'jira', 'openshift', 'sonar']));
    for (const def of checks) {
      expect(deprecatedPathsOf(def)).toEqual([[...def.path.slice(0, -1), 'check-dossier']]);
      expect(aliasPaths(def).flat()).not.toContain('check-dossier');
    }
  });

  it('`jira check-dossier` is retired the same way: it answers, and says what to type', async () => {
    const { context } = testContext();
    const run = await runCli(['jira', 'check-dossier'], { commands: registryCommands, context });
    expect(warningCodes(run.envelope?.meta.warnings)).toContain(DEPRECATED);
    expect(run.envelope?.meta.warnings?.find((w) => w.code === DEPRECATED)?.message).toContain('toil jira check-toil-project');
  });
});

describe('the old --dossier flag', () => {
  const commands: AnyCommand[] = [getWidget];
  const routes = [{ path: /^\/api\/projects\/[A-Z0-9]+\/widgets\/W-\d+$/, respond: { json: { id: 'W-1' } } }];
  const run = async (d: ToilProjectDisk, argv: string[]) => {
    const config = configOf();
    const { context } = testContext({ routes });
    return runCli(argv, { commands, context: { ...context, config, toilProjects: d.catalog(config, { areas: [{ name: 'demo-context', context: ['project', 'board', 'env'] }] }) } });
  };

  it('picks the toil project like --toil-project, with a deprecation warning; the new flag wins when both are given', async () => {
    const d = disk({ 'home/.toil/projects/payments.json': payments, 'home/.toil/projects/other.json': { name: 'other', repos: [], 'demo-context': { project: 'OTH' } } });
    const old = await run(d, ['demo-context', 'get-widget', 'W-1', '--dossier', 'payments']);
    expect(old.envelope?.ok, JSON.stringify(old.envelope?.error)).toBe(true);
    expect(old.envelope?.meta.context?.toilProject).toMatchObject({ name: 'payments', by: 'input' });
    expect(old.envelope?.meta.warnings).toContainEqual(expect.objectContaining({ code: DEPRECATED, message: expect.stringContaining('--toil-project') }));
    const both = await run(d, ['demo-context', 'get-widget', 'W-1', '--dossier', 'payments', '--toil-project', 'other']);
    expect(both.envelope?.meta.context?.toilProject).toMatchObject({ name: 'other' });
    expect(both.envelope?.meta.warnings?.find((w) => w.code === DEPRECATED)?.message).toContain('is ignored');
    const fresh = await run(d, ['demo-context', 'get-widget', 'W-1', '--toil-project', 'payments']);
    expect(warningCodes(fresh.envelope?.meta.warnings)).not.toContain(DEPRECATED);
  });

  it('is not an MCP field: toilProject only, and `dossier` is an unknown field', async () => {
    const d = disk({ 'home/.toil/projects/payments.json': payments });
    const config = configOf();
    const { context } = testContext({ routes });
    const session = await connectMcp({ commands, context: { ...context, config, toilProjects: d.catalog(config) } });
    sessions.push(session);
    const tool = (await session.client.listTools()).tools.find((t) => t.name === 'demo_context_get_widget')!;
    const props = Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties);
    expect(props).toContain('toilProject');
    expect(props).not.toContain('dossier');
    const refused = await session.call('demo_context_get_widget', { id: 'W-1', dossier: 'payments' });
    expect(refused.envelope.ok).toBe(false);
    expect(refused.envelope.error?.code).toBe('INVALID_INPUT');
  });
});

describe('MCP', () => {
  it('serves the projects_* tools, and none of the old names (check-toil-project tools are <area>_check_toil_project)', async () => {
    const { context } = testContext();
    const session = await connectMcp({ commands: registryCommands, context });
    sessions.push(session);
    const names = (await session.client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['projects_list', 'projects_show', 'projects_check']));
    expect(names.filter((n) => n.startsWith('dossiers_') || n.endsWith('_check_dossier'))).toEqual([]);
    // CLI only: it moves files, so an agent never gets it.
    expect(names).not.toContain('projects_migrate');
  });

  it('a call that still sends `dossier` is refused with INVALID_INPUT whose fix names `toilProject`', async () => {
    const { context } = testContext();
    const session = await connectMcp({ commands: registryCommands, context });
    sessions.push(session);
    const result = await session.client.callTool({ name: 'projects_list', arguments: { dossier: 'payments' } });
    const text = JSON.stringify(result);
    expect(text).toContain('INVALID_INPUT');
    expect(text).toContain('The field \\"dossier\\" is now \\"toilProject\\"');
  });
});

describe('the old env vars', () => {
  const config = configOf();

  it('TOIL_DOSSIER still names the toil project, with a warning; TOIL_PROJECT wins when both are set', () => {
    const d = disk({ 'home/.toil/projects/payments.json': payments, 'home/.toil/projects/other.json': { name: 'other', repos: [] } });
    const old = d.catalog(config, { env: { TOIL_DOSSIER: 'payments' } }).select({});
    expect(old.applied?.file.toilProject.name).toBe('payments');
    expect(old.applied?.by).toBe('env');
    expect(old.warnings).toContainEqual(expect.objectContaining({ code: DEPRECATED, message: expect.stringContaining('TOIL_PROJECT') }));
    const both = d.catalog(config, { env: { TOIL_PROJECT: 'other', TOIL_DOSSIER: 'payments' } }).select({});
    expect(both.applied?.file.toilProject.name).toBe('other');
    expect(both.warnings.find((w) => w.code === DEPRECATED)?.message).toContain('is ignored');
    const fresh = d.catalog(config, { env: { TOIL_PROJECT: 'payments' } }).select({});
    expect(warningCodes(fresh.warnings)).not.toContain(DEPRECATED);
  });

  it('TOIL_DOSSIER_PATHS still lists folders, with a warning; TOIL_PROJECT_PATHS wins when both are set', () => {
    const d = disk({ 'team/shared.json': { name: 'shared', repos: [] }, 'elsewhere/lonely.json': { name: 'lonely', repos: [] } });
    const old = d.catalog(config, { env: { TOIL_DOSSIER_PATHS: join(d.root, 'team') } }).scan();
    expect(old.files.map((f) => f.toilProject?.name)).toEqual(['shared']);
    expect(old.warnings).toContainEqual(expect.objectContaining({ code: DEPRECATED, message: expect.stringContaining('TOIL_PROJECT_PATHS') }));
    const both = d.catalog(config, { env: { TOIL_PROJECT_PATHS: join(d.root, 'elsewhere'), TOIL_DOSSIER_PATHS: join(d.root, 'team') } }).scan();
    expect(both.files.map((f) => f.toilProject?.name)).toEqual(['lonely']);
    expect(both.warnings.find((w) => w.code === DEPRECATED)?.message).toContain('is ignored');
  });

  it('are reserved, so no area can claim them, and TOIL_<AREA>_PROJECT still maps as it did', () => {
    for (const name of ['TOIL_PROJECT', 'TOIL_PROJECT_PATHS', 'TOIL_DOSSIER', 'TOIL_DOSSIER_PATHS']) expect(parseEnvName(name, ['jira', 'sonar']), name).toBeUndefined();
    expect(parseEnvName('TOIL_JIRA_PROJECT', ['jira', 'sonar'])).toEqual(expect.objectContaining({ area: 'jira' }));
    expect(parseEnvName('TOIL_SONAR_PROJECT', ['jira', 'sonar'])).toEqual(expect.objectContaining({ area: 'sonar' }));
  });
});

describe('the old folders', () => {
  const config = configOf();

  it('~/.toil/dossiers is still read as your own folder, the new folder wins a name clash, and the warning says how to move', () => {
    const d = disk({
      'home/.toil/dossiers/old.json': { name: 'old', repos: [] },
      'home/.toil/dossiers/payments.json': { name: 'payments', description: 'old copy', repos: [] },
      'home/.toil/projects/payments.json': { name: 'payments', description: 'new copy', repos: [] },
    });
    const catalog = d.catalog(config);
    const { files, warnings } = catalog.scan();
    expect(files.map((f) => [f.toilProject?.name, f.source])).toEqual([['payments', 'user'], ['old', 'user'], ['payments', 'user']]);
    expect(catalog.find('payments').toilProject.description).toBe('new copy');
    expect(catalog.find('old').source).toBe('user');
    const old = warnings.find((w) => w.code === 'TOIL_PROJECT_OLD_FOLDER');
    expect(old?.message).toContain('toil projects migrate');
    expect(old?.message).toContain('.toil/dossiers');
    // New files go in the new folder, always.
    expect(catalog.userFile('fresh')).toBe(join(d.home, '.toil', 'projects', 'fresh.json'));
    expect(catalog.places().userOld).toBe(join(d.home, '.toil', 'dossiers'));
  });

  it('an explicit name from the old folder warns too, and a call that never reads the old folder does not', () => {
    const d = disk({ 'home/.toil/dossiers/old.json': { name: 'old', repos: [] } });
    const named = d.catalog(config).select({ toilProject: 'old' });
    expect(warningCodes(named.warnings)).toContain('TOIL_PROJECT_OLD_FOLDER');
    const clean = disk({ 'home/.toil/projects/new.json': { name: 'new', repos: [] } });
    expect(warningCodes(clean.catalog(config).scan().warnings)).not.toContain('TOIL_PROJECT_OLD_FOLDER');
  });

  it("a repository's .toil/dossiers is read, and `projects list` names it in a warning that points to git mv, not to migrate", () => {
    const d = disk({ 'work/.toil/dossiers/team.json': { name: 'team', repos: [] } });
    d.write('work/.git/HEAD', 'ref: refs/heads/main\n');
    d.write('work/.git/config', '[remote "origin"]\n\turl = https://git.imagile.dev/pay/payments-api.git\n');
    const { files, warnings } = d.catalog(config).scan();
    expect(files.map((f) => [f.toilProject?.name, f.source])).toEqual([['team', 'repo']]);
    const old = warnings.find((w) => w.code === 'TOIL_PROJECT_OLD_FOLDER');
    expect(old?.message).toContain('.toil/dossiers');
    expect(old?.message).toContain('git mv');
  });
});

describe('config version 4', () => {
  const warn = (raw: Record<string, unknown>) => {
    const warnings: Warning[] = [];
    const read = migrateConfig(raw, '/home/test/.toil/config.json', warnings);
    return { read, warnings };
  };

  it('is the current version, and a newer file is refused saying so', () => {
    expect(CONFIG_VERSION).toBe(4);
    expect(() => migrateConfig({ version: 5, connections: {} }, '/c.json', [])).toThrow(/reads up to version 4/);
  });

  it.each([1, 2, 3].map((v) => [v]))('a version %i file with dossierPaths still loads it, and warns with the old and the new name', (version) => {
    const raw: Record<string, unknown> = version === 1 ? { dossierPaths: ['/a'] } : { version, connections: {}, defaults: {}, dossierPaths: ['/a'] };
    const { read, warnings } = warn(raw);
    if (version === 1) {
      // Version 1 ignored the key, and still does.
      expect(read.projectPaths).toBeUndefined();
      return;
    }
    expect(read.projectPaths).toEqual(['/a']);
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'CONFIG_RENAMED_KEY', message: expect.stringMatching(/"dossierPaths".*"projectPaths"/) }));
    expect(warnings.map((w) => w.code)).not.toContain('CONFIG_UNKNOWN_KEY');
  });

  it('a version 4 file with the old key is read the same, and projectPaths wins when both are there', () => {
    const only = warn({ version: 4, connections: {}, defaults: {}, dossierPaths: ['/a'] });
    expect(only.read.projectPaths).toEqual(['/a']);
    expect(warningCodes(only.warnings)).toEqual(['CONFIG_RENAMED_KEY']);
    const both = warn({ version: 4, connections: {}, defaults: {}, dossierPaths: ['/a'], projectPaths: ['/b'] });
    expect(both.read.projectPaths).toEqual(['/b']);
    expect(both.warnings[0]?.message).toContain('is ignored');
    const fresh = warn({ version: 4, connections: {}, defaults: {}, projectPaths: ['/b'] });
    expect(fresh.warnings).toEqual([]);
  });

  it('what an edit writes back has projectPaths, version 4, and every other key as it was', () => {
    const dir = mkdtempSync(join(tmpdir(), 'toil-config4-'));
    try {
      const file = join(dir, 'config.json');
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify({ version: 3, connections: {}, defaults: {}, dossierPaths: ['/a'], extra: 1 }));
      const edit = readConfigForEdit(file);
      expect(edit).toEqual({ version: 4, connections: {}, defaults: {}, projectPaths: ['/a'], extra: 1 });
      expect('dossierPaths' in edit).toBe(false);
      // Both keys: the new one is kept, the old one is dropped.
      writeFileSync(file, JSON.stringify({ version: 4, connections: {}, defaults: {}, dossierPaths: ['/a'], projectPaths: ['/b'] }));
      expect(readConfigForEdit(file)).toMatchObject({ projectPaths: ['/b'] });
      expect('dossierPaths' in readConfigForEdit(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('toil projects migrate', () => {
  const migrate = registryCommands.find((c) => c.path.join(' ') === 'projects migrate')!;
  const config = configOf();
  const seed = () =>
    disk({
      'home/.toil/dossiers/alpha.json': { name: 'alpha', repos: [] },
      'home/.toil/dossiers/beta.json': { name: 'beta repo copy', repos: [] },
      'home/.toil/dossiers/notes.txt': 'not a toil project',
      'home/.toil/projects/beta.json': { name: 'beta', repos: [] },
    });
  const run = (d: ToilProjectDisk, argv: string[], prompt?: ReturnType<typeof scriptedPrompter>['prompt']) => {
    const { context } = testContext(prompt ? { prompt } : {});
    return runCli(argv, { commands: registryCommands, context: { ...context, config, toilProjects: d.catalog(config) } });
  };

  it('is CLI only, declares its local write, and needs no connection', () => {
    expect(migrate.kind).toBe('cli-only');
    expect(migrate.writesLocal).toBe(true);
    expect(migrate.writes).toBe(false);
  });

  it('moves every .json to the new folder on --yes by name, skips a name already there, never overwrites, and touches nothing else', async () => {
    const d = seed();
    const run1 = await run(d, ['projects', 'migrate', '--yes']);
    expect(run1.envelope?.ok, JSON.stringify(run1.envelope?.error)).toBe(true);
    const data = run1.envelope?.data as { moved: Array<{ name: string }>; skipped: Array<{ name: string; reason: string }> };
    expect(data.moved.map((m) => m.name)).toEqual(['alpha']);
    expect(data.skipped.map((s) => s.name)).toEqual(['beta']);
    expect(warningCodes(run1.envelope?.meta.warnings)).toContain('TOIL_PROJECT_MIGRATE_SKIPPED');
    const home = join(d.home, '.toil');
    expect(existsSync(join(home, 'projects', 'alpha.json'))).toBe(true);
    expect(existsSync(join(home, 'dossiers', 'alpha.json'))).toBe(false);
    // The clash stays in the old folder, and the new folder's copy is exactly what it was.
    expect(existsSync(join(home, 'dossiers', 'beta.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, 'projects', 'beta.json'), 'utf8'))).toEqual({ name: 'beta', repos: [] });
    expect(readFileSync(join(home, 'dossiers', 'notes.txt'), 'utf8')).toBe('not a toil project');
    expect(JSON.parse(readFileSync(join(home, 'projects', 'alpha.json'), 'utf8'))).toEqual({ name: 'alpha', repos: [] });
  });

  it('asks on a terminal, moves on yes, and moves nothing on anything else', async () => {
    const d = seed();
    const no = scriptedPrompter({ Move: 'no' });
    const declined = await run(d, ['projects', 'migrate'], no.prompt);
    expect(declined.envelope?.error?.code).toBe('CANCELLED');
    expect(existsSync(join(d.home, '.toil', 'dossiers', 'alpha.json'))).toBe(true);
    const yes = scriptedPrompter({ Move: 'yes' });
    const done = await run(d, ['projects', 'migrate'], yes.prompt);
    expect(done.envelope?.ok).toBe(true);
    expect(yes.asked[0]?.question).toContain('alpha');
    expect(existsSync(join(d.home, '.toil', 'projects', 'alpha.json'))).toBe(true);
  });

  it('without a terminal and without --yes, refuses and moves nothing', async () => {
    const d = seed();
    const refused = await run(d, ['projects', 'migrate']);
    expect(refused.envelope?.error?.code).toBe('INVALID_INPUT');
    expect(refused.envelope?.error?.fix).toContain('--yes');
    expect(existsSync(join(d.home, '.toil', 'dossiers', 'alpha.json'))).toBe(true);
  });

  it('with nothing to move, says so without asking', async () => {
    const d = disk({ 'home/.toil/projects/a.json': { name: 'a', repos: [] } });
    const asked = scriptedPrompter();
    const run1 = await run(d, ['projects', 'migrate'], asked.prompt);
    expect(run1.envelope?.ok).toBe(true);
    expect((run1.envelope?.data as { moved: unknown[] }).moved).toEqual([]);
    expect(asked.asked).toEqual([]);
  });

  it("leaves a repository's .toil/dossiers where it is", async () => {
    const d = disk({ 'work/.toil/dossiers/team.json': { name: 'team', repos: [] } });
    d.write('work/.git/HEAD', 'ref: refs/heads/main\n');
    await run(d, ['projects', 'migrate', '--yes']);
    expect(existsSync(join(d.workspace, '.toil', 'dossiers', 'team.json'))).toBe(true);
    expect(existsSync(join(d.workspace, '.toil', 'projects', 'team.json'))).toBe(false);
  });

  it('is refused by a read-only API call, before anything moves, and writes an audit line on the CLI', async () => {
    const d = seed();
    const { context, audit } = testContext();
    const ctx = { ...context, config, toilProjects: d.catalog(config) };
    const refused = await runCommand(migrate, { yes: true }, () => ctx, ctx.version, 'api', undefined, { readOnly: true });
    expect(refused.ok).toBe(false);
    expect(existsSync(join(d.home, '.toil', 'dossiers', 'alpha.json'))).toBe(true);
    await runCli(['projects', 'migrate', '--yes'], { commands: registryCommands, context: ctx });
    expect(audit.entries().some((e) => e.command === 'projects migrate')).toBe(true);
  });
});
