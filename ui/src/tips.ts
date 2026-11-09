/**
 * Toil tips (#419): one line about toil or Toil UI on every loading screen,
 * the way a game's loading screen teaches while you wait. Every tip is a
 * real, checked fact in plain words, and carries a Read more link from the
 * help topics (src/help.ts), whose test resolves each link against the docs'
 * own headings, so a tip can't point at a section that isn't there.
 *
 * A theme frames a tip (its label, "Foreman's note", "Almanac entry"), never
 * words it: the text below reads the same in every theme, as a notification
 * does. The order is shuffled once per browser session, and a tip seen this
 * session isn't shown again until every one has been. Tips can be switched
 * off under Settings, Appearance, and the choice is kept in this browser only.
 * The induction pack, read one line at a time while the kettle boils.
 */

import { useSyncExternalStore } from 'react';
import type { HelpTopicId } from './help.ts';

export interface Tip {
  id: string;
  /** One sentence or two, plain text: no markup, no theme words. */
  text: string;
  /** The help topic its Read more link opens. */
  topic: HelpTopicId;
}

export const TIPS: readonly Tip[] = [
  { id: 'board-m', text: 'Press M on a focused board card to open its menu: propose a move, or assign it to an agent.', topic: 'assignments' },
  { id: 'board-drag', text: 'Drag a board card to another column to propose the move. Nothing changes in the tracker until you approve it.', topic: 'board' },
  { id: 'onboard', text: 'Joining a repository that already has a Toil project? Set up this repo, under Settings, Toil projects, checks the connections it needs.', topic: 'repo-setup' },
  { id: 'analyses', text: "Every Analyze is kept in the Toil project's Analyses tab, with what changed since the one before.", topic: 'analyses' },
  { id: 'notify', text: 'Notifications come only when an agent changes state. Pick which states, quiet hours and only your own under Settings, General.', topic: 'notifications' },
  { id: 'write-gate', text: "Toil UI only reads. A change needs writes allowed on the connection, and your approval each time.", topic: 'proposal' },
  { id: 'theme-depth', text: 'Themed wording and Themed agent voice, under Settings, Appearance, set how far a theme goes. Buttons, ids and errors never change.', topic: 'themed-wording' },
  { id: 'theme-motion', text: "Motion, under Settings, Appearance, plays a theme's animations in full, subtly, or not at all.", topic: 'theme-motion' },
  { id: 'audit', text: "Settings, Usage sums up how Toil is used, leaving out what Toil UI asks for in the background.", topic: 'audit' },
  { id: 'sync', text: 'After the first sync, a sync asks Jira, Azure DevOps and GitHub issues only for what changed since the last good one.', topic: 'sync' },
  { id: 'last-good', text: 'A source that fails to sync keeps its last good copy, marked stale, and the Sync panel shows toil\'s message and fix.', topic: 'sync' },
  { id: 'standup', text: "The stand-up, on the Summary and under the Worklog tab, folds the worklog's days into done, in progress and blocked, by code alone.", topic: 'standup' },
  { id: 'readiness', text: "The Board's Readiness view says which items are ready to start, worked out from the cache with no model call.", topic: 'readiness' },
  { id: 'wipe', text: 'Settings, General, Advanced can wipe everything Toil UI synced to this computer. Your trackers are never touched.', topic: 'sync' },
  { id: 'palette', text: 'Ctrl+K (Cmd+K on a Mac) opens the command palette: jump to a Toil project, a tab, an item or a setting, or run Sync, Analyze and Ask.', topic: 'palette' },
  { id: 'help', text: 'Help in the header opens the docs section for the view in front of you, and every (i) has a Read more link.', topic: 'toilProjects' },
];

const ORDER_KEY = 'toil-ui.tips.order';
const SEEN_KEY = 'toil-ui.tips.seen';

const session = {
  get(key: string): string | null {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      // Not kept: tips still rotate for this page, and may repeat sooner after a reload.
    }
  },
};

/** A shuffled order of the tips' ids, from `rand`. */
export function shuffled(ids: readonly string[], rand: () => number = Math.random): string[] {
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * The next tip to show: the first in this session's order not yet seen, and
 * once every one has been seen, the round starts again from the top. Pure
 * apart from `seen`, which it returns updated, so a test can drive it.
 */
export function nextTip(order: readonly string[], seen: readonly string[], tips: readonly Tip[] = TIPS): { tip: Tip; seen: string[] } {
  const known = order.filter((id) => tips.some((t) => t.id === id));
  // Any tip added since the order was made goes at the end, so it still comes round.
  const full = [...known, ...tips.map((t) => t.id).filter((id) => !known.includes(id))];
  const fresh = seen.filter((id) => full.includes(id));
  const round = fresh.length >= full.length ? [] : fresh;
  const id = full.find((x) => !round.includes(x))!;
  return { tip: tips.find((t) => t.id === id)!, seen: [...round, id] };
}

/** This session's order, made once. */
function order(): string[] {
  try {
    const v = JSON.parse(session.get(ORDER_KEY) ?? 'null') as unknown;
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  } catch {
    // Unreadable: made again below.
  }
  const made = shuffled(TIPS.map((t) => t.id));
  session.set(ORDER_KEY, JSON.stringify(made));
  return made;
}

let seenNow: string[] | null = null;
function seen(): string[] {
  if (seenNow) return seenNow;
  try {
    const v = JSON.parse(session.get(SEEN_KEY) ?? '[]') as unknown;
    seenNow = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    seenNow = [];
  }
  return seenNow;
}

/** Takes the next tip and marks it seen for this session. */
export function takeTip(): Tip {
  const { tip, seen: next } = nextTip(order(), seen());
  seenNow = next;
  session.set(SEEN_KEY, JSON.stringify(next));
  return tip;
}

/** Forgets the session's order and what was seen. For tests. */
export function resetTips() {
  seenNow = null;
  try {
    sessionStorage.removeItem(ORDER_KEY);
    sessionStorage.removeItem(SEEN_KEY);
  } catch {
    // Nothing kept, nothing to forget.
  }
}

// The setting: tips on (the default) or off, in this browser.

const ON_KEY = 'toil-ui.tips';
const listeners = new Set<() => void>();
let on: boolean | null = null;

function rememberedOn(): boolean {
  try {
    return localStorage.getItem(ON_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setTipsOn(next: boolean) {
  on = next;
  try {
    localStorage.setItem(ON_KEY, next ? 'on' : 'off');
  } catch {
    // Not remembered; it still holds for this visit.
  }
  for (const l of listeners) l();
}

/** Forgets the cached choice. For tests. */
export function resetTipsChoice() {
  on = null;
}

export function useTipsOn(): [boolean, (on: boolean) => void] {
  const value = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (on ??= rememberedOn()),
    () => true,
  );
  return [value, setTipsOn];
}
