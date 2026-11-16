import { z } from 'zod';
import { categorizeResult, categorizeWarnings, failureReason, fieldNotFound, fieldNotOnType, labelChange, labelsAfter, optionMissing, sameValue, typeLabel } from '../../core/classify/apply.js';
import { PLAN_FROM_DESCRIPTION, planFor, readPlanFrom } from '../../core/classify/plan.js';
import type { CategorizeChange, CategorizeResult, PlanItem } from '../../core/classify/types.js';
import type { CommandContext } from '../../core/context.js';
import { ToilError } from '../../core/errors.js';
import { allowWriteField } from '../../core/run.js';

/**
 * `ado work-item categorize` for both deployments. Azure DevOps Server and
 * Services differ in where a request goes and which api-version rides on it,
 * and in nothing else this command cares about, so the logic lives here once
 * and each deployment hands it an `AdoWire`: three verbs and a path rooted at
 * the collection (Server) or the organization (Services). Two implementations
 * of "set a tag" would have needed a third to explain why they disagree.
 *
 * The plan names work items by id and an id is unique in its collection, so
 * nothing here needs a project. A project appears only where Azure DevOps
 * insists: the work item type's own definition of the field, and that project
 * is each item's own `System.TeamProject`.
 */

/** One deployment's way of sending a request: paths start at the collection or organization root. */
export interface AdoWire {
  get<T>(path: string, query?: Record<string, string>): Promise<T>;
  post<T>(path: string, json: unknown): Promise<T>;
  /** A JSON Patch, with `application/json-patch+json` and `suppressNotifications` already on it. */
  patchItem<T>(path: string, json: unknown): Promise<T>;
}

export type CategorizeContext = Pick<CommandContext<{ name: string }>, 'files' | 'warn' | 'resolved' | 'toilProjectFields' | 'connection'>;

export const categorizeInput = z.object({
  from: z.string().optional().describe(PLAN_FROM_DESCRIPTION),
  ...allowWriteField,
});

export const categorizeOptions = [{ flags: '--from <file>', field: 'from', description: PLAN_FROM_DESCRIPTION }];

export const CATEGORIZE_DESCRIPTION = 'Apply a classification plan: tag work items with their category and set an optional field';
export const CATEGORIZE_TOOL_DESCRIPTION =
  "Applies a plan from classify_run (from: a file in the workspace): for each work item, adds the category's tag and removes the scheme's other tags, and, when the plan names a field, sets it to agree with the tag (the tag is the record; a field never changes a tag). Every item is read first, and each change goes in one JSON Patch that is refused if the item has moved past the revision read (retried once). An item already as the plan wants it is left alone, so running a plan twice changes nothing. Returns what changed, what was already right and what failed; items that fail never fail the call. Needs a connection with writes on. toil never creates the field. Needs no project.";

const ID = /^\d+$/;
/** Work items per batch read: the endpoint's own limit. */
const BATCH = 200;
const READ_FIELDS = ['System.Id', 'System.Rev', 'System.Tags', 'System.WorkItemType', 'System.TeamProject'];

/** A work item as it stands now: what a change is worked out from, never the plan's guess. */
interface Live {
  rev: number;
  tags: string[];
  type: string;
  project: string;
  fieldValue: unknown;
}

/** What a work item type says about the field. */
interface TypeField {
  carries: boolean;
  allowed: string[];
}

const enc = encodeURIComponent;

const missingReason = (key: string): string => `Azure DevOps has no work item ${key}, or this credential can't read it.`;

const statusOf = (err: unknown): number | undefined => {
  const status = err instanceof ToilError ? (err.details as { status?: unknown } | undefined)?.status : undefined;
  return typeof status === 'number' ? status : undefined;
};

/**
 * The item moved past the revision read. Azure DevOps answers a failed `test`
 * operation with 409 or 412 by the documentation; a 400 is taken for one only
 * when its message names the test operation or the `/rev` path. A looser match
 * (the word "revision", or "rev" next to a dot) also catches rule errors about
 * `System.Rev` and retries what no retry can fix.
 */
export function isConflict(err: unknown): boolean {
  const status = statusOf(err);
  if (status === 409 || status === 412) return true;
  return status === 400 && err instanceof ToilError && /test operation|\/rev\b/i.test(err.message);
}

function tagsOf(value: unknown): string[] {
  return typeof value === 'string' ? value.split(';').map((t) => t.trim()).filter(Boolean) : [];
}

/** The items' current state, 200 to a request. An id the batch leaves out (null, or absent) is not in the result. */
async function readItems(wire: AdoWire, ids: readonly number[], fieldRef: string | undefined): Promise<Map<number, Live>> {
  const live = new Map<number, Live>();
  for (let start = 0; start < ids.length; start += BATCH) {
    const body = { ids: ids.slice(start, start + BATCH), fields: fieldRef ? [...READ_FIELDS, fieldRef] : READ_FIELDS, errorPolicy: 'Omit' };
    const result = await wire.post<{ value?: Array<{ id?: unknown; rev?: unknown; fields?: Record<string, unknown> } | null> }>('/_apis/wit/workitemsbatch', body);
    for (const item of result.value ?? []) {
      if (!item || typeof item.id !== 'number') continue;
      const fields = item.fields ?? {};
      const rev = Number(fields['System.Rev'] ?? item.rev);
      if (!Number.isInteger(rev)) continue;
      live.set(item.id, {
        rev,
        tags: tagsOf(fields['System.Tags']),
        type: typeof fields['System.WorkItemType'] === 'string' ? fields['System.WorkItemType'] : '',
        project: typeof fields['System.TeamProject'] === 'string' ? fields['System.TeamProject'] : '',
        fieldValue: fieldRef ? fields[fieldRef] : undefined,
      });
    }
  }
  return live;
}

/** The field's reference name: a toil project alias, a name with a dot as it stands, else the one field with that display name. */
async function resolveField(wire: AdoWire, ctx: CategorizeContext, name: string): Promise<{ ref: string; given: boolean }> {
  const alias = ctx.toilProjectFields()[name];
  if (alias) return { ref: alias, given: true };
  if (name.includes('.')) return { ref: name, given: true };
  const all = (await wire.get<{ value?: Array<{ name?: string; referenceName?: string }> }>('/_apis/wit/fields')).value ?? [];
  const wanted = name.trim().toLowerCase();
  const found = all.filter((f) => typeof f.referenceName === 'string' && (f.name ?? '').trim().toLowerCase() === wanted);
  if (found.length === 0) throw fieldNotFound('ado', name);
  if (found.length > 1) {
    const refs = found.map((f) => f.referenceName).join(', ');
    throw new ToilError('INVALID_INPUT', `More than one Azure DevOps field is named "${name}": ${refs}.`, {
      fix: `Name the field by its reference name: toil projects classify set <toil-project> --target ado.field=<reference name>.`,
    });
  }
  return { ref: found[0]!.referenceName!, given: false };
}

/**
 * A reference name taken as written may not exist, and the batch read then
 * answers 400. Say so as the field being missing, which is what it is.
 */
async function explainBadRead(wire: AdoWire, name: string, ref: string, err: unknown): Promise<never> {
  if (statusOf(err) === 400) {
    try {
      await wire.get(`/_apis/wit/fields/${enc(ref)}`);
    } catch (probe) {
      if (probe instanceof ToilError && probe.code === 'NOT_FOUND') throw fieldNotFound('ado', name);
    }
  }
  throw err;
}

/** One work item type's definition of the field, with its allowed values. A 404 is a type that doesn't carry it. */
async function typeField(wire: AdoWire, project: string, type: string, ref: string): Promise<TypeField> {
  try {
    const def = await wire.get<{ allowedValues?: unknown }>(`/${enc(project)}/_apis/wit/workitemtypes/${enc(type)}/fields/${enc(ref)}`, { $expand: 'allowedValues' });
    const allowed = Array.isArray(def.allowedValues) ? def.allowedValues.filter((v): v is string => typeof v === 'string') : [];
    return { carries: true, allowed };
  } catch (err) {
    if (err instanceof ToilError && err.code === 'NOT_FOUND') return { carries: false, allowed: [] };
    throw err;
  }
}

type Outcome = { changed: CategorizeChange } | { unchanged: true } | { failed: string };

export async function categorize(ctx: CategorizeContext, input: { from?: string | undefined }, wire: AdoWire): Promise<CategorizeResult> {
  const plan = await readPlanFrom(ctx, input.from);
  const connection = ctx.connection.name;
  const { group, skipped } = planFor(plan, 'ado', connection);
  if (!group) {
    const empty = categorizeResult({ connection, plan, group, field: null, skipped, changed: [], unchanged: [], failed: [] });
    for (const w of categorizeWarnings(empty)) ctx.warn(w);
    return empty;
  }

  // Refused before anything is sent: a key that isn't an id could be anything an agent typed.
  for (const item of group.items) {
    if (!ID.test(item.key)) {
      throw new ToilError('INVALID_INPUT', `"${item.key}" is not an Azure DevOps work item id: ids are digits only.`, {
        fix: 'Apply a plan made from Azure DevOps work items: toil classify run with the items of an ado read.',
      });
    }
  }

  const changed: CategorizeChange[] = [];
  const unchanged: string[] = [];
  const failed: Array<{ key: string; reason: string }> = [];
  const notOnType = new Map<string, number>();
  let fieldRef: string | undefined;

  if (group.items.length > 0) {
    const name = group.field?.name;
    let given = true;
    // The field is looked up only when an item sets it: a plan that changes tags alone doesn't depend on the field existing.
    if (name && group.items.some((item) => item.field)) ({ ref: fieldRef, given } = await resolveField(wire, ctx, name));

    const ids = [...new Set(group.items.map((item) => Number(item.key)))];
    let live: Map<number, Live>;
    try {
      live = await readItems(wire, ids, fieldRef);
    } catch (err) {
      if (name && fieldRef && given) await explainBadRead(wire, name, fieldRef, err);
      throw err;
    }

    // The field is checked against each work item type before the first write: a value the field doesn't
    // offer would otherwise fail on item 40 of 200, after the first 39 were changed.
    const types = new Map<string, TypeField>();
    const sendValue = new Map<PlanItem, string | undefined>();
    if (name && fieldRef) {
      const wantsField = group.items.filter((item) => item.field && live.has(Number(item.key)));
      for (const item of wantsField) {
        const state = live.get(Number(item.key))!;
        const slot = `${state.project}\u0000${state.type}`;
        if (!types.has(slot)) types.set(slot, state.project && state.type ? await typeField(wire, state.project, state.type, fieldRef) : { carries: false, allowed: [] });
        const def = types.get(slot)!;
        if (!def.carries) {
          const label = typeLabel(state.project, state.type);
          notOnType.set(label, (notOnType.get(label) ?? 0) + 1);
          continue;
        }
        const wanted = item.field!.value;
        if (def.allowed.length === 0) {
          sendValue.set(item, wanted);
          continue;
        }
        const listed = def.allowed.find((option) => sameValue(option, wanted));
        if (listed === undefined) throw optionMissing('ado', name, wanted, item.category, def.allowed);
        sendValue.set(item, listed);
      }
      if (wantsField.length > 0 && ![...types.values()].some((t) => t.carries)) throw fieldNotFound('ado', name, "on any of the plan's work item types");
    }

    // One at a time, in plan order: a plan applied twice sends the same requests in the same order.
    const apply = async (item: PlanItem): Promise<Outcome> => {
      const id = Number(item.key);
      let state = live.get(id);
      for (let attempt = 0; ; attempt++) {
        if (!state) return { failed: missingReason(item.key) };
        const change = labelChange(state.tags, group, item.category);
        const wanted = sendValue.get(item);
        const setField = fieldRef !== undefined && wanted !== undefined && !sameValue(typeof state.fieldValue === 'string' ? state.fieldValue : undefined, wanted);
        const tagging = change.add.length > 0 || change.remove.length > 0;
        if (!tagging && !setField) return { unchanged: true };
        const ops: Array<{ op: string; path: string; value: unknown }> = [{ op: 'test', path: '/rev', value: state.rev }];
        // Azure DevOps reads `add` on System.Tags as "add these tags": a tag left out of the value stays on the item (seen live on
        // Services, 11 November 2026). Taking one off needs `replace`, which sets the whole list; an item with a tag to remove
        // always has a value to replace.
        if (tagging) ops.push({ op: change.remove.length > 0 ? 'replace' : 'add', path: '/fields/System.Tags', value: labelsAfter(state.tags, change).join('; ') });
        if (setField) ops.push({ op: 'add', path: `/fields/${fieldRef}`, value: wanted });
        try {
          await wire.patchItem(`/_apis/wit/workitems/${enc(id)}`, ops);
          return { changed: { id: item.id, key: item.key, category: item.category, labels: { added: change.add, removed: change.remove }, field: setField ? { value: wanted! } : null } };
        } catch (err) {
          if (!isConflict(err)) throw err;
          if (attempt > 0) return { failed: `Work item ${item.key} changed twice while toil was applying the plan, so its revision check refused both writes. Azure DevOps said "${(err as Error).message}". Run the same plan again.` };
          // Someone else's edit landed first: read the item again and work out the change from what it holds now.
          state = (await readItems(wire, [id], fieldRef)).get(id);
        }
      }
    };

    const progress = () => ({ planned: group.items.length, changed: changed.length, unchanged: unchanged.length, failed: failed.length });
    for (const item of group.items) {
      try {
        const outcome = await apply(item);
        if ('changed' in outcome) changed.push(outcome.changed);
        else if ('unchanged' in outcome) unchanged.push(item.key);
        else failed.push({ key: item.key, reason: outcome.failed });
      } catch (err) {
        failed.push({ key: item.key, reason: failureReason(err, progress) });
      }
    }
  }

  const result = categorizeResult({
    connection,
    plan,
    group,
    field: group.field ? { ...group.field, ...(fieldRef ? { id: fieldRef } : {}) } : null,
    skipped,
    changed,
    unchanged,
    failed,
  });
  for (const w of categorizeWarnings(result)) ctx.warn(w);
  const warning = group.field ? fieldNotOnType(group.field.name, [...notOnType].map(([type, items]) => ({ type, items }))) : undefined;
  if (warning) ctx.warn(warning);
  return result;
}
