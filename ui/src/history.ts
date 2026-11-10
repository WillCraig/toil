/**
 * The notification history behind the header's bell (#417): the last 50
 * things worth telling someone, kept in this browser like the other
 * per-person settings. Agent state changes come from the notices #306 makes
 * (needs you, done, failed, a session gone stale), and
 * each sync's result from the Sync panel. Each entry links to what it's about.
 * A toast follows #306's rules unchanged; the bell is where one dismissed is
 * found again. Theme moments (#419) play from the worklog's fold, never from
 * here. "Mark all read" sets the count to nothing and keeps the entries.
 * Kept in a store outside React, because the App remounts after every sync
 * and the history mustn't. Filed, numbered, and kept for the statutory 50.
 */

/** How many entries are kept: the oldest goes when the 51st arrives. */
export const MAX_HISTORY = 50;
export const HISTORY_KEY = 'toil-ui.notify.history';

export type HistoryKind = 'needs-you' | 'done' | 'failed' | 'stale' | 'sync' | 'sync-failed';

export interface HistoryEntry {
  /** Rises with every entry, so read and unread are one comparison. */
  seq: number;
  /**
   * What it is about, the same in every tab: each open tab hears the same server event and sees the same sync end,
   * and the history they share keeps one entry for it.
   */
  id: string;
  /** When it happened, as an ISO time. */
  at: string;
  kind: HistoryKind;
  title: string;
  /** One line on what it's about. */
  line: string;
  /** Where it links: an assignment, a toil project, or the Toil projects view. */
  href: string;
}

export interface History {
  entries: HistoryEntry[];
  /** The highest seq read; every entry above it is unread. */
  read: number;
}

const EMPTY: History = { entries: [], read: 0 };
const KINDS = new Set<HistoryKind>(['needs-you', 'done', 'failed', 'stale', 'sync', 'sync-failed']);

/** Reads the kept history, dropping any entry that doesn't parse, so a damaged one never stops the page. */
export function parseHistory(text: string | null): History {
  if (!text) return EMPTY;
  try {
    const v = JSON.parse(text) as Partial<History> | null;
    // Usage caps are gone; a bell entry saved with their kind is read as the failure it was.
    const entries = (Array.isArray(v?.entries) ? v.entries : []).map((e) => ((e as { kind?: unknown } | null)?.kind === 'cap' ? { ...e, kind: 'failed' as const } : e)).filter(
      (e): e is HistoryEntry => !!e && typeof e === 'object' && Number.isInteger(e.seq) && typeof e.id === 'string' && typeof e.at === 'string' && KINDS.has(e.kind) && typeof e.title === 'string' && typeof e.line === 'string' && typeof e.href === 'string' && /^#\//.test(e.href),
    );
    return { entries: entries.slice(0, MAX_HISTORY), read: typeof v?.read === 'number' ? v.read : 0 };
  } catch {
    return EMPTY;
  }
}

/** Adds entries, newest first, keeping the last MAX_HISTORY; one whose id is already kept (another tab added it) is skipped. */
export function added(h: History, add: ReadonlyArray<Omit<HistoryEntry, 'seq'>>): History {
  let seq = Math.max(h.read, ...h.entries.map((e) => e.seq), 0);
  const kept = new Set(h.entries.map((e) => e.id));
  const fresh: HistoryEntry[] = [];
  for (const e of add) {
    if (kept.has(e.id)) continue;
    kept.add(e.id);
    fresh.unshift({ ...e, seq: ++seq });
  }
  if (!fresh.length) return h;
  return { ...h, entries: [...fresh, ...h.entries].slice(0, MAX_HISTORY) };
}

export const unread = (h: History): number => h.entries.filter((e) => e.seq > h.read).length;
export const allRead = (h: History): History => ({ ...h, read: Math.max(h.read, ...h.entries.map((e) => e.seq), 0) });

/** The store the bell reads and the notices and the Sync panel write. */
export interface HistoryStore {
  get(): History;
  add(entries: ReadonlyArray<Omit<HistoryEntry, 'seq'>>): void;
  markAllRead(): void;
  subscribe(listener: () => void): () => void;
}

/** A store kept in localStorage; a browser that keeps nothing still has the history for this page. */
export function browserHistory(key = HISTORY_KEY): HistoryStore {
  // The kept text and what it parsed to: the same text gives the same object, which React's store hook needs.
  let raw: string | null | undefined;
  let state: History = EMPTY;
  // Where the browser keeps nothing, the history lives here for this page.
  let memory: string | null = null;
  const listeners = new Set<() => void>();
  const readRaw = () => {
    try {
      return localStorage.getItem(key);
    } catch {
      return memory;
    }
  };
  const load = (): History => {
    const now = readRaw();
    if (now !== raw) {
      raw = now;
      state = parseHistory(now);
    }
    return state;
  };
  const save = (next: History) => {
    const text = JSON.stringify(next);
    memory = text;
    try {
      localStorage.setItem(key, text);
    } catch {
      // Kept for this page only.
    }
    raw = text;
    state = next;
    for (const l of listeners) l();
  };
  // Another tab of Toil UI added an entry or marked them read.
  if (typeof window !== 'undefined') {
    // A storage event's key is the stored item's name, not a key pressed.
    window.addEventListener('storage', (change) => {
      if (change.key === key || change.key === null) for (const l of listeners) l();
    });
  }
  return {
    get: load,
    add: (entries) => {
      const now = load();
      const next = added(now, entries);
      if (next !== now) save(next);
    },
    markAllRead: () => save(allRead(load())),
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

/** The one history for this page. */
export const history: HistoryStore = browserHistory();
