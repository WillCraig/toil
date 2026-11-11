/**
 * The settings pages' sample data, for the site preview and `toil-ui
 * --sample`: what `toil connections list`, `projects list`, `projects show`,
 * `projects check`, `projects onboard --plan` and `connections test` print for the preview's own
 * connections and toil projects, what `audit stats` and `audit list` print for a
 * sample month (usage.ts), and the areas' connection fields as the registry
 * describes them (config-areas.json, which test/config.test.ts holds equal to
 * the real registry). Every change is refused, saying why: the preview has
 * no configuration to change, so nothing on these pages changes anything.
 *
 * The connections are the ones the preview's toil projects name. `github` is made
 * by env vars alone, the way CI defines one, so the pages show it read-only.
 * A sandbox with the furniture glued down.
 */

import { CONFIG_COMMANDS, CONFIG_READS, DEFAULT_TIMEOUT_MS, type AreaInfo, type ConfigApi, type ConnectionsData, type SettingsInfo } from '../config.ts';
import type { Envelope } from '../toil.ts';
import AREAS from './config-areas.json' with { type: 'json' };
import { TOIL_PROJECTS, archivedListData, fileOf, listData, showData } from './toil-projects.ts';
import { callKey } from './execute.ts';
import { usageCanned } from './usage.ts';

const VERSION = '0.1.0-alpha.1';
const CONFIG_FILE = '/home/you/.toil/config.json';

/** Why the preview's settings pages change nothing, said beside every action. */
export const PREVIEW_DISABLED = 'This is the preview, on sample data: it has no configuration of yours to change, so every action here is turned off. In Toil UI on your own machine, these run toil\'s own commands.';

export const FIXTURE_AREAS: AreaInfo[] = AREAS as AreaInfo[];

export const FIXTURE_CONNECTIONS: ConnectionsData = {
  configFile: CONFIG_FILE,
  connections: [
    { name: 'corp-ado', area: 'ado', isDefault: true, host: 'ado.imagile.dev', writes: false, values: { baseUrl: 'file', collection: 'file', pat: 'store' }, definedIn: 'file' },
    { name: 'corp-bitbucket', area: 'bitbucket', isDefault: true, host: 'bitbucket.imagile.dev', writes: false, values: { baseUrl: 'file', pat: 'store' }, definedIn: 'file' },
    { name: 'corp-jenkins', area: 'jenkins', isDefault: true, host: 'jenkins.imagile.dev', writes: false, values: { baseUrl: 'file', username: 'file', apiToken: 'store' }, definedIn: 'file' },
    { name: 'corp-jira', area: 'jira', isDefault: true, host: 'jira.imagile.dev', writes: true, values: { baseUrl: 'file', apiToken: 'store', writes: 'file' }, definedIn: 'file' },
    { name: 'github', area: 'github', isDefault: true, host: 'ghe.imagile.dev', writes: false, values: { baseUrl: 'env', token: 'ci' }, definedIn: 'env' },
    { name: 'ocp-nonprod', area: 'openshift', isDefault: true, host: 'api.ocp-nonprod.imagile.dev:6443', writes: false, values: { baseUrl: 'file', env: 'file', token: 'store' }, definedIn: 'file' },
    { name: 'ocp-prod', area: 'openshift', isDefault: false, host: 'api.ocp-prod.imagile.dev:6443', writes: false, values: { baseUrl: 'file', env: 'file', token: 'store' }, definedIn: 'file' },
  ],
};

/** Each area's live check, as `connections test` reports it (test/config.test.ts holds them to the areas' own probes). */
export const PROBES: Record<string, string> = {
  ado: 'GET /DefaultCollection/_apis/connectionData',
  bitbucket: 'GET /rest/api/1.0/profile/recent/repos',
  jenkins: 'GET /me/api/json',
  jira: 'GET /rest/api/2/myself',
  github: 'GET /user',
  openshift: 'GET /api/v1',
};

/**
 * Set up this repo's sample: `projects onboard --plan` in a clone of
 * payments-web, whose checked-in checkout-web selects each area by host. Three
 * areas have a connection and read; the SDK's Bitbucket server has none yet,
 * so it offers one on that host, and projects check says the same.
 */
export const ONBOARD_PLAN = {
  toilProject: { name: 'checkout-web', source: 'repo', file: '/home/you/code/payments-web/.toil/projects/checkout-web.json' },
  ownCopy: null,
  plan: true,
  ok: false,
  areas: [
    { area: 'github', env: null, path: 'github', selects: { host: 'ghe.imagile.dev' }, status: 'matched', connection: 'github', test: { ok: true, request: PROBES.github, live: true } },
    {
      area: 'bitbucket',
      env: null,
      path: 'bitbucket',
      selects: { host: 'bitbucket-sdk.imagile.dev' },
      status: 'missing',
      connection: null,
      problem: { code: 'NOT_CONFIGURED', message: 'You have no bitbucket connection on bitbucket-sdk.imagile.dev.', fix: 'Run toil projects onboard checkout-web in a terminal, or toil connections add bitbucket --area bitbucket with a base URL on bitbucket-sdk.imagile.dev (https://bitbucket-sdk.imagile.dev).' },
      suggest: { name: 'bitbucket', baseUrl: 'https://bitbucket-sdk.imagile.dev' },
      test: null,
    },
    { area: 'openshift', env: 'staging', path: 'environments.staging.openshift', selects: { host: 'api.ocp-nonprod.imagile.dev:6443' }, status: 'matched', connection: 'ocp-nonprod', test: { ok: true, request: PROBES.openshift, live: true } },
    { area: 'openshift', env: 'prod', path: 'environments.prod.openshift', selects: { host: 'api.ocp-prod.imagile.dev:6443' }, status: 'matched', connection: 'ocp-prod', test: { ok: true, request: PROBES.openshift, live: true } },
  ],
  check: {
    ok: false,
    problems: [{ level: 'error', code: 'TOIL_PROJECT_HOST_UNMATCHED', path: 'bitbucket.host', message: 'Toil project checkout-web uses the bitbucket connection on bitbucket-sdk.imagile.dev, and you have no bitbucket connection with that host.' }],
  },
};

/** `toil theme list` with no theme set (#427). */
export const THEME_LIST = {
  current: 'crate',
  source: 'default',
  default: 'crate',
  themes: [
    ['plain', 'Plain'], ['crate', 'Crate'], ['harvest', 'Harvest'], ['starship', 'Starship'],
    ['realm', 'Realm'], ['sprawl', 'Sprawl'], ['frontier', 'Frontier'], ['overworld', 'Overworld'],
  ].map(([name, label]) => ({ name, label, current: name === 'crate', default: name === 'crate' })),
};

interface Answer {
  command: string;
  input: Record<string, unknown>;
  data: unknown;
}

/**
 * `jira field discover` on the preview's Jira: one Story with a sprint and
 * points, one Bug with a Crew, and no Epic to read, which is unknown, not none.
 * Shaped as toil prints it (src/areas/jira/discover.ts); the commands are
 * the ones it is sure of.
 */
export const FIELD_DISCOVERY = {
  deployment: 'cloud',
  mode: 'sample',
  project: 'PAY',
  issueTypes: [
    { name: 'Story', id: '10001', sampled: ['PAY-107'], status: 'sampled', fields: ['customfield_10016', 'customfield_10020', 'customfield_10200'] },
    { name: 'Bug', id: '10002', sampled: ['PAY-104'], status: 'sampled', fields: ['customfield_10200'] },
    { name: 'Epic', id: '10003', sampled: null, status: 'no-sample', fields: null },
  ],
  fields: [
    { id: 'customfield_10016', name: 'Story point estimate', schema: { type: 'number', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' }, example: '3', issueTypes: ['Story'], alias: 'storyPointEstimate', owi: { field: 'estimate', confidence: 'high', why: 'a number named "Story point estimate", where Jira keeps story points' } },
    { id: 'customfield_10020', name: 'Sprint', schema: { type: 'array', custom: 'com.pyxis.greenhopper.jira:gh-sprint' }, example: 'Sprint 7 (active)', issueTypes: ['Story'], alias: 'sprint', owi: { field: 'iteration', confidence: 'high', why: "Jira Software's own Sprint field" } },
    { id: 'customfield_10200', name: 'Crew', schema: { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' }, example: 'Platform', issueTypes: ['Story', 'Bug'], alias: 'crew', owi: null },
  ],
  commands: [
    'toil projects field <toil-project> jira storyPointEstimate customfield_10016',
    'toil projects field <toil-project> jira estimate customfield_10016 --replace',
    'toil projects field <toil-project> jira sprint customfield_10020',
    'toil projects field <toil-project> jira iteration customfield_10020 --replace',
  ],
};

export const CONFIG_CANNED: Answer[] = [
  { command: 'connections list', input: {}, data: FIXTURE_CONNECTIONS },
  { command: 'projects list', input: {}, data: listData() },
  { command: 'projects list', input: { archived: true }, data: archivedListData() },
  ...TOIL_PROJECTS.map((d) => ({ command: 'projects show', input: { toilProject: d.name }, data: showData(d) })),
  ...TOIL_PROJECTS.map((d) => ({ command: 'projects check', input: { toilProject: d.name }, data: { name: d.name, file: fileOf(d.name), source: 'user', ok: true, problems: [] } })),
  ...FIXTURE_CONNECTIONS.connections.map((c) => ({
    command: 'connections test',
    input: { name: c.name },
    data: { name: c.name, area: c.area, host: c.host, live: true, authenticated: true, request: PROBES[c.area] ?? null },
  })),
  ...usageCanned(),
  { command: 'jira field discover', input: { connection: 'corp-jira', project: 'PAY', perType: 1 }, data: FIELD_DISCOVERY },
  { command: 'projects onboard', input: { plan: true }, data: ONBOARD_PLAN },
  // No theme set: toil's default, Crate, which is Toil UI's too (#467).
  { command: 'theme list', input: {}, data: THEME_LIST },
];

/** A plan with no pin asks nothing and changes nothing, so the preview answers it as it answers a read. */
const answersLikeARead = (command: string, input: Record<string, unknown>) => command === 'projects onboard' && input.plan === true && input.pin === undefined;

/** The Usage page sends `until` as the moment it opened; the sample month answers whatever moment that is. */
const answerInput = (command: string, input: Record<string, unknown>) => (command === 'audit stats' ? Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'until')) : input);

const meta = (command: string) => ({ command, durationMs: 0, version: VERSION, contractVersion: 1 });

/** The preview's config: reads from CONFIG_CANNED, every change refused with the reason. */
export function fixtureConfig(canned: Answer[] = CONFIG_CANNED): ConfigApi & { calls: Array<{ command: string; input: Record<string, unknown> }> } {
  const answers = new Map(canned.map((c) => [callKey(c.command, c.input), c]));
  const calls: Array<{ command: string; input: Record<string, unknown> }> = [];
  const reads = new Set<string>(CONFIG_READS);
  return {
    disabled: PREVIEW_DISABLED,
    calls,
    areas: async () => structuredClone(FIXTURE_AREAS),
    settings: async (): Promise<SettingsInfo> => ({ timeout: { variable: 'TOIL_TIMEOUT_MS', value: null, effectiveMs: DEFAULT_TIMEOUT_MS, defaultMs: DEFAULT_TIMEOUT_MS } }),
    run: async (command, input) => {
      calls.push({ command, input });
      await Promise.resolve();
      return structuredClone(fixtureConfigAnswer(answers, reads, command, input));
    },
  };
}

function fixtureConfigAnswer(answers: Map<string, Answer>, reads: Set<string>, command: string, input: Record<string, unknown>): Envelope {
  if (!CONFIG_COMMANDS.has(command)) {
    return { ok: false, data: null, error: { code: 'INVALID_INPUT', message: `Toil UI doesn't change ${command} from the page.`, fix: `Run toil ${command} on the CLI, where toil's own rules apply.` }, meta: meta(command) };
  }
  if (!reads.has(command) && !answersLikeARead(command, input)) {
    return { ok: false, data: null, error: { code: 'WRITE_DISABLED', message: `The preview changes nothing, so it wasn't saved.`, fix: 'Run Toil UI on your own machine to change your configuration.' }, meta: meta(command) };
  }
  const hit = answers.get(callKey(command, answerInput(command, input)));
  if (!hit) {
    return { ok: false, data: null, error: { code: 'INVALID_INPUT', message: `The preview has no sample answer for ${callKey(command, input)}.`, fix: 'Add the call to CONFIG_CANNED in ui/src/fixtures/config.ts.' }, meta: meta(command) };
  }
  return { ok: true, data: hit.data, error: null, meta: meta(command) };
}

/** The same answers as a Store's `execute()` would give them, for `toil-ui --sample` (ui/server/store.ts). */
export function fixtureConfigExecute(): (command: string, input: Record<string, unknown>) => Promise<Envelope> {
  const answers = new Map(CONFIG_CANNED.map((c) => [callKey(c.command, c.input), c]));
  const reads = new Set<string>(CONFIG_READS);
  return async (command, input) => structuredClone(fixtureConfigAnswer(answers, reads, command, input));
}
