import { describe, expect, it } from 'vitest';
import { fixture } from './fixtures/jira.fixture.js';
import { runCli } from './harness/cli.js';
import { testContext } from './harness/context.js';
import { connectMcp } from './harness/mcp.js';
import { commands } from '../src/registry.js';
import { toolName } from '../src/core/command.js';
import { selectCommands } from '../src/mcp/server.js';
import { emptyConfig } from '../src/core/config.js';

/**
 * Jira is one area for Data Center and Cloud (#495): one command tree and one
 * set of MCP tools, with the retired Cloud names refused by name. The parity
 * suite runs every example of both deployments; this is what is particular to
 * having folded them.
 */

const jira = commands.filter((def) => def.path[0] === 'jira');
const ctx = () => testContext({ config: fixture.config, routes: fixture.routes, files: fixture.files });

describe('one tree for both deployments', () => {
  it('has one command per path, none of them named for Cloud, and Cloud-only ones beside the shared', () => {
    const paths = jira.map((def) => def.path.join(' '));
    expect(new Set(paths).size).toBe(paths.length);
    expect(commands.some((def) => def.path[0] === 'jira-cloud')).toBe(false);
    expect(paths).toEqual(expect.arrayContaining(['jira issue get', 'jira api', 'jira project list', 'jira project get', 'jira user search']));
    expect(jira.map(toolName).filter((name) => name.startsWith('jira_cloud'))).toEqual([]);
  });

  it('says which deployment ran, in meta.context, for each connection', async () => {
    const dataCenter = await runCli(['jira', 'issue', 'get', 'PROJ-123'], { commands, context: ctx().context });
    expect(dataCenter.envelope?.meta.context?.connection).toMatchObject({ value: 'jira', deployment: 'server' });
    const cloud = await runCli(['jira', 'issue', 'get', 'PROJ-123', '--connection', 'jira-cloud'], { commands, context: ctx().context });
    expect(cloud.envelope?.meta.context?.connection).toMatchObject({ value: 'jira-cloud', deployment: 'cloud' });
    // Each returns its own API's shape: Cloud adds the description as text.
    expect(cloud.envelope?.data).toHaveProperty('descriptionText');
    expect(dataCenter.envelope?.data).not.toHaveProperty('descriptionText');
  });

  it('prints the input file schema of the deployment asked for, Data Center by default, with no connection', async () => {
    const none = testContext();
    const server = await runCli(['jira', 'issue', 'schema'], { commands, context: none.context });
    const cloud = await runCli(['jira', 'issue', 'schema', '--deployment', 'cloud'], { commands, context: none.context });
    expect(JSON.stringify(server.envelope?.data)).not.toContain('accountId');
    expect(JSON.stringify(cloud.envelope?.data)).toContain('accountId');
    expect(JSON.stringify(cloud.envelope?.data)).toContain('ADF');
    const bad = await runCli(['jira', 'issue', 'schema', '--deployment', 'edge'], { commands, context: none.context });
    expect(bad.envelope?.error?.code).toBe('INVALID_INPUT');
  });

  it('serves the same tool on either connection over MCP, and none called jira_cloud_*', async () => {
    const t = ctx();
    const session = await connectMcp({ commands, context: t.context, areas: ['jira'] });
    try {
      const tools = (await session.client.listTools()).tools.map((tool) => tool.name);
      expect(tools).toContain('jira_issue_get');
      expect(tools).toContain('jira_project_list');
      expect(tools.filter((name) => name.startsWith('jira_cloud'))).toEqual([]);
      const viaCloud = await session.call('jira_issue_get', { key: 'PROJ-123', connection: 'jira-cloud' });
      expect(viaCloud.envelope?.meta.context?.connection).toMatchObject({ deployment: 'cloud' });
    } finally {
      await session.close();
    }
  });
});

describe('a wrong token on Jira Cloud', () => {
  // Found live: Cloud answers a wrong email or API token as an anonymous user,
  // 200 and no projects, and says so only in X-Seraph-LoginReason.
  it('is AUTH with the API token fix, not an empty list, when Cloud answers as anonymous after a failed sign-in', async () => {
    const anonymous = { method: 'GET', url: /\/rest\/api\/3\/project\/search/, respond: { status: 200, headers: { 'X-Seraph-LoginReason': 'AUTHENTICATED_FAILED' }, json: { startAt: 0, maxResults: 50, total: 0, isLast: true, values: [] } } } as const;
    const t = testContext({ config: fixture.config, routes: [anonymous, ...(fixture.routes ?? [])], files: fixture.files });
    const run = await runCli(['jira', 'project', 'list', '--connection', 'jira-cloud'], { commands, context: t.context });
    expect(run.envelope?.data).toBeNull();
    expect(run.envelope?.error).toMatchObject({ code: 'AUTH', message: expect.stringContaining('anonymous'), fix: expect.stringContaining('API token on connection "jira-cloud"') });
  });

  it('still lists projects when Cloud signed the caller in', async () => {
    const run = await runCli(['jira', 'project', 'list', '--connection', 'jira-cloud'], { commands, context: ctx().context });
    expect(run.envelope?.ok, run.stdout).toBe(true);
  });
});

describe('the retired Jira Cloud names fail with the new form', () => {
  it('toil jira-cloud … is INVALID_INPUT naming toil jira and the deployment', async () => {
    const run = await runCli(['jira-cloud', 'issue', 'get', 'PROJ-1'], { commands, context: testContext().context });
    expect(run.exitCode).toBe(1);
    expect(run.envelope).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: 'toil jira-cloud no longer exists.' } });
    expect(run.envelope?.error?.fix).toContain('TOIL_JIRA_DEPLOYMENT=cloud');
    expect(run.envelope?.error?.fix).toContain('toil jira');
  });

  it("a typo with the old name further along isn't called the old area: only the first command word counts", async () => {
    for (const argv of [['connections', 'tset', 'jira-cloud'], ['jira', 'isue', 'get', '--connection', 'jira-cloud']]) {
      const run = await runCli(argv, { commands, context: testContext().context });
      expect(run.envelope).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(run.envelope?.error?.message).not.toContain('no longer exists');
    }
  });

  it('an MCP call to a jira_cloud_* tool is an unknown tool whose message says where it went', async () => {
    const session = await connectMcp({ commands, context: ctx().context, areas: ['jira'] });
    try {
      await expect(session.call('jira_cloud_issue_get', { key: 'PROJ-1' })).rejects.toThrow(/Unknown tool: jira_cloud_issue_get.*jira-cloud is now jira.*TOIL_JIRA_DEPLOYMENT=cloud/);
      await expect(session.call('nothing_here', {})).rejects.toThrow(/Unknown tool: nothing_here$/);
    } finally {
      await session.close();
    }
  });

  it('--areas jira-cloud is INVALID_INPUT, not an unknown area', () => {
    expect(() => selectCommands(commands, ['jira-cloud'], emptyConfig())).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringContaining('jira-cloud'), fix: expect.stringContaining('--areas jira') }),
    );
  });
});
