// @vitest-environment node
import { execute as realExecute, mapOwi, registry } from '@imagile-dev/toil/api';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import * as zod from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { noAgent } from '../server/agent.ts';
import { finish, named, partial, writeCommands } from '../server/agents/answer.ts';
import { claudeEnv, claudeRuntime, claudeToolName, zodShape } from '../server/agents/claude.ts';
import { AgentError, findCli, shimScript } from '../server/agents/cli.ts';
import { CODEX_FEATURES_OFF, codexOverrides, codexRuntime, prepareCodexHome, TOIL_CODEX_CONFIG, toilCodexHome, TOKEN_ENV, userCodexHome } from '../server/agents/codex.ts';
import { copilotRuntime } from '../server/agents/copilot.ts';
import { agentEnv } from '../server/agents/env.ts';
import { AgentHost, type AgentHostOptions } from '../server/agents/host.ts';
import { answerMcp, McpGrants } from '../server/agents/mcp.ts';
import { MAX_HISTORY_ANSWER, MAX_HISTORY_TURNS, promptFor, STARTERS, STYLE_RULE, systemPrompt, withHistory } from '../server/agents/prompts.ts';
import { structureOf } from '../src/model/analysis.ts';
import { THEME_VOICES } from '../server/agents/voices.ts';
import { Latest, loadSdk, type Importer, type Runtime } from '../server/agents/runtime.ts';
import { agentSettingsFile, checkAgentSettings, loadAgentSettings } from '../server/agents/settings.ts';
import { cacheData, cacheTools, toilProjectReader, Ledger, LIVE_COMMANDS, liveTools, neverWrites, peopleTools, proposalTool, prTools, readinessTools, standupTool, worklogTool, type AgentData, type ToolSpec } from '../server/agents/tools.ts';
import type { AgentRun } from '../src/model/worklog.ts';
import { Cache } from '../server/cache.ts';
import type { RequestContext } from '../server/context.ts';
import { SyncService } from '../server/sync.ts';
import { commandLine } from '../src/proposal.ts';
import type { Envelope, Execute } from '../src/toil.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { stubToil } from './toil-stub.ts';
import { headCommit, hiddenStaged, hostRunner } from '../server/assign/runner.ts';
import { spawnSync } from 'node:child_process';
import { memoryLedger, usageSettingsFile } from '../server/usage.ts';

/**
 * The agent adapters (#251), each against a stubbed SDK module: no test
 * starts a CLI or calls a model. The cache is the sample toil projects, synced
 * through the stubbed toil into a throwaway folder. Covered: the tools
 * reading the cache, the citation check, the tool list holding no write tool,
 * proposals coming back as cards and never run, the SDK missing, the CLI not
 * found, streaming, the settings file, and the Codex MCP endpoint.
 */

const ctx = (signal = new AbortController().signal): RequestContext => ({ viewer: { id: 'local', name: 'you', via: 'launch-token' }, signal });
const folder = mkdtempSync(join(tmpdir(), 'toil-ui-agents-'));
let cache: Cache;
let data: AgentData;

beforeAll(async () => {
  cache = await Cache.open(join(folder, 'data'), { retentionDays: 30, now: () => new Date(FIXTURE_NOW) });
  const toil = stubToil();
  await new SyncService({ cache, execute: toil.execute, mapOwi, now: () => new Date(FIXTURE_NOW) }).run(ctx());
  data = cacheData(cache, 'card-payments')!;
});
afterAll(() => {
  cache.close();
  rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
});

/** An execute() that records every call and answers each one ok with an empty list. */
function recordingExecute() {
  const calls: Array<{ command: string; input: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const execute: Execute = async (command, input = {}, options = {}) => {
    calls.push({ command, input, options: options as Record<string, unknown> });
    return { ok: true, data: { issues: [] }, error: null, meta: { command, durationMs: 0, version: '0', contractVersion: 1 } } as unknown as Envelope;
  };
  return { execute, calls };
}

const tool = (tools: ToolSpec[], name: string) => tools.find((t) => t.name === name)!;

describe('the pull request tools', () => {
  const web = () => cacheData(cache, 'checkout-web')!;
  const now = () => FIXTURE_NOW;

  it('pr_query lists the open ones longest-waiting first, with what each waits on, and vouches for them and their items', async () => {
    const ledger = new Ledger();
    const r = (await tool(prTools('checkout-web', web(), ledger, now), 'pr_query').run({})) as { total: number; pullRequests: Array<Record<string, unknown>> };
    expect(r.pullRequests.map((p) => [p.id, p.waitingOn, p.waitingWorkingDays, p.authorKind])).toEqual([
      ['github:imagile/payments-web#51', 'checks', 2, 'AGENT'],
      ['bitbucket-cloud:imagile/checkout-sdk#12', 'review', 1.3, 'AGENT'],
      ['github:imagile/payments-web#52', 'review', 1.3, 'HUMAN'],
      ['github:imagile/payments-web#53', 'draft', 0.8, 'HUMAN'],
    ]);
    expect(r.pullRequests[0]!.flags).toEqual([
      expect.objectContaining({ flag: 'slow-pickup' }),
      expect.objectContaining({ flag: 'failing-checks' }),
      expect.objectContaining({ flag: 'no-work-item' }),
    ]);
    expect(ledger.ids.has('github:imagile/payments-web#51')).toBe(true);
    expect(ledger.ids.has('github:imagile/payments-web#42')).toBe(true);
  });

  it('pr_query filters by state, kind, what it waits on and how long', async () => {
    const run = async (input: Record<string, unknown>) => ((await tool(prTools('checkout-web', web(), new Ledger(), now), 'pr_query').run(input)) as { pullRequests: Array<{ id: string }> }).pullRequests.map((p) => p.id);
    expect(await run({ authorKind: 'AGENT' })).toEqual(['github:imagile/payments-web#51', 'bitbucket-cloud:imagile/checkout-sdk#12']);
    expect(await run({ waitingOn: 'review', minWaitingDays: 1 })).toEqual(['bitbucket-cloud:imagile/checkout-sdk#12', 'github:imagile/payments-web#52']);
    expect(await run({ state: 'MERGED', authorKind: 'BOT' })).toEqual(['github:imagile/payments-web#49']);
    expect(await run({ repo: 'checkout-sdk', flagged: true })).toEqual(['bitbucket-cloud:imagile/checkout-sdk#12']);
  });

  it('pr_get gives one with its reviews and its items, or says to use pr_query', async () => {
    const ledger = new Ledger();
    const tools = prTools('checkout-web', web(), ledger, now);
    const r = (await tool(tools, 'pr_get').run({ id: 'github:imagile/payments-web#48' })) as { pullRequest: { reviews: Array<{ state: string }>; state: string } };
    expect(r.pullRequest.state).toBe('MERGED');
    expect(r.pullRequest.reviews.map((x) => x.state)).toEqual(['CHANGES_REQUESTED', 'APPROVED']);
    expect(((await tool(tools, 'pr_get').run({ id: 'github:imagile/payments-web#999' })) as { error: string }).error).toContain('pr_query');
  });

  it('pr_metrics splits each figure by author kind, with its sample size', async () => {
    const r = (await tool(prTools('checkout-web', web(), new Ledger(), now), 'pr_metrics').run({})) as { pickup: Record<string, { n: number; median: number | null }>; pullRequests: Record<string, number>; unit: string };
    expect(r.unit).toBe('working days');
    expect(Object.fromEntries(Object.entries(r.pickup).map(([k, v]) => [k, v.n]))).toEqual({ ALL: 4, HUMAN: 3, AGENT: 0, BOT: 1 });
    expect(r.pullRequests).toEqual({ ALL: 8, HUMAN: 5, AGENT: 2, BOT: 1 });
  });
});

describe('the cache tools', () => {
  it('owi_query lists the Toil project\'s items from the cache, filtered, and the ledger records each id', async () => {
    const ledger = new Ledger();
    const tools = cacheTools('card-payments', data, ledger);
    const all = (await tool(tools, 'owi_query').run({})) as { total: number; items: Array<{ id: string }> };
    expect(all.total).toBe(data.items().length);
    expect(all.items.every((i) => i.id.startsWith('corp-jira:PAY-'))).toBe(true);
    for (const i of all.items) expect(ledger.ids.has(i.id)).toBe(true);
    // And every id those items name, such as a link's target, since the result holds it too.
    expect([...ledger.ids].every((id) => JSON.stringify(all).includes(JSON.stringify(id)))).toBe(true);

    const progress = (await tool(tools, 'owi_query').run({ statusCategory: 'IN_PROGRESS' })) as { items: Array<{ id: string; statusCategory: string }> };
    expect(progress.items.length).toBeGreaterThan(0);
    expect(progress.items.every((i) => i.statusCategory === 'IN_PROGRESS')).toBe(true);
    // No native payload: the records are OWI, bounded.
    expect(JSON.stringify(all)).not.toContain('"native"');
  });

  it('owi_query is bounded and says when there are more', async () => {
    const r = (await tool(cacheTools('card-payments', data, new Ledger()), 'owi_query').run({ limit: 1 })) as { returned: number; more?: string };
    expect(r.returned).toBe(1);
    expect(r.more).toMatch(/more match/);
  });

  it('owi_get returns the item with its linked changes; owi_history its transitions', async () => {
    const ledger = new Ledger();
    const tools = cacheTools('card-payments', data, ledger);
    const got = (await tool(tools, 'owi_get').run({ id: 'corp-jira:PAY-101' })) as { item: { id: string }; changes: Array<{ kind: string }> };
    expect(got.item.id).toBe('corp-jira:PAY-101');
    expect(got.changes.some((c) => c.kind === 'pull-request')).toBe(true);
    const history = (await tool(tools, 'owi_history').run({ id: 'corp-jira:PAY-106' })) as { transitions: Array<{ to: string }> };
    expect(history.transitions.length).toBeGreaterThan(0);
    // The items, what PAY-101 names (PAY-102, which it blocks), and its pull requests and builds; nothing the results don't hold.
    for (const id of ['corp-jira:PAY-101', 'corp-jira:PAY-102', 'corp-jira:PAY-106', ...got.changes.map((c) => (c as { id?: string }).id!)]) expect(ledger.ids.has(id), id).toBe(true);
    const results = JSON.stringify([got, history]);
    for (const id of ledger.ids) expect(results, id).toContain(JSON.stringify(id));
  });

  it('owi_similar ranks the cache against some text or an item, with why, and vouches for what it returns', async () => {
    const ledger = new Ledger();
    const tools = cacheTools('card-payments', data, ledger);
    const byText = (await tool(tools, 'owi_similar').run({ query: 'Tokenise card numbers before logging' })) as { count: number; matches: Array<{ id: string; score: number; why: { titleTerms: string[] } }> };
    expect(byText.matches[0]!.id).toBe('corp-jira:PAY-101');
    expect(byText.matches[0]!.why.titleTerms).toEqual(expect.arrayContaining(['card', 'numbers']));
    for (const m of byText.matches) expect(ledger.ids.has(m.id)).toBe(true);
    const byItem = (await tool(tools, 'owi_similar').run({ id: 'corp-jira:PAY-101', limit: 1 })) as { returned: number; matches: Array<{ id: string }> };
    expect(byItem.returned).toBeLessThanOrEqual(1);
    expect(byItem.matches.map((m) => m.id)).not.toContain('corp-jira:PAY-101');
    expect(((await tool(tools, 'owi_similar').run({})) as { error: string }).error).toMatch(/exactly one of query/);
    expect(((await tool(tools, 'owi_similar').run({ id: 'corp-jira:PAY-999' })) as { error: string }).error).toMatch(/no item/);
  });

  it('an id the cache lacks is an error the model reads, and vouches for nothing', async () => {
    const ledger = new Ledger();
    const r = (await tool(cacheTools('card-payments', data, ledger), 'owi_get').run({ id: 'corp-jira:PAY-999' })) as { error: string };
    expect(r.error).toMatch(/no item/);
    expect(ledger.ids.size).toBe(0);
  });

  it('cacheData is null for a Toil project that never synced', () => {
    expect(cacheData(cache, 'never-synced')).toBeNull();
  });
});

describe('the tool list', () => {
  const host = (over: Partial<AgentHostOptions> = {}) =>
    new AgentHost({ dataDir: join(folder, 'host-list'), version: 't', data: () => data, registry: registry.commands, execute: recordingExecute().execute, mapIds: () => [], serveTools: () => ({ url: '', token: '', close() {} }), fallback: noAgent(), ...over });

  it('is the three cache tools and toil mcp\'s read tools, and none of them writes', () => {
    const names = host().tools('card-payments', data, new Ledger()).map((t) => t.name);
    const live = LIVE_COMMANDS.map((c) => registry.commands.find((r) => r.name === c)!);
    expect(names).toEqual(['owi_query', 'owi_get', 'owi_similar', 'owi_history', 'pr_query', 'pr_get', 'pr_metrics', 'people_list', 'person_get', 'readiness_list', 'readiness_get', 'proposal_fields', ...live.map((c) => c.tool)]);
    for (const c of live) expect(neverWrites(c), c.name).toBe(true);
    const writers = new Set(registry.commands.filter((c) => !neverWrites(c)).map((c) => c.tool));
    expect(names.filter((n) => writers.has(n))).toEqual([]);
    expect(names.some((n) => /create|update|transition|delete|merge|comment|write/.test(n))).toBe(false);
  });

  it('leaves out a live command the registry says writes, even if it is on the list', () => {
    const lying = registry.commands.map((c) => (c.name === 'jira issue search' ? { ...c, writes: true } : c));
    const names = liveTools('card-payments', lying, recordingExecute().execute, () => [], new Ledger()).map((t) => t.name);
    expect(names).not.toContain('jira_issue_search');
  });

  it('hides the Toil project, files and folders from a live tool, and fixes the Toil project and readOnly on every call', async () => {
    const rec = recordingExecute();
    const ledger = new Ledger();
    const tools = liveTools('card-payments', registry.commands, rec.execute, () => ['corp-jira:PAY-101'], ledger);
    const search = tool(tools, 'jira_issue_search');
    expect(Object.keys(search.inputSchema.properties)).not.toEqual(expect.arrayContaining(['toilProject']));
    for (const k of ['toilProject', 'cwd', 'jqlFile', 'connection', 'select']) expect(search.inputSchema.properties).not.toHaveProperty(k);
    await search.run({ jql: 'project = PAY', toilProject: 'someone-else', cwd: '/', jqlFile: '/etc/passwd' });
    expect(rec.calls).toEqual([{ command: 'jira issue search', input: { jql: 'project = PAY', toilProject: 'card-payments' }, options: { readOnly: true, caller: 'toil-ui' } }]);
    expect([...ledger.ids]).toEqual(['corp-jira:PAY-101']);
  });
});

describe('the citation check', () => {
  const writes = writeCommands(registry.commands);
  const ledgerOf = (...ids: string[]) => {
    const l = new Ledger();
    for (const id of ids) l.add(id);
    return l;
  };
  const f = (ledger: Ledger) => ({ toilProject: 'card-payments', prompt: 'q', by: 'Claude', ledger, writes });

  it('passes an answer whose every cited id came from a tool', () => {
    const a = finish('[[corp-jira:PAY-101]] blocks [[corp-jira:PAY-102]].', f(ledgerOf('corp-jira:PAY-101', 'corp-jira:PAY-102')));
    expect(a.citations).toEqual(['corp-jira:PAY-101', 'corp-jira:PAY-102']);
    expect(a.unverified).toEqual([]);
    expect(a.warnings).toEqual([]);
  });

  it('flags a cited id no tool returned', () => {
    const a = finish('[[corp-jira:PAY-101]] and [[corp-jira:PAY-999]] are late.', f(ledgerOf('corp-jira:PAY-101')));
    expect(a.unverified).toEqual(['corp-jira:PAY-999']);
    expect(a.warnings![0]).toMatch(/never returned: corp-jira:PAY-999/);
  });

  it('flags a bare OWI id and a bare tracker key the tools never returned, but not UTF-8', () => {
    const a = finish('See [[corp-jira:PAY-101]], corp-jira:PAY-404 and PAY-777, encoded in UTF-8.', f(ledgerOf('corp-jira:PAY-101')));
    expect(a.unverified).toEqual(['corp-jira:PAY-404', 'PAY-777']);
  });

  it('accepts a bare key the tools did return', () => {
    expect(finish('PAY-101 is fine, see [[corp-jira:PAY-101]].', f(ledgerOf('corp-jira:PAY-101'))).unverified).toEqual([]);
  });

  it('warns when an answer that read items cites none of them', () => {
    expect(finish('The sprint looks fine.', f(ledgerOf('corp-jira:PAY-101'))).warnings).toEqual([expect.stringMatching(/cites none/)]);
  });

  it('named() finds cited, bare and key mentions', () => {
    expect(named('[[a:B-1]] a:C-2 x:D-3 EF-4', new Set(['a']))).toEqual({ cited: ['a:B-1'], bare: ['a:C-2'], keys: ['EF-4'] });
  });

  it('holds back a half-written citation and a half-written proposal while streaming', () => {
    const p = partial('First [[corp-jira:PAY-101]].\n\nThen [[corp-jira:PA', { prompt: 'q', by: 'x' });
    expect(p.parts.map((x) => x.text)).toEqual(['First [[corp-jira:PAY-101]].', 'Then']);
    expect(partial('Text\n```proposal\n{"item":', { prompt: 'q', by: 'x' }).parts).toEqual([{ text: 'Text' }]);
  });
});

describe('proposals', () => {
  const writes = writeCommands(registry.commands);
  const ledger = new Ledger();
  ledger.add('corp-jira:PAY-107');
  const f = { toilProject: 'card-payments', prompt: 'q', by: 'Claude', ledger, writes };
  const block = (o: unknown) => `\n\n\`\`\`proposal\n${JSON.stringify(o)}\n\`\`\`\n`;

  it('become cards with a safe command line, the Toil project forced and allowWrite never taken from the model', () => {
    const a = finish(
      `Estimate [[corp-jira:PAY-107]].${block({ item: 'corp-jira:PAY-107', title: 'Estimate PAY-107', reason: 'No estimate on [[corp-jira:PAY-107]].', command: 'jira issue update', input: { key: 'PAY-107', field: ['Story Points=3'], toilProject: 'elsewhere', allowWrite: true }, note: null })}`,
      f,
    );
    expect(a.parts.map((p) => p.text)).toEqual(['Estimate [[corp-jira:PAY-107]].']);
    expect(a.proposals).toHaveLength(1);
    const p = a.proposals[0]!;
    expect(p).toMatchObject({ from: 'agent', item: 'corp-jira:PAY-107', command: 'jira issue update', input: { toilProject: 'card-payments', key: 'PAY-107', field: ['Story Points=3'] } });
    expect(p.input).not.toHaveProperty('allowWrite');
    expect(commandLine(p, 'posix').line).toBe("toil jira issue update 'PAY-107' --toil-project 'card-payments' --field 'Story Points=3' --allow-write");
  });

  it("name a command toil doesn't have as having none, rather than inventing one", () => {
    const a = finish(block({ item: 'corp-jira:PAY-107', title: 'Delete it', reason: '', command: 'jira delete-everything', input: {} }), f);
    expect(a.proposals[0]).toMatchObject({ command: null, input: null });
    expect(a.proposals[0]!.note).toMatch(/no write command "jira delete-everything"/);
  });

  it("show no command line when the input doesn't fit the command's fields, and say why", () => {
    const a = finish(block({ item: 'corp-jira:PAY-107', title: 'Parent it', reason: '', command: 'jira issue update', input: { key: 'PAY-107', fields: { parent: 'PAY-100' } } }), f);
    expect(a.proposals[0]).toMatchObject({ command: null, input: null });
    expect(a.proposals[0]!.note).toMatch(/doesn't fit toil jira issue update, which has no --fields/);
    const missing = finish(block({ item: 'corp-jira:PAY-107', title: 'x', reason: '', command: 'jira issue update', input: { summary: 'y' } }), f);
    expect(missing.proposals[0]!.note).toMatch(/needs <key>/);
  });

  it('proposal_fields reads a write command\'s fields from the registry and runs nothing', async () => {
    const t = proposalTool(registry.commands);
    const r = (await t.run({ command: 'jira issue update' })) as { fields: Record<string, unknown>; required: string[] };
    expect(Object.keys(r.fields)).toEqual(expect.arrayContaining(['key', 'field', 'summary']));
    expect(r.fields).not.toHaveProperty('allowWrite');
    expect(r.required).toEqual(['key']);
    expect(((await t.run({ command: 'jira issue search' })) as { error: string }).error).toMatch(/no write command/);
  });

  it('flag a proposal for an item no tool returned, and drop one that is not JSON', () => {
    const a = finish(`${block({ item: 'corp-jira:PAY-1', title: 'Move it', reason: '', command: null, input: null })}\n\`\`\`proposal\nnot json\n\`\`\``, f);
    expect(a.unverified).toContain('corp-jira:PAY-1');
    expect(a.warnings!.some((w) => /wasn't JSON/.test(w))).toBe(true);
  });
});

// ---------------------------------------------------------------- stubbed SDKs

interface Script {
  /** Tool calls the "model" makes, in order. */
  calls: Array<{ name: string; input: Record<string, unknown> }>;
  /** The answer, streamed in these chunks. */
  chunks: string[];
}

/** The Claude Agent SDK, stubbed: it records the options, runs the scripted tool calls through the MCP server's handlers, and streams. */
function claudeStub(script: Script) {
  const seen: { options?: Record<string, unknown>; tools: string[]; results: unknown[] } = { tools: [], results: [] };
  const module = {
    tool: (name: string, description: string, shape: unknown, handler: (a: Record<string, unknown>) => Promise<unknown>) => ({ name, description, shape, handler }),
    createSdkMcpServer: (o: { name: string; tools: Array<{ name: string; handler: (a: Record<string, unknown>) => Promise<unknown> }> }) => ({ type: 'sdk', name: o.name, tools: o.tools }),
    query: ({ options }: { prompt: string; options: Record<string, unknown> }) => {
      seen.options = options;
      const server = (options.mcpServers as Record<string, { tools: Array<{ name: string; handler: (a: Record<string, unknown>) => Promise<unknown> }> }>).toil_ui!;
      seen.tools = server.tools.map((t) => t.name);
      return (async function* () {
        for (const c of script.calls) {
          const t = server.tools.find((x) => x.name === c.name);
          // A tool the server doesn't have is one the model can't call.
          seen.results.push(t ? await t.handler(c.input) : { refused: c.name });
        }
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } };
        for (const text of script.chunks) yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } };
        yield { type: 'result', subtype: 'success', result: script.chunks.join('') };
      })();
    },
  };
  return { module, seen };
}

function copilotStub(script: Script) {
  const seen: { client?: Record<string, unknown>; session?: Record<string, unknown>; stopped: boolean } = { stopped: false };
  class CopilotClient {
    constructor(o: Record<string, unknown>) {
      seen.client = o;
    }
    async start() {}
    async stop() {
      seen.stopped = true;
      return [];
    }
    async createSession(config: Record<string, unknown>) {
      seen.session = config;
      const handlers = new Map<string, Array<(e: { data: Record<string, unknown> }) => void>>();
      const emit = (name: string, data: Record<string, unknown>) => (handlers.get(name) ?? []).forEach((h) => h({ data }));
      return {
        on: (name: string, h: (e: { data: Record<string, unknown> }) => void) => (handlers.set(name, [...(handlers.get(name) ?? []), h]), () => {}),
        async sendAndWait() {
          const tools = config.tools as Array<{ name: string; handler: (a: Record<string, unknown>) => Promise<unknown> }>;
          for (const c of script.calls) await tools.find((t) => t.name === c.name)?.handler(c.input);
          emit('assistant.message_start', {});
          for (const deltaContent of script.chunks) {
            emit('assistant.message_delta', { deltaContent });
            await new Promise((r) => setTimeout(r, 0));
          }
          return { data: { content: script.chunks.join('') } };
        },
        abort: async () => {},
        disconnect: async () => {},
      };
    }
  }
  return {
    module: { CopilotClient, RuntimeConnection: { forStdio: (o: { path: string }) => ({ kind: 'stdio', ...o }) }, defineTool: (name: string, c: Record<string, unknown>) => ({ name, ...c }) },
    seen,
  };
}

/** The Codex SDK, stubbed: it calls the served MCP tools over the real loopback grant, through answerMcp, with the token from its env. */
function codexStub(script: Script, grants: McpGrants) {
  const seen: { options?: Record<string, unknown>; thread?: Record<string, unknown>; listed: string[]; input?: string } = { listed: [] };
  class Codex {
    constructor(o: Record<string, unknown>) {
      seen.options = o;
    }
    startThread(t: Record<string, unknown>) {
      seen.thread = t;
      return {
        runStreamed: async (input: string) => ((seen.input = input), {
          events: (async function* () {
            const env = seen.options!.env as Record<string, string>;
            const tools = grants.tools(`Bearer ${env[TOKEN_ENV]}`)!;
            const list = (await answerMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, tools, 't')) as { result: { tools: Array<{ name: string }> } };
            seen.listed = list.result.tools.map((x) => x.name);
            for (const [i, c] of script.calls.entries()) await answerMcp({ jsonrpc: '2.0', id: i + 2, method: 'tools/call', params: { name: c.name, arguments: c.input } }, tools, 't');
            let text = '';
            for (const chunk of script.chunks) {
              text += chunk;
              yield { type: 'item.updated', item: { type: 'agent_message', text } };
            }
            yield { type: 'item.completed', item: { type: 'agent_message', text } };
            yield { type: 'turn.completed', usage: {} };
          })(),
        }),
      };
    }
  }
  return { module: { Codex }, seen };
}

const SCRIPT: Script = {
  calls: [
    { name: 'owi_get', input: { id: 'corp-jira:PAY-107' } },
    { name: 'jira_issue_update', input: { key: 'PAY-107', field: ['Story Points=3'] } },
    { name: 'jira_issue_search', input: { jql: 'project = PAY' } },
  ],
  chunks: [
    '[[corp-jira:PAY-107]] has no estimate',
    ', and [[corp-jira:PAY-999]] is invented.',
    '\n\n```proposal\n{"item":"corp-jira:PAY-107","title":"Estimate PAY-107","reason":"Unestimated.","command":"jira issue update","input":{"key":"PAY-107","field":["Story Points=3"]},"note":null}\n```',
  ],
};

const FAKE_CLI: Record<string, string> = { claude: '/usr/bin/claude', copilot: '/usr/bin/copilot', codex: '/usr/bin/codex' };

/** A Codex home of the user's own, signed in with a file, in the throwaway folder. */
function userCodex(): string {
  const home = mkdtempSync(join(folder, 'user-codex-'));
  writeFileSync(join(home, 'auth.json'), '{"auth_mode":"chatgpt"}\n');
  return home;
}

function hostFor(adapter: 'claude' | 'copilot' | 'codex', module: unknown, over: Partial<AgentHostOptions> = {}) {
  const dataDir = mkdtempSync(join(folder, `host-${adapter}-`));
  writeFileSync(agentSettingsFile(dataDir), JSON.stringify({ adapter, model: 'test-model', cliPath: null, endpoint: adapter === 'claude' ? 'bedrock' : null }));
  const rec = recordingExecute();
  const grants = new McpGrants(() => 'http://127.0.0.1:1/api/agent/mcp');
  const hostEnv: Record<string, string> = { PATH: '/usr/bin', HOME: '/home/you', TOIL_JIRA_TOKEN: 'toil-secret', GITHUB_TOKEN: 'gh-secret', SYSTEM_ACCESSTOKEN: 'ci-secret', ANTHROPIC_API_KEY: 'claude-own', OPENAI_API_KEY: 'codex-own', COPILOT_GITHUB_TOKEN: 'copilot-own', HTTPS_PROXY: 'http://proxy.imagile.dev:8080', CODEX_HOME: userCodex() };
  const importer: Importer = async (spec) => {
    if (spec === 'zod') return zod;
    if (spec.startsWith(`@${adapter === 'claude' ? 'anthropic-ai' : adapter === 'copilot' ? 'github' : 'openai'}/`)) return module;
    throw Object.assign(new Error(`Cannot find package '${spec}'`), { code: 'ERR_MODULE_NOT_FOUND' });
  };
  const host = new AgentHost({
    dataDir,
    version: 't',
    data: (d) => (d === 'card-payments' ? data : null),
    registry: registry.commands,
    execute: rec.execute,
    mapIds: () => [],
    serveTools: (tools) => grants.serve(tools),
    fallback: noAgent(),
    env: hostEnv,
    cwd: '/work',
    platform: 'linux',
    importer,
    installed: () => true,
    isFile: (p) => Object.values(FAKE_CLI).includes(p),
    now: () => FIXTURE_NOW,
    // Codex's home is the throwaway one above, never this machine's own.
    runtimes: [claudeRuntime('t'), copilotRuntime(), codexRuntime()],
    ...over,
  });
  return { host, rec, grants, dataDir, env: hostEnv };
}

async function streamed(host: AgentHost, prompt = 'hygiene') {
  const versions = [];
  for await (const a of host.stream(ctx(), 'card-payments', prompt)) versions.push(a);
  return versions;
}

/** What every adapter must do with the same script: stream, read the cache, refuse the write tool, flag the invented id, and propose (never run) the write. */
function expectTheRules(versions: Awaited<ReturnType<typeof streamed>>, rec: ReturnType<typeof recordingExecute>) {
  expect(versions.length).toBeGreaterThan(2);
  const last = versions.at(-1)!;
  // Streaming: the first says the agent is thinking, before any text; then the versions grow, carry no proposals, and the last is the checked answer.
  expect(versions[0]).toMatchObject({ parts: [], activity: { phase: 'thinking' } });
  expect(versions.find((v) => v.parts.length)!.parts[0]!.text).toBe('[[corp-jira:PAY-107]] has no estimate');
  // The status line (#343): the cache read and the live read each named as they ran, then writing.
  expect(versions.filter((v) => v.activity?.phase === 'tool').map((v) => v.activity)).toEqual(expect.arrayContaining([{ phase: 'tool', tool: 'jira issue search', source: 'live' }]));
  expect(versions.some((v) => v.activity?.phase === 'tool' && v.activity.source === 'cache')).toBe(true);
  expect(versions.some((v) => v.activity?.phase === 'writing')).toBe(true);
  expect(last.activity).toBeUndefined();
  expect(versions.slice(0, -1).every((v) => v.proposals.length === 0)).toBe(true);
  expect(last.prompt).toBe('Backlog hygiene');
  expect(last.unverified).toEqual(['corp-jira:PAY-999']);
  expect(last.proposals.map((p) => p.command)).toEqual(['jira issue update']);
  // Nothing wrote: the one toil call was the live read, read-only; the proposal's command never ran.
  expect(rec.calls.map((c) => c.command)).toEqual(['jira issue search']);
  expect(rec.calls.every((c) => c.options.readOnly === true)).toBe(true);
}

describe('the Claude adapter, on a stubbed SDK', () => {
  it('runs the CLI it found, with no built-in tools, only the read tools, and the chosen endpoint', async () => {
    const stub = claudeStub(SCRIPT);
    const { host, rec } = hostFor('claude', stub.module);
    const versions = await streamed(host);
    expectTheRules(versions, rec);
    const o = stub.seen.options!;
    expect(o.pathToClaudeCodeExecutable).toBe('/usr/bin/claude');
    expect(o.model).toBe('test-model');
    expect(o.tools).toEqual([]);
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.permissionMode).toBe('dontAsk');
    expect(o.persistSession).toBe(false);
    expect(stub.seen.tools).not.toContain('jira_issue_update');
    expect(o.allowedTools).toEqual(stub.seen.tools.map(claudeToolName));
    expect((o.env as Record<string, string>).CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(stub.seen.results[1]).toEqual({ refused: 'jira_issue_update' });
    expect(o).not.toHaveProperty('canUseTool');
    expect(versions.at(-1)!.by).toBe('Claude (test-model)');
  });

  it('treats a result marked is_error (a failed sign-in) as a failure, not an answer', async () => {
    const module = {
      ...claudeStub(SCRIPT).module,
      query: () =>
        (async function* () {
          yield { type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' };
        })(),
    };
    const { host } = hostFor('claude', module);
    await expect(host.ask(ctx(), 'card-payments', 'q')).rejects.toThrow('Claude failed: Claude Code answered with an error: Failed to authenticate: OAuth session expired and could not be refreshed');
  });

  it('turns each endpoint into Claude Code\'s own switch, and the Anthropic API into none', () => {
    expect(claudeEnv({ CLAUDE_CODE_USE_VERTEX: '1' }, 'foundry', 'v')).toMatchObject({ CLAUDE_CODE_USE_FOUNDRY: '1', CLAUDE_AGENT_SDK_CLIENT_APP: 'toil-ui/v' });
    expect(claudeEnv({ CLAUDE_CODE_USE_VERTEX: '1' }, 'foundry', 'v')).not.toHaveProperty('CLAUDE_CODE_USE_VERTEX');
    const api = claudeEnv({}, 'anthropic', 'v');
    expect(Object.keys(api).filter((k) => k.startsWith('CLAUDE_CODE_USE_'))).toEqual([]);
  });

  it('builds zod shapes the SDK takes from the tools\' JSON Schemas', () => {
    const search = liveTools('d', registry.commands, recordingExecute().execute, () => [], new Ledger()).find((t) => t.name === 'jira_issue_search')!;
    const shape = zodShape(zod as never, search.inputSchema) as unknown as Record<string, zod.ZodType>;
    const object = zod.object(shape);
    expect(object.safeParse({ jql: 'project = PAY', limit: 5 }).success).toBe(true);
    expect(object.safeParse({ limit: 'five' }).success).toBe(true);
    expect(object.safeParse({ limit: true }).success).toBe(false);
    expect(object.safeParse({ jql: 5 }).success).toBe(false);
    const query = cacheTools('d', data, new Ledger())[0]!;
    expect(zod.object(zodShape(zod as never, query.inputSchema) as never).safeParse({ statusCategory: 'NOPE' }).success).toBe(false);
  });
});

describe('the Copilot adapter, on a stubbed SDK', () => {
  it('starts the CLI it found over stdio, with only the read tools available and every permission request rejected', async () => {
    const stub = copilotStub(SCRIPT);
    const { host, rec } = hostFor('copilot', stub.module);
    expectTheRules(await streamed(host), rec);
    expect(stub.seen.client!.connection).toMatchObject({ kind: 'stdio', path: '/usr/bin/copilot' });
    expect(stub.seen.client).not.toHaveProperty('env');
    const s = stub.seen.session!;
    const names = (s.tools as Array<{ name: string; skipPermission: boolean }>).map((t) => t.name);
    expect(names).not.toContain('jira_issue_update');
    expect(s.availableTools).toEqual(names.map((n) => `custom:${n}`));
    expect((s.systemMessage as { mode: string }).mode).toBe('replace');
    expect((s.onPermissionRequest as () => { kind: string })().kind).toBe('reject');
    expect(stub.seen.stopped).toBe(true);
  });
});

describe('the Codex adapter, on a stubbed SDK', () => {
  it('serves the read tools over MCP for the run only, with the token in its env, and switches the rest of Codex off', async () => {
    const holder = new McpGrants(() => 'http://127.0.0.1:1/api/agent/mcp');
    const stub = codexStub(SCRIPT, holder);
    const { host, rec } = hostFor('codex', stub.module, { serveTools: (tools) => holder.serve(tools) });
    expectTheRules(await streamed(host), rec);
    const o = stub.seen.options!;
    expect(o.codexPathOverride).toBe('/usr/bin/codex');
    expect(o.configOverrides).toEqual(codexOverrides('http://127.0.0.1:1/api/agent/mcp'));
    expect((o.configOverrides as string[])[0]).toBe('mcp_servers={ toil_ui = { url = "http://127.0.0.1:1/api/agent/mcp", bearer_token_env_var = "TOIL_UI_MCP_TOKEN" } }');
    expect(CODEX_FEATURES_OFF).toEqual(expect.arrayContaining(['shell_tool', 'unified_exec', 'apps', 'plugins']));
    expect(JSON.stringify(o.configOverrides)).not.toContain((o.env as Record<string, string>)[TOKEN_ENV]);
    expect(stub.seen.thread).toMatchObject({ sandboxMode: 'read-only', approvalPolicy: 'never', webSearchMode: 'disabled', model: 'test-model' });
    expect(stub.seen.listed).not.toContain('jira_issue_update');
    // The grant ended with the run.
    expect(holder.size).toBe(0);
  });
});

describe('the composed prompt, on every adapter (#283)', () => {
  const style = { theme: 'crate', voice: true };
  const saved = { instructions: 'Answer in British English.', voice: null };
  const expected = systemPrompt('card-payments', FIXTURE_NOW, { voice: THEME_VOICES.get('crate')!.voice!, instructions: 'Answer in British English.' });

  async function systemOf(adapter: 'claude' | 'copilot' | 'codex', withStyle: typeof style | null): Promise<string> {
    const holder = new McpGrants(() => 'http://127.0.0.1:1/api/agent/mcp');
    const stub = adapter === 'claude' ? claudeStub(SCRIPT) : adapter === 'copilot' ? copilotStub(SCRIPT) : codexStub(SCRIPT, holder);
    const { host, dataDir } = hostFor(adapter, stub.module, adapter === 'codex' ? { serveTools: (tools) => holder.serve(tools) } : {});
    host.save({ ...host.status().settings, ...saved });
    expect(JSON.parse(readFileSync(agentSettingsFile(dataDir), 'utf8'))).toMatchObject(saved);
    for await (const _ of host.stream(ctx(), 'card-payments', 'hygiene', withStyle)) void _;
    if (adapter === 'claude') return (stub as ReturnType<typeof claudeStub>).seen.options!.systemPrompt as string;
    if (adapter === 'copilot') return ((stub as ReturnType<typeof copilotStub>).seen.session!.systemMessage as { content: string }).content;
    // Codex takes no separate system prompt, so Toil UI's goes first in the turn.
    const input = (stub as ReturnType<typeof codexStub>).seen.input!;
    expect(input.endsWith(`\n\nQuestion:\n${STARTERS.find((q) => q.id === 'hygiene')!.prompt('card-payments')}`)).toBe(true);
    return input.slice(0, input.indexOf('\n\nQuestion:\n'));
  }

  it.each(['claude', 'copilot', 'codex'] as const)('%s is sent the rules, then Crate\'s voice, then the instructions', async (adapter) => {
    const sent = await systemOf(adapter, style);
    expect(sent).toBe(expected);
    expect(sent).toBe(host0().systemPrompt('card-payments', style));
    expect(sent).toContain(STYLE_RULE);
  });

  it.each(['claude', 'copilot', 'codex'] as const)('%s is sent the rules and the instructions alone with the voice off', async (adapter) => {
    expect(await systemOf(adapter, { theme: 'crate', voice: false })).toBe(systemPrompt('card-payments', FIXTURE_NOW, { voice: null, instructions: 'Answer in British English.' }));
  });

  /** A host with the same saved words, for the prompt Settings shows. */
  function host0() {
    const { host } = hostFor('claude', claudeStub(SCRIPT).module);
    host.save({ ...host.status().settings, ...saved });
    return host;
  }
});

describe('the MCP endpoint\'s protocol', () => {
  it('initializes, lists, calls, and refuses a tool it lacks', async () => {
    const tools = cacheTools('card-payments', data, new Ledger());
    const init = (await answerMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, tools, 'v')) as { result: { protocolVersion: string; capabilities: object } };
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(await answerMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, tools, 'v')).toBeNull();
    const call = (await answerMcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'owi_get', arguments: { id: 'corp-jira:PAY-101' } } }, tools, 'v')) as { result: { content: Array<{ text: string }> } };
    expect(call.result.content[0]!.text).toContain('corp-jira:PAY-101');
    const refused = (await answerMcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'jira_issue_update', arguments: {} } }, tools, 'v')) as { error: { message: string } };
    expect(refused.error.message).toMatch(/only its read tools/);
  });

  it('knows a grant only by its exact bearer token, and forgets it on close', () => {
    const grants = new McpGrants(() => 'u');
    const served = grants.serve([]);
    expect(grants.tools(`Bearer ${served.token}`)).toEqual([]);
    expect(grants.tools(`Bearer ${served.token}x`)).toBeUndefined();
    expect(grants.tools(served.token)).toBeUndefined();
    served.close();
    expect(grants.tools(`Bearer ${served.token}`)).toBeUndefined();
  });
});

describe('when an adapter cannot run', () => {
  it('names the package when the SDK is not installed', async () => {
    const { host } = hostFor('claude', null, { importer: async (s) => Promise.reject(Object.assign(new Error(`Cannot find package '${s}'`), { code: 'ERR_MODULE_NOT_FOUND' })) });
    await expect(host.ask(ctx(), 'card-payments', 'hygiene')).rejects.toThrow(/needs @anthropic-ai\/claude-agent-sdk, which isn't installed/);
    await expect(loadSdk({ label: 'Codex', package: '@openai/codex-sdk' }, async () => Promise.reject(Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' })))).rejects.toBeInstanceOf(AgentError);
  });

  it('says plainly when the CLI is not on PATH, and never downloads one', async () => {
    const { host } = hostFor('codex', codexStub(SCRIPT, new McpGrants(() => '')).module, { isFile: () => false });
    const e = await host.ask(ctx(), 'card-payments', 'hygiene').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AgentError);
    expect((e as AgentError).message).toBe('Toil UI found no codex on PATH, so it can\'t start the Codex CLI. It never downloads one.');
    expect((e as AgentError).fix).toMatch(/set its path in Settings/);
  });

  it('says so when the Toil project never synced', async () => {
    const { host } = hostFor('claude', claudeStub(SCRIPT).module);
    await expect(host.ask(ctx(), 'never-synced', 'q')).rejects.toThrow(/hasn't synced never-synced/);
  });

  it('with no adapter chosen, names the three, and still offers the starters a switched chat can ask (#344)', async () => {
    const dataDir = mkdtempSync(join(folder, 'host-none-'));
    const host = new AgentHost({ dataDir, version: 't', data: () => data, registry: registry.commands, execute: recordingExecute().execute, mapIds: () => [], serveTools: () => ({ url: '', token: '', close() {} }), fallback: noAgent(), installed: () => false, isFile: () => false, env: {}, platform: 'linux' });
    expect(host.kind).toBe('none');
    expect((await host.starters(ctx(), 'card-payments')).length).toBe(10);
    const e = (await host.ask(ctx(), 'card-payments', 'q').catch((x: unknown) => x)) as AgentError;
    expect(e.message).toContain('No agent is set up');
    for (const p of ['@anthropic-ai/claude-agent-sdk', '@github/copilot-sdk', '@openai/codex-sdk']) expect(e.fix).toContain(p);
    const status = host.status();
    expect(status.adapters.map((a) => [a.name, a.installed, a.cli.path])).toEqual([
      ['claude', false, null],
      ['copilot', false, null],
      ['codex', false, null],
    ]);
  });

  it('offers the ten starters, each scoped to the Toil project, once an adapter is chosen', async () => {
    const { host } = hostFor('claude', claudeStub(SCRIPT).module);
    expect((await host.starters(ctx(), 'card-payments')).map((s) => s.label)).toEqual(['Stand-up digest', 'Why is this sprint at risk?', 'Backlog hygiene', 'Dependency risk', "What's stuck in review, and why?", 'What happened yesterday?', "Who's overloaded or blocked?", 'Prepare my 1:1 notes for <person>', 'Which items are ready for an agent?', 'Release notes']);
    for (const s of STARTERS) expect(s.prompt('card-payments')).toContain('"card-payments"');
  });
});

describe('finding the CLI', () => {
  const look = (over: Partial<Parameters<typeof findCli>[0]>) => findCli({ label: 'Claude Code', command: 'claude', env: {}, platform: 'linux', isFile: () => false, cwd: '/work', path: posix, ...over });

  it('skips relative PATH entries and the working directory, as git does, but not a home inside it', () => {
    const planted = (p: string) => p.endsWith('/claude');
    expect(look({ env: { PATH: '.:bin:/work:/work/node_modules/.bin:/usr/bin' }, isFile: planted })).toBe('/usr/bin/claude');
    expect(() => look({ env: { PATH: '.:bin:/work/tools' }, isFile: planted })).toThrow(/found no claude on PATH/);
    // A home inside the working directory stays searchable, as git's rule has it; the working directory itself never is.
    expect(look({ cwd: '/home', home: '/home/you', env: { PATH: '/home:/home/you/.local/bin' }, isFile: planted })).toBe('/home/you/.local/bin/claude');
    const exe = win32.join('C:\\tools', 'claude.exe');
    expect(look({ platform: 'win32', path: win32, cwd: 'C:\\repo', env: { Path: '.;C:\\repo;C:\\REPO\\bin;C:\\tools' }, isFile: (p) => p.toLowerCase().endsWith('claude.exe') })).toBe(exe);
  });

  it('takes the configured path first, and refuses one that is missing or relative', () => {
    expect(look({ configured: '/opt/claude/bin/claude', isFile: (p) => p === '/opt/claude/bin/claude', env: { PATH: '/usr/bin' } })).toBe('/opt/claude/bin/claude');
    expect(() => look({ configured: '/opt/nope/claude' })).toThrow("Claude Code isn't at /opt/nope/claude, the path set in Settings.");
    expect(() => look({ configured: 'claude' })).toThrow(/isn't an absolute path/);
  });

  it('searches PATH in order on POSIX', () => {
    expect(look({ env: { PATH: '/a:/b' }, isFile: (p) => p === posix.join('/b', 'claude'), path: posix })).toBe('/b/claude');
  });

  it('prefers a .exe on Windows, and calls a .cmd shim a shim, with the fix', () => {
    const exe = win32.join('C:\\tools', 'claude.exe');
    expect(look({ platform: 'win32', env: { Path: 'C:\\shims;C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' }, isFile: (p) => p === exe || p === win32.join('C:\\shims', 'claude.cmd'), path: win32 })).toBe(exe);
    expect(() => look({ platform: 'win32', env: { Path: 'C:\\shims' }, isFile: (p) => p === win32.join('C:\\shims', 'claude.cmd'), path: win32 })).toThrow(/Windows command shim the SDK can't start/);
    expect(() => look({ platform: 'win32', env: { Path: 'C:\\shims' }, isFile: (p) => p === win32.join('C:\\shims', 'claude.cmd'), path: win32 })).toThrow(expect.objectContaining({ fix: 'Set the CLI path in Settings to the claude executable itself (claude.exe).' }));
  });
});

describe('the agent settings', () => {
  it('are saved in the data folder, never toil\'s, and hold no secret', () => {
    const { host, dataDir } = hostFor('claude', claudeStub(SCRIPT).module);
    host.save({ adapter: 'codex', model: 'gpt-5', cliPath: null, endpoint: null });
    expect(agentSettingsFile(dataDir)).toBe(join(dataDir, 'agent.json'));
    expect(JSON.parse(readFileSync(agentSettingsFile(dataDir), 'utf8'))).toEqual({ adapter: 'codex', model: 'gpt-5', cliPath: null, endpoint: null, instructions: null, voice: null, models: { codex: 'gpt-5' }, cliPaths: {} });
    expect(loadAgentSettings(dataDir).adapter).toBe('codex');
    expect(host.kind).toBe('codex');
  });

  it('refuse a key, an endpoint for anything but Claude, a relative CLI path and an unknown adapter', () => {
    expect(() => checkAgentSettings({ adapter: 'claude', apiKey: 'sk-x' })).toThrow(/have no "apiKey"/);
    expect(() => checkAgentSettings({ adapter: 'codex', endpoint: 'bedrock' })).toThrow(/Only the Claude adapter takes an endpoint/);
    expect(() => checkAgentSettings({ adapter: 'claude', cliPath: 'bin/claude' }, posix.isAbsolute)).toThrow(/absolute path/);
    expect(() => checkAgentSettings({ adapter: 'gemini' })).toThrow(/no adapter "gemini"/);
    expect(checkAgentSettings({ adapter: 'claude', model: ' ', endpoint: '' })).toEqual({ adapter: 'claude', model: null, cliPath: null, endpoint: null, instructions: null, voice: null, models: {}, cliPaths: {} });
  });

  it("keep the person's instructions and custom voice as plain text, up to 4,000 characters each (#283)", () => {
    expect(checkAgentSettings({ adapter: 'none', instructions: '  Answer in British English.\r\nLead with risks.  ', voice: '' })).toMatchObject({ instructions: 'Answer in British English.\nLead with risks.', voice: null });
    expect(checkAgentSettings({ voice: 'x'.repeat(4000) }).voice).toHaveLength(4000);
    expect(() => checkAgentSettings({ instructions: 'x'.repeat(4001) })).toThrow(/at most 4000 characters, and is 4001/);
    expect(() => checkAgentSettings({ voice: 42 })).toThrow(/custom voice must be text/);
    expect(() => checkAgentSettings({ instructions: 'hidden\u0000text' })).toThrow(/control or invisible character/);
    expect(() => checkAgentSettings({ voice: 'quiet\u202Ereversed' })).toThrow(/invisible/);
    expect(() => checkAgentSettings({ voice: 'zero\u200Bwidth' })).toThrow(/invisible/);
    expect(checkAgentSettings({ instructions: 'tabs\tand\nlines, and é' }).instructions).toBe('tabs\tand\nlines, and é');
    // An agent.json from before #283 has neither, and loads with both empty.
    const dataDir = mkdtempSync(join(folder, 'old-'));
    writeFileSync(agentSettingsFile(dataDir), JSON.stringify({ adapter: 'codex', model: null, cliPath: null, endpoint: null }));
    expect(loadAgentSettings(dataDir)).toMatchObject({ adapter: 'codex', instructions: null, voice: null });
  });

  it('a broken file leaves the agent unset and says which file and why', () => {
    const dataDir = mkdtempSync(join(folder, 'broken-'));
    writeFileSync(agentSettingsFile(dataDir), '{ nope');
    const host = new AgentHost({ dataDir, version: 't', data: () => data, registry: registry.commands, execute: recordingExecute().execute, mapIds: () => [], serveTools: () => ({ url: '', token: '', close() {} }), fallback: noAgent() });
    expect(host.kind).toBe('none');
    expect(host.status().problem).toMatch(/agent\.json can't be used/);
  });
});

describe("the agent CLI's environment", () => {
  const leaked = (env: Record<string, unknown>) => ['TOIL_JIRA_TOKEN', 'GITHUB_TOKEN', 'SYSTEM_ACCESSTOKEN'].filter((k) => k in env);

  it('passes USER through the Claude SDK so its CLI can find the macOS sign-in (#489)', async () => {
    const claude = claudeStub(SCRIPT);
    const { host, env } = hostFor('claude', claude.module, { platform: 'darwin' });
    env.USER = 'you';
    await streamed(host);
    expect(claude.seen.options!.env).toMatchObject({ USER: 'you', HOME: '/home/you' });
    expect(leaked(claude.seen.options!.env as Record<string, string>)).toEqual([]);
  });

  it.each(['claude', 'copilot', 'codex'] as const)('preserves only the exact USER identity variable for %s', (adapter) => {
    expect(agentEnv({ USER: 'you', USER_TOKEN: 'secret', TOIL_JIRA_TOKEN: 'secret', GITHUB_TOKEN: 'secret' }, adapter)).toEqual({ USER: 'you' });
    expect(agentEnv({ USER: undefined }, adapter)).toEqual({});
  });

  it('is an allowlist per adapter: toil and CI tokens never reach any CLI, each CLI keeps its own sign-in', async () => {
    const claude = claudeStub(SCRIPT);
    await streamed(hostFor('claude', claude.module).host);
    const c = claude.seen.options!.env as Record<string, string>;
    expect(leaked(c)).toEqual([]);
    expect(c).toMatchObject({ PATH: '/usr/bin', HOME: '/home/you', ANTHROPIC_API_KEY: 'claude-own', HTTPS_PROXY: 'http://proxy.imagile.dev:8080' });
    expect(c).not.toHaveProperty('OPENAI_API_KEY');

    const copilot = copilotStub(SCRIPT);
    await streamed(hostFor('copilot', copilot.module).host);
    const p = (copilot.seen.client!.connection as { env: Record<string, string> }).env;
    expect(leaked(p)).toEqual([]);
    expect(p).toEqual({ PATH: '/usr/bin', HOME: '/home/you', COPILOT_GITHUB_TOKEN: 'copilot-own', HTTPS_PROXY: 'http://proxy.imagile.dev:8080' });

    const holder = new McpGrants(() => 'http://127.0.0.1:1/api/agent/mcp');
    const codex = codexStub(SCRIPT, holder);
    await streamed(hostFor('codex', codex.module, { serveTools: (t) => holder.serve(t) }).host);
    const x = codex.seen.options!.env as Record<string, string>;
    expect(leaked(x)).toEqual([]);
    expect(Object.keys(x).sort()).toEqual(['CODEX_HOME', 'HOME', 'HTTPS_PROXY', 'OPENAI_API_KEY', 'PATH', TOKEN_ENV].sort());
  });

  it('agentEnv drops everything off the list', () => {
    expect(agentEnv({ PATH: '/bin', TOIL_CONFIG: '/x', GH_TOKEN: 'g', NPM_TOKEN: 'n', CODEX_HOME: '/c', ANTHROPIC_API_KEY: 'a' }, 'codex')).toEqual({ PATH: '/bin', CODEX_HOME: '/c' });
  });
});

describe('the run count', () => {
  it('is taken before the SDK loads and given back whatever fails, so a third question waits and a failed load frees its place', async () => {
    let release: (e: unknown) => void = () => {};
    const blocked = new Promise<never>((_, reject) => (release = reject));
    const { host } = hostFor('claude', null, { importer: () => blocked });
    const first = host.ask(ctx(), 'card-payments', 'q').catch((e: unknown) => e);
    const second = host.ask(ctx(), 'card-payments', 'q').catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 0));
    expect(host.active).toBe(2);
    await expect(host.ask(ctx(), 'card-payments', 'q')).rejects.toThrow('2 questions are already running.');
    release(Object.assign(new Error("Cannot find package '@anthropic-ai/claude-agent-sdk'"), { code: 'ERR_MODULE_NOT_FOUND' }));
    expect(await first).toBeInstanceOf(AgentError);
    expect(await second).toBeInstanceOf(AgentError);
    expect(host.active).toBe(0);
  });

  it('is given back after a CLI search fails, and after an answer', async () => {
    const missing = hostFor('codex', codexStub(SCRIPT, new McpGrants(() => '')).module, { isFile: () => false }).host;
    await missing.ask(ctx(), 'card-payments', 'q').catch(() => undefined);
    expect(missing.active).toBe(0);
    const { host } = hostFor('claude', claudeStub(SCRIPT).module);
    await host.ask(ctx(), 'card-payments', 'q');
    expect(host.active).toBe(0);
  });
});

describe('a CLI path in Settings', () => {
  it("must name the adapter's own CLI", () => {
    expect(checkAgentSettings({ adapter: 'claude', cliPath: '/opt/bin/claude' }, posix.isAbsolute, 'linux').cliPath).toBe('/opt/bin/claude');
    expect(() => checkAgentSettings({ adapter: 'claude', cliPath: '/bin/sh' }, posix.isAbsolute, 'linux')).toThrow('The CLI path must end in claude, the claude adapter\'s own CLI, not "sh".');
    expect(() => checkAgentSettings({ adapter: 'codex', cliPath: '/opt/bin/claude' }, posix.isAbsolute, 'linux')).toThrow(/must end in codex/);
    expect(() => checkAgentSettings({ adapter: 'claude', cliPath: '/opt/bin/claude.exe' }, posix.isAbsolute, 'linux')).toThrow(/must end in claude,/);
    expect(() => checkAgentSettings({ adapter: 'none', cliPath: '/opt/bin/claude' }, posix.isAbsolute, 'linux')).toThrow(/needs an adapter/);
  });

  it('takes .exe on Windows, in any case, but not a .cmd shim the SDKs cannot start', () => {
    for (const p of ['C:\\Tools\\codex.exe', 'C:\\Tools\\CODEX.EXE', 'C:\\Tools\\codex']) expect(checkAgentSettings({ adapter: 'codex', cliPath: p }, win32.isAbsolute, 'win32').cliPath).toBe(p);
    for (const p of ['C:\\Windows\\System32\\cmd.exe', 'C:\\Tools\\codex.cmd']) expect(() => checkAgentSettings({ adapter: 'codex', cliPath: p }, win32.isAbsolute, 'win32')).toThrow(/must end in codex or codex.exe,/);
  });

  it('must be on a local drive on Windows: network, device and rootless paths are refused', () => {
    for (const p of ['C:/Tools/codex.exe', 'd:\\codex.exe']) expect(checkAgentSettings({ adapter: 'codex', cliPath: p }, win32.isAbsolute, 'win32').cliPath).toBe(p);
    for (const p of ['\\\\host\\share\\codex.exe', '//host/share/codex.exe', '\\/host/share/codex.exe', '\\\\?\\C:\\Tools\\codex.exe', '\\\\.\\C:\\Tools\\codex.exe', '\\??\\C:\\Tools\\codex.exe', '\\Tools\\codex.exe']) {
      expect(() => checkAgentSettings({ adapter: 'codex', cliPath: p }, win32.isAbsolute, 'win32'), p).toThrow(/must (be on a local drive|be an absolute path)/);
    }
    // Elsewhere a leading // is an ordinary absolute path, and nothing is contacted.
    expect(checkAgentSettings({ adapter: 'codex', cliPath: '/opt/bin/codex' }, posix.isAbsolute, 'linux').cliPath).toBe('/opt/bin/codex');
  });
});

describe('Latest', () => {
  it('yields the newest value, then ends or throws', async () => {
    const l = new Latest<number>();
    l.push(1);
    l.push(2);
    l.end();
    const seen = [];
    for await (const v of l) seen.push(v);
    expect(seen).toEqual([2]);
    const bad = new Latest<number>();
    bad.end(new Error('boom'));
    await expect((async () => {
      for await (const _ of bad) void _;
    })()).rejects.toThrow('boom');
  });
});

// Unused runtimes are still constructed, so their names stay in step with the settings.
it('the three runtimes are the three adapters the settings name', () => {
  const runtimes: Runtime[] = [claudeRuntime('t'), copilotRuntime(), codexRuntime()];
  expect(runtimes.map((r) => [r.name, r.package, r.command])).toEqual([
    ['claude', '@anthropic-ai/claude-agent-sdk', 'claude'],
    ['copilot', '@github/copilot-sdk', 'copilot'],
    ['codex', '@openai/codex-sdk', 'codex'],
  ]);
});

describe('the assignee a tool reports', () => {
  it('is the person\'s login when the tracker gives no name, as GitHub does, and filters on it', async () => {
    const github = cacheData(cache, 'checkout-web')!;
    const assigned = github.items().filter((i) => i.assignee);
    expect(assigned.length).toBeGreaterThan(0);
    const tools = cacheTools('checkout-web', github, new Ledger());
    const all = (await tool(tools, 'owi_query').run({ limit: 50 })) as { items: Array<{ id: string; assignee: string | null }> };
    for (const item of assigned) {
      const expected = item.assignee!.name ?? item.assignee!.id;
      expect(all.items.find((i) => i.id === item.id)?.assignee).toBe(expected);
    }
    const one = assigned[0]!;
    const login = one.assignee!.name ?? one.assignee!.id;
    const filtered = (await tool(tools, 'owi_query').run({ assignee: login, limit: 50 })) as { items: Array<{ id: string }> };
    expect(filtered.items.map((i) => i.id)).toContain(one.id);
  });
});

describe("Toil UI's own Codex home (#300)", () => {
  const sameFile = (a: string, b: string) => statSync(a, { bigint: true }).ino === statSync(b, { bigint: true }).ino;

  it("is where Codex runs: its own config.toml, and auth.json linked to the user's, not copied", async () => {
    const holder = new McpGrants(() => 'http://127.0.0.1:1/api/agent/mcp');
    const stub = codexStub(SCRIPT, holder);
    const { host, dataDir, env: given } = hostFor('codex', stub.module, { serveTools: (tools) => holder.serve(tools) });
    await streamed(host);
    const env = stub.seen.options!.env as Record<string, string>;
    const home = toilCodexHome(dataDir);
    expect(env.CODEX_HOME).toBe(home);
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(TOIL_CODEX_CONFIG);
    const theirs = join(given.CODEX_HOME!, 'auth.json');
    expect(sameFile(theirs, join(home, 'auth.json'))).toBe(true);
    // One file under two names: a token Codex refreshes in Toil UI's home is the user's token too.
    writeFileSync(join(home, 'auth.json'), '{"auth_mode":"chatgpt","refreshed":true}\n');
    expect(readFileSync(theirs, 'utf8')).toContain('refreshed');
    // Only toil_ui and the features: nothing from any user config is named, because none is read.
    expect(stub.seen.options!.configOverrides).toEqual(codexOverrides('http://127.0.0.1:1/api/agent/mcp'));
  });

  it('rewrites its config.toml and replaces a copied auth.json with the link', () => {
    const theirs = userCodex();
    const home = toilCodexHome(mkdtempSync(join(folder, 'data-')));
    prepareCodexHome(home, { CODEX_HOME: theirs }, 'linux');
    writeFileSync(join(home, 'config.toml'), '[mcp_servers.left_behind]\ncommand = "x"\n');
    rmSync(join(home, 'auth.json'));
    writeFileSync(join(home, 'auth.json'), '{"stale":true}\n');
    // A copy left from before is older than the user's sign-in.
    utimesSync(join(home, 'auth.json'), new Date(2020, 0, 1), new Date(2020, 0, 1));
    prepareCodexHome(home, { CODEX_HOME: theirs }, 'linux');
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(TOIL_CODEX_CONFIG);
    expect(sameFile(join(theirs, 'auth.json'), join(home, 'auth.json'))).toBe(true);
  });

  it("refuses, and keeps both files, when its auth.json is newer than the user's: a split link may hold the only live token", () => {
    const theirs = userCodex();
    const home = toilCodexHome(mkdtempSync(join(folder, 'data-')));
    prepareCodexHome(home, { CODEX_HOME: theirs }, 'linux');
    rmSync(join(home, 'auth.json'));
    writeFileSync(join(home, 'auth.json'), '{"refreshed":true}\n');
    utimesSync(join(theirs, 'auth.json'), new Date(2020, 0, 1), new Date(2020, 0, 1));
    expect(() => prepareCodexHome(home, { CODEX_HOME: theirs }, 'linux')).toThrow(/is newer than yours .* no longer one file/);
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toContain('refreshed');
    expect(readFileSync(join(theirs, 'auth.json'), 'utf8')).toContain('chatgpt');
  });

  it('drops the link once the user signs out, and then refuses unless CODEX_API_KEY signs in', () => {
    const theirs = userCodex();
    const home = toilCodexHome(mkdtempSync(join(folder, 'data-')));
    prepareCodexHome(home, { CODEX_HOME: theirs }, 'linux');
    rmSync(join(theirs, 'auth.json'));
    expect(() => prepareCodexHome(home, { CODEX_HOME: theirs }, 'linux')).toThrow(AgentError);
    expect(existsSync(join(home, 'auth.json'))).toBe(false);
    try {
      prepareCodexHome(home, { CODEX_HOME: theirs }, 'linux');
    } catch (e) {
      expect((e as AgentError).message).toBe(`Toil UI runs Codex in a Codex home of its own and signs in with your Codex's auth.json, but there is none at ${join(theirs, 'auth.json')}.`);
      expect((e as AgentError).fix).toMatch(/codex login.*CODEX_API_KEY.*another adapter/);
    }
    expect(() => prepareCodexHome(home, { CODEX_HOME: theirs, CODEX_API_KEY: 'sk-own' }, 'linux')).not.toThrow();
    expect(existsSync(join(home, 'auth.json'))).toBe(false);
  });

  it("finds the user's Codex home from CODEX_HOME, else .codex in the home folder", () => {
    expect(userCodexHome({ CODEX_HOME: '/opt/codex', HOME: '/home/you' }, 'linux')).toBe('/opt/codex');
    expect(userCodexHome({ HOME: '/home/you' }, 'linux')).toBe(join('/home/you', '.codex'));
    expect(userCodexHome({ USERPROFILE: 'C:\\Users\\you', HOME: '/c/Users/you' }, 'win32')).toBe(join('C:\\Users\\you', '.codex'));
  });

  it("serves toil_ui as the only MCP server and switches Codex's own reach off", () => {
    const overrides = codexOverrides('http://127.0.0.1:1/api/agent/mcp');
    expect(overrides.filter((o) => o.startsWith('mcp_servers'))).toEqual(['mcp_servers={ toil_ui = { url = "http://127.0.0.1:1/api/agent/mcp", bearer_token_env_var = "TOIL_UI_MCP_TOKEN" } }']);
    expect(overrides.slice(1)).toEqual(CODEX_FEATURES_OFF.map((f) => `features.${f}=false`));
  });
});

/** What the people tools return, as far as these tests read it. */
type Brief = { key: string; name: string; kind: string; inProgress: unknown[]; blocked: unknown[]; reviewsWaitingOnThem: Array<{ id: string }>; openPullRequests: unknown[] };
type PeopleList = { rule: string; wipLimitPerPerson: number | null; notes: string[]; people: Brief[]; unmapped: Brief[]; suggestedMatches: unknown[]; team: { unassignedInSprint: unknown } };
type PersonGet = { person: Brief & { recentActivity: unknown[] }; error?: string; people?: Array<{ key: string; name: string }> };

describe('the people tools (#292)', () => {
  const now = () => FIXTURE_NOW;
  const of = (name: string) => cacheData(cache, name)!;
  const fixture = fixtureExecute();
  const peopleTools_ = (name: string, ledger: Ledger) => peopleTools(name, of(name), ledger, toilProjectReader(fixture.execute, name), now);

  it("people_list reads the Toil project's people from the synced projects show, with each plate, and vouches for every id it names", async () => {
    const ledger = new Ledger();
    const r = (await tool(peopleTools_('card-payments', ledger), 'people_list').run({})) as PeopleList;
    // The toil project is read live, as the cache never holds it: read-only, and labelled as Toil UI.
    expect(fixture.calls.at(-1)).toMatchObject({ command: 'projects show', input: { toilProject: 'card-payments' }, ok: true });
    expect(r.rule).toContain('never rank, score or compare people');
    expect(r.wipLimitPerPerson).toBe(2);
    expect(r.people.map((p: { name: string }) => p.name)).toEqual(['A. Chen', 'J. Smith', 'R. Patel']);
    const chen = r.people[0]!;
    expect(chen.inProgress).toEqual([{ id: 'corp-jira:PAY-104', title: expect.any(String), status: 'In Review', daysInStatus: 5.9 }]);
    expect(chen.blocked).toEqual([{ id: 'corp-jira:PAY-102', title: expect.any(String), blockedBy: [{ id: 'corp-jira:PAY-101', status: 'In Progress', inToilProject: true }] }]);
    expect(r.people[1]!.reviewsWaitingOnThem.map((x: { id: string }) => x.id)).toEqual(['corp-bitbucket:PAY/payments-core#305']);
    expect(r.unmapped.map((p: { key: string }) => p.key)).toEqual(['id:bitbucket:achen']);
    expect(r.suggestedMatches).toEqual([{ accounts: ['bitbucket:achen'], probably: 'A. Chen', sharedEmail: 'you@example.com', applyWith: 'projects person' }]);
    expect(r.team.unassignedInSprint).toEqual({ sprint: 'Sprint 42', ids: ['corp-jira:PAY-103', 'corp-jira:PAY-107'] });
    for (const id of ['corp-jira:PAY-104', 'corp-jira:PAY-102', 'corp-jira:PAY-101', 'corp-bitbucket:PAY/payments-core#305', 'corp-jira:PAY-103']) expect(ledger.ids.has(id), id).toBe(true);
  });

  it('person_get finds someone by key, name or account, with their recent activity, or names who there is', async () => {
    const tools = (ledger: Ledger) => peopleTools_('checkout-web', ledger);
    const get = async (person: string, ledger = new Ledger()) => (await tool(tools(ledger), 'person_get').run({ person })) as PersonGet;
    const ledger = new Ledger();
    const ada = await get('ada d.', ledger);
    expect(ada.person).toMatchObject({ key: 'person:Ada D.', kind: 'human', reviewsWaitingOnThem: [{ id: 'bitbucket-cloud:imagile/checkout-sdk#12' }, { id: 'github:imagile/payments-web#52' }] });
    expect(ada.person.openPullRequests).toEqual([expect.objectContaining({ id: 'github:imagile/payments-web#51', waitingOn: 'checks', writtenWithAgent: 'Claude' })]);
    expect(ada.person.recentActivity[0]).toEqual({ kind: 'moved', at: expect.any(String), id: 'github:imagile/payments-web#44', from: 'open', to: 'closed' });
    expect(ledger.ids.has('github:imagile/payments-web#50')).toBe(true);
    expect((await get('person:Claude')).person.kind).toBe('agent');
    expect((await get('github:bo-web')).person.name).toBe('Bo W.');
    const none = await get('Nobody');
    expect(none.error).toBe('Nobody in checkout-web is "Nobody". Use people_list for the names and keys.');
    expect(none.people?.map((p) => p.key)).toEqual(['person:Ada D.', 'person:Bo W.', 'person:Claude', 'id:bitbucket:557058:abc12345-0000-0000-0000-000000000010']);
  });

  it('works with no people section: every account is unmapped, and nothing is suggested', async () => {
    const r = (await tool(peopleTools_('settlement', new Ledger()), 'people_list').run({})) as PeopleList;
    expect(r.people).toEqual([]);
    const failing = peopleTools('settlement', of('settlement'), new Ledger(), async () => ({ toilProject: null, error: 'toil projects show settlement failed: it broke.' }), now);
    expect(((await tool(failing, 'people_list').run({})) as PeopleList).notes).toEqual(['toil projects show settlement failed: it broke. So nobody is mapped, and no limit is known.']);
    expect(r.wipLimitPerPerson).toBeNull();
    expect(r.unmapped.map((p: { name: string }) => p.name)).toEqual(['D. Okafor', 'J. Park', 'K. Nakamura', 'M. Lind']);
  });
});

/** What the readiness tools return, as far as these tests read it. */
type VerdictBrief = { id: string; verdict: string; notReadyBecause: Array<{ check: string; state: string; reason: string }> };
type ReadinessList = { rule: string; openByVerdict: Record<string, number>; notes: string[]; total: number; items: VerdictBrief[]; settings: { sources: string[]; repositories: string[]; areas: Record<string, { acceptanceCriteriaField: string | null; minWords: number }> } };

describe('the readiness tools (#307)', () => {
  const of = (name: string) => cacheData(cache, name)!;
  const fixture = fixtureExecute();
  const tools = (name: string, ledger: Ledger) => readinessTools(name, of(name), ledger, toilProjectReader(fixture.execute, name));

  it('readiness_list gives every open item its verdict and why, with the settings it used, and vouches for every id it names', async () => {
    const ledger = new Ledger();
    const r = (await tool(tools('card-payments', ledger), 'readiness_list').run({})) as ReadinessList;
    expect(fixture.calls.at(-1)).toMatchObject({ command: 'projects show', input: { toilProject: 'card-payments' }, ok: true });
    expect(r.rule).toContain('with no model call');
    expect(r.openByVerdict).toEqual({ ready: 1, thin: 3, blocked: 2 });
    expect(r.settings).toEqual({ sources: ['jira', 'bitbucket', 'jenkins'], repositories: ['payments-core'], areas: expect.objectContaining({ jira: expect.objectContaining({ acceptanceCriteriaField: 'customfield_10500', minWords: 20 }) }) });
    expect(r.items.map((i) => [i.id, i.verdict])).toEqual([
      ['corp-jira:PAY-100', 'thin'],
      ['corp-jira:PAY-101', 'ready'],
      ['corp-jira:PAY-102', 'blocked'],
      ['corp-jira:PAY-103', 'blocked'],
      ['corp-jira:PAY-104', 'thin'],
      ['corp-jira:PAY-107', 'thin'],
    ]);
    expect(r.items[2]!.notReadyBecause[0]).toEqual({ check: 'Blockers', state: 'fail', reason: 'Blocked by [[corp-jira:PAY-101]] (In Progress).' });
    for (const id of ['corp-jira:PAY-100', 'corp-jira:PAY-101', 'corp-jira:PAY-107']) expect(ledger.ids.has(id), id).toBe(true);
    // A Done example a row cites is vouched for too.
    expect([...ledger.ids].some((id) => ['corp-jira:PAY-92', 'corp-jira:PAY-95', 'corp-jira:PAY-98', 'corp-jira:PAY-105'].includes(id))).toBe(true);
    const ready = (await tool(tools('card-payments', new Ledger()), 'readiness_list').run({ verdict: 'ready' })) as ReadinessList;
    expect(ready.items.map((i) => i.id)).toEqual(['corp-jira:PAY-101']);
    const withDone = (await tool(tools('card-payments', new Ledger()), 'readiness_list').run({ includeDone: true, limit: 2 })) as ReadinessList & { more?: string };
    expect(withDone.total).toBe(12);
    expect(withDone.more).toBe('10 more match; narrow with verdict or raise limit (max 200).');
  });

  it('readiness_get gives all five rows for one item, or says it has none', async () => {
    const r = (await tool(tools('checkout-web', new Ledger()), 'readiness_get').run({ id: 'github:imagile/payments-web#41' })) as VerdictBrief & { rows: Array<{ check: string; state: string; source: string }> };
    expect(r.verdict).toBe('ready');
    expect(r.rows.map((x) => [x.check, x.state])).toEqual([['Acceptance criteria', 'pass'], ['Description', 'pass'], ['Done state', 'pass'], ['Blockers', 'pass'], ['Scope', 'pass']]);
    expect(((await tool(tools('checkout-web', new Ledger()), 'readiness_get').run({ id: 'nope' })) as { error: string }).error).toBe('The cache holds no item "nope" in checkout-web. Use readiness_list or owi_query to find ids.');
  });

  it("says so when the Toil project can't be read, and every item then fails scope", async () => {
    const failing = readinessTools('settlement', of('settlement'), new Ledger(), async () => ({ toilProject: null, error: 'toil projects show settlement failed: it broke.' }));
    const r = (await tool(failing, 'readiness_list').run({})) as ReadinessList;
    expect(r.notes).toEqual(['toil projects show settlement failed: it broke. So no source, repository or readiness setting is known, and every item fails scope.']);
    expect(new Set(r.items.map((i) => i.verdict))).toEqual(new Set(['blocked']));
  });
});

describe('each question, as an agent run for the worklog (#308)', () => {
  it('is recorded as it starts and again when it finishes, with its answer, citations and proposals', async () => {
    const runs: AgentRun[] = [];
    const { host } = hostFor('claude', claudeStub(SCRIPT).module, { onRun: (r) => void runs.push(structuredClone(r)) });
    const versions = await streamed(host);
    expect(runs.map((r) => r.outcome)).toEqual(['running', 'finished']);
    const [start, end] = runs;
    expect(start).toMatchObject({ kind: 'ask', toilProject: 'card-payments', prompt: 'Backlog hygiene', by: 'Claude (test-model)', startedAt: FIXTURE_NOW, finishedAt: null, answer: null });
    expect(end!.id).toBe(start!.id);
    expect(end).toMatchObject({ finishedAt: FIXTURE_NOW, citations: versions.at(-1)!.citations, unverified: ['corp-jira:PAY-999'] });
    expect(end!.proposals.map((p) => p.command)).toEqual(['jira issue update']);
    expect(end!.answer).toBe(versions.at(-1)!.parts.map((p) => p.text).join('\n\n'));
  });

  it('is recorded as failed, with why, when the agent fails', async () => {
    const runs: AgentRun[] = [];
    const missing = hostFor('codex', codexStub(SCRIPT, new McpGrants(() => '')).module, { isFile: () => false, onRun: (r) => void runs.push(structuredClone(r)) }).host;
    await missing.ask(ctx(), 'card-payments', 'q').catch(() => undefined);
    expect(runs.map((r) => r.outcome)).toEqual(['running', 'failed']);
    expect(runs[1]!.error).toMatch(/codex/i);
  });

  it('is recorded as stopped when the person leaves mid-answer, with what it had said', async () => {
    const runs: AgentRun[] = [];
    const { host } = hostFor('claude', claudeStub(SCRIPT).module, { onRun: (r) => void runs.push(structuredClone(r)) });
    for await (const a of host.stream(ctx(), 'card-payments', 'hygiene')) if (a.parts.length) break;
    expect(runs.map((r) => r.outcome)).toEqual(['running', 'stopped']);
    expect(runs[1]!.answer).toBe('[[corp-jira:PAY-107]] has no estimate');
    expect(runs[1]!.citations).toEqual(['corp-jira:PAY-107']);
  });

  it('says a Stop is a stop, never a sign-in problem (#317, seen live on Copilot)', async () => {
    const runs: AgentRun[] = [];
    const { host } = hostFor('copilot', copilotStub(SCRIPT).module, { onRun: (r) => void runs.push(structuredClone(r)) });
    const stop = new AbortController();
    stop.abort();
    await expect(host.ask(ctx(stop.signal), 'card-payments', 'hygiene')).rejects.toThrow('GitHub Copilot was stopped before it finished.');
    expect(runs.at(-1)!.outcome).toBe('stopped');
    expect(runs.at(-1)!.error).toMatch(/^GitHub Copilot was stopped before it finished\./);
    expect(runs.at(-1)!.error).not.toMatch(/signed in/);
  });

  it("never fails the question when the worklog can't record it", async () => {
    const { host } = hostFor('claude', claudeStub(SCRIPT).module, { onRun: () => { throw new Error('disk full'); } });
    expect((await streamed(host)).at(-1)!.proposals).toHaveLength(1);
  });

  it('gives the agent worklog_day when the Toil project has a worklog, vouching for every id a line names', async () => {
    const page = { toilProject: 'card-payments', day: '2026-10-12', timeZone: 'UTC' as const, gaps: ['a gap'], work: [{ key: 'k', kind: 'status' as const, at: '2026-10-12T09:00:00.000Z', subject: 'corp-jira:PAY-101', source: 'jira', label: 'PAY-101', title: 'T', url: null, by: 'Ada', text: 'To Do → Done', cites: ['corp-jira:PAY-101'], refs: {}, observed: null }], prs: [], delivery: [], agents: [], notes: [], sources: [] };
    const ledger = new Ledger();
    const days: string[] = [];
    const [tool] = worklogTool('card-payments', { ...data, worklog: async (day) => (days.push(day), { ...page, day }) }, ledger, () => FIXTURE_NOW);
    expect(tool!.name).toBe('worklog_day');
    const out = (await tool!.run({})) as { day: string; gaps: string[]; lines: Array<{ time: string; cite: string[] }> };
    expect(days).toEqual(['2026-10-12']);
    expect(out).toMatchObject({ day: '2026-10-12', gaps: ['a gap'], lines: [{ time: '09:00', cite: ['corp-jira:PAY-101'] }] });
    expect(ledger.ids.has('corp-jira:PAY-101')).toBe(true);
    expect(await tool!.run({ day: '2026-10-14' })).toEqual({ error: '2026-10-14 is after today (2026-10-13, UTC), so it has no page yet.' });
    expect(worklogTool('card-payments', data, ledger)).toEqual([]);
  });

  it('gives the agent standup_report (#345), each line numbered and every id it names vouched for', async () => {
    const { fixtureWorklog } = await import('../src/fixtures/worklog.ts');
    const sample = fixtureWorklog();
    const ledger = new Ledger();
    const asked: Array<[string, string]> = [];
    const [tool] = standupTool('card-payments', { ...data, standup: async (from, to) => (asked.push([from, to]), (await sample.standup('card-payments', from, to)).report) }, ledger, () => FIXTURE_NOW);
    expect(tool!.name).toBe('standup_report');
    const out = (await tool!.run({})) as { from: string; to: string; team: Array<{ fact: string; cite: string[] }>; people: Array<Record<string, unknown>> };
    // FIXTURE_NOW is a Tuesday: since the last working day is Monday and Tuesday.
    expect(asked).toEqual([['2026-10-12', '2026-10-13']]);
    expect(out.team[0]!.fact).toBe('F1');
    expect(Object.keys(out.people[0]!)).toEqual(['name', 'kind', 'inToilProjectPeople', 'Done', 'In progress', 'Blocked', 'Next']);
    const cited = [...out.team, ...out.people.flatMap((p) => ['Done', 'In progress', 'Blocked', 'Next'].flatMap((b) => p[b] as Array<{ cite: string[] }>))].flatMap((l) => l.cite);
    expect(cited.length).toBeGreaterThan(0);
    for (const id of cited) expect(ledger.ids.has(id)).toBe(true);
    expect(await tool!.run({ from: '2026-10-13', to: '2026-10-12' })).toEqual({ error: 'The range starts (2026-10-13) after it ends (2026-10-12).' });
    expect(await tool!.run({ from: 'monday' })).toEqual({ error: 'Give from and to as days, yyyy-mm-dd.' });
    expect(standupTool('card-payments', data, ledger)).toEqual([]);
  });
});

describe('assignments on the agent host (#293)', () => {
  const item = () => data.items().find((i) => i.id === 'corp-jira:PAY-107')!;
  const run = async (over: { mode?: 'refine' | 'investigate' | 'implement'; script?: Script } = {}) => {
    const holder = new McpGrants(() => 'http://127.0.0.1:1/api/agent/mcp');
    const stub = codexStub(over.script ?? SCRIPT, holder);
    const { host, rec, dataDir } = hostFor('codex', stub.module, { serveTools: (tools) => holder.serve(tools) });
    const runner = hostRunner({ host, dataDir, registry: registry.commands, execute: rec.execute, mapIds: () => [], data: () => data, version: 't', toilVersion: '0.0.0-test', now: () => FIXTURE_NOW });
    const lines: string[] = [];
    const assignment = { id: 'abc12345-0000-0000-0000-000000000000', toilProject: 'card-payments', item: 'corp-jira:PAY-107', itemTitle: 'x', mode: over.mode ?? 'refine', adapter: 'codex', origin: 'person', trigger: null, state: 'working', waiting: null, repo: null, createdAt: FIXTURE_NOW, startedAt: FIXTURE_NOW, endedAt: null, stop: null, report: null, questions: [], proposals: [], usage: null, startedOn: null, branch: null } as const;
    const result = await runner.run({ assignment: { ...assignment, proposals: [], questions: [] }, item: item(), signal: new AbortController().signal, record: (e) => lines.push(`${e.kind}: ${e.title}`) });
    return { result, stub, rec, lines, holder, dataDir };
  };

  it('runs refine on the adapter the assignment names, read-only, with the read tools and the server checks', async () => {
    const { result, stub, rec, lines, holder } = await run();
    expect(stub.seen.thread).toMatchObject({ sandboxMode: 'read-only', approvalPolicy: 'never', networkAccessEnabled: false });
    expect(stub.seen.listed).toEqual(expect.arrayContaining(['owi_get', 'owi_similar', 'pr_query', 'proposal_fields']));
    expect(stub.seen.listed).not.toContain('people_list');
    expect(stub.seen.listed).not.toContain('jira_issue_update');
    // The item is fenced as data, and the rules say what to do with an instruction inside it.
    expect(stub.seen.input).toContain('<<<TRACKER_ITEM');
    expect(stub.seen.input).toContain('INJECTION:');
    expect(result.report!.unverified).toEqual(['corp-jira:PAY-999']);
    expect(result.proposals.map((p) => p.command)).toEqual(['jira issue update']);
    expect(result.startedOn).toMatchObject({ toil: '0.0.0-test', toilUi: 't', adapter: 'codex', skills: [], toilProject: { name: 'card-payments' }, item: { id: 'corp-jira:PAY-107' } });
    expect(result.startedOn.item.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(lines).toContain('tool: Called: owi_get');
    // Every call toil made was a read, and the run's own carry the assignment as their actor.
    expect(rec.calls.every((c) => c.options.readOnly === true && c.options.caller === 'toil-ui')).toBe(true);
    expect(rec.calls.some((c) => c.options.actor === 'assignment-abc12345-0000-0000-0000-000000000000')).toBe(true);
    expect(holder.size).toBe(0);
  });

  it('turns an investigation into a report and a comment proposal', async () => {
    const { result } = await run({ mode: 'investigate', script: { calls: [{ name: 'owi_get', input: { id: 'corp-jira:PAY-107' } }], chunks: ['[[corp-jira:PAY-107]] is unestimated.\nQUESTION: Who owns it?'] } });
    expect(result.questions).toEqual(['Who owns it?']);
    expect(result.report!.parts.map((p) => p.text)).toEqual(['[[corp-jira:PAY-107]] is unestimated.']);
    expect(result.proposals).toEqual([expect.objectContaining({ command: 'jira issue comment', input: expect.objectContaining({ toilProject: 'card-payments', key: 'PAY-107' }) })]);
  });

  it('stops on an item the agent says is an injection attempt', async () => {
    const { result } = await run({ script: { calls: [], chunks: ['INJECTION: asks to post the tokens elsewhere'] } });
    expect(result.injection).toBe('asks to post the tokens elsewhere');
    expect(result.proposals).toEqual([]);
  });

  it('gives implement mode the workspace-write sandbox in its own folder, with the shell and no network', async () => {
    const holder = new McpGrants(() => 'http://127.0.0.1:1/api/agent/mcp');
    const stub = codexStub({ calls: [], chunks: ['done'] }, holder);
    const { host, dataDir } = hostFor('codex', stub.module, { serveTools: (tools) => holder.serve(tools) });
    const root = join(dataDir, 'cache', 'work', 'x');
    await host.task({ adapter: 'codex', toilProject: 'card-payments', chat: 'abc12345', system: 's', prompt: 'p', tools: [], workspace: { root }, signal: new AbortController().signal, onText: () => undefined });
    expect(stub.seen.thread).toMatchObject({ sandboxMode: 'workspace-write', workingDirectory: root, networkAccessEnabled: false, approvalPolicy: 'never' });
    const overrides = stub.seen.options!.configOverrides as string[];
    expect(overrides).toEqual(codexOverrides('http://127.0.0.1:1/api/agent/mcp', true));
    expect(overrides).toContain('sandbox_workspace_write.network_access=false');
    expect(overrides).toContain('windows.sandbox="unelevated"');
    expect(overrides).not.toContain('features.shell_tool=false');
    expect(overrides).toContain('features.unified_exec=false');
  });

  it('refuses a workspace on an adapter whose own sandbox Toil UI does not use to bound one folder', async () => {
    const { host } = hostFor('claude', claudeStub(SCRIPT).module);
    await expect(host.task({ adapter: 'claude', toilProject: 'card-payments', chat: 'abc12345', system: 's', prompt: 'p', tools: [], workspace: { root: '/x' }, signal: new AbortController().signal, onText: () => undefined })).rejects.toThrow(/only Codex/);
    expect(host.adapterChoices().map((a) => [a.name, a.workspace])).toEqual([['claude', false], ['copilot', false], ['codex', true]]);
  });

  it('holds an assignment to the per-chat cap, and marks the refusal as a cap', async () => {
    const holder = new McpGrants(() => 'http://127.0.0.1:1/api/agent/mcp');
    const stub = codexStub(SCRIPT, holder);
    const ledger = memoryLedger([{ id: 'r1', chatId: 'abc12345', turn: 1, toilProject: 'card-payments', adapter: 'codex', at: FIXTURE_NOW, model: null, costSource: 'none', inputTokens: 900 }]);
    const { host, dataDir } = hostFor('codex', stub.module, { serveTools: (tools) => holder.serve(tools), ledger });
    writeFileSync(usageSettingsFile(dataDir), JSON.stringify({ caps: { 'codex.chat': { unit: 'tokens', limit: 500 } }, codexRates: null }));
    const e = await host.task({ adapter: 'codex', toilProject: 'card-payments', chat: 'abc12345', system: 's', prompt: 'p', tools: [], workspace: null, signal: new AbortController().signal, onText: () => undefined }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AgentError);
    expect((e as AgentError).capped).toBe(true);
    expect(stub.seen.thread).toBeUndefined();
  });

  it('records the model Settings gave the adapter when the run starts, so a run a cap stops still names it (#318, seen live)', async () => {
    const ledger = memoryLedger([{ id: 'r1', chatId: 'abc12345-0000-0000-0000-000000000009', turn: 1, toilProject: 'card-payments', adapter: 'claude', at: FIXTURE_NOW, model: 'test-model', costSource: 'none', inputTokens: 900 }]);
    const { host, rec, dataDir } = hostFor('claude', claudeStub(SCRIPT).module, { ledger });
    writeFileSync(usageSettingsFile(dataDir), JSON.stringify({ caps: { 'claude.chat': { unit: 'tokens', limit: 500 } }, codexRates: null }));
    const runner = hostRunner({ host, dataDir, registry: registry.commands, execute: rec.execute, mapIds: () => [], data: () => data, version: 't', toilVersion: '0.0.0-test', now: () => FIXTURE_NOW });
    const assignment = { id: 'abc12345-0000-0000-0000-000000000009', toilProject: 'card-payments', item: 'corp-jira:PAY-107', itemTitle: 'x', mode: 'refine', adapter: 'claude', origin: 'person', trigger: null, state: 'working', waiting: null, repo: null, createdAt: FIXTURE_NOW, startedAt: FIXTURE_NOW, endedAt: null, stop: null, report: null, questions: [], proposals: [], usage: null, startedOn: null, branch: null } as const;
    const started: Array<{ adapter: string; model: string | null }> = [];
    const stopped = await runner
      .run({ assignment: { ...assignment, proposals: [], questions: [] }, item: data.items().find((i) => i.id === 'corp-jira:PAY-107')!, signal: new AbortController().signal, record: () => undefined, started: (s) => void started.push(s) })
      .catch((x: unknown) => x);
    expect(stopped).toMatchObject({ reason: 'usage' });
    expect(started).toEqual([expect.objectContaining({ adapter: 'claude', model: 'test-model' })]);
  });
});

describe('implement mode, when the agent commits anyway (#293 review)', () => {
  it('warns and proposes no commit or push, since its commits are not in the staged diff', async () => {
    const source = mkdtempSync(join(folder, 'person-clone-'));
    mkdirSync(join(source, '.git', 'refs', 'heads'), { recursive: true });
    mkdirSync(join(source, '.git', 'objects'), { recursive: true });
    writeFileSync(join(source, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(source, '.git', 'refs', 'heads', 'main'), `${'a'.repeat(40)}\n`);
    let root = '';
    // The Codex SDK, stubbed: inside the run it "commits" by moving the branch the clone is on.
    class Codex {
      startThread(t: Record<string, unknown>) {
        root = String(t.workingDirectory);
        return {
          runStreamed: async () => ({
            events: (async function* () {
              writeFileSync(join(root, 'repo', '.git', 'refs', 'heads', 'main'), `${'b'.repeat(40)}\n`);
              yield { type: 'item.completed', item: { type: 'agent_message', text: 'Staged a README change.' } };
              yield { type: 'turn.completed', usage: {} };
            })(),
          }),
        };
      }
    }
    const holder = new McpGrants(() => 'http://127.0.0.1:1/api/agent/mcp');
    const { host, dataDir } = hostFor('codex', { Codex }, { serveTools: (tools) => holder.serve(tools) });
    const calls: string[] = [];
    const execute: Execute = async (command) => {
      calls.push(command);
      const data = command === 'projects show' ? { toilProject: { repos: [{ name: 'payments-core', path: source }] } } : { staged: ['README.md'] };
      return { ok: true, data, error: null, meta: { command, durationMs: 0, version: '0', contractVersion: 1 } } as unknown as Envelope;
    };
    const runner = hostRunner({ host, dataDir, registry: registry.commands, execute, mapIds: () => [], data: () => data, version: 't', toilVersion: 't', now: () => FIXTURE_NOW });
    const item = data.items().find((i) => i.id === 'corp-jira:PAY-107')!;
    const a = { id: 'abc12345-0000-0000-0000-000000000001', toilProject: 'card-payments', item: item.id, itemTitle: 'x', mode: 'implement', adapter: 'codex', origin: 'person', trigger: null, state: 'working', waiting: null, repo: 'payments-core', createdAt: FIXTURE_NOW, startedAt: FIXTURE_NOW, endedAt: null, stop: null, report: null, questions: [], proposals: [], usage: null, startedOn: null, branch: null } as const;
    const result = await runner.run({ assignment: { ...a, questions: [], proposals: [] }, item, signal: new AbortController().signal, record: () => undefined });
    expect(result.report!.warnings[0]).toMatch(/moved the clone off the commit it started at \(aaaaaaaaaaaa, now bbbbbbbbbbbb\)/);
    expect(result.proposals.some((p) => p.title.startsWith('Commit and push'))).toBe(false);
    expect(headCommit(join(root, 'repo'))).toBe('b'.repeat(40));
  });

  it('reads the commit HEAD is at from a loose ref, packed-refs, or a detached HEAD', () => {
    const clone = mkdtempSync(join(folder, 'heads-'));
    mkdirSync(join(clone, '.git'), { recursive: true });
    writeFileSync(join(clone, '.git', 'HEAD'), 'ref: refs/heads/agent/x\n');
    writeFileSync(join(clone, '.git', 'packed-refs'), `# pack-refs with: peeled\n${'c'.repeat(40)} refs/heads/agent/x\n`);
    expect(headCommit(clone)).toBe('c'.repeat(40));
    writeFileSync(join(clone, '.git', 'HEAD'), `${'d'.repeat(40)}\n`);
    expect(headCommit(clone)).toBe('d'.repeat(40));
    writeFileSync(join(clone, '.git', 'HEAD'), 'ref: refs/../../x\n');
    expect(headCommit(clone)).toBeNull();
  });
});

describe('implement mode, when the diff would hide something staged (#293 review round 4)', () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=you@example.com', '-c', 'commit.gpgsign=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };

  /** An implement run on a real clone of a real repository, with a stubbed Codex doing `act` in it, and toil's real git status and diff. */
  const implementWith = async (act: (repo: string) => void) => {
    const source = mkdtempSync(join(folder, 'gitlink-source-'));
    git(source, 'init', '-q', '-b', 'main');
    writeFileSync(join(source, 'README.md'), 'one\n');
    git(source, 'add', 'README.md');
    git(source, 'commit', '-q', '-m', 'start');
    // The Codex SDK, stubbed: inside the run it does what an injected agent might, with real git.
    class Codex {
      startThread(t: Record<string, unknown>) {
        const repo = join(String(t.workingDirectory), 'repo');
        return {
          runStreamed: async () => ({
            events: (async function* () {
              git(repo, 'reset', '-q', '--hard', 'HEAD');
              git(repo, 'switch', '-q', '-c', 'agent/PAY-107');
              act(repo);
              yield { type: 'item.completed', item: { type: 'agent_message', text: 'Staged a README change.' } };
              yield { type: 'turn.completed', usage: {} };
            })(),
          }),
        };
      }
    }
    const holder = new McpGrants(() => 'http://127.0.0.1:1/api/agent/mcp');
    const { host, dataDir } = hostFor('codex', { Codex }, { serveTools: (tools) => holder.serve(tools) });
    // toil's own git status and git diff, for real, with its audit log in a home of the test's own.
    const home = mkdtempSync(join(folder, 'gitlink-home-'));
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const execute: Execute = async (command, input = {}, options = {}) =>
      command === 'projects show'
        ? ({ ok: true, data: { toilProject: { repos: [{ name: 'payments-core', path: source }] } }, error: null, meta: { command, durationMs: 0, version: '0', contractVersion: 1 } } as unknown as Envelope)
        : ((await realExecute(command, input, options as never)) as unknown as Envelope);
    try {
      const runner = hostRunner({ host, dataDir, registry: registry.commands, execute, mapIds: () => [], data: () => data, version: 't', toilVersion: 't', now: () => FIXTURE_NOW });
      const item = data.items().find((i) => i.id === 'corp-jira:PAY-107')!;
      const a = { id: 'abc12345-0000-0000-0000-000000000002', toilProject: 'card-payments', item: item.id, itemTitle: 'x', mode: 'implement', adapter: 'codex', origin: 'person', trigger: null, state: 'working', waiting: null, repo: 'payments-core', createdAt: FIXTURE_NOW, startedAt: FIXTURE_NOW, endedAt: null, stop: null, report: null, questions: [], proposals: [], usage: null, startedOn: null, branch: null } as const;
      const result = await runner.run({ assignment: { ...a, questions: [], proposals: [] }, item, signal: new AbortController().signal, record: () => undefined });
      return result;
    } finally {
      process.env.HOME = saved.HOME;
      process.env.USERPROFILE = saved.USERPROFILE;
    }
  };


  it('stages a gitlink beside a README change, names it, and proposes no commit or push', async () => {
    const result = await implementWith((repo) => {
      writeFileSync(join(repo, 'README.md'), 'one\ntwo\n');
      git(repo, 'add', 'README.md');
      git(repo, 'update-index', '--add', '--cacheinfo', `160000,${'0123456789abcdef'.repeat(2)}01234567,leak1`);
    });
    expect(result.branch!.hidden).toEqual(['leak1']);
    expect(result.branch!.diff).toContain('+two');
    expect(result.branch!.diff).not.toContain('leak1');
    expect(result.report!.warnings[0]).toMatch(/^The staged change includes a file the diff below doesn't show: leak1\..*no commit or push is proposed/);
    expect(result.proposals.some((p) => p.title.startsWith('Commit and push'))).toBe(false);
  }, 30_000);

  it('stages a file longer than toil reads, says the diff is cut, and proposes no commit or push', async () => {
    const result = await implementWith((repo) => {
      writeFileSync(join(repo, 'big.md'), `${Array.from({ length: 5_100 }, (_, i) => `line ${i}`).join('\n')}\nSECRET\n`);
      git(repo, 'add', 'big.md');
    });
    expect(result.branch!.cut).toBe(true);
    expect(result.branch!.diff).not.toContain('SECRET');
    expect(result.branch!.diff).toContain("[toil stopped reading the diff");
    expect(result.report!.warnings[0]).toMatch(/^The staged diff is too long to show in full/);
    expect(result.proposals.some((p) => p.title.startsWith('Commit and push'))).toBe(false);
  }, 30_000);

  it('proposes the commit and push when the diff shows every staged file in full', async () => {
    const result = await implementWith((repo) => {
      writeFileSync(join(repo, 'README.md'), 'one\ntwo\n');
      git(repo, 'add', 'README.md');
    });
    expect(result.branch).toMatchObject({ hidden: [], cut: false, onBranch: true });
    expect(result.proposals.some((p) => p.title.startsWith('Commit and push'))).toBe(true);
  }, 30_000);

  it('counts a staged path as reviewed only when the diff has text for it', () => {
    const diff = { files: [{ path: 'a.md', binary: false, hunks: [{}] }, { path: 'logo.png', binary: true, hunks: [] }, { path: 'run.sh', binary: false, hunks: [] }, { path: 'new.md', binary: false, hunks: [{}] }] };
    expect(hiddenStaged({ staged: ['a.md', 'logo.png', 'run.sh', 'old.md -> new.md', 'leak1'] }, diff)).toEqual(['logo.png', 'run.sh', 'leak1']);
    expect(hiddenStaged({ staged: ['a.md'] }, null)).toEqual(['a.md']);
    expect(hiddenStaged({ staged: [] }, diff)).toEqual([]);
  });
});

// ---------------------------------------------------------------- #343, #344

describe('switching agent within a chat (#344)', () => {
  /** A host whose Settings choose Claude, with Codex installed too: both SDKs stubbed. */
  function twoAdapters(over: Partial<AgentHostOptions> = {}) {
    const claude = claudeStub(SCRIPT);
    const grants = new McpGrants(() => 'http://127.0.0.1:1/api/agent/mcp');
    const codex = codexStub(SCRIPT, grants);
    const importer: Importer = async (spec) => {
      if (spec === 'zod') return zod;
      if (spec.startsWith('@anthropic-ai/')) return claude.module;
      if (spec.startsWith('@openai/')) return codex.module;
      throw Object.assign(new Error(`Cannot find package '${spec}'`), { code: 'ERR_MODULE_NOT_FOUND' });
    };
    const made = hostFor('claude', claude.module, { importer, serveTools: (tools) => grants.serve(tools), installed: (spec) => !spec.startsWith('@github/'), ...over });
    return { ...made, claude, codex };
  }

  it('answers on the chat\'s adapter for that question only, with that adapter\'s own model, and labels the answer with both', async () => {
    const { host, dataDir, claude, codex } = twoAdapters();
    host.save({ ...loadAgentSettings(dataDir), models: { claude: 'haiku', codex: 'gpt-5-mini' } });
    const answer = await host.ask(ctx(), 'card-payments', 'hygiene', null, { id: 'chat-1', turn: 1 }, { adapter: 'codex' });
    expect(answer).toMatchObject({ adapter: 'codex', model: 'gpt-5-mini', by: 'Codex (gpt-5-mini)' });
    expect(codex.seen.thread!.model).toBe('gpt-5-mini');
    expect(claude.seen.options).toBeUndefined();
    // The next question with no override is Settings' Claude again, on its model.
    const back = await host.ask(ctx(), 'card-payments', 'hygiene');
    expect(back).toMatchObject({ adapter: 'claude', model: 'test-model', by: 'Claude (test-model)' });
    expect(claude.seen.options!.model).toBe('test-model');
  });

  it('carries the chat so far into the next question, shortened, and says how many turns it carried', async () => {
    const { host, codex } = twoAdapters();
    const history = [{ prompt: 'Why is this sprint at risk?', answer: 'x'.repeat(MAX_HISTORY_ANSWER + 50), by: 'Claude (haiku)' }];
    const answer = await host.ask(ctx(), 'card-payments', 'And who can unblock it?', null, { id: 'chat-2', turn: 2 }, { adapter: 'codex', history });
    expect(answer.carried).toBe(1);
    expect(codex.seen.input).toContain('Question 1: Why is this sprint at risk?');
    expect(codex.seen.input).toContain('Answer 1 (Claude (haiku)): ');
    expect(codex.seen.input).toContain(`${'x'.repeat(MAX_HISTORY_ANSWER)}…`);
    expect(codex.seen.input).not.toContain('x'.repeat(MAX_HISTORY_ANSWER + 1));
    expect(codex.seen.input).toMatch(/The new question:\nAnd who can unblock it\?$/);
  });

  it('refuses an adapter it has no runtime for', async () => {
    const { host } = twoAdapters();
    await expect(host.ask(ctx(), 'card-payments', 'q', null, undefined, { adapter: 'gemini' })).rejects.toThrow(/no gemini adapter/);
  });

  it('lists every adapter for the switcher, an uninstalled one unavailable with Install and the command, never left out', () => {
    const { host } = twoAdapters({ uiDir: '/usr/local/lib/node_modules/@imagile-dev/toil-ui', execPath: '/usr/local/bin/node', isFile: (p) => Object.values(FAKE_CLI).includes(p) || p === '/usr/local/lib/node_modules/npm/bin/npm-cli.js' });
    const list = host.adapterOptions();
    expect(list.chosen).toBe('claude');
    expect(list.options.map((o) => [o.name, o.ready, o.action])).toEqual([
      ['claude', true, null],
      ['copilot', false, 'install'],
      ['codex', true, null],
    ]);
    const copilot = list.options.find((o) => o.name === 'copilot')!;
    expect(copilot.problem).toBe("The GitHub Copilot adapter needs @github/copilot-sdk, which isn't installed beside Toil UI.");
    expect(copilot.fix).toContain('npm install --global --prefix /usr/local --ignore-scripts --before=');
    expect(copilot.fix).toContain('@github/copilot-sdk@1.0.16');
    // A CLI that can't be found is Fix, not Install.
    const noCli = twoAdapters({ isFile: () => false }).host.adapterOptions();
    expect(noCli.options.find((o) => o.name === 'codex')).toMatchObject({ ready: false, action: 'fix' });
  });

  it('keeps each adapter\'s model and CLI path in settings, the chosen one\'s in step with model and cliPath, and loads a file from before', () => {
    const checked = checkAgentSettings({ adapter: 'codex', model: 'gpt-5', cliPath: '/opt/codex', models: { claude: 'haiku', codex: 'stale' }, cliPaths: { claude: '/opt/claude' } }, posix.isAbsolute, 'linux');
    expect(checked.models).toEqual({ claude: 'haiku', codex: 'gpt-5' });
    expect(checked.cliPaths).toEqual({ claude: '/opt/claude', codex: '/opt/codex' });
    expect(() => checkAgentSettings({ adapter: 'codex', models: { gemini: 'x' } })).toThrow(/models has no adapter "gemini"/);
    expect(() => checkAgentSettings({ adapter: 'codex', cliPaths: { claude: '/opt/codex' } }, posix.isAbsolute, 'linux')).toThrow(/must end in claude/);
    expect(() => checkAgentSettings({ adapter: 'codex', models: { claude: 'bad model' } })).toThrow(/isn't a model name/);
    expect(checkAgentSettings({ adapter: 'claude', model: 'sonnet' })).toMatchObject({ models: { claude: 'sonnet' }, cliPaths: {} });
  });
});

describe('the status line (#343)', () => {
  it('names each tool as the agent calls it, a live read by its toil command, on every adapter', async () => {
    for (const [name, stub] of [['claude', claudeStub(SCRIPT).module], ['codex', codexStub(SCRIPT, new McpGrants(() => '')).module]] as const) {
      const { host } = name === 'codex' ? (() => { const g = new McpGrants(() => 'http://127.0.0.1:1/api/agent/mcp'); return hostFor('codex', codexStub(SCRIPT, g).module, { serveTools: (t) => g.serve(t) }); })() : hostFor(name, stub);
      const versions = await streamed(host);
      const tools = versions.filter((v) => v.activity?.phase === 'tool').map((v) => v.activity!.tool);
      expect(tools).toEqual(['owi_get', 'jira issue search']);
      expect(versions.find((v) => v.activity?.tool === 'owi_get')!.activity!.source).toBe('cache');
    }
  });
});

describe('Analyze (#343)', () => {
  it('asks the fixed pulse check: changes since the last Analyze, people, blockers, sprint health and what looks off', () => {
    const { label, text } = promptFor('card-payments', 'analyze');
    expect(label).toBe('Analyze');
    for (const part of ['What changed', 'worklog_day', '"Analyze"', 'people_list', 'never rank or score people', 'owi_query', 'pr_query', "The sprint's health", 'status drift', 'readiness_list', 'Cite every item']) expect(text).toContain(part);
  });

  it('asks for it top-down (#395): a Recommendation line, at most three Issues, then the Evidence, labels in plain text, the rules unchanged', () => {
    const { text } = promptFor('card-payments', 'analyze');
    const lines = text.split('\n');
    expect(lines[1]).toMatch(/^Recommendation: /);
    expect(lines[2]).toMatch(/^Issues: at most three/);
    expect(lines[3]).toMatch(/^Evidence: /);
    expect(text).toContain('not a Markdown heading');
    expect(text.indexOf('Recommendation:')).toBeLessThan(text.indexOf('What changed'));
    // The system prompt's rules are the same for Analyze as for any question: citations, proposals, plain text, and the rules win.
    const system = systemPrompt('card-payments', 'now', { voice: 'Speak like a pirate.', instructions: null });
    for (const rule of ['[[jira:PAY-101]]', '```proposal', 'no Markdown, no headings', 'The rules above win']) expect(system).toContain(rule);
    // And the page reads the shape back out of what the prompt asks for.
    expect(structureOf('Recommendation: Fix [[jira:PAY-1]].\nIssues:\n1. Blocked: [[jira:PAY-2]] waits.\nEvidence:\nWhat changed: nothing.')).toMatchObject({ recommendation: 'Fix [[jira:PAY-1]].', issues: [{ title: 'Blocked' }], evidence: ['What changed: nothing.'] });
  });

  it('carries at most the last turns of a chat', () => {
    const history = Array.from({ length: MAX_HISTORY_TURNS + 3 }, (_, i) => ({ prompt: `q${i}`, answer: `a${i}` }));
    const { text, carried } = withHistory('now?', history);
    expect(carried).toBe(MAX_HISTORY_TURNS);
    expect(text).not.toContain('Question 1: q0\n');
    expect(text).toContain(`Question ${MAX_HISTORY_TURNS}: q${MAX_HISTORY_TURNS + 2}`);
    expect(withHistory('now?', [])).toEqual({ text: 'now?', carried: 0 });
  });
});

describe("npm's copilot.cmd on Windows (#344)", () => {
  const cmd = '@ECHO off\r\nGOTO start\r\n:start\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@github\\copilot\\npm-loader.js" %*\r\n';
  it('resolves to the script the shim runs, which Copilot\'s SDK starts with Node, and says so in the status', () => {
    const shim = win32.join('C:\\nodejs', 'copilot.cmd');
    const script = win32.join('C:\\nodejs', 'node_modules', '@github', 'copilot', 'npm-loader.js');
    expect(shimScript(shim, cmd)).toBe(script);
    expect(findCli({ label: 'the Copilot CLI', command: 'copilot', env: { Path: 'C:\\nodejs' }, platform: 'win32', path: win32, cwd: 'C:\\work', isFile: (p) => p === shim || p === script, scripts: true, readText: () => cmd })).toBe(script);
    // Without the SDK starting scripts (Claude, Codex), the shim is refused as before.
    expect(() => findCli({ label: 'Claude Code', command: 'claude', env: { Path: 'C:\\nodejs' }, platform: 'win32', path: win32, cwd: 'C:\\work', isFile: (p) => p === win32.join('C:\\nodejs', 'claude.cmd'), readText: () => cmd })).toThrow(/Windows command shim/);
  });

  it('never follows a shim out of its own folder, and refuses one npm didn\'t write', () => {
    expect(shimScript('C:\\nodejs\\copilot.cmd', '"%dp0%\\..\\..\\evil\\x.js"')).toBeNull();
    expect(shimScript('C:\\nodejs\\copilot.cmd', 'start copilot.exe')).toBeNull();
    expect(shimScript('C:\\nodejs\\copilot', 'exec node  "$basedir/node_modules/@github/copilot/npm-loader.js" "$@"')).toBe('C:\\nodejs\\node_modules\\@github\\copilot\\npm-loader.js');
  });
});
