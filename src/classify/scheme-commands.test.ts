/* eslint-disable @typescript-eslint/no-explicit-any -- the tests read envelopes' untyped JSON */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registry } from '../api.js';
import { builtinScheme } from '../core/classify/builtin.js';
import { schemeContent } from '../core/classify/scheme.js';
import type { ResolvedConfig } from '../core/config.js';
import type { Envelope } from '../core/envelope.js';
import { forwardSlashes } from '../core/files.js';
import { toilProjectDisk, type ToilProjectDisk } from '../../test/harness/toil-projects.js';
import { runCli } from '../../test/harness/cli.js';
import { testContext } from '../../test/harness/context.js';
import { connectMcp, type McpSession } from '../../test/harness/mcp.js';
import { classifyProjectCommands } from './project-commands.js';
import { classifySchemeCommands } from './scheme-commands.js';
import { toilProjectBuildCommands } from '../projects/build.js';
import { areas, commands as allCommands } from '../registry.js';

const commands = [...classifySchemeCommands(), ...classifyProjectCommands(), ...toilProjectBuildCommands(areas)];
const config: ResolvedConfig = { connections: {}, defaults: {}, sources: {}, files: { global: '/home/test/.toil/config.json' }, warnings: [] };

const category = (id: string) => ({ id, short: id.toUpperCase(), name: id.toUpperCase(), label: id, definition: `The ${id} work.` });
const team = (extra: Record<string, unknown> = {}) => ({ name: 'team', revision: 3, categories: [category('ktlo'), category('feature')], guidance: [], examples: [], rules: [], signals: true, labels: {}, ...extra });

const disks: ToilProjectDisk[] = [];
const sessions: McpSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  for (const d of disks.splice(0)) d.cleanup();
});

function disk(files: Record<string, unknown> = {}): ToilProjectDisk {
  const d = toilProjectDisk({ 'work/.git/HEAD': 'ref: refs/heads/main\n', ...files });
  disks.push(d);
  return d;
}

async function cli(d: ToilProjectDisk, argv: string[]): Promise<Envelope> {
  const { context } = testContext({ config: {} });
  const run = await runCli(argv, { commands, context: { ...context, schemes: d.schemes(config), toilProjects: d.catalog(config) } });
  return run.envelope!;
}

async function mcp(d: ToilProjectDisk) {
  const { context } = testContext({ config: {} });
  const session = await connectMcp({ commands, context: { ...context, schemes: d.schemes(config, { mcp: true }), toilProjects: d.catalog(config, { mcp: true }) } });
  sessions.push(session);
  return session;
}

const data = (e: Envelope) => {
  expect(e.ok, JSON.stringify(e.error)).toBe(true);
  return e.data as Record<string, any>;
};
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;

describe('classify scheme list and show', () => {
  it('lists each scheme once, with its source, file and categories', async () => {
    const d = disk({ 'home/.toil/classify/team.json': team(), 'work/.toil/classify/repo.json': team({ name: 'repo' }) });
    const out = data(await cli(d, ['classify', 'scheme', 'list']));
    expect(out.schemes.map((s: any) => [s.name, s.source])).toEqual([['team', 'user'], ['repo', 'repo'], ['ktlo-feature', 'built-in'], ['balance', 'built-in']]);
    expect(out.schemes[0]).toEqual({ name: 'team', revision: 3, source: 'user', file: forwardSlashes(join(d.home, '.toil', 'classify', 'team.json')), categories: [{ id: 'ktlo', short: 'KTLO', name: 'KTLO', label: 'ktlo' }, { id: 'feature', short: 'FEATURE', name: 'FEATURE', label: 'feature' }] });
    expect(out.schemes[2]).not.toHaveProperty('file');
  });

  it('reports a broken file as a warning, not a failure', async () => {
    const d = disk({ 'home/.toil/classify/broken.json': { name: 'broken' } });
    const e = await cli(d, ['classify', 'scheme', 'list']);
    expect(data(e).schemes).toHaveLength(2);
    expect(e.meta.warnings?.[0]).toMatchObject({ code: 'SCHEME_INVALID' });
    expect(e.meta.warnings?.[0]?.message).toContain('categories:');
  });

  it('shows a scheme in full, by name or by file', async () => {
    const d = disk({ 'home/.toil/classify/team.json': team({ guidance: ['One.'] }), 'work/x/any.json': team({ name: 'anything' }) });
    expect(data(await cli(d, ['classify', 'scheme', 'show', 'team']))).toMatchObject({ source: 'user', scheme: { name: 'team', revision: 3, guidance: ['One.'] } });
    expect(data(await cli(d, ['classify', 'scheme', 'show', 'balance'])).scheme.categories).toHaveLength(4);
    expect(data(await cli(d, ['classify', 'scheme', 'show', './x/any.json']))).toMatchObject({ source: 'file', scheme: { name: 'anything' } });
    const missing = await cli(d, ['classify', 'scheme', 'show', 'nope']);
    expect(missing.error?.code).toBe('NOT_FOUND');
  });

  it('is served over MCP', async () => {
    const d = disk();
    const s = await mcp(d);
    const listed = await s.call('classify_scheme_list', {});
    expect(data(listed.envelope).schemes.map((x: any) => x.name)).toEqual(['ktlo-feature', 'balance']);
    expect(data((await s.call('classify_scheme_show', { name: 'balance' })).envelope).source).toBe('built-in');
  });
});

describe('classify scheme init', () => {
  it('copies ktlo-feature by default into your folder, at revision 1, and refuses a name you have', async () => {
    const d = disk();
    const out = data(await cli(d, ['classify', 'scheme', 'init', 'payments']));
    expect(out).toMatchObject({ name: 'payments', revision: 1, source: 'user', copiedFrom: 'ktlo-feature' });
    expect(read(out.file)).toEqual({ ...builtinScheme('ktlo-feature'), name: 'payments' });
    const again = await cli(d, ['classify', 'scheme', 'init', 'payments']);
    expect(again.error?.code).toBe('INVALID_INPUT');
    expect(again.error?.message).toContain('You already have a scheme named "payments"');
  });

  it('copies another scheme by name or file, resetting its revision and name', async () => {
    const d = disk({ 'home/.toil/classify/team.json': team({ guidance: ['G'] }) });
    expect(read(data(await cli(d, ['classify', 'scheme', 'init', 'copy', '--from', 'team'])).file)).toMatchObject({ name: 'copy', revision: 1, guidance: ['G'] });
    expect(read(data(await cli(d, ['classify', 'scheme', 'init', 'bal', '--from', 'balance'])).file).categories).toHaveLength(4);
    d.write('work/in.json', team({ name: 'whatever' }));
    expect(read(data(await cli(d, ['classify', 'scheme', 'init', 'fromfile', '--from', './in.json'])).file)).toMatchObject({ name: 'fromfile', revision: 1 });
  });

  it('refuses a name that is not a scheme name, and writes nothing', async () => {
    const d = disk();
    const e = await cli(d, ['classify', 'scheme', 'init', 'Not Valid']);
    expect(e.error?.code).toBe('INVALID_INPUT');
    expect(existsSync(join(d.home, '.toil', 'classify'))).toBe(false);
  });

  it('is served over MCP as a local write with no allowWrite', async () => {
    const d = disk();
    const s = await mcp(d);
    const out = data((await s.call('classify_scheme_init', { name: 'viamcp', from: 'balance' })).envelope);
    expect(out.name).toBe('viamcp');
    expect(existsSync(out.file)).toBe(true);
  });
});

describe('classify scheme export', () => {
  it('writes <repo>/.toil/classify/<name>.json into a working tree and never stages anything', async () => {
    const d = disk({ 'home/.toil/classify/team.json': team() });
    const out = data(await cli(d, ['classify', 'scheme', 'export', 'team', '--repo', d.workspace]));
    expect(out.file).toBe(forwardSlashes(join(d.workspace, '.toil', 'classify', 'team.json')));
    expect(read(out.file)).toEqual(team());
    expect(existsSync(join(d.workspace, '.git', 'index'))).toBe(false);
  });

  it('writes one file with --out, and needs exactly one of --repo and --out', async () => {
    const d = disk();
    expect(data(await cli(d, ['classify', 'scheme', 'export', 'balance', '--out', 'shared/balance.json'])).file).toBe(forwardSlashes(join(d.workspace, 'shared', 'balance.json')));
    expect((await cli(d, ['classify', 'scheme', 'export', 'balance'])).error?.message).toContain('exactly one of --repo and --out');
    expect((await cli(d, ['classify', 'scheme', 'export', 'balance', '--out', 'a.json', '--repo', '.'])).error?.code).toBe('INVALID_INPUT');
  });

  it('refuses an existing scheme without --replace, a file that is not a scheme, and a path outside the workspace', async () => {
    const d = disk({ 'work/shared/balance.json': team({ name: 'old' }), 'work/shared/other.json': '{"x":1}' });
    expect((await cli(d, ['classify', 'scheme', 'export', 'balance', '--out', 'shared/balance.json'])).error?.fix).toContain('--replace');
    expect(data(await cli(d, ['classify', 'scheme', 'export', 'balance', '--out', 'shared/balance.json', '--replace'])).name).toBe('balance');
    expect((await cli(d, ['classify', 'scheme', 'export', 'balance', '--out', 'shared/other.json', '--replace'])).error?.message).toContain("isn't a valid scheme");
    expect((await cli(d, ['classify', 'scheme', 'export', 'balance', '--out', join(d.root, 'away.json')])).error?.message).toContain('outside the workspace');
    expect((await cli(d, ['classify', 'scheme', 'export', 'balance', '--out', join(d.home, '.toil', 'config.json'), '--replace'])).error?.message).toContain("one of toil's own files");
    expect((await cli(d, ['classify', 'scheme', 'export', 'balance', '--repo', 'shared'])).error?.message).toContain("isn't the root of a git repository");
  });

  it('is served over MCP, under the same bounds', async () => {
    const d = disk();
    const s = await mcp(d);
    expect(data((await s.call('classify_scheme_export', { name: 'balance', repo: '.' })).envelope).file).toContain('.toil/classify/balance.json');
    expect((await s.call('classify_scheme_export', { name: 'balance', out: join(d.root, 'away.json') })).envelope.error?.message).toContain('outside the workspace');
  });
});

describe('classify scheme set', () => {
  it('writes a revised file over the scheme in your folder and raises the revision by one, whatever the file says', async () => {
    const d = disk({ 'home/.toil/classify/team.json': team(), 'work/v2.json': team({ revision: 99, guidance: ['A bug fix is KTLO.'], rules: [{ id: 'esc', when: { label: ['customer-escalation'] }, then: 'ktlo' }] }) });
    const out = data(await cli(d, ['classify', 'scheme', 'set', 'team', '--input-file', 'v2.json']));
    expect(out).toMatchObject({ name: 'team', revision: 4, previousRevision: 3, source: 'user', file: forwardSlashes(join(d.home, '.toil', 'classify', 'team.json')) });
    expect(out.changes).toMatchObject({ guidance: true, rules: { added: ['esc'] }, any: true });
    expect(read(out.file)).toMatchObject({ revision: 4, guidance: ['A bug fix is KTLO.'] });
  });

  it('writes the repository\'s working-tree file for a scheme that lives there', async () => {
    const d = disk({ 'work/.toil/classify/team.json': team(), 'work/v2.json': team({ guidance: ['Changed.'] }) });
    const out = data(await cli(d, ['classify', 'scheme', 'set', 'team', '--input-file', 'v2.json']));
    expect(out).toMatchObject({ source: 'repo', revision: 4, file: forwardSlashes(join(d.workspace, '.toil', 'classify', 'team.json')) });
    expect(existsSync(join(d.home, '.toil', 'classify', 'team.json'))).toBe(false);
  });

  it('writes a scheme named by path in place, which is how one beside a toil project is reached', async () => {
    const d = disk({ 'work/shared/mine.json': { name: 'mine', classify: { scheme: './team.json' } }, 'work/shared/team.json': team(), 'work/v2.json': team({ guidance: ['Changed.'] }) });
    // A toil project's `./team.json` is a file beside it; `set` has no toil project input, so it takes the path and writes the file where it lives.
    const out = data(await cli(d, ['classify', 'scheme', 'set', './shared/team.json', '--input-file', 'v2.json']));
    expect(out).toMatchObject({ source: 'file', revision: 4, file: forwardSlashes(join(d.workspace, 'shared', 'team.json')) });
  });

  it("reads and rewrites the scheme file beside a toil project, through the toil project, even in toil's own folder", async () => {
    const d = disk({
      'home/.toil/projects/mine.json': { name: 'mine', classify: { scheme: './schemes/team.json' } },
      'home/.toil/projects/schemes/team.json': team(),
      'work/v2.json': team({ guidance: ['Changed.'] }),
    });
    const file = forwardSlashes(join(d.home, '.toil', 'projects', 'schemes', 'team.json'));
    // By path alone the file is toil's own and refused; through the toil project it is the scheme the toil project uses.
    expect((await cli(d, ['classify', 'scheme', 'show', file])).ok).toBe(false);
    const shown = data(await cli(d, ['classify', 'scheme', 'show', '--toil-project', 'mine']));
    expect(shown).toMatchObject({ source: 'toil-project', file, scheme: { name: 'team', revision: 3 } });
    const out = data(await cli(d, ['classify', 'scheme', 'set', '--toil-project', 'mine', '--input-file', 'v2.json']));
    expect(out).toMatchObject({ source: 'toil-project', revision: 4, previousRevision: 3, file });
    expect(read(file)).toMatchObject({ revision: 4, guidance: ['Changed.'] });
    expect(existsSync(join(d.home, '.toil', 'classify', 'team.json'))).toBe(false);
  });

  it('needs a scheme name or a toil project, and a name still wins over the toil project', async () => {
    const d = disk({ 'home/.toil/projects/mine.json': { name: 'mine', classify: { scheme: 'balance' } } });
    expect((await cli(d, ['classify', 'scheme', 'show'])).error?.code).toBe('INVALID_INPUT');
    expect(data(await cli(d, ['classify', 'scheme', 'show', '--toil-project', 'mine'])).scheme.name).toBe('balance');
    expect(data(await cli(d, ['classify', 'scheme', 'show', 'ktlo-feature', '--toil-project', 'mine'])).scheme.name).toBe('ktlo-feature');
  });

  it('writes a user copy for a built-in scheme, leaving the built-in as it was', async () => {
    const d = disk({ 'work/v2.json': { ...builtinScheme('ktlo-feature'), guidance: ['Mine.'] } });
    const out = data(await cli(d, ['classify', 'scheme', 'set', 'ktlo-feature', '--input-file', 'v2.json']));
    expect(out).toMatchObject({ source: 'user', revision: 2, previousRevision: 1, file: forwardSlashes(join(d.home, '.toil', 'classify', 'ktlo-feature.json')) });
    expect(read(out.file).guidance).toEqual(['Mine.']);
    expect(builtinScheme('ktlo-feature')!.guidance).toHaveLength(1);
    expect(data(await cli(d, ['classify', 'scheme', 'show', 'ktlo-feature'])).source).toBe('user');
  });

  it('takes a file with no name as the scheme\'s own, and refuses a file for another scheme', async () => {
    const d = disk({ 'home/.toil/classify/team.json': team(), 'work/noname.json': { ...team({ guidance: ['x'] }), name: undefined }, 'work/other.json': team({ name: 'other' }) });
    expect(data(await cli(d, ['classify', 'scheme', 'set', 'team', '--input-file', 'noname.json'])).revision).toBe(4);
    const e = await cli(d, ['classify', 'scheme', 'set', 'team', '--input-file', 'other.json']);
    expect(e.error?.code).toBe('INVALID_INPUT');
    expect(e.error?.message).toContain('holds a scheme named "other", and team is "team"');
    expect(read(join(d.home, '.toil', 'classify', 'team.json')).revision).toBe(4);
  });

  it('writes nothing for a file that changes nothing, and warns SCHEME_UNCHANGED with the revision kept', async () => {
    const d = disk({ 'home/.toil/classify/team.json': team(), 'work/same.json': team({ revision: 50 }) });
    const e = await cli(d, ['classify', 'scheme', 'set', 'team', '--input-file', 'same.json']);
    expect(data(e)).toMatchObject({ revision: 3, previousRevision: 3, changes: { any: false } });
    expect(e.meta.warnings?.map((w) => w.code)).toContain('SCHEME_UNCHANGED');
    expect(read(join(d.home, '.toil', 'classify', 'team.json')).revision).toBe(3);
  });

  it('refuses an invalid revised file by key path, leaving the scheme as it was', async () => {
    const d = disk({ 'home/.toil/classify/team.json': team(), 'work/bad.json': team({ categories: [category('only')] }) });
    const e = await cli(d, ['classify', 'scheme', 'set', 'team', '--input-file', 'bad.json']);
    expect(e.error?.code).toBe('CONFIG_INVALID');
    expect(e.error?.message).toContain('categories:');
    expect(read(join(d.home, '.toil', 'classify', 'team.json'))).toEqual(team());
  });

  it('refuses a revised file outside the workspace', async () => {
    const d = disk({ 'home/.toil/classify/team.json': team(), 'outside/v2.json': team({ guidance: ['x'] }) });
    expect((await cli(d, ['classify', 'scheme', 'set', 'team', '--input-file', join(d.root, 'outside', 'v2.json')])).error?.message).toContain('outside the workspace');
  });

  it('is never an MCP tool, and is a person\'s command for a host that has one', async () => {
    const d = disk();
    const s = await mcp(d);
    const tools = (await s.client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('classify_scheme_init');
    expect(tools).not.toContain('classify_scheme_set');
    expect(tools).not.toContain('classify_scheme_import');
    const names = registry.personCommands.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['classify scheme set', 'classify scheme import']));
    expect(registry.commands.map((c) => c.name)).not.toEqual(expect.arrayContaining(['classify scheme set']));
    expect(registry.personCommands.map((c) => c.name)).not.toContain('classify scheme init');
  });
});

describe('classify scheme import', () => {
  it('copies a scheme file into your folder under its own name, keeping its revision', async () => {
    const d = disk({ 'work/.toil/classify/team.json': team() });
    const out = data(await cli(d, ['classify', 'scheme', 'import', '.toil/classify/team.json']));
    expect(out).toMatchObject({ name: 'team', revision: 3, file: forwardSlashes(join(d.home, '.toil', 'classify', 'team.json')) });
    expect(data(await cli(d, ['classify', 'scheme', 'show', 'team'])).source).toBe('user');
  });

  it('renames with --name, refuses a name you have, and replaces with --replace', async () => {
    const d = disk({ 'work/shared/team.json': team(), 'home/.toil/classify/mine.json': team({ name: 'mine', guidance: ['old'] }) });
    expect(data(await cli(d, ['classify', 'scheme', 'import', 'shared/team.json', '--name', 'copy'])).name).toBe('copy');
    const again = await cli(d, ['classify', 'scheme', 'import', 'shared/team.json', '--name', 'mine']);
    expect(again.error?.message).toContain('You already have a scheme named "mine"');
    expect(again.error?.fix).toContain('--replace');
    expect(data(await cli(d, ['classify', 'scheme', 'import', 'shared/team.json', '--name', 'mine', '--replace'])).name).toBe('mine');
    expect(read(join(d.home, '.toil', 'classify', 'mine.json')).guidance).toEqual([]);
  });

  it('refuses a file already in your folder, a bad name and a file outside the workspace', async () => {
    const d = disk({ 'home/.toil/classify/team.json': team(), 'outside/x.json': team({ name: 'x' }), 'work/shared/team.json': team() });
    expect((await cli(d, ['classify', 'scheme', 'import', join(d.home, '.toil', 'classify', 'team.json'), '--replace'])).error?.message).toContain('already in your own folder');
    expect((await cli(d, ['classify', 'scheme', 'import', 'shared/team.json', '--name', 'Bad Name'])).error?.code).toBe('INVALID_INPUT');
    expect((await cli(d, ['classify', 'scheme', 'import', join(d.root, 'outside', 'x.json')])).error?.message).toContain('outside the workspace');
  });
});

describe('projects classify set', () => {
  const project = { name: 'payments', repos: [], jira: { project: 'PAY' } };

  it('sets the scheme and targets, and writes the key back in the toil project file', async () => {
    const d = disk({ 'home/.toil/projects/payments.json': project });
    const out = data(await cli(d, ['projects', 'classify', 'set', 'payments', '--scheme', 'balance', '--target', 'jira.field=workCategory', '--target', 'github.project=imagile/7', '--target', 'github.field=Category', '--target', 'github.value.ktlo=Keep the lights on']));
    expect(out.classify).toEqual({ scheme: 'balance', targets: { jira: { field: 'workCategory' }, github: { project: 'imagile/7', field: 'Category', values: { ktlo: 'Keep the lights on' } } } });
    expect(read(join(d.home, '.toil', 'projects', 'payments.json')).classify).toEqual(out.classify);
    expect(read(join(d.home, '.toil', 'projects', 'payments.json')).jira).toEqual({ project: 'PAY' });
  });

  it('refuses to change a value that is already set unless --replace, naming it', async () => {
    const d = disk({ 'home/.toil/projects/payments.json': { ...project, classify: { scheme: 'balance', targets: { jira: { field: 'a', values: { ktlo: 'KTLO' } } } } } });
    for (const [args, what] of [[['--scheme', 'ktlo-feature'], 'scheme'], [['--target', 'jira.field=b'], 'jira.field'], [['--target', 'jira.value.ktlo=Other'], 'jira.value.ktlo']] as const) {
      const e = await cli(d, ['projects', 'classify', 'set', 'payments', ...args]);
      expect(e.error?.message).toContain(`${what} is already set`);
      expect(e.error?.fix).toContain('--replace');
    }
    // The same value again is no change, and needs no --replace.
    expect(data(await cli(d, ['projects', 'classify', 'set', 'payments', '--scheme', 'balance'])).changed).toBe(false);
    expect(data(await cli(d, ['projects', 'classify', 'set', 'payments', '--scheme', 'ktlo-feature', '--replace'])).classify.scheme).toBe('ktlo-feature');
  });

  it('removes parts with --clear, and the key itself when nothing is left', async () => {
    const d = disk({ 'home/.toil/projects/payments.json': { ...project, classify: { scheme: 'balance', targets: { jira: { field: 'a' }, ado: { field: 'b' } } } } });
    expect(data(await cli(d, ['projects', 'classify', 'set', 'payments', '--clear', 'jira'])).classify).toEqual({ scheme: 'balance', targets: { ado: { field: 'b' } } });
    expect(data(await cli(d, ['projects', 'classify', 'set', 'payments', '--clear', 'scheme', '--clear', 'ado'])).classify).toBeNull();
    expect(read(join(d.home, '.toil', 'projects', 'payments.json'))).not.toHaveProperty('classify');
  });

  it('refuses a bad --target with what to write instead, and a scheme the reader would refuse', async () => {
    const d = disk({ 'home/.toil/projects/payments.json': project });
    expect((await cli(d, ['projects', 'classify', 'set', 'payments', '--target', 'gitlab.field=x'])).error?.fix).toContain('jira, github, ado');
    expect((await cli(d, ['projects', 'classify', 'set', 'payments', '--target', 'jira.project=x'])).error?.message).toContain('only github takes a project');
    expect((await cli(d, ['projects', 'classify', 'set', 'payments', '--target', 'jira.colour=x'])).error?.message).toContain("isn't something a target sets");
    expect((await cli(d, ['projects', 'classify', 'set', 'payments', '--target', 'nope'])).error?.message).toContain('takes key=value');
    const bad = await cli(d, ['projects', 'classify', 'set', 'payments', '--target', 'github.project=notaproject']);
    expect(bad.error?.message).toContain('classify.targets.github.project');
    expect(read(join(d.home, '.toil', 'projects', 'payments.json'))).not.toHaveProperty('classify');
  });

  it('warns when the scheme cannot be found yet, and still sets it', async () => {
    const d = disk({ 'home/.toil/projects/payments.json': project });
    const e = await cli(d, ['projects', 'classify', 'set', 'payments', '--scheme', './later.json']);
    expect(data(e).classify.scheme).toBe('./later.json');
    expect(e.meta.warnings?.map((w) => w.code)).toContain('CLASSIFY_SCHEME_UNRESOLVED');
  });

  it('is served over MCP, except --clear, which is a delete', async () => {
    const d = disk({ 'home/.toil/projects/payments.json': project });
    const s = await mcp(d);
    expect(data((await s.call('projects_classify_set', { toilProject: 'payments', scheme: 'balance', target: ['jira.field=workCategory'] })).envelope).classify.scheme).toBe('balance');
    const cleared = await s.call('projects_classify_set', { toilProject: 'payments', clear: ['scheme'] });
    expect(cleared.envelope.ok).toBe(false);
    expect(cleared.envelope.error?.message).toContain('a delete');
    expect(read(join(d.home, '.toil', 'projects', 'payments.json')).classify.scheme).toBe('balance');
  });

  it('gets the retired dossiers path like every projects command but migrate, so no list of exceptions is kept', () => {
    const find = (name: string) => allCommands.find((c) => c.path.join(' ') === name)!;
    expect(find('projects classify set').deprecatedPaths).toEqual([['dossiers', 'classify', 'set']]);
    expect(find('projects init').deprecatedPaths).toEqual([['dossiers', 'init']]);
    expect(find('projects migrate').deprecatedPaths).toBeUndefined();
  });
});

describe('the schemes on disk are what the reader writes', () => {
  it('init then show round-trips the exact file text', async () => {
    const d = disk();
    const out = data(await cli(d, ['classify', 'scheme', 'init', 'rt', '--from', 'balance']));
    expect(readFileSync(out.file, 'utf8')).toBe(schemeContent({ ...builtinScheme('balance')!, name: 'rt' }));
  });
});
