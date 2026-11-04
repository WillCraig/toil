import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpAgent, httpExecute, signIn, type Session } from '../src/server-client.ts';

/**
 * The page's side of the session: it trades the launch token for a session id
 * kept in the tab's storage, takes the token out of the address bar, and sends the id as
 * a header (never relying on a cookie) on every call. fetch is stubbed.
 */

const SESSION: Session = { session: 'sid-1', csrf: 'csrf-1', version: '0.0.0', toil: { version: '0.1.0-alpha.2', contractVersion: 1 }, viewer: { id: 'local', name: 'you' }, store: 'fixture', sync: false, agent: 'scripted', sample: true, now: '2026-10-13T08:00:00.000Z' };

afterEach(() => vi.unstubAllGlobals());

/** A tab's storage, holding the kept session if one is given. */
function memory(kept?: { session: string }) {
  const map = new Map<string, string>(kept ? [['toil-ui-session', JSON.stringify(kept)]] : []);
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
}

describe('signIn', () => {
  it('posts the launch token, then drops it from the URL', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(SESSION), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const replaceState = vi.fn();
    const session = await signIn('./', { search: '?token=abc', pathname: '/', hash: '#/dossier/x' }, { replaceState });
    expect(session.session).toBe('sid-1');
    expect(fetch).toHaveBeenCalledWith('./api/session', expect.objectContaining({ method: 'POST', credentials: 'omit', body: JSON.stringify({ token: 'abc' }) }));
    expect(replaceState).toHaveBeenCalledWith(null, '', '/#/dossier/x');
  });

  it('keeps a theme in the address while dropping the token (#277)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(SESSION), { status: 200 })));
    const replaceState = vi.fn();
    await signIn('./', { search: '?token=abc&theme=realm&scheme=light', pathname: '/', hash: '#/' }, { replaceState });
    expect(replaceState).toHaveBeenCalledWith(null, '', '/?theme=realm&scheme=light#/');
  });

  it('keeps the session in the tab, not the token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(SESSION), { status: 200 })));
    const storage = memory();
    await signIn('./', { search: '?token=abc', pathname: '/', hash: '' }, { replaceState: vi.fn() }, storage);
    expect(JSON.parse(storage.getItem('toil-ui-session')!)).toEqual({ session: 'sid-1' });
    expect(storage.getItem('toil-ui-session')).not.toContain('abc');
  });

  it('resumes the kept session on a reload, asking the server with the id', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(SESSION), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const storage = memory({ session: 'sid-1' });
    const session = await signIn('./', { search: '', pathname: '/', hash: '' }, { replaceState: vi.fn() }, storage);
    expect(session).toEqual(SESSION);
    expect(fetch).toHaveBeenCalledWith('./api/session', { credentials: 'omit', headers: { 'X-Toil-UI-Session': 'sid-1' } });
  });

  it('forgets a kept session the restarted server does not know, and says to open the launch URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    const storage = memory({ session: 'old' });
    await expect(signIn('./', { search: '', pathname: '/', hash: '' }, { replaceState: vi.fn() }, storage)).rejects.toThrow(/Open the URL toil-ui printed.*restart|restarted.*Open the URL toil-ui printed/s);
    expect(storage.getItem('toil-ui-session')).toBeNull();
  });

  it('keeps the session when the server fails for another reason than not knowing it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    const storage = memory({ session: 'sid-1' });
    await expect(signIn('./', { search: '', pathname: '/', hash: '' }, { replaceState: vi.fn() }, storage)).rejects.toThrow(/Resuming the session failed/);
    expect(storage.getItem('toil-ui-session')).not.toBeNull();
  });

  it('treats a broken kept value as no session, without asking the server', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const broken = { getItem: () => '{oops', setItem: () => undefined, removeItem: () => undefined };
    await expect(signIn('./', { search: '', pathname: '/', hash: '' }, { replaceState: vi.fn() }, broken)).rejects.toThrow(/This tab has no session/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('drops a kept session when a new launch token is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'No.' } }), { status: 401 })));
    const storage = memory({ session: 'old' });
    await expect(signIn('./', { search: '?token=bad', pathname: '/', hash: '' }, { replaceState: vi.fn() }, storage)).rejects.toThrow('No.');
    expect(storage.getItem('toil-ui-session')).toBeNull();
  });

  it('says to open the launch URL when the tab has no token and no kept session', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(signIn('./', { search: '', pathname: '/', hash: '' }, { replaceState: vi.fn() }, memory())).rejects.toThrow(/Open the URL toil-ui printed/);
    await expect(signIn('./', { search: '', pathname: '/', hash: '' }, { replaceState: vi.fn() }, null)).rejects.toThrow(/Open the URL toil-ui printed/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still signs in where storage is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(SESSION), { status: 200 })));
    const refusing = { getItem: () => null, removeItem: () => undefined, setItem: () => { throw new Error('QuotaExceededError'); } };
    expect((await signIn('./', { search: '?token=abc', pathname: '/', hash: '' }, { replaceState: vi.fn() }, refusing)).session).toBe('sid-1');
  });
});

describe('httpExecute', () => {
  it('sends the session id and CSRF token as headers, and no cookie', async () => {
    const envelope = { ok: true, data: { dossiers: [] }, error: null, meta: { command: 'dossiers list', durationMs: 0, version: 'x', contractVersion: 1 } };
    const fetch = vi.fn(async () => new Response(JSON.stringify(envelope), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect(await httpExecute(SESSION)('dossiers list', {}, { readOnly: true, caller: 'toil-ui' })).toEqual(envelope);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('./api/execute');
    expect(init.credentials).toBe('omit');
    expect(init.headers).toEqual({ 'X-Toil-UI-Session': 'sid-1', 'Content-Type': 'application/json', 'X-Toil-UI-CSRF': 'csrf-1' });
    expect(JSON.parse(String(init.body))).toEqual({ command: 'dossiers list', input: {} });
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
    const agent = await httpAgent({ ...SESSION, agent: 'claude' }, []);
    const seen = [];
    for await (const a of agent.stream!('card-payments', 'q')) seen.push(a.parts[0]!.text);
    expect(seen).toEqual(['a', 'ab']);
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ dossier: 'card-payments', prompt: 'q', stream: true });
  });

  it("throws the server's message and fix when the agent fails partway, and when the stream just stops", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ndjson([{ answer: answer('a') }, { error: { message: 'Claude Code stopped.', fix: 'Sign in.' } }])));
    const agent = await httpAgent({ ...SESSION, agent: 'claude' }, []);
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
    const agent = await httpAgent({ ...SESSION, agent: 'claude' }, []);
    await agent.ask('d', 'q', undefined, undefined, { adapter: 'claude', fallback: true });
    await agent.ask('d', 'q', undefined, undefined, { adapter: 'codex' });
    const bodies = fetch.mock.calls.filter(([url]) => String(url).endsWith('api/agent/ask')).map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies.map((b) => [b.adapter, b.fallback])).toEqual([['claude', true], ['codex', undefined]]);
  });

  it('carries a plain notice, and the three adapters one step in, when the server has none', async () => {
    const agent = await httpAgent({ ...SESSION, agent: 'none' }, []);
    expect(agent.notice).not.toContain('@anthropic-ai');
    for (const p of ['@anthropic-ai/claude-agent-sdk', '@github/copilot-sdk', '@openai/codex-sdk']) expect(agent.noticeDetails).toContain(p);
  });
});
