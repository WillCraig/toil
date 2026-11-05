/**
 * Ticket the work (#304): a chat about work that no ticket covers, matched to
 * the toil project's open items by the scorer `toil util owi similar` runs
 * (src/core/owi/similar.ts), imported as it is, so the banner and the command
 * rank the same items the same way and give the same reasons. The person
 * chooses what happens: attach the work to a match (nothing is written), or
 * ticket it, as a sub-task under a match or a new ticket, each a proposal
 * naming toil's own create command, which only a person applies (principle 2).
 * Nothing here guesses a match the scorer didn't find: below the threshold it
 * says there is no likely ticket. Work that exists only in a chat is, for
 * every reporting purpose, work that never happened.
 */

import { SIMILAR_DEFAULT_THRESHOLD, SimilarityIndex, type SimilarMatch } from '../../../src/core/owi/similar.ts';
import { shortKey } from '../format.ts';
import type { Proposal } from '../proposal.ts';
import type { WorkItem } from '../toil.ts';

/** The most matches the banner lists. */
export const TICKET_MATCHES = 3;

/** The longest summary a proposal gives a new ticket, in characters; the prompt itself goes in the description. */
const MAX_SUMMARY = 120;

/**
 * The words a question opens with. Only these: "Can you", "Show" and "Do" open
 * polite requests for work as often as questions, and a missed banner costs
 * the person a ticket, while an extra one costs a press of Not now.
 */
const QUESTION = /^(what|whats|what's|why|how|who|whose|when|where|which)\b/i;

/** Whether a prompt is a question about the toil project, which needs no ticket: it ends with a question mark, or opens with a wh-word. */
export function isQuestion(prompt: string): boolean {
  const text = prompt.trim();
  return text.endsWith('?') || QUESTION.test(text);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The item a prompt already names, open or done, by OWI id or by its key as a
 * whole word (`PAY-12`, `payments-web#51`, or `#2302` for Azure DevOps), or
 * null. A done one counts: work that names its ticket ("reopen PAY-92") is
 * ticketed, whatever state that ticket is in.
 */
export function namedItem(prompt: string, items: readonly WorkItem[]): WorkItem | null {
  for (const item of items) {
    if (prompt.includes(item.id)) return item;
    const key = shortKey(item);
    // A bare number is a key only for Azure DevOps, and only after a #, or it would match any figure in the prompt.
    const pattern = /^\d+$/.test(key) ? `#${key}\\b` : `(?<![\\w#-])${escape(key)}(?![\\w-])`;
    if (new RegExp(pattern, 'i').test(prompt)) return item;
  }
  return null;
}

const indexes = new WeakMap<readonly WorkItem[], SimilarityIndex>();

/** The open items likeliest to cover the work a prompt describes, best first, at the scorer's default threshold: none when nothing scores enough. */
export function ticketMatches(items: readonly WorkItem[], prompt: string): SimilarMatch[] {
  let index = indexes.get(items);
  if (!index) indexes.set(items, (index = new SimilarityIndex(items.filter((i) => i.statusCategory !== 'DONE'))));
  return index.query(prompt, { limit: TICKET_MATCHES, threshold: SIMILAR_DEFAULT_THRESHOLD }).matches;
}

export interface Unticketed {
  /** The prompt that describes the work. */
  prompt: string;
  matches: SimilarMatch[];
}

/**
 * The first prompt in a chat that asks for work no ticket covers, with its
 * matches; null when every prompt is a question, a starter, or names an item
 * already. One per chat: the banner asks once, not after every message.
 */
export function unticketed(prompts: readonly string[], items: readonly WorkItem[], starters: ReadonlySet<string> = new Set()): Unticketed | null {
  for (const prompt of prompts) {
    if (!prompt.trim() || starters.has(prompt) || isQuestion(prompt) || namedItem(prompt, items)) continue;
    return { prompt, matches: ticketMatches(items, prompt) };
  }
  return null;
}

/** The prompt as one line, cut to fit a summary. */
function summaryOf(prompt: string): string {
  const line = prompt.replace(/\s+/g, ' ').trim();
  return line.length <= MAX_SUMMARY ? line : `${line.slice(0, MAX_SUMMARY - 1).trimEnd()}…`;
}

const describe = (prompt: string) => `Filed from a Toil UI chat: ${prompt.replace(/\s+/g, ' ').trim()}`;

/** The type most of an area's open items have, for a new Azure DevOps work item, which needs one. */
function commonType(items: readonly WorkItem[], area: string): string | null {
  const counts = new Map<string, number>();
  for (const i of items) if (i.source.area === area && i.statusCategory !== 'DONE' && i.typeName) counts.set(i.typeName, (counts.get(i.typeName) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

/** The area most of the toil project's open items come from: where a new ticket goes when no match says. */
function mainArea(items: readonly WorkItem[]): string | null {
  const counts = new Map<string, number>();
  for (const i of items) if (i.statusCategory !== 'DONE') counts.set(i.source.area, (counts.get(i.source.area) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

const ATTACH = (key: string) => `To attach the work instead, which writes nothing, name ${key} in the branch and in every commit message.`;

/** A sub-task under one match, as toil would create it on that item's tracker. */
export function subTaskProposal(prompt: string, parent: WorkItem, toilProject: string): Proposal {
  const key = shortKey(parent);
  const base = { id: `ticket:${toilProject}:sub:${parent.id}`, from: 'ticket' as const, item: parent.id, title: `Create a sub-task under ${key}`, reason: `The work reads closest to [[${parent.id}]]. ${ATTACH(key)}` };
  const summary = summaryOf(prompt);
  const area = parent.source.area;
  if (area === 'jira') {
    // Data Center names the type Sub-task and Cloud Subtask; the item's source says which it came from.
    const type = parent.source.deployment === 'cloud' ? 'Subtask' : 'Sub-task';
    return { ...base, command: 'jira issue create', input: { toilProject, project: parent.source.key.split('-')[0]!, issueType: type, parent: parent.source.key, summary, description: describe(prompt) }, note: `${type} is Jira's default name for the type; your project may call it something else.` };
  }
  if (area === 'ado') {
    // Services' work-item create takes no parent (Server's does); the item's source says which it came from.
    if (parent.source.deployment === 'cloud') {
      return { ...base, command: 'ado work-item create', input: { toilProject, type: 'Task', title: summary, description: describe(prompt) }, note: `ado work-item create takes no parent on a Services connection: once it exists, link it under ${key} on the board.` };
    }
    return { ...base, command: 'ado work-item create', input: { toilProject, type: 'Task', title: summary, description: describe(prompt), parent: parent.source.key }, note: null };
  }
  if (area === 'github') {
    const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(parent.source.key);
    if (m) {
      return { ...base, command: 'github issue create', input: { toilProject, owner: m[1]!, repo: m[2]!, title: summary, body: `Part of #${m[3]}. ${describe(prompt)}` }, note: 'toil has no sub-issue command, so this names its parent in the body; add it as a sub-issue on GitHub if the repository uses them.' };
    }
  }
  return { ...base, command: null, input: null, note: `toil has no create command for ${area} items.` };
}

/** A new ticket for the work, on the tracker the top match is on, else the one most of the toil project's open items come from. */
export function newTicketProposal(prompt: string, items: readonly WorkItem[], toilProject: string, near: WorkItem | null): Proposal {
  const summary = summaryOf(prompt);
  const area = near?.source.area ?? mainArea(items);
  const base = { id: `ticket:${toilProject}:new`, from: 'ticket' as const, item: `${toilProject}:new`, title: `Create a new ticket: ${summary}`, reason: near ? `Not one of the matches: a ticket of its own.` : 'No open item shares enough words with the work to be its ticket.' };
  if (area === 'jira') {
    return { ...base, command: 'jira issue create', input: { toilProject, summary, description: describe(prompt) }, note: "The project and issue type come from the Toil project and the connection's defaults; add --project or --type where they don't set them." };
  }
  if (area === 'ado') {
    const type = commonType(items, area);
    return { ...base, command: 'ado work-item create', input: { toilProject, type: type ?? 'Task', title: summary, description: describe(prompt) }, note: type ? `${type} is the type most of the Toil project's open ${area} items have; change --type if this is something else.` : 'Task is a guess: no open item shows which type the process uses; change --type if it calls it something else.' };
  }
  if (area === 'github') {
    return { ...base, command: 'github issue create', input: { toilProject, title: summary, body: describe(prompt) }, note: 'The repository comes from the Toil project; add --owner and --repo where it names none.' };
  }
  return { ...base, command: null, input: null, note: area ? `toil has no create command for ${area} items.` : 'The Toil project has no open item to say which tracker a new ticket goes on.' };
}

/** What "Ticket this" offers: a sub-task under each match, then a new ticket. */
export function ticketProposals(found: Unticketed, byId: ReadonlyMap<string, WorkItem>, items: readonly WorkItem[], toilProject: string): Proposal[] {
  const parents = found.matches.flatMap((m) => (byId.get(m.id) ? [byId.get(m.id)!] : []));
  return [...parents.map((p) => subTaskProposal(found.prompt, p, toilProject)), newTicketProposal(found.prompt, items, toilProject, parents[0] ?? null)];
}
