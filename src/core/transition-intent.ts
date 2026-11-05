import { ToilError } from './errors.js';

/**
 * Transitions by intent (#302): `--to review` resolved against the moves one
 * work item actually offers, never a status name hard-coded for the whole
 * project. A Jira workflow belongs to the issue type, so a Story may go
 * through In Review while a Task goes straight to Done; an ADO state belongs
 * to the work item type, and its category says what it is for.
 *
 * Resolution is deterministic and runs most specific first:
 *
 *   1. toil project   a name the toil project pins for this item's type and intent
 *   2. status    an exact transition or status name among the item's moves
 *   3. category  the one move into the intent's status category
 *   4. name      the one move whose name or target starts a word with the intent
 *
 * Steps 3 and 4 apply only to the four intents. When step 3 finds several,
 * step 4 narrows within them; anything still not exactly one is refused with
 * the moves the item does offer. Choosing one on the caller's behalf would
 * need a change ticket; listing the options needs none.
 */

export const INTENTS = ['start', 'review', 'done', 'reopen'] as const;
export type Intent = (typeof INTENTS)[number];

/** How a transition was chosen, as meta.transition reports it. */
export type ResolvedBy = 'toil-project' | 'status' | 'category' | 'name';

/** One move the item offers: a Jira transition, or an ADO state. */
export interface TransitionCandidate {
  /** What the write sends: a Jira transition id, or an ADO state name. */
  id: string;
  /** The transition's name (for ADO, the state's). */
  name: string;
  /** The status the item lands in. */
  toStatus: string;
  /** The service's own category for the target status, as it names it (`indeterminate`, `Resolved`), for the fix text. */
  category?: string | undefined;
  /** The intent the target's category serves, if any. */
  intent?: Intent | undefined;
}

/** The item being moved, for resolution and for every message about it. */
export interface TransitionItem {
  /** How messages name it: `PROJ-1`, `work item 42`. */
  label: string;
  /** Its type, which pins are keyed by: `Story`, `User Story`. */
  type: string;
  /** Its current status. */
  status: string;
  /** The intent its current status's category serves, if any. */
  statusIntent?: Intent | undefined;
}

/** What a call needs to know to explain itself: the commands and keys to name in a fix. */
export interface TransitionHelp {
  /** The flag or field that takes a transition or state by name or id: `--transition <name-or-id>`. */
  explicit: string;
  /** The toil project key pins live under, `jira.transitions` or `ado.transitions`. */
  pinKey: string;
}

/** meta.transition: what `--to` asked for and what it resolved to. */
export interface TransitionReport {
  intent: string;
  transition: string;
  toStatus: string;
  resolvedBy: ResolvedBy;
}

export interface TransitionResolution {
  candidate: TransitionCandidate;
  report: TransitionReport;
}

/** Pins from the toil project: type to intent to a transition or status name. */
export type TransitionPins = Record<string, Record<string, string>>;

const lower = (s: string) => s.trim().toLowerCase();

/** The intent a `--to` value names, or undefined for a status name. */
export function intentOf(to: string): Intent | undefined {
  const word = lower(to);
  return (INTENTS as readonly string[]).includes(word) ? (word as Intent) : undefined;
}

/** A name with a word that starts with the intent: `Submit for Review`, `Reopened`, never `Undone`. */
function startsWord(text: string, intent: Intent): boolean {
  return new RegExp(`(^|[^a-z0-9])${intent}`, 'i').test(text);
}

/** Pins for one type, the type matched case-insensitively. */
function pinFor(pins: TransitionPins, type: string, intent: Intent): string | undefined {
  const entry = Object.entries(pins).find(([t]) => lower(t) === lower(type));
  return entry?.[1][intent];
}

function named(candidates: TransitionCandidate[], name: string): TransitionCandidate[] {
  const want = lower(name);
  return candidates.filter((c) => lower(c.name) === want || lower(c.toStatus) === want);
}

/** One line per move, as the fix lists them. */
export function describeMoves(candidates: TransitionCandidate[]): string {
  if (candidates.length === 0) return '(none)';
  return candidates
    .map((c) => {
      const into = lower(c.name) === lower(c.toStatus) ? c.name : `${c.name} (to ${c.toStatus})`;
      return `${into}${c.category ? ` [${c.category}]` : ''}${c.id !== c.name ? ` id ${c.id}` : ''}`;
    })
    .join('; ');
}

/**
 * Resolves `to` against the moves `item` offers. Returns exactly one, or
 * throws INVALID_INPUT naming every move the item does offer.
 */
export function resolveTransition(to: string, item: TransitionItem, candidates: TransitionCandidate[], pins: TransitionPins, help: TransitionHelp): TransitionResolution {
  const intent = intentOf(to);
  const where = `${item.label} (${item.type}, now ${item.status})`;
  const offers = `${where} offers: ${describeMoves(candidates)}.`;
  const choose = `Pass one of them with --to <status>, or ${help.explicit}`;
  const pinHint = intent ? `, or pin it for ${item.type} in the toil project as ${help.pinKey}.${JSON.stringify(item.type)}.${intent}` : '';
  const done = (candidate: TransitionCandidate, resolvedBy: ResolvedBy): TransitionResolution => ({
    candidate,
    report: { intent: to, transition: candidate.name, toStatus: candidate.toStatus, resolvedBy },
  });
  const ambiguous = (found: TransitionCandidate[], how: string) =>
    new ToilError('INVALID_INPUT', `"${to}" is ambiguous for ${where}: ${how} ${found.map((c) => c.name).join(', ')}.`, {
      fix: `${offers} ${choose}${pinHint}.`,
    });

  // 1. The toil project's pin for this type: the author's word, so it never falls through.
  const pin = intent ? pinFor(pins, item.type, intent) : undefined;
  if (pin !== undefined) {
    const found = named(candidates, pin);
    if (found.length === 1) return done(found[0]!, 'toil-project');
    if (found.length > 1) throw ambiguous(found, `the toil project pins "${pin}", which more than one move matches:`);
    throw new ToilError('INVALID_INPUT', `The toil project pins ${intent} for ${item.type} to "${pin}", but ${where} offers no transition or status by that name.`, {
      fix: `${offers} Correct ${help.pinKey}.${JSON.stringify(item.type)}.${intent} in the toil project, or ${help.explicit}.`,
    });
  }

  // 2. An exact transition or status name.
  const exact = named(candidates, to);
  if (exact.length === 1) return done(exact[0]!, 'status');
  if (exact.length > 1) throw ambiguous(exact, 'more than one move goes by that name:');

  if (intent) {
    // Already there: say so rather than pick a sibling status in the same category.
    if (item.statusIntent === intent || (!candidates.some((c) => c.intent === intent) && startsWord(item.status, intent))) {
      const why = item.statusIntent === intent ? `a status in the category "${intent}" leads to` : `which is where "${intent}" leads`;
      throw new ToilError('INVALID_INPUT', `${where} is already ${item.status}, ${why}.`, {
        fix: `Nothing to move. ${offers} ${choose}.`,
      });
    }
    const moves = candidates.filter((c) => lower(c.toStatus) !== lower(item.status));
    // 3. The intent's status category, narrowed by name when it holds several.
    const inCategory = moves.filter((c) => c.intent === intent);
    if (inCategory.length === 1) return done(inCategory[0]!, 'category');
    if (inCategory.length > 1) {
      const narrowed = inCategory.filter((c) => startsWord(c.name, intent) || startsWord(c.toStatus, intent));
      if (narrowed.length === 1) return done(narrowed[0]!, 'name');
      throw ambiguous(inCategory, 'more than one move leads into its status category:');
    }
    // 4. A name that says it.
    const byName = moves.filter((c) => startsWord(c.name, intent) || startsWord(c.toStatus, intent));
    if (byName.length === 1) return done(byName[0]!, 'name');
    if (byName.length > 1) throw ambiguous(byName, 'more than one move is named for it:');
  }

  throw new ToilError('INVALID_INPUT', `${where} has no transition for "${to}".`, {
    fix: `${offers} ${choose}${pinHint}.`,
  });
}

/** The error for a call that gave neither or both of `--to` and the explicit flag. */
export function oneOfTransition(help: TransitionHelp, given: boolean): ToilError {
  return new ToilError('INVALID_INPUT', given ? `Give --to or ${help.explicit.split(' ')[0]}, not both.` : `Say where to move it: --to <intent|status>, or ${help.explicit}.`, {
    fix: `--to takes start, review, done, reopen or a status name, resolved against this item's own workflow; ${help.explicit.split(' ')[0]} names it exactly.`,
  });
}

/** Jira's status categories by key, as intents. There is no review category: a status's name says review (jiraIntent). */
const JIRA_CATEGORY: Record<string, Intent> = { new: 'reopen', indeterminate: 'start', done: 'done' };

/** Azure DevOps state categories as intents. Removed serves none, so only its name reaches it. */
const ADO_CATEGORY: Record<string, Intent> = { Proposed: 'reopen', InProgress: 'start', Resolved: 'review', Completed: 'done' };

/** A category's intent, own keys only: a server's `constructor` category is no intent. */
const intentIn = (table: Record<string, Intent>, category: string | undefined): Intent | undefined => (category !== undefined && Object.hasOwn(table, category) ? table[category] : undefined);

interface JiraStatus {
  name?: string;
  statusCategory?: { key?: string; name?: string };
}

/**
 * A Jira status's intent. Jira files review under In Progress (`indeterminate`),
 * so a status there whose name says review (In Review, Code Review) serves
 * review, not start; otherwise `--to start` from In Review would read as
 * already there, and `--to start` from To Do could land in review.
 */
function jiraIntent(status: JiraStatus | undefined): Intent | undefined {
  const intent = intentIn(JIRA_CATEGORY, status?.statusCategory?.key);
  return intent === 'start' && startsWord(status?.name ?? '', 'review') ? 'review' : intent;
}

/** A Jira issue read with `fields=issuetype,status&expand=transitions`, as Data Center and Cloud both return it. */
export interface JiraIssueWithTransitions {
  key?: string;
  fields?: { issuetype?: { name?: string }; status?: JiraStatus };
  transitions?: Array<{ id: string; name: string; to?: JiraStatus }>;
}

/** The moves a Jira issue offers right now, by its own workflow, and the issue as resolution needs it. */
export function jiraMoves(key: string, issue: JiraIssueWithTransitions): { item: TransitionItem; candidates: TransitionCandidate[] } {
  const status = issue.fields?.status;
  const item: TransitionItem = {
    label: key,
    type: issue.fields?.issuetype?.name ?? 'unknown type',
    status: status?.name ?? 'unknown status',
    statusIntent: jiraIntent(status),
  };
  const candidates = (issue.transitions ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    toStatus: t.to?.name ?? t.name,
    category: t.to?.statusCategory?.name ?? t.to?.statusCategory?.key,
    intent: jiraIntent(t.to),
  }));
  return { item, candidates };
}

/** One state of a work item type, as `workitemtypes/{type}/states` returns it. */
export interface AdoState {
  name: string;
  category?: string;
}

/**
 * The states a work item can be set to, from its type's states, and the item
 * as resolution needs it. ADO has no transition list: any state of the type
 * is a move, which the server's own rules may still refuse.
 */
export function adoMoves(id: number, fields: Record<string, unknown>, states: AdoState[]): { item: TransitionItem; candidates: TransitionCandidate[] } {
  const status = typeof fields['System.State'] === 'string' ? fields['System.State'] : 'unknown state';
  const type = typeof fields['System.WorkItemType'] === 'string' ? fields['System.WorkItemType'] : 'unknown type';
  const current = states.find((s) => s.name.toLowerCase() === status.toLowerCase());
  const item: TransitionItem = { label: `work item ${id}`, type, status, statusIntent: intentIn(ADO_CATEGORY, current?.category) };
  const candidates = states
    .filter((s) => s !== current)
    .map((s) => ({ id: s.name, name: s.name, toStatus: s.name, category: s.category, intent: intentIn(ADO_CATEGORY, s.category) }));
  return { item, candidates };
}
