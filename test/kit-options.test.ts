import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { connectionsCommands } from '../src/connections/commands.js';
import { defineArea } from '../src/core/area.js';
import { aliasPaths, servedOverMcp, withCoreAliases } from '../src/core/command.js';
import { withArticle } from '../src/core/errors.js';
import { nodeFiles } from '../src/core/files.js';
import { execute, exitCodeOf } from '../src/core/run.js';
import { selectCommands } from '../src/mcp/server.js';
import { withoutHttpUserinfo } from '../src/node-context.js';
import { argvFor } from '../src/program.js';
import { deleteThing, demoArea, demoCommands, demoRoutes, getThing, thingStatus } from './fixtures/demo-commands.js';
import { runCli } from './harness/cli.js';
import { testConfig, testContext } from './harness/context.js';
import { diffContract, readDivergenceFiles, removedPaths } from './harness/contract.js';
import { connectMcp, type McpSession } from './harness/mcp.js';

/**
 * The second batch of integration-kit options (#68): what an area may ask of core
 * without reaching past it. Each is small, additive, and changes no existing
 * envelope. Approved in principle, pending the usual countersignature.
 */

const sessions: McpSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

describe('a success envelope with a requested exit code', () => {
  const spec = {
    path: ['demo', 'run-build'] as [string, ...string[]],
    description: 'Run a build and report it',
    input: z.object({ fail: z.boolean().optional().describe('Whether the build fails') }),
    writes: false,
    options: [{ flags: '--fail', field: 'fail', description: 'The build fails' }],
    examples: [{ fail: true }],
  };
  const build = demoArea.command({
    ...spec,
    run: async (input, ctx) => {
      if (input.fail) ctx.setExitCode(1);
      return { result: input.fail ? 'FAILURE' : 'SUCCESS' };
    },
  });
  const config = { demo: { token: 't' } };

  it('stays ok with its data on the CLI, and exits with the code asked for', async () => {
    const { context } = testContext({ config });
    const failed = await runCli(['demo', 'run-build', '--fail'], { commands: [build], context });
    expect(failed.envelope).toMatchObject({ ok: true, error: null, data: { result: 'FAILURE' } });
    expect(failed.exitCode).toBe(1);
    const passed = await runCli(['demo', 'run-build'], { commands: [build], context });
    expect(passed.exitCode).toBe(0);
  });

  it('is the same envelope over MCP, not marked as an error', async () => {
    const { context } = testContext({ config });
    const session = await connectMcp({ commands: [build], context });
    sessions.push(session);
    const viaMcp = await session.call('demo_run_build', { fail: true });
    const viaCli = await runCli(['demo', 'run-build', '--fail'], { commands: [build], context });
    expect(viaMcp.isError).toBe(false);
    expect({ ...viaMcp.envelope, meta: { ...viaMcp.envelope.meta, durationMs: 0 } }).toEqual({ ...viaCli.envelope, meta: { ...viaCli.envelope!.meta, durationMs: 0 } });
  });

  it('is 1 for any failure and 0 by default, and refuses a code that is not one', async () => {
    const { context } = testContext({ config });
    expect(exitCodeOf(await execute(getThing, { id: 'THING-1' }, testContext({ config, routes: demoRoutes }).context))).toBe(0);
    expect(exitCodeOf(await execute(getThing, {}, context))).toBe(1);
    const bad = demoArea.command({ ...spec, path: ['demo', 'bad-code'], run: async (_i, ctx) => ctx.setExitCode(1.5) });
    const envelope = await execute(bad, {}, context);
    expect(envelope.error?.code).toBe('INTERNAL');
    expect(envelope.error?.message).toContain('whole number from 0 to 255');
  });
});

describe('an area alias onto a core command', () => {
  const widgets = defineArea({ name: 'widgets', description: 'test', connection: z.object({ baseUrl: z.url(), token: z.string() }), secrets: ['token'], coreAliases: { 'instance list': 'connections list' } });
  const areas = [widgets, demoArea];
  const commands = withCoreAliases(connectionsCommands(areas), areas);
  const list = commands.find((d) => d.path.join(' ') === 'connections list')!;
  const config = { widgets: { baseUrl: 'https://widgets.imagile.dev', token: 't' }, demo: { token: 't' } };

  it('runs connections list for that area only, with no --area flag of its own', async () => {
    expect(aliasPaths(list)).toContainEqual(['widgets', 'instance', 'list']);
    const { context } = testContext({ config });
    const run = await runCli(['widgets', 'instance', 'list'], { commands, context });
    expect(run.envelope?.meta.command).toBe('connections list');
    expect((run.envelope?.data as { connections: Array<{ name: string }> }).connections.map((c) => c.name)).toEqual(['widgets']);
    const refused = await runCli(['widgets', 'instance', 'list', '--area', 'demo'], { commands, context });
    expect(refused.envelope?.error?.code).toBe('INVALID_INPUT');
  });

  it('matches connections list --area over the CLI and the area field over MCP', async () => {
    const { context } = testContext({ config });
    const viaFlag = await runCli(['connections', 'list', '--area', 'widgets'], { commands, context });
    const session = await connectMcp({ commands, context });
    sessions.push(session);
    const viaMcp = await session.call('connections_list', { area: 'widgets' });
    expect(viaMcp.envelope.data).toEqual(viaFlag.envelope?.data);
    expect(argvFor(list, { area: 'widgets' }, ['widgets', 'instance', 'list'])).toEqual(['widgets', 'instance', 'list']);
  });

  it('refuses an area toil has no area for, rather than listing nothing', async () => {
    const { context } = testContext({ config });
    const run = await runCli(['connections', 'list', '--area', 'nope'], { commands, context });
    expect(run.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', fix: expect.stringContaining('widgets') });
  });

  it('refuses a target that is not a core command taking an area', async () => {
    const bad = (target: string) => defineArea({ name: 'bad', description: 'test', connection: z.object({}), coreAliases: { x: target } });
    expect(() => withCoreAliases([...commands, ...demoCommands], [bad('demo get-thing')])).toThrow(/isn't a core command/);
    expect(() => withCoreAliases(commands, [bad('connections nothing')])).toThrow(/isn't a core command/);
  });
});

describe('an area command kept off MCP', () => {
  it('is never listed, even with writes on and its area named', async () => {
    const tools = selectCommands(demoCommands, ['demo'], testConfig({ demo: { token: 't', writes: true } }));
    expect(servedOverMcp(deleteThing)).toBe(false);
    expect(tools).not.toContain(deleteThing);
    expect(tools).toContain(getThing);
  });

  it('keeps its time limit, unlike a cli-only command', async () => {
    const slow = demoArea.command({
      path: ['demo', 'slow-delete'],
      description: 'test',
      input: z.object({}),
      writes: false,
      mcp: false,
      examples: [{}],
      run: (_i, ctx) => new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason))) });
    const { context } = testContext({ config: { demo: { token: 't' } } });
    const envelope = await execute(slow, {}, { ...context, timeoutMs: 20 });
    expect(envelope.error?.code).toBe('TIMEOUT');
  });

  it('accepts only false', async () => {
    const spec = { path: ['demo', 'x'] as [string, ...string[]], description: 'test', input: z.object({}), writes: false, examples: [{}], run: async () => ({}) };
    expect(() => demoArea.command({ ...spec, mcp: true } as never)).toThrow(/"mcp" is false/);
  });
});

describe('a command that handles an unconfigured area itself', () => {
  it('runs with no connection when the area has none and the call names none', async () => {
    const { context, http } = testContext();
    const envelope = await execute(thingStatus, {}, context);
    expect(envelope).toMatchObject({ ok: true, data: { configured: false } });
    expect(envelope.meta.context).toBeUndefined();
    expect(http.calls).toHaveLength(0);
  });

  it('still uses the connection when there is one, and still fails on a bad one or a named one that is missing', async () => {
    const configured = await execute(thingStatus, {}, testContext({ config: { demo: { token: 't' } }, routes: demoRoutes }).context);
    expect(configured).toMatchObject({ ok: true, data: { configured: true, id: 'THING-0' } });
    expect((await execute(thingStatus, { connection: 'other' }, testContext().context)).error?.code).toBe('INVALID_INPUT');
    // A key set to something wrong is still a failure; only an unset one is the command's to answer (below).
    expect((await execute(thingStatus, {}, testContext({ config: { demo: { token: 't', pageSize: -1 } } }).context)).error?.code).toBe('CONFIG_INVALID');
  });

  it('also answers for a default connection that is only missing a key, with a warning naming it', async () => {
    const { context, http } = testContext({ config: { demo: {} } });
    const envelope = await execute(thingStatus, {}, context);
    expect(envelope).toMatchObject({ ok: true, data: { configured: false } });
    expect(envelope.meta.warnings).toEqual([{ code: 'CONFIG_INCOMPLETE', message: expect.stringContaining('Connection demo (demo) is missing or has invalid token.') }]);
    expect(http.calls).toHaveLength(0);
    // Named outright, the same connection is the caller's to fix: CONFIG_INVALID, as for any named connection.
    expect((await execute(thingStatus, { connection: 'demo' }, context)).error?.code).toBe('CONFIG_INVALID');
    // And a command without connectionOptional never gets this.
    expect((await execute(getThing, { id: 'THING-1' }, context)).error?.code).toBe('CONFIG_INVALID');
  });

  it('is an MCP tool with its area unconfigured, as a command with no connection is', async () => {
    const tools = selectCommands(demoCommands, undefined, testConfig());
    expect(tools).toContain(thingStatus);
    expect(tools).not.toContain(getThing);
  });

  it('is only for a read with no required context', async () => {
    const spec = { path: ['demo', 'w'] as [string, ...string[]], description: 'test', input: z.object({}), writes: false, connectionOptional: true as const, examples: [{}], run: async () => ({}) };
    expect(() => demoArea.command({ ...spec, writes: true })).toThrow(/write always needs its connection/);
    expect(() => demoArea.command({ ...spec, kind: 'area-local' })).toThrow(/connectionOptional/);
  });
});

describe('stdin on an interactive terminal', () => {
  it('refuses "-" at once with INVALID_INPUT, and never waits', async () => {
    const files = nodeFiles({ cwd: tmpdir(), stdin: 'terminal' });
    await expect(files.readText('-')).rejects.toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringContaining('Nothing was piped in'), fix: expect.stringContaining('--input-file <path>') }));
  });

  it('is the same error through a command on the CLI', async () => {
    const read = demoArea.command({
      path: ['demo', 'read-in'],
      description: 'Read stdin',
      input: z.object({ from: z.string().optional().describe('File, or "-"') }),
      writes: false,
      options: [{ flags: '--from <file>', field: 'from', description: 'File' }],
      examples: [{ from: '-' }],
      run: async (input, ctx) => ({ text: (await ctx.files.readText(input.from ?? '-')) }),
    });
    const { context } = testContext({ config: { demo: { token: 't' } }, stdin: { terminal: true } });
    const run = await runCli(['demo', 'read-in'], { commands: [read], context });
    expect(run.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('Nothing was piped in') });
    expect(run.exitCode).toBe(1);
  });
});

describe("a missing connection key's fix", () => {
  const figma = defineArea({
    name: 'figlet',
    description: 'test',
    connection: z.object({ baseUrl: z.url().describe('API base URL'), token: z.string() }),
    secrets: ['token'],
    examples: { baseUrl: 'https://api.figlet.imagile.dev' },
  });
  const get = figma.command({ path: ['figlet', 'get'], description: 'test', input: z.object({}), writes: false, examples: [{}], run: async () => ({}) });

  it('names the example value the area declares, when no connection is set up and when the key is missing', async () => {
    const none = await execute(get, {}, testContext().context);
    expect(none.error?.fix).toContain('TOIL_FIGLET_BASE_URL (e.g. https://api.figlet.imagile.dev)');
    const missing = await execute(get, {}, testContext({ config: { figlet: { token: 't' } } }).context);
    expect(missing.error).toMatchObject({ code: 'CONFIG_INVALID', fix: expect.stringContaining('TOIL_FIGLET_BASE_URL (e.g. https://api.figlet.imagile.dev)') });
  });

  it('refuses an example for a key the connection does not have', async () => {
    expect(() => defineArea({ name: 'x', description: 'test', connection: z.object({}), examples: { nope: 'y' } as never })).toThrow(/example "nope"/);
  });
});

describe("a git reader and the call's connection", () => {
  const repos = defineArea({
    name: 'repos',
    description: 'test',
    connection: z.object({ baseUrl: z.url(), token: z.string() }),
    secrets: ['token'],
    context: {
      // Trusts only a remote on the connection's own host.
      project: { description: 'Project', git: (remote, connection) => (connection && new URL(remote.url).host === new URL(String(connection.baseUrl)).host ? remote.url.split('/')[3] : undefined) },
    },
  });
  const where = repos.command({ path: ['repos', 'where'], description: 'test', input: z.object({}), writes: false, examples: [{}], run: async (_i, ctx) => ({ project: ctx.context.project ?? null }) });
  const run = (url: string) =>
    execute(where, {}, { ...testContext({ config: { repos: { baseUrl: 'https://git.imagile.dev', token: 't' } } }).context, gitRemote: async () => [{ name: 'origin', url }] });

  it('gets the resolved connection, so a remote on another host supplies nothing', async () => {
    expect((await run('https://git.imagile.dev/PRJ/repo.git')).data).toEqual({ project: 'PRJ' });
    expect((await run('https://other.example.com/PRJ/repo.git')).data).toEqual({ project: null });
  });
});

describe('the repository on ctx', () => {
  const branch = demoArea.command({ path: ['demo', 'branch'], description: 'test', input: z.object({}), writes: false, examples: [{}], run: async (_i, ctx) => ({ repo: ctx.repo() ?? null }) });

  it('is what the context reads from .git, and undefined outside a repository', async () => {
    const repo = { root: '/work', branch: 'feature/x', remotes: ['https://bitbucket.imagile.dev/scm/PRJ/repo.git'] };
    expect((await execute(branch, {}, testContext({ config: { demo: { token: 't' } }, repo }).context)).data).toEqual({ repo });
    expect((await execute(branch, {}, testContext({ config: { demo: { token: 't' } } }).context)).data).toEqual({ repo: null });
  });
});

describe("the repository's remotes", () => {
  it('lose an http(s) userinfo, which may be a token, and keep an ssh user', async () => {
    expect(withoutHttpUserinfo('https://x-token:abc123@bitbucket.imagile.dev/scm/PRJ/repo.git')).toBe('https://bitbucket.imagile.dev/scm/PRJ/repo.git');
    expect(withoutHttpUserinfo('HTTP://abc123@ghe.imagile.dev/o/r.git')).toBe('HTTP://ghe.imagile.dev/o/r.git');
    expect(withoutHttpUserinfo('ssh://git@bitbucket.imagile.dev:7999/prj/repo.git')).toBe('ssh://git@bitbucket.imagile.dev:7999/prj/repo.git');
    expect(withoutHttpUserinfo('git@ghe.imagile.dev:o/r.git')).toBe('git@ghe.imagile.dev:o/r.git');
  });
});

describe('argv for a negated flag', () => {
  const replies = demoArea.command({
    path: ['demo', 'replies'],
    description: 'test',
    input: z.object({ withReplies: z.boolean().default(true).describe('Include replies') }),
    writes: false,
    options: [{ flags: '--no-with-replies', field: 'withReplies', description: 'Leave replies out' }],
    examples: [{ withReplies: false }],
    run: async (input) => ({ withReplies: input.withReplies }),
  });

  it('writes --no-<flag> for false and nothing for true, and the CLI reads it back', async () => {
    expect(argvFor(replies, { withReplies: false })).toEqual(['demo', 'replies', '--no-with-replies']);
    expect(argvFor(replies, { withReplies: true })).toEqual(['demo', 'replies']);
    const { context } = testContext({ config: { demo: { token: 't' } } });
    expect((await runCli(argvFor(replies, { withReplies: false }), { commands: [replies], context })).envelope?.data).toEqual({ withReplies: false });
    expect((await runCli(['demo', 'replies'], { commands: [replies], context })).envelope?.data).toEqual({ withReplies: true });
  });
});

describe('the contract check and group flags', () => {
  it('counts a group flag for a contract leaf flag of the same spelling', async () => {
    const program = new Command('toil');
    program.command('bites').option('--project <key>', '').command('get');
    const contract = { globalOptions: [], commands: [{ command: 'bites get', usage: '[options]', leaf: true, options: [{ flags: '--project <key>', description: '' }, { flags: '--gone', description: '' }] }] };
    expect(diffContract(program, contract, new Set(['bites']), new Set()).map((d) => d.id)).toEqual(['bites get --gone']);
  });
});

describe('removed contract paths', () => {
  it('are read from divergences marked removed, which may list only command paths', async () => {
    expect(removedPaths()).toEqual(expect.arrayContaining(['git credentials', 'deps connectivity']));
    const dir = mkdtempSync(join(tmpdir(), 'toil-removed-'));
    const entry = { old: 'o', toil: 't', why: 'w', principle: '1', removed: true };
    writeFileSync(join(dir, 'bites.json'), JSON.stringify({ scope: 'bites', divergences: [{ ...entry, allows: ['bites get --flag'] }] }));
    expect(() => readDivergenceFiles(dir)).toThrow(/command paths it removes/);
    writeFileSync(join(dir, 'bites.json'), JSON.stringify({ scope: 'bites', divergences: [{ ...entry, allows: ['bites get'] }] }));
    expect(removedPaths(readDivergenceFiles(dir))).toEqual(['bites get']);
  });
});

describe('articles in messages', () => {
  it('reads "an" before a vowel and "a" otherwise', async () => {
    expect(withArticle('elasticsearch')).toBe('an elasticsearch');
    expect(withArticle('jira')).toBe('a jira');
  });

  it('is what the not-configured fix says', async () => {
    const elastic = defineArea({ name: 'elastic', description: 'test', connection: z.object({ token: z.string() }), secrets: ['token'] });
    const get = elastic.command({ path: ['elastic', 'get'], description: 'test', input: z.object({}), writes: false, examples: [{}], run: async () => ({}) });
    const envelope = await execute(get, {}, testContext().context);
    expect(envelope.error?.fix).toContain('add an elastic connection');
  });
});
