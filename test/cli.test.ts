import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineCommand } from '../src/core/command.js';
import { argvFor } from '../src/program.js';
import { commands } from '../src/registry.js';
import { demoCommands, demoRoutes } from './fixtures/demo-commands.js';
import { runCli } from './harness/cli.js';
import { TEST_VERSION, testContext } from './harness/context.js';

describe('toil CLI', () => {
  it('prints one compact JSON envelope per command', async () => {
    const { context } = testContext();
    const run = await runCli(['version'], { commands, context });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim().split('\n')).toHaveLength(1);
    expect(run.envelope).toMatchObject({ ok: true, error: null, data: { version: TEST_VERSION }, meta: { command: 'version', version: TEST_VERSION } });
  });

  it('puts the unpatched-Node warning in the CLI envelope too, and still runs the command', async () => {
    const real = Object.getOwnPropertyDescriptor(process.versions, 'node')!;
    Object.defineProperty(process.versions, 'node', { ...real, value: '24.22.0' });
    try {
      const { context } = testContext();
      const run = await runCli(['version'], { commands, context });
      expect(run.exitCode).toBe(0);
      expect(run.envelope?.ok).toBe(true);
      expect(run.envelope?.meta.warnings?.[0]).toMatchObject({ code: 'UNSUPPORTED_NODE', message: expect.stringContaining('CVE-2026-111497') });
    } finally {
      Object.defineProperty(process.versions, 'node', real);
    }
  });

  it('carries the unpatched-Node warning on a failure that happens before the command runs', async () => {
    const real = Object.getOwnPropertyDescriptor(process.versions, 'node')!;
    Object.defineProperty(process.versions, 'node', { ...real, value: '24.22.0' });
    try {
      const { context } = testContext();
      const run = await runCli(['version'], {
        commands,
        context,
        createContext: () => {
          throw new Error('the config would not load');
        },
      });
      expect(run.envelope?.ok).toBe(false);
      expect(run.envelope?.meta.warnings?.[0]).toMatchObject({ code: 'UNSUPPORTED_NODE' });
    } finally {
      Object.defineProperty(process.versions, 'node', real);
    }
  });

  it('reports the build commit next to contractVersion, null when the build recorded none', async () => {
    const { context } = testContext();
    const run = await runCli(['version'], { commands, context });
    const data = run.envelope!.data as Record<string, unknown>;
    expect(Object.keys(data).slice(0, 3)).toEqual(['version', 'contractVersion', 'commit']);
    // Tests run from source, where tsup's banner never declared __TOIL_COMMIT__.
    expect(data.commit).toBeNull();
  });

  it('indents with --pretty', async () => {
    const { context } = testContext();
    const run = await runCli(['--pretty', 'version'], { commands, context });
    expect(run.stdout).toContain('\n  "ok": true');
  });

  it('writes to --output-file instead of stdout', async () => {
    const { context } = testContext();
    const run = await runCli(['--output-file', 'out.json', 'version'], { commands, context });
    expect(run.stdout).toBe('');
    expect(JSON.parse(run.files['out.json']!)).toMatchObject({ ok: true });
  });

  it('prints the bare version for -v', async () => {
    const { context } = testContext();
    const run = await runCli(['-v'], { commands, context });
    expect(run.stdout.trim()).toBe(TEST_VERSION);
    expect(run.exitCode).toBe(0);
  });

  it('answers an unknown command with an INVALID_INPUT envelope on stdout', async () => {
    const { context } = testContext();
    const run = await runCli(['nope'], { commands, context });
    expect(run.exitCode).toBe(1);
    expect(run.envelope).toMatchObject({ ok: false, data: null, error: { code: 'INVALID_INPUT', message: expect.stringContaining('nope') } });
    expect(run.stderr).toContain("unknown command 'nope'");
  });

  it('answers an unknown flag with an envelope, honouring --pretty', async () => {
    const { context } = testContext();
    const run = await runCli(['--pretty', 'version', '--bogus'], { commands, context });
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain('\n  "ok": false');
    expect(run.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', fix: expect.stringContaining('--help') });
  });

  it('answers a missing argument with an envelope written to --output-file', async () => {
    const { context } = testContext({ config: { demo: { token: 't', writes: true } } });
    const run = await runCli(['--output-file', 'err.json', 'demo', 'rename-thing'], { commands: demoCommands, context });
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe('');
    expect(JSON.parse(run.files['err.json']!)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' }, meta: { command: 'demo rename-thing' } });
  });

  it('honours --output-file=path on a usage error too', async () => {
    const { context } = testContext();
    const run = await runCli(['--output-file=err.json', 'nope'], { commands, context });
    expect(run.stdout).toBe('');
    expect(JSON.parse(run.files['err.json']!)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' }, meta: { command: 'nope' } });
  });

  it('still prints plain help, not an envelope, for --help', async () => {
    const { context } = testContext();
    const run = await runCli(['--help'], { commands, context });
    expect(run.exitCode).toBe(0);
    expect(run.envelope).toBeUndefined();
    expect(run.stdout).toContain('Usage: toil');
  });

  it("lists each resource with its actions in an area's --help", async () => {
    const { context } = testContext();
    const run = await runCli(['jira', '--help'], { commands, context });
    expect(run.stdout).toMatch(/issue\s+get, history, create, update/);
    expect(run.stdout).toMatch(/board\s+list/);
  });

  it('names every argument in order when a dash-led one is refused as a flag', async () => {
    const { context } = testContext();
    const run = await runCli(['jenkins', 'run', 'get', 'myjob', '-1x'], { commands, context });
    expect(run.envelope?.error?.fix).toBe('If -1x is an argument, put -- before the arguments, after any flags: toil jenkins run get [flags] -- <name> <number>.');
  });

  it('lists an alias-only group by what it holds', async () => {
    const { context } = testContext();
    const run = await runCli(['jenkins', '--help'], { commands, context });
    expect(run.stdout).toMatch(/instance\s+add, list, remove/);
  });

  it('returns INVALID_INPUT with a fix when a required field is missing', async () => {
    const { context, http } = testContext({ config: { demo: { token: 't' } }, routes: demoRoutes });
    const run = await runCli(['demo', 'get-thing'], { commands: demoCommands, context });
    expect(run.exitCode).toBe(1);
    expect(run.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', fix: expect.stringContaining('--help') });
    expect(http.calls).toHaveLength(0);
  });

  describe('argv to typed input', () => {
    const echo = defineCommand({
      path: ['echo'],
      description: 'echo',
      input: z.object({ n: z.number().int().optional(), tags: z.array(z.string()).optional(), name: z.string().optional() }),
      writes: false,
      options: [
        { flags: '--n <n>', field: 'n', description: 'a number' },
        { flags: '--tag <tag>', field: 'tags', description: 'repeatable' },
        { flags: '--name <name>', field: 'name', description: 'text that looks numeric' },
      ],
      examples: [{}],
      run: async (input) => input,
    });

    it('turns a numeric flag into a number and collects a repeated flag for an array field', async () => {
      const { context } = testContext();
      const run = await runCli(['echo', '--n', '50', '--tag', 'a=1', '--tag', 'b=2,3', '--name', '007'], { commands: [echo], context });
      expect(run.envelope?.data).toEqual({ n: 50, tags: ['a=1', 'b=2,3'], name: '007' });
    });

    it('leaves a non-numeric value for the schema to refuse', async () => {
      const { context } = testContext();
      const run = await runCli(['echo', '--n', 'ten'], { commands: [echo], context });
      expect(run.envelope?.error?.code).toBe('INVALID_INPUT');
    });

    it('argvFor repeats a flag per array item', () => {
      expect(argvFor(echo, { n: 5, tags: ['x', 'y'] })).toEqual(['echo', '--n', '5', '--tag', 'x', '--tag', 'y']);
    });

    // One value or several, as `jira issue get A B` takes them.
    const oneOrMany = defineCommand({
      path: ['pick'],
      description: 'pick',
      input: z.object({ id: z.union([z.number(), z.array(z.number())]) }),
      writes: false,
      options: [{ flags: '--id <id>', field: 'id', description: 'once or repeated' }],
      examples: [{ id: 1 }],
      run: async (input) => input,
    });

    it('keeps a one-or-many flag given once as one value, and collects it when repeated, each typed as the element', async () => {
      const { context } = testContext();
      expect((await runCli(['pick', '--id', '7'], { commands: [oneOrMany], context })).envelope?.data).toEqual({ id: 7 });
      expect((await runCli(['pick', '--id', '7', '--id', '8', '--id', '9'], { commands: [oneOrMany], context })).envelope?.data).toEqual({ id: [7, 8, 9] });
      expect(argvFor(oneOrMany, { id: [7, 8] })).toEqual(['pick', '--id', '7', '--id', '8']);
      expect(argvFor(oneOrMany, { id: 7 })).toEqual(['pick', '--id', '7']);
    });
  });
});
