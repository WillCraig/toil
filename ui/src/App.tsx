/**
 * The app shell: the preview banner, the theme controls, the line every view
 * carries saying when and how its data was read, and the routes: the toil project
 * list, one dashboard per toil project, and an item page inside each. Each view's
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
import { dateTime, toilProjectHref } from './format.ts';
import { loadToilProject, loadToilProjects, type ArchivedToilProject, type ToilProjectData, type ToilProjectSummary } from './load.ts';
import { canArchive, type ArchiveNotice } from './components/archive.tsx';
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
import { ToilProjectShell, type ToilProjectTab } from './views/ToilProjectShell.tsx';
import { ToilProjects, type SyncedAt } from './views/ToilProjects.tsx';
import type { Described } from './components/toil-project-head.tsx';
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
import type { CacheControl } from './views/settings/General.tsx';
import type { ModelUsageApi } from './server-client.ts';
import type { FeedbackApi } from './feedback.ts';
import { FeedbackButton, FeedbackModal } from './feedback-dialog.tsx';
import { useMediaQuery } from './components/layout.tsx';
import { Choice } from './components/choice.tsx';
import { ThemeChoiceProvider, wordingOn } from './theme-context.ts';
import type { WordKey } from './wording.ts';
import { useFontApplied } from './fonts.ts';
import { usePlain, wordsFor } from './plain-words.ts';
import { viewHelpHref } from './help.ts';
import { Setup, type SetupProps } from './views/Setup.tsx';
import { NewProject, type NewProjectProps } from './views/NewProject.tsx';
import { Loader, MomentsProvider, Splash, useMomentPlayer } from './moments/Moments.tsx';
import { momentsFor } from './moments/events.ts';
import { progressText, syncText, trackCalls, type CallProgress } from './moments/progress.ts';
import { useThemeMotion } from './motion.ts';
import type { WorklogEvent } from './model/worklog.ts';
import type { SyncJob } from './server-client.ts';
import { CommandPalette, ShortcutsSheet } from './components/palette.tsx';
import { ariaKeys, keysText, matches, SHORTCUTS, typingIn } from './shortcuts.ts';
import { HeaderHelp } from './components/help.tsx';
import { Bell } from './components/bell.tsx';
import { ProjectLinks, ProjectSwitcher } from './components/project-switcher.tsx';
import { NewDot, WhatsNewModal, useWhatsNew } from './components/whats-new.tsx';
import type { Release, Versions } from './whats-new.ts';

const PowershellMan = lazy(() => import('./game/PowershellMan.tsx').then((module) => ({ default: module.PowershellMan })));
const POWERSHELL_MAN_HASH = '#/powershell-man';

export type SettingsPage = 'general' | 'connections' | 'projects' | 'appearance' | 'usage' | 'agent';
type RouteOf =
  | { view: 'toilProjects' }
  /** The setup wizard (#561): `#/setup`. */
  | { view: 'setup' }
  /** The short wizard that creates one Toil project: `#/new-project`. */
  | { view: 'newProject' }
  /** `at`: where an edit link lands on the page (#346): a connection's name, a toil project and its section, or `rates`. */
  | { view: 'settings'; page: SettingsPage; at?: string[] }
  /**
   * A toil project's own tabs (#394): the Overview when `tab` is absent, else the Board, Dependencies or Analyses.
   * `person`: the board filtered to one person, by the People view's key for them (#292).
   * `analysis`: one analysis opened from the Analyses tab (#395), by its id.
   */
  | { view: 'dashboard'; toilProject: string; tab?: 'board' | 'dependencies' | 'analyses'; person?: string; analysis?: string }
  | { view: 'prs'; toilProject: string }
  | { view: 'people'; toilProject: string }
  /** Every work item with its readiness verdict (#307). */
  | { view: 'command-center'; toilProject: string }
  | { view: 'worklog'; toilProject: string; day: string | null }
  /** The stand-up (#345): a range of days, or since the last working day when it names none. */
  /** `ignored`: what the URL named that isn't a day, said on the page rather than dropped quietly. */
  | { view: 'standup'; toilProject: string; from: string | null; to: string | null; ignored?: string }
  | { view: 'item'; toilProject: string; id: string }
  /** A workflow job's own page (#532): `#/project/<name>/job/<review|ship|diagram>?target=<change id or repository>`. */
  | { view: 'job'; toilProject: string; job: JobId; target: string | null }
  /** One agent assignment (#293). */
  | { view: 'assignment'; toilProject: string; id: string };

/** A route, and on any toil project page the item its drawer shows (#494): `?item=<owi id>` after the path, so the peek has an address of its own. */
export type Route = RouteOf & { peek?: string };

/**
 * Addresses from before dossiers were renamed (#555), kept so a bookmark or a link in a chat still lands: `#/dossier/<name>/…` is
 * `#/project/<name>/…`, `#/settings/dossiers/…` is `#/settings/projects/…`, and `#/dossiers` is the list. Anything else is as it was.
 */
export function upgradeHash(hash: string): string {
  return hash
    .replace(/^#\/dossier(?=\/|\?|$)/, '#/project')
    .replace(/^#\/settings\/dossiers(?=\/|\?|$)/, '#/settings/projects')
    .replace(/^#\/dossiers(?=\/|\?|$)/, '#/')
    // Creating a Toil project has its own short wizard; the two addresses that used to open the first-run wizard's project step go there.
    .replace(/^#\/setup\/project(?=\/|\?|$)/, '#/new-project')
    .replace(/^#\/settings\/projects\/\+new(?=\/|\?|$)/, '#/new-project');
}

export function parseRoute(rawHash: string): Route {
  const hash = upgradeHash(rawHash);
  const at = hash.indexOf('?');
  const route = parsePath(at < 0 ? hash : hash.slice(0, at));
  const query = at < 0 ? null : new URLSearchParams(hash.slice(at + 1));
  const peek = query?.get('item') ?? null;
  if (route.view === 'job') return { ...route, target: query?.get('target') || null };
  return peek && 'toilProject' in route && route.view !== 'item' ? { ...route, peek } : route;
}

function parsePath(hash: string): RouteOf {
  const parts = hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'setup') return { view: 'setup' };
  if (parts[0] === 'new-project') return { view: 'newProject' };
  if (parts[0] === 'settings') {
    // General opens first: `#/settings`, `#/settings/general` and the old `#/settings/toil` all land there. Agent token usage moved to Usage.
    let page: SettingsPage = parts[1] === 'agent-usage' ? 'usage' : parts[1] === 'connections' || parts[1] === 'projects' || parts[1] === 'appearance' || parts[1] === 'usage' || parts[1] === 'agent' ? parts[1] : 'general';
    // A malformed escape is kept as typed, so the page says it found nothing by that name rather than failing to render.
    const at = parts.slice(2).filter(Boolean).map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
    // The caps card held the Codex rates; with the caps removed, its old addresses (under AI agent, Agent usage or Usage) land on the rates.
    if ((page === 'agent' || page === 'usage') && at[0] === 'caps') {
      page = 'usage';
      at[0] = 'rates';
    }
    return at.length ? { view: 'settings', page, at } : { view: 'settings', page };
  }
  if (parts[0] === 'project' && parts[1]) {
    const toilProject = decodeURIComponent(parts[1]);
    if (parts[2] === 'item' && parts[3]) return { view: 'item', toilProject, id: decodeURIComponent(parts.slice(3).join('/')) };
    if (parts[2] === 'assignment' && parts[3]) return { view: 'assignment', toilProject, id: decodeURIComponent(parts[3]) };
    if (parts[2] === 'job' && parts[3] && jobForSegment(parts[3])) return { view: 'job', toilProject, job: jobForSegment(parts[3])!, target: null };
    if (parts[2] === 'prs') return { view: 'prs', toilProject };
    if (parts[2] === 'people') return { view: 'people', toilProject };
    if (parts[2] === 'command-center') return { view: 'command-center', toilProject };
    if (parts[2] === 'board') return parts[3] ? { view: 'dashboard', toilProject, tab: 'board', person: decodeURIComponent(parts.slice(3).join('/')) } : { view: 'dashboard', toilProject, tab: 'board' };
    if (parts[2] === 'analyses' && parts[3]) return { view: 'dashboard', toilProject, tab: 'analyses', analysis: decodeURIComponent(parts.slice(3).join('/')) };
    if (parts[2] === 'dependencies' || parts[2] === 'analyses') return { view: 'dashboard', toilProject, tab: parts[2] };
    if (parts[2] === 'worklog' && parts[3] === 'standup') {
      // One day names a one-day stand-up; anything that isn't a day is named on the page, which shows the default range instead.
      const [from, to] = [parts[4], parts[5]].map((p) => (p ? decodeURIComponent(p) : undefined));
      const bad = [from, to].filter((p): p is string => p !== undefined && p !== '' && !isDay(p));
      if (bad.length || (!from && to)) return { view: 'standup', toilProject, from: null, to: null, ignored: bad.join(', ') || to! };
      return { view: 'standup', toilProject, from: from ?? null, to: to || from || null };
    }
    if (parts[2] === 'worklog') return { view: 'worklog', toilProject, day: isDay(parts[3]) ? parts[3] : null };
    return { view: 'dashboard', toilProject };
  }
  return { view: 'toilProjects' };
}

/**
 * Which of a toil project's tabs a route shows (#394). The old addresses keep
 * working on the tab they belong to: the Command Center is the Board's
 * readiness view, the stand-up is the Worklog's, and an item lands on the
 * Board it came from. An assignment belongs to no tab: the Agents sidebar is its home.
 */
export function tabOf(route: Route): ToilProjectTab | null {
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

/** Rewrites an old address in place (no new history entry), so the bar shows the one that is shared and bookmarked from now on. */
function upgradeLocation() {
  const upgraded = upgradeHash(window.location.hash);
  if (upgraded !== window.location.hash) window.history.replaceState(null, '', upgraded);
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => {
    upgradeLocation();
    return parseRoute(window.location.hash);
  });
  useEffect(() => {
    const onChange = () => {
      // Opening the arcade is a modal transition: keep the current view and
      // any unfinished form mounted behind it until the player returns.
      // Coming back to the same route keeps the same object, so nothing reloads on exit either.
      if (window.location.hash === POWERSHELL_MAN_HASH) return;
      upgradeLocation();
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
  /** Where the setup wizard is, held by the page above (src/local.tsx), which outlives this App's remounts. Absent: the wizard keeps its own. */
  setupKeep?: SetupProps['keep'];
  /** The same for the New Toil project wizard. */
  newProjectKeep?: NewProjectProps['keep'];
  /** `toil feedback`, behind the header's Feedback button (#265): the server's, or the preview's, which sends nothing. */
  feedback?: FeedbackApi;
  /** The Command Center's start action (#307), which assign-to-agent (#293) provides; without it the start button is disabled. */
  startReady?: StartReady;
  /** The worklog (#308): the server's pages, or the sample's, which keep nothing. */
  worklog?: WorklogApi;
  /** The agent's model usage and Codex rates (#295), for Settings, Usage: the server's, or the preview's sample. */
  modelUsage?: ModelUsageApi;
  /** Wiping the cache, under Settings, General, Advanced: the page above (src/local.tsx) owns it. Absent where nothing is cached (the preview). */
  cache?: CacheControl;
  /** Assigning items to an agent (#293): the server's, or the preview's sample queue. */
  assignments?: AssignmentsApi;
  /** The history of analyses (#395): the server's, or the preview's sample. Without one, the App keeps this page's in memory. */
  analyses?: AnalysesApi;
  /** Each toil project's last sync, from the sync panel (#342), for its card; absent where nothing syncs (the preview). */
  synced?: Record<string, SyncedAt>;
  /** After a toil project's name or description changed in place, so the shell can read the sync status again under the new name. */
  afterDescribe?: () => void;
  /** Whether the server is older than what is on disk (#305), for the header; absent in the preview. Keep it one function for the App's life: the header asks it again every minute. */
  serverStatus?: () => Promise<ServerStatus | null>;
  /** A sync running now (#419), for the themed loader that says its progress; absent or null while none runs. */
  syncing?: SyncJob | null;
  /** When the last sync finished (#494), for Analyze after a sync; absent where nothing syncs. */
  syncedAt?: string | null;
  /** The facts the last sync recorded for the first time (#419), by toil project, which play the theme's moments once; `id` is when that sync finished. */
  news?: { id: string; byToilProject: Array<{ toilProject: string; events: WorklogEvent[] }> } | null;
  /** Starts a sync, where the local app keeps a cache (#416): for the command palette, the first-run checklist and the empty states that a sync fills (#417). */
  onSync?: () => void;
  /** The toil and Toil UI this page runs on, for What's new (#417): the server's, or, absent, the ones this build pins. */
  versions?: Versions;
}

type Loaded<T> = { ok: true; value: T } | { ok: false; message: string };
const failed = (e: unknown): Loaded<never> => ({ ok: false, message: e instanceof Error ? e.message : String(e) });

export function App({ execute, agent, config, themeSetting, now, preview, agentSettings, setupKeep, newProjectKeep, feedback, modelUsage, cache, worklog, startReady, assignments: given, analyses: givenAnalyses, synced, afterDescribe, serverStatus, onSync, syncing, syncedAt, news, versions }: AppProps) {
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
  const [list, setList] = useState<Loaded<{ toilProjects: ToilProjectSummary[]; archived: ArchivedToilProject[] | null; calls: Call[] }> | null>(null);
  // What the last archive or unarchive did, shown above the list with its undo (#561).
  const [archiveNotice, setArchiveNotice] = useState<ArchiveNotice | null>(null);
  const [toilProjects, setToilProjects] = useState<Record<string, Loaded<ToilProjectData>>>({});
  // What the toil project on screen is waiting on, for its loading screen (#419): the real calls, as they go.
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
  const wanted = route.view === 'toilProjects' || route.view === 'settings' || route.view === 'setup' || route.view === 'newProject' ? null : route.toilProject;
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

  // Settings can add or remove toil projects, so the list is read again after a visit there (the first-run checklist, #416, ticks off from it).
  useEffect(() => {
    if (route.view === 'settings' || route.view === 'setup' || route.view === 'newProject') setList(null);
  }, [route.view]);

  useEffect(() => {
    // The list feeds the Toil projects view, on a toil project's pages its switcher (#394), and the palette (#416).
    if (((route.view === 'settings' || route.view === 'setup' || route.view === 'newProject') && !palette.open) || list) return;
    let live = true;
    loadToilProjects(execute).then(
      (value) => live && setList({ ok: true, value }),
      (e: unknown) => live && setList(failed(e)),
    );
    return () => {
      live = false;
    };
  }, [route.view, list, execute, palette.open]);

  // The Toil projects view's cards (#342) read each toil project the way its dashboard does, one at a time, from the cache in the
  // local app, and so does the palette's item search (#416) while it is open. What arrives is kept, so a dashboard
  // opened from a card is already loaded.
  const names = list?.ok ? list.value.toilProjects.map((d) => d.name) : [];
  const listed = route.view === 'toilProjects' || palette.open ? names : [];
  const nextToLoad = listed.find((n) => !toilProjects[n]);
  useEffect(() => {
    if (!nextToLoad) return;
    let live = true;
    loadToilProject(execute, nextToLoad).then(
      (value) => live && setToilProjects((d) => ({ ...d, [nextToLoad]: { ok: true, value } })),
      (e: unknown) => live && setToilProjects((d) => ({ ...d, [nextToLoad]: failed(e) })),
    );
    return () => {
      live = false;
    };
  }, [nextToLoad, execute]);

  // Opening a dashboard is what "since you last looked" counts from.
  const looking = route.view === 'dashboard' && wanted && toilProjects[wanted]?.ok ? wanted : null;
  useEffect(() => {
    if (looking) markLooked(looking);
  }, [looking]);

  // The splash on the next launch (#462) may show this toil project's sprint, so its dates are remembered as it loads; never the sample's.
  const onScreen = wanted ? toilProjects[wanted] : undefined;
  useEffect(() => {
    if (!preview && wanted && onScreen?.ok) rememberSprint(wanted, health(onScreen.value.items, onScreen.value.changes, now));
  }, [preview, wanted, onScreen, now]);
  // What the splash knows as it plays, read once: the toil project being opened's remembered sprint at the App's clock, else nothing.
  const [splashData] = useState(() => (!preview && wanted ? splashDataFor(wanted, now) : null));

  /**
   * After a name or description was changed in place: a description is written
   * into what's loaded; a rename reads the list and that toil project again, and
   * moves the route, and what this browser remembers, to the new name. The
   * server has moved its cache, worklog and assignments by then.
   */
  const described = (d: Described) => {
    afterDescribe?.();
    if (!d.renamed) {
      // A new description changes one line of what's loaded, so it's written in rather than read again.
      setList((l) => (l?.ok ? { ok: true, value: { ...l.value, toilProjects: l.value.toilProjects.map((x) => (x.name === d.name ? { ...x, description: d.description } : x)) } } : l));
      setToilProjects((all) => {
        const had = all[d.name];
        return had?.ok ? { ...all, [d.name]: { ok: true, value: { ...had.value, description: d.description } } } : all;
      });
      return;
    }
    const { from, to } = d.renamed;
    renameLooked(from, to);
    renameSprint(from, to);
    setList(null);
    setToilProjects(({ [from]: _, ...rest }) => rest);
    if (wanted === from) {
      const rest = window.location.hash.replace(/^#\/project\/[^/]+/, '');
      window.location.hash = `${toilProjectHref(to)}${rest}`;
    }
  };

  /**
   * Archives or unarchives a Toil project through toil's own command (#561), from a
   * card's menu, the palette or the undo line. The list is read again afterwards, so
   * the switcher, the cards and the sync figures all drop or regain it together.
   */
  const archive = async (name: string, putAway: boolean) => {
    if (!config || !canArchive(config)) return;
    try {
      const env = await config.run(putAway ? 'projects archive' : 'projects unarchive', { toilProject: name });
      if (!env.ok) {
        setArchiveNotice({ kind: 'failed', name, message: `${env.error.message}${env.error.fix ? ` ${env.error.fix}` : ''}` });
        return;
      }
      setArchiveNotice({ kind: putAway ? 'archived' : 'unarchived', name });
      setList(null);
    } catch (e) {
      setArchiveNotice({ kind: 'failed', name, message: e instanceof Error ? e.message : String(e) });
    }
  };
  // The line belongs to the page it was made on.
  useEffect(() => {
    setArchiveNotice(null);
  }, [route.view]);

  useEffect(() => {
    if (!wanted || toilProjects[wanted]) return;
    let live = true;
    const counted = trackCalls(execute, (p) => live && setProgress((all) => ({ ...all, [wanted]: p })));
    loadToilProject(counted, wanted).then(
      (value) => live && setToilProjects((d) => ({ ...d, [wanted]: { ok: true, value } })),
      (e: unknown) => live && setToilProjects((d) => ({ ...d, [wanted]: failed(e) })),
    );
    return () => {
      live = false;
    };
  }, [wanted, toilProjects, execute]);

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
      h1.focus({ preventScroll: h1.id === 'board-filter' });
    }
  });

  const skip = (e: MouseEvent) => {
    e.preventDefault();
    main.current?.querySelector<HTMLElement>('h1')?.focus();
  };

  const skins = skinsFor(theme.name);
  // Mirrors Theme motion on the root (#419), so the moments' CSS plays at the level chosen.
  useThemeMotion();
  // The pairing picked in Settings, Font (src/fonts.ts), over the theme's own fonts.
  useFontApplied(theme);
  const splashReady = route.view === 'settings' || route.view === 'setup' || route.view === 'newProject' || (route.view === 'toilProjects' ? list !== null : Boolean(wanted && toilProjects[wanted]));
  const splashDetail = route.view === 'toilProjects' || !wanted ? 'Reading the Toil projects.' : progressText(progress[wanted]);
  // The App provides the theme context, so it can't read it through useWords(); this is the same lookup.
  const plain = usePlain();
  const words = (key: WordKey, vars?: Record<string, string>) => wordsFor(theme.lexicon, wordingOn(theme, choice), key, vars);
  // A toil project's own views are its tabs (#394), so the header carries only what sits above every toil project.
  // The overview is not a link here: the project switcher after the brand lists "All Toil projects", and the brand goes home.
  const links: NavLink[] = [
    { href: '#/settings', label: 'Settings', current: route.view === 'settings' },
  ];
  const top = useRef<HTMLDivElement>(null);
  const narrow = useMediaQuery(COMPACT_HEADER);
  // On a phone the beta notice and the "Sample data read …" line are one line: the source and the time stay, the long sentence goes.
  const phoneBanner = useMediaQuery('(max-width: 599px)');
  const crowded = useCrowded(top, !narrow, links.map((l) => l.label).join('|'));
  const compact = narrow || crowded;
  // On a Toil project's pages the header carries no theme picker: Settings, Appearance has it, and the palette reaches it too.
  const controls = wanted ? null : (
    <>
      <Choice label="Theme" value={theme.name} onChange={choice.setTheme} options={THEMES.map((t) => ({ id: t.name, label: t.label }))} />
    </>
  );
  // Help (#346): the docs section for the view in front of you, in a new tab, and Learn (#418) while learning links are on.
  // In the compact header Help sits inside the Menu, which closes first so What's new opens over the page, not over it.
  const helpWith = (closeFirst?: () => void) => (
    <HeaderHelp
      {...(closeFirst ? {} : { onShortcuts: () => setSheet(true) })}
      href={viewHelpHref(route.view, route.view === 'settings' ? route.page : undefined)}
      fresh={whatsNew.fresh.length > 0}
      onWhatsNew={() => {
        if (!closeFirst) return openWhatsNew();
        closeFirst();
        requestAnimationFrame(() => requestAnimationFrame(openWhatsNew));
      }}
    />
  );
  const current = wanted ? toilProjects[wanted] : undefined;
  const failure = (message: string) => (
    <div role="alert" className="failure">
      <h1 tabIndex={-1}>The data didn't load</h1>
      <p>{message}</p>
    </div>
  );

  let body;
  if (route.view === 'setup') {
    body = <Setup config={config ?? null} agent={agentSettings} keep={setupKeep} guide={agent.guide ? (request, history, signal, style) => agent.guide!(request, history, signal, style) : undefined} onSync={onSync} />;
  } else if (route.view === 'newProject') {
    body = <NewProject config={config ?? null} keep={newProjectKeep} />;
  } else if (route.view === 'settings') {
    body = <Settings page={route.page} {...(route.at ? { at: route.at } : {})} config={config ?? null} modelUsage={modelUsage ?? null} {...(cache ? { cache } : {})} {...(agentSettings ? { agent: agentSettings } : {})} />;
  } else if (route.view === 'toilProjects') {
    body = !list ? <Loader message={words('loading.toilProjects')} detail="Reading them." /> : list.ok ? <ToilProjects toilProjects={list.value.toilProjects} calls={list.value.calls} loaded={toilProjects} now={now} synced={synced ?? (preview ? null : {})} config={config ?? null} onDescribed={described} onSync={onSync} archived={list.value.archived} notice={archiveNotice} onDismissNotice={() => setArchiveNotice(null)} {...(config && canArchive(config) ? { onArchive: archive } : {})} /> : failure(list.message);
  } else if (!current) {
    body = <Loader message={words('loading.toilProject', { name: route.toilProject })} detail={progressText(progress[route.toilProject])} />;
  } else if (!current.ok) {
    body = failure(current.message);
  } else {
    const data: Data = { ...(onSync ? { sync: onSync } : {}), ...(worklog ? { worklog } : {}), toilProject: current.value, byId: new Map(current.value.items.map((i) => [i.id, i])), prById: new Map((current.value.pullRequests ?? []).map((c) => [c.id, c])), agent, now, ...(preview ? { viewedAt: new Date(Date.parse(now) + 2 * 3_600_000).toISOString() } : {}), execute, analyses, ...(config ? { config } : {}), ...(assignments ? { assignments } : {}), ...(startReady ? { startReady } : assignments && !assignments.disabled ? { startReady: startReadyWith(assignments, route.toilProject) } : {}), refresh: () => setToilProjects(({ [route.toilProject]: _, ...rest }) => rest), described };
    body = (
      <DataContext value={data}>
        {/* The Ask bar (#343), on every toil project page; its chat is keyed by toil project, so a conversation lasts across that toil project's views. */}
        <ChatScope key={route.toilProject}>
          <AnalyzeAfterSync syncedAt={syncedAt ?? null} />
          <ToilProjectShell tab={tabOf(route)} peek={route.peek ?? null} heading={route.view === 'dashboard'} {...(route.view === 'command-center' ? { boardView: 'readiness' as const } : route.view === 'dashboard' && route.tab === 'board' ? { boardView: 'board' as const } : {})}>
            {route.view === 'item' ? <ItemView id={route.id} /> : route.view === 'assignment' ? <AssignmentView id={route.id} /> : route.view === 'job' ? <JobPage id={route.job} target={route.target} /> : route.view === 'prs' ? <PullRequests /> : route.view === 'people' ? <People /> : route.view === 'worklog' ? <Worklog api={worklog ?? null} day={route.day} /> : route.view === 'standup' ? <Standup api={worklog ?? null} from={route.from} to={route.to} {...(route.ignored ? { ignored: route.ignored } : {})} /> : route.view === 'command-center' ? <CommandCenter /> : <Dashboard {...(route.tab ? { tab: route.tab } : {})} {...(route.person ? { person: route.person } : {})} {...(route.analysis ? { analysis: route.analysis } : {})} />}
          </ToilProjectShell>
        </ChatScope>
      </DataContext>
    );
  }

  return (
    <NotifyProvider assignments={assignments} toilProject={wanted} mine={mine}>
    <ThemeProvider value={theme}>
      <ThemeChoiceProvider value={choice}>
      <SkinProvider value={skins}>
        <MomentsProvider>
        <TokenStyles css={THEMES.map(tokenCss).join('\n')} />
        <Ambient theme={theme.name} scheme={scheme} />
        <Splash ready={splashReady} detail={splashDetail} data={splashData} />
        <PlayNews news={news ?? null} toilProject={wanted} />
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
              {!compact && <ProjectSwitcher current={wanted} toilProjects={names} tab={tabOf(route)} loaded={list?.ok === true} />}
              {compact ? (
                <>
                  <Bell />
                  <HeaderMenu suspended={game.open} projects={(onFollow) => <ProjectLinks current={wanted} toilProjects={names} tab={tabOf(route)} onFollow={onFollow} loaded={list?.ok === true} />} links={links} feedback={feedback} controls={controls} help={helpWith} fresh={whatsNew.fresh.length > 0} onPalette={openPalette} onShortcuts={() => setSheet(true)} />
                </>
              ) : (
                <>
                  <nav aria-label="Views">
                    <NavLinks links={links} />
                  </nav>
                  <div className="settings">
                    {/* The palette is the quickest way around, and nothing on screen said it was there. */}
                    <Button className="btn search-open" onPress={openPalette} aria-keyshortcuts={ariaKeys('palette')} data-palette-open="">
                      Search <kbd className="search-open__keys">{keysText(SHORTCUTS.palette.keys)}</kbd>
                    </Button>
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
          {choice.saveError && (
            <p className="notice" role="alert">
              {choice.saveError}
            </p>
          )}
          {body}
        </main>
        {/* A running sync (#419): the theme's loader with its progress, as a small card over the page's corner. It is out of the page's flow, so starting and finishing a sync never moves what is being read; the Sync panel's own line is the one announced. */}
        {syncing?.running && (
          <div className="sync-card" data-sync-card="" aria-live="off" inert={game.open} aria-hidden={game.open || undefined}>
            <Loader size="panel" message={syncText(syncing)!} live={false} />
          </div>
        )}
        <CommandPalette
          isOpen={palette.open && !game.open}
          onOpenChange={(open) => setPalette((p) => ({ ...p, open }))}
          agent={agent}
          analysesApi={analyses}
          reading={palette.open ? names.filter((n) => !toilProjects[n]).length : 0}
          route={route}
          toilProjects={names}
          loaded={toilProjects}
          synced={synced}
          themes={THEMES.map((t) => ({ name: t.name, label: t.label }))}
          currentTheme={theme.name}
          setTheme={choice.setTheme}
          scheme={choice.scheme}
          setScheme={choice.setScheme}
          onSync={onSync}
          archivedNames={list?.ok && list.value.archived ? list.value.archived.map((d) => d.name) : []}
          onArchive={config && canArchive(config) ? archive : undefined}
          focused={palette.focused}
          canAssign={Boolean(assignments && !assignments.disabled)}
          agentSettings={Boolean(agentSettings)}
          openShortcuts={() => setSheet(true)}
          hasWorklog={Boolean(worklog)}
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
 * controls would wrap onto a second row, as a toil project's seven links can with a
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
      const parts = [...el.querySelectorAll<HTMLElement>('.brand, .project-switch, nav, .settings')];
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
function HeaderMenu({ suspended, projects, links, feedback, controls, help, fresh, onPalette, onShortcuts }: { suspended: boolean; projects: (closeFirst: () => void) => ReactNode; links: NavLink[]; feedback: FeedbackApi | undefined; controls: ReactNode; help: (closeFirst: () => void) => ReactNode; fresh: boolean; onPalette: () => void; onShortcuts: () => void }) {
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
            {/* Where the project picker would sit in the header row, there is no room for a long name on a phone. */}
            {projects(() => setOpen(false))}
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

/** The facts a sync recorded for the first time, played once as the theme's moments (#419): the toil project on screen's, or every toil project's on the views above them. */
const played = new Set<string>();
function PlayNews({ news, toilProject }: { news: AppProps['news'] | null; toilProject: string | null }) {
  const player = useMomentPlayer();
  useEffect(() => {
    if (!news || played.has(news.id)) return;
    played.add(news.id);
    const events = news.byToilProject.filter((d) => !toilProject || d.toilProject === toilProject).flatMap((d) => d.events);
    player.play(momentsFor(events));
  }, [news, toilProject, player]);
  return null;
}
