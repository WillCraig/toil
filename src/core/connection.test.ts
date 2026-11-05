import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineArea } from './area.js';
import { emptyConfig, type ResolvedConfig } from './config.js';
import { resolveConnection } from './connection.js';
import { confluenceArea } from '../areas/confluence/area.js';
import type { Warning } from './envelope.js';

const db = defineArea({
  name: 'db',
  description: 'test',
  connection: z.object({
    host: z.string(),
    port: z.number().int(),
    domain: z.string().optional(),
    readOnly: z.boolean().optional(),
  }),
  defaults: { port: 1433 },
  renamed: { server: 'host' },
});

function config(connections: ResolvedConfig['connections'], defaults: ResolvedConfig['defaults'] = {}): ResolvedConfig {
  return { ...emptyConfig(), connections, defaults };
}

async function resolve(cfg: ResolvedConfig, requested?: string) {
  const warnings: Warning[] = [];
  const connection = await resolveConnection(cfg, db, requested, (w) => warnings.push(w));
  return { connection, warnings };
}

describe('resolveConnection', async () => {
  it('layers provider default, then defaults.<area>, then the connection', async () => {
    expect((await resolve(config({ a: { area: 'db', host: 'h' } }))).connection).toMatchObject({ name: 'a', area: 'db', host: 'h', port: 1433, writes: false });
    expect((await resolve(config({ a: { area: 'db', host: 'h' } }, { db: { port: 1500, domain: 'CORP' } }))).connection).toMatchObject({ port: 1500, domain: 'CORP' });
    expect((await resolve(config({ a: { area: 'db', host: 'h', port: 1600 } }, { db: { port: 1500 } }))).connection).toMatchObject({ port: 1600 });
  });

  it('parses a list or object setting given as JSON text, as an env var must give it', async () => {
    const listy = defineArea({
      name: 'listy',
      description: 'test',
      connection: z.object({ items: z.array(z.object({ id: z.string() })).default([]), map: z.object({ a: z.number() }).optional() }),
    });
    const cfg = config({ l: { area: 'listy', items: '[{"id":"x"}]', map: '{"a":1}' } });
    await expect(resolveConnection(cfg, listy, undefined, () => {})).resolves.toMatchObject({ items: [{ id: 'x' }], map: { a: 1 } });
    // Text that isn't JSON is left for the schema to refuse, naming the key.
    await expect(resolveConnection(config({ l: { area: 'listy', items: 'not json' } }), listy, undefined, () => {})).rejects.toThrow(/items/);
  });

  it('coerces env strings to the schema type', async () => {
    expect((await resolve(config({ a: { area: 'db', host: 'h', port: '5432', readOnly: 'true' } }))).connection).toMatchObject({ port: 5432, readOnly: true });
  });

  it('maps a renamed key, with a warning', async () => {
    const { connection, warnings } = await resolve(config({ a: { area: 'db', server: 'h' } }));
    expect(connection.host).toBe('h');
    expect(warnings.map((w) => w.code)).toEqual(['CONFIG_RENAMED_KEY']);
  });

  it('lets an old name from a higher tier beat a new name from a lower one, and the new name win a tie', async () => {
    const both = (server: 'env' | 'ci' | 'global', host: 'env' | 'ci' | 'global') => ({ ...config({ a: { area: 'db', server: 'old', host: 'new' } }), sources: { 'a.server': server, 'a.host': host } });
    // The old name's env var (TOIL_DB_SERVER) over the new name in the file.
    const envOld = await resolve(both('env', 'global'));
    expect(envOld.connection.host).toBe('old');
    expect(envOld.warnings.map((w) => w.code)).toEqual(['CONFIG_RENAMED_KEY']);
    expect((await resolve(both('global', 'env'))).connection.host).toBe('new');
    expect((await resolve(both('env', 'env'))).connection.host).toBe('new');
    expect((await resolve(both('global', 'global'))).connection.host).toBe('new');
    // An old TOIL_<AREA>_ variable (rule 2) over a CI fallback for the new name (rule 3), and the fallback over the file.
    expect((await resolve(both('env', 'ci'))).connection.host).toBe('old');
    expect((await resolve(both('ci', 'env'))).connection.host).toBe('new');
    expect((await resolve(both('ci', 'global'))).connection.host).toBe('old');
    // The connection's own old name over the new name in defaults.<area>.
    expect((await resolve(config({ a: { area: 'db', server: 'own' } }, { db: { host: 'shared' } }))).connection.host).toBe('own');
  });

  it('drops an unknown key, with a warning, so commands only ever see declared settings', async () => {
    const { connection, warnings } = await resolve(config({ a: { area: 'db', host: 'h', hots: 'typo' } }));
    expect(connection).not.toHaveProperty('hots');
    expect(warnings.map((w) => w.code)).toEqual(['CONFIG_UNKNOWN_KEY']);
  });

  it('says why a value that is set is invalid, not only which key, and keeps a missing key plain', async () => {
    const wrong = await resolve(config({ a: { area: 'db', host: 'h', port: 'not a port' } })).catch((e: unknown) => e);
    expect(wrong).toMatchObject({ code: 'CONFIG_INVALID', message: expect.stringMatching(/^Connection a \(db\) is missing or has invalid port\. port: .+\.$/) });
    // A custom message that already ends in a full stop gets exactly one.
    const sentence = defineArea({ name: 'db', description: '', connection: z.object({ host: z.string().refine((h) => h !== 'x', 'host must not be x.') }) });
    const ended = await resolveConnection(config({ a: { area: 'db', host: 'x' } }), sentence, undefined, () => {}).catch((e: unknown) => e);
    expect(ended).toMatchObject({ message: 'Connection a (db) is missing or has invalid host. host: host must not be x.' });
    const missing = await resolve(config({ db: { area: 'db' } }, { db: { connection: 'db' } })).catch((e: unknown) => e);
    expect(missing).toMatchObject({ code: 'CONFIG_INVALID', message: 'Connection db (db) is missing or has invalid host.' });
  });

  it('names the variable to set when a required key is missing', async () => {
    await expect(resolve(config({ db: { area: 'db' } }, { db: { connection: 'db' } }))).rejects.toEqual(
      expect.objectContaining({ code: 'CONFIG_INVALID', fix: expect.stringContaining('TOIL_DB_HOST') }),
    );
    await expect(resolve(config({ db: { area: 'db', host: 'h' }, other: { area: 'db' } }, { db: { connection: 'db' } }), 'other')).rejects.toEqual(
      expect.objectContaining({ code: 'CONFIG_INVALID', fix: expect.stringContaining('TOIL_CONN_OTHER_HOST') }),
    );
  });

  it('names a declared CI fallback beside the TOIL_ variable, for the default connection only', async () => {
    const scanned = defineArea({
      name: 'scan',
      description: 'test',
      connection: z.object({ baseUrl: z.string(), token: z.string() }),
      secrets: ['token'],
      fallbacks: { token: ['SCAN_TOKEN', 'SCANNER_TOKEN'] },
    });
    const fail = (cfg: ResolvedConfig, requested?: string) => resolveConnection(cfg, scanned, requested, () => {}).catch((e: unknown) => e);
    expect(await fail(config({}))).toMatchObject({
      code: 'NOT_CONFIGURED',
      fix: 'Set TOIL_SCAN_BASE_URL and TOIL_SCAN_TOKEN (or SCAN_TOKEN or SCANNER_TOKEN), or add a scan connection to your toil config.',
    });
    expect(await fail(config({ scan: { area: 'scan', baseUrl: 'https://scan.imagile.dev' } }, { scan: { connection: 'scan' } }))).toMatchObject({
      code: 'CONFIG_INVALID',
      fix: expect.stringContaining('Set TOIL_SCAN_TOKEN (or SCAN_TOKEN or SCANNER_TOKEN), or fix token'),
    });
    // Another connection doesn't take the fallback, so its fix doesn't offer it.
    const other = (await fail(config({ scan: { area: 'scan', baseUrl: 'b', token: 't' }, ci: { area: 'scan', baseUrl: 'b' } }, { scan: { connection: 'scan' } }), 'ci')) as { fix: string };
    expect(other.fix).toContain('TOIL_CONN_CI_TOKEN');
    expect(other.fix).not.toContain('SCAN_TOKEN');
  });

  it('explains every way the choice can fail', async () => {
    await expect(resolve(config({}))).rejects.toEqual(expect.objectContaining({ code: 'NOT_CONFIGURED', fix: expect.stringContaining('TOIL_DB_HOST') }));
    await expect(resolve(config({ a: { area: 'db', host: 'h' }, b: { area: 'db', host: 'h' } }))).rejects.toEqual(
      expect.objectContaining({ code: 'INVALID_INPUT', fix: expect.stringContaining('--connection') }),
    );
    await expect(resolve(config({ a: { area: 'db', host: 'h' } }), 'nope')).rejects.toEqual(expect.objectContaining({ code: 'INVALID_INPUT' }));
    await expect(resolve(config({ a: { area: 'db', host: 'h' }, j: { area: 'jira' } }), 'j')).rejects.toEqual(
      expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringContaining('jira connection') }),
    );
  });

  it('reads writes from the connection, never from defaults.<area>', async () => {
    expect((await resolve(config({ a: { area: 'db', host: 'h', writes: true } }))).connection.writes).toBe(true);
    expect((await resolve(config({ a: { area: 'db', host: 'h' } }, { db: { writes: true } }))).connection.writes).toBe(false);
  });
});

describe('defineArea', async () => {
  it('refuses keys core owns, keys ending in Area, and commands outside the area', async () => {
    const shape = (s: z.ZodRawShape) => () => defineArea({ name: 'x', description: '', connection: z.object(s) });
    expect(shape({ writes: z.boolean() })).toThrow(/set by core/);
    expect(shape({ dataArea: z.string() })).toThrow(/Area/);
    const x = defineArea({ name: 'x', description: '', connection: z.object({}) });
    expect(() => x.command({ path: ['y', 'go'], description: '', input: z.object({}), writes: false, examples: [{}], run: async () => null })).toThrow(/must start with "x"/);
  });

  it('adds the connection input and --connection to every command', async () => {
    const x = defineArea({ name: 'x', description: '', connection: z.object({}) });
    const cmd = x.command({ path: ['x', 'go'], description: '', input: z.object({ id: z.string() }), writes: false, examples: [{ id: '1' }], run: async () => null });
    expect(Object.keys(cmd.input.shape)).toEqual(['id', 'connection', 'toilProject', 'cwd']);
    expect(cmd.options?.map((o) => o.flags)).toContain('--connection <name>');
    expect(cmd.area?.name).toBe('x');
  });
});

describe('keychain: references', async () => {
  const api = defineArea({
    name: 'api',
    description: 'test',
    connection: z.object({ baseUrl: z.string(), token: z.string().min(1), label: z.string().optional() }),
    secrets: ['token'],
  });
  const store = (entries: Record<string, string>, fail?: Error) => {
    const asked: string[] = [];
    return {
      asked,
      get: async (ref: string) => {
        asked.push(ref);
        if (fail) throw fail;
        return entries[ref];
      },
    };
  };
  const run = async (cfg: ResolvedConfig, secrets?: ReturnType<typeof store>) => {
    const warnings: Warning[] = [];
    return { connection: await resolveConnection(cfg, api, undefined, (w) => warnings.push(w), secrets), warnings };
  };
  const withRef = (extra: Record<string, unknown> = {}) => config({ a: { area: 'api', baseUrl: 'https://api.imagile.dev', token: 'keychain:a.token', ...extra } });

  it('resolves a reference on a secret key to the stored secret', async () => {
    const secrets = store({ 'a.token': 'fake-secret' });
    expect((await run(withRef(), secrets)).connection).toMatchObject({ token: 'fake-secret' });
    expect(secrets.asked).toEqual(['a.token']);
  });

  it('an env var wins, and the store is never asked', async () => {
    const cfg = withRef();
    cfg.connections.a!.token = 'from-env';
    cfg.sources['a.token'] = 'env';
    const secrets = store({ 'a.token': 'fake-secret' });
    expect((await run(cfg, secrets)).connection).toMatchObject({ token: 'from-env' });
    expect(secrets.asked).toEqual([]);
  });

  it('an unresolvable reference is unset, never the literal string, with a warning naming the fix', async () => {
    for (const secrets of [store({}), store({}, new Error('store is locked')), undefined]) {
      let thrown: unknown;
      try {
        await run(withRef(), secrets);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toMatchObject({ code: 'CONFIG_INVALID', message: expect.stringContaining('token') });
      expect(JSON.stringify(thrown)).not.toContain('keychain:');
    }
    const optional = defineArea({ name: 'api', description: 'test', connection: z.object({ baseUrl: z.string(), token: z.string().optional() }), secrets: ['token'] });
    const warnings: Warning[] = [];
    const resolved = await resolveConnection(withRef(), optional, undefined, (w) => warnings.push(w), store({}));
    expect(resolved).not.toHaveProperty('token');
    expect(warnings).toEqual([expect.objectContaining({ code: 'CONFIG_SECRET_UNRESOLVED', message: expect.stringMatching(/toil connections login a.*TOIL_CONN_A_TOKEN/) })]);
  });

  it('leaves a keychain: value on a key that is not a secret alone', async () => {
    const secrets = store({ 'a.token': 's', 'a.label': 'x' });
    expect((await run(withRef({ label: 'keychain:a.label' }), secrets)).connection).toMatchObject({ label: 'keychain:a.label', token: 's' });
    expect(secrets.asked).toEqual(['a.token']);
  });

  it('resolves a reference shared through defaults.<area>', async () => {
    const cfg = config({ a: { area: 'api', baseUrl: 'https://api.imagile.dev' } }, { api: { token: 'keychain:shared.token' } });
    expect((await run(cfg, store({ 'shared.token': 'shared-secret' }))).connection).toMatchObject({ token: 'shared-secret' });
  });
});

describe('plaintext secrets in a config file', () => {
  const api = defineArea({
    name: 'api',
    description: 'test',
    connection: z.object({ baseUrl: z.string(), token: z.string().min(1) }),
    secrets: ['token'],
    renamed: { apiToken: 'token' },
  });
  const store = { get: async (ref: string) => (ref === 'a.token' ? 'from-store' : undefined) };
  const run = (cfg: ResolvedConfig) => resolveConnection(cfg, api, undefined, () => {}, store);
  const file = (settings: Record<string, unknown>, defaults: ResolvedConfig['defaults'] = {}) => {
    const cfg = config({ a: { area: 'api', baseUrl: 'https://api.imagile.dev', ...settings } }, defaults);
    for (const key of Object.keys(settings)) cfg.sources[`a.${key}`] = 'global';
    return cfg;
  };

  it('is CONFIG_INVALID, naming login and both env vars, and never echoing the value', async () => {
    let thrown: unknown;
    try {
      await run(file({ token: 'pasted-secret-value' }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({
      code: 'CONFIG_INVALID',
      fix: expect.stringMatching(/toil connections login a.*TOIL_CONN_A_TOKEN or TOIL_API_TOKEN/),
    });
    expect(JSON.stringify(thrown) + String((thrown as Error).message)).not.toContain('pasted-secret-value');
  });

  it('is refused under an old key name, and when shared through defaults.<area>', async () => {
    await expect(run(file({ apiToken: 'x' }))).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(run(file({}, { api: { token: 'x' } }))).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('a keychain: reference resolves instead', async () => {
    expect(await run(file({ token: 'keychain:a.token' }))).toMatchObject({ token: 'from-store' });
  });

  it('an env var or CI variable wins and may be plaintext, since it never sits in a file', async () => {
    for (const source of ['env', 'ci'] as const) {
      const cfg = file({ token: 'from-env' });
      cfg.sources['a.token'] = source;
      expect(await run(cfg)).toMatchObject({ token: 'from-env' });
    }
  });

  it('a key that is not a secret is fine in plain text', async () => {
    expect(await run(file({ token: 'keychain:a.token', baseUrl: 'https://other.imagile.dev' }))).toMatchObject({ baseUrl: 'https://other.imagile.dev' });
  });
});

describe('shares.fallbackWhen reads the connection as it resolves', () => {
  const jira = defineArea({
    name: 'jira',
    description: 'test',
    connection: z.object({ baseUrl: z.string(), deployment: z.enum(['server', 'cloud']).default('server'), apiToken: z.string().optional() }),
    secrets: ['apiToken'],
    defaults: { deployment: 'server' },
  });
  const wiki = defineArea({
    name: 'wiki',
    description: 'test',
    connection: z.object({ baseUrl: z.string(), deployment: z.enum(['server', 'cloud']).default('server'), apiToken: z.string().optional() }),
    secrets: ['apiToken'],
    defaults: { deployment: 'server' },
    shares: { area: jira, keys: ['apiToken'], fallbackWhen: (other, own) => other.deployment === own.deployment },
  });

  it("never lends a Cloud token to a Data Center area when the deployment is set only in defaults.jira", async () => {
    const cfg = config(
      { jira: { area: 'jira', baseUrl: 'https://jira.imagile.dev', apiToken: 'cloud-token' }, wiki: { area: 'wiki', baseUrl: 'https://wiki.imagile.dev' } },
      { jira: { connection: 'jira', deployment: 'cloud' }, wiki: { connection: 'wiki' } },
    );
    cfg.sources['jira.apiToken'] = 'env';
    await expect(resolveConnection(cfg, wiki, undefined, () => {})).resolves.not.toHaveProperty('apiToken');
  });

  it('still lends a Data Center token, whichever tier says the deployment', async () => {
    const cfg = config(
      { jira: { area: 'jira', baseUrl: 'https://jira.imagile.dev', apiToken: 'dc-token' }, wiki: { area: 'wiki', baseUrl: 'https://wiki.imagile.dev' } },
      { jira: { connection: 'jira' }, wiki: { connection: 'wiki' } },
    );
    cfg.sources['jira.apiToken'] = 'env';
    await expect(resolveConnection(cfg, wiki, undefined, () => {})).resolves.toMatchObject({ apiToken: 'dc-token' });
  });

  it('lends a Cloud token to a Cloud connection, and never a Data Center token to it', async () => {
    const cfg = (jiraDeployment: string) => {
      const c = config(
        { jira: { area: 'jira', baseUrl: 'https://jira.imagile.dev', deployment: jiraDeployment, apiToken: 'lent-token' }, wiki: { area: 'wiki', baseUrl: 'https://wiki.imagile.dev', deployment: 'cloud' } },
        { jira: { connection: 'jira' }, wiki: { connection: 'wiki' } },
      );
      c.sources['jira.apiToken'] = 'env';
      return c;
    };
    await expect(resolveConnection(cfg('cloud'), wiki, undefined, () => {})).resolves.toMatchObject({ apiToken: 'lent-token' });
    await expect(resolveConnection(cfg('server'), wiki, undefined, () => {})).resolves.not.toHaveProperty('apiToken');
  });
});

describe('the real confluence area shares the Jira token only between like deployments', () => {
  const jiraConn = (settings: Record<string, unknown>) => ({ area: 'jira', ...settings });
  const resolveWith = (jira: Record<string, unknown>) => {
    const cfg: ResolvedConfig = {
      ...config(
        { jira: jiraConn(jira), confluence: { area: 'confluence', baseUrl: 'https://confluence-cloud.imagile.dev', email: 'you@example.com' } },
        { jira: { connection: 'jira' }, confluence: { connection: 'confluence', deployment: 'cloud' } },
      ),
      sources: { 'jira.apiToken': 'env' },
    };
    return resolveConnection(cfg, confluenceArea, undefined, () => {});
  };

  it('lends a Cloud Jira token to a Confluence whose Cloud deployment is set only in defaults.confluence', async () => {
    await expect(resolveWith({ baseUrl: 'https://confluence-cloud.imagile.dev', deployment: 'cloud', email: 'you@example.com', apiToken: 'jira-token' })).resolves.toMatchObject({ apiToken: 'jira-token' });
  });

  it('does not lend a Data Center Jira token to that Cloud Confluence', async () => {
    await expect(resolveWith({ baseUrl: 'https://jira.imagile.dev', apiToken: 'dc-pat' })).rejects.toMatchObject({ code: 'CONFIG_INVALID', message: expect.stringContaining('apiToken') });
  });
});
