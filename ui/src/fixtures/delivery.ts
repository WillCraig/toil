/**
 * Pull requests, builds and deployments, as the toil commands that read them
 * print them: each source's own REST shape, trimmed to the fields the
 * dashboard reads plus enough around them to look like the real thing. Shapes
 * follow the vendors' REST references and toil's own command code:
 *
 * - Pull requests on every host, from the OWI fixture (below).
 * - Jenkins builds of a multibranch job (`jenkins pipeline runs`), with
 *   the `tree` fields src/areas/jenkins/client.ts asks for.
 * - Azure Pipelines builds (`ado run list`):
 *   https://learn.microsoft.com/rest/api/azure/devops/ (Build Builds).
 * - OpenShift Deployments (`openshift deployment list`), as the command summarises
 *   them (src/areas/openshift/workloads.ts).
 *
 * What the dashboards should show: PAY-105 and PAY-106 merged and running in
 * dev but not prod, PAY-101's build failing; settlement's export job deployed
 * to test while prod runs last week's; checkout's currency fix in staging, and
 * a failing Safari check on payments-web#43's draft. Invented, not captured;
 * every host is a placeholder and every commit made up. Every build here goes
 * green or red on cue, which no real pipeline has ever agreed to.
 */

const ms = (iso: string) => Date.parse(iso);
const sha = (short: string) => short.padEnd(40, '0');

// card-payments: Bitbucket Data Center, Jenkins, OpenShift -------------------------

const JENKINS = 'https://jenkins.imagile.dev';
const jenkinsRun = (pr: number, n: number, result: 'SUCCESS' | 'FAILURE' | null, at: string, durationMs: number) => ({
  number: n,
  url: `${JENKINS}/job/payments-core/job/PR-${pr}/${n}/`,
  result,
  duration: result === null ? 0 : durationMs,
  timestamp: ms(at),
  building: result === null,
  displayName: `#${n}`,
  fullDisplayName: `payments-core » PR-${pr} #${n}`,
  description: null,
  id: String(n),
  queueId: 9000 + pr * 10 + n,
});

/** `jenkins pipeline runs --name payments-core/PR-<id>`, newest first, per pull request. */
export const JENKINS_RUNS: Record<number, unknown[]> = {
  311: [jenkinsRun(311, 2, 'FAILURE', '2026-10-12T16:05:00.000Z', 412_000), jenkinsRun(311, 1, 'FAILURE', '2026-10-12T15:35:00.000Z', 398_000)],
  305: [jenkinsRun(305, 1, 'SUCCESS', '2026-10-07T10:40:00.000Z', 455_000)],
  298: [jenkinsRun(298, 3, 'SUCCESS', '2026-10-09T14:20:00.000Z', 441_000)],
  296: [jenkinsRun(296, 1, 'SUCCESS', '2026-10-07T11:10:00.000Z', 430_000)],
  290: [jenkinsRun(290, 1, 'SUCCESS', '2026-09-30T09:30:00.000Z', 420_000)],
};

const deployment = (name: string, image: string, version: string, ready: number, desired: number, age: string) => ({
  name,
  ready: `${ready}/${desired}`,
  desiredReplicas: desired,
  readyReplicas: ready,
  updatedReplicas: ready,
  availableReplicas: ready,
  unavailableReplicas: desired - ready,
  age,
  images: [{ name, image }],
  strategy: 'RollingUpdate',
  labels: { 'app.kubernetes.io/name': name, 'app.kubernetes.io/version': version },
});
const ns = (namespace: string, deployments: unknown[]) => ({ namespace, kind: 'Deployment', count: deployments.length, deployments });

/** `openshift deployment list --env <env> --namespace <ns>`, per environment. */
export const OPENSHIFT: Record<string, unknown> = {
  'payments-dev': ns('payments-dev', [deployment('payments-core', 'artifactory.imagile.dev/payments/payments-core:1.14.0-4e1d2a9', '1.14.0', 2, 2, '3d')]),
  'payments-prod': ns('payments-prod', [deployment('payments-core', 'artifactory.imagile.dev/payments/payments-core:1.13.2-1a2b3c4', '1.13.2', 3, 3, '13d')]),
  'checkout-staging': ns('checkout-staging', [deployment('payments-web', 'artifactory.imagile.dev/checkout/payments-web:2026.10.12-5a7e3f1', '2026.10.12', 2, 2, '18h')]),
  'checkout-prod': ns('checkout-prod', [deployment('payments-web', 'artifactory.imagile.dev/checkout/payments-web:2026.10.02-1c9b8e4', '2026.10.02', 4, 4, '11d')]),
};

// settlement: Azure Repos, Azure Pipelines ----------------------------------------

const ADO = 'https://ado.imagile.dev/DefaultCollection';
const OKAFOR = { displayName: 'D. Okafor', uniqueName: 'IMAGILE\\dokafor', id: 'abc12345-0000-0000-0000-000000000070', descriptor: 'win.dokafor' };

interface BuildSpec {
  id: number;
  definition: { id: number; name: string };
  number: string;
  status: 'completed' | 'inProgress';
  result?: 'succeeded' | 'failed';
  branch: string;
  commit: string;
  at: string;
  pr?: number;
  environment?: string;
}

const adoBuild = (s: BuildSpec) => ({
  id: s.id,
  buildNumber: s.number,
  status: s.status,
  ...(s.result ? { result: s.result } : {}),
  queueTime: s.at,
  startTime: s.at,
  ...(s.status === 'completed' ? { finishTime: s.at } : {}),
  sourceBranch: s.branch,
  sourceVersion: sha(s.commit),
  definition: { ...s.definition, path: '\\' },
  project: { name: 'Payments' },
  reason: s.pr ? 'pullRequest' : 'individualCI',
  ...(s.pr ? { triggerInfo: { 'pr.number': String(s.pr), 'pr.sourceBranch': `refs/heads/feature/${s.pr}` } } : {}),
  ...(s.environment ? { templateParameters: { environment: s.environment } } : {}),
  requestedFor: OKAFOR,
  _links: { web: { href: `${ADO}/Payments/_build/results?buildId=${s.id}` } },
  url: `${ADO}/Payments/_apis/build/Builds/${s.id}`,
});

const CI = { id: 12, name: 'settlement-ci' };
const DEPLOY = { id: 13, name: 'settlement-deploy' };

/** `ado run list --name settlement-ci`, newest first. */
export const ADO_CI_RUNS = [
  adoBuild({ id: 5530, definition: CI, number: '20261013.1', status: 'inProgress', branch: 'refs/pull/87/merge', commit: '87ab3e2', at: '2026-10-13T07:55:00Z', pr: 87 }),
  adoBuild({ id: 5512, definition: CI, number: '20261008.3', status: 'completed', result: 'succeeded', branch: 'refs/pull/84/merge', commit: '84cd1f9', at: '2026-10-08T12:10:00Z', pr: 84 }),
  adoBuild({ id: 5461, definition: CI, number: '20261001.2', status: 'completed', result: 'succeeded', branch: 'refs/pull/80/merge', commit: '80ef2a1', at: '2026-10-01T10:30:00Z', pr: 80 }),
];

/** `ado run list --name settlement-deploy`, newest first: one run per environment it deployed to. */
export const ADO_DEPLOY_RUNS = [
  adoBuild({ id: 5521, definition: DEPLOY, number: '20261008.1', status: 'completed', result: 'succeeded', branch: 'refs/heads/main', commit: 'c84e5f0', at: '2026-10-08T14:00:00Z', environment: 'test' }),
  adoBuild({ id: 5470, definition: DEPLOY, number: '20261002.1', status: 'completed', result: 'succeeded', branch: 'refs/heads/main', commit: 'b80a1d2', at: '2026-10-02T16:00:00Z', environment: 'prod' }),
  adoBuild({ id: 5466, definition: DEPLOY, number: '20261001.1', status: 'completed', result: 'succeeded', branch: 'refs/heads/main', commit: 'b80a1d2', at: '2026-10-01T13:00:00Z', environment: 'test' }),
];

// Pull requests: Sprint 42's, shared with toil's own OWI fixture ---------------------

/**
 * Each toil project's pull requests, as `pr list` and `pr get --include
 * reviews,checks,commits,files` print them, from the OWI pull request
 * fixture (test/fixtures/owi/pull-requests.ts), so the preview shows exactly
 * what toil's mapper is tested on. GitHub's check runs are the builds
 * checkout-web shows.
 */
export {
  ADO_PRS, ADO_PR_GETS, BITBUCKET_CLOUD_PRS, BITBUCKET_CLOUD_PR_GETS, BITBUCKET_PRS, BITBUCKET_PR_GETS, GITHUB_CODEOWNERS, GITHUB_PRS, GITHUB_PR_GETS,
} from '../../../test/fixtures/owi/pull-requests.ts';
