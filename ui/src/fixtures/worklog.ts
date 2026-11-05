/**
 * The sample worklog (#308), for the site preview and `toil-ui --sample`:
 * each sample toil project's pages folded by the same code the server folds them
 * with (src/model/worklog.ts), from the sample's own items, pull requests and
 * builds, plus a scripted fortnight of daily syncs (one of which fails), a
 * blocker one sync saw, an agent question with its proposals and a note.
 * It keeps nothing: a note or an export is refused, saying why. A diary
 * with every entry pre-printed, which is at least punctual.
 */

import type { Answer } from '../agent.ts';
import { loadToilProject, type ToilProjectData } from '../load.ts';
import { buildStandup, daysBetween, rangeProblem, standupMarkdown, standupText } from '../model/standup.ts';
import {
  addDays, buildDay, dayOf, eventsFrom, gapsFor, isDay, isMonth, lineCount, markdownOf, monthOf, runFromAnswer,
  type AgentRun, type Applied, type SyncRun, type WorklogEvent, type WorklogNote, type WorklogPage,
} from '../model/worklog.ts';
import type { Execute } from '../toil.ts';
import { WORKLOG_SAMPLE_DISABLED, WorklogRefusal, type ExportWhat, type WorklogApi, type WorklogDay, type WorklogExport, type WorklogMonth, type WorklogRebuilt, type WorklogStandup } from '../worklog.ts';
import { scriptedAgent } from './agent.ts';
import { FIXTURE_NOW, fixtureExecute } from './execute.ts';

/** How long the sample says its cache keeps things, as a real one does by default. */
const RETENTION = 30;
/** How many days of daily syncs the sample has. */
const SYNC_DAYS = 14;

interface Sample {
  data: ToilProjectData;
  events: WorklogEvent[];
  runs: AgentRun[];
  applied: Record<string, Applied>;
  notes: WorklogNote[];
  syncs: SyncRun[];
}

const at = (day: string, time: string) => `${day}T${time}:00.000Z`;

/** A scripted question from the day before, with its answer and proposals, the first one applied. */
async function sampleRun(toilProject: string, day: string): Promise<{ run: AgentRun; applied: Record<string, Applied> } | null> {
  const agent = scriptedAgent();
  const starters = agent.starters(toilProject);
  let chosen: { label: string; answer: Answer } | null = null;
  for (const s of starters) {
    const answer = await agent.ask(toilProject, s.id);
    if (!chosen || (!chosen.answer.proposals.length && answer.proposals.length)) chosen = { label: s.label, answer };
  }
  if (!chosen) return null;
  const run = runFromAnswer({ id: `sample-${toilProject}-1`, kind: 'ask', toilProject, startedAt: at(day, '15:20'), by: 'the scripted preview', prompt: chosen.label }, at(day, '15:21'), chosen.answer);
  const first = run.proposals.find((p) => p.command);
  return { run, applied: first ? { [first.id]: { state: 'applied', at: at(day, '16:02'), via: 'cli' } } : {} };
}

async function sampleOf(data: ToilProjectData, now: string): Promise<Sample> {
  const today = dayOf(now)!;
  const yesterday = addDays(today, -1);
  const events = eventsFrom({ items: data.items, changes: data.changes });
  const areas = data.sources.map((s) => s.area);
  // A sync every morning for a fortnight; the day before yesterday's first one failed.
  const syncs: SyncRun[] = [];
  for (let n = SYNC_DAYS; n >= 0; n--) {
    const day = addDays(today, -n);
    for (const area of areas) {
      if (n === 2 && area === areas[0]) syncs.push({ area, at: at(day, '06:40'), ok: false, error: 'toil timed out after 120 s waiting for the server.' });
      syncs.push({ area, at: at(day, n === 0 ? '07:55' : '07:00'), ok: true, error: null });
    }
  }
  // The one blocker a sync saw yesterday: the first unfinished item another unfinished one blocks.
  const byId = new Map(data.items.map((i) => [i.id, i]));
  const blocked = data.items.find((i) => i.statusCategory !== 'DONE' && i.links.some((l) => l.type === 'blocks' && l.direction === 'inward' && byId.get(l.target)?.statusCategory !== 'DONE'));
  if (blocked) {
    const by = blocked.links.find((l) => l.type === 'blocks' && l.direction === 'inward' && byId.get(l.target)?.statusCategory !== 'DONE')!.target;
    const blocker = byId.get(by)!;
    const label = (k: string) => k.replace(/^[^/]+\//, '');
    events.push({
      key: `blocker:${blocked.id}:${by}:${at(yesterday, '07:00')}`,
      kind: 'blocker',
      at: at(yesterday, '07:00'),
      subject: blocked.id,
      source: blocked.source.area,
      label: label(blocked.source.key),
      title: blocked.title,
      url: blocked.url,
      by: null,
      text: `blocked by [[${by}]]`,
      cites: [blocked.id, by],
      refs: { [blocked.id]: { label: label(blocked.source.key), url: blocked.url }, [by]: { label: label(blocker.source.key), url: blocker.url } },
      observed: { previousSync: at(addDays(yesterday, -1), '07:00') },
      who: blocked.assignee,
    });
  }
  const scripted = await sampleRun(data.name, yesterday);
  return {
    data,
    events,
    runs: scripted ? [scripted.run] : [],
    applied: scripted?.applied ?? {},
    notes: [{ id: `sample-${data.name}-note`, at: at(yesterday, '17:30'), by: 'Sample person', text: 'Paired on the retry fix; the review is booked for the morning.' }],
    syncs,
  };
}

/** The sample worklog, over the fixture `execute()` and its fixed clock. */
export function fixtureWorklog(execute: Execute = fixtureExecute().execute, now: string = FIXTURE_NOW): WorklogApi {
  const loaded = new Map<string, Promise<Sample>>();
  const sample = (toilProject: string) => {
    if (!loaded.has(toilProject)) loaded.set(toilProject, loadToilProject(execute, toilProject).then((d) => sampleOf(d, now)));
    return loaded.get(toilProject)!.catch((e: unknown) => {
      loaded.delete(toilProject);
      throw new WorklogRefusal(e instanceof Error ? e.message : String(e), 'Pick one of the sample Toil projects.', 404);
    });
  };
  const today = dayOf(now)!;
  const contentDays = (s: Sample) => [...new Set([...s.events.map((e) => dayOf(e.at)!), ...s.runs.map((r) => dayOf(r.startedAt)!), ...s.notes.map((n) => dayOf(n.at)!), ...s.syncs.map((x) => dayOf(x.at)!)])].filter((d) => d <= today).sort();
  const page = (toilProject: string, s: Sample, day: string): WorklogPage => buildDay({ toilProject, day, events: s.events, runs: s.runs, applied: s.applied, notes: s.notes, syncs: s.syncs, now, retentionDays: RETENTION });
  const checkDay = (day: string) => {
    if (!isDay(day)) throw new WorklogRefusal('Name a day as yyyy-mm-dd.', 'Pick one from the calendar.');
    if (day > today) throw new WorklogRefusal(`${day} hasn't happened yet, so it has no page.`, 'Pick today or an earlier day.');
    return day;
  };
  const dayOfSample = async (toilProject: string, day: string): Promise<WorklogDay> => {
    const p = page(toilProject, await sample(toilProject), checkDay(day));
    return { page: p, markdown: markdownOf(p), file: null };
  };
  return {
    disabled: WORKLOG_SAMPLE_DISABLED,
    async month(toilProject, month): Promise<WorklogMonth> {
      const s = await sample(toilProject);
      const wanted = month ?? monthOf(today);
      if (!isMonth(wanted)) throw new WorklogRefusal('Name a month as yyyy-mm.', "Use the calendar's arrows.");
      const all = contentDays(s);
      return {
        toilProject,
        month: wanted,
        today,
        timeZone: 'UTC',
        retentionDays: RETENTION,
        first: all[0] ?? null,
        last: all.at(-1) ?? null,
        days: all.filter((d) => monthOf(d) === wanted).map((day) => ({ day, lines: lineCount(page(toilProject, s, day)), gaps: gapsFor({ day, syncs: s.syncs, now, retentionDays: RETENTION }).length })),
      };
    },
    day: dayOfSample,
    async rebuild(toilProject, day): Promise<WorklogRebuilt> {
      return { ...(await dayOfSample(toilProject, day)), same: null };
    },
    async addNote(): Promise<WorklogDay> {
      throw new WorklogRefusal(WORKLOG_SAMPLE_DISABLED, 'Run toil-ui on your own machine to keep notes.');
    },
    async exportTo(_toilProject: string, _what: ExportWhat): Promise<WorklogExport> {
      throw new WorklogRefusal(WORKLOG_SAMPLE_DISABLED, 'Run toil-ui on your own machine to export a page.');
    },
    async standup(toilProject, from, to): Promise<WorklogStandup> {
      const s = await sample(toilProject);
      const problem = rangeProblem(from, to, today);
      if (problem) throw new WorklogRefusal(problem, 'Pick the days again, ending today or earlier.');
      const asOf = s.syncs.filter((x) => x.ok).map((x) => x.at).sort().at(-1) ?? null;
      const report = buildStandup({ toilProject, from, to, pages: daysBetween(from, to).map((d) => page(toilProject, s, d)), people: s.data.people, items: s.data.items, pullRequests: s.data.pullRequests, asOf, notes: s.data.peopleNotes });
      return { report, markdown: standupMarkdown(report), text: standupText(report) };
    },
  };
}

