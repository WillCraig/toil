/**
 * The Summary tab's answer (#552): one sentence on the sprint, one on why, and
 * at most three things that need attention, all worked out here by code from
 * the models the rest of Toil UI reads (briefing, sprint health, blockers,
 * pull requests, readiness), so the tab and the full briefing below it can
 * never disagree. Items are named by their titles in quotes; a ticket key is
 * small print on a card and never in the sentences. No model is asked
 * anything. A status report that has read its own footnotes.
 *
 * Words that name a toil concept (a pull request) are chosen here, once, from
 * `Ctx.plain`; an item's title and the briefing's own sentences are quoted as
 * they are, never reworded. People are named where they own something and
 * never ranked.
 */

import { commandCenterHref, toilProjectHref, peekHref, prName, prsHref, shortKey, sourceLabel } from '../format.ts';
import { PANEL_WORDS } from '../guided-questions.ts';
import type { ToilProjectData, Panel } from '../load.ts';
import type { BriefingView } from './briefing.ts';
import { behindAll, blockerOrder, heldBy } from './blockers.ts';
import { flows } from './flow.ts';
import type { Prepared } from './insights.ts';
import { isPerson } from './people.ts';
import { PICKUP_DAYS, openQueue, type OpenRow } from './prs.ts';
import { readiness, type Readiness } from './readiness.ts';
import { daysLeft, type Health } from './sprint.ts';
import { AT_RISK_FROM, statusOf, type Status } from './status.ts';
import type { Change, Person, WorkItem } from '../toil.ts';

// Words -----------------------------------------------------------------------------------

const round1 = (n: number) => Math.round(n * 10) / 10;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pts = (n: number) => plural(round1(n), 'point');
const q = (s: string) => `“${s}”`;
const points = (i: WorkItem) => (i.estimate?.unit === 'points' ? i.estimate.value : 0);
const isDone = (i: WorkItem) => i.statusCategory === 'DONE';
const nameOf = (p: Person | null | undefined) => (p ? (p.name ?? p.id) : null);
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const list = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** The services a toil project reads, in the order a team would say them: where the work is tracked, then the code, then builds, then where it runs. */
const SOURCE_ORDER = ['jira', 'ado', 'github', 'bitbucket', 'jenkins', 'openshift'];
const sourceRank = (family: string) => (SOURCE_ORDER.includes(family) ? SOURCE_ORDER.indexOf(family) : SOURCE_ORDER.length);
export function sourcesText(d: Pick<ToilProjectData, 'sources'>): string {
  const families = [...new Set(d.sources.map((s) => s.area.split('-')[0]!))].sort((a, b) => sourceRank(a) - sourceRank(b));
  return list(families.map(sourceLabel));
}

// What the sentences and cards are computed from -------------------------------------------

export interface Ctx {
  d: ToilProjectData;
  name: string;
  now: string;
  byId: Map<string, WorkItem>;
  prById: Map<string, Change>;
  h: Health | null;
  view: BriefingView;
  queue: OpenRow[];
  held: Map<string, string[]>;
  ready: Map<string, Readiness>;
  /** Plain words are on: a pull request is a code review. Only the words this module writes follow it. */
  plain: boolean;
}

const reviewWord = (c: Ctx) => (c.plain ? 'code review' : 'pull request');

export function contextOf(input: { d: ToilProjectData; now: string; byId: Map<string, WorkItem>; h: Health | null; p: Prepared; view: BriefingView; plain?: boolean }): Ctx {
  const { d, now, byId } = input;
  const prs = d.pullRequests ?? [];
  return {
    d,
    name: d.name,
    now,
    byId,
    h: input.h,
    view: input.view,
    plain: input.plain ?? false,
    prById: new Map(prs.map((c) => [c.id, c])),
    queue: openQueue(prs, byId, now),
    held: heldBy(input.p),
    ready: new Map(d.items.map((i) => [i.id, readiness({ item: i, settings: d.readiness, byId })])),
  };
}

/** The open stories that wait behind an item, directly or down a chain, and their points: worked out from the blockers model, so it holds whichever briefing is on screen. */
function holdsOf(c: Ctx, id: string): { items: number; points: number } {
  const waiting = [...behindAll(c.held, id)].map((x) => c.byId.get(x)).filter((i): i is WorkItem => !!i && !isDone(i));
  return { items: waiting.length, points: waiting.reduce((n, i) => n + points(i), 0) };
}

/** A person as the toil project's `people` names them ("Ada D."), else as the tracker does: a GitHub login is not a name anyone says out loud. */
function personIn(c: Ctx, p: Person | null | undefined, area: string): Person | null {
  if (!p) return null;
  const entry = (c.d.people ?? []).find((e) => isPerson(e, { area, id: p.id, name: p.name, email: p.email }));
  return entry ? { ...p, name: entry.name } : p;
}

/** A citation `[[id]]` as words: the item's title in quotes, or the pull request's short name. */
function plainCites(text: string, c: Ctx): string {
  return text.replace(/\[\[([^\]]+)\]\]/g, (_m, id: string) => {
    const i = c.byId.get(id);
    if (i) return q(i.title);
    return c.prById.has(id) ? `the ${reviewWord(c)} ${prName(id)}` : id;
  });
}

const itemHref = (c: Ctx, id: string) => peekHref(toilProjectHref(c.name), id);
const keyOf = (i: WorkItem) => `${sourceLabel(i.source.area)} ${shortKey(i)}`;
/** A pull request's title without the ticket key its author put in front. */
const stripKey = (t: string) => t.replace(/^[A-Z][A-Z0-9]*-\d+[:\s]+/, '');
/** What a pull request is about, in words: the title of the work item it names, else its own title. */
function aboutPr(c: Ctx, id: string): string {
  const change = c.prById.get(id);
  const item = change?.workItems.map((w) => c.byId.get(w)).find((i) => i);
  return q(item?.title ?? stripKey(change?.title ?? id));
}

// The answer ------------------------------------------------------------------------------

export interface Answer {
  status: Status;
  /** The status word, "Behind". */
  word: string;
  /** The rest of the sentence, which follows "Behind: ". */
  sentence: string;
  /** One smaller sentence on why, from the briefing's top reason. */
  why: string;
  /** What it was worked out from, line by line, one step in. */
  how: string[];
  /** Says the status word is an estimate, or that it is too early for a pace. */
  basis: string | null;
  /** The sentence says it all: the headline is the sentence alone, with no "Word:" in front. */
  bare?: boolean;
}

/** The panels whose read failed, in words: an all-clear that skipped them would be claiming what it didn't check. */
export function failedReads(c: Pick<Ctx, 'd' | 'plain'>): string[] {
  return (Object.keys(c.d.calls ?? {}) as Panel[]).filter((p) => c.d.calls[p]?.some((x) => !x.ok)).map((p) => (c.plain ? PANEL_WORDS[p].replace('pull requests', 'code reviews') : PANEL_WORDS[p]));
}

const unread = (failed: string[]) => `${cap(list(failed))} could not be read, so there may be problems this does not show.`;

function whyOf(c: Ctx, status: Status): string {
  const top = c.view.reasons[0];
  const failed = failedReads(c);
  if (!top && failed.length) return unread(failed);
  if (!top) return status === 'on-track' ? 'Nothing is blocked, failing its tests or waiting too long.' : 'No single cause stands out.';
  const first = c.byId.get(top.items[0]?.id ?? '');
  const title = first ? q(first.title) : 'one item';
  const holds = first ? holdsOf(c, first.id) : null;
  const behind = holds && holds.items > 0 ? `, and ${plural(holds.items, 'story', 'stories')} (${pts(holds.points)}) ${holds.items === 1 ? 'waits' : 'wait'} behind it` : '';
  switch (top.lens) {
    case 'failing':
      return `Mostly because the tests for ${title} are failing${behind}.`;
    case 'blocked':
      return `Mostly because ${plural(top.items.length, 'story', 'stories')} can’t move until another story is finished.`;
    case 'waiting':
      return `Mostly because ${plural(top.items.length, reviewWord(c))} ${top.items.length === 1 ? 'has' : 'have'} waited past ${PICKUP_DAYS} working days for a first review.`;
    case 'sprint':
      return c.view.code.sprint ? `Mostly because only ${pts(c.view.code.sprint.points.done)} ${c.view.code.sprint.points.done === 1 ? 'is' : 'are'} done so far, and the pace is too slow to finish the rest.` : `${top.label}: ${plainCites(top.line, c)}.`;
    case 'stale':
      return `Mostly because ${plural(top.items.length, 'item')} in progress ${top.items.length === 1 ? 'has' : 'have'} had no update for days.`;
    case 'load':
      return 'Mostly because someone has more in progress than the team’s limit.';
    case 'drift':
      return `Mostly because a ticket and its ${reviewWord(c)} disagree about whether the work is done.`;
    default:
      return `${top.label}: ${plainCites(top.line, c)}.`;
  }
}

export function answerOf(c: Ctx): Answer {
  const s = c.view.code.sprint;
  const h = c.h;
  if (!s || !h) {
    return { status: 'none', word: 'No sprint', sentence: 'No sprint is running right now.', why: 'No sprint with dates was found, so there is nothing to measure the work against.', how: [`Sprints are read from ${sourcesText(c.d)}.`], basis: null, bare: true };
  }
  if (s.points.total === 0) {
    // Nothing is estimated, so "all 0 points are done" would be a claim with nothing under it.
    const n = h.items.length;
    return {
      status: 'none',
      word: 'No estimates',
      sentence: n === 0 ? 'the sprint has no stories yet, so there is no progress to measure.' : `${plural(n, 'story', 'stories')} in the sprint ${n === 1 ? 'has' : 'have'} no points, so progress can’t be measured.`,
      why: 'Add points to the stories and this reads the pace against them.',
      how: [`Points come from ${sourcesText(c.d)}. This sprint has none to add up.`],
      basis: 'A status needs points to measure against',
    };
  }
  const left = s.points.left;
  const days = daysLeft(h.days);
  const result = statusOf({ sprint: { left, projected: s.projected }, red: c.view.reasons.some((r) => r.severity === 'danger') });
  const remain = days === 0 ? 'no working days remain' : `${plural(days, 'working day')} ${days === 1 ? 'remains' : 'remain'}`;
  const sentence = left <= 0 ? `all ${pts(s.points.total)} in the sprint are done.` : `${left} of ${s.points.total} points are left, and ${remain}.`;
  const skipped = h.unestimated.length;
  const pct = Math.round(AT_RISK_FROM * 100);
  return {
    status: result.status,
    word: result.word,
    sentence,
    why: whyOf(c, result.status),
    how: [
      ...(left > 0 && !result.early ? ['The status word is an estimate from the pace so far.'] : []),
      `${pts(s.points.done)} done out of ${s.points.total} after ${h.days.gone} of ${h.days.total} working days${s.pace !== null ? `, about ${s.pace} a day` : ''}. Working days left do not count today.`,
      s.projected === null ? 'It is too early to read a pace: that needs a quarter of the sprint to have passed.' : `At that pace about ${round1(s.projected)} of the ${left} points left would be done by the end. That is an estimate, not a promise.`,
      `The ${pct}% line is the app’s own rule of thumb, not a standard.`,
      `On track means the points left should fit at that pace. At risk means at least ${pct}% of them should, or something red is holding work up. Behind means fewer than ${pct}%.`,
      ...(skipped ? [`${plural(skipped, 'story', 'stories')} with no estimate ${skipped === 1 ? 'is' : 'are'} left out of these points.`] : []),
      `Points and dates come from ${sourcesText(c.d)}.`,
    ],
    basis: left > 0 && result.early ? 'Too early in the sprint to judge a pace' : null,
  };
}

// Cards -----------------------------------------------------------------------------------

export type Tone = 'danger' | 'warn' | 'ok';

/** Someone or something a card names, in words first: the key is small and secondary. */
export interface Named {
  text: string;
  meta?: string;
  key?: string;
}

export interface Card {
  id: 'risk' | 'blocked' | 'review' | 'ready' | 'clear';
  kicker: string;
  title: string;
  /** The ticket key, small print after the title, when the card is about one item. */
  key: string | null;
  why: string;
  named: Named[];
  /** "and 2 more", when the card names fewer than it counts. */
  more?: string;
  /** Exactly one way in to the thing; null on an all-clear card. */
  action: { label: string; href: string; item?: string } | null;
  tone: Tone;
}

const holdText = (h: { items: number; points: number } | undefined) => (h && h.items > 0 ? ` ${plural(h.items, 'other story', 'other stories')} (${pts(h.points)}) ${h.items === 1 ? 'waits' : 'wait'} behind it.` : '');

/** The biggest risk: the briefing's top reason, its first item and what waits behind it. */
/** The first reason, and in it the first item that is still open: a story already finished is no risk to anything. */
function riskPick(c: Ctx) {
  const top = c.view.reasons[0];
  for (const first of top?.items ?? []) {
    const item = c.byId.get(first.id);
    if (item && !isDone(item)) return { top: top!, first, item };
  }
  return null;
}

function riskCard(c: Ctx): Card | null {
  const pick = riskPick(c);
  if (!pick) return null;
  const { top, first, item } = pick;
  const row = c.queue.find((r) => r.items.includes(item.id));
  const waited = row?.wait.days ?? null;
  const why =
    top.lens === 'failing'
      ? `Its tests are failing.${holdText(holdsOf(c, item.id))}`
      : top.lens === 'blocked'
        ? `It can’t move until another story is finished.${holdText(holdsOf(c, item.id))}`
        : top.lens === 'waiting' && waited !== null
          ? `Its ${reviewWord(c)} has waited ${plural(Math.round(waited), 'working day')} for a first review.`
          : plainCites(first.why, c);
  const owner = nameOf(personIn(c, item.assignee, item.source.area));
  return {
    id: 'risk',
    // With no sprint running there is nothing for it to be a risk to.
    kicker: c.view.code.sprint ? 'Biggest risk to the sprint' : 'Biggest risk right now',
    title: item.title,
    key: keyOf(item),
    why,
    named: [{ text: owner ? `Owned by ${owner}` : 'Nobody owns it yet' }],
    action: { label: 'Open', href: itemHref(c, item.id), item: item.id },
    tone: 'danger',
  };
}

/** Stories that can't start: the blocker holding up the most, and what waits on it. `covered` is the item another card already covers: one story, one card, so a chain that holds it up is left to that card. */
function blockedCard(c: Ctx, covered: string | null): Card | null {
  const head = blockerOrder(c.held).find(([id]) => id !== covered);
  if (!head) return null;
  const [headId] = head;
  const blocker = c.byId.get(headId);
  const waiting = [...behindAll(c.held, headId)].map((id) => c.byId.get(id)).filter((i): i is WorkItem => !!i && !isDone(i));
  if (!blocker || !waiting.length || waiting.some((i) => i.id === covered)) return null;
  const total = waiting.reduce((n, i) => n + points(i), 0);
  const first = waiting[0]!;
  const owner = nameOf(personIn(c, blocker.assignee, blocker.source.area));
  return {
    id: 'blocked',
    kicker: 'Stories that can’t start',
    title: waiting.length === 1 ? `${q(first.title)} can’t start yet` : `${waiting.length} stories can’t start yet`,
    key: waiting.length === 1 ? keyOf(first) : null,
    why: `${waiting.length === 1 ? 'It waits' : 'They wait'} on ${q(blocker.title)}, which is still ${(blocker.status ?? 'open').toLowerCase()}. Together ${waiting.length === 1 ? 'it is' : 'they are'} ${pts(total)}.`,
    named: [{ text: owner ? `Waiting on ${owner}` : 'Waiting on nobody yet', meta: blocker.title }],
    action: { label: 'Open', href: itemHref(c, blocker.id), item: blocker.id },
    tone: 'warn',
  };
}

/** The oldest code review waiting for a first look, past the working days the team's rule allows. */
function reviewCard(c: Ctx, covered: Set<string> = new Set()): Card | null {
  // A review of work another card already tells is that card's story, not a second one.
  const late = c.queue.filter((r) => r.wait.on === 'review' && (r.wait.days ?? 0) > PICKUP_DAYS && !r.items.some((id) => covered.has(id)));
  if (!late.length) return null;
  const r = late[0]!;
  const days = Math.round(r.wait.days ?? 0);
  const extra = r.flags.some((f) => f.flag === 'conflict') ? ' It also has a merge conflict.' : r.flags.some((f) => f.flag === 'failing-checks') ? ' Its checks are failing too.' : '';
  const n = late.length;
  const author = nameOf(personIn(c, r.change.author, r.change.source.area));
  return {
    id: 'review',
    kicker: 'Waiting on a code review',
    title: n === 1 ? `The ${reviewWord(c)} for ${aboutPr(c, r.change.id)} has waited ${plural(days, 'working day')}` : `${n} ${reviewWord(c)}s have waited over ${PICKUP_DAYS} working days`,
    key: n === 1 ? `${sourceLabel(r.change.source.area)} ${prName(r.change.id)}` : null,
    why: `${cap(r.wait.why)}.${extra}${n > 1 ? ` The longest wait is ${aboutPr(c, r.change.id)}.` : ''}`,
    named: [{ text: author ? `Opened by ${author}` : 'Author unknown' }],
    action: { label: 'See the queue', href: prsHref(c.name) },
    tone: 'warn',
  };
}

/** The fallback when one of the three is empty: stories that wait to start but aren't ready to. */
function notReadyCard(c: Ctx, covered: Set<string> = new Set()): Card | null {
  const items = (c.h?.items ?? []).filter((i) => i.statusCategory === 'TODO' && flows(i) && !covered.has(i.id));
  const rows = items.map((i) => ({ i, r: c.ready.get(i.id)! })).filter((x) => x.r && x.r.verdict !== 'ready');
  if (!rows.length) return null;
  const count = (check: string) => rows.filter((x) => x.r.why.some((w) => w.check === check)).length;
  const need = count('description');
  const crit = count('acceptance');
  const wait = count('blockers');
  const n = rows.length;
  const why =
    n === 1
      ? `It ${list([need ? 'needs a fuller description' : '', crit ? 'needs a “done when” checklist' : '', wait ? 'is waiting on another story' : ''].filter(Boolean))}.`
      : `${list([need ? `${need} ${need === 1 ? 'needs' : 'need'} a fuller description` : '', crit ? `${crit} ${crit === 1 ? 'needs' : 'need'} a “done when” checklist` : '', wait ? `${wait} ${wait === 1 ? 'waits' : 'wait'} on another story` : ''].filter(Boolean))}.`;
  const first = rows[0]!.i;
  return {
    id: 'ready',
    kicker: 'Not ready to start',
    title: n === 1 ? `${q(first.title)} isn’t ready to start` : `${n} stories aren’t ready to start`,
    key: n === 1 ? keyOf(first) : null,
    why,
    named: n === 1 ? [] : rows.slice(0, 2).map((x) => ({ text: x.i.title, meta: nameOf(personIn(c, x.i.assignee, x.i.source.area)) ?? 'Nobody assigned', key: keyOf(x.i) })),
    more: n > 2 ? `and ${n - 2} more` : undefined,
    action: { label: 'See what is ready', href: commandCenterHref(c.name) },
    tone: 'warn',
  };
}

export const ALL_CLEAR: Card = {
  id: 'clear',
  kicker: 'All clear',
  title: 'Nothing needs attention right now',
  key: null,
  why: 'No risk stands out, no story is waiting on another, no code review has waited too long, and every story waiting to start is ready.',
  named: [],
  action: null,
  tone: 'ok',
};

/** In place of the all-clear when a read failed: nothing is flagged, but not everything was looked at. */
function unreadCard(failed: string[]): Card {
  return { id: 'clear', kicker: 'Some reads failed', title: 'Nothing is flagged, but not everything could be read', key: null, why: unread(failed), named: [], action: null, tone: 'warn' };
}

/**
 * Which cards show, at most three, the same for everyone: the biggest risk,
 * stories that can't start, the oldest waiting code review, in that order;
 * when any of them is empty, stories not ready to start take the free place
 * (once); and when nothing at all is there, the all-clear card. Never invents
 * work to fill the row.
 */
export function pickCards(found: { risk: Card | null; blocked: Card | null; review: Card | null; ready: Card | null }, failed: string[] = []): Card[] {
  const cards = [found.risk, found.blocked, found.review].filter((x): x is Card => !!x);
  if (cards.length < 3 && found.ready) cards.push(found.ready);
  return cards.length ? cards : [failed.length ? unreadCard(failed) : ALL_CLEAR];
}

export function cardsOf(c: Ctx): Card[] {
  const risk = riskCard(c);
  const riskId = risk ? (riskPick(c)?.item.id ?? null) : null;
  const blocked = blockedCard(c, riskId);
  // One story, one card: what an earlier card already names is left out of the later ones.
  const covered = new Set<string>(riskId ? [riskId] : []);
  if (blocked?.action?.item) {
    covered.add(blocked.action.item);
    for (const id of behindAll(c.held, blocked.action.item)) covered.add(id);
  }
  const review = reviewCard(c, covered);
  return pickCards({ risk, blocked, review, ready: notReadyCard(c, covered) }, failedReads(c));
}
