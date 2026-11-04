/**
 * "How sure is this?" under an answer (#552), worked out by code and never by
 * the model. Three plain checks over what the answer rested on: did every read
 * work, how old is the data, and how many of the items it used lack something
 * the question needs. High is all three clear, Medium is one that slipped,
 * Low is a read that failed, data over three days old, or too few items to go
 * on. The result is a word and one sentence that says why, so the level never
 * has to be taken on trust. A confidence score that shows its working, which
 * is more than the average forecast does.
 *
 * Pure: the same inputs give the same sentence, so the boundaries are tested
 * without a page.
 */

export type Level = 'high' | 'medium' | 'low';

export const LEVEL_WORD: Record<Level, string> = { high: 'High', medium: 'Medium', low: 'Low' };

const HOUR = 3_600_000;

/** From this many hours the data is no longer fresh: High needs it under this. */
export const FRESH_HOURS = 24;
/** Past this many hours (three days) the data is old, and the level is Low. */
export const OLD_HOURS = 72;
/** More than this share of the items used lacking what the question needs drops High to Medium. */
export const LACK_SHARE = 0.1;
/** Fewer items than this is too thin a base for anything above Low. */
export const MIN_ITEMS = 3;

export interface SureInput {
  /** The panels whose read failed, in words ("code reviews"), once each. */
  failed: string[];
  /** How long before the person looked the data was read, in hours. */
  ageHours: number;
  /** How many items there are to go on. */
  items: number;
  /** True when `failed` was checked against only the reads this answer depends on, so the all-clear says so rather than vouch for every read. */
  scoped?: boolean;
  /** Items the answer names that its tools never returned, out of the items it cites: one caps the level at Medium, more than one or half or more of them, at Low. */
  unverified?: { count: number; of: number } | null;
  /** What the items are called, when they aren't items ("pull request" for a question about reviews). */
  noun?: string;
  /** Items that lack something this question needs: what they lack, how many, out of how many. */
  lacking?: { what: string; count: number; of: number } | null;
}

export interface Sure {
  level: Level;
  word: string;
  /** The one sentence of reason: each check that slipped, or that all three held. */
  because: string;
  /** Which checks moved the level, for a test or a reader to see why. */
  reasons: string[];
}

/** "2 hours ago", "35 minutes ago", "3 days ago": the age in the unit a person thinks in. */
export function ago(ageHours: number): string {
  const minutes = Math.round(Math.max(0, ageHours) * 60);
  if (minutes < 2) return 'just now';
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(Math.max(0, ageHours));
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** Hours between when the data was read and when it is looked at; a time that can't be read counts as fresh, never as a guess at old. */
export function ageHoursOf(readAt: string, viewedAt: string): number {
  const ms = Date.parse(viewedAt) - Date.parse(readAt);
  return Number.isFinite(ms) ? Math.max(0, ms / HOUR) : 0;
}

const list = (words: string[]) => (words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);
const order: Level[] = ['high', 'medium', 'low'];
const worse = (a: Level, b: Level): Level => (order.indexOf(a) >= order.indexOf(b) ? a : b);
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

export function howSure(c: SureInput): Sure {
  let level: Level = 'high';
  const reasons: string[] = [];
  const said: string[] = [];
  const noun = c.noun ?? 'item';

  if (c.failed.length) {
    level = 'low';
    reasons.push('a read failed');
    said.push(`${list(c.failed)} could not be read, so the answer leaves ${c.failed.length === 1 ? 'it' : 'them'} out`);
  }
  const un = c.unverified;
  if (un && un.count > 0) {
    level = worse(level, un.count > 1 || un.count / Math.max(un.of, un.count) >= 0.5 ? 'low' : 'medium');
    reasons.push('names items its tools never returned');
    said.push(`it names ${plural(un.count, 'item')} its tools never returned`);
  }
  if (c.ageHours > OLD_HOURS) {
    level = worse(level, 'low');
    reasons.push('the data is old');
    said.push(`the data was read ${ago(c.ageHours)}`);
  } else if (c.ageHours >= FRESH_HOURS) {
    level = worse(level, 'medium');
    reasons.push('the data is over a day old');
    said.push(`the data was read ${ago(c.ageHours)}`);
  }
  if (c.items < MIN_ITEMS) {
    level = worse(level, 'low');
    reasons.push('too few items');
    said.push(c.items === 0 ? `there are no ${noun}s to go on` : `there ${c.items === 1 ? 'is' : 'are'} only ${plural(c.items, noun)} to go on`);
  }
  if (c.lacking && c.lacking.of > 0 && c.lacking.count / c.lacking.of > LACK_SHARE) {
    level = worse(level, 'medium');
    reasons.push(`${c.lacking.count} of ${c.lacking.of} lack ${c.lacking.what}`);
    said.push(`${c.lacking.count} of ${c.lacking.of} items have ${c.lacking.what}`);
  }

  const because = said.length
    ? `${said.join('; ').replace(/^./, (x) => x.toUpperCase())}.`
    : `${c.scoped ? 'Every read this answer depends on worked' : 'Every saved read worked'}, the data was read ${ago(c.ageHours)}, and there are ${plural(c.items, noun)} to go on.`;
  return { level, word: LEVEL_WORD[level], because, reasons };
}
