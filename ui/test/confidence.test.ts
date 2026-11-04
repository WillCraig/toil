import { describe, expect, it } from 'vitest';
import { FRESH_HOURS, LACK_SHARE, MIN_ITEMS, OLD_HOURS, ageHoursOf, ago, howSure, type SureInput } from '../src/model/confidence.ts';

/**
 * "How sure is this?" (#552): the rule at its edges. Every case starts from an
 * input that is High on all three checks and moves exactly one of them, so a
 * test names the check it is about.
 */

const clear: SureInput = { failed: [], ageHours: 2, items: 12, lacking: { what: 'no estimate', count: 1, of: 10 } };
const sure = (over: Partial<SureInput>) => howSure({ ...clear, ...over });

describe('how sure', () => {
  it('is High when every read worked, the data is under 24 hours old, and at most 1 in 10 items lacks what the question needs', () => {
    const s = sure({});
    expect([s.level, s.word, s.reasons]).toEqual(['high', 'High', []]);
    expect(s.because).toBe('Every saved read worked, the data was read 2 hours ago, and there are 12 items to go on.');
  });

  it('says it vouched only for the reads the answer depends on, when the check was scoped to them', () => {
    expect(sure({ scoped: true }).because).toBe('Every read this answer depends on worked, the data was read 2 hours ago, and there are 12 items to go on.');
  });

  it('is High with nothing lacking to count, and for a typed question that names none', () => {
    expect(sure({ lacking: null }).level).toBe('high');
    expect(sure({ lacking: { what: 'no estimate', count: 0, of: 0 } }).level).toBe('high');
  });

  it('drops to Medium at 24 hours and stays there up to 72', () => {
    expect(sure({ ageHours: FRESH_HOURS - 0.01 }).level).toBe('high');
    expect(sure({ ageHours: FRESH_HOURS }).level).toBe('medium');
    expect(sure({ ageHours: OLD_HOURS }).level).toBe('medium');
    expect(sure({ ageHours: OLD_HOURS + 0.01 }).level).toBe('low');
    expect(sure({ ageHours: 30 }).because).toBe('The data was read 30 hours ago.');
    expect(sure({ ageHours: 100 }).because).toBe('The data was read 4 days ago.');
  });

  it('drops to Medium when more than 1 in 10 items lacks what the question needs, and not at exactly 1 in 10', () => {
    expect(LACK_SHARE).toBe(0.1);
    expect(sure({ lacking: { what: 'no estimate', count: 1, of: 10 } }).level).toBe('high');
    const s = sure({ lacking: { what: 'no estimate', count: 2, of: 10 } });
    expect(s.level).toBe('medium');
    expect(s.because).toBe('2 of 10 items have no estimate.');
    expect(s.reasons).toEqual(['2 of 10 lack no estimate']);
  });

  it('is Low with fewer than 3 items, and not at 3', () => {
    expect(MIN_ITEMS).toBe(3);
    expect(sure({ items: 3 }).level).toBe('high');
    expect(sure({ items: 2 }).level).toBe('low');
    expect(sure({ items: 1 }).because).toBe('There is only 1 item to go on.');
    expect(sure({ items: 0 }).because).toBe('There are no items to go on.');
  });

  it('counts the base in pull requests for a question about reviews, and says none plainly', () => {
    expect(sure({ items: 2, noun: 'pull request' }).because).toBe('There are only 2 pull requests to go on.');
    expect(sure({ items: 0, noun: 'code review' }).because).toBe('There are no code reviews to go on.');
    expect(sure({ items: 12, noun: 'code review' }).because).toContain('12 code reviews to go on');
  });

  it('caps the level when the answer names items its tools never returned: Medium for one, Low for more or for half of them', () => {
    const one = sure({ unverified: { count: 1, of: 10 } });
    expect(one.level).toBe('medium');
    expect(one.because).toBe('It names 1 item its tools never returned.');
    expect(sure({ unverified: { count: 2, of: 10 } }).level).toBe('low');
    expect(sure({ unverified: { count: 1, of: 2 } }).level).toBe('low');
    expect(sure({ unverified: { count: 0, of: 10 } }).level).toBe('high');
    expect(sure({ unverified: null }).level).toBe('high');
  });

  it('is Low when a read failed, and says which, leaving them out', () => {
    const s = sure({ failed: ['code reviews', 'builds'] });
    expect(s.level).toBe('low');
    expect(s.because).toBe('Code reviews and builds could not be read, so the answer leaves them out.');
    expect(sure({ failed: ['builds'] }).because).toContain('so the answer leaves it out');
  });

  it('takes the worst of the checks that slipped, and says each one', () => {
    const s = sure({ ageHours: 30, lacking: { what: 'no estimate', count: 5, of: 10 } });
    expect(s.level).toBe('medium');
    expect(s.because).toBe('The data was read 30 hours ago; 5 of 10 items have no estimate.');
    expect(sure({ ageHours: 30, items: 1 }).level).toBe('low');
  });
});

describe('the age of the data', () => {
  it('is hours between when it was read and when it is looked at, never negative', () => {
    expect(ageHoursOf('2026-10-01T00:00:00Z', '2026-10-01T02:30:00Z')).toBe(2.5);
    expect(ageHoursOf('2026-10-02T00:00:00Z', '2026-10-01T00:00:00Z')).toBe(0);
  });

  it('counts a time it cannot read as fresh, not as a guess at old', () => {
    expect(ageHoursOf('not a time', '2026-10-01T00:00:00Z')).toBe(0);
  });

  it('reads in the unit a person thinks in', () => {
    expect([0, 0.5, 2, 47, 49, 100].map(ago)).toEqual(['just now', '30 minutes ago', '2 hours ago', '47 hours ago', '2 days ago', '4 days ago']);
  });
});
