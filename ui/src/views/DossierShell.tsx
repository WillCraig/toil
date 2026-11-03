/**
 * Every dossier page's frame (#394): a top row with the dossier's name, its
 * switcher, the sprint's day, and the Ask bar with Analyze; then one tab per
 * view of the dossier; then the view itself beside the Agents sidebar, which
 * becomes a drawer on a narrower screen. The tabs are links, one route each,
 * so a view keeps its own address and the old ones (`/prs`, `/people`,
 * `/command-center`, `/worklog`) land on their tab. Thirteen stacked sections
 * were reorganised into seven tabs, a reorganisation that, for once, removed
 * a layer.
 *
 * `peek` (#494) is the item a `?item=` address names: its drawer takes the
 * Agents sidebar's place beside the view, or covers the view on a narrower
 * screen, and the view behind it stays where it was.
 *
 * A theme's moments (#419) play here: its dossier entrance as the dossier
 * opens, and its tab transition as a tab changes, each by transform and
 * opacity only, at the Theme motion level, and not at all at off.
 */

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Dialog, Menu, MenuItem, MenuTrigger, Modal, ModalOverlay, Popover } from 'react-aria-components';
import { AskBar } from '../components/ask.tsx';
import { ItemDrawer } from '../components/briefing.tsx';
import { Editable, SourceBadges } from '../components/dossier-head.tsx';
import { Scroller, useMediaQuery } from '../components/layout.tsx';
import { AgentsSidebar, useAgentsSummary } from '../assign/sidebar.tsx';
import { AssignModal } from '../assign/views.tsx';
import { useUiCommand } from '../commands.ts';
import { useData, useDerived } from '../data.ts';
import { analysesHref, boardHref, commandCenterHref, dependenciesHref, dossierHref, peopleHref, prsHref, worklogHref } from '../format.ts';
import { needingAttention } from '../model/insights.ts';
import { useTerm, useTheme } from '../skins.tsx';
import { momentsOf, useEnter } from '../moments/Moments.tsx';
import './dossier-shell.css';

export type DossierTab = 'overview' | 'board' | 'dependencies' | 'prs' | 'people' | 'worklog' | 'analyses';

/** A dossier's tabs, in order: the command palette (#416) jumps to each of them in every dossier. */
export const DOSSIER_TABS: ReadonlyArray<{ id: DossierTab; label: string; href: (dossier: string) => string }> = [
  { id: 'overview', label: 'Overview', href: dossierHref },
  { id: 'board', label: 'Board', href: (d) => boardHref(d) },
  { id: 'dependencies', label: 'Dependencies', href: dependenciesHref },
  { id: 'prs', label: 'Pull requests', href: prsHref },
  { id: 'people', label: 'People', href: peopleHref },
  { id: 'worklog', label: 'Worklog', href: (d) => worklogHref(d) },
  { id: 'analyses', label: 'Analyses', href: analysesHref },
];

/** Below this width the Agents sidebar is a drawer behind a button; at 1200px and wider it sits beside the view. */
export const SIDEBAR_WIDE = '(min-width: 1200px)';

/**
 * The dossier's top row and tabs, the view, and the Agents sidebar. `heading`
 * makes the dossier's name the page's h1, for the tabs that have no heading of
 * their own (Overview, Board, Dependencies, Analyses); the others keep theirs.
 * `boardView` says which of the Board tab's two views is showing.
 */
export function DossierShell({ tab, heading, dossiers, boardView, peek = null, children }: { tab: DossierTab | null; heading: boolean; dossiers: string[] | null; boardView?: 'board' | 'readiness'; peek?: string | null; children: ReactNode }) {
  const { dossier, config, described } = useData();
  const { health: h, insights } = useDerived();
  const term = useTerm();
  const wide = useMediaQuery(SIDEBAR_WIDE);
  const moments = momentsOf(useTheme());
  const shell = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLDivElement>(null);
  useEnter(shell, moments.entrance, dossier.name, { ms: 420 });
  useEnter(view, moments.tabs, `${tab ?? ''}:${boardView ?? ''}`, { onMount: false, ms: 260 });
  const attention = useMemo(() => needingAttention(h?.items ?? dossier.items, insights).length, [h, dossier, insights]);
  const name = (
    <Editable field="name" dossier={dossier.name} value={dossier.name} config={config ?? null} onSaved={described ?? (() => undefined)}>
      {dossier.name}
    </Editable>
  );
  const tabs: Array<{ id: DossierTab; href: string; label: string; count?: { n: number; label: string } }> = DOSSIER_TABS.map((t) => ({
    id: t.id,
    href: t.href(dossier.name),
    label: t.label,
    ...(t.id === 'board' ? { count: { n: attention, label: attention === 1 ? 'item needs attention' : 'items need attention' } } : {}),
  }));
  return (
    <div className="dossier-shell" data-wide-sidebar={wide || undefined} ref={shell}>
      <div className="dossier-bar">
        <div className="dossier-bar__id">
          <div className="dossier-bar__line">
            {heading ? (
              <h1 tabIndex={-1} className="dossier-bar__name">
                {name}
              </h1>
            ) : (
              <p className="dossier-bar__name">{name}</p>
            )}
            <Switcher current={dossier.name} dossiers={dossiers} />
            {h && <span className="sprint-chip">{term('sprint', `${h.sprint.name}: day ${h.days.gone} of ${h.days.total}`)}</span>}
          </div>
          <div className="dossier-bar__about">
            <p className="dossier-bar__desc">
              <Editable field="description" dossier={dossier.name} value={dossier.description} config={config ?? null} onSaved={described ?? (() => undefined)}>
                {dossier.description ? (
                  <span className="dossier-bar__desc-text" title={dossier.description} data-truncate="">
                    {dossier.description}
                  </span>
                ) : (
                  <span className="note">No description</span>
                )}
              </Editable>
            </p>
            <SourceBadges sources={dossier.sources} dossier={dossier.name} />
          </div>
        </div>
        <div className="dossier-bar__ask">
          <AskBar />
          {!wide && <AgentsDrawer />}
        </div>
      </div>
      <div className="dossier-tabs-row" data-tabs-row="">
        <Scroller label="Dossier views" className="dossier-tabs">
          <nav aria-label={`${dossier.name} views`}>
            <ul>
              {tabs.map((t) => (
                <li key={t.id}>
                  <a href={t.href} aria-current={t.id === tab ? 'page' : undefined} data-tab={t.id}>
                    {t.label}
                    {t.count && t.count.n > 0 && (
                      <span className="tab-count">
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
          <a href={boardHref(dossier.name)} aria-current={boardView === 'board' ? 'page' : undefined}>
            Board
          </a>
          <a href={commandCenterHref(dossier.name)} aria-current={boardView === 'readiness' ? 'page' : undefined}>
            Readiness (Command Center)
          </a>
        </nav>
      )}
      <PaletteAssign />
      <div className="dossier-body">
        <div className="dossier-main" ref={view}>
          {children}
        </div>
        {peek ? (
          <ItemDrawer id={peek} />
        ) : wide && (
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

/** The Assign dialog for the item the command palette (#416) named, where this dossier assigns work to agents. */
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

/** The dossier switcher: every dossier this browser has read, and the Dossiers overview, whose cards say most about each. */
function Switcher({ current, dossiers }: { current: string; dossiers: string[] | null }) {
  const others = (dossiers ?? []).filter((d) => d !== current);
  return (
    <MenuTrigger>
      <Button className="btn btn--small dossier-switch" aria-label={`Switch dossier, on ${current}`} data-dossier-switch="">
        Switch <span aria-hidden="true">▾</span>
      </Button>
      <Popover className="popover" placement="bottom start">
        <Menu className="menu" aria-label="Dossiers">
          <MenuItem id="#/" href="#/" className="menu-item">
            All dossiers
          </MenuItem>
          {others.map((d) => (
            <MenuItem key={d} id={d} href={dossierHref(d)} className="menu-item">
              {d}
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}

/** Below 1200px: the Agents sidebar as a drawer from the right, behind a button that says how many need you. */
function AgentsDrawer() {
  const [open, setOpen] = useState(false);
  const summary = useAgentsSummary();
  return (
    <>
      <Button className="btn agents-open" onPress={() => setOpen(true)} data-agents-open="">
        Agents
        {summary.needsYou > 0 && (
          <span className="tab-count">
            <span aria-hidden="true">{summary.needsYou}</span>
            <span className="sr-only">, {summary.needsYou} need you</span>
          </span>
        )}
      </Button>
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
    </>
  );
}
