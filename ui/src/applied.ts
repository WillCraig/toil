/**
 * The changes Toil UI applied to a tracker (#657, round 4), so the header's
 * line about the data never says it was read "without changing anything"
 * after a person pressed Apply. Each change is kept once by a key (an
 * assignment's proposal, a board move) with when toil reported it applied;
 * the header counts those after the data it shows was read. Kept outside
 * React, because the App remounts after every sync and this mustn't, and
 * seeded from the assignments the server holds, so a reload still knows.
 * Nothing here is sent anywhere; it is a tally, like the clipboard on the
 * door that says who last signed the fire extinguisher.
 */

import { useSyncExternalStore } from 'react';

const applied = new Map<string, string>();
const listeners = new Set<() => void>();

/** Records one change toil applied, at the time toil said; the same key twice is one change. */
export function noteApplied(key: string, at: string) {
  if (applied.get(key) === at || Number.isNaN(Date.parse(at))) return;
  applied.set(key, at);
  for (const l of listeners) l();
}

/** How many changes were applied after `since` (the moment the data on screen was read). */
export function appliedSince(since: string): number {
  const from = Date.parse(since);
  let n = 0;
  for (const at of applied.values()) if (Date.parse(at) > from) n++;
  return n;
}

/** Forgets every change: for the tests. */
export function resetApplied() {
  applied.clear();
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));

/** The count of changes applied since the data was read, kept current as more are applied. */
export const useAppliedSince = (since: string) => useSyncExternalStore(subscribe, () => appliedSince(since), () => appliedSince(since));
