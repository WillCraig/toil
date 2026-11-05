import { z } from 'zod';
import { openshiftArea } from './area.js';
import { openshift, openshiftText } from './client.js';
import { age, containerState, type K8sDeployment, type K8sEvent, type K8sList, type K8sPod } from './k8s.js';
import { apiPath } from '../../core/api-path.js';

/**
 * Pods, deployments, events and logs for one namespace, summarised for an
 * agent to read: problems first, counters up top. --raw hands back the
 * objects as the API server sent them, for anyone who prefers the full
 * toil project to the executive summary.
 */

const namespace = z.string().describe('Kubernetes namespace');
const NAMESPACE_OPTION = { flags: '--namespace <ns>', field: 'namespace', description: 'Kubernetes namespace' };
const LABEL_SELECTOR_OPTION = { flags: '--label-selector <selector>', field: 'labelSelector', description: 'Label selector (e.g. app=my-app)' };

const phasePriority = (phase: unknown) => (phase === 'Failed' ? 0 : phase === 'Pending' ? 1 : phase === 'Unknown' ? 2 : 3);

export const podsCommand = openshiftArea.command({
  path: ['openshift', 'pod', 'list'],
  description: 'List pod health summary for a namespace — pre-processed for LLM analysis. Use --raw to return the full unmodified Kubernetes pod objects.',
  input: z.object({
    namespace,
    labelSelector: z.string().optional().describe('Label selector (e.g. app=my-app)'),
    raw: z.boolean().optional().describe('Return full Kubernetes pod objects without summarization (includes env vars, images, node name, annotations, resources, etc.) (default: false)'),
  }),
  writes: false,
  options: [
    NAMESPACE_OPTION,
    LABEL_SELECTOR_OPTION,
    { flags: '--raw', field: 'raw', description: 'Return full Kubernetes pod objects without summarization (includes env vars, images, node name, annotations, resources, etc.) (default: false)' },
  ],
  examples: [{ namespace: 'payments' }, { namespace: 'payments', labelSelector: 'app=api', raw: true }, { namespace: 'payments', env: 'prod', instance: 'east' }],
  run: async (input, ctx) => {
    const podList = await openshift<K8sList<K8sPod>>(ctx, apiPath`/api/v1/namespaces/${input.namespace}/pods`, { labelSelector: input.labelSelector || undefined });
    if (input.raw) return { namespace: input.namespace, count: podList.items.length, pods: podList.items };

    const summary = { total: podList.items.length, running: 0, pending: 0, failed: 0, succeeded: 0, unknown: 0, crashLoopBackOff: 0, oomKilled: 0, imagePullBackOff: 0, totalRestarts: 0 };
    const pods = podList.items.map((pod) => {
      const phase = pod.status.phase ?? 'Unknown';
      switch (phase.toLowerCase()) {
        case 'running': summary.running++; break;
        case 'pending': summary.pending++; break;
        case 'failed': summary.failed++; break;
        case 'succeeded': summary.succeeded++; break;
        default: summary.unknown++; break;
      }

      // Suspected bug (#88 item 2): init containers count toward ready and restarts, but not toward the total.
      const statuses = [...(pod.status.containerStatuses ?? []), ...(pod.status.initContainerStatuses ?? [])];
      let restarts = 0;
      const containers = statuses.map((cs) => {
        restarts += cs.restartCount;
        summary.totalRestarts += cs.restartCount;
        const current = containerState(cs.state);
        const last = containerState(cs.lastState);
        if (current === 'CrashLoopBackOff') summary.crashLoopBackOff++;
        if (current === 'ImagePullBackOff' || current === 'ErrImagePull') summary.imagePullBackOff++;
        // Suspected bug (#88 item 5): only lastState counts, so a container OOMKilled right now isn't.
        if (last === 'OOMKilled' || cs.lastState?.terminated?.reason === 'OOMKilled') summary.oomKilled++;
        const entry: Record<string, unknown> = { name: cs.name, ready: cs.ready, restartCount: cs.restartCount, state: current };
        if (cs.lastState?.terminated) {
          entry.lastExitCode = cs.lastState.terminated.exitCode;
          entry.lastReason = cs.lastState.terminated.reason;
        }
        return entry;
      });

      const readyCount = statuses.filter((cs) => cs.ready).length;
      const totalCount = pod.spec.containers?.length ?? statuses.length;
      const entry: Record<string, unknown> = { name: pod.metadata.name, phase, ready: `${readyCount}/${totalCount}`, restartCount: restarts, age: age(pod.metadata.creationTimestamp) };
      const reason = pod.status.reason ?? pod.status.conditions?.find((c) => c.status === 'False')?.reason;
      if (reason) entry.reason = reason;
      if (pod.status.message) entry.message = pod.status.message;
      if (containers.length > 0) entry.containers = containers;
      if (pod.metadata.labels && Object.keys(pod.metadata.labels).length > 0) entry.labels = pod.metadata.labels;
      return entry;
    });

    // Most problematic first: Failed, Pending, Unknown, then the rest, and most restarts within each.
    pods.sort((a, b) => phasePriority(a.phase) - phasePriority(b.phase) || ((b.restartCount as number) ?? 0) - ((a.restartCount as number) ?? 0));
    return { namespace: input.namespace, summary, pods };
  },
});

export const deploymentsCommand = openshiftArea.command({
  path: ['openshift', 'deployment', 'list'],
  description: 'List Deployments (or OpenShift DeploymentConfigs with --deployment-configs) for a namespace, read-only. Use --raw to return the full unmodified objects.',
  input: z.object({
    namespace,
    labelSelector: z.string().optional().describe('Label selector (e.g. app=my-app)'),
    deploymentConfigs: z.boolean().optional().describe('Read OpenShift DeploymentConfigs (apps.openshift.io/v1) instead of Deployments (apps/v1) (default: false)'),
    raw: z.boolean().optional().describe('Return full objects without summarization (includes pod template, env vars, strategy, etc.) (default: false)'),
  }),
  writes: false,
  options: [
    NAMESPACE_OPTION,
    LABEL_SELECTOR_OPTION,
    { flags: '--deployment-configs', field: 'deploymentConfigs', description: 'Read OpenShift DeploymentConfigs (apps.openshift.io/v1) instead of Deployments (apps/v1) (default: false)' },
    { flags: '--raw', field: 'raw', description: 'Return full objects without summarization (includes pod template, env vars, strategy, etc.) (default: false)' },
  ],
  examples: [{ namespace: 'payments' }, { namespace: 'payments', labelSelector: 'app=api', deploymentConfigs: true }, { namespace: 'payments', raw: true, env: 'prod', instance: 'east' }],
  run: async (input, ctx) => {
    const kind = input.deploymentConfigs ? 'DeploymentConfig' : 'Deployment';
    const path = input.deploymentConfigs ? apiPath`/apis/apps.openshift.io/v1/namespaces/${input.namespace}/deploymentconfigs` : apiPath`/apis/apps/v1/namespaces/${input.namespace}/deployments`;
    const list = await openshift<K8sList<K8sDeployment>>(ctx, path, { labelSelector: input.labelSelector || undefined });
    if (input.raw) return { namespace: input.namespace, kind, count: list.items.length, deployments: list.items };

    const deployments = list.items.map((d) => {
      const desired = d.spec.replicas ?? 0;
      const status = d.status ?? {};
      const entry: Record<string, unknown> = {
        name: d.metadata.name,
        ready: `${status.readyReplicas ?? 0}/${desired}`,
        desiredReplicas: desired,
        readyReplicas: status.readyReplicas ?? 0,
        updatedReplicas: status.updatedReplicas ?? 0,
        availableReplicas: status.availableReplicas ?? 0,
        unavailableReplicas: status.unavailableReplicas ?? 0,
        age: age(d.metadata.creationTimestamp),
        images: (d.spec.template?.spec?.containers ?? []).map((c) => ({ name: c.name, image: c.image })),
      };
      if (d.spec.strategy?.type) entry.strategy = d.spec.strategy.type;
      if (status.latestVersion !== undefined) entry.latestVersion = status.latestVersion;
      const problems = (status.conditions ?? []).filter(
        (c) => (c.type === 'Available' && c.status === 'False') || (c.type === 'Progressing' && c.status === 'False') || c.type === 'ReplicaFailure',
      );
      if (problems.length > 0) entry.conditions = problems.map((c) => ({ type: c.type, status: c.status, reason: c.reason, message: c.message }));
      if (d.metadata.labels && Object.keys(d.metadata.labels).length > 0) entry.labels = d.metadata.labels;
      return entry;
    });

    // Missing replicas first.
    deployments.sort((a, b) => ((b.unavailableReplicas as number) ?? 0) - ((a.unavailableReplicas as number) ?? 0));
    return { namespace: input.namespace, kind, count: deployments.length, deployments };
  },
});

export const eventsCommand = openshiftArea.command({
  path: ['openshift', 'event', 'list'],
  description: 'List Warning events for a namespace — pre-filtered for LLM analysis',
  input: z.object({
    namespace,
    fieldSelector: z.string().optional().describe('Additional field selector (e.g. involvedObject.name=my-pod)'),
    all: z.boolean().optional().describe('Include Normal events in addition to Warning events (default: false)'),
  }),
  writes: false,
  options: [
    NAMESPACE_OPTION,
    { flags: '--field-selector <selector>', field: 'fieldSelector', description: 'Additional field selector (e.g. involvedObject.name=my-pod)' },
    { flags: '--all', field: 'all', description: 'Include Normal events in addition to Warning events (default: false)' },
  ],
  examples: [{ namespace: 'payments' }, { namespace: 'payments', fieldSelector: 'involvedObject.name=api-7d9f8b6c5-abcde', all: true, env: 'prod', instance: 'east' }],
  run: async (input, ctx) => {
    // Warning only unless --all, joined to any extra selector with a comma.
    const selectors: string[] = [];
    if (!input.all) selectors.push('type=Warning');
    if (input.fieldSelector) selectors.push(input.fieldSelector);
    const eventList = await openshift<K8sList<K8sEvent>>(ctx, apiPath`/api/v1/namespaces/${input.namespace}/events`, { fieldSelector: selectors.length > 0 ? selectors.join(',') : undefined });

    const events = eventList.items.map((ev) => {
      const obj = ev.involvedObject ?? ev.regarding;
      const entry: Record<string, unknown> = {
        type: ev.type ?? 'Normal',
        reason: ev.reason,
        object: obj ? `${obj.kind ?? 'Object'}/${obj.name ?? '?'}` : undefined,
        message: ev.message,
        // Suspected bug (#88 item 6): series.count is never read, so an aggregated event shows 1.
        count: ev.count ?? 1,
        firstTime: ev.firstTimestamp ?? ev.eventTime,
        lastTime: ev.lastTimestamp ?? ev.eventTime,
      };
      const source = ev.source?.component ?? ev.reportingComponent;
      if (source) entry.source = source;
      return entry;
    });

    // Most frequent first.
    events.sort((a, b) => ((b.count as number) ?? 0) - ((a.count as number) ?? 0));
    return { namespace: input.namespace, count: events.length, events };
  },
});

export const logsCommand = openshiftArea.command({
  path: ['openshift', 'pod', 'logs'],
  description: 'Get recent log lines from a pod container',
  input: z.object({
    namespace,
    pod: z.string().describe('Pod name'),
    container: z.string().optional().describe('Container name (defaults to first container)'),
    // Read with parseInt, as the contract specifies, so text stays text until then.
    lines: z.union([z.number(), z.string()]).optional().describe('Number of most-recent lines to return (default: "100")'),
    previous: z.boolean().optional().describe('Return logs from the previous container instance (default: false)'),
  }),
  writes: false,
  args: [{ name: 'pod', field: 'pod', description: 'Pod name' }],
  options: [
    NAMESPACE_OPTION,
    { flags: '--container <name>', field: 'container', description: 'Container name (defaults to first container)' },
    { flags: '--lines <n>', field: 'lines', description: 'Number of most-recent lines to return (default: "100")' },
    { flags: '--previous', field: 'previous', description: 'Return logs from the previous container instance (default: false)' },
  ],
  examples: [{ namespace: 'payments', pod: 'api-7d9f8b6c5-abcde' }, { namespace: 'payments', pod: 'api-7d9f8b6c5-abcde', container: 'api', lines: '20', previous: true, env: 'prod', instance: 'east' }],
  run: async (input, ctx) => {
    // Suspected bug (#88 item 7): not validated, so "abc" sends tailLines=NaN and 0 or negatives pass through.
    const lines = input.lines === undefined || input.lines === '' ? 100 : parseInt(String(input.lines), 10);
    // Suspected bug (#88 item 1): no container is sent by default, whatever the help says, and the output says "(default)".
    const log = await openshiftText(ctx, apiPath`/api/v1/namespaces/${input.namespace}/pods/${input.pod}/log`, {
      container: input.container || undefined,
      previous: input.previous ? 'true' : undefined,
      tailLines: lines,
    });
    return { pod: input.pod, namespace: input.namespace, container: input.container ?? '(default)', previous: input.previous ?? false, lines, log };
  },
});

export const workloadCommands = [podsCommand, deploymentsCommand, eventsCommand, logsCommand];
