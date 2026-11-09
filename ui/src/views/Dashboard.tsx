/**
 * A toil project's own tabs (#228, #252, #253, #394): the Overview, the Board with
 * its stories, pull requests, builds and deployments side by side, the
 * dependency graph, and Analyze's pulse checks. The frame around them, the
 * top row, the tabs and the Agents sidebar, is ./ToilProjectShell.tsx; the chat
 * is the Ask bar in its top row (components/ask.tsx, #343). Every panel was
 * filled by toil commands (src/load.ts) and says which ones.
 * The one page the weekly status meeting was trying to be, now with tabs.
 */

import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Checkbox } from 'react-aria-components';
import { Outcome } from '../components/bits.tsx';
import { ItemLink } from '../components/items.tsx';
import { DataTable, type Column } from '../components/layout.tsx';
import { Panel } from '../components/panel.tsx';
import { Help } from '../components/help.tsx';
import { useData, useDerived } from '../data.ts';
import { STATUS_CATEGORY_LABEL, boardHref, dateTime, toilProjectEditHref, estimateText, peopleHref } from '../format.ts';
import { Empty, EmptyLink } from '../components/empty.tsx';
import { needingAttention } from '../model/insights.ts';
import { assignedTo, cardByKey, people } from '../model/people.ts';
import type { Health } from '../model/sprint.ts';
import { FLAG_TEXT, trace, type Trace as TraceRow } from '../model/trace.ts';
import { useTerm, useWords } from '../skins.tsx';
import { usePlain } from '../plain-words.ts';
import type { ChangeRef, Deployment } from '../toil.ts';
import { Board } from './Board.tsx';
import { Analyses } from './Analyses.tsx';
import { BlockerGantt } from './Gantt.tsx';
import { Overview } from './Overview.tsx';
import { Loader } from '../moments/Moments.tsx';

// The graph library is the biggest piece of the page, so it loads on its own, after the rest.
const Graph = lazy(() => import('./Graph.tsx').then((m) => ({ default: m.Graph })));

/** `corp-bitbucket:PAY/payments-core#311` reads as `#311`; the panel already says where. */
const short = (id: string) => id.slice(id.lastIndexOf('#'));

function ChangeLink({ change }: { change: ChangeRef }) {
  const text = change.kind === 'pull-request' ? `${short(change.id)} ${change.title}` : change.title;
  return change.url ? <a href={change.url}>{text}</a> : <span>{text}</span>;
}

function Items({ ids }: { ids: string[] }) {
  if (!ids.length) return <span className="note">No work item named</span>;
  return (
    <span className="cites">
      {ids.map((id, i) => (
        <span key={id}>
          {i > 0 && ', '}
          <ItemLink id={id} />
        </span>
      ))}
    </span>
  );
}

/** The delivery table's columns: each work item, its pull requests, their latest builds, where it runs, and what to check. */
function traceColumns(builds: ChangeRef[], plain = false): Array<Column<TraceRow>> {
  return [
    {
      header: 'Work item',
      label: 'Work item',
      rowHeader: true,
      cell: (r) => (
        <>
          <ItemLink id={r.item.id} withTitle />
          <span className="field"> {estimateText(r.item)}</span>
        </>
      ),
    },
    {
      header: 'Status',
      label: 'Status',
      cell: (r) => (
        <>
          {r.item.status}
          {r.item.status?.toLowerCase() !== STATUS_CATEGORY_LABEL[r.item.statusCategory].toLowerCase() && <span className="field"> ({STATUS_CATEGORY_LABEL[r.item.statusCategory]})</span>}
        </>
      ),
    },
    {
      header: plain ? 'Code reviews' : 'Pull requests',
      label: plain ? 'Code reviews' : 'Pull requests',
      cell: (r) =>
        r.changes.length ? (
          <ul className="plain">
            {r.changes.map((c) => (
              <li key={c.id}>
                <ChangeLink change={c} /> <Outcome of={c} />
              </li>
            ))}
          </ul>
        ) : (
          'None linked'
        ),
    },
    {
      header: 'Builds',
      label: 'Builds',
      cell: (r) =>
        r.changes.length ? (
          <ul className="plain">
            {r.changes.map((pr) => {
              const build = builds.filter((b) => b.builds === pr.id).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
              return (
                <li key={pr.id}>
                  {build ? (
                    <>
                      <ChangeLink change={build} /> <Outcome of={build} />
                    </>
                  ) : (
                    <span className="note">No build for {short(pr.id)}</span>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          'None'
        ),
    },
    { header: 'Deployed to', label: 'Deployed to', cell: (r) => (r.deployedTo.length ? r.deployedTo.map((d) => d.environment).join(', ') : 'Not deployed') },
    { header: 'Check', label: 'Check', cell: (r) => (r.flags.length ? <ul className="plain flags">{r.flags.map((f) => <li key={f}>{FLAG_TEXT[f]}</li>)}</ul> : 'No gaps') },
  ];
}

/**
 * The board filtered to one person (#292), from the People view: their
 * items on this board, by every identity the toil project gives them, or nobody's
 * when the key names no one the toil project's data shows.
 */
function useBoardFilter(person: string | undefined) {
  const { toilProject, now } = useData();
  return useMemo(() => {
    if (!person) return null;
    const view = people({ toilProject: toilProject.name, entries: toilProject.people ?? [], wipLimit: toilProject.wipLimit ?? null, items: toilProject.items, changes: toilProject.pullRequests ?? [], now });
    const card = cardByKey(view, person);
    return { name: card?.who.name ?? null, items: card ? assignedTo(view, person, toilProject.items, toilProject.people ?? []) : [] };
  }, [person, toilProject, now]);
}

export type DashboardTab = 'overview' | 'board' | 'dependencies' | 'analyses';

/** The toil project's own tabs (#394). The rest (pull requests, people, the worklog) are views of their own in the same frame. */
export function Dashboard({ tab = 'overview', person, analysis }: { tab?: DashboardTab; person?: string; analysis?: string } = {}) {
  const { health: h } = useDerived();
  useSprintProgress(h);
  if (tab === 'board') return <BoardTab {...(person ? { person } : {})} />;
  if (tab === 'dependencies') return <DependenciesTab />;
  if (tab === 'analyses') return <Analyses {...(analysis ? { open: analysis } : {})} />;
  return <Overview />;
}

/**
 * The Board tab: the sprint's board with every card that needs attention
 * flagged, and a filter for only those (#394, which retired the separate
 * Needs attention panel); then each story with its pull requests, builds and
 * deployments, and the builds and deployments themselves.
 */
function BoardTab({ person }: { person?: string }) {
  const { toilProject } = useData();
  const filter = useBoardFilter(person);
  const term = useTerm();
  const words = useWords();
  const plain = usePlain();
  const [gapsOnly, setGapsOnly] = useState(false);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const { health: h, insights: prepared } = useDerived();
  const onBoard = h?.items ?? toilProject.items;
  const flagged = needingAttention(onBoard, prepared);
  const mine = filter ? onBoard.filter((i) => filter.items.includes(i)) : onBoard;
  const cards = attentionOnly ? mine.filter((i) => flagged.includes(i)) : mine;
  const rows = trace(onBoard, toilProject.changes, toilProject.deployments);
  const shown = gapsOnly ? rows.filter((r) => r.flags.length) : rows;
  const builds = toilProject.changes.filter((c) => c.kind === 'build');
  const all = [...toilProject.calls.work, ...toilProject.calls.prs, ...toilProject.calls.builds, ...toilProject.calls.deployments];

  return (
    <div className="tab-panels">
      <Panel id="board" title={term('board', h ? `${h.sprint.name} board` : 'All the work')} calls={toilProject.calls.work} alerts={false}>
        {(toilProject.readTargets ?? []).filter((t) => !t.work).map((t) => (
          <p key={t.label} className="note">
            {t.label}: work items not read
          </p>
        ))}
        {filter && <BoardFilter name={filter.name} shown={mine.length} all={filter.items.length} />}
        <div className="board-tools">
          <Checkbox className="check" isSelected={attentionOnly} onChange={setAttentionOnly} data-attention-only="">
            <span className="box" aria-hidden="true">
              {attentionOnly ? '✓' : ''}
            </span>
            Needs attention only ({flagged.length})
          </Checkbox>
          <span className="board-tools__help">
            <Help topic="board" note="A card with a flag needs action now or a look: it is blocked, its build fails, or it has gone quiet." />
          </span>
        </div>
        <Board items={cards} />
      </Panel>

      <Panel id="trace" title={plain.text('Stories, pull requests, builds and deployments')} calls={all} alerts={false}>
        <p className="note">{words('trace.note')}</p>
        <Checkbox className="check" isSelected={gapsOnly} onChange={setGapsOnly}>
          <span className="box" aria-hidden="true">
            {gapsOnly ? '✓' : ''}
          </span>
          Only items with something to check
        </Checkbox>
        <DataTable className="trace" label="Work items and their delivery" wide rows={shown} rowKey={(r) => r.item.id} columns={traceColumns(builds, plain.on)} />
      </Panel>

      <div className="panel-grid">
        <Panel id="builds" title={term('builds', 'Builds')} calls={toilProject.calls.builds}>
          {builds.length ? (
            <ul className="rows">
              {builds.map((c) => (
                <li key={c.id}>
                  <ChangeLink change={c} /> <Outcome of={c} />
                  <p className="evidence">
                    For pull request {c.builds ? short(c.builds) : 'none'}, {dateTime(c.at)}.
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <Empty message={words('empty.builds')} action={<EmptyLink edit href={toilProjectEditHref(toilProject.name, 'sources')}>Link a pipeline</EmptyLink>} help="toil-project-setup" />
          )}
        </Panel>

        <Panel id="deployments" title="Deployments" calls={toilProject.calls.deployments}>
          {toilProject.deployments.length ? (
            <ul className="rows">
              {toilProject.deployments.map((d) => (
                <DeploymentRow key={d.id} d={d} />
              ))}
            </ul>
          ) : (
            <Empty message={words('empty.deployments')} action={<EmptyLink edit href={toilProjectEditHref(toilProject.name, 'sources')}>Add an environment</EmptyLink>} help="toil-project-setup" />
          )}
        </Panel>
      </div>
    </div>
  );
}

/** The Dependencies tab: the blocker Gantt on the sprint's timeline (#396), then the dependency graph, with every relation listed in words under it. */
function DependenciesTab() {
  const { toilProject } = useData();
  const term = useTerm();
  const plain = usePlain();
  const words = useWords();
  return (
    <div className="tab-panels">
      <Panel id="gantt" title="Blocker timeline" calls={[...toilProject.calls.work, ...toilProject.calls.prs, ...toilProject.calls.builds]} alerts={false}>
        <BlockerGantt />
      </Panel>
      <Panel id="graph" title={term('dependencies', plain.pw('Dependencies', 'What blocks what'))} calls={toilProject.calls.work} alerts={false}>
        <Suspense fallback={<Loader size="panel" message={words('loading.graph')} />}>
          <Graph />
        </Suspense>
      </Panel>
    </div>
  );
}

/** What the filtered board says: whose items, how many of theirs are on it, and the way back to everyone's. The shell moves focus here. */
function BoardFilter({ name, shown, all }: { name: string | null; shown: number; all: number }) {
  const { toilProject } = useData();
  const line = useRef<HTMLParagraphElement>(null);
  // Opened straight from a link or a reload, the shell moves no focus, so the board panel, heading and all, is brought into view here.
  useEffect(() => {
    // Only as far as it takes to see the filter's line: the header and tabs above it stay in view.
    (line.current?.closest('section') ?? line.current)?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  const on = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;
  return (
    <p id="board-filter" ref={line} className="board-filter" tabIndex={-1}>
      {name === null ? (
        <>The People view's link named nobody this Toil project's data shows, so no items are shown. </>
      ) : (
        <>
          Showing {name}'s items: {on(shown)} on this board{all > shown ? `, of ${on(all)} assigned to them in all` : ''}.{' '}
        </>
      )}
      <a href={boardHref(toilProject.name)}>Show everyone's</a> · <a href={peopleHref(toilProject.name)}>Back to People</a>
    </p>
  );
}

/**
 * How far through its sprint the toil project is, from 0 on day one to 1 on the
 * last, as `--sprint-progress` on the page, for a theme's sky to follow
 * (Harvest's dawn to dusk). It is decoration: the top row says the day
 * in words. Off the toil project's tabs, there is no sprint, and the property goes.
 */
function useSprintProgress(h: Health | null) {
  const progress = h && h.days.total > 1 ? Math.min(1, Math.max(0, (h.days.gone - 1) / (h.days.total - 1))) : null;
  useEffect(() => {
    if (progress === null) return;
    const root = document.documentElement;
    root.style.setProperty('--sprint-progress', progress.toFixed(3));
    return () => {
      root.style.removeProperty('--sprint-progress');
    };
  }, [progress]);
}

function DeploymentRow({ d }: { d: Deployment }) {
  const name = d.url ? <a href={d.url}>{d.name}</a> : <span>{d.name}</span>;
  return (
    <li>
      <h3 className="env">{d.environment}</h3>
      <p>
        {name} <span className={`outcome outcome--${d.outcome}`}>{d.state}</span>
      </p>
      <p className="evidence">
        {d.version ? `${d.version}, ` : ''}commit <code>{d.commit}</code>.{' '}
        {d.unknownCommit ? (
          <span className="failure">No listed pull request merged as this commit.</span>
        ) : (
          <>
            Includes {d.includes.length} merged pull {d.includes.length === 1 ? 'request' : 'requests'}
            {d.items.length ? (
              <>
                , for <Items ids={d.items} />
              </>
            ) : (
              ', none for this sprint'
            )}
            .
          </>
        )}
      </p>
    </li>
  );
}
