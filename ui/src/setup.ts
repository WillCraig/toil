/**
 * The setup wizard's pure parts (#561): its seven screens (the AI agent comes first, so the guide can explain the rest), and how the registry's
 * areas are sorted into the tools most people use and the long tail behind
 * "more". Nothing here reads or changes anything. Form 27-B, stripped of its
 * boxes, and filed as one array.
 */

import type { AreaInfo } from './config.ts';
import { hostMatches } from '../../src/core/connection-form.ts';

export const SETUP_STEPS = ['welcome', 'helper', 'tools', 'connect', 'project', 'fields', 'done'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/** The step titles, as the progress line and each screen's heading say them. */
export const STEP_TITLE: Record<SetupStep, string> = {
  welcome: 'Welcome',
  tools: 'Which tools do you use?',
  connect: 'Link your tools',
  project: 'Your Toil project',
  fields: 'Let toil learn your Jira fields (optional)',
  helper: 'An AI agent (optional)',
  done: 'All set',
};

/**
 * Where the wizard is, for the page that holds it (src/local.tsx): saving a
 * helper, or a sync that finishes, remounts the whole App, and the wizard
 * would start again at Welcome. Choices only, never a value anyone typed: no
 * secret is in here, and nothing is written anywhere but that page's memory.
 */
export interface SetupProgress {
  step: SetupStep;
  picked: string[];
  areaAt: number;
  made: Record<string, string>;
  project: string | null;
  helper: string | null;
  returnTo: SetupStep | null;
  /** The optional steps the person chose "Not now" on. */
  skipped?: SetupStep[];
}

/** Each step as the primary button names the one it leads to: "Next: Fields". */
export const STEP_SHORT: Record<SetupStep, string> = { welcome: 'Welcome', helper: 'AI agent', tools: 'Tools', connect: 'Link tools', project: 'Toil project', fields: 'Fields', done: 'All set' };

/** The steps that sit beside the guide once an AI agent is ready: the ones that ask the person something. */
export const GUIDED_STEPS: readonly SetupStep[] = ['tools', 'connect', 'project', 'fields'];

/** The work-tracking and code tools most people reach for, in the order the list shows them. */
export const COMMON_AREAS = ['github', 'jira', 'ado', 'bitbucket', 'confluence', 'sonarqube'] as const;

const NAMES: Record<string, string> = {
  github: 'GitHub', jira: 'Jira', ado: 'Azure DevOps', bitbucket: 'Bitbucket', confluence: 'Confluence', sonarqube: 'SonarQube', sonar: 'SonarQube', jenkins: 'Jenkins', openshift: 'OpenShift',
  alation: 'Alation', artifactory: 'Artifactory', checkmarx: 'Checkmarx', contrast: 'Contrast Security', db: 'Database', dynatrace: 'Dynatrace', elasticsearch: 'Elasticsearch', figma: 'Figma', git: 'Git', kibana: 'Kibana', logscale: 'LogScale',
  ossindex: 'OSS Index', osv: 'OSV', saucelabs: 'Sauce Labs', sde: 'SD Elements', sonatypeiq: 'Sonatype IQ', splitio: 'Split',
};

/** What an area is called to a person: its product name where Toil UI knows it, else the area's own name, capitalised. */
export const toolName = (area: string): string => NAMES[area] ?? (area ? area.charAt(0).toUpperCase() + area.slice(1) : area);

/** A service in a dropdown: its plain name, never the id in brackets. */
export const areaLabel = (area: string): string => toolName(area);

/** Only an area whose connection says what it holds can be added from a page. */
export const connectable = (areas: AreaInfo[]): AreaInfo[] => areas.filter((a) => a.connection.length > 0);

/** The areas split into the common ones, in the order above, and the rest, A to Z. */
export function groupAreas(areas: AreaInfo[]): { common: AreaInfo[]; more: AreaInfo[] } {
  const usable = connectable(areas);
  const common = COMMON_AREAS.flatMap((n) => usable.filter((a) => a.name === n));
  const more = usable.filter((a) => !(COMMON_AREAS as readonly string[]).includes(a.name)).sort((a, b) => a.name.localeCompare(b.name));
  return { common, more };
}

/** Where a connection's token lives, from `connections list`'s per-key sources (never a value). `missing` is a real none; an unreadable list is the caller's dash. */
export type TokenState = 'saved' | 'env' | 'missing' | 'none';
/** `none` is a connection that takes no secret (a SQLite file), which is not a secret that went missing. */
export const TOKEN_WORD: Record<TokenState, string> = { saved: 'saved', env: "set outside Toil UI", missing: 'missing', none: 'not needed' };

export function tokenState(row: { values: Record<string, string> }, secretKeys: string[]): TokenState {
  const sources = secretKeys.map((k) => row.values[k]);
  if (sources.some((s) => s === 'store' || s === 'file')) return 'saved';
  if (sources.some((s) => s === 'env' || s === 'ci')) return 'env';
  return 'missing';
}

/**
 * The secret keys this connection could use. `connections list` doesn't say
 * which variant (a database's engine) a connection is, so it is read from the
 * settings the connection holds: a variant is possible when every setting it
 * requires (a field's `requiredFor`) is set. A secret that `appliesTo` names
 * only other variants is left out. When the variant can't be told, every
 * secret counts, so "not needed" is only said when it is certain.
 */
export function secretKeysFor(area: AreaInfo | undefined, row: { values: Record<string, string> }): string[] {
  const secrets = area?.connection.filter((f) => f.secret) ?? [];
  if (!area || !area.variantBy) return secrets.map((f) => f.name);
  const variants = [...new Set(area.connection.flatMap((f) => f.requiredFor ?? []))];
  const held = new Set(Object.keys(row.values));
  const possible = variants.filter((v) => area.connection.filter((f) => f.requiredFor?.includes(v)).every((f) => held.has(f.name)));
  return secrets.filter((f) => !f.appliesTo || possible.length === 0 || possible.some((v) => f.appliesTo!.includes(v))).map((f) => f.name);
}

/** A connection's token state, counting only the secrets it could use: `none` when there are none. */
export function tokenStateOf(area: AreaInfo | undefined, row: { values: Record<string, string> }): TokenState {
  // Without the area's description there is no telling what it needs, so nothing is "not needed".
  if (!area) return tokenState(row, []);
  const keys = secretKeysFor(area, row);
  return keys.length === 0 ? 'none' : tokenState(row, keys);
}

/** Cloud or Data Center, read from the host the connection is on and the area's own host patterns; null when the area has no such choice. */
export function deploymentOf(area: AreaInfo, row: { host: string | null }): string | null {
  const by = area.variantBy && area.connection.find((f) => f.name === area.variantBy)?.choices;
  if (!by || !row.host) return null;
  const hit = by.options.find((o) => o.hosts?.some((h) => hostMatches(row.host!, h)));
  const fallback = by.options.find((o) => !o.hosts?.length);
  return (hit ?? fallback)?.label ?? null;
}

/** A name nothing has: the area's own, else `jira-2`, `jira-3`. */
export function freeName(area: string, taken: readonly string[]): string {
  if (!taken.includes(area)) return area;
  for (let n = 2; ; n++) if (!taken.includes(`${area}-${n}`)) return `${area}-${n}`;
}

/** What a typed location is: a repository address (https, ssh or scp-style) or a folder path. The page can't see the disk, so it never says a folder exists. */
export type LocationKind = 'address' | 'folder' | 'empty';
export function locationKind(text: string): LocationKind {
  const t = text.trim();
  if (t === '') return 'empty';
  return /^(https?|ssh|git):\/\//i.test(t) || /^[\w.-]+@[\w.-]+:/.test(t) ? 'address' : 'folder';
}

/** One problem per row worth saying: a repeat of an earlier row. Empty rows are ignored. */
export function locationProblems(rows: readonly string[]): Array<string | null> {
  const seen = new Set<string>();
  return rows.map((r) => {
    const t = r.trim().replace(/[\\/]+$/, '');
    if (t === '') return null;
    const key = t.toLowerCase();
    if (seen.has(key)) return 'Already in the list above.';
    seen.add(key);
    return null;
  });
}

