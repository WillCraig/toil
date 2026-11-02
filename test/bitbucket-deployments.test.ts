import { describe, expect, it } from 'vitest';
import { fixture } from './fixtures/bitbucket.fixture.js';
import { runCli } from './harness/cli.js';
import { testContext } from './harness/context.js';
import { connectMcp } from './harness/mcp.js';
import { commands } from '../src/registry.js';
import { toolName } from '../src/core/command.js';
import { selectCommands } from '../src/mcp/server.js';
import { emptyConfig } from '../src/core/config.js';
import { dossierDisk } from './harness/dossiers.js';

/**
 * Bitbucket is one area for Data Center and Cloud (#495): one command tree and
 * one set of MCP tools, with the retired Cloud names refused by name. The
 * parity suite runs every example of both deployments; this is what is
 * particular to having folded them.
 */

const bitbucket = commands.filter((def) => def.path[0] === 'bitbucket');
const ctx = () => testContext({ config: fixture.config, routes: fixture.routes, files: fixture.files });

describe('one tree for both deployments', () => {
  it('has one command per path, none of them named for Cloud, and each deployment-only command beside the shared', () => {
    const paths = bitbucket.map((def) => def.path.join(' '));
    expect(new Set(paths).size).toBe(paths.length);
    expect(commands.some((def) => def.path[0] === 'bitbucket-cloud')).toBe(false);
    expect(paths).toEqual(expect.arrayContaining(['bitbucket pr list', 'bitbucket pr create-many', 'bitbucket check-dossier', 'bitbucket repo list', 'bitbucket pipeline list', 'bitbucket api']));
    expect(bitbucket.map(toolName).filter((name) => name.startsWith('bitbucket_cloud'))).toEqual([]);
  });

  it("says which deployment ran, in meta.context, and each returns its own API's shape", async () => {
    const dataCenter = await runCli(['bitbucket', 'pr', 'get', '42', '--project', 'PROJ', '--repo', 'imagile-api'], { commands, context: ctx().context });
    expect(dataCenter.envelope?.meta.context?.connection).toMatchObject({ value: 'bitbucket', deployment: 'server' });
    const cloud = await runCli(['bitbucket', 'pr', 'get', '42', '--ws', 'imagile', '--repo', 'toil', '--connection', 'bitbucket-cloud'], { commands, context: ctx().context });
    expect(cloud.envelope?.meta.context?.connection).toMatchObject({ value: 'bitbucket-cloud', deployment: 'cloud' });
    expect(dataCenter.envelope?.data).toHaveProperty('fromRef');
    expect(cloud.envelope?.data).toHaveProperty('source');
  });

  it('serves the same tool on either connection over MCP, and none called bitbucket_cloud_*', async () => {
    const t = ctx();
    const session = await connectMcp({ commands, context: t.context, areas: ['bitbucket'] });
    try {
      const tools = (await session.client.listTools()).tools.map((tool) => tool.name);
      expect(tools).toContain('bitbucket_pr_get');
      expect(tools).toContain('bitbucket_pipeline_list');
      expect(tools.filter((name) => name.startsWith('bitbucket_cloud'))).toEqual([]);
      const viaCloud = await session.call('bitbucket_pr_get', { id: 42, workspace: 'imagile', repo: 'toil', connection: 'bitbucket-cloud' });
      expect(viaCloud.envelope?.meta.context?.connection).toMatchObject({ deployment: 'cloud' });
    } finally {
      await session.close();
    }
  });
});

describe('a per-repo dossier project when the folder is none of the dossier’s repos (#540)', () => {
  const dossier = { name: 'pay', repos: [{ name: 'api', remotes: ['https://bitbucket.imagile.dev/scm/pay/api.git'] }], bitbucket: { project: { api: 'PAY' } } };

  it('is refused on Data Center, which needs the project, and only noted on Cloud, which never takes it', async () => {
    const disk = dossierDisk({ 'home/.toil/dossiers/pay.json': dossier });
    try {
      const t = ctx();
      const context = { ...t.context, dossiers: disk.catalog(t.context.config) };
      const dataCenter = await runCli(['bitbucket', 'pr', 'list', '--dossier', 'pay', '--repo', 'toil', '--connection', 'bitbucket'], { commands, context });
      expect(dataCenter.envelope?.ok).toBe(false);
      expect(dataCenter.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('sets bitbucket project per repo') });
      const cloud = await runCli(['bitbucket', 'pr', 'list', '--dossier', 'pay', '--ws', 'imagile', '--repo', 'toil', '--connection', 'bitbucket-cloud'], { commands, context });
      expect(cloud.envelope?.ok, cloud.stdout).toBe(true);
    } finally {
      disk.cleanup();
    }
  });
});

describe('where a call acts: --project is Data Center’s, --ws is Cloud’s', () => {
  it('refuses --ws on a Data Center connection and --project on a Cloud one, saying which deployment takes it, before any request', async () => {
    const t = ctx();
    const ws = await runCli(['bitbucket', 'pr', 'list', '--ws', 'imagile', '--repo', 'imagile-api'], { commands, context: t.context });
    expect(ws.envelope?.error?.code).toBe('UNSUPPORTED');
    expect(ws.envelope?.error?.message).toContain('--ws');
    expect(ws.envelope?.error?.message).toContain('Data Center');
    const project = await runCli(['bitbucket', 'pr', 'list', '--project', 'PROJ', '--repo', 'toil', '--connection', 'bitbucket-cloud'], { commands, context: t.context });
    expect(project.envelope?.error?.code).toBe('UNSUPPORTED');
    expect(project.envelope?.error?.message).toContain('--project');
    expect(project.envelope?.error?.fix).toContain('Data Center');
    expect(t.http.calls).toEqual([]);
  });

  it('each deployment asks for its own container in its own words when none is given', async () => {
    const t = ctx();
    const dataCenter = await runCli(['bitbucket', 'pr', 'list'], { commands, context: t.context });
    expect(dataCenter.envelope?.error?.message).toContain('Could not determine Bitbucket project/repo');
    const cloud = await runCli(['bitbucket', 'pr', 'list', '--connection', 'bitbucket-cloud'], { commands, context: t.context });
    expect(cloud.envelope?.error?.message).toContain('No Bitbucket Cloud workspace given');
    const noRepo = await runCli(['bitbucket', 'pr', 'list', '--ws', 'imagile', '--connection', 'bitbucket-cloud'], { commands, context: t.context });
    expect(noRepo.envelope?.error?.message).toContain('No Bitbucket Cloud repository given');
  });

  it("still reads a Data Center project and repo from the git remote on the connection's host, and never lends a remote to Cloud", async () => {
    const t = ctx();
    t.context.gitRemote = async () => [
      { name: 'origin', url: 'https://bitbucket.imagile.dev/scm/PROJ/imagile-api.git' },
      { name: 'cloud', url: 'git@bitbucket.org:imagile/toil.git' },
    ];
    const dataCenter = await runCli(['bitbucket', 'pr', 'get', '42'], { commands, context: t.context });
    expect(dataCenter.envelope?.ok, dataCenter.stdout).toBe(true);
    expect(dataCenter.envelope?.meta.context?.inputs).toMatchObject({ project: { value: 'PROJ', source: 'git' }, repo: { value: 'imagile-api', source: 'git' } });
    const cloud = await runCli(['bitbucket', 'pr', 'get', '42', '--ws', 'imagile', '--connection', 'bitbucket-cloud'], { commands, context: t.context });
    expect(cloud.envelope?.error?.message).toContain('No Bitbucket Cloud repository given');
  });

  it('takes Cloud’s project only where it means something: repo create puts the repository in a project of the workspace', async () => {
    const t = ctx();
    const run = await runCli(['bitbucket', 'repo', 'create', '--name', 'scratch', '--project', 'TOIL', '--ws', 'imagile', '--connection', 'bitbucket-cloud', '--allow-write'], { commands, context: t.context });
    expect(run.envelope?.ok, run.stdout).toBe(true);
    expect(JSON.parse(t.http.calls[0]!.body!)).toMatchObject({ project: { key: 'TOIL' } });
    expect(run.envelope?.meta.context?.inputs?.project).toEqual({ value: 'TOIL', source: 'input' });
  });

  it('never fills Cloud’s project from a Data Center default, the connection’s own project setting or the environment: only the call or a dossier', async () => {
    const t = ctx();
    t.context.config.defaults.bitbucket = { connection: 'bitbucket', project: 'PAY' };
    t.context.config.connections['bitbucket-cloud'] = { ...t.context.config.connections['bitbucket-cloud']!, project: 'PAY' };
    const run = await runCli(['bitbucket', 'repo', 'create', '--name', 'scratch', '--ws', 'imagile', '--connection', 'bitbucket-cloud', '--allow-write'], { commands, context: t.context });
    expect(run.envelope?.ok, run.stdout).toBe(true);
    expect(JSON.parse(t.http.calls[0]!.body!)).not.toHaveProperty('project');
    expect(run.envelope?.meta.context?.inputs).not.toHaveProperty('project');
    const given = await runCli(['bitbucket', 'repo', 'create', '--name', 'scratch', '--project', 'TOIL', '--ws', 'imagile', '--connection', 'bitbucket-cloud', '--allow-write'], { commands, context: t.context });
    expect(given.envelope?.meta.context?.inputs?.project).toEqual({ value: 'TOIL', source: 'input' });
    expect(JSON.parse(t.http.calls[1]!.body!)).toMatchObject({ project: { key: 'TOIL' } });
  });

  it('still resolves Data Center’s project from the connection and the defaults', async () => {
    const t = ctx();
    t.context.config.connections.bitbucket = { ...t.context.config.connections.bitbucket!, project: 'PAY' };
    const create = await runCli(['bitbucket', 'repo', 'create', '--name', 'scratch', '--allow-write'], { commands, context: t.context });
    expect(create.envelope?.meta.context?.inputs?.project).toEqual({ value: 'PAY', source: 'connection' });
    const list = await runCli(['bitbucket', 'pr', 'list', '--repo', 'imagile-api'], { commands, context: t.context });
    expect(list.envelope?.meta.context?.inputs?.project).toEqual({ value: 'PAY', source: 'connection' });
    delete t.context.config.connections.bitbucket!.project;
    t.context.config.defaults.bitbucket = { connection: 'bitbucket', project: 'DEF' };
    const viaDefault = await runCli(['bitbucket', 'pr', 'list', '--repo', 'imagile-api'], { commands, context: t.context });
    expect(viaDefault.envelope?.meta.context?.inputs?.project?.value).toBe('DEF');
  });
});

describe('what only one deployment has', () => {
  it('refuses a command the other deployment lacks, naming both deployments and the connection that can run it', async () => {
    const t = ctx();
    const repoList = await runCli(['bitbucket', 'repo', 'list', '--ws', 'imagile'], { commands, context: t.context });
    expect(repoList.envelope?.error).toMatchObject({ code: 'UNSUPPORTED' });
    expect(repoList.envelope?.error?.message).toContain('Data Center');
    expect(repoList.envelope?.error?.fix).toContain('bitbucket-cloud');
    const createMany = await runCli(['bitbucket', 'pr', 'create-many', '--from', 'a', '--to', 'b', '--repos', 'x', '--project', 'PROJ', '--connection', 'bitbucket-cloud', '--allow-write'], { commands, context: t.context });
    expect(createMany.envelope?.error?.code).toBe('UNSUPPORTED');
    expect(t.http.calls).toEqual([]);
  });

  it('pr needs-work and its alias pr request-changes are one command, on either deployment', async () => {
    const t = ctx();
    const dataCenter = await runCli(['bitbucket', 'pr', 'request-changes', '42', '--project', 'PROJ', '--repo', 'imagile-api', '--allow-write'], { commands, context: t.context });
    expect(dataCenter.envelope?.meta.command).toBe('bitbucket pr needs-work');
    expect(dataCenter.envelope?.ok, dataCenter.stdout).toBe(true);
    const cloud = await runCli(['bitbucket', 'pr', 'needs-work', '42', '--ws', 'imagile', '--repo', 'toil', '--connection', 'bitbucket-cloud', '--allow-write'], { commands, context: t.context });
    expect(cloud.envelope?.ok, cloud.stdout).toBe(true);
    expect(t.http.calls.some((call) => call.url.endsWith('/pullrequests/42/request-changes'))).toBe(true);
  });

  it('pr diff needs its id on Data Center, and takes --spec instead on Cloud', async () => {
    const t = ctx();
    const dataCenter = await runCli(['bitbucket', 'pr', 'diff', '--project', 'PROJ', '--repo', 'imagile-api'], { commands, context: t.context });
    expect(dataCenter.envelope?.error?.code).toBe('INVALID_INPUT');
    expect(dataCenter.envelope?.error?.message).toContain('id');
    expect(t.http.calls).toEqual([]);
    const cloud = await runCli(['bitbucket', 'pr', 'diff', '--spec', 'abc12345def67890abc12345def67890abc12345', '--ws', 'imagile', '--repo', 'toil', '--connection', 'bitbucket-cloud'], { commands, context: t.context });
    expect(cloud.envelope?.ok, cloud.stdout).toBe(true);
  });

  it('git current-pr still answers for pr current', async () => {
    const run = await runCli(['git', 'current-pr'], { commands, context: testContext().context });
    expect(run.envelope?.meta.command).toBe('bitbucket pr current');
  });
});

describe('the retired Bitbucket Cloud names fail with the new form', () => {
  it('toil bitbucket-cloud … is INVALID_INPUT naming toil bitbucket and the deployment', async () => {
    const run = await runCli(['bitbucket-cloud', 'pr', 'get', '1'], { commands, context: testContext().context });
    expect(run.exitCode).toBe(1);
    expect(run.envelope).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: 'toil bitbucket-cloud no longer exists.' } });
    expect(run.envelope?.error?.fix).toContain('TOIL_BITBUCKET_DEPLOYMENT=cloud');
    expect(run.envelope?.error?.fix).toContain('toil bitbucket');
  });

  it('an MCP call to a bitbucket_cloud_* tool is an unknown tool whose message says where it went', async () => {
    const session = await connectMcp({ commands, context: ctx().context, areas: ['bitbucket'] });
    try {
      await expect(session.call('bitbucket_cloud_pr_get', { id: 1 })).rejects.toThrow(/Unknown tool: bitbucket_cloud_pr_get.*bitbucket-cloud is now bitbucket.*TOIL_BITBUCKET_DEPLOYMENT=cloud/);
    } finally {
      await session.close();
    }
  });

  it('the retired request-changes tool, and the natural retry under bitbucket, both name bitbucket_pr_needs_work', async () => {
    const session = await connectMcp({ commands, context: ctx().context, areas: ['bitbucket'] });
    try {
      await expect(session.call('bitbucket_cloud_pr_request_changes', { id: 1 })).rejects.toThrow(/Unknown tool: bitbucket_cloud_pr_request_changes.*bitbucket-cloud is now bitbucket.* Use bitbucket_pr_needs_work./);
      await expect(session.call('bitbucket_pr_request_changes', { id: 1 })).rejects.toThrow(/Unknown tool: bitbucket_pr_request_changes. Use bitbucket_pr_needs_work./);
    } finally {
      await session.close();
    }
  });

  it('a Cloud connection that forgot deployment is told to set it, not only to supply a pat', async () => {
    const config = { bitbucket: { area: 'bitbucket', baseUrl: 'https://bitbucket.imagile.dev', accessToken: 'abc12345', workspace: 'imagile' } };
    const run = await runCli(['bitbucket', 'pr', 'list', '--project', 'PROJ', '--repo', 'toil'], { commands, context: testContext({ config }).context });
    expect(run.envelope?.error?.message).toContain('missing or has invalid pat');
    expect(run.envelope?.error?.fix).toContain('holds accessToken, workspace, which only Cloud connections take');
    expect(run.envelope?.error?.fix).toContain('TOIL_BITBUCKET_DEPLOYMENT=cloud');
    // A Data Center connection that is merely missing its pat gets no such hint.
    const plain = await runCli(['bitbucket', 'pr', 'list', '--project', 'PROJ', '--repo', 'toil'], { commands, context: testContext({ config: { bitbucket: { area: 'bitbucket', baseUrl: 'https://bitbucket.imagile.dev' } } }).context });
    expect(plain.envelope?.error?.fix).not.toContain('only Cloud');
  });

  it('--areas bitbucket-cloud is INVALID_INPUT, not an unknown area', () => {
    expect(() => selectCommands(commands, ['bitbucket-cloud'], emptyConfig())).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringContaining('bitbucket-cloud'), fix: expect.stringContaining('--areas bitbucket') }),
    );
  });
});
