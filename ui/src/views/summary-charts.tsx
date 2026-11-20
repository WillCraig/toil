/**
 * The Summary's charts (#567): the Charts tab folded into the page it was one click from. Three items in one quiet
 * section, each its dashboard's own headline sentence (the same `headline(ins)` its full page leads with) and one small
 * chart drawn by the same chart kit, the title a quiet button to the full page (#657). Work mix also carries "Sort into
 * categories", the way in to the page that sorts the work it counts. Work mix, Where we're working and Flow are what a
 * Summary needs; Releases, Sprints and Explore are not offered here and stay reachable by their own addresses and the
 * command palette. There are no controls on the Summary: splitting, filtering and drilling happen on the full page. An item
 * whose data was never read shows a dash and why, never an empty chart and never a zero (principle 12). Three small charts,
 * which is the number of charts a stand-up has ever had time for.
 */

import { useEffect, type ReactNode } from 'react';
import { Heatmap, MixBar, StackedColumns, useChartView, type ChartView } from '../components/chartkit/index.ts';
import { Unread } from '../components/unread.tsx';
import { useData } from '../data.ts';
import { chartsHref, classifyHref } from '../format.ts';
import { NavButton } from '../components/nav-button.tsx';
import { ChevronRightIcon } from '../components/icons.tsx';
import { useWorkInsights } from '../insights-data.ts';
import { EPIC, whereResult } from '../model/where.ts';
import { mixOverview, periodOf } from '../model/work-insights.ts';
import { useWords } from '../theme-context.ts';
import type { PivotResult } from '../../../src/core/insights/index.ts';
import { flowHeadline, flowThroughput } from './charts/flow.tsx';
import { mixHeadline } from './charts/mix.tsx';
import { takeSaved } from './charts/saved.ts';
import { whereHeadline } from './charts/where.tsx';
import type { Headline } from './charts/dashboard.ts';
import './summary-charts.css';


/** A chart drawn small: the kit's own form on its own view, with the tooltip host and keyboard the marks need, and no frame, menu or toggles. */
function Mini({ result, scheme, label, children }: { result: PivotResult; scheme?: { categories: Array<{ id: string }> }; label: string; children: (view: ChartView) => ReactNode }) {
  const view = useChartView({ result, ...(scheme ? { scheme } : {}) });
  return (
    <figure className="summary-chart__figure" ref={view.host.hostRef} {...view.host.hostProps} aria-label={label}>
      {children(view)}
      {view.host.tip}
    </figure>
  );
}

function Item({ id, title, href, headline, action, children }: { id: string; title: string; href: string; headline: Headline; action?: ReactNode; children: ReactNode }) {
  return (
    <li className="summary-chart" data-summary-chart={id}>
      <h3 className="summary-chart__title">
        <NavButton href={href} kind="quiet" size="sm" className="summary-chart__open">
          {title}
          <ChevronRightIcon size={16} />
        </NavButton>
      </h3>
      {headline.text ? (
        <>
          <p className="summary-chart__headline">{headline.text}</p>
          {children}
          <p className="note summary-chart__note">{headline.note}</p>
          {action}
        </>
      ) : (
        <p className="summary-chart__headline">
          <Unread /> <span className="note">{headline.note}</span>
        </p>
      )}
    </li>
  );
}

export function SummaryCharts() {
  const { toilProject, refresh } = useData();
  const ins = useWorkInsights();
  const words = useWords();
  // A view saved on Explore is in the file, not yet in this page's copy: read the toil project again when the Summary opens.
  useEffect(() => {
    if (takeSaved()) refresh?.();
  }, [refresh]);
  const scheme = { categories: ins.scheme.categories };
  const mix = mixHeadline(ins);
  const where = whereHeadline(ins);
  const flow = flowHeadline(ins);
  const mixResult = mixOverview(ins).result;
  const heat = where.text ? whereResult(ins, EPIC, { ...periodOf(ins.today), top: 4 }) : null;
  const through = flow.text ? flowThroughput(ins) : null;
  return (
    <section className="summary-charts" aria-labelledby="summary-charts-title" data-summary-charts="">
      <h2 id="summary-charts-title" className="sum-section-head">
        Where the work goes
      </h2>
      <ul className="summary-charts__items">
        <Item
          id="mix"
          title={words('mix.title')}
          href={chartsHref(toilProject.name, 'mix')}
          headline={mix}
          action={
            <p className="summary-chart__action">
              <NavButton href={classifyHref(toilProject.name)} size="sm" data-open-classify="">
                Sort into categories
              </NavButton>
            </p>
          }
        >
          <MixBar result={mixResult} scheme={scheme} legend label="Work mix" />
        </Item>
        <Item id="where" title={words('where.title')} href={chartsHref(toilProject.name, 'where')} headline={where}>
          {heat && (
            <Mini result={heat} label="Days in progress by week, top epics">
              {(v) => <Heatmap view={v} />}
            </Mini>
          )}
        </Item>
        <Item id="flow" title={words('flow.title')} href={chartsHref(toilProject.name, 'flow')} headline={flow}>
          {through && (
            <Mini result={through} scheme={scheme} label="Finished each week, by category">
              {(v) => <StackedColumns view={v} />}
            </Mini>
          )}
        </Item>
      </ul>
    </section>
  );
}
