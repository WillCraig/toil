/**
 * Assigning a work item to an agent (#293): the shapes the server, the page
 * and the preview share, and the pure rules they all apply. A person picks
 * an item, an adapter (Claude, Copilot or Codex) and one mode:
 *
 * - **refine** drafts acceptance criteria, an estimate, a split into
 *   children and open questions, all as write proposals;
 * - **investigate** researches the item across the toil project's sources and
 *   writes a report that cites them, saved with the assignment; posting it
 *   as a comment is a proposal;
 * - **implement** works the item in a clone of the toil project's repository, on
 *   a new local branch `agent/<key>`; pushing it and opening a pull request
 *   are proposals.
 *
 * Nothing an agent does leaves the machine until a person applies a
 * proposal, which runs toil's write command through its own gate. The
 * states (`queued`, `working`, `needs-you`, `done`, `failed`), the events and
 * the record of what each run started on are what later work hooks into:
 * notifications (#306), stale sessions (#305) and matching the work to a
 * ticket (#304). A delegation form with a counter-signature box, and the box
 * is load-bearing.
 */

import type { AnswerUsage } from '../model-usage.ts';
import type { PersonEntry } from '../model/people.ts';
import type { Proposal } from '../proposal.ts';
import type { WorkItem } from '../toil.ts';
import type { Fingerprint, Staleness } from '../fingerprint.ts';
import { textOf } from '../../../src/core/standards/text.ts';

export type AssignMode = 'refine' | 'investigate' | 'implement';
export const MODES: readonly AssignMode[] = ['refine', 'investigate', 'implement'];

export type AssignAdapter = 'claude' | 'copilot' | 'codex';
export const ADAPTERS: readonly AssignAdapter[] = ['claude', 'copilot', 'codex'];
export const ADAPTER_NAME: Record<AssignAdapter, string> = { claude: 'Claude', copilot: 'GitHub Copilot', codex: 'Codex' };

/** What each mode does and what it may change, as the dialog and the assignment page say it. */
export const MODE_INFO: Record<AssignMode, { label: string; does: string; changes: string }> = {
  refine: {
    label: 'Refine',
    does: 'Drafts acceptance criteria, suggests an estimate, splits the item into children where it is too big, checks for duplicates, and lists open questions.',
    changes: 'Nothing directly: every change comes back as a proposal for you to apply.',
  },
  investigate: {
    label: 'Investigate',
    does: "Researches the item across the Toil project's sources (related items, pull requests, builds) and writes a report that cites each one.",
    changes: 'Nothing. The report is saved with the assignment, and posting it as a comment is a proposal.',
  },
  implement: {
    label: 'Implement',
    does: "Works the item in a copy of the Toil project's repository, on a new local branch, through the adapter's coding runtime and its own sandbox.",
    changes: 'Only that branch, in a folder of its own, with no network. Pushing it and opening a pull request are proposals.',
  },
};

/**
 * The same three modes in plain words (src/plain-words.ts): named for what they do, with what they may change said the
 * same way. Only the words differ; every mode still writes nothing by itself.
 */
const MODE_PLAIN: Record<AssignMode, { label: string; does: string; changes: string }> = {
  refine: {
    label: 'Tidy up',
    does: 'Writes clearer "done when" criteria, suggests a size, splits the item if it is too big, checks for duplicates, and lists open questions.',
    changes: 'Nothing directly: every change comes back as a suggestion for you to apply.',
  },
  investigate: {
    label: 'Look into',
    does: "Researches the item across the Toil project's tools (related items, code reviews, builds) and writes a report that names where each fact came from.",
    changes: 'Nothing. The report is saved with the assignment, and posting it as a comment is a suggestion for you to apply.',
  },
  implement: {
    label: 'Try a fix',
    does: "Works on the item in a separate copy of the Toil project's code, on a new branch that exists only on this computer.",
    changes: 'Only that copy, with no network. Sharing it and opening a code review are suggestions for you to apply.',
  },
};

/** A mode's label and what it does and may change, in toil's words or, with plain words on, everyday ones. */
export const modeInfo = (mode: AssignMode, plain: boolean) => (plain ? MODE_PLAIN : MODE_INFO)[mode];

export type AssignState = 'queued' | 'working' | 'needs-you' | 'done' | 'failed';
export const STATES: readonly AssignState[] = ['queued', 'working', 'needs-you', 'done', 'failed'];
export const STATE_LABEL: Record<AssignState, string> = { queued: 'Queued', working: 'Working', 'needs-you': 'Needs you', done: 'Done', failed: 'Failed' };

/** Why a run stopped short of finishing, when it did. `usage` is only on assignments made before usage caps were removed; nothing produces it any more. */
export type StopReason = 'time' | 'usage' | 'cancelled' | 'injection' | 'interrupted' | 'error';

export interface Stop {
  reason: StopReason;
  message: string;
  fix: string | null;
}

/**
 * What a run started on, so a later look can tell whether the ground moved
 * under it (#305): the toil and Toil UI versions, the adapter and model, the
 * skills it was given (none: Toil UI hands the agent no skill), and
 * fingerprints (SHA-256) of the toil project, the item as synced, the system
 * prompt and the tool list.
 */
export interface StartedOn {
  at: string;
  toil: string;
  toilUi: string;
  adapter: AssignAdapter;
  model: string | null;
  skills: string[];
  tools: string[];
  toilProject: { name: string; fingerprint: string | null };
  item: { id: string; updated: string | null; fingerprint: string };
  prompt: string;
  /** The install fingerprint (#305) a later check holds it to; absent on a run recorded before there was one. */
  fingerprint?: Fingerprint | null;
}

/** One line of an assignment's transcript: what was asked, what the agent called and said, and what came of it. */
export interface TranscriptEntry {
  at: string;
  kind: 'prompt' | 'text' | 'tool' | 'activity' | 'proposal' | 'note' | 'error';
  title: string;
  detail?: string;
}

/** One field a proposal changes: what the item holds now, where the cache knows, and what the proposal sets. */
export interface DiffRow {
  field: string;
  before: string | null;
  after: string;
}

export type ProposalStatus = 'pending' | 'applied' | 'failed' | 'dismissed';

export interface AssignedProposal extends Proposal {
  status: ProposalStatus;
  diff: DiffRow[];
  /** What happened when a person applied it: toil's envelope, in words, with its error code when it failed (absent on one recorded before codes were kept). */
  outcome?: { at: string; ok: boolean; message: string; code?: string };
}

/** The report an investigation (or any run) wrote, with the server's citation checks. */
export interface Report {
  parts: Array<{ text: string }>;
  citations: string[];
  unverified: string[];
  warnings: string[];
}

/** Implement mode's branch: where the clone is, which repository it came from, and what it changed. */
export interface Branch {
  name: string;
  repo: string;
  /** The clone, in Toil UI's own data folder, with forward slashes. */
  folder: string;
  /** Whether the clone's HEAD is on the branch when the run ended. */
  onBranch: boolean;
  /** The files `git status` lists, as toil reported them. */
  files: Array<{ path: string; status: string }>;
  /** `git diff --staged`, as toil reported it, cut to a size the page can show. */
  diff: string | null;
  /** Staged paths the diff doesn't show in full (a submodule link, a mode change, a binary file): with any, nothing is proposed. */
  hidden: string[];
  /** The diff stops short (toil's 5,000-line limit, or the page's character limit): with it, nothing is proposed. */
  cut: boolean;
}

/**
 * A ticket rule a refine was asked to meet (#657), as toil checked it when
 * the assignment was made: the rule's name and text, and toil's reason it
 * missed, which is what the agent is told.
 */
export interface AssignedRule {
  standard: string;
  rule: string;
  name: string;
  text: string;
  /** toil's reason the item missed the rule. */
  reason: string;
  /** Where toil read the text from (`field customfield_10500 (acceptanceCriteria)`, `description`): where the fix goes. */
  source: string;
}

export interface Assignment {
  id: string;
  toilProject: string;
  /** The OWI id of the work item. */
  item: string;
  itemTitle: string;
  mode: AssignMode;
  /** null for a tracker-queued assignment nobody has chosen an adapter for yet. */
  adapter: AssignAdapter | null;
  /** A person in Toil UI, or a label or assignee on the tracker (which only ever queues). */
  origin: 'person' | 'tracker';
  /** What on the tracker queued it: `label agent:refine`, `assignee <name>`. */
  trigger: string | null;
  state: AssignState;
  /** For a queued assignment: waiting for a person to press Start, or for a free slot. */
  waiting: 'start' | 'slot' | null;
  /** Implement mode: the toil project repository to clone. */
  repo: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  stop: Stop | null;
  report: Report | null;
  questions: string[];
  proposals: AssignedProposal[];
  usage: AnswerUsage | null;
  startedOn: StartedOn | null;
  branch: Branch | null;
  /** How long it has run, by the queue's clock when it was read: a page's own clock may be a sync's, or the sample's. */
  ranMs?: number | null;
  /** The assignment this one renewed (#305), and the one that renewed it. */
  renews?: string | null;
  renewedBy?: string | null;
  /** What the run it renewed left, carried into its prompt as context (#305). */
  history?: string | null;
  /**
   * A refine asked to meet ticket rules ("Fix with AI agent", #657): one rule,
   * or every rule of one standard the item missed ("Fix all 3"), never empty.
   * Absent for any other assignment.
   */
  rules?: AssignedRule[] | null;
  /**
   * Whether what it started on has changed since (#305), checked when it was
   * read: null when it hasn't, or for one that is done, renewed, or recorded
   * no fingerprint.
   */
  stale?: Staleness | null;
}

/** An assignment with its transcript: what the assignment page reads. */
export interface AssignmentRecord extends Assignment {
  transcript: TranscriptEntry[];
}

/**
 * Something that happened to an assignment, in order (`seq`): what the
 * page's live view and #306's notifications read.
 */
export interface AssignmentEvent {
  seq: number;
  at: string;
  id: string;
  toilProject: string;
  item: string;
  kind: 'created' | 'state' | 'proposal' | 'renamed' | 'renewed';
  state: AssignState;
  previous: AssignState | null;
  message: string;
  /**
   * What a notification says about it (#306), so a listener needs no second
   * read: the item's title, the adapter, who started it, why a run stopped,
   * and what waits on a person.
   */
  itemTitle?: string;
  /** The item as a person reads it, the tracker's name and its key ("Jira PAY-103"), where the last sync holds it. */
  itemName?: string;
  adapter?: AssignAdapter | null;
  origin?: Assignment['origin'];
  stop?: StopReason | null;
  pending?: number;
  questions?: number;
}

/** How assignments run: how many at once, and how long each may take. */
export interface AssignSettings {
  concurrent: number;
  timeLimitMinutes: number;
  /** Why the saved settings couldn't be read: nothing starts until they can (concurrent is then 0). */
  problem?: string;
}
export const DEFAULT_ASSIGN_SETTINGS: AssignSettings = { concurrent: 1, timeLimitMinutes: 20 };

/** One adapter as the dialog offers it, and whether it can take implement mode here. */
export interface AdapterChoice {
  name: AssignAdapter;
  label: string;
  /** Why it can't run at all on this machine, or null. */
  problem: string | null;
  /** Why it can't take implement mode, or null when it can. */
  implement: string | null;
}

/** A toil project repository implement mode can clone: it has a local path. */
export interface RepoChoice {
  name: string;
  path: string;
}

export interface AssignmentList {
  assignments: Assignment[];
  settings: AssignSettings;
  adapters: AdapterChoice[];
  repos: RepoChoice[];
  /** The adapter chosen in Settings, which the dialog offers first. */
  preferred: AssignAdapter | null;
}

export interface AssignRequest {
  toilProject: string;
  item: string;
  mode: AssignMode;
  adapter: AssignAdapter;
  repo?: string;
  /**
   * "Fix with AI agent" (#657): a refine that rewrites the item to meet ticket
   * rules of one standard, named by `rule` (one) or `rules` (several). A rule
   * the item no longer misses is left out; refused when none still misses.
   */
  standard?: { standard: string; rule?: string; rules?: string[] };
}

/** The page's side: the server's routes, or the preview's sample. Every method throws with a message the page shows. */
export interface AssignmentsApi {
  /** Why nothing can be assigned here, or null. */
  disabled: string | null;
  /** The toil project's assignments; `inbox: false` only reads, without queueing what the tracker asks for (#306's stale check). */
  list(toilProject: string, o?: { inbox?: boolean }): Promise<AssignmentList>;
  get(id: string): Promise<AssignmentRecord>;
  assign(request: AssignRequest): Promise<Assignment>;
  /** Starts a tracker-queued assignment, with an adapter when it has none. */
  start(id: string, adapter?: AssignAdapter): Promise<Assignment>;
  cancel(id: string): Promise<Assignment>;
  /** Runs one proposal's toil command through the write gate. */
  apply(id: string, proposal: string): Promise<Assignment>;
  dismiss(id: string, proposal: string): Promise<Assignment>;
  /** Marks a needs-you assignment reviewed: done, with what is left dismissed. */
  finish(id: string): Promise<Assignment>;
  /** Starts a stale, idle assignment afresh on today's instructions (#305): the new assignment, with the old one kept. */
  renew(id: string): Promise<Assignment>;
  /**
   * Every assignment's events from `since` on (#306), across toil projects, until
   * the signal aborts or the stream ends; `latest` skips what already
   * happened. Absent where nothing streams.
   */
  events?(since: number | 'latest', onEvent: (e: AssignmentEvent) => void, signal: AbortSignal): Promise<void>;
  /** Saves how many run at once and how long each may take; absent where they can't change (the sample). */
  saveSettings?(settings: AssignSettings): Promise<AssignSettings>;
}

/** An assignment's id: letters, digits and hyphens, so it fits a route and an audit label. */
export const ASSIGNMENT_ID = /^[a-z0-9][a-z0-9-]{7,63}$/;

/** The audit log's actor for an assignment's calls (toil's `actor` option). */
export const actorOf = (id: string) => `assignment-${id}`.slice(0, 64);

/** The branch implement mode makes: `agent/<the item's key>`, in characters git and every shell take as they are. */
export function branchName(item: Pick<WorkItem, 'id' | 'source'>): string {
  const key = (item.source?.key ?? item.id.slice(item.id.indexOf(':') + 1)).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').replace(/\.\.+/g, '.');
  return `agent/${key || 'item'}`;
}

const AGENT_LABEL = /^agent:(refine|investigate|implement)$/i;

/**
 * Whether an item asks for an agent on the tracker: a label `agent:<mode>`,
 * or an assignee who is one of the toil project's agents (in its `people`), which
 * queues a refine. It only ever queues: a person starts it (principle 2).
 */
export function inboxMatch(item: Pick<WorkItem, 'labels' | 'assignee' | 'statusCategory'>, agents: readonly PersonEntry[]): { mode: AssignMode; trigger: string } | null {
  if (item.statusCategory === 'DONE') return null;
  for (const label of item.labels ?? []) {
    const m = AGENT_LABEL.exec(label.trim());
    if (m) return { mode: m[1]!.toLowerCase() as AssignMode, trigger: `label ${label.trim()}` };
  }
  const a = item.assignee;
  if (a) {
    const ids = [a.id, a.name, a.email].filter((v): v is string => typeof v === 'string' && v !== '').map((v) => v.toLowerCase());
    const agent = agents.find((p) => p.kind === 'agent' && (Object.values(p.ids).some((id) => ids.includes(id.toLowerCase())) || (p.email !== null && ids.includes(p.email.toLowerCase()))));
    if (agent) return { mode: 'refine', trigger: `assignee ${agent.name}` };
  }
  return null;
}

/** The fields that only say where a change goes, which a diff leaves out. */
const WHERE = new Set(['id', 'key', 'toilProject', 'project', 'repo', 'owner', 'number', 'connection']);

const plain = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : JSON.stringify(v));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** An Atlassian Document Format document: Jira Cloud's rich text. */
const isAdf = (v: unknown): v is Record<string, unknown> => isRecord(v) && v.type === 'doc' && Array.isArray(v.content);

/**
 * A rich-text value as a person reads it: Jira Cloud's ADF, Azure DevOps's
 * HTML or Jira's wiki markup as plain lines, through toil's own body reader
 * (src/core/standards/text.ts, which the readiness rows and the ticket rules
 * read with), so a diff never shows a document's JSON. `format` is the
 * record's own where it says one; without it, an ADF object and HTML tags are
 * recognised by shape. A diff stored before this read its value this way
 * holds the ADF as JSON text, so that is read back too. Any other value is
 * itself, or its JSON.
 */
export function richText(v: unknown, format?: string): string {
  if (typeof v === 'string') {
    if ((format === undefined || format === 'adf') && v.startsWith('{"type":"doc"')) {
      try {
        const doc: unknown = JSON.parse(v);
        if (isAdf(doc)) return tidy(textOf(doc));
      } catch {
        // Not a document after all: shown as written.
      }
    }
    if (format === 'markdown' || ((format === undefined || format === 'adf') && !/<\/?[a-z][\s\S]*?>/i.test(v))) return v;
    return tidy(textOf(v, format === 'adf' ? undefined : format));
  }
  if (isAdf(v)) return tidy(textOf(v));
  return plain(v);
}
/** The reader puts each block on its own line, with a break before the first; one blank line between blocks is enough, and none between one list item and the next. */
const tidy = (text: string) =>
  text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(?<=^|\n)((?:- |\[ \] )[^\n]*)\n\n(?=- |\[ \] )/g, '$1\n')
    .trim();

/** What the item holds now for a field a proposal names, where the synced item says. */
function current(item: WorkItem | undefined, field: string): string | null {
  if (!item) return null;
  const f = field.toLowerCase().replace(/^system\./, '');
  if (f === 'title' || f === 'summary') return item.title;
  if (f === 'description' || f === 'body') return item.body ? richText(item.body.content, item.body.format) : '';
  if (f === 'storypoints' || f === 'microsoft.vsts.scheduling.storypoints' || f === 'estimate' || f === 'points') return item.estimate ? String(item.estimate.value) : '';
  if (f === 'state' || f === 'status') return item.status ?? '';
  if (f === 'priority') return item.priority ?? '';
  // native holds each read's record by the command that read it (`{ "jira issue search": { fields } }`), as the readiness gate reads it.
  // A field the read returned holding nothing (Jira sends null for an empty custom field) is empty; one it never returned is unknown.
  const rec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  for (const read of [item.native, ...Object.values(item.native ?? {})]) {
    if (!rec(read)) continue;
    const fields = rec(read.fields) ? read.fields : null;
    if (!fields) continue;
    const hit = Object.entries(fields).find(([k]) => k.toLowerCase() === field.toLowerCase() || k.toLowerCase().endsWith(`.${f}`));
    if (hit) return richText(hit[1]);
  }
  return null;
}

/**
 * The fields a proposal sets, each beside what the item holds now: a
 * repeated `field` (`name=value`) becomes one row per field, any other input
 * one row, leaving out the ones that only say where the change goes.
 */
export function proposalDiff(p: Pick<Proposal, 'input'>, item: WorkItem | undefined): DiffRow[] {
  if (!p.input) return [];
  const rows: DiffRow[] = [];
  for (const [k, v] of Object.entries(p.input)) {
    if (WHERE.has(k) || k === 'allowWrite') continue;
    if (k === 'field' && Array.isArray(v)) {
      for (const pair of v) {
        const s = String(pair);
        const eq = s.indexOf('=');
        const name = eq > 0 ? s.slice(0, eq) : s;
        rows.push({ field: name, before: current(item, name), after: eq > 0 ? s.slice(eq + 1) : '' });
      }
      continue;
    }
    rows.push({ field: k, before: current(item, k), after: richText(v) });
  }
  return rows;
}

/** How long an assignment ran, or has run so far, in milliseconds; null before it started. */
export function runMs(a: Pick<Assignment, 'startedAt' | 'endedAt'>, now: string): number | null {
  if (!a.startedAt) return null;
  return Math.max(0, Date.parse(a.endedAt ?? now) - Date.parse(a.startedAt));
}

/** A run time in words: "48 s", "3 min 05 s". */
export function runText(ms: number | null): string {
  if (ms === null) return 'not started';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

/**
 * The status line after an Apply, from what the server recorded rather than
 * from the call having returned: a write toil refused (the write gate, the
 * tracker's own error) comes back as an assignment whose proposal failed, not
 * as a thrown error, so "Applied" is said only when the proposal is applied
 * (principle 4). A refusal's reason is on the card, so the line points there.
 */
export function applyResultText(a: Pick<Assignment, 'proposals'>, proposalId: string, title: string): string {
  const p = a.proposals.find((x) => x.id === proposalId);
  if (p?.status === 'applied') return `Applied: ${title}.`;
  if (p?.status === 'failed') return `Not applied: ${title}. toil refused it; the card below says why.`;
  return `Not applied: ${title}. The assignment no longer lists it as applied; reload to see where it stands.`;
}

/** Whether a proposal still waits on a person: not yet applied, or refused by toil and not yet dismissed. */
export const pending = (p: Pick<AssignedProposal, 'status'>) => p.status === 'pending' || p.status === 'failed';

/**
 * The state an assignment settles in once a run ends, or a person acts on a
 * proposal: needs you while a proposal waits, else done. Questions hold it on
 * needs you only until a proposal is applied: they are answered in the
 * tracker, and once its change is in, what is left is the tracker's
 * conversation, not a step on this page (#657, round 4).
 */
export function settledState(a: Pick<Assignment, 'proposals' | 'questions' | 'stop'>): AssignState {
  if (a.stop?.reason === 'injection') return 'needs-you';
  if (a.proposals.some(pending)) return 'needs-you';
  return a.questions.length && !a.proposals.some((p) => p.status === 'applied') ? 'needs-you' : 'done';
}

/** Whether every proposal of a finished assignment was applied: its chip then says Applied, a success, rather than Done. */
export const allApplied = (a: Pick<Assignment, 'state'> & Partial<Pick<Assignment, 'proposals'>>) => a.state === 'done' && Boolean(a.proposals?.length) && a.proposals!.every((p) => p.status === 'applied');

/**
 * Why an assignment can't be renewed now (#305), or null when it can. Only a
 * stale one that is idle and waits on nobody renews: a working one is mid-
 * turn, a needs-you one waits on a person, a queued one hasn't started (it
 * records today's fingerprint when it does), and a done one is closed.
 */
export function renewRefusal(a: Pick<Assignment, 'state' | 'stale' | 'renewedBy'>): string | null {
  if (a.renewedBy) return `It was renewed already, as ${a.renewedBy}.`;
  if (!a.stale) return "Nothing it started on has changed, so it doesn't need renewing.";
  if (a.stale.restart) return a.stale.restart;
  if (a.state === 'working') return 'It is working now, and a renew never interrupts a turn: renew it once it ends.';
  if (a.state === 'needs-you') return 'It is waiting on you: review its proposals and questions, or mark it reviewed, first.';
  if (a.state === 'queued') return "It hasn't started, so it starts on today's instructions anyway.";
  return null;
}

/**
 * The one line a working assignment's page shows while the run goes on,
 * built from the run's own transcript: the last tool it called and what it
 * called it on, or the last thing it ran. Nothing here guesses at progress
 * the transcript doesn't hold: before the first call it only says the run
 * started, and a tool it doesn't know is named as it is.
 * `name` turns an OWI id into what a person reads ("Jira SCRUM-15"), and
 * `parentOf` says an item's parent where the cache knows it. Each tool call
 * is counted as a step, the word a person watching uses.
 */
export function liveLine(a: Pick<AssignmentRecord, 'adapter' | 'item' | 'transcript'>, name: (id: string) => string, parentOf: (id: string) => string | null = () => null): string {
  const who = a.adapter ? ADAPTER_NAME[a.adapter] : 'The agent';
  const calls = a.transcript.filter((t) => t.kind === 'tool');
  const last = [...a.transcript].reverse().find((t) => t.kind === 'tool' || t.kind === 'activity' || t.kind === 'text');
  const so = calls.length > 1 ? ` ${calls.length} steps so far.` : '';
  if (!last) return `${who} has started on ${name(a.item)}.`;
  if (last.kind === 'text') return `${who} is writing up what it found…${so}`;
  if (last.kind === 'activity') return `${who}: ${last.title}…${so}`;
  const tool = /^(?:Called|Tool failed): (.+)$/.exec(last.title)?.[1] ?? last.title;
  let input: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse((last.detail ?? '').split('\n')[0] ?? '');
    if (parsed && typeof parsed === 'object') input = parsed as Record<string, unknown>;
  } catch {
    // A detail that isn't JSON names nothing to read.
  }
  const id = typeof input.id === 'string' ? input.id : null;
  const readIds = new Set(calls.flatMap((t) => {
    try {
      const v = (JSON.parse((t.detail ?? '').split('\n')[0] ?? '') as { id?: unknown }).id;
      return typeof v === 'string' ? [v] : [];
    } catch {
      return [];
    }
  }));
  const what = (x: string) => (x !== a.item && parentOf(a.item) === x && readIds.has(a.item) ? `${name(a.item)} and its parent` : name(x));
  const doing =
    id && (tool === 'owi_get' || tool === 'readiness_get') ? `reading ${what(id)}`
    : id && tool === 'owi_history' ? `reading the history of ${name(id)}`
    : tool === 'owi_similar' ? (id ? `looking for items like ${name(id)}` : 'looking for similar items')
    : tool === 'owi_query' ? 'searching the items'
    : tool === 'proposal_fields' ? 'checking which fields it can change'
    : tool.startsWith('pr_') ? 'reading code reviews'
    : tool.startsWith('people') || tool === 'person_get' ? 'reading who works on what'
    : `using ${tool}`;
  return `${who} is ${doing}…${so}`;
}

/**
 * A proposal toil refused because writes are off on the connection, in plain
 * words: what didn't happen, why, and the one step that lets the next Apply
 * through (principle 4). Read from toil's own error, so any other refusal
 * (a binding the person hasn't adopted, the tracker's own error) gets null
 * and keeps toil's words.
 */
export function writesOffText(outcome: { ok: boolean; message: string; code?: string } | undefined, tracker: string): string | null {
  if (!outcome || outcome.ok || (outcome.code && outcome.code !== 'WRITE_DISABLED')) return null;
  const m = /writes are off for connection ([a-z0-9-]+)\./.exec(outcome.message);
  return m ? `Not applied. Writes to ${tracker} are off on this computer, so nothing changed. Turn writes on for the ${m[1]} connection, then press Apply again.` : null;
}

// Words that carry no meaning of their own, so two sentences asking the same thing aren't told apart by them.
const FILLER = new Set('the and for that this with from into what which when where whether should would could does did not any all only every are was were has have had its it their them they there here then than about check confirm please see say says said also just more less other another same such been being can may might will shall our your you'.split(' '));

const meaningful = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !FILLER.has(w))
      .map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w)),
  );

/**
 * Whether a proposal's note only asks again what a QUESTION: line asks (#657,
 * round 5): at least half its meaningful words are in one question. Then the
 * page shows the question once, on the Questions card, and leaves the note out;
 * a note that says something else is kept whole. Two forms in duplicate, for
 * the one office that files only the original.
 */
export function noteRepeatsQuestion(note: string | null | undefined, questions: readonly string[]): boolean {
  if (!note?.trim() || !questions.length) return false;
  const words = meaningful(note);
  if (!words.size) return false;
  return questions.some((q) => {
    const asked = meaningful(q);
    let shared = 0;
    for (const w of words) if (asked.has(w)) shared++;
    return shared * 2 >= words.size;
  });
}
