// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mapOwi } from '@imagile-dev/toil/api';
import { defaultAgent, sourceHint } from '../src/agent-default.ts';
import type { AdapterList, AdapterOption, Answer } from '../src/agent.ts';
import { DossierAgents, dossierAgentsFile } from '../server/agents/dossier-agents.ts';
import type { Agent } from '../server/agent.ts';
import { Cache } from '../server/cache.ts';
import { CSRF_HEADER, SESSION_HEADER, createUiServer } from '../server/server.ts';
import { fixtureStore } from '../server/store.ts';
import { SyncService } from '../server/sync.ts';
import { stubToil } from './toil-stub.ts';

/**
 * The agent Analyze starts on (#494): the order it is chosen in, the file that
 * remembers it per dossier across a restart, a rename and a forget, and the
 * server saying it and learning it from a whole Analyze.
 */

const folders: string[] = [];
const caches: Cache[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  while (caches.length) caches.pop()!.close();
  while (folders.length) rmSync(folders.pop()!, { recursive: true, force: true, maxRetries: 3 });
});
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), 'toil-ui-dossier-agents-'));
  folders.push(dir);
  return dir;
};

const option = (name: string, ready = true): AdapterOption => ({ name, label: name, model: null, ready, problem: ready ? null : 'Not signed in', fix: null, action: ready ? null : 'fix' });
const list = (over: Partial<AdapterList> & { ready?: Record<string, boolean> } = {}): AdapterList => ({
  chosen: 'claude',
  options: ['claude', 'codex', 'copilot'].map((n) => option(n, over.ready?.[n] ?? true)),
  ...(over.remembered !== undefined ? { remembered: over.remembered } : {}),
  ...(over.chosen !== undefined ? { chosen: over.chosen } : {}),
});

describe('the order the agent is chosen in', () => {
  it("is the dossier's remembered agent, then the default from Settings, then the first one ready, then nothing", () => {
    expect(defaultAgent(list({ remembered: 'codex' }))).toEqual({ name: 'codex', source: 'dossier' });
    expect(defaultAgent(list({ remembered: null }))).toEqual({ name: 'claude', source: 'settings' });
    expect(defaultAgent(list())).toEqual({ name: 'claude', source: 'settings' });
    expect(defaultAgent(list({ remembered: 'codex', ready: { codex: false, claude: false } }))).toEqual({ name: 'copilot', source: 'ready', skippedDefault: true });
    expect(defaultAgent(list({ chosen: null }))).toEqual({ name: 'claude', source: 'ready' });
    expect(defaultAgent(list({ chosen: 'copilot', ready: { copilot: false } }))).toEqual({ name: 'claude', source: 'ready', skippedDefault: true });
    expect(defaultAgent(list({ ready: { claude: false, codex: false, copilot: false } }))).toBeNull();
    expect(defaultAgent(null)).toBeNull();
  });

  it('skips an agent that is not ready, and one the list no longer has', () => {
    expect(defaultAgent(list({ remembered: 'codex', ready: { codex: false } }))).toEqual({ name: 'claude', source: 'settings' });
    expect(defaultAgent(list({ remembered: 'gemini' }))).toEqual({ name: 'claude', source: 'settings' });
    expect(defaultAgent(list({ remembered: 'copilot', ready: { copilot: false } }))?.source).toBe('settings');
  });

  it('says where it came from in a few words', () => {
    expect(sourceHint(false, { name: 'codex', source: 'dossier' })).toBe('last used on this dossier');
    expect(sourceHint(false, { name: 'claude', source: 'settings' })).toBe('your default');
    expect(sourceHint(true, { name: 'claude', source: 'settings' })).toBe('picked for this chat');
    expect(sourceHint(false, { name: 'claude', source: 'ready', skippedDefault: true })).toBe("your default can't run");
    expect(sourceHint(false, { name: 'claude', source: 'ready' })).toBe('the first one ready');
    expect(sourceHint(false, null)).toBeNull();
  });
});

describe("the file that remembers an agent per dossier", () => {
  it('persists across a restart, in the data folder, with nothing but names in it', () => {
    const dir = folder();
    const first = new DossierAgents(dir);
    expect(first.get('card-payments')).toBeNull();
    expect(first.set('card-payments', 'codex')).toBe(true);
    expect(first.set('settlement', 'copilot')).toBe(true);
    const second = new DossierAgents(dir);
    expect(second.get('card-payments')).toBe('codex');
    expect(second.get('settlement')).toBe('copilot');
    expect(JSON.parse(readFileSync(dossierAgentsFile(dir), 'utf8'))).toEqual({ version: 1, agents: { 'card-payments': 'codex', settlement: 'copilot' } });
  });

  it('changes when a different agent is picked', () => {
    const dir = folder();
    const store = new DossierAgents(dir);
    store.set('card-payments', 'codex');
    store.set('card-payments', 'claude');
    expect(new DossierAgents(dir).get('card-payments')).toBe('claude');
  });

  it('refuses a name that is not an adapter or a dossier, and never starts from a broken file', () => {
    const dir = folder();
    const store = new DossierAgents(dir);
    expect(store.set('card-payments', 'gemini')).toBe(false);
    expect(store.set('Card Payments', 'codex')).toBe(false);
    expect(store.set('../x', 'codex')).toBe(false);
    expect(store.get('Card Payments')).toBeNull();
    writeFileSync(dossierAgentsFile(dir), '{ not json');
    expect(new DossierAgents(dir).get('card-payments')).toBeNull();
    writeFileSync(dossierAgentsFile(dir), JSON.stringify({ version: 1, agents: { 'card-payments': 'gemini', '../x': 'codex', settlement: 'codex' } }));
    const loaded = new DossierAgents(dir);
    expect(loaded.get('card-payments')).toBeNull();
    expect(loaded.get('settlement')).toBe('codex');
    writeFileSync(dossierAgentsFile(dir), JSON.stringify({ agents: ['codex'] }));
    expect(new DossierAgents(dir).get('settlement')).toBeNull();
  });

  it('moves the memory when a dossier is renamed, replacing what the new name held, and survives a stale key', () => {
    const dir = folder();
    const store = new DossierAgents(dir);
    store.set('card-payments', 'codex');
    store.set('payments', 'copilot');
    store.rename('card-payments', 'payments');
    expect(store.get('card-payments')).toBeNull();
    expect(store.get('payments')).toBe('codex');
    expect(new DossierAgents(dir).get('payments')).toBe('codex');
    // A rename of a dossier with no memory clears whatever the new name held; one to itself does nothing.
    store.rename('never-asked', 'payments');
    expect(store.get('payments')).toBeNull();
    store.set('settlement', 'claude');
    store.rename('settlement', 'settlement');
    expect(store.get('settlement')).toBe('claude');
    expect(() => store.rename('a', 'Not A Name')).not.toThrow();
  });

  it('forgets a dossier', () => {
    const dir = folder();
    const store = new DossierAgents(dir);
    store.set('card-payments', 'codex');
    store.forget('card-payments');
    store.forget('never-there');
    expect(new DossierAgents(dir).get('card-payments')).toBeNull();
  });

  it('is forgotten by a sync when toil no longer has the dossier', async () => {
    const dir = folder();
    const cache = await Cache.open(dir, { retentionDays: 30 });
    caches.push(cache);
    const toil = stubToil();
    const store = new DossierAgents(dir);
    const sync = new SyncService({ cache, execute: toil.execute, mapOwi, onForget: (d) => store.forget(d) });
    const ctx = { viewer: { id: 'local', name: 'you', via: 'launch-token' as const }, signal: new AbortController().signal };
    await sync.run(ctx);
    store.set('checkout-web', 'codex');
    store.set('settlement', 'claude');
    const dossiers = toil.canned.find((c) => c.command === 'dossiers list')!.data as { dossiers: Array<{ name: string }> };
    dossiers.dossiers = dossiers.dossiers.filter((d) => d.name !== 'checkout-web');
    await sync.run(ctx);
    expect(store.get('checkout-web')).toBeNull();
    expect(store.get('settlement')).toBe('claude');
  });
});

describe('the server', () => {
  const TOKEN = 'launch-token-for-tests';
  const app = folder();

  function send(origin: string, path: string, sid: string, body?: unknown, csrf?: string): Promise<{ status: number; body: string }> {
    const url = new URL(path, origin);
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { host: url.host, [SESSION_HEADER]: sid };
      if (body !== undefined) Object.assign(headers, { origin, 'content-type': 'application/json', [CSRF_HEADER]: csrf! });
      const req = request({ host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: body === undefined ? 'GET' : 'POST', headers }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode!, body: text }));
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  async function boot(store: DossierAgents, answer: (adapter: string | undefined) => Answer | Error) {
    const asked: Array<string | undefined> = [];
    const agent: Agent = {
      kind: 'scripted',
      starters: async () => [],
      ask: async (_ctx, _d, _p, _s, _c, extra) => {
        asked.push(extra?.adapter);
        const a = answer(extra?.adapter);
        if (a instanceof Error) throw a;
        return a;
      },
      async *stream(_ctx, _d, _p, _s, _c, extra) {
        asked.push(extra?.adapter);
        const a = answer(extra?.adapter);
        if (a instanceof Error) throw a;
        yield a;
      },
      adapterOptions: () => list(),
    };
    const ui = createUiServer({ settings: { host: '127.0.0.1', port: 0, basePath: '/', dataDir: app, retentionDays: 30, sample: true }, store: fixtureStore(), agent, appDir: app, version: '0.0.0-test', toil: { version: '0.1.0', contractVersion: 1 }, token: TOKEN, dossierAgents: store });
    const address = await ui.listen();
    closers.push(() => ui.close());
    const res = await new Promise<{ body: string }>((resolve, reject) => {
      const url = new URL('/api/session', address.origin);
      const req = request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { host: url.host, origin: address.origin, 'content-type': 'application/json' } }, (r) => {
        let text = '';
        r.setEncoding('utf8');
        r.on('data', (c: string) => (text += c));
        r.on('end', () => resolve({ body: text }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ token: TOKEN }));
    });
    const session = JSON.parse(res.body) as { session: string; csrf: string };
    return { origin: address.origin, sid: session.session, csrf: session.csrf, asked };
  }

  const whole: Answer = { prompt: 'Analyze', parts: [{ text: 'Fine.' }], citations: [], by: 'Codex', proposals: [] };

  it("says the dossier's remembered agent with the list, and learns it from a whole Analyze that named one", async () => {
    const store = new DossierAgents(folder());
    const { origin, sid, csrf, asked } = await boot(store, () => whole);
    const read = async (dossier: string) => JSON.parse((await send(origin, `/api/agent/adapters?dossier=${dossier}`, sid)).body) as AdapterList;
    expect((await read('card-payments')).remembered).toBeUndefined();
    expect((await send(origin, '/api/agent/ask', sid, { dossier: 'card-payments', prompt: 'analyze', adapter: 'codex' }, csrf)).status).toBe(200);
    expect(asked).toEqual(['codex']);
    expect((await read('card-payments')).remembered).toBe('codex');
    expect((await read('settlement')).remembered).toBeUndefined();
    expect(JSON.parse((await send(origin, '/api/agent/adapters', sid)).body).remembered).toBeUndefined();
    // Another agent picked: the memory follows.
    await send(origin, '/api/agent/ask', sid, { dossier: 'card-payments', prompt: 'analyze', adapter: 'claude' }, csrf);
    expect(new DossierAgents(dirOf(store)).get('card-payments')).toBe('claude');
  });

  it('remembers an ordinary question that names an agent', async () => {
    const store = new DossierAgents(folder());
    const { origin, sid, csrf } = await boot(store, () => whole);
    await send(origin, '/api/agent/ask', sid, { dossier: 'card-payments', prompt: 'What is blocked?', adapter: 'codex' }, csrf);
    expect(store.get('card-payments')).toBe('codex');
    // Streamed, as the page asks: the same.
    await send(origin, '/api/agent/ask', sid, { dossier: 'settlement', prompt: 'What is blocked?', adapter: 'claude', stream: true }, csrf);
    expect(store.get('settlement')).toBe('claude');
  });

  it('refuses a fallback that names no adapter', async () => {
    const store = new DossierAgents(folder());
    const { origin, sid, csrf } = await boot(store, () => whole);
    const res = await send(origin, '/api/agent/ask', sid, { dossier: 'card-payments', prompt: 'What is blocked?', fallback: true }, csrf);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.message).toContain('fallback names no adapter');
  });

  it('remembers nothing from a question that names no agent, names only a fallback, or fails or comes back empty', async () => {
    const store = new DossierAgents(folder());
    let next: Answer | Error = whole;
    const { origin, sid, csrf } = await boot(store, () => next);
    await send(origin, '/api/agent/ask', sid, { dossier: 'card-payments', prompt: 'What is blocked?' }, csrf);
    await send(origin, '/api/agent/ask', sid, { dossier: 'card-payments', prompt: 'analyze' }, csrf);
    await send(origin, '/api/agent/ask', sid, { dossier: 'card-payments', prompt: 'What is blocked?', adapter: 'codex', fallback: true }, csrf);
    next = new Error('The agent is not signed in.');
    expect((await send(origin, '/api/agent/ask', sid, { dossier: 'card-payments', prompt: 'analyze', adapter: 'codex' }, csrf)).status).toBe(502);
    next = { ...whole, parts: [] };
    await send(origin, '/api/agent/ask', sid, { dossier: 'card-payments', prompt: 'analyze', adapter: 'codex' }, csrf);
    expect(store.get('card-payments')).toBeNull();
  });

  /** The folder a store was opened on: its file sits in it. */
  function dirOf(_store: DossierAgents): string {
    return (_store as unknown as { dataDir: string }).dataDir;
  }
});
