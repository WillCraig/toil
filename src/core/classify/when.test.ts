import { describe, expect, it } from 'vitest';
import type { WorkItem } from '../owi/types.js';
import { matchWhen, readWhen } from './when.js';

function item(key: string, extra: Partial<WorkItem> = {}): WorkItem {
  return {
    id: `corp-jira:${key}`,
    source: { area: 'jira', connection: 'corp-jira', key, command: 'jira issue search' },
    type: 'STORY',
    typeName: 'Story',
    title: `Work on ${key}`,
    labels: [],
    parent: null,
    ...extra,
  } as WorkItem;
}

const text = (v: unknown, min: number, max: number) => (typeof v !== 'string' ? 'must be text.' : v.trim().length < min ? 'must not be empty.' : v.length > max ? 'is too long.' : undefined);

describe('matchWhen', () => {
  const epic = item('PAY-1', { type: 'EPIC', typeName: 'Epic' });
  const story = item('PAY-2', { parent: 'corp-jira:PAY-1', labels: ['Checkout'], title: 'Bump the card library' });
  const byId = new Map([epic, story].map((i) => [i.id, i]));

  it('matches every key given, any value of each, and says why', () => {
    expect(matchWhen({ type: ['bug', 'story'], label: ['checkout'] }, story, byId)).toBe('it carries the label "checkout" and its type is story');
    expect(matchWhen({ parent: ['PAY-1'] }, story, byId)).toBe('it sits under PAY-1');
    expect(matchWhen({ title: ['bump'] }, story, byId)).toBe('its title contains "bump"');
    expect(matchWhen({ type: ['Story'], label: ['other'] }, story, byId)).toBeNull();
  });

  it('matches a parent the input does not hold by id or key, and never loops on a cycle', () => {
    const orphan = item('PAY-3', { parent: 'corp-jira:PAY-9' });
    expect(matchWhen({ parent: ['PAY-9'] }, orphan, new Map())).toBe('it sits under PAY-9');
    const a = item('A', { parent: 'corp-jira:B' });
    const b = item('B', { parent: 'corp-jira:A' });
    expect(matchWhen({ parent: ['C'] }, a, new Map([a, b].map((i) => [i.id, i])))).toBeNull();
  });

  it('matches nothing with no keys', () => {
    expect(matchWhen({}, story, byId)).toBeNull();
  });
});

describe('readWhen', () => {
  const read = (value: unknown) => {
    const problems: string[] = [];
    const when = readWhen(value, 'rules[0].when', (path, message) => problems.push(`${path}: ${message}`), text);
    return { when, problems };
  };

  it('reads the four keys, trimmed', () => {
    expect(read({ type: [' BUG '], label: ['x'], parent: ['PAY-1'], title: ['Bump'] })).toEqual({ when: { type: ['BUG'], label: ['x'], parent: ['PAY-1'], title: ['Bump'] }, problems: [] });
  });

  it('refuses an empty object, an unknown key, an empty list and a bad value, by path', () => {
    expect(read({}).problems).toEqual(['rules[0].when: "when" must name at least one of parent, label, type, title.']);
    expect(read({ status: ['Done'] }).problems[0]).toContain('rules[0].when.status: "status" isn\'t something a rule can match on');
    expect(read({ type: [] }).problems[0]).toContain('must be a list of 1 to 50 texts');
    expect(read({ type: [3] }).problems).toEqual(['rules[0].when.type[0]: A value must be text.']);
    expect(read('BUG').problems[0]).toContain('"when" must be an object');
    expect(read({ type: [3] }).when).toBeUndefined();
  });
});
