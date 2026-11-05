import { setPlain } from '../src/plain-words.ts';

/**
 * Pins the page to toil's own terms. Plain words are the default (#552), and
 * most of these tests read the standard labels (Toil projects, Pull requests,
 * Agents), so a test that is about toil's words says so by calling this
 * first; test/novice-defaults.test.tsx holds the plain ones.
 */
export function standardWords(): void {
  setPlain(false);
}
