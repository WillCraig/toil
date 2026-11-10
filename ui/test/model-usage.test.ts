// @vitest-environment node
import { mapOwi, registry } from '@imagile-dev/toil/api';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { cookieHeader, letInto } from './let-in.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zod from 'zod';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fixtureAgent, noAgent } from '../server/agent.ts';
import { claudeResultUsage, claudeRuntime, claudeStepUsage, onPlan } from '../server/agents/claude.ts';
import { codexRuntime, codexUsage, TOKEN_ENV } from '../server/agents/codex.ts';
import { copilotRuntime, copilotUsage, premiumQuota } from '../server/agents/copilot.ts';
import { AgentHost, type AgentHostOptions } from '../server/agents/host.ts';
import { AgentError as AgentErrorClass } from '../server/agents/cli.ts';
import { McpGrants } from '../server/agents/mcp.ts';
import type { Importer } from '../server/agents/runtime.ts';
import { agentSettingsFile } from '../server/agents/settings.ts';
import { cacheData, type AgentData } from '../server/agents/tools.ts';
import { Cache } from '../server/cache.ts';
import type { RequestContext } from '../server/context.ts';
import { createUiServer } from '../server/server.ts';
import { fixtureStore } from '../server/store.ts';
import { SyncService } from '../server/sync.ts';
import { cacheLedger, loadUsageSettings, memoryLedger, saveUsageSettings, usageControl, usageSettingsFile } from '../server/usage.ts';
import { FIXTURE_NOW } from '../src/fixtures/execute.ts';
import { SAMPLE_USAGE_SETTINGS, sampleUsageRecords } from '../src/fixtures/model-usage.ts';
import {
  addUp,
  checkUsageSettings,
  codexCost,
  reports,
  totalsBy,
  usageCsv,
  usageParts,
  UsageSettingsError,
  type AnswerUsage,
  type UsageRecord,
} from '../src/model-usage.ts';
import { stubToil } from './toil-stub.ts';

/**
 * The model usage meter (#295): the one adding-up rule, for running totals
 * and per-call reports; the ledger surviving a sync's cleanup; the settings,
 * refused when they don't parse; and each
 * adapter's capture, against SDK events shaped from each SDK's own type
 * definitions (Claude Agent SDK 0.3.289's sdk.d.ts, Codex SDK 0.160.0's
 * index.d.ts, Copilot SDK 1.0.16's session-events.d.ts and rpc.d.ts). No
 * test starts a CLI or calls a model; Codex is also checked live (the PR).
 */

const ctx = (signal = new AbortController().signal): RequestContext => ({ viewer: { id: 'local', name: 'you', via: 'loopback' }, signal });
const folder = mkdtempSync(join(tmpdir(), 'toil-ui-usage-'));
let cache: Cache;
let data: AgentData;

beforeAll(async () => {
  cache = await Cache.open(join(folder, 'data'), { retentionDays: 30, now: () => new Date(FIXTURE_NOW) });
  await new SyncService({ cache, execute: stubToil().execute, mapOwi, now: () => new Date(FIXTURE_NOW) }).run(ctx());
  data = cacheData(cache, 'card-payments')!;
});
afterAll(() => {
  cache.close();
  rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
});

const rec = (over: Partial<UsageRecord>): UsageRecord => ({ id: 'r1', chatId: 'chat-0001', turn: 1, toilProject: 'card-payments', adapter: 'claude', model: 'claude-sonnet-4-6', costSource: 'none', at: '2026-10-13T08:00:00.000Z', ...over });

describe('the adding-up rule', () => {
  it('sums per-call reports, each once by its id', () => {
    const calls = [rec({ id: 'a', inputTokens: 100, outputTokens: 10 }), rec({ id: 'b', inputTokens: 200, outputTokens: 20 }), rec({ id: 'a', inputTokens: 100, outputTokens: 10 })];
    const t = addUp(calls);
    expect(t.reports).toBe(2);
    expect(t.inputTokens).toBe(300);
    expect(t.outputTokens).toBe(30);
    expect(t.tokens).toBe(330);
  });

  it('takes the highest of a running total the SDK reported several times, never their sum', () => {
    const running = [rec({ id: 'session', costUsd: 0.01, costSource: 'sdk-estimate', inputTokens: 500 }), rec({ id: 'session', costUsd: 0.03, costSource: 'sdk-estimate', inputTokens: 1500, at: '2026-10-13T08:01:00.000Z' }), rec({ id: 'session', costUsd: 0.02, costSource: 'sdk-estimate', inputTokens: 1000 })];
    const t = addUp(running);
    expect(t.reports).toBe(1);
    expect(t.costUsd['sdk-estimate']).toBe(0.03);
    expect(t.inputTokens).toBe(1500);
    // Mixed: two sessions' running totals plus a separate call.
    expect(addUp([...running, rec({ id: 'other', costUsd: 0.5, costSource: 'sdk-estimate' })]).costUsd['sdk-estimate']).toBeCloseTo(0.53);
  });

  it('leaves a figure no record reported absent, never 0, and the footer says "not reported"', () => {
    const t = addUp([rec({ id: 'x', adapter: 'codex', inputTokens: 900, outputTokens: 80, inputIncludesCached: true })]);
    expect(t.cacheWriteTokens).toBeUndefined();
    expect(t.cachedInputTokens).toBeUndefined();
    expect('costUsd' in t && Object.keys(t.costUsd)).toEqual([]);
    expect(usageParts(t, 'codex')).toEqual(['900 in', '80 out', 'cached not reported', 'cache write not reported', 'no dollar figure (add your rates under Settings, Usage)']);
    expect(addUp([]).tokens).toBeUndefined();
  });

  it("counts Codex's cached input once, since its input already holds it, and Claude's apart from its input", () => {
    expect(addUp([rec({ adapter: 'codex', inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50, inputIncludesCached: true })]).tokens).toBe(1050);
    expect(addUp([rec({ inputTokens: 200, cachedInputTokens: 800, cacheWriteTokens: 100, outputTokens: 50 })]).tokens).toBe(1150);
  });

  it('never adds dollars from different sources together, and labels a Claude plan API-equivalent', () => {
    const t = addUp([rec({ id: 'c', costUsd: 0.012, costSource: 'sdk-estimate', plan: true, inputTokens: 2100, outputTokens: 380, cachedInputTokens: 14000, cacheWriteTokens: 0 }), rec({ id: 'x', adapter: 'codex', costUsd: 0.5, costSource: 'your-rates' })]);
    expect(t.costUsd).toEqual({ 'sdk-estimate': 0.012, 'your-rates': 0.5 });
    expect(usageParts(addUp([rec({ id: 'c', costUsd: 0.012, costSource: 'sdk-estimate', plan: true, inputTokens: 2100, outputTokens: 380, cachedInputTokens: 14000, cacheWriteTokens: 0 })]), 'claude')).toEqual([
      '2.1k in',
      '380 out',
      '14k cached',
      '0 cache write',
      '~$0.012 (SDK estimate, API-equivalent: your plan is not billed per token)',
    ]);
  });

  it('shows Copilot premium requests and never a dollar figure', () => {
    const t = addUp([rec({ adapter: 'copilot', model: 'gpt-5-mini', inputTokens: 10, outputTokens: 5, premiumRequests: 1, costUsd: 9, costSource: 'sdk-estimate' })]);
    const parts = usageParts(t, 'copilot');
    expect(parts.at(-1)).toBe('1 premium request');
    expect(parts.join(' ')).not.toContain('$');
  });

  it('groups after merging, so a running total reported on two days counts once, on its last', () => {
    const rs = [rec({ id: 's', inputTokens: 10, at: '2026-10-12T23:59:00.000Z' }), rec({ id: 's', inputTokens: 30, at: '2026-10-13T00:01:00.000Z' })];
    const byDay = totalsBy(rs, (r) => r.at.slice(0, 10));
    expect(byDay.map((g) => [g.key, g.totals.inputTokens])).toEqual([['2026-10-13', 30]]);
    expect(reports(rs)).toHaveLength(1);
  });

  it('splits a chat that switched models by model', () => {
    const rs = [rec({ id: 'a', model: 'claude-sonnet-4-6', inputTokens: 10 }), rec({ id: 'b', model: 'claude-haiku-4-5', inputTokens: 5 })];
    expect(totalsBy(rs, (r) => r.model ?? '').map((g) => [g.key, g.totals.inputTokens])).toEqual([
      ['claude-sonnet-4-6', 10],
      ['claude-haiku-4-5', 5],
    ]);
  });

  it('exports CSV with an empty cell where the SDK reported nothing, and a formula kept as text', () => {
    const csv = usageCsv([rec({ id: '=cmd()', adapter: 'codex', model: null, inputTokens: 5 })]).trim().split('\n');
    expect(csv[0]).toBe('at,day,adapter,model,toilProject,chatId,turn,inputTokens,cachedInputTokens,cacheWriteTokens,outputTokens,premiumRequests,costUsd,costSource,id');
    expect(csv[1]).toBe(`2026-10-13T08:00:00.000Z,2026-10-13,codex,,card-payments,chat-0001,1,5,,,,,,none,"'=cmd()"`);
  });

  it('prices Codex from your rates, its cached input at the cached rate', () => {
    expect(codexCost({ inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000 }, { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 })).toBeCloseTo(0.75 + 0.05 + 1);
    expect(codexCost({}, { inputPerMillion: 1, cachedInputPerMillion: 1, outputPerMillion: 1 })).toBeUndefined();
  });
});

describe('the ledger', () => {
  it("survives a sync's cleanup and a forgotten Toil project: a total never drops", async () => {
    const dir = mkdtempSync(join(folder, 'ledger-'));
    const c = await Cache.open(dir, { retentionDays: 30, now: () => new Date(FIXTURE_NOW) });
    try {
      const ledger = cacheLedger(() => c);
      ledger.add([rec({ id: 'a', inputTokens: 100 }), rec({ id: 'b', inputTokens: 50, toilProject: 'settlement' })]);
      const before = addUp(ledger.since('2026-10-01T00:00:00.000Z'));
      await new SyncService({ cache: c, execute: stubToil().execute, mapOwi, now: () => new Date(FIXTURE_NOW) }).run(ctx());
      c.forget('settlement');
      c.forget('card-payments');
      c.prune();
      expect(addUp(ledger.since('2026-10-01T00:00:00.000Z'))).toEqual(before);
      // A running total seen again merges, and never shrinks.
      ledger.add([rec({ id: 'a', inputTokens: 40 })]);
      expect(addUp(ledger.chat('chat-0001')).inputTokens).toBe(150);
    } finally {
      c.close();
    }
  });

  it('keeps a record only as long as the retention period, and a wipe clears it', async () => {
    const dir = mkdtempSync(join(folder, 'ledger-'));
    const c = await Cache.open(dir, { retentionDays: 7, now: () => new Date(FIXTURE_NOW) });
    try {
      c.addUsage([rec({ id: 'old', inputTokens: 1, at: '2026-09-01T00:00:00.000Z' }), rec({ id: 'new', inputTokens: 2 })]);
      c.prune();
      expect(c.usageSince('2000-01-01T00:00:00.000Z').map((r) => r.id)).toEqual(['new']);
      c.wipe();
      expect(c.counts().usage).toBe(0);
    } finally {
      c.close();
    }
  });
});

describe('usage settings', () => {
  it('take the Codex rates only, and refuse any other key, usage caps included', () => {
    const rates = { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 };
    expect(checkUsageSettings({ codexRates: rates })).toEqual({ codexRates: rates });
    expect(checkUsageSettings({ codexRates: null })).toEqual({ codexRates: null });
    expect(() => checkUsageSettings({ caps: {} })).toThrow('The usage settings have no "caps".');
  });

  it('refuse a rate that does not parse, naming the setting, never reading it as 0', () => {
    const refused = (codexRates: unknown) => {
      try {
        checkUsageSettings({ codexRates });
      } catch (e) {
        expect(e).toBeInstanceOf(UsageSettingsError);
        return (e as Error).message;
      }
      throw new Error('accepted');
    };
    expect(refused({ inputPerMillion: 'lots', cachedInputPerMillion: 0, outputPerMillion: 1 })).toContain('codexRates.inputPerMillion');
    expect(refused({ inputPerMillion: 1, cachedInputPerMillion: -1, outputPerMillion: 1 })).toContain('codexRates.cachedInputPerMillion');
    expect(refused({ inputPerMillion: 1, cachedInputPerMillion: 0 })).toContain('codexRates.outputPerMillion');
  });

  it('name the setting, and no file path, when the file is broken, and load again once it is saved', () => {
    const dir = mkdtempSync(join(folder, 'settings-'));
    writeFileSync(usageSettingsFile(dir), JSON.stringify({ codexRates: { inputPerMillion: 'lots', cachedInputPerMillion: 0, outputPerMillion: 1 } }));
    expect(() => loadUsageSettings(dir)).toThrow(/^Toil UI's saved Codex rates: codexRates\.inputPerMillion/);
    expect(() => loadUsageSettings(dir)).not.toThrow(/usage\.json/);
    writeFileSync(usageSettingsFile(dir), '{ not json');
    expect(() => loadUsageSettings(dir)).toThrow(/is damaged/);
    saveUsageSettings(dir, { codexRates: { inputPerMillion: 1, cachedInputPerMillion: 0.1, outputPerMillion: 5 } });
    expect(loadUsageSettings(dir).codexRates).toEqual({ inputPerMillion: 1, cachedInputPerMillion: 0.1, outputPerMillion: 5 });
  });

  it('still load a file saved before usage caps were removed, dropping its caps, and rewrite it without them on the next save', () => {
    const dir = mkdtempSync(join(folder, 'settings-'));
    const rates = { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 };
    writeFileSync(usageSettingsFile(dir), JSON.stringify({ caps: { 'codex.chat': { unit: 'tokens', limit: 5000 }, 'claude.day': 'off' }, codexRates: rates }));
    expect(loadUsageSettings(dir)).toEqual({ codexRates: rates });
    writeFileSync(usageSettingsFile(dir), JSON.stringify({ caps: { 'codex.chat': { unit: 'tokens', limit: 'lots' } } }));
    expect(loadUsageSettings(dir)).toEqual({ codexRates: null });
    saveUsageSettings(dir, loadUsageSettings(dir));
    expect(JSON.parse(readFileSync(usageSettingsFile(dir), 'utf8'))).toEqual({ codexRates: null });
  });
});

// ---------------------------------------------------------------- the adapters, on stubbed SDKs

describe("each adapter's capture, from events shaped like its SDK's", () => {
  it('Claude: steps by message id, then the result\'s modelUsage, with its cost as the SDK estimate', () => {
    expect(claudeStepUsage({ id: 'msg_01', model: 'claude-sonnet-4-6', usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 9000, cache_creation_input_tokens: 400 } })).toEqual({
      id: 'claude:msg_01',
      model: 'claude-sonnet-4-6',
      costSource: 'none',
      inputTokens: 12,
      outputTokens: 3,
      cachedInputTokens: 9000,
      cacheWriteTokens: 400,
    });
    // Claude Code's own "Not logged in" message, as it came back live (#318): no model ran, so nothing is reported.
    expect(claudeStepUsage({ id: 'e06bc8c1', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })).toBeNull();
    const result = { type: 'result', subtype: 'success', session_id: 'sess-1', total_cost_usd: 0.0123, modelUsage: { 'claude-sonnet-4-6': { inputTokens: 30, outputTokens: 400, cacheReadInputTokens: 18000, cacheCreationInputTokens: 900, webSearchRequests: 0, costUSD: 0.0123, contextWindow: 200000, maxOutputTokens: 32000, provider: 'firstParty' } } };
    expect(claudeResultUsage(result, true)).toEqual([{ id: 'claude:sess-1:claude-sonnet-4-6', model: 'claude-sonnet-4-6', costSource: 'sdk-estimate', costUsd: 0.0123, plan: true, inputTokens: 30, outputTokens: 400, cachedInputTokens: 18000, cacheWriteTokens: 900 }]);
    expect(onPlan('none', 'firstParty', null)).toBe(true);
    expect(onPlan('none', 'bedrock', 'bedrock')).toBe(false);
    expect(onPlan('ANTHROPIC_API_KEY', 'firstParty', null)).toBe(false);
  });

  it('Codex: one turn.completed, its figures exactly as the event carried them', () => {
    expect(codexUsage({ input_tokens: 21000, cached_input_tokens: 14000, cache_write_input_tokens: 0, output_tokens: 380, reasoning_output_tokens: 120 }, 'codex:t:1', null)).toEqual({ id: 'codex:t:1', model: null, costSource: 'none', inputIncludesCached: true, inputTokens: 21000, cachedInputTokens: 14000, cacheWriteTokens: 0, outputTokens: 380 });
    // An older SDK without cache writes leaves the field absent.
    expect(codexUsage({ input_tokens: 5, cached_input_tokens: 0, output_tokens: 1 }, 'id', 'gpt-5.5')).not.toHaveProperty('cacheWriteTokens');
  });

  it('Copilot: each assistant.usage event as a call, cost as premium requests, and the quota marked experimental', () => {
    expect(copilotUsage({ model: 'claude-sonnet-4.6', inputTokens: 3000, outputTokens: 200, cacheReadTokens: 1000, cost: 1, duration: 900 }, 'copilot:e1')).toEqual({ id: 'copilot:e1', model: 'claude-sonnet-4.6', costSource: 'none', inputTokens: 3000, outputTokens: 200, cachedInputTokens: 1000, premiumRequests: 1 });
    // Live on mai-code-1.1-flash (#317): one prompt, three calls, each reporting cost 0.25; the session's metrics billed 0.25.
    const calls = [
      { model: 'mai-code-1.1-flash', cost: 0.25, initiator: 'user', inputTokens: 101, outputTokens: 17 },
      { model: 'mai-code-1.1-flash', cost: 0.25, initiator: 'agent', inputTokens: 137, outputTokens: 17 },
      { model: 'mai-code-1.1-flash', cost: 0.25, initiator: 'agent', inputTokens: 173, outputTokens: 5 },
    ].map((d, n) => copilotUsage(d, `copilot:e${n}`));
    expect(calls.map((c) => c.premiumRequests)).toEqual([0.25, 0, 0]);
    expect(calls.reduce((sum, c) => sum + (c.premiumRequests ?? 0), 0)).toBe(0.25);
    expect(copilotUsage({ model: 'm', inputTokens: 1 }, 'copilot:none')).not.toHaveProperty('premiumRequests');
    expect(premiumQuota({ quotaSnapshots: { premium_interactions: { isUnlimitedEntitlement: false, entitlementRequests: 300, usedRequests: 41, usageAllowedWithExhaustedQuota: false, remainingPercentage: 86, overage: 0, overageAllowedWithExhaustedQuota: false, resetDate: '2026-11-01T00:00:00Z' } } })).toEqual({
      unlimited: false,
      entitlement: 300,
      remaining: 259,
      resetDate: '2026-11-01T00:00:00Z',
    });
    expect(premiumQuota({ quotaSnapshots: {} })).toBeNull();
  });
});

const FAKE_CLI: Record<string, string> = { claude: '/usr/bin/claude', copilot: '/usr/bin/copilot', codex: '/usr/bin/codex' };

function hostFor(adapter: 'claude' | 'copilot' | 'codex', module: unknown, over: Partial<AgentHostOptions> = {}) {
  const dataDir = mkdtempSync(join(folder, `host-${adapter}-`));
  writeFileSync(agentSettingsFile(dataDir), JSON.stringify({ adapter, model: adapter === 'codex' ? null : 'test-model', cliPath: null, endpoint: null }));
  const codexHome = mkdtempSync(join(folder, 'user-codex-'));
  writeFileSync(join(codexHome, 'auth.json'), '{}');
  const importer: Importer = async (spec) => {
    if (spec === 'zod') return zod;
    if (spec.startsWith(`@${adapter === 'claude' ? 'anthropic-ai' : adapter === 'copilot' ? 'github' : 'openai'}/`)) return module;
    throw Object.assign(new Error(`Cannot find package '${spec}'`), { code: 'ERR_MODULE_NOT_FOUND' });
  };
  const ledger = memoryLedger();
  const grants = new McpGrants(() => 'http://127.0.0.1:1/api/agent/mcp');
  const host = new AgentHost({
    dataDir,
    version: 't',
    data: (d) => (d === 'card-payments' ? data : null),
    registry: registry.commands,
    execute: async (command) => ({ ok: true, data: {}, error: null, meta: { command, durationMs: 0, version: '0', contractVersion: 1 } }) as never,
    mapIds: () => [],
    serveTools: (tools) => grants.serve(tools),
    fallback: noAgent(),
    env: { PATH: '/usr/bin', HOME: '/home/you', CODEX_HOME: codexHome },
    cwd: '/work',
    platform: 'linux',
    importer,
    installed: () => true,
    isFile: (p) => Object.values(FAKE_CLI).includes(p),
    now: () => FIXTURE_NOW,
    runtimes: [claudeRuntime('t'), copilotRuntime(), codexRuntime()],
    ledger,
    ...over,
  });
  return { host, ledger, dataDir };
}

async function last(host: AgentHost, chat = { id: 'chat-test-0001', turn: 1 }) {
  let a;
  for await (const v of host.stream(ctx(), 'card-payments', 'q', null, chat)) a = v;
  return a!;
}

/** Claude's stream as the SDK sends it: init, each step's assistant message (one id twice, as when it streams in pieces), and the result. */
function claudeModule(steps: Array<{ id: string; input: number; output: number }>, after?: () => void) {
  return {
    tool: (name: string) => ({ name }),
    createSdkMcpServer: (o: unknown) => o,
    query: () =>
      (async function* () {
        yield { type: 'system', subtype: 'init', apiKeySource: 'none', session_id: 'sess-1' };
        for (const s of steps) {
          const message = { id: s.id, model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'Answer.' }], usage: { input_tokens: s.input, output_tokens: s.output, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } };
          yield { type: 'assistant', parent_tool_use_id: null, message };
          yield { type: 'assistant', parent_tool_use_id: null, message };
          after?.();
        }
        const input = steps.reduce((n, s) => n + s.input, 0);
        const output = steps.reduce((n, s) => n + s.output, 0);
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Answer.',
          session_id: 'sess-1',
          total_cost_usd: 0.02,
          modelUsage: { 'claude-sonnet-4-6': { inputTokens: input, outputTokens: output, cacheReadInputTokens: 1000 * steps.length, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.02, contextWindow: 200000, maxOutputTokens: 32000, provider: 'firstParty' } },
        };
      })(),
  };
}

describe("the host, recording a chat's usage", () => {
  it('records the result\'s figures for a Claude answer, replacing the steps, and the answer carries them with the context meter', async () => {
    const { host, ledger } = hostFor('claude', claudeModule([{ id: 'msg_1', input: 100, output: 20 }, { id: 'msg_2', input: 300, output: 40 }]));
    const answer = await last(host);
    const usage = answer.usage as AnswerUsage;
    expect(usage.adapter).toBe('claude');
    expect(usage.records).toHaveLength(1);
    expect(usage.records[0]).toMatchObject({ id: 'claude:sess-1:claude-sonnet-4-6', chatId: 'chat-test-0001', turn: 1, toilProject: 'card-payments', adapter: 'claude', inputTokens: 400, outputTokens: 60, cachedInputTokens: 2000, costUsd: 0.02, costSource: 'sdk-estimate', plan: true, at: FIXTURE_NOW });
    expect(usage.context).toEqual({ used: 300 + 1000 + 40, window: 200000 });
    expect(ledger.rows).toEqual(usage.records);
  });

  it("counts a Claude step's output from its message_delta, which the assistant message leaves out (#318, seen live)", async () => {
    // As Haiku streamed one tool call live: message_start and the assistant message said 24 output tokens, message_delta 72.
    const start = { id: 'msg_1', model: 'claude-haiku-5-5', usage: { input_tokens: 2, cache_creation_input_tokens: 1609, cache_read_input_tokens: 0, output_tokens: 24 } };
    const module = {
      tool: (name: string) => ({ name }),
      createSdkMcpServer: (o: unknown) => o,
      query: () =>
        (async function* () {
          yield { type: 'system', subtype: 'init', apiKeySource: 'none', session_id: 'sess-1' };
          yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: start } };
          yield { type: 'assistant', parent_tool_use_id: null, message: { ...start, content: [{ type: 'tool_use', name: 'owi_get', input: {} }] } };
          yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 2, cache_creation_input_tokens: 1609, cache_read_input_tokens: 0, output_tokens: 72 } } };
          // No result's totals to replace the steps: the run ended without an answer, so the steps seen stand.
          yield { type: 'result', subtype: 'error_max_turns', errors: ['max turns'] };
        })(),
    };
    const { host, ledger } = hostFor('claude', module);
    await last(host).catch(() => undefined);
    expect(ledger.rows).toEqual([expect.objectContaining({ id: 'claude:msg_1', model: 'claude-haiku-5-5', inputTokens: 2, cacheWriteTokens: 1609, outputTokens: 72 })]);
  });

  it('records the Codex turn as the SDK reported it, and prices it from your rates', async () => {
    const usage = { input_tokens: 21000, cached_input_tokens: 14000, cache_write_input_tokens: 0, output_tokens: 380, reasoning_output_tokens: 0 };
    class Codex {
      constructor(readonly o: Record<string, unknown>) {}
      startThread() {
        return {
          runStreamed: async () => ({
            events: (async function* () {
              yield { type: 'thread.started', thread_id: 'thread-1' };
              yield { type: 'turn.started' };
              yield { type: 'item.completed', item: { type: 'agent_message', text: 'Answer.' } };
              yield { type: 'turn.completed', usage };
            })(),
          }),
        };
      }
    }
    const { host, dataDir, ledger } = hostFor('codex', { Codex });
    saveUsageSettings(dataDir, checkUsageSettings({ codexRates: { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 } }));
    const a = await last(host);
    expect(a.parts[0]!.text).toBe('Answer.');
    const r = a.usage!.records[0]!;
    expect(r).toMatchObject({ id: 'codex:thread-1:1', model: null, inputTokens: 21000, cachedInputTokens: 14000, cacheWriteTokens: 0, outputTokens: 380, costSource: 'your-rates', inputIncludesCached: true });
    expect(r.costUsd).toBeCloseTo((7000 * 1.25 + 14000 * 0.125 + 380 * 10) / 1e6);
    expect(a.usage!.notices).toEqual([]);
    expect(ledger.rows).toHaveLength(1);
    expect(TOKEN_ENV).toBe('TOIL_UI_MCP_TOKEN');
  });

  it("records each of Copilot's assistant.usage events as it arrives, with premium requests, the context and the quota", async () => {
    class CopilotClient {
      rpc = { account: { getQuota: async () => ({ quotaSnapshots: { premium_interactions: { isUnlimitedEntitlement: false, entitlementRequests: 300, usedRequests: 42, resetDate: '2026-11-01T00:00:00Z' } } }) } };
      async start() {}
      async stop() {
        return [];
      }
      async createSession() {
        const handlers = new Map<string, Array<(e: { id?: string; data: Record<string, unknown> }) => void>>();
        const emit = (name: string, e: { id?: string; data: Record<string, unknown> }) => (handlers.get(name) ?? []).forEach((h) => h(e));
        return {
          on: (name: string, h: (e: { id?: string; data: Record<string, unknown> }) => void) => (handlers.set(name, [...(handlers.get(name) ?? []), h]), () => {}),
          async sendAndWait() {
            emit('assistant.usage', { id: 'ev-1', data: { model: 'claude-sonnet-4.6', inputTokens: 3000, outputTokens: 50, cacheReadTokens: 1000, cost: 1 } });
            emit('assistant.usage', { id: 'ev-2', data: { model: 'claude-sonnet-4.6', inputTokens: 3500, outputTokens: 120, cacheReadTokens: 2900, cost: 0 } });
            emit('session.usage_info', { id: 'ev-3', data: { currentTokens: 7400, tokenLimit: 128000, messagesLength: 4 } });
            return { data: { content: 'Answer.' } };
          },
          abort: async () => {},
          disconnect: async () => {},
        };
      }
    }
    const module = { CopilotClient, RuntimeConnection: { forStdio: (o: unknown) => o }, defineTool: (name: string, c: Record<string, unknown>) => ({ name, ...c }) };
    const { host } = hostFor('copilot', module);
    const u = (await last(host)).usage!;
    expect(u.records.map((r) => [r.id, r.premiumRequests, r.inputTokens])).toEqual([
      ['copilot:ev-1', 1, 3000],
      ['copilot:ev-2', 0, 3500],
    ]);
    expect(addUp(u.records).premiumRequests).toBe(1);
    expect(u.context).toEqual({ used: 7400, window: 128000 });
    expect(u.quota).toEqual({ unlimited: false, entitlement: 300, remaining: 258, resetDate: '2026-11-01T00:00:00Z' });
    expect(u.records.every((r) => r.costUsd === undefined)).toBe(true);
  });

  it('still answers while the usage file is broken, and a Codex answer says why it has no dollar figure', async () => {
    const turn = { input_tokens: 2000, cached_input_tokens: 1000, cache_write_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0 };
    class Codex {
      constructor(readonly o: Record<string, unknown>) {}
      startThread() {
        return {
          runStreamed: async () => ({
            events: (async function* () {
              yield { type: 'thread.started', thread_id: 'thread-1' };
              yield { type: 'item.completed', item: { type: 'agent_message', text: 'Answer.' } };
              yield { type: 'turn.completed', usage: turn };
            })(),
          }),
        };
      }
    }
    const broken = JSON.stringify({ codexRates: { inputPerMillion: -5, cachedInputPerMillion: 0, outputPerMillion: 1 } });
    const claude = hostFor('claude', claudeModule([{ id: 'msg_1', input: 100, output: 20 }]));
    writeFileSync(usageSettingsFile(claude.dataDir), broken);
    const fine = await last(claude.host);
    expect(fine.usage!.records).toHaveLength(1);
    expect(fine.usage!.notices).toEqual([]);
    const codex = hostFor('codex', { Codex });
    writeFileSync(usageSettingsFile(codex.dataDir), broken);
    const a = await last(codex.host);
    expect(a.parts[0]!.text).toBe('Answer.');
    expect(a.usage!.records[0]!.costUsd).toBeUndefined();
    expect(a.usage!.notices).toHaveLength(1);
    expect(a.usage!.notices[0]).toMatch(/^This answer has no dollar figure: Toil UI's saved Codex rates: codexRates\.inputPerMillion.* Or save the rates again under Settings, Usage\.$/);
  });
});

// ---------------------------------------------------------------- the server's routes

const running: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (running.length) await running.pop()!();
});

function send(origin: string, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  const url = new URL(path, origin);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path: url.pathname, method: options.method ?? 'GET', headers: { host: url.host, ...cookieHeader(origin), ...options.headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

describe("the server's usage routes", () => {
  async function serve(control = usageControl({ dataDir: mkdtempSync(join(folder, 'srv-')), ledger: memoryLedger(sampleUsageRecords()), retentionDays: 30, now: () => new Date(FIXTURE_NOW) })) {
    const app = mkdtempSync(join(folder, 'app-'));
    writeFileSync(join(app, 'index.html'), '<!doctype html>');
    const asked: unknown[] = [];
    const agent = { ...fixtureAgent(), ask: async (_c: RequestContext, d: string, p: string, s: unknown, chat: unknown) => (asked.push(chat), fixtureAgent().ask(_c, d, p, null)) };
    const ui = createUiServer({ settings: { host: '127.0.0.1', port: 0, basePath: '/', dataDir: app, retentionDays: 30, sample: false }, store: fixtureStore(), agent, appDir: app, version: 't', toil: { version: 't', contractVersion: 1 }, usage: control });
    const { origin } = await ui.listen();
    await letInto(origin);
    running.push(() => ui.close());
    const post = (path: string, body: unknown) => send(origin, path, { method: 'POST', body: JSON.stringify(body), headers: { origin, 'content-type': 'application/json' } });
    const get = (path: string) => send(origin, path);
    return { post, get, asked };
  }

  it("answer the window's records and the settings, and save only settings that parse", async () => {
    const { get, post } = await serve();
    const view = JSON.parse((await get('/api/usage')).body);
    expect(view.since).toBe('2026-09-14T00:00:00.000Z');
    expect(view.records.length).toBeGreaterThan(20);
    expect(view.settings).toEqual({ codexRates: null });
    const bad = await post('/api/usage/settings', { codexRates: { inputPerMillion: 'none', cachedInputPerMillion: 0, outputPerMillion: 1 } });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error.message).toContain('codexRates.inputPerMillion');
    expect((await post('/api/usage/settings', { caps: {} })).status).toBe(400);
    const rates = { inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 15 };
    const ok = await post('/api/usage/settings', { codexRates: rates });
    expect(JSON.parse(ok.body).settings).toEqual({ codexRates: rates });
  });

  it('pass the chat a question belongs to, and refuse one that is not a chat', async () => {
    const { post, asked } = await serve();
    expect((await post('/api/agent/ask', { toilProject: 'card-payments', prompt: 'risk', chat: { id: 'abc12345-0000-0000-0000-000000000000', turn: 2 } })).status).toBe(200);
    expect(asked).toEqual([{ id: 'abc12345-0000-0000-0000-000000000000', turn: 2 }]);
    expect((await post('/api/agent/ask', { toilProject: 'card-payments', prompt: 'risk', chat: { id: '../x', turn: 1 } })).status).toBe(400);
    expect((await post('/api/agent/ask', { toilProject: 'card-payments', prompt: 'risk', chat: { id: 'abc12345', turn: 0 } })).status).toBe(400);
  });

  it("send a failed run's usage with its error, streamed or not", async () => {
    const app = mkdtempSync(join(folder, 'app-'));
    writeFileSync(join(app, 'index.html'), '<!doctype html>');
    const usage: AnswerUsage = { adapter: 'claude', records: [rec({ id: 'claude:msg_1', inputTokens: 600 })], notices: [] };
    const fail = () => Object.assign(new AgentErrorClass('stopped partway', 'ask again'), { usage });
    const agent = {
      ...fixtureAgent(),
      ask: async () => {
        throw fail();
      },
      async *stream() {
        yield* [];
        throw fail();
      },
    };
    const ui = createUiServer({ settings: { host: '127.0.0.1', port: 0, basePath: '/', dataDir: app, retentionDays: 30, sample: false }, store: fixtureStore(), agent, appDir: app, version: 't', toil: { version: 't', contractVersion: 1 } });
    const { origin } = await ui.listen();
    await letInto(origin);
    running.push(() => ui.close());
    const post = (body: unknown) => send(origin, '/api/agent/ask', { method: 'POST', body: JSON.stringify(body), headers: { origin, 'content-type': 'application/json' } });
    const whole = await post({ toilProject: 'card-payments', prompt: 'q' });
    expect(whole.status).toBe(502);
    expect(JSON.parse(whole.body).error).toEqual({ message: 'stopped partway', fix: 'ask again', usage });
    const streamed = await post({ toilProject: 'card-payments', prompt: 'q', stream: true });
    expect(JSON.parse(streamed.body.trim().split('\n').at(-1)!).error.usage).toEqual(usage);
  });

  it('with sample data, show the sample settings and save nothing', async () => {
    const { get, post } = await serve(usageControl({ dataDir: mkdtempSync(join(folder, 'srv-')), ledger: memoryLedger(), retentionDays: null, sample: SAMPLE_USAGE_SETTINGS }));
    expect(JSON.parse((await get('/api/usage')).body)).toMatchObject({ sample: true, settings: SAMPLE_USAGE_SETTINGS });
    expect((await post('/api/usage/settings', { codexRates: null })).status).toBe(400);
  });
});
