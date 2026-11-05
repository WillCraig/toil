/**
 * The work items each toil project's tracker returns, as toil's commands print
 * them. They are the OWI sprint fixture's own input
 * (test/fixtures/owi/sprint.ts, read in place, so there is one copy): the
 * Jira issues, Azure DevOps work items and GitHub issues `toil util owi map`
 * turns into test/fixtures/owi/sprint-42.owi.json, split by the toil project that
 * holds them. The dashboard asks for each item's history as well, so the items
 * that fixture has none for get a history here that agrees with their fields:
 * an empty Jira changelog or GitHub timeline, and Azure DevOps revisions from
 * creation on. One sprint, filed under three toil projects, and still no extra meetings.
 */

import { sprintEnvelopes } from '../../../test/fixtures/owi/sprint.ts';

type Env = { data?: unknown; meta?: { command?: string } };
type Wrapped = { key: string; history: Env };

const envs = sprintEnvelopes as Array<Env | Wrapped>;
const isWrapped = (e: Env | Wrapped): e is Wrapped => 'history' in e;
const dataOf = (command: string): unknown => (envs.find((e) => !isWrapped(e) && e.meta?.command === command) as Env).data;
const historyOf = (command: string) => envs.filter(isWrapped).filter((e) => e.history.meta?.command === command);

// Jira Data Center: card-payments --------------------------------------------

const jiraIssues = (dataOf('jira issue get') as { issues: Array<{ key: string }> }).issues;

/**
 * The acceptance criteria card-payments keeps in a custom field (its toil project
 * names `customfield_10500`), for the readiness gate (#307): PAY-101 and
 * PAY-102 have them, the rest don't. Added here rather than in the OWI
 * fixture, which core's own tests pin.
 */
export const JIRA_ACCEPTANCE: Record<string, string> = {
  'PAY-101': ['* The PAN is swapped for a token before the first log line', '* A replayed token is refused'].join('\n'),
  'PAY-102': ['* A stored token charges once', '* A second charge with the same idempotency key is refused'].join('\n'),
};

/** `jira issue search`'s data: Jira's own search answer. */
export const JIRA_SEARCH = {
  startAt: 0,
  maxResults: 50,
  total: jiraIssues.length,
  issues: jiraIssues.map((i) => (JIRA_ACCEPTANCE[i.key] ? { ...i, fields: { ...(i as { fields?: Record<string, unknown> }).fields, customfield_10500: JIRA_ACCEPTANCE[i.key] } } : i)),
};
export const JIRA_KEYS = jiraIssues.map((i) => i.key);

const SMITH = { self: 'https://jira.imagile.dev/rest/api/2/user?username=jsmith', name: 'jsmith', key: 'jsmith', displayName: 'J. Smith', active: true };
const jiraStatus = (id: number, at: string, from: [string, string], to: [string, string]) => ({
  id: String(id),
  author: SMITH,
  created: at,
  items: [{ field: 'status', fieldtype: 'jira', from: from[0], fromString: from[1], to: to[0], toString: to[1] }],
});

/**
 * Changelogs for the issues the OWI fixture keeps none for, matching their
 * fields: PAY-106, a sub-task created on day one and resolved on 10-07, was
 * started the day after it was created.
 */
const moreChangelogs: Record<string, unknown[]> = {
  'PAY-106': [
    jiraStatus(40501, '2026-10-06T09:30:00.000+0000', ['10000', 'To Do'], ['3', 'In Progress']),
    jiraStatus(40502, '2026-10-07T12:00:00.000+0000', ['3', 'In Progress'], ['10001', 'Done']),
  ],
};

/** Each issue's `jira issue history` data; an issue nothing changed on since it was created has an empty one. */
export const JIRA_CHANGELOGS: Record<string, unknown> = Object.fromEntries(
  JIRA_KEYS.map((key) => [key, historyOf('jira issue history').find((h) => h.key === key)?.history.data ?? moreChangelogs[key] ?? []]),
);

// Azure DevOps Server: settlement -------------------------------------------

export const ADO_ITERATIONS = dataOf('ado work-item iterations');
const adoBatch = dataOf('ado work-item get-many') as { count: number; value: Array<{ id: number; rev?: number; fields: Record<string, unknown> }>; missing: unknown[] };
export const ADO_IDS = adoBatch.value.map((w) => w.id);

const ADO = 'https://ado.imagile.dev/DefaultCollection';

/** `ado work-item search`'s data: the WIQL answer, ids and urls only. */
export const ADO_WIQL = {
  queryType: 'flat',
  queryResultType: 'workItem',
  asOf: '2026-10-13T08:00:00.000Z',
  columns: [{ referenceName: 'System.Id', name: 'ID', url: `${ADO}/_apis/wit/fields/System.Id` }],
  workItems: ADO_IDS.map((id) => ({ id, url: `${ADO}/_apis/wit/workItems/${id}` })),
};

const fixtureRevisions = new Map(
  envs
    .filter((e): e is Env => !isWrapped(e) && e.meta?.command === 'ado work-item history')
    .map((e) => [(e.data as Array<{ id: number }>)[0]!.id, e.data]),
);

const person = (user: string, displayName: string) => ({ displayName, id: `abc12345-0000-0000-0000-0000000000${user.length}0`, uniqueName: `IMAGILE\\${user}` });
const NAKAMURA = person('knakamura', 'K. Nakamura');
const OKAFOR = person('dokafor', 'D. Okafor');

const revision = (id: number, rev: number, at: string, by: typeof OKAFOR, type: string, state: string, iteration: string) => ({
  id,
  rev,
  fields: { 'System.WorkItemType': type, 'System.State': state, 'System.IterationPath': iteration, 'System.ChangedDate': at, 'System.ChangedBy': by },
  url: `${ADO}/_apis/wit/workItems/${id}/revisions/${rev}`,
});
const ROOT = 'Payments';
const S42 = 'Payments\\Sprint 42';

/** Revisions for the items the OWI fixture keeps none for, matching their fields. */
const moreRevisions: Record<number, unknown[]> = {
  2301: [revision(2301, 1, '2026-08-24T14:00:00Z', NAKAMURA, 'Feature', 'New', ROOT), revision(2301, 2, '2026-10-05T09:30:00Z', NAKAMURA, 'Feature', 'Active', ROOT)],
  2303: [revision(2303, 1, '2026-09-10T10:05:00Z', NAKAMURA, 'User Story', 'New', ROOT), revision(2303, 2, '2026-09-30T15:00:00Z', NAKAMURA, 'User Story', 'New', S42)],
  2305: [
    revision(2305, 1, '2026-10-05T10:00:00Z', OKAFOR, 'Task', 'New', S42),
    revision(2305, 2, '2026-10-06T09:00:00Z', OKAFOR, 'Task', 'Active', S42),
    revision(2305, 3, '2026-10-08T13:00:00Z', OKAFOR, 'Task', 'Closed', S42),
  ],
  2307: [revision(2307, 1, '2026-09-01T09:00:00Z', NAKAMURA, 'Bug', 'New', ROOT), revision(2307, 2, '2026-09-30T15:00:00Z', NAKAMURA, 'Bug', 'New', S42), revision(2307, 3, '2026-10-07T09:00:00Z', NAKAMURA, 'Bug', 'Removed', S42)],
};

/** Each work item's `ado work-item history` data, oldest first. */
export const ADO_REVISIONS: Record<number, unknown> = Object.fromEntries(ADO_IDS.map((id) => [id, fixtureRevisions.get(id) ?? moreRevisions[id]]));

/**
 * `ado work-item get-many`'s data. The OWI fixture gives every item the same
 * `rev`, which no item with a history of its own could have: a work item's
 * `rev` is the number of its latest revision, so each gets its history's length.
 */
export const ADO_BATCH = { ...adoBatch, value: adoBatch.value.map((w) => ({ ...w, rev: (ADO_REVISIONS[w.id] as unknown[]).length })) };

/** How many days back from the sample's now the sample feed starts: the window (42 days), and the day src/ado-revisions.ts adds. */
const FEED_DAYS = 43;
const FEED_FROM = Date.parse('2026-10-13T08:00:00.000Z') - FEED_DAYS * 86_400_000;

type Revision = { id: number; rev: number; fields: Record<string, unknown> };
/** A person as the feed sends one: `Name <unique name>`, where `work-item history` sends the identity object. */
const asText = (who: unknown) => (typeof who === 'object' && who !== null ? `${(who as { displayName: string }).displayName} <${(who as { uniqueName: string }).uniqueName}>` : who);

/**
 * `ado work-item feed`'s data for the sample: every revision after
 * the feed's start, in the order they were made, as the reporting feed sends
 * them ({ id, rev, fields } with people as text and no url). The sample's
 * items were created from late August, so one of them (2301, from the 24th) is
 * not held whole and is read with `work-item history`.
 */
export const ADO_FEED: Revision[] = ADO_IDS.flatMap((id) => ADO_REVISIONS[id] as Revision[])
  .filter((r) => Date.parse(String(r.fields['System.ChangedDate'])) > FEED_FROM)
  .map((r): Revision => ({ id: r.id, rev: r.rev, fields: { 'System.Id': r.id, 'System.Rev': r.rev, ...r.fields, 'System.ChangedBy': asText(r.fields['System.ChangedBy']) } }))
  .sort((a, b) => Date.parse(String(a.fields['System.ChangedDate'])) - Date.parse(String(b.fields['System.ChangedDate'])) || a.id - b.id);

/** The items whose history the sample feed doesn't hold whole: the ones the sample still reads one by one. */
export const ADO_FEED_GAPS: number[] = ADO_IDS.filter((id) => ADO_FEED.filter((r) => r.id === id).length !== (ADO_REVISIONS[id] as unknown[]).length);

// GitHub Enterprise: checkout-web --------------------------------------------

export const GITHUB_PROJECT_ITEMS = dataOf('github project items') as Array<{ content: { number: number; repository: { nameWithOwner: string } } }>;
export const GITHUB_NUMBERS = GITHUB_PROJECT_ITEMS.map((i) => i.content.number);
export const GITHUB_ISSUES = dataOf('github issue get');

/** Each issue's `github issue history` timeline; an issue with no events has an empty one. */
export const GITHUB_EVENTS: Record<number, unknown> = Object.fromEntries(
  GITHUB_NUMBERS.map((n) => [n, historyOf('github issue history').find((h) => h.key === String(n))?.history.data ?? []]),
);

// The readiness gate's one live read (#307) ------------------------------------

const jiraStatus2 = (name: string, id: string, key: 'new' | 'indeterminate' | 'done', category: string) => ({ self: `https://jira.imagile.dev/rest/api/2/status/${id}`, name, id, statusCategory: { id: key === 'new' ? 2 : key === 'done' ? 3 : 4, key, name: category } });
const TO = {
  progress: jiraStatus2('In Progress', '3', 'indeterminate', 'In Progress'),
  review: jiraStatus2('In Review', '10100', 'indeterminate', 'In Progress'),
  done: jiraStatus2('Done', '10001', 'done', 'Done'),
  todo: jiraStatus2('To Do', '10000', 'new', 'To Do'),
};
/** The moves Jira offers from each status in the sample workflow: To Do only starts, so it can't go straight to Done. */
const MOVES: Record<string, Array<{ id: string; name: string; to: unknown }>> = {
  'To Do': [{ id: '11', name: 'Start Progress', to: TO.progress }],
  'In Progress': [
    { id: '21', name: 'Submit for Review', to: TO.review },
    { id: '31', name: 'Done', to: TO.done },
    { id: '41', name: 'Stop Progress', to: TO.todo },
  ],
  'In Review': [
    { id: '31', name: 'Done', to: TO.done },
    { id: '51', name: 'Back to In Progress', to: TO.progress },
  ],
};
const statusName = (i: unknown) => String(((i as { fields?: { status?: { name?: string } } }).fields?.status?.name) ?? '');

/** `jira issue transitions <key>`'s data for each issue that isn't done: Jira's own transitions list. */
export const JIRA_TRANSITIONS: Record<string, unknown> = Object.fromEntries(jiraIssues.filter((i) => statusName(i) !== 'Done').map((i) => [i.key, MOVES[statusName(i)] ?? []]));

/** `ado work-item states --type <type>`'s data for each type with an open item on the settlement board: the Agile process's states. */
const AGILE = [
  { name: 'New', color: 'b2b2b2', category: 'Proposed' },
  { name: 'Active', color: '007acc', category: 'InProgress' },
  { name: 'Resolved', color: 'ff9d00', category: 'Resolved' },
  { name: 'Closed', color: '339933', category: 'Completed' },
  { name: 'Removed', color: 'ffffff', category: 'Removed' },
];
export const ADO_STATES: Record<string, unknown> = {
  'User Story': AGILE,
  Bug: AGILE,
  Feature: AGILE,
};

/** The issues whose inline changelog the sample cuts short: the only ones the dashboard reads with `issue history`. */
export const JIRA_CUT_SHORT = ['PAY-106'];

/**
 * `jira issue search --changelog`'s data: the same answer with each issue's
 * history inline, as Jira sends it (`changelog: { startAt, maxResults, total,
 * histories }`). The entries are the ones `issue history` returns for the key.
 */
export const JIRA_SEARCH_WITH_CHANGELOGS = {
  ...JIRA_SEARCH,
  issues: JIRA_SEARCH.issues.map((i) => {
    const key = (i as { key: string }).key;
    const histories = JIRA_CHANGELOGS[key] as unknown[];
    // An issue in JIRA_CUT_SHORT comes back with the first entry only, as a long history does, so the dashboard reads it with `issue history`.
    const sent = JIRA_CUT_SHORT.includes(key) ? histories.slice(0, 1) : histories;
    return { ...i, changelog: { startAt: 0, maxResults: 100, total: histories.length, histories: sent } };
  }),
};
