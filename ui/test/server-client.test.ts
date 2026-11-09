import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpAgent, httpExecute, readServerInfo, type ServerInfo } from '../src/server-client.ts';

/**
 * The page's side of the server (#561): it asks what the server is, and sends
 * each call as JSON with nothing else: no token, session id or CSRF header, no
 * cookie, and nothing kept in the tab's storage. fetch is stubbed.
 */

const INFO: ServerInfo = { version: '0.0.0', toil: { version: '0.1.0-alpha.2', contractVersion: 1 }, viewer: { id: 'local', name: 'you' }, store: 'fixture', sync: false, agent: 'scripted', sample: true, now: '2026-10-13T08:00:00.000Z' };

afterEach(() => vi.unstubAllGlobals());

describe('readServerInfo', () => {
  it('asks the server what it is, with no header, cookie or stored value', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(INFO), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect(await readServerInfo()).toEqual(INFO);
    expect(fetch).toHaveBeenCalledWith('./api/info', { credentials: 'same-origin' });
  });

  it("shows the server's refusal with its fix", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'This server answers only to 127.0.0.1:4960.', fix: 'Open http://127.0.0.1:4960/.' } }), { status: 403 })));
    await expect(readServerInfo()).rejects.toThrow('This server answers only to 127.0.0.1:4960. Open http://127.0.0.1:4960/.');
  });

  it('says what failed when the answer is not an error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(readServerInfo()).rejects.toThrow(/Reading what the server is failed: the server answered 500/);
  });

  it('keeps nothing in the tab: no sessionStorage and no localStorage read or write', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(INFO), { status: 200 })));
    const touched = vi.fn();
    const trap = new Proxy({}, { get: (_t, key) => (touched(String(key)), () => null) });
    vi.stubGlobal('sessionStorage', trap);
    vi.stubGlobal('localStorage', trap);
    await readServerInfo();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, data: null, error: null, meta: { command: 'projects list' } }), { status: 200 })));
    await httpExecute()('projects list', {}, { readOnly: true, caller: 'toil-ui' });
    expect(touched).not.toHaveBeenCalled();
  });
});

describe('httpExecute', () => {
  it('sends the call as JSON, and no session, CSRF or cookie', async () => {
    const envelope = { ok: true, data: { toilProjects: [] }, error: null, meta: { command: 'projects list', durationMs: 0, version: 'x', contractVersion: 1 } };
    const fetch = vi.fn(async () => new Response(JSON.stringify(envelope), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect(await httpExecute()('projects list', {}, { readOnly: true, caller: 'toil-ui' })).toEqual(envelope);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('./api/execute');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({ command: 'projects list', input: {} });
  });
});

describe('httpAgent streaming (#251)', () => {
  const answer = (text: string) => ({ prompt: 'q', parts: [{ text }], citations: [], by: 'Claude', proposals: [] });
  const ndjson = (lines: unknown[], split = 7) => {
    const text = lines.map((l) => `${JSON.stringify(l)}\n`).join('');
    // Chunks that cut lines in half, as a network does.
    const chunks = Array.from({ length: Math.ceil(text.length / split) }, (_, i) => text.slice(i * split, (i + 1) * split));
    return new Response(new ReadableStream({ start: (c) => (chunks.forEach((x) => c.enqueue(new TextEncoder().encode(x))), c.close()) }), { headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } });
  };

  it('asks with stream: true and yields each version of the answer, however the bytes arrive', async () => {
    const fetch = vi.fn(async () => ndjson([{ answer: answer('a') }, { answer: answer('ab') }, { done: true }]));
    vi.stubGlobal('fetch', fetch);
    const agent = await httpAgent({ ...INFO, agent: 'claude' }, []);
    const seen = [];
    for await (const a of agent.stream!('card-payments', 'q')) seen.push(a.parts[0]!.text);
    expect(seen).toEqual(['a', 'ab']);
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ toilProject: 'card-payments', prompt: 'q', stream: true });
  });

  it("throws the server's message and fix when the agent fails partway, and when the stream just stops", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ndjson([{ answer: answer('a') }, { error: { message: 'Claude Code stopped.', fix: 'Sign in.' } }])));
    const agent = await httpAgent({ ...INFO, agent: 'claude' }, []);
    const run = async () => {
      for await (const _ of agent.stream!('d', 'q')) void _;
    };
    await expect(run()).rejects.toThrow('Claude Code stopped. Sign in.');
    vi.stubGlobal('fetch', vi.fn(async () => ndjson([{ answer: answer('a') }])));
    await expect(run()).rejects.toThrow(/stopped partway/);
  });

  it('sends the chat\'s adapter, and says when it is only a fallback, so the server does not remember it (#543)', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(answer('a')), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const agent = await httpAgent({ ...INFO, agent: 'claude' }, []);
    await agent.ask('d', 'q', undefined, undefined, { adapter: 'claude', fallback: true });
    await agent.ask('d', 'q', undefined, undefined, { adapter: 'codex' });
    const bodies = fetch.mock.calls.filter(([url]) => String(url).endsWith('api/agent/ask')).map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies.map((b) => [b.adapter, b.fallback])).toEqual([['claude', true], ['codex', undefined]]);
  });

  it('carries a plain notice, and the three adapters one step in, when the server has none', async () => {
    const agent = await httpAgent({ ...INFO, agent: 'none' }, []);
    expect(agent.notice).not.toContain('@anthropic-ai');
    for (const p of ['@anthropic-ai/claude-agent-sdk', '@github/copilot-sdk', '@openai/codex-sdk']) expect(agent.noticeDetails).toContain(p);
  });
});
