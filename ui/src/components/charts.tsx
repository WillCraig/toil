/**
 * The dashboard's charts (#253), drawn as plain SVG: a sprint burn-up, a
 * throughput sparkline and a cycle-time scatter. No chart library: three
 * small drawings don't need one, and SVG takes the theme's tokens as they
 * are. Each chart is an image with a summary for a screen reader, and has its
 * figures in a table under "Show the figures", so nothing is only visual.
 * Lines draw themselves in once, only where motion is welcome
 * (app.css honours `prefers-reduced-motion`).
 * Charts for the steering group, finally with their working shown.
 */

import { useId, type CSSProperties, type ReactNode } from 'react';
import { day } from '../format.ts';
import { DataTable } from './layout.tsx';
import type { Burnup } from '../model/burnup.ts';
import type { Week } from '../model/flow.ts';
import type { DayCalls } from '../usage.ts';

const W = 560;
const PAD = { left: 34, right: 12, top: 14, bottom: 26 };
const round1 = (n: number) => Math.round(n * 10) / 10;

function Figures({ caption, head, rows }: { caption: string; head: string[]; rows: ReactNode[][] }) {
  return (
    <details className="figures">
      <summary>Show the figures</summary>
      <DataTable
        label={caption}
        caption={caption}
        rows={rows.map((cells, i) => ({ i, cells }))}
        rowKey={(r) => String(r.i)}
        columns={head.map((h, j) => ({ header: h, label: h, rowHeader: j === 0, cell: (r: { cells: ReactNode[] }) => r.cells[j] }))}
      />
    </details>
  );
}

/**
 * Each chart carries a vertical gradient a theme can fill its bars and areas
 * with (#271), as `fill: var(--chart-fill)`, colouring the stops in its own
 * stylesheet. Plain never asks for it, so its fills stay flat.
 */
function Svg({ label, height, children }: { label: string; height: number; children: ReactNode }) {
  const id = useId();
  const fill = `chart-fill-${id.replace(/[^\w-]/g, '')}`;
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${height}`} role="img" aria-labelledby={id} preserveAspectRatio="xMidYMid meet" style={{ '--chart-fill': `url(#${fill})` } as CSSProperties}>
      <title id={id}>{label}</title>
      <defs>
        <linearGradient id={fill} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="chart-stop chart-stop--top" />
          <stop offset="1" className="chart-stop chart-stop--bottom" />
        </linearGradient>
      </defs>
      {children}
    </svg>
  );
}

const ticks = (max: number) => {
  const step = max <= 5 ? 1 : max <= 12 ? 2 : max <= 30 ? 5 : 10;
  return Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step);
};

export function BurnupChart({ b, sprint }: { b: Burnup; sprint: string }) {
  const H = 220;
  const total = b.days.length + b.ahead;
  const max = Math.max(1, ...b.days.map((d) => d.scope));
  const x = (i: number) => PAD.left + ((W - PAD.left - PAD.right) * (i + 1)) / Math.max(1, total);
  const y = (v: number) => H - PAD.bottom - ((H - PAD.top - PAD.bottom) * v) / max;
  const x0 = PAD.left;
  const scope = [`${x0},${y(b.days[0]?.scope ?? 0)}`, ...b.days.map((d, i) => `${x(i)},${y(d.scope)}`)].join(' ');
  const done = [`${x0},${y(0)}`, ...b.days.map((d, i) => `${x(i)},${y(d.done)}`)].join(' ');
  const last = b.days.at(-1);
  const area = `${done} ${x(b.days.length - 1)},${y(0)} ${x0},${y(0)}`;
  const label = last
    ? `${sprint} burn-up: ${last.done} of ${last.scope} points done after ${b.days.length} days, with ${b.ahead} days to go.${b.days[0] && last.scope > b.days[0].scope ? ` Scope grew from ${b.days[0].scope} to ${last.scope} points.` : ''}`
    : `${sprint} burn-up: no days yet.`;
  return (
    <figure className="chart-figure">
      <Svg label={label} height={H}>
        {ticks(max).map((t) => (
          <g key={t}>
            <line className="grid" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
            <text className="axis" x={PAD.left - 6} y={y(t) + 4} textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        <line className="today" x1={x(b.days.length - 1)} x2={x(b.days.length - 1)} y1={PAD.top} y2={H - PAD.bottom} />
        <polygon className="area" points={area} />
        <polyline className="line line--scope" points={scope} pathLength={1} />
        <polyline className="line line--done" points={done} pathLength={1} />
        <text className="axis" x={x0} y={H - 8}>
          Start
        </text>
        <text className="axis" x={x(b.days.length - 1)} y={H - 8} textAnchor="middle">
          Today
        </text>
        <text className="axis" x={W - PAD.right} y={H - 8} textAnchor="end">
          End
        </text>
      </Svg>
      <figcaption className="legend">
        <span className="key-swatch key-swatch--done" aria-hidden="true" /> Done points <span className="key-swatch key-swatch--scope" aria-hidden="true" /> Scope
        {b.unplaced.length > 0 && <span className="note"> {b.unplaced.length} done items have no recorded finish and aren't drawn.</span>}
      </figcaption>
      <Figures caption={`${sprint} burn-up by day`} head={['Day', 'Scope (points)', 'Done (points)']} rows={b.days.map((d) => [day(d.at), d.scope, d.done])} />
    </figure>
  );
}

export function ThroughputSpark({ weeks, noun = 'items finished' }: { weeks: Week[]; noun?: string }) {
  const H = 96;
  const max = Math.max(1, ...weeks.map((w) => w.items.length));
  const slot = (W - PAD.left - PAD.right) / weeks.length;
  const bar = Math.min(48, slot * 0.6);
  const y = (v: number) => H - 22 - ((H - 40) * v) / max;
  const total = weeks.reduce((n, w) => n + w.items.length, 0);
  const label = `Throughput: ${total} ${noun} in ${weeks.length} weeks, ${weeks.map((w) => w.items.length).join(', ')} by week, oldest first. The last week is still running.`;
  return (
    <figure className="chart-figure">
      <Svg label={label} height={H}>
        <line className="grid" x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} />
        {weeks.map((w, i) => {
          const cx = PAD.left + slot * i + slot / 2;
          return (
            <g key={w.start}>
              <rect className={`bar${w.partial ? ' bar--partial' : ''}`} x={cx - bar / 2} y={y(w.items.length)} width={bar} height={Math.max(0, y(0) - y(w.items.length))} rx={3} />
              <text className="axis axis--value" x={cx} y={y(w.items.length) - 5} textAnchor="middle">
                {w.items.length}
              </text>
              <text className="axis" x={cx} y={H - 6} textAnchor="middle">
                {day(w.start).replace(/ \d{4}$/, '')}
              </text>
            </g>
          );
        })}
      </Svg>
      <Figures caption={`${noun[0]!.toUpperCase()}${noun.slice(1)} per week`} head={['Week of', noun === 'items finished' ? 'Finished' : 'Count']} rows={weeks.map((w) => [`${day(w.start)}${w.partial ? ' (so far)' : ''}`, w.items.length])} />
    </figure>
  );
}

export interface ScatterPoint {
  id: string;
  label: string;
  end: string;
  days: number;
}

export function CycleScatter({ points, p85 }: { points: ScatterPoint[]; p85: number | null }) {
  const H = 200;
  const ends = points.map((p) => Date.parse(p.end));
  const lo = Math.min(...ends);
  const hi = Math.max(...ends);
  const span = Math.max(1, hi - lo);
  const max = Math.max(1, ...points.map((p) => p.days), p85 ?? 0);
  const x = (t: number) => PAD.left + 10 + ((W - PAD.left - PAD.right - 20) * (t - lo)) / span;
  const y = (v: number) => H - PAD.bottom - ((H - PAD.top - PAD.bottom) * v) / (max * 1.1);
  const label = `Cycle time: ${points.length} finished items, from ${round1(Math.min(...points.map((p) => p.days)))} to ${round1(max)} days.${p85 !== null ? ` 85% finished within ${round1(p85)} days.` : ''}`;
  return (
    <figure className="chart-figure">
      <Svg label={label} height={H}>
        {ticks(Math.ceil(max)).map((t) => (
          <g key={t}>
            <line className="grid" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
            <text className="axis" x={PAD.left - 6} y={y(t) + 4} textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        {p85 !== null && (
          <g>
            <line className="p85" x1={PAD.left} x2={W - PAD.right} y1={y(p85)} y2={y(p85)} />
            <text className="axis axis--p85" x={W - PAD.right} y={y(p85) - 5} textAnchor="end">
              85% within {round1(p85)} days
            </text>
          </g>
        )}
        {points.map((p) => (
          <circle key={p.id} className="dot" cx={x(Date.parse(p.end))} cy={y(p.days)} r={6} />
        ))}
        <text className="axis" x={PAD.left} y={H - 8}>
          {day(new Date(lo).toISOString())}
        </text>
        <text className="axis" x={W - PAD.right} y={H - 8} textAnchor="end">
          {day(new Date(hi).toISOString())}
        </text>
      </Svg>
      <Figures caption="Cycle time per finished item" head={['Item', 'Finished', 'Cycle time']} rows={points.map((p) => [p.label, day(p.end), `${round1(p.days)} days`])} />
    </figure>
  );
}

/**
 * Calls per day (#309), from `toil audit stats --by day`: one bar a day, the
 * scale's top beside the tallest, and a date under every few, so thirty bars
 * still read at 375px. The figures table under it holds every day's calls and
 * failures.
 */
export function CallsPerDay({ days }: { days: DayCalls[] }) {
  const total = days.reduce((n, d) => n + d.calls, 0);
  const busiest = days.reduce<DayCalls | null>((b, d) => (!b || d.calls > b.calls ? d : b), null);
  const label = `Calls per day: ${total} calls in ${days.length} days${busiest && busiest.calls > 0 ? `, the most on ${day(busiest.day)} with ${busiest.calls}` : ''}.`;
  return <DayBars days={days} value={(d) => d.calls} label={label} max={String} figures={<Figures caption="Calls per day, UTC" head={['Day', 'Calls', 'Failed']} rows={days.map((d) => [day(d.day), d.calls, d.failed])} />} />;
}

/** Tokens per day (#295), for Settings, Usage: the same bars, in the meter's figures. */
export function TokensPerDay({ days, compact }: { days: Array<{ day: string; tokens: number }>; compact: (n: number) => string }) {
  const total = days.reduce((n, d) => n + d.tokens, 0);
  const busiest = days.reduce<{ day: string; tokens: number } | null>((b, d) => (!b || d.tokens > b.tokens ? d : b), null);
  const label = `Tokens per day: ${compact(total)} tokens in ${days.length} days${busiest && busiest.tokens > 0 ? `, the most on ${day(busiest.day)} with ${compact(busiest.tokens)}` : ''}.`;
  return <DayBars days={days} value={(d) => d.tokens} label={label} max={compact} figures={<Figures caption="Tokens per day, UTC" head={['Day', 'Tokens']} rows={days.map((d) => [day(d.day), d.tokens.toLocaleString('en-US')])} />} />;
}

/** One bar a day, the busiest day at the top of the scale. */
function DayBars<T extends { day: string }>({ days, value, label, max: maxLabel, figures }: { days: T[]; value: (d: T) => number; label: string; max: (n: number) => string; figures: ReactNode }) {
  const H = 110;
  const max = Math.max(1, ...days.map(value));
  const slot = (W - PAD.left - PAD.right) / Math.max(1, days.length);
  const bar = Math.max(2, Math.min(32, slot * 0.7));
  const y = (v: number) => H - 22 - ((H - 40) * v) / max;
  const every = Math.max(1, Math.ceil(days.length / 6));
  return (
    <figure className="chart-figure">
      <Svg label={label} height={H}>
        <line className="grid" x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} />
        <text className="axis" x={PAD.left - 6} y={y(max) + 4} textAnchor="end">
          {maxLabel(max)}
        </text>
        {days.map((d, i) => {
          const cx = PAD.left + slot * i + slot / 2;
          return (
            <g key={d.day}>
              <rect className="bar" x={cx - bar / 2} y={y(value(d))} width={bar} height={Math.max(0, y(0) - y(value(d)))} rx={2} />
              {/* Every other date is minor, and a phone's stylesheet hides those, so the dates still fit at 375px. */}
              {(i % every === 0 || i === days.length - 1) && (
                <text className={`axis${i !== days.length - 1 && (i / every) % 2 === 1 ? ' axis--minor' : ''}`} x={cx} y={H - 4} textAnchor="middle">
                  {day(d.day).replace(/ \d{4}$/, '')}
                </text>
              )}
            </g>
          );
        })}
      </Svg>
      {figures}
    </figure>
  );
}

/**
 * A sparkline for the Overview's metric strip (#394): a few values drawn the
 * size of a word, as a line or as bars, with an optional second line (a
 * burn-up's scope). It is for the eye only: its tile says the figure in words,
 * and the full chart, with its figures, is one press away.
 */
export function Sparkline({ values, kind = 'line', against, mark }: { values: number[]; kind?: 'line' | 'bars'; against?: number[]; mark?: number | null }) {
  const SW = 120;
  const SH = 32;
  const all = [...values, ...(against ?? []), mark ?? 0];
  const max = Math.max(1, ...all);
  const y = (v: number) => SH - 2 - ((SH - 4) * v) / max;
  const x = (i: number, n: number) => (n <= 1 ? SW / 2 : (SW * i) / (n - 1));
  const line = (vs: number[]) => vs.map((v, i) => `${x(i, vs.length).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const slot = SW / Math.max(1, values.length);
  return (
    <svg className={`spark spark--${kind}`} viewBox={`0 0 ${SW} ${SH}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      {mark != null && <line className="spark__mark" x1={0} x2={SW} y1={y(mark)} y2={y(mark)} />}
      {against && against.length > 0 && <polyline className="spark__against" points={line(against)} />}
      {kind === 'bars'
        ? values.map((v, i) => <rect key={i} className="spark__bar" x={slot * i + slot * 0.15} y={y(v)} width={slot * 0.7} height={Math.max(1, SH - 2 - y(v))} rx={1} />)
        : values.length > 0 && <polyline className="spark__line" points={line(values)} />}
    </svg>
  );
}
