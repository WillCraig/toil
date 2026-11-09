/**
 * The board (#252): one column per OWI status category, so items from any
 * tracker sit side by side under the same headings, each still showing its
 * source's own status word. A move on the board changes nothing. It becomes a
 * proposal (src/proposal.ts) naming the toil write command that would make
 * it, with the status word taken from items the toil project already shows in that
 * column, since each workflow names its statuses its own way. Where that name
 * isn't known, or the item isn't where its status can be set (a GitHub issue
 * that isn't on a project board), the proposal says so instead of guessing.
 * A kanban board where nothing moves until somebody signs.
 */

import { STATUS_CATEGORY_LABEL, shortKey } from '../format.ts';
import type { Proposal } from '../proposal.ts';
import type { StatusCategory, WorkItem } from '../toil.ts';
import { flows } from './flow.ts';

/** The `native` record of the board item an issue was mapped from (`github project items`), whose `id` is the project item id. */
export const GITHUB_ITEMS = 'github project items';
/** Added by the loader beside it: which project that board is, `{ project, owner? }`. */
export const GITHUB_BOARD_KEY = 'github project';

export const COLUMNS: StatusCategory[] = ['TODO', 'IN_PROGRESS', 'DONE'];

export interface Column {
  category: StatusCategory;
  items: WorkItem[];
}

/** The board's columns, in the toil project's own order; Unknown only when some item is. */
export function columns(items: WorkItem[]): Column[] {
  const shown = items.filter(flows);
  const cats = shown.some((i) => i.statusCategory === 'UNKNOWN') ? [...COLUMNS, 'UNKNOWN' as const] : COLUMNS;
  return cats.map((category) => ({ category, items: shown.filter((i) => i.statusCategory === category) }));
}

const family = (item: WorkItem) => item.source.area.split('-')[0]!;

/**
 * The status word the toil project's items from the same tracker use for a
 * category, most common first: among items of the same type when any has
 * one, since a workflow's states can differ by type (Scrum's backlog item is
 * Committed where its task is In Progress), else among all of them.
 */
export function statusFor(item: WorkItem, to: StatusCategory, items: WorkItem[]): string | null {
  // A GitHub issue's own state (open, closed) is not a Status option: its word is the board's Status value, and only items on a board have one.
  const word = (i: WorkItem) => (family(i) === 'github' ? boardStatus(i) : i.status);
  const peers = items.filter((i) => family(i) === family(item) && i.source.connection === item.source.connection && i.statusCategory === to && word(i));
  const sameType = peers.filter((i) => i.typeName === item.typeName);
  const counts = new Map<string, number>();
  for (const i of sameType.length ? sameType : peers) counts.set(word(i)!, (counts.get(word(i)!) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** The project item id of a GitHub issue that lives on a board, else null. */
export function boardItemId(item: WorkItem): string | null {
  const entry = item.native[GITHUB_ITEMS] as { id?: unknown } | undefined;
  return typeof entry?.id === 'string' ? entry.id : null;
}

/** The name of the Status option a board item holds, else null: the board's own word, which an issue's closed state hides in `status`. */
export function boardStatus(item: WorkItem): string | null {
  const entry = item.native[GITHUB_ITEMS] as { fieldValues?: unknown } | undefined;
  const values = Array.isArray(entry?.fieldValues) ? (entry.fieldValues as Array<{ name?: unknown; field?: { name?: unknown } }>) : [];
  const status = values.find((v) => v.field?.name === 'Status' && typeof v.name === 'string');
  return status ? (status.name as string) : null;
}

/** Whether a card can be moved at all, decided before anyone drags it; the reason is plain words for the person. */
export type CanMove = { ok: true } | { ok: false; reason: string };

/**
 * Whether toil can propose a move for this card, whichever column it goes to.
 * The board uses it to switch dragging off, and `proposeMove` asks it first, so
 * a card and its proposal never disagree. By the time the board draws, the
 * toil project's items and the project boards it names are read, so an issue
 * with no board record is known to be off the board, not still loading.
 */
export function canMove(item: WorkItem): CanMove {
  const fam = family(item);
  if (fam === 'github') {
    return boardItemId(item) ? { ok: true } : { ok: false, reason: "Can't be moved here: this issue isn't on a GitHub project board this Toil project reads, so it has no Status to set." };
  }
  if (fam === 'jira' || fam === 'ado') return { ok: true };
  return { ok: false, reason: `Can't be moved here: toil has no status change for ${item.source.area} items.` };
}

/** What moving an item to another column would take; null when it's already there. */
export function proposeMove(item: WorkItem, to: StatusCategory, items: WorkItem[], toilProject: string): Proposal | null {
  if (to === item.statusCategory || to === 'UNKNOWN') return null;
  const key = shortKey(item);
  const label = STATUS_CATEGORY_LABEL[to];
  const status = statusFor(item, to, items);
  const base = { id: `board:${item.id}:${to}`, from: 'board' as const, item: item.id, title: `Move ${key} to ${label}`, reason: `Dragged on the board from ${STATUS_CATEGORY_LABEL[item.statusCategory]} (${item.status ?? 'no status'}).` };
  const fam = family(item);
  // The card is not draggable in this case; this is the safety net for a move that arrives by another way.
  const can = canMove(item);
  if (!can.ok) {
    return { ...base, command: null, input: null, note: `${key}: ${can.reason}${fam === 'github' ? ` Add it to the board first${item.url ? `: ${item.url}` : ''}.` : ''}` };
  }
  if (fam === 'github') {
    const boardId = boardItemId(item)!;
    // The loader records which board the item came from; without it there is no project number to list the options of.
    const on = item.native[GITHUB_BOARD_KEY] as { project?: number; owner?: string } | undefined;
    const options = on?.project !== undefined ? { text: "List the Status options the project has:", command: 'github project fields', input: { toilProject, project: on.project, ...(on.owner ? { owner: on.owner } : {}) } } : undefined;
    if (!status) {
      return { ...base, command: null, input: null, note: `No ${label} item on this Toil project's board shows which Status to use.`, ...(options ? { hint: options } : {}) };
    }
    return { ...base, command: 'github project status', input: { toilProject, item: boardId, to: status }, note: `"${status}" is the Status other ${label} items use; the project may name its columns differently, and an unknown one is refused with the real options.`, ...(options ? { hint: options } : {}) };
  }
  // Each Jira and Azure DevOps pair (Data Center or Server, and Cloud) names its commands alike, so the item's own area fills the path.
  const transitions = { text: 'List the transitions the workflow offers:', command: `${item.source.area} issue transitions`, input: { toilProject, key: item.source.key } };
  const states = { text: 'List the states the work item type has:', command: `${item.source.area} work-item states`, input: { toilProject, type: item.typeName ?? 'User Story' } };
  if (!status) {
    const hint = fam === 'jira' ? transitions : states;
    return { ...base, command: null, input: null, note: `No ${label} item in this Toil project shows which status to use.`, hint };
  }
  if (fam === 'jira') {
    return { ...base, command: `${item.source.area} issue transition`, input: { toilProject, key: item.source.key, transition: status }, note: `"${status}" is the status other ${label} items use; the workflow may name the transition differently.`, hint: transitions };
  }
  if (fam === 'ado') {
    return { ...base, command: `${item.source.area} work-item transition`, input: { toilProject, id: Number(item.source.key), state: status }, note: null };
  }
  return { ...base, command: null, input: null, note: `toil has no status change for ${item.source.area} items.` };
}
