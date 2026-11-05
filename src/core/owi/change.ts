import { ToilError } from '../errors.js';
import { idFor, instant, isRecord, str, type MapState, type OwiDocument } from './common.js';
import { AUTHOR_KINDS, OWI_VERSION, type AuthorKind, type AuthorKindSource, type Change, type ChecksState, type KeyPattern, type Person, type Review } from './types.js';

/**
 * What every pull request mapper shares (OWI 0.2, `Change`): the empty
 * record, the work items a title, branch and description name, who wrote it
 * (a person, an agent or a bot, and the signal that said so), and the
 * checks and reviews rolled up into the few states a lead reads. Each code
 * host's own shapes are read in its module (change-github.ts and the rest);
 * the decisions are made here, once, so the five hosts can't disagree about
 * what "waiting on review" means. A cross-functional working group, minus
 * the working group.
 */

/** What the change mappers are handed besides the documents. */
export interface ChangeOptions {
  /** Where work item keys in a title, branch or description point: `PAY-{n}` to a Jira connection, `AB#{n}` to Azure Boards. */
  keys: KeyPattern[];
  /** Author kinds set by hand, by the author's id (a login or username), which win over every other signal. */
  authors: Record<string, AuthorKind>;
}

export interface ChangeMapState extends MapState {
  changes: ChangeOptions;
}

/** A change with every field empty, for a mapper to fill. */
export function blankChange(doc: OwiDocument, repo: string, number: string, title: string, native: unknown): Change {
  const key = `${repo}#${number}`;
  return {
    owi: OWI_VERSION,
    id: idFor(doc.connection, key),
    source: { area: doc.area, connection: doc.connection, key, command: doc.command, ...(doc.deployment === undefined ? {} : { deployment: doc.deployment }) },
    url: null,
    repo,
    title,
    branch: { source: null, target: null },
    state: 'OPEN',
    author: null,
    authorKind: 'HUMAN',
    authorKindSource: 'default',
    authorKindSignal: null,
    reviewers: [],
    reviews: null,
    checks: null,
    checksAt: null,
    mergeable: null,
    size: null,
    workItems: [],
    mergeCommit: null,
    created: null,
    firstReviewAt: null,
    approvedAt: null,
    mergedAt: null,
    closedAt: null,
    updated: null,
    unmapped: [],
    native: { [doc.command]: native },
  };
}

/** Records a change field left empty, and why; one entry per field. */
export function gap(change: Change, field: string, reason: string): void {
  if (!change.unmapped.some((u) => u.field === field)) change.unmapped.push({ field, reason });
}

/** An instant field, or a gap saying it couldn't be read. */
export function at(change: Change, field: string, value: unknown, from: string): string | null {
  const t = typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : instant(value);
  if (t === undefined) {
    gap(change, field, `${from} holds ${JSON.stringify(value)}, which isn't a date-time`);
    return null;
  }
  return t;
}

/** What `pr get --include` added, by name: the lists the call asked for, and nothing for the rest. */
export function included(pr: Record<string, unknown>): Partial<Record<'reviews' | 'checks' | 'commits' | 'files', unknown[]>> {
  const out: Partial<Record<'reviews' | 'checks' | 'commits' | 'files', unknown[]>> = {};
  if (!isRecord(pr.included)) return out;
  for (const name of ['reviews', 'checks', 'commits', 'files'] as const) if (Array.isArray(pr.included[name])) out[name] = pr.included[name] as unknown[];
  return out;
}

/** Why a list wasn't there to read, for the field it would have filled. */
export const notIncluded = (doc: OwiDocument, list: string) =>
  doc.command.endsWith(' pr list')
    ? `${doc.command} doesn't return ${list}: map ${doc.area} pr get --include ${list} for each pull request as well`
    : `the input wasn't read with --include ${list}: map ${doc.area} pr get --include ${list}`;

// Key patterns --------------------------------------------------------------------

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Key patterns as `text=connection` entries (the CLI's repeatable
 * --key-pattern) or objects (what Toil UI builds from a toil project), checked.
 * The text holds exactly one `{n}` and is matched as written, never as a
 * regular expression.
 */
export function keyPatterns(entries: Array<string | KeyPattern> | undefined): KeyPattern[] {
  return (entries ?? []).map((entry) => {
    let text: string;
    let connection: string;
    if (typeof entry === 'string') {
      const split = entry.lastIndexOf('=');
      if (split <= 0) throw new ToilError('INVALID_INPUT', `"${entry}" isn't a key pattern.`, { fix: 'Write it as pattern=connection, with {n} where the number is: PAY-{n}=corp-jira, or AB#{n}=corp-ado.' });
      text = entry.slice(0, split);
      connection = entry.slice(split + 1);
    } else {
      ({ text, connection } = entry);
    }
    if (text.split('{n}').length !== 2 || text === '{n}') {
      throw new ToilError('INVALID_INPUT', `The key pattern "${text}" must hold {n} exactly once, beside some text (PAY-{n}, AB#{n}).`, { fix: 'Put {n} where the number is, once: PAY-{n}=corp-jira.' });
    }
    if (!NAME.test(connection)) throw new ToilError('INVALID_INPUT', `"${connection}" isn't a connection name (the part after = in ${text}=${connection}).`, { fix: 'Name the connection the keys belong to: lowercase letters, digits and single hyphens, as toil connections list shows it.' });
    return { text, connection };
  });
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One pattern as a regular expression: the text literally, `{n}` a number, not inside a longer word or number. */
function patternRegex(text: string): RegExp {
  const [before, after] = text.split('{n}') as [string, string];
  const lead = /^\w/.test(before) ? '(?<![\\w-])' : '';
  const tail = after === '' || /\w$/.test(after) ? '(?!\\w)' : '';
  return new RegExp(`${lead}${escape(before)}(\\d+)${escape(after)}${tail}`, 'g');
}

/**
 * The key a pattern's match names: the text as matched (`PAY-101`,
 * `imagile/payments-web#42`), or the number alone for a mention such as
 * `AB#{n}`, which ends `#{n}` and names no repository.
 */
const keyOf = (pattern: KeyPattern, match: string, n: string) => (pattern.text.endsWith('#{n}') && !pattern.text.includes('/') ? n : match);

/** Text in code, which names nothing: fenced blocks and inline spans are blanked before reading. */
const withoutCode = (s: string) => s.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');

/**
 * The work items a change names. `own` reads the host's own references
 * (`#12` on GitHub is an issue in the same repository; on Azure DevOps it
 * is a work item); `keys` read everything else. Each id once, in the order
 * first found: title, then branch, then description.
 */
export function workItemsIn(parts: Array<string | null>, keys: KeyPattern[], own: (text: string) => string[] = () => []): string[] {
  const out: string[] = [];
  const add = (id: string) => {
    if (!out.includes(id)) out.push(id);
  };
  for (const raw of parts) {
    if (!raw) continue;
    const text = withoutCode(raw);
    for (const id of own(text)) add(id);
    for (const pattern of keys) for (const m of text.matchAll(patternRegex(pattern.text))) add(idFor(pattern.connection, keyOf(pattern, m[0], m[1]!)));
  }
  return out;
}

/** A branch named for its issue: `291-pr-tracking`, `kolatts/291-pr-tracking`, `feature/291_retries`. */
export function branchNumber(branch: string | null): string | null {
  const last = branch?.split('/').at(-1) ?? '';
  return /^(\d+)[-_]/.exec(last)?.[1] ?? null;
}

/** `#12`, not part of a longer word or an `owner/repo#12` (which a host reads on its own) or a key pattern such as `AB#12`. */
export const HASH_NUMBER = /(?<![\w/#-])#(\d+)\b/g;

// Who wrote it --------------------------------------------------------------------

/**
 * Agent signals: the branch prefixes the coding agents push to, and the
 * names and addresses their Co-Authored-By trailers carry. A trailer naming
 * one of these is the signal; a commit message merely mentioning one isn't.
 */
export const AGENT_BRANCH_PREFIXES = ['claude/', 'copilot/', 'codex/'];
const AGENT_TRAILER = /^co-authored-by:\s*(.+)$/gim;
const AGENTS: Array<{ name: string; test: RegExp }> = [
  { name: 'Claude', test: /\bclaude\b|@anthropic\.com\b/i },
  { name: 'GitHub Copilot', test: /\bcopilot\b/i },
  { name: 'Codex', test: /\bcodex\b|@openai\.com\b/i },
  { name: 'Cursor', test: /\bcursor\s*agent\b|@cursor\.(com|sh)\b/i },
  { name: 'Devin', test: /\bdevin\b|@cognition\.ai\b/i },
];

/** The accounts the coding agents open pull requests as, which a host marks as bots: they are agents, not bots. */
export const AGENT_ACCOUNTS = ['copilot', 'copilot-swe-agent[bot]', 'claude[bot]', 'devin-ai-integration[bot]', 'chatgpt-codex-connector[bot]'];

/** The first Co-Authored-By trailer in the messages that names an agent, as written. */
export function agentTrailer(messages: string[]): string | null {
  for (const message of messages) {
    for (const m of message.matchAll(AGENT_TRAILER)) {
      const who = m[1]!.trim();
      if (AGENTS.some((a) => a.test.test(who))) return `Co-Authored-By: ${who}`;
    }
  }
  return null;
}

/** What the host says about the author's account: a bot, an agent's account, or nothing. */
export interface AccountSignal {
  kind: AuthorKind;
  signal: string;
}

/**
 * Sets `authorKind` from the strongest signal there is, in this order: the
 * toil project's override for the author, the account itself (a bot, or an
 * agent's account), an agent's Co-Authored-By trailer on a commit, an
 * agent's branch prefix. With none, HUMAN, and the source says `default`.
 */
export function setAuthorKind(change: Change, state: ChangeMapState, signals: { account: AccountSignal | null; messages: string[] | null }): void {
  const set = (kind: AuthorKind, source: AuthorKindSource, signal: string | null) => {
    change.authorKind = kind;
    change.authorKindSource = source;
    change.authorKindSignal = signal;
  };
  const override = change.author ? overrideFor(state.changes.authors, change.author) : undefined;
  if (override) return set(override.kind, 'override', `override for ${override.id}`);
  if (signals.account) return set(signals.account.kind, 'account', signals.account.signal);
  const trailer = signals.messages ? agentTrailer(signals.messages) : null;
  if (trailer) return set('AGENT', 'trailer', trailer);
  const prefix = AGENT_BRANCH_PREFIXES.find((p) => change.branch.source?.toLowerCase().startsWith(p));
  if (prefix) return set('AGENT', 'branch', `branch ${change.branch.source}`);
  set('HUMAN', 'default', null);
  if (signals.messages === null) gap(change, 'authorKind', 'HUMAN by default: no override, account or branch says otherwise, and the commits (whose Co-Authored-By trailers can name an agent) weren\'t read; map pr get --include commits');
}

/** The override for a person, matched on their id, name or email, ignoring case. */
function overrideFor(authors: Record<string, AuthorKind>, person: Person): { id: string; kind: AuthorKind } | undefined {
  const names = [person.id, person.name, person.email].filter((n): n is string => !!n).map((n) => n.toLowerCase());
  for (const [id, kind] of Object.entries(authors)) if (names.includes(id.toLowerCase())) return { id, kind };
  return undefined;
}

/** Author kinds as `id=KIND` entries (the CLI's repeatable --author-kind) or an object (a toil project section's `authorKinds`), checked. */
export function authorKinds(entries: string[] | Record<string, string> | undefined): Record<string, AuthorKind> {
  const pairs = Array.isArray(entries)
    ? entries.map((entry) => {
        const split = entry.lastIndexOf('=');
        if (split <= 0) throw new ToilError('INVALID_INPUT', `"${entry}" isn't an author kind.`, { fix: 'Write it as id=KIND, with KIND one of HUMAN, AGENT or BOT: release-bot=BOT.' });
        return [entry.slice(0, split), entry.slice(split + 1)] as const;
      })
    : Object.entries(entries ?? {});
  const out: Record<string, AuthorKind> = {};
  for (const [id, raw] of pairs) {
    const kind = String(raw).toUpperCase() as AuthorKind;
    if (!AUTHOR_KINDS.includes(kind)) throw new ToilError('INVALID_INPUT', `"${raw}" isn't an author kind (for ${id}).`, { fix: `Use one of ${AUTHOR_KINDS.join(', ')}.` });
    out[id] = kind;
  }
  return out;
}

// Reviews and checks --------------------------------------------------------------

/** The first review by someone other than the author, and the first approval, from the reviews in order. */
export function reviewTimes(change: Change, reviews: Review[]): void {
  const sorted = [...reviews].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  change.reviews = sorted;
  const others = sorted.filter((r) => !change.author || r.by.id.toLowerCase() !== change.author.id.toLowerCase());
  change.firstReviewAt = others[0]?.at ?? null;
  change.approvedAt = others.find((r) => r.state === 'APPROVED')?.at ?? null;
}

/** One check as a mapper reads it: passing, failing or still running, and when it last changed. */
export interface CheckRun {
  name: string;
  outcome: 'pass' | 'fail' | 'pending';
  at: string | null;
}

/**
 * The checks rolled up: FAILING when any check is failing, else PENDING
 * when any is still running, else PASSING; NONE when the host ran none.
 */
export function rollUp(change: Change, runs: CheckRun[]): void {
  const times = (list: CheckRun[]) => list.map((r) => r.at).filter((t): t is string => t !== null).sort();
  if (!runs.length) {
    change.checks = 'NONE';
    change.checksAt = null;
    return;
  }
  const failing = runs.filter((r) => r.outcome === 'fail');
  const state: ChecksState = failing.length ? 'FAILING' : runs.some((r) => r.outcome === 'pending') ? 'PENDING' : 'PASSING';
  change.checks = state;
  change.checksAt = state === 'FAILING' ? (times(failing)[0] ?? null) : (times(runs).at(-1) ?? null);
}

/** The commit messages in a commits list, read by `message` (GitHub's is under `commit`, Azure DevOps' is `comment`). */
export function messagesOf(commits: unknown[]): string[] {
  return commits.flatMap((c) => {
    if (!isRecord(c)) return [];
    const m = str(c.message) ?? (isRecord(c.commit) ? str(c.commit.message) : null) ?? str(c.comment);
    return m ? [m] : [];
  });
}

/** Two records of one change, a list's and a get's, as one: the get's fields win, and native keeps both. */
export function joinChanges(before: Change, after: Change): Change {
  const fromGet = (c: Change) => c.source.command.endsWith(' pr get');
  const [base, other] = fromGet(after) || !fromGet(before) ? [after, before] : [before, after];
  return { ...base, native: { ...other.native, ...base.native } };
}
