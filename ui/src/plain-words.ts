/**
 * Plain words: toil's engineer jargon, said as everyday words, with toil's own
 * term one hover away. It is always on and has no switch (the maintainer's
 * call, 2026-11-05, after #552 made it the default).
 *
 * The design principle (CLAUDE.md, principle 11): anything a person reads to
 * ACT (a menu item, a tab, a button, a field's label, a heading, an error and
 * its fix) is plain English, identical in every theme, preferring everyday words
 * to jargon (pull request: code review, agent: AI agent). A theme speaks only
 * where nothing depends on the words: explanations and ledes, loading and
 * progress text, empty-state sentences and its moments (src/wording.ts).
 *
 * It renames control names (a tab, a button, a link) and the copy around
 * them, never a fact, a number, a command, an error or its fix: those read
 * the same everywhere, so what a person, a script or voice control looks for
 * is the one name on screen (WCAG 2.5.3). A name is swapped only at the place
 * that renders it, so its visible label and its accessible name are the same
 * words, and its `title` says what toil calls it.
 *
 * `usePlain()` and `pw(standard, plain)` stay as the call sites' helpers: `pw`
 * is the plain-words helper and returns the plain text. The standard text
 * beside it is the record of toil's own term, which the `title` names.
 */

import { plainify } from './plainify.ts';
import { wordFor, type WordKey } from './wording.ts';

export interface Plain {
  /** Always true: plain words have no switch. Kept so a call site can say which branch it is on. */
  on: true;
  /** The plain-words helper: returns the plain text. The standard text beside it names toil's own term. */
  pw: (standard: string, plain: string) => string;
  /** The hover that names what toil calls it. */
  title: (precise: string) => string | undefined;
  /** A sentence with its jargon swapped (plainify). */
  text: (standard: string) => string;
}

const PLAIN: Plain = {
  on: true,
  pw: (_standard, plain) => plain,
  title: (precise) => `In toil: ${precise}`,
  text: (standard) => plainify(standard),
};

export function usePlain(): Plain {
  return PLAIN;
}

/** Plain words are always on. For code outside a component (a test, the word lookup). */
export const plainOn = (): true => true;

export { plainify };

/**
 * The microcopy for a key (src/wording.ts), with its jargon swapped. A
 * functional key (a label a person acts on) is the plain text in every theme; a
 * flavour key is the theme's own while themed wording is on, else the plain text.
 */
export function wordsFor(lexicon: Partial<Record<WordKey, string>> | undefined, themed: boolean, key: WordKey, vars?: Record<string, string>): string {
  return plainify(wordFor(lexicon, themed, key, vars));
}
