import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { connectionsCommands } from '../src/connections/commands.js';
import { defineArea } from '../src/core/area.js';
import { loadConfig } from '../src/core/config.js';
import type { Context } from '../src/core/context.js';
import { createSecretStore, type SecretStore } from '../src/core/keychain.js';
import { terminalPrompter, type Prompter } from '../src/core/prompt.js';
import { demoArea, demoCommands, demoRoutes } from './fixtures/demo-commands.js';
import { demoContextArea } from './fixtures/demo-context-commands.js';
import { areas as registryAreas } from '../src/registry.js';
import { runCli } from './harness/cli.js';
import { TEST_VERSION } from './harness/context.js';
import { fakeFetch } from './harness/fake-fetch.js';
import { fakeStore } from './harness/fake-store.js';
import { memoryFiles } from './harness/files.js';

/**
 * `toil connections` against a real config file in a temp home, a fake
 * credential store and a scripted terminal. Nothing here touches the OS
 * store or reads a real terminal.
 */
const warehouse = defineArea({
  name: 'warehouse',
  description: 'A database that signs in with a username and password',
  connection: z.object({
    host: z.string().min(1).describe('Server host'),
    port: z.number().int().describe('Port'),
    username: z.string().min(1).describe('User name'),
    password: z.string().min(1).describe('Password'),
  }),
  secrets: ['password'],
  defaults: { port: 5432 },
});
/** An HTTP area with a live check, for `connections test`. */
const service = defineArea({
  name: 'service',
  description: 'An HTTP API with a probe',
  connection: z.object({ baseUrl: z.url().describe('API root'), token: z.string().min(1).describe('Token') }),
  secrets: ['token'],
  probe: () => ({ path: '/api/me', query: { fields: 'id' } }),
  request: (c) => ({ baseUrl: c.baseUrl, headers: { Authorization: `Bearer ${c.token}` }, service: 'Service', authFix: 'Create a new token.' }),
});
/** A service whose only cheap read answers anyone, and which takes an object setting. */
const pinged = defineArea({
  name: 'pinged',
  description: 'An HTTP API with only a public ping',
  connection: z.object({ baseUrl: z.url().describe('API root'), token: z.string().min(1).describe('Token'), labels: z.record(z.string(), z.string()).optional().describe('Labels') }),
  secrets: ['token'],
  probe: () => ({ path: '/ping', authenticated: false, as: 'text' }),
  request: (c) => ({ baseUrl: c.baseUrl, headers: { Authorization: `Bearer ${c.token}` } }),
});
const areas = [demoArea, warehouse, service, pinged, demoContextArea];
const commands = [...connectionsCommands(areas), ...demoCommands];
const SECRET = 'fake-token-abc12345';

let root: string;
let home: string;
let file: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'toil-connections-'));
  home = join(root, 'home');
  file = join(home, '.toil', 'config.json');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const writeConfig = (content: unknown) => {
  mkdirSync(join(home, '.toil'), { recursive: true });
  writeFileSync(file, JSON.stringify(content));
};
const readConfig = () => JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A scripted terminal: answers by the question's first word, and records what was asked and how. */
function terminal(answers: Record<string, string>) {
  const asked: Array<{ key: string; hidden: boolean; question: string }> = [];
  const answer = (question: string, hidden: boolean) => {
    const key = question.split(/[\s(]/)[0]!;
    asked.push({ key, hidden, question });
    return answers[key] ?? '';
  };
  const prompt: Prompter = {
    ask: async (q, fallback) => answer(q, false) || fallback || '',
    askSecret: async (q) => answer(q, true),
  };
  return { prompt, asked };
}

function context(options: { prompt?: Prompter; secrets?: SecretStore; env?: NodeJS.ProcessEnv } = {}): Context {
  const env = options.env ?? {};
  return {
    config: loadConfig({ env, cwd: root, home, areas: areas.map((a) => ({ name: a.name })) }),
    fetch: fakeFetch(demoRoutes).fetch,
    files: memoryFiles(),
    env,
    version: TEST_VERSION,
    verbose: false,
    debug: () => {},
    ...(options.secrets ? { secrets: options.secrets } : {}),
    ...(options.prompt ? { prompt: options.prompt } : {}),
  };
}

const cli = (argv: string[], ctx: Context) => runCli(argv, { commands, context: ctx });

describe('toil connections add', () => {
  it('asks for the area, base URL and keys with defaults from defineArea, reads the token hidden, and keeps it only in the store', async () => {
    const store = fakeStore();
    const { prompt, asked } = terminal({ Area: 'demo', baseUrl: 'https://jira.imagile.dev', token: SECRET });
    const run = await cli(['connections', 'add', 'corp-demo'], context({ prompt, secrets: store }));

    expect(run.envelope).toMatchObject({ ok: true, data: { name: 'corp-demo', area: 'demo', secrets: { token: 'store' } } });
    expect(asked.map((a) => [a.key, a.hidden])).toEqual([
      ['Area', false],
      ['baseUrl', false],
      ['pageSize', false],
      ['token', true],
      ['Save', false],
    ]);
    expect(asked.find((a) => a.key === 'baseUrl')!.question).toContain('API base URL');
    // The review names every setting and where the secret goes, never the secret itself.
    const review = asked.find((a) => a.key === 'Save')!.question;
    expect(review).toContain('baseUrl https://jira.imagile.dev');
    expect(review).toContain('token to the OS credential store');
    expect(review).not.toContain(SECRET);
    expect(store.entries.get('corp-demo.token')).toBe(SECRET);
    expect(store.log).toEqual(['set corp-demo.token', 'get corp-demo.token']);
    expect(readConfig()).toEqual({
      version: 4,
      connections: { 'corp-demo': { area: 'demo', baseUrl: 'https://jira.imagile.dev', token: 'keychain:corp-demo.token' } },
      defaults: { demo: { connection: 'corp-demo' } },
    });
    expect(readFileSync(file, 'utf8')).not.toContain(SECRET);
    expect(run.stdout + run.stderr).not.toContain(SECRET);
  });

  it('then the area command reads the token from the store and sends it, never the reference', async () => {
    const store = fakeStore();
    await cli(['connections', 'add', 'corp-demo', '--area', 'demo'], context({ prompt: terminal({ token: SECRET }).prompt, secrets: store }));
    const ctx = context({ secrets: store });
    const http = fakeFetch(demoRoutes);
    ctx.fetch = http.fetch;
    const run = await cli(['demo', 'get-thing', '--id', 'THING-1'], ctx);
    expect(run.envelope?.ok, run.stdout).toBe(true);
    expect(http.calls[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
  });

  it('then refuses a plaintext secret written into the file by hand, without echoing it', async () => {
    writeConfig({ version: 2, connections: { 'corp-demo': { area: 'demo', token: 'hand-pasted-secret' } } });
    const run = await cli(['demo', 'get-thing', '--id', 'THING-1'], context({ secrets: fakeStore() }));
    expect(run.envelope?.error).toMatchObject({
      code: 'CONFIG_INVALID',
      fix: expect.stringMatching(/toil connections login corp-demo.*TOIL_CONN_CORP_DEMO_TOKEN or TOIL_DEMO_TOKEN/),
    });
    expect(run.stdout).not.toContain('hand-pasted-secret');
    // login is the way out: it moves the secret into the store and the command works again.
    const store = fakeStore();
    await cli(['connections', 'login', 'corp-demo'], context({ prompt: terminal({ token: SECRET }).prompt, secrets: store }));
    expect(readFileSync(file, 'utf8')).not.toContain('hand-pasted-secret');
    expect((await cli(['demo', 'get-thing', '--id', 'THING-1'], context({ secrets: store }))).envelope?.ok).toBe(true);
  });

  it('a hung store read is ended by the time limit with a TIMEOUT envelope, before any request', async () => {
    writeConfig({ version: 2, connections: { demo: { area: 'demo', token: 'keychain:demo.token' } } });
    let signal: AbortSignal | undefined;
    const hung: SecretStore = {
      ...fakeStore(),
      // Never answers, as a store waiting on an unlock dialog nobody sees; only the abort ends it.
      get: (_ref, s) => {
        signal = s;
        return new Promise(() => {});
      },
    };
    const ctx = { ...context({ secrets: hung }), timeoutMs: 50 };
    const http = fakeFetch(demoRoutes);
    ctx.fetch = http.fetch;
    const run = await cli(['demo', 'get-thing', '--id', 'THING-1'], ctx);
    expect(run.envelope?.error?.code).toBe('TIMEOUT');
    expect(signal?.aborted, 'the store read was handed the aborted signal').toBe(true);
    expect(http.calls).toHaveLength(0);
  });

  it('shows an object setting in the review as JSON', async () => {
    const { prompt, asked } = terminal({ baseUrl: 'https://pinged.imagile.dev', labels: '{"team":"payments"}', token: SECRET });
    const run = await cli(['connections', 'add', 'p', '--area', 'pinged'], context({ prompt, secrets: fakeStore() }));
    expect(run.envelope?.ok, run.stdout).toBe(true);
    expect(asked.find((a) => a.key === 'Save')!.question).toContain('labels {"team":"payments"}');
  });

  it('keeps an accepted provider default out of config, so the default can still change', async () => {
    const { prompt } = terminal({ token: SECRET });
    await cli(['connections', 'add', 'corp-demo', '--area', 'demo'], context({ prompt, secrets: fakeStore() }));
    expect(readConfig().connections['corp-demo']).toEqual({ area: 'demo', token: 'keychain:corp-demo.token' });
  });

  it('asks a token area only for its token, and a password area for its password, both hidden', async () => {
    const tokenOnly = terminal({ token: SECRET });
    await cli(['connections', 'add', 'corp-demo', '--area', 'demo'], context({ prompt: tokenOnly.prompt, secrets: fakeStore() }));
    expect(tokenOnly.asked.filter((a) => a.hidden).map((a) => a.key)).toEqual(['token']);
    expect(tokenOnly.asked.map((a) => a.key)).not.toContain('password');
    expect(tokenOnly.asked.map((a) => a.key)).not.toContain('username');

    const store = fakeStore();
    const db = terminal({ host: 'db.imagile.dev', username: 'reporter', password: 'fake-password' });
    const run = await cli(['connections', 'add', 'reporting', '--area', 'warehouse'], context({ prompt: db.prompt, secrets: store }));
    expect(run.envelope?.ok, run.stdout).toBe(true);
    expect(db.asked.map((a) => [a.key, a.hidden])).toEqual([
      ['host', false],
      ['port', false],
      ['username', false],
      ['password', true],
      ['Save', false],
    ]);
    expect(db.asked.find((a) => a.key === 'port')).toBeDefined();
    expect(readConfig().connections.reporting).toEqual({ area: 'warehouse', host: 'db.imagile.dev', username: 'reporter', password: 'keychain:reporting.password' });
  });

  it('carries through every key it did not ask about, and writes version 2', async () => {
    writeConfig({
      version: 2,
      $schema: 'https://imagile-dev.github.io/toil/config.schema.json',
      futureKey: { kept: true },
      connections: { other: { area: 'demo', baseUrl: 'https://other.imagile.dev', token: 'keychain:other.token', writes: true, note: 'unknown key' } },
      defaults: { demo: { connection: 'other', pageSize: 5 } },
    });
    await cli(['connections', 'add', 'second', '--area', 'demo'], context({ prompt: terminal({ token: SECRET }).prompt, secrets: fakeStore() }));
    expect(readConfig()).toEqual({
      version: 4,
      $schema: 'https://imagile-dev.github.io/toil/config.schema.json',
      futureKey: { kept: true },
      connections: {
        other: { area: 'demo', baseUrl: 'https://other.imagile.dev', token: 'keychain:other.token', writes: true, note: 'unknown key' },
        second: { area: 'demo', token: 'keychain:second.token' },
      },
      defaults: { demo: { connection: 'other', pageSize: 5 } },
    });
  });

  it('upgrades a version 1 file to the version 2 file it meant, settings intact', async () => {
    writeConfig({ demo: { baseUrl: 'https://v1.imagile.dev', token: 'plain', writes: true } });
    await cli(['connections', 'add', 'reporting', '--area', 'warehouse'], context({ prompt: terminal({ host: 'h', username: 'u', password: 'p' }).prompt, secrets: fakeStore() }));
    expect(readConfig()).toEqual({
      version: 4,
      connections: {
        demo: { area: 'demo', baseUrl: 'https://v1.imagile.dev', token: 'plain', writes: true },
        reporting: { area: 'warehouse', host: 'h', username: 'u', password: 'keychain:reporting.password' },
      },
      defaults: { demo: { connection: 'demo' }, warehouse: { connection: 'reporting' } },
    });
  });

  it.skipIf(process.platform === 'win32')('writes the file readable by the user only (POSIX modes; Windows has none to set)', async () => {
    await cli(['connections', 'add', 'corp-demo', '--area', 'demo'], context({ prompt: terminal({ token: SECRET }).prompt, secrets: fakeStore() }));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, '.toil')).mode & 0o777).toBe(0o700);
  });

  it('with no terminal, fails with a fix naming the env vars, and writes nothing', async () => {
    const store = fakeStore();
    const run = await cli(['connections', 'add', 'corp-demo', '--area', 'demo'], context({ secrets: store }));
    expect(run.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', fix: expect.stringContaining('TOIL_CONN_CORP_DEMO_AREA=demo, TOIL_CONN_CORP_DEMO_BASE_URL, TOIL_CONN_CORP_DEMO_TOKEN') });
    const unknownArea = await cli(['connections', 'add', 'corp-demo'], context({ secrets: store }));
    expect(unknownArea.envelope?.error?.fix).toContain('TOIL_CONN_CORP_DEMO_AREA=<area>');
    expect(store.log).toEqual([]);
    expect(() => readConfig()).toThrow();
  });

  it('when the store is unavailable, fails with a fix naming the env var, and writes nothing', async () => {
    // The real Linux store, with a spawner reporting that secret-tool isn't installed.
    const unavailable = createSecretStore({
      platform: 'linux',
      spawn: async () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' }) }),
    });
    const run = await cli(['connections', 'add', 'corp-demo', '--area', 'demo'], context({ prompt: terminal({ token: SECRET }).prompt, secrets: unavailable }));
    expect(run.envelope?.error).toMatchObject({ code: 'CREDENTIAL_STORE', fix: expect.stringContaining('Set TOIL_CONN_CORP_DEMO_TOKEN instead') });
    expect(run.envelope?.error?.fix).not.toContain('--plaintext');
    expect(() => readConfig()).toThrow();
  });

  it('refuses settings the area would reject, before storing anything', async () => {
    const store = fakeStore();
    const run = await cli(['connections', 'add', 'corp-demo', '--area', 'demo'], context({ prompt: terminal({ baseUrl: 'not a url', token: SECRET }).prompt, secrets: store }));
    expect(run.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('baseUrl') });
    expect(JSON.stringify(run.envelope)).not.toContain(SECRET);
    expect(store.log).toEqual([]);
  });

  it('refuses a name that is taken, or not a valid connection name', async () => {
    writeConfig({ version: 2, connections: { 'corp-demo': { area: 'demo', token: 't' } } });
    const taken = await cli(['connections', 'add', 'corp-demo', '--area', 'demo'], context({ prompt: terminal({}).prompt, secrets: fakeStore() }));
    expect(taken.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', fix: expect.stringContaining('toil connections login corp-demo') });
    const bad = await cli(['connections', 'add', 'Corp_Demo'], context({ prompt: terminal({}).prompt, secrets: fakeStore() }));
    expect(bad.envelope?.error?.code).toBe('INVALID_INPUT');
  });
});

describe('toil connections login', () => {
  it('stores and verifies the new secret, rewrites config, and only then deletes the old plaintext or entry', async () => {
    writeConfig({ version: 2, connections: { a: { area: 'demo', token: 'keychain:old.token' }, b: { area: 'demo', token: 'plain-old' } }, defaults: { demo: { connection: 'a' } } });
    const seenAtDelete: string[] = [];
    const store = fakeStore({ entries: { 'old.token': 'old-secret' }, onDelete: () => seenAtDelete.push(readFileSync(file, 'utf8')) });

    const a = await cli(['connections', 'login', 'a'], context({ prompt: terminal({ token: SECRET }).prompt, secrets: store }));
    expect(a.envelope, a.stdout).toMatchObject({ ok: true, data: { secrets: { token: 'store' } } });
    expect(store.log).toEqual(['set a.token', 'get a.token', 'delete old.token']);
    expect(seenAtDelete[0]).toContain('keychain:a.token');
    expect(seenAtDelete[0]).not.toContain('keychain:old.token');
    expect([...store.entries]).toEqual([['a.token', SECRET]]);

    await cli(['connections', 'login', 'b'], context({ prompt: terminal({ token: 'fake-new' }).prompt, secrets: store }));
    expect(readConfig().connections.b).toEqual({ area: 'demo', token: 'keychain:b.token' });
    expect(readFileSync(file, 'utf8')).not.toContain('plain-old');
  });

  it('replaces an entry in place, and keeps an old entry another connection still uses', async () => {
    writeConfig({ version: 2, connections: { a: { area: 'demo', token: 'keychain:shared.token' }, b: { area: 'demo', token: 'keychain:shared.token' } }, defaults: { demo: { connection: 'a' } } });
    const store = fakeStore({ entries: { 'shared.token': 'old' } });
    await cli(['connections', 'login', 'a'], context({ prompt: terminal({ token: SECRET }).prompt, secrets: store }));
    expect(store.entries.get('shared.token')).toBe('old');
    expect(store.log).not.toContain('delete shared.token');
  });

  it('with no terminal, fails with a fix naming the env vars and changes nothing', async () => {
    writeConfig({ version: 2, connections: { a: { area: 'demo', token: 'keychain:a.token' } } });
    const before = readFileSync(file, 'utf8');
    const run = await cli(['connections', 'login', 'a'], context({ secrets: fakeStore() }));
    expect(run.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', fix: expect.stringContaining('TOIL_CONN_A_TOKEN') });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses a connection defined only by env vars, or one that does not exist', async () => {
    const env = { TOIL_CONN_CI_DEMO_AREA: 'demo', TOIL_CONN_CI_DEMO_TOKEN: 'x' };
    const envOnly = await cli(['connections', 'login', 'ci-demo'], context({ env, prompt: terminal({}).prompt }));
    expect(envOnly.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', fix: expect.stringContaining('TOIL_CONN_CI_DEMO_') });
    const missing = await cli(['connections', 'login', 'nope'], context({ prompt: terminal({}).prompt }));
    expect(missing.envelope?.error?.code).toBe('INVALID_INPUT');
  });
});

describe('toil connections remove', () => {
  it('removes the connection and its default, then deletes its store entry', async () => {
    writeConfig({ version: 2, connections: { a: { area: 'demo', token: 'keychain:a.token' }, b: { area: 'demo', token: 'keychain:b.token' } }, defaults: { demo: { connection: 'a', pageSize: 5 } } });
    const seenAtDelete: string[] = [];
    const store = fakeStore({ entries: { 'a.token': 'x', 'b.token': 'y' }, onDelete: () => seenAtDelete.push(readFileSync(file, 'utf8')) });
    const run = await cli(['connections', 'remove', 'a'], context({ secrets: store }));
    expect(run.envelope).toMatchObject({ ok: true, data: { name: 'a', deletedFromStore: ['a.token'] } });
    expect(readConfig()).toEqual({ version: 4, connections: { b: { area: 'demo', token: 'keychain:b.token' } }, defaults: { demo: { pageSize: 5 } } });
    expect(seenAtDelete[0]).not.toContain('"a"');
    expect([...store.entries.keys()]).toEqual(['b.token']);
  });

  it('removes from config even when the store is unavailable, and warns about what was left', async () => {
    writeConfig({ version: 2, connections: { a: { area: 'demo', token: 'keychain:a.token' } } });
    const run = await cli(['connections', 'remove', 'a'], context({ secrets: fakeStore({ fail: new Error('locked') }) }));
    expect(run.envelope?.ok).toBe(true);
    expect(run.envelope?.meta.warnings).toEqual([expect.objectContaining({ code: 'CREDENTIAL_STORE_LEFTOVER' })]);
    expect(readConfig().connections).toEqual({});
  });

  it('--area jira-cloud on add, list and remove says where the area went, rather than that toil has no such area', async () => {
    writeConfig({ version: 3, connections: {} });
    for (const argv of [['connections', 'add', 'x', '--area', 'jira-cloud'], ['connections', 'list', '--area', 'jira-cloud'], ['connections', 'remove', 'x', '--area', 'jira-cloud']]) {
      const run = await cli(argv, context({ secrets: fakeStore() }));
      expect(run.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: 'toil jira-cloud no longer exists.', fix: expect.stringContaining('TOIL_JIRA_DEPLOYMENT=cloud') });
    }
  });

  it('with --area, removes only a connection to that area, and refuses another before changing anything', async () => {
    const config = { version: 2, connections: { a: { area: 'demo', token: 'keychain:a.token' }, w: { area: 'warehouse', host: 'db.imagile.dev', username: 'u' } } };
    writeConfig(config);
    const store = fakeStore({ entries: { 'a.token': 'x' } });
    const wrong = await cli(['connections', 'remove', 'a', '--area', 'warehouse'], context({ secrets: store }));
    expect(wrong.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Connection "a" is a demo connection, not warehouse. Nothing was removed.' });
    const unknown = await cli(['connections', 'remove', 'a', '--area', 'nope'], context({ secrets: store }));
    expect(unknown.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: 'toil has no area named "nope".' });
    expect(readConfig()).toEqual(config);
    expect([...store.entries.keys()]).toEqual(['a.token']);

    const right = await cli(['connections', 'remove', 'a', '--area', 'demo'], context({ secrets: store }));
    expect(right.envelope).toMatchObject({ ok: true, data: { name: 'a', area: 'demo', deletedFromStore: ['a.token'] } });
    expect(Object.keys(readConfig().connections)).toEqual(['w']);
  });
});

describe('toil connections list', () => {
  it('shows names, areas, hosts, writes and where each value came from, never a secret, even a plaintext one left in an old file', async () => {
    writeConfig({
      version: 2,
      connections: {
        a: { area: 'demo', baseUrl: 'https://jira.imagile.dev', token: 'keychain:a.token', writes: true },
        b: { area: 'demo', token: 'plaintext-secret' },
        reporting: { area: 'warehouse', host: 'db.imagile.dev', username: 'reporter', password: 'plaintext-password' },
      },
      defaults: { demo: { connection: 'a', pageSize: 5 } },
    });
    const store = fakeStore({ entries: { 'a.token': SECRET } });
    const run = await cli(['connections', 'list'], context({ secrets: store, env: { TOIL_CONN_B_BASE_URL: 'https://env.imagile.dev' } }));
    expect(run.envelope?.data).toEqual({
      configFile: file.replace(/\\/g, '/'),
      connections: [
        { name: 'a', area: 'demo', isDefault: true, host: 'jira.imagile.dev', writes: true, values: { baseUrl: 'file', token: 'store', writes: 'file', pageSize: 'defaults' }, definedIn: 'file' },
        { name: 'b', area: 'demo', isDefault: false, host: 'env.imagile.dev', writes: false, values: { token: 'file', baseUrl: 'env', pageSize: 'defaults' }, definedIn: 'file' },
        { name: 'reporting', area: 'warehouse', isDefault: true, host: 'db.imagile.dev', writes: false, values: { host: 'file', username: 'file', password: 'file' }, definedIn: 'file' },
      ],
    });
    for (const secret of [SECRET, 'plaintext-secret', 'plaintext-password', 'keychain:']) expect(run.stdout).not.toContain(secret);
    // Listing never asks the store for anything.
    expect(store.log).toEqual([]);
  });
});

describe('toil connections test', () => {
  const probeRoute = (status: number) => [{ method: 'GET', path: '/api/me', query: { fields: 'id' }, origin: 'https://service.imagile.dev', respond: { status, json: { id: 'you' } } }];
  const svc = () => writeConfig({ version: 2, connections: { svc: { area: 'service', baseUrl: 'https://service.imagile.dev', token: 'keychain:svc.token' } } });

  it("sends the area's one GET with the secret from the store, and says it was live", async () => {
    svc();
    const ctx = context({ secrets: fakeStore({ entries: { 'svc.token': SECRET } }) });
    const http = fakeFetch(probeRoute(200));
    ctx.fetch = http.fetch;
    const run = await cli(['connections', 'test', 'svc'], ctx);
    expect(run.envelope).toMatchObject({ ok: true, data: { name: 'svc', area: 'service', host: 'service.imagile.dev', live: true, request: 'GET /api/me' } });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]).toMatchObject({ method: 'GET', url: 'https://service.imagile.dev/api/me?fields=id' });
    expect(http.calls[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(run.stdout).not.toContain(SECRET);
  });

  it("fails as a real command would when the service rejects the credential, with the area's fix", async () => {
    svc();
    const ctx = context({ secrets: fakeStore({ entries: { 'svc.token': SECRET } }) });
    ctx.fetch = fakeFetch(probeRoute(401)).fetch;
    const run = await cli(['connections', 'test', 'svc'], ctx);
    expect(run.envelope?.error).toMatchObject({ code: 'AUTH', fix: 'Create a new token.' });
    expect(run.exitCode).not.toBe(0);
  });

  it('fails before sending anything when the secret is missing from the store', async () => {
    svc();
    const ctx = context({ secrets: fakeStore() });
    const http = fakeFetch(probeRoute(200));
    ctx.fetch = http.fetch;
    const run = await cli(['connections', 'test', 'svc'], ctx);
    expect(run.envelope?.ok).toBe(false);
    expect(http.calls).toHaveLength(0);
  });

  it('for an area with no live check, checks settings and secret, sends nothing, and says so', async () => {
    writeConfig({ version: 2, connections: { d: { area: 'demo', token: 'keychain:d.token' } } });
    const ctx = context({ secrets: fakeStore({ entries: { 'd.token': SECRET } }) });
    const http = fakeFetch([]);
    ctx.fetch = http.fetch;
    const run = await cli(['connections', 'test', 'd'], ctx);
    expect(run.envelope).toMatchObject({ ok: true, data: { name: 'd', area: 'demo', live: false, request: null } });
    expect(run.envelope?.meta.warnings?.map((w) => w.code)).toContain('NOT_LIVE_TESTED');
    expect(http.calls).toHaveLength(0);
  });

  it('says so when the only read it can send answers without the credential', async () => {
    writeConfig({ version: 2, connections: { p: { area: 'pinged', baseUrl: 'https://pinged.imagile.dev', token: 'keychain:p.token' } } });
    const ctx = context({ secrets: fakeStore({ entries: { 'p.token': SECRET } }) });
    ctx.fetch = fakeFetch([{ method: 'GET', url: 'https://pinged.imagile.dev/ping', respond: { text: 'OK' } }]).fetch;
    const run = await cli(['connections', 'test', 'p'], ctx);
    expect(run.envelope).toMatchObject({ ok: true, data: { live: true, authenticated: false } });
    expect(run.envelope?.meta.warnings?.map((w) => w.code)).toContain('NOT_AUTHENTICATED');
  });

  it('refuses a name with no connection', async () => {
    const run = await cli(['connections', 'test', 'nope'], context());
    expect(run.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', fix: expect.stringContaining('connections list') });
  });
});

describe('toil connections writes', () => {
  beforeEach(() => writeConfig({ version: 2, connections: { prod: { area: 'demo', token: 'keychain:prod.token' } } }));

  it('turns writes on only when the connection name is typed back', async () => {
    const wrong = terminal({ Writes: 'yes' });
    const refused = await cli(['connections', 'writes', 'prod', 'on'], context({ prompt: wrong.prompt }));
    expect(refused.envelope?.error?.code).toBe('CANCELLED');
    expect(readConfig().connections.prod.writes).toBeUndefined();
    expect(wrong.asked[0]!.question).toContain('Type prod');

    const right = await cli(['connections', 'writes', 'prod', 'on'], context({ prompt: terminal({ Writes: 'prod' }).prompt }));
    expect(right.envelope).toMatchObject({ ok: true, data: { name: 'prod', area: 'demo', writes: true, changed: true } });
    expect(readConfig().connections.prod.writes).toBe(true);
  });

  it('never turns writes on without a terminal, and the fix says how to do it by hand', async () => {
    const run = await cli(['connections', 'writes', 'prod', 'on'], context());
    expect(run.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', fix: expect.stringContaining('TOIL_CONN_PROD_WRITES=true') });
    expect(readConfig().connections.prod.writes).toBeUndefined();
  });

  it('turns writes off without asking, and reports no change when nothing changed', async () => {
    writeConfig({ version: 2, connections: { prod: { area: 'demo', token: 'keychain:prod.token', writes: true } } });
    const { prompt, asked } = terminal({});
    const off = await cli(['connections', 'writes', 'prod', 'off'], context({ prompt }));
    expect(off.envelope).toMatchObject({ ok: true, data: { writes: false, changed: true } });
    expect(asked).toEqual([]);
    expect(readConfig().connections.prod).toEqual({ area: 'demo', token: 'keychain:prod.token' });
    const again = await cli(['connections', 'writes', 'prod', 'off'], context({ prompt }));
    expect(again.envelope).toMatchObject({ ok: true, data: { writes: false, changed: false } });
  });

  it('warns when an env var decides writes instead of the file', async () => {
    const run = await cli(['connections', 'writes', 'prod', 'off'], context({ env: { TOIL_CONN_PROD_WRITES: 'true' } }));
    expect(run.envelope?.meta.warnings?.map((w) => w.code)).toContain('OVERRIDDEN_BY_ENV');
  });

  it('is never an MCP tool, and refuses anything but on or off', async () => {
    const def = commands.find((c) => c.path.join(' ') === 'connections writes')!;
    expect(def.kind).toBe('cli-only');
    const run = await cli(['connections', 'writes', 'prod', 'maybe'], context());
    expect(run.envelope?.error?.code).toBe('INVALID_INPUT');
  });
});

describe('toil connections default', () => {
  it("makes a connection its area's default, keeping the area's other shared settings", async () => {
    writeConfig({
      version: 2,
      connections: { a: { area: 'demo', token: 'keychain:a.token' }, b: { area: 'demo', token: 'keychain:b.token' } },
      defaults: { demo: { connection: 'a', pageSize: 5 } },
    });
    const run = await cli(['connections', 'default', 'b'], context());
    expect(run.envelope).toMatchObject({ ok: true, data: { name: 'b', area: 'demo', previous: 'a' } });
    expect(readConfig().defaults).toEqual({ demo: { connection: 'b', pageSize: 5 } });
  });

  it('refuses a connection that is not in the file', async () => {
    const run = await cli(['connections', 'default', 'nope'], context());
    expect(run.envelope?.error?.code).toBe('INVALID_INPUT');
  });
});

/**
 * The real terminal prompter over fake streams (#358): each step waits for a
 * question to appear, then types its chunks, one write per keypress or paste.
 */
function realTerminal(steps: Array<[string, string[]]>) {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  let seen = 0;
  output.on('data', (chunk: Buffer) => {
    shown += chunk.toString();
    const next = steps[0];
    if (!next) return;
    const at = shown.indexOf(next[0], seen);
    if (at < 0) return;
    seen = at + next[0].length;
    steps.shift();
    setImmediate(() => next[1].forEach((c) => input.write(c)));
  });
  return { prompt: terminalPrompter(input, output), shown: () => shown };
}
const PASTE = (text: string) => `\x1b[200~${text}\x1b[201~`;

describe('pasting a secret at a real terminal prompt (#358)', () => {
  it('shows bullets and the length, asks again after a refusal, removes a Bearer prefix on yes, and stores the exact token', async () => {
    const store = fakeStore();
    const t = realTerminal([
      ['baseUrl', ['https://jira.imagile.dev\r']],
      ['pageSize', ['\r']],
      ['token (Bearer token) (input hidden): ', ['\r']],
      ['required.\n', []],
      ['token (Bearer token) (input hidden): ', [PASTE(`${SECRET}\n${SECRET}`), '\r']],
      ['paste it again.\n', []],
      ['token (Bearer token) (input hidden): ', [PASTE(`Bearer ${SECRET}\n`), '\r']],
      ['[Y/n]: ', ['\r']],
      ['Save corp-demo', ['y\r']],
    ]);
    const run = await cli(['connections', 'add', 'corp-demo', '--area', 'demo'], context({ prompt: t.prompt, secrets: store }));
    expect(run.envelope).toMatchObject({ ok: true });
    expect(store.entries.get('corp-demo.token')).toBe(SECRET);
    const plain = t.shown().replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[@-~]`, 'g'), '');
    expect(plain).toContain('Nothing was entered, and this one is required.\n');
    expect(plain).toContain(`token (Bearer token) (input hidden): ${'\u2022'.repeat(39)}\r\nThis has a line break in the middle`);
    expect(plain).toContain(`${'\u2022'.repeat(27)}\r\nReceived 26 characters (removed a trailing newline).\nThis starts with "Bearer ". Store it without that? [Y/n]: `);
    expect(plain).toContain('Removed "Bearer ": 19 characters left.\n');
    expect(t.shown() + run.stdout + run.stderr).not.toContain('abc12345');
  });

  it('says it kept the existing secret on an empty answer to login', async () => {
    const store = fakeStore();
    await cli(['connections', 'add', 'corp-demo', '--area', 'demo'], context({ prompt: terminal({ token: SECRET }).prompt, secrets: store }));
    const t = realTerminal([['token (Bearer token) (input hidden): ', ['\r']]]);
    const run = await cli(['connections', 'login', 'corp-demo'], context({ prompt: t.prompt, secrets: store }));
    expect(t.shown()).toContain('Kept the existing secret.\n');
    expect(run.envelope).toMatchObject({ ok: false, error: { message: 'Nothing was entered, so nothing changed.' } });
    expect(store.entries.get('corp-demo.token')).toBe(SECRET);
  });
});

describe('toil connections migrate', () => {
  const cloud = { area: 'jira-cloud', baseUrl: 'https://imagile-cloud.imagile.dev', email: 'you@example.com', token: 'keychain:imagile-cloud.token' };

  it('saves a version 2 file as the current version with jira-cloud folded into jira, and reports names and keys only', async () => {
    writeConfig({ version: 2, connections: { 'imagile-cloud': cloud }, defaults: { 'jira-cloud': { connection: 'imagile-cloud', project: 'ABC' } }, theme: 'plain' });
    const run = await cli(['connections', 'migrate'], context());
    expect(run.envelope).toMatchObject({
      ok: true,
      data: {
        written: true,
        fromVersion: 2,
        toVersion: 4,
        folded: [{ connection: 'imagile-cloud', from: 'jira-cloud', to: 'jira', deployment: 'cloud' }],
        defaultsMoved: [{ from: 'jira-cloud', to: 'jira', keys: ['connection', 'project'] }],
        setAside: [],
      },
    });
    expect(readConfig()).toMatchObject({ version: 4, theme: 'plain', connections: { 'imagile-cloud': { area: 'jira', deployment: 'cloud', token: 'keychain:imagile-cloud.token' } } });
    expect(readConfig().defaults['jira-cloud']).toBeUndefined();
    // Nothing secret, and no value of any setting: the reference stays in the file, not in the output.
    expect(run.stdout).not.toContain('keychain:');
    expect(run.stdout).not.toContain('imagile-cloud.imagile.dev');
    expect(run.stdout).not.toContain('you@example.com');
  });

  it('reports the default it set aside when both areas named one', async () => {
    writeConfig({
      version: 2,
      connections: { 'corp-jira': { area: 'jira', baseUrl: 'https://jira.imagile.dev' }, 'imagile-cloud': cloud },
      defaults: { jira: { connection: 'corp-jira' }, 'jira-cloud': { connection: 'imagile-cloud' } },
    });
    const run = await cli(['connections', 'migrate'], context());
    expect(run.envelope).toMatchObject({ ok: true, data: { written: true, setAside: [{ area: 'jira', setAside: 'imagile-cloud', kept: 'corp-jira' }] } });
    expect(readConfig().defaults).toEqual({ jira: { connection: 'corp-jira' } });
    expect(readConfig().connections['imagile-cloud']).toMatchObject({ area: 'jira', deployment: 'cloud' });
  });

  it('leaves a current file untouched, byte for byte, and says so', async () => {
    const current = '{"version":4,"connections":{"corp-demo":{"area":"demo","token":"keychain:corp-demo.token"}},"defaults":{"demo":{"connection":"corp-demo"}}}';
    mkdirSync(join(home, '.toil'), { recursive: true });
    writeFileSync(file, current);
    const run = await cli(['connections', 'migrate'], context());
    expect(run.envelope).toMatchObject({ ok: true, data: { written: false, fromVersion: 4, toVersion: 4 } });
    expect((run.envelope?.data as { reason: string }).reason).toContain('nothing was written');
    expect(readFileSync(file, 'utf8')).toBe(current);
  });

  it('saves an old version with nothing retired in it as the current version', async () => {
    writeConfig({ version: 2, connections: { 'corp-demo': { area: 'demo', token: 'keychain:corp-demo.token' } }, defaults: { demo: { connection: 'corp-demo' } } });
    const run = await cli(['connections', 'migrate'], context());
    expect(run.envelope).toMatchObject({ ok: true, data: { written: true, fromVersion: 2, toVersion: 4, folded: [] } });
    expect(readConfig().version).toBe(4);
  });

  it('renames dossierPaths to projectPaths, in a version 4 file too, and says so by key name only', async () => {
    writeConfig({ version: 4, connections: {}, defaults: {}, dossierPaths: ['/shared/toil-projects'] });
    const run = await cli(['connections', 'migrate'], context());
    expect(run.envelope).toMatchObject({ ok: true, data: { written: true, fromVersion: 4, toVersion: 4, renamedKeys: [{ from: 'dossierPaths', to: 'projectPaths' }] } });
    expect(readConfig()).toEqual({ version: 4, connections: {}, defaults: {}, projectPaths: ['/shared/toil-projects'] });
    const again = await cli(['connections', 'migrate'], context());
    expect(again.envelope).toMatchObject({ ok: true, data: { written: false, renamedKeys: [] } });
  });

  it('writes nothing, and says so, when there is no config file', async () => {
    const run = await cli(['connections', 'migrate'], context());
    expect(run.envelope).toMatchObject({ ok: true, data: { written: false } });
    expect((run.envelope?.data as { reason: string }).reason).toContain('no config file');
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });
});

/** The agent's way in (#516): non-secret settings from flags, no terminal, no secret. */
describe('toil connections add --set', () => {
  it('saves the non-secret settings with no terminal and no store, names the secret still needed, and leaves writes off', async () => {
    const run = await cli(['connections', 'add', 'corp-demo', '--area', 'demo', '--set', 'baseUrl=https://jira.imagile.dev'], context());
    expect(run.envelope).toMatchObject({ ok: true, data: { name: 'corp-demo', area: 'demo', secrets: {}, secretNeeded: ['token'], writes: false } });
    expect(run.envelope?.meta.warnings).toEqual([expect.objectContaining({ code: 'SECRET_NEEDED', message: expect.stringContaining('toil connections login corp-demo') })]);
    expect(readConfig()).toMatchObject({
      connections: { 'corp-demo': { area: 'demo', baseUrl: 'https://jira.imagile.dev' } },
      defaults: { demo: { connection: 'corp-demo' } },
    });
    expect(readConfig().connections['corp-demo']).not.toHaveProperty('token');
    expect(readConfig().connections['corp-demo']).not.toHaveProperty('writes');
  });

  it('then connections test fails for the missing secret, saying how to enter it', async () => {
    await cli(['connections', 'add', 'svc', '--area', 'service', '--set', 'baseUrl=https://service.imagile.dev'], context());
    const run = await cli(['connections', 'test', 'svc'], context({ secrets: fakeStore() }));
    expect(run.envelope?.ok).toBe(false);
    expect(JSON.stringify(run.envelope?.error)).toContain('toil connections login svc');
  });

  it('refuses a secret key as a flag without saving or echoing it', async () => {
    const run = await cli(['connections', 'add', 'corp-demo', '--area', 'demo', '--set', `token=${SECRET}`], context());
    expect(run.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('token is a secret'), fix: expect.stringContaining('toil connections login corp-demo') });
    expect(run.stdout + run.stderr).not.toContain(SECRET);
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });

  it('needs --area, a key=value pair, a known key and a valid connection, and saves nothing otherwise', async () => {
    const bad = async (argv: string[]) => (await cli(['connections', 'add', 'corp-demo', ...argv], context())).envelope?.error;
    expect(await bad(['--set', 'baseUrl=https://x.imagile.dev'])).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('--set needs --area') });
    expect(await bad(['--area', 'demo', '--set', 'baseUrl'])).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('key=value') });
    expect(await bad(['--area', 'demo', '--set', 'nope=1'])).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('no setting named "nope"') });
    expect(await bad(['--area', 'demo', '--set', 'baseUrl=not a url'])).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('baseUrl') });
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });

  it('refuses a pairing key (tokenFrom): borrowing another connection\'s secret is moving one', async () => {
    writeConfig({ version: 3, connections: { 'corp-demo': { area: 'demo', token: 'keychain:corp-demo.token' } } });
    const run = await cli(['connections', 'add', 'ctx', '--area', 'demo-context', '--set', 'baseUrl=https://evil.imagile.dev', '--set', 'tokenFrom=corp-demo'], context());
    expect(run.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('tokenFrom borrows another connection') });
    expect(readConfig().connections).not.toHaveProperty('ctx');
  });

  it('refuses a name that is already taken, as the prompted flow does', async () => {
    await cli(['connections', 'add', 'corp-demo', '--area', 'demo', '--set', 'baseUrl=https://jira.imagile.dev'], context());
    const run = await cli(['connections', 'add', 'corp-demo', '--area', 'demo', '--set', 'baseUrl=https://other.imagile.dev'], context());
    expect(run.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('already a connection named') });
  });
});

/** Which secrets `add --set` says are still needed, against the real areas and their variants (#516 review). */
describe('toil connections add --set, secretNeeded', () => {
  const real = connectionsCommands(registryAreas);
  const run = (argv: string[], env: NodeJS.ProcessEnv = {}) =>
    runCli(['connections', 'add', ...argv], {
      commands: real,
      context: { ...context({ env }), config: loadConfig({ env, cwd: root, home, areas: registryAreas.map((a) => ({ name: a.name })) }) },
    });

  it('names nothing and warns of nothing for an engine that signs in with no secret (sqlite)', async () => {
    const out = await run(['lite', '--area', 'db', '--set', 'engine=sqlite', '--set', 'path=/tmp/x.db']);
    expect(out.envelope).toMatchObject({ ok: true, data: { secretNeeded: [], secretFromEnv: {} } });
    expect(out.envelope?.meta.warnings ?? []).toEqual([]);
  });

  it('lists no secret for postgres, whose password is optional, rather than guessing that this one signs in with it', async () => {
    const out = await run(['pg', '--area', 'db', '--set', 'engine=postgres', '--set', 'host=db.imagile.dev', '--set', 'database=app', '--set', 'user=app']);
    expect(out.envelope?.ok, out.stdout).toBe(true);
    expect((out.envelope?.data as { secretNeeded: string[] }).secretNeeded).toEqual([]);
    expect(out.envelope?.meta.warnings ?? []).toEqual([]);
  });

  it('names the API token for Jira Cloud, which also needs its email set', async () => {
    const out = await run(['cloud', '--area', 'jira', '--set', 'deployment=cloud', '--set', 'baseUrl=https://jira.imagile.dev', '--set', 'email=you@example.com']);
    expect(out.envelope).toMatchObject({ ok: true, data: { secretNeeded: ['apiToken'] } });
    const noEmail = await run(['cloud2', '--area', 'jira', '--set', 'deployment=cloud', '--set', 'baseUrl=https://jira.imagile.dev']);
    expect(noEmail.envelope?.error).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('does not say "no token yet" for a default connection whose env var already supplies it, and names the variable', async () => {
    const out = await run(['gh', '--area', 'github', '--set', 'baseUrl=https://api.imagile.dev'], { TOIL_GITHUB_TOKEN: 'set-in-env' });
    expect(out.envelope).toMatchObject({ ok: true, data: { secretNeeded: [], secretFromEnv: { token: 'TOIL_GITHUB_TOKEN' } } });
    expect(out.envelope?.meta.warnings ?? []).toEqual([]);
    expect(out.stdout).not.toContain('set-in-env');
  });

  it('counts a CI fallback only where the area takes it: SYSTEM_ACCESSTOKEN is no PAT for Azure DevOps Services', async () => {
    const services = await run(['adoc', '--area', 'ado', '--set', 'deployment=cloud', '--set', 'baseUrl=https://dev.azure.com/imagile'], { SYSTEM_ACCESSTOKEN: 'set-in-ci' });
    expect(services.envelope).toMatchObject({ ok: true, data: { secretNeeded: ['pat'], secretFromEnv: {} } });
    expect(services.envelope?.meta.warnings).toEqual([expect.objectContaining({ code: 'SECRET_NEEDED' })]);
    expect(services.stdout).not.toContain('set-in-ci');
  });

  it('counts it for Azure DevOps Server, and names the variable', async () => {
    const server = await run(['ados', '--area', 'ado', '--set', 'baseUrl=https://ado.imagile.dev'], { SYSTEM_ACCESSTOKEN: 'set-in-ci' });
    expect(server.envelope).toMatchObject({ ok: true, data: { secretNeeded: [], secretFromEnv: { pat: 'SYSTEM_ACCESSTOKEN' } } });
    expect(server.envelope?.meta.warnings ?? []).toEqual([]);
  });

  it('counts a TOIL_CONN_<NAME>_<KEY> variable for a connection that is not the default', async () => {
    await run(['first', '--area', 'github', '--set', 'baseUrl=https://api.imagile.dev']);
    const out = await run(['second', '--area', 'github', '--set', 'baseUrl=https://ghe.imagile.dev/api/v3'], { TOIL_CONN_SECOND_TOKEN: 'set-in-env' });
    expect(out.envelope).toMatchObject({ ok: true, data: { secretNeeded: [], secretFromEnv: { token: 'TOIL_CONN_SECOND_TOKEN' } } });
  });

  it('counts a credential the area default shares from another area\'s env, as a call would', async () => {
    const out = await run(['kib', '--area', 'kibana', '--set', 'baseUrl=https://kibana.imagile.dev'], { TOIL_ELASTICSEARCH_API_KEY: 'set-in-env' });
    expect(out.envelope).toMatchObject({ ok: true, data: { secretNeeded: [] } });
    expect(out.envelope?.meta.warnings ?? []).toEqual([]);
  });

  it('still names the token when the env var belongs to the area default, not this second connection', async () => {
    await run(['first', '--area', 'github', '--set', 'baseUrl=https://api.imagile.dev']);
    const out = await run(['second', '--area', 'github', '--set', 'baseUrl=https://ghe.imagile.dev/api/v3'], { TOIL_GITHUB_TOKEN: 'set-in-env' });
    expect(out.envelope).toMatchObject({ ok: true, data: { secretNeeded: ['token'] } });
  });
});
