import { describe, expect, it } from 'vitest';
import { memoryFiles } from '../../../test/harness/files.js';
import type { WorkItem } from '../owi/types.js';
import { classify, type ClassifyInput } from './engine.js';
import { planFor, readPlanFrom } from './plan.js';
import type { Scheme } from './types.js';

function item(key: string, extra: Omit<Partial<WorkItem>, 'area'> & { connection?: string; area?: string } = {}): WorkItem {
  const { connection = 'corp-jira', area = 'jira', ...rest } = extra;
  return {
    owi: '0.2',
    id: `${connection}:${key}`,
    source: { area, connection, key, command: `${area} issue search` },
    url: `https://${area}.imagile.dev/browse/${key}`,
    type: 'TASK',
    typeName: 'Task',
    title: `Work on ${key}`,
    body: null,
    status: 'To Do',
    statusCategory: 'TODO',
    resolution: null,
    assignee: null,
    reporter: null,
    priority: null,
    estimate: null,
    labels: [],
    team: null,
    iteration: null,
    parent: null,
    children: [],
    links: [],
    created: null,
    updated: null,
    resolved: null,
    dueDate: null,
    history: null,
    unmapped: [],
    native: {},
    ...rest,
  } as WorkItem;
}

const scheme = (extra: Partial<Scheme> = {}): Scheme => ({
  name: 'ktlo-feature',
  revision: 3,
  categories: [
    { id: 'ktlo', short: 'KTLO', name: 'Keep the lights on', label: 'ktlo', definition: 'Work that keeps what exists running.' },
    { id: 'feature', short: 'Feature', name: 'Feature', label: 'feature', definition: 'New value for users.' },
  ],
  guidance: [],
  examples: [],
  rules: [],
  signals: true,
  labels: {},
  ...extra,
});

const run = (input: Partial<ClassifyInput> & { items: WorkItem[] }) => classify({ scheme: scheme(), ...input });
const only = (input: Partial<ClassifyInput> & { items: WorkItem[] }) => run(input).result.verdicts[0]!;
const jiraField = (id: string, value: unknown): Record<string, unknown> => ({ 'jira issue search': { fields: { [id]: value } } });
const target = { field: 'Work category', fieldId: 'customfield_10042' };

describe('already categorized', () => {
  it('takes the label over the field, and the plan puts the field right to the label', async () => {
    const v = run({ items: [item('PAY-1', { labels: ['feature'], native: jiraField('customfield_10042', { value: 'ktlo' }) })], targets: { jira: target } });
    const verdict = v.result.verdicts[0]!;
    expect([verdict.category, verdict.source, verdict.reason]).toEqual(['feature', 'label', 'It already carries the label "feature".']);
    // The field is corrected to the label, never the other way round: no label is added or removed.
    expect(v.result.plan[0]!.items).toEqual([{ id: 'corp-jira:PAY-1', key: 'PAY-1', category: 'feature', labels: { add: [], remove: [] }, field: { value: 'Feature' } }]);
  });

  it('settles by the field only when the item has no scheme label', async () => {
    const { result } = run({ items: [item('PAY-1', { labels: ['unrelated'], native: jiraField('customfield_10042', { value: 'ktlo' }) })], targets: { jira: target } });
    expect(result.verdicts[0]).toMatchObject({ category: 'ktlo', source: 'field' });
    expect(result.plan[0]!.items[0]!.labels).toEqual({ add: ['ktlo'], remove: [] });
  });

  it('settles by the field when two different scheme labels disagree and the field has a value; with no field value it goes on to the rules', async () => {
    const labels = ['ktlo', 'feature'];
    const withField = only({ items: [item('PAY-1', { labels, native: jiraField('customfield_10042', { value: 'feature' }) })], targets: { jira: target } });
    expect([withField.category, withField.source]).toEqual(['feature', 'field']);
    const s = scheme({ rules: [{ id: 'tasks', when: { type: ['Task'] }, then: 'ktlo' }] });
    for (const native of [jiraField('customfield_10042', null), {}]) {
      const v = classify({ scheme: s, items: [item('PAY-1', { labels, native })], targets: { jira: target } }).result.verdicts[0]!;
      expect(v.source).toBe('rule:tasks');
    }
  });

  it('does not let a field disagreeing with the label change the label, even with planFields off', async () => {
    const { result } = run({ items: [item('PAY-1', { labels: ['ktlo'], native: jiraField('customfield_10042', { value: 'feature' }) })], targets: { jira: target }, planFields: false });
    expect(result.verdicts[0]).toMatchObject({ category: 'ktlo', source: 'label' });
    expect(result.plan).toEqual([]);
  });

  it('uses the target values mapping for the field', async () => {
    const v = only({ items: [item('PAY-1', { native: jiraField('customfield_10042', 'Run') })], targets: { jira: { ...target, values: { ktlo: 'Run' } } } });
    expect([v.category, v.source]).toEqual(['ktlo', 'field']);
  });

  it('settles by the label when the field is empty, unread or unmatched', async () => {
    for (const native of [jiraField('customfield_10042', null), {}, jiraField('customfield_10042', 'Other')]) {
      const v = only({ items: [item('PAY-1', { labels: ['KTLO'], native })], targets: { jira: target } });
      expect([v.category, v.source, v.reason]).toEqual(['ktlo', 'label', 'It already carries the label "KTLO".']);
    }
  });

  it('beats a rule, and --recheck ignores it', async () => {
    const s = scheme({ rules: [{ id: 'all-bugs', when: { type: ['Task'] }, then: 'feature' }] });
    const i = item('PAY-1', { labels: ['ktlo'] });
    expect(classify({ scheme: s, items: [i] }).result.verdicts[0]!.source).toBe('label');
    expect(classify({ scheme: s, items: [i], recheck: true }).result.verdicts[0]!.source).toBe('rule:all-bugs');
  });

  it('settles nothing from two different scheme labels', async () => {
    const v = only({ items: [item('PAY-1', { labels: ['ktlo', 'feature'] })] });
    expect(v.source).toBe('unsure');
  });

  it("honours the tracker's own spelling of the label", async () => {
    const s = scheme({ labels: { ado: { ktlo: 'KTLO' } } });
    const v = classify({ scheme: s, items: [item('1', { area: 'ado', connection: 'corp-ado', labels: ['KTLO'] })] }).result.verdicts[0]!;
    expect(v.category).toBe('ktlo');
  });
});

describe('rules', () => {
  const rule = (when: object, then = 'feature', id = 'r1') => scheme({ rules: [{ id, when, then }] });
  const verdict = (s: Scheme, ...items: WorkItem[]) => classify({ scheme: s, items }).result.verdicts;

  it('go in file order and beat signals', async () => {
    const s = scheme({ rules: [{ id: 'first', when: { label: ['x'] }, then: 'feature' }, { id: 'second', when: { label: ['x'] }, then: 'ktlo' }] });
    const [v] = verdict(s, item('PAY-1', { labels: ['x'], type: 'BUG', typeName: 'Bug' }));
    expect([v!.category, v!.source]).toEqual(['feature', 'rule:first']);
    expect(v!.reason).toBe('Rule first: it carries the label "x".');
  });

  it('needs every key to match, and any value of a key', async () => {
    const s = rule({ label: ['a', 'b'], type: ['spike'] });
    expect(verdict(s, item('P-1', { labels: ['B'], typeName: 'Spike' }))[0]!.source).toBe('rule:r1');
    expect(verdict(s, item('P-2', { labels: ['B'], typeName: 'Task' }))[0]!.source).toBe('unsure');
    expect(verdict(s, item('P-3', { labels: [], typeName: 'Spike' }))[0]!.source).toBe('unsure');
  });

  it('matches type by OWI type or type name, and title by substring', async () => {
    expect(verdict(rule({ type: ['BUG'] }), item('P-1', { type: 'BUG', typeName: 'Defect' }))[0]!.source).toBe('rule:r1');
    expect(verdict(rule({ title: ['PAYMENT'] }), item('P-1', { title: 'fix the Payments page' }))[0]!.source).toBe('rule:r1');
  });

  it('matches a parent at any depth, by key or id', async () => {
    const epic = item('PAY-100', { type: 'EPIC', title: 'Card payments v2', children: [] });
    const story = item('PAY-101', { parent: epic.id });
    const task = item('PAY-102', { parent: story.id });
    const s = rule({ parent: ['pay-100'] });
    const vs = verdict(s, task, story, epic);
    expect(vs.map((v) => v.source)).toEqual(['rule:r1', 'rule:r1', 'unsure']);
    expect(vs[0]!.reason).toBe('Rule r1: it sits under pay-100.');
    expect(verdict(rule({ parent: ['corp-jira:PAY-100'] }), task, story, epic)[0]!.source).toBe('rule:r1');
  });

  it("matches a parent that isn't in the input by id or key", async () => {
    const orphan = item('PAY-9', { parent: 'corp-jira:PAY-500' });
    expect(verdict(rule({ parent: ['PAY-500'] }), orphan)[0]!.source).toBe('rule:r1');
    expect(verdict(rule({ parent: ['corp-jira:pay-500'] }), orphan)[0]!.source).toBe('rule:r1');
    expect(verdict(rule({ parent: ['PAY-50'] }), orphan)[0]!.source).toBe('unsure');
  });

  it('survives a parent cycle', async () => {
    const a = item('PAY-1', { parent: 'corp-jira:PAY-2' });
    const b = item('PAY-2', { parent: 'corp-jira:PAY-1' });
    expect(verdict(rule({ parent: ['PAY-3'] }), a, b).map((v) => v.source)).toEqual(['unsure', 'unsure']);
  });

  it('warns about a rule naming an unknown category, and skips it', async () => {
    const { result, warnings } = classify({ scheme: rule({ label: ['x'] }, 'nope'), items: [item('P-1', { labels: ['x'] })] });
    expect(result.verdicts[0]!.source).toBe('unsure');
    expect(warnings.map((w) => w.code)).toEqual(['CLASSIFY_RULE_UNKNOWN_CATEGORY']);
  });
});

describe('signals', () => {
  it('apply below rules, only with signals on and a ktlo category', async () => {
    const bug = item('PAY-1', { type: 'BUG', typeName: 'Bug' });
    const v = classify({ scheme: scheme(), items: [bug] }).result.verdicts[0]!;
    expect([v.category, v.source, v.reason]).toEqual(['ktlo', 'signal:type', 'Its type is Bug.']);
    expect(classify({ scheme: scheme({ signals: false }), items: [bug] }).result.verdicts[0]!.source).toBe('unsure');
    const noKtlo = scheme({ categories: scheme().categories.filter((c) => c.id !== 'ktlo') });
    expect(classify({ scheme: noKtlo, items: [bug] }).result.verdicts[0]!.source).toBe('unsure');
  });
});

describe('the parent', () => {
  it('passes its verdict down, whatever the order of the input', async () => {
    const epic = item('PAY-100', { type: 'EPIC', typeName: 'Epic', title: 'Card payments v2', labels: ['feature'] });
    const story = item('PAY-101', { parent: epic.id });
    const task = item('PAY-102', { parent: story.id });
    for (const items of [[epic, story, task], [task, story, epic]]) {
      const vs = classify({ scheme: scheme(), items }).result.verdicts;
      const t = vs.find((v) => v.key === 'PAY-102')!;
      expect([t.category, t.source, t.reason]).toEqual(['feature', 'parent', 'Its parent PAY-101 ("Work on PAY-101") is Feature.']);
      expect(vs.find((v) => v.key === 'PAY-101')!.reason).toBe('Its parent PAY-100 ("Card payments v2") is Feature.');
    }
  });

  it('is beaten by a signal on the child', async () => {
    const epic = item('PAY-100', { labels: ['feature'] });
    const bug = item('PAY-101', { parent: epic.id, type: 'BUG', typeName: 'Bug' });
    expect(classify({ scheme: scheme(), items: [epic, bug] }).result.verdicts[1]!.source).toBe('signal:type');
  });

  it('stays unsure in a cycle and with a parent outside the input', async () => {
    const a = item('PAY-1', { parent: 'corp-jira:PAY-2' });
    const b = item('PAY-2', { parent: 'corp-jira:PAY-1' });
    const c = item('PAY-3', { parent: 'corp-jira:PAY-9' });
    const { result } = classify({ scheme: scheme(), items: [a, b, c] });
    expect(result.verdicts.map((v) => v.source)).toEqual(['unsure', 'unsure', 'unsure']);
    expect(result.verdicts[0]).toMatchObject({ category: null, name: null, short: null, reason: 'Nothing settled it: no category on it, no rule or signal matched, and its parent is unsettled.' });
  });
});

describe('the agent', () => {
  const epic = item('PAY-100', { type: 'EPIC', typeName: 'Epic' });
  const child = item('PAY-101', { parent: epic.id });
  const settled = item('PAY-102', { labels: ['ktlo'] });

  it('fills only unsure items, and its epic carries the children', async () => {
    const { result, warnings } = classify({ scheme: scheme(), items: [child, epic, settled], verdicts: [{ id: epic.id, category: 'feature', reason: '  New\nwork for users. ' }] });
    expect(result.verdicts.map((v) => [v.key, v.category, v.source])).toEqual([['PAY-101', 'feature', 'parent'], ['PAY-100', 'feature', 'agent'], ['PAY-102', 'ktlo', 'label']]);
    expect(result.verdicts[1]!.reason).toBe('New work for users.');
    expect(warnings).toEqual([]);
  });

  it('leaves an item unsure on an unsure verdict, trims the reason to 300 characters', async () => {
    const a = classify({ scheme: scheme(), items: [epic], verdicts: [{ id: epic.id, category: 'unsure', reason: 'dunno' }] }).result.verdicts[0]!;
    expect(a.source).toBe('unsure');
    const b = classify({ scheme: scheme(), items: [epic], verdicts: [{ id: epic.id, category: 'ktlo', reason: 'x'.repeat(500) }] }).result.verdicts[0]!;
    expect(b.reason).toHaveLength(300);
  });

  it('ignores a verdict for a settled item with one warning', async () => {
    const { result, warnings } = classify({
      scheme: scheme(),
      items: [settled, item('PAY-103', { labels: ['feature'] })],
      verdicts: [{ id: settled.id, category: 'feature', reason: 'r' }, { id: 'corp-jira:PAY-103', category: 'ktlo', reason: 'r' }],
    });
    expect(result.verdicts[0]!.category).toBe('ktlo');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: 'CLASSIFY_VERDICT_IGNORED' });
    expect(warnings[0]!.message).toContain('2 agent verdicts were ignored');
    expect(warnings[0]!.message).toContain('corp-jira:PAY-102');
  });
});

describe('duplicates', () => {
  it('classifies an item once, the first, with a warning', async () => {
    const first = item('PAY-1', { labels: ['ktlo'] });
    const { result, warnings } = classify({ scheme: scheme(), items: [first, item('PAY-1', { labels: ['feature'] })] });
    expect(result.verdicts).toHaveLength(1);
    expect(result.verdicts[0]!.category).toBe('ktlo');
    expect(warnings.map((w) => w.code)).toEqual(['CLASSIFY_DUPLICATE_ITEM']);
  });
});

describe('the plan', () => {
  const planOf = (input: Partial<ClassifyInput> & { items: WorkItem[] }) => run(input).result.plan;

  it('adds the label an item lacks, and carries the scheme labels', async () => {
    const [group] = planOf({ items: [item('PAY-1', { type: 'BUG', typeName: 'Bug', labels: ['x'] })] });
    expect(group).toEqual({
      area: 'jira',
      connection: 'corp-jira',
      labels: { ktlo: 'ktlo', feature: 'feature' },
      items: [{ id: 'corp-jira:PAY-1', key: 'PAY-1', category: 'ktlo', labels: { add: ['ktlo'], remove: [] } }],
    });
  });

  it('leaves out an item with nothing to change, and a group with no items', async () => {
    expect(planOf({ items: [item('PAY-1', { labels: ['KTLO'] })] })).toEqual([]);
    expect(planOf({ items: [item('PAY-1')] })).toEqual([]);
  });

  it('removes the scheme\'s other labels, spelled as the item has them', async () => {
    const s = scheme({ rules: [{ id: 'r', when: { label: ['Roadmap'] }, then: 'feature' }] });
    const [group] = classify({ scheme: s, items: [item('PAY-1', { labels: ['Roadmap', 'KTLO', 'ktlo'] })], recheck: true }).result.plan;
    expect(group!.items[0]!.labels).toEqual({ add: ['feature'], remove: ['KTLO', 'ktlo'] });
  });

  it('plans a field that is unknown, empty or different, and skips one that matches ignoring case', async () => {
    const t = { field: 'Work category', fieldId: 'customfield_10042' };
    const mk = (key: string, native: Record<string, unknown>) => item(key, { labels: ['ktlo'], native });
    const items = [
      mk('A-1', {}),
      mk('A-2', jiraField('customfield_10042', null)),
      mk('A-3', jiraField('customfield_10042', { value: 'Other' })),
      mk('A-4', jiraField('customfield_10042', { value: 'ktlo' })),
    ];
    const [group] = planOf({ items, targets: { jira: t } });
    expect(group!.field).toEqual({ name: 'Work category' });
    expect(group!.items.map((i) => [i.key, i.field])).toEqual([['A-1', { value: 'KTLO' }], ['A-2', { value: 'KTLO' }], ['A-3', { value: 'KTLO' }]]);
    expect(group!.items.every((i) => i.labels.add.length === 0)).toBe(true);
  });

  it('with planFields off, still reads the field for a verdict but plans labels only: no group field, no item field, and no entry for an item whose only change was the field', async () => {
    const t = { field: 'Work category', fieldId: 'customfield_10042' };
    const items = [
      // Settled by the field alone; its label is missing, so the plan adds the label and no field value.
      item('A-1', { native: jiraField('customfield_10042', { value: 'ktlo' }) }),
      // Labelled right and the field is empty: the only change would be the field, so it is left out.
      item('A-2', { labels: ['ktlo'], native: jiraField('customfield_10042', null) }),
      // Labelled right and the field is right: nothing to do either way.
      item('A-3', { labels: ['ktlo'], native: jiraField('customfield_10042', { value: 'ktlo' }) }),
    ];
    const withFields = classify({ scheme: scheme(), items, targets: { jira: t } }).result;
    expect(withFields.plan[0]!.field).toEqual({ name: 'Work category' });
    expect(withFields.plan[0]!.items.map((i) => i.key)).toEqual(['A-1', 'A-2']);

    const { result } = classify({ scheme: scheme(), items, targets: { jira: t }, planFields: false });
    expect(result.verdicts[0]).toMatchObject({ category: 'ktlo', source: 'field' });
    expect(result.plan).toHaveLength(1);
    expect(result.plan[0]!.field).toBeUndefined();
    expect(result.plan[0]!.items).toEqual([{ id: 'corp-jira:A-1', key: 'A-1', category: 'ktlo', labels: { add: ['ktlo'], remove: [] } }]);
    expect(result.plan[0]!.items.every((i) => i.field === undefined)).toBe(true);
  });

  it("carries a GitHub project and the target's values", async () => {
    const gh = item('imagile/payments-web#4', { area: 'github', connection: 'github', type: 'BUG', typeName: 'Bug', labels: ['ktlo'] });
    const [group] = planOf({ items: [gh], targets: { github: { field: 'Work', project: 'imagile/3', values: { ktlo: 'Run' } } } });
    expect(group).toMatchObject({ area: 'github', field: { name: 'Work', project: 'imagile/3' } });
    expect(group!.items[0]!.field).toEqual({ value: 'Run' });
  });

  it("uses an area's own label spelling", async () => {
    const s = scheme({ labels: { ado: { ktlo: 'KTLO' } } });
    const [group] = classify({ scheme: s, items: [item('12', { area: 'ado', connection: 'corp-ado', type: 'BUG', typeName: 'Bug' })] }).result.plan;
    expect(group!.labels).toEqual({ ktlo: 'KTLO', feature: 'feature' });
    expect(group!.items[0]!.labels.add).toEqual(['KTLO']);
  });

  it('groups by area and connection in first-seen order', async () => {
    const bug = { type: 'BUG', typeName: 'Bug' } as const;
    const plan = planOf({
      items: [item('A-1', { ...bug, connection: 'b-jira' }), item('B-1', { ...bug, area: 'ado', connection: 'corp-ado' }), item('A-2', { ...bug, connection: 'b-jira' }), item('C-1', { ...bug, connection: 'a-jira' })],
    });
    expect(plan.map((g) => [g.area, g.connection, g.items.length])).toEqual([['jira', 'b-jira', 2], ['ado', 'corp-ado', 1], ['jira', 'a-jira', 1]]);
  });

  it('never plans an unsure item, and warns once about areas it cannot write back to', async () => {
    const { result, warnings } = classify({
      scheme: scheme(),
      items: [item('A-1'), item('B-1', { area: 'bitbucket', connection: 'bb', type: 'BUG', typeName: 'Bug' }), item('B-2', { area: 'bitbucket', connection: 'bb', type: 'BUG', typeName: 'Bug' })],
    });
    expect(result.plan).toEqual([]);
    expect(result.verdicts.map((v) => v.category)).toEqual([null, 'ktlo', 'ktlo']);
    expect(warnings).toEqual([expect.objectContaining({ code: 'CLASSIFY_NO_WRITE_BACK', message: expect.stringContaining('bitbucket') })]);
  });
});

describe('the summary', () => {
  it('counts categories, sources, the rules share and the labels already there', async () => {
    const epic = item('P-1', { labels: ['feature'] });
    const { result } = classify({
      scheme: scheme(),
      items: [epic, item('P-2', { parent: epic.id }), item('P-3', { type: 'BUG', typeName: 'Bug' }), item('P-4', { labels: ['KTLO'] }), item('P-5')],
      toilProject: 'payments',
    });
    expect(result.toilProject).toBe('payments');
    expect(result.summary).toEqual({
      items: 5,
      byCategory: { ktlo: 2, feature: 2, unsure: 1 },
      bySource: { label: 2, parent: 1, 'signal:type': 1, unsure: 1 },
      settledByRules: 0.4,
      alreadyLabelled: { ktlo: 1, feature: 1 },
    });
    expect(result.scheme).toEqual({ name: 'ktlo-feature', revision: 3 });
  });

  it('is null and zeroed with no items', async () => {
    const { result } = classify({ scheme: scheme(), items: [] });
    expect(result.summary).toEqual({ items: 0, byCategory: { ktlo: 0, feature: 0, unsure: 0 }, bySource: {}, settledByRules: null, alreadyLabelled: { ktlo: 0, feature: 0 } });
    expect(result.toilProject).toBeNull();
  });

  it('counts labels already there even with recheck', async () => {
    const { result } = classify({ scheme: scheme(), items: [item('P-1', { labels: ['ktlo'] })], recheck: true });
    expect(result.summary.alreadyLabelled.ktlo).toBe(1);
  });
});

describe('the contract with categorize', () => {
  it('round-trips a realistic result through readPlanFrom', async () => {
    const epic = item('PAY-100', { type: 'EPIC', typeName: 'Epic', labels: ['Feature'] });
    const items = [epic, item('PAY-101', { parent: epic.id, labels: ['ktlo'] }), item('PAY-102', { type: 'BUG', typeName: 'Bug', labels: ['feature', 'x'] }), item('PAY-103', { title: 'Bump lodash' }), item('PAY-104')];
    const { result } = classify({ scheme: scheme(), items, targets: { jira: { field: 'Work category', fieldId: 'customfield_10042' } }, toilProject: 'payments' });
    expect(result.plan.length).toBeGreaterThan(0);
    for (const text of [JSON.stringify(result), JSON.stringify({ ok: true, data: result, error: null, meta: {} })]) {
      const files = memoryFiles({ 'plan.json': text });
      const plan = (await readPlanFrom({ files }, 'plan.json'));
      expect(plan.plan).toEqual(result.plan);
      expect(plan.scheme).toEqual(result.scheme);
      expect(planFor(plan, 'jira', 'corp-jira').group?.items.map((i) => i.key)).toEqual(['PAY-100', 'PAY-101', 'PAY-102', 'PAY-103']);
    }
  });
});

describe("a person's say", () => {
  const bug = (extra: Parameters<typeof item>[1] = {}) => item('PAY-1', { type: 'BUG', typeName: 'Bug', ...extra });
  const rule = { id: 'all-bugs', when: { type: ['BUG'] }, then: 'ktlo' };

  it('beats a rule and a signal, and says so with their reason', async () => {
    const v = only({ scheme: scheme({ rules: [rule] }), items: [bug()], person: { 'corp-jira:PAY-1': { category: 'feature', reason: 'adds a new export format' } } });
    expect(v).toMatchObject({ category: 'feature', source: 'person' });
    expect(v.reason).toBe('A person chose Feature: adds a new export format.');
    expect(only({ items: [bug()], person: { 'corp-jira:PAY-1': { category: 'feature', reason: null } } }).reason).toBe('A person chose Feature.');
  });

  it('beats the parent and the agent, since a person decided before either could', async () => {
    const epic = item('PAY-9', { type: 'EPIC', typeName: 'Epic', labels: ['ktlo'] });
    const child = item('PAY-2', { parent: epic.id });
    const { result } = run({ items: [epic, child], person: { [child.id]: { category: 'feature', reason: null } }, verdicts: [{ id: child.id, category: 'ktlo', reason: 'agent' }] });
    expect(result.verdicts.find((x) => x.key === 'PAY-2')).toMatchObject({ category: 'feature', source: 'person' });
  });

  it("loses to a category already on the item, and --recheck hands the say back to the person over the label", async () => {
    const labelled = bug({ labels: ['ktlo'] });
    const person = { 'corp-jira:PAY-1': { category: 'feature', reason: null } };
    expect(only({ items: [labelled], person })).toMatchObject({ category: 'ktlo', source: 'label' });
    expect(only({ items: [labelled], person, recheck: true })).toMatchObject({ category: 'feature', source: 'person' });
  });

  it("outranks a label that still says what the tracker held before the person spoke, and only that label", async () => {
    const person = { 'corp-jira:PAY-1': { category: 'feature', reason: null, from: 'ktlo' } };
    expect(only({ items: [bug({ labels: ['ktlo'] })], person })).toMatchObject({ category: 'feature', source: 'person' });
    // Someone set the label to something else since: that is the tracker speaking, and it wins.
    const three = scheme({ categories: [...scheme().categories, { id: 'chore', short: 'Chore', name: 'Chore', label: 'chore', definition: 'Housekeeping.' }] });
    expect(only({ scheme: three, items: [bug({ labels: ['chore'] })], person })).toMatchObject({ category: 'chore', source: 'label' });
    // With nothing to compare (no `from`), a label still wins.
    expect(only({ items: [bug({ labels: ['ktlo'] })], person: { 'corp-jira:PAY-1': { category: 'feature', reason: null } } })).toMatchObject({ source: 'label' });
  });

  it('words the reason by the door that recorded it', async () => {
    const say = (via: 'cli' | 'mcp' | 'api' | 'tracker', reason: string | null) => only({ items: [bug()], person: { 'corp-jira:PAY-1': { category: 'feature', reason, via } } });
    expect(say('mcp', 'You said so.')).toMatchObject({ source: 'person', reason: 'Recorded by an AI agent for a person: Feature (You said so.).' });
    expect(say('tracker', null)).toMatchObject({ source: 'person', reason: 'Changed in the tracker to Feature.' });
    expect(say('api', 'ok').reason).toBe('A person chose Feature: ok.');
  });

  it('is ignored with one warning when the scheme no longer has the category', async () => {
    const { result, warnings } = run({ items: [bug(), item('PAY-3', { type: 'BUG', typeName: 'Bug' })], person: { 'corp-jira:PAY-1': { category: 'chore', reason: null }, 'corp-jira:PAY-3': { category: 'gone', reason: null } } });
    expect(result.verdicts.map((v) => v.source)).toEqual(['signal:type', 'signal:type']);
    expect(warnings.filter((w) => w.code === 'CLASSIFY_PERSON_UNKNOWN_CATEGORY')).toHaveLength(1);
    expect(warnings.find((w) => w.code === 'CLASSIFY_PERSON_UNKNOWN_CATEGORY')!.message).toContain('corp-jira:PAY-1');
  });

  it('changes nothing for an item with no entry, and `person: {}` is the same as none', async () => {
    const items = [bug(), item('PAY-2')];
    expect(run({ items, person: {} })).toEqual(run({ items }));
  });
});
