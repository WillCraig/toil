/**
 * The Work mix dashboard (#567, docs/work-classification-proposal.md, "Toil UI"):
 * of the work that was finished, how much was a feature and how much was keeping
 * the lights on, and how that moved. One focus: the three shares over the period,
 * as a sentence, then one chart, a trend by month. The person can split it by any
 * dimension (it then becomes a bar of category share for each value), change what
 * is counted (items, estimate, days in progress), and narrow it with the filter
 * bar, all in menus and all in the address. Beside the chart, never behind a
 * tooltip, it says how the categories were decided and how much is not sorted yet,
 * because a share that hides how much of it is a guess is a misleading share.
 * A split by person or team is in name order and never sorted by size: the team
 * is measured, never the person. Splits by anyone's name are alphabetical, a form of fairness.
 *
 * "Categories" (#657) views the same work by another built-in scheme, such as
 * flow's Feature, Defect, Risk and Debt, worked out on the fly from its rules
 * and the labels already on the items (`?lens=` in the address, read by
 * useWorkInsights). It comes first and stands apart from Split by and Measured
 * in, since it changes what the categories are rather than how they are cut.
 * It changes nothing saved: the team's own choice lives in Settings, and this
 * menu only borrows the other spectacles; "Back to saved" returns them.
 */

import { Fragment } from 'react';
import { BUILTIN_SCHEMES } from '../../../../src/core/classify/builtin.ts';
import type { Scheme } from '../../../../src/core/classify/types.ts';
import { StackedBars, StackedColumns } from '../../components/chartkit/index.ts';
import { CategoryName } from '../../components/category-chip.tsx';
import { Choice } from '../../components/choice.tsx';
import { FilterBar } from '../../components/filter-bar.tsx';
import { Help } from '../../components/help.tsx';
import { Unread } from '../../components/unread.tsx';
import { useData } from '../../data.ts';
import { classifyHref } from '../../format.ts';
import { toWhere } from '../../filters.ts';
import { lensOf, schemeInUse, useAddress, useWorkInsights } from '../../insights-data.ts';
import { mixDecided, mixOverview, mixSentence, inNameOrder, NOT_SORTED, isPeopleDimension, labelOfDimension, MIX_UNITS, periodWords, SPLIT_MENU, type MixUnit } from '../../model/work-insights.ts';
import { useWords } from '../../theme-context.ts';
import type { Dashboard, Headline } from './dashboard.ts';
import { ChartPanel, DashboardHead, Door, useDrill, useFilterFromCell, useSourceLine } from './shared.tsx';
import { plainDates } from './format.ts';
import { NavButton } from '../../components/nav-button.tsx';

const TIME = 'time';

/** The line in Where the work goes for this dashboard: the mix of what was finished in the last 90 days, or why it isn't known. */
export function mixHeadline(ins: ReturnType<typeof useWorkInsights>): Headline {
  const { lines, period, result } = mixOverview(ins);
  if (!lines) return { text: null, note: ins.items.length === 0 ? 'no items were read' : 'nothing was finished in the last 90 days' };
  return { text: mixSentence(lines), note: `${periodWords(ins.today, period)}, ${result.total.value ?? 0} ${result.measure.unit} finished` };
}

/** A scheme's categories, in order: "Feature / Defect / Risk / Debt". */
const schemeLabel = (s: { categories: ReadonlyArray<Pick<Scheme['categories'][number], 'name'>> }) => s.categories.map((c) => c.name).join(' / ');

/** The built-in schemes' names as the Categories menu leads with them, so two lists of categories are told apart by name. */
const SCHEME_TITLE: Record<string, string> = { flow: 'Flow', balance: 'Balance' };

/** A scheme as the Categories menu names it: "Flow: Feature / Defect / Risk / Debt". */
const schemeOption = (s: Pick<Scheme, 'name'> & Parameters<typeof schemeLabel>[0]) => (SCHEME_TITLE[s.name] ? `${SCHEME_TITLE[s.name]}: ${schemeLabel(s)}` : schemeLabel(s));

export function MixView() {
  const ins = useWorkInsights();
  const { toilProject, classification } = useData();
  const { filters, query, go, hrefWith } = useAddress();
  const drill = useDrill();
  const words = useWords();
  const source = useSourceLine(true);
  const unit: MixUnit = (MIX_UNITS.find((u) => u.id === query.get('unit'))?.id ?? 'items') as MixUnit;
  const measure = MIX_UNITS.find((u) => u.id === unit)!.measure;
  const rawSplit = query.get('split');
  const split = rawSplit && SPLIT_MENU.some((d) => d.spec === rawSplit) && rawSplit !== 'category' ? rawSplit : TIME;
  const where = toWhere(filters);
  const lead = mixOverview(ins, { ...(filters.from ? { from: filters.from } : {}), ...(filters.to ? { to: filters.to } : {}), where }, unit);
  const period = lead.period;
  const spec = split === TIME ? { measure, split: 'category', across: 'resolved:month', share: true, where, ...period } : { measure, split: 'category', across: split, share: true, top: isPeopleDimension(split) ? 0 : 8, where, ...period };
  const raw = ins.run(spec);
  const result = split !== TIME && isPeopleDimension(split) ? inNameOrder(raw) : raw;
  const onFilter = useFilterFromCell(result);
  const scheme = { categories: ins.scheme.categories };
  const decided = mixDecided(ins, lead, unit);
  const share = (n: number) => (decided.total === 0 ? null : `${Math.round((n / decided.total) * 100)}%`);
  const sources: Array<[string, number]> = [['Rules', decided.rules], ['Labels on the items', decided.labels], ['Your AI agent', decided.agent], ['People', decided.people]];
  const splitLabel = split === TIME ? 'Month' : labelOfDimension(split);
  const title = split === TIME ? `Work mix by month, ${periodWords(ins.today, period)}` : `Work mix by ${labelOfDimension(split).toLowerCase()}, ${periodWords(ins.today, period)}`;
  const set = (key: string, value: string | null) => go((q) => (value === null ? q.delete(key) : q.set(key, value)));
  // The saved scheme first when it isn't built in (a team's own file), then every built-in one; picking the saved one drops the lens.
  const inUse = schemeInUse(toilProject.classifyScheme, classification?.view?.scheme.name);
  const lens = lensOf(query.get('lens'), inUse);
  const saved = classification?.view?.scheme;
  const lenses = [
    ...(BUILTIN_SCHEMES.some((b) => b.name === inUse) ? [] : [{ id: inUse, label: `${saved ? schemeLabel(saved) : inUse} (your team's)` }]),
    ...BUILTIN_SCHEMES.map((b) => ({ id: b.name, label: `${schemeOption(b)}${b.name === inUse ? " (your team's)" : ''}` })),
  ];
  const menus = (
    <div className="chart-menus">
      <div className="chart-menus__lens">
        <Choice label="Categories" value={lens ?? inUse} options={lenses} onChange={(id) => set('lens', id === inUse ? null : id)} />
      </div>
      <Choice label={words('charts.splitBy')} value={split} options={[{ id: TIME, label: 'Month' }, ...SPLIT_MENU.filter((d) => d.spec !== 'category').map((d) => ({ id: d.spec, label: d.label }))]} onChange={(id) => set('split', id === TIME ? null : id)} />
      <Choice label={words('charts.measuredIn')} value={unit} options={MIX_UNITS.map((u) => ({ id: u.id, label: u.label }))} onChange={(id) => set('unit', id === 'items' ? null : id)} />
    </div>
  );
  return (
    <div className="chart-page" data-dashboard="mix">
      <DashboardHead title={words('mix.title')} help="work-mix" />
      <p className="chart-lead" data-mix-lead="">
        {lead.lines ? (
          <>
            {lead.lines.map((l, i) => (
              <Fragment key={l.key}>
                {i > 0 && ' · '}
                <CategoryName ins={ins} id={l.id} /> {Math.round(l.share * 100)}%
              </Fragment>
            ))}
            <span className="chart-lead__period">, {periodWords(ins.today, period)}</span>
          </>
        ) : (
          <>
            <Unread /> <span className="chart-lead__period">nothing finished in {periodWords(ins.today, period)} to count</span>
          </>
        )}
      </p>
      {lens && (
        <p className="note" data-mix-lens={lens}>
          Viewing as {schemeLabel(ins.scheme)}. Your team's saved categories haven't changed. <NavButton href={hrefWith((q) => q.delete('lens'))} size="sm">Back to saved</NavButton>
        </p>
      )}
      <FilterBar />
      <div className="chart-page__grid">
        <div className="chart-page__main">
          <ChartPanel
            main
            questions={["Why did 'Keep the lights on' work rise?", 'What changed most this period?']}
            title={title}
            result={result}
            source={source}
            scheme={scheme}
            defaultMode="share"
            actions={menus}
            onDrill={(c) => drill.open({ kind: 'cell', spec, row: c.row.key, column: c.column.key })}
            onFilter={onFilter}
          >
            {(view) => (split === TIME ? <StackedColumns view={view} /> : <StackedBars view={view} />)}
          </ChartPanel>
          {split === TIME && raw.notable.length > 0 && (
            <section className="chart-changes" aria-label={words('charts.changes')}>
              <h3>{words('charts.changes')}</h3>
              <ul>
                {raw.notable.map((n) => (
                  <li key={`${n.kind}-${n.row}-${n.column}`}>
                    <Door drill={{ kind: 'cell', spec, row: n.row, column: n.column }}>{plainDates(n.message)}</Door>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <aside className="chart-page__side" aria-label={words('charts.decided')} data-decided="">
          <h3>
            {words('charts.decided')} <Help topic="work-mix" />
          </h3>
          {decided.total === 0 ? (
            <p>
              <Unread /> nothing to count in {splitLabel === 'Month' ? 'this period' : periodWords(ins.today, period)}
            </p>
          ) : (
            <ul className="decided">
              {sources.map(([name, n]) => (
                <li key={name}>
                  <span>{name}</span> <b>{share(n)}</b>
                </li>
              ))}
              <li>
                <NavButton href={classifyHref(toilProject.name)} kind="quiet" size="sm" data-unsure-link="">
                  {NOT_SORTED}
                </NavButton>{' '}
                <b>{share(decided.unsure)}</b>
              </li>
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}

export const mix: Dashboard = { id: 'mix', title: 'Work mix', headline: mixHeadline, View: MixView };
