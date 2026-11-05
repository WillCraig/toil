/**
 * Possible duplicates of a work item, among the items of the toil project on
 * screen: the scorer `toil util owi similar` runs (src/core/owi/similar.ts),
 * imported as it is, so the page and the command give the same scores and
 * the same reasons for the same items. Lexical, not semantic, and every match
 * carries the words and fields that drove it (principle 4). The index is
 * built once per toil project load and asked once per item page. Two tickets for
 * one problem is a coordination failure; three is a working group.
 */

import { SimilarityIndex, type SimilarMatch } from '../../../src/core/owi/similar.ts';
import type { WorkItem } from '../toil.ts';

/** The most possible duplicates an item page lists. */
export const DUPLICATE_LIMIT = 5;

const indexes = new WeakMap<readonly WorkItem[], SimilarityIndex>();

/** The items in `items` likeliest to duplicate the one with this id, best first, at the scorer's default threshold. */
export function possibleDuplicates(items: readonly WorkItem[], id: string): SimilarMatch[] {
  let index = indexes.get(items);
  if (!index) indexes.set(items, (index = new SimilarityIndex(items)));
  return index.item(id, { limit: DUPLICATE_LIMIT })?.matches ?? [];
}
