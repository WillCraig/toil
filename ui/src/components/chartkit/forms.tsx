/**
 * The chart forms. Each takes a `ChartView` (view.tsx; `ChartFrame` makes one)
 * and draws the pivot as plain SVG on a fixed viewBox, so it scales with its
 * container: no canvas, no chart library, theme tokens as they are.
 *
 *  - `<StackedColumns view />`  columns = the result's columns, segments = its
 *    rows; count, or 100% share when the view's mode is `share`.
 *  - `<StackedBars view />`     the same, horizontal, for a categorical across.
 *  - `<StackedArea view />`     rows stacked over the columns as a time axis; the
 *    form that serves cumulative flow.
 *  - `<Lines view scope? forecast? />` one line per row (a burn-up: rows are
 *    done and so on). `scope` is a column-aligned neutral dashed line;
 *    `forecast` a range band: `{ low, high, label? }`, column-aligned, null
 *    where there is none.
 *  - `<Heatmap view />`         rows by columns on ONE sequential ramp made from
 *    the theme's accent and surface, not marks.
 *  - `<SmallMultiples view />`  one small column chart per row, all on one scale.
 *  - `<MixBar result onDrill? />` one thin 100% bar for a card or a tile, no axis.
 *
 * Every mark (a segment, a vertex dot, a heatmap cell) is focusable, named by
 * the sentence it shows on hover (describe.ts), and drills on click. A cell
 * nobody read is never drawn as a height of zero: it is left out, and its
 * column gets a "–" marker named "not read yet". A computed zero draws nothing,
 * as it is nothing.
 *
 * The 2px gap between segments is taken off each segment's rect (`gapped`).
 * Seven forms of one chart, because a pie was not on the list and was not discussed.
 */

import { useId, type ReactNode } from 'react';
import type { PivotResult } from '../../../../src/core/insights/types.ts';
import { assignMarks } from './assign.ts';
import { axisName, columnText, num, percent, quantity, unreadRows, NOT_READ_YET, type ChartMode } from './describe.ts';
import { MarkLine, MarkRect, Swatch, gapped } from './marks.tsx';
import { useMarkHost } from './tip.tsx';
import type { CellRef, ChartView } from './view.tsx';
import { useSeriesMarks, useFrames } from './series.ts';
import { Unread } from '../unread.tsx';

const W = 560;
const SURFACE_GAP = 2;
/**
 * Whether a segment's value fits inside it clear of its border: the 13px text plus the thickest edge on both sides (a
 * double outline sits 4.5 in), so no label is drawn struck through by a border it doesn't fit inside. A segment too small
 * keeps its figure in the table and the drill, one press away.
 */
const fitsLabel = (seg: { width: number; height: number }, text: string) => seg.height >= 22 && seg.width >= text.length * 7.8 + 10;

/** Whole-number ticks up to `max`, about four of them. */
export function niceTicks(max: number): number[] {
  if (max <= 0) return [0];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw) || 1;
  const stepped = Math.max(1, step);
  return Array.from({ length: Math.floor(max / stepped) + 1 }, (_, i) => i * stepped);
}

const cut = (s: string, n: number) => (n > 1 && s.length > n ? `${s.slice(0, n - 1)}…` : s);
const colLabel = (v: { label: string; short?: string | undefined }) => v.short ?? v.label;
const modeTicks = (mode: ChartMode, max: number) => (mode === 'share' ? [0, 0.25, 0.5, 0.75, 1] : niceTicks(max));
const tickLabel = (mode: ChartMode, t: number) => (mode === 'share' ? percent(t) : num(t));

/** The first mark drawn is the chart's tab stop until another is focused. */
function firstOnce() {
  let first = true;
  return () => {
    const f = first;
    first = false;
    return f;
  };
}

/** The "–" that stands in for cells nobody read in a column: a mark named "not read yet", never a zero-height segment. */
function UnreadMark({ view, column, x, y, first }: { view: ChartView; column: number; x: number; y: number; first: boolean }) {
  const names = unreadRows(view.result, column).map(axisName).join(', ');
  const text = `${columnText(view.result, column).split(':')[0]}: ${names} ${NOT_READ_YET}`;
  return (
    <g className="ck-unread" {...view.host.mark(`u${column}`, text, { first })}>
      <rect x={x - 12} y={y - 14} width={24} height={20} fill="transparent" />
      <text className="ck-dash" x={x} y={y} textAnchor="middle">
        –
      </text>
    </g>
  );
}

function Plot({ title, height, children }: { title: string; height: number; children: ReactNode }) {
  return (
    <svg className="ck-svg" viewBox={`0 0 ${W} ${height}`} role="group" aria-label={title} preserveAspectRatio="xMidYMid meet">
      {children}
    </svg>
  );
}

function maxOf(view: ChartView, sum: boolean): number {
  if (view.mode === 'share') return 1;
  const { result } = view;
  let max = 0;
  result.columns.forEach((_, c) => {
    const values = view.rows.map((r) => view.figure(r, c)).filter((v): v is number => v !== null);
    max = Math.max(max, sum ? values.reduce((a, b) => a + b, 0) : Math.max(0, ...values));
  });
  return max || 1;
}

// Stacked columns and bars -------------------------------------------------------

function Stacked({ view, horizontal }: { view: ChartView; horizontal: boolean }) {
  const { result, mode } = view;
  const n = result.columns.length;
  const max = maxOf(view, true);
  const first = firstOnce();
  const label = (n: number) => (mode === 'share' ? percent(n) : num(n));
  if (horizontal) {
    const longest = Math.max(0, ...result.columns.map((c) => colLabel(c).length));
    const left = Math.min(220, Math.max(132, Math.ceil(longest * 6.4) + 12));
    const right = 16;
    const step = 38;
    const bar = 28;
    const top = 8;
    const H = top + n * step + 28;
    const plot = W - left - right;
    const x = (v: number) => left + (plot * v) / max;
    return (
      <Plot title="Stacked bars" height={H}>
        {modeTicks(mode, max).map((t) => (
          <g key={t}>
            <line className="ck-grid" x1={x(t)} x2={x(t)} y1={top} y2={H - 24} />
            <text className="ck-axis" x={x(t)} y={H - 8} textAnchor="middle">
              {tickLabel(mode, t)}
            </text>
          </g>
        ))}
        {result.columns.map((c, ci) => {
          const y = top + ci * step + (step - bar) / 2;
          let cum = 0;
          const unread = view.rows.length > 0 && unreadRows(result, ci).some((r) => view.rows.includes(result.rows.indexOf(r)));
          return (
            <g key={c.key}>
              <text className="ck-axis ck-axis--row" x={left - 8} y={y + bar / 2 + 4} textAnchor="end">
                {cut(colLabel(c), Math.floor((left - 12) / 6.2))}
              </text>
              {view.rows.map((ri) => {
                const v = view.figure(ri, ci);
                if (v === null || v <= 0) return null;
                const seg = gapped({ x: x(cum), y, width: x(cum + v) - x(cum), height: bar }, SURFACE_GAP);
                cum += v;
                const { mark, kind } = view.look(ri);
                return (
                  <MarkRect key={ri} {...seg} mark={mark} kind={kind} frames={view.frames} {...view.cellMark(ri, ci, first())}>
                    {fitsLabel(seg, label(v)) && <text className="ck-value" x={seg.x + seg.width / 2} y={seg.y + seg.height / 2 + 4} textAnchor="middle">{label(v)}</text>}
                  </MarkRect>
                );
              })}
              {unread && <UnreadMark view={view} column={ci} x={x(cum) + 14} y={y + bar / 2 + 5} first={first()} />}
            </g>
          );
        })}
      </Plot>
    );
  }
  const L = 44;
  const R = 12;
  const T = 20;
  const B = 34;
  const H = 250;
  const plot = W - L - R;
  const slot = plot / Math.max(1, n);
  const bw = Math.min(64, slot * 0.72);
  const base = H - B;
  const y = (v: number) => base - ((base - T) * v) / max;
  const every = Math.max(1, Math.ceil(56 / slot));
  return (
    <Plot title="Stacked columns" height={H}>
      {modeTicks(mode, max).map((t) => (
        <g key={t}>
          <line className="ck-grid" x1={L} x2={W - R} y1={y(t)} y2={y(t)} />
          <text className="ck-axis" x={L - 6} y={y(t) + 4} textAnchor="end">
            {tickLabel(mode, t)}
          </text>
        </g>
      ))}
      {result.columns.map((c, ci) => {
        const cx = L + slot * ci + slot / 2;
        let cum = 0;
        const unread = unreadRows(result, ci).some((r) => view.rows.includes(result.rows.indexOf(r)));
        return (
          <g key={c.key}>
            {view.rows.map((ri) => {
              const v = view.figure(ri, ci);
              if (v === null || v <= 0) return null;
              const seg = gapped({ x: cx - bw / 2, y: y(cum + v), width: bw, height: y(cum) - y(cum + v) }, SURFACE_GAP);
              cum += v;
              const { mark, kind } = view.look(ri);
              return (
                <MarkRect key={ri} {...seg} mark={mark} kind={kind} frames={view.frames} {...view.cellMark(ri, ci, first())}>
                  {fitsLabel(seg, label(v)) && <text className="ck-value" x={cx} y={seg.y + seg.height / 2 + 4} textAnchor="middle">{label(v)}</text>}
                </MarkRect>
              );
            })}
            {unread && <UnreadMark view={view} column={ci} x={cx} y={y(cum) - 6} first={first()} />}
            {ci % every === 0 && (
              <text className="ck-axis" x={cx} y={H - 12} textAnchor="middle">
                {cut(colLabel(c), Math.max(4, Math.floor((slot * every) / 6)))}
              </text>
            )}
          </g>
        );
      })}
    </Plot>
  );
}

export const StackedColumns = ({ view }: { view: ChartView }) => <Stacked view={view} horizontal={false} />;
export const StackedBars = ({ view }: { view: ChartView }) => <Stacked view={view} horizontal />;

// Time plots: area and lines ------------------------------------------------------

const TL = 44;
const TR = 16;
const TT = 20;
const TB = 34;
const TH = 250;

function timeScale(view: ChartView, max: number) {
  const n = view.result.columns.length;
  const base = TH - TB;
  return {
    x: (i: number) => TL + (n <= 1 ? (W - TL - TR) / 2 : ((W - TL - TR) * i) / (n - 1)),
    y: (v: number) => base - ((base - TT) * v) / max,
    base,
  };
}

function TimeAxes({ view, max, x, y }: { view: ChartView; max: number; x: (i: number) => number; y: (v: number) => number }) {
  const { result, mode } = view;
  const every = Math.max(1, Math.ceil(44 / (((W - TL - TR) / Math.max(1, result.columns.length - 1)) || 44)));
  return (
    <>
      {modeTicks(mode, max).map((t) => (
        <g key={t}>
          <line className="ck-grid" x1={TL} x2={W - TR} y1={y(t)} y2={y(t)} />
          <text className="ck-axis" x={TL - 6} y={y(t) + 4} textAnchor="end">
            {tickLabel(mode, t)}
          </text>
        </g>
      ))}
      {result.columns.map((c, i) =>
        i % every === 0 ? (
          <text key={c.key} className="ck-axis" x={x(i)} y={TH - 12} textAnchor={i === 0 && result.columns.length > 1 ? 'start' : 'middle'}>
            {cut(colLabel(c), 10)}
          </text>
        ) : null,
      )}
    </>
  );
}

/** A dot a person can aim at: a visible point with a larger invisible one around it. */
function Dot({ view, row, column, cx, cy, first }: { view: ChartView; row: number; column: number; cx: number; cy: number; first: boolean }) {
  const { mark } = view.look(row);
  return (
    <g className="ck-dot" {...view.cellMark(row, column, first)}>
      <circle cx={cx} cy={cy} r={9} fill="transparent" />
      <circle className={`ck-dot-fill${mark ? '' : ' ck-dot-fill--neutral'}`} cx={cx} cy={cy} r={3.5} {...(mark ? { stroke: mark.stroke, fill: mark.fill } : {})} />
    </g>
  );
}

/** Runs of consecutive columns where `at` has a value: a null is a break in the line, never a point on zero. */
function runs(n: number, at: (i: number) => number | null): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < n; i++) {
    if (at(i) === null) {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push(i);
  }
  if (cur.length) out.push(cur);
  return out;
}

export function StackedArea({ view }: { view: ChartView }) {
  const { result } = view;
  const n = result.columns.length;
  const max = maxOf(view, true);
  const { x, y, base } = timeScale(view, max);
  const first = firstOnce();
  // lo[row][col]: where a row's band starts; null where the cell was not read.
  const lo: Array<Array<number | null>> = [];
  const hi: Array<Array<number | null>> = [];
  const cum = Array<number>(n).fill(0);
  view.rows.forEach((ri) => {
    lo[ri] = [];
    hi[ri] = [];
    for (let c = 0; c < n; c++) {
      const v = view.figure(ri, c);
      lo[ri]![c] = v === null ? null : cum[c]!;
      if (v !== null) cum[c] = cum[c]! + v;
      hi[ri]![c] = v === null ? null : cum[c]!;
    }
  });
  return (
    <Plot title="Stacked area" height={TH}>
      <TimeAxes view={view} max={max} x={x} y={y} />
      {view.rows.map((ri) => {
        const { mark, kind } = view.look(ri);
        return runs(n, (c) => hi[ri]![c]!).map((run) => {
          if (run.length < 2) return null;
          const top = run.map((c) => `${x(c)},${y(hi[ri]![c]!)}`);
          const bottom = [...run].reverse().map((c) => `${x(c)},${y(lo[ri]![c]!)}`);
          return (
            <g key={`${ri}-${run[0]}`} aria-hidden="true" pointerEvents="none">
              <polygon className={kind === 'other' ? 'ck-other' : kind === 'none' ? 'ck-none' : 'ck-fill'} points={[...top, ...bottom].join(' ')} {...(mark ? { fill: mark.fill } : {})} />
              {mark ? <MarkLine points={top.join(' ')} mark={mark} /> : <polyline className="ck-line-neutral" points={top.join(' ')} fill="none" />}
            </g>
          );
        });
      })}
      {view.rows.flatMap((ri) =>
        result.columns.map((_, c) => {
          const top = hi[ri]![c];
          if (top === null || top === undefined || (view.figure(ri, c) ?? 0) <= 0) return null;
          return <Dot key={`${ri}-${c}`} view={view} row={ri} column={c} cx={x(c)} cy={y(top)} first={first()} />;
        }),
      )}
      {result.columns.map((_, c) => (unreadRows(result, c).some((r) => view.rows.includes(result.rows.indexOf(r))) ? <UnreadMark key={`u${c}`} view={view} column={c} x={x(c)} y={base - 6} first={first()} /> : null))}
    </Plot>
  );
}

export interface LinesProps {
  view: ChartView;
  /** A neutral dashed line, one value per column (a burn-up's scope); null where unknown. */
  scope?: Array<number | null>;
  scopeLabel?: string;
  /** A range band, one value per column, null where there is no forecast. */
  forecast?: { low: Array<number | null>; high: Array<number | null>; label?: string };
  /** A thin vertical rule at one column, named in words ("Due 21 Nov"): a date the line is heading for. */
  marker?: { column: string; label: string };
}

export function Lines({ view, scope, scopeLabel = 'Scope', forecast, marker }: LinesProps) {
  const { result, mode } = view;
  const n = result.columns.length;
  const uses = [...view.rows.flatMap((r) => result.columns.map((_, c) => view.figure(r, c))), ...(mode === 'count' ? [...(scope ?? []), ...(forecast?.high ?? [])] : [])].filter((v): v is number => v !== null);
  const max = mode === 'share' ? 1 : Math.max(1, ...uses);
  const { x, y, base } = timeScale(view, max);
  const first = firstOnce();
  const band = forecast ? runs(n, (c) => (forecast.low[c] !== null && forecast.high[c] !== null ? 1 : null)).filter((r) => r.length > 1) : [];
  const forecastName = forecast?.label ?? 'Forecast';
  const lastBand = band.at(-1)?.at(-1);
  const markerAt = marker ? result.columns.findIndex((c) => c.key === marker.column) : -1;
  return (
    <Plot title="Lines" height={TH}>
      <TimeAxes view={view} max={max} x={x} y={y} />
      {markerAt >= 0 && (
        <g className="ck-marker" aria-hidden="true" pointerEvents="none">
          <line x1={x(markerAt)} x2={x(markerAt)} y1={TT - 4} y2={base} />
          <text className="ck-axis ck-marker__label" x={x(markerAt) + (markerAt > n * 0.6 ? -6 : 6)} y={base - 8} textAnchor={markerAt > n * 0.6 ? 'end' : 'start'}>
            {marker!.label}
          </text>
        </g>
      )}
      {mode === 'count' &&
        band.map((run) => (
          <polygon key={run[0]} className="ck-band" aria-hidden="true" points={[...run.map((c) => `${x(c)},${y(forecast!.high[c]!)}`), ...[...run].reverse().map((c) => `${x(c)},${y(forecast!.low[c]!)}`)].join(' ')} />
        ))}
      {mode === 'count' && forecast && lastBand !== undefined && (
        <g {...view.host.mark('forecast', `${forecastName}: ${quantity(result, forecast.low[lastBand]!)} to ${quantity(result, forecast.high[lastBand]!)} by ${axisName(result.columns[lastBand]!)}`, { first: first() })}>
          <rect x={x(lastBand) - 10} y={y(forecast.high[lastBand]!)} width={20} height={Math.max(8, y(forecast.low[lastBand]!) - y(forecast.high[lastBand]!))} fill="transparent" />
          <text className="ck-axis" x={x(lastBand) - 14} y={y(forecast.low[lastBand]!) + 16} textAnchor="end">
            {forecastName}
          </text>
        </g>
      )}
      {mode === 'count' && scope && (
        <>
          {runs(n, (c) => scope[c] ?? null).map((run) => (
            <polyline key={run[0]} className="ck-scope" points={run.map((c) => `${x(c)},${y(scope[c]!)}`).join(' ')} fill="none" />
          ))}
          {scope.map((v, c) =>
            v === null || v === undefined ? null : (
              <g key={`s${c}`} {...view.host.mark(`s${c}`, `${scopeLabel}, ${axisName(result.columns[c]!)}: ${quantity(result, v)}`, { first: first() })}>
                <circle cx={x(c)} cy={y(v)} r={8} fill="transparent" />
                <circle className="ck-scope-dot" cx={x(c)} cy={y(v)} r={2.5} />
              </g>
            ),
          )}
        </>
      )}
      {view.rows.map((ri) => {
        const { mark } = view.look(ri);
        return runs(n, (c) => view.figure(ri, c)).map((run) =>
          run.length < 2 ? null : mark ? <MarkLine key={`${ri}-${run[0]}`} points={run.map((c) => `${x(c)},${y(view.figure(ri, c)!)}`).join(' ')} mark={mark} /> : <polyline key={`${ri}-${run[0]}`} className="ck-line-neutral" points={run.map((c) => `${x(c)},${y(view.figure(ri, c)!)}`).join(' ')} fill="none" />,
        );
      })}
      {view.rows.flatMap((ri) =>
        result.columns.map((_, c) => {
          const v = view.figure(ri, c);
          return v === null ? null : <Dot key={`${ri}-${c}`} view={view} row={ri} column={c} cx={x(c)} cy={y(v)} first={first()} />;
        }),
      )}
      {result.columns.map((_, c) => (unreadRows(result, c).some((r) => view.rows.includes(result.rows.indexOf(r))) ? <UnreadMark key={`u${c}`} view={view} column={c} x={x(c)} y={base - 6} first={first()} /> : null))}
    </Plot>
  );
}

// Heatmap ---------------------------------------------------------------------

/** The ramp: the theme's surface at nothing, its accent at the most. */
export const rampColour = (t: number) => `color-mix(in srgb, var(--accent) ${Math.round(Math.min(1, Math.max(0, t)) * 85)}%, var(--surface))`;

export function Heatmap({ view }: { view: ChartView }) {
  const { result } = view;
  const hatch = `ck-hatch-${useId().replace(/[^\w-]/g, '')}`;
  const longest = Math.max(0, ...view.rows.map((r) => result.rows[r]!.label.length));
  const left = Math.min(220, Math.max(132, Math.ceil(longest * 6.4) + 12));
  const labelMax = Math.floor((left - 12) / 6.2);
  const top = 26;
  const cw = (W - left - 8) / Math.max(1, result.columns.length);
  const ch = 32;
  const H = top + view.rows.length * ch + 8;
  const all = view.rows.flatMap((r) => result.columns.map((_, c) => view.figure(r, c))).filter((v): v is number => v !== null);
  const max = Math.max(...all, 0) || 1;
  const first = firstOnce();
  const fmt = (v: number) => (view.mode === 'share' ? percent(v) : num(v));
  const every = Math.max(1, Math.ceil(40 / cw));
  return (
    <Plot title="Heatmap" height={H}>
      <defs>
        <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line className="ck-hatch" x1="0" y1="0" x2="0" y2="6" />
        </pattern>
      </defs>
      {result.columns.map((c, ci) =>
        ci % every === 0 ? (
          <text key={c.key} className="ck-axis" x={left + cw * ci + cw / 2} y={top - 8} textAnchor="middle">
            {cut(colLabel(c), Math.max(4, Math.floor((cw * every) / 6.5)))}
          </text>
        ) : null,
      )}
      {view.rows.map((ri, k) => (
        <g key={ri}>
          <text className="ck-axis ck-axis--row" x={left - 8} y={top + k * ch + ch / 2 + 4} textAnchor="end">
            {cut(result.rows[ri]!.label, labelMax)}
          </text>
          {result.columns.map((_, ci) => {
            const v = view.figure(ri, ci);
            const t = v === null ? 0 : v / max;
            const g = gapped({ x: left + cw * ci, y: top + k * ch, width: cw, height: ch }, SURFACE_GAP);
            return (
              <g key={ci} className="ck-cell" {...view.cellMark(ri, ci, first())}>
                {v === null ? <rect className="ck-cell-unread" {...g} fill={`url(#${hatch})`} /> : <rect {...g} style={{ fill: rampColour(t) }} />}
                {v === null ? (
                  <text className="ck-dash" x={g.x + g.width / 2} y={g.y + g.height / 2 + 4} textAnchor="middle">
                    –
                  </text>
                ) : (
                  g.width >= 24 && (
                    <text className={`ck-cell-value${t > 0.55 ? ' ck-cell-value--dark' : ''}`} x={g.x + g.width / 2} y={g.y + g.height / 2 + 4} textAnchor="middle">
                      {fmt(v)}
                    </text>
                  )
                )}
              </g>
            );
          })}
        </g>
      ))}
    </Plot>
  );
}

/** The ramp's key: fewer to more, then the one thing a ramp cannot say, that a hatched cell is not zero. */
export function RampKey() {
  return (
    <p className="ck-ramp" aria-hidden="true">
      <span>Fewer</span>
      <span className="ck-ramp__bar" />
      <span>More</span>
      <span className="ck-ramp__none" /> <span>Not read yet</span>
    </p>
  );
}

// Small multiples -------------------------------------------------------------

export function SmallMultiples({ view }: { view: ChartView }) {
  const { result } = view;
  const n = result.columns.length;
  const all = view.rows.flatMap((r) => result.columns.map((_, c) => view.figure(r, c))).filter((v): v is number => v !== null);
  const max = Math.max(...all, 0) || 1;
  const first = firstOnce();
  const w = 200;
  const h = 96;
  const L = 6;
  const base = h - 18;
  const slot = (w - L - 6) / Math.max(1, n);
  const bw = Math.min(26, slot * 0.72);
  return (
    <div className="ck-multiples">
      {view.rows.map((ri) => {
        const { mark, kind } = view.look(ri);
        const name = axisName(result.rows[ri]!);
        return (
          <figure key={ri} className="ck-multiple">
            <figcaption>{name}</figcaption>
            <svg className="ck-svg" viewBox={`0 0 ${w} ${h}`} role="group" aria-label={name}>
              <line className="ck-grid" x1={L} x2={w - 6} y1={base} y2={base} />
              {result.columns.map((c, ci) => {
                const v = view.figure(ri, ci);
                const cx = L + slot * ci + slot / 2;
                const top = v === null ? base : base - ((base - 8) * v) / max;
                return (
                  <g key={c.key}>
                    {v === null ? (
                      <g className="ck-unread" {...view.cellMark(ri, ci, first())}>
                        <rect x={cx - 10} y={base - 20} width={20} height={20} fill="transparent" />
                        <text className="ck-dash" x={cx} y={base - 6} textAnchor="middle">
                          –
                        </text>
                      </g>
                    ) : (
                      v > 0 && <MarkRect {...gapped({ x: cx - bw / 2, y: top, width: bw, height: base - top }, SURFACE_GAP)} mark={mark} kind={kind} frames={view.frames} {...view.cellMark(ri, ci, first())} />
                    )}
                    {(n <= 8 || ci % 2 === 0) && (
                      <text className="ck-axis ck-axis--small" x={cx} y={h - 4} textAnchor="middle">
                        {cut(colLabel(c), Math.max(3, Math.floor(slot / 5.5)))}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          </figure>
        );
      })}
    </div>
  );
}

// Mix bar -----------------------------------------------------------------------

export interface MixBarProps {
  result: PivotResult;
  scheme?: { categories: Array<{ id: string }> };
  pins?: Record<string, 0 | 1 | 2 | 3>;
  onDrill?: (cell: CellRef) => void;
  /** Said to a screen reader before the figures: "Work mix". */
  label?: string;
  /** Names each segment under the bar (a swatch and its name: the key to the marks, the shares are in the headline and the tooltips), for a bar that stands alone on a page. */
  legend?: boolean;
}

/**
 * One thin 100% bar across all the result's columns, one segment per row,
 * sized by the row's total. It has no axis and no wrapper: it is what goes on a
 * person's card or a Summary tile, and each segment is a named mark like any
 * other. Nothing read at all is a dash, not an empty bar.
 */
export function MixBar({ result, scheme, pins, onDrill, label = 'Mix', legend: named = false }: MixBarProps) {
  const marks = useSeriesMarks();
  const frames = useFrames();
  const host = useMarkHost();
  const assignment = assignMarks(result.rows, { ...(scheme ? { scheme } : {}), ...(pins ? { pins } : {}) });
  const totals = result.rowTotals.map((t) => t.value);
  const sum = totals.reduce<number>((a, v) => a + (v ?? 0), 0);
  if (totals.every((v) => v === null) || sum <= 0) return <Unread label={`${label}: ${NOT_READ_YET}`} />;
  const bw = 240;
  const bh = 14;
  let at = 0;
  const first = firstOnce();
  return (
    <span className="ck-mix" ref={host.hostRef} {...host.hostProps}>
      <svg className="ck-svg ck-svg--mix" viewBox={`0 0 ${bw} ${bh}`} role="group" aria-label={label}>
        {result.rows.map((r, ri) => {
          const v = totals[ri];
          if (v === null || v === undefined || v <= 0) return null;
          const seg = gapped({ x: (bw * at) / sum, y: 0, width: (bw * v) / sum, height: bh }, SURFACE_GAP);
          at += v;
          const slot = assignment[r.key];
          const mark = typeof slot === 'number' ? marks[slot] : undefined;
          const kind = typeof slot === 'number' ? 'value' : (slot ?? 'other');
          const text = `${axisName(r)}: ${quantity(result, v)}, ${percent(v / sum)} of ${quantity(result, sum)}`;
          const drill = onDrill && (() => onDrill({ row: r, column: result.columns[0]!, rowIndex: ri, columnIndex: 0, cell: result.rowTotals[ri]! }));
          return <MarkRect key={r.key} {...seg} mark={mark} kind={kind} frames={frames} {...host.mark(`m${ri}`, text, { first: first(), onDrill: drill })} />;
        })}
      </svg>
      {named && (
        <ul className="ck-mix__key" aria-hidden="true">
          {result.rows.map((r, ri) => {
            const v = totals[ri];
            if (v === null || v === undefined || v <= 0) return null;
            const slot = assignment[r.key];
            const mark = typeof slot === 'number' ? marks[slot] : undefined;
            return (
              <li key={r.key}>
                <Swatch mark={mark} kind={typeof slot === 'number' ? 'value' : (slot ?? 'other')} frames={frames} />
                <span>{r.label}</span>
              </li>
            );
          })}
        </ul>
      )}
      {host.tip}
    </span>
  );
}

/** The chart forms by name, for a gallery or a saved view's `chart`. */
export type FormName = 'columns' | 'bars' | 'area' | 'lines' | 'heatmap' | 'multiples';
