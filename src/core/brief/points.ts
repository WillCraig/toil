/**
 * Points over a set of items (#652). An item with no estimate in points has
 * no points toil could read: the tracker may hold none, or the toil project
 * may not name the field they live in. Either way it is unknown, not zero
 * (principle 12), so a total says how many items it could not count, and a
 * set where nothing was read has no total at all. A real estimate of 0 is
 * read, and counts as 0. The ledger balances; it just lists what it never saw.
 */

import type { WorkItem } from '../owi/types.js';

/** An item's points, or null when it has no estimate in points. */
export const pointsOf = (item: WorkItem | undefined): number | null => (item?.estimate?.unit === 'points' ? item.estimate.value : null);

export interface PointsSum {
  /** The points of the items that have them; null when there are items and none has points. An empty set is a real 0. */
  points: number | null;
  /** Items with no points read, left out of `points`. */
  unestimated: number;
}

export function sumPoints(items: readonly WorkItem[]): PointsSum {
  let points = 0;
  let read = 0;
  for (const i of items) {
    const p = pointsOf(i);
    if (p === null) continue;
    points += p;
    read++;
  }
  return { points: read === 0 && items.length > 0 ? null : points, unestimated: items.length - read };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** "2 items with no points read": what a total left out, said so a reader knows what the number counts. */
export const unreadItems = (n: number) => `${n} ${n === 1 ? 'item' : 'items'} with no points read`;

/** "5 points", or "5 points, and 2 items with no points read" when some have none; null when none were read, so the sentence leaves the figure out. */
export function pointsPhrase(s: PointsSum): string | null {
  if (s.points === null) return null;
  const n = round1(s.points);
  const total = `${n} ${n === 1 ? 'point' : 'points'}`;
  return s.unestimated ? `${total}, and ${unreadItems(s.unestimated)}` : total;
}
