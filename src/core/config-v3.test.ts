import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConnectionName, loadConfig, parseEnvName, readConfigForEdit, writeConfigFile, type AreaInfo } from './config.js';

/**
 * Config version 3 (#495): `jira-cloud` became `jira` with `"deployment":
 * "cloud"` on the connection. Every way the old name could still arrive is
 * either folded into the new one or refused with the new form.
 */

let root: string;
let home: string;
let repo: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'toil-config-v3-'));
  home = join(root, 'home');
  repo = join(root, 'work', 'repo');
  mkdirSync(join(home, '.toil'), { recursive: true });
  mkdirSync(join(repo, '.git'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const file = () => join(home, '.toil', 'config.json');
const writeJson = (value: unknown) => writeFileSync(file(), JSON.stringify(value));
const areas: AreaInfo[] = [{ name: 'jira' }, { name: 'confluence' }, { name: 'db' }];
const load = (env: NodeJS.ProcessEnv = {}) => loadConfig({ env, cwd: repo, home, areas });

const cloud = { area: 'jira-cloud', baseUrl: 'https://jira-cloud.imagile.dev', email: 'you@example.com', apiToken: 'keychain:imagile-cloud.apiToken' };

describe('version 3: jira-cloud became jira with deployment cloud', () => {
  it('reads a version 2 file with a jira-cloud connection as a jira connection with deployment cloud, keychain reference untouched', () => {
    writeJson({ version: 2, connections: { 'imagile-cloud': cloud }, defaults: { 'jira-cloud': { connection: 'imagile-cloud', project: 'PROJ' } } });
    const config = load();
    expect(config.connections['imagile-cloud']).toEqual({ ...cloud, area: 'jira', deployment: 'cloud' });
    expect(config.defaults).toEqual({ jira: { connection: 'imagile-cloud', project: 'PROJ' } });
    expect(defaultConnectionName(config, 'jira')).toBe('imagile-cloud');
    expect(config.warnings).toEqual([]);
  });

  it('reads a version 1 file with a jira-cloud key the same way, the connection keeping its name', () => {
    writeJson({ 'jira-cloud': { baseUrl: 'https://jira-cloud.imagile.dev', email: 'you@example.com' } });
    const config = load();
    expect(config.connections['jira-cloud']).toMatchObject({ area: 'jira', deployment: 'cloud' });
    expect(defaultConnectionName(config, 'jira')).toBe('jira-cloud');
  });

  it("keeps jira's default when both named one, and names the one it dropped", () => {
    writeJson({
      version: 2,
      connections: { 'corp-jira': { area: 'jira', baseUrl: 'https://jira.imagile.dev' }, 'imagile-cloud': cloud },
      defaults: { jira: { connection: 'corp-jira' }, 'jira-cloud': { connection: 'imagile-cloud' } },
    });
    const config = load();
    expect(defaultConnectionName(config, 'jira')).toBe('corp-jira');
    expect(config.warnings).toEqual([expect.objectContaining({ code: 'CONFIG_DEFAULT_KEPT', message: expect.stringContaining('"imagile-cloud"') })]);
    expect(config.warnings[0]!.message).toContain('corp-jira');
    expect(config.warnings[0]!.message).toContain('toil connections migrate');
    expect(config.warnings[0]!.message).toContain('version 4');
  });

  it("doesn't let a Cloud default reach Data Center connections: it moves onto the Cloud connections instead", () => {
    writeJson({
      version: 2,
      connections: { 'corp-jira': { area: 'jira', baseUrl: 'https://jira.imagile.dev' }, 'imagile-cloud': cloud },
      defaults: { 'jira-cloud': { connection: 'imagile-cloud', project: 'CLD' } },
    });
    const config = load();
    expect(config.defaults.jira).toEqual({ connection: 'corp-jira' });
    expect(config.connections['imagile-cloud']).toMatchObject({ project: 'CLD' });
    expect(config.connections['corp-jira']).not.toHaveProperty('project');
    // jira had a connection, which was what `toil jira` used and still is; the warning says the Cloud default was set aside.
    expect(defaultConnectionName(config, 'jira')).toBe('corp-jira');
    expect(config.warnings.map((w) => w.code)).toEqual(['CONFIG_DEFAULT_KEPT']);
  });

  it("doesn't let Data Center defaults reach the connections that moved in: they are written onto the Data Center connections instead", () => {
    writeJson({
      version: 2,
      connections: { 'corp-jira': { area: 'jira', baseUrl: 'https://jira.imagile.dev', priority: 'High' }, 'other-jira': { area: 'jira', baseUrl: 'https://jira2.imagile.dev' }, 'imagile-cloud': cloud },
      defaults: { jira: { connection: 'corp-jira', project: 'DC', priority: 'Low' }, 'jira-cloud': { connection: 'imagile-cloud' } },
    });
    const config = load();
    expect(config.defaults.jira).toEqual({ connection: 'corp-jira' });
    expect(config.connections['corp-jira']).toMatchObject({ project: 'DC', priority: 'High' });
    expect(config.connections['other-jira']).toMatchObject({ project: 'DC', priority: 'Low' });
    expect(config.connections['imagile-cloud']).not.toHaveProperty('project');
    expect(config.connections['imagile-cloud']).not.toHaveProperty('priority');
  });

  it('leaves defaults.jira alone when no connection moves in', () => {
    writeJson({ version: 2, connections: { 'corp-jira': { area: 'jira', baseUrl: 'https://jira.imagile.dev' } }, defaults: { jira: { connection: 'corp-jira', project: 'DC' } } });
    expect(load().defaults.jira).toEqual({ connection: 'corp-jira', project: 'DC' });
  });

  it('is what an edit writes back: version 4, folded, other keys kept', () => {
    writeJson({ version: 2, extra: 1, connections: { 'imagile-cloud': cloud }, defaults: { 'jira-cloud': { connection: 'imagile-cloud' } } });
    const edit = readConfigForEdit(file());
    expect(edit).toEqual({ version: 4, extra: 1, connections: { 'imagile-cloud': { ...cloud, area: 'jira', deployment: 'cloud' } }, defaults: { jira: { connection: 'imagile-cloud' } } });
    writeConfigFile(file(), edit);
    expect(load().connections['imagile-cloud']).toMatchObject({ area: 'jira', deployment: 'cloud' });
  });

  it('folds a version 3 file that still names the old area, with a warning that gives the new form', () => {
    writeJson({ version: 3, connections: { old: { ...cloud, area: 'jira-cloud' } }, defaults: { 'jira-cloud': { connection: 'old' } } });
    const config = load();
    expect(config.connections.old).toEqual({ ...cloud, area: 'jira', deployment: 'cloud' });
    expect(defaultConnectionName(config, 'jira')).toBe('old');
    const warning = config.warnings.find((w) => w.code === 'CONFIG_RENAMED_AREA')!;
    expect(warning.message).toContain('jira-cloud is now jira');
    expect(warning.message).toContain('TOIL_JIRA_DEPLOYMENT=cloud');
    expect(warning.message).toContain('connection old');
  });

  it('refuses TOIL_JIRA_CLOUD_* env vars, naming TOIL_JIRA_* with TOIL_JIRA_DEPLOYMENT=cloud, rather than ignoring a credential', () => {
    expect(() => load({ TOIL_JIRA_CLOUD_API_TOKEN: 't', TOIL_JIRA_CLOUD_EMAIL: 'you@example.com' })).toThrow(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        message: expect.stringContaining('TOIL_JIRA_CLOUD_API_TOKEN'),
        fix: expect.stringContaining('TOIL_JIRA_API_TOKEN and set TOIL_JIRA_DEPLOYMENT=cloud'),
      }),
    );
    expect(() => load({ TOIL_JIRA_BASE_URL: 'https://jira.imagile.dev' })).not.toThrow();
  });

  it('refuses TOIL_CONN_<NAME>_AREA=jira-cloud, naming the area and the deployment to set', () => {
    expect(() => load({ TOIL_CONN_CI_AREA: 'jira-cloud' })).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', fix: expect.stringContaining('TOIL_CONN_CI_AREA=jira, and TOIL_CONN_CI_DEPLOYMENT=cloud') }));
  });

  it('defines a Cloud connection from env alone with TOIL_CONN_<NAME>_DEPLOYMENT=cloud, and the default one with TOIL_JIRA_DEPLOYMENT=cloud', () => {
    const named = load({ TOIL_CONN_CI_AREA: 'jira', TOIL_CONN_CI_DEPLOYMENT: 'cloud', TOIL_CONN_CI_EMAIL: 'you@example.com' });
    expect(named.connections.ci).toMatchObject({ area: 'jira', deployment: 'cloud', email: 'you@example.com' });
    const byArea = load({ TOIL_JIRA_DEPLOYMENT: 'cloud', TOIL_JIRA_EMAIL: 'you@example.com' });
    expect(byArea.connections.jira).toMatchObject({ area: 'jira', deployment: 'cloud' });
  });
});

describe('TOIL_JIRA_* reaching a connection that is Cloud', () => {
  const migrated = { version: 2, connections: { 'imagile-cloud': cloud }, defaults: { 'jira-cloud': { connection: 'imagile-cloud' } } };

  it('refuses them when the jira default is Cloud and TOIL_JIRA_DEPLOYMENT is unset, naming the variables, the fix and sending nothing', () => {
    writeJson(migrated);
    expect(() => load({ TOIL_JIRA_API_TOKEN: 'dc-pat', TOIL_JIRA_BASE_URL: 'https://jira.imagile.dev' })).toThrow(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        message: expect.stringMatching(/TOIL_JIRA_API_TOKEN, TOIL_JIRA_BASE_URL are set.*"imagile-cloud".*deployment cloud/),
        fix: expect.stringContaining('TOIL_JIRA_DEPLOYMENT=cloud'),
      }),
    );
    try {
      load({ TOIL_JIRA_API_TOKEN: 'dc-pat' });
    } catch (err) {
      expect(JSON.stringify(err)).not.toContain('dc-pat');
      expect((err as { fix: string }).fix).toContain('TOIL_CONN_<NAME>_AREA=jira');
    }
  });

  it('also refuses when the deployment is only in defaults.jira', () => {
    writeJson({ version: 3, connections: { j: { area: 'jira', baseUrl: 'https://jira-cloud.imagile.dev', email: 'you@example.com' } }, defaults: { jira: { connection: 'j', deployment: 'cloud' } } });
    expect(() => load({ TOIL_JIRA_API_TOKEN: 't' })).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('lets them through with TOIL_JIRA_DEPLOYMENT=cloud', () => {
    writeJson(migrated);
    const config = load({ TOIL_JIRA_API_TOKEN: 't', TOIL_JIRA_DEPLOYMENT: 'cloud' });
    expect(config.connections['imagile-cloud']).toMatchObject({ apiToken: 't', deployment: 'cloud' });
  });

  it('leaves TOIL_CONN_<NAME>_* alone, and a Data Center default, and a file with no env at all', () => {
    writeJson(migrated);
    expect(() => load({ TOIL_CONN_IMAGILE_CLOUD_API_TOKEN: 't' })).not.toThrow();
    expect(() => load()).not.toThrow();
    writeJson({ version: 3, connections: { dc: { area: 'jira', baseUrl: 'https://jira.imagile.dev' } }, defaults: { jira: { connection: 'dc' } } });
    expect(() => load({ TOIL_JIRA_API_TOKEN: 't' })).not.toThrow();
  });
});

describe('empty retired variables, and TOIL_STRICT_ENV', () => {
  it('skips an empty TOIL_JIRA_CLOUD_* by default, and still refuses one with a value', () => {
    expect(() => load({ TOIL_JIRA_CLOUD_API_TOKEN: '' })).not.toThrow();
    expect(() => load({ TOIL_JIRA_CLOUD_API_TOKEN: '', TOIL_JIRA_CLOUD_EMAIL: 'you@example.com' })).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', message: expect.stringContaining('TOIL_JIRA_CLOUD_EMAIL') }));
  });

  it('with TOIL_STRICT_ENV=true refuses an empty one too, with the same fix, and the variable maps onto no area', () => {
    expect(() => load({ TOIL_JIRA_CLOUD_API_TOKEN: '', TOIL_STRICT_ENV: 'true' })).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID', message: expect.stringContaining('TOIL_JIRA_CLOUD_API_TOKEN'), fix: expect.stringContaining('TOIL_JIRA_API_TOKEN and set TOIL_JIRA_DEPLOYMENT=cloud') }),
    );
    expect(() => load({ TOIL_JIRA_CLOUD_API_TOKEN: '', TOIL_STRICT_ENV: 'false' })).not.toThrow();
    expect(parseEnvName('TOIL_STRICT_ENV', ['jira'])).toBeUndefined();
  });
});

describe('confluence-cloud became confluence with deployment cloud', () => {
  const wiki = { area: 'confluence-cloud', baseUrl: 'https://confluence-cloud.imagile.dev', email: 'you@example.com', apiToken: 'keychain:wiki-cloud.apiToken' };
  const folded = { ...wiki, area: 'confluence', deployment: 'cloud' };

  it('folds a version 2 file quietly, keychain reference untouched', () => {
    writeJson({ version: 2, connections: { 'wiki-cloud': wiki }, defaults: { 'confluence-cloud': { connection: 'wiki-cloud' } } });
    const config = load();
    expect(config.connections['wiki-cloud']).toEqual(folded);
    expect(defaultConnectionName(config, 'confluence')).toBe('wiki-cloud');
    expect(config.defaults).toEqual({ confluence: { connection: 'wiki-cloud' } });
    expect(config.warnings).toEqual([]);
  });

  it('folds a version 3 file, which an earlier build of this change could still write, with a warning', () => {
    writeJson({ version: 3, connections: { 'wiki-cloud': wiki }, defaults: { 'confluence-cloud': { connection: 'wiki-cloud' } } });
    const config = load();
    expect(config.connections['wiki-cloud']).toEqual(folded);
    expect(defaultConnectionName(config, 'confluence')).toBe('wiki-cloud');
    expect(config.defaults).not.toHaveProperty('confluence-cloud');
    const warning = config.warnings.find((w) => w.code === 'CONFIG_RENAMED_AREA')!;
    expect(warning.message).toContain('confluence-cloud is now confluence');
    expect(warning.message).toContain('TOIL_CONFLUENCE_DEPLOYMENT=cloud');
    expect(warning.message).toContain('connection wiki-cloud');
    expect(warning.message).toContain('defaults.confluence-cloud');
  });

  it('keeps the Data Center default beside a folded Cloud connection', () => {
    writeJson({
      version: 3,
      connections: { 'corp-wiki': { area: 'confluence', baseUrl: 'https://confluence.imagile.dev' }, 'wiki-cloud': wiki },
      defaults: { confluence: { connection: 'corp-wiki' }, 'confluence-cloud': { connection: 'wiki-cloud' } },
    });
    const config = load();
    expect(defaultConnectionName(config, 'confluence')).toBe('corp-wiki');
    expect(config.warnings.map((w) => w.code).sort()).toEqual(['CONFIG_DEFAULT_KEPT', 'CONFIG_RENAMED_AREA']);
  });

  it('folding twice changes nothing: what an edit writes back loads clean and reads back the same', () => {
    writeJson({ version: 3, connections: { 'wiki-cloud': wiki, 'imagile-cloud': cloud }, defaults: { 'confluence-cloud': { connection: 'wiki-cloud' }, 'jira-cloud': { connection: 'imagile-cloud' } } });
    const once = readConfigForEdit(file());
    expect(once).toEqual({
      version: 4,
      connections: { 'wiki-cloud': folded, 'imagile-cloud': { ...cloud, area: 'jira', deployment: 'cloud' } },
      defaults: { confluence: { connection: 'wiki-cloud' }, jira: { connection: 'imagile-cloud' } },
    });
    writeConfigFile(file(), once);
    const config = load();
    expect(config.warnings).toEqual([]);
    expect(readConfigForEdit(file())).toEqual(once);
  });

  it('refuses TOIL_CONFLUENCE_CLOUD_* env vars and TOIL_CONN_<NAME>_AREA=confluence-cloud, naming the new form', () => {
    expect(() => load({ TOIL_CONFLUENCE_CLOUD_API_TOKEN: 't' })).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', fix: expect.stringContaining('TOIL_CONFLUENCE_API_TOKEN and set TOIL_CONFLUENCE_DEPLOYMENT=cloud') }));
    expect(() => load({ TOIL_CONN_CI_AREA: 'confluence-cloud' })).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', fix: expect.stringContaining('TOIL_CONN_CI_AREA=confluence, and TOIL_CONN_CI_DEPLOYMENT=cloud') }));
  });

  it('refuses stale TOIL_CONFLUENCE_* on a Cloud default, and lets them through with TOIL_CONFLUENCE_DEPLOYMENT=cloud', () => {
    writeJson({ version: 3, connections: { 'wiki-cloud': folded }, defaults: { confluence: { connection: 'wiki-cloud' } } });
    expect(() => load({ TOIL_CONFLUENCE_API_TOKEN: 'dc-pat' })).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', fix: expect.stringContaining('TOIL_CONFLUENCE_DEPLOYMENT=cloud') }));
    expect(load({ TOIL_CONFLUENCE_API_TOKEN: 't', TOIL_CONFLUENCE_DEPLOYMENT: 'cloud' }).connections['wiki-cloud']).toMatchObject({ apiToken: 't' });
  });
});
