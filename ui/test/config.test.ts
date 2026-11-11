// @vitest-environment node
import { Validator } from '@cfworker/json-schema';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { cookieHeader, letInto } from './let-in.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeStore } from '../../test/harness/fake-store.ts';
import { clearConnectionEnv } from '../../test/harness/hermetic-env.ts';
import { DEFAULT_TIMEOUT_MS as TOIL_DEFAULT_TIMEOUT_MS } from '../../src/core/run.ts';
import { areas as toilAreas } from '../../src/registry.ts';
import { STANDARD_SEARCH_FIELDS as CLOUD_STANDARD } from '../../src/areas/jira/cloud/client.ts';
import { STANDARD_SEARCH_FIELDS as SERVER_STANDARD } from '../../src/areas/jira/server/client.ts';
import { CONFIG_CHANGES, CONFIG_COMMANDS, CONFIG_READS, DEFAULT_TIMEOUT_MS, connectionEnvVar, type ConnectionRow } from '../src/config.ts';
import { guideStateOf } from '../src/guide.ts';
import { JIRA_STANDARD_FIELDS } from '../src/load.ts';
import { tokenStateOf } from '../src/setup.ts';
import { guideContext } from '../server/agents/guide.ts';
import { connectionEnvName } from '../../src/core/config.ts';
import { CONFIG_CANNED, FIXTURE_AREAS, FIXTURE_CONNECTIONS, PROBES } from '../src/fixtures/config.ts';
import { noAgent } from '../server/agent.ts';
import { areasFrom, personFrom, settingsFrom } from '../server/config.ts';
import { createUiServer, type UiServerOptions } from '../server/server.ts';
import { toilStore } from '../server/store.ts';

// toil's API builds its own credential store: here it is an in-memory one, so no test reaches the OS keychain.
const store = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('../../src/core/keychain.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/keychain.ts')>();
  // toil keeps the first store it makes for the process, so it gets one that always answers from this test's.
  return { ...real, createSecretStore: () => new Proxy({}, { get: (_target, key) => (store.current as Record<string | symbol, unknown>)[key] }) };
});
const { execute, registry } = await import('../../src/api.ts');

/**
 * The settings pages' path end to end (#253, item 4): the page's request to
 * `/api/config`, the server's allowlist and its Host, Origin and JSON checks, and
 * toil's own config commands run in-process from source (src/api.ts) against
 * a temp home, so the config file, the toil projects and the audit log are this
 * test's, never the user's. The credential store is the in-memory fake.
 * Every secret typed is swept for afterwards in every response, the audit
 * log, the config file and everything the process printed.
 */

const SECRET = 'fake-pat-abc12345-typed-once';
const SECOND = 'fake-pat-abc12345-typed-twice';

const app = mkdtempSync(join(tmpdir(), 'toil-ui-config-app-'));
writeFileSync(join(app, 'index.html'), '<!doctype html><div id="root"></div>');

let home: string;
let secrets: ReturnType<typeof fakeStore>;
const printed: string[] = [];
const replies: string[] = [];
let closeServer: (() => Promise<void>) | undefined;

beforeAll(() => {
  // Everything this process prints, so the sweep covers the server's own output too.
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      printed.push(String(chunk));
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write);
  }
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void printed.push(a.map(String).join(' ')));
});
afterAll(() => {
  vi.restoreAllMocks();
  rmSync(app, { recursive: true, force: true });
});

beforeEach(() => {
  // One canonical spelling (macOS's /private/var, no Windows 8.3 name), so the test's own paths match what toil reports.
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'toil-ui-config-home-')));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  // No TOIL_* or CI fallback var (GITHUB_TOKEN on a runner) may add a connection of its own.
  clearConnectionEnv(toilAreas);
  secrets = fakeStore();
  store.current = secrets;
});
afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

interface Reply {
  status: number;
  body: string;
}

function send(origin: string, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  const url = new URL(path, origin);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path: url.pathname, method: options.method ?? 'GET', headers: { host: url.host, ...cookieHeader(origin), ...options.headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => {
        replies.push(body);
        resolve({ status: res.statusCode!, body });
      });
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

/** The server on toil's own execute(), signed in, with a helper that sends one config call as the page does. */
async function serve(extra: Partial<UiServerOptions> = {}) {
  const ui = createUiServer({
    ...extra,
    settings: { host: '127.0.0.1', port: 0, basePath: '/', dataDir: join(home, '.toil-ui'), retentionDays: 30, sample: false },
    store: toilStore(execute),
    agent: noAgent(),
    appDir: app,
    version: '0.0.0-test',
    toil: { version: '0.0.0-test', contractVersion: 1 },
    config: { areas: areasFrom(registry), settings: settingsFrom(process.env) },
  });
  const { origin } = await ui.listen();
  await letInto(origin);
  closeServer = () => ui.close();
  const headers = { origin, 'content-type': 'application/json' };
  const config = async (command: string, input: Record<string, unknown> = {}, extra: { answers?: Record<string, string>; secrets?: Record<string, string> } = {}, over: Record<string, string> = {}) => {
    const res = await send(origin, '/api/config', { method: 'POST', body: JSON.stringify({ command, input, ...extra }), headers: { ...headers, ...over } });
    return { status: res.status, envelope: JSON.parse(res.body) };
  };
  const get = async (path: string) => JSON.parse((await send(origin, path)).body);
  return { origin, config, get, headers };
}

const configFile = () => join(home, '.toil', 'config.json');
const fileText = () => (existsSync(configFile()) ? readFileSync(configFile(), 'utf8') : '');
const audit = () => {
  const dir = join(home, '.toil', 'audit');
  if (!existsSync(dir)) return [] as Array<Record<string, unknown>>;
  return readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>));
};
const jiraAnswers = (baseUrl = 'https://jira.imagile.dev') => {
  const fields = registry.areas.find((a) => a.name === 'jira')!.connection.filter((f) => !f.secret);
  return { confirm: 'y', ...Object.fromEntries(fields.map((f) => [`setting:${f.name}`, f.name === 'baseUrl' ? baseUrl : ''])) };
};

/** An envelope assertion that prints toil's error, so a failure on CI says why. */
const expectEnvelope = (reply: { envelope: { error?: unknown } }) => expect(reply.envelope, `toil said: ${JSON.stringify(reply.envelope.error)}`);

/** No secret typed anywhere in the test turns up anywhere the test can see. */
function sweep() {
  const everywhere = [...replies, fileText(), JSON.stringify(audit()), printed.join('\n')].join('\n');
  for (const secret of [SECRET, SECOND]) expect(everywhere.includes(secret), `${secret} leaked`).toBe(false);
}

describe('the allowlist', () => {
  it('is exactly the config commands the pages need, each one toil has, the changes local writes only', () => {
    const served = new Map([...registry.commands, ...registry.personCommands].map((c) => [c.name, c]));
    expect([...CONFIG_COMMANDS].sort()).toEqual(
      ['audit list', 'audit stats', 'connections add', 'connections default', 'connections list', 'connections login', 'connections remove', 'connections test', 'connections writes', 'jira field discover', 'projects add-repo', 'projects analyze set', 'projects archive', 'projects check', 'projects describe', 'projects field', 'projects init', 'projects link', 'projects list', 'projects onboard', 'projects people save', 'projects person', 'projects show', 'projects unarchive', 'projects wip-limit', 'theme list', 'theme set'],
    );
    for (const name of CONFIG_READS) expect(served.get(name), name).toMatchObject({ writes: false, writesLocal: false, writesDependOnInput: false });
    // A change writes only toil's own config on this machine, never a service.
    // projects onboard writes only when it adds or pins a connection; its plan writes nothing, and asks nothing.
    for (const name of CONFIG_CHANGES) expect(served.get(name), name).toMatchObject(name === 'projects onboard' ? { writes: false, writesLocal: false, writesDependOnInput: true } : { writes: false, writesLocal: true });
  });

  it("runs Set up this repo's plan as a person's command, which asks nothing and writes nothing", async () => {
    mkdirSync(join(home, '.toil', 'projects'), { recursive: true });
    writeFileSync(join(home, '.toil', 'projects', 'team.json'), JSON.stringify({ name: 'team', github: { host: 'github.com' } }));
    const { config } = await serve();
    const { status, envelope } = await config('projects onboard', { toilProject: 'team', plan: true });
    expect(status).toBe(200);
    expectEnvelope({ envelope }).toMatchObject({ ok: true, data: { plan: true, ok: false, areas: [{ area: 'github', status: 'missing', suggest: { name: 'github', baseUrl: 'https://api.github.com' } }] } });
    expect(existsSync(configFile())).toBe(false);
    expect(audit().map((l) => [l.command, l.caller])).toEqual([['projects onboard', 'toil-ui']]);
  });

  it("refuses a tracker write and every other command before toil sees it, so the audit log has no line for it", async () => {
    const { config } = await serve();
    for (const command of ['jira issue create', 'jira issue transition', 'github issue create', 'connections import', 'projects remove', 'setup alias']) {
      const { status, envelope } = await config(command, { project: 'PAY', summary: 'x', allowWrite: true });
      expect(status, command).toBe(403);
      expect(envelope).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
    expect(audit()).toEqual([]);
  });

  it('refuses a config call from another Origin, from a form post, or under another Host, before anything is saved', async () => {
    const { config } = await serve();
    const body = { name: 'corp-jira', area: 'jira' };
    const extra = { answers: jiraAnswers(), secrets: { apiToken: SECRET } };
    expect((await config('connections add', body, extra, { origin: 'http://evil.imagile.dev' })).status).toBe(403);
    expect((await config('connections add', body, extra, { origin: 'null' })).status).toBe(403);
    expect((await config('connections add', body, extra, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await config('connections add', body, extra, { host: 'rebind.imagile.dev' })).status).toBe(403);
    expect(fileText()).toBe('');
    expect(secrets.entries.size).toBe(0);
    expect(audit()).toEqual([]);
    sweep();
  });

  it('refuses answers that are not text', async () => {
    const { config } = await serve();
    const { status, envelope } = await config('connections add', { name: 'x', area: 'jira' }, { secrets: { apiToken: 42 } as unknown as Record<string, string> });
    expect(status).toBe(400);
    expect(envelope.error.message).toBe("The call's secrets must be an object of text values.");
  });
});

describe('connections, through toil', () => {
  it('adds, lists, tests, defaults, turns writes on and off, replaces the secret and removes, the secret never coming back', async () => {
    const { config } = await serve();
    const added = await config('connections add', { name: 'corp-jira', area: 'jira' }, { answers: jiraAnswers(), secrets: { apiToken: SECRET } });
    expect(added).toMatchObject({ status: 200, envelope: { ok: true, data: { name: 'corp-jira', area: 'jira', secrets: { apiToken: 'store' } } } });
    expect(secrets.entries.get('corp-jira.apiToken')).toBe(SECRET);
    expect(JSON.parse(fileText()).connections['corp-jira']).toEqual({ area: 'jira', baseUrl: 'https://jira.imagile.dev', apiToken: 'keychain:corp-jira.apiToken' });
    await config('connections add', { name: 'other-jira', area: 'jira' }, { answers: jiraAnswers('https://jira2.imagile.dev'), secrets: { apiToken: SECOND } });

    const listed = await config('connections list');
    expect(listed.envelope.data.connections.map((c: { name: string; isDefault: boolean; definedIn: string }) => [c.name, c.isDefault, c.definedIn])).toEqual([
      ['corp-jira', true, 'file'],
      ['other-jira', false, 'file'],
    ]);

    // The area's one cheap authenticated read, with the stored secret, through a stubbed fetch.
    const sent: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      sent.push({ url: req.url, auth: req.headers.get('authorization') });
      return new Response(JSON.stringify({ name: 'you' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const tested = await config('connections test', { name: 'corp-jira' });
    expect(tested.envelope).toMatchObject({ ok: true, data: { live: true, authenticated: true, request: 'GET /rest/api/2/myself' } });
    expect(sent).toEqual([{ url: 'https://jira.imagile.dev/rest/api/2/myself', auth: `Bearer ${SECRET}` }]);

    expectEnvelope(await config('connections default', { name: 'other-jira' }, { answers: {} })).toMatchObject({ ok: true, data: { previous: 'corp-jira' } });

    // Writes on: the typed name is the command's own gate. A mismatch changes nothing.
    const mistyped = await config('connections writes', { name: 'corp-jira', state: 'on' }, { answers: { 'confirm-name': 'corp-jria' } });
    expect(mistyped.envelope).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    const unanswered = await config('connections writes', { name: 'corp-jira', state: 'on' });
    expect(unanswered.envelope).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    // A secret is never the answer to a visible question, even under its id.
    const smuggled = await config('connections writes', { name: 'corp-jira', state: 'on' }, { secrets: { 'confirm-name': 'corp-jira' } });
    expect(smuggled.envelope).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(JSON.parse(fileText()).connections['corp-jira'].writes).toBeUndefined();
    expectEnvelope(await config('connections writes', { name: 'corp-jira', state: 'on' }, { answers: { 'confirm-name': 'corp-jira' } })).toMatchObject({ ok: true, data: { writes: true, changed: true } });
    expect(JSON.parse(fileText()).connections['corp-jira'].writes).toBe(true);
    expectEnvelope(await config('connections writes', { name: 'corp-jira', state: 'off' })).toMatchObject({ ok: true, data: { writes: false } });

    const login = await config('connections login', { name: 'corp-jira' }, { secrets: { apiToken: SECOND } });
    expect(login.envelope).toMatchObject({ ok: true, data: { secrets: { apiToken: 'store' } } });
    expect(secrets.entries.get('corp-jira.apiToken')).toBe(SECOND);

    expectEnvelope(await config('connections remove', { name: 'other-jira' })).toMatchObject({ ok: true, data: { deletedFromStore: ['other-jira.apiToken'] } });
    expect(Object.keys(JSON.parse(fileText()).connections)).toEqual(['corp-jira']);

    // Every call is in toil's audit log as Toil UI's, through the API.
    const lines = audit();
    expect(new Set(lines.map((l) => `${l.via} ${l.caller}`))).toEqual(new Set(['api toil-ui']));
    expect(lines.map((l) => l.command)).toEqual([
      'connections add', 'connections add', 'connections list', 'connections test', 'connections default',
      'connections writes', 'connections writes', 'connections writes', 'connections writes', 'connections writes', 'connections login', 'connections remove',
    ]);
    sweep();
  });

  it("saves a connection whose optional secret was left blank (''), storing nothing for it, as the CLI does", async () => {
    const { config } = await serve();
    const fields = registry.areas.find((a) => a.name === 'openshift')!.connection;
    expect(fields.find((f) => f.name === 'token')).toMatchObject({ secret: true, required: false });
    const answers = { confirm: 'y', ...Object.fromEntries(fields.filter((f) => !f.secret).map((f) => [`setting:${f.name}`, f.name === 'baseUrl' ? 'https://openshift.imagile.dev' : ''])) };
    const added = await config('connections add', { name: 'ocp-lab', area: 'openshift' }, { answers, secrets: { token: '' } });
    expect(added.envelope).toMatchObject({ ok: true, data: { name: 'ocp-lab', area: 'openshift', secrets: {} } });
    expect(JSON.parse(fileText()).connections['ocp-lab']).toEqual({ area: 'openshift', baseUrl: 'https://openshift.imagile.dev' });
    expect(secrets.entries.size).toBe(0);
  });

  it('shows a connection made by env vars alone as such, and toil refuses to change it', async () => {
    vi.stubEnv('TOIL_CONN_CI_JIRA_AREA', 'jira');
    vi.stubEnv('TOIL_CONN_CI_JIRA_BASE_URL', 'https://jira.imagile.dev');
    vi.stubEnv('TOIL_CONN_CI_JIRA_API_TOKEN', SECRET);
    const { config } = await serve();
    const listed = await config('connections list');
    expect(listed.envelope.data.connections).toEqual([expect.objectContaining({ name: 'ci-jira', definedIn: 'env', values: { baseUrl: 'env', apiToken: 'env' } })]);
    for (const [command, input] of [['connections default', { name: 'ci-jira' }], ['connections remove', { name: 'ci-jira' }], ['connections writes', { name: 'ci-jira', state: 'off' }]] as const) {
      const { envelope } = await config(command, input);
      expect(envelope, command).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: 'Connection "ci-jira" is defined by env vars, not your config file, so there\'s nothing here to change.' } });
    }
    sweep();
  });
});

describe('Toil projects, through toil', () => {
  it('creates one, adds a repo, links an area, names a field, and lists, shows and checks it', async () => {
    const { config } = await serve();
    await config('connections add', { name: 'corp-jira', area: 'jira' }, { answers: jiraAnswers(), secrets: { apiToken: SECRET } });
    expectEnvelope(await config('projects init', { name: 'payments', description: 'Payments platform' })).toMatchObject({ ok: true, data: { name: 'payments', source: 'user' } });
    expectEnvelope(await config('projects add-repo', { toilProject: 'payments', location: 'https://git.imagile.dev/pay/payments-api.git' })).toMatchObject({ ok: true, data: { repo: { name: 'payments-api' } } });
    expectEnvelope(await config('projects link', { toilProject: 'payments', area: 'jira', connection: 'corp-jira', set: ['project=PAY'], add: ['projects=FEES'] })).toMatchObject({ ok: true });
    expectEnvelope(await config('projects field', { toilProject: 'payments', area: 'jira', alias: 'storyPoints', id: 'customfield_10002' })).toMatchObject({ ok: true, data: { fields: { storyPoints: 'customfield_10002' } } });
    const file = JSON.parse(readFileSync(join(home, '.toil', 'projects', 'payments.json'), 'utf8'));
    expect(file).toMatchObject({ name: 'payments', jira: { connection: 'corp-jira', project: 'PAY', projects: ['FEES'], fields: { storyPoints: 'customfield_10002' } } });

    expect((await config('projects list')).envelope.data.toilProjects.map((d: { name: string }) => d.name)).toEqual(['payments']);
    expectEnvelope(await config('projects show', { toilProject: 'payments' })).toMatchObject({ ok: true, data: { areas: { jira: { connection: { value: 'corp-jira' }, writes: false, inputs: { project: 'PAY' } } } } });
    expectEnvelope(await config('projects check', { toilProject: 'payments' })).toMatchObject({ ok: true, data: { ok: true } });
    sweep();
  });

  it("sets the theme as toil's own setting, which the welcome menu reads too, and reads it back (#427)", async () => {
    const { config } = await serve();
    expectEnvelope(await config('theme list')).toMatchObject({ ok: true, data: { current: 'crate', source: 'default', default: 'crate' } });
    expectEnvelope(await config('theme set', { name: 'realm' })).toMatchObject({ ok: true, data: { theme: 'realm', changed: true } });
    expect(JSON.parse(readFileSync(join(home, '.toil', 'config.json'), 'utf8'))).toMatchObject({ version: 4, theme: 'realm' });
    expectEnvelope(await config('theme list')).toMatchObject({ ok: true, data: { current: 'realm', source: 'file' } });
    expectEnvelope(await config('theme set', { name: 'vaporwave' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('maps people and sets the limit, and leaves removing either to the CLI', async () => {
    const { config } = await serve();
    await config('projects init', { name: 'payments' });
    expectEnvelope(await config('projects person', { toilProject: 'payments', name: 'Pat Example', id: ['jira=pat', 'github=pat-ex'], email: 'you@example.com' })).toMatchObject({ ok: true, data: { person: { name: 'Pat Example', ids: { jira: 'pat', github: 'pat-ex' } } } });
    expectEnvelope(await config('projects person', { toilProject: 'payments', name: 'Claude', kind: 'agent' })).toMatchObject({ ok: true });
    expectEnvelope(await config('projects wip-limit', { toilProject: 'payments', limit: 3 })).toMatchObject({ ok: true, data: { wipLimit: 3 } });
    expectEnvelope(await config('projects show', { toilProject: 'payments' })).toMatchObject({ ok: true, data: { toilProject: { people: [{ name: 'Pat Example' }, { name: 'Claude', kind: 'agent' }], wipLimit: 3 } } });
    // A removal is a delete: the API is held to MCP's rules, so the page can't make one.
    expectEnvelope(await config('projects person', { toilProject: 'payments', name: 'Claude', remove: true })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', fix: 'Only a person can make this call, on the CLI with toil projects person.' } });
    expectEnvelope(await config('projects wip-limit', { toilProject: 'payments', clear: true })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(JSON.parse(readFileSync(join(home, '.toil', 'projects', 'payments.json'), 'utf8'))).toMatchObject({ people: [{ name: 'Pat Example' }, { name: 'Claude' }], wipLimit: 3 });
    sweep();
  });

  it("maps one person across sources and saves the people into a repository's .toil/projects, never a secret (#561)", async () => {
    const { config } = await serve();
    await config('projects init', { name: 'payments' });
    expectEnvelope(await config('projects person', { toilProject: 'payments', name: 'Pat Example', github: 'pat-ex', jira: 'pat', ado: 'you@example.com', bitbucket: 'pexample' })).toMatchObject({ ok: true, data: { person: { ids: { github: 'pat-ex', jira: 'pat', ado: 'you@example.com', bitbucket: 'pexample' } } } });
    const repo = join(home, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const saved = await config('projects people save', { toilProject: 'payments', repo });
    expectEnvelope(saved).toMatchObject({ ok: true, data: { created: true, added: ['Pat Example'] } });
    expect(JSON.parse(readFileSync(join(repo, '.toil', 'projects', 'payments.json'), 'utf8'))).toMatchObject({ name: 'payments', people: [{ name: 'Pat Example', ids: { github: 'pat-ex' } }] });
    sweep();
  });

  it("refuses, from the page as over MCP, a link to a connection with writes on: that one is a person's, on the CLI", async () => {
    const { config } = await serve();
    await config('connections add', { name: 'corp-jira', area: 'jira' }, { answers: jiraAnswers(), secrets: { apiToken: SECRET } });
    await config('connections add', { name: 'admin-jira', area: 'jira' }, { answers: jiraAnswers('https://jira2.imagile.dev'), secrets: { apiToken: SECOND } });
    await config('connections writes', { name: 'admin-jira', state: 'on' }, { answers: { 'confirm-name': 'admin-jira' } });
    await config('projects init', { name: 'payments' });
    const linked = await config('projects link', { toilProject: 'payments', area: 'jira', connection: 'admin-jira' });
    expectEnvelope(linked).toMatchObject({ ok: false, error: { code: 'WRITE_DISABLED' } });
    expect(JSON.parse(readFileSync(join(home, '.toil', 'projects', 'payments.json'), 'utf8')).jira).toBeUndefined();
  });

  it('runs the reads read-only: a change named as a read is still refused by toil', async () => {
    const { config } = await serve();
    // The page's reads go read-only even on the config path; a projects init can't hide behind one.
    const readOnly = await execute('projects init', { name: 'x' }, { readOnly: true, caller: 'toil-ui' });
    expect(readOnly).toMatchObject({ ok: false, error: { code: 'WRITE_DISABLED' } });
    expectEnvelope(await config('projects list')).toMatchObject({ ok: true });
  });
});

describe('the pages beside the commands', () => {
  it("serves the areas' connection fields and the time limit the server's toil runs with", async () => {
    vi.stubEnv('TOIL_TIMEOUT_MS', '300000');
    const { get } = await serve();
    const areas = await get('/api/config/areas');
    expect(areas.find((a: { name: string }) => a.name === 'jira').connection[0]).toMatchObject({ name: 'baseUrl', required: true });
    expect(await get('/api/config/settings')).toEqual({ timeout: { variable: 'TOIL_TIMEOUT_MS', value: '300000', effectiveMs: 300000, defaultMs: 120000 } });
    expect(settingsFrom({}).timeout).toMatchObject({ value: null, effectiveMs: 120000 });
    expect(settingsFrom({ TOIL_TIMEOUT_MS: 'soon' }).timeout).toMatchObject({ value: 'soon', effectiveMs: 120000 });
    expect(DEFAULT_TIMEOUT_MS).toBe(TOIL_DEFAULT_TIMEOUT_MS);
  });

  it('answers a question only by its id, and a hidden one only from the secrets', async () => {
    const person = personFrom({ answers: { 'setting:baseUrl': 'https://jira.imagile.dev', 'secret:apiToken': 'not-this' }, secrets: { apiToken: SECRET, baseUrl: 'nor-this' } });
    expect(await person.ask({ id: 'setting:baseUrl', text: 'baseUrl', secret: false, fallback: null })).toBe('https://jira.imagile.dev');
    expect(await person.ask({ id: 'secret:apiToken', text: 'apiToken', secret: true, fallback: null })).toBe(SECRET);
    expect(await person.ask({ id: 'confirm', text: 'Save?', secret: false, fallback: 'y' })).toBeUndefined();
    expect(await person.ask({ id: 'toString', text: 'x', secret: false, fallback: null })).toBeUndefined();
  });
});

describe("the preview's sample config", () => {
  const served = new Map([...registry.commands, ...registry.personCommands].map((c) => [c.name, c]));

  it("names only real commands in the Usage page's sample month", () => {
    const names = new Set(registry.commands.map((c) => c.name).concat(registry.personCommands.map((c) => c.name)));
    const usage = CONFIG_CANNED.filter((c) => c.command === 'audit stats').flatMap((c) => {
      const d = c.data as { groups: Array<{ command?: string | null }>; unused?: Array<{ command: string }> };
      return [...d.groups.flatMap((g) => (g.command ? [g.command] : [])), ...(d.unused ?? []).map((u) => u.command)];
    });
    expect(usage.length).toBeGreaterThan(0);
    for (const name of usage) expect(names, name).toContain(name);
  });

  it.each(CONFIG_CANNED.map((c) => [`${c.command} ${JSON.stringify(c.input)}`, c] as const))("%s is a config read whose input validates against toil's schema", (_label, call) => {
    // projects onboard's plan, with no pin, asks nothing and changes nothing: the preview answers it like a read.
    if (call.command === 'projects onboard') expect(call.input).toEqual({ plan: true });
    else expect(CONFIG_READS as readonly string[]).toContain(call.command);
    const def = served.get(call.command)!;
    const result = new Validator(def.inputSchema as object, '2020-12', false).validate(call.input);
    expect(result.errors.map((e) => `${e.instanceLocation} ${e.error}`)).toEqual([]);
  });

  it("holds the areas' connection fields to toil's registry", () => {
    for (const area of FIXTURE_AREAS) expect(area, area.name).toEqual(registry.areas.find((a) => a.name === area.name));
  });

  it("holds each connection's live check to its area's own probe", () => {
    const conn = { baseUrl: 'https://x.imagile.dev', collection: 'DefaultCollection' };
    for (const c of FIXTURE_CONNECTIONS.connections) {
      const area = toilAreas.find((a) => a.name === c.area)!;
      const probe = area.probe?.(conn as never);
      expect(PROBES[c.area], c.area).toBe(`GET ${probe?.path}`);
      for (const key of Object.keys(c.values)) expect(registry.areas.find((a) => a.name === c.area)!.connection.map((f) => f.name).concat('writes'), `${c.name}.${key}`).toContain(key);
    }
  });
});

// Every test's home is a temp folder: a guard against one ever pointing at the real ~/.toil.
it('runs in a temp home, never the real ~/.toil', () => {
  expect(home.startsWith(realpathSync.native(tmpdir()))).toBe(true);
  expect(process.env.HOME).toBe(home);
});

describe("a Toil project's name and description, from its card or dashboard (#342)", () => {
  it("describes and renames through toil projects describe, then moves Toil UI's own records, labelled toil-ui in the audit log", async () => {
    const moved: Array<[string, string]> = [];
    let holds = 0;
    let released = 0;
    const { config } = await serve({ renames: { hold: () => (holds++, () => void released++), blocked: () => null, moved: async (from, to) => (moved.push([from, to]), []) } });
    expectEnvelope(await config('projects init', { name: 'scratch' })).toMatchObject({ ok: true });
    expectEnvelope(await config('projects describe', { toilProject: 'scratch', description: 'A scratch Toil project' })).toMatchObject({ ok: true, data: { renamed: null, description: 'A scratch Toil project' } });
    expect(moved).toEqual([]);
    const renamed = await config('projects describe', { toilProject: 'scratch', name: 'scratch-two' });
    expectEnvelope(renamed).toMatchObject({ ok: true, data: { name: 'scratch-two', renamed: { from: 'scratch', to: 'scratch-two' } } });
    expect(moved).toEqual([['scratch', 'scratch-two']]);
    expect(existsSync(join(home, '.toil', 'projects', 'scratch.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, '.toil', 'projects', 'scratch-two.json'), 'utf8'))).toMatchObject({ name: 'scratch-two', description: 'A scratch Toil project' });
    expect(audit().filter((l) => l.command === 'projects describe').map((l) => l.caller)).toEqual(['toil-ui', 'toil-ui']);
    // Syncs were held for the rename only, and let go after it.
    expect([holds, released]).toEqual([1, 1]);
    // A rename names the toil project as Toil UI keeps it, by name, never a path.
    const byPath = await config('projects describe', { toilProject: join(home, '.toil', 'projects', 'scratch-two.json'), name: 'scratch-three' });
    expect(byPath.status).toBe(400);
    expect(byPath.envelope.error.message).toBe('Toil UI renames a Toil project by its name, not a path to its file.');
  });

  it('refuses a rename while a sync or an assignment of it runs, before toil sees it, and says what Toil UI could not move', async () => {
    const { config } = await serve({ renames: { hold: () => () => undefined, blocked: (d) => (d === 'busy' ? { message: "A sync is running, so busy can't be renamed until it ends.", fix: 'Wait for it.' } : null), moved: async () => ["Toil UI couldn't move its cache."] } });
    await config('projects init', { name: 'busy' });
    await config('projects init', { name: 'idle' });
    const refused = await config('projects describe', { toilProject: 'busy', name: 'busy-two' });
    expect(refused.status).toBe(409);
    expect(refused.envelope).toMatchObject({ ok: false, error: { code: 'CONFLICT', fix: 'Wait for it.' } });
    expect(existsSync(join(home, '.toil', 'projects', 'busy.json'))).toBe(true);
    // A description alone isn't a rename, so it goes ahead.
    expectEnvelope(await config('projects describe', { toilProject: 'busy', description: 'Still busy' })).toMatchObject({ ok: true });
    const warned = await config('projects describe', { toilProject: 'idle', name: 'idle-two' });
    expectEnvelope(warned).toMatchObject({ ok: true });
    expect(warned.envelope.meta.warnings).toContainEqual({ code: 'TOIL_UI_RENAME', message: "Toil UI couldn't move its cache." });
  });
});

describe('connectionEnvVar', () => {
  it("spells a connection key's env var as toil does, for the fix on an empty required secret (#358)", () => {
    for (const [name, key] of [['corp-jira', 'apiToken'], ['ocp-lab', 'token'], ['db-1', 'baseURL'], ['x', 'apiKey2']] as const) {
      expect(connectionEnvVar(name, key)).toBe(connectionEnvName(name, key));
    }
  });
});

describe('what Toil UI reads from toil for the setup fixes (#573)', () => {
  const areas = areasFrom(registry);
  const row = (area: string, values: Record<string, string>): ConnectionRow => ({ name: 'local-db', area, isDefault: true, host: null, writes: false, values: values as ConnectionRow['values'] });

  it('holds the standard Jira search fields to what toil searches without a list, on both deployments', () => {
    expect(CLOUD_STANDARD).toEqual(SERVER_STANDARD);
    expect([...JIRA_STANDARD_FIELDS].sort()).toEqual([...CLOUD_STANDARD].sort());
  });

  it('says a SQLite connection needs no secret, and an engine that signs in still does', () => {
    const db = areas.find((a) => a.name === 'db')!;
    expect(tokenStateOf(db, row('db', { engine: 'file', path: 'file' }))).toBe('none');
    expect(tokenStateOf(db, row('db', { engine: 'file', host: 'file', database: 'file', user: 'file' }))).toBe('missing');
    expect(tokenStateOf(db, row('db', { engine: 'file', host: 'file', database: 'file', user: 'file', password: 'store' }))).toBe('saved');
    expect(tokenStateOf(db, row('db', { engine: 'file', baseUrl: 'file', system: 'file', token: 'store' }))).toBe('saved');
    expect(tokenStateOf(areas.find((a) => a.name === 'jira')!, row('jira', { baseUrl: 'file' }))).toBe('missing');
  });

  it('tells the setup guide no sign-in is needed, never that a password is missing', () => {
    const state = guideStateOf({ step: 'connect', areas: ['db'], area: 'db' });
    const context = guideContext(state, [row('db', { engine: 'file', path: 'file' })], areas);
    expect(context).toContain('local-db: Database');
    expect(context).toContain('token not needed');
    expect(context).not.toContain('token missing');
  });
});
