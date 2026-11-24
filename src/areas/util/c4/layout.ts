import { typeLine, type ComputedView, type Element, type How } from './view.js';

/**
 * toil's own layout for one C4 view: a cut-down Sugiyama layered layout,
 * sized for what C4 views are (a few dozen boxes, one level of nesting) and
 * nothing more. The steps, each exported so it can be tested on its own:
 *
 * 1. `breakCycles`: reverse a small set of edges so the graph has no cycle.
 *    Edges into a person go first, so people stay on top.
 * 2. `assignLayers`: longest path from the sources; people on layer 0.
 * 3. `orderLayers`: barycenter sweeps, down and up, to cut crossings, with the
 *    boundary's children kept together as one block in every layer.
 * 4. `placeRow`: even spacing, each box pulled toward the centre of what it
 *    connects to (an isotonic fit, so order and spacing always hold).
 * 5. Routing: down out of the source, straight through each row a long edge
 *    passes at its dummy's place, and into the target, so arrows bend only in
 *    the gaps between rows; then a label spot on each edge that keeps clear of
 *    boxes, and of other arrows, where one exists.
 *
 * Text is sized from fixed per-character widths for Helvetica (Arial has the
 * same metrics), the one font the SVG asks for, so a layout is the same on
 * every machine and needs no font file. Layout engines usually come with a
 * steering committee; this one has a for loop.
 */

export interface Point {
  x: number;
  y: number;
}

/** A rectangle by its top-left corner. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextLine {
  text: string;
  size: number;
  bold: boolean;
}

export interface NodeBox extends Rect {
  id: string;
  element: Element;
  /** Inside the view's boundary. */
  inside: boolean;
  lines: TextLine[];
}

export interface EdgeRoute {
  from: string;
  to: string;
  description?: string | undefined;
  technology?: string | undefined;
  how?: How | undefined;
  /** From the source box's border to the destination box's border. */
  points: Point[];
  label?: { lines: TextLine[]; rect: Rect } | undefined;
}

export interface Layout {
  width: number;
  height: number;
  title: { text: string; x: number; y: number; size: number };
  boundary?: { element: Element; rect: Rect; lines: TextLine[] } | undefined;
  nodes: NodeBox[];
  edges: EdgeRoute[];
}

// ---------------------------------------------------------------- text

/** Helvetica's advance widths in 1/1000 em for ASCII 32 to 126, from its font metrics. */
const REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222,
  833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
  611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278,
  889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
/** Anything outside ASCII is measured as a wide character, so the estimate errs toward room to spare. */
const OTHER = 1000;

export const FONT_FAMILY = 'Helvetica, Arial, sans-serif';

export function textWidth(text: string, size: number, bold = false): number {
  const table = bold ? BOLD : REGULAR;
  let units = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    units += code >= 32 && code <= 126 ? table[code - 32]! : OTHER;
  }
  return (units * size) / 1000;
}

/** Words wrapped to `maxWidth`; a word wider than that is broken between characters, so no line is ever wider. */
export function wrapText(text: string, maxWidth: number, size: number, bold = false): string[] {
  const lines: string[] = [];
  let line = '';
  const fits = (s: string) => textWidth(s, size, bold) <= maxWidth;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const joined = line ? `${line} ${word}` : word;
    if (fits(joined)) {
      line = joined;
      continue;
    }
    if (line) lines.push(line);
    let rest = word;
    while (!fits(rest)) {
      let cut = rest.length - 1;
      while (cut > 1 && !fits(rest.slice(0, cut))) cut--;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines;
}

export const lineHeight = (line: TextLine) => Math.round(line.size * 1.3);
export const linesHeight = (lines: TextLine[]) => lines.reduce((sum, l) => sum + lineHeight(l), 0);
export const linesWidth = (lines: TextLine[]) => Math.max(0, ...lines.map((l) => textWidth(l.text, l.size, l.bold)));

// ---------------------------------------------------------------- sizes

export const NODE_WIDTH = 230;
const NODE_PAD = 14;
const MIN_HEIGHT = 100;
/** The extra height a database's top ellipse takes. */
export const DB_CAP = 10;
const NAME = 15;
const TYPE = 11;
const DESC = 12;
const DUMMY_WIDTH = 16;
const NODE_GAP = 50;
const LAYER_GAP = 120;
const BOUNDARY_PAD = 28;
const BOUNDARY_LABEL = 38;
const MARGIN = 30;
const TITLE = 20;
const LABEL_WIDTH = 150;
const EDGE_LABEL = 11;
const EDGE_TECH = 10;
/** How far in from a box's corner an arrow may leave or enter it. */
const PORT_INSET = 12;

/** The text lines in an element's box: bold name, type line, then the description, each wrapped to the box. */
export function nodeLines(el: Element): TextLine[] {
  const inner = NODE_WIDTH - 2 * NODE_PAD;
  const lines: TextLine[] = [
    ...wrapText(el.name, inner, NAME, true).map((text) => ({ text, size: NAME, bold: true })),
    ...wrapText(typeLine(el), inner, TYPE).map((text) => ({ text, size: TYPE, bold: false })),
  ];
  if (el.description) lines.push({ text: '', size: 6, bold: false }, ...wrapText(el.description, inner, DESC).map((text) => ({ text, size: DESC, bold: false })));
  return lines;
}

export function nodeHeight(el: Element, lines: TextLine[]): number {
  return Math.max(MIN_HEIGHT, linesHeight(lines) + 2 * NODE_PAD) + (el.database ? 2 * DB_CAP : 0);
}

// ---------------------------------------------------------------- 1. cycles

export interface DirectedEdge {
  from: string;
  to: string;
}

/**
 * Which edges to reverse so the graph has no cycle. Edges into a `top` node
 * (a person) from anything else are reversed first, so people can sit on the
 * top layer; then a depth-first search in node order reverses each edge that
 * closes a cycle. That is a small set, not always the smallest, which is an
 * NP-hard question and not one a diagram needs answered exactly.
 */
export function breakCycles(nodes: readonly string[], edges: readonly DirectedEdge[], top: ReadonlySet<string> = new Set()): boolean[] {
  const reversed = edges.map((e) => top.has(e.to) && !top.has(e.from));
  const out = new Map<string, number[]>(nodes.map((n) => [n, []]));
  edges.forEach((e, i) => {
    if (top.has(e.from) && top.has(e.to)) return;
    out.get(reversed[i] ? e.to : e.from)!.push(i);
  });
  const state = new Map<string, 'open' | 'done'>();
  const visit = (n: string) => {
    state.set(n, 'open');
    for (const i of out.get(n)!) {
      const next = reversed[i] ? edges[i]!.from : edges[i]!.to;
      const s = state.get(next);
      if (s === 'open') reversed[i] = !reversed[i];
      else if (s === undefined) visit(next);
    }
    state.set(n, 'done');
  };
  for (const n of nodes) if (!state.has(n)) visit(n);
  return reversed;
}

// ---------------------------------------------------------------- 2. layers

/**
 * Longest-path layering of an acyclic graph: each node one layer below the
 * lowest of the nodes with an edge into it. `top` nodes are pinned to layer 0
 * and everything else starts at layer 1 when there are any. A node nothing points to is then
 * moved down to sit just above its highest successor, so a system that only
 * sends into the view isn't stranded at the top.
 */
export function assignLayers(nodes: readonly string[], edges: readonly DirectedEdge[], top: ReadonlySet<string> = new Set()): Map<string, number> {
  const base = top.size > 0 ? 1 : 0;
  const active = edges.filter((e) => !top.has(e.to) && e.from !== e.to);
  const incoming = new Map<string, string[]>(nodes.map((n) => [n, []]));
  const outgoing = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const e of active) {
    incoming.get(e.to)!.push(e.from);
    outgoing.get(e.from)!.push(e.to);
  }
  const layer = new Map<string, number>();
  const indegree = new Map(nodes.map((n) => [n, incoming.get(n)!.length]));
  const queue = nodes.filter((n) => indegree.get(n) === 0);
  for (const n of queue) layer.set(n, top.has(n) ? 0 : base);
  while (queue.length > 0) {
    const n = queue.shift()!;
    for (const s of outgoing.get(n)!) {
      layer.set(s, Math.max(layer.get(s) ?? base, layer.get(n)! + 1));
      indegree.set(s, indegree.get(s)! - 1);
      if (indegree.get(s) === 0) queue.push(s);
    }
  }
  // A cycle left in the input would leave nodes unlayered; they go at the bottom rather than vanish.
  const deepest = Math.max(base, ...layer.values());
  for (const n of nodes) if (!layer.has(n)) layer.set(n, deepest + 1);
  for (const n of nodes) {
    if (top.has(n) || incoming.get(n)!.length > 0 || outgoing.get(n)!.length === 0) continue;
    const highest = Math.min(...outgoing.get(n)!.map((s) => layer.get(s)!));
    if (highest - 1 > layer.get(n)!) layer.set(n, highest - 1);
  }
  return layer;
}

// ---------------------------------------------------------------- 3. order

/** The block marker: where the boundary's children sit among the other nodes of a layer. */
export const BLOCK = '#block';

export interface Ordering {
  /** Each layer's items left to right; `BLOCK` stands for the boundary's children in the layers it spans. */
  items: string[][];
  /** The boundary's children in each layer, left to right. */
  inner: string[][];
}

/** A node's horizontal rank: its index, or for a block member, a fraction across the block's slot. */
function ranks(o: Ordering, layer: number): Map<string, number> {
  const out = new Map<string, number>();
  o.items[layer]!.forEach((id, i) => {
    if (id !== BLOCK) return out.set(id, i);
    const inner = o.inner[layer]!;
    inner.forEach((m, k) => out.set(m, i - 0.5 + (k + 0.5) / inner.length));
  });
  return out;
}

/** Edge crossings between each pair of adjacent layers, for the edges given (upper node first). */
export function countCrossings(o: Ordering, edges: ReadonlyArray<[string, string]>, layerOf: ReadonlyMap<string, number>): number {
  let crossings = 0;
  for (let l = 0; l + 1 < o.items.length; l++) {
    const upper = ranks(o, l);
    const lower = ranks(o, l + 1);
    const between = edges.filter(([a, b]) => layerOf.get(a) === l && layerOf.get(b) === l + 1).map(([a, b]) => [upper.get(a)!, lower.get(b)!] as const);
    for (let i = 0; i < between.length; i++)
      for (let j = i + 1; j < between.length; j++) {
        const [a1, b1] = between[i]!;
        const [a2, b2] = between[j]!;
        if ((a1 - a2) * (b1 - b2) < 0) crossings++;
      }
  }
  return crossings;
}

/**
 * Barycenter sweeps: each layer sorted by the mean rank of its neighbours in
 * the layer just swept, alternately downward and upward, keeping the best
 * ordering seen. The block moves as one item, by its members' mean
 * barycenter, and its members are sorted among themselves the same way.
 */
export function orderLayers(start: Ordering, edges: ReadonlyArray<[string, string]>, layerOf: ReadonlyMap<string, number>, sweeps = 6): Ordering {
  const copy = (o: Ordering): Ordering => ({ items: o.items.map((l) => [...l]), inner: o.inner.map((l) => [...l]) });
  const current = copy(start);
  let best = copy(start);
  let bestCrossings = countCrossings(best, edges, layerOf);
  const adjacent = adjacency(edges);
  const neighbours = (id: string, layer: number) => (adjacent.get(id) ?? []).filter((n) => layerOf.get(n) === layer);
  for (let sweep = 0; sweep < sweeps; sweep++) {
    const down = sweep % 2 === 0;
    const layers = [...current.items.keys()];
    if (!down) layers.reverse();
    for (const l of layers.slice(1)) {
      const ref = down ? l - 1 : l + 1;
      const refRanks = ranks(current, ref);
      const own = ranks(current, l);
      const bary = (id: string) => {
        const ns = neighbours(id, ref).map((n) => refRanks.get(n)!);
        return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : own.get(id)!;
      };
      const inner = current.inner[l]!;
      const innerB = new Map(inner.map((m) => [m, bary(m)]));
      current.inner[l] = [...inner].sort((a, b) => innerB.get(a)! - innerB.get(b)!);
      const blockAt = current.items[l]!.indexOf(BLOCK);
      const blockB = inner.length ? [...innerB.values()].reduce((a, b) => a + b, 0) / inner.length : blockAt;
      const keyed = current.items[l]!.map((id) => ({ id, b: id === BLOCK ? blockB : bary(id) }));
      current.items[l] = keyed.sort((a, b) => a.b - b.b).map((k) => k.id);
    }
    const crossings = countCrossings(current, edges, layerOf);
    if (crossings < bestCrossings) {
      best = copy(current);
      bestCrossings = crossings;
    }
  }
  return best;
}

/** Each node's neighbours, either direction, built once: looked up per node per sweep, which a scan of every edge made quadratic. */
function adjacency(edges: ReadonlyArray<[string, string]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [a, b] of edges) {
    (out.get(a) ?? out.set(a, []).get(a)!).push(b);
    (out.get(b) ?? out.set(b, []).get(b)!).push(a);
  }
  return out;
}

// ---------------------------------------------------------------- 4. positions

/**
 * Centres for a row of boxes, kept in order with `gap` between them, each as
 * close as it can get to its desired centre (least squares). Pool adjacent
 * violators on the centres less their cumulative minimum offsets, then
 * clamped into [lo, hi] for the row's outer edges.
 */
export function placeRow(widths: readonly number[], desired: readonly number[], gap: number, lo = -Infinity, hi = Infinity): number[] {
  const n = widths.length;
  if (n === 0) return [];
  const offset = [0];
  for (let i = 1; i < n; i++) offset.push(offset[i - 1]! + (widths[i - 1]! + widths[i]!) / 2 + gap);
  const blocks: Array<{ sum: number; count: number }> = [];
  for (let i = 0; i < n; i++) {
    blocks.push({ sum: desired[i]! - offset[i]!, count: 1 });
    while (blocks.length > 1 && blocks.at(-2)!.sum / blocks.at(-2)!.count > blocks.at(-1)!.sum / blocks.at(-1)!.count) {
      const last = blocks.pop()!;
      blocks.at(-1)!.sum += last.sum;
      blocks.at(-1)!.count += last.count;
    }
  }
  const z = blocks.flatMap((b) => Array<number>(b.count).fill(b.sum / b.count));
  const zLo = lo + widths[0]! / 2;
  const zHi = hi - widths[n - 1]! / 2 - offset[n - 1]!;
  return z.map((v, i) => Math.min(Math.max(v, zLo), Math.max(zLo, zHi)) + offset[i]!);
}

// ---------------------------------------------------------------- the whole layout

interface LNode {
  id: string;
  width: number;
  height: number;
  dummy: boolean;
  inside: boolean;
  layer: number;
  x: number;
  y: number;
}

const DUMMY_PREFIX = '~';

/** Lays out a computed view. Pure: the same view always gives the same layout. */
export function layoutView(view: ComputedView): Layout {
  const boundary = view.boundary && view.inside.length > 0 ? view.boundary : undefined;
  const elements = [...view.outside, ...view.inside];
  const insideIds = new Set(boundary ? view.inside.map((e) => e.id) : []);
  const ids = elements.map((e) => e.id);
  const people = new Set(elements.filter((e) => e.kind === 'person').map((e) => e.id));

  // 1 and 2: cycles, then layers.
  const reversed = breakCycles(ids, view.edges, people);
  const oriented = view.edges.map((e, i) => (reversed[i] ? { from: e.to, to: e.from } : { from: e.from, to: e.to }));
  const layerOf = assignLayers(ids, oriented, people);

  const nodes = new Map<string, LNode>();
  const lines = new Map<string, TextLine[]>();
  for (const el of elements) {
    const ls = nodeLines(el);
    lines.set(el.id, ls);
    nodes.set(el.id, { id: el.id, width: NODE_WIDTH, height: nodeHeight(el, ls), dummy: false, inside: insideIds.has(el.id), layer: layerOf.get(el.id)!, x: 0, y: 0 });
  }

  // Long edges get a dummy point per layer they pass; edges within a layer get none. A dummy
  // stays inside the boundary while an edge with an end inside it is still in the block's
  // layers, so the edge leaves through the block's top or bottom rather than across a sibling.
  const insideLayerList = elements.filter((e) => insideIds.has(e.id)).map((e) => layerOf.get(e.id)!);
  const blockSpan = insideLayerList.length ? { first: Math.min(...insideLayerList), last: Math.max(...insideLayerList) } : undefined;
  const inBlock = (l: number) => blockSpan !== undefined && l >= blockSpan.first && l <= blockSpan.last;
  const chains: string[][] = [];
  const adjacent: Array<[string, string]> = [];
  oriented.forEach((e, i) => {
    let [a, b] = [e.from, e.to];
    if (layerOf.get(a)! > layerOf.get(b)!) [a, b] = [b, a];
    const chain = [a];
    for (let l = layerOf.get(a)! + 1; l < layerOf.get(b)!; l++) {
      const id = `${DUMMY_PREFIX}${i}${DUMMY_PREFIX}${l}`;
      nodes.set(id, { id, width: DUMMY_WIDTH, height: 0, dummy: true, inside: inBlock(l) && (insideIds.has(a) || insideIds.has(b)), layer: l, x: 0, y: 0 });
      layerOf.set(id, l);
      chain.push(id);
    }
    chain.push(b);
    for (let k = 0; k + 1 < chain.length; k++) if (layerOf.get(chain[k]!) !== layerOf.get(chain[k + 1]!)) adjacent.push([chain[k]!, chain[k + 1]!]);
    chains.push(chain);
  });

  // 3: ordering, starting from model order.
  const layerCount = Math.max(...[...nodes.values()].map((n) => n.layer)) + 1;
  const insideLayers = [...nodes.values()].filter((n) => n.inside).map((n) => n.layer);
  const span = boundary ? { first: Math.min(...insideLayers), last: Math.max(...insideLayers) } : undefined;
  const start: Ordering = { items: [], inner: [] };
  for (let l = 0; l < layerCount; l++) {
    const here = [...nodes.values()].filter((n) => n.layer === l);
    const outside = here.filter((n) => !n.inside).map((n) => n.id);
    const inner = here.filter((n) => n.inside).map((n) => n.id);
    const inSpan = span && l >= span.first && l <= span.last;
    start.items.push(inSpan ? [BLOCK, ...outside] : outside);
    start.inner.push(inner);
  }
  const order = orderLayers(start, adjacent, layerOf);

  // 4: positions. The block's inner width is its widest layer; its centre is shared by every layer it spans.
  const packed = (ids: string[]) => ids.reduce((w, id, i) => w + nodes.get(id)!.width + (i > 0 ? NODE_GAP : 0), 0);
  const innerWidth = span ? Math.max(NODE_WIDTH, ...order.inner.map(packed)) : 0;
  const blockWidth = innerWidth + 2 * BOUNDARY_PAD;
  let blockCentre = 0;
  const widthOf = (id: string) => (id === BLOCK ? blockWidth : nodes.get(id)!.width);
  // Start packed left to right.
  order.items.forEach((items, l) => {
    let x = 0;
    for (const id of items) {
      const w = widthOf(id);
      if (id === BLOCK) blockCentre = x + w / 2;
      else nodes.get(id)!.x = x + w / 2;
      x += w + NODE_GAP;
    }
    const inner = order.inner[l]!;
    let ix = blockCentre - packed(inner) / 2;
    for (const id of inner) {
      nodes.get(id)!.x = ix + nodes.get(id)!.width / 2;
      ix += nodes.get(id)!.width + NODE_GAP;
    }
  });
  const linked = adjacency(adjacent);
  const neighbourMean = (id: string, layers: number[]) => {
    const xs = (linked.get(id) ?? []).filter((n) => layers.includes(layerOf.get(n)!)).map((n) => nodes.get(n)!.x);
    return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : nodes.get(id)!.x;
  };
  for (let pass = 0; pass < 12; pass++) {
    const down = pass % 2 === 0;
    const layers = [...order.items.keys()];
    if (!down) layers.reverse();
    // The last passes use both neighbouring layers, which centres a parent over its children.
    const both = pass >= 8;
    const innerWanted: number[] = [];
    for (const l of layers) {
      const refs = both ? [l - 1, l + 1] : [down ? l - 1 : l + 1];
      const items = order.items[l]!;
      const at = items.indexOf(BLOCK);
      const row = (list: string[], lo?: number, hi?: number) => {
        const xs = placeRow(list.map(widthOf), list.map((id) => neighbourMean(id, refs)), NODE_GAP, lo, hi);
        list.forEach((id, i) => (nodes.get(id)!.x = xs[i]!));
      };
      if (at < 0) row(items);
      else {
        row(items.slice(0, at), -Infinity, blockCentre - blockWidth / 2 - NODE_GAP);
        row(items.slice(at + 1), blockCentre + blockWidth / 2 + NODE_GAP);
        const inner = order.inner[l]!;
        for (const id of inner) innerWanted.push(neighbourMean(id, refs) - nodes.get(id)!.x);
        row(inner, blockCentre - innerWidth / 2, blockCentre + innerWidth / 2);
      }
    }
    if (innerWanted.length) blockCentre += innerWanted.reduce((a, b) => a + b, 0) / innerWanted.length / 2;
  }
  // A final pass with the block where it ended up, so every row respects it exactly.
  order.items.forEach((items, l) => {
    const at = items.indexOf(BLOCK);
    if (at < 0) return;
    const fix = (list: string[], lo?: number, hi?: number) => {
      const xs = placeRow(list.map(widthOf), list.map((id) => nodes.get(id)!.x), NODE_GAP, lo, hi);
      list.forEach((id, i) => (nodes.get(id)!.x = xs[i]!));
    };
    fix(items.slice(0, at), -Infinity, blockCentre - blockWidth / 2 - NODE_GAP);
    fix(items.slice(at + 1), blockCentre + blockWidth / 2 + NODE_GAP);
    fix(order.inner[l]!, blockCentre - innerWidth / 2, blockCentre + innerWidth / 2);
  });

  // Rows: each layer as tall as its tallest box, with room for the boundary's padding and label.
  const rowTop: number[] = [];
  const rowHeight: number[] = [];
  let y = TITLE * 2.5;
  for (let l = 0; l < layerCount; l++) {
    if (span && l === span.first) y += BOUNDARY_PAD;
    rowTop.push(y);
    const h = Math.max(0, ...[...nodes.values()].filter((n) => n.layer === l).map((n) => n.height));
    rowHeight.push(h);
    y += h + LAYER_GAP;
    if (span && l === span.last) y += BOUNDARY_PAD + BOUNDARY_LABEL;
  }
  for (const n of nodes.values()) n.y = rowTop[n.layer]! + (rowHeight[n.layer]! - n.height) / 2;

  const rectOf = (n: LNode): Rect => ({ x: n.x - n.width / 2, y: n.y, width: n.width, height: n.height });
  const boxes: NodeBox[] = elements.map((el) => ({ ...rectOf(nodes.get(el.id)!), id: el.id, element: el, inside: insideIds.has(el.id), lines: lines.get(el.id)! }));
  const boundaryRect: Rect | undefined = span
    ? { x: blockCentre - blockWidth / 2, y: rowTop[span.first]! - BOUNDARY_PAD, width: blockWidth, height: rowTop[span.last]! + rowHeight[span.last]! + BOUNDARY_PAD + BOUNDARY_LABEL - (rowTop[span.first]! - BOUNDARY_PAD) }
    : undefined;

  // 5: routes, then labels.
  const pairCount = new Map<string, number>();
  const pairSeen = new Map<string, number>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const e of view.edges) pairCount.set(pairKey(e.from, e.to), (pairCount.get(pairKey(e.from, e.to)) ?? 0) + 1);
  const edges: EdgeRoute[] = view.edges.map((e, i) => {
    const key = pairKey(e.from, e.to);
    const k = pairSeen.get(key) ?? 0;
    pairSeen.set(key, k + 1);
    const shift = (k - ((pairCount.get(key) ?? 1) - 1) / 2) * 28;
    const chain = chains[i]!;
    const a = nodes.get(chain[0]!)!;
    const b = nodes.get(chain.at(-1)!)!;
    let points: Point[];
    if (a.layer === b.layer) {
      // Same layer: out of the bottom of one, under the row, into the bottom of the other.
      const below = rowTop[a.layer]! + rowHeight[a.layer]! + 30 + Math.abs(shift);
      points = [
        { x: a.x + shift / 2, y: a.y + a.height },
        { x: a.x + shift / 2, y: below },
        { x: b.x + shift / 2, y: below },
        { x: b.x + shift / 2, y: b.y + b.height },
      ];
    } else {
      // Down out of the source's bottom, straight through every row it passes at its dummy's
      // place, and into the target's top. Diagonals only cross the gaps between rows, where
      // there are no boxes, so an arrow never runs behind one (verify.ts checks it).
      const bottom = (l: number) => rowTop[l]! + rowHeight[l]!;
      const across = (n: LNode, x: number) => Math.min(Math.max(x, n.x - n.width / 2 + PORT_INSET), n.x + n.width / 2 - PORT_INSET);
      const ax = across(a, a.x + shift);
      const bx = across(b, b.x + shift);
      points = [{ x: ax, y: a.y + a.height }, { x: ax, y: bottom(a.layer) }];
      for (const id of chain.slice(1, -1)) {
        const dummy = nodes.get(id)!;
        points.push({ x: dummy.x + shift, y: rowTop[dummy.layer]! }, { x: dummy.x + shift, y: bottom(dummy.layer) });
      }
      points.push({ x: bx, y: rowTop[b.layer]! }, { x: bx, y: b.y });
      points = points.filter((p, k) => k === 0 || p.x !== points[k - 1]!.x || p.y !== points[k - 1]!.y);
    }
    // Drawn in the relationship's own direction, whatever the layering did to it.
    if (chain[0] !== e.from) points.reverse();
    return { from: e.from, to: e.to, description: e.description, technology: e.technology, ...(e.how === undefined ? {} : { how: e.how }), points };
  });
  placeLabels(edges, boxes);

  // Move everything so the drawing starts at the margin, and size the canvas around it.
  const titleWidth = textWidth(view.title, TITLE, true);
  const all: Rect[] = [...boxes, ...(boundaryRect ? [boundaryRect] : []), ...edges.flatMap((e) => (e.label ? [e.label.rect] : [])), ...edges.flatMap((e) => e.points.map((p) => ({ x: p.x, y: p.y, width: 0, height: 0 })))];
  const minX = Math.min(...all.map((r) => r.x));
  const maxX = Math.max(...all.map((r) => r.x + r.width));
  const contentWidth = Math.max(maxX - minX, titleWidth);
  const dx = MARGIN - minX + (contentWidth - (maxX - minX)) / 2;
  const move = (r: Rect) => {
    r.x += dx;
  };
  boxes.forEach(move);
  if (boundaryRect) move(boundaryRect);
  for (const e of edges) {
    e.points.forEach((p) => (p.x += dx));
    if (e.label) move(e.label.rect);
  }
  const maxY = Math.max(...all.map((r) => r.y + r.height));
  const width = Math.ceil(contentWidth + 2 * MARGIN);
  return {
    width,
    height: Math.ceil(maxY + MARGIN),
    title: { text: view.title, x: width / 2, y: TITLE * 1.6, size: TITLE },
    boundary: boundary && boundaryRect ? { element: boundary, rect: boundaryRect, lines: boundaryLines(boundary) } : undefined,
    nodes: boxes,
    edges,
  };
}

function boundaryLines(el: Element): TextLine[] {
  return [
    { text: el.name, size: 14, bold: true },
    { text: typeLine(el), size: 11, bold: false },
  ];
}

export function intersects(a: Rect, b: Rect, margin = 0): boolean {
  return a.x < b.x + b.width + margin && b.x < a.x + a.width + margin && a.y < b.y + b.height + margin && b.y < a.y + a.height + margin;
}

const overlapArea = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/** How far in from a border a line counts as inside, in pixels: the tolerance the layout check uses too (verify.ts). */
const INSIDE = 1;

/**
 * Whether the segment from `a` to `b` passes through the inside of `r`, more
 * than the tolerance in from its border (Liang-Barsky clipping). Touching the
 * border, or running along it, doesn't count. The one geometry the label
 * placement below and the layout check in verify.ts share, so a spot the
 * placement calls clear of an arrow is one the check passes.
 */
export function segmentCrosses(r: Rect, a: Point, b: Point): boolean {
  const x0 = r.x + INSIDE;
  const y0 = r.y + INSIDE;
  const x1 = r.x + r.width - INSIDE;
  const y1 = r.y + r.height - INSIDE;
  if (x1 <= x0 || y1 <= y0) return false;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [
    [-dx, a.x - x0],
    [dx, x1 - a.x],
    [-dy, a.y - y0],
    [dy, y1 - a.y],
  ] as const) {
    if (p === 0) {
      if (q <= 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 >= t1) return false;
  }
  return t1 - t0 > 1e-9;
}

/** The point `t` of the way along a polyline, by length. */
function along(points: Point[], t: number): Point {
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y));
  let left = lengths.reduce((a, b) => a + b, 0) * t;
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i]! || i === lengths.length - 1) {
      const f = lengths[i]! === 0 ? 0 : Math.min(1, left / lengths[i]!);
      return { x: points[i]!.x + (points[i + 1]!.x - points[i]!.x) * f, y: points[i]!.y + (points[i + 1]!.y - points[i]!.y) * f };
    }
    left -= lengths[i]!;
  }
  return points[0]!;
}

/** The whole edge, nearest the middle first: the spots searched before giving up on a label clear of other arrows. */
const WHOLE_EDGE = Array.from({ length: 39 }, (_, i) => (i + 1) / 40).sort((a, b) => Math.abs(a - 0.5) - Math.abs(b - 0.5) || a - b);

/**
 * A spot for each edge's label: tried at points along the edge, centred on it
 * and then beside it, taking the first that touches no box and no label
 * already placed. A spot that also touches no other arrow is preferred
 * (#584): when that first pick sits on another arrow, the whole edge is
 * searched, nearest the middle first, for one clear of boxes, labels and
 * arrows alike. With none clear, the first pick stands — the
 * least-overlapping spot when boxes crowd every spot — and the layout check
 * reports it.
 */
export function placeLabels(edges: EdgeRoute[], boxes: readonly Rect[]): void {
  const placed: Rect[] = [];
  // Each arrow's bounding box first, so a spot is tested in full only against the arrows that reach it.
  const bounds: Rect[] = edges.map((e) => {
    const xs = e.points.map((p) => p.x);
    const ys = e.points.map((p) => p.y);
    const [x, y] = [Math.min(...xs), Math.min(...ys)];
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  });
  const touchesArrow = (rect: Rect, own: number): boolean =>
    edges.some((o, j) => j !== own && intersects(rect, bounds[j]!) && o.points.slice(1).some((p, k) => segmentCrosses(rect, o.points[k]!, p)));
  for (let index = 0; index < edges.length; index++) {
    const e = edges[index]!;
    const lines: TextLine[] = [
      ...(e.description ? wrapText(e.description, LABEL_WIDTH, EDGE_LABEL).map((text) => ({ text, size: EDGE_LABEL, bold: false })) : []),
      ...(e.technology ? [{ text: `[${e.technology}]`, size: EDGE_TECH, bold: false }] : []),
    ];
    if (lines.length === 0) continue;
    const w = linesWidth(lines) + 6;
    const h = linesHeight(lines) + 4;
    const shifts = [0, w / 2 + 8, -(w / 2 + 8)];
    const at = (t: number, shift: number): Rect => {
      const p = along(e.points, t);
      return { x: p.x + shift - w / 2, y: p.y - h / 2, width: w, height: h };
    };
    const costOf = (rect: Rect): number => [...boxes, ...placed].reduce((sum, b) => sum + overlapArea(rect, { x: b.x - 4, y: b.y - 4, width: b.width + 8, height: b.height + 8 }), 0);
    let best: { rect: Rect; cost: number } | undefined;
    search: for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
      for (const shift of shifts) {
        const rect = at(t, shift);
        const cost = costOf(rect);
        if (!best || cost < best.cost) best = { rect, cost };
        if (cost === 0) break search;
      }
    }
    if (best!.cost > 0 || touchesArrow(best!.rect, index)) {
      clear: for (const t of WHOLE_EDGE) {
        for (const shift of shifts) {
          const rect = at(t, shift);
          if (costOf(rect) === 0 && !touchesArrow(rect, index)) {
            best = { rect, cost: 0 };
            break clear;
          }
        }
      }
    }
    e.label = { lines, rect: best!.rect };
    placed.push(best!.rect);
  }
}
