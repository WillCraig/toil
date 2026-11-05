import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { testContext } from '../../test/harness/context.js';
import { defineArea } from './area.js';
import type { AnyCommand } from './command.js';
import { allowWriteField, execute } from './run.js';

/**
 * area.byDeployment(): one command per path from an implementation per deployment.
 * The widget area has a Data Center and a Cloud, as jira does, small enough
 * to see every rule: the union input, the dispatch, the refusals, and the
 * ways a definition can be inconsistent.
 */

const widget = defineArea({
  name: 'widget',
  description: 'test',
  connection: z.object({ baseUrl: z.url(), deployment: z.enum(['server', 'cloud']).default('server') }),
  defaults: { deployment: 'server' },
  variants: { by: 'deployment', of: { server: { label: 'Data Center' }, cloud: { label: 'Cloud' } } },
});

const get = (deployment: string, extra: Record<string, z.ZodType> = {}, description = 'Get a widget') =>
  widget.command({
    path: ['widget', 'get'],
    description,
    input: z.object({ id: z.string().describe('The id'), ...extra }),
    writes: false,
    args: [{ name: 'id', field: 'id', description: 'The id', required: true }],
    options: Object.entries(extra).map(([field, schema]) => ({ flags: `--${field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} <value>`, field, description: schema.description ?? field })),
    examples: [{ id: '1' }],
    run: async (input, ctx) => ({ ran: deployment, input, connection: ctx.connection!.name }),
  });

const connection = (name: string, deployment: string) => ({ [name]: { area: 'widget', baseUrl: `https://${name}.imagile.dev`, deployment, writes: true } });
const config = { ...connection('widget', 'server'), ...connection('widget-cloud', 'cloud') };
const run = (def: AnyCommand, input: Record<string, unknown>, via: 'cli' | 'mcp' = 'cli', cfg: Record<string, Record<string, unknown>> = config) => execute(def, input, testContext({ config: cfg }).context, via);

describe('area.byDeployment', () => {
  const [both] = widget.byDeployment({
    server: [get('server', { startAt: z.number().optional().describe('Offset') })],
    cloud: [get('cloud', { cursor: z.string().optional().describe('Cursor') })],
  });

  it('registers one command with the union of both inputs, every example tagged with its deployment', () => {
    expect(Object.keys(both!.input.shape)).toEqual(expect.arrayContaining(['id', 'startAt', 'cursor', 'connection']));
    expect(both!.input.shape.startAt!.description).toBe('Offset [Data Center only]');
    expect(both!.input.shape.cursor!.description).toBe('Cursor [Cloud only]');
    expect(both!.examples).toHaveLength(2);
    expect(both!.exampleDeployments).toEqual(['server', 'cloud']);
    expect(both!.options!.map((o) => o.field)).toEqual(expect.arrayContaining(['startAt', 'cursor']));
  });

  it("runs the implementation of the resolved connection's deployment, and says which in meta.context", async () => {
    const server = await run(both!, { id: '1' });
    expect(server.data).toMatchObject({ ran: 'server', connection: 'widget' });
    expect(server.meta.context?.connection).toMatchObject({ value: 'widget', source: 'default', deployment: 'server' });
    const cloud = await run(both!, { id: '1', connection: 'widget-cloud' });
    expect(cloud.data).toMatchObject({ ran: 'cloud', connection: 'widget-cloud' });
    expect(cloud.meta.context?.connection).toMatchObject({ value: 'widget-cloud', deployment: 'cloud' });
  });

  it('refuses a flag only the other deployment takes before running, naming the flag on the CLI and the field over MCP', async () => {
    const cli = await run(both!, { id: '1', startAt: 5, connection: 'widget-cloud' });
    expect(cli.error).toMatchObject({ code: 'UNSUPPORTED', message: expect.stringContaining('--start-at isn\'t available on Cloud connections') });
    expect(cli.error?.fix).toContain('--connection widget');
    const mcp = await run(both!, { id: '1', startAt: 5, connection: 'widget-cloud' }, 'mcp');
    expect(mcp.error?.message).toContain('startAt isn\'t available on Cloud connections');
    expect(cli.data).toBeNull();
    // The same field on its own deployment runs.
    expect((await run(both!, { id: '1', startAt: 5 })).data).toMatchObject({ ran: 'server' });
  });

  it("refuses a command the deployment has none of, naming the connections that can", async () => {
    const [onlyServer] = widget.byDeployment({ server: [get('server')] });
    const refused = await run(onlyServer!, { id: '1', connection: 'widget-cloud' });
    expect(refused.error).toMatchObject({ code: 'UNSUPPORTED', message: 'widget get isn\'t available on Cloud connections, and connection widget-cloud is one. It works on Data Center.', fix: 'Use a Data Center connection (--connection widget).' });
  });

  it('refuses before the write gate, so a missing command is not reported as a missing opt-in', async () => {
    const write = widget.command({ path: ['widget', 'make'], description: 'Make', input: z.object({ ...allowWriteField }), writes: true, examples: [{ allowWrite: true }], run: async () => 'made' });
    const [onlyServer] = widget.byDeployment({ server: [write] });
    const off = { widget: { area: 'widget', baseUrl: 'https://widget.imagile.dev' }, 'widget-cloud': { area: 'widget', baseUrl: 'https://c.imagile.dev', deployment: 'cloud' } };
    expect((await run(onlyServer!, { connection: 'widget-cloud' }, 'cli', off)).error?.code).toBe('UNSUPPORTED');
    expect((await run(onlyServer!, { allowWrite: true }, 'cli', off)).error?.code).toBe('WRITE_DISABLED');
  });

  it("holds each deployment to its own input schema: a stricter field is checked for its calls only", async () => {
    const [strict] = widget.byDeployment({
      server: [get('server', { limit: z.union([z.number(), z.string()]).optional() })],
      cloud: [get('cloud', { limit: z.number().int().positive().optional() })],
    });
    expect((await run(strict!, { id: '1', limit: '5x' })).data).toMatchObject({ ran: 'server' });
    expect((await run(strict!, { id: '1', limit: '5', connection: 'widget-cloud' })).data).toMatchObject({ ran: 'cloud', input: { limit: 5 } });
    const bad = await run(strict!, { id: '1', limit: '5x', connection: 'widget-cloud' });
    expect(bad.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('Invalid input for widget get') });
  });

  it('makes a field optional in the union when one deployment does not require it, and the one that does still requires it', async () => {
    const needs = (deployment: string, field: z.ZodType) => widget.command({ path: ['widget', 'log'], description: 'Log', input: z.object({ at: field }), writes: false, examples: [{ at: 'now' }], run: async () => deployment });
    const [log] = widget.byDeployment({ server: [needs('server', z.string().optional())], cloud: [needs('cloud', z.string())] }, { overrides: {} });
    expect((await run(log!, {})).data).toBe('server');
    expect((await run(log!, { connection: 'widget-cloud' })).error?.code).toBe('INVALID_INPUT');
  });
});

describe('area.byDeployment definition checks', () => {
  const two = (server: AnyCommand, cloud: AnyCommand) => () => widget.byDeployment({ server: [server], cloud: [cloud] });

  it('throws when the deployments disagree about writing, or describe a command or a field differently without saying how', () => {
    const w = widget.command({ path: ['widget', 'get'], description: 'Get a widget', input: z.object({ ...allowWriteField }), writes: true, examples: [{ allowWrite: true }], run: async () => 1 });
    expect(two(get('server'), w)).toThrow(/writes is true for Cloud but false for Data Center/);
    expect(two(get('server'), get('cloud', {}, 'Get a Cloud widget'))).toThrow(/description differs/);
    const described = (text: string) => widget.command({ path: ['widget', 'get'], description: 'Get', input: z.object({ id: z.string().describe(text) }), writes: false, examples: [{ id: '1' }], run: async () => 1 });
    expect(two(described('Id'), described('Account id'))).toThrow(/field id is described differently/);
    expect(() => widget.byDeployment({ server: [described('Id')], cloud: [described('Account id')] }, { overrides: { 'widget get': { describe: { id: 'Id (an account id on Cloud)' } } } })).not.toThrow();
  });

  it('throws for a command with no connection, which has nothing to route by', () => {
    const local = widget.command({ path: ['widget', 'schema'], kind: 'area-local', description: 'Schema', input: z.object({}), writes: false, examples: [{}], run: async () => 1 });
    expect(() => widget.byDeployment({ server: [local] })).toThrow(/kind area-local/);
  });

  it('throws for a deployment the area has no variant for, and for an area with no variants', () => {
    expect(() => widget.byDeployment({ edge: [get('edge')] })).toThrow(/deployment "edge"/);
    const plain = defineArea({ name: 'plain', description: 'test', connection: z.object({}) });
    expect(() => plain.byDeployment({ server: [] })).toThrow(/declare variants/);
  });
});

/**
 * Context inputs by deployment (#495, Bitbucket): the gadget area has a Data Center
 * and a Cloud that take different inputs. `project` is Data Center's, `workspace`
 * is Cloud's, and `repo` is both's but worded differently when missing.
 */
describe('context inputs that only some deployments take', () => {
  const gadget = defineArea({
    name: 'gadget',
    description: 'test',
    connection: z.object({ baseUrl: z.url(), deployment: z.enum(['server', 'cloud']).default('server'), project: z.string().optional(), workspace: z.string().optional(), repo: z.string().optional() }),
    defaults: { deployment: 'server' },
    variants: { by: 'deployment', of: { server: { label: 'Data Center' }, cloud: { label: 'Cloud' } } },
    context: {
      project: { description: 'Project', flags: '--project <key>', setting: 'project', deployments: ['server'], schema: z.string().min(1) },
      workspace: { description: 'Workspace', flags: '--ws <slug>', setting: 'workspace', deployments: ['cloud'], schema: z.string().min(1) },
      repo: {
        description: 'Repository',
        flags: '--repo <slug>',
        setting: 'repo',
        missing: (connection) => ({ message: connection.deployment === 'cloud' ? 'No Cloud repository given.' : 'No Data Center repository given.' }),
        schema: z.string().min(1),
      },
    },
  });
  const ran: string[] = [];
  const command = (deployment: string, path: string, context: Record<string, 'optional' | 'required'>) =>
    gadget.command({
      path: ['gadget', path],
      description: `Run ${path}`,
      input: z.object({}),
      writes: false,
      context,
      examples: [{}],
      run: async (_input, ctx) => (ran.push(`${deployment} ${path}`), { deployment, context: ctx.context }),
    });
  const read = gadget.byDeployment({ server: [command('server', 'read', { project: 'required', repo: 'required' })], cloud: [command('cloud', 'read', { workspace: 'required', repo: 'required' })] })[0]!;
  // Cloud lists --project itself on this command (Bitbucket's repo create), so it takes it although the area gives it to Data Center.
  const make = gadget.byDeployment({ server: [command('server', 'make', { project: 'required' })], cloud: [command('cloud', 'make', { workspace: 'required', project: 'optional' })] })[0]!;
  const cfg = {
    gadget: { area: 'gadget', baseUrl: 'https://gadget.imagile.dev', deployment: 'server', writes: true },
    'gadget-cloud': { area: 'gadget', baseUrl: 'https://gadget-cloud.imagile.dev', deployment: 'cloud', writes: true },
  };
  const go = (def: AnyCommand, input: Record<string, unknown>, via: 'cli' | 'mcp' = 'cli') => execute(def, input, testContext({ config: cfg }).context, via);

  it("refuses an input the connection's deployment never takes, before any request or any run", async () => {
    const onCloud = await go(read, { connection: 'gadget-cloud', workspace: 'w', project: 'P', repo: 'r' });
    expect(onCloud.error).toMatchObject({ code: 'UNSUPPORTED', message: expect.stringContaining('--project') });
    const onServer = await go(read, { workspace: 'w', project: 'P', repo: 'r' }, 'mcp');
    expect(onServer.error).toMatchObject({ code: 'UNSUPPORTED', message: expect.stringContaining('workspace') });
    expect(ran).toEqual([]);
  });

  it("requires only the inputs of the connection's own deployment, and words each missing one for it", async () => {
    expect((await go(read, { project: 'P' })).error?.message).toContain('No Data Center repository given.');
    expect((await go(read, { connection: 'gadget-cloud', workspace: 'w' })).error?.message).toContain('No Cloud repository given.');
    // Cloud isn't asked for the project Data Center needs; Data Center isn't asked for the workspace.
    expect((await go(read, { connection: 'gadget-cloud', workspace: 'w', repo: 'r' })).data).toMatchObject({ deployment: 'cloud' });
    expect((await go(read, { project: 'P', repo: 'r' })).data).toMatchObject({ deployment: 'server' });
  });

  it("takes an input on any deployment when the command lists it in its own context", async () => {
    const made = await go(make, { connection: 'gadget-cloud', workspace: 'w', project: 'P' });
    expect(made.error).toBeNull();
    expect(made.data).toMatchObject({ deployment: 'cloud' });
    expect(ran).toContain('cloud make');
  });

  it('resolves an input a deployment takes only because its command lists it from the call or the toil project alone, never from the other deployment’s settings', async () => {
    const withSettings = { ...cfg, 'gadget-cloud': { ...cfg['gadget-cloud'], project: 'SET' } };
    const t = testContext({ config: withSettings });
    t.context.config.defaults.gadget = { connection: 'gadget', project: 'DEF' };
    const cloud = await execute(make, { connection: 'gadget-cloud', workspace: 'w' }, t.context, 'cli');
    expect(cloud.error).toBeNull();
    expect(cloud.data).toMatchObject({ deployment: 'cloud', context: { workspace: 'w' } });
    expect(cloud.meta.context?.inputs).not.toHaveProperty('project');
    const given = await execute(make, { connection: 'gadget-cloud', workspace: 'w', project: 'P' }, t.context, 'cli');
    expect(given.meta.context?.inputs?.project).toEqual({ value: 'P', source: 'input' });
    // Its own deployment still reads the setting.
    const server = await execute(make, {}, t.context, 'cli');
    expect(server.meta.context?.inputs?.project).toEqual({ value: 'DEF', source: 'connection' });
  });

  it("throws at definition time for a context input that names a deployment the area has no variant for", () => {
    expect(() =>
      defineArea({
        name: 'gizmo',
        description: 'test',
        connection: z.object({ deployment: z.enum(['server', 'cloud']).default('server') }),
        variants: { by: 'deployment', of: { server: {}, cloud: {} } },
        context: { project: { description: 'P', flags: '--project <key>', deployments: ['edge'], schema: z.string() } },
      }),
    ).toThrow(/deployment "edge"/);
  });
});
