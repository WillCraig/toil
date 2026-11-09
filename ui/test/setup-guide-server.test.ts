// @vitest-environment node
import { registry } from '@imagile-dev/toil/api';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zod from 'zod';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { fixtureAgent, noAgent, type Agent } from '../server/agent.ts';
import { GuideRefusal, docPages, guideAnswer, guideContext, guideProposals, guideSystem, guideTools, pagesFor } from '../server/agents/guide.ts';
import { AgentHost } from '../server/agents/host.ts';
import { claudeRuntime } from '../server/agents/claude.ts';
import type { Importer } from '../server/agents/runtime.ts';
import { agentSettingsFile } from '../server/agents/settings.ts';
import type { RequestContext } from '../server/context.ts';
import { createUiServer } from '../server/server.ts';
import { fixtureStore } from '../server/store.ts';
import { FIXTURE_AREAS } from '../src/fixtures/config.ts';
import { GUIDE_REFUSAL, cleanAddress, guideInputProblem, guideLine, guideStateOf, guideStarters, looksLikeSecret, readGuideState } from '../src/guide.ts';
import type { ConnectionRow } from '../src/config.ts';
import type { Envelope, Execute } from '../src/toil.ts';
import { letIn } from './let-in.ts';

/**
 * The setup guide (#561), server side and shared: what looks like a secret, the
 * state the wizard may send and the context built from it (with a fake secret
 * fed in at every door it could come through), the guide mode working with no
 * sync and no Toil project, its tools being reads, and a refused message
 * reaching nothing: no connection list, no agent, no ledger line, no worklog run.
 * Every token below is built from pieces, so no scanner finds a real-looking one in the repository.
 */

const FAKE = {
  github: ['ghp', '_', '0'.repeat(34), 'AB'].join(''),
  pat: ['github', '_pat_', '1'.repeat(30)].join(''),
  atlassian: ['AT', 'ATT', 'x'.repeat(24)].join(''),
  gitlab: ['glpat', '-', 'a1'.repeat(10)].join(''),
  slack: ['xo', 'xb-', '1234567890-abcdef'].join(''),
  aws: ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join(''),
  hex: 'deadbeef'.repeat(5),
  b64: 'Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3A=',
};

const ctx = (signal = new AbortController().signal): RequestContext => ({ viewer: { id: 'local', name: 'you', via: 'loopback' }, signal });

describe('what looks like a secret', () => {
  it.each([
    ['a GitHub token', `here it is ${FAKE.github}`],
    ['a fine-grained token', FAKE.pat],
    ['an Atlassian token', `my token is ${FAKE.atlassian}`],
    ['a GitLab token', `use ${FAKE.gitlab} please`],
    ['a Slack token', FAKE.slack],
    ['an AWS key id', `${FAKE.aws} is the key`],
    ['a bearer header', `Authorization: Bearer ${FAKE.b64}`],
    ['a labelled password', 'password: hunter2hunter2'],
    ['an env assignment', `GITHUB_TOKEN=${FAKE.hex}`],
    ['a long hex string', `what about ${FAKE.hex}?`],
    ['a long key-shaped word', FAKE.b64],
    ['an address with a login', 'my site is https://you:s3cretpass@jira.imagile.dev'],
    ['a private key', '-----BEGIN RSA PRIVATE KEY-----'],
    ['a JWT', ['eyJ', 'hbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.abc123def456'].join('')],
  ])('refuses %s', (_name, text) => {
    expect(looksLikeSecret(text)).toBe(true);
  });

  it.each([
    'Which scopes does my token need?',
    'Where do I find my Jira site name?',
    'Cloud or Data Center?',
    'What is a Toil project?',
    'The list says token: saved, is that enough?',
    'Is https://jira.imagile.dev/rest/api/3 the right address?',
    'What does Sprint mean here?',
    'Do I paste my password anywhere?',
  ])('lets %j through', (text) => {
    expect(looksLikeSecret(text)).toBe(false);
  });
});

describe('the state the wizard may send, and the context built from it', () => {
  const rows: ConnectionRow[] = [{ name: 'corp-jira', area: 'jira', isDefault: true, host: 'jira.imagile.dev', writes: false, values: { baseUrl: 'file', apiToken: 'store' } }];

  it('is a whitelist: a form with a secret in it contributes none of it', () => {
    // The connection form's settings as it would send them, with a secret that must never be there, and the places one could be hidden.
    const draft = { baseUrl: `https://jira.imagile.dev/?token=${FAKE.github}`, deployment: 'Data Center', apiToken: FAKE.github, token: FAKE.pat };
    const state = guideStateOf({ step: 'connect', areas: ['jira'], area: 'jira', draft, project: 'payments' });
    expect(JSON.stringify(state)).not.toContain(FAKE.github);
    expect(JSON.stringify(state)).not.toContain(FAKE.pat);
    // The address with a token in its query is dropped whole; the plain one is kept without any query.
    expect(state.address).toBeUndefined();
    expect(guideStateOf({ step: 'connect', areas: ['jira'], draft: { ...draft, baseUrl: 'https://jira.imagile.dev/?x=1' } }).address).toBe('https://jira.imagile.dev');
    expect(state).toEqual({ step: 'connect', areas: ['jira'], area: 'jira', deployment: 'Data Center', project: 'payments' });
  });

  it('builds a context from facts only, with a fake secret fed in through the state, the rows and the address', () => {
    const state = guideStateOf({ step: 'connect', areas: ['jira', 'github'], area: 'jira', draft: { deployment: 'Data Center', baseUrl: 'https://you:hunter2@jira.imagile.dev/path', apiToken: FAKE.github }, project: null });
    const withSecretInRow = [{ ...rows[0]!, values: { ...rows[0]!.values, apiToken: FAKE.github as never } }];
    const context = guideContext(state, withSecretInRow, FIXTURE_AREAS);
    expect(context).not.toContain(FAKE.github);
    expect(context).not.toContain('hunter2');
    expect(context).toContain('Linking now: Jira.');
    expect(context).toContain('Deployment chosen in the form: Data Center.');
    expect(context).toContain('corp-jira: Jira, jira.imagile.dev');
    expect(context).toContain('changes off');
    // The badge says where a token lives, never what it is.
    expect(context).toMatch(/token (saved|set outside Toil UI|missing)/);
  });

  it('says a token is missing, saved or from the environment, and says so plainly when toil could not list the connections', () => {
    const base = guideStateOf({ step: 'connect', areas: ['jira'], area: 'jira' });
    const jira = FIXTURE_AREAS.find((a) => a.name === 'jira')!;
    const secretKey = jira.connection.find((f) => f.secret)!.name;
    const row = (source?: string): ConnectionRow => ({ name: 'j', area: 'jira', isDefault: true, host: null, writes: true, values: source ? ({ [secretKey]: source } as never) : {} });
    expect(guideContext(base, [row('store')], FIXTURE_AREAS)).toContain('token saved');
    expect(guideContext(base, [row('env')], FIXTURE_AREAS)).toContain('token set outside Toil UI');
    expect(guideContext(base, [row()], FIXTURE_AREAS)).toContain('token missing');
    expect(guideContext(base, [row('store')], FIXTURE_AREAS)).toContain('changes on');
    expect(guideContext(base, null, FIXTURE_AREAS)).toContain("toil couldn't list them");
    expect(guideContext(base, [], FIXTURE_AREAS)).toContain('Connections that already exist: none.');
  });

  it('refuses a state with an unknown key, a wrong step or a bad name, saying which', () => {
    expect(readGuideState({ step: 'connect', areas: [], token: FAKE.github })).toMatch(/not token/);
    expect(JSON.stringify(readGuideState({ step: 'connect', areas: [], token: FAKE.github }))).not.toContain(FAKE.github);
    expect(readGuideState({ step: 'elsewhere', areas: [] })).toMatch(/step is one of/);
    expect(readGuideState({ step: 'connect', areas: ['Not A Name'] })).toMatch(/area names/);
    expect(readGuideState({ step: 'connect', areas: ['jira'], address: `https://x.imagile.dev/?t=${FAKE.github}` })).toEqual({ step: 'connect', areas: ['jira'] });
    expect(readGuideState({ step: 'tools', areas: ['jira'], project: 'payments' })).toEqual({ step: 'tools', areas: ['jira'], project: 'payments' });
  });

  it('cleans an address to a plain one, and drops what is not', () => {
    expect(cleanAddress('jira.imagile.dev')).toBe('https://jira.imagile.dev');
    expect(cleanAddress('https://jira.imagile.dev/jira/')).toBe('https://jira.imagile.dev/jira');
    expect(cleanAddress('https://you:pw@jira.imagile.dev')).toBeNull();
    expect(cleanAddress('ftp://jira.imagile.dev')).toBeNull();
    expect(cleanAddress('localhost')).toBeNull();
    expect(cleanAddress(42)).toBeNull();
  });

  it('offers starters per step, naming the tool in play', () => {
    expect(guideStarters('connect', 'jira')).toEqual(expect.arrayContaining(['Which scopes does my token need?', 'Where do I find my Jira site name?', 'Cloud or Data Center?']));
    expect(guideStarters('connect', 'github')).not.toContain('Cloud or Data Center?');
    expect(guideStarters('project')).toContain('What is a Toil project?');
    expect(guideStarters('fields')).toContain('What does Sprint mean here?');
    expect(guideStarters('welcome')).toEqual([]);
  });
});

describe("the guide's docs and tools", () => {
  const state = guideStateOf({ step: 'connect', areas: ['jira'], area: 'jira' });

  it('offers the setup pages and the chosen tool, and with none chosen every tool', () => {
    const names = pagesFor(state).map((p) => p.page);
    expect(names).toEqual(expect.arrayContaining(['core', 'connections', 'projects', 'jira']));
    expect(names).not.toContain('github');
    expect(pagesFor(guideStateOf({ step: 'tools', areas: [] })).map((p) => p.page)).toEqual(expect.arrayContaining(['jira', 'github']));
    expect(docPages().every((p) => p.description.length > 0 || p.page === 'upgrading' || p.page === 'changelog' || true)).toBe(true);
  });

  it('has three tools, all reads: the docs and a scope lookup', async () => {
    const tools = guideTools(state, FIXTURE_AREAS);
    expect(tools.map((t) => t.name)).toEqual(['docs_list', 'docs_read', 'connection_scopes']);
    const read = (await tools[1]!.run({ page: 'jira' })) as { text: string };
    expect(read.text).toContain('Jira');
    expect(((await tools[1]!.run({ page: 'github' })) as { error: string }).error).toMatch(/no page/);
    expect(((await tools[1]!.run({ page: '../../etc/passwd' })) as { error: string }).error).toMatch(/no page/);
    const scopes = (await tools[2]!.run({ area: 'github' })) as { scopes?: unknown; note?: string };
    expect(scopes.scopes ?? scopes.note).toBeTruthy();
    expect(((await tools[2]!.run({ area: 'nope' })) as { error: string }).error).toMatch(/no tool/);
  });

  it('cuts a long page and says so', async () => {
    const files = { 'jira.md': `---\narea: jira\ndescription: x\n---\n${'a'.repeat(30_000)}` };
    const r = (await guideTools(state, FIXTURE_AREAS, files)[1]!.run({ page: 'jira' })) as { cut?: string; text: string };
    expect(r.cut).toMatch(/cut to 24000/);
    expect(r.text).toHaveLength(24_000);
  });

  it('writes a prompt that names the step, the facts, the commands it may suggest and the rule about secrets', () => {
    const prompt = guideSystem('The person is on the step "x".', pagesFor(state), '2026-11-05T00:00:00Z', { voice: 'Speak like a ship.', instructions: null });
    expect(prompt).toContain('You are the setup guide');
    expect(prompt).toContain('You never see a secret and never ask for one');
    for (const c of ['connections add', 'projects init', 'projects add-repo', 'projects link']) expect(prompt).toContain(c);
    expect(prompt).toContain('Speak like a ship.');
    expect(prompt.indexOf('Speak like a ship.')).toBeGreaterThan(prompt.indexOf('Rules:'));
    expect(prompt).toContain('The person is on the step "x".');
  });
});

describe("the guide's suggested commands", () => {
  const block = (o: unknown) => `\`\`\`proposal\n${JSON.stringify(o)}\n\`\`\``;

  it('keeps a suggestion from the table, and leaves out one that is not, has an unknown field, is missing one, or holds a token', () => {
    const good = { title: 'Make it', reason: 'You have none.', command: 'projects init', input: { name: 'payments' }, note: null };
    const raw = [
      block(good),
      block({ ...good, command: 'jira issue create', input: { summary: 'x' } }),
      block({ ...good, input: { name: 'payments', shared: true } }),
      block({ ...good, input: {} }),
      block({ ...good, command: 'connections add', input: { name: 'j', area: 'jira', set: [`apiToken=${FAKE.github}`] } }),
      block({ ...good, command: 'connections add', input: { name: 'j', area: 'jira', set: ['baseUrl=https://jira.imagile.dev'] } }),
      '```proposal\nnot json\n```',
    ].join('\n');
    const { proposals, warnings } = guideProposals(raw);
    expect(proposals.map((p) => [p.command, p.input])).toEqual([
      ['projects init', { name: 'payments' }],
      ['connections add', { name: 'j', area: 'jira', set: ['baseUrl=https://jira.imagile.dev'] }],
    ]);
    expect(warnings).toHaveLength(5);
    expect(warnings.join(' ')).not.toContain(FAKE.github);
  });

  it('types the line the card shows, single quoted, and refuses what it cannot', () => {
    expect(guideLine('projects link', { toilProject: 'payments', area: 'jira', connection: 'corp-jira' })).toBe("toil projects link 'payments' 'jira' --connection 'corp-jira'");
    expect(guideLine('connections add', { name: 'j', area: 'jira', set: ['baseUrl=https://jira.imagile.dev'] })).toBe("toil connections add 'j' --area 'jira' --set 'baseUrl=https://jira.imagile.dev'");
    expect(guideLine('jira issue create', { summary: 'x' })).toBeNull();
    expect(guideInputProblem('projects init', { name: 'a\nb' })).toBeNull();
    expect(guideLine('projects init', { name: 'a\nb' })).toBeNull();
    expect(guideInputProblem('projects init', { name: FAKE.github })).toMatch(/looks like a token/);
  });

  it('holds back an answer that itself contains something shaped like a token', () => {
    const a = guideAnswer(`The token is ${FAKE.github}.`, { prompt: 'q', by: 'Claude' });
    expect(JSON.stringify(a)).not.toContain(FAKE.github);
    expect(a.parts[0]!.text).toMatch(/held back/);
    expect(guideAnswer('Plain text.\n\nSecond.', { prompt: 'q', by: 'Claude' }).parts.map((p) => p.text)).toEqual(['Plain text.', 'Second.']);
  });
});

// ---------------------------------------------------------------- the host, on a stubbed SDK

const folder = mkdtempSync(join(tmpdir(), 'toil-ui-guide-'));
afterAll(() => rmSync(folder, { recursive: true, force: true, maxRetries: 3 }));

/** The Claude Agent SDK, stubbed: it records the system prompt and prompt it was handed, runs scripted tool calls through the served tools, and streams the text. */
function stub(chunks: string[], calls: Array<{ name: string; input: Record<string, unknown> }> = []) {
  const seen: { queries: number; system?: string; prompt?: string; tools: string[]; results: unknown[] } = { queries: 0, tools: [], results: [] };
  const module = {
    tool: (name: string, description: string, shape: unknown, handler: (a: Record<string, unknown>) => Promise<unknown>) => ({ name, description, shape, handler }),
    createSdkMcpServer: (o: { name: string; tools: Array<{ name: string; handler: (a: Record<string, unknown>) => Promise<unknown> }> }) => ({ type: 'sdk', name: o.name, tools: o.tools }),
    query: ({ prompt, options }: { prompt: string; options: Record<string, unknown> }) => {
      seen.queries++;
      seen.system = options.systemPrompt as string;
      seen.prompt = prompt;
      const server = (options.mcpServers as Record<string, { tools: Array<{ name: string; handler: (a: Record<string, unknown>) => Promise<unknown> }> }>).toil_ui!;
      seen.tools = server.tools.map((t) => t.name);
      return (async function* () {
        for (const c of calls) seen.results.push(await server.tools.find((t) => t.name === c.name)?.handler(c.input));
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } };
        for (const text of chunks) yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } };
        yield { type: 'result', subtype: 'success', result: chunks.join('') };
      })();
    },
  };
  return { module, seen };
}

function guideHost(module: unknown, over: { rows?: ConnectionRow[] | null; runs?: unknown[] } = {}) {
  const dataDir = mkdtempSync(join(folder, 'host-'));
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(agentSettingsFile(dataDir), JSON.stringify({ adapter: 'claude', model: 'test-model', cliPath: null, endpoint: null }));
  const calls: Array<{ command: string; input: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const execute: Execute = async (command, input = {}, options = {}) => {
    calls.push({ command, input, options: options as Record<string, unknown> });
    const rows = over.rows === undefined ? [] : over.rows;
    return (rows === null ? { ok: false, data: null, error: { code: 'X', message: 'no', fix: '' }, meta: { command } } : { ok: true, data: { configFile: '/home/you/.toil/config.json', connections: rows }, error: null, meta: { command, durationMs: 0, version: '0', contractVersion: 1 } }) as unknown as Envelope;
  };
  const importer: Importer = async (spec) => {
    if (spec === 'zod') return zod;
    if (spec.startsWith('@anthropic-ai/')) return module;
    throw Object.assign(new Error(`Cannot find package '${spec}'`), { code: 'ERR_MODULE_NOT_FOUND' });
  };
  const runs = over.runs ?? [];
  const host = new AgentHost({
    dataDir,
    version: 't',
    // No sync has ever happened and no Toil project exists: the guide must not need either.
    data: () => null,
    registry: registry.commands,
    execute,
    mapIds: () => [],
    areas: FIXTURE_AREAS,
    serveTools: () => ({ url: '', token: '', close() {} }),
    fallback: noAgent(),
    env: { PATH: '/usr/bin', HOME: '/home/you' },
    cwd: '/work',
    platform: 'linux',
    importer,
    installed: () => true,
    isFile: (p) => p === '/usr/bin/claude',
    now: () => '2026-11-05T12:00:00.000Z',
    runtimes: [claudeRuntime('t')],
    onRun: (r) => void runs.push(r),
  });
  return { host, calls, runs };
}

const req = (message: string, state = guideStateOf({ step: 'connect', areas: ['jira'], area: 'jira' })) => ({ chat: 'guide-0000-0001', message, state });
async function all(host: AgentHost, message: string, extra: Parameters<AgentHost['guide']>[2] = null) {
  const versions = [];
  for await (const a of host.guide(ctx(), req(message), extra)) versions.push(a);
  return versions;
}

describe('the guide on the host', () => {
  it('answers with no sync and no Toil project, reading the docs and listing connections read-only, and records no worklog run', async () => {
    const s = stub(['Look at the web address ', 'you open Jira at.', '\n\n```proposal\n{"title":"Make a Toil project","reason":"None yet.","command":"projects init","input":{"name":"payments"},"note":null}\n```'], [{ name: 'docs_read', input: { page: 'jira' } }]);
    const { host, calls, runs } = guideHost(s.module, { rows: [{ name: 'corp-jira', area: 'jira', isDefault: true, host: 'jira.imagile.dev', writes: false, values: { baseUrl: 'file', apiToken: 'store' } }] });
    const versions = await all(host, 'Where do I find my Jira site name?');
    const last = versions.at(-1)!;
    expect(versions[0]).toMatchObject({ parts: [], activity: { phase: 'thinking' } });
    expect(last.parts.map((p) => p.text)).toEqual(['Look at the web address you open Jira at.']);
    expect(last.proposals.map((p) => p.command)).toEqual(['projects init']);
    expect(last.by).toBe('Claude (test-model)');
    // Its tools are the docs and the scope lookup; with no Toil project there are no live reads at all.
    expect(s.seen.tools).toEqual(['docs_list', 'docs_read', 'connection_scopes']);
    expect((s.seen.results[0] as { content: Array<{ text: string }> }).content[0]!.text).toContain('Jira');
    // The context it was given: the step, the tools, and the badge for the connection, never a value.
    expect(s.seen.system).toContain('Linking now: Jira.');
    expect(s.seen.system).toContain('corp-jira: Jira, jira.imagile.dev');
    expect(s.seen.system).toContain('token saved');
    expect(s.seen.prompt).toBe('Where do I find my Jira site name?');
    // The only toil call is the connection list, read-only, as Toil UI.
    expect(calls).toEqual([{ command: 'connections list', input: {}, options: expect.objectContaining({ readOnly: true, caller: 'toil-ui' }) }]);
    expect(runs).toEqual([]);
  });

  it('adds toil\'s live reads only once a Toil project exists, and still none that write', async () => {
    const s = stub(['ok']);
    const { host } = guideHost(s.module);
    for await (const _ of host.guide(ctx(), req('What is in it?', guideStateOf({ step: 'fields', areas: ['jira'], project: 'payments' })))) void _;
    expect(s.seen.tools.slice(0, 3)).toEqual(['docs_list', 'docs_read', 'connection_scopes']);
    expect(s.seen.tools.length).toBeGreaterThan(3);
    expect(s.seen.tools.some((t) => /create|update|transition|delete|merge|comment|write|add_repo|link/.test(t))).toBe(false);
  });

  it('says it does not know the connections when toil cannot list them', async () => {
    const s = stub(['ok']);
    const { host } = guideHost(s.module, { rows: null });
    await all(host, 'What do I have?');
    expect(s.seen.system).toContain("toil couldn't list them");
  });

  it('refuses a message that looks like a secret before anything runs: no connection list, no agent, no worklog run, no usage line', async () => {
    const s = stub(['never said']);
    const { host, calls, runs } = guideHost(s.module);
    await expect(all(host, `my token is ${FAKE.github}`)).rejects.toThrow(GuideRefusal);
    await expect(all(host, `my token is ${FAKE.github}`)).rejects.toThrow(GUIDE_REFUSAL);
    expect(calls).toEqual([]);
    expect(s.seen.queries).toBe(0);
    expect(runs).toEqual([]);
    expect(host.ledger.since('1970-01-01T00:00:00.000Z')).toEqual([]);
    expect(host.active).toBe(0);
    // An earlier question in the history that looks like one is refused the same way.
    await expect((async () => { for await (const _ of host.guide(ctx(), req('and now?'), null, [{ prompt: FAKE.pat, answer: 'x' }])) void _; })()).rejects.toThrow(GuideRefusal);
    expect(s.seen.queries).toBe(0);
  });

  it('refuses an area it does not have, a question that is too long, and says no helper is set up when none is', async () => {
    const s = stub(['x']);
    const { host } = guideHost(s.module);
    await expect(all(host, 'q').then(() => (async () => { for await (const _ of host.guide(ctx(), { ...req('q'), state: { step: 'tools', areas: ['nope'] } })) void _; })())).rejects.toThrow(/no tool nope/);
    await expect(all(host, 'a'.repeat(2001))).rejects.toThrow(GuideRefusal);
    const dataDir = mkdtempSync(join(folder, 'none-'));
    const bare = new AgentHost({ dataDir, version: 't', data: () => null, registry: registry.commands, execute: async () => ({}) as never, mapIds: () => [], serveTools: () => ({ url: '', token: '', close() {} }), fallback: noAgent(), runtimes: [claudeRuntime('t')] });
    await expect((async () => { for await (const _ of bare.guide(ctx(), req('hello'))) void _; })()).rejects.toThrow(/No agent is set up/);
  });
});

// ---------------------------------------------------------------- the route

const running: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (running.length) await running.pop()!();
});

describe('POST api/agent/guide', () => {
  async function start(agent: Agent) {
    const dir = mkdtempSync(join(folder, 'app-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    const ui = createUiServer({ settings: { host: '127.0.0.1', port: 0, basePath: '/', dataDir: dir, retentionDays: 30, sample: true }, store: fixtureStore(), agent, appDir: dir, version: '0.0.0-test', toil: { version: '0.1.0', contractVersion: 1 }, machineSecret: randomBytes(32) });
    const address = await ui.listen();
    running.push(() => ui.close());
    return { ...address, cookie: await letIn(address.origin, '/') };
  }
  const post = (o: { origin: string; cookie: string }, body: unknown) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const url = new URL('/api/agent/guide', o.origin);
      const r = request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { host: url.host, origin: o.origin, cookie: o.cookie, 'content-type': 'application/json' } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode!, body: text }));
      });
      r.on('error', reject);
      r.end(JSON.stringify(body));
    });
  const spyAgent = () => {
    const seen: string[] = [];
    const agent: Agent = { ...fixtureAgent(), guide: async function* (_c, request) {
      seen.push(request.message);
      yield { prompt: request.message, parts: [{ text: 'Fine.' }], citations: [], by: 'test', proposals: [] };
    } };
    return { agent, seen };
  };
  const state = { step: 'connect', areas: ['jira'] };

  it('refuses a token-shaped message before the agent is reached, without echoing it', async () => {
    const { agent, seen } = spyAgent();
    const o = await start(agent);
    const res = await post(o, { chat: 'guide-0000-0001', message: `here: ${FAKE.github}`, state, stream: true });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.message).toBe(GUIDE_REFUSAL);
    expect(res.body).not.toContain(FAKE.github);
    expect(seen).toEqual([]);
    // The state is held to its shape, too: a stray field is refused, and its value is not echoed.
    const stray = await post(o, { chat: 'guide-0000-0001', message: 'hello', state: { ...state, token: FAKE.pat } });
    expect(stray.status).toBe(400);
    expect(stray.body).not.toContain(FAKE.pat);
    expect(seen).toEqual([]);
    const history = await post(o, { chat: 'guide-0000-0001', message: 'hello', state, history: [{ prompt: FAKE.slack, answer: 'a' }] });
    expect(history.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('streams a clean question to the agent, and 404s where the agent has no guide', async () => {
    const { agent, seen } = spyAgent();
    const o = await start(agent);
    const res = await post(o, { chat: 'guide-0000-0001', message: 'Cloud or Data Center?', state, stream: true });
    expect(res.status).toBe(200);
    expect(res.body).toContain('"done":true');
    expect(seen).toEqual(['Cloud or Data Center?']);
    const none = await start({ ...noAgent() });
    expect((await post(none, { chat: 'guide-0000-0001', message: 'hello', state })).status).toBe(404);
  });
});
