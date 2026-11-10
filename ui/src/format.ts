/**
 * Display helpers shared by the views: source names, item labels, dates.
 * Dates are shown in UTC and say so, since the sprint's sources disagree about
 * time zones as it is.
 */

import type { Person, SourceKind, WorkItem } from './toil.ts';

export const SOURCE_LABEL: Record<SourceKind, string> = {
  jira: 'Jira',
  ado: 'Azure DevOps',
  github: 'GitHub',
  bitbucket: 'Bitbucket',
  jenkins: 'Jenkins',
  openshift: 'OpenShift',
};

/** An area reads as its family's name (the first word of the area), which is what a person recognises. */
export function sourceLabel(area: string): string {
  const family = area.split('-')[0] as SourceKind;
  return SOURCE_LABEL[family] ?? area;
}

/** A source's short name, for a citation in running text, where the full name is one hover away. */
const SOURCE_SHORT: Partial<Record<SourceKind, string>> = { ado: 'ADO', github: 'GH', bitbucket: 'BB' };
export function sourceShort(area: string): string {
  const family = area.split('-')[0] as SourceKind;
  return SOURCE_SHORT[family] ?? sourceLabel(area);
}

/** The source's own key, shortened where the owner repeats on every item (`payments-web#41`). */
export function shortKey(item: WorkItem): string {
  return item.source.key.replace(/^[^/]+\//, '');
}

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC',
});

export const day = (iso: string) => DATE.format(new Date(iso));
/** A date and time in UTC; an empty or unparsable one reads as unknown rather than breaking the view. */
export const dateTime = (iso: string) => (Number.isNaN(Date.parse(iso)) ? 'at an unknown time' : `${DATE_TIME.format(new Date(iso))} UTC`);

/** A person by name, else by the id the source gave (GitHub gives only a login). */
export const personText = (p: Person | null) => (p ? (p.name ?? p.id) : 'Unassigned');

export const toilProjectHref = (toilProject: string) => `#/project/${encodeURIComponent(toilProject)}`;
export const itemHref = (toilProject: string, id: string) => `${toilProjectHref(toilProject)}/item/${encodeURIComponent(id)}`;
/** The page you're on with an item's drawer open over it (#494): its path, then `?item=`. */
export const peekHref = (page: string, id: string) => `${page.split('?')[0] || '#/'}?item=${encodeURIComponent(id)}`;
/** The page you're on with its drawer closed. */
export const unpeekHref = (page: string) => page.split('?')[0] || '#/';
export const prsHref = (toilProject: string) => `${toilProjectHref(toilProject)}/prs`;
export const peopleHref = (toilProject: string) => `${toilProjectHref(toilProject)}/people`;
/** The Command Center (#307): every work item with its readiness verdict. */
export const commandCenterHref = (toilProject: string) => `${toilProjectHref(toilProject)}/command-center`;
/** The Board tab (#394), or the board filtered to one person (#292), by the key the People view gives them. */
export const boardHref = (toilProject: string, person?: string) => `${toilProjectHref(toilProject)}/board${person ? `/${encodeURIComponent(person)}` : ''}`;
/** The Dependencies tab (#394). */
export const dependenciesHref = (toilProject: string) => `${toilProjectHref(toilProject)}/dependencies`;
/** The Analyses tab (#394): Analyze's pulse checks. */
export const analysesHref = (toilProject: string) => `${toilProjectHref(toilProject)}/analyses`;
/** One analysis, opened again (#395). */
export const analysisHref = (toilProject: string, id: string) => `${analysesHref(toilProject)}/${encodeURIComponent(id)}`;
/** The worklog (#308): its calendar, or one UTC day's page. */
export const worklogHref = (toilProject: string, day?: string) => `${toilProjectHref(toilProject)}/worklog${day ? `/${day}` : ''}`;
/** The stand-up (#345): since the last working day, or a range of UTC days. */
export const standupHref = (toilProject: string, range?: { from: string; to: string }) => `${toilProjectHref(toilProject)}/worklog/standup${range ? `/${range.from}/${range.to}` : ''}`;

/**
 * Edit links (#346): where each configurable value is set. A pencil only
 * navigates; the settings page it opens lands on that connection, toil project
 * section or the Codex rates.
 */
export type ToilProjectSection = 'sources' | 'repos' | 'fields' | 'find-fields' | 'people' | 'wip' | 'analyze';
export const connectionEditHref = (name: string) => `#/settings/connections/${encodeURIComponent(name)}`;
export const toilProjectEditHref = (toilProject: string, section: ToilProjectSection) => `#/settings/projects/${encodeURIComponent(toilProject)}/${section}`;
export const AGENT_SETTINGS_HREF = '#/settings/agent';
export const RATES_HREF = '#/settings/usage/rates';

/** A pull request's short name: `payments-core #311`, the host and owner left to the panel. */
export const prName = (id: string) => {
  const key = id.slice(id.indexOf(':') + 1);
  const repo = key.slice(0, key.lastIndexOf('#')).replace(/^.*\//, '');
  return `${repo} ${key.slice(key.lastIndexOf('#'))}`;
};

export const STATUS_CATEGORY_LABEL = { TODO: 'To do', IN_PROGRESS: 'In progress', DONE: 'Done', UNKNOWN: 'Unknown' } as const;

/** An estimate with the field it came from, which the UI always shows (#206). */
export function estimateText(item: WorkItem): string {
  const e = item.estimate;
  if (!e) return 'No estimate';
  const unit = e.unit === 'points' ? (e.value === 1 ? 'point' : 'points') : e.unit === 'hours' ? (e.value === 1 ? 'hour' : 'hours') : e.value === 1 ? 'day' : 'days';
  return `${e.value} ${unit}`;
}
