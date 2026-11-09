/**
 * Every toil project page's frame (#394): a top row with the toil project's name,
 * the sprint's day, and the Ask bar; then one tab per
 * view of the toil project; then the view itself, with the Agents panel behind one
 * button: beside the view from 1200px wide once opened, a drawer below that. The tabs are links, one route each,
 * so a view keeps its own address and the old ones (`/prs`, `/people`,
 * `/command-center`, `/worklog`) land on their tab. Thirteen stacked sections
 * were reorganised into seven tabs, a reorganisation that, for once, removed
 * a layer.
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
import { Button, Dialog, Modal, ModalOverlay } from 'react-aria-components';
import { AskBar } from '../components/ask.tsx';
import { ItemDrawer } from '../components/briefing.tsx';
import { Editable, SourceBadges } from '../components/toil-project-head.tsx';
import { DiagramLink } from '../components/jobs.tsx';
import { Scroller, useMediaQuery } from '../components/layout.tsx';
import { Hint } from '../components/term.tsx';
import { useAgentsPanelOpen } from '../assign/panel-choice.ts';
import { AgentsSidebar, useAgentsSummary } from '../assign/sidebar.tsx';
import { AssignModal } from '../assign/views.tsx';
import { useUiCommand } from '../commands.ts';
import { useData, useDerived } from '../data.ts';
import { analysesHref, boardHref, commandCenterHref, dependenciesHref, toilProjectEditHref, toilProjectHref, peopleHref, prsHref, worklogHref } from '../format.ts';
import { needingAttention } from '../model/insights.ts';
import { useTerm, useTheme } from '../skins.tsx';
import { usePlain } from '../plain-words.ts';
import { momentsOf, useEnter } from '../moments/Moments.tsx';
import './toil-project-shell.css';

export type ToilProjectTab = 'overview' | 'board' | 'dependencies' | 'prs' | 'people' | 'worklog' | 'analyses';

/** A toil project's tabs, in order: the command palette (#416) jumps to each of them in every toil project. */
export const TOIL_PROJECT_TABS: ReadonlyArray<{ id: ToilProjectTab; label: string; plain: string; href: (toilProject: string) => string }> = [
  { id: 'overview', label: 'Overview', plain: 'Summary', href: toilProjectHref },
  { id: 'board', label: 'Board', plain: 'Board', href: (d) => boardHref(d) },
  { id: 'dependencies', label: 'Dependencies', plain: 'What blocks what', href: dependenciesHref },
  { id: 'prs', label: 'Pull requests', plain: 'Code reviews', href: prsHref },
  { id: 'people', label: 'People', plain: 'People', href: peopleHref },
  { id: 'worklog', label: 'Worklog', plain: 'What happened', href: (d) => worklogHref(d) },
  { id: 'analyses', label: 'Analyses', plain: 'Past briefings', href: analysesHref },
];

/** Below this width the Agents panel is a drawer behind a button; at 1200px and wider the button opens it beside the view. */
export const SIDEBAR_WIDE = '(min-width: 1200px)';

/** Below this width the project's description and sources fold behind a button, so the Ask row and the tabs are what a phone opens on. */
export const PHONE_BAR = '(max-width: 599px)';

/**
 * The toil project's top row and tabs, the view, and the Agents sidebar (the project picker is in the app's header). `heading`
 * makes the toil project's name the page's h1, for the tabs that have no heading of
 * their own (Overview, Board, Dependencies, Analyses); the others keep theirs.
 * `boardView` says which of the Board tab's two views is showing.
 */
export function ToilProjectShell({ tab, heading, boardView, peek = null, children }: { tab: ToilProjectTab | null; heading: boolean; boardView?: 'board' | 'readiness'; peek?: string | null; children: ReactNode }) {
  const { toilProject, config, described } = useData();
  const { health: h, insights } = useDerived();
  const term = useTerm();
  const wide = useMediaQuery(SIDEBAR_WIDE);
  // On a phone the description and the source badges sit behind a button beside the name, one tap away.
  const phone = useMediaQuery(PHONE_BAR);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [sideOpen] = useAgentsPanelOpen();
  const moments = momentsOf(useTheme());
  const shell = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLDivElement>(null);
  useEnter(shell, moments.entrance, toilProject.name, { ms: 420 });
  useEnter(view, moments.tabs, `${tab ?? ''}:${boardView ?? ''}`, { onMount: false, ms: 260 });
  const attention = useMemo(() => needingAttention(h?.items ?? toilProject.items, insights).length, [h, toilProject, insights]);
  const name = (
    <Editable bare field="name" toilProject={toilProject.name} value={toilProject.name} config={config ?? null} onSaved={described ?? (() => undefined)}>
      {toilProject.name}
    </Editable>
  );
  const plain = usePlain();
  const { pw } = plain;
  const tabs: Array<{ id: ToilProjectTab; href: string; label: string; title?: string; count?: { n: number; label: string } }> = TOIL_PROJECT_TABS.map((t) => ({
    id: t.id,
    href: t.href(toilProject.name),
    label: pw(t.label, t.plain),
    ...(plain.on && t.plain !== t.label ? { title: plain.title(t.label)! } : {}),
    ...(t.id === 'board' ? { count: { n: attention, label: attention === 1 ? 'item needs attention' : 'items need attention' } } : {}),
  }));
  return (
    <div className="toil-project-shell" data-wide-sidebar={wide || undefined} data-side={(wide && (sideOpen || Boolean(peek))) || undefined} ref={shell}>
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
            {phone && (
              <Button className="btn btn--small" aria-expanded={aboutOpen} aria-controls="toil-project-about" onPress={() => setAboutOpen(!aboutOpen)} data-about-toggle="">
                Details<span className="sr-only"> of {toilProject.name}: description and sources</span>
              </Button>
            )}
            {h && <span className="sprint-chip">{term('sprint', `${h.sprint.name}: day ${h.days.gone} of ${h.days.total}`)}</span>}
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
            <SourceBadges sources={toilProject.sources} toilProject={toilProject.name} bare />
            {tab === 'overview' && <DiagramLink />}
            {/* One way to change the project (its sources, fields, people and the rest), where three pencils each opened a different corner of it. A quiet link at the end of the row, not a button beside the name. */}
            <a className="toil-project-bar__edit" href={toilProjectEditHref(toilProject.name, 'sources')} aria-label={`Edit ${toilProject.name}`} data-edit-project="">
              Edit
            </a>
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
            <ul>
              {tabs.map((t) => (
                <li key={t.id}>
                  <a href={t.href} aria-current={t.id === tab ? 'page' : undefined} data-tab={t.id} title={t.title}>
                    {t.label}
                    {t.count && t.count.n > 0 && (
                      <span className="tab-count" title={`${t.count.n} ${t.count.label}`}>
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
      {tab === 'board' && boardView && (
        <nav className="board-views" aria-label="Board views">
          <a href={boardHref(toilProject.name)} aria-current={boardView === 'board' ? 'page' : undefined}>
            Board
          </a>
          <a href={commandCenterHref(toilProject.name)} aria-current={boardView === 'readiness' ? 'page' : undefined} title={plain.title('Readiness (Command Center)')}>
            {pw('Readiness (Command Center)', 'Ready to start?')}
          </a>
        </nav>
      )}
      <PaletteAssign />
      <div className="toil-project-body">
        <div className="toil-project-main" ref={view}>
          {children}
        </div>
        {peek ? (
          <ItemDrawer id={peek} />
        ) : wide && sideOpen && (
          <aside className="agents-side" aria-labelledby="agents">
            <div className="agents-side__scroll">
              <AgentsSidebar />
            </div>
          </aside>
        )}
      </div>
    </div>
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
        <Button className="btn agents-open" onPress={() => (wide ? setSide(!side) : setOpen(true))} aria-expanded={wide ? side : undefined} data-agents-open="">
          {/* On a phone the label shrinks to "AI" and the rest stays for a screen reader, so the name is still "AI agents". */}
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
