/**
 * The sync job (#250, #206 point 2: sync through toil, not around it). It
 * calls toil's own commands in-process through `@imagile-dev/toil/api`'s
 * `execute()`, read-only and named `toil-ui` in the audit log, so
 * connections, the credential store, toil projects, bounds and the audit log all
 * apply unchanged and Toil UI holds no credential of its own.
 *
 * **What it asks for is what the dashboards ask for.** Each toil project is loaded
 * with the views' own loader (src/load.ts), driven by `projects show`, through
 * an `execute()` that goes to toil, so the cache holds exactly the calls the
 * views will make and they render from it unchanged. On the way, that
 * `execute()` makes the sync incremental:
 *
 * - **Searches** (`jira issue search`, `ado work-item search`, `github
 *   list-issues`) ask only for what changed since the source's watermark, with
 *   `updatedSince`, and merge the answer into the last copy by key.
 * - **The GitHub board** (`github project items`) is read whole, and an
 *   item counts as changed when its issue's `updatedAt` moved.
 * - **Batches** (`ado work-item get-many`, `github issue get`) fetch only the
 *   changed and new items, merged into the last copy.
 * - **Histories** (`jira issue history`, `ado work-item history`, `github
 *   issue-events`) are fetched only for changed and new items; the rest are
 *   the last copy.
 * - **Azure DevOps' revision feed** (`ado work-item feed`) is read from
 *   the start of the window the first time and from the watermark after that,
 *   and the new revisions are laid over the last copy by item and revision
 *   number, so a changed item's history grows by what it did instead of being
 *   read again whole. Only an item whose revisions run from 1 to its own `rev`
 *   is mapped from the feed (src/ado-revisions.ts); the rest are read with
 *   `ado work-item history`, through the histories rule above.
 * - **Pull request lists** (every host's `pr list`) ask only for what changed
 *   since the watermark too, with `updatedSince`, merged into the last copy
 *   by id; and a **pull request's get** is read again only when it changed
 *   or is still open, since a check finishing doesn't count as an update on
 *   every host. A closed one that didn't change is the last copy.
 * - **Everything else** (builds, deployments, iterations) has no "changed
 *   since" in toil, so it is read again, bounded as the loader already bounds
 *   it.
 * - **Deleted and moved items** never show up in a search "since" a
 *   watermark, so once a day (`RECONCILE_MS`) a source's search is also sent
 *   whole, asking for ids only where the command can (Jira's `--fields key`;
 *   a WIQL answer is ids already), and a cached item it no longer lists is
 *   dropped. Between those, the merge by id goes on as before. GitHub's
 *   issue list has no window, so it is left out. A whole listing that fails
 *   keeps the merged delta, says so in the job's messages and is tried again
 *   by the next sync.
 * - **The window.** The loader asks Jira and Azure DevOps for open items and
 *   what changed within the read window (the retention period, at least six
 *   weeks), not the whole project. Its per-item calls run through the pool in
 *   `src/load.ts`.
 *
 * Every call follows `meta.page.nextCursor` to the end, up to `MAX_PAGES`,
 * and says so when it stops there (Bounds). Work items go through `mapOwi`.
 *
 * **A failing source never blanks the others.** Each area a toil project reads is
 * a source with its own state. When a call fails, the loader is handed that
 * call's last good copy, so the dashboard keeps it; the source is marked
 * failed with toil's message and fix, its watermark stays where it was so the
 * next sync asks again, and the views show its data as stale. A toil project
 * whose `projects show` fails keeps everything it had.
 *
 * Progress comes from `execute()`'s own events (requests, pages, retries) and
 * is polled by the page (GET api/sync). One job runs at a time. A relay race
 * where every runner checks the baton has the right serial number.
 */

import type { ProgressEvent } from '@imagile-dev/toil/api';
import { mergeFeed } from '../src/ado-revisions.ts';
import { loadToilProject, windowFor, type LoaderMapOwi } from '../src/load.ts';
import type { Envelope } from '../src/toil.ts';
import type { WorklogEvent } from '../src/model/worklog.ts';
import { areaOf, type Cache, type ToilProjectState, type SourceResult } from './cache.ts';
import type { RequestContext } from './context.ts';
import { CALLER } from './store.ts';

/** What the sync calls: `execute()` from `@imagile-dev/toil/api`, or a stub in the tests. */
export type SyncExecute = (
  command: string,
  input: Record<string, unknown>,
  options: { readOnly: true; caller: string; signal?: AbortSignal; onProgress?: (event: ProgressEvent) => void },
) => Promise<Envelope>;

/** The OWI mapper the sync hands the loader: the API's, from the toil Toil UI runs with. */
export type MapOwi = LoaderMapOwi;

/** The most new facts a job keeps for one toil project's moments (#419); the page plays a few at most anyway. */
export const MAX_NEWS = 50;

/** The most pages one call follows before it stops and says so. */
export const MAX_PAGES = 200;
/** How far back of the last sync's start the next one asks from, for clocks that disagree a little. */
export const SKEW_MS = 5 * 60_000;
/** How long a source's last whole listing stands before the next sync lists it whole again, to notice items deleted or moved away (#493). */
export const RECONCILE_MS = 24 * 3_600_000;
/** The progress lines a job keeps for the page. */
export const MAX_MESSAGES = 50;

export interface SyncJob {
  running: boolean;
  /** Who started it: the request's viewer (#206, Hosting-ready by design). */
  by: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** The toil project being synced now. */
  toilProject: string | null;
  toilProjectsDone: number;
  toilProjectsTotal: number;
  /** Calls sent to toil, and calls answered from the last copy because nothing changed. */
  fetched: number;
  reused: number;
  requests: number;
  pages: number;
  retries: number;
  /** The newest progress lines, oldest first. */
  messages: string[];
  /** What stopped the job as a whole (the toil project list failed, it was cancelled). Source failures are on the sources. */
  error: string | null;
  /**
   * The facts this job recorded for the first time, by toil project (#419): the
   * page plays its theme moments from these once the job ends. Up to
   * MAX_NEWS a toil project, newest kept.
   */
  news?: Array<{ toilProject: string; events: WorklogEvent[] }>;
}

export interface SyncStatus {
  job: SyncJob;
  toilProjects: ToilProjectState[];
  retentionDays: number;
}

export class SyncBusy extends Error {
  constructor(message = 'A sync is already running.') {
    super(message);
  }
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const recs = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(isRec) : []);

/** A search whose answer is a list of items with ids, which `updatedSince` narrows. `list` is null when the answer is the list itself. */
const SEARCHES: Record<string, { list: string | null; id: (r: Rec) => string; reconcile: boolean }> = {
  'jira issue search': { list: 'issues', id: (r) => String(r.key), reconcile: true },
  'ado work-item search': { list: 'workItems', id: (r) => String(r.id), reconcile: true },
  // Not reconciled: it has no window, so a whole listing would read every issue the repository ever had, every day.
  'github issue list': { list: null, id: (r) => String(r.number), reconcile: false },
};
/** A batch get by ids: the input field holding them, and where the answer lists the items. */
const BATCHES: Record<string, { field: string; list: string; id: (r: Rec) => string }> = {
  'ado work-item get-many': { field: 'id', list: 'value', id: (r) => String(r.id) },
  'github issue get': { field: 'number', list: 'issues', id: (r) => String(r.number) },
};
/** One item's history: the input field naming the item. */
const HISTORIES: Record<string, string> = {
  'jira issue history': 'key',
  'ado work-item history': 'id',
  'github issue history': 'number',
};
const BOARD = 'github project items';
/** Azure DevOps' feed of every revision since a date, which stands in for each item's history (src/ado-revisions.ts). */
const ADO_FEED = 'ado work-item feed';
const ADO_SEARCH = 'ado work-item search';

/** Commands whose NOT_FOUND says the thing isn't there, which is worth knowing: the loader looks for CODEOWNERS where GitHub would. */
const ABSENT_IS_AN_ANSWER = new Set(['github repo file']);

/** Each host's pull request list, which `updatedSince` narrows, and how a pull request in it is named. */
const PR_LISTS: Record<string, (r: Rec) => string> = {
  'github pr list': (r) => String(r.number),
  'bitbucket pr list': (r) => String(r.id),
  'ado pr list': (r) => String(r.pullRequestId),
};
/** Each host's pull request get, and the input field naming the pull request. */
const PR_GETS: Record<string, string> = { 'github pr get': 'number', 'bitbucket pr get': 'id', 'ado pr get': 'id' };
/** A pull request record that is merged, declined or abandoned, by whichever host's words it uses. */
const closedPr = (data: unknown) => isRec(data) && (data.state === 'closed' || ['MERGED', 'DECLINED', 'SUPERSEDED'].includes(String(data.state)) || data.status === 'completed' || data.status === 'abandoned');

/** Envelopes the sync handed back as the last copy, untouched: the cache needn't compare them with what it holds. */
const reusedEnvelopes = new WeakSet<object>();
const reuse = (env: Envelope): Envelope => (reusedEnvelopes.add(env), env);

/** The same search asking for ids only, where the command can: a listing to reconcile with, not to read. */
const idsOnly = (command: string, input: Rec): Rec => {
  if (!command.endsWith('issue search')) return input;
  // Ids only means no histories either: the reconcile lists the project, it doesn't read it.
  return { ...Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'changelog')), fields: 'key' };
};

/** Two pages of one listing as one answer: lists concatenated, the rest from the newer page. */
export function joinPages(a: unknown, b: unknown): unknown {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (isRec(a) && isRec(b)) {
    const out: Rec = { ...a, ...b };
    for (const [k, v] of Object.entries(b)) if (Array.isArray(v) && Array.isArray(a[k])) out[k] = [...(a[k] as unknown[]), ...v];
    return out;
  }
  return b;
}

/** `items` replaced and extended by `fresh`, matched by id; the order is the old one, new items last. */
function mergeById(items: Rec[], fresh: Rec[], id: (r: Rec) => string): Rec[] {
  const byId = new Map(fresh.map((r) => [id(r), r]));
  const out = items.map((r) => byId.get(id(r)) ?? r);
  const seen = new Set(items.map(id));
  for (const r of fresh) if (!seen.has(id(r))) out.push(r);
  return out;
}

interface Source {
  area: string;
  calls: number;
  error: { message: string; fix: string | null } | null;
  /** Ids that changed since the watermark, or null when this sync read the source whole. */
  changed: Set<string> | null;
  /** Pull requests that changed since the watermark, kept apart because a work item and a pull request can share a number. */
  changedPrs: Set<string> | null;
  /** Searches this sync ran, and how many of them listed the source whole (a first read or a reconcile). */
  searches: number;
  fullSearches: number;
}

interface Run {
  toilProject: string;
  startedAt: string;
  sources: Map<string, Source>;
  responses: Array<{ command: string; input: Rec; envelope: Envelope }>;
}

export interface SyncOptions {
  cache: Cache;
  execute: SyncExecute;
  mapOwi: MapOwi;
  now?: () => Date;
  maxPages?: number;
  /**
   * When the job ends, however it ended: the worklog (#308) folds every
   * toil project's pages again, since the cache's retention ran for all of them.
   * A failure is said in the job's messages and never fails the sync.
   */
  onFinished?: () => Promise<void>;
  /** A toil project toil no longer has was forgotten (#494): whatever else Toil UI kept under its name goes too. */
  onForget?: (toilProject: string) => void;
}

export class SyncService {
  private readonly cache: Cache;
  private readonly toil: SyncExecute;
  private readonly mapOwi: MapOwi;
  private readonly now: () => Date;
  private readonly maxPages: number;
  private readonly onFinished: SyncOptions['onFinished'];
  private readonly onForget: SyncOptions['onForget'];
  private job: SyncJob = idle();
  private current: Promise<SyncJob> | null = null;
  private controller: AbortController | null = null;

  constructor(options: SyncOptions) {
    this.cache = options.cache;
    this.toil = options.execute;
    this.mapOwi = options.mapOwi;
    this.now = options.now ?? (() => new Date());
    this.maxPages = options.maxPages ?? MAX_PAGES;
    this.onFinished = options.onFinished;
    this.onForget = options.onForget;
  }

  status(): SyncStatus {
    return { job: structuredClone(this.job), toilProjects: this.cache.states(), retentionDays: this.cache.retentionDays };
  }

  get running(): boolean {
    return this.current !== null;
  }

  /** Holds that keep a sync from starting: a toil project being renamed (#342). */
  private holds = 0;

  /** Keeps any sync from starting until the returned function is called. */
  hold(): () => void {
    this.holds++;
    let done = false;
    return () => {
      if (!done) this.holds--;
      done = true;
    };
  }

  /** Starts a sync of every toil project, or of one, and returns at once; poll `status()`. Throws SyncBusy while one runs. */
  start(ctx: RequestContext, toilProject?: string): SyncJob {
    void this.run(ctx, toilProject).catch(() => {});
    return structuredClone(this.job);
  }

  /** Runs a sync to the end. */
  run(ctx: RequestContext, toilProject?: string): Promise<SyncJob> {
    if (this.current) throw new SyncBusy();
    if (this.holds) throw new SyncBusy('A Toil project is being renamed, so the sync waits until it is done.');
    this.controller = new AbortController();
    this.job = { ...idle(), running: true, by: ctx.viewer.id, startedAt: this.now().toISOString() };
    this.current = this.sync(toilProject, this.controller.signal).finally(() => {
      this.current = null;
      this.controller = null;
    });
    return this.current;
  }

  /** Empties the cache. Refused while a sync runs, so the two never interleave. */
  wipe() {
    if (this.current) throw new SyncBusy();
    this.cache.wipe();
    this.job = idle();
  }

  /** Stops a running sync and waits for it. */
  async close() {
    this.controller?.abort();
    await this.current?.catch(() => {});
  }

  private say(message: string) {
    this.job.messages.push(message);
    if (this.job.messages.length > MAX_MESSAGES) this.job.messages.splice(0, this.job.messages.length - MAX_MESSAGES);
  }

  private async sync(only: string | undefined, signal: AbortSignal): Promise<SyncJob> {
    const job = this.job;
    try {
      const list = await this.call('projects list', {}, signal);
      if (!list.ok) throw new Error(`projects list failed: ${list.error.message}${list.error.fix ? ` ${list.error.fix}` : ''}`);
      const names = recs((list.data as Rec).toilProjects)
        .filter((d) => d.shadowedBy === null || d.shadowedBy === undefined)
        .map((d) => String(d.name));
      if (only !== undefined && !names.includes(only)) throw new Error(`toil has no Toil project named ${JSON.stringify(only)}. Run toil projects list to see them.`);
      // A toil project toil no longer has is forgotten, with everything synced for it.
      if (only === undefined) for (const old of this.cache.toilProjectNames()) if (!names.includes(old)) {
        this.cache.forget(old);
        try {
          this.onForget?.(old);
        } catch (e) {
          this.say(`${old}: couldn't forget its other records: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const targets = only === undefined ? names : [only];
      job.toilProjectsTotal = targets.length;
      if (!targets.length) this.say('No Toil projects to sync: add one with toil projects add.');
      for (const name of targets) {
        if (signal.aborted) throw new Error('The sync was cancelled.');
        job.toilProject = name;
        this.say(`${name}: syncing`);
        await this.syncToilProject(name, signal);
        job.toilProjectsDone++;
      }
    } catch (e) {
      job.error = e instanceof Error ? e.message : String(e);
      this.say(`Stopped: ${job.error}`);
    } finally {
      try {
        await this.onFinished?.();
      } catch (e) {
        this.say(`Couldn't update the worklog: ${e instanceof Error ? e.message : String(e)}`);
      }
      job.running = false;
      job.toilProject = null;
      job.finishedAt = this.now().toISOString();
    }
    return structuredClone(job);
  }

  /** One call to toil, every page of it, with its progress counted. */
  private async call(command: string, input: Rec, signal: AbortSignal): Promise<Envelope> {
    const onProgress = (event: ProgressEvent) => {
      if (event.type === 'request') this.job.requests++;
      else if (event.type === 'page') this.job.pages++;
      else if (event.type === 'retry') this.job.retries++;
      if (event.type !== 'request') this.say(event.message);
    };
    let env = await this.toil(command, input, { readOnly: true, caller: CALLER, signal, onProgress });
    this.job.fetched++;
    let pages = 1;
    while (env.ok && env.meta.page?.nextCursor) {
      if (pages >= this.maxPages) {
        return {
          ok: false,
          data: null,
          error: { code: 'INVALID_INPUT', message: `${command} still had more after ${this.maxPages} pages, so the sync stopped there rather than keep only part of it.`, fix: 'Narrow the Toil project\'s query (a Jira project with fewer issues, a WIQL with a date bound), then sync again.' },
          meta: env.meta,
        } as Envelope;
      }
      const next = await this.toil(command, { ...input, cursor: env.meta.page.nextCursor }, { readOnly: true, caller: CALLER, signal, onProgress });
      this.job.fetched++;
      pages++;
      if (!next.ok) return next;
      env = { ...next, data: joinPages(env.data, next.data) };
    }
    if (env.ok && env.meta.page) env = { ...env, meta: { ...env.meta, page: undefined } } as Envelope;
    return env;
  }

  private async syncToilProject(name: string, signal: AbortSignal) {
    const run: Run = { toilProject: name, startedAt: this.now().toISOString(), sources: new Map(), responses: [] };
    const syncing = (command: string, input: Record<string, unknown> = {}) => this.answer(run, command, input, signal);
    let loaded;
    try {
      loaded = await loadToilProject(syncing, name, { mapOwi: this.mapOwi, windowDays: windowFor(this.cache.retentionDays), now: this.now });
    } catch (e) {
      // `projects show` failed: the toil project keeps everything it had.
      const message = e instanceof Error ? e.message : String(e);
      this.cache.saveFailure(name, this.now().toISOString(), message);
      this.say(`${name}: failed, ${message}`);
      return;
    }
    const sources: SourceResult[] = [...run.sources.values()].map((s) => ({
      area: s.area,
      ok: s.error === null,
      error: s.error?.message ?? null,
      fix: s.error?.fix ?? null,
      watermark: s.error === null ? new Date(Date.parse(run.startedAt) - SKEW_MS).toISOString() : null,
      fullReadAt: s.error === null && s.searches > 0 && s.fullSearches === s.searches ? run.startedAt : null,
      calls: s.calls,
    }));
    const news = this.cache.saveToilProject({
      toilProject: name,
      startedAt: run.startedAt,
      finishedAt: this.now().toISOString(),
      responses: run.responses,
      items: loaded.items,
      changes: loaded.changes,
      deployments: loaded.deployments,
      sources,
    });
    if (news.length) (this.job.news ??= []).push({ toilProject: name, events: [...news].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(-MAX_NEWS) });
    const failed = sources.filter((s) => !s.ok);
    this.say(`${name}: ${loaded.items.length} items, ${loaded.changes.length} changes, ${loaded.deployments.length} deployments${failed.length ? `; ${failed.map((s) => s.area).join(', ')} failed, showing the last good copy` : ''}`);
  }

  private source(run: Run, area: string): Source {
    let s = run.sources.get(area);
    if (!s) {
      s = { area, calls: 0, error: null, changed: null, changedPrs: null, searches: 0, fullSearches: 0 };
      run.sources.set(area, s);
    }
    return s;
  }

  /**
   * The loader's `execute()` during a sync: toil, made incremental, with a
   * failed call answered by its last good copy so nothing blanks.
   */
  private async answer(run: Run, command: string, input: Rec, signal: AbortSignal): Promise<Envelope> {
    // The toil project itself is read fresh, and isn't a source: it's toil's own config.
    if (command === 'projects show' || command === 'projects list') return this.call(command, input, signal);
    const area = areaOf(command);
    const source = this.source(run, area);
    source.calls++;
    const env = await this.fetch(run, source, command, input, signal);
    // A file that isn't there (a repository with no CODEOWNERS) is an answer, kept like one, not a failing source.
    if (env.ok || (ABSENT_IS_AN_ANSWER.has(command) && env.error.code === 'NOT_FOUND')) {
      run.responses.push({ command, input, envelope: env, ...(reusedEnvelopes.has(env) ? { unchanged: true } : {}) });
      return env;
    }
    source.error ??= { message: `${command}: ${env.error.message}`, fix: env.error.fix ?? null };
    this.say(`${run.toilProject}: ${command} failed, ${env.error.message}`);
    const last = this.cache.response(run.toilProject, command, input);
    return last ? last.envelope : env;
  }

  private async fetch(run: Run, source: Source, command: string, input: Rec, signal: AbortSignal): Promise<Envelope> {
    const { toilProject } = run;
    const state = this.cache.source(toilProject, source.area);
    const watermark = state?.watermark ?? null;

    const search = SEARCHES[command];
    if (search) {
      source.searches++;
      const last = this.cache.response(toilProject, command, input);
      if (!watermark || !last?.envelope.ok) {
        const whole = await this.call(command, input, signal);
        if (whole.ok) source.fullSearches++;
        return whole;
      }
      const delta = await this.call(command, { ...input, updatedSince: watermark }, signal);
      if (!delta.ok) return delta;
      const listOf = (data: unknown) => recs(search.list === null ? data : (data as Rec)[search.list]);
      const fresh = listOf(delta.data);
      source.changed = new Set([...(source.changed ?? []), ...fresh.map(search.id)]);
      this.say(`${toilProject}: ${command} since ${watermark}: ${fresh.length} changed`);
      let merged = mergeById(listOf(last.envelope.data), fresh, search.id);
      // A search "since" never lists what was deleted or moved away, so once in a while the source is listed whole and what it no longer has is dropped.
      let removed = 0;
      const fullReadAt = state?.fullReadAt ?? null;
      if (search.reconcile && (fullReadAt === null || Date.parse(run.startedAt) - Date.parse(fullReadAt) >= RECONCILE_MS)) {
        const whole = await this.call(command, idsOnly(command, input), signal);
        if (whole.ok) {
          const present = new Set(listOf(whole.data).map(search.id));
          const kept = merged.filter((r) => present.has(search.id(r)));
          removed = merged.length - kept.length;
          merged = kept;
          source.fullSearches++;
          if (removed) this.say(`${toilProject}: ${command} listed whole: ${removed} no longer there`);
        } else {
          // The delta stands and the watermark moves on; fullReadAt stays where it was, so the next sync lists the source whole again.
          this.say(`${toilProject}: ${command} listed whole failed, ${whole.error.message}; keeping the changes since ${watermark}, trying again next sync`);
        }
      }
      if (!fresh.length && !removed) return reuse(last.envelope);
      if (search.list === null) return { ...delta, data: merged };
      const data: Rec = { ...(last.envelope.data as Rec), [search.list]: merged };
      if ('total' in data) data.total = merged.length;
      if ('maxResults' in data) data.maxResults = merged.length;
      return { ...delta, data };
    }

    if (command === ADO_FEED) {
      const last = this.cache.response(toilProject, command, input);
      if (!watermark || !last?.envelope.ok || !Array.isArray(last.envelope.data)) return this.call(command, input, signal);
      // The delta lays new revisions over old ones and never refreshes what it already holds (a renamed iteration, a changed display name), so once in a while the feed is read whole, on the day the search is listed whole.
      const fullReadAt = state?.fullReadAt ?? null;
      if (fullReadAt === null || Date.parse(run.startedAt) - Date.parse(fullReadAt) >= RECONCILE_MS) {
        const whole = await this.call(command, input, signal);
        if (whole.ok && Array.isArray(whole.data)) {
          this.say(`${toilProject}: ${command} read whole: ${whole.data.length} revisions`);
          return whole;
        }
        this.say(`${toilProject}: ${command} read whole failed${whole.ok ? '' : `, ${whole.error.message}`}; keeping the changes since ${watermark}, trying again next sync`);
      }
      const delta = await this.call(command, { ...input, updatedSince: watermark }, signal);
      if (!delta.ok || !Array.isArray(delta.data)) return delta;
      this.say(`${toilProject}: ${command} since ${watermark}: ${delta.data.length} revisions`);
      // Only the work items this run lists matter; the search ran before the feed, so its answer is in the run.
      const search = run.responses.find((r) => r.command === ADO_SEARCH && r.envelope.ok);
      const keep = search ? new Set(recs((search.envelope.data as Rec).workItems).map((w) => Number(w.id))) : undefined;
      const merged = mergeFeed(recs(last.envelope.data), recs(delta.data), keep);
      if (!delta.data.length && merged.length === (last.envelope.data as unknown[]).length) return reuse(last.envelope);
      return { ...delta, data: merged };
    }

    const prId = PR_LISTS[command];
    if (prId) {
      const last = this.cache.response(toilProject, command, input);
      if (!watermark || !last?.envelope.ok) return this.call(command, input, signal);
      const delta = await this.call(command, { ...input, updatedSince: watermark }, signal);
      if (!delta.ok) return delta;
      const fresh = recs(delta.data);
      source.changedPrs = new Set([...(source.changedPrs ?? []), ...fresh.map(prId)]);
      this.say(`${toilProject}: ${command} since ${watermark}: ${fresh.length} changed`);
      return { ...delta, data: mergeById(recs(last.envelope.data), fresh, prId) };
    }

    const getField = PR_GETS[command];
    if (getField !== undefined && source.changedPrs !== null && !source.changedPrs.has(String(input[getField]))) {
      const last = this.cache.response(toilProject, command, input);
      if (last?.envelope.ok && closedPr(last.envelope.data)) {
        this.job.reused++;
        return reuse(last.envelope);
      }
    }

    if (command === BOARD) {
      const env = await this.call(command, input, signal);
      if (!env.ok) return env;
      const last = this.cache.response(toilProject, command, input);
      if (last?.envelope.ok && watermark) {
        const before = new Map(recs(last.envelope.data).map((i) => [numberOf(i), updatedOf(i)]));
        const changed = recs(env.data).filter((i) => before.get(numberOf(i)) !== updatedOf(i) || !before.has(numberOf(i))).map(numberOf);
        source.changed = new Set([...(source.changed ?? []), ...changed]);
        this.say(`${toilProject}: ${command}: ${changed.length} changed since the last sync`);
      }
      return env;
    }

    const batch = BATCHES[command];
    if (batch && Array.isArray(input[batch.field]) && (input[batch.field] as unknown[]).length > 1) {
      const wanted = (input[batch.field] as unknown[]).map(String);
      // The loader asks in slices, and where a slice ends moves as items come and go, so every stored slice is the last copy, not only the newest.
      const stored = this.cache.all(toilProject, command).filter((r) => r.envelope.ok);
      const last = stored[0];
      const changed = source.changed;
      if (changed === null || !last) return this.call(command, input, signal);
      const cached = new Map<string, Rec>();
      for (const row of stored) for (const r of recs((row.envelope.data as Rec)[batch.list])) if (!cached.has(batch.id(r))) cached.set(batch.id(r), r);
      const toFetch = wanted.filter((id) => changed.has(id) || !cached.has(id));
      if (!toFetch.length) {
        this.job.reused++;
        const all = recs((last.envelope.data as Rec)[batch.list]);
        // Asking for exactly what was cached, in the same order, is the last copy itself.
        if (stored.length === 1 && all.length === wanted.length && all.every((r, n) => batch.id(r) === wanted[n])) return reuse(last.envelope);
        return { ...(last.envelope as Extract<Envelope, { ok: true }>), data: { ...(last.envelope.data as Rec), [batch.list]: wanted.flatMap((id) => (cached.has(id) ? [cached.get(id)!] : [])) } };
      }
      const asInput = (ids: string[]) => (input[batch.field] as unknown[]).filter((v) => ids.includes(String(v)));
      const delta = await this.call(command, { ...input, [batch.field]: asInput(toFetch) }, signal);
      if (!delta.ok) return delta;
      const data = delta.data as Rec;
      // One id comes back as the item itself (github issue get), several as a list.
      const fresh = Array.isArray(data[batch.list]) ? recs(data[batch.list]) : isRec(data) ? [data] : [];
      for (const r of fresh) cached.set(batch.id(r), r);
      const list = wanted.flatMap((id) => (cached.has(id) ? [cached.get(id)!] : []));
      const base = Array.isArray(data[batch.list]) ? data : (last.envelope.data as Rec);
      return { ...delta, data: { ...base, [batch.list]: list, ...('count' in base ? { count: list.length } : {}) } };
    }

    const field = HISTORIES[command];
    if (field !== undefined && source.changed !== null && !source.changed.has(String(input[field]))) {
      const last = this.cache.response(toilProject, command, input);
      if (last?.envelope.ok) {
        this.job.reused++;
        return reuse(last.envelope);
      }
    }
    return this.call(command, input, signal);
  }
}

const numberOf = (item: Rec) => (isRec(item.content) ? String(item.content.number) : String(item.id));
const updatedOf = (item: Rec) => (isRec(item.content) && typeof item.content.updatedAt === 'string' ? item.content.updatedAt : typeof item.updatedAt === 'string' ? item.updatedAt : null);

function idle(): SyncJob {
  return { running: false, by: null, startedAt: null, finishedAt: null, toilProject: null, toilProjectsDone: 0, toilProjectsTotal: 0, fetched: 0, reused: 0, requests: 0, pages: 0, retries: 0, messages: [], error: null, news: [] };
}
