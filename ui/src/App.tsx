/**
 * The app shell: the preview banner, the theme controls, the line every view
 * carries saying when and how its data was read, and the routes: the dossier
 * list, one dashboard per dossier, and an item page inside each. Each view's
 * data is loaded through `execute()` (src/load.ts) the first time it is
 * opened and kept for the session, so a view is a function of data and the
 * tests can render one against the fixture `execute()` directly. Navigation
 * is by hash, so any static host can serve it at any path without a rewrite
 * rule, which is one fewer change request.
 */

import { lazy, Suspense, useCallback, useEffect, useInsertionEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { Button, Dialog, DialogTrigger, Popover } from 'react-aria-components';
import type { Agent } from './agent.ts';
import { Ambient } from './ambient/Ambient.tsx';
import { DataContext, type Data, type StartReady } from './data.ts';
import { dateTime, dossierHref } from './format.ts';
import { loadDossier, loadDossiers, type DossierData, type DossierSummary } from './load.ts';
import { SkinProvider, ThemeProvider, skinsFor } from './skins.tsx';
import { THEMES, themeNamed, tokenCss } from './themes.ts';
import { useResolvedScheme, useThemeChoice } from './theme-choice.ts';
import type { Call, Execute } from './toil.ts';
import { ChatScope } from './components/ask.tsx';
import { AnalyzeAfterSync } from './components/briefing.tsx';
import { ServerStale } from './components/stale.tsx';
import { Notices, NotifyProvider, remembering, useMine } from './components/notify.tsx';
import type { ServerStatus } from './fingerprint.ts';
import { CommandCenter } from './views/CommandCenter.tsx';
import { Dashboard } from './views/Dashboard.tsx';
import { DossierShell, type DossierTab } from './views/DossierShell.tsx';
import { Dossiers, type SyncedAt } from './views/Dossiers.tsx';
import type { Described } from './components/dossier-head.tsx';
import { markLooked, renameLooked } from './looked.ts';
import { health } from './model/sprint.ts';
import { rememberSprint, renameSprint, splashDataFor } from './moments/splash-data.ts';
import { ItemView } from './views/Item.tsx';
import { AssignmentView } from './views/Assignment.tsx';
import { startReadyWith } from './assign/start.ts';
import type { AssignmentsApi } from './assign/model.ts';
import { memoryAnalyses, type AnalysesApi } from './analyses.ts';
import { People } from './views/People.tsx';
import { PullRequests } from './views/PullRequests.tsx';
import { JobPage } from './components/jobs.tsx';
import { jobForSegment, type JobId } from './model/jobs.ts';
import { Settings } from './views/Settings.tsx';
import { Standup } from './views/Standup.tsx';
import { Worklog } from './views/Worklog.tsx';
import type { WorklogApi } from './worklog.ts';
import { isDay } from './model/worklog.ts';
import type { ConfigApi } from './config.ts';
import type { AgentSettingsPanelProps } from './agent-settings.tsx';
import type { ModelUsageApi } from './server-client.ts';
import type { FeedbackApi } from './feedback.ts';
import { FeedbackButton, FeedbackModal } from './feedback-dialog.tsx';
import { useMediaQuery } from './components/layout.tsx';
import { Choice } from './components/choice.tsx';
import { ThemeChoiceProvider, wordingOn } from './theme-context.ts';
import type { WordKey } from './wording.ts';
import { usePlain, wordsFor } from './plain-words.ts';
import { viewHelpHref } from './help.ts';
import { Loader, MomentsProvider, Splash, useMomentPlayer } from './moments/Moments.tsx';
import { momentsFor } from './moments/events.ts';
import { progressText, syncText, trackCalls, type CallProgress } from './moments/progress.ts';
import { useThemeMotion } from './motion.ts';
import type { WorklogEvent } from './model/worklog.ts';
import type { SyncJob } from './server-client.ts';
import { CommandPalette, ShortcutsSheet } from './components/palette.tsx';
import { matches, typingIn } from './shortcuts.ts';
import { HeaderHelp } from './components/help.tsx';
import { Bell } from './components/bell.tsx';
import { NewDot, WhatsNewModal, useWhatsNew } from './components/whats-new.tsx';
import type { Release, Versions } from './whats-new.ts';

const PowershellMan = lazy(() => import('./game/PowershellMan.tsx').then((module) => ({ default: module.PowershellMan })));
const POWERSHELL_MAN_HASH = '#/powershell-man';

export type SettingsPage = 'connections' | 'dossiers' | 'toil' | 'usage' | 'agent-usage' | 'agent';
type RouteOf =
  | { view: 'dossiers' }
  /** `at`: where an edit link lands on the page (#346): a connection's name, a dossier and its section, or `caps`. */
  | { view: 'settings'; page: SettingsPage; at?: string[] }
  /**
   * A dossier's own tabs (#394): the Overview when `tab` is absent, else the Board, Dependencies or Analyses.
   * `person`: the board filtered to one person, by the People view's key for them (#292).
   * `analysis`: one analysis opened from the Analyses tab (#395), by its id.
   */
  | { view: 'dashboard'; dossier: string; tab?: 'board' | 'dependencies' | 'analyses'; person?: string; analysis?: string }
  | { view: 'prs'; dossier: string }
  | { view: 'people'; dossier: string }
  /** Every work item with its readiness verdict (#307). */
  | { view: 'command-center'; dossier: string }
  | { view: 'worklog'; dossier: string; day: string | null }
  /** The stand-up (#345): a range of days, or since the last working day when it names none. */
  /** `ignored`: what the URL named that isn't a day, said on the page rather than dropped quietly. */
  | { view: 'standup'; dossier: string; from: string | null; to: string | null; ignored?: string }
  | { view: 'item'; dossier: string; id: string }
  /** A workflow job's own page (#532): `#/dossier/<name>/job/<review|ship|diagram>?target=<change id or repository>`. */
  | { view: 'job'; dossier: string; job: JobId; target: string | null }
  /** One agent assignment (#293). */
  | { view: 'assignment'; dossier: string; id: string };

/** A route, and on any dossier page the item its drawer shows (#494): `?item=<owi id>` after the path, so the peek has an address of its own. */
export type Route = RouteOf & { peek?: string };

export function parseRoute(hash: string): Route {
  const at = hash.indexOf('?');
  const route = parsePath(at < 0 ? hash : hash.slice(0, at));
  const query = at < 0 ? null : new URLSearchParams(hash.slice(at + 1));
  const peek = query?.get('item') ?? null;
  if (route.view === 'job') return { ...route, target: query?.get('target') || null };
  return peek && 'dossier' in route && route.view !== 'item' ? { ...route, peek } : route;
}

function parsePath(hash: string): RouteOf {
  const parts = hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'settings') {
    const page: SettingsPage = parts[1] === 'dossiers' || parts[1] === 'toil' || parts[1] === 'usage' || parts[1] === 'agent-usage' || parts[1] === 'agent' ? parts[1] : 'connections';
    // A malformed escape is kept as typed, so the page says it found nothing by that name rather than failing to render.
    const at = parts.slice(2).filter(Boolean).map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
    return at.length ? { view: 'settings', page, at } : { view: 'settings', page };
  }
  if (parts[0] === 'dossier' && parts[1]) {
    const dossier = decodeURIComponent(parts[1]);
    if (parts[2] === 'item' && parts[3]) return { view: 'item', dossier, id: decodeURIComponent(parts.slice(3).join('/')) };
    if (parts[2] === 'assignment' && parts[3]) return { view: 'assignment', dossier, id: decodeURIComponent(parts[3]) };
    if (parts[2] === 'job' && parts[3] && jobForSegment(parts[3])) return { view: 'job', dossier, job: jobForSegment(parts[3])!, target: null };
    if (parts[2] === 'prs') return { view: 'prs', dossier };
    if (parts[2] === 'people') return { view: 'people', dossier };
    if (parts[2] === 'command-center') return { view: 'command-center', dossier };
    if (parts[2] === 'board') return parts[3] ? { view: 'dashboard', dossier, tab: 'board', person: decodeURIComponent(parts.slice(3).join('/')) } : { view: 'dashboard', dossier, tab: 'board' };
    if (parts[2] === 'analyses' && parts[3]) return { view: 'dashboard', dossier, tab: 'analyses', analysis: decodeURIComponent(parts.slice(3).join('/')) };
    if (parts[2] === 'dependencies' || parts[2] === 'analyses') return { view: 'dashboard', dossier, tab: parts[2] };
    if (parts[2] === 'worklog' && parts[3] === 'standup') {
      // One day names a one-day stand-up; anything that isn't a day is named on the page, which shows the default range instead.
      const [from, to] = [parts[4], parts[5]].map((p) => (p ? decodeURIComponent(p) : undefined));
      const bad = [from, to].filter((p): p is string => p !== undefined && p !== '' && !isDay(p));
      if (bad.length || (!from && to)) return { view: 'standup', dossier, from: null, to: null, ignored: bad.join(', ') || to! };
      return { view: 'standup', dossier, from: from ?? null, to: to || from || null };
    }
    if (parts[2] === 'worklog') return { view: 'worklog', dossier, day: isDay(parts[3]) ? parts[3] : null };
    return { view: 'dashboard', dossier };
  }
  return { view: 'dossiers' };
}

/**
 * Which of a dossier's tabs a route shows (#394). The old addresses keep
 * working on the tab they belong to: the Command Center is the Board's
 * readiness view, the stand-up is the Worklog's, and an item lands on the
 * Board it came from. An assignment belongs to no tab: the Agents sidebar is its home.
 */
export function tabOf(route: Route): DossierTab | null {
  switch (route.view) {
    case 'dashboard':
      return route.tab ?? 'overview';
    case 'prs':
      return 'prs';
    case 'people':
      return 'people';
    case 'worklog':
    case 'standup':
      return 'worklog';
    case 'command-center':
    case 'item':
      return 'board';
    default:
      return null;
  }
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      // Opening the arcade is a modal transition: keep the current view and
      // any unfinished form mounted behind it until the player returns.
      // Coming back to the same route keeps the same object, so nothing reloads on exit either.
      if (window.location.hash === POWERSHELL_MAN_HASH) return;
      const next = parseRoute(window.location.hash);
      setRoute((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

function usePowershellMan() {
  const [open, setOpen] = useState(() => window.location.hash === POWERSHELL_MAN_HASH);
  const returnHash = useRef('#/');
  const activeBeforeOpen = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onChange = () => setOpen(window.location.hash === POWERSHELL_MAN_HASH);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  useEffect(() => {
    if (!open) return;
    return () => {
      activeBeforeOpen.current?.focus();
      activeBeforeOpen.current = null;
    };
  }, [open]);
  const show = useCallback(() => {
    if (open) return;
    returnHash.current = window.location.hash && window.location.hash !== POWERSHELL_MAN_HASH ? window.location.hash : '#/';
    activeBeforeOpen.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    window.location.hash = POWERSHELL_MAN_HASH;
  }, [open]);
  const close = useCallback(() => {
    if (window.location.hash === POWERSHELL_MAN_HASH) window.location.hash = returnHash.current;
    else setOpen(false);
  }, []);
  return { open, show, close };
}

export interface AppProps {
  /** `execute()` from `@imagile-dev/toil/api`, or the preview's fixture one. */
  execute: Execute;
  agent: Agent;
  /** toil's config commands, for the settings pages: the server's, or the preview's sample one, which changes nothing. */
  config?: ConfigApi;
  /**
   * toil's theme setting (#427), read with `toil theme list` and written with
   * `toil theme set` through the server's config commands. Absent (the preview,
   * sample data, a test), the theme is this browser's alone.
   */
  themeSetting?: ConfigApi;
  /** When the data is read; sprint figures are worked out at it. The preview's is fixed. */
  now: string;
  /** The site's live sample: shows the sample-data banner on every view. */
  preview: boolean;
  /** The local app's agent settings (#251), shown under Settings; the preview has none. */
  agentSettings?: AgentSettingsPanelProps;
  /** `toil feedback`, behind the header's Feedback button (#265): the server's, or the preview's, which sends nothing. */
  feedback?: FeedbackApi;
  /** The Command Center's start action (#307), which assign-to-agent (#293) provides; without it the start button is disabled. */
  startReady?: StartReady;
  /** The worklog (#308): the server's pages, or the sample's, which keep nothing. */
  worklog?: WorklogApi;
  /** The agent's model usage and caps (#295), for Settings, Agent usage: the server's, or the preview's sample. */
  modelUsage?: ModelUsageApi;
  /** Assigning items to an agent (#293): the server's, or the preview's sample queue. */
  assignments?: AssignmentsApi;
  /** The history of analyses (#395): the server's, or the preview's sample. Without one, the App keeps this page's in memory. */
  analyses?: AnalysesApi;
  /** Each dossier's last sync, from the sync panel (#342), for its card; absent where nothing syncs (the preview). */
  synced?: Record<string, SyncedAt>;
  /** After a dossier's name or description changed in place, so the shell can read the sync status again under the new name. */
  afterDescribe?: () => void;
  /** Whether the server is older than what is on disk (#305), for the header; absent in the preview. Keep it one function for the App's life: the header asks it again every minute. */
  serverStatus?: () => Promise<ServerStatus | null>;
  /** A sync running now (#419), for the themed loader that says its progress; absent or null while none runs. */
  syncing?: SyncJob | null;
  /** When the last sync finished (#494), for Analyze after a sync; absent where nothing syncs. */
  syncedAt?: string | null;
  /** The facts the last sync recorded for the first time (#419), by dossier, which play the theme's moments once; `id` is when that sync finished. */
  news?: { id: string; byDossier: Array<{ dossier: string; events: WorklogEvent[] }> } | null;
  /** Starts a sync, where the local app keeps a cache (#416): for the command palette, the first-run checklist and the empty states that a sync fills (#417). */
  onSync?: () => void;
  /** The toil and Toil UI this page runs on, for What's new (#417): the server's, or, absent, the ones this build pins. */
  versions?: Versions;
}

type Loaded<T> = { ok: true; value: T } | { ok: false; message: string };
const failed = (e: unknown): Loaded<never> => ({ ok: false, message: e instanceof Error ? e.message : String(e) });

export function App({ execute, agent, config, themeSetting, now, preview, agentSettings, feedback, modelUsage, worklog, startReady, assignments: given, analyses: givenAnalyses, synced, afterDescribe, serverStatus, onSync, syncing, syncedAt, news, versions }: AppProps) {
  const [ownAnalyses] = useState(() => memoryAnalyses());
  const analyses = givenAnalyses ?? ownAnalyses;
  const route = useRoute();
  const game = usePowershellMan();
  const gameBuffer = useRef('');
  const gameLastKey = useRef(0);
  useEffect(() => {
    const onType = (e: KeyboardEvent) => {
      if (game.open || e.repeat || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || typingIn(e.target) || (e.target instanceof Element && e.target.closest('[role="dialog"]'))) {
        gameBuffer.current = '';
        return;
      }
      if (e.key.length !== 1 || !/[a-z]/i.test(e.key)) return;
      const now = Date.now();
      if (now - gameLastKey.current > 1400) gameBuffer.current = '';
      gameLastKey.current = now;
      gameBuffer.current = (gameBuffer.current + e.key.toLowerCase()).slice(-'powershell'.length);
      if (gameBuffer.current === 'powershell') {
        gameBuffer.current = '';
        e.preventDefault();
        game.show();
      }
    };
    window.addEventListener('keydown', onType, true);
    return () => window.removeEventListener('keydown', onType, true);
  }, [game.open, game.show]);
  // Every assignment this browser starts is remembered as its own, for "only for agents I started" (#306).
  const { mine, mark } = useMine();
  const assignments = useMemo(() => (given ? remembering(given, mark) : undefined), [given, mark]);
  const [list, setList] = useState<Loaded<{ dossiers: DossierSummary[]; calls: Call[] }> | null>(null);
  const [dossiers, setDossiers] = useState<Record<string, Loaded<DossierData>>>({});
  // What the dossier on screen is waiting on, for its loading screen (#419): the real calls, as they go.
  const [progress, setProgress] = useState<Record<string, CallProgress>>({});
  const choice = useThemeChoice(themeSetting ?? null);
  const scheme = useResolvedScheme(choice.scheme);
  const theme = themeNamed(choice.theme);
  const main = useRef<HTMLElement>(null);
  const gameDialog = useRef<HTMLDivElement>(null);
  const focusGameDialog = useCallback((element: HTMLDivElement | null) => {
    gameDialog.current = element;
    element?.querySelector<HTMLElement>('button')?.focus();
  }, []);
  const first = useRef(true);
  const wanted = route.view === 'dossiers' || route.view === 'settings' ? null : route.dossier;
  // The command palette and the shortcuts sheet (#416), hidden until called up; `focused` is the item the focus was on when the palette opened.
  const [palette, setPalette] = useState<{ open: boolean; focused: string | null }>({ open: false, focused: null });
  const [sheet, setSheet] = useState(false);
  // What's new (#417): a dot on Help after an upgrade, and the list behind it.
  const whatsNew = useWhatsNew(versions);
  // What the list shows is taken as it opens, since opening it marks it seen.
  const [newsOpen, setNewsOpen] = useState<{ shown: Release[]; fresh: boolean } | null>(null);
  const openWhatsNew = () => {
    setNewsOpen({ shown: whatsNew.shown, fresh: whatsNew.fresh.length > 0 });
    whatsNew.seen();
  };
  const openPalette = () => {
    const card = document.activeElement?.closest('[data-item]')?.getAttribute('data-item') ?? null;
    setPalette({ open: true, focused: card ?? (route.view === 'item' ? route.id : null) });
  };
  const openPaletteRef = useRef(openPalette);
  useEffect(() => {
    openPaletteRef.current = openPalette;
  });
  useEffect(() => {
    // Capture, so a field or a dialog that handles its own keys can't swallow Ctrl+K first.
    const on = (e: KeyboardEvent) => {
      if (game.open || (e.target instanceof Element && e.target.closest('[data-powershell-man]'))) return;
      if (matches('palette', e)) {
        e.preventDefault();
        setPalette((p) => (p.open ? { ...p, open: false } : p));
        if (!document.querySelector('[data-palette]')) openPaletteRef.current();
      } else if (matches('shortcuts', e) && !typingIn(e.target)) {
        e.preventDefault();
        setSheet(true);
      }
    };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, [game.open]);

  // Settings can add or remove dossiers, so the list is read again after a visit there (the first-run checklist, #416, ticks off from it).
  useEffect(() => {
    if (route.view === 'settings') setList(null);
  }, [route.view]);

  useEffect(() => {
    // The list feeds the Dossiers view, on a dossier's pages its switcher (#394), and the palette (#416).
    if ((route.view === 'settings' && !palette.open) || list) return;
    let live = true;
    loadDossiers(execute).then(
      (value) => live && setList({ ok: true, value }),
      (e: unknown) => live && setList(failed(e)),
    );
    return () => {
      live = false;
    };
  }, [route.view, list, execute, palette.open]);

  // The Dossiers view's cards (#342) read each dossier the way its dashboard does, one at a time, from the cache in the
  // local app, and so does the palette's item search (#416) while it is open. What arrives is kept, so a dashboard
  // opened from a card is already loaded.
  const names = list?.ok ? list.value.dossiers.map((d) => d.name) : [];
  const listed = route.view === 'dossiers' || palette.open ? names : [];
  const nextToLoad = listed.find((n) => !dossiers[n]);
  useEffect(() => {
    if (!nextToLoad) return;
    let live = true;
    loadDossier(execute, nextToLoad).then(
      (value) => live && setDossiers((d) => ({ ...d, [nextToLoad]: { ok: true, value } })),
      (e: unknown) => live && setDossiers((d) => ({ ...d, [nextToLoad]: failed(e) })),
    );
    return () => {
      live = false;
    };
  }, [nextToLoad, execute]);

  // Opening a dashboard is what "since you last looked" counts from.
  const looking = route.view === 'dashboard' && wanted && dossiers[wanted]?.ok ? wanted : null;
  useEffect(() => {
    if (looking) markLooked(looking);
  }, [looking]);

  // The splash on the next launch (#462) may show this dossier's sprint, so its dates are remembered as it loads; never the sample's.
  const onScreen = wanted ? dossiers[wanted] : undefined;
  useEffect(() => {
    if (!preview && wanted && onScreen?.ok) rememberSprint(wanted, health(onScreen.value.items, onScreen.value.changes, now));
  }, [preview, wanted, onScreen, now]);
  // What the splash knows as it plays, read once: the dossier being opened's remembered sprint at the App's clock, else nothing.
  const [splashData] = useState(() => (!preview && wanted ? splashDataFor(wanted, now) : null));

  /**
   * After a name or description was changed in place: a description is written
   * into what's loaded; a rename reads the list and that dossier again, and
   * moves the route, and what this browser remembers, to the new name. The
   * server has moved its cache, worklog and assignments by then.
   */
  const described = (d: Described) => {
    afterDescribe?.();
    if (!d.renamed) {
      // A new description changes one line of what's loaded, so it's written in rather than read again.
      setList((l) => (l?.ok ? { ok: true, value: { ...l.value, dossiers: l.value.dossiers.map((x) => (x.name === d.name ? { ...x, description: d.description } : x)) } } : l));
      setDossiers((all) => {
        const had = all[d.name];
        return had?.ok ? { ...all, [d.name]: { ok: true, value: { ...had.value, description: d.description } } } : all;
      });
      return;
    }
    const { from, to } = d.renamed;
    renameLooked(from, to);
    renameSprint(from, to);
    setList(null);
    setDossiers(({ [from]: _, ...rest }) => rest);
    if (wanted === from) {
      const rest = window.location.hash.replace(/^#\/dossier\/[^/]+/, '');
      window.location.hash = `${dossierHref(to)}${rest}`;
    }
  };

  useEffect(() => {
    if (!wanted || dossiers[wanted]) return;
    let live = true;
    const counted = trackCalls(execute, (p) => live && setProgress((all) => ({ ...all, [wanted]: p })));
    loadDossier(counted, wanted).then(
      (value) => live && setDossiers((d) => ({ ...d, [wanted]: { ok: true, value } })),
      (e: unknown) => live && setDossiers((d) => ({ ...d, [wanted]: failed(e) })),
    );
    return () => {
      live = false;
    };
  }, [wanted, dossiers, execute]);

  // A new view moves focus to its heading, so a screen reader hears where it
  // landed and the next Tab starts from the top of the content. A dashboard
  // still loading has no heading yet, so the move waits until it renders one.
  const routeKey = JSON.stringify(route);
  const pending = useRef(false);
  // An edit link's target (#346) is focused by its own page once it has loaded (useLandOn), so the heading doesn't take it first.
  const landing = route.view === 'settings' && Boolean(route.at);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    pending.current = !landing;
  }, [routeKey, landing]);
  useEffect(() => {
    // A board filtered to one person (#292) takes focus at the filter's line instead, which is what the link was for.
    if (game.open) return;
    const h1 = pending.current ? (main.current?.querySelector<HTMLElement>('#board-filter') ?? main.current?.querySelector<HTMLElement>('h1')) : null;
    if (h1) {
      pending.current = false;
      h1.focus();
    }
  });

  const skip = (e: MouseEvent) => {
    e.preventDefault();
    main.current?.querySelector<HTMLElement>('h1')?.focus();
  };

  const skins = skinsFor(theme.name);
  // Mirrors Theme motion on the root (#419), so the moments' CSS plays at the level chosen.
  useThemeMotion();
  const splashReady = route.view === 'settings' || (route.view === 'dossiers' ? list !== null : Boolean(wanted && dossiers[wanted]));
  const splashDetail = route.view === 'dossiers' || !wanted ? 'Reading the dossiers with toil dossiers list.' : progressText(progress[wanted]);
  // The App provides the theme context, so it can't read it through useWords(); this is the same lookup.
  const plain = usePlain();
  const words = (key: WordKey, vars?: Record<string, string>) => wordsFor(theme.lexicon, wordingOn(theme, choice), plain.on, key, vars);
  // A dossier's own views are its tabs (#394), so the header carries only what sits above every dossier.
  const links: NavLink[] = [
    { href: '#/', label: plain.pw('Dossiers', 'Toil projects'), title: plain.title('Dossiers'), current: route.view === 'dossiers' },
    { href: '#/settings', label: 'Settings', current: route.view === 'settings' },
  ];
  const top = useRef<HTMLDivElement>(null);
  const narrow = useMediaQuery(COMPACT_HEADER);
  // On a phone the beta notice and the "Sample data read …" line are one line: the source and the time stay, the long sentence goes.
  const phoneBanner = useMediaQuery('(max-width: 599px)');
  const crowded = useCrowded(top, !narrow, links.map((l) => l.label).join('|'));
  const compact = narrow || crowded;
  const controls = (
    <>
      <Choice label="Theme" value={theme.name} onChange={choice.setTheme} options={THEMES.map((t) => ({ id: t.name, label: t.label }))} />
    </>
  );
  // Help (#346): the docs section for the view in front of you, in a new tab, and Learn (#418) while learning links are on.
  // In the compact header Help sits inside the Menu, which closes first so What's new opens over the page, not over it.
  const helpWith = (closeFirst?: () => void) => (
    <HeaderHelp
      href={viewHelpHref(route.view, route.view === 'settings' ? route.page : undefined)}
      fresh={whatsNew.fresh.length > 0}
      onWhatsNew={() => {
        if (!closeFirst) return openWhatsNew();
        closeFirst();
        requestAnimationFrame(() => requestAnimationFrame(openWhatsNew));
      }}
    />
  );
  const current = wanted ? dossiers[wanted] : undefined;
  const failure = (message: string) => (
    <div role="alert" className="failure">
      <h1 tabIndex={-1}>The data didn't load</h1>
      <p>{message}</p>
    </div>
  );

  let body;
  if (route.view === 'settings') {
    body = <Settings page={route.page} {...(route.at ? { at: route.at } : {})} config={config ?? null} modelUsage={modelUsage ?? null} {...(agentSettings ? { agent: agentSettings } : {})} />;
  } else if (route.view === 'dossiers') {
    body = !list ? <Loader message={words('loading.dossiers')} detail="Reading them with toil dossiers list." /> : list.ok ? <Dossiers dossiers={list.value.dossiers} calls={list.value.calls} loaded={dossiers} now={now} synced={synced ?? (preview ? null : {})} config={config ?? null} onDescribed={described} onSync={onSync} /> : failure(list.message);
  } else if (!current) {
    body = <Loader message={words('loading.dossier', { name: route.dossier })} detail={progressText(progress[route.dossier])} />;
  } else if (!current.ok) {
    body = failure(current.message);
  } else {
    const data: Data = { ...(onSync ? { sync: onSync } : {}), dossier: current.value, byId: new Map(current.value.items.map((i) => [i.id, i])), prById: new Map((current.value.pullRequests ?? []).map((c) => [c.id, c])), agent, now, ...(preview ? { viewedAt: new Date(Date.parse(now) + 2 * 3_600_000).toISOString() } : {}), execute, analyses, ...(config ? { config } : {}), ...(assignments ? { assignments } : {}), ...(startReady ? { startReady } : assignments && !assignments.disabled ? { startReady: startReadyWith(assignments, route.dossier) } : {}), refresh: () => setDossiers(({ [route.dossier]: _, ...rest }) => rest), described };
    body = (
      <DataContext value={data}>
        {/* The Ask bar (#343), on every dossier page; its chat is keyed by dossier, so a conversation lasts across that dossier's views. */}
        <ChatScope key={route.dossier}>
          <AnalyzeAfterSync syncedAt={syncedAt ?? null} />
          <DossierShell tab={tabOf(route)} peek={route.peek ?? null} heading={route.view === 'dashboard'} dossiers={list?.ok ? list.value.dossiers.map((d) => d.name) : null} {...(route.view === 'command-center' ? { boardView: 'readiness' as const } : route.view === 'dashboard' && route.tab === 'board' ? { boardView: 'board' as const } : {})}>
            {route.view === 'item' ? <ItemView id={route.id} /> : route.view === 'assignment' ? <AssignmentView id={route.id} /> : route.view === 'job' ? <JobPage id={route.job} target={route.target} /> : route.view === 'prs' ? <PullRequests /> : route.view === 'people' ? <People /> : route.view === 'worklog' ? <Worklog api={worklog ?? null} day={route.day} /> : route.view === 'standup' ? <Standup api={worklog ?? null} from={route.from} to={route.to} {...(route.ignored ? { ignored: route.ignored } : {})} /> : route.view === 'command-center' ? <CommandCenter /> : <Dashboard {...(route.tab ? { tab: route.tab } : {})} {...(route.person ? { person: route.person } : {})} {...(route.analysis ? { analysis: route.analysis } : {})} />}
          </DossierShell>
        </ChatScope>
      </DataContext>
    );
  }

  return (
    <NotifyProvider assignments={assignments} dossier={wanted} mine={mine}>
    <ThemeProvider value={theme}>
      <ThemeChoiceProvider value={choice}>
      <SkinProvider value={skins}>
        <MomentsProvider>
        <TokenStyles css={THEMES.map(tokenCss).join('\n')} />
        <Ambient theme={theme.name} scheme={scheme} />
        <Splash ready={splashReady} detail={splashDetail} data={splashData} />
        <PlayNews news={news ?? null} dossier={wanted} />
        <a className="skip" href="#main" onClick={skip} inert={game.open} aria-hidden={game.open || undefined}>
          Skip to content
        </a>
        <header className="app-header" inert={game.open} aria-hidden={game.open || undefined}>
          {preview && phoneBanner && (
            <p className="banner" role="note" data-banner-merged="">
              <strong>{plain.pw('Toil UI beta, on sample data.', 'Toil UI beta, showing sample data.')}</strong> Read {dateTime(now)}.
            </p>
          )}
          {preview && !phoneBanner && (
            <p className="banner" role="note">
              <strong>{plain.pw('Toil UI beta, on sample data.', 'Toil UI beta, showing sample data.')}</strong> {plain.pw('Nothing here connects to a tracker.', 'Nothing here connects to your real tools.')}
            </p>
          )}
          <div className="top" data-one-row="" ref={top}>
            <skins.Header>
              {/* The wordmark, the site's and the terminal's, with "UI" stuck on beside it. Its
                  name is its own text, "toil UI": the space between the word and the sticker is a
                  real one, kept narrow, so the name a screen reader or voice control uses is the
                  words on screen (WCAG 2.5.3). */}
              <a className="brand" href="#/">
                <span className="brand-name">
                  <span className="wordmark">toil</span>{' '}
                  <span className="sticker">
                    <span className="sticker__face">UI</span>
                  </span>
                </span>
              </a>
              {compact ? (
                <>
                  <Bell />
                  <HeaderMenu suspended={game.open} links={links} feedback={feedback} controls={controls} help={helpWith} fresh={whatsNew.fresh.length > 0} onPalette={openPalette} onShortcuts={() => setSheet(true)} />
                </>
              ) : (
                <>
                  <nav aria-label="Views">
                    <NavLinks links={links} />
                  </nav>
                  <div className="settings">
                    <Bell />
                    {helpWith()}
                    {feedback && !game.open && <FeedbackButton api={feedback} />}
                    {controls}
                  </div>
                </>
              )}
            </skins.Header>
          </div>
          <ServerStale load={serverStatus} />
          <Notices />
          {!(preview && phoneBanner) && (
            <p className="sync">
              {preview ? 'Sample data' : 'Data'} read {dateTime(now)} {plain.pw('through toil, read-only.', 'without changing anything.')}
            </p>
          )}
        </header>
        <main id="main" ref={main} data-view={route.view} inert={game.open} aria-hidden={game.open || undefined}>
          {/* A running sync (#419): the theme's loader with its progress; the Sync panel's own line is the one announced. */}
          {syncing?.running && <Loader size="panel" message={syncText(syncing)!} live={false} />}
          {choice.saveError && (
            <p className="notice" role="alert">
              {choice.saveError}
            </p>
          )}
          {body}
        </main>
        <CommandPalette
          isOpen={palette.open && !game.open}
          onOpenChange={(open) => setPalette((p) => ({ ...p, open }))}
          agent={agent}
          analysesApi={analyses}
          reading={palette.open ? names.filter((n) => !dossiers[n]).length : 0}
          route={route}
          dossiers={names}
          loaded={dossiers}
          synced={synced}
          themes={THEMES.map((t) => ({ name: t.name, label: t.label }))}
          currentTheme={theme.name}
          setTheme={choice.setTheme}
          scheme={choice.scheme}
          setScheme={choice.setScheme}
          onSync={onSync}
          focused={palette.focused}
          canAssign={Boolean(assignments && !assignments.disabled)}
          agentSettings={Boolean(agentSettings)}
          openShortcuts={() => setSheet(true)}
        />
        <ShortcutsSheet isOpen={sheet && !game.open} onOpenChange={setSheet} />
        <WhatsNewModal shown={newsOpen?.shown ?? []} fresh={newsOpen?.fresh ?? false} isOpen={newsOpen !== null && !game.open} onOpenChange={(open) => !open && setNewsOpen(null)} />
        {game.open && <Suspense fallback={null}><div className="pm-dialog" ref={focusGameDialog} role="dialog" aria-modal="true" aria-label="Powershell Man" tabIndex={-1} data-powershell-man onKeyDown={(e) => {
          if (!['Tab'].includes(e.key)) return;
          const focusable = [...(gameDialog.current?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [])].filter((el) => !el.hasAttribute('disabled'));
          const first = focusable[0];
          const last = focusable.at(-1);
          if (!first || !last) { e.preventDefault(); gameDialog.current?.focus(); }
          else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }}><PowershellMan onClose={game.close} /></div></Suspense>}
        </MomentsProvider>
      </SkinProvider>
      </ThemeChoiceProvider>
    </ThemeProvider>
    </NotifyProvider>
  );
}

/**
 * The themes' tokens as a constructed stylesheet, adopted by the document, so
 * the Content-Security-Policy needs no `'unsafe-inline'` for styles: a
 * stylesheet built through the CSSOM isn't inline markup. Where the browser
 * can't construct one (jsdom), it falls back to a <style> element.
 */
function TokenStyles({ css }: { css: string }) {
  const constructable = typeof CSSStyleSheet !== 'undefined' && 'replaceSync' in CSSStyleSheet.prototype && 'adoptedStyleSheets' in document;
  useInsertionEffect(() => {
    if (!constructable) return;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return () => {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
    };
  }, [css, constructable]);
  return constructable ? null : <style>{css}</style>;
}

/**
 * Below 1024px the header is the name and a Menu button; the views,
 * Feedback and the theme controls open from it. Wider, they sit in one row.
 */
export const COMPACT_HEADER = '(max-width: 1023px)';

/**
 * Whether the header's one row is too crowded at this width: its links and
 * controls would wrap onto a second row, as a dossier's seven links can with a
 * wider font (Linux's, say). Measured on the full header and kept until the
 * window is wider than where it last didn't fit or its links change, so the header shows its Menu
 * instead of wrapping, and never flips back and forth at one width.
 */
function useCrowded(row: RefObject<HTMLElement | null>, measuring: boolean, links: string): boolean {
  // The width it last didn't fit at, and the links it was measured with: other links (another view) are measured afresh.
  const [crowded, setCrowded] = useState<{ width: number; links: string } | null>(null);
  useLayoutEffect(() => {
    const check = () => {
      if (crowded !== null) {
        if (crowded.links !== links || window.innerWidth > crowded.width) setCrowded(null);
        return;
      }
      const el = row.current;
      if (!measuring || !el) return;
      // Only the header's own parts: a theme's corners and flourishes sit beside them, positioned on their own.
      const parts = [...el.querySelectorAll<HTMLElement>('.brand, nav, .settings')];
      const items = [...el.querySelectorAll<HTMLElement>('nav li')];
      // A second row is an element lying wholly below another one of the row.
      const wraps = (xs: HTMLElement[]) => {
        const rects = xs.map((x) => x.getBoundingClientRect()).filter((r) => r.height > 0);
        return rects.some((a) => rects.some((b) => a.top >= b.bottom));
      };
      if (wraps(parts) || wraps(items)) setCrowded({ width: window.innerWidth, links });
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [row, measuring, links, crowded]);
  return crowded !== null && crowded.links === links;
}

type NavLink = { href: string; label: string; title?: string | undefined; current: boolean };

function NavLinks({ links, onFollow }: { links: NavLink[]; onFollow?: () => void }) {
  return (
    <ul>
      {links.map((l) => (
        <li key={l.href}>
          <a href={l.href} aria-current={l.current ? 'page' : undefined} title={l.title} onClick={onFollow}>
            {l.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * The compact header's menu: a button that opens a popover holding the
 * views, Feedback and the theme controls. React Aria's Dialog keeps focus
 * inside while it's open, Escape or a click outside closes it, and focus goes
 * back to the button. Feedback closes the menu first, then opens its dialog.
 */
function HeaderMenu({ suspended, links, feedback, controls, help, fresh, onPalette, onShortcuts }: { suspended: boolean; links: NavLink[]; feedback: FeedbackApi | undefined; controls: ReactNode; help: (closeFirst: () => void) => ReactNode; fresh: boolean; onPalette: () => void; onShortcuts: () => void }) {
  const [open, setOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const current = links.find((l) => l.current)?.label;
  return (
    <>
      <DialogTrigger isOpen={open && !suspended} onOpenChange={setOpen}>
        <Button className="btn menu-button" data-menu-button="">
          <span aria-hidden="true" className="menu-button__icon">
            ☰
          </span>
          Menu
          {/* Help, with its dot (#417), is inside the Menu here, so the Menu carries the dot. */}
          {fresh && <NewDot />}
        </Button>
        <Popover className="popover nav-menu" placement="bottom end" offset={6}>
          <Dialog className="nav-menu__dialog" aria-label={current ? `Menu, on ${current}` : 'Menu'}>
            <nav aria-label="Views">
              <NavLinks links={links} onFollow={() => setOpen(false)} />
            </nav>
            <div className="nav-menu__settings">
              {/* The palette and the shortcuts (#416), for a screen with no keyboard to press Ctrl+K on. Inside the Menu, so the header stays as it was. */}
              <Button
                className="btn"
                onPress={() => {
                  setOpen(false);
                  requestAnimationFrame(() => requestAnimationFrame(onPalette));
                }}
                data-palette-open=""
              >
                Search and commands
              </Button>
              <Button
                className="btn"
                onPress={() => {
                  setOpen(false);
                  onShortcuts();
                }}
              >
                Keyboard shortcuts
              </Button>
              {help(() => setOpen(false))}
              {feedback && (
                <Button
                  className="btn feedback-open"
                  onPress={() => {
                    setOpen(false);
                    setFeedbackOpen(true);
                  }}
                >
                  Feedback
                </Button>
              )}
              {controls}
            </div>
          </Dialog>
        </Popover>
      </DialogTrigger>
      {feedback && <FeedbackModal api={feedback} isOpen={feedbackOpen && !suspended} onOpenChange={setFeedbackOpen} />}
    </>
  );
}

/** The facts a sync recorded for the first time, played once as the theme's moments (#419): the dossier on screen's, or every dossier's on the views above them. */
const played = new Set<string>();
function PlayNews({ news, dossier }: { news: AppProps['news'] | null; dossier: string | null }) {
  const player = useMomentPlayer();
  useEffect(() => {
    if (!news || played.has(news.id)) return;
    played.add(news.id);
    const events = news.byDossier.filter((d) => !dossier || d.dossier === dossier).flatMap((d) => d.events);
    player.play(momentsFor(events));
  }, [news, dossier, player]);
  return null;
}
