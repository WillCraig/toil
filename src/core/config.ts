import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseAuditSettings } from './audit.js';
import { ToilError, withArticle } from './errors.js';
import { RENAMED_AREAS, renamedArea, renamedAreaFix, renamedAreaOfEnv, renamedEnvFix } from './renamed-areas.js';

/**
 * Configuration is a set of named **connections**, each one instance of a
 * service (an area), plus per-area **defaults**.
 *
 * Where a connection's value comes from, highest first (CLAUDE.md,
 * Configuration Precedence):
 *   1. TOIL_CONN_<NAME>_<KEY>, for that connection
 *   2. TOIL_<AREA>_<KEY>, for the area's default connection
 *   3. a well-known CI variable the area declares, for its default connection
 *   4. the connection in ~/.toil/config.json (or --config)
 *   5. `defaults.<area>` in that file, shared by every connection to the area
 *   6. the area's provider defaults (applied when the connection is resolved)
 *
 * There is deliberately no repository-level file. A config file inside a repo
 * could be written by anyone who can push to it, or by an agent editing the
 * working tree, and use it to switch on writes or send the user's credentials
 * to a host of its choosing. A memo left in a shared folder is not an
 * authorisation, however official its letterhead.
 */
export type Settings = Record<string, unknown>;
export type Source = 'env' | 'ci' | 'global' | 'defaults';

/** A connection as stored: its area, `writes`, and the area's own keys. */
export type ConnectionSettings = Settings & { area: string };

export interface ResolvedConfig {
  connections: Record<string, ConnectionSettings>;
  /** Per area: `connection` names the default connection; any other key is a shared default. */
  defaults: Record<string, Settings>;
  /** Where each `<connection>.<key>` came from, for `config check` and debugging. */
  sources: Record<string, Source>;
  files: { global: string };
  /** Things worth telling the user that aren't errors, surfaced in meta.warnings. */
  warnings: Array<{ code: string; message: string }>;
  /** Bounds the user relaxed in the config file (docs/bounds.md). Absent means every bound holds. */
  bounds?: Bounds;
  /** Folders of shared toil projects the user listed (`"projectPaths"`, version 2); TOIL_PROJECT_PATHS replaces them (src/core/toil-project.ts). */
  projectPaths?: string[];
  /** `"wait": { "maxTimeout": "2h" }`: the longest `toil wait --timeout` may be (src/core/wait.ts). Absent means the default. */
  wait?: WaitSettings;
  /**
   * The welcome menu's and Toil UI's theme (#427): `TOIL_THEME`, else
   * `"theme"` in the config file (version 2), with where it came from. Absent
   * means neither set one. Which names exist is the theme commands' to say
   * (src/theme/commands.ts); the loader only checks it's a name.
   */
  theme?: { name: string; source: 'env' | 'global' };
}

/** The settings `toil wait` reads from the config file. */
export interface WaitSettings {
  maxTimeoutMs: number;
}

/**
 * The bounds a config file may relax. Only the file workspace can be, and
 * only from the user's own config file: never from env, a toil project or a
 * repository (docs/bounds.md).
 */
export interface Bounds {
  files: 'workspace' | 'unbounded';
}

/** What config loading needs to know about each registered area. */
export interface AreaInfo {
  name: string;
  /** Key to the CI variables that stand in for it, in order. */
  fallbacks?: Record<string, string[] | undefined>;
  /** `defineArea({ fallbackWhen })`: whether the fallbacks apply, asked of the default connection's effective settings. */
  fallbackWhen?: (effective: Record<string, unknown>) => boolean;
  /** Its context inputs' names: the keys a toil project section may supply (src/core/toil-project.ts). */
  contextInputs?: readonly string[];
  /** Hosts people know the service by, to the API base URL its connections use (`defineArea({ siteApis })`). */
  siteApis?: Readonly<Record<string, string>>;
}

/** The config file format this toil writes. It reads every version up to this one. */
export const CONFIG_VERSION = 4;

/** Top-level keys that are never areas, in any version. */
const RESERVED_KEYS = new Set(['version', '$schema', 'connections', 'defaults', 'bounds', 'projectPaths', 'dossierPaths', 'audit', 'wait', 'game', 'theme']);

/**
 * Connection names map one-to-one onto env names: lowercase letters, digits
 * and single hyphens, starting with a letter. Toil project names follow it too.
 * `constructor` and `prototype` fit that shape but name parts of every
 * JavaScript object, so a lookup by either could find something no one
 * configured; they're refused, as `__proto__` is by the shape itself.
 */
export const CONNECTION_NAME = /^(?!(?:constructor|prototype)$)[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Keys that name parts of every JavaScript object rather than data; never a connection, area or setting in a config file. */
const RESERVED_OBJECT_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function refuseReservedKey(key: string, where: string, path: string): void {
  if (!RESERVED_OBJECT_KEYS.has(key)) return;
  throw new ToilError('CONFIG_INVALID', `"${where}" in ${path} uses the reserved key "${key}".`, {
    fix: `Rename or remove it: __proto__, constructor and prototype can't be names in a toil config file.`,
  });
}

export function emptyConfig(globalPath = ''): ResolvedConfig {
  return { connections: {}, defaults: {}, sources: {}, files: { global: globalPath }, warnings: [] };
}

export interface LoadConfigOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  home: string;
  configPath?: string | undefined;
  /** Registered areas, so TOIL_FOO_BAR_TOKEN maps to foo-bar, not foo. */
  areas?: readonly AreaInfo[];
}

export function loadConfig(options: LoadConfigOptions): ResolvedConfig {
  const globalPath = options.configPath ? resolve(options.cwd, options.configPath) : join(options.home, '.toil', 'config.json');
  const config = emptyConfig(globalPath);
  const file = readConfigFile(globalPath, config.warnings);
  config.defaults = file.defaults;
  if (file.projectPaths) config.projectPaths = file.projectPaths;
  if (file.wait) config.wait = file.wait;
  const envTheme = options.env.TOIL_THEME?.trim();
  if (envTheme) config.theme = { name: envTheme, source: 'env' };
  else if (file.theme) config.theme = { name: file.theme, source: 'global' };
  if (file.bounds) {
    config.bounds = file.bounds;
    if (file.bounds.files === 'unbounded') {
      config.warnings.push({
        code: 'BOUND_RELAXED',
        message: `The file workspace bound is off ("bounds": { "files": "unbounded" } in ${globalPath.replace(/\\/g, '/')}): commands may read and write files anywhere you can, except toil's own files.`,
      });
    }
  }
  // The audit log's settings count only from the user's own file (src/core/audit.ts):
  // a --config file is something an agent can name, so it can't switch the log off.
  const ownFile = join(options.home, '.toil', 'config.json');
  if (file.audit && globalPath !== ownFile) {
    const slashes = (p: string) => p.replace(/\\/g, '/');
    config.warnings.push({
      code: 'AUDIT_SETTING_IGNORED',
      message: `"audit" in ${slashes(globalPath)} was ignored: the audit log is set only in ${slashes(ownFile)}.`,
    });
  }
  for (const [name, conn] of Object.entries(file.connections)) {
    config.connections[name] = { ...conn };
    for (const key of Object.keys(conn)) if (key !== 'area') config.sources[`${name}.${key}`] = 'global';
  }
  // Order matters: connections defined only by env exist before an area's
  // default is chosen, so TOIL_CONN_CI_AREA=jira plus TOIL_JIRA_TOKEN is one
  // connection, not a stray second one named after the area.
  refuseRenamedEnv(options.env);
  createEnvConnections(config, options.env);
  applyAreaEnv(config, options.env, options.areas ?? []);
  applyConnectionEnv(config, options.env);
  if (options.areas?.length) warnUnknownAreas(config, options.areas);
  return config;
}

/**
 * TOIL_JIRA_CLOUD_TOKEN would otherwise read as the `jira` area's
 * `cloudToken` and be ignored, which is silence about a credential that was
 * meant to be used. It refuses instead, once, naming what to set. A warning
 * would ride along in meta.warnings, where the first reader to miss it is the
 * one whose pipeline it was.
 */
function refuseRenamedEnv(env: NodeJS.ProcessEnv): void {
  // An empty variable carries no credential, so by default it is skipped, as an empty CI fallback is. TOIL_STRICT_ENV=true makes CI fail on it too.
  const strict = env.TOIL_STRICT_ENV?.trim().toLowerCase() === 'true';
  const old = Object.keys(env)
    .filter((name) => env[name] !== undefined && (strict || env[name] !== '') && renamedAreaOfEnv(name) !== undefined)
    .sort();
  if (old.length > 0) {
    throw new ToilError('CONFIG_INVALID', `${old.join(', ')} ${old.length > 1 ? 'are' : 'is'} set, and the ${renamedAreaOfEnv(old[0]!)} area they configure no longer exists. ${renamedAreaFix(renamedAreaOfEnv(old[0]!)!)}`, { fix: renamedEnvFix(old[0]!) });
  }
}

/** A misspelt area would otherwise surface later as "no such connection", hiding the typo. */
function warnUnknownAreas(config: ResolvedConfig, areas: readonly AreaInfo[]): void {
  const known = new Set(areas.map((a) => a.name));
  for (const [name, conn] of Object.entries(config.connections)) {
    if (known.has(conn.area)) continue;
    config.warnings.push({
      code: 'CONFIG_UNKNOWN_AREA',
      message: `Connection ${name} is for area "${conn.area}", which this toil doesn't have. Known areas: ${[...known].sort().join(', ')}.`,
    });
  }
}

/** The default connection's name for an area, or undefined when it has none or several and no default. */
export function defaultConnectionName(config: ResolvedConfig, area: string): string | undefined {
  const named = config.defaults[area]?.connection;
  if (typeof named === 'string') return named;
  const candidates = connectionsOf(config, area);
  if (candidates.includes(area)) return area;
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Every connection name for an area. */
export function connectionsOf(config: ResolvedConfig, area: string): string[] {
  return Object.keys(config.connections).filter((name) => config.connections[name]!.area === area);
}

/** Whether the user has configured anything at all for an area. */
export function hasConfig(config: ResolvedConfig, area: string): boolean {
  return connectionsOf(config, area).length > 0;
}

/** `writes: true` on a connection, set by a human (or by CI through env). */
export function connectionWrites(settings: Settings | undefined): boolean {
  const value = settings?.writes;
  return value === true || value === 'true';
}

/** Whether any connection to an area has writes on: MCP lists its write tools only then. */
export function anyWrites(config: ResolvedConfig, area: string): boolean {
  return connectionsOf(config, area).some((name) => connectionWrites(config.connections[name]));
}

function readConfigFile(path: string, warnings: ResolvedConfig['warnings']): ReturnType<typeof migrateConfig> {
  if (!existsSync(path)) return { connections: {}, defaults: {} };
  return migrateConfig(readJson(path), path, warnings);
}

function readJson(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ToilError('CONFIG_INVALID', `${path} is not valid JSON: ${(err as Error).message}`, {
      fix: `Fix the JSON in ${path}, or move it aside and set toil up again.`,
    });
  }
  if (!isRecord(parsed)) {
    throw new ToilError('CONFIG_INVALID', `${path} must contain a JSON object.`, {
      fix: `Make ${path} look like { "version": ${CONFIG_VERSION}, "connections": { ... } }.`,
    });
  }
  return parsed;
}

/** A config file as `toil connections` edits it: always the current version, every other key kept as found. */
export type EditableConfig = Record<string, unknown> & {
  version: number;
  connections: Record<string, ConnectionSettings>;
  defaults: Record<string, Settings>;
};

/**
 * Reads the config file for editing, as the current version. A file of version
 * 2 or later comes back as written (a version 2 file with its renamed areas
 * folded in, see {@link migrateConfig}), unknown keys included, so writing it
 * back drops nothing else.
 * A version 1 file becomes the file it already meant: one connection
 * per area, named after it and set as its default, with every setting carried
 * over. A missing file is an empty one.
 */
export function readConfigForEdit(path: string): EditableConfig {
  if (!existsSync(path)) return { version: CONFIG_VERSION, connections: {}, defaults: {} };
  const raw = readJson(path);
  const { connections, defaults } = migrateConfig(raw, path, []);
  if ((raw.version ?? 1) !== 1) {
    // Version 4 renamed dossierPaths to projectPaths; saving the file finishes the rename, and the new key wins a tie.
    const { dossierPaths, ...rest } = raw;
    return { ...rest, ...(dossierPaths !== undefined && rest.projectPaths === undefined ? { projectPaths: dossierPaths } : {}), version: CONFIG_VERSION, connections: { ...connections }, defaults: { ...defaults } };
  }
  // In version 1 these keys were ignored; upgrading would give them meaning.
  for (const key of ['connections', 'defaults', 'projectPaths', 'dossierPaths', 'theme']) {
    if (key in raw) {
      throw new ToilError('CONFIG_INVALID', `${path} is a version 1 file with a "${key}" key, which version 1 ignores, so toil won't upgrade it automatically.`, {
        fix: `Remove "${key}" from ${path}, or add "version": ${CONFIG_VERSION} and check it reads as you intend.`,
      });
    }
  }
  return {
    ...('$schema' in raw ? { $schema: raw.$schema } : {}),
    ...('bounds' in raw ? { bounds: raw.bounds } : {}),
    ...('audit' in raw ? { audit: raw.audit } : {}),
    ...('wait' in raw ? { wait: raw.wait } : {}),
    version: CONFIG_VERSION,
    connections,
    defaults,
  };
}

/**
 * Writes the config file, readable by the user only where the platform has
 * POSIX modes (0600, in a 0700 folder). On Windows the file inherits the
 * ACL of the user's profile folder, which already keeps other users out. The
 * new file is written alongside and renamed into place, so a crash halfway
 * leaves the old file, not half of a new one. The content is checked with the
 * same reader that will load it, so toil never writes a file it would refuse.
 */
export function writeConfigFile(path: string, config: EditableConfig): void {
  migrateConfig(config, path, []);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, path);
}

/**
 * Turns a config file of any version this toil understands into connections
 * and defaults. Each format change adds a step here, with a test, so a file
 * written years ago still loads. A file from a newer toil is refused with an
 * upgrade hint rather than half-read.
 *
 * Version 1 is a map of area to settings. It reads as one connection per area,
 * named after the area and set as that area's default, which is exactly what
 * it always meant. Superseded forms remain valid in perpetuity; nobody is asked
 * to resubmit.
 */
export function migrateConfig(
  raw: Record<string, unknown>,
  path: string,
  warnings: ResolvedConfig['warnings'],
): { connections: Record<string, ConnectionSettings>; defaults: Record<string, Settings>; bounds?: Bounds; projectPaths?: string[]; audit?: true; wait?: WaitSettings; theme?: string } {
  // Absent means version 1; present-but-null is a mistake, not a default.
  const version = 'version' in raw ? raw.version : 1;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new ToilError('CONFIG_INVALID', `"version" in ${path} must be a whole number, found ${JSON.stringify(raw.version)}.`, {
      fix: `Remove "version" from ${path}, or set it to ${CONFIG_VERSION}.`,
    });
  }
  if (version > CONFIG_VERSION) {
    throw new ToilError('CONFIG_INVALID', `${path} was written by a newer toil (config version ${version}); this toil reads up to version ${CONFIG_VERSION}.`, {
      fix: 'Upgrade toil: npm install -g @imagile-dev/toil@latest.',
    });
  }
  const read = version === 1 ? fromVersion1(raw, path, warnings) : fromVersion2(raw, path, warnings);
  // Areas that were folded into another (jira-cloud into jira, confluence-cloud into confluence) are read as the area they became, whatever the file's version: older files meant it, and a version 3 file written before its area was folded still says the old name. Folding is idempotent, so a folded file is left as it is.
  foldRenamedAreas(read, path, warnings, version >= 3);
  const bounds = readBounds(raw.bounds, path);
  // Version 4 renamed dossierPaths to projectPaths. The old key still loads, in any version, with the new name said once; with both set, the new one wins.
  if (version !== 1 && raw.dossierPaths !== undefined) {
    warnings.push({ code: 'CONFIG_RENAMED_KEY', message: `"dossierPaths" in ${path} is now "projectPaths", so it is read as "projectPaths"${raw.projectPaths !== undefined ? ', and this file has both: "projectPaths" is used and "dossierPaths" is ignored' : ''}. Run toil connections migrate to save the file in version ${CONFIG_VERSION} with the new name.` });
  }
  const projectPaths = version === 1 ? undefined : readToilProjectPaths(raw.projectPaths ?? raw.dossierPaths, path);
  // Checked here so a typo is loud on every command; read from the user's own file only (src/core/audit.ts).
  if (raw.audit !== undefined) parseAuditSettings(raw.audit, path);
  const wait = readWait(raw.wait, path);
  const theme = version === 1 ? undefined : readTheme(raw.theme, path);
  return { ...read, ...(bounds ? { bounds } : {}), ...(projectPaths ? { projectPaths } : {}), ...(raw.audit !== undefined ? { audit: true as const } : {}), ...(wait ? { wait } : {}), ...(theme ? { theme } : {}) };
}

/** A theme's name: lowercase letters, digits and hyphens, as its folder under ui/themes/ is named. */
export const THEME_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * `"theme": "realm"`: the welcome menu's and Toil UI's theme (#427). A name
 * here; whether toil has that theme is for `toil theme list` and the menu to
 * say, so a theme a newer toil added doesn't break every command in an older one.
 */
function readTheme(raw: unknown, path: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !THEME_NAME.test(raw)) {
    throw new ToilError('CONFIG_INVALID', `"theme" in ${path} must be a theme's name, such as "plain", found ${JSON.stringify(raw)}.`, {
      fix: `Run toil theme set <name> (toil theme list names them), or remove "theme" from ${path}.`,
    });
  }
  return raw;
}

/**
 * `"wait": { "maxTimeout": "2h" }`: how long `toil wait --timeout` may be. A
 * duration as the flag takes it, from a minute to a day, since a wait that
 * outlives the working day is a vigil.
 */
function readWait(raw: unknown, path: string): WaitSettings | undefined {
  if (raw === undefined) return undefined;
  const fix = `Make it look like "wait": { "maxTimeout": "2h" } (a duration from 1m to 24h), or remove "wait" from ${path}.`;
  if (!isRecord(raw)) throw new ToilError('CONFIG_INVALID', `"wait" in ${path} must be an object.`, { fix });
  const settings: WaitSettings = { maxTimeoutMs: DEFAULT_MAX_WAIT_MS };
  for (const [key, value] of Object.entries(raw)) {
    if (key !== 'maxTimeout') throw new ToilError('CONFIG_INVALID', `"wait.${key}" in ${path} isn't a wait setting.`, { fix });
    const ms = typeof value === 'string' ? parseDuration(value) : undefined;
    if (ms === undefined || ms < 60_000 || ms > 24 * 3_600_000) {
      throw new ToilError('CONFIG_INVALID', `"wait.maxTimeout" in ${path} must be a duration from 1m to 24h, such as "2h", found ${JSON.stringify(value)}.`, { fix });
    }
    settings.maxTimeoutMs = ms;
  }
  return settings;
}

/** The longest `toil wait --timeout` when the config file doesn't say: one hour. */
export const DEFAULT_MAX_WAIT_MS = 3_600_000;

const DURATION = /^(\d+)(ms|s|m|h)$/;
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;

/** `500ms`, `15s`, `30m`, `2h` in milliseconds; undefined for anything else. */
export function parseDuration(text: string): number | undefined {
  const m = DURATION.exec(text.trim());
  if (!m) return undefined;
  const ms = Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
  return Number.isSafeInteger(ms) ? ms : undefined;
}

/** `"projectPaths"`: folders of shared toil projects, each absolute. Only folders listed here are read; toil never searches for them. */
function readToilProjectPaths(raw: unknown, path: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.every((p) => typeof p === 'string' && isAbsolute(p))) {
    throw new ToilError('CONFIG_INVALID', `"projectPaths" in ${path} must be a list of absolute folder paths.`, {
      fix: `Make it look like "projectPaths": ["C:/Code/team-toil-projects/.toil/projects"], or remove it from ${path}.`,
    });
  }
  return raw as string[];
}

const RELAXABLE: Record<keyof Bounds, readonly string[]> = { files: ['workspace', 'unbounded'] };

/**
 * `"bounds"` in the config file. An unknown key is refused rather than
 * ignored: a bound that can't be relaxed (toil's own files, credentials to
 * their host) has no setting, and a typo shouldn't read as having worked.
 */
function readBounds(raw: unknown, path: string): Bounds | undefined {
  if (raw === undefined) return undefined;
  const fix = `Set "bounds": { "files": "unbounded" } to let commands reach files outside the workspace, or remove "bounds" from ${path}. No other bound can be relaxed (docs/bounds.md).`;
  if (!isRecord(raw)) throw new ToilError('CONFIG_INVALID', `"bounds" in ${path} must be an object.`, { fix });
  const bounds: Bounds = { files: 'workspace' };
  for (const [key, value] of Object.entries(raw)) {
    const allowed = RELAXABLE[key as keyof Bounds];
    if (!allowed) throw new ToilError('CONFIG_INVALID', `"bounds.${key}" in ${path} isn't a bound that can be relaxed.`, { fix });
    if (typeof value !== 'string' || !allowed.includes(value)) {
      throw new ToilError('CONFIG_INVALID', `"bounds.${key}" in ${path} must be one of ${allowed.map((a) => `"${a}"`).join(', ')}, found ${JSON.stringify(value)}.`, { fix });
    }
    bounds[key as keyof Bounds] = value as Bounds['files'];
  }
  return bounds;
}

/**
 * Folded areas (#495): `jira-cloud` became `jira`, and `confluence-cloud`
 * `confluence`, each with `"deployment": "cloud"` on the connection. A
 * connection of a renamed area changes area and gains the setting; its
 * `defaults` entry folds into the new area's. Keychain references are
 * untouched, being named after the connection and not the area.
 *
 * It runs on every version, and a second run changes nothing. Files older
 * than version 3 meant the old area, so they fold quietly; a version 3 file
 * can still say it (one written before that area was folded, or edited by
 * hand), and folding it is kinder than refusing it, so it folds with a
 * `CONFIG_RENAMED_AREA` warning.
 *
 * Defaults are the delicate part: `defaults.jira` reaches every Jira
 * connection, so a Cloud default moves there only when nothing else would
 * inherit it, and is otherwise written onto the Cloud connections
 * themselves. The mirror image holds too: when connections move in beside
 * existing Data Center ones, the shared keys `defaults.jira` already had are
 * written onto those Data Center connections (where they were set, so they
 * stay) and leave `defaults.jira`, which would now reach the Cloud ones. The new area's default stays what it was, including the one it
 * only had by being the sole connection; when the old area named a different
 * default, the warning names the one that was set aside.
 */
function foldRenamedAreas(read: { connections: Record<string, ConnectionSettings>; defaults: Record<string, Settings> }, path: string, warnings: ResolvedConfig['warnings'], say: boolean): void {
  for (const [old, renamed] of Object.entries(RENAMED_AREAS)) {
    const moved = Object.keys(read.connections).filter((name) => read.connections[name]!.area === old);
    const oldDefaults = read.defaults[old];
    if (moved.length === 0 && !oldDefaults) continue;
    const others = Object.keys(read.connections).filter((name) => read.connections[name]!.area === renamed.area);
    for (const name of moved) read.connections[name] = { ...read.connections[name]!, area: renamed.area, ...renamed.settings };
    const target = (read.defaults[renamed.area] ??= {});
    // What `toil jira` used before stays what it uses: the default it named, else the connection called jira, else the only one.
    const before = typeof target.connection === 'string' ? target.connection : others.includes(renamed.area) ? renamed.area : others.length === 1 ? others[0] : undefined;
    if (target.connection === undefined && before !== undefined) target.connection = before;
    // The other way round: what defaults.jira said only ever reached the Data Center connections, and must not start reaching the ones that moved in.
    if (moved.length > 0 && others.length > 0) {
      for (const [key, value] of Object.entries(target)) {
        if (key === 'connection') continue;
        for (const name of others) if (read.connections[name]![key] === undefined) read.connections[name]![key] = value;
        delete target[key];
      }
    }
    const { connection: named, ...shared } = oldDefaults ?? {};
    for (const [key, value] of Object.entries(shared)) {
      if (target[key] === undefined && others.length === 0) target[key] = value;
      else for (const name of moved) if (read.connections[name]![key] === undefined) read.connections[name]![key] = value;
    }
    if (typeof named === 'string' && moved.includes(named)) {
      if (target.connection === undefined) target.connection = named;
      else {
        const kept = String(target.connection);
        warnings.push({
          code: 'CONFIG_DEFAULT_KEPT',
          message: `${path} named ${old} connection "${named}" as the default for ${old}, and ${renamed.area} already has one (${kept}), which stays the default. ${old} is now ${renamed.area}. Run toil connections migrate to save the file in version ${CONFIG_VERSION} and clear this warning.`,
        });
      }
    }
    delete read.defaults[old];
    // A file older than version 3 meant the old area, so reading it as the new one is no news. A version 3 file is news: toil wrote it, or a person edited it, with a name that no longer exists.
    if (say) {
      const what = [...moved.map((name) => `connection ${name}`), ...(oldDefaults ? [`defaults.${old}`] : [])].join(', ');
      warnings.push({ code: 'CONFIG_RENAMED_AREA', message: `${path} still names area "${old}" (${what}), which no longer exists, so it is read as ${renamed.area}. ${renamedAreaFix(old)} Run toil connections migrate to save the file with the new form and clear this warning.` });
    }
    if (Object.keys(target).length === 0) delete read.defaults[renamed.area];
  }
}

function fromVersion1(raw: Record<string, unknown>, path: string, warnings: ResolvedConfig['warnings']) {
  const connections: Record<string, ConnectionSettings> = {};
  const defaults: Record<string, Settings> = {};
  for (const [key, settings] of Object.entries(raw)) {
    refuseReservedKey(key, key, path);
    if (RESERVED_KEYS.has(key)) {
      if (key === 'connections' || key === 'defaults' || key === 'projectPaths' || key === 'dossierPaths' || key === 'theme') {
        warnings.push({ code: 'CONFIG_RESERVED_KEY', message: `"${key}" in ${path} needs "version": ${CONFIG_VERSION} and was ignored.` });
      }
      continue;
    }
    if (!isRecord(settings)) {
      throw new ToilError('CONFIG_INVALID', `"${key}" in ${path} must be an object of settings.`, {
        fix: `Change "${key}" in ${path} to an object, for example { "baseUrl": "..." }.`,
      });
    }
    connections[key] = { ...settings, area: key };
    defaults[key] = { connection: key };
  }
  return { connections, defaults };
}

function fromVersion2(raw: Record<string, unknown>, path: string, warnings: ResolvedConfig['warnings']) {
  const connections: Record<string, ConnectionSettings> = {};
  const defaults: Record<string, Settings> = {};
  for (const key of Object.keys(raw)) {
    if (!RESERVED_KEYS.has(key)) {
      warnings.push({ code: 'CONFIG_UNKNOWN_KEY', message: `"${key}" in ${path} was ignored: in version ${CONFIG_VERSION}, settings belong to a connection under "connections".` });
    }
  }
  const rawConnections = raw.connections ?? {};
  if (!isRecord(rawConnections)) {
    throw new ToilError('CONFIG_INVALID', `"connections" in ${path} must be an object of named connections.`, {
      fix: `Make it look like "connections": { "corp-jira": { "area": "jira", "baseUrl": "https://jira.imagile.dev" } }.`,
    });
  }
  for (const [name, settings] of Object.entries(rawConnections)) {
    refuseReservedKey(name, `connections.${name}`, path);
    if (!CONNECTION_NAME.test(name)) {
      throw new ToilError('CONFIG_INVALID', `Connection name "${name}" in ${path} isn't valid.`, {
        fix: 'Use lowercase letters, digits and single hyphens, starting with a letter, e.g. "corp-jira".',
      });
    }
    if (!isRecord(settings) || typeof settings.area !== 'string') {
      throw new ToilError('CONFIG_INVALID', `Connection "${name}" in ${path} must be an object with an "area".`, {
        fix: `Give "${name}" an area, e.g. { "area": "jira", "baseUrl": "https://jira.imagile.dev" }.`,
      });
    }
    connections[name] = settings as ConnectionSettings;
  }
  const rawDefaults = raw.defaults ?? {};
  if (!isRecord(rawDefaults) || !Object.values(rawDefaults).every(isRecord)) {
    throw new ToilError('CONFIG_INVALID', `"defaults" in ${path} must map each area to an object.`, {
      fix: `Make it look like "defaults": { "jira": { "connection": "corp-jira" } }.`,
    });
  }
  for (const [area, settings] of Object.entries(rawDefaults as Record<string, Settings>)) {
    refuseReservedKey(area, `defaults.${area}`, path);
    const named = settings.connection;
    if (named !== undefined && (typeof named !== 'string' || !Object.hasOwn(connections, named) || connections[named]!.area !== area)) {
      throw new ToilError('CONFIG_INVALID', `"defaults.${area}.connection" in ${path} names ${JSON.stringify(named)}, which isn't ${withArticle(area)} connection.`, {
        fix: `Set it to one of: ${Object.keys(connections).filter((n) => connections[n]!.area === area).join(', ') || `(no ${area} connections yet)`}.`,
      });
    }
    defaults[area] = settings;
  }
  return { connections, defaults };
}

/**
 * Environment variable names toil reserves for itself. They never map onto an
 * area, whatever areas exist now or later.
 */
const RESERVED_ENV = [/^TOIL_CONN_/, /^TOIL_PROJECT/, /^TOIL_DOSSIER/, /^TOIL_ENV$/, /^TOIL_CONFIG/, /^TOIL_TIMEOUT_MS$/, /^TOIL_WORKSPACE$/, /^TOIL_FEEDBACK_URL$/, /^TOIL_THEME$/, /^TOIL_STRICT_ENV$/];

/** camelCase key to SNAKE: baseUrl -> BASE_URL, baseURL -> BASE_URL, apiKey2 -> API_KEY2. */
function snake(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toUpperCase();
}

/** SNAKE to camelCase: BASE_URL -> baseUrl. */
function camel(snakeKey: string): string {
  return snakeKey
    .toLowerCase()
    .split('_')
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

const envForm = (name: string) => name.toUpperCase().replace(/-/g, '_');

/** The variable for a key on an area's default connection: foo-bar + baseUrl -> TOIL_FOO_BAR_BASE_URL. */
export function envName(area: string, key: string): string {
  return `TOIL_${envForm(area)}_${snake(key)}`;
}

/** The variable for a key on a named connection: corp-jira + token -> TOIL_CONN_CORP_JIRA_TOKEN. */
export function connectionEnvName(connection: string, key: string): string {
  return `TOIL_CONN_${envForm(connection)}_${snake(key)}`;
}

/**
 * The inverse of envName, against the areas toil knows. The longest matching
 * area wins, so TOIL_FOO_BAR_TOKEN is foo-bar.token. A name matching no
 * known area, or one toil reserves, is not config: it returns undefined rather
 * than guessing, so the same variable never means different things in
 * different versions.
 */
export function parseEnvName(name: string, knownAreas: readonly string[]): { area: string; key: string } | undefined {
  if (!name.startsWith('TOIL_') || RESERVED_ENV.some((re) => re.test(name))) return undefined;
  const rest = name.slice(5);
  const match = knownAreas
    .map((area) => ({ area, prefix: `${envForm(area)}_` }))
    .filter((p) => rest.startsWith(p.prefix) && rest.length > p.prefix.length)
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (!match) return undefined;
  return { area: match.area, key: camel(rest.slice(match.prefix.length)) };
}

/**
 * Every TOIL_<AREA>_<KEY> variable for a known area, as settings per area.
 * Values stay strings: the area's schema types them when the connection is
 * resolved, so a token that happens to be "true" stays a token.
 */
export function fromEnv(env: NodeJS.ProcessEnv, knownAreas: readonly string[] = []): Record<string, Settings> {
  const out: Record<string, Settings> = {};
  for (const [name, raw] of Object.entries(env)) {
    if (raw === undefined) continue;
    const parsed = parseEnvName(name, knownAreas);
    if (parsed) (out[parsed.area] ??= {})[parsed.key] = raw;
  }
  return out;
}

/**
 * CI fallbacks, then TOIL_<AREA>_* variables, onto each area's default
 * connection. An area with no connection gets one named after it, so CI can
 * configure an area with env vars alone, as it always could.
 */
function applyAreaEnv(config: ResolvedConfig, env: NodeJS.ProcessEnv, areas: readonly AreaInfo[]): void {
  const fromToil = fromEnv(env, areas.map((a) => a.name));
  for (const area of areas) {
    const layer: Array<[string, unknown, Source]> = [];
    for (const [key, names] of Object.entries(area.fallbacks ?? {})) {
      const found = (names ?? []).find((n) => env[n] !== undefined && env[n] !== '');
      if (found) layer.push([key, env[found], 'ci']);
    }
    for (const [key, value] of Object.entries(fromToil[area.name] ?? {})) layer.push([key, value, 'env']);
    if (area.fallbackWhen && layer.some(([, , source]) => source === 'ci')) {
      const connection = defaultConnectionName(config, area.name) ?? area.name;
      const effective = { ...config.defaults[area.name], ...config.connections[connection], ...fromToil[area.name], ...connectionEnvOf(env, connection) };
      if (!area.fallbackWhen(effective)) layer.splice(0, layer.length, ...layer.filter(([, , source]) => source !== 'ci'));
    }
    if (layer.length === 0) continue;

    let name = defaultConnectionName(config, area.name);
    if (!name) {
      if (connectionsOf(config, area.name).length > 0) {
        config.warnings.push({
          code: 'CONFIG_AMBIGUOUS_DEFAULT',
          message: `TOIL_${envForm(area.name)}_* variables were ignored: ${area.name} has several connections and no default. Set defaults.${area.name}.connection, or use TOIL_CONN_<NAME>_* variables.`,
        });
        continue;
      }
      name = area.name;
      config.connections[name] = { area: area.name };
      (config.defaults[area.name] ??= {}).connection = name;
    }
    const target = config.connections[name]!;
    refuseStaleEnvOnRenamed(config, area.name, name, target, layer, env);
    for (const [key, value, source] of layer) {
      target[key] = value;
      config.sources[`${name}.${key}`] = source;
    }
  }
}

/**
 * TOIL_JIRA_* used to mean Data Center's default connection; since #495 they
 * reach whichever connection is jira's default, and a connection that came
 * from `jira-cloud` is Cloud. A pipeline that still sets Data Center values
 * would send them (and a token) to that Cloud connection with nothing saying
 * so. So when the connection the env tier would land on is one the folded
 * area's settings describe (deployment cloud) and TOIL_JIRA_DEPLOYMENT isn't
 * set to say the values are meant for it, the call is refused. A named
 * connection (TOIL_CONN_<NAME>_*) is explicit and untouched.
 */
function refuseStaleEnvOnRenamed(config: ResolvedConfig, area: string, connection: string, target: ConnectionSettings, layer: Array<[string, unknown, Source]>, env: NodeJS.ProcessEnv): void {
  const fromEnv = layer.filter(([, , source]) => source === 'env');
  if (fromEnv.length === 0) return;
  for (const renamed of Object.values(RENAMED_AREAS)) {
    if (renamed.area !== area) continue;
    const effective = { ...config.defaults[area], ...target };
    const isFolded = Object.entries(renamed.settings).every(([key, value]) => effective[key] === value);
    if (!isFolded) continue;
    const says = Object.keys(renamed.settings).every((key) => {
      const named = envName(area, key);
      return env[named] !== undefined && env[named] !== '';
    });
    if (says) continue;
    const vars = fromEnv.map(([key]) => envName(area, key)).sort();
    const set = Object.entries(renamed.settings).map(([key, value]) => `${envName(area, key)}=${value}`).join(' ');
    throw new ToilError(
      'CONFIG_INVALID',
      `${vars.join(', ')} ${vars.length > 1 ? 'are' : 'is'} set, and ${area}'s default connection "${connection}" is ${Object.entries(renamed.settings).map(([k, v]) => `${k} ${v}`).join(', ')}, so ${vars.length > 1 ? 'they' : 'it'} would apply to it. Nothing was sent.`,
      {
        fix: `If they are for that connection, also set ${set}. If they are for a Data Center ${area} connection, define it separately with TOIL_CONN_<NAME>_AREA=${area} and TOIL_CONN_<NAME>_* variables, or remove them.`,
      },
    );
  }
}

/** One connection's TOIL_CONN_<NAME>_<KEY> variables as settings; they outrank every other tier, so a fallback's condition reads them too. */
function connectionEnvOf(env: NodeJS.ProcessEnv, connection: string): Record<string, string> {
  const prefix = `TOIL_CONN_${envForm(connection)}_`;
  const out: Record<string, string> = {};
  for (const [name, value] of connectionVars(env)) if (name.startsWith(prefix) && value !== '' && !name.endsWith('_AREA')) out[camel(name.slice(prefix.length))] = value;
  return out;
}

const connectionVars = (env: NodeJS.ProcessEnv) =>
  Object.entries(env).filter(([name, value]) => name.startsWith('TOIL_CONN_') && value !== undefined) as Array<[string, string]>;

/** TOIL_CONN_<NAME>_AREA creates a connection with no config file at all, which is how CI defines one. */
function createEnvConnections(config: ResolvedConfig, env: NodeJS.ProcessEnv): void {
  for (const [name, value] of connectionVars(env)) {
    if (!name.endsWith('_AREA')) continue;
    const connection = name.slice('TOIL_CONN_'.length, -'_AREA'.length).toLowerCase().replace(/_/g, '-');
    if (!CONNECTION_NAME.test(connection)) {
      config.warnings.push({ code: 'CONFIG_UNKNOWN_KEY', message: `${name} doesn't name a valid connection and was ignored.` });
      continue;
    }
    if (renamedArea(value)) {
      throw new ToilError('CONFIG_INVALID', `${name}=${value} names an area that no longer exists. ${renamedAreaFix(value)}`, {
        fix: `Set ${name}=${renamedArea(value)!.area}, and ${Object.entries(renamedArea(value)!.settings).map(([k, v]) => `${name.replace(/_AREA$/, '')}_${k.toUpperCase()}=${v}`).join(' and ')}.`,
      });
    }
    const existing = config.connections[connection];
    if (existing && existing.area !== value) {
      throw new ToilError('CONFIG_INVALID', `${name}=${value} conflicts with connection "${connection}", which is ${withArticle(existing.area)} connection.`, {
        fix: `Remove ${name}, or rename one of the two connections.`,
      });
    }
    config.connections[connection] = existing ?? { area: value };
  }
}

/**
 * TOIL_CONN_<NAME>_<KEY> variables, the highest layer. Names are matched
 * longest first against known connections, and a variable for a connection
 * that doesn't exist is a warning, never a guess.
 */
function applyConnectionEnv(config: ResolvedConfig, env: NodeJS.ProcessEnv): void {
  const names = Object.keys(config.connections).sort((a, b) => b.length - a.length);
  for (const [name, value] of connectionVars(env)) {
    if (name.endsWith('_AREA')) continue;
    const rest = name.slice('TOIL_CONN_'.length);
    const connection = names.find((n) => rest.startsWith(`${envForm(n)}_`) && rest.length > envForm(n).length + 1);
    if (!connection) {
      config.warnings.push({
        code: 'CONFIG_UNKNOWN_CONNECTION',
        message: `${name} was ignored: no connection matches it. To define one from env vars, also set TOIL_CONN_<NAME>_AREA.`,
      });
      continue;
    }
    const key = camel(rest.slice(envForm(connection).length + 1));
    if (key === 'area') continue;
    config.connections[connection]![key] = value;
    config.sources[`${connection}.${key}`] = 'env';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
