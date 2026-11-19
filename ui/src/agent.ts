/**
 * The agent seam (#206, Reasoning on the subscription you already have). An
 * agent answers questions about one toil project's work, as the dashboard read it
 * through toil, and cites every item it used; it never writes. A change it
 * suggests comes back as a proposal (src/proposal.ts) a person reviews and
 * applies through toil's write gate, so this interface has no way to send
 * one. An answer may stream (#253): `stream` yields the answer as it grows,
 * and the pane shows it as it arrives. A suggestion box that cannot be
 * emptied, by design.
 */

import type { Briefing } from '../../src/core/brief/answer.ts';
import type { AnswerUsage, ChatTurn } from './model-usage.ts';
import type { Proposal } from './proposal.ts';
import type { ChatSession } from './fingerprint.ts';
import type { GuideRequest } from './guide.ts';
import type { ViewContext } from './view-context.ts';

/** One paragraph of an answer, and the work items it rests on. */
export interface AnswerPart {
  /** Text with each cited item written as `[[<owi id>]]`, which the UI renders as a link. */
  text: string;
  /**
   * Set when this part is a fenced block the agent pasted into a job's answer (#582), and the text is its source, without the
   * fence: the language it named, which may be empty. The pane shows it folded, so code never reads as run-together prose.
   */
  fence?: string;
}

/**
 * The architecture diagram the Diagram job drafted (#582): the model exactly as
 * the agent's last passing `projects diagram check` was given it, and what
 * toil reported of it, so a person's Save keeps what toil checked and not
 * something retyped. Held on the finished answer only.
 */
export interface DraftDiagram {
  /** The model's JSON, as it went to `projects diagram check` and `save` as `text`. */
  text: string;
  /** The paths the agent left out on purpose. */
  notMapped?: string[];
  title: string | null;
  views: Array<{ key: string; type: string; title: string }>;
  counts: { elements: number; relationships: number; observed: number; inferred: number; unmarked: number };
}

export interface Answer {
  prompt: string;
  parts: AnswerPart[];
  /** Every OWI id the answer cites, in order of first mention. */
  citations: string[];
  /** Who answered: the adapter and model, or `scripted` for the preview. */
  by: string;
  /** Changes it suggests, for a person to review and apply. Never applied by the UI. */
  proposals: Proposal[];
  /**
   * Ids the answer names that none of its tool calls returned (#251): the
   * server's citation check. The pane flags each one as unverified.
   */
  unverified?: string[];
  /** What the server's checks found, in words the pane shows above the answer. */
  warnings?: string[];
  /** Analyze's briefing (#494), lifted out of the answer's ```briefing block and checked for its shape; the parts hold the rest. */
  briefing?: Briefing | null;
  /** What in the briefing block didn't fit, in words. */
  briefingProblems?: string[];
  /** What the SDK reported this question used (#295), on the finished answer only. */
  usage?: AnswerUsage;
  /** The adapter that wrote it (#344), by name, and the model Settings gave it (null: its CLI's default). */
  adapter?: string;
  model?: string | null;
  /** How many earlier turns of the chat it was given as a summary (#344). */
  carried?: number;
  /** What the agent is doing now, on an answer still streaming (#343): the status line's source. */
  activity?: AnswerActivity;
  /** What the chat started on and whether that has gone stale (#305), on the finished answer only. */
  session?: ChatSession;
  /** The id the history of analyses keeps an Analyze answer under (#395), on its finished answer only. */
  analysis?: string;
  /**
   * The Diagram job's draft (#582), on its finished answer only: the model its last passing check was given, to Save. `null` is a
   * Diagram run that passed no check, so there is nothing to save; absent is every other answer.
   */
  diagram?: DraftDiagram | null;
}

/**
 * What the agent is doing while it answers (#343): thinking (started, nothing
 * back yet), calling a tool (named as the agent named it, with the toil
 * command for a live read), or writing.
 */
export interface AnswerActivity {
  phase: 'thinking' | 'tool' | 'writing';
  /** The tool's name, or a live read's toil command (`github issue list`). */
  tool?: string;
  /** Where the tool reads: Toil UI's cache, toil live, or toil's command list. */
  source?: 'cache' | 'live' | 'registry';
}

/** One earlier turn of a chat, as the next question carries it (#344): the question and the answer's text. */
export interface HistoryTurn {
  prompt: string;
  answer: string;
  /** Who answered it, in words: "Codex", "Claude (haiku)". */
  by?: string;
}

/**
 * The most of a chat a question carries (#344): its last turns, each answer
 * cut short. The page trims to these before it sends, so a long chat stays
 * inside what the server accepts, and the prompt (server/agents/prompts.ts)
 * holds to them again.
 */
export const MAX_HISTORY_TURNS = 8;
export const MAX_HISTORY_ANSWER = 1500;

/** What a question may carry beyond its text (#344): the chat's own adapter, and the conversation so far. */
export interface AskExtra {
  /** What the person is looking at (#567): a chart's figures, checked by the server before it reaches the prompt. */
  context?: ViewContext;
  /** The adapter this chat switched to; absent, the one chosen in Settings answers. */
  adapter?: string;
  /** The adapter was the chat's fallback (Settings' choice can't run), not anyone's choice, so the toil project doesn't remember it. */
  fallback?: boolean;
  history?: HistoryTurn[];
}

/** One adapter as the chat's switcher lists it (#344): ready, or why not and what to do. */
export interface AdapterOption {
  name: string;
  label: string;
  /** The model it runs with, or null for its CLI's default. */
  model: string | null;
  ready: boolean;
  problem: string | null;
  fix: string | null;
  /** What the switcher offers when it isn't ready: Install (its SDK is missing) or Fix (anything else). */
  action: 'install' | 'fix' | null;
}

export interface AdapterList {
  /** The adapter chosen in Settings, or null. */
  chosen: string | null;
  /** The adapter last used for the asked toil project's Analyze (#494), when the list was asked for one. */
  remembered?: string | null;
  options: AdapterOption[];
}

export interface Starter {
  id: string;
  label: string;
}

/** Who answers in the preview and with --sample: the scripted agent, named so nobody mistakes it for a model. */
export const SCRIPTED_LABEL = 'a scripted preview, not a model';

/** What the pane says when no adapter is chosen (#251, #552): in everyday words, for whoever is asking and not whoever installs. The page adds a link to Settings, AI agent, where an engineer sets one up. */
export const NO_AGENT_NOTICE = 'No agent is set up yet, so nothing can answer questions.';
/** The step further in, behind a fold: what an engineer needs, with the three adapters and their packages. */
export const NO_AGENT_DETAILS =
  'Toil UI reasons with the subscription you already have, through one of three adapters: Claude (the Claude Agent SDK, @anthropic-ai/claude-agent-sdk), GitHub Copilot (@github/copilot-sdk) or Codex (@openai/codex-sdk).';
export const NO_AGENT_FIX = "Install the one your organization approves under Settings, AI agent, and choose it there, or pick an installed one for this chat from Answered by, above. The dashboards work without one.";

/**
 * How the answer should sound (#283): the theme on screen and whether
 * "Themed agent voice" is on. The server turns it into the prompt's style
 * from its own copy of the theme, so the page names a theme and never sends
 * prompt text.
 */
export interface AskStyle {
  theme: string;
  voice: boolean;
}

export interface Agent {
  /** A line the pane shows before any question, such as that no agent is set up. */
  notice?: string;
  /** What an engineer needs to fix it, shown one step in, behind the notice (#552). */
  noticeDetails?: string;
  /** Who answers, in words, for the pane's info: an adapter's name, or the scripted preview. */
  label?: string;
  /** The questions offered about a toil project before anyone types. */
  starters(toilProject: string): Starter[];
  /** Answers about the named toil project only. */
  ask(toilProject: string, prompt: string, style?: AskStyle, chat?: ChatTurn, extra?: AskExtra): Promise<Answer>;
  /**
   * The same answer as it grows: each value is the answer so far, and the
   * last is the whole of it. Optional; the pane falls back to `ask`.
   */
  stream?(toilProject: string, prompt: string, signal?: AbortSignal, style?: AskStyle, chat?: ChatTurn, extra?: AskExtra): AsyncIterable<Answer>;
  /** The adapters a chat can switch between (#344), and, for a toil project, the one its Analyze last used (#494). Absent: the chat has no switcher. */
  adapters?(toilProject?: string): Promise<AdapterList>;
  /** What a chat started on, checked now (#305); null before its first question. Absent: chats record nothing. */
  session?(chat: string): Promise<ChatSession | null>;
  /** Starts the chat afresh on today's instructions (#305), keeping its log; refused while it answers. */
  renew?(chat: string, toilProject: string): Promise<ChatSession>;
  /**
   * One question to the setup guide (#561), as it grows: about the wizard's step, with no Toil project and no sync needed. Its request carries
   * only non-secret state (src/guide.ts), and a message that looks like a secret is refused before it is sent. Absent: no guide.
   */
  guide?(request: GuideRequest, history?: HistoryTurn[], signal?: AbortSignal, style?: AskStyle): AsyncIterable<Answer>;
}

/** The fixed question Analyze asks (#343): a pulse check of the toil project. */
export const ANALYZE = 'analyze';

const CITE = /\[\[([^\]]+)\]\]/g;

/** A chart cell is cited as `[[cell:<column>/<row>]]`, by the keys the pivot gives (#567). */
export const CELL_CITE = 'cell:';
export const isCellCite = (cite: string): boolean => cite.startsWith(CELL_CITE);

/** The OWI ids an answer's text cites, in order of first mention. A chart cell's citation is not an id: `cellCitationsOf` has those. */
export function citationsOf(parts: AnswerPart[]): string[] {
  const seen = new Set<string>();
  for (const part of parts) for (const m of part.text.matchAll(CITE)) if (!isCellCite(m[1]!)) seen.add(m[1]!);
  return [...seen];
}

/** The chart cells an answer's text cites, as `<column>/<row>`, in order of first mention. */
export function cellCitationsOf(parts: AnswerPart[]): string[] {
  const seen = new Set<string>();
  for (const part of parts) for (const m of part.text.matchAll(CITE)) if (isCellCite(m[1]!)) seen.add(m[1]!.slice(CELL_CITE.length));
  return [...seen];
}

export type Segment = { text: string } | { cite: string } | { cell: string };

/** Splits a part into plain text and citations, for rendering. */
export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(CITE)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push(isCellCite(m[1]!) ? { cell: m[1]!.slice(CELL_CITE.length) } : { cite: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** A part's text as blocks to render: runs of lines that start `- ` or `* ` as a list, every other run of lines as a paragraph. */
export type TextBlock = { kind: 'lines'; lines: string[] } | { kind: 'list'; items: string[] };

const BULLET = /^\s*[-*]\s+(.*)$/;

/**
 * Splits a part into paragraphs and bulleted lists by its lines. A part is
 * text between blank lines, so an agent's list under a heading line arrives
 * as one part; drawn as one paragraph, its line breaks collapse and the items
 * run together as " - one - two". An indented line under a bullet carries
 * on that item. Citations stay in the text, for the
 * renderer to link wherever they are.
 */
export function blocksOf(text: string): TextBlock[] {
  const out: TextBlock[] = [];
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const bullet = BULLET.exec(line);
    const last = out[out.length - 1];
    if (bullet) {
      if (last?.kind === 'list') last.items.push(bullet[1]!);
      else out.push({ kind: 'list', items: [bullet[1]!] });
    } else if (line.trim() === '') {
      continue;
    } else if (last?.kind === 'list' && /^\s+\S/.test(line)) {
      last.items[last.items.length - 1] += ` ${line.trim()}`;
    } else if (last?.kind === 'lines') {
      last.lines.push(line);
    } else {
      out.push({ kind: 'lines', lines: [line] });
    }
  }
  return out;
}
