import { ToilError } from './errors.js';

/**
 * Areas that no longer exist under their old name, and where they went.
 * `jira-cloud`, `confluence-cloud`, `bitbucket-cloud` and `ado-cloud` are `jira`,
 * `confluence`, `bitbucket` and `ado` with `"deployment": "cloud"` on the connection (#495): one product, one command
 * tree, one set of MCP tools. Everything that still names the old area (a
 * config file, an env var, a toil project
 * section, `--areas`, a typed command) gets the new form from here, so no
 * place invents its own wording and none of them goes quiet.
 *
 * The old forms were retired without a deprecation period, so this table
 * is where the apology goes. Forms are filed under their new address; the
 * old address is, as ever, no longer accepting forms.
 */
export interface RenamedArea {
  /** The area that took over. */
  area: string;
  /** Connection settings that say what the old area was (`deployment: 'cloud'`). */
  settings: Record<string, string>;
  /** An old tool that is not simply the new area's tool of the same name: `{ bitbucket_cloud_pr_request_changes: 'bitbucket_pr_needs_work' }`. */
  tools?: Record<string, string>;
}

export const RENAMED_AREAS: Readonly<Record<string, RenamedArea>> = {
  'jira-cloud': { area: 'jira', settings: { deployment: 'cloud' } },
  'confluence-cloud': { area: 'confluence', settings: { deployment: 'cloud' } },
  'bitbucket-cloud': { area: 'bitbucket', settings: { deployment: 'cloud' }, tools: { bitbucket_cloud_pr_request_changes: 'bitbucket_pr_needs_work' } },
  'ado-cloud': { area: 'ado', settings: { deployment: 'cloud' } },
};

export const renamedArea = (name: string): RenamedArea | undefined => (Object.hasOwn(RENAMED_AREAS, name) ? RENAMED_AREAS[name] : undefined);

/** `TOIL_JIRA_CLOUD_` for `jira-cloud`: the prefix its env vars had. */
const envPrefix = (name: string) => `TOIL_${name.toUpperCase().replace(/-/g, '_')}_`;

/** The old area whose env vars `name` is one of (`TOIL_JIRA_CLOUD_TOKEN`), if any. */
export function renamedAreaOfEnv(name: string): string | undefined {
  return Object.keys(RENAMED_AREAS).find((old) => name.startsWith(envPrefix(old)));
}

const upper = (text: string) => text.toUpperCase();

/** What replaces an old area, for a message: the new name for each place the old one was used. */
export function renamedAreaFix(old: string): string {
  const r = RENAMED_AREAS[old]!;
  const says = Object.entries(r.settings).map(([k, v]) => `"${k}": "${v}"`).join(', ');
  const env = Object.entries(r.settings).map(([k, v]) => `TOIL_${upper(r.area)}_${upper(k)}=${v}`).join(' ');
  return `${old} is now ${r.area}, with ${says} on the connection: use toil ${r.area} …, the ${r.area}_* MCP tools, --areas ${r.area}, a ${r.area} toil project section, and TOIL_${upper(r.area)}_* env vars with ${env}.`;
}

/** The fix for an env var `name` of an old area: its new name, and the setting that says which deployment. */
export function renamedEnvFix(name: string): string {
  const old = renamedAreaOfEnv(name)!;
  const r = RENAMED_AREAS[old]!;
  const rest = name.slice(envPrefix(old).length);
  const set = Object.entries(r.settings).map(([k, v]) => `TOIL_${upper(r.area)}_${upper(k)}=${v}`).join(' ');
  const conn = Object.entries(r.settings).map(([k, v]) => `TOIL_CONN_<NAME>_${upper(k)}=${v}`).join(' ');
  return `Rename ${name} to TOIL_${upper(r.area)}_${rest} and set ${set}. For a named connection, use TOIL_CONN_<NAME>_${rest} with TOIL_CONN_<NAME>_AREA=${r.area} and ${conn}.`;
}

/** The old area whose MCP tools `tool` looks like (`jira_cloud_issue_get`), if any. */
export function renamedAreaOfTool(tool: string): string | undefined {
  return Object.keys(RENAMED_AREAS).find((old) => tool.startsWith(`${old.replace(/-/g, '_')}_`));
}

/**
 * The tool that replaced `tool` when it was merged into another (`tools`), for
 * the old name and for the natural retry under the new area (`bitbucket_pr_request_changes`).
 */
export function renamedToolTarget(tool: string): string | undefined {
  for (const [old, r] of Object.entries(RENAMED_AREAS)) {
    const prefix = `${old.replace(/-/g, '_')}_`;
    for (const [oldTool, newTool] of Object.entries(r.tools ?? {})) {
      if (tool === oldTool || tool === `${r.area.replace(/-/g, '_')}_${oldTool.slice(prefix.length)}`) return newTool;
    }
  }
  return undefined;
}

/** Refuses an area name that was folded into another, with where it went; anything else passes through for the caller's own check. */
export function refuseRenamedArea(name: string): void {
  if (renamedArea(name)) throw new ToilError('INVALID_INPUT', `toil ${name} no longer exists.`, { fix: renamedAreaFix(name) });
}
