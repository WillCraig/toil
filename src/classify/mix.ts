import { z } from 'zod';
import { inputFields, textOption } from '../areas/util/kit/input.js';
import { defineConfigCommand, type AnyCommand } from '../core/command.js';
import { ToilError } from '../core/errors.js';
import { NONE_KEY, TIME_GRAINS, type PivotCell, type PivotResult, type PivotSpec } from '../core/insights/index.js';
import { EXAMPLE_BRIEF_RECORDS } from '../projects/brief.js';
import { asOfField, checkDay, classified, runPivot, unreadWarnings } from '../projects/pivot.js';
import { cwdField, cwdOption, fileOption, schemeField, schemeOption, toilProjectField, toilProjectOption } from './run.js';

/**
 * `toil classify mix` (#566, Step 5): the work mix, how finished work divides
 * between a scheme's categories, per week, month or quarter, or per team,
 * assignee, project, epic, component or release. A thin wrapper over the
 * insights pivot (split by category, shares on, nothing folded into Other), so
 * the mix a person reads here is the pivot's figure and not a second opinion.
 * Unsure is always its own line: a mix that quietly shares the unsure items out
 * among the categories is a budget, not a measurement. Reads local files only.
 */

const BY = ['week', 'month', 'quarter'] as const;
const GROUPS = { team: 'team', assignee: 'assignee', project: 'project', epic: 'parent:Epic', component: 'component', release: 'release' } as const;
const UNITS = { count: null, estimate: 'estimate', days: 'days' } as const;

export interface MixShare {
  /** A category id, or `unsure`. */
  category: string;
  name: string;
  short: string | null;
  value: number | null;
  share: number | null;
  items: number;
}

const round = (n: number) => Math.round(n * 10000) / 10000;

export function classifyMixCommands(): AnyCommand[] {
  const mix = defineConfigCommand({
    path: ['classify', 'mix'],
    description: "Show how work divides between a scheme's categories, by period or by team, assignee, project, epic, component or release (local only)",
    toolDescription:
      "Classifies Open Work Item records you pass (what util owi map printed, as inputFile or text; same input as classify_run: toilProject, cwd, scheme) and shows the mix: each category's share of the finished work per week, month or quarter (by, default month), or per team, assignee, project, epic, component or release (group). unit counts items (count, the default: items finished per period, or items per group), sums estimates (estimate) or counts person-days in progress (days). from and to bound the period (days, YYYY-MM-DD; default the 90 days to asOf). Asks no service. Returns { scheme { name, revision }, toilProject, unit, by, group, periods or groups [{ key, label, total, shares [{ category (an id, or unsure), name, short, value, share, items }] }], overall [same shares], sources { rules, signals, labels, parent, agent, person, unsure } (how each item's category was decided, adding up to the item count), coverage, notable }. Unsure is always its own share, never spread over the categories. A share that cannot be computed is null with a MIX_UNREAD warning, never 0; a period with no finished work has null shares and a MIX_EMPTY warning. Cite a figure as [[cell:<column>/<row>]].",
    input: z.object({
      ...inputFields,
      toilProject: toilProjectField,
      cwd: cwdField,
      scheme: schemeField,
      by: z.enum(BY).optional().describe('The period of each column: week, month (default) or quarter. Used when group is not set.'),
      group: z.enum(Object.keys(GROUPS) as [keyof typeof GROUPS, ...Array<keyof typeof GROUPS>]).optional().describe('Show one column per team, assignee, project, epic, component or release instead of per period'),
      unit: z.enum(Object.keys(UNITS) as [keyof typeof UNITS, ...Array<keyof typeof UNITS>]).optional().describe('What a share counts: count (default), estimate or days'),
      from: z.string().min(1).optional().describe('The first day of the period, YYYY-MM-DD (default: 90 days before to)'),
      to: z.string().min(1).optional().describe('The last day of the period, YYYY-MM-DD (default: the day of asOf)'),
      asOf: asOfField,
    }),
    writes: false,
    writesLocal: false,
    options: [
      fileOption,
      textOption,
      toilProjectOption,
      cwdOption,
      schemeOption,
      { flags: '--by <period>', field: 'by', description: 'week, month (the default) or quarter' },
      { flags: '--group <by>', field: 'group', description: `One column per ${Object.keys(GROUPS).join(', ')} instead of per period` },
      { flags: '--unit <unit>', field: 'unit', description: 'count (the default), estimate or days' },
      { flags: '--from <day>', field: 'from', description: 'The period starts on this day, YYYY-MM-DD (default: 90 days before --to)' },
      { flags: '--to <day>', field: 'to', description: 'The period ends on this day, YYYY-MM-DD (default: the --as-of day)' },
      { flags: '--as-of <time>', field: 'asOf', description: 'Count to this ISO 8601 time (default: now)' },
    ],
    examples: [
      { text: EXAMPLE_BRIEF_RECORDS, asOf: '2026-10-13T08:00:00Z' },
      { toilProject: 'payments', cwd: '.', inputFile: 'owi/brief.owi.json', scheme: 'balance', by: 'week', unit: 'estimate', from: '2026-09-01', to: '2026-10-13', asOf: '2026-10-13T08:00:00Z' },
      { inputFile: 'owi/brief.owi.json', group: 'assignee', unit: 'days', asOf: '2026-10-13T08:00:00Z' },
    ],
    run: async (input, ctx) => {
      const by = input.by ?? 'month';
      if (!(TIME_GRAINS as readonly string[]).includes(by)) throw new ToilError('INVALID_INPUT', `--by "${by}" isn't a period.`, { fix: `Use one of: ${BY.join(', ')}.` });
      const unit = input.unit ?? 'count';
      const from = input.from !== undefined ? checkDay(input.from, '--from') : undefined;
      const to = input.to !== undefined ? checkDay(input.to, '--to') : undefined;
      const c = await classified(input, ctx);
      const grouped = input.group !== undefined;
      const measure = UNITS[unit] ?? (grouped ? 'items' : 'throughput');
      const spec: PivotSpec = { measure, split: 'category', across: grouped ? GROUPS[input.group!] : `resolved:${by}`, share: true, top: 0, ...(from ? { from } : {}), ...(to ? { to } : {}) };
      const result = runPivot({ ...c.input, spec, asOf: input.asOf ?? new Date().toISOString() });
      unreadWarnings(result, ctx, 'MIX_UNREAD');

      const scheme = c.input.scheme!;
      const rowAt = new Map(result.rows.map((r, i) => [r.key === NONE_KEY ? 'unsure' : r.key.replace(/^v:/, ''), i]));
      const lines = [...scheme.categories.map((x) => ({ category: x.id, name: x.name, short: x.short as string | null })), { category: 'unsure', name: 'Unsure', short: null }];
      const sharesOf = (cellAt: (row: number) => PivotCell | undefined, total: PivotCell): MixShare[] => lines.map((line) => {
        const at = rowAt.get(line.category);
        const cell = at === undefined ? undefined : cellAt(at);
        const value = cell ? cell.value : total.value === null ? null : 0;
        const share = value === null || total.value === null || total.value === 0 ? null : round(value / total.value);
        return { ...line, value, share, items: cell?.items.length ?? 0 };
      });
      const columns = result.columns.map((col, ci) => {
        const total = result.columnTotals[ci]!;
        return { key: col.key, label: col.label, total: total.value, shares: sharesOf((r) => result.cells[r]?.[ci], total) };
      });
      const overall = sharesOf((r) => result.rowTotals[r], result.total);
      warnNulls(columns, result, ctx);

      return {
        scheme: { name: scheme.name, revision: scheme.revision },
        toilProject: c.prepared.toilProject,
        unit,
        by: grouped ? null : by,
        group: input.group ?? null,
        asOf: result.asOf,
        period: result.period,
        measure: result.measure,
        [grouped ? 'groups' : 'periods']: columns,
        overall,
        sources: c.sources,
        coverage: result.coverage,
        notable: result.notable,
      };
    },
  });
  return [mix];
}

/** A share is null for one of two reasons, said apart: the measure could not be read, or the column holds no finished work. */
function warnNulls(columns: Array<{ label: string; total: number | null; shares: MixShare[] }>, result: PivotResult, ctx: Parameters<typeof unreadWarnings>[1]): void {
  const unread = columns.filter((x) => x.total === null || x.shares.some((s) => s.value === null));
  const empty = columns.filter((x) => x.total === 0);
  if (unread.length > 0) {
    ctx.warn({ code: 'MIX_UNREAD', message: `${result.measure.label} could not be read for ${unread.length} of ${columns.length} columns (${unread.slice(0, 3).map((x) => x.label).join(', ')}${unread.length > 3 ? ', …' : ''}), so their shares are null, not 0.` });
  }
  if (empty.length > 0) {
    ctx.warn({ code: 'MIX_EMPTY', message: `${empty.length} of ${columns.length} columns hold no work (${empty.slice(0, 3).map((x) => x.label).join(', ')}${empty.length > 3 ? ', …' : ''}), so their shares are null: there is nothing to share.` });
  }
  if (result.total.value === null && columns.length === 0) {
    ctx.warn({ code: 'MIX_UNREAD', message: 'The mix could not be drawn, so there are no columns. coverage says what was not read.' });
  }
}
