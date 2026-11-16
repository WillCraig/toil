import { describe, expect, it } from 'vitest';
import { testContext } from '../../../test/harness/context.js';
import type { CannedResponse, RecordedRequest, Route } from '../../../test/harness/fake-fetch.js';
import { API, categoryPlan, fixture, GHE, label, projectField, workCategoryField } from '../../../test/fixtures/github.fixture.js';
import { execute } from '../../core/run.js';
import { categorizeCommand, describeLabel } from './categorize.js';

/**
 * `github issue categorize`: the requests it sends in the order it sends them,
 * what it refuses before sending any, and what it says came of it. The tests
 * run it against a small stand-in for GitHub that answers the way the REST and
 * GraphQL reference documents say it does: the canned data is shaped from the
 * vendor's documentation, not captured from a live instance. No test lets a
 * DELETE through; each one checks that none was sent, which is the one thing
 * about it the change request committee was firm on.
 */

interface World {
  /** `owner/repo#n` to the labels the issue carries now, or the status GitHub answers with instead. */
  issues: Record<string, string[] | 403 | 404>;
  /** Labels each repository already has. */
  labels: Record<string, string[]>;
  /** `owner/repo#n` to the value the Work category field holds; absent means the issue is not on the project. */
  onProject: Record<string, string | null>;
  /** Answers a request itself, ahead of the stand-in. */
  fail?: (request: RecordedRequest) => CannedResponse | undefined;
}

const world = (w: Partial<World> = {}): World => ({ issues: {}, labels: { 'imagile/toil-probe': ['ktlo', 'feature'] }, onProject: {}, ...w });

function routes(w: World): Route[] {
  const wrap = (answer: (request: RecordedRequest) => CannedResponse) => (request: RecordedRequest) => w.fail?.(request) ?? answer(request);
  const rest = (path: RegExp, method: string, answer: (request: RecordedRequest, m: RegExpMatchArray) => CannedResponse): Route => ({
    method,
    path,
    respond: wrap((request) => answer(request, new URL(request.url).pathname.match(path)!)),
  });
  const keyOf = (m: RegExpMatchArray) => `${m[1]}/${m[2]}#${m[3]}`;
  return [
    rest(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/, 'GET', (_r, m) => {
      const issue = w.issues[keyOf(m)];
      if (issue === undefined || typeof issue === 'number') return { status: issue ?? 404, json: { message: issue === 403 ? 'Resource not accessible by personal access token' : 'Not Found' } };
      return { json: { number: Number(m[3]), title: 'Probe failed', labels: issue.map((name, i) => label(name, i + 1)) } };
    }),
    rest(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels\/([^/]+)$/, 'GET', (_r, m) => {
      const has = (w.labels[`${m[1]}/${m[2]}`] ?? []).find((l) => l.toLowerCase() === decodeURIComponent(m[3]!).toLowerCase());
      return has ? { json: label(has, 50) } : { status: 404, json: { message: 'Not Found' } };
    }),
    rest(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels$/, 'POST', (request, m) => {
      (w.labels[`${m[1]}/${m[2]}`] ??= []).push((JSON.parse(request.body!) as { name: string }).name);
      return { status: 201, json: label((JSON.parse(request.body!) as { name: string }).name, 51) };
    }),
    rest(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/labels$/, 'POST', (request) => ({ status: 200, json: (JSON.parse(request.body!) as { labels: string[] }).labels.map((l, i) => label(l, i + 1)) })),
    rest(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/labels$/, 'PUT', (request) => ({ status: 200, json: (JSON.parse(request.body!) as { labels: string[] }).labels.map((l, i) => label(l, i + 1)) })),
    {
      method: 'POST',
      path: '/api/graphql',
      respond: wrap((request) => {
        const { query, variables } = JSON.parse(request.body!) as { query: string; variables: Record<string, unknown> };
        if (query.includes('updateProjectV2ItemFieldValue')) return { json: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_abc12345' } } } } };
        if (query.includes('issueOrPullRequest')) {
          const key = `${String(variables.owner)}/${String(variables.repo)}#${String(variables.number)}`;
          const current = w.onProject[key];
          const item =
            current === undefined
              ? []
              : [
                  {
                    id: `PVTI_${variables.number}`,
                    project: { id: 'PVT_kwDOabc123453', number: 3, title: 'Roadmap', owner: { __typename: 'Organization', login: 'imagile' }, field: { id: 'PVTSSF_cat12345', name: 'Work category', options: workCategoryField().options } },
                    fieldValueByName: current === null ? null : { name: current, optionId: workCategoryField().options.find((o) => o.name === current)!.id },
                  },
                ];
          return { json: { data: { repository: { issueOrPullRequest: { __typename: 'Issue', projectItems: { nodes: item } } } } } };
        }
        const nodes = [{ __typename: 'ProjectV2Field', id: 'PVTF_abc12345', name: 'Estimate', dataType: 'NUMBER' }, projectField(), workCategoryField()];
        return { json: { data: { repositoryOwner: { projectV2: { fields: { pageInfo: { hasNextPage: false, endCursor: 'Y3Vyc29yOjE=' }, nodes } } } } } };
      }),
    },
  ];
}

const KEY = (n: number, repo = 'toil-probe') => `imagile/${repo}#${n}`;
const item = (n: number, category = 'ktlo', extra: Record<string, unknown> = {}, repo = 'toil-probe') => ({
  id: `github:${KEY(n, repo)}`,
  key: KEY(n, repo),
  category,
  labels: { add: [category], remove: [] },
  field: { value: category === 'ktlo' ? 'KTLO' : 'Feature' },
  ...extra,
});
/** The same item with no field value, for a plan that sets labels only. */
const labelOnly = (n: number, category = 'ktlo', repo = 'toil-probe') => {
  const withField: Record<string, unknown> = item(n, category, {}, repo);
  delete withField.field;
  return withField;
};
const noField = { field: undefined };

async function run(plan: unknown, w: World, opts: { input?: Record<string, unknown>; settings?: Record<string, unknown> } = {}) {
  const t = testContext({ config: { github: { ...fixture.config!.github, ...opts.settings } }, routes: routes(w), files: { 'plan.json': typeof plan === 'string' ? plan : JSON.stringify(plan) } });
  const envelope = await execute(categorizeCommand, { inputFile: 'plan.json', allowWrite: true, ...opts.input }, t.context);
  // The command never sends a DELETE: a label comes off by replacing the list.
  expect(t.http.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
  return { envelope, calls: t.http.calls, w };
}

const graphqlKind = (body: string | undefined) => {
  const { query } = JSON.parse(body ?? '{}') as { query: string };
  return query.includes('updateProjectV2ItemFieldValue') ? 'set field' : query.includes('issueOrPullRequest') ? 'read item' : 'read fields';
};
const seq = (calls: RecordedRequest[]) => calls.map((c) => (c.url === `${GHE}/api/graphql` ? `GRAPHQL ${graphqlKind(c.body)}` : `${c.method} ${c.url.replace(API, '')}`));
const bodies = (calls: RecordedRequest[], method: string) => calls.filter((c) => c.method === method && !c.url.endsWith('/graphql')).map((c) => JSON.parse(c.body!) as unknown);
const R = '/repos/imagile/toil-probe';
const warned = (envelope: { meta: { warnings?: Array<{ code: string }> } }) => (envelope.meta.warnings ?? []).map((x) => x.code);

describe('github issue categorize: labels', () => {
  it('adds the category label with one POST when the repository already has it', async () => {
    const { envelope, calls } = await run(categoryPlan([labelOnly(9)], noField), world({ issues: { [KEY(9)]: ['bug'] } }));
    expect(seq(calls)).toEqual([`GET ${R}/issues/9`, `GET ${R}/labels/ktlo`, `POST ${R}/issues/9/labels`]);
    expect(bodies(calls, 'POST')).toEqual([{ labels: ['ktlo'] }]);
    expect(envelope.data).toEqual({
      connection: 'github',
      scheme: { name: 'ktlo-feature', revision: 1 },
      field: null,
      changed: [{ id: `github:${KEY(9)}`, key: KEY(9), category: 'ktlo', labels: { added: ['ktlo'], removed: [] }, field: null }],
      unchanged: [],
      failed: [],
      skipped: [],
      counts: { planned: 1, changed: 1, unchanged: 0, failed: 0 },
      labelsCreated: [],
      notOnProject: [],
    });
    expect(envelope.meta.warnings).toBeUndefined();
  });

  it('creates a missing label once per repository, with the category in its description and no colour, then adds it', async () => {
    const { envelope, calls } = await run(categoryPlan([labelOnly(9), labelOnly(10)], noField), world({ labels: {}, issues: { [KEY(9)]: [], [KEY(10)]: ['bug'] } }));
    expect(seq(calls)).toEqual([`GET ${R}/issues/9`, `GET ${R}/issues/10`, `GET ${R}/labels/ktlo`, `POST ${R}/labels`, `POST ${R}/issues/9/labels`, `POST ${R}/issues/10/labels`]);
    const created = bodies(calls, 'POST')[0] as { name: string; description: string };
    expect(Object.keys(created).sort()).toEqual(['description', 'name']);
    expect(created.name).toBe('ktlo');
    expect(created.description).toBe('Keep the lights on: Work that keeps what already exists running: fixes, upgrades, on-call…');
    expect(created.description.length).toBeLessThanOrEqual(100);
    expect(envelope.data).toMatchObject({ labelsCreated: [{ repo: 'imagile/toil-probe', label: 'ktlo' }], counts: { changed: 2 } });
  });

  it('a second run, with the label there, sends no write and lists the key as unchanged', async () => {
    const { envelope, calls } = await run(categoryPlan([labelOnly(9)], noField), world({ issues: { [KEY(9)]: ['bug', 'ktlo'] } }));
    expect(seq(calls)).toEqual([`GET ${R}/issues/9`]);
    expect(envelope.data).toMatchObject({ changed: [], unchanged: [KEY(9)], counts: { planned: 1, changed: 0, unchanged: 1, failed: 0 } });
  });

  it('a label present in another case counts as present: nothing is added', async () => {
    const { envelope, calls } = await run(categoryPlan([labelOnly(9)], noField), world({ issues: { [KEY(9)]: ['KTLO'] } }));
    expect(seq(calls)).toEqual([`GET ${R}/issues/9`]);
    expect(envelope.data).toMatchObject({ unchanged: [KEY(9)] });
  });

  it("a reclassification is one PUT of the issue's labels as just read, minus the scheme's other label, plus the category's", async () => {
    const live = { [KEY(9)]: ['bug', 'Feature', 'area/api'] };
    const { envelope, calls } = await run(categoryPlan([labelOnly(9)], noField), world({ issues: live }));
    expect(seq(calls)).toEqual([`GET ${R}/issues/9`, `GET ${R}/labels/ktlo`, `PUT ${R}/issues/9/labels`]);
    expect(bodies(calls, 'PUT')).toEqual([{ labels: ['bug', 'area/api', 'ktlo'] }]);
    expect(envelope.data).toMatchObject({ changed: [{ category: 'ktlo', labels: { added: ['ktlo'], removed: ['Feature'] }, field: null }] });
  });

  it("works from the labels the issue has now, not the plan's add and remove lists", async () => {
    // The plan says to add ktlo and remove nothing; the issue already moved on to the other category's label.
    const { calls } = await run(categoryPlan([{ ...labelOnly(9), labels: { add: ['ktlo'], remove: [] } }], noField), world({ issues: { [KEY(9)]: ['ktlo', 'feature'] } }));
    expect(seq(calls)).toEqual([`GET ${R}/issues/9`, `PUT ${R}/issues/9/labels`]);
    expect(bodies(calls, 'PUT')).toEqual([{ labels: ['ktlo'] }]);
  });

  it('applies items in two repositories, creating the label in the one that lacks it', async () => {
    const w = world({ labels: { 'imagile/toil-probe': ['ktlo'] }, issues: { [KEY(9)]: [], [KEY(4, 'payments')]: [] } });
    const { envelope, calls } = await run(categoryPlan([labelOnly(9), labelOnly(4, 'ktlo', 'payments')], noField), w);
    expect(seq(calls)).toEqual([
      `GET ${R}/issues/9`,
      'GET /repos/imagile/payments/issues/4',
      `GET ${R}/labels/ktlo`,
      'GET /repos/imagile/payments/labels/ktlo',
      'POST /repos/imagile/payments/labels',
      `POST ${R}/issues/9/labels`,
      'POST /repos/imagile/payments/issues/4/labels',
    ]);
    expect(envelope.data).toMatchObject({ labelsCreated: [{ repo: 'imagile/payments', label: 'ktlo' }], counts: { planned: 2, changed: 2 } });
  });

  it('works on a pull request the same way: it is an issue to the labels API', async () => {
    const { envelope } = await run(categoryPlan([labelOnly(7)], noField), world({ issues: { [KEY(7)]: [] } }));
    expect(envelope.data).toMatchObject({ counts: { changed: 1 } });
  });
});

describe('github issue categorize: the project field', () => {
  it('sets the option through the mutation, with the ids the item read returned', async () => {
    const { envelope, calls } = await run(categoryPlan([item(9)]), world({ issues: { [KEY(9)]: ['bug'] }, onProject: { [KEY(9)]: null } }));
    expect(seq(calls)).toEqual(['GRAPHQL read fields', `GET ${R}/issues/9`, `GET ${R}/labels/ktlo`, 'GRAPHQL read item', `POST ${R}/issues/9/labels`, 'GRAPHQL set field']);
    const sent = calls.filter((c) => c.url === `${GHE}/api/graphql`).map((c) => JSON.parse(c.body!) as { query: string; variables: Record<string, unknown> });
    expect(sent[0]!.variables).toMatchObject({ owner: 'imagile', project: 3 });
    expect(sent[1]!.variables).toEqual({ owner: 'imagile', repo: 'toil-probe', number: 9 });
    expect(sent[1]!.query).toContain('field(name: "Work category")');
    expect(sent[2]!.variables).toEqual({ project: 'PVT_kwDOabc123453', item: 'PVTI_9', field: 'PVTSSF_cat12345', option: 'a1b2c3d4' });
    expect(envelope.data).toMatchObject({
      field: { name: 'Work category', project: 'imagile/3', id: 'PVTSSF_cat12345' },
      changed: [{ key: KEY(9), labels: { added: ['ktlo'], removed: [] }, field: { value: 'KTLO' } }],
    });
  });

  it('matches the option by name without regard to case', async () => {
    const { calls } = await run(categoryPlan([item(9, 'ktlo', { field: { value: 'ktlo' } })]), world({ issues: { [KEY(9)]: ['ktlo'] }, onProject: { [KEY(9)]: null } }));
    const set = calls.filter((c) => c.url === `${GHE}/api/graphql`).map((c) => JSON.parse(c.body!) as { variables: Record<string, unknown> }).at(-1)!;
    expect(set.variables.option).toBe('a1b2c3d4');
  });

  it("reports the project's own spelling of the option, not the plan's", async () => {
    const { envelope } = await run(categoryPlan([item(9, 'ktlo', { field: { value: 'ktlo' } })]), world({ issues: { [KEY(9)]: ['ktlo'] }, onProject: { [KEY(9)]: null } }));
    expect(envelope.data).toMatchObject({ changed: [{ key: KEY(9), field: { value: 'KTLO' } }] });
  });

  it('sends no mutation when the field already holds the value, and a second run changes nothing', async () => {
    const { envelope, calls } = await run(categoryPlan([item(9)]), world({ issues: { [KEY(9)]: ['ktlo'] }, onProject: { [KEY(9)]: 'KTLO' } }));
    expect(seq(calls)).toEqual(['GRAPHQL read fields', `GET ${R}/issues/9`, 'GRAPHQL read item']);
    expect(envelope.data).toMatchObject({ changed: [], unchanged: [KEY(9)], notOnProject: [] });
  });

  it("an issue whose labels are right but whose field differs is changed, with no label sent", async () => {
    const { envelope, calls } = await run(categoryPlan([item(9)]), world({ issues: { [KEY(9)]: ['ktlo'] }, onProject: { [KEY(9)]: 'Feature' } }));
    expect(seq(calls)).toEqual(['GRAPHQL read fields', `GET ${R}/issues/9`, 'GRAPHQL read item', 'GRAPHQL set field']);
    expect(envelope.data).toMatchObject({ changed: [{ labels: { added: [], removed: [] }, field: { value: 'KTLO' } }], unchanged: [] });
  });

  it('an issue whose field is right but whose label is missing is changed with the label alone', async () => {
    const { envelope } = await run(categoryPlan([item(9)]), world({ issues: { [KEY(9)]: [] }, onProject: { [KEY(9)]: 'KTLO' } }));
    expect(envelope.data).toMatchObject({ changed: [{ labels: { added: ['ktlo'], removed: [] }, field: null }] });
  });

  it('an issue not on the project gets its label and is listed, with one warning; it is never added', async () => {
    const { envelope, calls } = await run(categoryPlan([item(9), item(10)]), world({ issues: { [KEY(9)]: [], [KEY(10)]: [] }, onProject: { [KEY(10)]: null } }));
    expect(seq(calls).filter((s) => s === 'GRAPHQL set field')).toHaveLength(1);
    expect(envelope.data).toMatchObject({
      changed: [{ key: KEY(9), field: null }, { key: KEY(10), field: { value: 'KTLO' } }],
      notOnProject: [KEY(9)],
    });
    const w = envelope.meta.warnings!.filter((x) => x.code === 'CATEGORIZE_NOT_ON_PROJECT');
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toContain(`${KEY(9)}`);
    expect(w[0]!.message).toContain('got the label and no field value');
    expect(w[0]!.message).toContain('run the same plan again');
    expect(w[0]!.message).toContain('toil github project add 3 <number> --owner imagile --repo <repo> --allow-write');
  });

  it('an issue not on the project whose labels are already right is unchanged, and still listed', async () => {
    const { envelope } = await run(categoryPlan([item(9)]), world({ issues: { [KEY(9)]: ['ktlo'] } }));
    expect(envelope.data).toMatchObject({ changed: [], unchanged: [KEY(9)], notOnProject: [KEY(9)] });
    expect(warned(envelope)).toEqual(['CATEGORIZE_NOT_ON_PROJECT']);
  });

  it('a field the project lacks is NOT_FOUND before any issue is read', async () => {
    const { envelope, calls } = await run(categoryPlan([item(9)], { field: { name: 'Nope', project: 'imagile/3' } }), world({ issues: { [KEY(9)]: [] } }));
    expect(envelope.error).toMatchObject({ code: 'NOT_FOUND', message: 'GitHub has no field named "Nope" on project imagile/3.' });
    expect(seq(calls)).toEqual(['GRAPHQL read fields']);
  });

  it('a field that is not a single-select is INVALID_INPUT before any issue is read', async () => {
    const { envelope, calls } = await run(categoryPlan([item(9)], { field: { name: 'Estimate', project: 'imagile/3' } }), world({ issues: { [KEY(9)]: [] } }));
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('isn\'t a single-select field (it is NUMBER)') });
    expect(seq(calls)).toEqual(['GRAPHQL read fields']);
  });

  it('an option the field lacks is INVALID_INPUT listing the options, before any write', async () => {
    const plan = categoryPlan([item(9), item(10, 'feature', { field: { value: 'Maintenance' } })]);
    const { envelope, calls } = await run(plan, world({ issues: { [KEY(9)]: [], [KEY(10)]: [] } }));
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'The field "Work category" has no option "Maintenance", the value for the category "feature". It has: KTLO, Feature.' });
    expect(seq(calls)).toEqual(['GRAPHQL read fields']);
  });

  it('a field with no project in the plan is INVALID_INPUT, naming the setting, before any request', async () => {
    for (const project of [undefined, 'imagile', 'imagile/three']) {
      const { envelope, calls } = await run(categoryPlan([item(9)], { field: { name: 'Work category', ...(project ? { project } : {}) } }), world({ issues: { [KEY(9)]: [] } }));
      expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', fix: 'toil projects classify set <toil-project> --target github.project=<owner>/<number>' });
      expect(calls).toEqual([]);
    }
  });
});

describe('github issue categorize: what goes wrong', () => {
  it('an issue GitHub cannot find is failed with its reason and a warning; the rest are applied', async () => {
    const { envelope, calls } = await run(categoryPlan([labelOnly(9), labelOnly(10)], noField), world({ issues: { [KEY(10)]: [] } }));
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toMatchObject({ failed: [{ key: KEY(9), reason: 'Not Found' }], changed: [{ key: KEY(10) }], counts: { planned: 2, changed: 1, failed: 1 } });
    expect(warned(envelope)).toEqual(['CATEGORIZE_FAILED']);
    expect(seq(calls)).toContain(`POST ${R}/issues/10/labels`);
  });

  it('a 403 on one write is recorded and the next issue is still applied', async () => {
    const w = world({ issues: { [KEY(9)]: [], [KEY(10)]: [] }, fail: (r) => (r.method === 'POST' && r.url.endsWith('/issues/9/labels') ? { status: 403, json: { message: 'Resource not accessible by personal access token' } } : undefined) });
    const { envelope } = await run(categoryPlan([labelOnly(9), labelOnly(10)], noField), w);
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toMatchObject({ failed: [{ key: KEY(9), reason: expect.stringContaining('Resource not accessible') }], changed: [{ key: KEY(10) }] });
    expect(warned(envelope)).toEqual(['CATEGORIZE_FAILED']);
  });

  it('a 401 stops the command with AUTH', async () => {
    const w = world({ issues: { [KEY(9)]: [], [KEY(10)]: [] }, fail: () => ({ status: 401, json: { message: 'Bad credentials' } }) });
    const { envelope, calls } = await run(categoryPlan([labelOnly(9), labelOnly(10)], noField), w);
    expect(envelope).toMatchObject({ ok: false, error: { code: 'AUTH', message: 'Bad credentials' } });
    expect(calls).toHaveLength(1);
  });

  it('a 401 after some issues were written stops the command with the counts so far in details.categorize', async () => {
    const w = world({ issues: { [KEY(9)]: [], [KEY(10)]: [], [KEY(11)]: [] }, fail: (r) => (r.url.includes('/issues/10/labels') ? { status: 401, json: { message: 'Bad credentials' } } : undefined) });
    const { envelope } = await run(categoryPlan([labelOnly(9), labelOnly(10), labelOnly(11)], noField), w);
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatchObject({ code: 'AUTH', message: 'Bad credentials 1 of 3 items were changed before this.', details: { categorize: { planned: 3, changed: 1, unchanged: 0, failed: 0 } } });
  });

  it('a label that cannot be created fails every issue that needs it in that repository, and adds nothing to them', async () => {
    const w = world({ labels: {}, issues: { [KEY(9)]: [], [KEY(10)]: [] }, fail: (r) => (r.method === 'POST' && r.url.endsWith('/labels') ? { status: 403, json: { message: 'Must have admin rights to Repository.' } } : undefined) });
    const { envelope, calls } = await run(categoryPlan([labelOnly(9), labelOnly(10)], noField), w);
    expect(envelope.data).toMatchObject({ changed: [], failed: [{ key: KEY(9), reason: expect.stringContaining('"ktlo" couldn\'t be created in imagile/toil-probe') }, { key: KEY(10) }], labelsCreated: [] });
    expect(seq(calls).filter((s) => s.endsWith('/issues/9/labels') || s.endsWith('/issues/10/labels'))).toEqual([]);
  });

  it("a key that isn't owner/repo#number is INVALID_INPUT before any request, even with a field to read", async () => {
    for (const key of ['imagile/toil-probe-9', 'PAY-123', 'imagile/toil-probe#0', 'imagile/../x#4']) {
      const { envelope, calls } = await run(categoryPlan([item(9), { ...item(10), key }]), world());
      expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining(`"${key}"`) });
      expect(calls).toEqual([]);
    }
  });
});

describe('github issue categorize: the plan', () => {
  it('a plan with entries only for another connection is INVALID_INPUT', async () => {
    const plan = categoryPlan([item(9)], { connection: 'ghe-other' });
    const { envelope, calls } = await run(plan, world());
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'The plan has nothing for the github connection "github". It holds entries for: github "ghe-other".', fix: expect.stringContaining('--connection ghe-other') });
    expect(calls).toEqual([]);
  });

  it('a group that names a field but holds no items is CATEGORIZE_NOTHING with no request, the field as the plan named it', async () => {
    const { envelope, calls } = await run(categoryPlan([], { field: { name: 'Nope', project: 'imagile/3' } }), world());
    expect(calls).toEqual([]);
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toMatchObject({ field: { name: 'Nope', project: 'imagile/3' }, counts: { planned: 0 } });
    expect((envelope.data as { field: Record<string, unknown> }).field).not.toHaveProperty('id');
    expect(warned(envelope)).toEqual(['CATEGORIZE_NOTHING']);
  });

  it('looks the field up only when an item sets it: a plan that changes labels alone is not refused over a field the project lacks', async () => {
    const { envelope, calls } = await run(categoryPlan([labelOnly(9)], { field: { name: 'Nope', project: 'imagile/3' } }), world({ issues: { [KEY(9)]: ['bug'] } }));
    expect(envelope.ok, JSON.stringify(envelope.error)).toBe(true);
    expect(seq(calls)).toEqual([`GET ${R}/issues/9`, `GET ${R}/labels/ktlo`, `POST ${R}/issues/9/labels`]);
    expect(envelope.data).toMatchObject({ field: { name: 'Nope', project: 'imagile/3' }, changed: [{ key: KEY(9), field: null }] });
    expect((envelope.data as { field: Record<string, unknown> }).field).not.toHaveProperty('id');
  });

  it('an empty plan does nothing and says so', async () => {
    const { envelope, calls } = await run({ ...categoryPlan(), plan: [] }, world());
    expect(calls).toEqual([]);
    expect(envelope.data).toMatchObject({ field: null, changed: [], unchanged: [], failed: [], skipped: [], counts: { planned: 0, changed: 0, unchanged: 0, failed: 0 }, labelsCreated: [], notOnProject: [] });
    expect(warned(envelope)).toEqual(['CATEGORIZE_NOTHING']);
  });

  it("entries for other connections are named in skipped, with a warning, and not applied", async () => {
    const plan = categoryPlan([labelOnly(9)], noField);
    plan.plan.push({ ...plan.plan[0]!, connection: 'ghe-other', items: [labelOnly(1), labelOnly(2)] } as never);
    const { envelope, calls } = await run(plan, world({ issues: { [KEY(9)]: [] } }));
    expect(envelope.data).toMatchObject({ skipped: [{ area: 'github', connection: 'ghe-other', items: 2 }], counts: { planned: 1, changed: 1 } });
    expect(warned(envelope)).toEqual(['CATEGORIZE_SKIPPED']);
    expect(seq(calls).every((s) => !s.includes('issues/1') && !s.includes('issues/2'))).toBe(true);
  });

  it('takes the plan as a classify run envelope too', async () => {
    const { envelope } = await run({ ok: true, data: categoryPlan([labelOnly(9)], noField), error: null, meta: {} }, world({ issues: { [KEY(9)]: ['ktlo'] } }));
    expect(envelope.data).toMatchObject({ unchanged: [KEY(9)] });
  });
});

describe('github issue categorize: the write gate', () => {
  it('without --allow-write it sends nothing', async () => {
    const { envelope, calls } = await run(categoryPlan([item(9)]), world({ issues: { [KEY(9)]: [] } }), { input: { allowWrite: false } });
    expect(envelope.error?.code).toBe('WRITE_DISABLED');
    expect(calls).toEqual([]);
  });

  it('with writes off on the connection it sends nothing', async () => {
    const { envelope, calls } = await run(categoryPlan([item(9)]), world({ issues: { [KEY(9)]: [] } }), { settings: { writes: false } });
    expect(envelope.error?.code).toBe('WRITE_DISABLED');
    expect(calls).toEqual([]);
  });
});

describe('github issue categorize: a label description', () => {
  it('cuts at a word, drops a dangling conjunction, and says it cut', () => {
    const text = describeLabel('Keep the lights on', 'Security patches, bug fixes, dependency upgrades, compliance updates and evidence for the regulators');
    expect(text).toBe('Keep the lights on: Security patches, bug fixes, dependency upgrades, compliance updates…');
    expect(text.length).toBeLessThanOrEqual(100);
    expect(describeLabel('Run', `${'word '.repeat(30)}`.trim()).length).toBeLessThanOrEqual(100);
  });
  it('leaves a text that fits alone', () => {
    expect(describeLabel('Grow', 'New features and experiments')).toBe('Grow: New features and experiments');
    expect(describeLabel('Grow', '')).toBe('Grow');
  });
});
