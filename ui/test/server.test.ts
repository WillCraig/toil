// @vitest-environment node
import { createHash } from 'node:crypto';
import type { InstallPlan } from '../server/agents/install.ts';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { fixtureAgent, noAgent, type Agent } from '../server/agent.ts';
import { AgentError } from '../server/agents/cli.ts';
import type { AnalysisKeeper } from '../server/analyses.ts';
import type { RequestContext } from '../server/context.ts';
import { PRESSABLE_STYLE_HASH } from '../server/csp.ts';
import { CSP, CSRF_HEADER, MAX_BODY, SESSION_HEADER, MAX_SESSIONS, createUiServer, type UiServerOptions } from '../server/server.ts';
import { parseSettings, SettingsError, themesNotice, type Settings } from '../server/settings.ts';
import { mapOwi } from '@imagile-dev/toil/api';
import { Cache, CacheError, RUNNING_MESSAGE, cachePaths, liveLock, pidAlive, wipeCacheFiles } from '../server/cache.ts';
import { spawn, spawnSync } from 'node:child_process';
import { CALLER, READ_COMMANDS, fixtureStore, sqliteStore, toilStore, type Access, type Store } from '../server/store.ts';
import { SyncService } from '../server/sync.ts';
import { stubToil } from './toil-stub.ts';
import { CANNED } from '../src/fixtures/execute.ts';
import { JQL } from '../src/load.ts';
import type { Envelope, Execute } from '../src/toil.ts';

/**
 * The local server, over real loopback sockets: the Host check, the launch
 * token and the session id it trades for (a header, never a cookie), the POST
 * checks (Origin, JSON, CSRF), the read allowlist and the config allowlist,
 * the viewer on every call, and the static files. node:http's own client sends whatever Host and Origin a test names,
 * which is how a rebinding page or a foreign origin is played.
 */

const TOKEN = 'launch-token-for-tests';
const app = mkdtempSync(join(tmpdir(), 'toil-ui-app-'));
mkdirSync(join(app, 'assets'));
writeFileSync(join(app, 'index.html'), '<!doctype html><div id="root"></div>');
writeFileSync(join(app, 'assets', 'app.js'), 'console.log(1);');
writeFileSync(join(app, 'assets', '..app.js'), 'console.log(2);');
writeFileSync(join(tmpdir(), 'toil-ui-secret.txt'), 'outside the app folder');

const settings = (over: Partial<Settings> = {}): Settings => ({ host: '127.0.0.1', port: 0, basePath: '/', dataDir: join(app, 'data'), retentionDays: 30, sample: true, ...over });

interface Seen {
  ctx: RequestContext;
  command: string;
  input: Record<string, unknown>;
  access: Access;
}

/** A Store that records what reached it, answering from the fixture. */
function watched(): { store: Store; seen: Seen[] } {
  const inner = fixtureStore();
  const seen: Seen[] = [];
  return {
    seen,
    store: { ...inner, execute: (ctx, command, input, access) => (seen.push({ ctx, command, input, access }), inner.execute(ctx, command, input, access)) },
  };
}

const running: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (running.length) await running.pop()!();
});

async function start(over: Partial<UiServerOptions> = {}) {
  const ui = createUiServer({ settings: settings(), store: fixtureStore(), agent: fixtureAgent(), appDir: app, version: '0.0.0-test', toil: { version: '0.1.0-alpha.2', contractVersion: 1 }, token: TOKEN, ...over });
  const address = await ui.listen();
  running.push(() => ui.close());
  const host = new URL(address.origin).host;
  return { ui, ...address, host };
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(origin: string, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  const url = new URL(path, origin);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port, path: `${url.pathname}${url.search}`, method: options.method ?? 'GET', headers: { host: url.host, ...options.headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

/** Trades the launch token for a session id, as the page does, and returns it with the session. */
async function signIn(origin: string, base = '/', token = TOKEN) {
  const res = await send(origin, `${base}api/session`, { method: 'POST', body: JSON.stringify({ token }), headers: { origin, 'content-type': 'application/json' } });
  const session = JSON.parse(res.body) as { session: string; csrf: string } & Record<string, unknown>;
  return { sid: session.session, session, res };
}

async function post(origin: string, path: string, body: unknown, auth: { sid: string; csrf: string }, headers: Record<string, string> = {}) {
  return send(origin, path, { method: 'POST', body: JSON.stringify(body), headers: { [SESSION_HEADER]: auth.sid, origin, 'content-type': 'application/json', [CSRF_HEADER]: auth.csrf, ...headers } });
}

const noCors = (r: Reply) => Object.keys(r.headers).filter((h) => h.startsWith('access-control-'));

describe('the lock on the door', () => {
  it('refuses any Host but the one it printed, before reading anything else', async () => {
    const { origin, host } = await start();
    for (const other of ['rebind.imagile.dev', `localhost:${new URL(origin).port}`, `127.0.0.1:1`, `127.0.0.1.rebind.imagile.dev:${new URL(origin).port}`]) {
      const res = await send(origin, `/?token=${TOKEN}`, { headers: { host: other } });
      expect(res.status, other).toBe(403);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.body).toContain(`http://${host}`);
    }
  });

  it('serves the app without a session, since its files hold no data, and never sets a cookie', async () => {
    const { origin, launchUrl } = await start();
    expect(launchUrl).toBe(`${origin}/?token=${TOKEN}`);
    for (const path of ['/', `/?token=${TOKEN}`, '/?token=not-it', '/assets/app.js']) {
      const res = await send(origin, path);
      expect(res.status, path).toBe(200);
      expect(res.headers['set-cookie'], path).toBeUndefined();
    }
    const page = await send(origin, '/');
    expect(page.body).toContain('<div id="root">');
    expect(page.headers['content-security-policy']).toBe(CSP);
    expect(CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self' 'sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o='; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'none'; media-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    // Every response carries it, a refused API call and a missing file included.
    for (const path of ['/api/session', '/no-such-file.css', '/assets/app.js']) expect((await send(origin, path)).headers['content-security-policy'], path).toBe(CSP);
    expect(CSP).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/);
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(noCors(page)).toEqual([]);
  });

  it("allows by hash only the one style React Aria adds, and recomputes that hash from React Aria's source", () => {
    const source = readFileSync(join(import.meta.dirname, '..', '..', 'node_modules', 'react-aria', 'dist', 'private', 'interactions', 'usePress.mjs'), 'utf8');
    const text = /style\.textContent = `([\s\S]*?)`\.trim\(\)/.exec(source)?.[1]?.replace('${$d27d541f9569d26d$var$PRESSABLE_ATTRIBUTE}', 'data-react-aria-pressable').trim();
    expect(text, 'React Aria no longer adds its pressable style this way; check the browser console for a CSP report').toBeTruthy();
    expect(`sha256-${createHash('sha256').update(text!).digest('base64')}`).toBe(PRESSABLE_STYLE_HASH);
  });

  it('trades the launch token for a session id in the response body, never a cookie, and refuses a wrong token', async () => {
    const { origin } = await start();
    const { res, sid, session } = await signIn(origin);
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(sid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sid).not.toBe(TOKEN);
    expect(session.csrf).not.toBe(sid);
    const wrong = await signIn(origin, '/', 'not-it');
    expect(wrong.res.status).toBe(401);
    expect(wrong.res.headers['set-cookie']).toBeUndefined();
    const foreign = await send(origin, '/api/session', { method: 'POST', body: JSON.stringify({ token: TOKEN }), headers: { origin: 'http://127.0.0.1:1', 'content-type': 'application/json' } });
    expect(foreign.status).toBe(403);
  });

  it('answers the API only with the session header: a cookie alone is refused', async () => {
    const { origin } = await start();
    const { sid, session } = await signIn(origin);
    const call = JSON.stringify({ command: 'projects list', input: {} });
    const asCookie = { cookie: `toil-ui-${new URL(origin).port}=${sid}; toil-ui=${sid}; session=${sid}` };
    for (const [path, method] of [['/api/session', 'GET'], ['/api/execute', 'POST'], ['/api/agent/starters?toilProject=card-payments', 'GET']] as const) {
      const res = await send(origin, path, { method, body: method === 'POST' ? call : undefined, headers: { ...asCookie, origin, 'content-type': 'application/json', [CSRF_HEADER]: session.csrf } });
      expect(res.status, `${method} ${path} with only a cookie`).toBe(401);
      expect(JSON.parse(res.body).error.message).toContain(SESSION_HEADER);
    }
    expect((await send(origin, '/api/session')).status).toBe(401);
    expect((await send(origin, '/api/session', { headers: { [SESSION_HEADER]: 'not-a-session' } })).status).toBe(401);
    const withHeader = await post(origin, '/api/execute', { command: 'projects list', input: {} }, { sid, csrf: session.csrf });
    expect(withHeader.status).toBe(200);
    expect((JSON.parse(withHeader.body) as Envelope).ok).toBe(true);
    expect((await send(origin, '/api/session', { headers: { [SESSION_HEADER]: sid } })).status).toBe(200);
  });

  it('never sends a CORS header, even when asked', async () => {
    const { origin } = await start();
    const { sid } = await signIn(origin);
    const preflight = await send(origin, '/api/execute', { method: 'OPTIONS', headers: { [SESSION_HEADER]: sid, origin: 'https://rebind.imagile.dev', 'access-control-request-method': 'POST' } });
    expect(preflight.status).toBe(405);
    expect(noCors(preflight)).toEqual([]);
    const get = await send(origin, '/api/session', { headers: { [SESSION_HEADER]: sid, origin: 'https://rebind.imagile.dev' } });
    expect(noCors(get)).toEqual([]);
  });

  it('keeps at most MAX_SESSIONS sessions, dropping the oldest', async () => {
    const { origin } = await start();
    const first = await signIn(origin);
    for (let i = 0; i < MAX_SESSIONS; i++) await signIn(origin);
    expect((await send(origin, '/api/session', { headers: { [SESSION_HEADER]: first.sid } })).status).toBe(401);
  });
});

describe('every POST', () => {
  it("needs the page's own Origin, a JSON body and the session's CSRF token", async () => {
    const { origin } = await start();
    const { sid, session } = await signIn(origin);
    const auth = { sid, csrf: session.csrf };
    const call = { command: 'projects list', input: {} };
    expect((await post(origin, '/api/execute', call, auth, { origin: 'https://rebind.imagile.dev' })).status).toBe(403);
    const noOrigin = await send(origin, '/api/execute', { method: 'POST', body: JSON.stringify(call), headers: { [SESSION_HEADER]: sid, 'content-type': 'application/json', [CSRF_HEADER]: session.csrf } });
    expect(noOrigin.status).toBe(403);
    expect((await post(origin, '/api/execute', call, auth, { 'content-type': 'text/plain' })).status).toBe(415);
    const noCsrf = await post(origin, '/api/execute', call, { sid, csrf: 'wrong' });
    expect(noCsrf.status).toBe(403);
    expect(JSON.parse(noCsrf.body).error.message).toContain('CSRF');
    const ok = await post(origin, '/api/execute', call, auth);
    expect(ok.status).toBe(200);
    expect((JSON.parse(ok.body) as Envelope).ok).toBe(true);
  });

  it("takes a session's CSRF token only for that session", async () => {
    const { origin } = await start();
    const a = await signIn(origin);
    const b = await signIn(origin);
    expect(a.session.csrf).not.toBe(b.session.csrf);
    expect((await post(origin, '/api/execute', { command: 'projects list' }, { sid: a.sid, csrf: b.session.csrf })).status).toBe(403);
  });

  it('refuses a body over the limit, and one that is not an object', async () => {
    const { origin } = await start();
    const { sid, session } = await signIn(origin);
    const big = await post(origin, '/api/execute', { command: 'projects list', input: { pad: 'x'.repeat(MAX_BODY) } }, { sid, csrf: session.csrf });
    expect(big.status).toBe(413);
    const list = await send(origin, '/api/execute', { method: 'POST', body: '[1]', headers: { [SESSION_HEADER]: sid, origin, 'content-type': 'application/json', [CSRF_HEADER]: session.csrf } });
    expect(list.status).toBe(400);
  });
});

describe('the API', () => {
  it('reports the session: versions, viewer, Store, Agent and the clock', async () => {
    const viewer = { id: 'local', name: 'you', via: 'launch-token' as const };
    const { origin } = await start({ viewer });
    const { session } = await signIn(origin);
    expect(session).toEqual({
      version: '0.0.0-test',
      toil: { version: '0.1.0-alpha.2', contractVersion: 1 },
      viewer: { id: 'local', name: 'you' },
      store: 'fixture',
      sync: false,
      agent: 'scripted',
      agentSettings: false,
      assignments: false,
      sample: true,
      now: '2026-10-13T08:00:00.000Z',
      csrf: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      session: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });

  it('runs a read from the allowlist read-only, with the viewer in its context', async () => {
    const { store, seen } = watched();
    const viewer = { id: 'local', name: 'you', via: 'launch-token' as const };
    const { origin } = await start({ store, viewer });
    const { sid, session } = await signIn(origin);
    const res = await post(origin, '/api/execute', { command: 'projects show', input: { toilProject: 'card-payments' } }, { sid, csrf: session.csrf });
    const env = JSON.parse(res.body) as Envelope;
    expect(env.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ command: 'projects show', input: { toilProject: 'card-payments' }, access: 'read' });
    expect(seen[0]!.ctx.viewer).toEqual(viewer);
    expect(seen[0]!.ctx.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(['connections list', 'jira issue create', 'projects field', 'util md'])('refuses %s, which the views never read, before the Store sees it', async (command) => {
    const { store, seen } = watched();
    const { origin } = await start({ store });
    const { sid, session } = await signIn(origin);
    const res = await post(origin, '/api/execute', { command, input: {} }, { sid, csrf: session.csrf });
    expect(res.status).toBe(403);
    const env = JSON.parse(res.body) as Envelope;
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.message).toContain(`toil ${command}`);
      expect(env.error.fix).toContain('CLI');
    }
    expect(seen).toEqual([]);
  });

  it("refuses on the config path anything but toil's own config commands: a tracker write never reaches a Store", async () => {
    const { store, seen } = watched();
    const { origin } = await start({ store });
    const { sid, session } = await signIn(origin);
    for (const command of ['jira issue create', 'jira issue transition', 'setup alias', 'projects remove', 'jira issue search']) {
      const res = await post(origin, '/api/config', { command, input: {} }, { sid, csrf: session.csrf });
      expect(res.status, command).toBe(403);
      expect(JSON.parse(res.body).error.message).toContain(`Toil UI doesn't change ${command} from the page`);
    }
    expect(seen).toEqual([]);
  });

  it('runs a config command on the allowlist with config access, and only those', async () => {
    const { store, seen } = watched();
    const { origin } = await start({ store, configCommands: new Set(['projects field']) });
    const { sid, session } = await signIn(origin);
    await post(origin, '/api/config', { command: 'projects field', input: { toilProject: 'card-payments' } }, { sid, csrf: session.csrf });
    expect(seen.map((s) => [s.command, s.access])).toEqual([['projects field', 'config']]);
    // A read command isn't a config command, and a config command isn't a read.
    expect((await post(origin, '/api/config', { command: 'projects list' }, { sid, csrf: session.csrf })).status).toBe(403);
    expect((await post(origin, '/api/execute', { command: 'projects field' }, { sid, csrf: session.csrf })).status).toBe(403);
  });

  it('asks the Agent with the viewer, and shows its failure as a message', async () => {
    const asked: string[] = [];
    const agent: Agent = { ...fixtureAgent(), ask: async (ctx, toilProject, prompt) => (asked.push(`${ctx.viewer.id} ${toilProject} ${prompt}`), fixtureAgent().ask(ctx, toilProject, prompt)) };
    const { origin } = await start({ agent });
    const { sid, session } = await signIn(origin);
    const starters = JSON.parse((await send(origin, '/api/agent/starters?toilProject=card-payments', { headers: { [SESSION_HEADER]: sid } })).body) as Array<{ id: string }>;
    expect(starters.map((s) => s.id)).toEqual(['risk', 'attention', 'deployed', 'people', 'review']);
    const answer = JSON.parse((await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'risk' }, { sid, csrf: session.csrf })).body);
    expect(answer.citations).toContain('corp-jira:PAY-101');
    expect(answer.proposals.map((p: { command: string }) => p.command)).toEqual(['jira issue update']);
    expect(asked).toEqual(['local card-payments risk']);

    const none = await start({ agent: noAgent() });
    const other = await signIn(none.origin);
    expect(JSON.parse((await send(none.origin, '/api/agent/starters?toilProject=card-payments', { headers: { [SESSION_HEADER]: other.sid } })).body)).toEqual([]);
    const failed = await post(none.origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'risk' }, { sid: other.sid, csrf: other.session.csrf });
    expect(failed.status).toBe(502);
    expect(JSON.parse(failed.body).error.message).toContain('No agent is set up');
    expect(JSON.parse(failed.body).error.fix).toContain('Settings, Agent');
  });

  it('streams an answer as NDJSON, each line the answer so far, ending done; a failure partway ends with the error', async () => {
    const versions = (n: number) => ({ prompt: 'q', parts: [{ text: 'x'.repeat(n) }], citations: [], by: 'stub', proposals: [] });
    const agent: Agent = {
      ...fixtureAgent(),
      async *stream(_ctx, toilProject) {
        yield versions(1);
        yield versions(2);
        if (toilProject === 'boom') throw new AgentError('The CLI stopped.', 'Run it once on its own.');
      },
    };
    const { origin } = await start({ agent });
    const { sid, session } = await signIn(origin);
    const res = await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'q', stream: true }, { sid, csrf: session.csrf });
    expect(res.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
    const lines = res.body.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([{ answer: versions(1) }, { answer: versions(2) }, { done: true }]);
    const boom = await post(origin, '/api/agent/ask', { toilProject: 'boom', prompt: 'q', stream: true }, { sid, csrf: session.csrf });
    expect(boom.body.trim().split('\n').map((l) => JSON.parse(l)).at(-1)).toEqual({ error: { message: 'The CLI stopped.', fix: 'Run it once on its own.' } });
    // Without stream: true, the same agent answers whole through ask().
    expect(JSON.parse((await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'risk' }, { sid, csrf: session.csrf })).body).by).toBe('scripted');
  });

  it('keeps a whole Analyze in the history, naming it on the last line, and nothing else (#395)', async () => {
    const kept: Array<{ toilProject: string; text: string }> = [];
    const analyses: AnalysisKeeper = {
      list: async (toilProject) => [{ id: `${toilProject}-1`, at: 'x' } as never],
      get: async (_toilProject, id) => (id === 'there' ? ({ record: { id } } as never) : null),
      record: async (toilProject, answer) => (kept.push({ toilProject, text: answer.parts[0]!.text }), `kept-${kept.length}`),
    };
    const whole = { prompt: 'Analyze', parts: [{ text: 'Recommendation: Go.' }], citations: [], by: 'stub', proposals: [] };
    const agent: Agent = {
      ...fixtureAgent(),
      async *stream(_ctx, toilProject, prompt) {
        yield { ...whole, activity: { phase: 'writing' as const } };
        if (toilProject === 'boom') throw new AgentError('The CLI stopped.', 'Run it once on its own.');
        yield { ...whole, prompt };
      },
    };
    const { origin } = await start({ agent, analyses });
    const { sid, session } = await signIn(origin);
    const auth = { sid, csrf: session.csrf };
    const lines = (await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'analyze', stream: true }, auth)).body.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.at(-2).answer.analysis).toBe('kept-1');
    expect(lines.at(-1)).toEqual({ done: true });
    expect(kept).toEqual([{ toilProject: 'card-payments', text: 'Recommendation: Go.' }]);
    // Another question, or an Analyze that failed partway, keeps nothing.
    await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'risk', stream: true }, auth);
    await post(origin, '/api/agent/ask', { toilProject: 'boom', prompt: 'analyze', stream: true }, auth);
    expect(kept).toHaveLength(1);
    // Without stream: true, the whole answer is kept and names it.
    expect(JSON.parse((await post(origin, '/api/agent/ask', { toilProject: 'settlement', prompt: 'analyze' }, auth)).body).analysis).toBe('kept-2');

    const read = (path: string) => send(origin, path, { headers: { [SESSION_HEADER]: sid } });
    expect(JSON.parse((await read('/api/analyses?toilProject=card-payments')).body)).toEqual([{ id: 'card-payments-1', at: 'x' }]);
    expect(JSON.parse((await read('/api/analyses/one?toilProject=card-payments&id=there')).body)).toEqual({ record: { id: 'there' } });
    const gone = await read('/api/analyses/one?toilProject=card-payments&id=gone');
    expect(gone.status).toBe(404);
    expect(JSON.parse(gone.body).error.message).toContain('no analysis by that id');
    expect((await read('/api/analyses')).status).toBe(400);
    // The history is read-only over the API: there is no route that writes one.
    expect((await post(origin, '/api/analyses', { toilProject: 'card-payments' }, auth)).status).toBe(404);
    // A server with no history says so, and Analyze still answers.
    const bare = await start({ agent });
    const b = await signIn(bare.origin);
    expect((await send(bare.origin, '/api/analyses?toilProject=card-payments', { headers: { [SESSION_HEADER]: b.sid } })).status).toBe(404);
    expect((await post(bare.origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'analyze', stream: true }, { sid: b.sid, csrf: b.session.csrf })).status).toBe(200);
  });

  it('records a failed history write on the answer, never failing it (#395)', async () => {
    const analyses: AnalysisKeeper = { list: async () => [], get: async () => null, record: async () => Promise.reject(new Error('disk full')) };
    const { origin } = await start({ analyses });
    const { sid, session } = await signIn(origin);
    const answer = JSON.parse((await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'analyze' }, { sid, csrf: session.csrf })).body);
    expect(answer.analysis).toBeUndefined();
    expect(answer.warnings.at(-1)).toContain("couldn't keep this analysis in its history: disk full");
  });

  it("serves the agent's settings only where there is a choice, and refuses a key", async () => {
    const sample = await start();
    const s = await signIn(sample.origin);
    expect(s.session.agentSettings).toBe(false);
    expect((await send(sample.origin, '/api/agent/settings', { headers: { [SESSION_HEADER]: s.sid } })).status).toBe(404);

    let saved: unknown = null;
    const status = { settings: { adapter: 'none', model: null, cliPath: null, endpoint: null, instructions: null, voice: null, models: {}, cliPaths: {} }, problem: null, adapters: [], kind: 'none' } as const;
    const { origin } = await start({
      agentControl: {
        status: () => ({ ...status, adapters: [] }),
        save: (input) => {
          if (typeof input === 'object' && input && 'apiKey' in input) throw new AgentError('Toil UI\'s agent settings have no "apiKey".', 'Keys never go here.');
          saved = input;
          return { ...status, adapters: [] };
        },
        systemPrompt: (toilProject, style) => `prompt for ${toilProject} in ${style?.theme ?? 'none'} with the voice ${style?.voice ? 'on' : 'off'}`,
        installPlan: () => {
          throw new Error('not here');
        },
        install: async () => {
          throw new Error('not here');
        },
      },
    });
    const { sid, session } = await signIn(origin);
    expect(session.agentSettings).toBe(true);
    expect(JSON.parse((await send(origin, '/api/agent/settings', { headers: { [SESSION_HEADER]: sid } })).body).kind).toBe('none');
    expect((await post(origin, '/api/agent/settings', { adapter: 'claude' }, { sid, csrf: session.csrf })).status).toBe(200);
    expect(saved).toEqual({ adapter: 'claude' });
    const key = await post(origin, '/api/agent/settings', { adapter: 'claude', apiKey: 'x' }, { sid, csrf: session.csrf });
    expect(key.status).toBe(400);
    expect(JSON.parse(key.body).error).toEqual({ message: 'Toil UI\'s agent settings have no "apiKey".', fix: 'Keys never go here.' });
    // A POST without the CSRF token is refused, as every POST is.
    expect((await post(origin, '/api/agent/settings', { adapter: 'claude' }, { sid, csrf: 'wrong' })).status).toBe(403);
    // The full prompt (#283): read-only, with the session, in a built-in theme only.
    const prompt = (query: string, headers: Record<string, string> = { [SESSION_HEADER]: sid }) => send(origin, `/api/agent/prompt?${query}`, { headers });
    expect(JSON.parse((await prompt('toilProject=card-payments&theme=crate&voice=on')).body)).toEqual({ toilProject: 'card-payments', prompt: 'prompt for card-payments in crate with the voice on' });
    expect(JSON.parse((await prompt('theme=plain&voice=off')).body).toilProject).toBe('<Toil project>');
    expect((await prompt('theme=my-theme&voice=on')).status).toBe(400);
    expect((await prompt('theme=crate')).status).toBe(400);
    expect((await prompt('theme=crate&voice=on', {})).status).toBe(401);
    expect((await send(sample.origin, '/api/agent/prompt?theme=crate&voice=on', { headers: { [SESSION_HEADER]: s.sid } })).status).toBe(404);
  });

  it("passes the page's theme and voice switch to the agent, and refuses a theme that isn't built in (#283)", async () => {
    const seen: unknown[] = [];
    const agent = { kind: 'scripted', starters: async () => [], ask: async (_ctx: unknown, _d: string, _p: string, style: unknown) => (seen.push(style), { prompt: 'p', parts: [], citations: [], by: 'scripted', proposals: [] }) };
    const { origin } = await start({ agent });
    const { sid, session } = await signIn(origin);
    const auth = { sid, csrf: session.csrf };
    expect((await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'risk', theme: 'harvest', voice: true }, auth)).status).toBe(200);
    expect((await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'risk' }, auth)).status).toBe(200);
    expect(seen).toEqual([{ theme: 'harvest', voice: true }, null]);
    const bad = await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'risk', theme: 'my-theme', voice: true }, auth);
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error.message).toBe('There is no built-in theme "my-theme".');
    expect((await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'risk', theme: 'crate', voice: 'loud' }, auth)).status).toBe(400);
    expect(seen).toHaveLength(2);
  });

  it("passes the chat's adapter and its history to the agent, and refuses an adapter or history it can't use (#344)", async () => {
    const seen: unknown[] = [];
    const agent = {
      kind: 'scripted',
      starters: async () => [],
      ask: async (_ctx: unknown, _d: string, _p: string, _s: unknown, _c: unknown, extra: unknown) => (seen.push(extra), { prompt: 'p', parts: [], citations: [], by: 'scripted', proposals: [] }),
      adapterOptions: () => ({ chosen: 'claude', options: [{ name: 'claude', label: 'Claude', model: 'haiku', ready: true, problem: null, fix: null, action: null }] }),
    };
    const { origin } = await start({ agent });
    const { sid, session } = await signIn(origin);
    const auth = { sid, csrf: session.csrf };
    const history = [{ prompt: 'Why?', answer: 'Because [[corp-jira:PAY-101]].', by: 'Claude (haiku)' }];
    expect((await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'And then?', adapter: 'codex', history }, auth)).status).toBe(200);
    expect((await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'q' }, auth)).status).toBe(200);
    expect(seen).toEqual([{ adapter: 'codex', history }, {}]);
    expect((await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'q', adapter: 'gemini' }, auth)).status).toBe(400);
    expect((await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'q', history: [{ prompt: 1 }] }, auth)).status).toBe(400);
    expect((await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'q', history: Array.from({ length: 21 }, () => ({ prompt: 'a', answer: 'b' })) }, auth)).status).toBe(400);
    expect((await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'q', history: [{ prompt: 'a', answer: 'b'.repeat(20_001) }] }, auth)).status).toBe(413);
    expect(seen).toHaveLength(2);
    expect(JSON.parse((await send(origin, '/api/agent/adapters', { headers: { [SESSION_HEADER]: sid } })).body).chosen).toBe('claude');
  });

  it('shows the install command, runs only that one, streaming npm, and refuses a package name (#344)', async () => {
    const plan: InstallPlan = { adapter: 'codex', kind: 'global', folder: '/opt/npm', command: 'npm install --global --prefix /opt/npm @openai/codex-sdk@0.160.0', argv: ['node', 'npm-cli.js'], problem: null, fix: null };
    const runs: string[] = [];
    const { origin } = await start({
      agentControl: {
        status: () => ({ settings: { adapter: 'none', model: null, cliPath: null, endpoint: null, instructions: null, voice: null, models: {}, cliPaths: {} }, problem: null, adapters: [], kind: 'none' }),
        save: () => {
          throw new Error('no');
        },
        systemPrompt: () => '',
        installPlan: (adapter) => ({ ...plan, adapter }),
        install: async (adapter, command, onLine) => {
          if (command !== plan.command) throw new AgentError("The install command has changed since it was shown, so it didn't run.", 'Read the new command.');
          runs.push(adapter);
          onLine('added 2 packages');
          return { run: { code: 0, output: ['added 2 packages'] }, status: { name: adapter, installed: true } as never };
        },
      },
    });
    const { sid, session } = await signIn(origin);
    const auth = { sid, csrf: session.csrf };
    expect(JSON.parse((await send(origin, '/api/agent/install?adapter=codex', { headers: { [SESSION_HEADER]: sid } })).body).command).toBe(plan.command);
    expect((await send(origin, '/api/agent/install?adapter=lodash', { headers: { [SESSION_HEADER]: sid } })).status).toBe(400);
    const ok = await post(origin, '/api/agent/install', { adapter: 'codex', command: plan.command }, auth);
    expect(ok.body.trim().split('\n').map((l) => JSON.parse(l))).toEqual([{ line: 'added 2 packages' }, { done: true, status: { name: 'codex', installed: true } }]);
    const changed = await post(origin, '/api/agent/install', { adapter: 'codex', command: `${plan.command} lodash` }, auth);
    expect(JSON.parse(changed.body.trim()).error.message).toMatch(/has changed since it was shown/);
    expect((await post(origin, '/api/agent/install', { adapter: '@evil/pkg', command: plan.command }, auth)).status).toBe(400);
    expect((await post(origin, '/api/agent/install', { adapter: 'codex' }, auth)).status).toBe(400);
    expect((await post(origin, '/api/agent/install', { adapter: 'codex', command: plan.command }, { sid, csrf: 'wrong' })).status).toBe(403);
    expect(runs).toEqual(['codex']);
  });

  it("answers the MCP endpoint only with a running question's token, and never from a page", async () => {
    const { ui, origin } = await start();
    const served = ui.serveTools([{ name: 'owi_get', description: 'd', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, run: async () => ({ ok: 1 }) }]);
    expect(served.url).toBe(`${origin}/api/agent/mcp`);
    const mcp = (headers: Record<string, string>, body: unknown = { jsonrpc: '2.0', id: 1, method: 'tools/list' }) => send(origin, '/api/agent/mcp', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
    const listed = await mcp({ authorization: `Bearer ${served.token}` });
    expect(listed.status).toBe(200);
    expect(JSON.parse(listed.body).result.tools.map((t: { name: string }) => t.name)).toEqual(['owi_get']);
    expect((await mcp({ authorization: `Bearer ${served.token}` }, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    expect((await mcp({ authorization: 'Bearer not-it' })).status).toBe(401);
    expect((await mcp({})).status).toBe(401);
    expect((await mcp({ authorization: `Bearer ${served.token}`, origin })).status).toBe(403);
    expect(noCors(listed)).toEqual([]);
    served.close();
    expect((await mcp({ authorization: `Bearer ${served.token}` })).status).toBe(401);
  });

  it('says once, plainly, that a themes folder from an earlier alpha is no longer read (#283)', () => {
    expect(themesNotice('/home/you/.toil-ui', () => false, posix)).toBeNull();
    const note = themesNotice('/home/you/.toil-ui', (p) => p === '/home/you/.toil-ui/themes', posix)!;
    expect(note).toBe('Note: Toil UI no longer reads themes from /home/you/.toil-ui/themes; only its built-in themes are offered. The folder is left as it is, and you can delete it. To ask for a new theme, send a feature request from the Feedback button or with toil feedback feature.');
  });

  it('answers an unknown route with where the API is', async () => {
    const { origin } = await start();
    const { sid } = await signIn(origin);
    const res = await send(origin, '/api/nothing', { headers: { [SESSION_HEADER]: sid } });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error.fix).toContain('session, execute, config');
  });
});

describe('the sync API', () => {
  async function withSync(gate: Promise<void> = Promise.resolve()) {
    const dataDir = mkdtempSync(join(tmpdir(), 'toil-ui-sync-api-'));
    const cache = await Cache.open(dataDir, { retentionDays: 30 });
    const toil = stubToil();
    // The gate holds every call to toil, so a test can see a sync while it runs.
    const sync = new SyncService({ cache, execute: async (...args) => (await gate, toil.execute(...args)), mapOwi });
    running.push(async () => {
      cache.close();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
    });
    const server = await start({ store: sqliteStore(() => cache, toil.execute as unknown as Execute, { version: '0.1.0-alpha.2', contractVersion: 1 }), sync, settings: settings({ sample: false }) });
    const auth = await signIn(server.origin);
    const get = (path: string) => send(server.origin, path, { headers: { [SESSION_HEADER]: auth.sid } });
    return { ...server, auth: { sid: auth.sid, csrf: auth.session.csrf }, session: auth.session, get, sync, cache };
  }

  it('is not there with sample data', async () => {
    const { origin } = await start();
    const { sid, session } = await signIn(origin);
    expect((await send(origin, '/api/sync', { headers: { [SESSION_HEADER]: sid } })).status).toBe(404);
    expect((await post(origin, '/api/sync', {}, { sid, csrf: session.csrf })).status).toBe(404);
    expect((await post(origin, '/api/cache/wipe', { confirm: 'wipe' }, { sid, csrf: session.csrf })).status).toBe(404);
  });

  it('needs a session, and a POST needs the CSRF token', async () => {
    const { origin, auth } = await withSync();
    expect((await send(origin, '/api/sync')).status).toBe(401);
    expect((await post(origin, '/api/sync', {}, { sid: auth.sid, csrf: 'wrong' })).status).toBe(403);
    expect((await post(origin, '/api/cache/wipe', { confirm: 'wipe' }, { sid: auth.sid, csrf: 'wrong' })).status).toBe(403);
  });

  it('starts a sync, reports its progress, refuses a second, and the views then read the cache', async () => {
    let release!: () => void;
    const { origin, auth, session, get } = await withSync(new Promise((r) => (release = r)));
    expect(session).toMatchObject({ store: 'sqlite', sync: true, sample: false });
    const before = JSON.parse((await post(origin, '/api/execute', { command: 'jira issue search', input: { toilProject: 'card-payments', jql: JQL('PAY'), changelog: true } }, auth)).body) as Envelope;
    expect(before.ok).toBe(false);

    const started = await post(origin, '/api/sync', {}, auth);
    expect(started.status).toBe(202);
    expect(JSON.parse(started.body).job.running).toBe(true);
    expect((await post(origin, '/api/sync', {}, auth)).status).toBe(409);
    expect((await post(origin, '/api/cache/wipe', { confirm: 'wipe' }, auth)).status).toBe(409);
    release();

    let status = JSON.parse((await get('/api/sync')).body);
    for (let i = 0; status.job.running && i < 200; i++) {
      await new Promise((r) => setTimeout(r, 10));
      status = JSON.parse((await get('/api/sync')).body);
    }
    expect(status.job).toMatchObject({ running: false, error: null, toilProjectsDone: 3, by: 'local' });
    expect(status.retentionDays).toBe(30);
    expect(status.toilProjects.map((d: { name: string; status: string }) => `${d.name}:${d.status}`)).toEqual(['card-payments:ok', 'checkout-web:ok', 'settlement:ok']);

    const after = JSON.parse((await post(origin, '/api/execute', { command: 'jira issue search', input: { toilProject: 'card-payments', jql: JQL('PAY'), changelog: true } }, auth)).body) as Envelope;
    expect(after.ok).toBe(true);
    const one = await post(origin, '/api/sync', { toilProject: 7 }, auth);
    expect(one.status).toBe(400);
  });

  it('wipes only when the page confirms', async () => {
    const { origin, auth, sync, cache } = await withSync();
    await sync.run({ viewer: { id: 'local', name: 'you', via: 'launch-token' }, signal: new AbortController().signal });
    expect((await post(origin, '/api/cache/wipe', {}, auth)).status).toBe(400);
    expect(cache.counts().responses).toBeGreaterThan(0);
    const wiped = await post(origin, '/api/cache/wipe', { confirm: 'wipe' }, auth);
    expect(wiped.status).toBe(200);
    expect(JSON.parse(wiped.body).toilProjects).toEqual([]);
    expect(cache.counts().responses).toBe(0);
  });
});

describe('toil-ui wipe and a running server', () => {
  const ctx: RequestContext = { viewer: { id: 'local', name: 'you', via: 'launch-token' }, signal: new AbortController().signal };

  async function serving(dataDir: string) {
    const cache = await Cache.open(dataDir, { retentionDays: 30 });
    const toil = stubToil();
    const sync = new SyncService({ cache, execute: toil.execute, mapOwi });
    const server = await start({ store: sqliteStore(() => cache, toil.execute as unknown as Execute, { version: '0.1.0-alpha.2', contractVersion: 1 }), sync, settings: settings({ sample: false, dataDir }) });
    const auth = await signIn(server.origin);
    return { ...server, cache, sync, auth: { sid: auth.sid, csrf: auth.session.csrf } };
  }

  it('is refused with the same message on every OS while the server runs, and allowed once it stops', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'toil-ui-lock-'));
    try {
      const { ui, cache, sync } = await serving(dataDir);
      await sync.run(ctx);
      expect(() => wipeCacheFiles(dataDir)).toThrow(RUNNING_MESSAGE);
      // Nothing was unlinked under the server: it still reads its rows.
      expect(existsSync(cachePaths(dataDir).db)).toBe(true);
      expect(cache.counts().responses).toBeGreaterThan(0);

      await ui.close();
      cache.close();
      expect(() => wipeCacheFiles(dataDir)).not.toThrow();
      expect(existsSync(cachePaths(dataDir).dir)).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('takes over a stale lock left by a process that has gone', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'toil-ui-lock-'));
    try {
      const gone = spawnSync(process.execPath, ['-e', '']).pid!;
      expect(pidAlive(gone)).toBe(false);
      writeFileSync(join(dataDir, 'toil-ui.lock'), JSON.stringify({ pid: gone, token: 'stale', startedAt: '2026-10-01T00:00:00.000Z' }));
      mkdirSync(cachePaths(dataDir).dir, { recursive: true });
      expect(() => wipeCacheFiles(dataDir)).not.toThrow();
      const cache = await Cache.open(dataDir, { retentionDays: 30 });
      expect(liveLock(dataDir)?.pid).toBe(process.pid);
      cache.close();
      expect(liveLock(dataDir)).toBeNull();
    } finally {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('takes over a lock naming its own pid, left by a crash whose pid was reused', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'toil-ui-lock-'));
    try {
      writeFileSync(join(dataDir, 'toil-ui.lock'), JSON.stringify({ pid: process.pid, token: 'crashed', startedAt: '2026-10-01T00:00:00.000Z' }));
      const cache = await Cache.open(dataDir, { retentionDays: 30 });
      expect(liveLock(dataDir)).toMatchObject({ pid: process.pid });
      expect(liveLock(dataDir)?.token).not.toBe('crashed');
      cache.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("refuses to start beside a live lock, naming the lock file to delete if nothing's running", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'toil-ui-lock-'));
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    try {
      writeFileSync(join(dataDir, 'toil-ui.lock'), JSON.stringify({ pid: other.pid, token: 'other', startedAt: '2026-10-01T00:00:00.000Z' }));
      const refused = await Cache.open(dataDir, { retentionDays: 30 }).then(() => null, (e: unknown) => e as CacheError);
      expect(refused?.message).toContain(`Another Toil UI (process ${other.pid})`);
      expect(refused?.fix).toContain(`delete ${join(dataDir, 'toil-ui.lock')}`);
    } finally {
      other.kill();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("the page's wipe empties the open cache in the server, and the next sync works", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'toil-ui-lock-'));
    try {
      const { origin, auth, cache, sync } = await serving(dataDir);
      await sync.run(ctx);
      const wiped = await post(origin, '/api/cache/wipe', { confirm: 'wipe' }, auth);
      expect(wiped.status).toBe(200);
      expect(Object.values(cache.counts()).every((n) => n === 0)).toBe(true);
      expect(liveLock(dataDir)?.pid).toBe(process.pid);
      const job = await sync.run(ctx);
      expect(job.error).toBeNull();
      expect(cache.states().map((d) => d.status)).toEqual(['ok', 'ok', 'ok']);
      const search = JSON.parse((await post(origin, '/api/execute', { command: 'jira issue search', input: { toilProject: 'card-payments', jql: JQL('PAY'), changelog: true } }, auth)).body) as Envelope;
      expect(search.ok).toBe(true);
      cache.close();
    } finally {
      while (running.length) await running.pop()!();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

describe('the static files', () => {
  it('serves the app and nothing outside its folder', async () => {
    const { origin } = await start();
    const { sid } = await signIn(origin);
    const js = await send(origin, '/assets/app.js', { headers: { [SESSION_HEADER]: sid } });
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toContain('text/javascript');
    const dotted = await send(origin, '/assets/..app.js', { headers: { [SESSION_HEADER]: sid } });
    expect(dotted.status, 'a name that merely starts with two dots').toBe(200);
    const paths = ['/../toil-ui-secret.txt', '/%2e%2e/toil-ui-secret.txt', '/assets/..%2f..%2ftoil-ui-secret.txt', '/..%5ctoil-ui-secret.txt', '/%2e%2e%5ctoil-ui-secret.txt', '/index.html::$DATA', '/assets', '/missing.js'];
    for (const path of paths) {
      const res = await send(origin, path, { headers: { [SESSION_HEADER]: sid } });
      expect(res.status, path).toBe(404);
      expect(res.body).not.toContain('outside the app folder');
      expect(res.body).not.toContain('<div id="root">');
    }
  });

  it('serves under its base path only', async () => {
    const { origin, launchUrl } = await start({ settings: settings({ basePath: '/toil/' }) });
    expect(launchUrl).toBe(`${origin}/toil/?token=${TOKEN}`);
    const { sid, res } = await signIn(origin, '/toil/');
    expect(res.status).toBe(200);
    expect((await send(origin, '/toil')).status).toBe(308);
    expect((await send(origin, '/index.html')).status).toBe(404);
    expect((await send(origin, '/api/session', { headers: { [SESSION_HEADER]: sid } })).status).toBe(404);
    expect((await send(origin, '/toil/')).status).toBe(200);
    expect((await send(origin, '/toil/api/session', { headers: { [SESSION_HEADER]: sid } })).status).toBe(200);
  });
});

describe('the Stores', () => {
  it('lets the views read exactly the commands the fixture answers, plus the ones the sample has no Toil project for', () => {
    // A GitHub toil project with no board reads the repository's issues; the sample's GitHub toil project has a board.
    // test/github-repo.test.ts proves that path with its own stub.
    // The sample has no Azure DevOps Services toil project; test/ado-seed.test.ts reads one through toil, its work items and its board, with the same ado commands.
    const noSampleToilProject = ['github issue list'];
    expect([...READ_COMMANDS].sort()).toEqual([...new Set([...CANNED.map((c) => c.command), ...noSampleToilProject])].sort());
  });

  it("toil's own execute() gets every read read-only, and every call named toil-ui", async () => {
    const calls: unknown[] = [];
    const execute: Execute = async (command, input, options) => (calls.push([command, input, options]), { ok: true, data: null, error: null, meta: { command, durationMs: 0, version: 'x', contractVersion: 1 } } as Envelope);
    const store = toilStore(execute);
    const ctx: RequestContext = { viewer: { id: 'local', name: 'you', via: 'launch-token' }, signal: new AbortController().signal };
    await store.execute(ctx, 'projects list', {}, 'read');
    await store.execute(ctx, 'projects field', { toilProject: 'd' }, 'config');
    const person = { ask: () => undefined };
    await store.execute(ctx, 'connections add', { name: 'x' }, 'config', { readOnly: false, person });
    await store.execute(ctx, 'connections list', {}, 'config', { readOnly: true });
    await store.execute(ctx, 'projects show', {}, 'read', { readOnly: false, person });
    expect(calls).toEqual([
      ['projects list', {}, { readOnly: true, caller: CALLER, signal: ctx.signal }],
      // A config call the server didn't mark as a change stays read-only.
      ['projects field', { toilProject: 'd' }, { readOnly: true, caller: CALLER, signal: ctx.signal }],
      ['connections add', { name: 'x' }, { readOnly: false, caller: CALLER, signal: ctx.signal, person }],
      ['connections list', {}, { readOnly: true, caller: CALLER, signal: ctx.signal }],
      // A read never runs with writes or a person, whatever it's handed.
      ['projects show', {}, { readOnly: true, caller: CALLER, signal: ctx.signal }],
    ]);
    expect(store.sample).toBe(false);
  });

  it('the fixture Store reads the sample config and refuses every change', async () => {
    const ctx: RequestContext = { viewer: { id: 'local', name: 'you', via: 'launch-token' }, signal: new AbortController().signal };
    expect(await fixtureStore().execute(ctx, 'connections list', {}, 'config', { readOnly: true })).toMatchObject({ ok: true });
    const env = await fixtureStore().execute(ctx, 'projects init', { name: 'x' }, 'config', { readOnly: false, person: { ask: () => undefined } });
    expect(env).toMatchObject({ ok: false, error: { code: 'WRITE_DISABLED' } });
  });
});

describe('the settings', () => {
  const home = join(app, 'home');

  it('defaults to loopback, a free port, the root path and ~/.toil-ui', () => {
    expect(parseSettings([], {}, home)).toEqual({ command: 'serve', settings: { host: '127.0.0.1', port: 0, basePath: '/', dataDir: join(home, '.toil-ui'), retentionDays: 30, sample: false }, help: false, version: false });
  });

  it('takes a flag over its env var, and the env var over the default', () => {
    const env = { TOIL_UI_PORT: '4400', TOIL_UI_BASE_PATH: 'toil', TOIL_UI_HOST: '::1' };
    expect(parseSettings([], env, home).settings).toMatchObject({ host: '::1', port: 4400, basePath: '/toil/' });
    expect(parseSettings(['--port', '4500', '--base-path=/a/b/', '--sample'], env, home).settings).toMatchObject({ port: 4500, basePath: '/a/b/', sample: true });
  });

  it.each(['0.0.0.0', '192.168.0.10', 'localhost', '::'])('refuses to bind %s, with a fix', (host) => {
    expect(() => parseSettings(['--host', host], {}, home)).toThrow(SettingsError);
    try {
      parseSettings([], { TOIL_UI_HOST: host }, home);
    } catch (e) {
      expect((e as SettingsError).fix).toContain('127.0.0.1');
    }
  });

  it.each([['--port', '70000'], ['--port', 'eighty'], ['--base-path', '/a/../b'], ['--base-path', '/a b'], ['--nope'], ['--port']])('refuses %s %s', (...argv) => {
    expect(() => parseSettings(argv, {}, home)).toThrow(SettingsError);
  });
});

afterAll(() => {
  rmSync(app, { recursive: true, force: true });
  rmSync(join(tmpdir(), 'toil-ui-secret.txt'), { force: true });
});

describe('feedback (#265)', () => {
  const fields = { kind: 'bug', title: 'jira issue search ignores --max-results', body: 'It returns 50.', email: 'you@example.com' };

  /** A Store that records each feedback call, with how it was to run and how its person answers the consent question. */
  function feedbackStore() {
    const calls: Array<{ command: string; input: Record<string, unknown>; access: Access; readOnly: boolean | undefined; consent: unknown; other: unknown }> = [];
    const inner = fixtureStore();
    const store: Store = {
      ...inner,
      execute: async (ctx, command, input, access, how) => {
        const question = (id: string) => ({ id, text: 'q', secret: false, fallback: null });
        calls.push({ command, input, access, readOnly: how?.readOnly, consent: await how?.person?.ask(question('consent')), other: await how?.person?.ask(question('confirm')) });
        return inner.execute(ctx, command, input, access, how);
      },
    };
    return { store, calls };
  }

  it('previews read-only, and sends only with consent, answering yes to the consent question and nothing else', async () => {
    const { store, calls } = feedbackStore();
    const { origin } = await start({ store });
    const { sid, session } = await signIn(origin);
    const preview = await post(origin, '/api/feedback', { fields }, { sid, csrf: session.csrf });
    expect(preview.status).toBe(200);
    expect(JSON.parse(preview.body).data).toMatchObject({ sent: false, report: { ...fields, consent: 1 } });
    await post(origin, '/api/feedback', { fields, consent: true }, { sid, csrf: session.csrf });
    expect(calls).toEqual([
      { command: 'feedback', input: fields, access: 'feedback', readOnly: true, consent: 'no', other: undefined },
      { command: 'feedback', input: fields, access: 'feedback', readOnly: false, consent: 'yes', other: undefined },
    ]);
  });

  it('refuses anything but the four fields as text and consent: true, before a Store sees it', async () => {
    const { store, calls } = feedbackStore();
    const { origin } = await start({ store });
    const { sid, session } = await signIn(origin);
    for (const body of [{ command: 'jira issue create', fields }, { fields: { ...fields, connection: 'corp-jira' } }, { fields: { ...fields, title: 5 } }, { fields, consent: 'yes' }, { fields, consent: false }, { fields: [fields] }, {}]) {
      const res = await post(origin, '/api/feedback', body, { sid, csrf: session.csrf });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(JSON.parse(res.body).error.fix).toContain('"consent": true');
    }
    expect(calls).toEqual([]);
  });

  it('keeps the lock on the door: a session, the page\'s Origin and the CSRF token', async () => {
    const { store, calls } = feedbackStore();
    const { origin } = await start({ store });
    const { sid, session } = await signIn(origin);
    const body = JSON.stringify({ fields, consent: true });
    const json = { 'content-type': 'application/json' };
    expect((await send(origin, '/api/feedback', { method: 'POST', body, headers: { origin, ...json, [CSRF_HEADER]: session.csrf } })).status).toBe(401);
    expect((await send(origin, '/api/feedback', { method: 'POST', body, headers: { origin, ...json, [SESSION_HEADER]: sid } })).status).toBe(403);
    expect((await post(origin, '/api/feedback', { fields, consent: true }, { sid, csrf: session.csrf }, { origin: 'https://rebind.imagile.dev' })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('sends nothing with sample data, saying why', async () => {
    const { origin } = await start();
    const { sid, session } = await signIn(origin);
    const res = JSON.parse((await post(origin, '/api/feedback', { fields, consent: true }, { sid, csrf: session.csrf })).body) as Envelope;
    expect(res.ok).toBe(false);
    expect(res.error?.message).toBe('Nothing was sent: this is sample data.');
  });

  it('hands toil the person only off the read path: toilStore runs feedback with readOnly as the server decided', async () => {
    const seen: unknown[] = [];
    const execute: Execute = async (command, input, options) => (seen.push([command, input, options]), { ok: true, data: null, error: null, meta: { command, durationMs: 0, version: 'x', contractVersion: 1 } } as Envelope);
    const ctx: RequestContext = { viewer: { id: 'local', name: 'you', via: 'launch-token' }, signal: new AbortController().signal };
    const person = { ask: () => 'yes' };
    await toilStore(execute).execute(ctx, 'feedback', fields, 'feedback', { readOnly: false, person });
    await toilStore(execute).execute(ctx, 'feedback', fields, 'feedback', { readOnly: true, person });
    expect(seen).toEqual([
      ['feedback', fields, { readOnly: false, caller: CALLER, signal: ctx.signal, person }],
      ['feedback', fields, { readOnly: true, caller: CALLER, signal: ctx.signal, person }],
    ]);
  });
});

describe('the worklog (#308)', () => {
  const get = (origin: string, path: string, sid: string) => send(origin, path, { headers: { [SESSION_HEADER]: sid } });

  it("serves the sample's calendar and pages with a session, and nothing without one", async () => {
    const { fixtureWorklog } = await import('../src/fixtures/worklog.ts');
    const { origin } = await start({ worklog: fixtureWorklog() });
    expect((await send(origin, '/api/worklog/month?toilProject=card-payments')).status).toBe(401);
    const { sid } = await signIn(origin);
    const month = await get(origin, '/api/worklog/month?toilProject=card-payments', sid);
    expect(month.status).toBe(200);
    expect(JSON.parse(month.body)).toMatchObject({ toilProject: 'card-payments', month: '2026-10', today: '2026-10-13', timeZone: 'UTC' });
    const day = JSON.parse((await get(origin, '/api/worklog/day?toilProject=card-payments&day=2026-10-12', sid)).body) as { markdown: string; file: null };
    expect(day.markdown).toMatch(/^# Worklog: card-payments, Monday 12 October 2026/);
    expect(day.file).toBeNull();
  });

  it("answers a refusal with its own status, message and fix, and a missing field with how to send it", async () => {
    const { fixtureWorklog } = await import('../src/fixtures/worklog.ts');
    const { origin } = await start({ worklog: fixtureWorklog() });
    const auth = await signIn(origin);
    const future = await get(origin, '/api/worklog/day?toilProject=card-payments&day=2026-10-14', auth.sid);
    expect(future.status).toBe(400);
    expect(JSON.parse(future.body)).toEqual({ error: { message: "2026-10-14 hasn't happened yet, so it has no page.", fix: 'Pick today or an earlier day.' } });
    expect(JSON.parse((await get(origin, '/api/worklog/day?toilProject=card-payments', auth.sid)).body).error.message).toBe('Name the day.');
    const note = await post(origin, '/api/worklog/note', { toilProject: 'card-payments', text: 'hi' }, { sid: auth.sid, csrf: auth.session.csrf });
    expect(note.status).toBe(400);
    expect(JSON.parse(note.body).error.message).toMatch(/sample data/);
    const both = await post(origin, '/api/worklog/export', { toilProject: 'card-payments', day: '2026-10-12', month: '2026-10', folder: '/tmp' }, { sid: auth.sid, csrf: auth.session.csrf });
    expect(JSON.parse(both.body).error.message).toBe('Export a day, a month or a stand-up, one of the three.');
    const mixed = await post(origin, '/api/worklog/export', { toilProject: 'card-payments', day: '2026-10-12', from: '2026-10-12', to: '2026-10-13', folder: '/tmp' }, { sid: auth.sid, csrf: auth.session.csrf });
    expect(JSON.parse(mixed.body).error.message).toBe('Export a day, a month or a stand-up, one of the three.');
    const half = await post(origin, '/api/worklog/export', { toilProject: 'card-payments', from: '2026-10-12', folder: '/tmp' }, { sid: auth.sid, csrf: auth.session.csrf });
    expect(JSON.parse(half.body).error.message).toBe('Name the last day.');
    const extra = await post(origin, '/api/worklog/export', { toilProject: 'card-payments', day: '2026-10-12', folder: '/tmp', overwrite: true }, { sid: auth.sid, csrf: auth.session.csrf });
    expect(JSON.parse(extra.body).error.message).toBe("An export takes toilProject, a day, a month or a stand-up's from and to, and folder, not overwrite.");
    const misspelt = await post(origin, '/api/worklog/note', { toilProject: 'card-payments', txt: 'hi' }, { sid: auth.sid, csrf: auth.session.csrf });
    expect(JSON.parse(misspelt.body).error.message).toBe('A note takes toilProject and text, not txt.');
  });

  it('answers a stand-up (#345) for a range, and refuses a range it cannot cover', async () => {
    const { fixtureWorklog } = await import('../src/fixtures/worklog.ts');
    const { origin } = await start({ worklog: fixtureWorklog() });
    const auth = await signIn(origin);
    const ok = await get(origin, '/api/worklog/standup?toilProject=card-payments&from=2026-10-12&to=2026-10-13', auth.sid);
    expect(ok.status).toBe(200);
    const body = JSON.parse(ok.body) as { markdown: string; text: string; report: { from: string; to: string } };
    expect(body.markdown).toMatch(/^# Stand-up: card-payments, 12 Oct 2026 to 13 Oct 2026/);
    expect(body.text).toMatch(/^Stand-up: card-payments, 12 Oct 2026 to 13 Oct 2026/);
    expect(body.report).toMatchObject({ from: '2026-10-12', to: '2026-10-13' });
    const future = await get(origin, '/api/worklog/standup?toilProject=card-payments&from=2026-10-12&to=2026-10-14', auth.sid);
    expect(future.status).toBe(400);
    expect(JSON.parse(future.body).error.message).toBe("2026-10-14 hasn't happened yet: end the range today (2026-10-13) or earlier.");
    expect(JSON.parse((await get(origin, '/api/worklog/standup?toilProject=card-payments&from=2026-10-12', auth.sid)).body).error.message).toBe('Name the last day.');
  });

  it('needs the CSRF token on every change: a rebuild, a note, an export', async () => {
    const { fixtureWorklog } = await import('../src/fixtures/worklog.ts');
    const { origin } = await start({ worklog: fixtureWorklog() });
    const auth = await signIn(origin);
    for (const path of ['/api/worklog/rebuild', '/api/worklog/note', '/api/worklog/export']) {
      const res = await post(origin, path, { toilProject: 'card-payments', day: '2026-10-12' }, { sid: auth.sid, csrf: 'not-it' });
      expect(res.status, path).toBe(403);
    }
  });

  it('passes the viewer to a note as its author', async () => {
    const notes: Array<{ text: string; by?: string }> = [];
    const { fixtureWorklog } = await import('../src/fixtures/worklog.ts');
    const inner = fixtureWorklog();
    const { origin } = await start({ viewer: { id: 'local', name: 'Ada', via: 'launch-token' }, worklog: { ...inner, disabled: null, addNote: async (toilProject, text, by?: string) => (notes.push({ text, ...(by ? { by } : {}) }), inner.day(toilProject, '2026-10-13')) } });
    const auth = await signIn(origin);
    expect((await post(origin, '/api/worklog/note', { toilProject: 'card-payments', text: 'Paired on it' }, { sid: auth.sid, csrf: auth.session.csrf })).status).toBe(200);
    expect(notes).toEqual([{ text: 'Paired on it', by: 'Ada' }]);
  });

  it('says plainly when it keeps no worklog', async () => {
    const { origin } = await start();
    const { sid } = await signIn(origin);
    const res = await get(origin, '/api/worklog/month?toilProject=card-payments', sid);
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error.message).toBe('This Toil UI keeps no worklog.');
  });
});

describe('stale sessions (#305)', () => {
  const get = (origin: string, path: string, sid: string) => send(origin, path, { headers: { [SESSION_HEADER]: sid } });
  const session = { startedAt: '2026-10-13T08:00:00.000Z', stale: { reasons: ['Toil project changed'], text: 'Toil project changed since it started' }, renewals: 0 };
  const agent = () => ({
    ...fixtureAgent(),
    session: async (chat: string) => (chat === 'chat-0000-0001' ? session : null),
    renew: async (chat: string, toilProject: string) => {
      if (chat === 'chat-busy-0001') throw Object.assign(new AgentError('This chat is answering a question now, and a renew never interrupts one.', 'Wait for the answer.'), { status: 409 });
      return { startedAt: '2026-10-13T09:00:00.000Z', stale: null, renewals: toilProject === 'card-payments' ? 1 : 0 };
    },
  });

  it("says what a chat started on and whether it is stale, and null for a chat it hasn't seen", async () => {
    const { origin } = await start({ agent: agent() });
    const { sid } = await signIn(origin);
    expect(JSON.parse((await get(origin, '/api/agent/session?chat=chat-0000-0001', sid)).body)).toEqual(session);
    expect(JSON.parse((await get(origin, '/api/agent/session?chat=chat-0000-0009', sid)).body)).toBeNull();
    expect((await get(origin, '/api/agent/session?chat=not%20an%20id', sid)).status).toBe(400);
  });

  it('renews a chat behind the session and CSRF, and says why when it is answering', async () => {
    const { origin } = await start({ agent: agent() });
    const auth = await signIn(origin);
    const done = await post(origin, '/api/agent/renew', { chat: 'chat-0000-0001', toilProject: 'card-payments' }, { sid: auth.sid, csrf: auth.session.csrf });
    expect(JSON.parse(done.body)).toMatchObject({ renewals: 1, stale: null });
    expect((await post(origin, '/api/agent/renew', { chat: 'chat-0000-0001', toilProject: 'card-payments' }, { sid: auth.sid, csrf: 'not-it' })).status).toBe(403);
    const busy = await post(origin, '/api/agent/renew', { chat: 'chat-busy-0001', toilProject: 'card-payments' }, { sid: auth.sid, csrf: auth.session.csrf });
    expect(busy.status).toBe(409);
    expect(JSON.parse(busy.body).error.message).toContain('never interrupts');
    const plain = await start();
    const other = await signIn(plain.origin);
    expect((await post(plain.origin, '/api/agent/renew', { chat: 'chat-0000-0001', toilProject: 'card-payments' }, { sid: other.sid, csrf: other.session.csrf })).status).toBe(404);
  });

  it("answers the server's own staleness for the header, and null where it keeps none", async () => {
    const status = { running: { toil: { version: '0.1.0-alpha.3', commit: null }, toilUi: { version: '0.1.0-alpha.2', commit: null } }, disk: { toil: { version: '0.1.0-alpha.4', commit: null }, toilUi: { version: '0.1.0-alpha.2', commit: null } }, stale: 'toil 0.1.0-alpha.4 is installed, and this server runs 0.1.0-alpha.3.', restart: 'node toil-ui.js' };
    const { origin } = await start({ serverStatus: () => status });
    const { sid } = await signIn(origin);
    expect(JSON.parse((await get(origin, '/api/fingerprint', sid)).body)).toEqual(status);
    const plain = await start();
    expect(JSON.parse((await get(plain.origin, '/api/fingerprint', (await signIn(plain.origin)).sid)).body)).toBeNull();
    expect((await send(origin, '/api/fingerprint')).status).toBe(401);
  });
});
