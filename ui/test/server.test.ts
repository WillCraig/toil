// @vitest-environment node
import { createHash, randomBytes } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import type { InstallPlan } from '../server/agents/install.ts';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { letIn } from './let-in.ts';
import { COOKIE_MAX_AGE_SECONDS, issueCookie } from '../server/machine-secret.ts';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { fixtureAgent, noAgent, type Agent } from '../server/agent.ts';
import { AgentError } from '../server/agents/cli.ts';
import type { AnalysisKeeper } from '../server/analyses.ts';
import type { RequestContext } from '../server/context.ts';
import { PRESSABLE_STYLE_HASH } from '../server/csp.ts';
import { CSP, MAX_BODY, createUiServer, type UiServerOptions } from '../server/server.ts';
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
 * The local server, over real loopback sockets: the Host check, the Origin and
 * JSON checks on every API call (the whole defence of a server with no token,
 * #561), the absence of any cookie, header or CORS answer that would stand in
 * for one, the read allowlist and the config allowlist, the viewer on every
 * call, and the static files. node:http's own client sends whatever Host and
 * Origin a test names, which is how a rebinding page, a foreign origin and a
 * cross-site form are played.
 */

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

/** The cookie each server's browser was let in with, as a page's first navigation earns it. A test that wants none says `cookie: null`. */
const jar = new Map<string, string>();

/** `prime: false` leaves the browser out in the cold, for a test of the door itself. */
async function start(over: Partial<UiServerOptions> = {}, prime = true) {
  const machineSecret = over.machineSecret ?? randomBytes(32);
  const ui = createUiServer({ settings: settings(), store: fixtureStore(), agent: fixtureAgent(), appDir: app, version: '0.0.0-test', toil: { version: '0.1.0-alpha.2', contractVersion: 1 }, ...over, machineSecret });
  const address = await ui.listen();
  running.push(() => ui.close());
  const host = new URL(address.origin).host;
  if (prime) jar.set(address.origin, await letIn(address.origin, (over.settings ?? settings()).basePath));
  return { ui, ...address, host, machineSecret };
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(origin: string, path: string, options: { method?: string; headers?: Record<string, string>; body?: string; cookie?: string | null } = {}): Promise<Reply> {
  const url = new URL(path, origin);
  const cookie = options.cookie === undefined ? jar.get(url.origin) : (options.cookie ?? undefined);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port, path: `${url.pathname}${url.search}`, method: options.method ?? 'GET', headers: { host: url.host, ...(cookie ? { cookie } : {}), ...options.headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

/** What the server says about itself, as the page asks at load: no token, no header, nothing kept. */
async function info(origin: string, base = '/') {
  const res = await send(origin, `${base}api/info`);
  return { res, info: JSON.parse(res.body) as Record<string, unknown> };
}

/** A POST as the page makes it: its own Origin and a JSON body, and nothing else. */
async function post(origin: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return send(origin, path, { method: 'POST', body: JSON.stringify(body), headers: { origin, 'content-type': 'application/json', ...headers } });
}

const noCors = (r: Reply) => Object.keys(r.headers).filter((h) => h.startsWith('access-control-'));

describe('the checks on the door', () => {
  it('refuses any Host but loopback spelt three ways, for the page and the API, with the fix', async () => {
    const { origin, host } = await start();
    const port = new URL(origin).port;
    for (const other of ['rebind.imagile.dev', `rebind.imagile.dev:${port}`, '127.0.0.1:1', `127.0.0.1.rebind.imagile.dev:${port}`, `localhost.rebind.imagile.dev:${port}`, `0.0.0.0:${port}`, `[::2]:${port}`]) {
      for (const path of ['/', '/assets/app.js', '/api/info']) {
        const res = await send(origin, path, { headers: { host: other } });
        expect(res.status, `${path} as ${other}`).toBe(403);
        expect(res.headers['set-cookie']).toBeUndefined();
        const error = JSON.parse(res.body).error as { message: string; fix: string };
        expect(error.message).toContain(`127.0.0.1:${port}`);
        expect(error.fix).toContain(`http://${host}/`);
        expect(noCors(res)).toEqual([]);
      }
    }
  });

  it('answers each way a browser spells loopback, with the same-origin page for each', async () => {
    const { origin } = await start();
    const port = new URL(origin).port;
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
      expect((await send(origin, '/', { headers: { host } })).status, host).toBe(200);
      const own = `http://${host.toLowerCase()}`;
      expect((await send(origin, '/api/info', { headers: { host, origin: own } })).status, host).toBe(200);
      expect((await send(origin, '/api/execute', { method: 'POST', body: JSON.stringify({ command: 'projects list' }), headers: { host, origin: own, 'content-type': 'application/json' } })).status, host).toBe(200);
    }
    const v6 = await start({ settings: settings({ host: '::1' }) });
    const v6port = new URL(v6.origin).port;
    expect(v6.url).toBe(`http://[::1]:${v6port}/`);
    expect((await send(v6.origin, '/', { headers: { host: `[::1]:${v6port}` } })).status).toBe(200);
    expect((await send(v6.origin, '/api/info', { headers: { host: `localhost:${v6port}` } })).status).toBe(200);
  });

  it('prints a plain URL, and serves the app and the API with a cookie and nothing in the URL, a header or the page', async () => {
    const { origin, url, ...rest } = await start();
    expect(url).toBe(`${origin}/`);
    expect(Object.keys(rest)).not.toContain('launchUrl');
    for (const path of ['/', '/?token=anything', '/assets/app.js', '/api/info']) {
      const res = await send(origin, path);
      expect(res.status, path).toBe(200);
      // Only a browser's navigation to the page earns a cookie, never an asset or an API answer.
      expect(res.headers['set-cookie'], path).toBeUndefined();
    }
    const page = await send(origin, '/');
    expect(page.body).toContain('<div id="root">');
    expect(page.headers['content-security-policy']).toBe(CSP);
    expect(CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self' 'sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o='; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'none'; media-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    // Every response carries it, an unknown API route and a missing file included.
    for (const path of ['/api/info', '/api/nothing', '/no-such-file.css', '/assets/app.js']) expect((await send(origin, path)).headers['content-security-policy'], path).toBe(CSP);
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

  it('has no sign-in: the old session route is gone, and a session header or token in the URL opens nothing', async () => {
    const { origin } = await start();
    const signed = await send(origin, '/api/session', { method: 'POST', body: JSON.stringify({ token: 'x' }), headers: { origin, 'content-type': 'application/json' } });
    expect(signed.status).toBe(404);
    expect((await send(origin, '/api/info?token=x', { cookie: null, headers: { 'x-toil-ui-session': 'whatever' } })).status).toBe(401);
  });

  it("sets the cookie only on a browser's own navigation to the page: HttpOnly, SameSite=Strict, 30 days, no Secure, nothing in it but an id and a time", async () => {
    const { origin } = await start({}, false);
    const nav = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' };
    for (const site of ['none', 'same-origin']) {
      const res = await send(origin, '/', { cookie: null, headers: { ...nav, 'sec-fetch-site': site } });
      expect(res.status).toBe(200);
      const set = String(res.headers['set-cookie']);
      expect(set, site).toMatch(/^toil-ui=[A-Za-z0-9_-]{22}\.\d{10}\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Strict$/);
      expect(set).not.toMatch(/Secure/i);
      expect(COOKIE_MAX_AGE_SECONDS).toBe(2592000);
    }
    expect(String((await send(origin, '/index.html', { cookie: null, headers: { ...nav, 'sec-fetch-site': 'none' } })).headers['set-cookie'])).toContain('HttpOnly');
    // Refused issuance: the page still loads, with no cookie, for a cross-site or same-site navigation, a subresource, or no metadata at all.
    for (const headers of [{ ...nav, 'sec-fetch-site': 'cross-site' }, { ...nav, 'sec-fetch-site': 'same-site' }, { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'none' }, { 'sec-fetch-dest': 'script', 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-dest': 'document' }, { 'sec-fetch-site': 'none' }, {}] as Array<Record<string, string>>) {
      const res = await send(origin, '/', { cookie: null, headers });
      expect(res.status, JSON.stringify(headers)).toBe(200);
      expect(res.headers['set-cookie'], JSON.stringify(headers)).toBeUndefined();
    }
    // A POST, an asset and the API never issue one, whatever they say they are.
    const asset = await send(origin, '/assets/app.js', { cookie: null, headers: { ...nav, 'sec-fetch-site': 'none' } });
    expect(asset.headers['set-cookie']).toBeUndefined();
    const api = await send(origin, '/api/info', { cookie: null, headers: { ...nav, 'sec-fetch-site': 'same-origin' } });
    expect(api.headers['set-cookie']).toBeUndefined();
  });

  it('refuses an absent, forged, tampered, expired or foreign-signed cookie, and tells the browser how to be let in', async () => {
    const { origin, machineSecret } = await start();
    const good = jar.get(origin)!;
    expect((await send(origin, '/api/info')).status).toBe(200);
    const value = good.slice('toil-ui='.length);
    const [id, iat, mac] = value.split('.') as [string, string, string];
    const now = Date.now();
    const cookies: Array<[string, string | null]> = [
      ['no cookie', null],
      ['garbage', 'toil-ui=abc'],
      ['empty', 'toil-ui='],
      ['tampered time', `toil-ui=${id}.${Number(iat) + 1}.${mac}`],
      ['tampered id', `toil-ui=${'A'.repeat(22)}.${iat}.${mac}`],
      ['truncated mac', `toil-ui=${id}.${iat}.${mac.slice(0, 20)}`],
      ['extra part', `toil-ui=${value}.x`],
      ['signed by another secret', `toil-ui=${issueCookie(randomBytes(32))}`],
      ['expired', `toil-ui=${issueCookie(machineSecret, now - (COOKIE_MAX_AGE_SECONDS + 60) * 1000)}`],
      ['from the future', `toil-ui=${issueCookie(machineSecret, now + 3600 * 1000)}`],
      ['another name', good.replace('toil-ui=', 'toil-ui-other=')],
    ];
    for (const [what, cookie] of cookies) {
      for (const [path, method] of [['/api/info', 'GET'], ['/api/execute', 'POST']] as const) {
        const res = await send(origin, path, { method, cookie, body: method === 'POST' ? JSON.stringify({ command: 'projects list' }) : undefined, headers: { origin, 'content-type': 'application/json' } });
        expect(res.status, `${what} ${path}`).toBe(401);
        const error = JSON.parse(res.body).error as { message: string; fix: string };
        expect(error.message).toContain('no valid Toil UI cookie');
        expect(error.fix).toContain(`http://127.0.0.1:${new URL(origin).port}/`);
        expect(res.headers['set-cookie']).toBeUndefined();
      }
    }
    // And a good one among others is found.
    expect((await send(origin, '/api/info', { cookie: `a=b; ${good}; c=d` })).status).toBe(200);
  });

  it('keeps a cookie good across a restart, because the secret survives it, and not across a new secret', async () => {
    const machineSecret = randomBytes(32);
    const first = await start({ machineSecret });
    const cookie = jar.get(first.origin)!;
    await first.ui.close();
    const second = await start({ machineSecret });
    expect(second.origin).not.toBe(first.origin);
    expect((await send(second.origin, '/api/info', { cookie })).status).toBe(200);
    const third = await start({ machineSecret: randomBytes(32) });
    expect((await send(third.origin, '/api/info', { cookie })).status).toBe(401);
  });

  it('refuses a cross-site request even when it carries a valid cookie, and an API call that is not same-origin', async () => {
    const { store, seen } = watched();
    const { origin } = await start({ store });
    const body = JSON.stringify({ command: 'projects list', input: {} });
    for (const site of ['cross-site', 'same-site', 'none']) {
      for (const [path, method] of [['/api/info', 'GET'], ['/api/execute', 'POST']] as const) {
        const res = await send(origin, path, { method, body: method === 'POST' ? body : undefined, headers: { 'sec-fetch-site': site, origin, 'content-type': 'application/json' } });
        expect(res.status, `${method} ${path} ${site}`).toBe(403);
        expect(JSON.parse(res.body).error.message).toContain(site);
      }
    }
    expect(seen).toEqual([]);
    expect((await send(origin, '/api/info', { headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
  });

  it('refuses a peer that is not on loopback, whatever it sends, and answers the three spellings of loopback', async () => {
    const { ui, origin, machineSecret } = await start();
    const asPeer = (remoteAddress: string | undefined, path: string) =>
      new Promise<{ status: number; body: string }>((resolve) => {
        const socket = new Socket();
        Object.defineProperty(socket, 'remoteAddress', { value: remoteAddress });
        const req = new IncomingMessage(socket);
        req.method = 'GET';
        req.url = path;
        req.headers = { host: new URL(origin).host, cookie: `toil-ui=${issueCookie(machineSecret)}` };
        const res = new ServerResponse(req);
        let status = 0;
        res.writeHead = ((code: number) => ((status = code), res)) as never;
        res.end = ((chunk?: string | Buffer) => (resolve({ status, body: String(chunk ?? '') }), res)) as never;
        ui.server.emit('request', req, res);
        req.push(null);
      });
    for (const peer of ['10.0.0.7', '192.168.1.20', '::ffff:10.0.0.7', '2001:db8::1', undefined]) {
      for (const path of ['/', '/api/info']) {
        const res = await asPeer(peer, path);
        expect(res.status, `${peer} ${path}`).toBe(403);
        expect(JSON.parse(res.body).error.message).toContain('only to programs on this machine');
      }
    }
    for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect((await asPeer(peer, '/api/info')).status, peer).toBe(200);
  });

  it('never puts the machine secret in a response, a header or the cookie', async () => {
    const { origin, machineSecret } = await start();
    const needles = [machineSecret.toString('hex'), machineSecret.toString('base64'), machineSecret.toString('base64url'), machineSecret.toString('latin1')];
    const seen: string[] = [];
    for (const [path, extra] of [['/', { cookie: null as string | null, headers: { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' } }], ['/api/info', {}], ['/api/info', { cookie: null }], ['/api/nothing', {}], ['/assets/app.js', {}]] as const) {
      const res = await send(origin, path, extra as never);
      seen.push(res.body, JSON.stringify(res.headers));
    }
    seen.push(jar.get(origin)!);
    for (const needle of needles) for (const text of seen) expect(text.includes(needle)).toBe(false);
  });

  it('refuses a foreign Origin on every kind of API call, before anything reaches the Store', async () => {
    const { store, seen } = watched();
    const { origin } = await start({ store });
    const call = JSON.stringify({ command: 'projects list', input: {} });
    for (const foreign of ['https://rebind.imagile.dev', 'http://127.0.0.1:1', 'http://localhost:1', 'null', `${origin}.evil.test`, origin.replace('http:', 'https:')]) {
      for (const [path, method] of [['/api/info', 'GET'], ['/api/agent/starters?toilProject=card-payments', 'GET'], ['/api/assignments?toilProject=card-payments', 'GET'], ['/api/execute', 'POST'], ['/api/config', 'POST'], ['/api/agent/ask', 'POST'], ['/api/feedback', 'POST']] as const) {
        const res = await send(origin, path, { method, body: method === 'POST' ? call : undefined, headers: { origin: foreign, 'content-type': 'application/json' } });
        expect(res.status, `${method} ${path} from ${foreign}`).toBe(403);
        const error = JSON.parse(res.body).error as { message: string; fix: string };
        expect(error.message).toContain(origin);
        expect(error.fix).toContain('Use Toil UI in the browser tab');
        expect(noCors(res)).toEqual([]);
      }
    }
    expect(seen).toEqual([]);
  });

  it('refuses a POST that is not JSON, the kind a plain cross-site form sends, before anything reaches the Store', async () => {
    const { store, seen } = watched();
    const { origin } = await start({ store });
    const body = JSON.stringify({ command: 'projects list', input: {} });
    for (const type of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp', undefined]) {
      for (const sameOrigin of [true, false]) {
        const res = await send(origin, '/api/execute', { method: 'POST', body, headers: { ...(sameOrigin ? { origin } : { origin: 'https://rebind.imagile.dev' }), ...(type ? { 'content-type': type } : {}) } });
        expect(res.status, `${type} ${sameOrigin ? 'same' : 'foreign'} origin`).toBe(sameOrigin ? 415 : 403);
        const error = JSON.parse(res.body).error as { message: string; fix: string };
        expect(sameOrigin ? error.fix : error.message).toContain(sameOrigin ? 'Content-Type: application/json' : origin);
      }
    }
    expect(seen).toEqual([]);
    const ok = await send(origin, '/api/execute', { method: 'POST', body, headers: { origin, 'content-type': 'application/json; charset=utf-8' } });
    expect(ok.status).toBe(200);
  });

  it('answers a client that sends no Origin (curl, a script), which no browser page can be', async () => {
    const { origin } = await start();
    const res = await send(origin, '/api/execute', { method: 'POST', body: JSON.stringify({ command: 'projects list', input: {} }), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    expect((JSON.parse(res.body) as Envelope).ok).toBe(true);
  });

  it('never sends a CORS header, even when asked, and refuses the preflight', async () => {
    const { origin } = await start();
    const preflight = await send(origin, '/api/execute', { method: 'OPTIONS', headers: { origin: 'https://rebind.imagile.dev', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    expect(preflight.status).toBe(405);
    expect(noCors(preflight)).toEqual([]);
    const get = await send(origin, '/api/info', { headers: { origin: 'https://rebind.imagile.dev' } });
    expect(get.status).toBe(403);
    expect(noCors(get)).toEqual([]);
    expect(noCors(await send(origin, '/api/info'))).toEqual([]);
  });
});

describe('every POST', () => {
  it("takes a JSON body from the page's own Origin and runs it", async () => {
    const { origin } = await start();
    const call = { command: 'projects list', input: {} };
    const ok = await post(origin, '/api/execute', call);
    expect(ok.status).toBe(200);
    expect((JSON.parse(ok.body) as Envelope).ok).toBe(true);
    expect((await post(origin, '/api/execute', call, { origin: 'https://rebind.imagile.dev' })).status).toBe(403);
    expect((await post(origin, '/api/execute', call, { 'content-type': 'text/plain' })).status).toBe(415);
  });

  it('refuses a body over the limit, and one that is not an object', async () => {
    const { origin } = await start();
    const big = await post(origin, '/api/execute', { command: 'projects list', input: { pad: 'x'.repeat(MAX_BODY) } });
    expect(big.status).toBe(413);
    const list = await send(origin, '/api/execute', { method: 'POST', body: '[1]', headers: { origin, 'content-type': 'application/json' } });
    expect(list.status).toBe(400);
  });
});

describe('the API', () => {
  it('reports what the server is: versions, viewer, Store, Agent and the clock, and no credential', async () => {
    const viewer = { id: 'local', name: 'you', via: 'loopback' as const };
    const { origin } = await start({ viewer });
    const { info: session } = await info(origin);
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
    });
  });

  it('runs a read from the allowlist read-only, with the viewer in its context', async () => {
    const { store, seen } = watched();
    const viewer = { id: 'local', name: 'you', via: 'loopback' as const };
    const { origin } = await start({ store, viewer });
    const res = await post(origin, '/api/execute', { command: 'projects show', input: { toilProject: 'card-payments' } });
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
    const res = await post(origin, '/api/execute', { command, input: {} });
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
    for (const command of ['jira issue create', 'jira issue transition', 'setup alias', 'projects remove', 'jira issue search']) {
      const res = await post(origin, '/api/config', { command, input: {} });
      expect(res.status, command).toBe(403);
      expect(JSON.parse(res.body).error.message).toContain(`Toil UI doesn't change ${command} from the page`);
    }
    expect(seen).toEqual([]);
  });

  it('runs a config command on the allowlist with config access, and only those', async () => {
    const { store, seen } = watched();
    const { origin } = await start({ store, configCommands: new Set(['projects field']) });
    await post(origin, '/api/config', { command: 'projects field', input: { toilProject: 'card-payments' } });
    expect(seen.map((s) => [s.command, s.access])).toEqual([['projects field', 'config']]);
    // A read command isn't a config command, and a config command isn't a read.
    expect((await post(origin, '/api/config', { command: 'projects list' })).status).toBe(403);
    expect((await post(origin, '/api/execute', { command: 'projects field' })).status).toBe(403);
  });

  it('asks the Agent with the viewer, and shows its failure as a message', async () => {
    const asked: string[] = [];
    const agent: Agent = { ...fixtureAgent(), ask: async (ctx, toilProject, prompt) => (asked.push(`${ctx.viewer.id} ${toilProject} ${prompt}`), fixtureAgent().ask(ctx, toilProject, prompt)) };
    const { origin } = await start({ agent });
    const starters = JSON.parse((await send(origin, '/api/agent/starters?toilProject=card-payments')).body) as Array<{ id: string }>;
    expect(starters.map((s) => s.id)).toEqual(['risk', 'attention', 'deployed', 'people', 'review']);
    const answer = JSON.parse((await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'risk' })).body);
    expect(answer.citations).toContain('corp-jira:PAY-101');
    expect(answer.proposals.map((p: { command: string }) => p.command)).toEqual(['jira issue update']);
    expect(asked).toEqual(['local card-payments risk']);

    const none = await start({ agent: noAgent() });
    expect(JSON.parse((await send(none.origin, '/api/agent/starters?toilProject=card-payments')).body)).toEqual([]);
    const failed = await post(none.origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'risk' });
    expect(failed.status).toBe(502);
    expect(JSON.parse(failed.body).error.message).toContain('No agent is set up');
    expect(JSON.parse(failed.body).error.fix).toContain('Settings, AI agent');
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
    const res = await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'q', stream: true });
    expect(res.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
    const lines = res.body.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([{ answer: versions(1) }, { answer: versions(2) }, { done: true }]);
    const boom = await post(origin, '/api/agent/ask', { toilProject: 'boom', prompt: 'q', stream: true });
    expect(boom.body.trim().split('\n').map((l) => JSON.parse(l)).at(-1)).toEqual({ error: { message: 'The CLI stopped.', fix: 'Run it once on its own.' } });
    // Without stream: true, the same agent answers whole through ask().
    expect(JSON.parse((await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'risk' })).body).by).toBe('scripted');
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
    const lines = (await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'analyze', stream: true })).body.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.at(-2).answer.analysis).toBe('kept-1');
    expect(lines.at(-1)).toEqual({ done: true });
    expect(kept).toEqual([{ toilProject: 'card-payments', text: 'Recommendation: Go.' }]);
    // Another question, or an Analyze that failed partway, keeps nothing.
    await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'risk', stream: true });
    await post(origin, '/api/agent/ask', { toilProject: 'boom', prompt: 'analyze', stream: true });
    expect(kept).toHaveLength(1);
    // Without stream: true, the whole answer is kept and names it.
    expect(JSON.parse((await post(origin, '/api/agent/ask', { toilProject: 'settlement', prompt: 'analyze' })).body).analysis).toBe('kept-2');

    const read = (path: string) => send(origin, path);
    expect(JSON.parse((await read('/api/analyses?toilProject=card-payments')).body)).toEqual([{ id: 'card-payments-1', at: 'x' }]);
    expect(JSON.parse((await read('/api/analyses/one?toilProject=card-payments&id=there')).body)).toEqual({ record: { id: 'there' } });
    const gone = await read('/api/analyses/one?toilProject=card-payments&id=gone');
    expect(gone.status).toBe(404);
    expect(JSON.parse(gone.body).error.message).toContain('no analysis by that id');
    expect((await read('/api/analyses')).status).toBe(400);
    // The history is read-only over the API: there is no route that writes one.
    expect((await post(origin, '/api/analyses', { toilProject: 'card-payments' })).status).toBe(404);
    // A server with no history says so, and Analyze still answers.
    const bare = await start({ agent });
    expect((await send(bare.origin, '/api/analyses?toilProject=card-payments')).status).toBe(404);
    expect((await post(bare.origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'analyze', stream: true })).status).toBe(200);
  });

  it('records a failed history write on the answer, never failing it (#395)', async () => {
    const analyses: AnalysisKeeper = { list: async () => [], get: async () => null, record: async () => Promise.reject(new Error('disk full')) };
    const { origin } = await start({ analyses });
    const answer = JSON.parse((await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'analyze' })).body);
    expect(answer.analysis).toBeUndefined();
    expect(answer.warnings.at(-1)).toContain("couldn't keep this analysis in its history: disk full");
  });

  it("serves the agent's settings only where there is a choice, and refuses a key", async () => {
    const sample = await start();
    expect((await info(sample.origin)).info.agentSettings).toBe(false);
    expect((await send(sample.origin, '/api/agent/settings')).status).toBe(404);

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
    expect((await info(origin)).info.agentSettings).toBe(true);
    expect(JSON.parse((await send(origin, '/api/agent/settings')).body).kind).toBe('none');
    expect((await post(origin, '/api/agent/settings', { adapter: 'claude' })).status).toBe(200);
    expect(saved).toEqual({ adapter: 'claude' });
    const key = await post(origin, '/api/agent/settings', { adapter: 'claude', apiKey: 'x' });
    expect(key.status).toBe(400);
    expect(JSON.parse(key.body).error).toEqual({ message: 'Toil UI\'s agent settings have no "apiKey".', fix: 'Keys never go here.' });
    // The full prompt (#283): read-only, in a built-in theme only.
    const prompt = (query: string) => send(origin, `/api/agent/prompt?${query}`);
    expect(JSON.parse((await prompt('toilProject=card-payments&theme=crate&voice=on')).body)).toEqual({ toilProject: 'card-payments', prompt: 'prompt for card-payments in crate with the voice on' });
    expect(JSON.parse((await prompt('theme=plain&voice=off')).body).toilProject).toBe('<Toil project>');
    expect((await prompt('theme=my-theme&voice=on')).status).toBe(400);
    expect((await prompt('theme=crate')).status).toBe(400);
    expect((await send(sample.origin, '/api/agent/prompt?theme=crate&voice=on')).status).toBe(404);
  });

  it("passes the page's theme and voice switch to the agent, and refuses a theme that isn't built in (#283)", async () => {
    const seen: unknown[] = [];
    const agent = { kind: 'scripted', starters: async () => [], ask: async (_ctx: unknown, _d: string, _p: string, style: unknown) => (seen.push(style), { prompt: 'p', parts: [], citations: [], by: 'scripted', proposals: [] }) };
    const { origin } = await start({ agent });
    expect((await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'risk', theme: 'harvest', voice: true })).status).toBe(200);
    expect((await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'risk' })).status).toBe(200);
    expect(seen).toEqual([{ theme: 'harvest', voice: true }, null]);
    const bad = await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'risk', theme: 'my-theme', voice: true });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error.message).toBe('There is no built-in theme "my-theme".');
    expect((await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'risk', theme: 'crate', voice: 'loud' })).status).toBe(400);
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
    const history = [{ prompt: 'Why?', answer: 'Because [[corp-jira:PAY-101]].', by: 'Claude (haiku)' }];
    expect((await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'And then?', adapter: 'codex', history })).status).toBe(200);
    expect((await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'q' })).status).toBe(200);
    expect(seen).toEqual([{ adapter: 'codex', history }, {}]);
    expect((await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'q', adapter: 'gemini' })).status).toBe(400);
    expect((await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'q', history: [{ prompt: 1 }] })).status).toBe(400);
    expect((await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'q', history: Array.from({ length: 21 }, () => ({ prompt: 'a', answer: 'b' })) })).status).toBe(400);
    expect((await post(origin, '/api/agent/ask', { toilProject: 'card-payments', prompt: 'q', history: [{ prompt: 'a', answer: 'b'.repeat(20_001) }] })).status).toBe(413);
    expect(seen).toHaveLength(2);
    expect(JSON.parse((await send(origin, '/api/agent/adapters')).body).chosen).toBe('claude');
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
    expect(JSON.parse((await send(origin, '/api/agent/install?adapter=codex')).body).command).toBe(plan.command);
    expect((await send(origin, '/api/agent/install?adapter=lodash')).status).toBe(400);
    const ok = await post(origin, '/api/agent/install', { adapter: 'codex', command: plan.command });
    expect(ok.body.trim().split('\n').map((l) => JSON.parse(l))).toEqual([{ line: 'added 2 packages' }, { done: true, status: { name: 'codex', installed: true } }]);
    const changed = await post(origin, '/api/agent/install', { adapter: 'codex', command: `${plan.command} lodash` });
    expect(JSON.parse(changed.body.trim()).error.message).toMatch(/has changed since it was shown/);
    expect((await post(origin, '/api/agent/install', { adapter: '@evil/pkg', command: plan.command })).status).toBe(400);
    expect((await post(origin, '/api/agent/install', { adapter: 'codex' })).status).toBe(400);
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
    const res = await send(origin, '/api/nothing');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error.fix).toContain('info, execute, config');
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
    const get = (path: string) => send(server.origin, path);
    return { ...server, get, sync, cache };
  }

  it('is not there with sample data', async () => {
    const { origin } = await start();
    expect((await send(origin, '/api/sync')).status).toBe(404);
    expect((await post(origin, '/api/sync', {})).status).toBe(404);
    expect((await post(origin, '/api/cache/wipe', { confirm: 'wipe' })).status).toBe(404);
  });

  it("takes a sync only from the page's own Origin", async () => {
    const { origin } = await withSync();
    expect((await post(origin, '/api/sync', {}, { origin: 'https://rebind.imagile.dev' })).status).toBe(403);
    expect((await post(origin, '/api/cache/wipe', { confirm: 'wipe' }, { origin: 'https://rebind.imagile.dev' })).status).toBe(403);
    expect(JSON.parse((await send(origin, '/api/sync')).body).job.running).toBe(false);
  });

  it('starts a sync, reports its progress, refuses a second, and the views then read the cache', async () => {
    let release!: () => void;
    const { origin, get } = await withSync(new Promise((r) => (release = r)));
    expect((await info(origin)).info).toMatchObject({ store: 'sqlite', sync: true, sample: false });
    const before = JSON.parse((await post(origin, '/api/execute', { command: 'jira issue search', input: { toilProject: 'card-payments', jql: JQL('PAY'), changelog: true } })).body) as Envelope;
    expect(before.ok).toBe(false);

    const started = await post(origin, '/api/sync', {});
    expect(started.status).toBe(202);
    expect(JSON.parse(started.body).job.running).toBe(true);
    expect((await post(origin, '/api/sync', {})).status).toBe(409);
    expect((await post(origin, '/api/cache/wipe', { confirm: 'wipe' })).status).toBe(409);
    release();

    let status = JSON.parse((await get('/api/sync')).body);
    for (let i = 0; status.job.running && i < 200; i++) {
      await new Promise((r) => setTimeout(r, 10));
      status = JSON.parse((await get('/api/sync')).body);
    }
    expect(status.job).toMatchObject({ running: false, error: null, toilProjectsDone: 3, by: 'local' });
    expect(status.retentionDays).toBe(30);
    expect(status.toilProjects.map((d: { name: string; status: string }) => `${d.name}:${d.status}`)).toEqual(['card-payments:ok', 'checkout-web:ok', 'settlement:ok']);

    const after = JSON.parse((await post(origin, '/api/execute', { command: 'jira issue search', input: { toilProject: 'card-payments', jql: JQL('PAY'), changelog: true } })).body) as Envelope;
    expect(after.ok).toBe(true);
    const one = await post(origin, '/api/sync', { toilProject: 7 });
    expect(one.status).toBe(400);
  });

  it('wipes only when the page confirms', async () => {
    const { origin, sync, cache } = await withSync();
    await sync.run({ viewer: { id: 'local', name: 'you', via: 'loopback' }, signal: new AbortController().signal });
    expect((await post(origin, '/api/cache/wipe', {})).status).toBe(400);
    expect(cache.counts().responses).toBeGreaterThan(0);
    const wiped = await post(origin, '/api/cache/wipe', { confirm: 'wipe' });
    expect(wiped.status).toBe(200);
    expect(JSON.parse(wiped.body).toilProjects).toEqual([]);
    expect(cache.counts().responses).toBe(0);
  });
});

describe('toil-ui wipe and a running server', () => {
  const ctx: RequestContext = { viewer: { id: 'local', name: 'you', via: 'loopback' }, signal: new AbortController().signal };

  async function serving(dataDir: string) {
    const cache = await Cache.open(dataDir, { retentionDays: 30 });
    const toil = stubToil();
    const sync = new SyncService({ cache, execute: toil.execute, mapOwi });
    const server = await start({ store: sqliteStore(() => cache, toil.execute as unknown as Execute, { version: '0.1.0-alpha.2', contractVersion: 1 }), sync, settings: settings({ sample: false, dataDir }) });
    return { ...server, cache, sync };
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
      const { origin, cache, sync } = await serving(dataDir);
      await sync.run(ctx);
      const wiped = await post(origin, '/api/cache/wipe', { confirm: 'wipe' });
      expect(wiped.status).toBe(200);
      expect(Object.values(cache.counts()).every((n) => n === 0)).toBe(true);
      expect(liveLock(dataDir)?.pid).toBe(process.pid);
      const job = await sync.run(ctx);
      expect(job.error).toBeNull();
      expect(cache.states().map((d) => d.status)).toEqual(['ok', 'ok', 'ok']);
      const search = JSON.parse((await post(origin, '/api/execute', { command: 'jira issue search', input: { toilProject: 'card-payments', jql: JQL('PAY'), changelog: true } })).body) as Envelope;
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
    const js = await send(origin, '/assets/app.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toContain('text/javascript');
    const dotted = await send(origin, '/assets/..app.js');
    expect(dotted.status, 'a name that merely starts with two dots').toBe(200);
    const paths = ['/../toil-ui-secret.txt', '/%2e%2e/toil-ui-secret.txt', '/assets/..%2f..%2ftoil-ui-secret.txt', '/..%5ctoil-ui-secret.txt', '/%2e%2e%5ctoil-ui-secret.txt', '/index.html::$DATA', '/assets', '/missing.js'];
    for (const path of paths) {
      const res = await send(origin, path);
      expect(res.status, path).toBe(404);
      expect(res.body).not.toContain('outside the app folder');
      expect(res.body).not.toContain('<div id="root">');
    }
  });

  it('serves under its base path only', async () => {
    const { origin, url } = await start({ settings: settings({ basePath: '/toil/' }) });
    expect(url).toBe(`${origin}/toil/`);
    expect((await info(origin, '/toil/')).res.status).toBe(200);
    expect((await send(origin, '/toil')).status).toBe(308);
    expect((await send(origin, '/index.html')).status).toBe(404);
    expect((await send(origin, '/api/info')).status).toBe(404);
    expect((await send(origin, '/toil/')).status).toBe(200);
    expect((await send(origin, '/toil/api/info')).status).toBe(200);
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
    const ctx: RequestContext = { viewer: { id: 'local', name: 'you', via: 'loopback' }, signal: new AbortController().signal };
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
    const ctx: RequestContext = { viewer: { id: 'local', name: 'you', via: 'loopback' }, signal: new AbortController().signal };
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
    const preview = await post(origin, '/api/feedback', { fields });
    expect(preview.status).toBe(200);
    expect(JSON.parse(preview.body).data).toMatchObject({ sent: false, report: { ...fields, consent: 1 } });
    await post(origin, '/api/feedback', { fields, consent: true });
    expect(calls).toEqual([
      { command: 'feedback', input: fields, access: 'feedback', readOnly: true, consent: 'no', other: undefined },
      { command: 'feedback', input: fields, access: 'feedback', readOnly: false, consent: 'yes', other: undefined },
    ]);
  });

  it('refuses anything but the four fields as text and consent: true, before a Store sees it', async () => {
    const { store, calls } = feedbackStore();
    const { origin } = await start({ store });
    for (const body of [{ command: 'jira issue create', fields }, { fields: { ...fields, connection: 'corp-jira' } }, { fields: { ...fields, title: 5 } }, { fields, consent: 'yes' }, { fields, consent: false }, { fields: [fields] }, {}]) {
      const res = await post(origin, '/api/feedback', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(JSON.parse(res.body).error.fix).toContain('"consent": true');
    }
    expect(calls).toEqual([]);
  });

  it("keeps the checks on the door: the page's own Origin and a JSON body", async () => {
    const { store, calls } = feedbackStore();
    const { origin } = await start({ store });
    const body = JSON.stringify({ fields, consent: true });
    const json = { 'content-type': 'application/json' };
    expect((await send(origin, '/api/feedback', { method: 'POST', body, headers: { origin, 'content-type': 'text/plain' } })).status).toBe(415);
    expect((await send(origin, '/api/feedback', { method: 'POST', body, headers: { origin: 'https://rebind.imagile.dev', ...json } })).status).toBe(403);
    expect((await post(origin, '/api/feedback', { fields, consent: true }, { origin: 'https://rebind.imagile.dev' })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('sends nothing with sample data, saying why', async () => {
    const { origin } = await start();
    const res = JSON.parse((await post(origin, '/api/feedback', { fields, consent: true })).body) as Envelope;
    expect(res.ok).toBe(false);
    expect(res.error?.message).toBe('Nothing was sent: this is sample data.');
  });

  it('hands toil the person only off the read path: toilStore runs feedback with readOnly as the server decided', async () => {
    const seen: unknown[] = [];
    const execute: Execute = async (command, input, options) => (seen.push([command, input, options]), { ok: true, data: null, error: null, meta: { command, durationMs: 0, version: 'x', contractVersion: 1 } } as Envelope);
    const ctx: RequestContext = { viewer: { id: 'local', name: 'you', via: 'loopback' }, signal: new AbortController().signal };
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
  const get = (origin: string, path: string) => send(origin, path);

  it("serves the sample's calendar and pages", async () => {
    const { fixtureWorklog } = await import('../src/fixtures/worklog.ts');
    const { origin } = await start({ worklog: fixtureWorklog() });
    const month = await get(origin, '/api/worklog/month?toilProject=card-payments');
    expect(month.status).toBe(200);
    expect(JSON.parse(month.body)).toMatchObject({ toilProject: 'card-payments', month: '2026-10', today: '2026-10-13', timeZone: 'UTC' });
    const day = JSON.parse((await get(origin, '/api/worklog/day?toilProject=card-payments&day=2026-10-12')).body) as { markdown: string; file: null };
    expect(day.markdown).toMatch(/^# Worklog: card-payments, Monday 12 October 2026/);
    expect(day.file).toBeNull();
  });

  it("answers a refusal with its own status, message and fix, and a missing field with how to send it", async () => {
    const { fixtureWorklog } = await import('../src/fixtures/worklog.ts');
    const { origin } = await start({ worklog: fixtureWorklog() });
    const future = await get(origin, '/api/worklog/day?toilProject=card-payments&day=2026-10-14');
    expect(future.status).toBe(400);
    expect(JSON.parse(future.body)).toEqual({ error: { message: "2026-10-14 hasn't happened yet, so it has no page.", fix: 'Pick today or an earlier day.' } });
    expect(JSON.parse((await get(origin, '/api/worklog/day?toilProject=card-payments')).body).error.message).toBe('Name the day.');
    const note = await post(origin, '/api/worklog/note', { toilProject: 'card-payments', text: 'hi' });
    expect(note.status).toBe(400);
    expect(JSON.parse(note.body).error.message).toMatch(/sample data/);
    const both = await post(origin, '/api/worklog/export', { toilProject: 'card-payments', day: '2026-10-12', month: '2026-10', folder: '/tmp' });
    expect(JSON.parse(both.body).error.message).toBe('Export a day, a month or a stand-up, one of the three.');
    const mixed = await post(origin, '/api/worklog/export', { toilProject: 'card-payments', day: '2026-10-12', from: '2026-10-12', to: '2026-10-13', folder: '/tmp' });
    expect(JSON.parse(mixed.body).error.message).toBe('Export a day, a month or a stand-up, one of the three.');
    const half = await post(origin, '/api/worklog/export', { toilProject: 'card-payments', from: '2026-10-12', folder: '/tmp' });
    expect(JSON.parse(half.body).error.message).toBe('Name the last day.');
    const extra = await post(origin, '/api/worklog/export', { toilProject: 'card-payments', day: '2026-10-12', folder: '/tmp', overwrite: true });
    expect(JSON.parse(extra.body).error.message).toBe("An export takes toilProject, a day, a month or a stand-up's from and to, and folder, not overwrite.");
    const misspelt = await post(origin, '/api/worklog/note', { toilProject: 'card-payments', txt: 'hi' });
    expect(JSON.parse(misspelt.body).error.message).toBe('A note takes toilProject and text, not txt.');
  });

  it('answers a stand-up (#345) for a range, and refuses a range it cannot cover', async () => {
    const { fixtureWorklog } = await import('../src/fixtures/worklog.ts');
    const { origin } = await start({ worklog: fixtureWorklog() });
    const ok = await get(origin, '/api/worklog/standup?toilProject=card-payments&from=2026-10-12&to=2026-10-13');
    expect(ok.status).toBe(200);
    const body = JSON.parse(ok.body) as { markdown: string; text: string; report: { from: string; to: string } };
    expect(body.markdown).toMatch(/^# Stand-up: card-payments, 12 Oct 2026 to 13 Oct 2026/);
    expect(body.text).toMatch(/^Stand-up: card-payments, 12 Oct 2026 to 13 Oct 2026/);
    expect(body.report).toMatchObject({ from: '2026-10-12', to: '2026-10-13' });
    const future = await get(origin, '/api/worklog/standup?toilProject=card-payments&from=2026-10-12&to=2026-10-14');
    expect(future.status).toBe(400);
    expect(JSON.parse(future.body).error.message).toBe("2026-10-14 hasn't happened yet: end the range today (2026-10-13) or earlier.");
    expect(JSON.parse((await get(origin, '/api/worklog/standup?toilProject=card-payments&from=2026-10-12')).body).error.message).toBe('Name the last day.');
  });

  it("takes a change only from the page's own Origin: a rebuild, a note, an export", async () => {
    const { fixtureWorklog } = await import('../src/fixtures/worklog.ts');
    const { origin } = await start({ worklog: fixtureWorklog() });
    for (const path of ['/api/worklog/rebuild', '/api/worklog/note', '/api/worklog/export']) {
      const res = await post(origin, path, { toilProject: 'card-payments', day: '2026-10-12' }, { origin: 'https://rebind.imagile.dev' });
      expect(res.status, path).toBe(403);
    }
  });

  it('passes the viewer to a note as its author', async () => {
    const notes: Array<{ text: string; by?: string }> = [];
    const { fixtureWorklog } = await import('../src/fixtures/worklog.ts');
    const inner = fixtureWorklog();
    const { origin } = await start({ viewer: { id: 'local', name: 'Ada', via: 'loopback' }, worklog: { ...inner, disabled: null, addNote: async (toilProject, text, by?: string) => (notes.push({ text, ...(by ? { by } : {}) }), inner.day(toilProject, '2026-10-13')) } });
    expect((await post(origin, '/api/worklog/note', { toilProject: 'card-payments', text: 'Paired on it' })).status).toBe(200);
    expect(notes).toEqual([{ text: 'Paired on it', by: 'Ada' }]);
  });

  it('says plainly when it keeps no worklog', async () => {
    const { origin } = await start();
    const res = await get(origin, '/api/worklog/month?toilProject=card-payments');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error.message).toBe('This Toil UI keeps no worklog.');
  });
});

describe('stale sessions (#305)', () => {
  const get = (origin: string, path: string) => send(origin, path);
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
    expect(JSON.parse((await get(origin, '/api/agent/session?chat=chat-0000-0001')).body)).toEqual(session);
    expect(JSON.parse((await get(origin, '/api/agent/session?chat=chat-0000-0009')).body)).toBeNull();
    expect((await get(origin, '/api/agent/session?chat=not%20an%20id')).status).toBe(400);
  });

  it('renews a chat from the page only, and says why when it is answering', async () => {
    const { origin } = await start({ agent: agent() });
    const done = await post(origin, '/api/agent/renew', { chat: 'chat-0000-0001', toilProject: 'card-payments' });
    expect(JSON.parse(done.body)).toMatchObject({ renewals: 1, stale: null });
    const busy = await post(origin, '/api/agent/renew', { chat: 'chat-busy-0001', toilProject: 'card-payments' });
    expect(busy.status).toBe(409);
    expect(JSON.parse(busy.body).error.message).toContain('never interrupts');
    const plain = await start();
    expect((await post(plain.origin, '/api/agent/renew', { chat: 'chat-0000-0001', toilProject: 'card-payments' })).status).toBe(404);
  });

  it("answers the server's own staleness for the header, and null where it keeps none", async () => {
    const status = { running: { toil: { version: '0.1.0-alpha.3', commit: null }, toilUi: { version: '0.1.0-alpha.2', commit: null } }, disk: { toil: { version: '0.1.0-alpha.4', commit: null }, toilUi: { version: '0.1.0-alpha.2', commit: null } }, stale: 'toil 0.1.0-alpha.4 is installed, and this server runs 0.1.0-alpha.3.', restart: 'node toil-ui.js' };
    const { origin } = await start({ serverStatus: () => status });
    expect(JSON.parse((await get(origin, '/api/fingerprint')).body)).toEqual(status);
    const plain = await start();
    expect(JSON.parse((await get(plain.origin, '/api/fingerprint')).body)).toBeNull();
  });
});
