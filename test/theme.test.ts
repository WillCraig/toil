import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, parseEnvName } from '../src/core/config.js';
import { gatherWelcomeData } from '../src/welcome/data.js';
import { areas } from '../src/registry.js';
import { clearConnectionEnv } from './harness/hermetic-env.js';
import { sharedStore } from './harness/shared-store.js';

vi.mock('../src/core/keychain.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/keychain.js')>()),
  createSecretStore: () => sharedStore,
}));

const { execute, registry } = await import('../src/api.js');

/**
 * `toil theme list | set` and the `"theme"` setting (#427): one theme in
 * ~/.toil/config.json for the welcome menu and Toil UI, TOIL_THEME over it,
 * Crate when neither says (#467). Each test has its own home.
 */

let home: string;
const configFile = () => join(home, '.toil', 'config.json');
const writeConfig = (value: unknown) => {
  mkdirSync(join(home, '.toil'), { recursive: true });
  writeFileSync(configFile(), JSON.stringify(value));
};
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'toil-theme-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('TOIL_THEME', '');
  clearConnectionEnv(areas);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('the config loader', () => {
  const load = (env: NodeJS.ProcessEnv = {}) => loadConfig({ env, cwd: home, home, areas });

  it('reads "theme" from a version 2 file without warning about it', () => {
    writeConfig({ version: 2, connections: {}, defaults: {}, theme: 'realm' });
    const config = load();
    expect(config.theme).toEqual({ name: 'realm', source: 'global' });
    expect(config.warnings).toEqual([]);
  });

  it('lets TOIL_THEME override the file', () => {
    writeConfig({ version: 2, theme: 'realm' });
    expect(load({ TOIL_THEME: 'starship' }).theme).toEqual({ name: 'starship', source: 'env' });
  });

  it('refuses a theme that is not a name, saying how to set one', () => {
    writeConfig({ version: 2, theme: 42 });
    expect(() => load()).toThrow(/"theme" .* must be a theme's name/);
  });

  it('ignores "theme" in a version 1 file, saying it needs version 2', () => {
    writeConfig({ theme: 'realm' });
    const config = load();
    expect(config.theme).toBeUndefined();
    expect(config.warnings.map((w) => w.code)).toEqual(['CONFIG_RESERVED_KEY']);
  });

  it('keeps TOIL_THEME for itself: it never maps onto an area', () => {
    expect(parseEnvName('TOIL_THEME', areas.map((a) => a.name))).toBeUndefined();
  });
});

describe('toil theme list', () => {
  it('lists every theme, with Crate in effect by default and marked as the default', async () => {
    const env = await execute('theme list', {}, { readOnly: true });
    expect(env.ok).toBe(true);
    const data = env.data as { current: string; source: string; default: string; themes: Array<{ name: string; current: boolean; default: boolean }> };
    expect(data.current).toBe('crate');
    expect(data.source).toBe('default');
    expect(data.default).toBe('crate');
    expect(data.themes.map((t) => t.name)).toEqual(['plain', 'crate', 'harvest', 'starship', 'realm', 'sprawl', 'frontier', 'overworld']);
    expect(data.themes.filter((t) => t.current).map((t) => t.name)).toEqual(['crate']);
    expect(data.themes.filter((t) => t.default).map((t) => t.name)).toEqual(['crate']);
  });

  it('keeps Plain for a config that already chose it, and lets TOIL_THEME choose it too', async () => {
    writeConfig({ version: 2, theme: 'plain' });
    expect((await execute('theme list', {}, { readOnly: true })).data).toMatchObject({ current: 'plain', source: 'file', default: 'crate' });
    rmSync(configFile());
    vi.stubEnv('TOIL_THEME', 'plain');
    expect((await execute('theme list', {}, { readOnly: true })).data).toMatchObject({ current: 'plain', source: 'env' });
  });

  it('marks the theme from the file, and TOIL_THEME over it', async () => {
    writeConfig({ version: 2, theme: 'realm' });
    expect((await execute('theme list', {}, { readOnly: true })).data).toMatchObject({ current: 'realm', source: 'file' });
    vi.stubEnv('TOIL_THEME', 'harvest');
    expect((await execute('theme list', {}, { readOnly: true })).data).toMatchObject({ current: 'harvest', source: 'env' });
  });

  it("says so when the theme set is one toil doesn't have, and shows the default", async () => {
    vi.stubEnv('TOIL_THEME', 'vaporwave');
    const env = await execute('theme list', {}, { readOnly: true });
    expect(env.data).toMatchObject({ current: 'crate', source: 'default' });
    expect(env.meta.warnings?.[0]).toMatchObject({ code: 'THEME_UNKNOWN', message: expect.stringContaining('TOIL_THEME is "vaporwave"') });
    expect(env.meta.warnings?.[0]?.message).toContain('so Crate, the default, shows instead');
  });
});

describe('the welcome menu', () => {
  const welcomeTheme = (env: NodeJS.ProcessEnv = {}) =>
    gatherWelcomeData({ version: '0.0.0', env, cwd: home, home, areas, catalog: [], mcpAreas: [], script: undefined }).theme?.name;

  it('opens in Crate with nothing set, Plain for a config that chose it, and TOIL_THEME over both', () => {
    expect(welcomeTheme()).toBe('crate');
    writeConfig({ version: 2, theme: 'plain' });
    expect(welcomeTheme()).toBe('plain');
    expect(welcomeTheme({ TOIL_THEME: 'realm' })).toBe('realm');
  });
});

describe('toil theme set', () => {
  it('writes "theme" and keeps every other key as it was', async () => {
    writeConfig({ version: 2, connections: {}, defaults: {}, projectPaths: [], game: { sealed: 'x' } });
    const env = await execute('theme set', { name: 'realm' });
    expect(env.ok).toBe(true);
    expect(env.data).toMatchObject({ theme: 'realm', label: 'Realm', previous: null, changed: true });
    expect(JSON.parse(readFileSync(configFile(), 'utf8'))).toEqual({ version: 4, connections: {}, defaults: {}, projectPaths: [], game: { sealed: 'x' }, theme: 'realm' });
    expect((await execute('theme set', { name: 'realm' })).data).toMatchObject({ previous: 'realm', changed: false });
  });

  it('creates the file when there is none', async () => {
    await execute('theme set', { name: 'crate' });
    expect(JSON.parse(readFileSync(configFile(), 'utf8'))).toMatchObject({ version: 4, theme: 'crate' });
  });

  it('refuses a theme toil does not have, listing the themes', async () => {
    const env = await execute('theme set', { name: 'vaporwave' });
    expect(env.ok).toBe(false);
    expect(env.error).toMatchObject({ code: 'INVALID_INPUT', fix: 'Use one of: plain, crate, harvest, starship, realm, sprawl, frontier, overworld.' });
  });

  it('is refused under readOnly, and writes nothing', async () => {
    const env = await execute('theme set', { name: 'realm' }, { readOnly: true });
    expect(env.ok).toBe(false);
    expect(() => readFileSync(configFile(), 'utf8')).toThrow();
  });

  it('says when TOIL_THEME will still win', async () => {
    vi.stubEnv('TOIL_THEME', 'starship');
    const env = await execute('theme set', { name: 'realm' });
    expect(env.meta.warnings?.map((w) => w.code)).toEqual(['OVERRIDDEN_BY_ENV']);
  });

  it('declares its local write, and list declares none', () => {
    const info = (name: string) => registry.commands.find((c) => c.name === name);
    expect(info('theme set')).toMatchObject({ kind: 'config', writes: false, writesLocal: true });
    expect(info('theme list')).toMatchObject({ kind: 'config', writes: false, writesLocal: false });
  });
});

describe('a theme never reaches what an agent or a script reads', () => {
  it('gives the same envelope, errors included, whatever the theme', async () => {
    const strip = (e: Awaited<ReturnType<typeof execute>>) => ({ ...e, meta: { ...e.meta, durationMs: 0 } });
    const calls: Array<[string, Record<string, unknown>]> = [['connections list', {}], ['version', {}], ['projects show', { toilProject: 'missing' }]];
    const plain = await Promise.all(calls.map(([c, i]) => execute(c, i, { readOnly: true }).then(strip)));
    vi.stubEnv('TOIL_THEME', 'realm');
    const realm = await Promise.all(calls.map(([c, i]) => execute(c, i, { readOnly: true }).then(strip)));
    expect(realm).toEqual(plain);
  });
});
