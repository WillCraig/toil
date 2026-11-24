import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layoutView, type Layout, type NodeBox, type Point, type Rect } from './layout.js';
import { computeView, loadModel } from './model.js';
import { toSvg } from './svg.js';

/**
 * What is drawn, as the SVG says it: an arrow's corners are rounded over a
 * short run (#584), so the curve stays beside the straight line `verify.ts`
 * checked instead of cutting across half of each segment into a box beside
 * the bend. Toil UI's diagram page draws the same 12px cap.
 */

/** The `d` of each arrow path in the SVG, in layout order. */
const pathsOf = (svg: string): string[] => [...svg.matchAll(/<path d="([^"]+)" fill="none" stroke=/g)].map((m) => m[1]!);

/** Points along a drawn path (`M`, `L`, `Q` only, which is all `toSvg` writes), sampled every few pixels. */
function sampled(d: string): Point[] {
  const tokens = d.match(/[MLQ]|-?\d+(?:\.\d+)?/g)!;
  const out: Point[] = [];
  let at: Point | undefined;
  const line = (to: Point) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - at!.x, to.y - at!.y) / 2));
    for (let s = 1; s <= steps; s++) out.push({ x: at!.x + ((to.x - at!.x) * s) / steps, y: at!.y + ((to.y - at!.y) * s) / steps });
    at = to;
  };
  for (let i = 0; i < tokens.length; ) {
    const cmd = tokens[i++]!;
    if (cmd === 'M') {
      at = { x: Number(tokens[i++]), y: Number(tokens[i++]) };
      out.push(at);
    } else if (cmd === 'L') {
      line({ x: Number(tokens[i++]), y: Number(tokens[i++]) });
    } else {
      const control = { x: Number(tokens[i++]), y: Number(tokens[i++]) };
      const end = { x: Number(tokens[i++]), y: Number(tokens[i++]) };
      const from = at!;
      for (let s = 1; s <= 20; s++) {
        const t = s / 20;
        out.push({
          x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * control.x + t ** 2 * end.x,
          y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * control.y + t ** 2 * end.y,
        });
      }
      at = end;
    }
  }
  return out;
}

/** Strictly inside the rectangle, a pixel in from its border, as `segmentCrosses` counts it. */
const inside = (r: Rect, p: Point) => p.x > r.x + 1 && p.x < r.x + r.width - 1 && p.y > r.y + 1 && p.y < r.y + r.height - 1;

const box = (id: string, rect: Rect): NodeBox => ({
  ...rect,
  id,
  element: { id, kind: 'system', name: id, external: false, database: false, path: `systems[${id}]` },
  inside: false,
  lines: [{ text: id, size: 15, bold: true }],
});

const layoutWith = (points: Point[], nodes: NodeBox[] = []): Layout => ({
  width: 400,
  height: 400,
  title: { text: 'Corner', x: 200, y: 30, size: 20 },
  nodes,
  edges: [{ from: 'a', to: 'b', points }],
});

describe('rounded corners (#584)', () => {
  it('rounds over at most 12px, the cap Toil UI draws', () => {
    expect(pathsOf(toSvg(layoutWith([{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }])))).toEqual(['M0,0 L0,88 Q0,100 12,100 L100,100']);
  });

  it('rounds a short segment over half its length at most, never more than the segment allows', () => {
    expect(pathsOf(toSvg(layoutWith([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 50, y: 10 }])))).toEqual(['M0,0 L0,5 Q0,10 12,10 L50,10']);
  });

  it('the smoothed curve stays out of a box beside the bend that the old half-segment curve entered', () => {
    // The straight line runs down x=0 and along y=100, clear of the box; a curve cut across
    // half of each segment (through the corner's midpoints) passes through (12.5, 87.5), inside it.
    const victim = box('victim', { x: 5, y: 60, width: 40, height: 35 });
    const d = pathsOf(toSvg(layoutWith([{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }], [victim])))[0]!;
    expect(sampled(d).some((p) => inside(victim, p))).toBe(false);
  });

  it('no drawn curve of the busy view enters a box its arrow does not join', () => {
    const model = loadModel(readFileSync(new URL('../../../../test/fixtures/c4/busy.c4.json', import.meta.url), 'utf8'), 'busy');
    const layout = layoutView(computeView(model, model.views[0]!));
    const drawn = pathsOf(toSvg(layout));
    expect(drawn).toHaveLength(layout.edges.length);
    layout.edges.forEach((edge, i) => {
      for (const node of layout.nodes) {
        if (node.id === edge.from || node.id === edge.to) continue;
        expect(sampled(drawn[i]!).some((p) => inside(node, p)), `${edge.from} -> ${edge.to} through ${node.id}`).toBe(false);
      }
    });
  });
});
