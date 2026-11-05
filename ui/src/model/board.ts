/**
 * The board (#252): one column per OWI status category, so items from any
 * tracker sit side by side under the same headings, each still showing its
 * source's own status word. A move on the board changes nothing. It becomes a
 * proposal (src/proposal.ts) naming the toil write command that would make
 * it, with the status word taken from items the toil project already shows in that
 * column, since each workflow names its statuses its own way. Where that name
 * isn't known, or toil has no command for the change (GitHub Projects' status
 * field), the proposal says so instead of guessing.
 * A kanban board where nothing moves until somebody signs.
 */

import { STATUS_CATEGORY_LABEL, shortKey } from '../format.ts';
import type { Proposal } from '../proposal.ts';
import type { StatusCategory, WorkItem } from '../toil.ts';
import { flows } from './flow.ts';

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
  const peers = items.filter((i) => family(i) === family(item) && i.source.connection === item.source.connection && i.statusCategory === to && i.status);
  const sameType = peers.filter((i) => i.typeName === item.typeName);
  const counts = new Map<string, number>();
  for (const i of sameType.length ? sameType : peers) counts.set(i.status!, (counts.get(i.status!) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** What moving an item to another column would take; null when it's already there. */
export function proposeMove(item: WorkItem, to: StatusCategory, items: WorkItem[], toilProject: string): Proposal | null {
  if (to === item.statusCategory || to === 'UNKNOWN') return null;
  const key = shortKey(item);
  const label = STATUS_CATEGORY_LABEL[to];
  const status = statusFor(item, to, items);
  const base = { id: `board:${item.id}:${to}`, from: 'board' as const, item: item.id, title: `Move ${key} to ${label}`, reason: `Dragged on the board from ${STATUS_CATEGORY_LABEL[item.statusCategory]} (${item.status ?? 'no status'}).` };
  const fam = family(item);
  if (fam === 'github') {
    return { ...base, command: null, input: null, note: `toil has no command that sets a GitHub Projects status yet. Change ${key}'s Status field on the project board${item.url ? `: ${item.url}` : ''}.` };
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
