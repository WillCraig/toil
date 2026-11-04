/**
 * How one person likes the briefing laid out (#494): which reasons show,
 * whether the first opens, whether the numbers start open, whether an item
 * opens in its drawer or on its page, whether Analyze runs after each
 * sync, and whether the Summary tab's full briefing is open. Kept in this
 * browser only: they're conveniences for the person at the screen, never what Analyze looks for (that's the dossier's, in its
 * file) and never shared. Storage that's blocked or full leaves the
 * defaults, quietly, since nothing here is worth an error. Personal
 * preferences, filed in the one cabinet nobody else has a key to.
 */

import { useSyncExternalStore } from 'react';

export interface BriefingPrefs {
  /** Open the first reason. */
  firstOpen: boolean;
  /** Start with the numbers open. */
  numbersOpen: boolean;
  /** Lens ids whose reasons are hidden; their items still count. */
  hidden: string[];
  /** Where an item opens from the briefing. */
  opensIn: 'drawer' | 'page';
  /** Run Analyze when a sync finishes, which uses the agent's usage. */
  afterSync: boolean;
  /** Whether the Summary tab's full briefing (the headline, the reasons, the numbers, Customize) is open (#552). */
  fullOpen: boolean;
}

export const DEFAULT_PREFS: BriefingPrefs = { firstOpen: true, numbersOpen: false, hidden: [], opensIn: 'drawer', afterSync: false, fullOpen: false };

const KEY = 'toil-ui.briefing';
const listeners = new Set<() => void>();
let cached: { raw: string | null; prefs: BriefingPrefs } | null = null;

const stored = (): string | null => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

/** The stored preferences, read again only when what's stored changed, so a view gets the same object until then. */
function read(): BriefingPrefs {
  const raw = stored();
  if (cached && cached.raw === raw) return cached.prefs;
  let parsed: Partial<BriefingPrefs> = {};
  try {
    parsed = JSON.parse(raw ?? '{}') as Partial<BriefingPrefs>;
  } catch {
    // Unreadable: the defaults.
  }
  const prefs: BriefingPrefs = {
    firstOpen: typeof parsed.firstOpen === 'boolean' ? parsed.firstOpen : DEFAULT_PREFS.firstOpen,
    numbersOpen: typeof parsed.numbersOpen === 'boolean' ? parsed.numbersOpen : DEFAULT_PREFS.numbersOpen,
    hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter((h): h is string => typeof h === 'string') : [],
    opensIn: parsed.opensIn === 'page' ? 'page' : 'drawer',
    afterSync: parsed.afterSync === true,
    fullOpen: parsed.fullOpen === true,
  };
  cached = { raw, prefs };
  return prefs;
}

/** Changes some preferences, keeps them, and tells every view that reads them. */
export function setPrefs(change: Partial<BriefingPrefs>): void {
  const prefs = { ...read(), ...change };
  const raw = JSON.stringify(prefs);
  try {
    localStorage.setItem(KEY, raw);
  } catch {
    // Blocked or full storage: the change lasts for this page only.
  }
  cached = { raw: stored() === raw ? raw : stored(), prefs };
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The person's briefing preferences, read live. */
export const useBriefingPrefs = (): BriefingPrefs => useSyncExternalStore(subscribe, read, () => DEFAULT_PREFS);
