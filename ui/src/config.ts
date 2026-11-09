/**
 * The settings pages' seam (#253, item 4): toil's own config commands, run
 * through `execute()` from `@imagile-dev/toil/api` on the local server, never
 * by editing a file. This is the one place Toil UI changes anything, and only
 * toil's own configuration: its connections and toil projects. The server holds the
 * allowlist below (ui/server/config.ts) and runs nothing else on this path;
 * test/config.test.ts holds the list to the real registry.
 *
 * A change is an explicit action by the person at the page, so the commands
 * that ask a person questions on a terminal (`connections add`, `login`,
 * `writes`, ...) get them asked here instead: the page collects the answers
 * and the server hands them to toil as the call's `person`. A secret goes from
 * a password field to toil's login path, which keeps it in the OS credential
 * store. It is never kept by the page after the call, never logged, and never
 * sent back. Turning writes on needs the connection's name typed, exactly as
 * `toil connections writes <name> on` asks for it.
 *
 * The site preview passes a fixture (src/fixtures/config.ts) that reads sample
 * data and changes nothing, saying so. Paperwork about the paperwork, filed
 * where the paperwork is.
 */

import type { Envelope } from './toil.ts';
import type { FormChoices } from '../../src/core/connection-form.ts';
import type { DescribedScopes } from '../../src/core/scopes.ts';

/** The reads the pages make: run read-only, even on the config path. The audit reads fill Usage (#309). */
export const CONFIG_READS = ['connections list', 'connections test', 'projects list', 'projects show', 'projects check', 'jira field discover', 'audit stats', 'audit list', 'theme list'] as const;

/** The changes, each only to toil's own config or toil projects. */
export const CONFIG_CHANGES = [
  'connections add',
  'connections login',
  'connections default',
  'connections writes',
  'connections remove',
  'projects init',
  'projects add-repo',
  'projects link',
  'projects field',
  'projects person',
  // Saving the people into the repository's own .toil/projects file, to be reviewed and committed with the code (#561).
  'projects people save',
  'projects wip-limit',
  // How Analyze briefs a toil project (#494): its goal, reader, lenses and focus.
  'projects analyze set',
  'projects onboard',
  // A toil project's name and description, edited in place on its card and dashboard (#342).
  'projects describe',
  // Archiving puts a toil project away without deleting it (#561); unarchive is the undo.
  'projects archive',
  'projects unarchive',
  // The theme a person picks, as toil's own setting, which the welcome menu follows too (#427).
  'theme set',
] as const;

/** Everything `/api/config` runs, and nothing else. */
export const CONFIG_COMMANDS: ReadonlySet<string> = new Set<string>([...CONFIG_READS, ...CONFIG_CHANGES]);

/** One value a connection holds, as `registry.areas[].connection` describes it. */
export interface ConnectionField {
  name: string;
  description: string | null;
  secret: boolean;
  password: boolean;
  default: string | null;
  required: boolean;
  /** Presets the form shows as radio buttons (older toil: absent). */
  choices?: FormChoices;
  appliesTo?: readonly string[];
  requiredFor?: readonly string[];
}

export interface AreaInfo {
  name: string;
  description: string;
  /** Empty when the toil the server runs doesn't describe its connections. */
  connection: ConnectionField[];
  /** What its credential must be allowed to do (older toil: absent). */
  scopes?: DescribedScopes;
  variantBy?: string;
}

/** What a person typed for one call: answers by question id, and secrets by key. */
export interface ConfigAnswers {
  /** `setting:<key>`, `area`, `confirm`, `confirm-name`, and `unwrap:<key>` (`n` keeps a secret's quotes or `Bearer ` prefix as typed). */
  answers?: Record<string, string>;
  /** Secret values by connection key. Only a hidden question is answered from these. */
  secrets?: Record<string, string>;
}

/** The settings toil has no command for, as the server sees them. */
export interface SettingsInfo {
  timeout: {
    variable: 'TOIL_TIMEOUT_MS';
    /** The variable's value in the server's environment, which is where toil runs. */
    value: string | null;
    /** What applies: the variable when it's a positive number, else toil's default. */
    effectiveMs: number;
    defaultMs: number;
  };
}

/** toil's default time limit for one command (DEFAULT_TIMEOUT_MS in src/core/run.ts; test/config.test.ts holds them equal). */
export const DEFAULT_TIMEOUT_MS = 120_000;

export interface ConfigApi {
  /** Why changes are off (the preview), or null when the page may make them. */
  readonly disabled: string | null;
  areas(): Promise<AreaInfo[]>;
  settings(): Promise<SettingsInfo>;
  /** Runs one allowlisted config command and returns its envelope. Never throws for a refusal. */
  run(command: string, input: Record<string, unknown>, answers?: ConfigAnswers): Promise<Envelope>;
}

/** `connections list`'s data, as the pages read it. */
export interface ConnectionRow {
  name: string;
  area: string;
  isDefault: boolean;
  host: string | null;
  writes: boolean;
  values: Record<string, 'env' | 'ci' | 'file' | 'store' | 'defaults'>;
  /** Absent from an older toil: then a connection whose every value is from env or CI counts as env-defined. */
  definedIn?: 'file' | 'env';
}

export interface ConnectionsData {
  configFile: string;
  connections: ConnectionRow[];
}

/** Whether a connection is made by env vars alone, so the pages show it read-only. */
export function envOnly(c: ConnectionRow): boolean {
  if (c.definedIn) return c.definedIn === 'env';
  const sources = Object.values(c.values);
  return sources.length > 0 && sources.every((s) => s === 'env' || s === 'ci');
}

/** `TOIL_CONN_CORP_JIRA_*`: the variables that define a connection named `corp-jira`. */
export function envPrefix(name: string): string {
  return `TOIL_CONN_${name.toUpperCase().replace(/-/g, '_')}_`;
}

/** `TOIL_CONN_CORP_JIRA_API_TOKEN`: the variable for one key of a connection, as toil's connectionEnvName spells it. */
export function connectionEnvVar(name: string, key: string): string {
  const snake = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toUpperCase();
  return `${envPrefix(name)}${snake}`;
}

/** `key=value` lines from a text area, blank lines dropped. */
export function pairs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}
