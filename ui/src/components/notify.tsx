/**
 * Notifications in the page (#306): the provider that listens for agent
 * state changes and turns them into notices, the strip under the header
 * that shows them, and the settings under Settings, General. A change
 * notifies once, when it happens, and only for the states a person switched
 * on: assignments' end states from the server's event stream, a session gone
 * stale (#305) from the chat and from a minute's read of the toil project's
 * assignments. While the tab is hidden the title counts them, and the
 * browser's own notification shows them once a person has turned that on
 * and the browser allowed it. Plain words in every theme. Nothing leaves the
 * machine: the Notification API draws on this computer. A bell, mounted on
 * the inside of the door, rung only for the visitors on the list.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Checkbox, FieldError, Input, Label, TextField } from 'react-aria-components';
import { ADAPTER_NAME, type AssignmentsApi } from '../assign/model.ts';
import { Card } from './layout.tsx';
import { toilProjectHref } from '../format.ts';
import { history } from '../history.ts';
import { Coalescer, HHMM, inQuiet, NOTABLE_LABEL, NOTABLES, parseNotify, summaryOf, transitionOf, type NotifySettings, type Transition } from '../notify.ts';

const SETTINGS_KEY = 'toil-ui.notify';
const MINE_KEY = 'toil-ui.notify.mine';
/** How many assignment ids this browser remembers starting: plenty for "only mine". */
const MAX_MINE = 500;
/** How often the toil project on screen is read for sessions gone stale. */
export const STALE_POLL_MS = 60_000;
/** How long the event stream waits before it reconnects. */
const RECONNECT_MS = 5000;

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A browser that keeps nothing still shows the notices; the settings last for this page.
  }
};

/** One notice in the strip: what one window gathered. */
export interface Notice {
  id: number;
  title: string;
  changes: Transition[];
}

/** Whether the browser can notify, and what it said when asked. */
export type Permission = NotificationPermission | 'unsupported';
const permissionNow = (): Permission => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

interface Notify {
  settings: NotifySettings;
  save(next: NotifySettings): void;
  permission: Permission;
  /** Asks the browser, once a person turns browser notifications on. */
  ask(): Promise<Permission>;
  /** A change the page saw itself (a chat gone stale). */
  report(t: Transition, from: string | null): void;
  notices: Notice[];
  dismiss(id: number): void;
}

const NotifyContext = createContext<Notify | null>(null);
export const useNotify = (): Notify | null => useContext(NotifyContext);

/** Wraps an AssignmentsApi so every assignment this browser assigns, starts or renews is remembered as its own ("only mine"). */
export function remembering(api: AssignmentsApi, mark: (id: string) => void): AssignmentsApi {
  return {
    ...api,
    assign: async (r) => {
      const a = await api.assign(r);
      mark(a.id);
      return a;
    },
    start: async (id, adapter) => {
      const a = await api.start(id, adapter);
      mark(a.id);
      return a;
    },
    renew: async (id) => {
      const a = await api.renew(id);
      mark(a.id);
      return a;
    },
  };
}

/** The ids this browser started, kept here only. */
export function useMine(): { mine: () => Set<string>; mark: (id: string) => void } {
  const ref = useRef<Set<string> | null>(null);
  const mine = useCallback(() => {
    if (!ref.current) {
      try {
        const v = JSON.parse(read(MINE_KEY) ?? '[]') as unknown;
        ref.current = new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
      } catch {
        ref.current = new Set();
      }
    }
    return ref.current;
  }, []);
  const mark = useCallback(
    (id: string) => {
      const s = mine();
      s.add(id);
      write(MINE_KEY, JSON.stringify([...s].slice(-MAX_MINE)));
    },
    [mine],
  );
  return { mine, mark };
}

export function NotifyProvider({ assignments, toilProject, mine, children }: { assignments: AssignmentsApi | undefined; toilProject: string | null; mine: () => Set<string>; children: ReactNode }) {
  const [settings, setSettings] = useState<NotifySettings>(() => parseNotify(read(SETTINGS_KEY)));
  const [permission, setPermission] = useState<Permission>(permissionNow);
  const [notices, setNotices] = useState<Notice[]>([]);
  const live = useRef(settings);
  live.current = settings;
  const next = useRef(0);
  const unread = useRef(0);
  const title = useRef<string | null>(null);

  const deliver = useCallback((changes: Transition[]) => {
    const s = live.current;
    const { title: head, lines } = summaryOf(changes);
    // The bell keeps each change (#417), quiet hours included: they hold the notice, not the record of it.
    history.add(changes.map((c) => ({ id: `${c.key}:${c.state}${c.event === undefined ? '' : `:${c.event}`}`, at: new Date().toISOString(), kind: c.notable!, title: summaryOf([c]).title, line: lineOfLink(c), href: c.href })));
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (hidden) {
      // The title counts what arrived while the tab was away, quiet hours included.
      if (title.current === null) title.current = document.title;
      unread.current += changes.length;
      document.title = `(${unread.current}) ${title.current}`;
    }
    if (inQuiet(s.quiet, new Date())) return;
    setNotices((ns) => [{ id: next.current++, title: head, changes }, ...ns].slice(0, 3));
    if (hidden && s.browser && permissionNow() === 'granted') {
      try {
        new Notification(head, { body: lines.join('\n'), tag: 'toil-ui' });
      } catch {
        // A browser that refuses the constructor (some mobile ones) still has the notice in the page.
      }
    }
  }, []);

  const coalescer = useMemo(() => new Coalescer(deliver, () => live.current), [deliver]);
  useEffect(() => () => coalescer.stop(), [coalescer]);

  // Back on the tab: the count is read.
  useEffect(() => {
    const seen = () => {
      if (document.visibilityState !== 'visible' || title.current === null) return;
      document.title = title.current;
      title.current = null;
      unread.current = 0;
    };
    document.addEventListener('visibilitychange', seen);
    return () => document.removeEventListener('visibilitychange', seen);
  }, []);

  // Assignments' state changes, from the server's event stream (or the sample's queue), from now on.
  useEffect(() => {
    if (!assignments?.events || assignments.disabled) return;
    const controller = new AbortController();
    let since: number | 'latest' = 'latest';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listen = () => {
      assignments.events!(since, (e) => {
        since = e.seq;
        const t = transitionOf(e, { mine: mine().has(e.id), href: `${toilProjectHref(e.toilProject)}/assignment/${encodeURIComponent(e.id)}` });
        if (t) coalescer.push(t, e.previous);
      }, controller.signal).then(
        () => undefined,
        () => undefined,
      ).finally(() => {
        if (!controller.signal.aborted) timer = setTimeout(listen, RECONNECT_MS);
      });
    };
    listen();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [assignments, coalescer, mine]);

  // Sessions gone stale (#305) on the toil project on screen: those seen stale at the first read are known already, so only a change notifies.
  useEffect(() => {
    if (!assignments || assignments.disabled || !toilProject) return;
    let known: Set<string> | null = null;
    let alive = true;
    const look = () =>
      assignments.list(toilProject, { inbox: false }).then(
        (l) => {
          if (!alive) return;
          const stale = l.assignments.filter((a) => a.stale);
          if (known) {
            for (const a of stale) {
              if (known.has(a.id)) continue;
              coalescer.push({ key: `stale:${a.id}`, state: 'stale', notable: 'stale', agent: a.adapter ? ADAPTER_NAME[a.adapter] : 'An agent', item: a.item, itemTitle: a.itemTitle, why: a.stale!.text, toilProject: a.toilProject, href: `${toilProjectHref(a.toilProject)}/assignment/${encodeURIComponent(a.id)}`, mine: mine().has(a.id) }, 'fresh');
            }
          }
          known = new Set([...(known ?? []), ...stale.map((a) => a.id)]);
        },
        () => undefined,
      );
    void look();
    const t = setInterval(look, STALE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [assignments, toilProject, coalescer, mine]);

  const value: Notify = {
    settings,
    save: (s) => {
      setSettings(s);
      write(SETTINGS_KEY, JSON.stringify(s));
    },
    permission,
    ask: async () => {
      if (typeof Notification === 'undefined') return 'unsupported';
      const p = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      setPermission(p);
      return p;
    },
    report: (t, from) => coalescer.push(t, from),
    notices,
    dismiss: (id) => setNotices((ns) => ns.filter((n) => n.id !== id)),
  };
  return <NotifyContext value={value}>{children}</NotifyContext>;
}

/** The notices, under the header: each with its lines, links and a Dismiss. Nothing is drawn while there are none. */
export function Notices() {
  const n = useNotify();
  return (
    <div className="notices" role="status" aria-label="Notifications" data-notices="">
      {n?.notices.map((x) => (
        <div key={x.id} className="notice">
          <p className="notice__title">
            <strong>{x.title}</strong>
          </p>
          <ul className="notice__lines">
            {x.changes.map((c) => (
              <li key={c.key}>
                <a href={c.href}>{lineOfLink(c)}</a>
              </li>
            ))}
          </ul>
          <Button className="btn btn--small" onPress={() => n.dismiss(x.id)}>
            Dismiss<span className="sr-only"> {x.title}</span>
          </Button>
        </div>
      ))}
    </div>
  );
}

const lineOfLink = (c: Transition) => `${c.item ? `${c.item}${c.itemTitle ? ` ${c.itemTitle}` : ''}` : c.toilProject}: ${c.why}`;

/** One checkbox in the settings, drawn as Settings, General draws its others. */
function Check({ on, set, children }: { on: boolean; set: (on: boolean) => void; children: ReactNode }) {
  return (
    <Checkbox className="check" isSelected={on} onChange={set}>
      <span className="box" aria-hidden="true">
        {on ? '✓' : ''}
      </span>
      {children}
    </Checkbox>
  );
}

/**
 * One end of the quiet hours: saved only once it reads as a time, and
 * saying so plainly until it does, so a typo never turns quiet hours off
 * without a word.
 */
function QuietTime({ label, value, save }: { label: string; value: string; save: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const bad = !HHMM.test(draft);
  return (
    <TextField
      className="field-text"
      value={draft}
      onChange={(v) => {
        setDraft(v);
        if (HHMM.test(v)) save(v);
      }}
      isInvalid={bad}
    >
      <Label>{label}</Label>
      <Input inputMode="numeric" />
      <FieldError className="failure">Use HH:MM, like 22:00. Until then the quiet hours keep {value}.</FieldError>
    </TextField>
  );
}

/** Settings, General: which changes notify, only mine, quiet hours, and the browser's own notifications. */
export function NotifySetting() {
  const n = useNotify();
  const [problem, setProblem] = useState<string | null>(null);
  if (!n) return null;
  const s = n.settings;
  const set = (patch: Partial<NotifySettings>) => n.save({ ...s, ...patch });
  const turnBrowser = async (on: boolean) => {
    setProblem(null);
    if (!on) return set({ browser: false });
    // Asked only now, after a person turned it on; never assumed.
    const p = await n.ask();
    if (p === 'granted') return set({ browser: true });
    set({ browser: false });
    setProblem(p === 'unsupported' ? 'This browser has no notifications, so Toil UI shows its notices in the page only.' : "The browser didn't allow notifications for this page, so Toil UI shows its notices in the page only. Allow them in the browser's settings for this site, then turn this on again.");
  };
  return (
    <Card as="section" className="panel notify-setting" aria-labelledby="notify-title">
      <h2 id="notify-title">Notifications</h2>
      <p className="note">A notice when an agent's state changes, never for a tool call or its progress. Changes within a few seconds become one notice. Saved in this browser only.</p>
      <fieldset className="notify-states">
        <legend>Notify when an agent is</legend>
        {NOTABLES.map((k) => (
          <Check key={k} on={s.states[k]} set={(on) => set({ states: { ...s.states, [k]: on } })}>
            {NOTABLE_LABEL[k]}
          </Check>
        ))}
      </fieldset>
      <Check on={s.mine} set={(on) => set({ mine: on })}>
        Only for agents I started in this browser
      </Check>
      <Check on={s.quiet !== null} set={(on) => set({ quiet: on ? { from: '22:00', to: '07:00' } : null })}>
        Quiet hours
      </Check>
      {s.quiet && (
        <div className="notify-quiet">
          <QuietTime label="From (HH:MM, this computer's time)" value={s.quiet.from} save={(from) => set({ quiet: { ...s.quiet!, from } })} />
          <QuietTime label="To (HH:MM)" value={s.quiet.to} save={(to) => set({ quiet: { ...s.quiet!, to } })} />
        </div>
      )}
      <Check on={s.browser} set={(on) => void turnBrowser(on)}>
        Browser notifications while this tab is hidden
      </Check>
      <p className="note" role="status">
        {problem ?? (s.browser ? 'The browser draws them on this computer; nothing is sent anywhere.' : 'Off. The browser is asked for permission only when you turn this on.')}
      </p>
    </Card>
  );
}
