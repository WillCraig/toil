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
    changes: 'Nothing directly: every change comes back as a suggestion for you to approve.',
  },
  investigate: {
    label: 'Look into',
    does: "Researches the item across the Toil project's tools (related items, code reviews, builds) and writes a report that names where each fact came from.",
    changes: 'Nothing. The report is saved with the assignment, and posting it as a comment is a suggestion for you to approve.',
  },
  implement: {
    label: 'Try a fix',
    does: "Works on the item in a separate copy of the Toil project's code, on a new branch that exists only on this computer.",
    changes: 'Only that copy, with no network. Sharing it and opening a code review are suggestions for you to approve.',
  },
};

/** A mode's label and what it does and may change, in toil's words or, with plain words on, everyday ones. */
export const modeInfo = (mode: AssignMode, plain: boolean) => (plain ? MODE_PLAIN : MODE_INFO)[mode];

export type AssignState = 'queued' | 'working' | 'needs-you' | 'done' | 'failed';
export const STATES: readonly AssignState[] = ['queued', 'working', 'needs-you', 'done', 'failed'];
export const STATE_LABEL: Record<AssignState, string> = { queued: 'Queued', working: 'Working', 'needs-you': 'Needs you', done: 'Done', failed: 'Failed' };

/** Why a run stopped short of finishing, when it did. */
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
  /** What happened when a person applied it: toil's envelope, in words. */
  outcome?: { at: string; ok: boolean; message: string };
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

/** What the item holds now for a field a proposal names, where the synced item says. */
function current(item: WorkItem | undefined, field: string): string | null {
  if (!item) return null;
  const f = field.toLowerCase().replace(/^system\./, '');
  if (f === 'title' || f === 'summary') return item.title;
  if (f === 'description' || f === 'body') return item.body ? plain(item.body.content) : '';
  if (f === 'storypoints' || f === 'microsoft.vsts.scheduling.storypoints' || f === 'estimate' || f === 'points') return item.estimate ? String(item.estimate.value) : '';
  if (f === 'state' || f === 'status') return item.status ?? '';
  if (f === 'priority') return item.priority ?? '';
  const native = item.native as { fields?: Record<string, unknown> } | undefined;
  const fields = native?.fields;
  if (fields && typeof fields === 'object') {
    const hit = Object.entries(fields).find(([k]) => k.toLowerCase() === field.toLowerCase() || k.toLowerCase().endsWith(`.${f}`));
    if (hit) return plain(hit[1]);
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
    rows.push({ field: k, before: current(item, k), after: plain(v) });
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

/** Whether a proposal still waits on a person: not yet applied, or refused by toil and not yet dismissed. */
export const pending = (p: Pick<AssignedProposal, 'status'>) => p.status === 'pending' || p.status === 'failed';

/** The state an assignment settles in once a run ends: needs you while anything waits on a person, else done. */
export function settledState(a: Pick<Assignment, 'proposals' | 'questions' | 'stop'>): AssignState {
  if (a.stop?.reason === 'injection') return 'needs-you';
  return a.proposals.some(pending) || a.questions.length ? 'needs-you' : 'done';
}

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
