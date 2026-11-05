/**
 * The worklog, server side (#308): one Markdown page per toil project per day, kept
 * in the cache's folder in Toil UI's data folder,
 *
 *   <data folder>/cache/worklog/<toil project>/<yyyy-mm>/<yyyy-mm-dd>.md
 *   <data folder>/cache/worklog/<toil project>/runs/<run id>.md   (each agent run's transcript)
 *
 * so the cache's retention and its wipe cover the pages too: they hold ticket
 * titles and names. Each page is folded from the cache (src/model/worklog.ts)
 * by code alone. A sync records its facts as it goes (Cache.saveToilProject); after
 * it, every page is folded again from what the cache holds and written only
 * where its text changed, so a page always matches the cache and building a
 * day twice gives the same file. A day the cache no longer has anything for
 * loses its page.
 *
 * Whether a person applied an agent's proposal is read from toil's own audit
 * log (`toil audit list`), never assumed. Export goes through toil's file
 * service (`toil util encode --decode --out`, which writes a new file inside
 * the workspace it's given and nowhere else), and publishing is a proposal.
 * A diary kept by the filing system, which has never once forgotten to write
 * in it.
 */

import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  buildDay, dayOf, gapsFor, isDay, isMonth, markdownOf, monthMarkdown, monthOf, transcriptOf,
  type AgentRun, type Applied, type WorklogPage,
} from '../src/model/worklog.ts';
import { readPeople } from '../src/model/people.ts';
import { buildStandup, daysBetween, rangeProblem, standupMarkdown, standupText } from '../src/model/standup.ts';
import { POSITIONAL_FIELDS } from '../src/proposal.ts';
import type { Envelope, Execute } from '../src/toil.ts';
import { pullRequestsOf } from './agents/tools.ts';
import { exportName, MAX_NOTE, WorklogRefusal, publishProposals, type ExportWhat, type ShowAreas, type WorklogApi, type WorklogDay, type WorklogExport, type WorklogMonth, type WorklogRebuilt, type WorklogStandup } from '../src/worklog.ts';
import type { Cache } from './cache.ts';
import { CALLER } from './store.ts';


/** How long one read of toil's audit log answers for "was it applied". */
export const AUDIT_FRESH_MS = 60_000;

/** toil's toil project names: lowercase letters, digits and single hyphens, so each is a safe folder name. */
const TOIL_PROJECT = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export interface WorklogOptions {
  /** The cache, as a getter, since a wipe swaps the file underneath. */
  cache: () => Cache;
  /** toil's own `execute()`: the audit log's reads, `projects show` and the export. */
  execute: Execute;
  now?: () => Date;
}

const fwd = (p: string) => p.replace(/\\/g, '/');

export class WorklogService implements WorklogApi {
  readonly disabled = null;
  private readonly now: () => Date;
  /** Every fold and write runs in turn, so a note or a run that lands mid-fold isn't overwritten by a page folded before it. */
  private queue: Promise<unknown> = Promise.resolve();
  private audit: { since: string; at: number; env: Envelope } | null = null;

  constructor(private readonly o: WorklogOptions) {
    this.now = o.now ?? (() => new Date());
  }

  private get cache() {
    return this.o.cache();
  }

  /** The folder a toil project's pages are kept in. */
  folder(toilProject: string): string {
    return join(this.cache.paths.dir, 'worklog', toilProject);
  }

  pagePath(toilProject: string, day: string): string {
    return join(this.folder(toilProject), monthOf(day), `${day}.md`);
  }

  private checkToilProject(toilProject: unknown): string {
    if (typeof toilProject !== 'string' || !TOIL_PROJECT.test(toilProject)) throw new WorklogRefusal('Name a Toil project: lowercase letters, digits and single hyphens.', 'Use a name toil projects list shows.');
    if (!this.cache.states().some((s) => s.name === toilProject) && !this.cache.worklogDays(toilProject).length) {
      throw new WorklogRefusal(`Toil UI hasn't synced ${toilProject}, so it has no worklog yet.`, 'Press Sync now in the Sync panel; each sync records the day it saw.', 404);
    }
    return toilProject;
  }

  private today() {
    return dayOf(this.now().toISOString())!;
  }

  private checkDay(day: unknown): string {
    if (!isDay(day)) throw new WorklogRefusal('Name a day as yyyy-mm-dd.', 'Pick one from the calendar.');
    if (day > this.today()) throw new WorklogRefusal(`${day} hasn't happened yet, so it has no page.`, 'Pick today or an earlier day.');
    return day;
  }

  /**
   * What toil's audit log says about the proposals agent runs made, by
   * proposal id: one read of the log for every run passed. A matching write is
   * the same command, writing, succeeding, after the run finished, naming the
   * same item in its positional fields (the id the command acts on), or, for a
   * command with none (a create), with every field the proposal named. Where
   * the log can't tell (a line too large to keep its input, or more writes than
   * one read returns), the proposal says so rather than guess.
   */
  private async applied(runs: AgentRun[]): Promise<Record<string, Applied>> {
    const wanted = runs.flatMap((r) => r.proposals.filter((p) => p.command).map((p) => ({ p, after: r.finishedAt ?? r.startedAt })));
    if (!wanted.length) return {};
    const since = wanted.map((w) => w.after).sort()[0]!;
    const env = await this.auditSince(since);
    const out: Record<string, Applied> = {};
    if (!env.ok) {
      for (const { p } of wanted) out[p.id] = { state: 'unknown', why: `${env.error.message}${env.error.fix ? ` ${env.error.fix}` : ''}` };
      return out;
    }
    const entries = (Array.isArray(env.data) ? env.data : []) as Array<{ time: string; via: string; command: string; writes: boolean; outcome: string; input: unknown }>;
    const capped = (env.meta.warnings ?? []).some((w) => w.code === 'AUDIT_LIMIT');
    // Scalars as text, since a proposal may carry an id as "7" that the CLI typed to 7; lists and objects as JSON.
    const same = (a: unknown, b: unknown) => (typeof a === 'object' || typeof b === 'object' ? JSON.stringify(a) === JSON.stringify(b) : String(a) === String(b));
    for (const { p, after } of wanted) {
      const positional = POSITIONAL_FIELDS.get(p.command!) ?? [];
      const fields = positional.length ? positional : Object.keys(p.input ?? {}).filter((k) => k !== 'allowWrite');
      const writes = entries.filter((e) => e.command === p.command && e.writes && e.outcome === 'ok' && e.time >= after);
      const hit = writes
        .filter((e) => typeof e.input === 'object' && e.input !== null && fields.every((f) => same((e.input as Record<string, unknown>)[f], p.input?.[f])))
        .sort((a, b) => (a.time < b.time ? -1 : 1))[0];
      const hashed = writes.flatMap((e) => fields.filter((f) => typeof e.input === 'object' && e.input !== null && /^sha256:/.test(String((e.input as Record<string, unknown>)[f]))));
      if (hit) out[p.id] = { state: 'applied', at: hit.time, via: hit.via };
      else if (hashed.length) out[p.id] = { state: 'unknown', why: `toil's audit log has a ${p.command} write after it, but keeps only a hash of its ${[...new Set(hashed)].join(', ')}.` };
      else if (writes.some((e) => e.input === null)) out[p.id] = { state: 'unknown', why: `toil's audit log has a ${p.command} write after it whose input was too large to record.` };
      else if (capped) out[p.id] = { state: 'unknown', why: "toil's audit log has more writes since the run than one read returns (1,000)." };
      else out[p.id] = { state: 'not-applied' };
    }
    return out;
  }

  /**
   * toil's audit log since a time, read at most once a minute: every read is
   * itself a line in the log, and a page read shouldn't fill it with Toil UI's
   * own lookups. A read from earlier covers any later `since`.
   */
  private async auditSince(since: string) {
    const now = this.now().getTime();
    if (this.audit && this.audit.since <= since && now - this.audit.at < AUDIT_FRESH_MS) return this.audit.env;
    const env = await this.o.execute('audit list', { since, writesOnly: true, limit: 1000 }, { readOnly: true, caller: CALLER });
    if (env.ok) this.audit = { since, at: now, env };
    return env;
  }

  /** The pages for some days, as the cache has them now, with the audit log read once for all of them. */
  private async pages(toilProject: string, days: string[]): Promise<WorklogPage[]> {
    const runs = days.flatMap((d) => this.cache.runs(toilProject, d));
    const applied = await this.applied(runs);
    const syncs = this.cache.syncRuns(toilProject);
    const now = this.now().toISOString();
    return days.map((day) =>
      buildDay({ toilProject, day, events: this.cache.worklogEvents(toilProject, day), runs: runs.filter((r) => dayOf(r.startedAt) === day), applied, notes: this.cache.notes(toilProject, day), syncs, now, retentionDays: this.cache.retentionDays }),
    );
  }

  /** Writes a page where its text changed; returns whether it wrote. Owner-only, like the cache. */
  private write(path: string, text: string): boolean {
    if (existsSync(path) && readFileSync(path, 'utf8') === text) return false;
    const dir = join(path, '..');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows has no POSIX modes; the file is under the user's profile there.
    }
    return true;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Folds every day of a toil project that has anything into its page, writing
   * only those whose text changed, and removes pages and transcripts the
   * cache no longer backs. Returns the days it wrote.
   */
  reconcile(toilProject: string): Promise<string[]> {
    return this.serial(() => this.fold(toilProject));
  }

  private async fold(toilProject: string): Promise<string[]> {
    if (!TOIL_PROJECT.test(toilProject)) return [];
    const days = this.cache.worklogDays(toilProject);
    const written: string[] = [];
    for (const page of await this.pages(toilProject, days)) if (this.write(this.pagePath(toilProject, page.day), markdownOf(page))) written.push(page.day);
    const runs = new Set(this.cache.runs(toilProject).map((r) => r.id));
    for (const run of this.cache.runs(toilProject)) this.write(join(this.folder(toilProject), 'runs', `${run.id}.md`), transcriptOf(run));
    // What the cache no longer backs goes: a day pruned past retention, a run's transcript, a month left empty.
    const root = this.folder(toilProject);
    if (existsSync(root)) {
      for (const entry of readdirSync(root)) {
        const dir = join(root, entry);
        if (!statSync(dir).isDirectory()) continue;
        for (const file of readdirSync(dir)) {
          const id = file.replace(/\.md$/, '');
          const keep = entry === 'runs' ? runs.has(id) : isMonth(entry) && days.includes(id);
          if (!keep) rmSync(join(dir, file), { force: true });
        }
        if (!readdirSync(dir).length) rmSync(dir, { recursive: true, force: true });
      }
    }
    return written.sort();
  }

  /** Every toil project the cache holds, and the folders of any it has forgotten. */
  reconcileAll(): Promise<void> {
    return this.serial(async () => {
      const names = this.cache.toilProjectNames();
      for (const name of names) await this.fold(name);
      const root = join(this.cache.paths.dir, 'worklog');
      if (!existsSync(root)) return;
      for (const entry of readdirSync(root)) if (!names.includes(entry)) rmSync(join(root, entry), { recursive: true, force: true });
    });
  }

  async month(toilProject: string, month?: string): Promise<WorklogMonth> {
    const name = this.checkToilProject(toilProject);
    const today = this.today();
    const wanted = month ?? monthOf(today);
    if (!isMonth(wanted)) throw new WorklogRefusal('Name a month as yyyy-mm.', 'Use the calendar\'s arrows.');
    const all = this.cache.worklogDays(name);
    const syncs = this.cache.syncRuns(name);
    const now = this.now().toISOString();
    const days = all.filter((d) => monthOf(d) === wanted && d <= today);
    return {
      toilProject: name,
      month: wanted,
      today,
      timeZone: 'UTC',
      retentionDays: this.cache.retentionDays,
      first: all[0] ?? null,
      last: all.filter((d) => d <= today).at(-1) ?? null,
      days: days.map((day) => {
        const events = this.cache.worklogEvents(name, day).filter((e) => e.kind !== 'build-passed').length;
        return { day, lines: events + this.cache.runs(name, day).length + this.cache.notes(name, day).length, gaps: gapsFor({ day, syncs, now, retentionDays: this.cache.retentionDays }).length };
      }),
    };
  }

  /** One day's page, built now, and written if it changed. */
  async day(toilProject: string, day: string): Promise<WorklogDay> {
    const name = this.checkToilProject(toilProject);
    const d = this.checkDay(day);
    return this.serial(() => this.foldDay(name, d));
  }

  private async foldDay(name: string, d: string): Promise<WorklogDay> {
    const [page] = await this.pages(name, [d]);
    const markdown = markdownOf(page!);
    const path = this.pagePath(name, d);
    // A day the cache has nothing for has no page to keep: it's shown, never written.
    if (this.cache.worklogDays(name).includes(d)) this.write(path, markdown);
    return { page: page!, markdown, file: existsSync(path) ? fwd(path) : null };
  }

  async rebuild(toilProject: string, day: string): Promise<WorklogRebuilt> {
    const name = this.checkToilProject(toilProject);
    const d = this.checkDay(day);
    const path = this.pagePath(name, d);
    return this.serial(async () => {
      const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
      const built = await this.foldDay(name, d);
      return { ...built, same: before === null ? null : before === built.markdown };
    });
  }

  async addNote(toilProject: string, text: string, by = 'You'): Promise<WorklogDay> {
    const name = this.checkToilProject(toilProject);
    if (typeof text !== 'string' || !text.trim()) throw new WorklogRefusal('A note needs some text.', 'Type the note, then add it.');
    if (text.length > MAX_NOTE) throw new WorklogRefusal(`A note is at most ${MAX_NOTE} characters.`, 'Shorten it, or add it as two notes.');
    return this.serial(async () => {
      const at = this.now().toISOString();
      this.cache.addNote(name, { id: randomUUID(), at, by, text: text.trim().replace(/\s*\r?\n\s*/g, ' ') });
      return this.foldDay(name, dayOf(at)!);
    });
  }

  /**
   * Records an agent run as it starts and again as it ends, and writes its
   * transcript; its day's page is folded again in turn, without the question
   * waiting on it. A run that started before the cache was opened or wiped
   * isn't brought back into it. The Ask pane's questions come here from the
   * agent host; assign-to-agent (#293) will send its assignments the same way.
   */
  async recordRun(run: AgentRun): Promise<void> {
    if (!TOIL_PROJECT.test(run.toilProject) || run.startedAt < this.cache.openedAt) return;
    this.cache.saveRun(run);
    this.write(join(this.folder(run.toilProject), 'runs', `${run.id}.md`), transcriptOf(run));
    void this.serial(() => this.foldDay(run.toilProject, dayOf(run.startedAt)!)).catch(() => undefined);
  }

  /**
   * The day's or the month's Markdown, written through toil's file service
   * into `folder`: `toil util encode base64 --decode --out <file>`, run with
   * that folder as its workspace. toil writes a new file only, inside the
   * workspace, never into its own config, and records the call in its audit
   * log. Then the proposals for publishing it.
   */
  async exportTo(toilProject: string, what: ExportWhat, folder: string): Promise<WorklogExport> {
    const name = this.checkToilProject(toilProject);
    if (typeof folder !== 'string' || !folder.trim() || !isAbsolute(folder.trim())) throw new WorklogRefusal('Name the folder to export into, as a full path.', 'Type a folder that exists, such as your Documents folder.');
    let markdown: string;
    if ('from' in what) {
      markdown = (await this.standup(name, what.from, what.to)).markdown;
    } else if ('day' in what) {
      const d = this.checkDay(what.day);
      markdown = (await this.serial(() => this.foldDay(name, d))).markdown;
    } else {
      if (!isMonth(what.month)) throw new WorklogRefusal('Name a month as yyyy-mm.', 'Export the month the calendar shows.');
      const days = this.cache.worklogDays(name).filter((d) => monthOf(d) === what.month && d <= this.today());
      if (!days.length) throw new WorklogRefusal(`${what.month} has no worklog pages to export.`, 'Pick a month the calendar shows pages in.');
      markdown = monthMarkdown(name, what.month, await this.pages(name, days));
    }
    const file = exportName(name, what);
    const env = await this.o.execute('util encode', { scheme: 'base64', decode: true, text: Buffer.from(markdown, 'utf8').toString('base64'), out: file }, { readOnly: false, caller: CALLER, workspace: folder.trim() });
    if (!env.ok) throw new WorklogRefusal(`toil couldn't write the export: ${env.error.message}`, env.error.fix ?? 'Check the folder, then try again.');
    const path = typeof (env.data as { file?: unknown }).file === 'string' ? ((env.data as { file: string }).file) : fwd(join(folder.trim(), file));
    const show = await this.o.execute('projects show', { toilProject: name }, { readOnly: true, caller: CALLER });
    const areas = show.ok && typeof show.data === 'object' && show.data !== null ? ((show.data as { areas?: ShowAreas }).areas ?? {}) : {};
    return { path, bytes: Buffer.byteLength(markdown, 'utf8'), proposals: publishProposals(name, what, path, areas) };
  }

  /**
   * The stand-up for a range of days (#345): every day's page as the cache
   * has it now, the toil project's people from `toil projects show`, and the
   * items and pull requests of the latest sync, folded by
   * src/model/standup.ts. Nothing is written: a stand-up is read, copied or
   * exported, never kept.
   */
  async standup(toilProject: string, from: string, to: string): Promise<WorklogStandup> {
    const name = this.checkToilProject(toilProject);
    const problem = rangeProblem(from, to, this.today());
    if (problem) throw new WorklogRefusal(problem, 'Pick the days again, ending today or earlier.');
    const pages = await this.pages(name, daysBetween(from, to));
    const show = await this.o.execute('projects show', { toilProject: name }, { readOnly: true, caller: CALLER });
    const read = show.ok ? readPeople(typeof show.data === 'object' && show.data !== null ? (show.data as { toilProject?: unknown }).toilProject : null) : null;
    const notes = read ? read.notes : [`toil projects show ${name} failed (${show.ok ? '' : show.error.message}), so each account is its own person here: the Toil project's people couldn't be read.`];
    const pullRequests = pullRequestsOf(this.cache.changes(name));
    const asOf = this.cache.syncRuns(name).filter((s) => s.ok).map((s) => s.at).sort().at(-1) ?? null;
    const report = buildStandup({ toilProject: name, from, to, pages, people: read?.people ?? [], items: this.cache.items(name), pullRequests, asOf, notes });
    return { report, markdown: standupMarkdown(report), text: standupText(report) };
  }
}

