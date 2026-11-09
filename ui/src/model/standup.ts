/**
 * The stand-up report (#345): the worklog's days, reshaped for a meeting. A
 * pure fold of a range of worklog pages (src/model/worklog.ts), the toil project's
 * `people` and the picture the latest sync holds, with no model anywhere: the
 * same inputs always give the same report, byte for byte, in Markdown and in
 * plain text.
 *
 * Grouped by person, agents included, each person in four lists:
 *
 * - **Done:** items moved into a done status, pull requests merged or closed.
 * - **In progress:** every other status change, pull requests opened or
 *   reviewed, and an agent's assignment still running.
 * - **Blocked:** a new blocker on an item they hold, a failed build of their
 *   pull request, a pull request of theirs waiting on review for
 *   PICKUP_DAYS working days or more, an agent's assignment that failed or
 *   stopped.
 * - **Next:** current-sprint items assigned to them and not started.
 *
 * The first two lists, and the first two kinds of Blocked, come from the
 * worklog's facts in the range. A review wait and Next are as of the latest
 * sync (`asOf`), said in the report, since no worklog line records them.
 * Who a line belongs to is the fact's `who`: who moved the item, who wrote or
 * reviewed the pull request. The toil project's `people` folds each person's
 * accounts into one name, as the People view does (src/model/people.ts).
 *
 * The team lines come first: the sprint's working days left, scope added to
 * or dropped from a sprint, and builds and deployments that broke or
 * recovered. Everything the worklog says it can't vouch for in the range is
 * said above them. Every line is numbered (F1, F2, ...) in the order the
 * report shows it, so an agent's write-up can say which facts it used. The
 * meeting could have been this document, which is rather the point.
 */

import type { Change, Person, StatusCategory, WorkItem } from '../toil.ts';
import { flows } from './flow.ts';
import { agentsOf, isPerson, personKey, type Identity, type PersonEntry } from './people.ts';
import { PICKUP_DAYS, waitOf } from './prs.ts';
import { health } from './sprint.ts';
import { addDays, cited, dayOf, escapeMd, isDay, link, OUTCOME_TEXT, shortDay, timeOf, type AgentRun, type WorklogEvent, type WorklogPage, type WorklogRef } from './worklog.ts';

/** The longest range one report covers, in days. */
export const MAX_STANDUP_DAYS = 31;

export type Bucket = 'done' | 'progress' | 'blocked' | 'next';
export const BUCKETS: readonly Bucket[] = ['done', 'progress', 'blocked', 'next'];
export const BUCKET_TITLE: Record<Bucket, string> = { done: 'Done', progress: 'In progress', blocked: 'Blocked', next: 'Next' };
/** What an empty list says: Next names the sprint, or says there is none to take it from. */
export const bucketNone = (b: Bucket, sprint: string | null) =>
  b === 'done' ? 'Nothing done.' : b === 'progress' ? 'Nothing in progress.' : b === 'blocked' ? 'Nothing blocked.' : sprint ? `Nothing assigned and not started in ${sprint}.` : 'No current sprint to take it from.';

/** One line of the report: a fact from the worklog, or something as of the latest sync. */
export interface StandupLine {
  /** `F1`, `F2`, ...: its number, in the order the report shows it. */
  fact: string;
  /** Stable for the same fact: the worklog event's key, or what the line is about. */
  key: string;
  /** When it happened; null for a line as of the latest sync. */
  at: string | null;
  /** The UTC day it belongs to: its event's day, or for a line as of the latest sync, null. */
  day: string | null;
  /** What it is about: an OWI item or change id, a build or deployment id, or `run:<id>` for an agent's assignment. */
  subject: string;
  label: string;
  url: string | null;
  /** The subject's title, which may cite other things as `[[id]]`. */
  title: string | null;
  /** The fact in words; may cite other things as `[[id]]`, each in `refs`. */
  text: string;
  refs: Record<string, WorklogRef>;
  /** Every OWI id the line names. */
  cites: string[];
}

export interface StandupGroup {
  /** `person:<name>` for someone the toil project lists, `id:<area>:<id>` for an account it doesn't, `agent:<label>` for an agent it doesn't name, `none` for lines with nobody to give them to. */
  key: string;
  name: string;
  kind: 'human' | 'agent';
  /** Whether the toil project's `people` lists them. */
  mapped: boolean;
  /** For an account the toil project doesn't map: the area and id it has there, which tell two accounts of one name apart. */
  account: { area: string; id: string } | null;
  lines: Record<Bucket, StandupLine[]>;
}

export interface StandupReport {
  toilProject: string;
  from: string;
  to: string;
  timeZone: 'UTC';
  /** The latest good sync: what review waits, the sprint and Next are as of. Null when there is none. */
  asOf: string | null;
  /** The current sprint as of `asOf`, whose items Next lists; null when there is none. */
  sprint: string | null;
  /** What the worklog can't vouch for in the range, each with the days it applies to. */
  gaps: string[];
  team: StandupLine[];
  people: StandupGroup[];
  /** How many lines the report has, team and people together. */
  facts: number;
}

export interface StandupInput {
  toilProject: string;
  from: string;
  to: string;
  /** The worklog page of every day from `from` to `to`, in any order. */
  pages: WorklogPage[];
  /** The toil project's `people` (#292). */
  people: PersonEntry[];
  /** The work items and pull requests the latest sync holds. */
  items: WorkItem[];
  pullRequests: Change[];
  asOf: string | null;
  /** Anything that couldn't be read for the report (the toil project's people), said first among its gaps. */
  notes?: string[];
}

// Ranges --------------------------------------------------------------------------------

/** The last working day (Monday to Friday) before `day`: Friday for a Monday. */
export function lastWorkingDay(day: string): string {
  let d = addDays(day, -1);
  while ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) d = addDays(d, -1);
  return d;
}

/** The default range: since the last working day, through today. */
export const defaultRange = (today: string) => ({ from: lastWorkingDay(today), to: today });

/** Every day from `from` to `to`, both included. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Why a range can't be reported, in words, or null when it can. */
export function rangeProblem(from: unknown, to: unknown, today: string): string | null {
  if (!isDay(from) || !isDay(to)) return 'Name the range as two days, yyyy-mm-dd.';
  if (from > to) return `The range starts (${from}) after it ends (${to}).`;
  if (to > today) return `${to} hasn't happened yet: end the range today (${today}) or earlier.`;
  // Counted by arithmetic, not by listing the days: a range of centuries is refused as fast as one of a week.
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  if (days > MAX_STANDUP_DAYS) return `A stand-up covers at most ${MAX_STANDUP_DAYS} days; ${from} to ${to} is ${days}.`;
  return null;
}

// Who is who ---------------------------------------------------------------------------

const lower = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// Names compared by code, without case, rather than through Intl, whose collation moves with each runtime's ICU data.
const byName = (a: StandupGroup, b: StandupGroup) => (a.key === 'none' ? 1 : b.key === 'none' ? -1 : natural(a.name.toLowerCase(), b.name.toLowerCase()) || natural(a.key, b.key));
const emptyLines = (): Record<Bucket, StandupLine[]> => ({ done: [], progress: [], blocked: [], next: [] });

/** Finds or makes the group a line goes in. */
function grouper(entries: PersonEntry[]) {
  const groups = new Map<string, StandupGroup>();
  for (const e of entries) groups.set(personKey(e.name), { key: personKey(e.name), name: e.name, kind: e.kind, mapped: true, account: null, lines: emptyLines() });
  const make = (key: string, name: string, kind: 'human' | 'agent', account: StandupGroup['account'] = null) => {
    if (!groups.has(key)) groups.set(key, { key, name, kind, mapped: false, account, lines: emptyLines() });
    return groups.get(key)!;
  };
  return {
    groups,
    /** An account's group: the person the toil project maps it to, else one of its own. */
    of(area: string, who: Person | null): StandupGroup {
      if (!who) return make('none', 'Not attributed', 'human');
      const id: Identity = { area, id: who.id, name: who.name, email: who.email };
      const entry = entries.find((e) => isPerson(e, id));
      if (entry) return groups.get(personKey(entry.name))!;
      return make(`id:${area}:${lower(who.id)}`, who.name ?? who.id, 'human', { area, id: who.id });
    },
    entry(e: PersonEntry): StandupGroup {
      return groups.get(personKey(e.name))!;
    },
    agent(label: string): StandupGroup {
      const named = entries.find((e) => e.kind === 'agent' && [e.name, ...Object.values(e.ids)].some((n) => lower(n).length > 1 && lower(label).includes(lower(n))));
      return named ? groups.get(personKey(named.name))! : make(`agent:${label}`, label, 'agent');
    },
  };
}

// The fold -----------------------------------------------------------------------------

type Draft = Omit<StandupLine, 'fact'>;

const fromEvent = (e: WorklogEvent, text = e.text): Draft => ({ key: e.key, at: e.at, day: dayOf(e.at), subject: e.subject, label: e.label, url: e.url, title: e.title || null, text, refs: e.refs, cites: e.cites });

/** The category a status change moved into: recorded on the fact, else read from the item's history. */
function categoryOf(e: WorklogEvent, items: Map<string, WorkItem>): StatusCategory | null {
  if (e.toCategory) return e.toCategory;
  const to = e.text.split(' → ').at(-1);
  // Compared as parsed times: a transition with an unparseable time is skipped, never thrown on.
  const t = items.get(e.subject)?.history?.transitions.find((x) => x.to === to && Date.parse(x.at) === Date.parse(e.at));
  return t?.toCategory ?? null;
}

/** Who a fact belongs to: its `who`, or for a fact recorded before #345, who its line names. */
function whoOf(e: WorklogEvent, items: Map<string, WorkItem>): Person | null {
  if (e.who !== undefined) return e.who;
  if (e.kind === 'blocker' || e.kind === 'blocker-cleared') return items.get(e.subject)?.assignee ?? null;
  return e.by ? { id: e.by, name: e.by, email: null } : null;
}

const time = (l: Draft) => l.at ?? '￿';
/** Keys with their numbers compared as numbers (#7 before #11), by code rather than Intl, whose collation moves with each runtime's ICU data. */
function natural(a: string, b: string): number {
  const x = a.match(/\d+|\D+/g) ?? [];
  const y = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = x[i]!;
    const q = y[i]!;
    if (p === q) continue;
    if (/^\d/.test(p) && /^\d/.test(q)) return Number(p) - Number(q) || (p < q ? -1 : 1);
    return p < q ? -1 : 1;
  }
  return x.length - y.length;
}
const order = (a: Draft, b: Draft) => (time(a) < time(b) ? -1 : time(a) > time(b) ? 1 : natural(a.key, b.key));

/** The stand-up for a range of days: a pure fold of its input. */
export function buildStandup(input: StandupInput): StandupReport {
  const { toilProject, from, to, people: entries, asOf } = input;
  const items = new Map(input.items.map((i) => [i.id, i]));
  const prs = new Map(input.pullRequests.map((c) => [c.id, c]));
  const agents = entries.filter((e) => e.kind === 'agent');
  const pages = input.pages.filter((p) => p.day >= from && p.day <= to).sort((a, b) => (a.day < b.day ? -1 : 1));
  const g = grouper(entries);
  const team: Draft[] = [];
  const drafts = new Map<StandupGroup, Record<Bucket, Draft[]>>();
  const put = (group: StandupGroup, bucket: Bucket, line: Draft) => {
    if (!drafts.has(group)) drafts.set(group, { done: [], progress: [], blocked: [], next: [] });
    drafts.get(group)![bucket].push(line);
  };

  /** A pull request's group: the toil project's agent that wrote it, else its author. */
  const prGroup = (id: string, area: string, who: Person | null): { group: StandupGroup; withAuthor: string | null } => {
    const c = prs.get(id);
    const agent = c ? agentsOf(c, agents)[0] : undefined;
    if (agent && c) {
      const author = c.author && !isPerson(agent, { area: c.source.area, id: c.author.id, name: c.author.name, email: c.author.email }) ? (c.author.name ?? c.author.id) : null;
      return { group: g.entry(agent), withAuthor: author };
    }
    return { group: g.of(c?.source.area ?? area, who), withAuthor: null };
  };

  for (const page of pages) {
    for (const e of [...page.work, ...page.prs, ...page.delivery]) {
      const who = whoOf(e, items);
      switch (e.kind) {
        case 'status':
          put(g.of(e.source, who), categoryOf(e, items) === 'DONE' ? 'done' : 'progress', fromEvent(e));
          break;
        case 'sprint':
          team.push(fromEvent(e, e.by ? `${e.text}, by ${e.by}` : e.text));
          break;
        case 'blocker':
          put(g.of(e.source, who), 'blocked', fromEvent(e));
          break;
        case 'blocker-cleared':
          put(g.of(e.source, who), 'progress', fromEvent(e));
          break;
        case 'pr-opened':
        case 'pr-review':
        case 'pr-merged':
        case 'pr-declined': {
          // A review is the reviewer's news; the rest is the pull request's writer's.
          if (e.kind === 'pr-review') {
            put(g.of(e.source, who), 'progress', fromEvent(e));
            break;
          }
          const { group, withAuthor } = prGroup(e.subject, e.source, who);
          put(group, e.kind === 'pr-opened' ? 'progress' : 'done', fromEvent(e, withAuthor ? `${e.text}, with ${withAuthor}` : e.text));
          break;
        }
        case 'build-failed': {
          const pr = e.cites[0];
          if (pr) put(prGroup(pr, e.source, who).group, 'blocked', fromEvent(e));
          else team.push(fromEvent(e));
          break;
        }
        case 'build-passed':
          break;
        default:
          team.push(fromEvent(e));
      }
    }
    for (const r of page.agents) {
      if (r.run.kind !== 'assignment') continue;
      const bucket: Bucket = r.run.outcome === 'finished' ? 'done' : r.run.outcome === 'running' ? 'progress' : 'blocked';
      put(g.agent(r.run.by), bucket, runLine(r.run));
    }
  }

  // As of the latest sync: review waits, the sprint, and what is next in it.
  let sprint: ReturnType<typeof health> = null;
  if (asOf) {
    for (const c of input.pullRequests) {
      if (c.state !== 'OPEN') continue;
      const wait = waitOf(c, asOf);
      if (wait.on !== 'review' || wait.days === null || wait.days < PICKUP_DAYS) continue;
      const days = Math.round(wait.days * 10) / 10;
      const label = c.id.slice(c.id.indexOf(':') + 1).replace(/^[^/]*\//, '');
      put(prGroup(c.id, c.source.area, c.author).group, 'blocked', { key: `waiting:${c.id}`, at: null, day: null, subject: c.id, label, url: c.url, title: c.title, text: `waiting on review for ${days} working ${days === 1 ? 'day' : 'days'}: ${wait.why}`, refs: { [c.id]: { label, url: c.url } }, cites: [c.id] });
    }
    sprint = health(input.items, [], asOf);
    if (sprint) {
      const { gone, total } = sprint.days;
      const left = Math.max(0, total - gone);
      const done = sprint.done.count;
      team.unshift({ key: `sprint:${sprint.sprint.name}`, at: null, day: null, subject: `sprint:${sprint.sprint.name}`, label: sprint.sprint.name, url: null, title: null, text: `${plural(left, 'working day')} left (day ${Math.min(gone, total)} of ${total}); ${done} of ${plural(sprint.items.length, 'item')} done`, refs: {}, cites: [] });
      for (const item of sprint.items) {
        if (item.statusCategory !== 'TODO' || !flows(item) || !item.assignee) continue;
        const label = item.source.key.replace(/^[^/]+\//, '');
        put(g.of(item.source.area, item.assignee), 'next', { key: `next:${item.id}`, at: null, day: null, subject: item.id, label, url: item.url, title: item.title, text: `${item.status ?? 'not started'}, in ${sprint.sprint.name}`, refs: { [item.id]: { label, url: item.url } }, cites: [item.id] });
      }
    }
  }

  // Number every line in the order the report shows it.
  let n = 0;
  const number = (l: Draft): StandupLine => ({ fact: `F${++n}`, ...l });
  const teamLines = [...team.filter((l) => l.at === null), ...team.filter((l) => l.at !== null).sort(order)].map(number);
  const groups = [...g.groups.values()].filter((x) => x.mapped || drafts.has(x)).sort(byName);
  for (const group of groups) {
    const d = drafts.get(group);
    for (const b of BUCKETS) group.lines[b] = (d?.[b] ?? []).sort(order).map(number);
  }
  return { toilProject, from, to, timeZone: 'UTC', asOf, sprint: sprint?.sprint.name ?? null, gaps: [...(input.notes ?? []), ...gapsOf(pages)], team: teamLines, people: groups, facts: n };
}

function runLine(run: AgentRun): Draft {
  return {
    key: `run:${run.id}`,
    at: run.startedAt,
    day: dayOf(run.startedAt),
    subject: `run:${run.id}`,
    label: 'Assignment',
    url: null,
    title: null,
    text: `"${run.prompt}", ${OUTCOME_TEXT[run.outcome]}${run.error ? `: ${run.error}` : ''}${run.citations.length ? `, citing ${plural(run.citations.length, 'item')}` : ''}`,
    refs: {},
    cites: [],
  };
}

/** Each page's gaps, the same words on several days said once with those days. */
function gapsOf(pages: WorklogPage[]): string[] {
  const days = new Map<string, string[]>();
  for (const p of pages) for (const gap of p.gaps) days.set(gap, [...(days.get(gap) ?? []), p.day]);
  return [...days.entries()].map(([gap, on]) => `${on.length === pages.length && pages.length > 1 ? 'Every day' : on.map(shortDay).join(', ')}: ${gap}`);
}

/** Every line of a report, in its order. */
export const allLines = (r: StandupReport): StandupLine[] => [...r.team, ...r.people.flatMap((p) => BUCKETS.flatMap((b) => p.lines[b]))];

// Text ---------------------------------------------------------------------------------

/** When a line happened, as the report says it: the time, with the day when the range has more than one. */
export function whenText(r: Pick<StandupReport, 'from' | 'to'>, l: Pick<StandupLine, 'at'>): string {
  if (!l.at) return 'as of the latest sync';
  return r.from === r.to ? `${timeOf(l.at)} UTC` : `${shortDay(dayOf(l.at)!)} ${timeOf(l.at)} UTC`;
}

const rangeText = (r: Pick<StandupReport, 'from' | 'to'>) => (r.from === r.to ? shortDay(r.from) : `${shortDay(r.from)} to ${shortDay(r.to)}`);
/** What review waits, the sprint and Next rest on: the latest good sync, or that there hasn't been one. */
const asOfText = (r: StandupReport) =>
  r.asOf ? `Review waits, the sprint and Next are as of the sync at ${shortDay(dayOf(r.asOf)!)} ${timeOf(r.asOf)} UTC.` : 'Review waits, the sprint and Next come from a sync, and none has run yet, so there are none.';

/** A group's heading: its name, the account for one the toil project doesn't map, and whether it is an agent. */
export const groupTitle = (p: StandupGroup) => `${p.name}${p.account && p.account.id !== p.name ? ` (${p.account.area} ${p.account.id})` : p.account ? ` (${p.account.area})` : ''}${p.kind === 'agent' ? ' (agent)' : ''}`;

/** The report's title. */
export const standupTitle = (r: Pick<StandupReport, 'toilProject' | 'from' | 'to'>) => `Stand-up: ${r.toilProject}, ${rangeText(r)}`;

/** What the report is, in a sentence, under its title. */
export const standupLede = (r: StandupReport) =>
  `Built by Toil UI from the worklog, ${rangeText(r)}, times in UTC: facts only, each linked to its source. ${asOfText(r)}`;

function mdLine(r: StandupReport, l: StandupLine): string {
  const subject = l.subject.startsWith('run:') ? escapeMd(l.label) : link({ label: l.label, url: l.url });
  const title = l.title ? ` ${cited(l.title, l.refs)}` : '';
  return `- ${subject}${title}: ${cited(l.text, l.refs)} (${whenText(r, l)})`;
}

/** The report as Markdown, ready for Slack, Teams or a page: deterministic, so the same report always gives the same text. */
export function standupMarkdown(r: StandupReport): string {
  const out = [`# ${escapeMd(standupTitle(r))}`, '', escapeMd(standupLede(r)), ''];
  if (r.gaps.length) {
    out.push('## Coverage', '');
    for (const gap of r.gaps) out.push(`- ${escapeMd(gap)}`);
    out.push('');
  }
  out.push('## Team', '');
  if (r.team.length) for (const l of r.team) out.push(mdLine(r, l));
  else out.push('No sprint, scope changes, or builds and deployments that broke or recovered.');
  out.push('');
  for (const p of r.people) {
    out.push(`## ${escapeMd(groupTitle(p))}${p.mapped || p.key === 'none' ? '' : ", not in the Toil project's people"}`, '');
    for (const b of BUCKETS) {
      out.push(`**${BUCKET_TITLE[b]}**`, '');
      if (p.lines[b].length) for (const l of p.lines[b]) out.push(mdLine(r, l));
      else out.push(bucketNone(b, r.sprint));
      out.push('');
    }
  }
  return out.join('\n');
}

/** `[[id]]` citations as their labels, for plain text. */
/** Text from a tracker on one line, as a list item needs it: a title with a line break would otherwise start a line of its own. */
const flat = (text: string) => text.replace(/\s*\r?\n\s*/g, ' ');
const plainCited = (text: string, refs: Record<string, WorklogRef>) => flat(text.replace(/\[\[([^\]]+)\]\]/g, (_, id: string) => refs[id]?.label ?? id));

function plainLine(r: StandupReport, l: StandupLine): string {
  const title = l.title ? ` ${plainCited(l.title, l.refs)}` : '';
  return `- ${flat(l.label)}${title}: ${plainCited(l.text, l.refs)} (${whenText(r, l)})${l.url ? ` ${l.url}` : ''}`;
}

/** The report as plain text, for a chat that doesn't render Markdown. */
export function standupText(r: StandupReport): string {
  const out = [standupTitle(r), '', standupLede(r), ''];
  if (r.gaps.length) out.push('Coverage', ...r.gaps.map((gap) => `- ${flat(gap)}`), '');
  out.push('Team', ...(r.team.length ? r.team.map((l) => plainLine(r, l)) : ['No sprint, scope changes, or builds and deployments that broke or recovered.']), '');
  for (const p of r.people) {
    out.push(`${flat(groupTitle(p))}${p.mapped || p.key === 'none' ? '' : ", not in the Toil project's people"}`);
    for (const b of BUCKETS) out.push(`${BUCKET_TITLE[b]}:`, ...(p.lines[b].length ? p.lines[b].map((l) => plainLine(r, l)) : [`- ${bucketNone(b, r.sprint)}`]));
    out.push('');
  }
  return out.join('\n');
}

/** The question the Stand-up's "Write it up" sends (server/agents/prompts.ts turns it into the instructions). */
export const standupWriteUp = (from: string, to: string) => `Write up the stand-up for ${from}${to === from ? '' : ` to ${to}`}`;

/** The fact numbers a write-up names, `(F3)` or `F3, F7`, in order of first mention, among those the report has. */
export function factsCited(text: string, report: StandupReport): string[] {
  const known = new Set(allLines(report).map((l) => l.fact));
  const seen = new Set<string>();
  for (const m of text.matchAll(/\bF(\d+)\b/g)) if (known.has(`F${m[1]}`)) seen.add(`F${m[1]}`);
  return [...seen];
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** The range in plain words for the Summary's card: "Yesterday", "Since Friday (9 Oct 2026)", or the dates when it isn't the default range. */
export function sinceText(r: Pick<StandupReport, 'from' | 'to'>, today: string): string {
  if (r.to !== today) return rangeText(r);
  if (r.from === today) return 'Today';
  if (r.from === addDays(today, -1)) return 'Yesterday';
  return `Since ${WEEKDAY_NAMES[new Date(`${r.from}T00:00:00Z`).getUTCDay()]} (${shortDay(r.from)})`;
}
