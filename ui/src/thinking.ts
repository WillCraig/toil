/**
 * The "thinking" indicator's words (#561): while an AI agent answers, the Ask
 * bar shows a small moving icon and a phrase in the theme's voice that changes
 * every few seconds. The phrases are flavour. What is true (how long it has
 * been, which tool the agent is reading) is always said plainly beside them,
 * and the phrase gives way entirely once the agent names a tool or starts
 * writing (`statusLine` in components/ask.tsx), because from then on we know
 * what it is doing and a joke about turnips would be a claim of its own
 * (principle 4).
 *
 * Every function here is pure and takes the elapsed time as an argument, so
 * the rotation is the same on every run and testable without a clock. There is
 * no randomness: a phrase is chosen by how many whole intervals have passed.
 * Rotating the phrases is the only form of progress reporting permitted
 * without a progress bar, a sponsor or a steering committee.
 */

/** How long one phrase stays, and so the most often the live region announces a change. */
export const THINKING_PHRASE_MS = 6000;

/** Plain's phrases, and the ones every theme reads while themed wording is off. */
export const STANDARD_THINKING: readonly string[] = ['Reading your data…', 'Working on it…', 'Still working on it…'];

/** The phrases to rotate: the theme's own while themed wording is on and it has some, else the standard ones. */
export function thinkingPhrases(theme: readonly string[] | undefined, wording: boolean): readonly string[] {
  return wording && theme && theme.length > 0 ? theme : STANDARD_THINKING;
}

/** Which phrase has been up for `elapsedMs`: one per interval, in order, starting over after the last. A negative time counts as none. */
export function thinkingPhrase(phrases: readonly string[], elapsedMs: number): string {
  if (phrases.length === 0) return '';
  const step = Math.floor(Math.max(0, elapsedMs) / THINKING_PHRASE_MS);
  return phrases[step % phrases.length]!;
}
