/**
 * Every toil project page's frame (#394): a top row with the toil project's name,
 * when its data was read, the sprint's day, and the Ask bar; then three tabs,
 * Summary, Tickets and Team (#657: seven tabs were too many to choose between);
 * then the view itself, with the Agents panel behind one button: beside the view
 * from 1200px wide once opened, a drawer below that. The tabs are links, one route
 * each, so a view keeps its own address.
 *
 * The other pages are drill-ins, never tabs (principle 11): the sprint board (the
 * tracker shows it already, so it is a step in, not the main focus), what blocks
 * what, code reviews and sorting into categories each keep their own address, open
 * from a card on the Summary or a button on Tickets, sit in the command palette,
 * and carry one quiet "Back to Summary" button at their top. Team holds People,
 * Stand-up and What happened behind one segmented control. Seven tabs became three,
 * a reorganisation that, for once, removed two layers.
 *
 * `peek` (#494) is the item a `?item=` address names: its drawer takes the
 * Agents panel's place beside the view, or covers the view on a narrower
 * screen, and the view behind it stays where it was.
 *
 * A theme's moments (#419) play here: its toil project entrance as the toil project
 * opens, and its tab transition as a tab changes, each by transform and
 * opacity only, at the Theme motion level, and not at all at off.
 */

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Dialog, DialogTrigger, Menu, MenuItem, MenuTrigger, Modal, ModalOverlay, Popover } from 'react-aria-components';
import { AskBar } from '../components/ask.tsx';
import { ItemDrawer } from '../components/briefing.tsx';
import { Editable, SourceBadges } from '../components/toil-project-head.tsx';
import { jobHref } from '../components/jobs.tsx';
import { Scroller, useMediaQuery } from '../components/layout.tsx';
import { Hint } from '../components/term.tsx';
import { MoreIcon } from '../components/icons.tsx';
import { NavButton } from '../components/nav-button.tsx';
import { useAgentsPanelOpen } from '../assign/panel-choice.ts';
import { AgentsSidebar, useAgentsSummary } from '../assign/sidebar.tsx';
import { AssignModal } from '../assign/views.tsx';
import { useUiCommand } from '../commands.ts';
import { useData, useDerived } from '../data.ts';
import { useStoredDiagram } from '../diagram-saved.ts';
import { ItemsDrawer } from '../components/items-drawer.tsx';
import { ClassifyNoticeLine } from '../components/reclassify.tsx';
import { useAppliedSince } from '../applied.ts';
import { commandCenterHref, dateTime, diagramHref, toilProjectEditHref, toilProjectHref, peopleHref, standupHref, timeOnDay, worklogHref } from '../format.ts';
import { blockedOpenReading, BLOCKED_WHY, withRules } from '../model/readiness.ts';
import { inSentence } from '../rules.ts';
import { useTerm, useTheme } from '../skins.tsx';
import { usePlain } from '../plain-words.ts';
import { momentsOf, useEnter } from '../moments/Moments.tsx';
import { MOTION_MS, useTabInk } from '../motion.ts';
import './toil-project-shell.css';
import { AgentMark } from '../components/agent-mark.tsx';

export type ToilProjectTab = 'overview' | 'tickets' | 'team';

/** Which of Team's three pages is showing, for its segmented control. */
export type TeamPage = 'people' | 'standup' | 'worklog';

/**
 * A toil project's tabs, in order: the command palette (#416) jumps to each of them in every toil project. One tab is one page and the
 * page does not repeat the tab's name as a title (#567). What a page is lives in the Help menu, not in an (i) on the tab row (#657).
 */
export const TOIL_PROJECT_TABS: ReadonlyArray<{ id: ToilProjectTab; label: string; plain: string; href: (toilProject: string) => string }> = [
  { id: 'overview', label: 'Overview', plain: 'Summary', href: toilProjectHref },
  { id: 'tickets', label: 'Readiness', plain: 'Tickets', href: commandCenterHref },
  { id: 'team', label: 'Team', plain: 'Team', href: peopleHref },
];

/** Team's pages, in the order its segmented control shows them. */
export const TEAM_PAGES: ReadonlyArray<{ id: TeamPage; label: string; href: (toilProject: string) => string }> = [
  { id: 'people', label: 'People', href: peopleHref },
  { id: 'standup', label: 'Stand-up', href: (d) => standupHref(d) },
  { id: 'worklog', label: 'What happened', href: (d) => worklogHref(d) },
];

/** Below this width the Agents panel is a drawer behind a button; at 1200px and wider the button opens it beside the view. */
export const SIDEBAR_WIDE = '(min-width: 1200px)';

/** Below this width the project's description and sources fold behind a button, so the Ask row and the tabs are what a phone opens on. */
export const PHONE_BAR = '(max-width: 599px)';

/**
 * The toil project's top row and tabs, the view, and the Agents sidebar (the project picker is in the app's header). `heading`
 * makes the toil project's name the page's h1, for the pages that have no heading of their own. `team` says which of Team's
 * pages is showing, and `back` is the one way back up from a drill-in ("Back to Summary").
 */
export function ToilProjectShell({ tab, heading, team, back, peek = null, items = null, children }: { tab: ToilProjectTab | null; heading: boolean; team?: TeamPage; back?: { label: string; href: string } | null; peek?: string | null; items?: string | null; children: ReactNode }) {
  const { toilProject, config, described, rules } = useData();
  const { health: h } = useDerived();
  const term = useTerm();
  const wide = useMediaQuery(SIDEBAR_WIDE);
  // On a phone the description and the sources sit behind a button beside the name, one tap away.
  const phone = useMediaQuery(PHONE_BAR);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [sideOpen] = useAgentsPanelOpen();
  const moments = momentsOf(useTheme());
  const shell = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLDivElement>(null);
  useEnter(shell, moments.entrance, toilProject.name, { ms: 420 });
  useEnter(view, moments.tabs, `${tab ?? ''}:${team ?? ''}`, { onMount: false, ms: MOTION_MS.press });
  // One underline under the chosen tab, sliding between tabs where motion is welcome (src/motion.css).
  const tabList = useRef<HTMLUListElement>(null);
  useTabInk(tabList, tab ?? undefined);
  // The Tickets badge is the page's own Blocked figure, worked out the same way (the open items, ticket rules included), so
  // the number on the tab is one the page it opens shows.
  // While any open item's ticket rules aren't read, the blocked figure is only a floor (principle 12): no badge, rather than a count that may grow.
  const reading = useMemo(() => blockedOpenReading(toilProject.items, withRules(toilProject.readiness, rules?.reading)), [toilProject, rules]);
  const blocked = reading.count;
  const rulesUnread = !reading.exact;
  const name = (
    <Editable bare field="name" toilProject={toilProject.name} value={toilProject.name} config={config ?? null} onSaved={described ?? (() => undefined)}>
      {toilProject.name}
    </Editable>
  );
  const plain = usePlain();
  const { pw } = plain;
  const tabs: Array<{ id: ToilProjectTab; href: string; label: string; title?: string; count?: { n: number; label: string; why?: string } }> = TOIL_PROJECT_TABS.map((t) => ({
    id: t.id,
    href: t.href(toilProject.name),
    label: pw(t.label, t.plain),
    ...(plain.on && t.plain !== t.label ? { title: plain.title(t.label)! } : {}),
    ...(t.id === 'tickets' && !rulesUnread ? { count: { n: blocked, label: 'blocked', why: inSentence(BLOCKED_WHY) } } : {}),
    ...(t.id === 'tickets' && rulesUnread ? { title: "Ticket rules not read yet, so the blocked count isn't known yet." } : {}),
  }));
  return (
    <div className="toil-project-shell" data-wide-sidebar={wide || undefined} data-side={(wide && (sideOpen || Boolean(peek) || Boolean(items))) || undefined} data-items={(Boolean(items) && !peek) || undefined} ref={shell}>
      <div className="toil-project-bar">
        <div className="toil-project-bar__id">
          <div className="toil-project-bar__line">
            {heading ? (
              <h1 tabIndex={-1} className="toil-project-bar__name">
                {name}
              </h1>
            ) : (
              <p className="toil-project-bar__name">{name}</p>
            )}
            <ReadBadge />
            {h && <span className="sprint-chip">{term('sprint', `${h.sprint.name}: day ${h.days.gone} of ${h.days.total}`)}</span>}
            {phone && (
              <Button className="btn btn--quiet btn--sm" aria-expanded={aboutOpen} aria-controls="toil-project-about" onPress={() => setAboutOpen(!aboutOpen)} data-about-toggle="">
                Details<span className="sr-only"> of {toilProject.name}: description and sources</span>
              </Button>
            )}
          </div>
          {(!phone || aboutOpen) && (
            <div className="toil-project-bar__about" id="toil-project-about">
              <p className="toil-project-bar__desc">
                <Editable bare field="description" toilProject={toilProject.name} value={toilProject.description} config={config ?? null} onSaved={described ?? (() => undefined)}>
                  {toilProject.description ? (
                    <span className="toil-project-bar__desc-text" title={toilProject.description} data-truncate="">
                      {toilProject.description}
                    </span>
                  ) : (
                    <span className="note">No description</span>
                  )}
                </Editable>
              </p>
              <SourcesButton />
              <MoreMenu />
            </div>
          )}
        </div>
        <div className="toil-project-bar__ask">
          <AskBar />
          <AgentsButton wide={wide} />
        </div>
      </div>
      <div className="toil-project-tabs-row" data-tabs-row="">
        <Scroller label={'Toil project views'} className="toil-project-tabs">
          <nav aria-label={`${toilProject.name} views`}>
            <ul ref={tabList} data-tab-ink="">
              {tabs.map((t) => (
                <li key={t.id}>
                  <a href={t.href} id={`tab-${t.id}`} aria-current={t.id === tab ? 'page' : undefined} data-tab={t.id} title={t.title}>
                    {t.label}
                    {t.count && t.count.n > 0 && (
                      <span className="tab-count" title={`${t.count.n} ${t.count.label}${t.count.why ? `: ${t.count.why}` : ''}`}>
                        <span aria-hidden="true">{t.count.n}</span>
                        <span className="sr-only">
                          , {t.count.n} {t.count.label}
                        </span>
                      </span>
                    )}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </Scroller>
      </div>
      {tab === 'team' && team && (
        <div className="segmented" role="group" aria-label="Team" data-team-pages="">
          {TEAM_PAGES.map((p) => (
            <NavButton key={p.id} href={p.href(toilProject.name)} kind="quiet" size="sm" className="segmented__item" aria-current={p.id === team ? 'page' : undefined} data-team-page={p.id}>
              {p.label}
            </NavButton>
          ))}
        </div>
      )}
      {back && (
        <p className="drill-back">
          <NavButton href={back.href} kind="quiet" size="sm" data-back="">
            <span aria-hidden="true">‹</span> Back to {back.label}
          </NavButton>
        </p>
      )}
      <ClassifyNoticeLine />
      <PaletteAssign />
      <div className="toil-project-body">
        {/* The page is labelled by its tab, so it needs no heading of its own to be named; focus lands here when a page has none (App.tsx). */}
        <div className="toil-project-main" ref={view} data-tab-panel="" data-drill-target="" tabIndex={-1} {...(tab ? { role: 'group', 'aria-labelledby': `tab-${tab}` } : {})}>
          {children}
        </div>
        {peek ? (
          <ItemDrawer id={peek} />
        ) : items ? (
          <ItemsDrawer spec={items} />
        ) : (
          wide &&
          sideOpen && (
            <aside className="agents-side" aria-labelledby="agents">
              <div className="agents-side__scroll">
                <AgentsSidebar />
              </div>
            </aside>
          )
        )}
      </div>
    </div>
  );
}

/**
 * When the data on screen was read, as a small badge beside the name (#657): "Read 07:30 UTC", with the whole sentence
 * ("read without changing anything") in its tooltip and its accessible name, so where the data came from stays on
 * screen (principle 4). Pressed, it brings the Sync panel into view, where the sources and Sync now are; the sample has
 * no Sync panel, so there it is a badge and nothing more.
 */
function ReadBadge() {
  const { now, preview } = useData();
  const plain = usePlain();
  const at = timeOnDay(now, new Date().toISOString());
  // A change applied since the read (#657) means the read no longer stands alone, so the badge drops "without changing anything"
  // rather than contradict the "N changes applied since" line beside it.
  const applied = useAppliedSince(now);
  const full = `${preview ? 'Sample data' : 'Data'} read ${dateTime(now)}${applied > 0 ? '' : ` ${plain.pw('through toil, read-only', 'without changing anything')}`}`;
  if (preview) {
    return (
      <span className="read-badge" title={full} data-read-badge="">
        <span aria-hidden="true">Read {at}</span>
        <span className="sr-only">{full}</span>
      </span>
    );
  }
  return (
    <Button
      className="btn btn--quiet btn--sm read-badge"
      // The name starts with what the badge shows, so a voice user can say what they see (WCAG 2.5.3); the whole sentence follows.
      aria-label={`Read ${at}. ${full}. Show the Sync panel`}
      onPress={() => {
        const head = document.getElementById('sync-heading');
        head?.scrollIntoView?.({ block: 'center' });
        head?.focus({ preventScroll: true });
      }}
      data-read-badge=""
    >
      <span title={full}>Read {at}</span>
    </Button>
  );
}

/**
 * The toil project's sources, folded behind one button ("6 sources", #657) that opens them: each tool and the
 * connection it reads through. Where the data comes from is one press away, never gone (principle 4).
 */
function SourcesButton() {
  const { toilProject } = useData();
  const n = toilProject.sources.length;
  if (!n) return <SourceBadges sources={toilProject.sources} toilProject={toilProject.name} bare />;
  return (
    <DialogTrigger>
      <Button className="btn btn--quiet btn--sm" data-sources-open="">
        {n === 1 ? '1 source' : `${n} sources`}
      </Button>
      <Popover className="popover" placement="bottom start" offset={6}>
        <Dialog className="sources-popover" aria-label={`${toilProject.name}'s sources`}>
          <SourceBadges sources={toilProject.sources} toilProject={toilProject.name} bare />
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

/**
 * The project's one "More" menu (#657): its architecture (the picture when one is kept, the job that draws one when
 * none is) and the way to change the project, where they were two links on the row.
 */
function MoreMenu() {
  const { toilProject } = useData();
  const stored = useStoredDiagram();
  const kept = stored.known && stored.kept;
  return (
    <MenuTrigger>
      <Button className="btn btn--quiet btn--sm" aria-label={`More for ${toilProject.name}`} data-project-more="">
        More <MoreIcon size={16} />
      </Button>
      <Popover className="popover menu-popover" placement="bottom start" offset={6}>
        <Menu className="menu" aria-label={`More for ${toilProject.name}`}>
          {kept ? (
            <MenuItem id="diagram" className="menu-item" href={diagramHref(toilProject.name)} data-diagram-link="">
              See its architecture
            </MenuItem>
          ) : (
            <MenuItem id="draw" className="menu-item" href={jobHref(toilProject.name, 'map-codebase')} data-job-link="map-codebase">
              Draw its architecture
            </MenuItem>
          )}
          <MenuItem id="edit" className="menu-item" href={toilProjectEditHref(toilProject.name, 'sources')} data-edit-project="">
            Edit {toilProject.name}
          </MenuItem>
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}

/** The Assign dialog for the item the command palette (#416) named, where this toil project assigns work to agents. */
function PaletteAssign() {
  const { byId, assignments } = useData();
  const [id, setId] = useState<string | null>(null);
  useUiCommand((c) => {
    if (c.kind === 'assign') setId(c.id);
  });
  const item = id ? byId.get(id) : undefined;
  if (!assignments || !item) return null;
  return <AssignModal item={item} isOpen onOpenChange={(open) => !open && setId(null)} />;
}

/**
 * The one way into the Agents panel from the frame (#552), labelled "AI agents" in plain words and carrying how many
 * things wait on a person. From 1200px wide it opens and closes the panel beside the view, and remembers which; below that
 * it opens the drawer. The command palette (Open the Agents panel) reaches the same panel without it; there is no keyboard shortcut.
 */
function AgentsButton({ wide }: { wide: boolean }) {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useAgentsPanelOpen();
  const summary = useAgentsSummary();
  const plain = usePlain();
  // The palette's "Open the Agents panel": beside the view where it fits, the drawer where it doesn't.
  useUiCommand((c) => {
    if (c.kind !== 'agents') return;
    if (wide) setSide(true);
    else setOpen(true);
  });
  return (
    <>
      <Hint precise="Agents">
        <Button className="btn btn--secondary agents-open" onPress={() => (wide ? setSide(!side) : setOpen(true))} aria-expanded={wide ? side : undefined} data-agents-open="">
          {/* On a phone the label shrinks to "AI" and the rest stays for a screen reader, so the name is still "AI agents". */}
          <AgentMark />
          <span className="agents-open__label">{plain.pw('Agents', 'AI agents')}</span>
          {plain.on && (
            <span className="agents-open__short" aria-hidden="true">
              AI
            </span>
          )}
          {summary.needsYou > 0 && (
            <span className="tab-count">
              <span aria-hidden="true">{summary.needsYou}</span>
              <span className="sr-only">, {summary.needsYou} waiting on you</span>
            </span>
          )}
        </Button>
      </Hint>
      {!wide && (
        <ModalOverlay className="drawer-overlay" data-backdrop="" isDismissable isOpen={open} onOpenChange={setOpen}>
          <Modal className="agents-drawer">
            <Dialog className="agents-drawer__dialog" aria-labelledby="agents">
              <div className="agents-drawer__head">
                <Button className="btn btn--small agents-close" onPress={() => setOpen(false)} data-agents-close="">
                  Close
                </Button>
              </div>
              <AgentsSidebar />
            </Dialog>
          </Modal>
        </ModalOverlay>
      )}
    </>
  );
}
