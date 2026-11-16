import { describe, expect, it } from 'vitest';
import { ADO, fixture } from './fixtures/ado.fixture.js';
import { HOST } from './fixtures/ado-cloud-data.js';
import { runCli } from './harness/cli.js';
import { testContext } from './harness/context.js';
import { connectMcp } from './harness/mcp.js';
import { commands } from '../src/registry.js';
import { toolName } from '../src/core/command.js';
import { selectCommands } from '../src/mcp/server.js';
import { emptyConfig } from '../src/core/config.js';

/**
 * Azure DevOps is one area for Server and Services (#495): one command tree and
 * one set of MCP tools, with the retired Services names refused by name. The
 * parity suite runs every example of both deployments; this is what is
 * particular to having folded them.
 */

const ado = commands.filter((def) => def.path[0] === 'ado');
const ctx = (extra: Parameters<typeof testContext>[0] = {}) => testContext({ config: fixture.config, routes: fixture.routes, files: fixture.files, ...extra });
const run = (argv: string[], extra: Parameters<typeof testContext>[0] = {}) => runCli(argv, { commands, context: ctx(extra).context });

describe('one tree for both deployments', () => {
  it('has one command per path, none of them named for Services, and each deployment-only command beside the shared ones', () => {
    const paths = ado.map((def) => def.path.join(' '));
    expect(new Set(paths).size).toBe(paths.length);
    expect(commands.some((def) => def.path[0] === 'ado-cloud')).toBe(false);
    expect(paths).toEqual(expect.arrayContaining(['ado work-item get', 'ado pipeline list', 'ado sprint list', 'ado board get', 'ado api', 'ado work-item schema']));
    expect(ado.map(toolName).filter((name) => name.startsWith('ado_cloud'))).toEqual([]);
  });

  it('says which deployment ran, in meta.context, for each connection, each returning its own API shape', async () => {
    const server = await run(['ado', '--collection', 'DefaultCollection', '--project', 'Imagile', 'work-item', 'get', '42']);
    expect(server.envelope?.meta.context?.connection).toMatchObject({ value: 'ado', deployment: 'server' });
    const services = await run(['ado', '--project', 'Imagile', 'work-item', 'get', '42', '--connection', 'ado-cloud']);
    expect(services.envelope?.meta.context?.connection).toMatchObject({ value: 'ado-cloud', deployment: 'cloud' });
    expect(services.envelope?.ok).toBe(true);
  });

  it('prints the Server input file schema with no connection at all', async () => {
    const schema = await run(['ado', 'work-item', 'schema'], { config: {} });
    expect(schema.envelope?.ok).toBe(true);
    expect(schema.envelope?.data).toHaveProperty('schema');
  });

  it('serves the same tool on either connection over MCP, and none called ado_cloud_*', async () => {
    const t = ctx();
    const session = await connectMcp({ commands, context: t.context, areas: ['ado'] });
    try {
      const tools = (await session.client.listTools()).tools.map((tool) => tool.name);
      expect(tools).toContain('ado_work_item_get');
      expect(tools).toContain('ado_sprint_list');
      expect(tools.filter((name) => name.startsWith('ado_cloud'))).toEqual([]);
      const viaServices = await session.call('ado_work_item_get', { id: 42, connection: 'ado-cloud' });
      expect(viaServices.envelope?.meta.context?.connection).toMatchObject({ deployment: 'cloud' });
    } finally {
      await session.close();
    }
  });
});

describe('a call the connection\'s deployment can\'t serve is refused before any request', () => {
  it('a Services-only command on a Server connection, and a Server-only one on a Services connection, name the deployment and the connections that can run it', async () => {
    const t = ctx();
    const sprint = await runCli(['ado', '--project', 'Imagile', 'sprint', 'list'], { commands, context: t.context });
    expect(sprint.envelope).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED', message: expect.stringContaining('Server connections') } });
    expect(sprint.envelope?.error?.fix).toContain('--connection ado-cloud');
    const pipeline = await runCli(['ado', 'pipeline', 'list', '--connection', 'ado-cloud'], { commands, context: t.context });
    expect(pipeline.envelope).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED', message: expect.stringContaining('Services connections') } });
    expect(pipeline.envelope?.error?.fix).toContain('--connection ado');
    expect(t.http.calls).toEqual([]);
  });

  it('--collection and --organization are Server flags: a Services connection refuses them, and --parent, --rev and --target are each one deployment\'s', async () => {
    const t = ctx();
    const collection = await runCli(['ado', '--collection', 'DefaultCollection', '--project', 'Imagile', 'work-item', 'get', '42', '--connection', 'ado-cloud'], { commands, context: t.context });
    expect(collection.envelope).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED', message: expect.stringContaining('--collection') } });
    const rev = await runCli(['ado', '--project', 'Imagile', 'work-item', 'update', '42', '--field', 'state=Active', '--rev', '3', '--allow-write'], { commands, context: t.context });
    expect(rev.envelope).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED', message: expect.stringContaining('--rev') } });
    const parent = await runCli(['ado', '--project', 'Imagile', 'work-item', 'create', '--type', 'Task', '--title', 'T', '--parent', '7', '--connection', 'ado-cloud', '--allow-write'], { commands, context: t.context });
    expect(parent.envelope).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED', message: expect.stringContaining('--parent') } });
    expect(t.http.calls).toEqual([]);
  });
});

describe('where a command acts, per deployment', () => {
  const remote = (url: string) => ({ gitRemote: async () => [{ name: 'origin', url }] });

  it('Server reads project and repo from a remote on its host; Services does not read the remote at all', async () => {
    const server = ctx();
    Object.assign(server.context, remote(`${ADO}/DefaultCollection/Imagile/_git/imagile-api`));
    const onServer = await runCli(['ado', 'repo', 'get'], { commands, context: server.context });
    expect(onServer.envelope?.meta.context?.inputs).toMatchObject({ project: { value: 'Imagile', source: 'git' }, repo: { value: 'imagile-api', source: 'git' } });

    const services = ctx();
    Object.assign(services.context, remote(`${HOST}/imagile/Imagile/_git/imagile-api`));
    const onServices = await runCli(['ado', 'repo', 'get', '--connection', 'ado-cloud'], { commands, context: services.context });
    expect(onServices.envelope).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: 'No Azure DevOps project given. Pass --project <name>, or set project on the connection.' } });
    expect(services.http.calls).toEqual([]);
  });

  it('Services words a missing project and repo itself, before any request, naming the flag and the setting', async () => {
    const t = ctx();
    const run1 = await runCli(['ado', 'pr', 'get', '42', '--connection', 'ado-cloud', '--project', 'Imagile'], { commands, context: t.context });
    expect(run1.envelope).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: 'No Azure DevOps repository given. Pass --repo <name>, or set repo on the connection.' } });
    expect(run1.envelope?.error?.fix).toContain('--repo <name>');
    expect(t.http.calls).toEqual([]);
  });

  it('a work item read on Services needs no project, as it never did', async () => {
    const t = ctx();
    const got = await runCli(['ado', 'work-item', 'get', '42', '--connection', 'ado-cloud'], { commands, context: t.context });
    expect(got.envelope?.ok).toBe(true);
  });
});

describe('a refused PAT on Services', () => {
  // Found live: Services answers an unaccepted PAT with a 302 to its sign-in
  // host, which read as HTTP with a fix to point baseUrl there.
  it('is AUTH with the PAT fix when Services redirects to its sign-in host, and the redirect is not followed', async () => {
    const signIn = { method: 'GET', url: /\/_apis\/projects/, respond: { status: 302, headers: { Location: 'https://spsprodcus3.vssps.visualstudio.com/_signin?realm=dev.azure.com' } } } as const;
    const t = testContext({ config: fixture.config, routes: [signIn, ...(fixture.routes ?? [])], files: fixture.files });
    const refused = await runCli(['ado', 'api', 'GET', '/_apis/projects', '--connection', 'ado-cloud'], { commands, context: t.context });
    expect(refused.envelope?.error).toMatchObject({ code: 'AUTH', fix: expect.stringContaining('personal access token on connection "ado-cloud"') });
    expect(refused.envelope?.error?.fix).not.toContain('baseUrl');
    expect(t.http.calls.map((c) => new URL(c.url).host)).toEqual(['ado-cloud.imagile.dev']);
  });
});

describe('the retired Services names fail with the new form', () => {
  it('toil ado-cloud … is INVALID_INPUT naming toil ado and the deployment', async () => {
    const result = await runCli(['ado-cloud', 'work-item', 'get', '42'], { commands, context: testContext().context });
    expect(result.exitCode).toBe(1);
    expect(result.envelope).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: 'toil ado-cloud no longer exists.' } });
    expect(result.envelope?.error?.fix).toContain('TOIL_ADO_DEPLOYMENT=cloud');
    expect(result.envelope?.error?.fix).toContain('toil ado');
  });

  it('an MCP call to an ado_cloud_* tool is an unknown tool whose message says where it went', async () => {
    const session = await connectMcp({ commands, context: ctx().context, areas: ['ado'] });
    try {
      await expect(session.call('ado_cloud_work_item_get', { id: 42 })).rejects.toThrow(/Unknown tool: ado_cloud_work_item_get.*ado-cloud is now ado.*TOIL_ADO_DEPLOYMENT=cloud/);
    } finally {
      await session.close();
    }
  });

  it('--areas ado-cloud is INVALID_INPUT, not an unknown area', () => {
    expect(() => selectCommands(commands, ['ado-cloud'], emptyConfig())).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringContaining('ado-cloud'), fix: expect.stringContaining('--areas ado') }),
    );
  });
});
