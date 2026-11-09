import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutePerson, Question } from '../src/api.js';
import { areas } from '../src/registry.js';
import { clearConnectionEnv, connectionEnvVars } from './harness/hermetic-env.js';
import { sharedStore } from './harness/shared-store.js';

// The API builds its own credential store; here it is the in-memory one, so no test reaches the OS keychain.
vi.mock('../src/core/keychain.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/keychain.js')>()),
  createSecretStore: () => sharedStore,
}));

const { execute, registry } = await import('../src/api.js');

/**
 * `execute()` with a `person` (src/api.ts): a host such as Toil UI asks the
 * person toil's own questions in its interface and passes on the answers, so
 * the connections commands run without a terminal. Each test has its own
 * home, so the config file, the toil projects and the audit log are the test's.
 */

const SECRET = 'fake-pat-abc12345-never-shown';
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'toil-api-person-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  // No TOIL_* or CI fallback var (GITHUB_TOKEN on a runner) may add a connection of its own.
  clearConnectionEnv(areas);
  sharedStore.entries.clear();
  sharedStore.log.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

/** A person who answers by question id, leaving any other setting blank, and the questions they were asked. */
function person(answers: Record<string, string>): ExecutePerson & { asked: Question[] } {
  const asked: Question[] = [];
  return {
    asked,
    ask: (q) => {
      asked.push(q);
      return answers[q.id] ?? (q.id.startsWith('setting:') ? '' : undefined);
    },
  };
}

const config = () => JSON.parse(readFileSync(join(home, '.toil', 'config.json'), 'utf8')) as { connections: Record<string, Record<string, unknown>>; defaults: Record<string, Record<string, unknown>> };
const auditText = () => {
  const dir = join(home, '.toil', 'audit');
  return readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('');
};
const jira = { 'setting:baseUrl': 'https://jira.imagile.dev', 'secret:apiToken': SECRET, confirm: 'y' };

it("clears every area's CI fallback, as the registry declares them, so a runner's GITHUB_TOKEN can't add a connection", () => {
  expect(connectionEnvVars(areas, {})).toEqual(expect.arrayContaining(['GITHUB_TOKEN', 'SYSTEM_ACCESSTOKEN']));
  expect(process.env.GITHUB_TOKEN).toBeUndefined();
});

describe('the registry', () => {
  it("lists the person's commands apart from what execute() serves without one", () => {
    expect(registry.personCommands.map((c) => c.name).sort()).toEqual(['connections add', 'connections default', 'connections login', 'connections remove', 'connections writes', 'feedback', 'projects onboard']);
    expect(registry.commands.map((c) => c.name)).not.toContain('connections add');
    expect(registry.personCommands.find((c) => c.name === 'connections writes')).toMatchObject({ kind: 'cli-only', writes: false, writesLocal: true });
  });

  it("says what a connection to each area holds, in the order connections add asks", () => {
    const fields = registry.areas.find((a) => a.name === 'jira')!.connection;
    expect(fields[0]).toMatchObject({ name: 'baseUrl', description: 'Jira root: the Data Center server (https://jira.imagile.dev), or the Cloud site (https://<your-site>.atlassian.net)', secret: false, password: false, default: null, required: true });
    // Cloud or Data Center is a radio the person must choose, and the address is made from it; the email is Cloud's.
    expect(fields.find((f) => f.name === 'deployment')!.choices).toMatchObject({ required: true, options: [{ label: 'Cloud', value: 'cloud' }, { label: 'Data Center', value: 'server' }] });
    expect(fields[0]!.choices!.options.map((o) => o.when)).toEqual([{ deployment: 'cloud' }, { deployment: 'server' }]);
    expect(fields.find((f) => f.name === 'email')).toMatchObject({ appliesTo: ['cloud'], requiredFor: ['cloud'] });
    expect(registry.areas.find((a) => a.name === 'jira')!.variantBy).toBe('deployment');
    expect(fields.at(-1)).toMatchObject({ name: 'apiToken', secret: true, password: false, required: true });
    expect(fields.find((f) => f.name === 'project')).toMatchObject({ secret: false, required: false });
  });
});

describe('execute() with a person', () => {
  it("refuses a person's command without one, saying what it needs", async () => {
    const refused = await execute('connections add', { name: 'corp-jira', area: 'jira' });
    expect(refused).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: "connections add is a person's command: execute() runs it only with a person to answer its questions." } });
    expect(await execute('setup alias', {}, { person: person({}) })).toMatchObject({ ok: false, error: { message: "setup alias isn't served through the API: it's a person's command, on the CLI." } });
    expect(await execute('connections add', { name: 'x' }, { person: {} as ExecutePerson })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: 'person must be an object with an ask(question) function.' } });
  });

  it('adds a connection: the questions by id, the secret to the store only, and the audit line naming the caller', async () => {
    const p = person(jira);
    const added = await execute('connections add', { name: 'corp-jira', area: 'jira' }, { person: p, caller: 'toil-ui' });
    expect(added).toMatchObject({ ok: true, data: { name: 'corp-jira', area: 'jira', secrets: { apiToken: 'store' } } });
    expect(p.asked.map((q) => q.id)).toEqual(['setting:baseUrl', 'setting:deployment', 'setting:email', 'setting:customFields', 'setting:project', 'setting:issueType', 'setting:priority', 'secret:apiToken', 'confirm']);
    expect(p.asked.find((q) => q.id === 'secret:apiToken')).toMatchObject({ secret: true, fallback: null });
    expect(p.asked.find((q) => q.id === 'confirm')).toMatchObject({ secret: false, fallback: 'y' });
    expect(sharedStore.entries.get('corp-jira.apiToken')).toBe(SECRET);
    expect(config().connections['corp-jira']).toEqual({ area: 'jira', baseUrl: 'https://jira.imagile.dev', apiToken: 'keychain:corp-jira.apiToken' });
    expect(config().defaults.jira).toEqual({ connection: 'corp-jira' });
    expect(JSON.stringify(added)).not.toContain(SECRET);
    expect(auditText()).not.toContain(SECRET);
    expect(JSON.parse(auditText().trim())).toMatchObject({ via: 'api', caller: 'toil-ui', command: 'connections add', outcome: 'ok' });
  });

  it("saves nothing when the person says no, or isn't asked a question the command needs", async () => {
    expect(await execute('connections add', { name: 'corp-jira', area: 'jira' }, { person: person({ ...jira, confirm: 'n' }) })).toMatchObject({ ok: false, error: { code: 'CANCELLED', message: 'Nothing was saved.' } });
    const unanswered = await execute('connections add', { name: 'corp-jira', area: 'jira' }, { person: person({ 'setting:baseUrl': 'https://jira.imagile.dev', 'secret:apiToken': SECRET }) });
    expect(unanswered).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(!unanswered.ok && unanswered.error.message).toMatch(/^Nothing was saved: "Save corp-jira .*" wasn't answered\.$/);
    expect(JSON.stringify(unanswered)).not.toContain(SECRET);
    expect(sharedStore.entries.size).toBe(0);
  });

  it('replaces a secret with login, turns writes on only for the typed name, sets the default and removes', async () => {
    await execute('connections add', { name: 'corp-jira', area: 'jira' }, { person: person(jira) });
    await execute('connections add', { name: 'other-jira', area: 'jira' }, { person: person({ ...jira, 'setting:baseUrl': 'https://jira2.imagile.dev' }) });

    const login = await execute('connections login', { name: 'corp-jira' }, { person: person({ 'secret:apiToken': `${SECRET}-2` }) });
    expect(login).toMatchObject({ ok: true, data: { secrets: { apiToken: 'store' } } });
    expect(sharedStore.entries.get('corp-jira.apiToken')).toBe(`${SECRET}-2`);

    const mistyped = await execute('connections writes', { name: 'corp-jira', state: 'on' }, { person: person({ 'confirm-name': 'corp-jria' }) });
    expect(mistyped).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(config().connections['corp-jira']!.writes).toBeUndefined();
    const typed = person({ 'confirm-name': 'corp-jira' });
    expect(await execute('connections writes', { name: 'corp-jira', state: 'on' }, { person: typed })).toMatchObject({ ok: true, data: { writes: true, changed: true } });
    expect(typed.asked).toEqual([expect.objectContaining({ id: 'confirm-name', secret: false, fallback: null })]);
    expect(typed.asked[0]!.text).toContain('Type corp-jira to turn them on');
    expect(await execute('connections writes', { name: 'corp-jira', state: 'off' }, { person: person({}) })).toMatchObject({ ok: true, data: { writes: false } });

    expect(await execute('connections default', { name: 'other-jira' }, { person: person({}) })).toMatchObject({ ok: true, data: { previous: 'corp-jira' } });
    expect(await execute('connections remove', { name: 'other-jira' }, { person: person({}) })).toMatchObject({ ok: true, data: { deletedFromStore: ['other-jira.apiToken'] } });
    expect(Object.keys(config().connections)).toEqual(['corp-jira']);
    expect(auditText()).not.toContain(SECRET);
  });

  it("writes the first toil project when the home is spelled through a link (macOS's /var, a Windows 8.3 name)", async () => {
    // ~/.toil exists (a connection was added) but ~/.toil/projects doesn't yet: the folder and the file must compare in one canonical form.
    const linked = join(tmpdir(), `toil-api-person-link-${process.pid}-${Date.now()}`);
    symlinkSync(home, linked, 'junction');
    try {
      vi.stubEnv('HOME', linked);
      vi.stubEnv('USERPROFILE', linked);
      await execute('connections add', { name: 'corp-jira', area: 'jira' }, { person: person(jira) });
      const made = await execute('projects init', { name: 'payments' });
      expect(made, JSON.stringify(made.error)).toMatchObject({ ok: true, data: { name: 'payments', source: 'user' } });
      const changed = await execute('projects add-repo', { toilProject: 'payments', location: 'https://git.imagile.dev/pay/payments-api.git' });
      expect(changed, JSON.stringify(changed.error)).toMatchObject({ ok: true });
    } finally {
      rmSync(linked, { recursive: false, force: true });
    }
  });

  it('is refused under readOnly, person or not', async () => {
    expect(await execute('connections add', { name: 'corp-jira', area: 'jira' }, { person: person(jira), readOnly: true })).toMatchObject({ ok: false, error: { code: 'WRITE_DISABLED' } });
  });

  it('lists where each connection is defined: the file, or env vars alone', async () => {
    await execute('connections add', { name: 'corp-jira', area: 'jira' }, { person: person(jira) });
    vi.stubEnv('TOIL_CONN_CI_JIRA_AREA', 'jira');
    vi.stubEnv('TOIL_CONN_CI_JIRA_BASE_URL', 'https://jira.imagile.dev');
    const listed = await execute('connections list', {});
    expect(listed.ok && (listed.data as { connections: Array<{ name: string; definedIn: string }> }).connections.map((c) => [c.name, c.definedIn])).toEqual([
      ['ci-jira', 'env'],
      ['corp-jira', 'file'],
    ]);
    const changed = await execute('connections default', { name: 'ci-jira' }, { person: person({}) });
    expect(changed).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: 'Connection "ci-jira" is defined by env vars, not your config file, so there\'s nothing here to change.' } });
  });

  it("runs toil projects onboard only for a person, and its plan for one asks nothing, offering github.com's API for the new connection", async () => {
    mkdirSync(join(home, '.toil', 'projects'), { recursive: true });
    writeFileSync(join(home, '.toil', 'projects', 'team.json'), JSON.stringify({ name: 'team', github: { host: 'github.com', owner: 'imagile' } }));
    const refused = await execute('projects onboard', { toilProject: 'team', plan: true });
    expect(refused).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: "projects onboard is a person's command: execute() runs it only with a person to answer its questions." } });
    const someone = person({});
    const plan = await execute('projects onboard', { toilProject: 'team', plan: true }, { person: someone });
    expect(someone.asked).toEqual([]);
    expect(plan).toMatchObject({ ok: true, data: { plan: true, ok: false, areas: [{ area: 'github', status: 'missing', selects: { host: 'github.com' }, suggest: { name: 'github', baseUrl: 'https://api.github.com' } }] } });
  });
});

describe('the paste checks, through a person (#358)', () => {
  it('trims a pasted secret before storing it', async () => {
    expect(await execute('connections add', { name: 'corp-jira', area: 'jira' }, { person: person({ ...jira, 'secret:apiToken': `${SECRET}\r\n` }) })).toMatchObject({ ok: true });
    expect(sharedStore.entries.get('corp-jira.apiToken')).toBe(SECRET);
  });

  it('asks unwrap:<key> about a Bearer prefix, and stores what the answer says', async () => {
    const p = person({ ...jira, 'secret:apiToken': `Bearer ${SECRET}`, 'unwrap:apiToken': 'y' });
    expect(await execute('connections add', { name: 'corp-jira', area: 'jira' }, { person: p })).toMatchObject({ ok: true });
    expect(p.asked.find((q) => q.id === 'unwrap:apiToken')).toEqual({ id: 'unwrap:apiToken', text: 'This starts with "Bearer ". Store it without that? [Y/n]', secret: false, fallback: null });
    expect(sharedStore.entries.get('corp-jira.apiToken')).toBe(SECRET);

    await execute('connections login', { name: 'corp-jira' }, { person: person({ 'secret:apiToken': `"${SECRET}"`, 'unwrap:apiToken': 'n' }) });
    expect(sharedStore.entries.get('corp-jira.apiToken')).toBe(`"${SECRET}"`);
    // Unanswered, it saves nothing: never removed silently.
    const unanswered = await execute('connections login', { name: 'corp-jira' }, { person: person({ 'secret:apiToken': `token ${SECRET}` }) });
    expect(unanswered).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(sharedStore.entries.get('corp-jira.apiToken')).toBe(`"${SECRET}"`);
  });

  it('refuses a line break in the middle, and an empty required secret, saving nothing and never echoing it', async () => {
    const split = await execute('connections add', { name: 'corp-jira', area: 'jira' }, { person: person({ ...jira, 'secret:apiToken': `${SECRET}\n${SECRET}` }) });
    expect(split).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: 'apiToken: This has a line break in the middle, so the paste most likely took two lines. Nothing was stored.', fix: 'Copy just the token, on its own, and paste it again.' } });
    const empty = await execute('connections add', { name: 'corp-jira', area: 'jira' }, { person: person({ ...jira, 'secret:apiToken': '' }) });
    expect(empty).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: 'apiToken: Nothing was entered, and this one is required. Nothing was saved.', fix: expect.stringMatching(/cancel and set TOIL_CONN_CORP_JIRA_AREA=jira, TOIL_CONN_CORP_JIRA_BASE_URL, TOIL_CONN_CORP_JIRA_API_TOKEN, /) } });
    expect(sharedStore.entries.size).toBe(0);
    expect(JSON.stringify([split, empty])).not.toContain('abc12345');
    expect(auditText()).not.toContain('abc12345');
  });
});
