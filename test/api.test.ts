import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import contract from '../docs/command-contract.json' with { type: 'json' };
import { contractVersion, execute as apiExecute, registry, version } from '../src/api.js';
import { versionCommand } from '../src/areas/version/version.js';
import { CONTRACT_VERSION, type Envelope } from '../src/core/envelope.js';
import { ToilError } from '../src/core/errors.js';
import { paginate } from '../src/core/paginate.js';
import { cliProgress, progressMessage, type ProgressEvent } from '../src/core/progress.js';
import { restRequest } from '../src/core/rest.js';
import { allowWriteField, execute, runCommand } from '../src/core/run.js';
import { demoArea, getThing, renameThing } from './fixtures/demo-commands.js';
import { API_EXPORTS } from '../scripts/entries.mjs';
import { testContext } from './harness/context.js';
import { connectMcp, type McpSession } from './harness/mcp.js';

/**
 * #212's core: `@imagile-dev/toil/api` (src/api.ts), `contractVersion`, the
 * `api` front door with its caller label, read-only calls, and progress events.
 * The built bundle is exercised by scripts/smoke.mjs, which installs the
 * tarball and runs scripts/api-consumer/ against it the way an npm user would.
 */

const config = { demo: { baseUrl: 'https://demo.imagile.dev', token: 't', writes: true } };

/** A test-only listing that pages through core's paginate() and restRequest(), as every area's client does. */
const listThings = demoArea.command({
  path: ['demo', 'list-things'],
  description: 'List things, two to a page',
  input: z.object({}),
  writes: false,
  examples: [{}],
  run: async (_input, ctx) =>
    (
      await paginate<{ id: string }>(
        { kind: 'nextPageStart', startParam: 'start', limitParam: 'limit', pageSize: 2 },
        async (page) => ({ body: await restRequest(ctx, `${ctx.connection.baseUrl}/api/things?start=${page.start}&limit=${page.limit}`, {}, { service: 'Demo', authFix: 'Check the token.' }) }),
        { what: 'demo things' },
      )
    ).items,
});

/** A test-only passthrough shape: the method decides whether the call writes. */
const sendThing = demoArea.command({
  path: ['demo', 'send'],
  description: 'Send a request',
  input: z.object({ method: z.enum(['GET', 'POST']), ...allowWriteField }),
  writes: false,
  writesWhen: (input) => input.method === 'POST',
  examples: [{ method: 'GET' }],
  run: async (input, ctx) => (await ctx.fetch(`${ctx.connection.baseUrl}/api/send`, { method: input.method })).status,
});

/** Page one is rate limited once (Retry-After: 0), then answers; page two is the last. */
function pagedRoutes() {
  let first = 0;
  return [
    {
      path: '/api/things',
      query: { start: '0', limit: '2' },
      respond: () => (first++ === 0 ? { status: 429, headers: { 'Retry-After': '0' }, json: {} } : { json: { values: [{ id: 'a' }, { id: 'b' }], isLastPage: false, nextPageStart: 2 } }),
    },
    { path: '/api/things', query: { start: '2', limit: '2' }, respond: { json: { values: [{ id: 'c' }], isLastPage: true } } },
  ];
}

const sessions: McpSession[] = [];
const homes: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('contractVersion', () => {
  it('is the value docs/command-contract.json records, in toil version and on every envelope', async () => {
    expect(contract.contractVersion).toBe(CONTRACT_VERSION);
    expect(contractVersion).toBe(CONTRACT_VERSION);
    const { context } = testContext({ config });
    const ok = await execute(versionCommand, {}, context);
    expect(ok.ok && (ok.data as { contractVersion: number }).contractVersion).toBe(CONTRACT_VERSION);
    expect(ok.meta.contractVersion).toBe(CONTRACT_VERSION);
    const failed = await execute(getThing, { nope: true }, context);
    expect(failed.ok).toBe(false);
    expect(failed.meta.contractVersion).toBe(CONTRACT_VERSION);
    // Right after version in meta, where a reader looks for it.
    expect(Object.keys(failed.meta).slice(0, 4)).toEqual(['command', 'durationMs', 'version', 'contractVersion']);
  });
});

describe('the Node floor through the API (CVE-2026-111497, #479)', () => {
  it("refuses every call on an unpatched Node with the CLI's UNSUPPORTED_NODE envelope, before anything runs", async () => {
    const real = Object.getOwnPropertyDescriptor(process.versions, 'node')!;
    Object.defineProperty(process.versions, 'node', { ...real, value: '24.22.0' });
    try {
      const refused = await apiExecute('version');
      expect(refused.ok).toBe(false);
      expect(refused.error).toMatchObject({ code: 'UNSUPPORTED_NODE', message: expect.stringContaining('CVE-2026-111497') });
      expect((await apiExecute('no such command')).error?.code).toBe('UNSUPPORTED_NODE');
    } finally {
      Object.defineProperty(process.versions, 'node', real);
    }
  });
});

describe('progress events', () => {
  it('reports every request, page and 429 retry from core, with no change to the envelope', async () => {
    const events: ProgressEvent[] = [];
    const heard = testContext({ config, routes: pagedRoutes() });
    const withListener = await execute(listThings, {}, { ...heard.context, progress: (e) => events.push(e) });
    const quiet = testContext({ config, routes: pagedRoutes() });
    const without = await execute(listThings, {}, quiet.context);
    expect(withListener.ok && withListener.data).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect({ ...withListener, meta: { ...withListener.meta, durationMs: 0 } }).toEqual({ ...without, meta: { ...without.meta, durationMs: 0 } });
    expect(events.map((e) => e.type)).toEqual(['request', 'retry', 'request', 'page', 'request', 'page']);
    expect(events.every((e) => e.command === 'demo list-things')).toBe(true);
    expect(events[1]).toMatchObject({ type: 'retry', attempt: 1, waitMs: 0, status: 429, url: 'https://demo.imagile.dev/api/things?start=0&limit=2' });
    expect(events[0]).toMatchObject({ type: 'request', method: 'GET', status: 429 });
    expect(events[5]).toMatchObject({ type: 'page', page: 2, items: 3, what: 'demo things', message: 'demo list-things: read page 2 of demo things, 3 items so far' });
    expect(events[1]!.message).toBe('demo list-things: rate limited (429) on https://demo.imagile.dev/api/things?start=0&limit=2; retrying in 0 s (attempt 2)');
  });

  it('a listener that throws stops hearing, and the command still succeeds with a warning saying so', async () => {
    const { context } = testContext({ config, routes: pagedRoutes() });
    let calls = 0;
    const envelope = await execute(listThings, {}, {
      ...context,
      progress: () => {
        calls++;
        throw new Error('the progress bar fell over');
      },
    });
    expect(envelope.ok).toBe(true);
    expect(calls).toBe(1);
    expect(envelope.meta.warnings).toEqual([expect.objectContaining({ code: 'PROGRESS_LISTENER_FAILED', message: expect.stringContaining('the progress bar fell over') })]);
  });

  it('over MCP, a client that sent a progress token hears pages and retries as notifications, and requests not at all', async () => {
    const { context } = testContext({ config, routes: pagedRoutes() });
    const session = await connectMcp({ commands: [listThings], context, areas: ['demo'] });
    sessions.push(session);
    const progress: Array<{ progress: number; message?: string }> = [];
    const result = await session.client.callTool({ name: 'demo_list_things', arguments: {} }, undefined, { onprogress: (p) => progress.push(p) });
    expect((result.structuredContent as unknown as Envelope).ok).toBe(true);
    expect(progress.map((p) => p.progress)).toEqual([1, 2, 3]);
    expect(progress.map((p) => p.message)).toEqual([
      'demo list-things: rate limited (429) on https://demo.imagile.dev/api/things?start=0&limit=2; retrying in 0 s (attempt 2)',
      'demo list-things: read page 1 of demo things, 2 items so far',
      'demo list-things: read page 2 of demo things, 3 items so far',
    ]);
  });
});

describe('read-only calls', () => {
  it('refuse a command that writes before its input is read or anything is sent, whatever the config says', async () => {
    const { context, http, audit } = testContext({ config });
    const envelope = await execute(renameThing, { id: 'THING-1', name: 'x', allowWrite: true }, context, 'api', { readOnly: true });
    expect(envelope.ok).toBe(false);
    expect(!envelope.ok && envelope.error.code).toBe('WRITE_DISABLED');
    expect(!envelope.ok && envelope.error.message).toBe('demo rename-thing changes data, and this call was made read-only, so it was refused before anything ran.');
    expect(http.calls).toEqual([]);
    expect(envelope.meta.context).toBeUndefined();
    expect(audit.entries().map((e) => [e.via, e.outcome, e.writes])).toEqual([['api', 'WRITE_DISABLED', true]]);
  });

  it('refuse a call whose input makes it write, and let the same command read', async () => {
    const posted = testContext({ config, routes: [{ method: 'POST', path: '/api/send', respond: { status: 201 } }] });
    const post = await execute(sendThing, { method: 'POST', allowWrite: true }, posted.context, 'api', { readOnly: true });
    expect(!post.ok && post.error.code).toBe('WRITE_DISABLED');
    expect(posted.http.calls).toEqual([]);
    const got = testContext({ config, routes: [{ path: '/api/send', respond: { status: 200 } }] });
    const get = await execute(sendThing, { method: 'GET' }, got.context, 'api', { readOnly: true });
    expect(get.ok && get.data).toBe(200);
  });

  it('refuse a local write too: a config command that writes, a download, and an undeclared file write as a backstop', async () => {
    const { context, http } = testContext({ config });
    const init = (await import('../src/registry.js')).commands.find((d) => d.path.join(' ') === 'projects init')!;
    expect(init.writesLocal).toBe(true);
    const refused = await runCommand(init, { name: 'payments' }, () => context, context.version, 'api', undefined, { readOnly: true });
    expect(!refused.ok && refused.error.message).toBe('projects init changes data, and this call was made read-only, so it was refused before anything ran.');
    // A command that writes a file without saying so is stopped at the write, never allowed through.
    const sneaky = demoArea.command({ path: ['demo', 'sneaky'], description: 'Writes a file it never declared', input: z.object({}), writes: false, examples: [{}], run: async (_i, ctx) => ctx.files.writeBytes('x.txt', new Uint8Array([1])) });
    const stopped = await execute(sneaky, {}, context, 'api', { readOnly: true });
    expect(!stopped.ok && stopped.error).toMatchObject({ code: 'WRITE_DISABLED', message: 'demo sneaky tried to write a file, and this call was made read-only, so the write was refused.' });
    expect(http.calls).toEqual([]);
    expect(registry.commands.find((c) => c.name === 'projects init')).toMatchObject({ writes: false, writesLocal: true });
    expect(registry.commands.find((c) => c.name === 'util encode')).toMatchObject({ writesLocal: false, writesDependOnInput: true });
  });

  it("skip the bundled skill's upkeep, the one local write a read can otherwise make", async () => {
    const { context } = testContext({ config, routes: [{ path: '/api/things/THING-1', respond: { json: { id: 'THING-1', attributes: { name: 'n' } } } }] });
    const upkeep = vi.fn();
    expect((await execute(getThing, { id: 'THING-1' }, { ...context, skillUpkeep: upkeep }, 'api', { readOnly: true })).ok).toBe(true);
    expect(upkeep).not.toHaveBeenCalled();
    expect((await execute(getThing, { id: 'THING-1' }, { ...context, skillUpkeep: upkeep }, 'api')).ok).toBe(true);
    expect(upkeep).toHaveBeenCalledOnce();
  });
});

describe('the api front door', () => {
  it('records via api and the caller label, and words input errors in field names, as MCP does', async () => {
    const { context, audit } = testContext({ config, routes: [{ path: '/api/things/THING-1', respond: { json: { id: 'THING-1', attributes: { name: 'n' } } } }] });
    expect((await runCommand(getThing, { id: 'THING-1' }, () => context, context.version, 'api', undefined, { caller: 'toil-ui' })).ok).toBe(true);
    expect(audit.entries()[0]).toMatchObject({ via: 'api', caller: 'toil-ui', command: 'demo get-thing', outcome: 'ok' });
    // No label, no key: the line is as it always was.
    await runCommand(getThing, { id: 'THING-1' }, () => context, context.version, 'cli');
    expect(audit.entries()[1]).not.toHaveProperty('caller');
    const picky = demoArea.command({
      path: ['demo', 'picky'],
      description: 'Refuses its flag',
      input: z.object({ maxResults: z.number().optional() }),
      writes: false,
      options: [{ flags: '--max-results <n>', field: 'maxResults', description: 'Most results' }],
      examples: [{}],
      run: async () => {
        throw new ToilError('INVALID_INPUT', '--max-results must be positive.', { fix: 'Pass --max-results 1 or more.' });
      },
    });
    const refused = await runCommand(picky, { maxResults: 0 }, () => context, context.version, 'api');
    expect(!refused.ok && refused.error).toMatchObject({ message: 'maxResults must be positive.', fix: 'Pass maxResults 1 or more.' });
  });
});

describe('@imagile-dev/toil/api (src/api.ts)', () => {
  /** A home of the test's own, so the API's real audit log lands there, never in the user's. */
  const isolatedHome = () => {
    const home = mkdtempSync(join(tmpdir(), 'toil-api-'));
    homes.push(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    return home;
  };

  it('exports exactly what dist/api.js re-exports from the bundle (scripts/entries.mjs)', async () => {
    const api = await import('../src/api.js');
    expect(Object.keys(api).sort()).toEqual([...API_EXPORTS].sort());
    // The bundle's entry exports the API plus main(), which only the bin calls; importing it runs nothing.
    const lib = await import('../src/cli.js');
    expect(Object.keys(lib).sort()).toEqual([...API_EXPORTS, 'main'].sort());
  });

  it('exports the version, the contract version and a registry of what execute() serves', () => {
    expect(version).toBe('0.0.0-test');
    expect(contractVersion).toBe(3);
    const names = registry.commands.map((c) => c.name);
    expect(names).toContain('version');
    expect(names).toContain('connections list');
    // A person's commands stay on the CLI.
    expect(names).not.toContain('connections add');
    const listing = registry.commands.find((c) => c.name === 'connections list')!;
    expect(listing).toMatchObject({ tool: 'connections_list', path: ['connections', 'list'], area: 'connections', kind: 'config', writes: false, writesLocal: false, writesDependOnInput: false });
    expect(listing.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(registry.areas.map((a) => a.name)).toContain('jira');
  });

  it('runs a command in-process, with the caller in the audit log of the home it runs in', async () => {
    const home = isolatedHome();
    const envelope = await apiExecute('version', {}, { caller: 'toil-ui' });
    expect(envelope).toMatchObject({ ok: true, data: { version: '0.0.0-test', contractVersion: CONTRACT_VERSION }, meta: { command: 'version', contractVersion: CONTRACT_VERSION } });
    const dir = join(home, '.toil', 'audit');
    const lines = readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n'));
    expect(lines.map((l) => JSON.parse(l))).toEqual([expect.objectContaining({ via: 'api', caller: 'toil-ui', command: 'version', outcome: 'ok' })]);
  });

  it('answers an unknown command, a person-only command and a bad caller label with envelopes, never a throw', async () => {
    isolatedHome();
    const unknown = await apiExecute('jira no-such-thing');
    expect(unknown).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' }, meta: { command: 'jira no-such-thing', contractVersion: CONTRACT_VERSION } });
    const personal = await apiExecute('connections add', { name: 'x' });
    expect(personal).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: "connections add is a person's command: execute() runs it only with a person to answer its questions." } });
    const cliOnly = await apiExecute('setup alias', {});
    expect(cliOnly).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: "setup alias isn't served through the API: it's a person's command, on the CLI." } });
    for (const caller of ['Toil UI', '', '-x', 'ghp_'.padEnd(80, 'a')]) {
      expect(await apiExecute('version', {}, { caller })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(await apiExecute('version', {}, { caller: 'toil-ui', actor: caller })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
  });

  it('records the actor a caller names beside the caller, and nothing when it names none', async () => {
    const home = isolatedHome();
    await apiExecute('version', {}, { caller: 'toil-ui', actor: 'assignment-abc12345' });
    await apiExecute('version', {}, { caller: 'toil-ui' });
    const dir = join(home, '.toil', 'audit');
    const lines = readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n')).map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ via: 'api', caller: 'toil-ui', actor: 'assignment-abc12345', command: 'version' });
    expect(lines[1]).not.toHaveProperty('actor');
  });

  it('refuses a write under readOnly before reading config or sending anything', async () => {
    isolatedHome();
    const envelope = await apiExecute('jira issue create', { project: 'PAY', summary: 'x', allowWrite: true }, { readOnly: true });
    expect(envelope).toMatchObject({ ok: false, error: { code: 'WRITE_DISABLED' } });
  });
});

describe('progress on the CLI (cliProgress)', () => {
  const event = (body: Parameters<typeof progressMessage>[1]): ProgressEvent => ({ ...body, command: 'demo list-things', message: progressMessage('demo list-things', body) });
  const retry = event({ type: 'retry', attempt: 1, waitMs: 30_000, status: 429, url: 'https://demo.imagile.dev/api/things' });
  const page = event({ type: 'page', page: 1, items: 2 });
  const request = event({ type: 'request', method: 'GET', url: 'https://demo.imagile.dev/api/things', status: 200, durationMs: 5 });

  it('on a pipe, says every retry and its wait as one plain stderr line, and no page or request', () => {
    const written: string[] = [];
    const listen = cliProgress({ isTTY: false, write: (t) => written.push(t) });
    [request, page, retry, page].forEach(listen);
    expect(written).toEqual(['[toil] demo list-things: rate limited (429) on https://demo.imagile.dev/api/things; retrying in 30 s (attempt 2)\n']);
  });

  it('on a terminal, says pages too, and still never a request', () => {
    const written: string[] = [];
    const listen = cliProgress({ isTTY: true, write: (t) => written.push(t) });
    [request, page, retry].forEach(listen);
    expect(written).toEqual(['[toil] demo list-things: read page 1, 2 items so far\n', '[toil] demo list-things: rate limited (429) on https://demo.imagile.dev/api/things; retrying in 30 s (attempt 2)\n']);
  });
});
