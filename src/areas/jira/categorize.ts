import { z } from 'zod';
import { apiPath } from '../../core/api-path.js';
import {
  CATEGORIZE_TIME_LIMIT_MS,
  categorizeResult,
  categorizeWarnings,
  failureReason,
  fieldNotFound,
  fieldNotOnType,
  labelChange,
  optionMissing,
  sameValue,
  typeLabel,
} from '../../core/classify/apply.js';
import { PLAN_FROM_DESCRIPTION, planFor, readPlanFrom } from '../../core/classify/plan.js';
import type { CategorizeChange, PlanItem } from '../../core/classify/types.js';
import { ToilError } from '../../core/errors.js';
import { allowWriteField } from '../../core/run.js';
import { jiraArea } from './area.js';
import * as cloudClient from './cloud/client.js';
import * as serverClient from './server/client.js';

/**
 * `jira issue categorize`, for Data Center and Cloud: it applies the plan that
 * `toil classify run` wrote, one request per issue that still differs from it.
 * The two deployments differ in their API version and in how they search, and
 * in nothing a caller reads, so the logic lives here once and each deployment
 * hands it a small adapter. Two copies of this would have drifted apart by the
 * first quarterly review, which would have been attended by neither.
 *
 * Everything is read before anything is written, so a field that doesn't
 * exist or an option that isn't offered stops the run with nothing changed.
 */

type JiraContext = serverClient.JiraContext;

interface JiraIssueLike {
  key: string;
  fields: Record<string, unknown>;
}

interface Call {
  method?: 'GET' | 'PUT';
  query?: Record<string, string>;
  body?: unknown;
}

/** What differs between the deployments: the API's path, and the three reads that aren't spelled alike. */
export interface CategorizeAdapter {
  /** `/rest/api/2` or `/rest/api/3`. */
  api: string;
  call: <T>(ctx: JiraContext, path: string, req?: Call) => Promise<T>;
  /** JQL search for one page of keys: Data Center's POST /search, Cloud's POST /search/jql. */
  search: (ctx: JiraContext, jql: string, fields: string[]) => Promise<JiraIssueLike[]>;
  fields: (ctx: JiraContext) => Promise<Array<{ id: string; name: string }>>;
}

const serverAdapter: CategorizeAdapter = {
  api: '/rest/api/2',
  call: (ctx, path, req = {}) => serverClient.jira(ctx, path, { ...(req.method ? { method: req.method } : {}), ...(req.query ? { params: req.query } : {}), ...(req.body !== undefined ? { body: req.body } : {}) }),
  search: async (ctx, jql, fields) => (await serverClient.search(ctx, jql, { fields })).issues,
  fields: (ctx) => serverClient.fetchFields(ctx),
};

const cloudAdapter: CategorizeAdapter = {
  api: '/rest/api/3',
  call: (ctx, path, req = {}) => cloudClient.jiraCloud(ctx, path, { ...(req.method ? { method: req.method } : {}), ...(req.query ? { query: req.query } : {}), ...(req.body !== undefined ? { body: req.body } : {}) }),
  search: async (ctx, jql, fields) => (await cloudClient.search(ctx, jql, { fields })).items,
  fields: (ctx) => cloudClient.fetchFields(ctx),
};

/** Keys per search: one page, and a JQL line that stays short enough for any proxy on the way. */
const BATCH = 100;

const categorizeInput = z.object({
  from: z.string().min(1).optional().describe(PLAN_FROM_DESCRIPTION),
  ...allowWriteField,
});

type Input = z.output<typeof categorizeInput>;

interface Live {
  labels: string[];
  /** The field's current value as text, or null when unset or not text. */
  value: string | null;
  project: string;
  type: string;
}

interface Option {
  id?: string;
  value?: string;
  name?: string;
}

/** What to send for one item's field, and how to show it. */
interface Prepared {
  send: unknown;
  shown: string;
}

function textOf(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object' && raw !== null) {
    const option = raw as { value?: unknown; name?: unknown };
    if (typeof option.value === 'string') return option.value;
    if (typeof option.name === 'string') return option.name;
  }
  return null;
}

function liveFrom(issue: JiraIssueLike, fieldId: string | undefined): Live {
  const fields = issue.fields ?? {};
  const project = (fields.project as { key?: unknown } | undefined)?.key;
  const type = (fields.issuetype as { name?: unknown } | undefined)?.name;
  return {
    labels: Array.isArray(fields.labels) ? fields.labels.filter((l): l is string => typeof l === 'string') : [],
    value: fieldId === undefined ? null : textOf(fields[fieldId]),
    project: typeof project === 'string' ? project : '',
    type: typeof type === 'string' ? type : '',
  };
}

const isBadRequest = (err: unknown) => err instanceof ToilError && err.code === 'HTTP' && (err.details as { status?: unknown } | undefined)?.status === 400;

const customFieldId = /^customfield_\d+$/;

/** The id of the field the plan names: a toil project's alias, an id as given, or the one field Jira has by that name. */
async function resolveField(adapter: CategorizeAdapter, ctx: JiraContext, name: string): Promise<string> {
  const alias = ctx.toilProjectFields()[name];
  if (alias) return alias;
  if (customFieldId.test(name)) return name;
  const hits = (await adapter.fields(ctx)).filter((f) => f.name.toLowerCase() === name.toLowerCase());
  if (hits.length === 0) throw fieldNotFound('jira', name);
  if (hits.length > 1) {
    throw new ToilError('INVALID_INPUT', `Jira has ${hits.length} fields named "${name}": ${hits.map((f) => f.id).join(', ')}.`, {
      fix: 'Name the field by its id: toil projects classify set <toil-project> --target jira.field=customfield_…',
    });
  }
  return hits[0]!.id;
}

/**
 * Every plan key's live state. Jira answers a search with 400 when any key in
 * it doesn't exist, and doesn't hand a moved issue back under the key the plan
 * named, so what the search leaves out, or the 400 refuses, is read one issue
 * at a time. A key that can't be read is that item's failure; the rest go on.
 */
async function readLive(
  adapter: CategorizeAdapter,
  ctx: JiraContext,
  keys: string[],
  fieldId: string | undefined,
): Promise<{ live: Map<string, Live>; failed: Array<{ key: string; reason: string }> }> {
  const props = ['labels', ...(fieldId === undefined ? [] : [fieldId]), 'project', 'issuetype'];
  const live = new Map<string, Live>();
  const failed: Array<{ key: string; reason: string }> = [];
  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH);
    let single = batch;
    try {
      const jql = `key in (${batch.map((key) => `"${key.replace(/["\\]/g, '\\$&')}"`).join(', ')})`;
      const found = new Map((await adapter.search(ctx, jql, props)).map((issue) => [issue.key.toLowerCase(), issue]));
      for (const key of batch) {
        const issue = found.get(key.toLowerCase());
        if (issue) live.set(key, liveFrom(issue, fieldId));
      }
      single = batch.filter((key) => !live.has(key));
    } catch (err) {
      if (!isBadRequest(err)) throw err;
    }
    for (const key of single) {
      try {
        const issue = await adapter.call<JiraIssueLike>(ctx, adapter.api + apiPath`/issue/${key}`, { query: { fields: props.join(',') } });
        live.set(key, liveFrom(issue, fieldId));
      } catch (err) {
        failed.push({ key, reason: failureReason(err) });
      }
    }
  }
  return { live, failed };
}

async function run(adapter: CategorizeAdapter, input: Input, ctx: JiraContext) {
  const plan = await readPlanFrom(ctx, input.from);
  const connection = ctx.connection.name;
  const { group, skipped } = planFor(plan, 'jira', connection);
  const done = (changed: CategorizeChange[], unchanged: string[], failed: Array<{ key: string; reason: string }>, fieldId?: string) => {
    const result = categorizeResult({
      connection,
      plan,
      group,
      field: group?.field ? { ...group.field, ...(fieldId === undefined ? {} : { id: fieldId }) } : null,
      skipped,
      changed,
      unchanged,
      failed,
    });
    for (const warning of categorizeWarnings(result)) ctx.warn(warning);
    return result;
  };
  // Nothing to apply, so nothing to look up: not even the field.
  if (!group || group.items.length === 0) return done([], [], []);

  // The field is looked up only when an item sets it: a plan that changes labels alone doesn't depend on the field existing.
  const fieldId = group.field && group.items.some((item) => item.field) ? await resolveField(adapter, ctx, group.field.name) : undefined;
  const { live, failed } = await readLive(adapter, ctx, [...new Set(group.items.map((item) => item.key))], fieldId);
  const readable = group.items.filter((item) => live.has(item.key));

  // What each issue type offers for the field, asked once per project and type.
  const prepared = new Map<PlanItem, Prepared | null>();
  const notOnType = new Map<string, number>();
  if (group.field && fieldId !== undefined) {
    const metas = new Map<string, Record<string, { allowedValues?: Option[] }>>();
    const typeOf = (item: PlanItem) => {
      const l = live.get(item.key)!;
      return { id: `${l.project}\u0000${l.type}`, label: typeLabel(l.project, l.type) };
    };
    const withField = readable.filter((item) => item.field);
    for (const item of withField) {
      const { id } = typeOf(item);
      if (!metas.has(id)) {
        const meta = await adapter.call<{ fields?: Record<string, { allowedValues?: Option[] }> }>(ctx, adapter.api + apiPath`/issue/${item.key}/editmeta`);
        metas.set(id, meta.fields ?? {});
      }
    }
    if (metas.size > 0 && [...metas.values()].every((fields) => !(fieldId in fields))) throw fieldNotFound('jira', group.field.name, "on any of the plan's issue types");
    for (const item of withField) {
      const { id, label } = typeOf(item);
      const meta = metas.get(id)![fieldId];
      if (!meta) {
        prepared.set(item, null);
        notOnType.set(label, (notOnType.get(label) ?? 0) + 1);
        continue;
      }
      const wanted = item.field!.value;
      if (!meta.allowedValues) {
        prepared.set(item, { send: wanted, shown: wanted });
        continue;
      }
      const option = meta.allowedValues.find((o) => sameValue(o.value, wanted)) ?? meta.allowedValues.find((o) => sameValue(o.name, wanted));
      if (!option) {
        throw optionMissing('jira', group.field.name, wanted, item.category, meta.allowedValues.map((o) => o.value ?? o.name).filter((n): n is string => typeof n === 'string'));
      }
      prepared.set(item, { send: { id: option.id }, shown: option.value ?? option.name ?? wanted });
    }
  }

  const changed: CategorizeChange[] = [];
  const unchanged: string[] = [];
  const progress = () => ({ planned: group.items.length, changed: changed.length, unchanged: unchanged.length, failed: failed.length });
  for (const item of readable) {
    const state = live.get(item.key)!;
    const change = labelChange(state.labels, group, item.category);
    const field = prepared.get(item);
    const setField = field && !sameValue(state.value, item.field!.value) && !sameValue(state.value, field.shown) ? field : undefined;
    if (change.add.length === 0 && change.remove.length === 0 && !setField) {
      unchanged.push(item.key);
      continue;
    }
    const labels = [...change.add.map((add) => ({ add })), ...change.remove.map((remove) => ({ remove }))];
    const body = { ...(labels.length > 0 ? { update: { labels } } : {}), ...(setField ? { fields: { [fieldId!]: setField.send } } : {}) };
    try {
      await adapter.call<void>(ctx, adapter.api + apiPath`/issue/${item.key}`, { method: 'PUT', body });
    } catch (err) {
      failed.push({ key: item.key, reason: failureReason(err, progress) });
      continue;
    }
    changed.push({
      id: item.id,
      key: item.key,
      category: item.category,
      labels: { added: change.add, removed: change.remove },
      field: setField ? { value: setField.shown } : null,
    });
  }

  const result = done(changed, unchanged, failed, fieldId);
  const warning = group.field ? fieldNotOnType(group.field.name, [...notOnType].map(([type, items]) => ({ type, items }))) : undefined;
  if (warning) ctx.warn(warning);
  return result;
}

function defineCategorize(adapter: CategorizeAdapter, planFile: string) {
  return jiraArea.command({
    path: ['jira', 'issue', 'categorize'],
    description: "Apply a classification plan to Jira issues: add each issue's category label, remove the scheme's other labels, and set the category field when the plan names one.",
    toolDescription:
      "Applies a classification plan (the output of classify_run, written to a file and passed as from) to Jira issues: adds each issue's category label, removes the scheme's other labels, and, when the plan names a field, sets it to agree with the label (the label is the record; a field never changes a label). It reads each issue first and sends one update only where the issue differs from the plan, so running a plan twice changes nothing. Returns { connection, scheme, field, changed, unchanged, failed, skipped, counts }; an issue that couldn't be changed is in failed and the rest are still applied. The field is never created: a missing field or option is refused before any issue is changed.",
    input: categorizeInput,
    writes: true,
    timeLimitMs: CATEGORIZE_TIME_LIMIT_MS,
    options: [{ flags: '--from <file>', field: 'from', description: PLAN_FROM_DESCRIPTION }],
    examples: [{ from: planFile, allowWrite: true }],
    run: (input, ctx) => run(adapter, input, ctx),
  });
}

/** Data Center: /rest/api/2, and the search that pages by offset. */
export const serverCategorize = defineCategorize(serverAdapter, 'classify-plan.json');
/** Cloud: /rest/api/3, and the enhanced search. */
export const cloudCategorize = defineCategorize(cloudAdapter, 'classify-plan-cloud.json');
