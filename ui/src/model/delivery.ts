/**
 * Pull requests, builds and deployments, read from each command's own output
 * into the UI's `ChangeRef` and `Deployment` (src/toil.ts). Pure functions of
 * the `data` the commands return, so the dashboards and the tests agree. The
 * rules, which AGENT_DECISIONS.md (#228 toil project dashboard) records:
 *
 * - **A pull request names its work items** in its title, branch or
 *   description, as its OWI change reads them (src/core/owi/change.ts). Only
 *   items the toil project's own queries returned count.
 * - **A build belongs to a pull request** by the source's own link: the
 *   Jenkins multibranch job `PR-<id>`, an Azure Pipelines run's
 *   `triggerInfo["pr.number"]`, or the GitHub check runs `pr get --include
 *   checks` returned for the pull request's head.
 *   A GitHub head's checks are one build: failed if any failed, running if any
 *   are, else passed.
 * - **A deployment names a commit**: the image tag's trailing hex on an
 *   OpenShift Deployment (`payments-core:1.14.0-4e1d2a9`), or a deploy run's
 *   `sourceVersion`. It includes the merged pull request whose merge commit
 *   that is, and every one merged before it into the same repository (an
 *   OpenShift Deployment is matched to its repository by name), since the
 *   target branch is linear. A missing commit, or one no listed pull request
 *   merged as, is shown as unknown, never guessed.
 * - **A date that's missing or won't parse is unknown** (`''`), on its own
 *   row, rather than failing the whole dashboard.
 *
 * Release notes, reconstructed from evidence, which is how most get written anyway.
 */

import type { Change, ChangeRef, Deployment, SourceKind, WorkItem } from '../toil.ts';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const recs = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(isRec) : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
/** An instant as ISO 8601, or '' (shown as unknown) when it's missing or unparsable: one bad date stays on its own row. */
export const iso = (v: unknown): string => {
  if (typeof v !== 'number' && typeof v !== 'string') return '';
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? '' : new Date(t).toISOString();
};

// Pull requests ---------------------------------------------------------------

/** A source's family, as the panels name it: an area's first word (`github`, `ado`). */
const family = (area: string): SourceKind => area.split('-')[0] as SourceKind;

/**
 * A pull request's `ChangeRef`, made from its OWI change: the work items it
 * names that the toil project's own queries returned, its state, and the time the
 * panels sort it by (merged or closed, else opened). A host that records no
 * merge time (Bitbucket Cloud) is sorted by its last update.
 */
export function changeRef(c: Change, byId: Map<string, WorkItem>): ChangeRef {
  const done = c.state === 'MERGED' || c.state === 'DECLINED';
  return {
    id: c.id,
    kind: 'pull-request',
    source: family(c.source.area),
    command: c.source.command,
    items: c.workItems.filter((id) => byId.has(id)),
    title: c.title,
    url: c.url,
    state: c.state,
    outcome: c.state === 'MERGED' ? 'merged' : c.state === 'DECLINED' ? 'declined' : 'open',
    builds: null,
    mergeCommit: c.state === 'MERGED' ? c.mergeCommit : null,
    at: iso((done ? (c.mergedAt ?? c.closedAt ?? c.updated) : null) ?? c.created),
    change: c,
  };
}

// Builds -------------------------------------------------------------------------

const JENKINS_OUTCOME: Record<string, ChangeRef['outcome']> = { SUCCESS: 'passed', FAILURE: 'failed', UNSTABLE: 'failed', ABORTED: 'failed' };

/** One Jenkins multibranch job's runs (`<job>/PR-<id>`), for the pull request it builds. */
export function jenkinsBuilds(data: unknown, connection: string, job: string, pr: ChangeRef): ChangeRef[] {
  return recs(data).map((run) => {
    const result = str(run.result);
    return {
      id: `${connection}:${job}#${run.number}`,
      kind: 'build',
      source: 'jenkins',
      command: 'jenkins pipeline runs',
      items: pr.items,
      title: str(run.fullDisplayName) ?? `${job} #${run.number}`,
      url: str(run.url),
      state: run.building === true ? 'BUILDING' : (result ?? 'UNKNOWN'),
      outcome: run.building === true || result === null ? 'running' : (JENKINS_OUTCOME[result] ?? 'failed'),
      builds: pr.id,
      mergeCommit: null,
      at: iso(run.timestamp),
    };
  });
}

/** Azure Pipelines CI runs, each joined to its pull request by `triggerInfo["pr.number"]` or a `refs/pull/<id>/merge` branch. */
export function adoBuilds(data: unknown, connection: string, prs: ChangeRef[]): ChangeRef[] {
  return recs(data).flatMap((run) => {
    const trigger = isRec(run.triggerInfo) ? str(run.triggerInfo['pr.number']) : null;
    const number = trigger ?? /^refs\/pull\/(\d+)\/merge$/.exec(str(run.sourceBranch) ?? '')?.[1];
    const pr = number ? prs.find((p) => p.id.endsWith(`#${number}`)) : undefined;
    if (!pr) return [];
    const status = str(run.status);
    const result = str(run.result);
    const definition = isRec(run.definition) ? str(run.definition.name) : null;
    return [{
      id: `${connection}:build#${run.id}`,
      kind: 'build' as const,
      source: 'ado' as const,
      command: 'ado run list',
      items: pr.items,
      title: `${definition ?? 'build'} ${run.buildNumber}`,
      url: isRec(run._links) && isRec(run._links.web) ? str(run._links.web.href) : null,
      state: status === 'completed' ? (result ?? 'completed') : (status ?? 'unknown'),
      outcome: status !== 'completed' ? ('running' as const) : result === 'succeeded' ? ('passed' as const) : ('failed' as const),
      builds: pr.id,
      mergeCommit: null,
      at: iso(run.finishTime ?? run.startTime ?? run.queueTime),
    }];
  });
}

/** Each name once, in the order first seen. */
const unique = (names: Array<string | null>) => [...new Set(names.filter((n): n is string => n !== null))];

/** A pull request head's GitHub checks, as one build. */
export function githubBuild(data: unknown, connection: string, pr: ChangeRef): ChangeRef | null {
  const runs = recs(data);
  if (!runs.length) return null;
  const failed = runs.filter((r) => r.conclusion !== null && r.conclusion !== 'success' && r.conclusion !== 'skipped' && r.conclusion !== 'neutral');
  const running = runs.filter((r) => r.status !== 'completed');
  const worst = failed[0] ?? running[0] ?? runs[0]!;
  const at = runs.map((r) => iso(r.completed_at ?? r.started_at)).sort().at(-1)!;
  return {
    id: `${pr.id}/checks`,
    kind: 'build',
    source: 'github',
    command: 'github commit checks',
    items: pr.items,
    // A check that ran for both the push and the pull request is named once.
    title: unique(runs.map((r) => str(r.name))).join(', '),
    url: str(worst.html_url),
    state: failed.length ? `failure (${unique(failed.map((r) => str(r.name))).join(', ')})` : running.length ? 'in_progress' : 'success',
    outcome: failed.length ? 'failed' : running.length ? 'running' : 'passed',
    builds: pr.id,
    mergeCommit: null,
    at,
  };
}

// Deployments ------------------------------------------------------------------------

/** What a deployed commit includes: its own pull request and every one merged before it. */
export function included(commit: string | null | undefined, prs: ChangeRef[]): { includes: string[]; items: string[]; unknownCommit: boolean } {
  // An empty commit would prefix-match every merge commit; with no commit there is nothing to match.
  if (!commit) return { includes: [], items: [], unknownCommit: true };
  const merged = prs.filter((p) => p.outcome === 'merged' && p.mergeCommit).sort((a, b) => (a.at < b.at ? -1 : 1));
  const at = merged.findIndex((p) => p.mergeCommit!.startsWith(commit) || commit.startsWith(p.mergeCommit!));
  if (at < 0) return { includes: [], items: [], unknownCommit: true };
  const includes = merged.slice(0, at + 1);
  return { includes: includes.map((p) => p.id), items: [...new Set(includes.flatMap((p) => p.items))], unknownCommit: false };
}

const IMAGE_TAG = /:(?:(.+)-)?([0-9a-f]{7,40})$/;

/** An OpenShift namespace's Deployments for the toil project's repositories, by the commit in each image tag. */
export function openshiftDeployments(data: unknown, environment: string, repos: string[], prs: ChangeRef[]): Deployment[] {
  const body = isRec(data) ? data : {};
  return recs(body.deployments)
    .filter((d) => repos.includes(String(d.name)))
    .map((d) => {
      const image = str(recs(d.images)[0]?.image) ?? '';
      const [, version, commit] = IMAGE_TAG.exec(image) ?? [];
      const ready = str(d.ready) ?? '?';
      const unavailable = typeof d.unavailableReplicas === 'number' ? d.unavailableReplicas : 0;
      return {
        id: `openshift:${body.namespace}/${d.name}`,
        environment,
        source: 'openshift' as const,
        command: 'openshift deployment list',
        name: `${d.name} in ${body.namespace}`,
        commit: commit ?? '',
        version: version ?? null,
        state: `${ready} ready`,
        outcome: unavailable > 0 ? ('failed' as const) : ('passed' as const),
        url: null,
        // Only the deployment's own repository's merges: a toil project may have several code hosts.
        ...included(commit, prs.filter((p) => p.id.includes(`/${d.name}#`))),
      };
    });
}

/** Azure Pipelines deploy runs: the newest successful run per `templateParameters.environment`. */
export function adoDeployments(data: unknown, connection: string, prs: ChangeRef[]): Deployment[] {
  const runs = recs(data)
    .filter((r) => r.status === 'completed' && r.result === 'succeeded' && isRec(r.templateParameters) && str(r.templateParameters.environment))
    .sort((a, b) => (iso(a.finishTime) < iso(b.finishTime) ? 1 : -1));
  const seen = new Set<string>();
  const out: Deployment[] = [];
  for (const run of runs) {
    const environment = str((run.templateParameters as Rec).environment)!;
    if (seen.has(environment)) continue;
    seen.add(environment);
    const commit = str(run.sourceVersion) ?? '';
    out.push({
      id: `${connection}:build#${run.id}`,
      environment,
      source: 'ado',
      command: 'ado run list',
      name: `${isRec(run.definition) ? str(run.definition.name) : 'deploy'} ${run.buildNumber}`,
      commit: commit.slice(0, 7),
      version: null,
      state: String(run.result),
      outcome: 'passed',
      url: isRec(run._links) && isRec(run._links.web) ? str(run._links.web.href) : null,
      ...included(commit, prs),
    });
  }
  return out;
}

const ENV_ORDER = ['dev', 'test', 'staging', 'prod'];
export const byEnvironment = (a: Deployment, b: Deployment) => {
  const rank = (e: string) => (ENV_ORDER.includes(e) ? ENV_ORDER.indexOf(e) : ENV_ORDER.length);
  return rank(a.environment) - rank(b.environment) || a.environment.localeCompare(b.environment);
};
