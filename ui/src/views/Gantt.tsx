/**
 * The blocker Gantt (#396), drawn as plain SVG from src/model/gantt.ts: one
 * row per item that blocks or is blocked, on the sprint's timeline, with its
 * time blocked (hatched), in progress (solid) and failing checks (a thin
 * strip under the bar), "waits on" arrows from each blocker to what it holds
 * up, the critical chain's arrows drawn heavy and its rows marked, and today
 * as a line. Every mark differs by shape as well as colour, because in some
 * themes the danger and accent tokens are the same orange.
 *
 * The drawing is an image with a summary; the table under it is the
 * accessible equivalent, listing every bar and every arrow with links, so no
 * bar needs to be focusable. Narrower than the drawing's minimum width, it
 * scrolls sideways inside a declared scroller with a visible cue.
 * A Gantt chart nobody had to update by hand on Friday afternoon.
 */

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ItemLink } from '../components/items.tsx';
import { DataTable, Scroller, type Column } from '../components/layout.tsx';
import { useData, useDerived } from '../data.ts';
import { STATUS_CATEGORY_LABEL, day, shortKey } from '../format.ts';
import { blockerGantt, type Bar, type Gantt, type Segment } from '../model/gantt.ts';
import { VERDICT_LABEL } from '../model/readiness.ts';
import './gantt.css';

const DAY = 86_400_000;
const t = (iso: string) => Date.parse(iso);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The toil project's Gantt, worked out once per toil project and clock. */
export function useGantt(): Gantt {
  const { toilProject, now } = useData();
  const { health, insights } = useDerived();
  return useMemo(() => blockerGantt({ prepared: insights, health, readiness: toilProject.readiness, now }), [insights, health, toilProject.readiness, now]);
}

/** The width the drawing has to work with, followed as the box resizes; a fixed guess where nothing measures (tests). */
function useWidth(min: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  // The box's own width, before the drawing's minimum: a phone gets a narrower label column, so more of the timeline shows before it scrolls.
  useEffect(() => {
    // The scroller's box, not the drawing's: the drawing may be wider than what holds it.
    const el = ref.current?.parentElement;
    if (!el || typeof ResizeObserver !== 'function') return;
    const measure = () => setWidth(Math.round(el.clientWidth) || 960);
    measure();
    const o = new ResizeObserver(measure);
    o.observe(el);
    return () => o.disconnect();
  }, []);
  return { ref, width: Math.max(min, width), narrow: width < 560 };
}

interface Layout {
  label: number;
  row: number;
  bar: number;
  top: number;
  right: number;
}
const FULL: Layout = { label: 220, row: 36, bar: 14, top: 26, right: 16 };
/** How many lanes the arrows leaving bars that end together are spread over. */
const LANES = 5;

function timeText(s: Segment) {
  return `${s.estimated ? 'about ' : ''}${day(s.start)} to ${day(s.end)}`;
}

/** One row's words, for its tooltip. */
function rowWords(bar: Bar, g: Gantt, name: (id: string) => string): string {
  const parts = [`${name(bar.id)}${bar.points !== null ? `, ${plural(bar.points, 'point')}` : ''}${bar.done ? ', done' : ''}`];
  for (const s of bar.segments.filter((x) => x.kind === 'progress')) parts.push(`in progress ${timeText(s)}`);
  for (const s of bar.blocked) parts.push(`blocked by ${name(s.by!)} ${timeText(s)}`);
  for (const s of bar.checks) parts.push(`checks failing since ${s.estimated ? 'about ' : ''}${day(s.start)}`);
  const waits = g.arrows.filter((a) => a.to === bar.id).map((a) => name(a.from));
  if (waits.length) parts.push(`waits on ${waits.join(', ')}`);
  if (bar.onChain) parts.push('on the critical chain');
  return parts.join('; ');
}

function Drawing({ g }: { g: Gantt }) {
  const { byId } = useData();
  const { ref, width, narrow } = useWidth(680);
  const L = { ...FULL, ...(narrow ? { label: 150 } : {}) };
  const uid = useId().replace(/[^\w-]/g, '');
  const hatch = `gantt-hatch-${uid}`;
  const head = `gantt-head-${uid}`;
  const headChain = `gantt-head-chain-${uid}`;
  const start = t(g.start);
  const end = t(g.end);
  const plot = width - L.label - L.right;
  const x = (ms: number) => L.label + (plot * (Math.min(Math.max(ms, start), end) - start)) / Math.max(1, end - start);
  // The rows, then a band under them for the Today label, clear of the day labels above.
  const height = L.top + g.bars.length * L.row + 18;
  const rowY = new Map(g.bars.map((b, i) => [b.id, L.top + i * L.row + L.row / 2]));
  const key = (id: string) => {
    const item = byId.get(id);
    return item ? shortKey(item) : id;
  };
  const name = (id: string) => {
    const item = byId.get(id);
    return item ? `${shortKey(item)} ${item.title}` : id;
  };

  // A tick a day where there's room, else every few days: labels never closer than 64px.
  const days = Math.max(1, Math.round((end - start) / DAY));
  const step = Math.max(1, Math.ceil(days / Math.max(1, Math.floor(plot / 64))));
  const ticks: number[] = [];
  for (let d = Math.ceil(start / DAY) * DAY; d <= end; d += step * DAY) ticks.push(d);

  const nowX = x(t(g.now));
  const chain = g.chain;
  const summary = `Blocker timeline${g.sprint ? ` for ${g.sprint}` : ''}: ${plural(g.bars.length, 'item')} and ${plural(g.arrows.length, 'waits-on arrow')}.${
    chain ? ` Critical chain: ${chain.ids.map(key).join(' blocks ')}${chain.byCount ? '' : `, ${plural(chain.points, 'point')}`}.` : ''
  } The table lists every bar and arrow.`;
  const maxChars = Math.floor((L.label - 24) / 7);
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s);

  // Where a blocker's bar ends: its last segment, else today.
  const endX = (id: string) => {
    const bar = g.bars.find((b) => b.id === id);
    const last = bar?.segments.map((s) => t(s.end)).sort((a, b) => b - a)[0];
    return x(last ?? t(g.now));
  };

  const lanes = new Map([...new Set(g.arrows.map((a) => a.from))].map((id, i) => [id, i % LANES]));

  return (
    <div ref={ref} className="gantt-measure">
      <svg className="gantt" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary} data-gantt="full">
        <defs>
          <pattern id={hatch} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
            <rect className="gantt-hatch-bg" width="6" height="6" />
            <line className="gantt-hatch-line" x1="1.5" y1="0" x2="1.5" y2="6" />
          </pattern>
          <marker id={head} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path className="gantt-head" d="M0,0 L8,4 L0,8 z" />
          </marker>
          <marker id={headChain} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path className="gantt-head gantt-head--chain" d="M0,0 L8,4 L0,8 z" />
          </marker>
        </defs>

        {ticks.map((d) => (
          <g key={d}>
            <line className="gantt-grid" x1={x(d)} x2={x(d)} y1={L.top - 4} y2={height - 16} />
            <text className="gantt-axis" x={x(d) + 3} y={L.top - 10}>
              {day(new Date(d).toISOString()).replace(/ \d{4}$/, '')}
            </text>
          </g>
        ))}

        {g.bars.map((bar, i) => {
          const y = L.top + i * L.row;
          const mid = y + L.row / 2;
          const top = mid - L.bar / 2;
          const item = byId.get(bar.id);
          return (
            <g key={bar.id} className={`gantt-row${bar.onChain ? ' gantt-row--chain' : ''}`}>
              <title>{rowWords(bar, g, name)}</title>
              {bar.onChain && <rect className="gantt-band" x={0} y={y + 1} width={width} height={L.row - 2} />}
              {bar.onChain && <path className="gantt-diamond" d={`M8,${mid - 5} L13,${mid} L8,${mid + 5} L3,${mid} z`} />}
              <text className="gantt-key" x={18} y={mid + 4}>
                {key(bar.id)}
                <tspan className="gantt-title" dx={6}>
                  {cut(item?.title ?? '', Math.max(4, maxChars - key(bar.id).length))}
                </tspan>
              </text>
              {bar.segments.map((s, j) => {
                const x1 = x(t(s.start));
                const x2 = x(t(s.end));
                // A 2px gap of the surface between touching segments; at least 3px, so a short spell is still a mark.
                const w = Math.max(3, x2 - x1 - 2);
                return s.kind === 'blocked' ? (
                  <rect key={j} className="gantt-seg gantt-seg--blocked" x={x1} y={top} width={w} height={L.bar} rx={3} fill={`url(#${hatch})`} />
                ) : (
                  <rect key={j} className="gantt-seg gantt-seg--progress" x={x1} y={top} width={w} height={L.bar} rx={3} />
                );
              })}
              {bar.checks.map((s, j) => {
                const x1 = x(t(s.start));
                return <rect key={`c${j}`} className="gantt-seg gantt-seg--checks" x={x1} y={top + L.bar + 3} width={Math.max(3, x(t(s.end)) - x1)} height={4} rx={2} />;
              })}
              {!bar.segments.length && !bar.done && (
                <text className="gantt-none" x={L.label + 4} y={mid + 4}>
                  Not started
                </text>
              )}
              {bar.done && <path className="gantt-done" d={`M${endX(bar.id) + 4},${mid} l3,3 l6,-7`} />}
            </g>
          );
        })}

        {g.arrows.map((a) => {
          const y1 = rowY.get(a.from);
          const y2 = rowY.get(a.to);
          if (y1 === undefined || y2 === undefined) return null;
          const x1 = endX(a.from) + 2;
          const down = y2 > y1 ? 1 : -1;
          // Clear of the Today line, where an open blocker's bar ends, and each blocker in a lane of its own, so arrows from several blockers that end today don't merge into one line.
          const xv = Math.min(width - 4, x1 + 12 + (lanes.get(a.from) ?? 0) * 8);
          const tip = y2 - down * (L.bar / 2 + 3);
          return (
            <path
              key={`${a.from}->${a.to}`}
              className={`gantt-arrow${a.onChain ? ' gantt-arrow--chain' : ''}${a.live ? '' : ' gantt-arrow--over'}`}
              d={`M${x1},${y1} H${xv} V${tip}`}
              markerEnd={`url(#${a.onChain ? headChain : head})`}
            />
          );
        })}

        <line className="gantt-today" x1={nowX} x2={nowX} y1={L.top - 4} y2={height - 2} />
        <text className="gantt-today-label" x={nowX > width - 60 ? nowX - 4 : nowX + 4} y={height - 4} textAnchor={nowX > width - 60 ? 'end' : 'start'}>
          Today
        </text>
      </svg>
    </div>
  );
}

/** The key, each mark drawn as it is in the chart, so none is told apart by colour alone. */
function Legend({ g }: { g: Gantt }) {
  const uid = useId().replace(/[^\w-]/g, '');
  const swatch = (children: ReactNode) => (
    <svg className="gantt-swatch" width="28" height="14" viewBox="0 0 28 14" aria-hidden="true">
      <defs>
        <pattern id={`lh-${uid}`} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
          <rect className="gantt-hatch-bg" width="6" height="6" />
          <line className="gantt-hatch-line" x1="1.5" y1="0" x2="1.5" y2="6" />
        </pattern>
      </defs>
      {children}
    </svg>
  );
  return (
    <ul className="gantt-legend" aria-label="Key">
      <li>{swatch(<rect className="gantt-seg gantt-seg--progress" x="1" y="2" width="26" height="10" rx="3" />)} In progress</li>
      <li>{swatch(<rect className="gantt-seg gantt-seg--blocked" x="1" y="2" width="26" height="10" rx="3" fill={`url(#lh-${uid})`} />)} Blocked</li>
      <li>{swatch(<rect className="gantt-seg gantt-seg--checks" x="1" y="5" width="26" height="4" rx="2" />)} Checks failing</li>
      <li>{swatch(<path className="gantt-arrow" d="M2,7 H24" />)} Waits on (points at the item that waits)</li>
      {g.chain && <li>{swatch(<><path className="gantt-diamond" d="M6,2 L11,7 L6,12 L1,7 z" /><path className="gantt-arrow gantt-arrow--chain" d="M14,7 H27" /></>)} Critical chain</li>}
      <li>{swatch(<line className="gantt-today" x1="14" x2="14" y1="0" y2="14" />)} Today</li>
    </ul>
  );
}

function Dates({ list, by }: { list: Segment[]; by?: boolean }) {
  if (!list.length) return <span className="note">None</span>;
  return (
    <ul className="plain">
      {list.map((s, i) => (
        <li key={i}>
          {s.kind === 'checks' ? `Since ${s.estimated ? 'about ' : ''}${day(s.start)}` : timeText(s)}
          {by && s.by && (
            <>
              {' '}
              by <ItemLink id={s.by} />
            </>
          )}
          {s.estimated && <span className="field"> (estimated)</span>}
        </li>
      ))}
    </ul>
  );
}

/** Every bar and every arrow, in words and links: the chart's accessible equivalent. */
function GanttTable({ g }: { g: Gantt }) {
  const { byId } = useData();
  const columns: Array<Column<Bar>> = [
    { header: 'Item', label: 'Item', rowHeader: true, cell: (b) => <ItemLink id={b.id} withTitle /> },
    {
      header: 'Status',
      label: 'Status',
      cell: (b) => {
        const item = byId.get(b.id)!;
        return `${item.status ?? STATUS_CATEGORY_LABEL[item.statusCategory]}${b.points !== null ? `, ${plural(b.points, 'point')}` : ''}`;
      },
    },
    { header: 'In progress', label: 'In progress', cell: (b) => <Dates list={b.segments.filter((s) => s.kind === 'progress')} /> },
    { header: 'Blocked', label: 'Blocked', cell: (b) => <Dates list={b.blocked} by /> },
    { header: 'Checks failing', label: 'Checks failing', cell: (b) => <Dates list={b.checks} /> },
    {
      header: 'Waits on',
      label: 'Waits on',
      cell: (b) => {
        const list = g.arrows.filter((a) => a.to === b.id);
        if (!list.length) return <span className="note">Nothing</span>;
        return (
          <ul className="plain">
            {list.map((a) => (
              <li key={a.from}>
                <ItemLink id={a.from} />
                {a.live ? '' : ', done'}
                {a.onChain ? ', critical chain' : ''}
              </li>
            ))}
          </ul>
        );
      },
    },
    { header: 'Critical chain', label: 'Critical chain', cell: (b) => (b.onChain ? 'Yes' : 'No') },
    { header: 'Ready to start', label: 'Ready to start', cell: (b) => (b.ready ? VERDICT_LABEL[b.ready] : <span className="note">Started</span>) },
  ];
  return <DataTable label="Every bar and arrow" caption="Every bar and waits-on arrow in the blocker timeline" columns={columns} rows={g.bars} rowKey={(b) => b.id} wide />;
}

function ChainLine({ g }: { g: Gantt }) {
  const c = g.chain;
  if (!c) return null;
  return (
    <p className="gantt-chain">
      <strong>Critical chain:</strong>{' '}
      {c.ids.map((id, i) => (
        <span key={id}>
          {i > 0 && ' blocks '}
          <ItemLink id={id} />
        </span>
      ))}
      , {c.byCount ? `${plural(c.ids.length, 'item')} (no item on a chain has points, so the longest)` : `${plural(c.points, 'point')} in ${plural(c.ids.length, 'item')}`}.
    </p>
  );
}

/** The Dependencies tab's Gantt: the chart, its key, what is estimated, and the table. */
export function BlockerGantt() {
  const g = useGantt();
  if (!g.bars.length) return <p className="note">Nothing in this Toil project blocks anything that is still open.</p>;
  return (
    <div className="gantt-panel">
      <ChainLine g={g} />
      <Legend g={g} />
      <p className="note gantt-cue">Scroll the timeline sideways for the whole sprint, or read the table under it.</p>
      <Scroller label="The timeline drawing" hint="Scroll sideways for the whole sprint." className="gantt-scroll">
        <Drawing g={g} />
      </Scroller>
      <p className="note">
        {g.sprint ? `The timeline is ${g.sprint}, ${day(g.start)} to ${day(g.end)}.` : 'No current sprint, so the timeline spans the items’ own dates.'} Blocked time is estimated: links carry no date in Jira, Azure DevOps or
        GitHub, so a block is drawn from when both items existed. Time in progress comes from each item&rsquo;s transitions, and is estimated from its creation where none were recorded. Failing checks come from its open pull requests&rsquo; builds and checks.
      </p>
      {g.cycle && <p className="failure">These blocks links form a loop, so the order of the rows is approximate.</p>}
      <h3>Every bar and arrow</h3>
      <GanttTable g={g} />
    </div>
  );
}

