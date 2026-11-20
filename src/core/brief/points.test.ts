import { describe, expect, it } from 'vitest';
import type { WorkItem } from '../owi/types.js';
import { pointsOf, pointsPhrase, sumPoints } from './points.js';

const item = (id: string, estimate: WorkItem['estimate'] = null) => ({ id, estimate }) as WorkItem;
const pts = (value: number) => ({ value, unit: 'points' as const, field: 'Story Points' });

describe('points over items (#652: unknown is not zero)', () => {
  it('has no total when no item has points read', () => {
    const s = sumPoints([item('a'), item('b')]);
    expect(s).toEqual({ points: null, unestimated: 2 });
    expect(pointsPhrase(s)).toBeNull();
  });

  it('sums the items that have points and counts the ones that do not', () => {
    const s = sumPoints([item('a', pts(3)), item('b'), item('c', pts(2)), item('d', { value: 4, unit: 'hours', field: 'Original estimate' })]);
    expect(s).toEqual({ points: 5, unestimated: 2 });
    expect(pointsPhrase(s)).toBe('5 points, and 2 items with no points read');
  });

  it('keeps a real estimate of 0 as 0', () => {
    const s = sumPoints([item('a', pts(0)), item('b', pts(0))]);
    expect(s).toEqual({ points: 0, unestimated: 0 });
    expect(pointsPhrase(s)).toBe('0 points');
    expect(pointsOf(item('a', pts(0)))).toBe(0);
    expect(pointsOf(item('a'))).toBeNull();
  });

  it('reads an empty set as a real 0, since there was nothing to read', () => {
    expect(sumPoints([])).toEqual({ points: 0, unestimated: 0 });
  });

  it('says one point in the singular', () => {
    expect(pointsPhrase(sumPoints([item('a', pts(1))]))).toBe('1 point');
  });
});
