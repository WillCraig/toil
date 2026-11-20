import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EXAMPLE_TOKEN } from '../src/areas/util/jwt.js';
import { defineCommand } from '../src/core/command.js';
import { allowWriteField } from '../src/core/run.js';
import { argvFor } from '../src/program.js';
import { commands } from '../src/registry.js';
import { demoArea, demoCommands, demoRoutes } from './fixtures/demo-commands.js';
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

  // Fork issue #3: commander quotes what was typed in its "too many
  // arguments" list and in an unknown `--flag=value`, so a credential passed
  // as an argument (a JWT for `util jwt decode`) was repeated in the envelope
  // and on stderr. Neither stream may carry the token or its signature.
  it('keeps argument values out of a too-many-arguments usage error, on stdout and stderr', async () => {
    const { context } = testContext();
    const signature = EXAMPLE_TOKEN.split('.')[2]!;
    const run = await runCli(['util', 'jwt', 'decode', EXAMPLE_TOKEN, 'extra'], { commands, context });
    expect(run.exitCode).toBe(1);
    expect(run.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('Too many arguments') });
    expect(run.stdout + run.stderr).not.toContain(EXAMPLE_TOKEN);
    expect(run.stdout + run.stderr).not.toContain(signature);
  });

  it('keeps the value of an unknown --flag=<value> out of its usage error, on stdout and stderr', async () => {
    const { context } = testContext();
    const signature = EXAMPLE_TOKEN.split('.')[2]!;
    const run = await runCli(['util', 'jwt', 'decode', `--token=${EXAMPLE_TOKEN}`], { commands, context });
    expect(run.exitCode).toBe(1);
    expect(run.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: "Unknown option '--token'" });
    expect(run.stdout + run.stderr).not.toContain(EXAMPLE_TOKEN);
    expect(run.stdout + run.stderr).not.toContain(signature);
  });

  it('keeps argument values out of a toil wait parse error, its fix included', async () => {
    const { context } = testContext();
    const signature = EXAMPLE_TOKEN.split('.')[2]!;
    const run = await runCli(['wait', '--until', 'x', '--', 'util', 'jwt', 'decode', EXAMPLE_TOKEN, 'extra'], { commands, context });
    expect(run.exitCode).toBe(1);
    expect(run.envelope?.error?.code).toBe('INVALID_INPUT');
    expect(run.stdout + run.stderr).not.toContain(EXAMPLE_TOKEN);
    expect(run.stdout + run.stderr).not.toContain(signature);
  });

  it('answers a missing argument with an envelope written to --output-file', async () => {
    const { context } = testContext({ config: { demo: { token: 't', writes: true } } });
    const run = await runCli(['--output-file', 'err.json', 'demo', 'rename-thing'], { commands: demoCommands, context });
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe('');
    expect(JSON.parse(run.files['err.json']!)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' }, meta: { command: 'demo rename-thing' } });
  });

  it('prints a failure envelope, never nothing, when the result is too deeply nested to print as JSON', async () => {
    // A placeholder token whose payload nests far past the CLI stringify
    // cliff (depth 5,000 prints, 6,000 overflowed the action stack on the
    // main this was written against): data this deep reaches emit() from
    // any command, and printing it must not lose the envelope.
    const depth = 20_000;
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(`{"a":${'['.repeat(depth)}1${']'.repeat(depth)}}`).toString('base64url');
    const token = `${header}.${payload}.c2lnbmF0dXJlLW5vdC1jaGVja2Vk`;
    const { context } = testContext();
    for (const argv of [['util', 'jwt', 'decode', token], ['--pretty', 'util', 'jwt', 'decode', token], ['--output-file', 'deep.json', 'util', 'jwt', 'decode', token]]) {
      const run = await runCli(argv, { commands, context });
      expect(run.exitCode, argv.slice(0, 2).join(' ')).toBe(1);
      expect(run.envelope, argv.slice(0, 2).join(' ')).toMatchObject({
        ok: false,
        data: null,
        error: { code: 'INTERNAL', message: expect.stringContaining("couldn't be printed as JSON"), fix: expect.stringContaining('--select') },
        meta: { command: 'util jwt decode' },
      });
      expect(run.stderr).not.toContain('Maximum call stack size exceeded');
      expect(run.files['deep.json']).toBeUndefined();
    }
    const compact = await runCli(['util', 'jwt', 'decode', token], { commands, context });
    expect(compact.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('prints a failure envelope when the result is circular, and says a write may already have been applied', async () => {
    const circular = () => {
      const value: Record<string, unknown> = { name: 'loop' };
      value['self'] = value;
      return value;
    };
    const readCircular = defineCommand({ path: ['read-circular'], description: 'read returning a circular result', input: z.object({}), writes: false, examples: [{}], run: async () => circular() });
    const writeCircular = demoArea.command({ path: ['demo', 'write-circular'], description: 'write returning a circular result', input: z.object({ ...allowWriteField }), writes: true, examples: [{ allowWrite: true }], run: async () => circular() });
    const { context } = testContext();
    const read = await runCli(['read-circular'], { commands: [readCircular], context });
    expect(read.exitCode).toBe(1);
    expect(read.envelope).toMatchObject({ ok: false, data: null, error: { code: 'INTERNAL', message: expect.stringContaining("couldn't be printed as JSON") } });
    expect(read.stdout.trim().split('\n')).toHaveLength(1);
    const write = await runCli(['demo', 'write-circular', '--allow-write'], { commands: [writeCircular], context: testContext({ config: { demo: { token: 't', writes: true } }, routes: demoRoutes }).context });
    expect(write.exitCode).toBe(1);
    expect(write.envelope).toMatchObject({
      ok: false,
      data: null,
      error: { code: 'INTERNAL', message: expect.stringContaining('may already have been applied'), fix: expect.stringContaining('Check whether the change was made before retrying') },
    });
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
