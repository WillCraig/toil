/**
 * "Sync and check again" (#657, round 4): after a fix's proposal is applied,
 * whether the item now meets the rules the fix was for, read from a fresh
 * sync and toil's own `standards check`, never assumed from the Apply having
 * worked (principle 12). Toil UI has no read of one item that refreshes the
 * cache, so the press syncs the Toil project (incremental, so only what
 * changed is read again) and the rules are checked on what that sync read.
 * The App remounts after a sync, so the press is remembered here, outside
 * React, by assignment and by the moment the data on screen was read. A
 * second inspection, booked for after the first one's paperwork clears.
 */

import type { Readiness, RulesReading } from '../model/readiness.ts';
import type { AssignedRule } from './model.ts';

const asked = new Map<string, string>();

/** Remembers that a person asked to check an assignment's rules again, on data read at `at`. */
export const askRecheck = (id: string, at: string) => void asked.set(id, at);
/** When the data on screen was read as the person asked, or undefined when they haven't. */
export const askedAt = (id: string): string | undefined => asked.get(id);
/** Forgets every press: for the tests. */
export const resetRechecks = () => (asked.clear(), shown.clear());

const shown = new Set<string>();
/**
 * True the first time a press's result is on screen, false after: the page
 * brings the result into view once, beside the button, and leaves the reader's
 * scrolling alone from then on.
 */
export function firstShowing(id: string, at: string): boolean {
  const key = `${id}@${at}`;
  if (shown.has(key)) return false;
  shown.add(key);
  return true;
}

/** One rule on the new reading: passes, still missing, not checked, or no longer one that applies. */
export interface RuleAgain {
  name: string;
  state: 'pass' | 'missing' | 'unchecked' | 'gone';
  /** toil's reason, where it gave one. */
  reason: string;
}

/**
 * Each rule the fix was for, on this reading; null while the reading isn't
 * there yet, so nothing is said until something was read. A failed reading is
 * said by the caller in toil's words, not here.
 */
export function rulesAgain(rules: readonly Pick<AssignedRule, 'standard' | 'rule' | 'name'>[], reading: RulesReading | undefined, item: string): RuleAgain[] | null {
  if (!reading || reading.state !== 'read') return null;
  const results = reading.byItem.get(item) ?? [];
  return rules.map((r) => {
    const hit = results.find((x) => x.standard === r.standard && x.rule === r.rule);
    if (!hit) return { name: r.name, state: 'gone', reason: '' };
    if (hit.state === 'pass') return { name: hit.name, state: 'pass', reason: hit.reason };
    if (hit.state === 'skipped') return { name: hit.name, state: 'unchecked', reason: hit.reason };
    return { name: hit.name, state: 'missing', reason: hit.reason };
  });
}

/** One rule's line: "Acceptance criteria as Given/When/Then: now passes", or what is still missing. */
export function againText(r: RuleAgain): string {
  const why = r.reason.trim().replace(/\.$/, '');
  if (r.state === 'pass') return `${r.name}: now passes`;
  if (r.state === 'missing') return `${r.name}: still missing${why ? `: ${why}` : ''}`;
  if (r.state === 'unchecked') return `${r.name}: not checked${why ? `: ${why}` : ''}`;
  return `${r.name}: no longer applies to this item`;
}

/**
 * The line beside "Sync and check again" when every rule now passes (#657,
 * round 5), or null when one doesn't, so the per-rule lines say what is still
 * missing or not checked. The second sentence is the readiness verdict on the
 * same reading: "ready to start" only when it is Ready, otherwise what it is,
 * and nothing when the item isn't in the reading.
 */
export function passedText(again: readonly RuleAgain[], key: string, after: Pick<Readiness, 'verdict' | 'why'> | null): string | null {
  if (!again.length || again.some((r) => r.state !== 'pass')) return null;
  const names = again.map((r) => r.name);
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const first = `\u2713 ${list} now ${names.length === 1 ? 'passes' : 'pass'}.`;
  if (!after) return first;
  if (after.verdict === 'ready') return `${first} ${key} is ready to start.`;
  const missing = after.why.map((r) => r.label);
  if (after.verdict === 'unread') return `${first} ${key} passes the other checks, but its ticket rules haven't been read yet, so it isn't known to be ready to start.`;
  if (after.verdict === 'blocked') return `${first} ${key} is blocked, so it isn't ready to start${missing.length ? `: ${missing.join(', ')}` : ''}.`;
  return `${first} ${key} still needs more detail before it is ready to start${missing.length ? `: ${missing.join(', ')}` : ''}.`;
}
