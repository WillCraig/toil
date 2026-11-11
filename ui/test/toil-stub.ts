/**
 * A stubbed toil for the sync's tests: `execute()` from `@imagile-dev/toil/api`,
 * signature and all, answering from the preview's canned envelopes (CANNED,
 * which test/registry.test.ts holds to the real registry), plus what a sync
 * adds on top of the views' calls: `updatedSince` on the searches (filtered by
 * each item's own updated time, as Jira and Azure DevOps filter), a batch of
 * some of the ids, and `meta.page.nextCursor` paging on `jira issue search`. Azure
 * DevOps revisions are kept per item, answering `work-item history` whole and
 * `work-item feed` as the feed does (every item's revisions after `updatedSince`,
 * people as text). A
 * test can change an item, fail an area, or count the calls. Nothing here
 * reaches a network.
 */

import { CANNED, fixtureExecute, type Canned } from '../src/fixtures/execute.ts';
import { inputKey } from '../server/cache.ts';
import { ADO_REVISIONS } from '../src/fixtures/work.ts';
import type { SyncExecute } from '../server/sync.ts';
import type { Envelope } from '../src/toil.ts';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface StubCall {
  command: string;
  input: Rec;
}

/** The page size the stub's `jira issue search` hands out, so a sync has to follow nextCursor. */
export const JIRA_PAGE = 3;

export interface StubToil {
  execute: SyncExecute;
  calls: StubCall[];
  /** Areas whose every call fails, as a tracker that's down would. */
  failing: Set<string>;
  /** The canned answers, which a test may change between syncs. */
  canned: Canned[];
  /** Updates one Jira issue: its status and updated time. */
  touchJira(key: string, status: string, at: string): void;
  /** Deletes one Jira issue from the tracker, as deleting or moving it out of the project does. */
  removeJira(key: string): void;
  /** Deletes one Azure DevOps work item. */
  removeAdo(id: number): void;
  /** Updates one Azure DevOps work item: its state and changed date. */
  touchAdo(id: number, state: string, at: string): void;
  /** Adds an Azure DevOps work item to the settlement toil project: a copy of the first one, under a new id, with its revisions. */
  addAdo(id: number): void;
  /** Renames the iteration path in every revision of every Azure DevOps work item, as renaming an iteration does in the tracker. */
  renameIteration(from: string, to: string): void;
  reset(): void;
}

const VERSION = '0.1.0-alpha.2';

function ok(command: string, data: unknown, page?: { nextCursor: string | null; limit: number }): Envelope {
  return { ok: true, data, error: null, meta: { command, durationMs: 0, version: VERSION, contractVersion: 1, ...(page ? { page } : {}) } } as Envelope;
}

function fail(command: string, code: string, message: string, fix: string): Envelope {
  return { ok: false, data: null, error: { code, message, fix }, meta: { command, durationMs: 0, version: VERSION, contractVersion: 1 } } as Envelope;
}

export function stubToil(): StubToil {
  const canned = structuredClone(CANNED);
  const calls: StubCall[] = [];
  // Every work item's revisions, which touchAdo adds to: the one history that both ADO commands read.
  const revisions = new Map<number, Rec[]>(Object.entries(ADO_REVISIONS).map(([id, r]) => [Number(id), structuredClone(r as Rec[])]));
  const asText = (who: unknown) => (isRec(who) ? `${who.displayName} <${who.uniqueName}>` : who);
  const feedOf = (r: Rec): Rec => {
    const fields = r.fields as Rec;
    return { id: r.id, rev: r.rev, fields: { 'System.Id': r.id, 'System.Rev': r.rev, ...fields, 'System.ChangedBy': asText(fields['System.ChangedBy']) } };
  };
  const failing = new Set<string>();
  const find = (command: string, input: Rec) => canned.find((c) => c.command === command && inputKey(c.input) === inputKey(input));
  const sameToilProject = (command: string, input: Rec) => canned.find((c) => c.command === command && c.input.toilProject === input.toilProject);

  // meta.context (the connection a call used) as the preview's fixture reports it, from the pristine canned call.
  const pristine = fixtureExecute();
  const context = async (c: Canned | undefined, env: Envelope): Promise<Envelope> => {
    if (!c || !env.ok) return env;
    const real = await pristine.execute(c.command, c.input, { readOnly: true });
    return real.meta.context ? ({ ...env, meta: { ...env.meta, context: real.meta.context } } as Envelope) : env;
  };

  const adoChanged = (toilProject: unknown) => {
    const batch = canned.find((c) => c.command === 'ado work-item get-many' && c.input.toilProject === toilProject)!.data as { value: Array<{ id: number; fields: Rec }> };
    return new Map(batch.value.map((w) => [w.id, String(w.fields['System.ChangedDate'])]));
  };

  const answer = async (command: string, input: Rec, options: Parameters<SyncExecute>[2]): Promise<Envelope> => {
    calls.push({ command, input: structuredClone(input) });
    if (options.readOnly !== true || options.caller !== 'toil-ui') return fail(command, 'WRITE_DISABLED', 'The stub answers read-only toil-ui calls only.', 'Pass readOnly and the toil-ui caller.');
    options.onProgress?.({ type: 'request', method: 'GET', url: `https://${command.split(' ')[0]}.imagile.dev/`, status: 200, durationMs: 1, command, message: `GET ${command}` });
    await Promise.resolve();
    if (failing.has(command.split(' ')[0]!)) return fail(command, 'HTTP', `${command.split(' ')[0]}.imagile.dev answered 503 Service Unavailable.`, 'Try again when the server is back; toil config test checks the connection.');

    const { updatedSince, cursor, fields, ...rest } = input;
    const since = typeof updatedSince === 'string' ? Date.parse(updatedSince) : null;

    if (command === 'jira issue search') {
      // The ids-only listing (fields: 'key') carries no changelog, and is answered from the one canned search the dashboard asks.
      // A search that names its fields is the canned one with those fields (the loader asks for the connection's own); the listing is answered from it whatever they were.
      const hit = fields === 'key' ? canned.find((c) => c.command === command && c.input.toilProject === rest.toilProject && c.input.jql === rest.jql) : find(command, { ...rest, ...(fields === undefined ? {} : { fields }) });
      if (!hit) return fail(command, 'INVALID_INPUT', `No canned ${command}.`, 'Add it.');
      // fields: 'key' is the sync's ids-only listing (#493): the key and nothing else.
      const all = (hit.data as { issues: Array<{ key: string; fields: Rec }> }).issues.filter((i) => since === null || Date.parse(String(i.fields.updated)) >= since).map((i) => (fields === 'key' ? ({ key: i.key } as { key: string; fields: Rec }) : i));
      const start = typeof cursor === 'string' ? Number(cursor) : 0;
      const issues = all.slice(start, start + JIRA_PAGE);
      const next = start + JIRA_PAGE < all.length ? String(start + JIRA_PAGE) : null;
      return ok(command, { startAt: start, maxResults: JIRA_PAGE, total: all.length, issues }, { nextCursor: next, limit: JIRA_PAGE });
    }
    if (command === 'ado work-item search') {
      const hit = find(command, rest);
      if (!hit) return fail(command, 'INVALID_INPUT', `No canned ${command}.`, 'Add it.');
      const changed = adoChanged(rest.toilProject);
      const data = hit.data as { workItems: Array<{ id: number }> };
      return ok(command, { ...data, workItems: data.workItems.filter((w) => since === null || Date.parse(changed.get(w.id) ?? '') >= since) });
    }
    if (command === 'ado work-item history') {
      const list = revisions.get(Number(rest.id));
      return list ? ok(command, structuredClone(list)) : fail(command, 'NOT_FOUND', `No work item ${String(rest.id)}.`, 'Ask for an id the sample has.');
    }
    if (command === 'ado work-item feed') {
      const ids = new Set(adoChanged(rest.toilProject).keys());
      const feed = [...revisions].filter(([id]) => ids.has(id)).flatMap(([, list]) => list)
        .filter((r) => since === null || Date.parse(String((r.fields as Rec)['System.ChangedDate'])) > since)
        .map(feedOf)
        .sort((a, b) => Date.parse(String((a.fields as Rec)['System.ChangedDate'])) - Date.parse(String((b.fields as Rec)['System.ChangedDate'])) || Number(a.id) - Number(b.id));
      return ok(command, feed);
    }
    if (command === 'ado work-item get-many' || command === 'github issue get') {
      const exact = find(command, rest);
      if (exact) return ok(command, structuredClone(exact.data));
      const whole = sameToilProject(command, rest);
      if (!whole) return fail(command, 'INVALID_INPUT', `No canned ${command}.`, 'Add it.');
      if (command === 'ado work-item get-many') {
        const ids = (rest.id as number[]).map(Number);
        const value = (whole.data as { value: Array<{ id: number }> }).value.filter((w) => ids.includes(w.id));
        return ok(command, { count: value.length, value, missing: [] });
      }
      const numbers = (rest.number as number[]).map(Number);
      const issues = (whole.data as { issues: Array<{ number: number }> }).issues.filter((i) => numbers.includes(i.number));
      return ok(command, numbers.length === 1 ? issues[0] : { issues, errors: [] });
    }
    // A pull request list narrowed by updatedSince, each host by its own updated field; Azure DevOps records none, so it keeps the active ones.
    if (command.endsWith(' pr list') && since !== null) {
      const hit = find(command, rest);
      if (!hit) return fail(command, 'INVALID_INPUT', `No canned ${command}.`, 'Add it.');
      const at = (pr: Rec) => (typeof pr.updatedDate === 'number' ? pr.updatedDate : Date.parse(String(pr.updated_at ?? pr.updated_on ?? pr.closedDate ?? pr.creationDate ?? '')));
      return ok(command, (hit.data as Rec[]).filter((pr) => pr.status === 'active' || at(pr) >= since));
    }
    if (updatedSince !== undefined || cursor !== undefined) return fail(command, 'INVALID_INPUT', `The stub's ${command} takes no updatedSince or cursor.`, 'Call it as the views do.');
    const hit = find(command, rest);
    return hit ? ok(command, structuredClone(hit.data)) : fail(command, 'INVALID_INPUT', `No canned answer for ${command} ${inputKey(rest)}.`, 'Add it to CANNED.');
  };

  const execute: SyncExecute = async (command, input, options) => {
    const rest = Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'updatedSince' && k !== 'cursor' && k !== 'fields'));
    return context(find(command, rest) ?? sameToilProject(command, rest), await answer(command, input, options));
  };

  return {
    execute,
    calls,
    failing,
    canned,
    touchJira(key, status, at) {
      for (const c of canned) {
        if (c.command !== 'jira issue search') continue;
        for (const issue of (c.data as { issues: Array<{ key: string; fields: Rec }> }).issues) {
          if (issue.key !== key) continue;
          issue.fields.updated = at;
          if (isRec(issue.fields.status)) issue.fields.status = { ...issue.fields.status, name: status };
        }
      }
    },
    touchAdo(id, state, at) {
      for (const c of canned) {
        if (c.command !== 'ado work-item get-many') continue;
        for (const w of (c.data as { value: Array<{ id: number; fields: Rec }> }).value) {
          if (w.id !== id) continue;
          w.fields['System.ChangedDate'] = at;
          w.fields['System.State'] = state;
          // A save is a revision: the item's rev moves on, and the feed and its history both gain it.
          const list = revisions.get(id)!;
          const last = list[list.length - 1]!;
          const rev = Number(last.rev) + 1;
          (w as { rev?: number }).rev = rev;
          list.push({ ...last, rev, fields: { ...(last.fields as Rec), 'System.State': state, 'System.ChangedDate': at } });
        }
      }
    },
    addAdo(id) {
      const of = (command: string) => canned.find((c) => c.command === command && c.input.toilProject === 'settlement')!.data as Rec;
      const search = of('ado work-item search') as { workItems: Rec[] };
      const many = of('ado work-item get-many') as { value: Array<{ id: number }>; count?: number };
      const template = many.value[0]!;
      search.workItems.push({ ...search.workItems[0]!, id });
      many.value.push({ ...structuredClone(template), id });
      revisions.set(id, structuredClone(revisions.get(template.id)!).map((r) => ({ ...r, id })));
    },
    renameIteration(from, to) {
      for (const list of revisions.values()) for (const r of list) {
        const fields = r.fields as Rec;
        if (fields['System.IterationPath'] === from) fields['System.IterationPath'] = to;
      }
    },
    removeJira(key) {
      for (const c of canned) if (c.command === 'jira issue search') (c.data as { issues: Array<{ key: string }> }).issues = (c.data as { issues: Array<{ key: string }> }).issues.filter((i) => i.key !== key);
    },
    removeAdo(id) {
      for (const c of canned) {
        if (c.command === 'ado work-item search') (c.data as { workItems: Array<{ id: number }> }).workItems = (c.data as { workItems: Array<{ id: number }> }).workItems.filter((w) => w.id !== id);
        if (c.command === 'ado work-item get-many') (c.data as { value: Array<{ id: number }> }).value = (c.data as { value: Array<{ id: number }> }).value.filter((w) => w.id !== id);
      }
    },
    reset() {
      calls.length = 0;
    },
  };
}
