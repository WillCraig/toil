/**
 * The fixture `execute()`: `@imagile-dev/toil/api`'s `execute()`, signature
 * and all, answering from canned, sanitized envelopes keyed by command and
 * input. The site preview runs on it and so do the UI's tests; the local app
 * will pass the real one. test/registry.test.ts holds every call in `CANNED`
 * to the real registry (the command exists, it only reads, and its input
 * validates against the command's own schema), so a renamed command or flag
 * fails the build rather than the demo.
 *
 * A call it has no answer for gets the envelope a real refusal would be
 * (`ok: false`, a message and a fix), never a throw, and so does any call that
 * isn't read-only: the UI only ever reads. Every call is recorded, which is how
 * the tests know each panel asked only for what it shows. It returns exactly
 * what it was told to, a property the vendor demos never quite managed.
 */

import { ADO_FEED_FIELDS } from '../ado-revisions.ts';
import { CODEOWNERS_PATHS, JQL, PR_INCLUDE, WIQL } from '../load.ts';
import type { Call, Envelope, Execute, ExecuteOptions } from '../toil.ts';
import { ADO_CI_RUNS, ADO_DEPLOY_RUNS, ADO_PR_GETS, ADO_PRS, BITBUCKET_CLOUD_PR_GETS, BITBUCKET_CLOUD_PRS, BITBUCKET_PR_GETS, BITBUCKET_PRS, GITHUB_CODEOWNERS, GITHUB_PR_GETS, GITHUB_PRS, JENKINS_RUNS, OPENSHIFT } from './delivery.ts';
import { DOSSIERS, fileOf, listData, showData, type DossierFile } from './dossiers.ts';
import {
  ADO_BATCH, ADO_FEED, ADO_FEED_GAPS, ADO_IDS, ADO_ITERATIONS, ADO_REVISIONS, ADO_WIQL, GITHUB_EVENTS, GITHUB_ISSUES, GITHUB_NUMBERS, GITHUB_PROJECT_ITEMS,
  ADO_STATES, JIRA_CHANGELOGS, JIRA_CUT_SHORT, JIRA_SEARCH_WITH_CHANGELOGS, JIRA_TRANSITIONS,
} from './work.ts';

/** The moment the sample data was read: day seven of Sprint 42. */
export const FIXTURE_NOW = '2026-10-13T08:00:00.000Z';
const VERSION = '0.1.0-alpha.1';

export interface Canned {
  command: string;
  input: Record<string, unknown>;
  data: unknown;
  /** The dossier and area whose connection the call used, for `meta.context`. */
  dossier?: string;
  area?: string;
  env?: string;
  /** For an area with more than one deployment, which one the connection is (`cloud`). */
  deployment?: string;
}


const card = 'card-payments';
const settle = 'settlement';
const checkout = 'checkout-web';
/** The repository the sample's GitHub calls name outright: the loader passes owner and repo for every repository it reads. */
const GH = { owner: 'imagile', repo: 'payments-web' };
const at = (dossier: string, area: string, env?: string, deployment?: string) => ({ dossier, area, ...(env ? { env } : {}), ...(deployment ? { deployment } : {}) });
/** `pr get <n> --include …` for each pull request a host's fixture holds. */
const gets = (dossier: string, area: string, field: string, byNumber: Record<number, unknown>, deployment?: string, scope: Record<string, unknown> = {}): Canned[] =>
  Object.entries(byNumber).map(([n, data]) => ({ command: `${area} pr get`, input: { dossier, ...scope, [field]: Number(n), include: PR_INCLUDE }, data, ...at(dossier, area, undefined, deployment) }));

export const CANNED: Canned[] = [
  { command: 'dossiers list', input: {}, data: listData() },
  ...DOSSIERS.map((d) => ({ command: 'dossiers show', input: { dossier: d.name }, data: showData(d) })),

  // card-payments
  // The search carries each issue's history (toil's --changelog); the sample cuts one short, and that issue is read with its own call.
  { command: 'jira issue search', input: { dossier: card, jql: JQL('PAY'), changelog: true }, data: JIRA_SEARCH_WITH_CHANGELOGS, ...at(card, 'jira') },
  ...JIRA_CUT_SHORT.map((key) => ({ command: 'jira issue history', input: { dossier: card, key }, data: JIRA_CHANGELOGS[key], ...at(card, 'jira') })),
  // The readiness gate's one live read (#307), made only when a person presses for it on an item's page.
  ...Object.entries(JIRA_TRANSITIONS).map(([key, data]) => ({ command: 'jira issue transitions', input: { dossier: card, key }, data, ...at(card, 'jira') })),
  { command: 'bitbucket pr list', input: { dossier: card, state: 'ALL' }, data: BITBUCKET_PRS, ...at(card, 'bitbucket') },
  ...gets(card, 'bitbucket', 'id', BITBUCKET_PR_GETS),
  ...Object.entries(JENKINS_RUNS).map(([pr, runs]) => ({ command: 'jenkins pipeline runs', input: { dossier: card, name: `payments-core/PR-${pr}`, limit: 5 }, data: runs, ...at(card, 'jenkins') })),
  { command: 'openshift deployment list', input: { dossier: card, env: 'dev', namespace: 'payments-dev' }, data: OPENSHIFT['payments-dev'], ...at(card, 'openshift', 'dev') },
  { command: 'openshift deployment list', input: { dossier: card, env: 'prod', namespace: 'payments-prod' }, data: OPENSHIFT['payments-prod'], ...at(card, 'openshift', 'prod') },

  // settlement
  { command: 'ado work-item iterations', input: { dossier: settle }, data: ADO_ITERATIONS, ...at(settle, 'ado') },
  { command: 'ado work-item search', input: { dossier: settle, wiql: WIQL }, data: ADO_WIQL, ...at(settle, 'ado') },
  { command: 'ado work-item get-many', input: { dossier: settle, id: ADO_IDS }, data: ADO_BATCH, ...at(settle, 'ado') },
  // The feed holds every item's revisions but the ones that start before it; those are read one by one.
  { command: 'ado work-item feed', input: { dossier: settle, fields: ADO_FEED_FIELDS }, data: ADO_FEED, ...at(settle, 'ado') },
  ...ADO_FEED_GAPS.map((id) => ({ command: 'ado work-item history', input: { dossier: settle, id }, data: ADO_REVISIONS[id], ...at(settle, 'ado') })),
  ...Object.entries(ADO_STATES).map(([type, data]) => ({ command: 'ado work-item states', input: { dossier: settle, type }, data, ...at(settle, 'ado') })),
  { command: 'ado pr list', input: { dossier: settle, state: 'all' }, data: ADO_PRS, ...at(settle, 'ado') },
  ...gets(settle, 'ado', 'id', ADO_PR_GETS),
  { command: 'ado run list', input: { dossier: settle, name: 'settlement-ci', top: 20 }, data: ADO_CI_RUNS, ...at(settle, 'ado') },
  { command: 'ado run list', input: { dossier: settle, name: 'settlement-deploy', top: 20 }, data: ADO_DEPLOY_RUNS, ...at(settle, 'ado') },

  // checkout-web
  { command: 'github project items', input: { dossier: checkout, owner: GH.owner, project: 7 }, data: GITHUB_PROJECT_ITEMS, ...at(checkout, 'github') },
  { command: 'github issue get', input: { dossier: checkout, ...GH, number: GITHUB_NUMBERS, subIssues: true }, data: GITHUB_ISSUES, ...at(checkout, 'github') },
  ...GITHUB_NUMBERS.map((number) => ({ command: 'github issue history', input: { dossier: checkout, ...GH, number }, data: GITHUB_EVENTS[number], ...at(checkout, 'github') })),
  { command: 'github pr list', input: { dossier: checkout, ...GH, state: 'all' }, data: GITHUB_PRS, ...at(checkout, 'github') },
  ...gets(checkout, 'github', 'number', GITHUB_PR_GETS, undefined, GH),
  { command: 'github repo file', input: { dossier: checkout, ...GH, path: CODEOWNERS_PATHS[0] }, data: GITHUB_CODEOWNERS, ...at(checkout, 'github') },
  { command: 'bitbucket pr list', input: { dossier: checkout, state: 'ALL' }, data: BITBUCKET_CLOUD_PRS, ...at(checkout, 'bitbucket', undefined, 'cloud') },
  ...gets(checkout, 'bitbucket', 'id', BITBUCKET_CLOUD_PR_GETS, 'cloud'),
  { command: 'openshift deployment list', input: { dossier: checkout, env: 'staging', namespace: 'checkout-staging' }, data: OPENSHIFT['checkout-staging'], ...at(checkout, 'openshift', 'staging') },
  { command: 'openshift deployment list', input: { dossier: checkout, env: 'prod', namespace: 'checkout-prod' }, data: OPENSHIFT['checkout-prod'], ...at(checkout, 'openshift', 'prod') },
];

/** One string per command and input, whatever order the input's keys came in. */
export function callKey(command: string, input: Record<string, unknown>): string {
  // The feed's start date moves with the clock, so it is not what the call asked for (the cache's inputKey leaves it out for this command too).
  if (command === 'ado work-item feed') input = Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'updatedSince'));
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)])) : v;
  return `${command} ${JSON.stringify(sort(input))}`;
}

/** `meta.context` as toil reports it for a call a dossier supplied. */
function contextOf(c: Canned) {
  if (!c.dossier || !c.area) return undefined;
  const d = DOSSIERS.find((x) => x.name === c.dossier) as DossierFile;
  const section = ((c.env ? d.environments?.[c.env]?.[c.area] : undefined) ?? d[c.area]) as Record<string, unknown>;
  const inputs = (showData(d).areas[c.area] as { inputs: Record<string, string> } | undefined)?.inputs ?? {};
  return {
    dossier: { name: d.name, source: 'user' as const, file: fileOf(d.name), by: 'input' as const },
    connection: { value: String(section.connection), source: 'dossier' as const, ...(c.deployment ? { deployment: c.deployment } : {}) },
    ...(Object.keys(inputs).length ? { inputs: Object.fromEntries(Object.entries(inputs).map(([k, value]) => [k, { value, source: 'dossier' as const }])) } : {}),
  };
}

function envelope(c: Canned): Envelope {
  const context = contextOf(c);
  return { ok: true, data: c.data, error: null, meta: { command: c.command, durationMs: 0, version: VERSION, contractVersion: 1, ...(context ? { context } : {}) } };
}

function refusal(command: string, code: 'INVALID_INPUT' | 'WRITE_DISABLED', message: string, fix: string): Envelope {
  return { ok: false, data: null, error: { code, message, fix }, meta: { command, durationMs: 0, version: VERSION, contractVersion: 1 } };
}

export interface FixtureExecute {
  execute: Execute;
  /** Every call made so far, in order, answered or not. */
  calls: Call[];
}

export function fixtureExecute(canned: Canned[] = CANNED): FixtureExecute {
  const answers = new Map(canned.map((c) => [callKey(c.command, c.input), c]));
  const calls: Call[] = [];
  const execute = async (command: string, input: Record<string, unknown> = {}, options: ExecuteOptions = {}): Promise<Envelope> => {
    const hit = answers.get(callKey(command, input));
    const result = options.readOnly !== true
      ? refusal(command, 'WRITE_DISABLED', `The preview answers read-only calls only, and this ${command} call didn't pass readOnly.`, 'Pass { readOnly: true }, as every Toil UI call does.')
      : hit
        ? envelope(hit)
        : refusal(command, 'INVALID_INPUT', `The preview has no sample answer for ${callKey(command, input)}.`, 'Add the call to CANNED in ui/src/fixtures/execute.ts, with data in the command\'s own output shape.');
    calls.push({ command, input, ok: result.ok, error: result.ok ? null : `${result.error.message} ${result.error.fix ?? ''}`.trim() });
    // A real call takes a moment; so does this one, so loading states render.
    await Promise.resolve();
    return structuredClone(result);
  };
  return { execute, calls };
}
