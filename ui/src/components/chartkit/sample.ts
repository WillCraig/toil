/**
 * Fixed sample pivot results for the chart kit's gallery (`#/chartkit`) and its
 * tests, shaped as `src/core/insights/types.ts` says: rows, columns,
 * `cells[row][column]` with a null where nothing was read, totals and shares.
 * `makeResult` builds the whole table from a grid of numbers so a sample says
 * only what is interesting about it. Placeholder names throughout.
 * The figures are invented, in the way a sample is: confidently and without any ticket numbers.
 */

import { ALL_KEY, type PivotAxisValue, type PivotCell, type PivotResult } from '../../../../src/core/insights/types.ts';

export interface SampleSpec {
  measure?: { id: PivotResult['measure']['id']; unit: PivotResult['measure']['unit']; label: string };
  split?: { spec: string; label: string; kind?: 'single' | 'multi' | 'parent' | 'time' | 'derived'; read?: boolean } | null;
  across?: { spec: string; label: string; kind?: 'single' | 'multi' | 'parent' | 'time' | 'derived'; read?: boolean } | null;
  rows: PivotAxisValue[];
  columns: PivotAxisValue[];
  /** `values[row][column]`; null is an unread cell. */
  values: Array<Array<number | null>>;
  /** Cells where the measure read only some items, as `"row,col": measured`. */
  partial?: Record<string, number>;
  notes?: string[];
}

const cell = (value: number | null, of = 0, measured = of): PivotCell => ({ value, items: [], measured: value === null ? 0 : measured, of, ...(value === null ? { reason: 'No item in it has an estimate' } : {}) });
const sum = (xs: Array<number | null>): number | null => (xs.every((x) => x === null) ? null : xs.reduce<number>((a, x) => a + (x ?? 0), 0));

export function makeResult(spec: SampleSpec): PivotResult {
  const measure = spec.measure ?? { id: 'items' as const, unit: 'items' as const, label: 'Items' };
  const cells = spec.values.map((row, r) => row.map((v, c) => cell(v, v === null ? 3 : Math.round(v), spec.partial?.[`${r},${c}`] ?? Math.round(v ?? 0))));
  const colTotals = spec.columns.map((_, c) => sum(spec.values.map((row) => row[c]!)));
  cells.forEach((row) => row.forEach((x, c) => { const t = colTotals[c]; x.share = x.value === null || !t ? null : x.value / t; }));
  const rowTotals = spec.values.map((row) => cell(sum(row), 1));
  const all = sum(colTotals);
  return {
    spec: { measure: measure.id, share: true },
    asOf: '2026-11-09T12:00:00Z',
    period: { from: '2026-08-11', to: '2026-11-09' },
    measure,
    split: spec.split === null ? null : { kind: 'single', read: true, ...(spec.split ?? { spec: 'category', label: 'Category' }) },
    across: spec.across === null ? null : { kind: 'time', read: true, ...(spec.across ?? { spec: 'created:month', label: 'Created, by month' }) },
    rows: spec.rows,
    columns: spec.columns,
    cells,
    rowTotals,
    columnTotals: colTotals.map((v) => cell(v, 1)),
    total: cell(all, 1),
    allValues: spec.rows.map((r, i) => ({ key: r.key, label: r.label, value: rowTotals[i]!.value, items: Math.round(rowTotals[i]!.value ?? 0) })),
    coverage: { items: 0, measured: 0, unreadSplit: 0, unreadAcross: 0, parentsLeftOut: 0, multi: false, notes: spec.notes ?? [] },
    notable: [],
  };
}

const value = (key: string, label: string, short?: string): PivotAxisValue => ({ key: `v:${key}`, label, kind: 'value', ...(short ? { short } : {}) });
const other: PivotAxisValue = { key: '(other)', label: 'Other', kind: 'other' };
const none = (label: string): PivotAxisValue => ({ key: '(none)', label, kind: 'none' });
const months = ['Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov'].map((m) => value(`2026-${m}`, m));

/** Work mix: two categories, Other and Not sorted yet, over six months, in points. One month's Keep the lights on was never estimated. */
export const WORK_MIX = makeResult({
  measure: { id: 'estimate', unit: 'points', label: 'Estimate' },
  split: { spec: 'category', label: 'Category' },
  across: { spec: 'created:month', label: 'Created, by month' },
  rows: [value('ktlo', 'Keep the lights on', 'KTLO'), value('features', 'New features', 'FEAT'), other, none('Not sorted yet')],
  columns: months,
  values: [
    [14, 18, 20, null, 26, 24],
    [30, 28, 31, 35, 29, 33],
    [4, 5, 3, 6, 4, 5],
    [6, 4, 5, 3, 2, 3],
  ],
  partial: { '0,5': 3 },
  notes: ['One month of Keep the lights on has no estimate on any item, so it is a dash, not a zero.'],
});

/** The same, with nothing unread, for the forms that draw a plain table. */
export const WORK_MIX_COMPLETE = makeResult({
  measure: { id: 'items', unit: 'items', label: 'Items' },
  rows: [value('ktlo', 'Keep the lights on', 'KTLO'), value('features', 'New features', 'FEAT'), other, none('Not sorted yet')],
  columns: months,
  values: [
    [14, 18, 20, 17, 26, 24],
    [30, 28, 31, 35, 29, 33],
    [4, 5, 3, 6, 4, 5],
    [6, 4, 5, 3, 2, 3],
  ],
});

/** A release split with six values (four marks, then Other, then no fix version), across the type of work, so it draws as bars. */
export const RELEASES = makeResult({
  split: { spec: 'release', label: 'Release', kind: 'multi' },
  across: { spec: 'type', label: 'Type' },
  rows: [value('4.2', '4.2'), value('4.3', '4.3'), value('4.4', '4.4'), value('4.5', '4.5'), other, none('No fix version')],
  columns: [value('story', 'Story'), value('bug', 'Bug'), value('task', 'Task'), value('incident', 'Incident')],
  values: [
    [24, 9, 7, 1],
    [18, 12, 6, 0],
    [11, 6, 9, 2],
    [8, 3, 4, 0],
    [5, 4, 2, 1],
    [9, 14, 10, 3],
  ],
  notes: ['An item with several fix versions counts once in each, so the rows add up to more than the total.'],
});

/** One row, over twelve days: a burn-up's done line. */
export const BURNUP = makeResult({
  split: { spec: 'statusCategory', label: 'Status' },
  across: { spec: 'resolved:day', label: 'Resolved, by day' },
  rows: [value('done', 'Done')],
  columns: Array.from({ length: 10 }, (_, i) => value(`d${i}`, `Nov ${i + 1}`)),
  values: [[0, 2, 5, 6, 9, 12, 13, 17, 19, 22]],
});
export const BURNUP_SCOPE: Array<number | null> = [30, 30, 32, 32, 32, 35, 35, 35, 36, 36];
export const BURNUP_FORECAST = {
  low: [null, null, null, null, null, null, null, 17, 21, 26] as Array<number | null>,
  high: [null, null, null, null, null, null, null, 17, 25, 36] as Array<number | null>,
  label: 'Forecast',
};

/** A result whose split was never read: the frame says so and draws nothing. */
export const UNREAD_SPLIT: PivotResult = {
  ...WORK_MIX_COMPLETE,
  split: { spec: 'release', label: 'Release', kind: 'multi', read: false },
  rows: [],
  cells: [],
  rowTotals: [],
};

/** A single-column result, for a mix bar on a person's card. */
export const PERSON_MIX = makeResult({
  split: { spec: 'category', label: 'Category' },
  across: null,
  rows: [value('ktlo', 'Keep the lights on', 'KTLO'), value('features', 'New features', 'FEAT'), other, none('Not sorted yet')],
  columns: [{ key: ALL_KEY, label: 'All items', kind: 'value' }],
  values: [[8], [11], [2], [1]],
});
