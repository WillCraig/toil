/**
 * Reading a classification plan: what `toil classify run` wrote and a
 * tracker's `categorize` command applies. The three trackers share this reader
 * so a plan means the same thing to each, and so the one promise a plan makes
 * is checked in one place: an item adds and removes only labels its entry's own
 * `labels` map names. A tracker command can't look the scheme up (area commands
 * never see the scheme catalog), so the plan is the caller's input like any
 * other write input and the write gate decides whether it may be sent at all;
 * `toil classify run` is what builds that map from the scheme. A plan is a file
 * an agent may have written by hand, so its shape is checked, never its
 * author's intentions. The form has no box for "and while you're there".
 */
import { z } from 'zod';
import type { Warning } from '../envelope.js';
import { ToilError } from '../errors.js';
import { STDIN_OVER_MCP, type FileAccess } from '../files.js';
import { CATEGORY_ID, CLASSIFY_AREAS, type ClassifyArea, type ClassifyPlan, type PlanGroup } from './types.js';

/** What `--from` (MCP: `from`) says on every `categorize` command. */
export const PLAN_FROM_DESCRIPTION =
  'The plan to apply: a file holding toil classify run output (its envelope or its data). Omitted, it is read from stdin on the CLI';

/** The fix every unreadable plan gets. */
const PLAN_FIX = 'Pass the output of toil classify run, e.g. toil classify run … > plan.json, then --from plan.json.';

const text = z.string().min(1);
const categoryId = z.string().regex(CATEGORY_ID);

const planItem = z.object({
  id: text,
  key: text,
  category: categoryId,
  labels: z.object({ add: z.array(text), remove: z.array(text) }),
  field: z.object({ value: text }).optional(),
});

const planGroup = z.object({
  area: z.enum(CLASSIFY_AREAS),
  connection: text,
  labels: z.record(categoryId, text),
  field: z.object({ name: text, project: text.optional() }).optional(),
  items: z.array(planItem),
});

const category = z.object({ id: categoryId, short: text, name: text, label: text, definition: z.string() });

/** A key as the tracker addresses the item: Jira and GitHub keys without regard to case, Azure DevOps ids as numbers. */
function itemKey(area: ClassifyArea, key: string): string {
  return area === 'ado' && /^\d+$/.test(key) ? String(Number(key)) : key.toLowerCase();
}

const classifyPlan = z
  .object({
    scheme: z.object({ name: text, revision: z.number().int().positive() }),
    categories: z.array(category),
    plan: z.array(planGroup),
  })
  .superRefine((plan, ctx) => {
    const seen = new Set<string>();
    plan.plan.forEach((group, g) => {
      const slot = `${group.area}/${group.connection}`;
      if (seen.has(slot)) ctx.addIssue({ code: 'custom', path: ['plan', g], message: `a second entry for ${group.area} connection "${group.connection}"` });
      seen.add(slot);
      // A label is the entry's own when its `labels` map names it, compared the
      // way the trackers compare labels: without regard to case.
      const own = new Set(Object.values(group.labels).map((label) => label.toLowerCase()));
      // Two items for one key would each be worked out from the same read and
      // put two category labels on one issue, so the second is refused.
      const keys = new Set<string>();
      group.items.forEach((item, i) => {
        const key = itemKey(group.area, item.key);
        if (keys.has(key)) {
          ctx.addIssue({ code: 'custom', path: ['plan', g, 'items', i, 'key'], message: `"${item.key}" appears more than once in the ${group.area} entry for connection "${group.connection}"` });
        }
        keys.add(key);
        if (!(item.category in group.labels)) {
          ctx.addIssue({ code: 'custom', path: ['plan', g, 'items', i, 'category'], message: `"${item.category}" has no label in this entry's labels` });
        }
        for (const [list, labels] of [['add', item.labels.add], ['remove', item.labels.remove]] as const) {
          labels.forEach((label, l) => {
            if (!own.has(label.toLowerCase())) {
              ctx.addIssue({ code: 'custom', path: ['plan', g, 'items', i, 'labels', list, l], message: `"${label}" is not one of the labels this entry's labels map names` });
            }
          });
        }
        if (item.field && !group.field) {
          ctx.addIssue({ code: 'custom', path: ['plan', g, 'items', i, 'field'], message: 'a field value with no field named on the entry' });
        }
      });
    });
  });

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function pathText(path: ReadonlyArray<PropertyKey>): string {
  return path.map((part, i) => (typeof part === 'number' ? `[${part}]` : `${i === 0 ? '' : '.'}${String(part)}`)).join('');
}

/**
 * The plan a `categorize` call was handed: `from`, a file in the workspace, or
 * stdin on the CLI. It takes the `classify run` envelope or its `data`, and
 * refuses a failed envelope, anything that isn't a plan, a key repeated in one
 * entry, and an item that adds or removes a label its entry's labels map
 * doesn't name.
 */
export async function readPlanFrom(ctx: { files: FileAccess }, from: string | undefined): Promise<ClassifyPlan> {
  const where = from === undefined || from === '-' ? 'stdin' : `"${from}"`;
  let source: string;
  try {
    source = await ctx.files.readText(from ?? '-');
  } catch (err) {
    if (err === STDIN_OVER_MCP && from === undefined) {
      throw new ToilError('INVALID_INPUT', 'No plan to apply: pass from, a file holding toil classify run output. Over MCP there is no stdin to read it from.', {
        fix: 'Write the classify run result to a file in the workspace (its summaryFile does that), then pass its path as from.',
      });
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new ToilError('INVALID_INPUT', `The plan from ${where} isn't JSON.`, { fix: PLAN_FIX });
  }
  const envelope = record(parsed);
  if (envelope?.ok === false) {
    const message = record(envelope.error)?.message;
    throw new ToilError('INVALID_INPUT', `The plan from ${where} is a failed result${typeof message === 'string' ? `: ${message}` : ''}.`, {
      fix: 'Fix what made toil classify run fail, then run it again.',
    });
  }
  // The envelope carries the plan under `data`; the data carries it directly.
  const body = record(envelope?.data) ?? envelope;
  if (!body || !Array.isArray(body.plan)) {
    throw new ToilError('INVALID_INPUT', `The plan from ${where} has no plan list.`, { fix: PLAN_FIX });
  }
  const plan = classifyPlan.safeParse(body);
  if (!plan.success) {
    const issue = plan.error.issues[0];
    throw new ToilError('INVALID_INPUT', `The plan from ${where} isn't one toil classify run wrote: ${issue ? `${pathText(issue.path)}: ${issue.message}` : 'it has the wrong shape'}.`, {
      fix: 'Run toil classify run again and pass its output unchanged. A plan adds and removes only the labels its entries name.',
      details: plan.error.issues.slice(0, 5).map((i) => ({ path: i.path, message: i.message })),
    });
  }
  return plan.data;
}

/** A plan's entries for other connections, as a `categorize` result reports them. */
export type SkippedGroup = { area: string; connection: string; items: number };

/**
 * This call's share of a plan: the one entry for its area and connection, and
 * what it leaves alone. One command acts on one connection (principle 3), so
 * the rest is named, never applied. A plan that holds entries but none for
 * this connection is refused, since the caller pointed it at the wrong place;
 * a plan with no entries at all is a plan with nothing to do.
 */
export function planFor(plan: ClassifyPlan, area: ClassifyArea, connection: string): { group: PlanGroup | undefined; skipped: SkippedGroup[] } {
  const group = plan.plan.find((entry) => entry.area === area && entry.connection === connection);
  const skipped = plan.plan.filter((entry) => entry !== group).map((entry) => ({ area: entry.area, connection: entry.connection, items: entry.items.length }));
  if (!group && plan.plan.length > 0) {
    const mine = plan.plan.filter((entry) => entry.area === area).map((entry) => entry.connection);
    const holds = plan.plan.map((entry) => `${entry.area} "${entry.connection}"`).join(', ');
    throw new ToilError('INVALID_INPUT', `The plan has nothing for the ${area} connection "${connection}". It holds entries for: ${holds}.`, {
      fix: mine.length > 0
        ? `Pass --connection ${mine.length === 1 ? mine[0] : `<one of ${mine.join(', ')}>`}, the connection the items were read through.`
        : `This plan has no ${area} items. Apply it with the categorize command of each area it names.`,
    });
  }
  return { group, skipped };
}

/** The warning for a plan's entries this call left alone, worded the same in every area. Undefined when there are none. */
export function skippedWarning(skipped: SkippedGroup[]): Warning | undefined {
  if (skipped.length === 0) return undefined;
  const named = skipped.map((entry) => `${entry.area} "${entry.connection}" (${entry.items} ${entry.items === 1 ? 'item' : 'items'})`).join(', ');
  return {
    code: 'CATEGORIZE_SKIPPED',
    message: `One call applies one connection's entries. Left alone: ${named}. Run the categorize command for each, with its --connection.`,
  };
}

/** The warning for a plan with nothing to apply here: every item already carries its category. */
export const NOTHING_TO_CATEGORIZE: Warning = {
  code: 'CATEGORIZE_NOTHING',
  message: 'The plan has nothing to change: every item it classified already carries its category, or none was settled.',
};
