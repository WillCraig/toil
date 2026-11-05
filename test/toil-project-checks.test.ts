import { afterEach, describe, expect, it } from 'vitest';
import type { Settings } from '../src/core/config.js';
import { validateToilProject, viewScopes, type ToilProjectView } from '../src/core/toil-project.js';
import type { Envelope } from '../src/core/envelope.js';
import { areas, commands } from '../src/registry.js';
import { fixture as ado } from './fixtures/ado.fixture.js';
import { fixture as bitbucket } from './fixtures/bitbucket.fixture.js';
import { fixture as dynatrace } from './fixtures/dynatrace.fixture.js';
import { fixture as github } from './fixtures/github.fixture.js';
import { fixture as jira } from './fixtures/jira.fixture.js';
import { fixture as openshift } from './fixtures/openshift.fixture.js';
import { runCli } from './harness/cli.js';
import { testContext } from './harness/context.js';
import { toilProjectDisk, type ToilProjectDisk } from './harness/toil-projects.js';
import type { Route } from './harness/fake-fetch.js';
import type { AreaFixture } from './harness/fixtures.js';

/**
 * `toil <area> check-toil-project` for ado, openshift, dynatrace, bitbucket, github
 * and jira on Cloud: what each looks up, how per-repo values pair up (a repo with
 * its project or owner), a value the service hasn't got, and that only the
 * call's own environment is checked. The parity suite already runs each
 * one's examples through both doors; this proves what they find.
 */

const toilProjectAreas = areas.map((a) => ({ name: a.name, context: Object.keys(a.context) }));
const disks: ToilProjectDisk[] = [];
afterEach(() => disks.splice(0).forEach((d) => d.cleanup()));

/** 404 for any GET no fixture route answers, as each service does for a value it hasn't got. */
const missing: Route = { path: /.*/, respond: { status: 404, json: { message: 'Not Found', errors: [{ message: 'Not Found' }], errorMessages: ['Not Found'] } } };

async function check(f: AreaFixture, toilProject: Record<string, unknown>, extra: string[] = [], config: Record<string, Settings> = f.config ?? {}): Promise<{ envelope: Envelope; exitCode: number; urls: string[] }> {
  const d = toilProjectDisk({ [`home/.toil/projects/${String(toilProject.name)}.json`]: toilProject });
  disks.push(d);
  const { context, http } = testContext({ config, routes: [...(f.routes ?? []), missing], toilProjects: (c) => d.catalog(c, { areas: toilProjectAreas }) });
  const run = await runCli([f.area, 'check-toil-project', '--toil-project', String(toilProject.name), ...extra], { commands, context });
  return { envelope: run.envelope!, exitCode: run.exitCode, urls: http.calls.map((c) => new URL(c.url).pathname + new URL(c.url).search) };
}

const found = (e: Envelope) => (e.data as { checks: Array<{ path: string; kind: string; value: string; found: boolean }> }).checks.map((c) => [c.path, c.kind, c.value, c.found]);

describe('check-toil-project for the rest of the areas', () => {
  it('ado: projects in their collection and repos in their project, the collection per repo or from the call', async () => {
    const run = await check(ado, { name: 'p', ado: { collection: { 'imagile-api': 'DefaultCollection' }, project: { 'imagile-api': 'Imagile', ops: 'Gone' }, repo: { 'imagile-api': 'imagile-api' } } }, ['--collection', 'DefaultCollection']);
    expect(found(run.envelope)).toEqual([
      ['ado.project.imagile-api', 'project', 'DefaultCollection/Imagile', true],
      ['ado.project.ops', 'project', 'DefaultCollection/Gone', false],
      ['ado.repo.imagile-api', 'repo', 'DefaultCollection/Imagile/imagile-api', true],
    ]);
    expect(run.exitCode).toBe(1);
    // No collection anywhere: reported as unchecked, ok false, a warning, and nothing sent.
    const orphan = await check(ado, { name: 'p', ado: { projects: ['Imagile'] } });
    expect(orphan.envelope.data).toMatchObject({ ok: false, checks: [], unchecked: [{ path: 'ado.projects[0]', value: 'Imagile', reason: expect.stringContaining('no collection') }] });
    expect(orphan.envelope.meta.warnings?.map((w) => w.code)).toEqual(['TOIL_PROJECT_UNCHECKED']);
    expect(orphan.exitCode).toBe(1);
    expect(orphan.urls).toEqual([]);
  });

  it("openshift: only the call's environment, and each deployment in its section's namespace", async () => {
    const toilProject = {
      name: 'p',
      env: 'test',
      environments: { prod: { openshift: { namespace: 'payments', deployments: ['api', 'worker'] } }, test: { openshift: { namespace: 'payments-test' } } },
    };
    const prod = await check(openshift, toilProject, ['--env', 'prod']);
    expect(found(prod.envelope)).toEqual([
      ['environments.prod.openshift.namespace', 'namespace', 'payments', true],
      ['environments.prod.openshift.deployments[0]', 'deployment', 'payments/api', true],
      ['environments.prod.openshift.deployments[1]', 'deployment', 'payments/worker', false],
    ]);
    expect(prod.envelope.data).toMatchObject({ env: 'prod', ok: false });
    // With no --env, the toil project's own environment, test: whose cluster this connection (env prod) isn't, so a person would pass --env.
    const test = await check(openshift, toilProject, [], { openshift: { ...openshift.config!.openshift, env: 'test' } });
    expect(found(test.envelope)).toEqual([['environments.test.openshift.namespace', 'namespace', 'payments-test', false]]);
    expect(test.urls).toEqual(['/apis/project.openshift.io/v1/projects/payments-test']);
  });

  it('dynatrace: each entity id', async () => {
    const run = await check(dynatrace, { name: 'p', dynatrace: { entities: ['SERVICE-ABC12345', 'HOST-GONE'] } });
    expect(found(run.envelope)).toEqual([
      ['dynatrace.entities[0]', 'entity', 'SERVICE-ABC12345', true],
      ['dynatrace.entities[1]', 'entity', 'HOST-GONE', false],
    ]);
  });

  it('bitbucket: projects, and each repo paired with its own repo\'s project', async () => {
    const run = await check(bitbucket, { name: 'p', bitbucket: { project: { 'imagile-api': 'PROJ', ledger: 'PROJ' }, repo: { 'imagile-api': 'imagile-api', ledger: 'ledger' } } });
    expect(found(run.envelope)).toEqual([
      ['bitbucket.project.imagile-api', 'project', 'PROJ', true],
      ['bitbucket.project.ledger', 'project', 'PROJ', true],
      ['bitbucket.repo.imagile-api', 'repo', 'PROJ/imagile-api', true],
      ['bitbucket.repo.ledger', 'repo', 'PROJ/ledger', false],
    ]);
    // Each value looked up once.
    expect(run.urls.filter((u) => u === '/rest/api/1.0/projects/PROJ')).toHaveLength(1);
  });

  it('github: owners, and each repo under its owner', async () => {
    const run = await check(github, { name: 'p', github: { owner: 'imagile', repo: { 'toil-probe': 'toil-probe', gone: 'gone' } } });
    expect(found(run.envelope)).toEqual([
      ['github.owner', 'owner', 'imagile', true],
      ['github.repo.toil-probe', 'repo', 'imagile/toil-probe', true],
      ['github.repo.gone', 'repo', 'imagile/gone', false],
    ]);
  });

  it('jira on a Cloud connection: projects and field ids', async () => {
    const run = await check(jira, { name: 'p', jira: { projects: ['PROJ', 'GONE'], fields: { storyPoints: 'customfield_10016', ghost: 'customfield_1' } } }, ['--connection', 'jira-cloud']);
    expect(found(run.envelope)).toEqual([
      ['jira.projects[0]', 'project', 'PROJ', true],
      ['jira.projects[1]', 'project', 'GONE', false],
      ['jira.fields.storyPoints', 'field', 'customfield_10016', true],
      ['jira.fields.ghost', 'field', 'customfield_1', false],
    ]);
    expect(run.urls).toContain('/rest/api/3/project/GONE');
  });

  it('a jira-cloud section is read as the jira section, and check-toil-project says to rename it', async () => {
    const run = await check(jira, { name: 'p', 'jira-cloud': { projects: ['PROJ'] } }, ['--connection', 'jira-cloud']);
    expect(found(run.envelope)).toEqual([['jira.projects[0]', 'project', 'PROJ', true]]);
    expect(run.envelope.meta.warnings).toEqual([expect.objectContaining({ code: 'TOIL_PROJECT_RENAMED_AREA', message: expect.stringContaining('"jira-cloud" is now "jira"') })]);
    // Both present: jira wins, and the warning says the other was ignored.
    const both = await check(jira, { name: 'p', jira: { projects: ['PROJ'] }, 'jira-cloud': { projects: ['GONE'] } }, ['--connection', 'jira-cloud']);
    expect(found(both.envelope)).toEqual([['jira.projects[0]', 'project', 'PROJ', true]]);
    expect(both.envelope.meta.warnings?.[0]?.message).toContain('"jira-cloud" is ignored');
  });

  it("a jira-cloud entry under an environment or in a person's ids is read as jira too, each warned by key path", () => {
    const { toilProject, problems } = validateToilProject(
      {
        name: 'p',
        environments: { prod: { 'jira-cloud': { projects: ['PROJ'] } } },
        people: [{ name: 'Sam', ids: { 'jira-cloud': 'sam@example.com' } }],
      },
      toilProjectAreas,
    );
    expect(problems.filter((p) => p.level === 'error')).toEqual([]);
    expect(problems.filter((p) => p.code === 'TOIL_PROJECT_RENAMED_AREA').map((p) => p.path)).toEqual(['environments.prod.jira-cloud', 'people[0].ids.jira-cloud']);
    expect(JSON.stringify(toilProject)).not.toContain('jira-cloud');
    expect(toilProject?.environments?.prod?.jira).toMatchObject({ projects: ['PROJ'] });
    expect(toilProject?.people?.[0]?.ids).toEqual({ jira: 'sam@example.com' });
    // Both present: the new one wins, and the old one is named as ignored.
    const both = validateToilProject({ name: 'p', people: [{ name: 'Sam', ids: { jira: 'new', 'jira-cloud': 'old' } }] }, toilProjectAreas);
    expect(both.toilProject?.people?.[0]?.ids).toEqual({ jira: 'new' });
    expect(both.problems.find((p) => p.code === 'TOIL_PROJECT_RENAMED_AREA')?.message).toContain('"jira-cloud" is ignored');
  });

  it('an ado-cloud section, with its team and transition pins, is read as the ado section, warned by key path, and ado wins when both exist', () => {
    const { toilProject, problems } = validateToilProject(
      { name: 'p', 'ado-cloud': { project: 'Imagile', team: 'Imagile Team', transitions: { 'User Story': { review: 'Resolved' } } }, environments: { prod: { 'ado-cloud': { project: 'Prod' } } } },
      toilProjectAreas,
    );
    expect(problems.filter((p) => p.level === 'error')).toEqual([]);
    expect(problems.filter((p) => p.code === 'TOIL_PROJECT_RENAMED_AREA').map((p) => p.path)).toEqual(['ado-cloud', 'environments.prod.ado-cloud']);
    expect(JSON.stringify(toilProject)).not.toContain('ado-cloud');
    expect(toilProject?.sections.ado).toMatchObject({ project: 'Imagile', team: 'Imagile Team', transitions: { 'User Story': { review: 'Resolved' } } });
    const both = validateToilProject({ name: 'p', ado: { project: 'New' }, 'ado-cloud': { project: 'Old' } }, toilProjectAreas);
    expect(both.toilProject?.sections.ado).toMatchObject({ project: 'New' });
    expect(both.problems.find((p) => p.code === 'TOIL_PROJECT_RENAMED_AREA')?.message).toContain('"ado-cloud" is ignored');
  });

  it("checks what a call would use: an environment's value shadows the area's own, and keys pair across the two", async () => {
    // The review's case: the dev namespace is never looked up on the prod cluster.
    const shadowed = await check(openshift, { name: 'p', env: 'prod', openshift: { namespace: 'payments-dev' }, environments: { prod: { openshift: { namespace: 'payments' } } } }, ['--env', 'prod']);
    expect(found(shadowed.envelope)).toEqual([['environments.prod.openshift.namespace', 'namespace', 'payments', true]]);
    expect(shadowed.envelope.data).toMatchObject({ ok: true });
    // Deployments in the area's own section, the namespace per environment: paired as a call pairs them.
    const deployments = await check(openshift, { name: 'p', env: 'prod', openshift: { deployments: ['api'] }, environments: { prod: { openshift: { namespace: 'payments' } } } }, ['--env', 'prod']);
    expect(found(deployments.envelope)).toEqual([
      ['environments.prod.openshift.namespace', 'namespace', 'payments', true],
      ['openshift.deployments[0]', 'deployment', 'payments/api', true],
    ]);
    // The review's case: each repo has its namespace, and the list doesn't say whose a deployment is.
    const perRepo = await check(openshift, { name: 'p', openshift: { namespace: { 'payments-api': 'payments', ledger: 'ledger' }, deployments: ['api'] } });
    expect(perRepo.envelope.data).toMatchObject({
      ok: false,
      checks: expect.arrayContaining([
        { path: 'openshift.deployments[0]', kind: 'deployment', value: 'payments/api', found: true, note: "looked up in payments, ledger, since the toil project doesn't say which repo's namespace it's in; found in payments" },
      ]),
    });
    expect(perRepo.urls).toEqual(['/apis/project.openshift.io/v1/projects/payments', '/apis/project.openshift.io/v1/projects/ledger', '/apis/apps/v1/namespaces/payments/deployments/api']);
    // No namespace at all: the deployment is unchecked, never skipped.
    const none = await check(openshift, { name: 'p', openshift: { deployments: ['api'] } });
    expect(none.envelope.data).toMatchObject({ ok: false, unchecked: [{ path: 'openshift.deployments[0]', value: 'api' }] });
    // github: the owner in the area's own section, the repo in the environment's.
    const across = await check(github, { name: 'p', env: 'prod', github: { owner: 'imagile' }, environments: { prod: { github: { repo: 'toil-probe' } } } });
    expect(found(across.envelope)).toEqual([
      ['github.owner', 'owner', 'imagile', true],
      ['environments.prod.github.repo', 'repo', 'imagile/toil-probe', true],
    ]);
  });

  it('reports a repo with no owner to look it up under as unchecked, so ok never covers a value nobody looked at', async () => {
    const run = await check(github, { name: 'p', github: { owner: { 'toil-probe': 'imagile' }, repo: { 'toil-probe': 'toil-probe', other: 'other' } } });
    expect(run.envelope.data).toMatchObject({ ok: false, unchecked: [{ path: 'github.repo.other', value: 'other', reason: 'no owner to look this repo up in for repo other' }] });
    expect(run.envelope.meta.warnings?.[0]).toMatchObject({ code: 'TOIL_PROJECT_UNCHECKED', message: expect.stringContaining('github.repo.other ("other") wasn\'t checked') });
    expect(run.exitCode).toBe(1);
  });

  it('fails, rather than calling a value missing, when the service answers with anything but not-found', async () => {
    const d = toilProjectDisk({ 'home/.toil/projects/p.json': { name: 'p', dynatrace: { entities: ['SERVICE-1'] } } });
    disks.push(d);
    const { context } = testContext({ config: dynatrace.config!, routes: [{ path: /.*/, respond: { status: 401, json: { error: { message: 'Token is invalid' } } } }], toilProjects: (c) => d.catalog(c, { areas: toilProjectAreas }) });
    const run = await runCli(['dynatrace', 'check-toil-project', '--toil-project', 'p'], { commands, context });
    expect(run.envelope?.error?.code).toBe('AUTH');
  });
});

describe('viewScopes', () => {
  const view = (sections: ToilProjectView['sections']): ToilProjectView => ({ name: 'p', source: 'user', file: '', env: 'prod', sections });

  it("pairs per repo, the environment's section first, and says which scopes lack a key", () => {
    const { scopes, incomplete } = viewScopes(
      view([
        { path: 'x', env: null, values: { owner: 'o', repo: { a: 'base-a' } } },
        { path: 'environments.prod.x', env: 'prod', values: { repo: { a: 'ra', b: 'rb' } } },
      ]),
      ['owner', 'repo'],
    );
    expect(scopes).toEqual([
      { repo: 'a', values: { owner: 'o', repo: 'ra' }, paths: { owner: 'x.owner', repo: 'environments.prod.x.repo.a' } },
      { repo: 'b', values: { owner: 'o', repo: 'rb' }, paths: { owner: 'x.owner', repo: 'environments.prod.x.repo.b' } },
    ]);
    expect(incomplete).toEqual([]);
    const partial = viewScopes(view([{ path: 'x', env: null, values: { owner: { a: 'oa' }, repo: { a: 'ra', b: 'rb' } } }]), ['owner', 'repo']);
    expect(partial.scopes.map((s) => s.repo)).toEqual(['a']);
    expect(partial.incomplete).toEqual([{ repo: 'b', found: { 'x.repo.b': 'rb' }, lacks: ['owner'] }]);
  });
});
