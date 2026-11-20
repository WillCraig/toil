import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectionsCommands } from '../src/connections/commands.js';
import { loadConfig } from '../src/core/config.js';
import type { Context } from '../src/core/context.js';
import type { Prompter } from '../src/core/prompt.js';
import { z } from 'zod';
import { registry } from '../src/api.js';
import { defineArea } from '../src/core/area.js';
import { areas } from '../src/registry.js';
import { runCli } from './harness/cli.js';
import { TEST_VERSION } from './harness/context.js';
import { fakeFetch } from './harness/fake-fetch.js';
import { fakeStore, type FakeStore } from './harness/fake-store.js';
import { memoryFiles } from './harness/files.js';

/**
 * Reusing Jira Cloud's API token for Confluence Cloud on the same site
 * (`defineArea({ shares: { offer } })`): `connections add` and `login` offer
 * it, `add --set` names it for the agent to pass on and still refuses the
 * pairing, and nothing is offered on Data Center or across sites. Real areas,
 * a temp home, a fake store and a scripted terminal.
 */
const commands = connectionsCommands(areas);
const JIRA_TOKEN = 'fake-jira-token-abc12345';
const OWN_TOKEN = 'fake-confluence-token-abc12345';
// A Cloud connection's base URL is any site root; the placeholder rule keeps real-looking Atlassian tenants out.
const SITE = 'https://atlassian.imagile.dev';

let root: string;
let home: string;
let file: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'toil-borrow-'));
  home = join(root, 'home');
  file = join(home, '.toil', 'config.json');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const writeConfig = (connections: Record<string, Record<string, unknown>>) => {
  mkdirSync(join(home, '.toil'), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 4, connections, defaults: {} }));
};
const readConfig = () => JSON.parse(readFileSync(file, 'utf8')) as { connections: Record<string, Record<string, unknown>> };

const jiraCloud = { area: 'jira', deployment: 'cloud', baseUrl: SITE, email: 'you@example.com', apiToken: 'keychain:corp-jira.apiToken' };
const withJira = () => fakeStore({ entries: { 'corp-jira.apiToken': JIRA_TOKEN } });

/** Answers by the question's first word, or by its id for the borrow question; records every question. */
function terminal(answers: Record<string, string>) {
  const asked: Array<{ id: string; question: string; fallback: string | undefined }> = [];
  const prompt: Prompter = {
    ask: async (question, fallback, id) => {
      asked.push({ id: id ?? '', question, fallback });
      return answers[id ?? ''] ?? answers[question.split(/[\s(]/)[0]!] ?? fallback ?? '';
    },
    askSecret: async (question, id) => {
      asked.push({ id: id ?? '', question, fallback: undefined });
      return answers[id ?? ''] ?? '';
    },
  };
  return { prompt, asked };
}

function context(options: { prompt?: Prompter; secrets?: FakeStore; env?: NodeJS.ProcessEnv } = {}): Context {
  const env = options.env ?? {};
  return {
    config: loadConfig({ env, cwd: root, home, areas: areas.map((a) => ({ name: a.name })) }),
    fetch: fakeFetch([]).fetch,
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

/** A prompted `connections add` of a Confluence connection with these settings. */
const addConfluence = (secrets: FakeStore, settings: Record<string, string>, extra: Record<string, string> = {}) => {
  const t = terminal({ ...Object.fromEntries(Object.entries(settings).map(([k, v]) => [`setting:${k}`, v])), ...extra });
  return { t, run: cli(['connections', 'add', 'wiki', '--area', 'confluence'], context({ prompt: t.prompt, secrets })) };
};

describe('connections add offers Jira Cloud\'s API token to Confluence Cloud on the same site', () => {
  it('offers it, defaults the email to Jira\'s, and on a yes writes apiTokenFrom and stores nothing', async () => {
    writeConfig({ 'corp-jira': jiraCloud });
    const store = withJira();
    const { t, run } = addConfluence(store, { baseUrl: SITE, deployment: 'cloud' });
    const out = await run;

    expect(out.envelope, out.stdout).toMatchObject({ ok: true, data: { name: 'wiki', secrets: {}, borrowed: { apiToken: 'corp-jira' } } });
    const email = t.asked.find((a) => a.id === 'setting:email')!;
    expect(email.fallback).toBe('you@example.com');
    const offer = t.asked.find((a) => a.id === 'borrow:apiToken')!;
    expect(offer.question).toContain('Use the apiToken from corp-jira (jira)');
    expect(offer.fallback).toBe('y');
    // No secret question, and no plain apiTokenFrom question: the offer replaced both.
    expect(t.asked.map((a) => a.id)).not.toContain('secret:apiToken');
    expect(t.asked.map((a) => a.id)).not.toContain('setting:apiTokenFrom');
    expect(readConfig().connections.wiki).toEqual({ area: 'confluence', baseUrl: SITE, deployment: 'cloud', email: 'you@example.com', apiTokenFrom: 'corp-jira' });
    expect([...store.entries.keys()]).toEqual(['corp-jira.apiToken']);
    expect(store.log.filter((l) => l.startsWith('set'))).toEqual([]);
    expect(out.stdout + out.stderr).not.toContain(JIRA_TOKEN);
  });

  it('then a Confluence command signs in with Jira\'s token and the shared email', async () => {
    writeConfig({ 'corp-jira': jiraCloud });
    const store = withJira();
    await addConfluence(store, { baseUrl: SITE, deployment: 'cloud' }).run;
    const ctx = context({ secrets: store });
    const http = fakeFetch([{ method: 'GET', url: `${SITE}/wiki/rest/api/user/current`, respond: { json: { type: 'known', accountId: 'abc12345' } } }]);
    ctx.fetch = http.fetch;
    const out = await cli(['connections', 'test', 'wiki'], ctx);
    expect(out.envelope?.ok, out.stdout).toBe(true);
    expect(http.calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`you@example.com:${JIRA_TOKEN}`).toString('base64')}`);
  });

  it('on a no, asks for Confluence\'s own token as before', async () => {
    writeConfig({ 'corp-jira': jiraCloud });
    const store = withJira();
    const { t, run } = addConfluence(store, { baseUrl: SITE, deployment: 'cloud' }, { 'borrow:apiToken': 'n', 'secret:apiToken': OWN_TOKEN });
    const out = await run;
    expect(out.envelope, out.stdout).toMatchObject({ ok: true, data: { secrets: { apiToken: 'store' }, borrowed: {} } });
    expect(t.asked.map((a) => a.id)).toContain('secret:apiToken');
    expect(readConfig().connections.wiki).not.toHaveProperty('apiTokenFrom');
    expect(store.entries.get('wiki.apiToken')).toBe(OWN_TOKEN);
  });

  it('says the token won\'t work with a different email, and defaults to no', async () => {
    writeConfig({ 'corp-jira': jiraCloud });
    const { t, run } = addConfluence(withJira(), { baseUrl: SITE, deployment: 'cloud', email: 'someone-else@example.com' }, { 'secret:apiToken': OWN_TOKEN });
    expect((await run).envelope?.ok).toBe(true);
    const offer = t.asked.find((a) => a.id === 'borrow:apiToken')!;
    expect(offer.question).toContain('works only with email you@example.com');
    expect(offer.question).toContain("won't sign in here");
    expect(offer.fallback).toBe('n');
    expect(readConfig().connections.wiki).not.toHaveProperty('apiTokenFrom');
  });

  it('never offers it on Data Center, where each server issues its own personal access token', async () => {
    writeConfig({ 'jira-dc': { area: 'jira', baseUrl: 'https://jira.imagile.dev', apiToken: 'keychain:jira-dc.apiToken' } });
    const store = fakeStore({ entries: { 'jira-dc.apiToken': JIRA_TOKEN } });
    const { t, run } = addConfluence(store, { baseUrl: 'https://jira.imagile.dev', deployment: 'server' }, { 'secret:apiToken': OWN_TOKEN });
    expect((await run).envelope?.ok).toBe(true);
    expect(t.asked.map((a) => a.id)).not.toContain('borrow:apiToken');
    expect(store.log).not.toContain('get jira-dc.apiToken');
  });

  it('never offers a Data Center Jira\'s token to Confluence Cloud, nor across sites', async () => {
    writeConfig({
      'jira-dc': { area: 'jira', baseUrl: SITE, apiToken: 'keychain:jira-dc.apiToken' },
      'other-site': { ...jiraCloud, baseUrl: 'https://wiki-elsewhere.imagile.dev', apiToken: 'keychain:other-site.apiToken' },
    });
    const store = fakeStore({ entries: { 'jira-dc.apiToken': JIRA_TOKEN, 'other-site.apiToken': JIRA_TOKEN } });
    const { t, run } = addConfluence(store, { baseUrl: SITE, deployment: 'cloud', email: 'you@example.com' }, { 'secret:apiToken': OWN_TOKEN });
    expect((await run).envelope?.ok).toBe(true);
    expect(t.asked.map((a) => a.id)).not.toContain('borrow:apiToken');
  });

  it('never offers a Jira made of env vars, whose pairing would break in the next shell', async () => {
    const env = { TOIL_CONN_ENV_JIRA_AREA: 'jira', TOIL_CONN_ENV_JIRA_DEPLOYMENT: 'cloud', TOIL_CONN_ENV_JIRA_BASE_URL: SITE, TOIL_CONN_ENV_JIRA_EMAIL: 'you@example.com', TOIL_CONN_ENV_JIRA_API_TOKEN: JIRA_TOKEN };
    writeConfig({});
    const t = terminal({ 'setting:baseUrl': SITE, 'setting:deployment': 'cloud', 'setting:email': 'you@example.com', 'secret:apiToken': OWN_TOKEN });
    const out = await cli(['connections', 'add', 'wiki', '--area', 'confluence'], context({ prompt: t.prompt, secrets: fakeStore(), env }));
    expect(out.envelope?.ok, out.stdout).toBe(true);
    expect(t.asked.map((a) => a.id)).not.toContain('borrow:apiToken');
  });

  it('reads deployment from defaults.confluence, as the connection will resolve', async () => {
    mkdirSync(join(home, '.toil'), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 4, connections: { 'corp-jira': jiraCloud }, defaults: { confluence: { deployment: 'cloud' } } }));
    const t = terminal({ 'setting:baseUrl': SITE });
    const out = await cli(['connections', 'add', 'wiki', '--area', 'confluence'], context({ prompt: t.prompt, secrets: withJira() }));
    expect(out.envelope, out.stdout).toMatchObject({ ok: true, data: { borrowed: { apiToken: 'corp-jira' } } });
  });

  it('never offers a Jira whose token doesn\'t resolve', async () => {
    writeConfig({ 'corp-jira': jiraCloud });
    const { t, run } = addConfluence(fakeStore(), { baseUrl: SITE, deployment: 'cloud', email: 'you@example.com' }, { 'secret:apiToken': OWN_TOKEN });
    const out = await run;
    expect(out.envelope?.ok).toBe(true);
    expect(t.asked.map((a) => a.id)).not.toContain('borrow:apiToken');
    // Not in silence: the person is told why they were asked for a token they already hold.
    expect(out.envelope!.meta.warnings).toEqual([expect.objectContaining({ code: 'SECRET_REUSE_UNAVAILABLE', message: expect.stringContaining('toil connections test corp-jira') })]);
  });
});

describe('connections login offers the reuse too', () => {
  it('on a yes, switches a Confluence Cloud connection to Jira\'s token and deletes its own', async () => {
    writeConfig({ 'corp-jira': jiraCloud, wiki: { area: 'confluence', deployment: 'cloud', baseUrl: SITE, email: 'you@example.com', apiToken: 'keychain:wiki.apiToken' } });
    const store = fakeStore({ entries: { 'corp-jira.apiToken': JIRA_TOKEN, 'wiki.apiToken': OWN_TOKEN } });
    const { prompt, asked } = terminal({});
    const out = await cli(['connections', 'login', 'wiki'], context({ prompt, secrets: store }));
    expect(out.envelope, out.stdout).toMatchObject({ ok: true, data: { secrets: {}, borrowed: { apiToken: 'corp-jira' } } });
    expect(asked.map((a) => a.id)).toEqual(['borrow:apiToken']);
    expect(readConfig().connections.wiki).toEqual({ area: 'confluence', deployment: 'cloud', baseUrl: SITE, email: 'you@example.com', apiTokenFrom: 'corp-jira' });
    expect(store.entries.has('wiki.apiToken')).toBe(false);
    expect(store.entries.get('corp-jira.apiToken')).toBe(JIRA_TOKEN);
  });

  it('on a no, takes its own token and drops a pairing, so the file says which one signs in', async () => {
    writeConfig({ 'corp-jira': jiraCloud, wiki: { area: 'confluence', deployment: 'cloud', baseUrl: SITE, email: 'you@example.com', apiTokenFrom: 'corp-jira' } });
    const store = withJira();
    const { prompt } = terminal({ 'borrow:apiToken': 'n', 'secret:apiToken': OWN_TOKEN });
    const out = await cli(['connections', 'login', 'wiki'], context({ prompt, secrets: store }));
    expect(out.envelope, out.stdout).toMatchObject({ ok: true, data: { secrets: { apiToken: 'store' }, borrowed: {} } });
    expect(readConfig().connections.wiki).toEqual({ area: 'confluence', deployment: 'cloud', baseUrl: SITE, email: 'you@example.com', apiToken: 'keychain:wiki.apiToken' });
  });

  it('offers nothing when its own token comes from env, which would still win over a pairing', async () => {
    writeConfig({ 'corp-jira': jiraCloud, wiki: { area: 'confluence', deployment: 'cloud', baseUrl: SITE, email: 'you@example.com' } });
    const { prompt, asked } = terminal({ 'secret:apiToken': OWN_TOKEN });
    const out = await cli(['connections', 'login', 'wiki'], context({ prompt, secrets: withJira(), env: { TOIL_CONN_WIKI_API_TOKEN: OWN_TOKEN } }));
    expect(out.envelope?.ok, out.stdout).toBe(true);
    expect(asked.map((a) => a.id)).toEqual(['secret:apiToken']);
  });

  it('leaves a pairing set by hand where no offer applies, when a token of its own is entered', async () => {
    writeConfig({ 'jira-dc': { area: 'jira', baseUrl: 'https://jira.imagile.dev', apiToken: 'keychain:jira-dc.apiToken' }, wiki: { area: 'confluence', baseUrl: 'https://jira.imagile.dev', apiTokenFrom: 'jira-dc' } });
    const { prompt } = terminal({ 'secret:apiToken': OWN_TOKEN });
    const out = await cli(['connections', 'login', 'wiki'], context({ prompt, secrets: fakeStore({ entries: { 'jira-dc.apiToken': JIRA_TOKEN } }) }));
    expect(out.envelope?.ok, out.stdout).toBe(true);
    expect(readConfig().connections.wiki).toEqual({ area: 'confluence', baseUrl: 'https://jira.imagile.dev', apiTokenFrom: 'jira-dc', apiToken: 'keychain:wiki.apiToken' });
  });

  it('says why when the page chose reuse but the Jira token does not read, instead of only "nothing was entered"', async () => {
    writeConfig({ 'corp-jira': jiraCloud, wiki: { area: 'confluence', deployment: 'cloud', baseUrl: SITE, email: 'you@example.com', apiToken: 'keychain:wiki.apiToken' } });
    const { prompt } = terminal({ 'borrow:apiToken': 'y' });
    const out = await cli(['connections', 'login', 'wiki'], context({ prompt, secrets: fakeStore({ entries: { 'wiki.apiToken': OWN_TOKEN } }) }));
    expect(out.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining("corp-jira's token couldn't be read") });
  });

  it('asks a Data Center Confluence only for its own token', async () => {
    writeConfig({ 'jira-dc': { area: 'jira', baseUrl: 'https://jira.imagile.dev', apiToken: 'keychain:jira-dc.apiToken' }, wiki: { area: 'confluence', baseUrl: 'https://jira.imagile.dev' } });
    const { prompt, asked } = terminal({ 'secret:apiToken': OWN_TOKEN });
    const out = await cli(['connections', 'login', 'wiki'], context({ prompt, secrets: fakeStore({ entries: { 'jira-dc.apiToken': JIRA_TOKEN } }) }));
    expect(out.envelope?.ok, out.stdout).toBe(true);
    expect(asked.map((a) => a.id)).toEqual(['secret:apiToken']);
  });
});

describe('connections add --set, the agent path', () => {
  it('names the Jira connection whose token the person can reuse, and still sets no pairing', async () => {
    writeConfig({ 'corp-jira': jiraCloud });
    const out = await cli(['connections', 'add', 'wiki', '--area', 'confluence', '--set', `baseUrl=${SITE}`, '--set', 'deployment=cloud', '--set', 'email=you@example.com'], context({ secrets: withJira() }));
    expect(out.envelope, out.stdout).toMatchObject({ ok: true, data: { secretNeeded: ['apiToken'], secretReusable: { apiToken: 'corp-jira' } } });
    const warning = out.envelope!.meta.warnings!.find((w) => w.code === 'SECRET_NEEDED')!;
    expect(warning.message).toContain('corp-jira (jira) already holds an apiToken that works here: toil connections login wiki offers to reuse it');
    expect(readConfig().connections.wiki).not.toHaveProperty('apiTokenFrom');
  });

  it('says the email has to match first when it differs', async () => {
    writeConfig({ 'corp-jira': jiraCloud });
    const out = await cli(['connections', 'add', 'wiki', '--area', 'confluence', '--set', `baseUrl=${SITE}`, '--set', 'deployment=cloud', '--set', 'email=other@example.com'], context({ secrets: withJira() }));
    expect(out.envelope!.meta.warnings!.find((w) => w.code === 'SECRET_NEEDED')!.message).toContain("works only with corp-jira's email");
  });

  it('names nothing to reuse on Data Center', async () => {
    writeConfig({ 'jira-dc': { area: 'jira', baseUrl: 'https://jira.imagile.dev', apiToken: 'keychain:jira-dc.apiToken' } });
    const out = await cli(['connections', 'add', 'wiki', '--area', 'confluence', '--set', 'baseUrl=https://jira.imagile.dev'], context({ secrets: fakeStore({ entries: { 'jira-dc.apiToken': JIRA_TOKEN } }) }));
    expect(out.envelope, out.stdout).toMatchObject({ ok: true, data: { secretReusable: {} } });
    expect(out.envelope!.meta.warnings!.find((w) => w.code === 'SECRET_NEEDED')!.message).not.toContain('reuse');
  });

  it('warns when the Jira connection that would work has a token that does not read', async () => {
    writeConfig({ 'corp-jira': jiraCloud });
    const out = await cli(['connections', 'add', 'wiki', '--area', 'confluence', '--set', `baseUrl=${SITE}`, '--set', 'deployment=cloud', '--set', 'email=you@example.com'], context({ secrets: fakeStore() }));
    expect(out.envelope, out.stdout).toMatchObject({ ok: true, data: { secretReusable: {} } });
    expect(out.envelope!.meta.warnings!.map((w) => w.code).sort()).toEqual(['SECRET_NEEDED', 'SECRET_REUSE_UNAVAILABLE']);
  });

  it('still refuses apiTokenFrom: an agent never moves a secret', async () => {
    writeConfig({ 'corp-jira': jiraCloud });
    const out = await cli(['connections', 'add', 'wiki', '--area', 'confluence', '--set', `baseUrl=${SITE}`, '--set', 'apiTokenFrom=corp-jira'], context({ secrets: withJira() }));
    expect(out.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('apiTokenFrom borrows another connection') });
  });
});

describe('connections list says which deployment', () => {
  it('on Jira and Confluence connections, never a secret', async () => {
    writeConfig({ 'corp-jira': jiraCloud, wiki: { area: 'confluence', baseUrl: 'https://confluence.imagile.dev' } });
    const out = await cli(['connections', 'list'], context());
    const rows = (out.envelope?.data as { connections: Array<{ name: string; deployment?: string }> }).connections;
    expect(rows.map((r) => [r.name, r.deployment])).toEqual([['corp-jira', 'cloud'], ['wiki', 'server']]);
  });
});

describe('defineArea checks an offer', () => {
  it('refuses a when or match key that is not a non-secret setting of both areas', () => {
    const jira = areas.find((a) => a.name === 'jira')!;
    const make = (offer: object) => () =>
      defineArea({ name: 'wiki-x', description: 'x', connection: z.object({ baseUrl: z.url(), apiToken: z.string(), email: z.string().optional() }), secrets: ['apiToken'], shares: { area: jira, keys: ['apiToken'], offer } });
    expect(make({ match: ['email'], sameHost: true })).not.toThrow();
    expect(make({ when: { deployment: 'cloud' } })).toThrow(/checks "deployment"/);
    expect(make({ match: ['apiToken'] })).toThrow(/non-secret connection key/);
  });
});

describe('the registry describes the offer for a form', () => {
  it('on Confluence\'s apiTokenFrom only', () => {
    const fields = registry.areas.flatMap((a) => a.connection.filter((f) => f.borrows).map((f) => [a.name, f.name, f.borrows]));
    expect(fields).toEqual([['confluence', 'apiTokenFrom', { area: 'jira', key: 'apiToken', when: { deployment: 'cloud' }, sameHost: true, match: ['email'] }]]);
  });
});
