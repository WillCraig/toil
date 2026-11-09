import type { Change, Person, WorkItem } from './owi/types.js';

/** The shape of a toil project's person this module reads: no import of the project reader, so the page can bundle it. */
export interface PersonEntryLike {
  name: string;
  email?: string | null | undefined;
  ids: Readonly<Record<string, string>>;
}

/** The key one identity is held under, as toil-project.ts keeps it: system ids compare without case. */
const identityKey = (area: string, id: string) => `${area}\u0000${id.trim().toLowerCase()}`;

/**
 * Who is probably who: the accounts a read named (a GitHub login, a Jira
 * accountId, an Azure DevOps identity, a Bitbucket user) set against a toil
 * project's people, for `toil projects people suggest`. Pure and offline: the
 * caller hands it the accounts, it hands back proposals and the command line
 * that would apply each one. It never maps anything. A suggestion is a
 * question put to a person, who is better placed to know than a trigram.
 *
 * What a match rests on, strongest first, and said on every suggestion:
 * - `email`: the account's email is the person's email, or the identity the
 *   person already has in that account's area (an Azure DevOps identity is
 *   often an email).
 * - `name`: the account's display name is the person's name, in any order and
 *   ignoring case, accents and punctuation ("Example, Pat" is Pat Example).
 * - `login`: the account's id reads as the person's name with the usual
 *   shapes of a login (patexample, pat.example, pat-example, pexample).
 *
 * An account that fits more than one person suggests nothing; an area where a
 * person already has an identity is never offered a second one. Two accounts
 * in different areas that share an email and match nobody suggest a new
 * person. The ledger of who is who, drawn up without the weekly meeting.
 */

/** One account in one system, as a read names it. */
export interface Account {
  area: string;
  id: string;
  name: string | null;
  email: string | null;
}

export const MATCH_REASONS = ['email', 'name', 'login'] as const;
export type MatchReason = (typeof MATCH_REASONS)[number];

export interface PeopleSuggestion {
  /** The accounts to map. */
  accounts: Account[];
  /** The person they join, or null for a new person named `name`. */
  person: string | null;
  name: string;
  reason: MatchReason;
  /** One sentence saying what the match rests on. */
  because: string;
  /** The `projects person` input that applies it. */
  input: { toilProject: string; name: string; id: string[]; email?: string };
  /** The same as a command line, made from `input` alone. */
  command: string;
}

export interface PeopleSuggestions {
  suggestions: PeopleSuggestion[];
  /** Accounts the people don't map and nothing was suggested for, for a person to map by hand. */
  unmapped: Account[];
  /** Why an account suggested nothing though something fit. */
  ambiguous: string[];
  /** How many distinct accounts were read, so that "none" is distinguishable from "none read". */
  read: number;
}

const lower = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** Letters and digits only, accents folded: the form a name and a login are compared in. */
const squash = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** A name's words, in order, accents folded: "Example, Pat" gives [example, pat]. */
const words = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

const sameName = (a: string, b: string) => {
  const x = words(a).sort().join(' ');
  return x !== '' && x === words(b).sort().join(' ');
};

/** Whether a login reads as this name: all the words run together, either way round, or first initial plus the last word. */
function loginFits(login: string, name: string): boolean {
  const l = squash(login);
  const w = words(name);
  if (w.length < 2 || l.length < 4) return false;
  const first = w[0]!;
  const last = w[w.length - 1]!;
  return l === w.join('') || l === [...w].reverse().join('') || l === `${first[0]}${last}` || l === `${first}${last[0]}` || l === `${last}${first[0]}`;
}

/** Whether a person already is this account: their identity for its area is its id or its email. */
export function isMapped(people: readonly PersonEntryLike[], a: Account): boolean {
  return people.some((p) => {
    const id = p.ids[a.area];
    return id !== undefined && (lower(id) === lower(a.id) || (a.email !== null && lower(id) === lower(a.email)));
  });
}

const quote = (v: string) => (/^[\w@.:=-]+$/.test(v) ? v : `"${v.replace(/(["\\$`])/g, '\\$1')}"`);

/** The `projects person` call that applies a suggestion, as the line a person would type. */
export function personCommand(input: PeopleSuggestion['input']): string {
  return ['toil projects person', quote(input.toilProject), quote(input.name), ...input.id.flatMap((id) => ['--id', quote(id)]), ...(input.email ? ['--email', quote(input.email)] : [])].join(' ');
}

const label = (a: Account) => `${a.area} ${a.id}`;

export function suggestPeople(toilProject: string, people: readonly PersonEntryLike[], read: readonly Account[]): PeopleSuggestions {
  // One entry per account, keeping the best name and email seen for it.
  const seen = new Map<string, Account>();
  for (const a of read) {
    const key = identityKey(a.area, a.id);
    const had = seen.get(key);
    seen.set(key, had ? { ...had, name: had.name ?? a.name, email: had.email ?? a.email } : { ...a });
  }
  const accounts = [...seen.values()].filter((a) => !isMapped(people, a)).sort((a, b) => label(a).localeCompare(label(b)));
  const suggestions: PeopleSuggestion[] = [];
  const ambiguous: string[] = [];
  const done = new Set<string>();

  const propose = (account: Account, person: PersonEntryLike, reason: MatchReason, because: string) => {
    const input = { toilProject, name: person.name, id: [`${account.area}=${account.id}`] };
    suggestions.push({ accounts: [account], person: person.name, name: person.name, reason, because, input, command: personCommand(input) });
    done.add(identityKey(account.area, account.id));
  };

  for (const a of accounts) {
    // Only a person without an identity in this area can take it: a second one would be a different account, not a match.
    const open = people.filter((p) => p.ids[a.area] === undefined);
    const tiers: Array<[MatchReason, (p: PersonEntryLike) => boolean, (p: PersonEntryLike) => string]> = [
      ['email', (p) => a.email !== null && (lower(p.email) === lower(a.email) || Object.values(p.ids).some((v) => lower(v) === lower(a.email))), (p) => `${label(a)} has ${p.name}'s email.`],
      ['name', (p) => a.name !== null && sameName(a.name, p.name), (p) => `${label(a)} is shown as "${a.name}", which is ${p.name}'s name.`],
      ['login', (p) => loginFits(a.id, p.name), (p) => `${label(a)} reads as ${p.name}'s name written as a login.`],
    ];
    for (const [reason, fits, because] of tiers) {
      const hit = open.filter(fits);
      if (hit.length === 0) continue;
      if (hit.length > 1) {
        ambiguous.push(`${label(a)} fits ${hit.map((p) => p.name).join(' and ')} by ${reason}, so it isn't suggested for either.`);
        break;
      }
      propose(a, hit[0]!, reason, because(hit[0]!));
      break;
    }
  }

  // Accounts in different areas that share an email and fit nobody: probably one new person.
  const byEmail = new Map<string, Account[]>();
  for (const a of accounts) if (!done.has(identityKey(a.area, a.id)) && a.email) byEmail.set(lower(a.email), [...(byEmail.get(lower(a.email)) ?? []), a]);
  for (const [email, group] of [...byEmail.entries()].sort(([x], [y]) => x.localeCompare(y))) {
    const areas = new Set(group.map((a) => a.area));
    if (group.length < 2) continue;
    if (areas.size < group.length) {
      ambiguous.push(`${email} is on more than one ${group.find((a, i) => group.findIndex((b) => b.area === a.area) !== i)!.area} account, so nothing is suggested for it.`);
      continue;
    }
    const name = group.find((a) => a.name)?.name ?? group[0]!.id;
    const input = { toilProject, name, id: group.map((a) => `${a.area}=${a.id}`), email };
    suggestions.push({ accounts: group, person: null, name, reason: 'email', because: `${group.map(label).join(' and ')} share the email ${email}.`, input, command: personCommand(input) });
    for (const a of group) done.add(identityKey(a.area, a.id));
  }

  return { suggestions, unmapped: accounts.filter((a) => !done.has(identityKey(a.area, a.id))), ambiguous, read: seen.size };
}

/**
 * The accounts the work items and pull requests name: assignee, reporter and
 * who moved an item, each pull request's author, its reviewers and who
 * reviewed it, each under the area the record came from. A record with no
 * area names nobody, since an account is only an account in some system.
 */
export function accountsIn(items: readonly WorkItem[], changes: readonly Change[]): Account[] {
  const out: Account[] = [];
  const add = (area: string | undefined, p: Person | null | undefined) => {
    if (!area || !p || typeof p.id !== 'string' || p.id.trim() === '') return;
    out.push({ area, id: p.id.trim(), name: p.name?.trim() || null, email: p.email?.trim() || null });
  };
  for (const item of items) {
    add(item.source.area, item.assignee);
    add(item.source.area, item.reporter);
    for (const t of item.history?.transitions ?? []) add(item.source.area, t.by);
  }
  for (const c of changes) {
    add(c.source?.area, c.author);
    for (const r of c.reviewers ?? []) add(c.source?.area, r.person);
    for (const r of c.reviews ?? []) add(c.source?.area, r.by);
  }
  return out;
}