/**
 * What every dashboard shares (#567): a click that opens a list of items, a
 * shift-click that adds a filter, the page's head with the way back, the source
 * line, and the empty state for a dimension the read never fetched. Kept here so
 * a dashboard is its charts and its sentences, and the behaviours that must
 * match across dashboards (every number a door, every segment a filter) are
 * written once and cannot drift. The shared drawer is where the dashboards'
 * paperwork goes to be countersigned.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { type PivotResult } from '../../../../src/core/insights/index.ts';
import { Help } from '../../components/help.tsx';
import { TrackerAction, Empty } from '../../components/empty.tsx';
import { useData } from '../../data.ts';
import { toilProjectHref } from '../../format.ts';
import { Breadcrumb } from '../../components/breadcrumb.tsx';
import { addValue, writeFilters, type Filters } from '../../filters.ts';
import { useAddress, useWorkInsights } from '../../insights-data.ts';
import { encodeDrill, type Drill } from '../../model/drill.ts';
import { ChartFrame, type CellRef, type ChartFrameProps } from '../../components/chartkit/index.ts';
import { CardMenu, type CardMenuItem } from '../../components/card-menu.tsx';
import { askAboutChart } from '../../commands.ts';
import { setCurrentChart } from '../../current-chart.ts';
import { buildViewContext, viewContextMarkdown } from '../../view-context.ts';
import { csvName, figuresCsv, plainResult } from './format.ts';
import { dimensionChoices } from '../../model/explore.ts';
import type { HelpTopicId } from '../../help.ts';
import { AgentMark } from '../../components/agent-mark.tsx';

/** Opens a list of items: as a click handler, or as the link behind a number. */
export function useDrill() {
  const { go, hrefWith } = useAddress();
  const edit = (d: Drill) => (q: URLSearchParams) => {
    q.set('items', encodeDrill(d));
    q.delete('item');
  };
  return { open: (d: Drill) => go(edit(d)), href: (d: Drill) => hrefWith(edit(d)) };
}

/** A number that is a door: the figure as a link to the list of items behind it. */
export function Door({ drill, children, label }: { drill: Drill; children: ReactNode; label?: string }) {
  const { href } = useDrill();
  return (
    <a className="door" href={href(drill)} {...(label ? { 'aria-label': label } : {})} data-door="" data-press="">
      {children}
    </a>
  );
}

/**
 * Shift-click on a mark adds what it stands for as filters: the row's value and, where the columns are not time,
 * the column's, each in its own dimension. Other and "none" buckets add nothing the filter could name, except none, which the filter understands.
 */
export function useFilterFromCell(result: PivotResult) {
  const { filters, go } = useAddress();
  return (cell: CellRef) => {
    let next: Filters = filters;
    const add = (spec: string | undefined, key: string, label: string, kind: string, timeKind: string | undefined) => {
      if (!spec || timeKind === 'time' || kind === 'other' || key === '(all)') return;
      next = addValue(next, spec, kind === 'none' ? 'none' : spec === 'category' ? key.replace(/^v:/, '') : label);
    };
    add(result.split?.spec, cell.row.key, cell.row.label, cell.row.kind, result.split?.kind);
    add(result.across?.spec, cell.column.key, cell.column.label, cell.column.kind, result.across?.kind);
    if (next !== filters) go((q) => writeFilters(q, next));
  };
}

/** The line every chart carries: where the items came from and how far back; the scheme's note when it isn't the toil project's own. */
export function useSourceLine(category = false): string {
  const ins = useWorkInsights();
  return `${ins.sourceLine()}${category && ins.schemeNote ? ` ${ins.schemeNote}` : ''}`;
}

/** A dashboard's heading, with the breadcrumb back to the Summary it is a step in from (#567) and its (i). */
export function DashboardHead({ title, help }: { title: string; help: HelpTopicId }) {
  const { toilProject } = useData();
  return (
    <header className="chart-page__head">
      <Breadcrumb trail={[{ label: 'Summary', href: toilProjectHref(toilProject.name) }, { label: title }]} />
      <h1 className="chart-page__title" tabIndex={-1} id="chart-page-title">
        {title} <Help topic={help} />
      </h1>
    </header>
  );
}

/** What a dashboard says when a dimension it needs was never read: one sentence, then the action that reads it where there is one. */
export function NotRead({ what }: { what: string }) {
  const { toilProject, sync } = useData();
  return <Empty message={`${what} weren't read for this Toil project, so there is nothing to draw yet.`} action={<TrackerAction toilProject={toilProject.name} sync={sync} />} />;
}

// What every chart does -----------------------------------------------------------------

/** The Charts menu's items, and the words each says. */
const CHART_MENU: CardMenuItem[] = [
  { id: 'ask', label: 'Ask about this chart' },
  { id: 'copy', label: 'Copy for AI' },
  { id: 'export', label: 'Export the figures' },
];

/** Saves text as a file the browser downloads: the one export path that needs no server, so it works in the preview too. */
export function downloadText(name: string, text: string, type = 'text/csv;charset=utf-8'): boolean {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' || typeof document === 'undefined') return false;
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

export interface ChartPanelProps extends Omit<ChartFrameProps, 'coverage'> {
  /** The dashboard's main chart: the one the palette's "Ask about this chart" means while this page is open. */
  main?: boolean;
  /** Questions worth asking of this chart, shown as quiet chips that open Ask with the question filled in. */
  questions?: string[];
}

/**
 * A chart in its frame with everything every chart does (docs/work-insights-proposal.md,
 * "What every chart does"): sentences with their dates in plain words, a menu
 * to ask the agent about it, copy it for any AI, or export its figures, and
 * the suggested questions as chips. A dashboard writes `<ChartPanel>` where it
 * would have written `<ChartFrame>`, and gets all of it.
 */
export function ChartPanel({ main = false, questions = [], result: raw, title, actions, children, ...frame }: ChartPanelProps) {
  const result = useMemo(() => plainResult(raw), [raw]);
  const context = useMemo(() => buildViewContext(title, result), [title, result]);
  const [said, setSaid] = useState('');
  // Registered by what the chart says, not by the object that says it: a view that rebuilds its result each render must not re-register each render.
  const latest = useRef(context);
  latest.current = context;
  const signature = `${context.title}::${context.figuresMarkdown}`;
  useEffect(() => {
    if (!main) return undefined;
    setCurrentChart(latest.current);
    return () => setCurrentChart(null);
  }, [main, signature]);
  useEffect(() => {
    if (!said) return undefined;
    const t = setTimeout(() => setSaid(''), 4000);
    return () => clearTimeout(t);
  }, [said]);
  const act = async (id: string) => {
    if (id === 'ask') askAboutChart(context);
    else if (id === 'copy') {
      try {
        await navigator.clipboard.writeText(viewContextMarkdown(context));
        setSaid('Copied for AI: paste it into any assistant.');
      } catch {
        setSaid("This browser wouldn't copy. Use Show the figures and select them instead.");
      }
    } else if (id === 'export') setSaid(downloadText(csvName(title), figuresCsv(result)) ? `Saved ${csvName(title)} to your downloads.` : "This browser wouldn't save a file. Use Show the figures and copy them instead.");
  };
  return (
    <div className="chart-panel" data-chart-panel="">
      <ChartFrame
        {...frame}
        title={title}
        result={result}
        actions={
          <>
            {actions}
            <CardMenu name={title} items={CHART_MENU} onAction={(id) => void act(id)} />
          </>
        }
      >
        {children}
      </ChartFrame>
      {said && (
        <p className="note chart-panel__said" role="status" data-chart-said="">
          {said}
        </p>
      )}
      {questions.length > 0 && (
        <ul className="chart-asks" aria-label="Questions to ask about this chart">
          {questions.map((q) => (
            <li key={q}>
              <button type="button" className="btn btn--small chart-asks__chip" onClick={() => askAboutChart(context, q)}>
                <AgentMark />
                {q}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The dimensions a Split by or Across menu offers for this data, as the Choice menu takes them: each greyed with "not read yet"
 * where the read never fetched it, so a person sees it exists and why it can't be used (principle 12). `time` includes the date dimensions.
 */
export function useDimensionOptions(time: boolean): Array<{ id: string; label: string; disabled?: boolean }> {
  const ins = useWorkInsights();
  const { toilProject } = useData();
  return useMemo(
    () => dimensionChoices(ins, toilProject.dimensionNames ?? []).filter((d) => time || !d.time).map((d) => (d.read ? { id: d.spec, label: d.label } : { id: d.spec, label: `${d.label} (not read yet)`, disabled: true })),
    [ins, toilProject.dimensionNames, time],
  );
}
