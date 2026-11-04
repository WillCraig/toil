/**
 * The status word (#552): On track, At risk, Behind, or No sprint, chosen by
 * one rule that every screen can share, so two pages never call the same
 * sprint by different names. The briefing's own sprint lens only says "at
 * risk or not"; people ask for three words, so this draws the lines at all of
 * the points left landing, and at three quarters of them, at the pace so far.
 * The word is an estimate and every screen that shows it says so. A traffic
 * light, with the committee that sets the thresholds shown in the open. A
 * sprint with no points at all gets no word from here: the Summary says so.
 */

export type Status = 'on-track' | 'at-risk' | 'behind' | 'none';

/** The share of the points left that must land, at the pace so far, for the sprint to be At risk rather than Behind. */
export const AT_RISK_FROM = 0.75;

export const STATUS_WORD: Record<Exclude<Status, 'none'>, string> = { 'on-track': 'On track', 'at-risk': 'At risk', behind: 'Behind' };

/** What the rule reads: the sprint's points left and how many would land by the end at the pace so far (the code's `projected`, which is null until a quarter of the sprint has gone). */
export interface PaceFacts {
  left: number;
  projected: number | null;
}

export interface StatusResult {
  status: Status;
  /** "Behind", or "No sprint". */
  word: string;
  /** The share of the points left that would land, 0 to 1; null when there is nothing to measure. */
  landing: number | null;
  /** A sprint with points left but too early in it to read a pace. */
  early: boolean;
}

/**
 * On track: the points left fit at the pace so far (`projected` is rounded to a
 * tenth, so within 0.05 of all of them counts as all of them). At risk: at
 * least three quarters of them would land, or a red reason (failing checks,
 * blocked work) is holding work up even though the pace fits. Behind: fewer
 * than three quarters. No pace yet means On track unless a red reason says
 * otherwise, and says it is too early; nothing left means On track.
 */
export function statusOf(input: { sprint: PaceFacts | null; red: boolean }): StatusResult {
  const s = input.sprint;
  if (!s) return { status: 'none', word: 'No sprint', landing: null, early: false };
  const done = (status: Exclude<Status, 'none'>, landing: number | null, early = false): StatusResult => ({ status, word: STATUS_WORD[status], landing, early });
  if (s.left <= 0) return done('on-track', 1);
  if (s.projected === null) return done(input.red ? 'at-risk' : 'on-track', null, true);
  const landing = s.projected / s.left;
  if (s.projected + 0.05 >= s.left) return done(input.red ? 'at-risk' : 'on-track', landing);
  return done(landing >= AT_RISK_FROM ? 'at-risk' : 'behind', landing);
}
