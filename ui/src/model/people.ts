/**
 * The People view (#292): what is on each person's plate, agents included,
 * across every system the toil project reads. Pure functions of the toil project's
 * `people` list, its OWI work items, its OWI changes and a clock, like
 * prs.ts, so the view and the agent's people tools work it out the same way.
 *
 * Who someone is comes from the toil project: each person's `ids` names the
 * account each area knows them by, matched on the account's id or email,
 * without case. An agent is a person with kind `agent`; it is matched by the
 * same signals that set a change's `authorKind` (an agent's account, a
 * Co-Authored-By trailer, a branch prefix) where the signal names it.
 * Accounts the toil project doesn't map get cards of their own, and an email they
 * share with a person, or with an account in another system, is offered as a
 * suggestion, never applied: one email on two accounts is how the wrong
 * person gets someone else's work, so a match is suggested only when there
 * is exactly one candidate.
 *
 * It shows load, never a score: cards are in name order, nothing is ranked,
 * and no figure compares one person with another. The limit a team sets in
 * the toil project is the only line anyone is measured against, and only their
 * own count of work in progress meets it. The seating plan is alphabetical,
 * which ended the meeting about the seating plan.
 */

import type { Change, Person, WorkItem } from '../toil.ts';
import { flows } from './flow.ts';
import { waitOf, workingDays, type Wait } from './prs.ts';
import { health } from './sprint.ts';

const DAY = 86_400_000;
/** How far back recent activity looks, in calendar days. */
export const ACTIVITY_DAYS = 14;
/** The most activity lines one card shows; the rest are counted. */
export const MAX_ACTIVITY = 8;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const lower = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

// Who is who ---------------------------------------------------------------------------

/** One entry of the toil project's `people` list, as the view reads it. */
export interface PersonEntry {
  name: string;
  kind: 'human' | 'agent';
  email: string | null;
  /** Area to the identity that area knows them by. */
  ids: Record<string, string>;
}

/** The toil project's `people` and `wipLimit`, read from `projects show`, with anything that couldn't be used said in `notes`. */
export function readPeople(toilProject: unknown): { people: PersonEntry[]; wipLimit: number | null; notes: string[] } {
  const d = isRec(toilProject) ? toilProject : {};
  const notes: string[] = [];
  const people: PersonEntry[] = [];
  if (d.people !== undefined && !Array.isArray(d.people)) notes.push('The Toil project\'s "people" isn\'t a list, so nobody is mapped.');
  for (const [i, raw] of (Array.isArray(d.people) ? d.people : []).entries()) {
    if (!isRec(raw) || typeof raw.name !== 'string' || !raw.name.trim()) {
      notes.push(`people[${i}] has no name, so it was left out.`);
      continue;
    }
    const ids = Object.fromEntries(Object.entries(isRec(raw.ids) ? raw.ids : {}).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].trim() !== '').map(([a, v]) => [a, v.trim()]));
    people.push({ name: raw.name.trim(), kind: raw.kind === 'agent' ? 'agent' : 'human', email: typeof raw.email === 'string' ? raw.email : null, ids });
  }
  const limit = d.wipLimit;
  const wipLimit = typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? limit : null;
  if (limit !== undefined && wipLimit === null) notes.push('The Toil project\'s "wipLimit" isn\'t a whole number above 0, so no limit is shown.');
  return { people, wipLimit, notes };
}

/** An account in one system, as the work items and pull requests name it. */
export interface Identity {
  area: string;
  id: string;
  name: string | null;
  email: string | null;
}

const identityKey = (area: string, id: string) => `${area}\u0000${lower(id)}`;
const keyOf = (i: Identity) => identityKey(i.area, i.id);

/** The identity a person has in an area: their entry for that area. */
function idIn(person: PersonEntry, area: string): string | undefined {
  return person.ids[area];
}

/** Whether a person is this account: their identity for its area is the account's id or its email. */
export function isPerson(person: PersonEntry, who: Identity): boolean {
  const id = idIn(person, who.area);
  return id !== undefined && (lower(id) === lower(who.id) || (who.email !== null && lower(id) === lower(who.email)));
}

/** Someone a card is about: a person in the toil project, or an account it doesn't map. */
export interface Who {
  /** `person:<name>` or `id:<area>:<id>`: what the board filter and the agent's tools name them by. */
  key: string;
  name: string;
  kind: 'human' | 'agent';
  mapped: boolean;
  /** The accounts seen for them, plus, for a person, the ids the toil project gives that no data has shown yet. */
  identities: Identity[];
  email: string | null;
}

export const personKey = (name: string) => `person:${name}`;
export const identityWhoKey = (i: Pick<Identity, 'area' | 'id'>) => `id:${i.area}:${i.id}`;

/** A matcher for one card's subject: does this account belong to them? */
type Matcher = (i: Identity) => boolean;

// The data, by account ------------------------------------------------------------------

const asIdentity = (area: string, p: Person | null): Identity | null => (p ? { area, id: p.id, name: p.name, email: p.email } : null);

/** Every account the data names, by key, with the best name and email seen for it. */
function accounts(items: WorkItem[], changes: Change[]): Map<string, Identity> {
  const out = new Map<string, Identity>();
  const add = (i: Identity | null) => {
    if (!i) return;
    const k = keyOf(i);
    const had = out.get(k);
    out.set(k, had ? { ...had, name: had.name ?? i.name, email: had.email ?? i.email } : i);
  };
  for (const item of items) {
    add(asIdentity(item.source.area, item.assignee));
    for (const t of item.history?.transitions ?? []) add(asIdentity(item.source.area, t.by));
  }
  for (const c of changes) {
    add(asIdentity(c.source.area, c.author));
    for (const r of c.reviewers) add(asIdentity(c.source.area, r.person));
    for (const r of c.reviews ?? []) add(asIdentity(c.source.area, r.by));
  }
  return out;
}

// One card --------------------------------------------------------------------------------

export interface WipItem {
  item: WorkItem;
  /** When it came into the status it is in now, or null when no move into it was recorded. */
  since: string | null;
  /** Calendar days in that status, or null. */
  days: number | null;
}

export interface OpenPr {
  change: Change;
  wait: Wait;
  /** For a person's own pull request written with an agent: the agent, in the signal's words. */
  withAgent: string | null;
}

export interface ReviewWait {
  change: Change;
  /** Working days since it was opened: when the review was asked for isn't recorded, so this is the longest it can have waited. */
  days: number | null;
}

export interface Blocked {
  item: WorkItem;
  /** What blocks it: each blocker's id, and its record when the toil project holds it (else its status is unknown). */
  by: Array<{ id: string; item: WorkItem | null }>;
}

export type Activity =
  | { kind: 'moved'; at: string; item: WorkItem; from: string | null; to: string }
  | { kind: 'merged'; at: string; change: Change }
  | { kind: 'reviewed'; at: string; change: Change; state: string };

export interface Card {
  who: Who;
  /** Work in progress by status, each status's items longest-sitting first. */
  wip: Array<{ status: string; items: WipItem[] }>;
  wipCount: number;
  /** Over the toil project's limit; null when it sets none. */
  overLimit: boolean | null;
  prs: OpenPr[];
  reviews: ReviewWait[];
  blocked: Blocked[];
  /** Newest first, at most MAX_ACTIVITY. */
  activity: Activity[];
  /** How many more there were in the window. */
  moreActivity: number;
}

const isOpen = (c: Change) => c.state === 'OPEN' || c.state === 'DRAFT';
const isDone = (i: WorkItem) => i.statusCategory === 'DONE';
const round1 = (n: number) => Math.round(n * 10) / 10;

/** When an item came into the status it is in now: its last recorded move into that status, else into its category. */
export function sinceInStatus(item: WorkItem): string | null {
  const moves = [...(item.history?.transitions ?? [])].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const into = moves.filter((t) => item.status !== null && lower(t.to) === lower(item.status)).at(-1) ?? moves.filter((t) => t.toCategory === item.statusCategory && t.fromCategory !== item.statusCategory).at(-1);
  return into?.at ?? null;
}

/** The agents a change was written with, among the toil project's agents: its author's account is one, or its authorKind signal names one. */
export function agentsOf(c: Change, agents: PersonEntry[]): PersonEntry[] {
  if (c.authorKind !== 'AGENT') return [];
  const author = asIdentity(c.source.area, c.author);
  const signal = lower(c.authorKindSignal);
  return agents.filter((a) => (author && isPerson(a, author)) || [a.name, ...Object.values(a.ids)].some((n) => lower(n).length > 1 && signal.includes(lower(n))));
}

function cardFor(who: Who, match: Matcher, agent: PersonEntry | null, data: { items: WorkItem[]; changes: Change[]; byId: Map<string, WorkItem>; now: string; wipLimit: number | null; agents: PersonEntry[] }): Card {
  const { items, changes, byId, now } = data;
  const mine = (area: string, p: Person | null) => {
    const i = asIdentity(area, p);
    return i !== null && match(i);
  };
  const assigned = items.filter((i) => mine(i.source.area, i.assignee));

  const wipItems = assigned.filter((i) => i.statusCategory === 'IN_PROGRESS' && flows(i)).map((item): WipItem => {
    const since = sinceInStatus(item);
    return { item, since, days: since ? round1((Date.parse(now) - Date.parse(since)) / DAY) : null };
  });
  const byStatus = new Map<string, WipItem[]>();
  for (const w of wipItems) byStatus.set(w.item.status ?? 'In progress', [...(byStatus.get(w.item.status ?? 'In progress') ?? []), w]);
  const wip = [...byStatus.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, list]) => ({ status, items: list.sort((a, b) => (b.days ?? -1) - (a.days ?? -1) || a.item.id.localeCompare(b.item.id)) }));

  const written = (c: Change) => mine(c.source.area, c.author) || (agent !== null && agentsOf(c, [agent]).length > 0);
  const prs = changes
    .filter((c) => isOpen(c) && written(c))
    .map((change): OpenPr => {
      const withAgent = !agent && change.authorKind === 'AGENT' ? (agentsOf(change, data.agents)[0]?.name ?? `an agent the Toil project doesn't name (${change.authorKindSignal ?? 'its account'})`) : null;
      return { change, wait: waitOf(change, now), withAgent };
    })
    .sort((a, b) => (b.wait.days ?? -1) - (a.wait.days ?? -1) || a.change.id.localeCompare(b.change.id));

  const reviews = changes
    .filter((c) => c.state === 'OPEN' && !mine(c.source.area, c.author) && c.reviewers.some((r) => r.state === 'PENDING' && mine(c.source.area, r.person)))
    .map((change): ReviewWait => ({ change, days: change.created ? round1(workingDays(change.created, now)) : null }))
    .sort((a, b) => (b.days ?? -1) - (a.days ?? -1) || a.change.id.localeCompare(b.change.id));

  const blocked = assigned
    .filter((i) => !isDone(i))
    .flatMap((item): Blocked[] => {
      const by = item.links.filter((l) => l.type === 'blocks' && l.direction === 'inward').map((l) => ({ id: l.target, item: byId.get(l.target) ?? null })).filter((b) => !b.item || !isDone(b.item));
      return by.length ? [{ item, by }] : [];
    });

  const from = Date.parse(now) - ACTIVITY_DAYS * DAY;
  const recent = (at: string | null): at is string => at !== null && Date.parse(at) >= from && Date.parse(at) <= Date.parse(now);
  const activity: Activity[] = [
    ...items.flatMap((item) => (item.history?.transitions ?? []).filter((t) => recent(t.at) && mine(item.source.area, t.by) && t.from !== t.to).map((t): Activity => ({ kind: 'moved', at: t.at, item, from: t.from, to: t.to }))),
    ...changes.filter((c) => c.state === 'MERGED' && recent(c.mergedAt) && written(c)).map((change): Activity => ({ kind: 'merged', at: change.mergedAt!, change })),
    ...changes.flatMap((change) => (change.reviews ?? []).filter((r) => recent(r.at) && mine(change.source.area, r.by)).map((r): Activity => ({ kind: 'reviewed', at: r.at, change, state: r.state }))),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  return {
    who,
    wip,
    wipCount: wipItems.length,
    overLimit: data.wipLimit === null ? null : wipItems.length > data.wipLimit,
    prs,
    reviews,
    blocked,
    activity: activity.slice(0, MAX_ACTIVITY),
    moreActivity: Math.max(0, activity.length - MAX_ACTIVITY),
  };
}

/** Whether a card has anything on it: an account the toil project doesn't map gets one only then. */
export const hasWork = (c: Card) => c.wipCount > 0 || c.prs.length > 0 || c.reviews.length > 0 || c.blocked.length > 0 || c.activity.length > 0;

// Suggestions ------------------------------------------------------------------------------

/** One account that is probably someone, by a shared email, for a person to approve. Never applied by the view. */
export interface Suggestion {
  /** The accounts to map. */
  identities: Identity[];
  /** The person to add them to, or null to add a new person named `name`. */
  person: string | null;
  name: string;
  email: string;
  /** The toil command that applies it, and its input: exactly what the line shows and the button runs. */
  command: 'projects person';
  input: { toilProject: string; name: string; id: string[]; email?: string };
}

export interface People {
  toilProject: string;
  /** Everyone the toil project's `people` lists, agents included, in name order. */
  people: Card[];
  /** Accounts the toil project doesn't map, each with something on its plate, in name order. */
  unmapped: Card[];
  suggestions: Suggestion[];
  /** Why an email suggested nothing: it points at more than one candidate. */
  ambiguous: string[];
  /** Pull requests an agent wrote that no agent in the toil project's people is matched to. */
  unnamedAgents: Change[];
  /** Accounts that wrote only bots' pull requests: left out of the cards. */
  bots: Identity[];
  team: Team;
  wipLimit: number | null;
}

export interface Team {
  /** Work in progress across the team's cards, and who is over the limit, in name order. */
  wip: { total: number; limit: number | null; over: Array<{ key: string; name: string; count: number }> };
  /** Open pull requests waiting on a review, longest first. */
  reviewQueue: Array<{ change: Change; wait: Wait }>;
  /** Items in the current sprint with nobody assigned and not done; null when no sprint is current. */
  unassigned: { sprint: string; items: WorkItem[] } | null;
}

const byName = (a: Card, b: Card) => a.who.name.localeCompare(b.who.name, 'en', { sensitivity: 'base' }) || a.who.key.localeCompare(b.who.key);

/** Everything the People view shows for one toil project. */
export function people(input: { toilProject: string; entries: PersonEntry[]; wipLimit: number | null; items: WorkItem[]; changes: Change[]; now: string }): People {
  const { toilProject, entries, wipLimit, items, now } = input;
  const changes = input.changes;
  const byId = new Map(items.map((i) => [i.id, i]));
  const seen = accounts(items, changes);
  const agents = entries.filter((e) => e.kind === 'agent');
  const data = { items, changes, byId, now, wipLimit, agents };

  const owner = (i: Identity) => entries.find((e) => isPerson(e, i));
  const peopleCards = entries.map((e) => {
    const found = [...seen.values()].filter((i) => isPerson(e, i));
    // Ids the toil project gives that no data has shown yet still say who the card is about.
    const named = Object.entries(e.ids).filter(([area, id]) => !found.some((f) => f.area === area && (lower(f.id) === lower(id) || lower(f.email) === lower(id)))).map(([area, id]): Identity => ({ area, id, name: null, email: null }));
    const who: Who = { key: personKey(e.name), name: e.name, kind: e.kind, mapped: true, identities: [...found, ...named], email: e.email };
    return cardFor(who, (i) => isPerson(e, i), e.kind === 'agent' ? e : null, data);
  });

  // Bots write pull requests but carry no plate: accounts that only ever wrote a bot's change stay off the cards.
  const botKeys = new Set(changes.filter((c) => c.authorKind === 'BOT' && c.author).map((c) => identityKey(c.source.area, c.author!.id)));
  const human = (i: Identity) => !botKeys.has(keyOf(i));
  const unmappedIds = [...seen.values()].filter((i) => !owner(i));
  const unmapped = unmappedIds
    .filter(human)
    .map((i) => cardFor({ key: identityWhoKey(i), name: i.name ?? i.id, kind: 'human', mapped: false, identities: [i], email: i.email }, (x) => keyOf(x) === keyOf(i), null, data))
    .filter(hasWork);

  const { suggestions, ambiguous } = suggest(toilProject, entries, unmappedIds.filter(human));
  const unnamedAgents = changes.filter((c) => c.authorKind === 'AGENT' && agentsOf(c, agents).length === 0);
  const cards = [...peopleCards].sort(byName);
  const health_ = health(items, [], now);
  return {
    toilProject,
    people: cards,
    unmapped: unmapped.sort(byName),
    suggestions,
    ambiguous,
    unnamedAgents,
    bots: unmappedIds.filter((i) => !human(i)),
    wipLimit,
    team: {
      wip: {
        total: [...cards, ...unmapped].reduce((n, c) => n + c.wipCount, 0),
        limit: wipLimit,
        over: [...cards, ...unmapped].filter((c) => c.overLimit).sort(byName).map((c) => ({ key: c.who.key, name: c.who.name, count: c.wipCount })),
      },
      reviewQueue: changes
        .filter((c) => c.state === 'OPEN')
        .map((change) => ({ change, wait: waitOf(change, now) }))
        .filter((r) => r.wait.on === 'review')
        .sort((a, b) => (b.wait.days ?? -1) - (a.wait.days ?? -1) || a.change.id.localeCompare(b.change.id)),
      unassigned: health_ ? { sprint: health_.sprint.name, items: health_.items.filter((i) => !i.assignee && !isDone(i) && flows(i)) } : null,
    },
  };
}

/**
 * Suggestions by email: an unmapped account whose email is one person's
 * `email`, or accounts in different systems that share one email and no
 * person has it. Only an email with exactly one candidate suggests anything;
 * the rest are said in `ambiguous`. A mapped account's email isn't used: one
 * shared mailbox on two accounts would pull a third to the wrong person.
 */
export function suggest(toilProject: string, entries: PersonEntry[], unmapped: Identity[]): { suggestions: Suggestion[]; ambiguous: string[] } {
  const suggestions: Suggestion[] = [];
  const ambiguous: string[] = [];
  const byEmail = new Map<string, Identity[]>();
  for (const i of unmapped) if (i.email) byEmail.set(lower(i.email), [...(byEmail.get(lower(i.email)) ?? []), i]);
  const label = (i: Identity) => `${i.area} ${i.id}`;
  for (const [email, accounts_] of [...byEmail.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const people_ = entries.filter((e) => lower(e.email) === email);
    const areas = new Map<string, Identity[]>();
    for (const i of accounts_) areas.set(i.area, [...(areas.get(i.area) ?? []), i]);
    const twice = [...areas.entries()].filter(([, list]) => list.length > 1);
    if (people_.length > 1) {
      ambiguous.push(`${email} is the email of ${people_.map((p) => p.name).join(' and ')}, so ${accounts_.map(label).join(', ')} ${accounts_.length === 1 ? 'is' : 'are'} not matched to either.`);
      continue;
    }
    if (twice.length) {
      ambiguous.push(`${email} is on ${twice.map(([area, list]) => `${list.length} ${area} accounts (${list.map((i) => i.id).join(', ')})`).join(' and ')}, so nothing is suggested for it.`);
      continue;
    }
    const person = people_[0];
    if (person) {
      const taken = accounts_.filter((i) => idIn(person, i.area) !== undefined);
      for (const i of taken) ambiguous.push(`${label(i)} has ${person.name}'s email, but ${person.name} already has a ${i.area} identity (${idIn(person, i.area)}), so it isn't suggested.`);
      const fit = accounts_.filter((i) => !taken.includes(i));
      if (fit.length) suggestions.push({ identities: fit, person: person.name, name: person.name, email, command: 'projects person', input: { toilProject, name: person.name, id: fit.map((i) => `${i.area}=${i.id}`) } });
      continue;
    }
    if (accounts_.length < 2) continue;
    const name = accounts_.find((i) => i.name)?.name ?? accounts_[0]!.id;
    suggestions.push({ identities: accounts_, person: null, name, email, command: 'projects person', input: { toilProject, name, id: accounts_.map((i) => `${i.area}=${i.id}`), email } });
  }
  return { suggestions, ambiguous };
}

/** A suggestion as the command line that applies it, made from its input alone, so the line and the button can't differ. */
export function suggestionLine(s: Suggestion): string {
  const quote = (v: string) => (/^[\w@.:=-]+$/.test(v) ? v : `"${v.replace(/(["\\$`])/g, '\\$1')}"`);
  return ['toil projects person', quote(s.input.toilProject), quote(s.input.name), ...s.input.id.flatMap((id) => ['--id', quote(id)]), ...(s.input.email ? ['--email', quote(s.input.email)] : [])].join(' ');
}

/** The card a key names, among the people and the unmapped accounts. */
export function cardByKey(view: People, key: string): Card | undefined {
  return [...view.people, ...view.unmapped].find((c) => c.who.key === key);
}

/** The work items assigned to whoever a key names: what the board shows filtered to them. */
export function assignedTo(view: People, key: string, items: WorkItem[], entries: PersonEntry[]): WorkItem[] {
  const entry = key.startsWith('person:') ? entries.find((e) => personKey(e.name) === key) : undefined;
  const card = cardByKey(view, key);
  const match: Matcher | null = entry ? (i) => isPerson(entry, i) : card ? (i) => card.who.identities.some((x) => keyOf(x) === keyOf(i)) : null;
  if (!match) return [];
  return items.filter((i) => {
    const who = asIdentity(i.source.area, i.assignee);
    return who !== null && match(who);
  });
}
