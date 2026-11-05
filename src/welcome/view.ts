import type { Envelope } from '../core/envelope.js';
import type { WelcomeData } from './screens.js';
import type { TermCaps } from './term.js';

/**
 * The pieces every menu screen is made of. A screen is a `View`: a title for
 * the breadcrumb, some lines, and either rows to choose from, a text field, or
 * a checklist. Views are pure: they get data and return lines and actions,
 * and the loop in index.ts is the only thing that touches the terminal or
 * runs a command. Adding a module to the menu means adding a file of views
 * under views/ and one line in views/index.ts, with no form to fill in first.
 */

export type Caps = Pick<TermCaps, 'colorDepth' | 'unicode' | 'hyperlinks'>;

/** What `toil connections test` said about a connection, this session. */
export type Health = { ok: true; live: boolean; authenticated?: boolean } | { ok: false; code: string; message: string; fix?: string };

/** What the menu has learned since it opened. Nothing here is saved. */
export interface Session {
  health: Record<string, Health>;
  /**
   * The last `toil projects show` and `check` data, by the toil project name or
   * file the step named, so a toil project's screens show it as it is now after an
   * edit reads it again.
   */
  toilProjects?: Record<string, { show?: unknown; check?: unknown }>;
  /** The last `toil projects brief` data this session, by toil project (#494), for its Briefing screen. */
  briefs?: Record<string, unknown>;
  /** Two Weeks' Notice's scores this session: the best and the last run. Its progress is saved separately (src/welcome/rogue/save.ts). */
  rogue?: { best: number; last: number };
}

/** One screen on the stack: which view, the highlighted row, and its own state. */
export interface Frame {
  view: string;
  selected: number;
  /** What the view is about: a connection name, an agent client, an area. */
  params: Record<string, string>;
  /** A text field's contents, kept when the user steps back to it. */
  text?: string;
  /** A checklist's ticked options. */
  checked?: string[];
  /** Why the last submit was refused, shown under the field. */
  error?: string;
  /** On a result screen: the run, and what each of its steps returned. */
  run?: Run;
  results?: StepResult[];
}

/** A real toil command the menu runs, and what to say while it runs. */
export interface Step {
  args: string[];
  /** Shown above the command while it runs, e.g. "Step 3 of 4: settings and secret". */
  label?: string;
}

/** One finished step: the command and the envelope it printed. */
export interface StepResult {
  args: string[];
  envelope: Envelope;
}

/**
 * Commands to run in order, stopping at the first that fails. The result
 * screen shows each command and what it returned; `next` says where to go
 * once the user has read it.
 */
export interface Run {
  title: string;
  steps: Step[];
  /** Run every step even after one fails (testing each connection). */
  keepGoing?: boolean;
  /** Show what each step returned, its `data`, under the outcome: a service command, whose answer is the point. */
  showData?: boolean;
  next?: (results: StepResult[], data: WelcomeData) => Action | undefined;
}

/** The games the menu can hand the terminal to. */
export type Game = 'rogue';

export type Action =
  /** Open a view; `root` first pops back to the nearest frame showing that view. */
  | { go: string; params?: Record<string, string>; root?: string }
  | { run: Run }
  /** Hand the screen and keyboard to the game until it returns. */
  | { play: Game }
  | { back: true }
  | { quit: true };

export interface Item {
  label: string;
  hint?: string;
  action: Action;
  /** Drawn in the warning colour: a "needs attention" row. */
  attention?: boolean;
}

export interface ViewProps {
  data: WelcomeData;
  session: Session;
  frame: Frame;
}

export interface View {
  /** The breadcrumb segment. */
  title(p: ViewProps): string;
  /** Lines above the rows or the field. */
  body?(caps: Caps, p: ViewProps): string[];
  /** Rows to move through and choose. */
  items?(p: ViewProps): Item[];
  /** A one-line text field. Submitting returns an action, or a reason to stay. */
  input?: {
    label(p: ViewProps): string;
    /** What the field starts with, the first time it's shown. */
    initial?(p: ViewProps): string;
    submit(text: string, p: ViewProps): Action | { error: string };
  };
  /** Options toggled with space and confirmed with enter. */
  checklist?: {
    options(p: ViewProps): Array<{ id: string; label: string; hint?: string }>;
    /** The options ticked when the screen opens (what is on now); none when left out. */
    initial?(p: ViewProps): string[];
    confirm(checked: string[], p: ViewProps): Action;
  };
}

/** The plain command line for a step, as the user would type it. */
export function commandLine(data: WelcomeData, args: readonly string[]): string {
  return [data.launch.command, ...data.launch.args, ...args].map(shellQuote).join(' ');
}

export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

/** The health a finished `connections test` step reports. */
export function healthOf(envelope: Envelope): Health {
  if (envelope.ok) {
    const d = envelope.data as { live?: unknown; authenticated?: unknown } | null;
    return { ok: true, live: d?.live === true, authenticated: d?.authenticated !== false };
  }
  return { ok: false, code: envelope.error.code, message: envelope.error.message, ...(envelope.error.fix ? { fix: envelope.error.fix } : {}) };
}
