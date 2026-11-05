import { describe, expect, it } from 'vitest';
import { fixture } from './fixtures/confluence.fixture.js';
import { runCli } from './harness/cli.js';
import { testContext } from './harness/context.js';
import { connectMcp } from './harness/mcp.js';
import { commands } from '../src/registry.js';
import { toolName } from '../src/core/command.js';
import { selectCommands } from '../src/mcp/server.js';
import { emptyConfig } from '../src/core/config.js';

/**
 * Confluence is one area for Data Center and Cloud (#495): one command tree
 * and one set of MCP tools, with the retired Cloud names refused by name. The
 * parity suite runs every example of both deployments; this is what is
 * particular to having folded them.
 */

const confluence = commands.filter((def) => def.path[0] === 'confluence');
const ctx = () => testContext({ config: fixture.config, routes: fixture.routes, files: fixture.files });

describe('one tree for both deployments', () => {
  it('has one command per path, none of them named for Cloud', () => {
    const paths = confluence.map((def) => def.path.join(' '));
    expect(new Set(paths).size).toBe(paths.length);
    expect(commands.some((def) => def.path[0] === 'confluence-cloud')).toBe(false);
    expect(paths).toEqual(expect.arrayContaining(['confluence page get', 'confluence page search', 'confluence space list', 'confluence attachment download']));
    expect(confluence.map(toolName).filter((name) => name.startsWith('confluence_cloud'))).toEqual([]);
  });

  it('says which deployment ran, in meta.context, for each connection, and each returns its own API shape', async () => {
    const dataCenter = await runCli(['confluence', 'page', 'get', '12345'], { commands, context: ctx().context });
    expect(dataCenter.envelope?.meta.context?.connection).toMatchObject({ value: 'confluence', deployment: 'server' });
    const cloud = await runCli(['confluence', 'page', 'get', '12345', '--connection', 'confluence-cloud'], { commands, context: ctx().context });
    expect(cloud.envelope?.meta.context?.connection).toMatchObject({ value: 'confluence-cloud', deployment: 'cloud' });
    // Cloud adds the body as plain text.
    expect(cloud.envelope?.data).toHaveProperty('bodyText');
    expect(dataCenter.envelope?.data).not.toHaveProperty('bodyText');
  });

  it('serves the same tool on either connection over MCP, and none called confluence_cloud_*', async () => {
    const session = await connectMcp({ commands, context: ctx().context, areas: ['confluence'] });
    try {
      const tools = (await session.client.listTools()).tools.map((tool) => tool.name);
      expect(tools).toContain('confluence_page_get');
      expect(tools.filter((name) => name.startsWith('confluence_cloud'))).toEqual([]);
      const viaCloud = await session.call('confluence_page_get', { id: '12345', connection: 'confluence-cloud' });
      expect(viaCloud.envelope?.meta.context?.connection).toMatchObject({ deployment: 'cloud' });
    } finally {
      await session.close();
    }
  });
});

describe('paging: each deployment keeps the idea it pages by, and the other refuses it', () => {
  it('Data Center pages by offset and Cloud by cursor, neither taking the other', async () => {
    const offsetOnCloud = await runCli(['confluence', 'page', 'list', '--space', 'DOCS', '--limit', '2', '--offset', '1', '--connection', 'confluence-cloud'], { commands, context: ctx().context });
    expect(offsetOnCloud.envelope?.error).toMatchObject({ code: 'UNSUPPORTED', message: expect.stringContaining('--offset') });
    const cursorOnServer = await runCli(['confluence', 'page', 'list', '--space', 'DOCS', '--limit', '2', '--cursor', 'abc12345'], { commands, context: ctx().context });
    expect(cursorOnServer.envelope?.error).toMatchObject({ code: 'UNSUPPORTED', message: expect.stringContaining('--cursor') });
  });

  it('check-toil-project exists on Data Center only, and says so on Cloud before any request', async () => {
    const t = ctx();
    const run = await runCli(['confluence', 'check-toil-project', '--connection', 'confluence-cloud'], { commands, context: t.context });
    expect(run.envelope?.error).toMatchObject({ code: 'UNSUPPORTED', message: expect.stringContaining('confluence check-toil-project') });
    expect(t.http.calls).toHaveLength(0);
  });
});

describe('the retired Confluence Cloud names fail with the new form', () => {
  it('toil confluence-cloud … is INVALID_INPUT naming toil confluence and the deployment', async () => {
    const run = await runCli(['confluence-cloud', 'page', 'get', '12345'], { commands, context: testContext().context });
    expect(run.exitCode).toBe(1);
    expect(run.envelope).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: 'toil confluence-cloud no longer exists.' } });
    expect(run.envelope?.error?.fix).toContain('TOIL_CONFLUENCE_DEPLOYMENT=cloud');
    expect(run.envelope?.error?.fix).toContain('toil confluence');
  });

  it('an MCP call to a confluence_cloud_* tool is an unknown tool whose message says where it went', async () => {
    const session = await connectMcp({ commands, context: ctx().context, areas: ['confluence'] });
    try {
      await expect(session.call('confluence_cloud_page_get', { id: '1' })).rejects.toThrow(/Unknown tool: confluence_cloud_page_get.*confluence-cloud is now confluence.*TOIL_CONFLUENCE_DEPLOYMENT=cloud/);
    } finally {
      await session.close();
    }
  });

  it('--areas confluence-cloud is INVALID_INPUT, not an unknown area', () => {
    expect(() => selectCommands(commands, ['confluence-cloud'], emptyConfig())).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringContaining('confluence-cloud'), fix: expect.stringContaining('--areas confluence') }),
    );
  });
});
