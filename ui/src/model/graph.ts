/**
 * The dependency graph (#252), from OWI links alone. Each link appears on
 * both of its items (outward on one, inward on the other), so the graph keeps
 * one edge per pair and type, pointing the way the link reads: A blocks B is
 * A → B. A link to an item the toil project doesn't hold is kept, as a node marked
 * unknown, rather than dropped (principle 4).
 *
 * The layout is part of the model, so it is tested and needs no layout
 * library: each item's column is the length of the longest `blocks` chain
 * leading to it, and items keep the toil project's own order down each column.
 * Other link types draw edges but don't move anything. A cycle can't loop
 * forever: ranks stop growing after one pass per node, and the graph says so.
 * A critical path, found without a Gantt chart.
 */

import type { LinkType, WorkItem } from '../toil.ts';

export interface GraphNode {
  id: string;
  /** False for a link target the toil project doesn't hold. */
  known: boolean;
  /** Column: the longest chain of `blocks` edges leading here. */
  rank: number;
  /** Position down its column. */
  row: number;
  done: boolean;
  /** Blocked by an unfinished item. */
  blocked: boolean;
  /** Not finished, and blocks an unfinished item. */
  blocking: boolean;
}

export interface GraphEdge {
  id: string;
  type: LinkType;
  source: string;
  target: string;
  /** The source's own wording, from the outward side when it has one. */
  name: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** True when the `blocks` links loop, so the columns are only approximate. */
  cycle: boolean;
}

export function dependencyGraph(items: WorkItem[]): Graph {
  const byId = new Map(items.map((i) => [i.id, i]));
  const edges = new Map<string, GraphEdge>();
  for (const item of items) {
    for (const link of item.links) {
      const [source, target] = link.direction === 'outward' ? [item.id, link.target] : [link.target, item.id];
      // `relates` reads the same both ways: one edge per pair, in id order.
      const [a, b] = link.type === 'relates' && source > target ? [target, source] : [source, target];
      const id = `${link.type}:${a}->${b}`;
      const seen = edges.get(id);
      if (!seen || link.direction === 'outward') edges.set(id, { id, type: link.type, source: a, target: b, name: link.name });
    }
  }

  const order: string[] = [];
  for (const item of items) if (item.links.length && !order.includes(item.id)) order.push(item.id);
  for (const e of edges.values()) for (const id of [e.source, e.target]) if (!order.includes(id)) order.push(id);

  const blocks = [...edges.values()].filter((e) => e.type === 'blocks');
  const rank = new Map(order.map((id) => [id, 0]));
  let cycle = false;
  for (let pass = 0; ; pass++) {
    let changed = false;
    for (const e of blocks) {
      const next = rank.get(e.source)! + 1;
      if (next > rank.get(e.target)!) {
        rank.set(e.target, next);
        changed = true;
      }
    }
    if (!changed) break;
    if (pass >= order.length) {
      cycle = true;
      break;
    }
  }

  const unfinished = (id: string) => byId.has(id) && byId.get(id)!.statusCategory !== 'DONE';
  const rows = new Map<number, number>();
  const nodes = order.map((id): GraphNode => {
    const r = rank.get(id)!;
    const row = rows.get(r) ?? 0;
    rows.set(r, row + 1);
    return {
      id,
      known: byId.has(id),
      rank: r,
      row,
      done: byId.get(id)?.statusCategory === 'DONE',
      // A finished item isn't held up by anything any more, whatever its links say; the same rule as blocking.
      blocked: unfinished(id) && blocks.some((e) => e.target === id && unfinished(e.source)),
      blocking: unfinished(id) && blocks.some((e) => e.source === id && unfinished(e.target)),
    };
  });
  return { nodes, edges: [...edges.values()], cycle };
}

/** An edge in words: "corp-jira:PAY-101 blocks corp-jira:PAY-102". */
export const EDGE_WORD: Record<LinkType, string> = {
  blocks: 'blocks',
  relates: 'relates to',
  duplicates: 'duplicates',
  implements: 'implements',
  other: 'is linked to',
};
