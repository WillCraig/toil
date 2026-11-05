import { defineFixture } from '../harness/fixtures.js';

/**
 * Canned API server responses for every request the openshift examples send.
 * Routes match on path; the query is left open, since the examples vary only
 * the selectors.
 *
 * Provenance: the command contract records no responses for this area, so
 * every shape here is invented from the Kubernetes API reference (Pod,
 * Deployment, Event, PodMetrics) and OpenShift's DeploymentConfig, trimmed
 * to the fields the commands read. Timestamps are years old so `age` reads
 * the same on both front doors, whatever the clock says.
 */

export const OPENSHIFT = 'https://openshift.imagile.dev';
export const NAMESPACE = 'payments';
export const POD = 'api-7d9f8b6c5-abcde';

export const config = { openshift: { baseUrl: OPENSHIFT, token: 'test-token', env: 'prod', instance: 'east' } };

const OLD = '2024-01-01T00:00:00Z';

export const runningPod = {
  metadata: { name: POD, namespace: NAMESPACE, creationTimestamp: OLD, labels: { app: 'api' } },
  spec: {
    containers: [
      { name: 'api', image: 'registry.imagile.dev/api:1.4.2', resources: { limits: { cpu: '500m', memory: '512Mi' }, requests: { cpu: '250m', memory: '256Mi' } } },
      { name: 'proxy', image: 'registry.imagile.dev/proxy:2.0', resources: { limits: { cpu: '1', memory: '1Gi' } } },
    ],
  },
  status: {
    phase: 'Running',
    conditions: [{ type: 'Ready', status: 'True' }],
    containerStatuses: [
      { name: 'api', ready: true, restartCount: 3, state: { running: { startedAt: OLD } }, lastState: { terminated: { exitCode: 137, reason: 'OOMKilled' } } },
      { name: 'proxy', ready: true, restartCount: 0, state: { running: { startedAt: OLD } } },
    ],
  },
};

export const pendingPod = {
  metadata: { name: 'worker-5c4b3a2190-fghij', namespace: NAMESPACE, creationTimestamp: OLD },
  spec: { containers: [{ name: 'worker', image: 'registry.imagile.dev/worker:0.9' }] },
  status: {
    phase: 'Pending',
    conditions: [{ type: 'PodScheduled', status: 'True' }, { type: 'Ready', status: 'False', reason: 'ContainersNotReady' }],
    containerStatuses: [{ name: 'worker', ready: false, restartCount: 0, state: { waiting: { reason: 'ImagePullBackOff', message: 'Back-off pulling image' } } }],
  },
};

export const podList = { kind: 'PodList', apiVersion: 'v1', items: [runningPod, pendingPod] };

export const deployment = {
  metadata: { name: 'api', namespace: NAMESPACE, creationTimestamp: OLD, labels: { app: 'api' } },
  spec: { replicas: 3, strategy: { type: 'RollingUpdate' }, template: { spec: { containers: [{ name: 'api', image: 'registry.imagile.dev/api:1.4.2' }] } } },
  status: {
    readyReplicas: 2,
    updatedReplicas: 3,
    availableReplicas: 2,
    unavailableReplicas: 1,
    conditions: [
      { type: 'Available', status: 'False', reason: 'MinimumReplicasUnavailable', message: 'Deployment does not have minimum availability.' },
      { type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable' },
    ],
  },
};

export const deploymentConfig = {
  metadata: { name: 'legacy', namespace: NAMESPACE, creationTimestamp: OLD },
  spec: { replicas: 1, strategy: { type: 'Rolling' }, template: { spec: { containers: [{ name: 'legacy', image: 'registry.imagile.dev/legacy:3' }] } } },
  status: { readyReplicas: 1, updatedReplicas: 1, availableReplicas: 1, unavailableReplicas: 0, latestVersion: 7, conditions: [] },
};

export const warningEvent = {
  type: 'Warning',
  reason: 'BackOff',
  message: 'Back-off restarting failed container api',
  count: 12,
  firstTimestamp: OLD,
  lastTimestamp: '2024-01-02T00:00:00Z',
  involvedObject: { kind: 'Pod', name: POD, namespace: NAMESPACE },
  source: { component: 'kubelet' },
};

/** An events.k8s.io-style event seen through the core API: no count, regarding and eventTime instead. */
export const seriesEvent = {
  type: 'Warning',
  reason: 'FailedScheduling',
  message: '0/3 nodes are available',
  eventTime: '2024-01-03T00:00:00.000000Z',
  regarding: { kind: 'Pod', name: 'worker-5c4b3a2190-fghij' },
  reportingComponent: 'default-scheduler',
  series: { count: 40, lastObservedTime: '2024-01-04T00:00:00.000000Z' },
};

export const eventList = { kind: 'EventList', apiVersion: 'v1', items: [seriesEvent, warningEvent] };

export const podMetrics = {
  kind: 'PodMetricsList',
  apiVersion: 'metrics.k8s.io/v1beta1',
  items: [
    {
      metadata: { name: POD, namespace: NAMESPACE },
      timestamp: OLD,
      window: '30s',
      containers: [
        { name: 'api', usage: { cpu: '123456789n', memory: '204800Ki' } },
        { name: 'proxy', usage: { cpu: '2500u', memory: '64Mi' } },
      ],
    },
  ],
};

export const LOG = '2024-01-01T00:00:00Z started\n2024-01-01T00:00:01Z listening on :8080\n';

export const fixture = defineFixture({
  area: 'openshift',
  routes: [
    // check-toil-project's lookups. Invented from the docs: a project, and one deployment.
    { path: `/apis/project.openshift.io/v1/projects/${NAMESPACE}`, respond: { json: { kind: 'Project', metadata: { name: NAMESPACE } } } },
    { path: `/apis/apps/v1/namespaces/${NAMESPACE}/deployments/api`, respond: { json: deployment } },
    { path: `/api/v1/namespaces/${NAMESPACE}/pods`, respond: { json: podList } },
    { path: `/apis/apps/v1/namespaces/${NAMESPACE}/deployments`, respond: { json: { kind: 'DeploymentList', items: [deployment] } } },
    { path: `/apis/apps.openshift.io/v1/namespaces/${NAMESPACE}/deploymentconfigs`, respond: { json: { kind: 'DeploymentConfigList', items: [deploymentConfig] } } },
    { path: `/api/v1/namespaces/${NAMESPACE}/events`, respond: { json: eventList } },
    { path: `/api/v1/namespaces/${NAMESPACE}/pods/${POD}/log`, respond: { text: LOG } },
    { path: `/apis/metrics.k8s.io/v1beta1/namespaces/${NAMESPACE}/pods`, respond: { json: podMetrics } },
  ],
  config,
  // Reference data only (openshift's context inputs are env and instance), so no other example changes.
  toilProject: { name: 'payments', openshift: { namespace: NAMESPACE, deployments: ['api'] } },
});
