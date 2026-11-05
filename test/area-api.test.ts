import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineArea } from '../src/core/area.js';
import type { GitRemoteReader } from '../src/core/call-context.js';
import type { ResolvedConfig, Settings, Source } from '../src/core/config.js';
import { allowWriteField, execute } from '../src/core/run.js';
import { demoCommands } from './fixtures/demo-commands.js';
import { demoContextCommands, demoContextRoutes, getWidget, renameWidget } from './fixtures/demo-context-commands.js';
import { runCli } from './harness/cli.js';
import { testContext } from './harness/context.js';
import { fakeStore } from './harness/fake-store.js';
import { connectMcp, type McpSession } from './harness/mcp.js';

/**
 * The area API end to end, on the test-only demo-context area: the context
 * resolver's order, connection selection, settings shared from another
 * area's connection, aliases, and argv typed from the schema. The parity
 * suite already proves both front doors agree on every example; this proves
 * what they agree on.
 */

const commands = [...demoContextCommands, ...demoCommands];
const base = { 'demo-context': { project: 'PRJ', env: 'staging' }, demo: { token: 'shared-token' } };

/** A config of named connections, each value attributed to `source` (env unless said otherwise). */
function configOf(connections: Record<string, Settings & { area: string }>, defaults: ResolvedConfig['defaults'], sources: Record<string, Source> = {}): ResolvedConfig {
  const all: Record<string, Source> = {};
  for (const [name, conn] of Object.entries(connections)) for (const key of Object.keys(conn)) all[`${name}.${key}`] = 'env';
  return { connections, defaults, sources: { ...all, ...sources }, files: { global: '/home/test/.toil/config.json' }, warnings: [] };
}

const sessions: McpSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

describe('context inputs', () => {
  it('fills each input from the connection or the area default, and says so in meta.context', async () => {
    const { context, http } = testContext({ config: base, routes: demoContextRoutes });
    const run = await runCli(['demo-context', 'get-widget', 'W-1'], { commands, context });

    expect(run.envelope).toMatchObject({ ok: true, data: { project: 'PRJ', board: 'main', env: null, id: 'W-1', name: 'Widget W-1' } });
    expect(run.envelope?.meta.context).toEqual({
      connection: { value: 'demo-context', source: 'default', default: 'named' },
      inputs: { project: { value: 'PRJ', source: 'connection' }, board: { value: 'main', source: 'default' } },
      shared: { token: { area: 'demo', connection: 'demo', source: 'env', via: 'env-fallback' } },
    });
    expect(http.calls.map((c) => [c.url, c.headers.authorization])).toEqual([['https://demo.imagile.dev/api/projects/PRJ/widgets/W-1?board=main', 'Bearer shared-token']]);
  });

  it('takes a group flag before or after the leaf, and a command flag on the leaf', async () => {
    for (const argv of [
      ['demo-context', '--project', 'ABC', 'get-widget', 'W-1', '--board', 'ops'],
      ['demo-context', 'get-widget', 'W-1', '--project', 'ABC', '--board', 'ops'],
    ]) {
      const { context, http } = testContext({ config: base, routes: demoContextRoutes });
      const run = await runCli(argv, { commands, context });
      expect(run.envelope?.meta.context?.inputs, argv.join(' ')).toEqual({ project: { value: 'ABC', source: 'input' }, board: { value: 'ops', source: 'input' } });
      expect(http.calls[0]?.url).toBe('https://demo.imagile.dev/api/projects/ABC/widgets/W-1?board=ops');
    }
  });

  it('offers the same inputs as fixed MCP fields, and refuses a command-level one on a command that lacks it', async () => {
    const { context } = testContext({ config: base, routes: demoContextRoutes });
    const session = await connectMcp({ commands, context });
    sessions.push(session);
    const tools = (await session.client.listTools()).tools;
    const props = (name: string) => Object.keys(tools.find((t) => t.name === name)!.inputSchema.properties ?? {}).sort();
    expect(props('demo_context_get_widget')).toEqual(['board', 'connection', 'cwd', 'env', 'id', 'outputFormat', 'project', 'select', 'summaryFile', 'toilProject']);
    expect(props('demo_context_echo_filters')).not.toContain('board');

    const viaMcp = await session.call('demo_context_echo_filters', { board: 'ops' });
    expect(viaMcp.envelope.error?.code).toBe('INVALID_INPUT');
  });

  it('orders the sources: the call, then the toil project, then the git remote, then the connection', async () => {
    let reads = 0;
    const gitRemote: GitRemoteReader = async () => {
      reads++;
      return [{ name: 'origin', url: 'https://demo.imagile.dev/scm/GIT/widgets.git' }];
    };
    const noProject = { 'demo-context': {}, demo: { token: 't' } };
    const run = async (input: Record<string, unknown>, extra: object) => {
      const { context } = testContext({ config: noProject, routes: demoContextRoutes });
      return execute(getWidget, input, { ...context, ...extra });
    };

    const fromGit = await run({ id: 'W-1' }, { gitRemote });
    expect(fromGit.meta.context?.inputs?.project).toEqual({ value: 'GIT', source: 'git' });
    expect(reads).toBe(1);

    const fromToilProject = await run({ id: 'W-1' }, { gitRemote, toilProject: (area: string, key: string) => (area === 'demo-context' && key === 'project' ? 'DOS' : undefined) });
    expect(fromToilProject.meta.context?.inputs?.project).toEqual({ value: 'DOS', source: 'toil-project' });

    reads = 0;
    const explicit = await run({ id: 'W-1', project: 'MINE' }, { gitRemote });
    expect(explicit.meta.context?.inputs?.project).toEqual({ value: 'MINE', source: 'input' });
    expect(reads, 'an explicit value never reads git').toBe(0);
  });

  it('refuses a required input that no source supplies, naming the flag and the env var', async () => {
    const { context, http } = testContext({ config: { 'demo-context': {}, demo: { token: 't' } }, routes: demoContextRoutes });
    const envelope = await execute(getWidget, { id: 'W-1' }, context);
    expect(envelope.error).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'demo-context get-widget needs project, and none was given or found.',
      fix: 'Pass --project <key>, or set project on connection demo-context (TOIL_DEMO_CONTEXT_PROJECT).',
    });
    expect(http.calls).toHaveLength(0);
  });

  it("checks a value from the git remote or the connection against the input's schema", async () => {
    const { context } = testContext({ config: { 'demo-context': { project: 'lower' }, demo: { token: 't' } }, routes: demoContextRoutes });
    const envelope = await execute(getWidget, { id: 'W-1' }, context);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining(`"lower" from the connection's project setting`) });

    const viaGit = await execute(getWidget, { id: 'W-1' }, { ...context, gitRemote: async () => [{ name: 'origin', url: 'https://demo.imagile.dev/scm/bad/x.git' }] });
    // The git remote ranks above the connection, so its bad value is the one reported.
    expect(viaGit.error?.message).toContain('"bad" from the git remote');
  });
});

describe('a context input the command supplies, and its own wording when nothing does', () => {
  const filed = defineArea({
    name: 'filed',
    description: 'test',
    connection: z.object({ project: z.string().optional(), env: z.string().optional() }),
    context: {
      project: { description: 'Project key', flags: '--project <key>', scope: 'command', setting: 'project', schema: z.string().regex(/^[A-Z]+$/) },
      board: {
        description: 'Board',
        scope: 'command',
        setting: 'project',
        missing: { message: 'No board specified. Use --board or set defaults.filed.project in config.' },
      },
      env: { description: 'Environment', selectsConnection: true },
    },
  });
  const create = filed.command({
    path: ['filed', 'create'],
    description: 'test',
    writes: false,
    input: z.object({ fromFile: z.string().optional() }),
    context: { project: 'optional' },
    examples: [{}],
    run: async (input, ctx) => ({ used: ctx.supply('project', input.fromFile, 'file') ?? null, context: { ...ctx.context } }),
  });
  const run = (input: Record<string, unknown>, connection: Record<string, unknown> = {}) =>
    execute(create, input, { ...testContext().context, config: configOf({ filed: { area: 'filed', ...connection } }, { filed: { connection: 'filed' } }) });

  it('ranks the supplied value below the call and above the connection, and reports source file', async () => {
    const fromFile = await run({ fromFile: 'FILE' }, { project: 'CONN' });
    expect(fromFile.data).toEqual({ used: 'FILE', context: { project: 'FILE' } });
    expect(fromFile.meta.context?.inputs).toEqual({ project: { value: 'FILE', source: 'file' } });

    const flag = await run({ project: 'FLAG', fromFile: 'FILE' }, { project: 'CONN' });
    expect(flag.data).toEqual({ used: 'FLAG', context: { project: 'FLAG' } });
    expect(flag.meta.context?.inputs).toEqual({ project: { value: 'FLAG', source: 'input' } });

    const none = await run({}, { project: 'CONN' });
    expect(none.data).toEqual({ used: 'CONN', context: { project: 'CONN' } });
    expect(none.meta.context?.inputs).toEqual({ project: { value: 'CONN', source: 'connection' } });

    const nothing = await run({ fromFile: '' });
    expect(nothing.data).toEqual({ used: null, context: {} });
    expect(nothing.meta.context).not.toHaveProperty('inputs');
  });

  it("checks a supplied value against the input's schema, naming the file as where it came from", async () => {
    const bad = await run({ fromFile: 'lower' });
    expect(bad.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('filed project "lower" from the input file isn') });
  });

  it('refuses to supply an input the command does not list, or one that selects the connection', async () => {
    const wrong = (name: 'board' | 'env') =>
      filed.command({ path: ['filed', `w-${name}`], description: 'test', writes: false, input: z.object({}), examples: [{}], run: async (_i, ctx) => ctx.supply(name, 'X', 'file') });
    const config = configOf({ filed: { area: 'filed' } }, { filed: { connection: 'filed' } });
    expect((await execute(wrong('board'), {}, { ...testContext().context, config })).error?.message).toContain(`"board" isn't one of its context inputs`);
    expect((await execute(wrong('env'), {}, { ...testContext().context, config })).error?.message).toContain('"env" selects the connection');
  });

  it("uses an input's own missing wording, with core's fix unless it gives one", async () => {
    const needsBoard = filed.command({ path: ['filed', 'board'], description: 'test', writes: false, input: z.object({}), context: { board: 'required' }, examples: [{}], run: async () => ({}) });
    const envelope = await execute(needsBoard, {}, { ...testContext().context, config: configOf({ filed: { area: 'filed' } }, { filed: { connection: 'filed' } }) });
    expect(envelope.error).toEqual({
      code: 'INVALID_INPUT',
      message: 'No board specified. Use --board or set defaults.filed.project in config.',
      fix: 'Pass --board <value>, or set project on connection filed (TOIL_FILED_PROJECT).',
    });
  });
});

describe('choosing the connection', () => {
  const two = configOf(
    {
      prod: { area: 'demo-context', env: 'production', project: 'PRD', token: 'p' },
      stage: { area: 'demo-context', env: 'staging', project: 'STG', token: 's' },
      demo: { area: 'demo', token: 't' },
    },
    { 'demo-context': { connection: 'prod' }, demo: { connection: 'demo' } },
  );
  const run = async (input: Record<string, unknown>, config: ResolvedConfig = two, extra: object = {}) => {
    const { context } = testContext({ routes: demoContextRoutes });
    return execute(getWidget, input, { ...context, config, ...extra });
  };

  it('lets --env select a connection by its setting or its name', async () => {
    expect((await run({ id: 'W-1', env: 'staging' })).meta.context?.connection).toEqual({ value: 'stage', source: 'input', via: 'env' });
    expect((await run({ id: 'W-1', env: 'stage' })).meta.context?.connection).toEqual({ value: 'stage', source: 'input', via: 'env' });
    expect((await run({ id: 'W-1', env: 'staging' })).data).toMatchObject({ project: 'STG', env: 'staging' });
    expect((await run({ id: 'W-1' })).meta.context?.connection).toEqual({ value: 'prod', source: 'default', default: 'named' });
  });

  it('takes the connection from the toil project below the call and above an input the git remote selects', async () => {
    const toilProject = (_area: string, key: string) => (key === 'connection' ? 'stage' : undefined);
    expect((await run({ id: 'W-1' }, two, { toilProject })).meta.context?.connection).toEqual({ value: 'stage', source: 'toil-project' });
    expect((await run({ id: 'W-1', connection: 'prod' }, two, { toilProject })).meta.context?.connection).toEqual({ value: 'prod', source: 'input' });
  });

  it('lets a selecting value from a lower source give way to the connection a higher one chose', async () => {
    const toilProject = (_area: string, key: string) => (key === 'env' ? 'staging' : undefined);
    const envelope = await run({ id: 'W-1', connection: 'prod' }, two, { toilProject });
    expect(envelope.meta.context?.connection).toEqual({ value: 'prod', source: 'input' });
    // Not the toil project's "staging", which would describe the other connection.
    expect(envelope.meta.context?.inputs?.env).toBeUndefined();
    expect(envelope.data).toMatchObject({ project: 'PRD', env: null });
    // With nothing higher, the toil project's env picks the connection.
    expect((await run({ id: 'W-1' }, two, { toilProject })).meta.context?.connection).toEqual({ value: 'stage', source: 'toil-project', via: 'env' });
  });

  it('says which kind of default it used', async () => {
    const only = configOf({ solo: { area: 'demo-context', project: 'P' }, demo: { area: 'demo', token: 't' } }, { demo: { connection: 'demo' } });
    expect((await run({ id: 'W-1' }, only)).meta.context?.connection).toEqual({ value: 'solo', source: 'default', default: 'only' });
    const named = configOf({ 'demo-context': { area: 'demo-context', project: 'P' }, other: { area: 'demo-context' }, demo: { area: 'demo', token: 't' } }, { demo: { connection: 'demo' } });
    expect((await run({ id: 'W-1' }, named)).meta.context?.connection).toEqual({ value: 'demo-context', source: 'default', default: 'area-name' });
  });

  it('still reports the connection when resolution fails part-way', async () => {
    const { context } = testContext({ config: { 'demo-context': {}, demo: { token: 't' } } });
    const envelope = await execute(getWidget, { id: 'W-1', board: 'ops' }, context);
    expect(envelope.error?.code).toBe('INVALID_INPUT');
    expect(envelope.meta.context).toMatchObject({ connection: { value: 'demo-context' }, inputs: { board: { value: 'ops', source: 'input' } } });
  });

  it('refuses --connection and --env that disagree, an env no connection serves, and one several do', async () => {
    expect((await run({ id: 'W-1', connection: 'prod', env: 'staging' })).error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('selects connection stage') });
    expect((await run({ id: 'W-1', connection: 'stage', env: 'staging' })).ok).toBe(true);
    expect((await run({ id: 'W-1', env: 'qa' })).error).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'demo-context has no env "qa" (from the call). It knows: production (connection prod), staging (connection stage).',
    });
    const fromToilProject = await run({ id: 'W-1' }, two, { toilProject: (_a: string, key: string) => (key === 'env' ? 'qa' : undefined) });
    expect(fromToilProject.error).toMatchObject({ message: expect.stringContaining('(from your toil project)'), fix: expect.stringContaining('or correct your toil project') });

    const twins = configOf({ a: { area: 'demo-context', env: 'staging', token: 't' }, b: { area: 'demo-context', env: 'staging', token: 't' }, demo: { area: 'demo', token: 't' } }, { demo: { connection: 'demo' } });
    expect((await run({ id: 'W-1', env: 'staging', project: 'P' }, twins)).error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('a, b') });
  });
});

describe('settings shared from another area', () => {
  const run = async (config: ResolvedConfig, store?: ReturnType<typeof fakeStore>) => {
    const { context, http } = testContext({ routes: demoContextRoutes });
    const envelope = await execute(getWidget, { id: 'W-1', project: 'PRJ' }, { ...context, config, ...(store ? { secrets: store } : {}) });
    return { envelope, auth: http.calls[0]?.headers.authorization };
  };
  const defaults = { 'demo-context': { connection: 'dc' }, demo: { connection: 'de' } };
  /** A file-tier value must be a keychain reference; this swaps one in, with the secret in the store. */
  const inFile = (cfg: ResolvedConfig, store: ReturnType<typeof fakeStore>, name: string, key: string) => {
    store.entries.set(`${name}.${key}`, String(cfg.connections[name]![key]));
    cfg.connections[name]![key] = `keychain:${name}.${key}`;
    cfg.sources[`${name}.${key}`] = 'global';
  };

  it('borrows from a paired connection: env beats file across both, and the own connection wins a tie', async () => {
    const cases: Array<[Source, Source, string]> = [
      ['env', 'env', 'Bearer own'],
      ['global', 'env', 'Bearer theirs'],
      ['env', 'global', 'Bearer own'],
      ['global', 'global', 'Bearer own'],
    ];
    for (const [own, theirs, expected] of cases) {
      const cfg = configOf({ dc: { area: 'demo-context', token: 'own', tokenFrom: 'de' }, de: { area: 'demo', token: 'theirs' } }, defaults);
      const store = fakeStore();
      if (own === 'global') inFile(cfg, store, 'dc', 'token');
      if (theirs === 'global') inFile(cfg, store, 'de', 'token');
      expect((await run(cfg, store)).auth, `${own} vs ${theirs}`).toBe(expected);
    }

    const ownUnset = configOf({ dc: { area: 'demo-context', tokenFrom: 'de' }, de: { area: 'demo', token: 'from-store' } }, defaults);
    const store = fakeStore();
    inFile(ownUnset, store, 'de', 'token');
    const { envelope, auth } = await run(ownUnset, store);
    expect(auth).toBe('Bearer from-store');
    expect(envelope.meta.context?.shared).toEqual({ token: { area: 'demo', connection: 'de', source: 'store', via: 'pairing' } });
  });

  it("ranks the own defaults.<area> with the own file tier, above the paired connection's file value", async () => {
    const cfg = configOf({ dc: { area: 'demo-context', tokenFrom: 'de' }, de: { area: 'demo', token: 'theirs' } }, { ...defaults, 'demo-context': { connection: 'dc', token: 'keychain:shared.token' } });
    const store = fakeStore({ entries: { 'shared.token': 'own-defaults' } });
    inFile(cfg, store, 'de', 'token');
    expect((await run(cfg, store)).auth).toBe('Bearer own-defaults');
  });

  it('borrows nothing without a pairing, except the default connection taking the other default env value', async () => {
    // Not the default connection, not paired: its own token or nothing.
    const unpaired = configOf({ dc: { area: 'demo-context' }, other: { area: 'demo-context' }, de: { area: 'demo', token: 'theirs' } }, defaults);
    const { context, http } = testContext({ routes: demoContextRoutes });
    const viaOther = await execute(getWidget, { id: 'W-1', project: 'PRJ', connection: 'other' }, { ...context, config: unpaired });
    expect(viaOther.error?.code).toBe('NOT_CONFIGURED');
    expect(http.calls).toHaveLength(0);

    // The default connection: the other default's env value, as TOIL_DEMO_TOKEN would give it.
    const fallback = await run(unpaired);
    expect(fallback.auth).toBe('Bearer theirs');
    expect(fallback.envelope.meta.context?.shared).toEqual({ token: { area: 'demo', connection: 'de', source: 'env', via: 'env-fallback' } });

    // ...but never its stored value, which only a pairing reaches.
    const store = fakeStore();
    inFile(unpaired, store, 'de', 'token');
    expect((await run(unpaired, store)).envelope.error?.code).toBe('NOT_CONFIGURED');
  });

  it('refuses a pairing with a connection that is missing or of another area', async () => {
    for (const target of ['nope', 'dc2']) {
      const cfg = configOf({ dc: { area: 'demo-context', tokenFrom: target }, dc2: { area: 'demo-context' }, de: { area: 'demo', token: 't' } }, defaults);
      const { envelope, auth } = await run(cfg);
      expect(envelope.error, target).toMatchObject({ code: 'CONFIG_INVALID', message: expect.stringContaining(`takes token from "${target}", which isn't a demo connection`), fix: expect.stringContaining('(de)') });
      expect(auth).toBeUndefined();
    }
  });

  it('finds a shared key under a renamed name, on either side', async () => {
    const ownOld = configOf({ dc: { area: 'demo-context', apiToken: 'own-old', tokenFrom: 'de' }, de: { area: 'demo', token: 'theirs' } }, defaults);
    expect((await run(ownOld)).auth).toBe('Bearer own-old');
    const theirsOld = configOf({ dc: { area: 'demo-context', tokenFrom: 'de' }, de: { area: 'demo', apiToken: 'theirs-old' } }, defaults);
    expect((await run(theirsOld)).auth).toBe('Bearer theirs-old');
  });

  it("refuses the paired connection's plaintext secret in a file, naming that connection", async () => {
    const cfg = configOf({ dc: { area: 'demo-context', tokenFrom: 'de' }, de: { area: 'demo', token: 'plain' } }, defaults, { 'de.token': 'global' });
    const { envelope, auth } = await run(cfg);
    expect(envelope.error).toMatchObject({ code: 'CONFIG_INVALID', message: expect.stringContaining('Connection de (demo) has token in plain text') });
    expect(auth).toBeUndefined();
  });

  it('reports nothing shared when the own connection has the setting, and says which key was sent on a 401', async () => {
    const own = configOf({ dc: { area: 'demo-context', token: 'own', tokenFrom: 'de' }, de: { area: 'demo', token: 'theirs' } }, defaults);
    expect((await run(own)).envelope.meta.context).not.toHaveProperty('shared');

    const { context } = testContext({ config: base, routes: [{ url: /widgets/, respond: { status: 401, json: {} } }] });
    const rejected = await execute(getWidget, { id: 'W-1' }, context);
    expect(rejected.error?.message).toBe('The token was rejected (sent the shared token from demo connection demo).');
  });
});

describe('writes on a connection the toil project or the git remote chose', () => {
  const two = configOf(
    {
      prod: { area: 'demo-context', env: 'production', project: 'PRD', token: 'p', writes: true },
      stage: { area: 'demo-context', env: 'staging', project: 'STG', token: 's', writes: true },
      demo: { area: 'demo', token: 't' },
    },
    { 'demo-context': { connection: 'prod' }, demo: { connection: 'demo' } },
  );
  const write = async (input: Record<string, unknown>, extra: object = {}) => {
    const { context, http } = testContext({ routes: demoContextRoutes });
    const envelope = await execute(renameWidget, { id: 'W-1', name: 'N', allowWrite: true, ...input }, { ...context, config: two, ...extra });
    return { envelope, calls: http.calls };
  };
  const toilProject = (_area: string, key: string) => (key === 'env' ? 'staging' : undefined);

  it('refuses until the binding is adopted, naming the connection and how to choose it', async () => {
    const refused = await write({}, { toilProject });
    expect(refused.envelope.error).toEqual({
      code: 'WRITE_DISABLED',
      message: 'demo-context rename-widget changes data in demo-context, and connection stage was chosen by your toil project, not by you.',
      fix: 'Pass --connection stage to choose it yourself, or adopt the toil project once with toil projects import, which copies it into your own folder.',
    });
    expect(refused.calls).toHaveLength(0);

    const adopted = await write({}, { toilProject, adopted: (area: string, name: string) => area === 'demo-context' && name === 'stage' });
    expect(adopted.envelope.ok).toBe(true);
    expect(adopted.calls[0]?.url).toContain('/projects/STG/');
  });

  it('lets reads follow the toil project, and writes follow an explicit choice or the default', async () => {
    const { context } = testContext({ routes: demoContextRoutes });
    expect((await execute(getWidget, { id: 'W-1' }, { ...context, config: two, toilProject })).ok).toBe(true);
    expect((await write({ connection: 'stage' }, { toilProject })).envelope.ok).toBe(true);
    expect((await write({ env: 'staging' })).envelope.ok).toBe(true);
    expect((await write({})).envelope.ok).toBe(true);
  });

  it('refuses a write on a connection the git remote selected', async () => {
    const gitArea = defineArea({
      name: 'git-picked',
      description: 'test',
      connection: z.object({ instance: z.string().optional() }),
      context: { instance: { description: 'Instance', selectsConnection: true, git: (r) => new URL(r.url).hostname.split('.')[0] } },
    });
    const change = gitArea.command({ path: ['git-picked', 'change'], description: 'test', input: z.object({ ...allowWriteField }), writes: true, examples: [{ allowWrite: true }], run: async () => ({ changed: true }) });
    const config = configOf({ alpha: { area: 'git-picked', writes: true }, beta: { area: 'git-picked', writes: true } }, { 'git-picked': { connection: 'alpha' } });
    const { context } = testContext();
    const envelope = await execute(change, { allowWrite: true }, { ...context, config, gitRemote: async () => [{ name: 'origin', url: 'https://beta.imagile.dev/x.git' }] });
    expect(envelope.error).toMatchObject({ code: 'WRITE_DISABLED', message: expect.stringContaining('connection beta was chosen by the git remote') });
  });
});

describe('area-local commands', () => {
  it("refuse the area's group flags rather than ignore them, before or after the leaf", async () => {
    for (const argv of [
      ['demo-context', '--project', 'ABC', 'about'],
      ['demo-context', 'about', '--project', 'ABC'],
    ]) {
      const { context } = testContext({ config: base });
      const run = await runCli(argv, { commands, context });
      expect(run.envelope?.error?.code, argv.join(' ')).toBe('INVALID_INPUT');
    }
    const { context } = testContext();
    expect((await runCli(['demo-context', 'about'], { commands, context })).envelope).toMatchObject({ ok: true, meta: { command: 'demo-context about' } });
  });
});

describe('aliases', () => {
  it('runs a cross-group alias and a sibling alias as the command, and names the command in meta', async () => {
    for (const path of [['demo', 'widget'], ['demo-context', 'widget']]) {
      const { context, http } = testContext({ config: base, routes: demoContextRoutes });
      const run = await runCli([...path, 'W-1'], { commands, context });
      expect(run.envelope, path.join(' ')).toMatchObject({ ok: true, data: { id: 'W-1' }, meta: { command: 'demo-context get-widget' } });
      expect(http.calls).toHaveLength(1);
    }
  });

  it("gives an alias in another group the area's group flags on its own leaf", async () => {
    const { context, http } = testContext({ config: base, routes: demoContextRoutes });
    const run = await runCli(['demo', 'widget', 'W-1', '--project', 'ABC', '--env', 'staging'], { commands, context });
    expect(run.envelope?.meta.context?.inputs?.project).toEqual({ value: 'ABC', source: 'input' });
    expect(http.calls[0]?.url).toContain('/projects/ABC/');
  });

  it("refuses a group flag before an alias's leaf in another group, saying to move it", async () => {
    const { context, http } = testContext({ config: base, routes: demoContextRoutes });
    const run = await runCli(['demo', '--project', 'ABC', 'widget', 'W-1'], { commands, context });
    expect(run.envelope).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: "--project goes after the command on toil demo widget: it's a demo-context group flag, and demo doesn't have it.",
        fix: 'Run toil demo widget ... --project <value>, or toil demo-context --project <value> get-widget ....',
      },
      meta: { command: 'demo-context get-widget' },
    });
    expect(http.calls).toHaveLength(0);

    // When commander refused a different option, even beside a misplaced group flag, its own error stands.
    for (const argv of [['demo', '--bogus', 'widget', 'W-1'], ['demo', '--bogus', '--project', 'ABC', 'widget', 'W-1']]) {
      const other = await runCli(argv, { commands, context });
      expect(other.envelope?.error, argv.join(' ')).toMatchObject({ code: 'INVALID_INPUT', message: "Unknown option '--bogus'" });
    }
  });

  it('names the command, not the alias, on a usage error', async () => {
    const { context } = testContext({ config: base });
    const run = await runCli(['demo', 'widget', 'W-1', '--nope'], { commands, context });
    expect(run.envelope).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' }, meta: { command: 'demo-context get-widget' } });
  });
});

describe('CLI values typed from the input schema', () => {
  it('turns numbers, booleans, enums, repeated numbers and JSON into their types, and leaves a union as text', async () => {
    const { context } = testContext({ config: base });
    const argv = ['demo-context', 'echo-filters', '--limit', '5', '--archived', '--strict', 'false', '--sort', 'created', '--id', '1', '--id', '2', '--filter', '{"owner":"you","open":true}', '--label', '7'];
    const run = await runCli(argv, { commands, context });
    expect(run.envelope?.data).toEqual({
      input: { limit: 5, archived: true, strict: false, sort: 'created', ids: [1, 2], filter: { owner: 'you', open: true }, label: '7' },
      context: { project: 'PRJ' },
    });
  });

  it('leaves text that does not parse for the schema to refuse, with the same envelope as MCP', async () => {
    const { context } = testContext({ config: base });
    const cli = await runCli(['demo-context', 'echo-filters', '--limit', 'five', '--filter', '{not json'], { commands, context });
    const session = await connectMcp({ commands, context });
    sessions.push(session);
    const mcp = await session.call('demo_context_echo_filters', { limit: 'five', filter: '{not json' });
    expect(cli.envelope?.error?.code).toBe('INVALID_INPUT');
    expect({ ...mcp.envelope, meta: { ...mcp.envelope.meta, durationMs: 0 } }).toEqual({ ...cli.envelope, meta: { ...cli.envelope!.meta, durationMs: 0 } });
  });
});
