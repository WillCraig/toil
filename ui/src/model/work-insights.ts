/**
 * The data layer under the Summary's charts, the Work mix item and the filter bar
 * (#567): everything the pure pivot model (src/core/insights/) needs, built once
 * from a loaded toil project. The classification runs here, in the page, with the
 * pure engine, so a category is the same answer in the Summary tile, a chart, a
 * drill list and `toil classify run`. A pivot is memoized by its spec, so the
 * headline in Where the work goes and the chart it opens are one computation and
 * cannot disagree. A figure nobody read stays `null` all the way to the screen
 * (principle 12). Named model/work-insights.ts because model/insights.ts is the
 * per-ticket "worth a look" model, and two files of one name would be a merger.
 * The reconciliation of two tabs called Insights is scheduled for a future quarter.
 */

import type { Verdict } from '../../../src/core/classify/types.ts';
import {
  addDays, applyFilters, computeMeasure, dayOf, DIMENSION_MENU, NONE_KEY, parseDimension, pivot, releaseScope, valuesOf,
  type Filter, type InsightsCategory, type InsightsPerson, type PivotAxisValue, type PivotCell, type PivotResult, type PivotSpec, type ReleaseScope, type ValuesContext,
} from '../../../src/core/insights/index.ts';
import { bucketLabel, bucketsBetween, bucketStart } from '../../../src/core/insights/dimensions.ts';
import { day, sourceLabel } from '../format.ts';
import { categoriesOf, classifyItems, insightsPeople, schemeFor, schemeSummary, withHistory, type Classification } from '../insights-input.ts';
import type { ToilProjectData } from '../load.ts';
import { asMapped } from './people.ts';
import type { WorkItem } from '../toil.ts';

export const DEFAULT_PERIOD_DAYS = 90;

/** How the page says a verdict was reached, grouped the way a person thinks about it. */
export interface MixSources {
  total: number;
  /** Rules the team wrote, toil's built-in signals, and the parent's category. */
  rules: number;
  /** A label or a field the item already carried. */
  labels: number;
  agent: number;
  people: number;
  unsure: number;
}

/** Counts verdicts by how they were decided; `unsure` is anything with no category, whoever looked. */
export function mixSources(verdicts: Iterable<Pick<Verdict, 'source' | 'category'>>): MixSources {
  const out: MixSources = { total: 0, rules: 0, labels: 0, agent: 0, people: 0, unsure: 0 };
  for (const v of verdicts) {
    out.total++;
    if (v.category === null) out.unsure++;
    else if (v.source === 'label' || v.source === 'field') out.labels++;
    else if (v.source === 'agent') out.agent++;
    else if (v.source === 'person') out.people++;
    else out.rules++;
  }
  return out;
}

export interface Release {
  name: string;
  /** Due, or went out, as `YYYY-MM-DD`. */
  date: string | null;
  start: string | null;
  released: boolean;
}

export interface WorkInsights {
  /** The moment figures are counted to, and its day. */
  asOf: string;
  today: string;
  items: WorkItem[];
  people: InsightsPerson[];
  scheme: { name: string; revision: number; categories: InsightsCategory[] };
  /** Each category's definition, for a tooltip, by id. */
  definitions: Record<string, { name: string; short: string; definition: string }>;
  /** Set when the toil project names a scheme this page can't resolve, so the source line says which one was used instead. */
  schemeNote: string | null;
  /** Each item's category id, null for unsure. */
  categories: Record<string, string | null>;
  verdicts: ReadonlyMap<string, Verdict>;
  /** The trackers the items came from, as people name them, and the earliest item created. */
  trackers: string[];
  earliest: string | null;
  /** Whether the read fetched fix versions at all: if no item carries the field, they were never asked for. */
  releasesRead: boolean;
  releases: Release[];
  run: (spec: PivotSpec) => PivotResult;
  /** The same pivot over only these items (a sprint's done items, an epic's children), with the same people, categories and scheme. Memoized. */
  runOver: (ids: Iterable<string>, spec: PivotSpec) => PivotResult;
  /** The values a dimension holds in this data, for the filter bar's menu; `null` when it was never read. */
  valuesIn: (dimension: string) => Array<{ key: string; label: string; short?: string; count: number }> | null;
  /** The same view over only the items that pass the filters, so every figure on a page agrees with the filters on it. Memoized. */
  narrow: (where: Filter[]) => WorkInsights;
  /** What one item holds in a dimension, in words: "Checkout, Accounts", "No fix version"; null when the read never fetched it. */
  valueText: (item: WorkItem, dimension: string) => string | null;
  scope: (release: string) => ReleaseScope;
  /** "From Jira and GitHub, read 13 Oct 2026. Items go back to 2 Sep 2026." */
  sourceLine: () => string;
}

const sentence = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/**
 * The scheme a toil project's page uses: the built-in one it names, else the standard Keep the lights on / Feature
 * scheme, with a note saying so when it named one the page can't resolve. One function, insights-input.ts's, so the
 * screen and the agent's tools read the same scheme.
 */
export const resolveScheme = schemeFor;

/**
 * What the screens call an item no rule, label, agent or person has put in a category. toil's pivot calls it "Unsure", which
 * a person read as the product failing; it is an unknown, so it says so plainly (principle 12, #657). Only the words change:
 * the key stays the pivot's own `none`, so a filter, a drill or a saved view keeps working.
 */
export const NOT_SORTED = 'Not sorted yet';

const isCategory = (spec: string | null | undefined) => spec !== null && spec !== undefined && parseDimension(spec).base === 'category';
const relabelAxis = (values: PivotResult['rows']) => values.map((v) => (v.kind === 'none' ? { ...v, label: NOT_SORTED } : v));

/** A pivot's result in the screens' words: a category split's or across's none row reads Not sorted yet. */
function inScreenWords(r: PivotResult): PivotResult {
  const split = isCategory(r.split?.spec);
  const across = isCategory(r.across?.spec);
  if (!split && !across) return r;
  return {
    ...r,
    rows: split ? relabelAxis(r.rows) : r.rows,
    columns: across ? relabelAxis(r.columns) : r.columns,
    allValues: split ? r.allValues.map((v) => (v.key === NONE_KEY ? { ...v, label: NOT_SORTED } : v)) : r.allValues,
  };
}

/** A dimension's none label in the screens' words. */
const noneLabelOf = (d: { base: string; noneLabel: string | null }) => (d.base === 'category' ? NOT_SORTED : d.noneLabel);

export function buildInsights(data: Pick<ToilProjectData, 'items' | 'people'>, now: string, schemeName?: string | null, extra: Classification = {}): WorkInsights {
  return makeInsights(data.items.map((i) => withMappedAssignee(i, data.people)), insightsPeople(data.people), now, schemeName, undefined, extra);
}

/**
 * The item with its assignee as the person the toil project maps them to, so the assignee dimension (the filter bar's Assignee,
 * a lane, a person's mix) has one value per person, not one per account. An item whose assignee nobody maps is the same object.
 */
function withMappedAssignee(item: WorkItem, people: ToilProjectData['people']): WorkItem {
  const assignee = asMapped(people ?? [], item.source.area, item.assignee);
  return assignee === item.assignee ? item : { ...item, assignee };
}

/**
 * `verdicts` is passed when a view narrows an earlier one: an item's category can come from its parent, which a filter may
 * have taken out of the input, so the narrowed view keeps the verdicts of the whole and never classifies a fragment afresh.
 */
function makeInsights(items: WorkItem[], people: InsightsPerson[], now: string, schemeName?: string | null, whole?: ReadonlyMap<string, Verdict>, extra: Classification = {}): WorkInsights {
  const classified = classifyItems(whole ? [] : items, schemeName, extra);
  const { scheme, note } = classified;
  const verdicts = whole ?? classified.verdicts;
  const categories = categoriesOf(items, verdicts);
  const summary = schemeSummary(scheme);
  const today = dayOf(now) ?? now.slice(0, 10);
  const readable = withHistory(items);
  const memo = new Map<string, PivotResult>();
  const run = (spec: PivotSpec): PivotResult => {
    const key = JSON.stringify(spec);
    let r = memo.get(key);
    if (!r) memo.set(key, (r = inScreenWords(pivot({ items: readable, spec, asOf: now, people, categories, scheme: summary }))));
    return r;
  };
  const areas = [...new Set(items.map((i) => i.source.area))].sort();
  const created = items.map((i) => dayOf(i.created)).filter((d): d is string => d !== null).sort();
  const seen = new Map<string, Release>();
  for (const i of items) {
    for (const r of i.releases ?? []) {
      const prior = seen.get(r.name);
      seen.set(r.name, { name: r.name, date: dayOf(r.date) ?? prior?.date ?? null, start: r.start ?? prior?.start ?? null, released: r.released === true || prior?.released === true });
    }
  }
  const releases = [...seen.values()];
  const index = new Map(items.map((i) => [i.id, i]));
  const vctx: ValuesContext = { asOf: now, period: { from: addDays(today, 1 - DEFAULT_PERIOD_DAYS), to: today }, people, categories, scheme: summary, index };
  const overMemo = new Map<string, PivotResult>();
  const runOver: WorkInsights['runOver'] = (ids, spec) => {
    const keep = new Set(ids);
    const key = `${[...keep].sort().join('|')}#${JSON.stringify(spec)}`;
    let r = overMemo.get(key);
    if (!r) overMemo.set(key, (r = inScreenWords(pivot({ items: readable.filter((i) => keep.has(i.id)), spec, asOf: now, people, categories, scheme: summary }))));
    return r;
  };
  const valueMemo = new Map<string, ReturnType<WorkInsights['valuesIn']>>();
  const valuesIn: WorkInsights['valuesIn'] = (dimension) => {
    if (valueMemo.has(dimension)) return valueMemo.get(dimension)!;
    const d = parseDimension(dimension);
    const tally = new Map<string, { key: string; label: string; short?: string; count: number; order: string }>();
    let read = 0;
    for (const item of items) {
      const v = valuesOf(item, d, vctx);
      if (v.unread) continue;
      read++;
      const held = v.values.length === 0 ? (noneLabelOf(d) === null ? [] : [{ key: NONE_KEY, label: noneLabelOf(d)!, short: undefined as string | undefined, order: '\uffff' }]) : v.values.map((e) => ({ ...e, order: e.order ?? '' }));
      for (const e of held) {
        const t = tally.get(e.key) ?? { key: e.key, label: e.label, ...(e.short ? { short: e.short } : {}), count: 0, order: e.order };
        t.count++;
        tally.set(e.key, t);
      }
    }
    const out = read === 0 ? null : [...tally.values()].sort((a, b) => a.order.localeCompare(b.order) || a.label.localeCompare(b.label)).map(({ order: _o, ...rest }) => rest);
    valueMemo.set(dimension, out);
    return out;
  };
  const valueText: WorkInsights['valueText'] = (item, dimension) => {
    const d = parseDimension(dimension);
    const v = valuesOf(item, d, vctx);
    if (v.unread) return null;
    return v.values.length === 0 ? (noneLabelOf(d) ?? 'None') : v.values.map((e) => e.label).join(', ');
  };
  const narrowed = new Map<string, WorkInsights>();
  const self: WorkInsights = {
    asOf: now, today, items, people, scheme: summary,
    definitions: Object.fromEntries(scheme.categories.map((c) => [c.id, { name: c.name, short: c.short, definition: c.definition }])),
    schemeNote: note, categories, verdicts, trackers: areas.map(sourceLabel), earliest: created[0] ?? null,
    releasesRead: items.some((i) => i.releases !== undefined), releases, run, runOver, valuesIn, valueText,
    scope: (release) => releaseScope(items, release, now),
    narrow: (where) => {
      if (where.length === 0) return self;
      const key = JSON.stringify(where);
      let n = narrowed.get(key);
      if (!n) narrowed.set(key, (n = makeInsights(applyFilters(items, where, vctx).kept, people, now, schemeName, verdicts, extra)));
      return n;
    },
    sourceLine: () => (items.length === 0 ? 'No items were read.' : `From ${sentence([...new Set(areas.map(sourceLabel))])}, read ${day(now)}.${created[0] ? ` Items go back to ${day(`${created[0]}T00:00:00Z`)}.` : ''}`),
  };
  return self;
}

// The period ----------------------------------------------------------------------------

/** The period a filter state names, as the pivot reads it: explicit days, else the 90 up to today. */
export function periodOf(today: string, from?: string, to?: string): { from: string; to: string } {
  const end = to ?? today;
  return { from: from ?? addDays(end, 1 - DEFAULT_PERIOD_DAYS), to: end };
}

/** "last 90 days" when the period is that, else "12 Oct to 10 Nov". */
export function periodWords(today: string, p: { from: string; to: string }): string {
  if (p.to === today) {
    const n = Math.round((Date.parse(`${p.to}T00:00:00Z`) - Date.parse(`${p.from}T00:00:00Z`)) / 86_400_000) + 1;
    if (n === 30 || n === 90) return `last ${n} days`;
  }
  return `${day(`${p.from}T00:00:00Z`)} to ${day(`${p.to}T00:00:00Z`)}`;
}

// Shares ----------------------------------------------------------------------------------

export interface MixLine {
  key: string;
  /** What a person reads: the category's name, Not sorted yet for none. */
  name: string;
  /** The short form, for a tooltip only. */
  short?: string;
  id: string | null;
  value: number;
  share: number;
  items: string[];
}

/** The category shares of a result with a category split and no across: biggest first, Not sorted yet last. Null when nothing was counted, never an empty mix of zeros. */
export function mixLines(result: PivotResult): MixLine[] | null {
  if (!result.split?.read || result.rows.length === 0) return null;
  const totals = result.rowTotals;
  const sum = totals.reduce((n, t) => n + (t.value ?? 0), 0);
  if (sum <= 0) return null;
  const lines = result.rows.flatMap((r, i): MixLine[] => {
    const v = totals[i]!.value;
    if (v === null || v <= 0) return [];
    return [{ key: r.key, name: r.label, ...(r.short ? { short: r.short } : {}), id: r.kind === 'none' ? null : r.key.replace(/^v:/, ''), value: v, share: v / sum, items: totals[i]!.items }];
  });
  return lines.sort((a, b) => Number(a.id === null) - Number(b.id === null) || b.value - a.value);
}

export const percentText = (share: number) => `${Math.round(share * 100)}%`;

// Name order ---------------------------------------------------------------------------------

/**
 * A result's columns in name order, with "none" last. The pivot arranges a plain axis largest first, which for a split by
 * person is a league table; the team is measured, never the person, so people and teams are put back in the alphabet.
 */
export function inNameOrder(result: PivotResult): PivotResult {
  const order = result.columns.map((c, i) => ({ c, i })).sort((a, b) => Number(a.c.kind === 'none') - Number(b.c.kind === 'none') || Number(a.c.kind === 'other') - Number(b.c.kind === 'other') || a.c.label.localeCompare(b.c.label));
  return { ...result, columns: order.map((o) => o.c), cells: result.cells.map((row) => order.map((o) => row[o.i]!)), columnTotals: order.map((o) => result.columnTotals[o.i]!) };
}

/** The same for a result whose rows are the people or squads: rows in name order, "none" last, never by size. */
export function rowsInNameOrder(result: PivotResult): PivotResult {
  const order = result.rows.map((r, i) => ({ r, i })).sort((a, b) => Number(a.r.kind === 'none') - Number(b.r.kind === 'none') || Number(a.r.kind === 'other') - Number(b.r.kind === 'other') || a.r.label.localeCompare(b.r.label));
  return { ...result, rows: order.map((o) => o.r), cells: order.map((o) => result.cells[o.i]!), rowTotals: order.map((o) => result.rowTotals[o.i]!) };
}

/** The dimensions whose values are people or squads, which a chart shows in name order and never sorted by size. */
export const PEOPLE_DIMENSIONS = ['assignee', 'team'];
export const isPeopleDimension = (spec: string) => PEOPLE_DIMENSIONS.includes(parseDimension(spec).base);

// The dimensions a menu offers --------------------------------------------------------------------

/** Every dimension a Split by or Add filter menu offers: the menu's own, in the order a person looks for them. */
export const SPLIT_MENU = DIMENSION_MENU.filter((d) => d.kind !== 'time');
export const FILTER_MENU = DIMENSION_MENU.filter((d) => d.kind !== 'time');
export const labelOfDimension = (spec: string): string => {
  try {
    return parseDimension(spec).label;
  } catch {
    return spec;
  }
};

// A release's burn-up ---------------------------------------------------------------------------------

const DAY = 86_400_000;
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const endOf = (start: string, grain: 'week' | 'month') => (grain === 'week' ? addDays(start, 6) : addDays(bucketStart(addDays(start, 32), 'month'), -1));

export interface Burnup {
  result: PivotResult;
  /** The scope line, one value per column; null where the day hasn't come. */
  scope: Array<number | null>;
  /** The last day each column counts to (today for the one still filling), null for a day that hasn't come. A click opens "done by" that day. */
  upTo: Array<string | null>;
  /** The column the due date falls in, null when it has none or falls outside the columns. */
  dueColumn: number | null;
}

/**
 * Done items, cumulative, by week toward a release's date, with the scope line. It is built here and not by `pivot()`,
 * whose time dimensions count a bucket and not a running total; each cell still carries the ids behind it so a click opens
 * them. The columns run to the due date, so the date is in the picture; a day that hasn't come yet is null (unknown),
 * never a flat line that claims nothing will be done.
 */
export function burnupOf(ins: WorkInsights, release: Release): Burnup | null {
  const held = ins.items.filter((i) => (i.releases ?? []).some((r) => r.name === release.name));
  if (held.length === 0) return null;
  const created = held.map((i) => dayOf(i.created)).filter((d): d is string => d !== null).sort();
  const from = release.start ?? created[0] ?? ins.today;
  // Work that hasn't started has no done line to draw: every column would be a day that hasn't come.
  if (from > ins.today) return null;
  const to = release.date !== null && release.date > ins.today ? release.date : ins.today;
  const grain = Math.round((dayMs(to) - dayMs(from)) / DAY) > 150 ? 'month' : 'week';
  const starts = bucketsBetween(from, to, grain);
  // A done item with no resolved date has no day to stand on: it is left off the line and counted as unmeasured, never as done today.
  const doneItems = held.filter((i) => i.statusCategory === 'DONE');
  const doneDay = new Map(doneItems.flatMap((i) => { const d = dayOf(i.resolved); return d === null ? [] : [[i.id, d] as const]; }));
  const undated = doneItems.length - doneDay.size;
  const measuredItems = held.length - undated;
  const cells: PivotCell[] = [];
  const scope: Array<number | null> = [];
  const upTo: Array<string | null> = [];
  for (const s of starts) {
    const end = endOf(s, grain);
    if (s > ins.today) {
      cells.push({ value: null, items: [], measured: 0, of: held.length, reason: 'This day has not come yet.' });
      scope.push(null);
      upTo.push(null);
      continue;
    }
    const through = end < ins.today ? end : ins.today;
    upTo.push(through);
    const ids = held.filter((i) => doneDay.has(i.id) && doneDay.get(i.id)! <= through).map((i) => i.id).sort();
    cells.push({ value: ids.length, items: ids, measured: measuredItems, of: held.length });
    scope.push(held.filter((i) => { const c = dayOf(i.created); return c === null || c <= through; }).length);
  }
  const columns: PivotAxisValue[] = starts.map((s) => ({ key: `v:${s}`, label: grain === 'week' ? dayWords(s) : bucketLabel(s, grain), kind: 'value' }));
  const row: PivotAxisValue = { key: 'v:done', label: 'Done', kind: 'value' };
  const last = cells.filter((c) => c.value !== null).at(-1)!;
  const dueColumn = release.date === null ? null : starts.findIndex((s) => s <= release.date! && release.date! <= endOf(s, grain));
  const result: PivotResult = {
    spec: { measure: 'items', across: `resolved:${grain}` }, asOf: ins.asOf, period: { from, to },
    measure: { id: 'items', unit: 'items', label: 'Items' },
    split: null, across: { spec: `resolved:${grain}`, label: `Done by ${grain}`, kind: 'time', read: true },
    rows: [row], columns, cells: [cells], rowTotals: [last], columnTotals: cells, total: last,
    allValues: [], coverage: { items: held.length, measured: measuredItems, unreadSplit: 0, unreadAcross: 0, parentsLeftOut: 0, multi: false, notes: undated > 0 ? [`${undated} done ${undated === 1 ? 'item has' : 'items have'} no resolved date, so ${undated === 1 ? 'it is' : 'they are'} not on the line.`] : [] }, notable: [],
  };
  return { result, scope, upTo, dueColumn: dueColumn !== null && dueColumn >= 0 ? dueColumn : null };
}

// Releases ---------------------------------------------------------------------------------------------

/** Unreleased releases, soonest first (a date that has passed is the most urgent, so it sorts first), then the latest one that went out. */
export function releasesToShow(ins: WorkInsights): { open: Release[]; latest: Release | null } {
  const open = ins.releases.filter((r) => !r.released).sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.name.localeCompare(b.name));
  const out = ins.releases.filter((r) => r.released).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.name.localeCompare(a.name));
  return { open, latest: out[0] ?? null };
}

/** Days from today to a release's date: negative once it has passed. */
export const daysUntil = (today: string, date: string): number => Math.round((dayMs(date) - dayMs(today)) / DAY);

export const dayWords = (date: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));

// The two headlines -------------------------------------------------------------------------------------

/** What the Work mix dashboard counts, and what the unit menu calls it: finished items, their estimates, or the days people spent on them. */
export const MIX_UNITS = [
  { id: 'items', measure: 'throughput', label: 'Items finished' },
  { id: 'estimate', measure: 'estimate', label: 'Estimate' },
  { id: 'days', measure: 'days', label: 'Days in progress' },
] as const;
export type MixUnit = (typeof MIX_UNITS)[number]['id'];

/** The mix of what was finished in a period: one row per category, no across. The Summary's Work mix item, Where the work goes and the Work mix page all start here. */
export function mixOverview(ins: WorkInsights, f: { from?: string; to?: string; where?: Filter[] } = {}, unit: MixUnit = 'items'): { result: PivotResult; lines: MixLine[] | null; period: { from: string; to: string } } {
  const period = periodOf(ins.today, f.from, f.to);
  const measure = MIX_UNITS.find((u) => u.id === unit)!.measure;
  const result = ins.run({ measure, split: 'category', ...period, ...(f.where && f.where.length > 0 ? { where: f.where } : {}) });
  return { result, lines: mixLines(result), period };
}

/**
 * How the items a mix counted were decided, for the panel beside it (#657). For Items finished that is only the items
 * finished in the period, judged by the pivot's own throughput measure, so the panel's Not sorted yet and the headline's
 * count the same items, with the same verdicts and one rule for unsure (no category). For the other units it is every
 * item the measure holds, since their shares are of points or days and the panel's are of items.
 */
export function mixDecided(ins: WorkInsights, lead: { result: PivotResult; period: { from: string; to: string } }, unit: MixUnit = 'items'): MixSources {
  const measure = MIX_UNITS.find((u) => u.id === unit)!.measure;
  const byId = new Map(ins.items.map((i) => [i.id, i]));
  const ctx = { asOf: ins.asOf, period: lead.period, unit: 'points' as const, days: new Map<string, number | null>() };
  const counted = (id: string) => {
    if (measure !== 'throughput') return true;
    const item = byId.get(id);
    return item !== undefined && computeMeasure('throughput', [item], ctx).value === 1;
  };
  return mixSources(lead.result.total.items.flatMap((id) => (counted(id) && ins.verdicts.get(id) ? [ins.verdicts.get(id)!] : [])));
}

/** "Feature 55% · Keep the lights on 35% · Not sorted yet 10%", worked out from one result; null when nothing was counted. */
export const mixSentence = (lines: MixLine[]): string => lines.map((l) => `${l.name} ${percentText(l.share)}`).join(' · ');

export interface ReleaseLine {
  release: Release;
  scope: ReleaseScope;
  /** Done as a share of everything in it; null when nothing is in it. */
  doneShare: number | null;
  daysLeft: number | null;
}

/** The release the Summary and Where the work goes lead with: the unreleased one due soonest (a date that has passed is the most urgent). */
export function nextRelease(ins: WorkInsights): ReleaseLine | null {
  const { open } = releasesToShow(ins);
  const release = open[0];
  if (!release) return null;
  const scope = ins.scope(release.name);
  return { release, scope, doneShare: scope.total === 0 ? null : scope.done / scope.total, daysLeft: release.date === null ? null : daysUntil(ins.today, release.date) };
}

/** "2.4 due 21 Nov: 76% done, 8 added since it started". The added clause is a floor that needs a start date, so without one it says so rather than saying 0. */
export function releaseSentence(r: ReleaseLine): string {
  const due = r.release.date === null ? 'has no date' : `due ${dayWords(r.release.date)}`;
  const done = r.doneShare === null ? 'nothing in it yet' : `${percentText(r.doneShare)} done`;
  const added = r.scope.added === null ? 'no start date, so what was added since is not known' : `${r.scope.added} added since it started`;
  return `${r.release.name} ${due}: ${done}, ${added}`;
}
