import { describe, expect, it } from 'vitest';
import { BITBUCKET_PR_GETS, BITBUCKET_PRS, GITHUB_CODEOWNERS, GITHUB_PR_GETS, GITHUB_PRS, OPENSHIFT } from '../src/fixtures/delivery.ts';
import { showData } from '../src/fixtures/toil-projects.ts';
import { fixtureExecute, type Canned } from '../src/fixtures/execute.ts';
import { dateTime } from '../src/format.ts';
import { loadToilProject, PR_INCLUDE } from '../src/load.ts';
import { adoDeployments, changeRef, included, iso } from '../src/model/delivery.ts';
import { entry } from '../src/model/sprint.ts';
import { trace } from '../src/model/trace.ts';
import { healthOf, loaded } from './harness.ts';

/** The models, on each toil project as the dashboard loads it through the fixture `execute()`. */

const ids = (h: Awaited<ReturnType<typeof healthOf>>['h'], kind: string) => h.items.filter((i) => h.entries.get(i.id)!.kind === kind).map((i) => i.id);
const reasons = (h: Awaited<ReturnType<typeof healthOf>>['h']) => Object.fromEntries(h.risks.map((r) => [r.id, r.reasons.map((x) => x.code)]));

describe('card-payments: Jira, Bitbucket, Jenkins, OpenShift', () => {
  it("works out Sprint 42 from Jira's own dates", async () => {
    const { h } = await healthOf('card-payments');
    expect(h.sprint.name).toBe('Sprint 42');
    expect(h.days).toEqual({ gone: 7, total: 10 });
    expect(h.items).toHaveLength(7); // The epic sits outside any sprint.
    expect(ids(h, 'carried')).toEqual(['corp-jira:PAY-104']);
    expect(ids(h, 'added')).toEqual(['corp-jira:PAY-107']);
    expect(h.done).toEqual({ count: 2, points: 3 });
    expect(h.remaining).toEqual({ count: 5, points: 18 });
  });

  it('flags each risk, the failing Jenkins build included', async () => {
    const { h } = await healthOf('card-payments');
    expect(reasons(h)).toEqual({
      'corp-jira:PAY-101': ['failing-build'],
      'corp-jira:PAY-102': ['blocked'],
      'corp-jira:PAY-103': ['blocked'],
      'corp-jira:PAY-104': ['carried'],
      'corp-jira:PAY-107': ['unestimated'],
    });
    expect(h.risks[0]!.reasons[0]).toEqual({ code: 'failing-build', change: 'corp-jenkins:payments-core/PR-311#2' });
  });

  it('joins pull requests to items by key, builds by job, deployments by image tag', async () => {
    const { data } = await loaded('card-payments');
    const pr = data.changes.find((c) => c.id === 'corp-bitbucket:PAY/payments-core#311')!;
    expect(pr.items).toEqual(['corp-jira:PAY-101', 'corp-jira:PAY-100']);
    expect(data.changes.filter((c) => c.builds === pr.id).map((c) => c.outcome)).toEqual(['failed', 'failed']);
    expect(data.deployments.map((d) => [d.environment, d.commit, d.items])).toEqual([
      ['dev', '4e1d2a9', ['corp-jira:PAY-106', 'corp-jira:PAY-105']],
      ['prod', '1a2b3c4', []],
    ]);
  });
});

describe('settlement: Azure DevOps Server Boards, Repos and Pipelines', () => {
  it("works out Sprint 42 from the iteration's dates, leaving hours out of the points", async () => {
    const { h } = await healthOf('settlement');
    expect(h.days).toEqual({ gone: 7, total: 9 });
    expect(ids(h, 'carried')).toEqual(['corp-ado:2304']);
    // 2305 is a task created inside the sprint, which is scope added.
    expect(ids(h, 'added')).toEqual(['corp-ado:2305', 'corp-ado:2306']);
    expect(h.otherUnits).toEqual(['corp-ado:2305']);
    expect(h.done).toEqual({ count: 2, points: 1 });
    expect(h.remaining).toEqual({ count: 4, points: 15 });
    expect(reasons(h)).toEqual({ 'corp-ado:2303': ['blocked'], 'corp-ado:2304': ['carried'] });
  });

  it('says what each entry rests on', async () => {
    const { byId } = await healthOf('settlement');
    expect(entry(byId.get('corp-ado:2304')!)).toMatchObject({ kind: 'carried', from: 'Payments\\Sprint 41', evidence: 'history.iterations' });
    // Moving from the area path into the sprint before it started is planning, not scope added.
    expect(entry(byId.get('corp-ado:2302')!)).toMatchObject({ kind: 'planned', at: '2026-09-30T15:00:00.000Z' });
  });

  it('joins CI runs by pull request and deployments by source version, per environment', async () => {
    const { data } = await loaded('settlement');
    expect(data.changes.filter((c) => c.kind === 'build').map((c) => [c.builds, c.outcome])).toEqual([
      ['corp-ado:Payments/settlement#87', 'running'],
      ['corp-ado:Payments/settlement#84', 'passed'],
      ['corp-ado:Payments/settlement#80', 'passed'],
    ]);
    expect(data.deployments.map((d) => [d.environment, d.commit, d.includes.length, d.items])).toEqual([
      ['test', 'c84e5f0', 2, ['corp-ado:2305']],
      ['prod', 'b80a1d2', 1, []],
    ]);
  });
});

describe('checkout-web: GitHub with Projects and Actions, OpenShift', () => {
  it('takes scope added from the board item, and says so', async () => {
    const { h, byId } = await healthOf('checkout-web');
    expect(ids(h, 'added')).toEqual(['github:imagile/payments-web#43', 'github:imagile/payments-web#45']);
    expect(entry(byId.get('github:imagile/payments-web#43')!)).toEqual({
      kind: 'added', at: '2026-10-07T09:00:00.000Z', from: null, evidence: 'github project items: createdAt',
    });
    expect(reasons(h)).toEqual({ 'github:imagile/payments-web#43': ['failing-build'], 'github:imagile/payments-web#45': ['unestimated'] });
  });

  it("makes one build of a head's checks: failed if any check failed", async () => {
    const { data } = await loaded('checkout-web');
    const build = data.changes.find((c) => c.id === 'github:imagile/payments-web#53/checks')!;
    expect(build).toMatchObject({ outcome: 'failed', state: 'failure (e2e-safari)', title: 'test, e2e-safari', items: ['github:imagile/payments-web#43'] });
    expect(data.deployments.map((d) => [d.environment, d.version, d.items])).toEqual([
      ['staging', '2026.10.12', ['github:imagile/payments-web#44']],
      ['prod', '2026.10.02', []],
    ]);
  });
});

describe('traceability', () => {
  it('flags the gaps and says where each item runs', async () => {
    const { data, h } = await healthOf('card-payments');
    const rows = new Map(trace(h.items, data.changes, data.deployments).map((r) => [r.item.id, r]));
    expect(rows.get('corp-jira:PAY-101')!.flags).toEqual(['failing-build']);
    expect(rows.get('corp-jira:PAY-105')!.deployedTo.map((d) => d.environment)).toEqual(['dev']);
    expect(rows.get('corp-jira:PAY-104')!.deployedTo).toEqual([]);
    const settlement = await healthOf('settlement');
    const flagged = trace(settlement.h.items, settlement.data.changes).filter((r) => r.flags.length);
    expect(flagged.map((r) => [r.item.id, r.flags])).toEqual([['corp-ado:2307', ['done-without-change']]]);
  });
});

describe('the delivery rules', () => {
  it("names only the Toil project's own items, of those its pull request's change names", async () => {
    const { data } = await loaded('checkout-web');
    const byId = new Map(data.items.map((i) => [i.id, i]));
    const c = data.pullRequests.find((p) => p.id === 'github:imagile/payments-web#52')!;
    expect(changeRef({ ...c, workItems: [...c.workItems, 'github:imagile/payments-web#999', 'github:imagile/other#42'] }, byId).items).toEqual([
      'github:imagile/payments-web#42',
      'github:imagile/payments-web#41',
    ]);
  });

  it('calls a commit no merged pull request made unknown, rather than guessing', async () => {
    const { data } = await loaded('card-payments');
    expect(included('deadbee', data.changes)).toEqual({ includes: [], items: [], unknownCommit: true });
  });
});

describe('review round 1 (#229)', () => {
  it('calls a deploy run with no sourceVersion unknown, never the oldest merge', async () => {
    const { data } = await loaded('settlement');
    const prs = data.changes.filter((c) => c.kind === 'pull-request');
    const run = { id: 9, buildNumber: '1', status: 'completed', result: 'succeeded', templateParameters: { environment: 'test' }, finishTime: '2026-10-09T00:00:00Z' };
    expect(adoDeployments([run], 'corp-ado', prs)).toMatchObject([{ environment: 'test', includes: [], items: [], unknownCommit: true }]);
    expect(included('', prs).unknownCommit).toBe(true);
    expect(included(undefined, prs).unknownCommit).toBe(true);
  });

  it('keeps an unparsable date on its own row as unknown', async () => {
    expect(iso('not a date')).toBe('');
    expect(iso('')).toBe('');
    const { data } = await loaded('card-payments');
    // A change whose host sent a date OWI couldn't read has no created time; its row says unknown.
    const pr = changeRef({ ...data.pullRequests[0]!, created: null }, new Map());
    expect(pr.at).toBe('');
    expect(dateTime(pr!.at)).toBe('at an unknown time');
  });

  it('reads OpenShift once for a Toil project with two code hosts, matching each deployment to its own repository', async () => {
    const mixed = {
      name: 'mixed',
      description: 'Two code hosts, one cluster.',
      repos: [{ name: 'payments-core', remotes: [] }, { name: 'payments-web', remotes: [] }],
      bitbucket: { connection: 'corp-bitbucket', project: 'PAY', repo: 'payments-core' },
      github: { connection: 'github', owner: 'imagile', repo: 'payments-web' },
      environments: { dev: { openshift: { connection: 'ocp-nonprod', namespace: 'mixed-dev' } } },
    };
    const ns = (OPENSHIFT['payments-dev'] as { deployments: unknown[] }).deployments;
    const staging = (OPENSHIFT['checkout-staging'] as { deployments: unknown[] }).deployments;
    const base = { toilProject: 'mixed' };
    const GH = { owner: 'imagile', repo: 'payments-web' };
    const canned: Canned[] = [
      { command: 'projects show', input: base, data: showData(mixed) },
      { command: 'bitbucket pr list', input: { ...base, state: 'ALL' }, data: BITBUCKET_PRS },
      ...Object.entries(BITBUCKET_PR_GETS).map(([id, data]) => ({ command: 'bitbucket pr get', input: { ...base, id: Number(id), include: PR_INCLUDE }, data })),
      // No board named, so the repository's issues are read; this test is about deployments, so there are none.
      { command: 'github issue list', input: { ...base, ...GH, state: 'all' }, data: [] },
      { command: 'github pr list', input: { ...base, ...GH, state: 'all' }, data: GITHUB_PRS },
      ...Object.entries(GITHUB_PR_GETS).map(([number, data]) => ({ command: 'github pr get', input: { ...base, ...GH, number: Number(number), include: PR_INCLUDE }, data })),
      { command: 'github repo file', input: { ...base, ...GH, path: '.github/CODEOWNERS' }, data: GITHUB_CODEOWNERS },
      { command: 'openshift deployment list', input: { ...base, env: 'dev', namespace: 'mixed-dev' }, data: { namespace: 'mixed-dev', kind: 'Deployment', count: 2, deployments: [...ns, ...staging] } },
    ];
    const fixture = fixtureExecute(canned);
    const data = await loadToilProject(fixture.execute, 'mixed');
    expect(fixture.calls.filter((c) => !c.ok)).toEqual([]);
    expect(fixture.calls.filter((c) => c.command === 'openshift deployment list')).toHaveLength(1);
    expect(data.deployments.map((d) => [d.name, d.commit, d.includes])).toEqual([
      ['payments-core in mixed-dev', '4e1d2a9', ['bitbucket:PAY/payments-core#290', 'bitbucket:PAY/payments-core#296', 'bitbucket:PAY/payments-core#298']],
      ['payments-web in mixed-dev', '5a7e3f1', ['github:imagile/payments-web#48', 'github:imagile/payments-web#49', 'github:imagile/payments-web#50']],
    ]);
  });
});
