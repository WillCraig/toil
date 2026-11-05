import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  anyWrites,
  CONNECTION_NAME,
  CONFIG_VERSION,
  connectionEnvName,
  defaultConnectionName,
  envName,
  fromEnv,
  loadConfig,
  parseEnvName,
  readConfigForEdit,
  writeConfigFile,
  type AreaInfo,
} from './config.js';
import { ToilError } from './errors.js';

let root: string;
let home: string;
let repo: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'toil-config-'));
  home = join(root, 'home');
  repo = join(root, 'work', 'repo');
  mkdirSync(join(home, '.toil'), { recursive: true });
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'packages', 'app'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const file = () => join(home, '.toil', 'config.json');
const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
const areas: AreaInfo[] = [{ name: 'jira' }, { name: 'demo-cloud' }, { name: 'db' }, { name: 'github', fallbacks: { token: ['GITHUB_TOKEN'] } }];
const knownAreas = areas.map((a) => a.name);
const load = (env: NodeJS.ProcessEnv = {}) => loadConfig({ env, cwd: repo, home, areas });

const v2 = {
  version: 2,
  connections: {
    'corp-jira': { area: 'jira', baseUrl: 'https://jira.imagile.dev', token: 'file-token' },
    'jira-sandbox': { area: 'jira', baseUrl: 'https://jira-sandbox.imagile.dev', writes: true },
  },
  defaults: { jira: { connection: 'corp-jira', pageSize: 50 } },
};

describe('version 1 files', () => {
  it('read as one connection per area, named after it and set as its default', () => {
    writeJson(file(), { jira: { baseUrl: 'https://jira.imagile.dev', project: 'P' } });
    const config = load();
    expect(config.connections.jira).toEqual({ area: 'jira', baseUrl: 'https://jira.imagile.dev', project: 'P' });
    expect(defaultConnectionName(config, 'jira')).toBe('jira');
    expect(config.sources['jira.project']).toBe('global');
  });

  it('warn about connections and defaults, which need version 2', () => {
    writeJson(file(), { connections: { x: {} }, defaults: {}, jira: { project: 'P' } });
    const config = load();
    expect(Object.keys(config.connections)).toEqual(['jira']);
    expect(config.warnings.map((w) => w.code)).toEqual(['CONFIG_RESERVED_KEY', 'CONFIG_RESERVED_KEY']);
  });
});

describe('version 2 files', () => {
  it('read named connections and the default each area uses', () => {
    writeJson(file(), v2);
    const config = load();
    expect(Object.keys(config.connections).sort()).toEqual(['corp-jira', 'jira-sandbox']);
    expect(defaultConnectionName(config, 'jira')).toBe('corp-jira');
    expect(anyWrites(config, 'jira')).toBe(true);
  });

  it('pick the only connection for an area when no default is named', () => {
    writeJson(file(), { version: 2, connections: { 'corp-db': { area: 'db' } } });
    expect(defaultConnectionName(load(), 'db')).toBe('corp-db');
  });

  it('have no default when an area has several connections and none is named', () => {
    writeJson(file(), { version: 2, connections: { a: { area: 'db' }, b: { area: 'db' } } });
    expect(defaultConnectionName(load(), 'db')).toBeUndefined();
  });

  it('refuse a bad connection name, a connection without an area, and a default naming another area', () => {
    for (const bad of [
      { version: 2, connections: { Corp_Jira: { area: 'jira' } } },
      { version: 2, connections: { 'corp-jira': { baseUrl: 'x' } } },
      { version: 2, connections: { 'corp-db': { area: 'db' } }, defaults: { jira: { connection: 'corp-db' } } },
    ]) {
      writeJson(file(), bad);
      expect(() => load()).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', fix: expect.any(String) }));
    }
  });

  it('warn about top-level area keys, which belong under connections now', () => {
    writeJson(file(), { version: 2, jira: { baseUrl: 'x' } });
    expect(load().warnings.map((w) => w.code)).toEqual(['CONFIG_UNKNOWN_KEY']);
  });
});

describe('precedence', () => {
  it('TOIL_CONN_<NAME>_* beats TOIL_<AREA>_*, which beats the CI fallback, which beats the file', () => {
    writeJson(file(), { version: 2, connections: { gh: { area: 'github', token: 'file' } } });
    expect(load({ GITHUB_TOKEN: 'ci' }).connections.gh!.token).toBe('ci');
    expect(load({ GITHUB_TOKEN: 'ci', TOIL_GITHUB_TOKEN: 'area' }).connections.gh!.token).toBe('area');
    const config = load({ GITHUB_TOKEN: 'ci', TOIL_GITHUB_TOKEN: 'area', TOIL_CONN_GH_TOKEN: 'conn' });
    expect(config.connections.gh!.token).toBe('conn');
    expect(config.sources['gh.token']).toBe('env');
    expect(load({ GITHUB_TOKEN: 'ci' }).sources['gh.token']).toBe('ci');
  });

  it('TOIL_<AREA>_* sets the default connection only', () => {
    writeJson(file(), v2);
    const config = load({ TOIL_JIRA_TOKEN: 'env' });
    expect(config.connections['corp-jira']!.token).toBe('env');
    expect(config.connections['jira-sandbox']!.token).toBeUndefined();
  });

  it('TOIL_<AREA>_* creates a connection named after the area when there is none, as CI always could', () => {
    const config = load({ TOIL_JIRA_BASE_URL: 'https://jira.imagile.dev', TOIL_JIRA_WRITES: 'true' });
    expect(config.connections.jira).toEqual({ area: 'jira', baseUrl: 'https://jira.imagile.dev', writes: 'true' });
    expect(defaultConnectionName(config, 'jira')).toBe('jira');
    expect(anyWrites(config, 'jira')).toBe(true);
  });

  it('TOIL_<AREA>_* is ignored with a warning when the area has several connections and no default', () => {
    writeJson(file(), { version: 2, connections: { a: { area: 'db' }, b: { area: 'db' } } });
    const config = load({ TOIL_DB_HOST: 'h' });
    expect(config.connections.a!.host).toBeUndefined();
    expect(config.warnings.map((w) => w.code)).toEqual(['CONFIG_AMBIGUOUS_DEFAULT']);
  });

  it('ignores a .toil.json in the repository: it cannot enable writes or redirect credentials', () => {
    writeJson(file(), { jira: { baseUrl: 'https://jira.imagile.dev', token: 'secret' } });
    writeJson(join(repo, '.toil.json'), { jira: { baseUrl: 'https://other.example.com', writes: true } });
    const config = loadConfig({ env: {}, cwd: join(repo, 'packages', 'app'), home, areas });
    expect(config.connections.jira!.baseUrl).toBe('https://jira.imagile.dev');
    expect(anyWrites(config, 'jira')).toBe(false);
  });

  it('reads --config instead of the default global file', () => {
    const custom = join(root, 'custom.json');
    writeJson(custom, { db: { default: 'reporting' } });
    expect(loadConfig({ env: {}, cwd: repo, home, configPath: custom, areas }).connections.db!.default).toBe('reporting');
  });

  it('works with no config anywhere', () => {
    expect(load().connections).toEqual({});
  });
});

describe('connections from env vars alone', () => {
  it('TOIL_CONN_<NAME>_AREA creates a connection, and its other variables fill it in', () => {
    const config = load({ TOIL_CONN_OCP_PROD_AREA: 'jira', TOIL_CONN_OCP_PROD_BASE_URL: 'https://api.ocp.imagile.dev', TOIL_CONN_OCP_PROD_WRITES: 'false' });
    expect(config.connections['ocp-prod']).toEqual({ area: 'jira', baseUrl: 'https://api.ocp.imagile.dev', writes: 'false' });
    expect(anyWrites(config, 'jira')).toBe(false);
  });

  it('makes TOIL_<AREA>_* fill the env-only connection, not a second one', () => {
    const config = load({ TOIL_CONN_CI_AREA: 'jira', TOIL_JIRA_TOKEN: 'x' });
    expect(Object.keys(config.connections)).toEqual(['ci']);
    expect(config.connections.ci!.token).toBe('x');
  });

  it('keeps env values as strings, so a token that reads "true" stays a token', () => {
    expect(load({ TOIL_JIRA_TOKEN: 'true' }).connections.jira!.token).toBe('true');
  });

  it('warns about a connection for an area toil does not have', () => {
    const config = load({ TOIL_CONN_CI_AREA: 'jria', TOIL_CONN_CI_TOKEN: 'x' });
    expect(config.warnings.map((w) => w.code)).toEqual(['CONFIG_UNKNOWN_AREA']);
    expect(config.warnings[0]!.message).toContain('jria');
  });

  it('matches the longest connection name, so corp and corp-jira never collide', () => {
    writeJson(file(), { version: 2, connections: { corp: { area: 'db' }, 'corp-jira': { area: 'jira' } } });
    const config = load({ TOIL_CONN_CORP_JIRA_TOKEN: 't', TOIL_CONN_CORP_HOST: 'h' });
    expect(config.connections['corp-jira']!.token).toBe('t');
    expect(config.connections.corp!.host).toBe('h');
    expect(config.connections.corp!.jiraToken).toBeUndefined();
  });

  it('warns, and never guesses, for a variable naming no connection', () => {
    const config = load({ TOIL_CONN_NOPE_TOKEN: 't' });
    expect(config.connections).toEqual({});
    expect(config.warnings.map((w) => w.code)).toEqual(['CONFIG_UNKNOWN_CONNECTION']);
  });

  it('refuses an _AREA that contradicts the file', () => {
    writeJson(file(), v2);
    expect(() => load({ TOIL_CONN_CORP_JIRA_AREA: 'db' })).toThrow(ToilError);
  });
});

describe('config file versions', () => {
  it('refuses a file from a newer toil with an upgrade fix, rather than half-reading it', () => {
    writeJson(file(), { version: CONFIG_VERSION + 1, jira: { project: 'P' } });
    expect(() => load()).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', fix: expect.stringContaining('npm install -g @imagile-dev/toil@latest') }));
  });

  it('refuses a version that is not a whole number', () => {
    for (const version of ['1', 1.5, 0, null]) {
      writeJson(file(), { version, jira: {} });
      expect(() => load()).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    }
  });

  it('rejects invalid JSON and wrongly shaped files with a fix, never a TypeError', () => {
    writeFileSync(file(), '{ not json');
    expect(() => load()).toThrow(ToilError);
    writeJson(file(), { jira: 'https://jira.imagile.dev' });
    expect(() => load()).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', fix: expect.stringContaining('"jira"') }));
  });

  it('refuses a reserved key as a connection, area or default, in either version, and never reads a connection through one', () => {
    const conn = '{ "area": "jira", "baseUrl": "https://jira.imagile.dev" }';
    // Written as text: an object literal can't hold a __proto__ key.
    for (const text of [
      `{ "__proto__": { "jira": { "baseUrl": "https://jira.imagile.dev" } } }`,
      `{ "version": 2, "connections": { "__proto__": ${conn} } }`,
      `{ "version": 2, "connections": { "constructor": ${conn} } }`,
      `{ "version": 2, "connections": { "a": ${conn} }, "defaults": { "__proto__": { "jira": { "connection": "a" } } } }`,
    ]) {
      writeFileSync(file(), text);
      expect(() => load(), text).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', message: expect.stringContaining('reserved key') }));
    }
    writeFileSync(file(), `{ "version": 2, "connections": { "a": ${conn} } }`);
    expect(load().connections).not.toHaveProperty('constructor');
    expect(CONNECTION_NAME.test('constructor') || CONNECTION_NAME.test('prototype') || CONNECTION_NAME.test('__proto__')).toBe(false);
    expect(CONNECTION_NAME.test('constructors')).toBe(true);
  });
});

describe('env names', () => {
  it('map hyphenated areas by the longest known name', () => {
    expect(fromEnv({ TOIL_DEMO_CLOUD_TOKEN: 't', TOIL_JIRA_BASE_URL: 'https://jira.imagile.dev' }, knownAreas)).toEqual({
      'demo-cloud': { token: 't' },
      jira: { baseUrl: 'https://jira.imagile.dev' },
    });
  });

  it('reserve every TOIL_PROJECT* name, even if an area called toil project is registered', () => {
    expect(parseEnvName('TOIL_PROJECT_PATHS', ['toil-project', 'jira'])).toBeUndefined();
    expect(parseEnvName('TOIL_PROJECT', ['toil-project'])).toBeUndefined();
  });

  it('ignore names for areas toil does not know, and names toil reserves, instead of guessing', () => {
    expect(
      fromEnv({ TOIL_GITLAB_TOKEN: 'g', TOIL_CONN_JIRA_PROD_TOKEN: 'c', TOIL_PROJECT: 'payments', TOIL_ENV: 'prod', TOIL_CONFIG: '/x', TOIL_TIMEOUT_MS: '5', TOIL_JIRA_: 'x' }, knownAreas),
    ).toEqual({});
  });

  it('round-trip every (area, key), and name connection variables the same way', () => {
    for (const [area, key] of [['jira', 'baseUrl'], ['demo-cloud', 'apiToken'], ['db', 'writes']] as const) {
      expect(parseEnvName(envName(area, key), knownAreas)).toEqual({ area, key });
    }
    expect(envName('demo-cloud', 'baseUrl')).toBe('TOIL_DEMO_CLOUD_BASE_URL');
    expect(connectionEnvName('corp-jira', 'baseUrl')).toBe('TOIL_CONN_CORP_JIRA_BASE_URL');
  });
});

describe('editing the config file', () => {
  const path = () => join(home, '.toil', 'config.json');

  it('reads a missing file as an empty version 2 config', () => {
    expect(readConfigForEdit(join(home, '.toil', 'none.json'))).toEqual({ version: CONFIG_VERSION, connections: {}, defaults: {} });
  });

  it('round-trips a current-version file key for key, unknown keys included', () => {
    const content = { version: CONFIG_VERSION, extra: [1, 2], connections: { a: { area: 'jira', baseUrl: 'https://jira.imagile.dev', custom: { x: 1 } } }, defaults: { jira: { connection: 'a', pageSize: 5 } } };
    writeFileSync(path(), JSON.stringify(content));
    writeConfigFile(path(), readConfigForEdit(path()));
    expect(JSON.parse(readFileSync(path(), 'utf8'))).toEqual(content);
    expect(readdirSync(join(home, '.toil'))).toEqual(['config.json']);
  });

  it('refuses to upgrade a version 1 file whose "connections" or "defaults" key version 1 ignored', () => {
    writeFileSync(path(), JSON.stringify({ jira: { baseUrl: 'https://jira.imagile.dev' }, connections: { a: {} } }));
    expect(() => readConfigForEdit(path())).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', fix: expect.stringContaining('"connections"') }));
  });

  it('refuses a file from a newer toil, and never writes one it would refuse to load', () => {
    writeFileSync(path(), JSON.stringify({ version: CONFIG_VERSION + 1 }));
    expect(() => readConfigForEdit(path())).toThrow(ToilError);
    const target = join(home, '.toil', 'new.json');
    expect(() => writeConfigFile(target, { version: 2, connections: { Bad_Name: { area: 'jira' } }, defaults: {} })).toThrow(ToilError);
    expect(existsSync(target)).toBe(false);
  });
});

describe('bounds in the config file', () => {
  it('reads "bounds": { "files": "unbounded" } and says so in a warning, in version 1 and 2 files', () => {
    writeJson(file(), { version: 2, connections: {}, bounds: { files: 'unbounded' } });
    const config = load();
    expect(config.bounds).toEqual({ files: 'unbounded' });
    expect(config.warnings).toEqual([expect.objectContaining({ code: 'BOUND_RELAXED', message: expect.stringContaining('"bounds": { "files": "unbounded" }') })]);
    writeJson(file(), { jira: { baseUrl: 'https://jira.imagile.dev' }, bounds: { files: 'unbounded' } });
    expect(load().bounds).toEqual({ files: 'unbounded' });
    expect(Object.keys(load().connections)).toEqual(['jira']);
  });

  it('leaves every bound on when there is no bounds key, or files is "workspace"', () => {
    writeJson(file(), { version: 2, connections: {} });
    expect(load().bounds).toBeUndefined();
    writeJson(file(), { version: 2, connections: {}, bounds: { files: 'workspace' } });
    expect(load().warnings).toEqual([]);
  });

  it('refuses a bound that cannot be relaxed, a typo, and a wrong value, rather than ignoring them', () => {
    for (const bounds of [{ ownFiles: 'off' }, { file: 'unbounded' }, { files: 'anywhere' }, 'unbounded']) {
      writeJson(file(), { version: 2, connections: {}, bounds });
      expect(() => load(), JSON.stringify(bounds)).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', fix: expect.stringContaining('No other bound can be relaxed') }));
    }
  });

  it('cannot be relaxed from env', () => {
    writeJson(file(), { version: 2, connections: {} });
    expect(load({ TOIL_BOUNDS_FILES: 'unbounded', TOIL_WORKSPACE: '/tmp' }).bounds).toBeUndefined();
    expect(parseEnvName('TOIL_WORKSPACE', ['workspace'])).toBeUndefined();
  });

  it('survives an edit that upgrades a version 1 file', () => {
    writeJson(file(), { jira: { baseUrl: 'https://jira.imagile.dev' }, bounds: { files: 'unbounded' } });
    expect(readConfigForEdit(file()).bounds).toEqual({ files: 'unbounded' });
  });
});

describe('wait in the config file', () => {
  it('reads "wait": { "maxTimeout" } as milliseconds, in version 1 and 2 files, and keeps it through an edit', () => {
    writeJson(file(), { version: 2, connections: {}, wait: { maxTimeout: '2h' } });
    expect(load().wait).toEqual({ maxTimeoutMs: 7_200_000 });
    writeJson(file(), { jira: { baseUrl: 'https://jira.imagile.dev' }, wait: { maxTimeout: '90m' } });
    expect(load().wait).toEqual({ maxTimeoutMs: 5_400_000 });
    expect(Object.keys(load().connections)).toEqual(['jira']);
    expect(readConfigForEdit(file()).wait).toEqual({ maxTimeout: '90m' });
  });

  it('refuses a wrong shape, an unknown key and a duration outside 1m to 24h', () => {
    for (const wait of ['2h', { maxTimeout: 7200 }, { maxTimeout: '30s' }, { maxTimeout: '25h' }, { maxTimout: '2h' }]) {
      writeJson(file(), { version: 2, connections: {}, wait });
      expect(() => load(), JSON.stringify(wait)).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', fix: expect.stringContaining('"wait": { "maxTimeout": "2h" }') }));
    }
  });
});

describe('projectPaths in the config file', () => {
  it('reads absolute folders from a version 2 file, and is never read as an area', () => {
    const folder = join(home, 'team-toil-projects');
    writeJson(file(), { version: 2, connections: {}, projectPaths: [folder] });
    const config = load();
    expect(config.projectPaths).toEqual([folder]);
    expect(config.connections).toEqual({});
    expect(config.warnings).toEqual([]);
  });

  it('refuses anything but a list of absolute paths', () => {
    for (const bad of ['C:/x', ['relative/dir'], [1]]) {
      writeJson(file(), { version: 2, connections: {}, projectPaths: bad });
      expect(() => load(), JSON.stringify(bad)).toThrow(/"projectPaths" .* must be a list of absolute folder paths/);
    }
  });

  it('ignores it in a version 1 file with a warning, and refuses to upgrade such a file silently', () => {
    writeJson(file(), { jira: { baseUrl: 'https://jira.imagile.dev' }, projectPaths: [join(home, 'x')] });
    const config = load();
    expect(config.projectPaths).toBeUndefined();
    expect(Object.keys(config.connections)).toEqual(['jira']);
    expect(config.warnings.map((w) => w.code)).toEqual(['CONFIG_RESERVED_KEY']);
    expect(() => readConfigForEdit(file())).toThrow(/"projectPaths" key, which version 1 ignores/);
  });
});
