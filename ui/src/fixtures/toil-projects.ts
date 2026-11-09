/**
 * The preview's three toil projects, as the files in `~/.toil/projects/` would hold
 * them, and what `toil projects list` and `toil projects show` print for them.
 * Each mixes its own sources, the way real teams do:
 *
 * - **card-payments**: Jira Data Center (PAY), Bitbucket Data Center
 *   (PAY/payments-core) with Jenkins multibranch builds, and OpenShift for dev
 *   and prod.
 * - **settlement**: Azure DevOps Server (DefaultCollection/Payments): Boards,
 *   Azure Repos (settlement) and two Azure Pipelines, one for CI and one that
 *   deploys.
 * - **checkout-web**: GitHub Enterprise (imagile/payments-web) with Projects
 *   (project 7) and Actions checks, its SDK on Bitbucket Cloud
 *   (imagile/checkout-sdk), and OpenShift for staging and prod.
 *
 * Two say who is who (#292): card-payments maps J. Smith and R. Patel and
 * gives A. Chen an email, so the People view suggests her Bitbucket account;
 * checkout-web maps Ada across GitHub and Bitbucket Cloud, Bo on GitHub only,
 * and Claude as an agent. settlement lists nobody, so every account in its
 * data gets a card of its own.
 *
 * Two set the readiness gate (#307): card-payments keeps acceptance criteria
 * in a Jira custom field and asks for 20 words of description, checkout-web
 * asks for 10 and names its issue template; settlement takes the defaults.
 *
 * Reference data (`jobs`, `builds`, `deployments`, `projects`) is the kind a
 * toil project keeps as written (docs/projects.md); the dashboard reads it to know
 * which pipelines and boards to ask about. Every host is a placeholder.
 * Three toil projects, each complete, which is two more than most handovers produce.
 */

export interface ToilProjectFile {
  name: string;
  description: string;
  env?: string;
  repos: Array<{ name: string; remotes: string[] }>;
  environments?: Record<string, Record<string, Record<string, unknown>>>;
  people?: Array<{ name: string; kind?: 'human' | 'agent'; email?: string; ids: Record<string, string> }>;
  wipLimit?: number;
  [area: string]: unknown;
}

export const TOIL_PROJECTS: ToilProjectFile[] = [
  {
    name: 'card-payments',
    description: 'Card payments v2: tokenised cards at the edge. Jira, Bitbucket, Jenkins and OpenShift.',
    env: 'dev',
    repos: [{ name: 'payments-core', remotes: ['ssh://git@bitbucket.imagile.dev:7999/pay/payments-core.git'] }],
    // The readiness gate (#307): acceptance criteria live in a custom field, and 20 words of description will do here.
    jira: { connection: 'corp-jira', project: 'PAY', fields: { acceptanceCriteria: 'customfield_10500' }, readiness: { minWords: 20 } },
    bitbucket: { connection: 'corp-bitbucket', project: 'PAY', repo: 'payments-core' },
    jenkins: { connection: 'corp-jenkins', jobs: ['payments-core'] },
    environments: {
      dev: { openshift: { connection: 'ocp-nonprod', namespace: 'payments-dev' } },
      prod: { openshift: { connection: 'ocp-prod', namespace: 'payments-prod' } },
    },
    people: [
      { name: 'J. Smith', ids: { jira: 'jsmith', bitbucket: 'jsmith' } },
      { name: 'A. Chen', email: 'you@example.com', ids: { jira: 'achen' } },
      { name: 'R. Patel', ids: { jira: 'rpatel' } },
    ],
    wipLimit: 2,
  },
  {
    name: 'settlement',
    description: 'Daily settlement reports for finance. Azure DevOps Server: Boards, Repos and Pipelines.',
    repos: [{ name: 'settlement', remotes: ['https://ado.imagile.dev/DefaultCollection/Payments/_git/settlement'] }],
    ado: { connection: 'corp-ado', collection: 'DefaultCollection', project: 'Payments', repo: 'settlement', builds: ['settlement-ci'], deployments: ['settlement-deploy'] },
  },
  {
    name: 'checkout-web',
    description: 'The checkout web front end and its SDK. GitHub Enterprise with Projects and Actions, Bitbucket Cloud for the SDK, deployed on OpenShift.',
    env: 'staging',
    repos: [
      { name: 'payments-web', remotes: ['https://ghe.imagile.dev/imagile/payments-web.git'] },
      { name: 'checkout-sdk', remotes: ['https://bitbucket-cloud.imagile.dev/imagile/checkout-sdk.git'] },
    ],
    // The readiness gate (#307): ten words of description, not counting the issue template's headings.
    github: { connection: 'github', owner: 'imagile', repo: 'payments-web', projects: ['7'], readiness: { minWords: 10, templates: [['## What', '## Why', '## Acceptance criteria'].join('\n')] } },
    bitbucket: { connection: 'bitbucket-cloud', workspace: 'imagile', repo: 'checkout-sdk' },
    environments: {
      staging: { openshift: { connection: 'ocp-nonprod', namespace: 'checkout-staging' } },
      prod: { openshift: { connection: 'ocp-prod', namespace: 'checkout-prod' } },
    },
    people: [
      { name: 'Ada D.', ids: { github: 'ada-dev', bitbucket: '557058:abc12345-0000-0000-0000-000000000020' } },
      { name: 'Bo W.', ids: { github: 'bo-web' } },
      { name: 'Claude', kind: 'agent', ids: {} },
    ],
    wipLimit: 2,
  },
];

const USER_DIR = '/home/you/.toil/projects';
export const fileOf = (name: string) => `${USER_DIR}/${name}.json`;

/** Each area's context inputs, as `projects show` resolves them: the ones the registry declares, nothing else. */
const CONTEXT: Record<string, string[]> = {
  jira: ['project'],
  bitbucket: ['project', 'workspace', 'repo'],
  jenkins: ['instance'],
  ado: ['collection', 'organization', 'project', 'repo'],
  github: ['owner', 'repo'],
  openshift: ['instance'],
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `toil projects show <name>`'s data. */
export function showData(d: ToilProjectFile) {
  const { name, description, env, repos, environments, people, wipLimit, ...sections } = d;
  const areaNames = new Set([...Object.keys(sections), ...Object.values(environments ?? {}).flatMap((e) => Object.keys(e))]);
  const areas: Record<string, unknown> = {};
  for (const area of [...areaNames].sort()) {
    const section = (env !== undefined ? environments?.[env]?.[area] : undefined) ?? (isRecord(sections[area]) ? sections[area] : {});
    const inputs = Object.fromEntries((CONTEXT[area] ?? []).flatMap((k) => (typeof section[k] === 'string' ? [[k, section[k]]] : [])));
    areas[area] = {
      connection: typeof section.connection === 'string' ? { value: section.connection, source: 'toil-project' } : null,
      writes: false,
      env: area === 'openshift' ? (env ?? null) : null,
      inputs,
    };
  }
  return {
    name,
    source: 'user',
    file: fileOf(name),
    by: 'input',
    match: null,
    repo: null,
    adopted: true,
    areas,
    toilProject: { name, description, ...(env ? { env } : {}), repos, ...sections, ...(environments ? { environments } : {}), ...(people ? { people } : {}), ...(wipLimit ? { wipLimit } : {}) },
    problems: [],
  };
}

/** `toil projects list`'s data. */
export function listData() {
  return {
    folder: null,
    places: { user: USER_DIR, listed: [], repo: null },
    archivedHidden: SAMPLE_ARCHIVED.length,
    toilProjects: TOIL_PROJECTS.map((d) => ({ name: d.name, description: d.description, archived: false, source: 'user', file: fileOf(d.name), shadowedBy: null, problems: 0 })),
    broken: [],
  };
}

/** The sample's one archived Toil project: it has no data, which is what archived means here. */
export const SAMPLE_ARCHIVED = [{ name: 'pilot-rollout', description: 'The pilot, wrapped up in March' }];

/** `toil projects list --archived`'s data. */
export function archivedListData() {
  return {
    folder: null,
    places: { user: USER_DIR, listed: [], repo: null },
    archivedHidden: 0,
    toilProjects: SAMPLE_ARCHIVED.map((d) => ({ name: d.name, description: d.description, archived: true, source: 'user', file: fileOf(d.name), shadowedBy: null, problems: 0 })),
    broken: [],
  };
}
