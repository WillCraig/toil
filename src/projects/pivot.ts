import { z } from 'zod';
import { inputFields, textOption } from '../areas/util/kit/input.js';
import { ledgerOf, prepare, readLedger, runOn, type Prepared } from '../classify/run.js';
import { personSay } from '../core/classify/ledger.js';
import { defineConfigCommand, type AnyCommand } from '../core/command.js';
import type { CommandContext } from '../core/context.js';
import { ToilError } from '../core/errors.js';
import {
  DIMENSION_MENU, MAX_TOP, MEASURES, isDay, parseDimension, parseWhere, pivot, pivotMarkdown, viewToSpec,
  type Filter, type InsightsPerson, type PivotInput, type PivotResult, type PivotSpec, type SavedView,
} from '../core/insights/index.js';
import { EXAMPLE_BRIEF_RECORDS } from './brief.js';

/**
 * `toil projects pivot` (#567, Layer 2): one measure, split by one dimension,
 * across time or a second one, over Open Work Items the caller read and mapped.
 * It asks no service (principle 3): every tracker is read by its own command
 * and composed through `util owi map`. The toil project supplies the people
 * (for `team`), the scheme (for `category`) and the saved views; the model is
 * `pivot()` in src/core/insights/, which Toil UI draws from too, so a figure
 * on a screen is the figure here. A pivot with no categories would be a pivot
 * of unclassified work, which in most organisations is just called work.
 */

export const toilProjectArg = { name: 'toil-project', field: 'toilProject', description: 'A toil project name or file (default: the one the folder matches, if any)', required: false };
export const asOfField = z.string().datetime({ offset: true }).optional().describe('The moment to count to, as an ISO 8601 time (default: now). Ages, work in progress and the default period are counted to it.');

/** The dimension grammar as a fix shows it: the menu, then the two forms the menu can't list. */
export const dimensionHelp = (): string => `Choose from: ${DIMENSION_MENU.map((d) => d.spec).join(', ')}, label:<prefix>, area:<depth>, or dim:<name> for a dimension the toil project names.`;
export const whereHelp = 'Write "<dimension> = value, value" or "<dimension> != value", for example --where "status != Done" or --where "release = 1.4, 1.5".';

const bad = (message: string, fix: string): ToilError => new ToilError('INVALID_INPUT', message, { fix });

/** Checks a measure, so a typo gets the list of measures rather than a model error. */
export function checkMeasure(value: string, flag = '--measure'): PivotSpec['measure'] {
  if (!(MEASURES as readonly string[]).includes(value)) throw bad(`${flag} "${value}" isn't a measure.`, `Use one of: ${MEASURES.join(', ')}.`);
  return value as PivotSpec['measure'];
}

export function checkDimension(value: string, flag: string): string {
  try {
    parseDimension(value);
  } catch (err) {
    throw bad(`${flag}: ${(err as Error).message}`, dimensionHelp());
  }
  return value;
}

export function checkFilters(values: readonly string[]): Filter[] {
  return values.map((text) => {
    try {
      return parseWhere(text);
    } catch (err) {
      throw bad(`--where: ${(err as Error).message}`, whereHelp);
    }
  });
}

export function checkDay(value: string, flag: string): string {
  if (!isDay(value)) throw bad(`${flag} "${value}" isn't a day.`, `Write it as YYYY-MM-DD, for example ${flag} 2026-10-01.`);
  return value;
}

/** The toil project's people as the model reads them; none listed is none told, so `team` stays unread rather than empty. */
export function peopleOf(p: Prepared): InsightsPerson[] | undefined {
  const people = p.applied?.file.toilProject?.people ?? [];
  if (people.length === 0) return undefined;
  return people.map((x) => ({ name: x.name, ...(x.team !== undefined ? { team: x.team } : {}), ...(x.email !== undefined ? { email: x.email } : {}), ids: x.ids }));
}

export interface Classified {
  prepared: Prepared;
  /** Each item's category id by OWI id; null where the engine looked and stayed unsure. */
  categories: Record<string, string | null>;
  /** How each item's category was decided: rules, signals, labels (a label or a field), parent, agent, person, unsure. They add up to the item count. */
  sources: Record<'rules' | 'signals' | 'labels' | 'parent' | 'agent' | 'person' | 'unsure', number>;
  input: Pick<PivotInput, 'items' | 'changes' | 'people' | 'categories' | 'scheme'>;
}

/** Reads the records and runs the classification engine, as `classify run` does, so every item has been looked at: settled, or unsure. */
export async function classified(input: Parameters<typeof prepare>[0], ctx: CommandContext<unknown>): Promise<Classified> {
  const prepared = await prepare(input, ctx);
  const ledger = ledgerOf(ctx);
  const held = ledger ? readLedger(ledger, prepared.scheme.name, ctx, { optional: true }) : undefined;
  const result = runOn(prepared, ctx, { planFields: false, ...(held ? { person: personSay(held.lines) } : {}) });
  const categories: Record<string, string | null> = {};
  const sources: Classified['sources'] = { rules: 0, signals: 0, labels: 0, parent: 0, agent: 0, person: 0, unsure: 0 };
  for (const v of result.verdicts) {
    categories[v.id] = v.category;
    const s = v.source;
    if (s.startsWith('rule:')) sources.rules++;
    else if (s.startsWith('signal:')) sources.signals++;
    else if (s === 'label' || s === 'field') sources.labels++;
    else sources[s as 'parent' | 'agent' | 'person' | 'unsure']++;
  }
  const people = peopleOf(prepared);
  // A record written by hand may leave out `history`; the model reads null as "never read" and would fail on a missing one.
  const items = prepared.items.map((i) => (i.history === undefined ? { ...i, history: null } : i));
  return {
    prepared, categories, sources,
    input: {
      items, changes: prepared.changes, ...(people ? { people } : {}), categories,
      scheme: { name: prepared.scheme.name, revision: prepared.scheme.revision, categories: prepared.scheme.categories.map((c) => ({ id: c.id, name: c.name, short: c.short })) },
    },
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Tells `meta.warnings` what the table could not read, from the result's own
 * structure, so a caller who reads only meta notices. A filter that could not
 * judge items is the one fact held only as a sentence, so that sentence is passed on as it is.
 */
export function unreadWarnings(result: PivotResult, ctx: CommandContext<unknown>, code: string): void {
  const c = result.coverage;
  const axes = [{ axis: result.split, unread: c.unreadSplit }, { axis: result.across, unread: c.unreadAcross }];
  for (const { axis, unread } of axes) {
    if (!axis || unread === 0) continue;
    ctx.warn({ code, message: `${axis.label} wasn't read for ${unread} of ${plural(c.items, 'item')}${axis.read ? '; they are left out of the table' : ', so the table could not be drawn'}.` });
  }
  const drawn = axes.every(({ axis }) => !axis || axis.read);
  const { measured, of } = result.total;
  if (drawn && measured < of) {
    ctx.warn({ code, message: `${result.measure.label} could be read for ${measured} of ${plural(of, 'item')} in the table; the rest are left out of the figures.${result.total.reason ? ` ${result.total.reason}` : ''}` });
  }
  for (const note of c.notes) if (note.startsWith('The filter "') && note.includes('could not judge')) ctx.warn({ code, message: note });
}

/** One run of the model, with its Errors (a period that ends before it starts) turned into an envelope that says what to change. */
export function runPivot(input: PivotInput): PivotResult {
  const from = input.spec.from;
  const to = input.spec.to;
  if (from !== undefined && to !== undefined && from > to) throw bad(`The period starts after it ends (${from} to ${to}).`, 'Make --from on or before --to.');
  return pivot(input);
}

export const flagsFor = (): Array<{ flags: string; field: string; description: string }> => [
  { flags: '--measure <id>', field: 'measure', description: `What to count: ${MEASURES.join(', ')} (default: items)` },
  { flags: '--split <dimension>', field: 'split', description: 'The rows: one dimension, for example category, release, team, parent:Epic' },
  { flags: '--across <dimension>', field: 'across', description: 'The columns: a dimension, usually a time one such as resolved:week' },
  { flags: '--where <filter>', field: 'where', description: 'Keep only matching items (repeatable): "status != Done", "release = 1.4, 1.5"' },
  { flags: '--from <day>', field: 'from', description: 'The period starts on this day, YYYY-MM-DD (default: 90 days before --to)' },
  { flags: '--to <day>', field: 'to', description: 'The period ends on this day, YYYY-MM-DD (default: the --as-of day)' },
  { flags: '--share', field: 'share', description: "Add each cell's share of its column's total" },
  { flags: '--top <n>', field: 'top', description: 'Rows that keep their own line before the rest fold into Other (default 4; 0 keeps all)' },
  { flags: '--pin <label>', field: 'pin', description: 'A row that always keeps its line (repeatable)' },
  { flags: '--include-parents', field: 'includeParents', description: 'Count parent items too when splitting by a parent dimension' },
];

export function toilProjectPivotCommands(): AnyCommand[] {
  const pivotCommand = defineConfigCommand({
    path: ['projects', 'pivot'],
    description: 'Pivot a toil project\'s work items: one measure, split by one dimension, across time or another, from OWI records you pass (local only)',
    toolDescription:
      "Pivots Open Work Item records you pass (what util owi map printed, as inputFile or text; several envelopes are fine). Asks no service: read each tracker with its own command and map it first. measure is items, estimate, days (person-days in progress), throughput, cycleTime, wip or aging; split makes the rows and across the columns, each a dimension: category, type, status, statusCategory, priority, assignee, team, parent (parent:Epic, parent:top), iteration, sprint, release, affects, component, label (label:<prefix>), area, project, tracker, connection, dim:<name>, created/started/resolved with :week, :month or :quarter, age, size, planned, hasEpic, carried, reopened. where keeps matching items (\"status != Done\", \"release = 1.4, 1.5\"); view runs a saved view of the toil project, and any field you pass overrides the view's. Every item is classified by the toil project's scheme (or scheme, else ktlo-feature) so category always works. Returns { toilProject, view, scheme { name, revision }, spec, asOf, period, measure, split, across, rows, columns, cells[row][column] { value, share, items, measured, of, reason }, rowTotals, columnTotals, total, allValues, coverage { items, measured, unreadSplit, unreadAcross, notes }, notable, markdown }. A figure nobody read is null, never 0: coverage and meta.warnings (PIVOT_UNREAD) say what was not read. Cite a cell as [[cell:<column>/<row>]] and an item as [[<owi id>]]. markdown adds the pivot as a Markdown table.",
    input: z.object({
      toilProject: z.string().min(1).optional().describe('A toil project name, or the path to a toil project file. Defaults to the toil project that applies to the folder, if there is one; with none, there are no people and the built-in scheme applies.'),
      cwd: z.string().min(1).optional().describe('The folder to look from; its repository decides which checked-in toil projects apply. Defaults to the workspace.'),
      ...inputFields,
      measure: z.string().min(1).optional().describe(`What to count: ${MEASURES.join(', ')} (default items)`),
      split: z.string().min(1).optional().describe('The rows: a dimension, for example category, release, team, parent:Epic, dim:customer'),
      across: z.string().min(1).optional().describe('The columns: a dimension, usually a time one such as resolved:week or created:month'),
      where: z.array(z.string().min(1)).optional().describe('Filters, each "<dimension> = a, b" or "<dimension> != a". An item a filter cannot judge, because the dimension was never read, is left out by = and kept by !=, and counted in coverage.'),
      from: z.string().min(1).optional().describe('The first day of the period, YYYY-MM-DD (default: 90 days before to)'),
      to: z.string().min(1).optional().describe('The last day of the period, YYYY-MM-DD (default: the day of asOf)'),
      share: z.boolean().optional().describe("Add each cell's share (0 to 1) of its column's total"),
      top: z.number().int().min(0).max(MAX_TOP).optional().describe('How many split values keep their own row before the rest fold into Other (default 4; 0 keeps all)'),
      pin: z.array(z.string().min(1)).optional().describe('Split values, by label, that always keep a row'),
      includeParents: z.boolean().optional().describe('When splitting by a parent dimension, count the parents too (default: they are left out and their children carry the work)'),
      asOf: asOfField,
      view: z.string().min(1).optional().describe("The name of a saved view in the toil project (views.<name>). Any other field passed overrides the view's; where replaces its filters."),
      scheme: z.string().min(1).optional().describe("The scheme that gives each item its category: a name, or a path to a scheme file. Defaults to the toil project's, else the built-in ktlo-feature."),
      markdown: z.boolean().optional().describe('Also return the pivot as a Markdown table in data.markdown, with the period, what was left out and what moved.'),
    }),
    writes: false,
    writesLocal: false,
    args: [toilProjectArg],
    options: [
      { flags: '--input-file <path>', field: 'inputFile', description: 'The OWI records: a file inside the workspace, or - for stdin (the default when no --text is given)', deprecated: ['--file <path>'] },
      textOption,
      ...flagsFor(),
      { flags: '--as-of <time>', field: 'asOf', description: 'Count to this ISO 8601 time (default: now)' },
      { flags: '--view <name>', field: 'view', description: "Run a saved view of the toil project; flags you pass override its fields" },
      { flags: '--scheme <name|file>', field: 'scheme', description: "The scheme for category: a name, or a path to a file (default: the toil project's, else ktlo-feature)" },
      { flags: '--markdown', field: 'markdown', description: 'Also print the pivot as a Markdown table in data.markdown' },
      { flags: '--cwd <dir>', field: 'cwd', description: 'The folder to look from (default: the working directory)' },
    ],
    examples: [
      { toilProject: 'payments', text: EXAMPLE_BRIEF_RECORDS, measure: 'items', split: 'category', share: true, asOf: '2026-10-13T08:00:00Z' },
      {
        toilProject: 'payments', cwd: '.', inputFile: 'owi/brief.owi.json', measure: 'throughput', split: 'category', across: 'resolved:week', where: ['status != Cancelled'],
        from: '2026-09-01', to: '2026-10-13', top: 3, pin: ['Feature'], includeParents: true, scheme: 'balance', markdown: true, asOf: '2026-10-13T08:00:00Z',
      },
      { toilProject: 'payments', inputFile: 'owi/brief.owi.json', view: 'release-mix', asOf: '2026-10-13T08:00:00Z' },
    ],
    run: async (input, ctx) => {
      // Everything the caller typed is checked first, one flag at a time, so each refusal names its own flag and fix.
      const measure = input.measure !== undefined ? checkMeasure(input.measure) : undefined;
      const split = input.split !== undefined ? checkDimension(input.split, '--split') : undefined;
      const across = input.across !== undefined ? checkDimension(input.across, '--across') : undefined;
      const where = input.where !== undefined ? checkFilters(input.where) : undefined;
      const from = input.from !== undefined ? checkDay(input.from, '--from') : undefined;
      const to = input.to !== undefined ? checkDay(input.to, '--to') : undefined;

      const c = await classified(input, ctx);
      const toilProject = c.prepared.applied?.file.toilProject;
      let view: SavedView | undefined;
      if (input.view !== undefined) {
        if (!toilProject) throw bad(`--view ${input.view} needs a toil project, and none applies.`, 'Name one with its positional argument, or run from a folder one matches.');
        view = toilProject.views?.[input.view];
        if (!view) {
          const names = Object.keys(toilProject.views ?? {});
          throw bad(`Toil project ${toilProject.name} has no view named "${input.view}".`, names.length ? `It has: ${names.join(', ')}.` : 'It has none yet. Save one with toil projects view set.');
        }
      }
      const base = view ? viewToSpec(view) : undefined;
      const spec: PivotSpec = { ...(base ?? {}), measure: measure ?? base?.measure ?? 'items' };
      if (split !== undefined) spec.split = split;
      if (across !== undefined) spec.across = across;
      if (where !== undefined) spec.where = where;
      if (from !== undefined) spec.from = from;
      if (to !== undefined) spec.to = to;
      if (input.share !== undefined) spec.share = input.share;
      if (input.top !== undefined) spec.top = input.top;
      if (input.pin !== undefined) spec.pin = input.pin;
      if (input.includeParents !== undefined) spec.includeParents = input.includeParents;

      const result = runPivot({ ...c.input, spec, asOf: input.asOf ?? new Date().toISOString() });
      unreadWarnings(result, ctx, 'PIVOT_UNREAD');
      return {
        toilProject: toilProject?.name ?? null,
        view: input.view ?? null,
        scheme: { name: c.prepared.scheme.name, revision: c.prepared.scheme.revision },
        ...result,
        ...(input.markdown ? { markdown: pivotMarkdown(result) } : {}),
      };
    },
  });
  return [pivotCommand];
}
