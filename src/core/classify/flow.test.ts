import { describe, expect, it } from 'vitest';
import type { WorkItem } from '../owi/types.js';
import { builtinScheme } from './builtin.js';
import { classify } from './engine.js';

/**
 * The built-in flow scheme, run through the engine: its four rules decide, in order, and nothing else does. Items that
 * would trip toil's keep-the-lights-on signals stay unsure here, because flow turns them off; the signals have been
 * informed and have filed no objection.
 */

function item(key: string, extra: Partial<WorkItem> = {}): WorkItem {
  return {
    owi: '0.2',
    id: `corp-jira:${key}`,
    source: { area: 'jira', connection: 'corp-jira', key, command: 'jira issue search' },
    url: `https://jira.imagile.dev/browse/${key}`,
    type: 'STORY',
    typeName: 'Story',
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
    ...extra,
  } as WorkItem;
}

const verdict = (one: WorkItem) => classify({ scheme: builtinScheme('flow')!, items: [one] }).result.verdicts[0]!;
const decided = (one: WorkItem) => {
  const v = verdict(one);
  return [v.category, v.source];
};

describe('the flow scheme', () => {
  it('calls a task or issue labelled bug a defect', () => {
    expect(decided(item('PAY-9', { type: 'TASK', typeName: 'Task', labels: ['bug'] }))).toEqual(['defect', 'rule:defect-label']);
  });

  it('calls a bug a defect', () => {
    expect(decided(item('PAY-1', { type: 'BUG', typeName: 'Bug' }))).toEqual(['defect', 'rule:defect']);
  });

  it('calls a security or compliance item risk, even when it is a bug', () => {
    expect(decided(item('PAY-2', { labels: ['security'] }))).toEqual(['risk', 'rule:risk']);
    expect(decided(item('PAY-3', { type: 'BUG', typeName: 'Bug', labels: ['Compliance'] }))).toEqual(['risk', 'rule:risk']);
  });

  it('calls a bump or an upgrade debt by its title, and an item labelled tech-debt', () => {
    expect(decided(item('PAY-4', { title: 'Bump lodash from 4.17.20 to 4.17.21' }))).toEqual(['debt', 'rule:debt-title']);
    expect(decided(item('PAY-5', { title: 'upgrade the build image' }))).toEqual(['debt', 'rule:debt-title']);
    expect(decided(item('PAY-6', { labels: ['tech-debt'] }))).toEqual(['debt', 'rule:tech-debt']);
  });

  it('calls a plain story a feature', () => {
    expect(decided(item('PAY-7', { title: 'Let customers save a card' }))).toEqual(['feature', 'rule:story']);
  });

  it('keeps a story labelled tech-debt as debt, since the story rule comes last', () => {
    expect(decided(item('PAY-8', { title: 'Split the payments module', labels: ['tech-debt'] }))).toEqual(['debt', 'rule:tech-debt']);
  });

  it('leaves a plain task unsure, for a person or an agent to decide', () => {
    expect(decided(item('PAY-10', { type: 'TASK', typeName: 'Task', title: 'Rotate the staging certificate' }))).toEqual([null, 'unsure']);
  });

  it('fires none of toil\'s signals, so an incident with no rule match stays unsure', () => {
    const v = verdict(item('PAY-8', { type: 'INCIDENT', typeName: 'Incident', title: 'Checkout outage', labels: ['hotfix'] }));
    expect(v.category).toBeNull();
    expect(v.source).not.toMatch(/^signal:/);
  });
});
