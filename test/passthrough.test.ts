import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { commands as jiraCommands } from '../src/areas/jira/index.js';
import { commandName } from '../src/core/command.js';
import { z } from 'zod';
import { defineArea } from '../src/core/area.js';
import { apiCommand, MAX_TEXT_BYTES } from '../src/core/passthrough.js';
import { allowWriteField } from '../src/core/run.js';
import { JIRA } from './fixtures/jira.fixture.js';
import { runCli } from './harness/cli.js';
import { testContext } from './harness/context.js';
import type { Route } from './harness/fake-fetch.js';
import { connectMcp, type McpSession } from './harness/mcp.js';

/**
 * `<area> api`, through `jira api`: the request it sends comes from the
 * area's own hook, the method decides the write gate, DELETE stays off MCP,
 * the path stays on the connection's host, and a body that isn't JSON comes
 * back as text. test/parity/suite.ts covers its examples through both doors.
 */

const api = jiraCommands.find((def) => commandName(def) === 'jira api')!;
const commands = [api];
const config = (writes = true) => ({ jira: { baseUrl: `${JIRA}/jira`, apiToken: 'test-token', ...(writes ? { writes: true } : {}) } });

const sessions: McpSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

async function mcp(routes: Route[], writes = true) {
  const { context, http } = testContext({ config: config(writes), routes, files: { 'body.json': '{"name":"Payments"}' } });
  const session = await connectMcp({ commands, context });
  sessions.push(session);
  return { session, http };
}

function cli(routes: Route[], writes = true) {
  return testContext({ config: config(writes), routes, files: { 'body.json': '{"name":"Payments"}' } });
}

describe('jira api', () => {
  it('reads: sends the hook\'s credential under the base URL\'s context path, and returns the JSON body with status and content type in meta', async () => {
    const routes: Route[] = [{ path: '/jira/rest/api/2/myself', query: { expand: ['groups', 'applicationRoles'] }, respond: { json: { name: 'jsmith' } } }];
    const { context, http } = cli(routes);
    const run = await runCli(['jira', 'api', 'GET', '/rest/api/2/myself', '--query', 'expand=groups', '--query', 'expand=applicationRoles'], { commands, context });

    expect(run.envelope?.ok, run.stdout).toBe(true);
    expect(run.envelope?.data).toEqual({ name: 'jsmith' });
    expect(run.envelope?.meta.response).toEqual({ status: 200, contentType: 'application/json' });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]).toMatchObject({ method: 'GET', url: `${JIRA}/jira/rest/api/2/myself?expand=groups&expand=applicationRoles`, body: undefined });
    expect(http.calls[0]!.headers.authorization).toBe('Bearer test-token');
    expect(run.envelope?.meta.context?.connection).toMatchObject({ value: 'jira' });
  });

  it('is gated by method: POST needs writes on and --allow-write, and sends the body file as given', async () => {
    const routes: Route[] = [{ method: 'POST', path: '/jira/rest/api/2/component', respond: { status: 201, json: { id: '10500' } } }];

    const off = cli(routes, false);
    const refused = await runCli(['jira', 'api', 'POST', '/rest/api/2/component', '--body-file', 'body.json', '--allow-write'], { commands, context: off.context });
    expect(refused.envelope?.error).toMatchObject({ code: 'WRITE_DISABLED', message: expect.stringContaining('writes are off') });
    expect(off.http.calls).toHaveLength(0);

    const on = cli(routes);
    const noFlag = await runCli(['jira', 'api', 'POST', '/rest/api/2/component', '--body-file', 'body.json'], { commands, context: on.context });
    expect(noFlag.envelope?.error).toMatchObject({ code: 'WRITE_DISABLED', message: expect.stringContaining('--allow-write') });
    expect(on.http.calls).toHaveLength(0);

    const made = await runCli(['jira', 'api', 'POST', '/rest/api/2/component', '--body-file', 'body.json', '--allow-write'], { commands, context: on.context });
    expect(made.envelope?.data).toEqual({ id: '10500' });
    expect(made.envelope?.meta.response?.status).toBe(201);
    expect(on.http.calls[0]).toMatchObject({ method: 'POST', body: '{"name":"Payments"}' });
    expect(on.http.calls[0]!.headers['content-type']).toBe('application/json');

    // A GET stays free with writes off, and over MCP the tool is listed with writes off.
    const read = await runCli(['jira', 'api', 'HEAD', '/rest/api/2/component'], { commands, context: cli([{ method: 'HEAD', path: '/jira/rest/api/2/component', respond: { status: 200 } }], false).context });
    expect(read.envelope).toMatchObject({ ok: true, data: null, meta: { response: { status: 200 } } });
    const { session } = await mcp(routes, false);
    expect((await session.client.listTools()).tools.map((t) => t.name)).toEqual(['jira_api']);
    expect((await session.call('jira_api', { method: 'PATCH', path: '/rest/api/2/component/1', bodyFile: 'body.json', allowWrite: true })).envelope.error?.code).toBe('WRITE_DISABLED');
  });

  it('runs DELETE on the CLI behind the gate, and never over MCP, whatever the connection allows', async () => {
    const routes: Route[] = [{ method: 'DELETE', path: '/jira/rest/api/2/component/10500', respond: { status: 204 } }];
    const { context, http } = cli(routes);
    const ran = await runCli(['jira', 'api', 'DELETE', '/rest/api/2/component/10500', '--allow-write'], { commands, context });
    expect(ran.envelope).toMatchObject({ ok: true, data: null, meta: { response: { status: 204 } } });
    expect(http.calls.map((c) => c.method)).toEqual(['DELETE']);

    const { session, http: mcpHttp } = await mcp(routes);
    const viaMcp = await session.call('jira_api', { method: 'DELETE', path: '/rest/api/2/component/10500', allowWrite: true });
    expect(viaMcp.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('DELETE is never served over MCP') });
    expect(viaMcp.isError).toBe(true);
    expect(mcpHttp.calls).toHaveLength(0);
  });

  it.each([
    ['https://other.imagile.dev/rest/api/2/myself', 'scheme'],
    ['//other.imagile.dev/rest/api/2/myself', '//'],
    [' //other.imagile.dev/x', '//'],
    ['/\\other.imagile.dev/x', '//'],
    ['\\\\other.imagile.dev/x', '//'],
    ['\\x', 'backslash'],
    ['javascript:alert(1)', 'scheme'],
    ['C:/Program Files/Git/rest/api/2/myself', 'local file path'],
    ['/rest/api/2/../../../admin', 'segment'],
    ['/rest/api/2/%2e%2e/admin', 'segment'],
  ])('refuses %s, which would leave the connection\'s base URL, before anything is sent', async (path, why) => {
    const { context, http } = cli([]);
    const run = await runCli(['jira', 'api', 'GET', path], { commands, context });
    expect(run.envelope?.error?.code).toBe('INVALID_INPUT');
    expect(run.envelope?.error?.message).toContain(why === 'segment' ? 'segment' : why);
    expect(http.calls).toHaveLength(0);
  });

  it('returns a body that isn\'t JSON as text, and a JSON one that fails to parse as text with a warning', async () => {
    const routes: Route[] = [
      { path: '/jira/rest/api/2/status.txt', respond: { text: 'all good', headers: { 'content-type': 'text/plain' } } },
      { path: '/jira/rest/api/2/broken', respond: { text: '{not json', headers: { 'content-type': 'application/json;charset=UTF-8' } } },
      { path: '/jira/rest/api/2/vendor', respond: { text: '{"ok":1}', headers: { 'content-type': 'application/vnd.atl+json' } } },
    ];
    const { context } = cli(routes);
    const text = await runCli(['jira', 'api', 'GET', 'rest/api/2/status.txt'], { commands, context });
    expect(text.envelope).toMatchObject({ ok: true, data: 'all good', meta: { response: { status: 200, contentType: 'text/plain' } } });
    const broken = await runCli(['jira', 'api', 'GET', 'rest/api/2/broken'], { commands, context });
    expect(broken.envelope?.data).toBe('{not json');
    expect(broken.envelope?.meta.warnings).toContainEqual(expect.objectContaining({ code: 'API_NOT_JSON' }));
    const vendor = await runCli(['jira', 'api', 'GET', 'rest/api/2/vendor'], { commands, context });
    expect(vendor.envelope?.data).toEqual({ ok: 1 });
  });

  it('refuses a content type with a line break as INVALID_INPUT on both doors, naming the problem, before anything is sent', async () => {
    const { context, http } = cli([]);
    const viaCli = await runCli(['jira', 'api', 'POST', '/x', '--body-file', 'body.json', '--content-type', 'application/json\r\nX-Evil: 1', '--allow-write'], { commands, context });
    expect(viaCli.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('one line with no control characters') });
    const { session, http: mcpHttp } = await mcp([]);
    const viaMcp = await session.call('jira_api', { method: 'POST', path: '/x', bodyFile: 'body.json', contentType: 'text/plain\n', allowWrite: true });
    expect(viaMcp.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('one line with no control characters') });
    expect([...http.calls, ...mcpHttp.calls]).toHaveLength(0);
  });

  it('returns a binary body as base64 with an API_BINARY warning naming the download command, never as mangled text', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
    const { context } = cli([
      { path: '/jira/secure/useravatar', respond: { text: String.fromCharCode(...png), headers: { 'content-type': 'image/png' } } },
      { path: '/jira/rest/api/2/feed', respond: { text: '<feed/>', headers: { 'content-type': 'application/atom+xml' } } },
    ]);
    const run = await runCli(['jira', 'api', 'GET', '/secure/useravatar'], { commands, context });
    // The fake server sends the text as UTF-8; data is exactly those bytes, round-tripped, not a lossy decode.
    const sent = new TextEncoder().encode(String.fromCharCode(...png));
    expect(new Uint8Array(Buffer.from(run.envelope?.data as string, 'base64'))).toEqual(sent);
    expect(run.envelope?.meta.warnings).toContainEqual(expect.objectContaining({ code: 'API_BINARY', message: expect.stringContaining('toil jira issue download') }));
    expect(run.envelope?.meta.response?.contentType).toBe('image/png');
    const xml = await runCli(['jira', 'api', 'GET', '/rest/api/2/feed'], { commands, context });
    expect(xml.envelope?.data).toBe('<feed/>');
    expect(xml.envelope?.meta.warnings).toBeUndefined();
  });

  it('caps a text body, and says so', async () => {
    const big = 'x'.repeat(MAX_TEXT_BYTES + 10);
    const { context } = cli([{ path: '/jira/secure/big.log', respond: { text: big, headers: { 'content-type': 'text/plain' } } }]);
    const run = await runCli(['jira', 'api', 'GET', '/secure/big.log'], { commands, context });
    expect((run.envelope?.data as string).length).toBe(MAX_TEXT_BYTES);
    expect(run.envelope?.meta.warnings).toContainEqual(expect.objectContaining({ code: 'API_TRUNCATED', message: expect.stringContaining(String(MAX_TEXT_BYTES + 10)) }));
  });

  it('maps errors to the usual codes, with the area\'s own fix for a rejected token', async () => {
    const { context } = cli([
      { path: '/jira/rest/api/2/issue/NOPE-1', respond: { status: 404, json: { errorMessages: ['Issue does not exist or you do not have permission to see it.'] } } },
      { path: '/jira/rest/api/2/myself', respond: { status: 401 } },
    ]);
    const missing = await runCli(['jira', 'api', 'GET', '/rest/api/2/issue/NOPE-1'], { commands, context });
    expect(missing.envelope?.error).toMatchObject({ code: 'NOT_FOUND', message: 'Issue does not exist or you do not have permission to see it.' });
    const auth = await runCli(['jira', 'api', 'GET', '/rest/api/2/myself'], { commands, context });
    expect(auth.envelope?.error).toMatchObject({ code: 'AUTH', fix: expect.stringContaining('Personal Access Tokens') });
  });

  it('sends a query typed into the path as typed, and joins it with --query, the path\'s first', async () => {
    const routes: Route[] = [{ path: '/jira/rest/api/2/search', respond: { json: { issues: [] } } }];
    const typed = cli(routes);
    expect((await runCli(['jira', 'api', 'GET', '/rest/api/2/search?jql=a%20b'], { commands, context: typed.context })).envelope?.ok).toBe(true);
    expect(typed.http.calls.map((c) => c.url)).toEqual([`${JIRA}/jira/rest/api/2/search?jql=a%20b`]);
    const both = cli(routes);
    const run = await runCli(['jira', 'api', 'GET', '/rest/api/2/search?jql=a', '--query', 'maxResults=5'], { commands, context: both.context });
    expect(run.envelope?.ok, run.stdout).toBe(true);
    expect(both.http.calls.map((c) => c.url)).toEqual([`${JIRA}/jira/rest/api/2/search?jql=a&maxResults=5`]);
  });

  it('refuses a # in the path with a fix for the passthrough, before anything is sent', async () => {
    const { context, http } = cli([]);
    const run = await runCli(['jira', 'api', 'GET', '/rest/api/2/myself#top'], { commands, context });
    expect(run.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('a fragment is never sent'), fix: expect.stringContaining('Leave out the #') });
    expect(http.calls).toEqual([]);
  });

  it('refuses a malformed query, a body on a read, and a content type with no body, before anything is sent', async () => {
    const { context, http } = cli([]);
    for (const argv of [
      ['jira', 'api', 'GET', '/x', '--query', 'novalue'],
      ['jira', 'api', 'GET', '/x', '--query', '=v'],
      ['jira', 'api', 'GET', '/x', '--body-file', 'body.json'],
      ['jira', 'api', 'POST', '/x', '--content-type', 'text/plain', '--allow-write'],
      ['jira', 'api', 'get', '/x'],
      ['jira', 'api', 'POST', '/x', '--body-file', 'body.json', '--content-type', 'application/json\r\nX-Evil: 1', '--allow-write'],
    ]) {
      const run = await runCli(argv, { commands, context });
      expect(run.envelope?.error?.code, argv.join(' ')).toBe('INVALID_INPUT');
    }
    expect(http.calls).toHaveLength(0);
  });
});

describe('the kit behind it', () => {
  const plain = defineArea({ name: 'plain', description: 'An area with no request hook', connection: z.object({ baseUrl: z.string() }) });

  it('needs the area\'s request hook, so passthrough and the wrapped commands share one way in', () => {
    expect(() => apiCommand(plain, { service: 'Plain', examplePath: '/x', examples: [{ method: 'GET', path: '/x' }] })).toThrow(/request hook/);
  });

  it('refuses writesWhen without allowWrite or on a write, and offMcpWhen on a command MCP never serves', () => {
    const base = { path: ['plain', 'x'] as [string, string], description: 'x', examples: [{}], run: async () => null };
    expect(() => plain.command({ ...base, input: z.object({}), writes: false, writesWhen: () => true })).toThrow(/allowWriteField/);
    expect(() => plain.command({ ...base, input: z.object({ ...allowWriteField }), writes: true, writesWhen: () => true })).toThrow(/writes: false/);
    expect(() => plain.command({ ...base, input: z.object({}), writes: false, mcp: false, offMcpWhen: () => 'no' })).toThrow(/off MCP already/);
  });
});
