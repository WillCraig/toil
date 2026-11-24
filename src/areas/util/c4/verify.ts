import { parseXml, XmlSyntaxError } from '../kit/xml.js';
import { intersects, segmentCrosses, type Layout, type Point, type Rect } from './layout.js';
import { XML_FORBIDDEN } from './svg.js';

export { segmentCrosses };

/**
 * The renderer checks its own drawing before handing it over: no two boxes
 * overlap, every child sits inside its boundary (and nothing else does),
 * every arrow starts and ends on the right boxes, no arrow passes behind a
 * box it doesn't join, no label covers a box, and no label sits on another
 * arrow's line. This runs beside the layout in the bounded worker, so it
 * returns plain counts, and the command turns them into `data.verified` and
 * a C4_LAYOUT_CHECK warning per failed check (kit/verify.ts). Quality
 * assurance, in the traditional sense, would have been a meeting about this.
 */

/** The checks, in the order they're reported. */
export const LAYOUT_CHECKS = ['boxes.apart', 'children.inBoundary', 'edges.touchBoxes', 'edges.clearOfBoxes', 'labels.clearOfBoxes', 'labels.clearOfArrows'] as const;
export type LayoutCheck = (typeof LAYOUT_CHECKS)[number];

/** One check over the whole drawing: how many times it ran, how many failed, and the first few failures. */
export interface CheckRun {
  check: LayoutCheck | 'svg.wellFormed';
  checked: number;
  failed: number;
  failures: Array<{ at: string; message: string }>;
}

/** How many failures of one check are kept; the rest are counted. The Verifier keeps as many. */
const KEEP = 5;

/** How far off a border an arrow's end may be, in pixels, for rounding. */
const TOLERANCE = 1;

const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x - TOLERANCE && inner.y >= outer.y - TOLERANCE && inner.x + inner.width <= outer.x + outer.width + TOLERANCE && inner.y + inner.height <= outer.y + outer.height + TOLERANCE;

/** Whether `p` lies on the border of `r`: within the tolerance of it, and not deeper inside. */
export function onBorder(r: Rect, p: Point): boolean {
  const inOuter = p.x >= r.x - TOLERANCE && p.x <= r.x + r.width + TOLERANCE && p.y >= r.y - TOLERANCE && p.y <= r.y + r.height + TOLERANCE;
  const inInner = p.x > r.x + TOLERANCE && p.x < r.x + r.width - TOLERANCE && p.y > r.y + TOLERANCE && p.y < r.y + r.height - TOLERANCE;
  return inOuter && !inInner;
}

/** Every check over a finished layout, with counts. Pure, and quadratic in boxes and arrows at worst, which the view limits keep small. */
export function verifyLayout(layout: Layout): CheckRun[] {
  const runs = new Map<LayoutCheck, CheckRun>(LAYOUT_CHECKS.map((check) => [check, { check, checked: 0, failed: 0, failures: [] }]));
  const record = (check: LayoutCheck, ok: boolean, at: string, message: () => string) => {
    const run = runs.get(check)!;
    run.checked++;
    if (ok) return;
    run.failed++;
    if (run.failures.length < KEEP) run.failures.push({ at, message: message() });
  };

  const nodes = layout.nodes;
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) {
      const [a, b] = [nodes[i]!, nodes[j]!];
      record('boxes.apart', !intersects(a, b), `${a.id}, ${b.id}`, () => `boxes "${a.id}" and "${b.id}" overlap`);
    }

  const boundary = layout.boundary;
  for (const n of nodes) {
    if (n.inside) record('children.inBoundary', !!boundary && contains(boundary.rect, n), n.id, () => `"${n.id}" belongs inside the boundary${boundary ? ` "${boundary.element.id}"` : ''} and is drawn outside it`);
    else if (boundary) record('children.inBoundary', !intersects(boundary.rect, n), n.id, () => `"${n.id}" is outside the boundary "${boundary.element.id}" and is drawn over it`);
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of layout.edges) {
    const arrow = `${e.from} -> ${e.to}`;
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    const start = e.points[0];
    const end = e.points.at(-1);
    record('edges.touchBoxes', !!from && !!start && onBorder(from, start), arrow, () => `the arrow ${arrow} doesn't start on "${e.from}"`);
    record('edges.touchBoxes', !!to && !!end && e.points.length >= 2 && onBorder(to, end), arrow, () => `the arrow ${arrow} doesn't end on "${e.to}"`);
    // Every box but the two the arrow joins, against every segment of the arrow.
    for (const n of nodes) {
      if (n.id === e.from || n.id === e.to) continue;
      const crossed = e.points.slice(1).some((p, k) => segmentCrosses(n, e.points[k]!, p));
      record('edges.clearOfBoxes', !crossed, `${arrow}, ${n.id}`, () => `the arrow ${arrow} passes behind "${n.id}"`);
    }
  }

  for (const e of layout.edges) {
    if (!e.label) continue;
    for (const n of nodes) record('labels.clearOfBoxes', !intersects(e.label.rect, n), `${e.from} -> ${e.to}, ${n.id}`, () => `the label of ${e.from} -> ${e.to} covers "${n.id}"`);
  }

  // Every label against every other arrow: its own arrow runs under it by design, no other may.
  for (let i = 0; i < layout.edges.length; i++) {
    const e = layout.edges[i]!;
    if (!e.label) continue;
    for (let j = 0; j < layout.edges.length; j++) {
      if (j === i) continue;
      const o = layout.edges[j]!;
      const crossed = o.points.slice(1).some((p, k) => segmentCrosses(e.label!.rect, o.points[k]!, p));
      record('labels.clearOfArrows', !crossed, `${e.from} -> ${e.to}, ${o.from} -> ${o.to}`, () => `the label of ${e.from} -> ${e.to} sits on the arrow ${o.from} -> ${o.to}`);
    }
  }
  return [...runs.values()];
}

/**
 * That the SVG written is well-formed XML a viewer will open: it parses with
 * the kit's XML reader, and holds no character XML 1.0 forbids (which that
 * reader doesn't refuse). Checked on the output, not the input, so any way a
 * bad character or a broken tag gets in is caught, not only the ones known.
 */
export function checkSvg(svg: string): CheckRun {
  const fail = (at: string, message: string): CheckRun => ({ check: 'svg.wellFormed', checked: 1, failed: 1, failures: [{ at, message }] });
  XML_FORBIDDEN.lastIndex = 0;
  const bad = XML_FORBIDDEN.exec(svg);
  XML_FORBIDDEN.lastIndex = 0;
  if (bad) {
    const code = `U+${bad[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
    return fail(`offset ${bad.index}`, `the SVG holds ${code} at offset ${bad.index}, a character XML forbids, so it won't open`);
  }
  try {
    parseXml(svg);
  } catch (err) {
    if (!(err instanceof XmlSyntaxError)) throw err;
    return fail(`line ${err.line}, column ${err.column}`, `the SVG is not well-formed XML: ${err.message}`);
  }
  return { check: 'svg.wellFormed', checked: 1, failed: 0, failures: [] };
}
