/**
 * Possible duplicates of a work item, among the items of the toil project on
 * screen: the scorer `toil util owi similar` runs (src/core/owi/similar.ts),
 * imported as it is, so the page and the command give the same scores and
 * the same reasons for the same items. Lexical, not semantic, and every match
 * carries the words and fields that drove it (principle 4). The index is
 * built once per toil project load and asked once per item page. Two tickets for
 * one problem is a coordination failure; three is a working group.
 */

import { SimilarityIndex, type SimilarMatch, type SimilarWhy } from '../../../src/core/owi/similar.ts';
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

/** A label the sandboxes' seeding puts on made-up items (`toil-seed`, `seed:<id>`): bookkeeping, never a reason two items are alike. */
export const isSeedMark = (label: string) => label === 'toil-seed' || label.startsWith('seed:');

/**
 * Why a match scored as it did, in words a person reads behind its "Why?":
 * the shared words, how alike the titles are, the labels, parent and link,
 * from the scorer's own fields. Seed marks are left out, since every seeded
 * item carries them. `name` turns an OWI id into what a person reads.
 */
export function duplicateWhy(why: Omit<SimilarWhy, 'summary' | 'parts'>, name: (id: string) => string = (id) => id): string {
  const said: string[] = [];
  if (why.titleTerms.length) said.push(`Both titles say ${why.titleTerms.join(', ')}.`);
  if (why.bodyTerms.length) said.push(`Both descriptions mention ${why.bodyTerms.join(', ')}.`);
  if (why.trigram > 0) said.push(`The titles are ${Math.round(why.trigram * 100)}% alike letter for letter.`);
  const labels = why.labels.filter((l) => !isSeedMark(l));
  if (labels.length) said.push(`Both are labelled ${labels.join(', ')}.`);
  if (why.parent) said.push(`They share the parent ${name(why.parent)}.`);
  if (why.link) said.push(`They are linked (${why.link.name}).`);
  if (why.titleOnly) said.push('One has no description, so only the titles were compared.');
  return said.length ? said.join(' ') : 'Nothing in common beyond the score.';
}
