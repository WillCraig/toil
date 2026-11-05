import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { CONNECTION_FIELD, CORE_FIELDS } from '../src/core/area.js';
import { envName } from '../src/core/config.js';
import { aliasPaths, servedOverMcp, takesAllowWrite, toolName } from '../src/core/command.js';
import { providers } from '../src/core/db/engines.js';
import { areas, commands } from '../src/registry.js';

/**
 * The site's per-integration docs pages list each area's real commands. The
 * site is its own package and can't import the registry, so this test writes
 * the lists it reads: site/src/data/commands/<area>.json, one file per area so
 * parallel integrations each write their own. A command added, renamed or
 * re-described without regenerating fails here; `npx vitest run -u` rewrites
 * the files. Each area's connection settings go the same way, to
 * site/src/data/settings/<area>.json, so its page lists every key it reads,
 * not only the credential. One source per fact, and a clerk who checks it. The board's own
 * per-area files (site/src/data/integrations/<area>.json) are checked here too,
 * since status honesty depends on which areas the registry has. The database
 * engines go the same way, to site/src/data/databases.json, so /connect/ lists
 * each engine at its own level beside the integrations.
 */
/**
 * `tool` is null for a command MCP never serves (a `cli-only` one, or an area
 * command marked `mcp: false`), so the page can say it's CLI only. `connection`
 * says whether it takes `--connection`. `aliases` lists the other CLI paths it
 * answers at (`jwt decode` for `util jwt decode`), and is absent when there are none.
 */
export type SiteCommand = { name: string; tool: string | null; description: string; writes: boolean; connection: boolean; flags: string[]; aliases?: string[] };

export function siteCommands(): Record<string, SiteCommand[]> {
  const out: Record<string, SiteCommand[]> = {};
  for (const def of commands) {
    if (def.path.length < 2) continue;
    const flags = [
      ...(def.args ?? []).map((a) => (a.required === false ? `[${a.name}${a.variadic ? '...' : ''}]` : `<${a.name}${a.variadic ? '...' : ''}>`)),
      // Core's own per-call inputs (--connection, --toil-project, --cwd) are documented once, not on every command.
      ...(def.options ?? []).filter((o) => !(def.area && CORE_FIELDS.includes(o.field))).map((o) => o.flags),
      ...(takesAllowWrite(def) ? ['--allow-write'] : []),
    ];
    const connection = (def.options ?? []).some((o) => o.field === CONNECTION_FIELD);
    const aliases = aliasPaths(def).map((a) => a.join(' '));
    (out[def.path[0]] ??= []).push({ name: def.path.slice(1).join(' '), tool: servedOverMcp(def) ? toolName(def) : null, description: def.description, writes: takesAllowWrite(def), connection, flags, ...(aliases.length ? { aliases } : {}) });
  }
  return out;
}

/** One connection setting, for the Configuration section of an area's docs page. */
export type SiteSetting = { key: string; env: string; description: string; required: boolean; secret: boolean; fallbacks: string[] };

/** Every key an area's connection takes, in schema order, with its env var and any CI fallback. */
export function siteSettings(): Record<string, SiteSetting[]> {
  const out: Record<string, SiteSetting[]> = {};
  for (const area of areas) {
    const fallbacks = (area.fallbacks ?? {}) as Record<string, string[] | undefined>;
    out[area.name] = Object.entries(area.connection.shape as Record<string, z.ZodType>).map(([key, schema]) => ({
      key,
      env: envName(area.name, key),
      description: schema.description ?? '',
      required: !schema.safeParse(undefined).success,
      secret: (area.secrets as readonly string[]).includes(key),
      fallbacks: fallbacks[key] ?? [],
    }));
  }
  return out;
}

const dir = join(import.meta.dirname, '..', 'site', 'src', 'data', 'commands');
const settingsDir = join(import.meta.dirname, '..', 'site', 'src', 'data', 'settings');
const boardDir = join(import.meta.dirname, '..', 'site', 'src', 'data', 'integrations');
const GROUPS = ['trackers', 'source', 'cicd', 'testing', 'security', 'observability', 'docs'];
const levels = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'site', 'src', 'data', 'levels.json'), 'utf8')) as Array<{ name: string; meaning: string; localMeaning?: string }>;
const STATUSES = levels.map((l) => l.name);
const lists = siteCommands();
const settings = siteSettings();

describe('site command reference', () => {
  for (const [area, list] of Object.entries(lists)) {
    it(`site/src/data/commands/${area}.json matches the registry`, async () => {
      await expect(`${JSON.stringify(list, null, 2)}\n`).toMatchFileSnapshot(join(dir, `${area}.json`));
    });
  }

  for (const [area, list] of Object.entries(settings)) {
    it(`site/src/data/settings/${area}.json matches the area's connection schema`, async () => {
      await expect(`${JSON.stringify(list, null, 2)}
`).toMatchFileSnapshot(join(settingsDir, `${area}.json`));
    });
  }

  it('defines exactly the three verification levels, each with its meaning', () => {
    expect(STATUSES).toEqual(['unit', 'live', 'stable']);
    for (const level of levels) expect(level.meaning, level.name).toMatch(/\S/);
  });

  it('site/src/data/databases.json matches the database providers', async () => {
    const engines = providers.map((p) => ({ engine: p.engine, label: p.label, verification: p.verification }));
    await expect(`${JSON.stringify(engines, null, 2)}\n`).toMatchFileSnapshot(join(import.meta.dirname, '..', 'site', 'src', 'data', 'databases.json'));
  });

  it('gives every database provider, and nothing else, a sign-in and a section of db.md for /connect/', () => {
    const signIn = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'site', 'src', 'data', 'db-sign-in.json'), 'utf8')) as Record<string, { signIn: string; section: string }>;
    expect(Object.keys(signIn).sort()).toEqual(providers.map((p) => p.engine).sort());
    for (const [engine, entry] of Object.entries(signIn)) {
      expect(entry.signIn, engine).toMatch(/\S/);
      expect(entry.section, engine).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('gives every database provider one of the levels', () => {
    for (const provider of providers) expect(STATUSES, provider.engine).toContain(provider.verification);
  });

  it("states each database provider's level in skills/toil/db.md", () => {
    const skill = readFileSync(join(import.meta.dirname, '..', 'skills', 'toil', 'db.md'), 'utf8');
    for (const provider of providers) {
      const row = skill.split('\n').find((line) => line.startsWith('|') && line.includes(`| \`${provider.engine}\` |`));
      expect(row, `db.md has no engine row for ${provider.engine}`).toBeDefined();
      expect(row, provider.engine).toContain(`| \`${provider.verification}\`:`);
    }
  });

  it('lists only registered areas on the board, each at a verification level', () => {
    const registered = new Set(areas.map((a) => a.name));
    const wrong: string[] = [];
    for (const file of readdirSync(boardDir).filter((f) => f.endsWith('.json'))) {
      const entry = JSON.parse(readFileSync(join(boardDir, file), 'utf8')) as Record<string, unknown>;
      const where = `site/src/data/integrations/${file}`;
      if (`${String(entry.area)}.json` !== file) wrong.push(`${where}: "area" must match the file name`);
      for (const key of ['name', 'covers', 'credential']) if (typeof entry[key] !== 'string' || entry[key] === '') wrong.push(`${where}: needs "${key}"`);
      if (!GROUPS.includes(entry.group as string)) wrong.push(`${where}: "group" is one of ${GROUPS.join(', ')}`);
      if (typeof entry.order !== 'number') wrong.push(`${where}: needs a numeric "order"`);
      if (!STATUSES.includes(entry.status as string)) wrong.push(`${where}: "status" is one of ${STATUSES.join(', ')}`);
      if (!registered.has(String(entry.area))) wrong.push(`${where}: the area is not registered`);
    }
    expect(wrong).toEqual([]);
  });

  it('has no file for an area the registry no longer has', () => {
    const stale = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .filter((area) => !(area in lists));
    expect(stale, 'delete these from site/src/data/commands/').toEqual([]);
    const staleSettings = readdirSync(settingsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .filter((area) => !(area in settings));
    expect(staleSettings, 'delete these from site/src/data/settings/').toEqual([]);
  });
});
