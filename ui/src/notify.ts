/**
 * Notifications on agent state changes (#306), the pure part: which changes
 * notify, how several within a few seconds become one notice, and the plain
 * words it says. A tool call, progress, or a state that didn't change never
 * notifies; neither does a change undone before the window closes. The
 * React side (components/notify.tsx) keeps the settings in this browser,
 * shows the notice in the page, and hands it to the browser's Notification
 * API only once a person has turned that on. Nothing leaves the machine.
 * An escalation policy with one rung, and the rung is a person.
 */

import { ADAPTER_NAME, type AssignAdapter, type AssignmentEvent, type AssignState } from './assign/model.ts';

/** What can notify: the Agents sidebar's end states and a session gone stale (#305). */
export type Notable = 'needs-you' | 'done' | 'failed' | 'stale';
export const NOTABLES: readonly Notable[] = ['needs-you', 'failed', 'done', 'stale'];
export const NOTABLE_LABEL: Record<Notable, string> = {
  'needs-you': 'Needs you',
  failed: 'Failed',
  done: 'Done',
  stale: 'Gone stale',
};

export interface NotifySettings {
  /** The browser's own notifications, on top of the notice in the page: off until a person turns them on. */
  browser: boolean;
  /** Which changes notify. */
  states: Record<Notable, boolean>;
  /** Hours with no notice at all, as local "HH:MM" times; the count still goes up. Null for none. */
  quiet: { from: string; to: string } | null;
  /** Only sessions this browser started: its chats, and the assignments assigned, started or renewed here. */
  mine: boolean;
}

export const DEFAULT_NOTIFY: NotifySettings = {
  browser: false,
  states: { 'needs-you': true, failed: true, done: false, stale: true },
  quiet: null,
  mine: false,
};

/** One change of one session's state: the session, the state it reached, and what a notice says about it. */
export interface Transition {
  /** The session: `assignment:<id>` or `chat:<id>`. */
  key: string;
  /** The state it reached, as the lane names it, or `stale`. */
  state: string;
  /** What it notifies as, or null for a change that never does (queued, working, a person's own Stop). */
  notable: Notable | null;
  /** Who: "Codex", "The chat". */
  agent: string;
  /** The item, where there is one: its id and title. */
  item: string | null;
  itemTitle: string | null;
  /** One line on why, in plain words: "asked a question", "3 proposals to review". */
  why: string;
  toilProject: string;
  /** Where the notice links: the assignment's page, or the toil project. */
  href: string;
  mine: boolean;
  /** The server event's sequence number, where it came from one: every tab hears the same event, so the bell's history can tell it's one (#417). */
  event?: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n === 1 ? 'a' : n} ${n === 1 ? one : many}`;

/**
 * What an assignment event means for a notification: null for an event that
 * isn't a change of state (a proposal applied, a renewal recorded) or that
 * repeats the state it was in. Every other change is a transition, notable
 * or not, so a change undone inside the window can cancel the one before it.
 */
export function transitionOf(e: AssignmentEvent, o: { mine: boolean; href: string }): Transition | null {
  if (e.kind !== 'state' || e.state === e.previous) return null;
  const agent = e.adapter ? ADAPTER_NAME[e.adapter as AssignAdapter] : 'An agent';
  const base = { key: `assignment:${e.id}`, event: e.seq, state: e.state, agent, item: e.item, itemTitle: e.itemTitle ?? null, toilProject: e.toilProject, href: o.href, mine: o.mine };
  return { ...base, ...notableOf(e.state, e) };
}

function notableOf(state: AssignState, e: Pick<AssignmentEvent, 'stop' | 'pending' | 'questions' | 'message'>): { notable: Notable | null; why: string } {
  if (state === 'needs-you') {
    if (e.stop === 'injection') return { notable: 'needs-you', why: 'stopped on text in the item that looked like an instruction to it' };
    const parts = [e.questions ? `asked ${plural(e.questions, 'question')}` : '', e.pending ? `${e.pending} ${e.pending === 1 ? 'proposal' : 'proposals'} to review` : ''].filter(Boolean);
    return { notable: 'needs-you', why: parts.join(', ') || 'waiting on you' };
  }
  if (state === 'done') return { notable: 'done', why: 'finished' };
  if (state === 'failed') {
    // A person's own Stop is news to nobody.
    if (e.stop === 'cancelled') return { notable: null, why: 'stopped by a person' };
    if (e.stop === 'time') return { notable: 'failed', why: 'stopped at its time limit' };
    if (e.stop === 'interrupted') return { notable: 'failed', why: 'Toil UI stopped while it ran' };
    // The run's own reason, on one line: what failed, as the assignment page says it.
    const said = e.message.split('\n')[0]!.trim();
    return { notable: 'failed', why: said ? (said.length > 160 ? `${said.slice(0, 157)}...` : said) : 'failed' };
  }
  return { notable: null, why: state };
}

/** A time of day as quiet hours take it: H:MM or HH:MM, 00:00 to 23:59. */
export const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Whether a local time falls in the quiet hours; a range past midnight (22:00 to 07:00) wraps. */
export function inQuiet(quiet: NotifySettings['quiet'], at: Date): boolean {
  if (!quiet) return false;
  const mins = (t: string) => {
    const m = HHMM.exec(t);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const from = mins(quiet.from);
  const to = mins(quiet.to);
  if (from === null || to === null || from === to) return false;
  const now = at.getHours() * 60 + at.getMinutes();
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/** Whether a transition notifies under these settings: its kind switched on, and its session the person's when they asked for only theirs. */
export const wanted = (t: Transition, s: NotifySettings) => t.notable !== null && s.states[t.notable] && (!s.mine || t.mine);

/** How long changes gather before they become one notice. */
export const WINDOW_MS = 4000;

/**
 * Gathers transitions for WINDOW_MS from the first, then hands on what is
 * left: per session, the last change in the window, and nothing for a
 * session whose last change isn't wanted, or that ended where it started
 * (a question answered elsewhere, a run restarted).
 */
export class Coalescer {
  private readonly held = new Map<string, { from: string | null; last: Transition }>();
  private timer: unknown = null;

  constructor(
    private readonly emit: (changes: Transition[]) => void,
    private readonly settings: () => NotifySettings,
    private readonly timers: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void } = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
    private readonly windowMs = WINDOW_MS,
  ) {}

  /** Records one change; `from` is the state the session was in before it, where known. */
  push(t: Transition, from: string | null) {
    const hit = this.held.get(t.key);
    if (hit) hit.last = t;
    else this.held.set(t.key, { from, last: t });
    if (this.timer === null) this.timer = this.timers.set(() => this.flush(), this.windowMs);
  }

  /** Hands on what the window gathered, now. */
  flush() {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    const s = this.settings();
    const out = [...this.held.values()].filter((h) => h.last.state !== h.from && wanted(h.last, s)).map((h) => h.last);
    this.held.clear();
    if (out.length) this.emit(out);
  }

  stop() {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.held.clear();
  }
}

const VERB: Record<Notable, [string, string]> = {
  'needs-you': ['needs you', 'need you'],
  done: ['finished', 'finished'],
  failed: ['failed', 'failed'],
  stale: ['went stale', 'went stale'],
};

/** One line for one change: "Codex needs you on PAY-102 Store tokens in the vault: asked a question". */
export const lineOf = (t: Transition) => `${t.agent} ${VERB[t.notable!][0]}${t.item ? ` on ${t.item}${t.itemTitle ? ` ${t.itemTitle}` : ''}` : ` in ${t.toilProject}`}: ${t.why}`;

/** The notice for what one window gathered: its title, and one line per change. */
export function summaryOf(changes: readonly Transition[]): { title: string; lines: string[] } {
  const lines = changes.map(lineOf);
  if (changes.length === 1) {
    const t = changes[0]!;
    return { title: `${t.agent} ${VERB[t.notable!][0]}`, lines };
  }
  const kinds = new Set(changes.map((c) => c.notable!));
  if (kinds.size === 1) {
    const kind = [...kinds][0]!;
    return { title: `${changes.length} ${kind === 'stale' ? 'sessions' : 'agents'} ${VERB[kind][1]}`, lines };
  }
  return { title: `${changes.length} agent updates`, lines };
}

/** Reads the settings kept in this browser, any part that doesn't parse falling back to its default. */
export function parseNotify(text: string | null): NotifySettings {
  if (!text) return structuredClone(DEFAULT_NOTIFY);
  try {
    const v = JSON.parse(text) as Partial<NotifySettings> | null;
    const states = { ...DEFAULT_NOTIFY.states };
    for (const k of NOTABLES) if (typeof v?.states?.[k] === 'boolean') states[k] = v.states[k];
    const q = v?.quiet;
    const quiet = q && typeof q.from === 'string' && typeof q.to === 'string' && HHMM.test(q.from) && HHMM.test(q.to) ? { from: q.from, to: q.to } : null;
    return { browser: v?.browser === true, states, quiet, mine: v?.mine === true };
  } catch {
    return structuredClone(DEFAULT_NOTIFY);
  }
}
