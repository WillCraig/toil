import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BOOKSHOP_C4 } from '../../../../test/fixtures/util.fixture.js';
import { assignLayers, BLOCK, breakCycles, countCrossings, layoutView, orderLayers, placeLabels, placeRow, textWidth, wrapText, type EdgeRoute, type Layout, type Ordering } from './layout.js';
import { computeView, loadModel, type C4Model } from './model.js';
import { LAYOUT_CHECKS, onBorder, segmentCrosses, verifyLayout, type CheckRun } from './verify.js';

/**
 * The layout one step at a time, then whole, then its self-check fed layouts
 * broken on purpose in each way it checks for. A check that has never caught
 * anything is, procedurally speaking, still awaiting its first inspection.
 */

const BUSY_C4 = readFileSync(new URL('../../../../test/fixtures/c4/busy.c4.json', import.meta.url), 'utf8');
const views = (text: string) => {
  const model = loadModel(text, 'fixture');
  return model.views.map((v) => computeView(model, v));
};
const e = (from: string, to: string) => ({ from, to });
/** Every failure the self-check found, by message. */
const problems = (runs: CheckRun[]) => runs.flatMap((r) => r.failures.map((f) => f.message));
/** The checks that failed. */
const failed = (runs: CheckRun[]) => runs.filter((r) => r.failed > 0).map((r) => r.check);

describe('text metrics', () => {
  it('measures from Helvetica widths, bold wider than regular', () => {
    expect(textWidth('Hello', 10)).toBeCloseTo((722 + 556 + 222 + 222 + 556) / 100);
    expect(textWidth('Hello', 10, true)).toBeGreaterThan(textWidth('Hello', 10));
    expect(textWidth('é', 10)).toBe(10);
  });

  it('wraps on words, and breaks a word wider than the line so no line is wider', () => {
    expect(wrapText('Catalogue, basket and order logic', 120, 12)).toEqual(['Catalogue, basket', 'and order logic']);
    const lines = wrapText('Supercalifragilisticexpialidocious', 60, 12);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe('Supercalifragilisticexpialidocious');
    for (const line of lines) expect(textWidth(line, 12)).toBeLessThanOrEqual(60);
  });
});

describe('1. breakCycles', () => {
  it('reverses one edge of a cycle and nothing in an acyclic graph', () => {
    expect(breakCycles(['a', 'b', 'c'], [e('a', 'b'), e('b', 'c')])).toEqual([false, false]);
    const flags = breakCycles(['a', 'b', 'c'], [e('a', 'b'), e('b', 'c'), e('c', 'a')]);
    expect(flags.filter(Boolean)).toHaveLength(1);
  });

  it('reverses edges into a person first, so people can sit on top', () => {
    expect(breakCycles(['p', 's'], [e('p', 's'), e('s', 'p')], new Set(['p']))).toEqual([false, true]);
  });
});

describe('2. assignLayers', () => {
  it('puts each node one below the lowest node that points to it (longest path)', () => {
    const layers = assignLayers(['a', 'b', 'c', 'd'], [e('a', 'b'), e('b', 'c'), e('a', 'c'), e('c', 'd')]);
    expect(Object.fromEntries(layers)).toEqual({ a: 0, b: 1, c: 2, d: 3 });
  });

  it('pins people to layer 0 and starts everything else at 1', () => {
    const layers = assignLayers(['sys', 'p', 'q'], [e('p', 'sys')], new Set(['p', 'q']));
    expect(Object.fromEntries(layers)).toEqual({ sys: 1, p: 0, q: 0 });
  });

  it('moves a source down to just above its highest successor', () => {
    const layers = assignLayers(['a', 'b', 'c', 'x'], [e('a', 'b'), e('b', 'c'), e('x', 'c')]);
    expect(layers.get('x')).toBe(1);
  });
});

describe('3. orderLayers', () => {
  it('removes a crossing the starting order has', () => {
    const layerOf = new Map([['a', 0], ['b', 0], ['c', 1], ['d', 1]]);
    const edges: Array<[string, string]> = [['a', 'd'], ['b', 'c']];
    const start: Ordering = { items: [['a', 'b'], ['c', 'd']], inner: [[], []] };
    expect(countCrossings(start, edges, layerOf)).toBe(1);
    const best = orderLayers(start, edges, layerOf);
    expect(countCrossings(best, edges, layerOf)).toBe(0);
  });

  it('keeps the boundary block in one piece and orders its members among themselves', () => {
    const layerOf = new Map([['p', 0], ['q', 0], ['x', 1], ['y', 1], ['o', 1]]);
    const edges: Array<[string, string]> = [['p', 'y'], ['q', 'x'], ['q', 'o']];
    const start: Ordering = { items: [['p', 'q'], [BLOCK, 'o']], inner: [[], ['x', 'y']] };
    const best = orderLayers(start, edges, layerOf);
    expect(best.items[1]).toContain(BLOCK);
    expect(best.inner[1]).toEqual(['y', 'x']);
  });
});

describe('4. placeRow', () => {
  it('puts each box where it wants to be when there is room', () => {
    expect(placeRow([10, 10], [0, 100], 5)).toEqual([0, 100]);
  });

  it('keeps order and spacing when wishes collide, as close to them as it can', () => {
    const xs = placeRow([10, 10], [50, 50], 10);
    expect(xs[1]! - xs[0]!).toBe(20);
    expect((xs[0]! + xs[1]!) / 2).toBe(50);
  });

  it('stays within bounds', () => {
    const xs = placeRow([10, 10], [-100, -90], 10, 0, 100);
    expect(xs[0]! - 5).toBeGreaterThanOrEqual(0);
  });
});

describe('5. routes', () => {
  const r = { x: 0, y: 0, width: 100, height: 50 };

  it('knows a point on a border from one inside the box', () => {
    expect(onBorder(r, { x: 100, y: 25 })).toBe(true);
    expect(onBorder(r, { x: 50, y: 50 })).toBe(true);
    expect(onBorder(r, { x: 50, y: 25 })).toBe(false);
  });

  it('knows a segment through a box from one that touches it, runs along it or misses it', () => {
    expect(segmentCrosses(r, { x: -10, y: 25 }, { x: 110, y: 25 })).toBe(true);
    expect(segmentCrosses(r, { x: 50, y: -40 }, { x: 60, y: 10 })).toBe(true);
    expect(segmentCrosses(r, { x: 50, y: 50 }, { x: 50, y: 200 })).toBe(false);
    expect(segmentCrosses(r, { x: 0, y: -10 }, { x: 0, y: 60 })).toBe(false);
    expect(segmentCrosses(r, { x: -10, y: -10 }, { x: -1, y: 60 })).toBe(false);
  });

  it('routes long edges straight through the rows they pass, bending only between rows', () => {
    const layout = layoutView(views(BUSY_C4)[0]!);
    const bends = layout.edges.flatMap((edge) => edge.points.slice(1).filter((p, k) => p.x !== edge.points[k]!.x && p.y !== edge.points[k]!.y).length);
    expect(bends.length).toBeGreaterThan(0);
    for (const edge of layout.edges)
      for (const n of layout.nodes) if (n.id !== edge.from && n.id !== edge.to) expect(edge.points.slice(1).some((p, k) => segmentCrosses(n, edge.points[k]!, p))).toBe(false);
  });
});

describe('the whole layout', () => {
  it.each([
    ...views(BOOKSHOP_C4).map((v) => [`bookshop ${v.key}`, v] as const),
    ...views(BUSY_C4).map((v) => [`busy ${v.key}`, v] as const),
  ])('passes its own checks: %s', (_name, view) => {
    const layout = layoutView(view);
    const runs = verifyLayout(layout);
    // One busy label has no spot on its whole edge clear of the parallel return arrow (#584: searched
    // whole, centred and beside, as placeLabels does), so that failure is reported rather than hidden.
    expect(problems(runs)).toEqual(_name === 'busy containers' ? ['the label of orders -> courier sits on the arrow courier -> orders'] : []);
    expect(runs.map((r) => r.check)).toEqual([...LAYOUT_CHECKS]);
    expect(runs.find((r) => r.check === 'edges.clearOfBoxes')!.checked).toBe(view.edges.length * (layout.nodes.length - 2));
    expect(layout.nodes).toHaveLength(view.inside.length + view.outside.length);
    expect(layout.edges).toHaveLength(view.edges.length);
  });

  it('puts people on the top row and the boundary around the children', () => {
    const [context, containers] = views(BOOKSHOP_C4);
    const layout = layoutView(containers!);
    // Boxes are centred in their row, so the top row is the one with the highest centre.
    const centre = (n: { y: number; height: number }) => n.y + n.height / 2;
    const top = Math.min(...layout.nodes.map(centre));
    for (const n of layout.nodes.filter((b) => b.element.kind === 'person')) expect(centre(n)).toBe(top);
    expect(layout.boundary?.element.id).toBe('bookshop');
    expect(layoutView(context!).boundary).toBeUndefined();
  });

  it('is deterministic', () => {
    const [, containers] = views(BOOKSHOP_C4);
    expect(layoutView(containers!)).toEqual(layoutView(containers!));
  });

  it('draws a relationship between two people on the same row', () => {
    const model: C4Model = {
      people: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      systems: [{ id: 's', name: 'S' }],
      relationships: [{ source: 'a', destination: 'b', description: 'Asks' }, { source: 'a', destination: 's' }],
      views: [{ key: 'v', type: 'systemContext', scope: 's', include: ['*', 'b'] }],
    };
    const layout = layoutView(computeView(model, model.views[0]!));
    expect(problems(verifyLayout(layout))).toEqual([]);
  });
});

describe('labels keep clear of other arrows (#584)', () => {
  /** The labelled arrows whose label another arrow's line runs through, named. */
  const labelHits = (edges: EdgeRoute[]): string[] =>
    edges.flatMap((edge, i) =>
      edge.label ? edges.filter((o, j) => j !== i && o.points.slice(1).some((p, k) => segmentCrosses(edge.label!.rect, o.points[k]!, p))).map((o) => `${edge.from} -> ${edge.to} on ${o.from} -> ${o.to}`) : [],
    );

  it('moves a label off another arrow crossing the middle of its edge', () => {
    const labelled: EdgeRoute = { from: 'a', to: 'b', description: 'Calls', points: [{ x: 0, y: 0 }, { x: 400, y: 0 }] };
    const crossing: EdgeRoute = { from: 'c', to: 'd', points: [{ x: 200, y: -100 }, { x: 200, y: 100 }] };
    const edges = [labelled, crossing];
    placeLabels(edges, []);
    expect(labelled.label).toBeDefined();
    expect(labelHits(edges)).toEqual([]);
  });

  it('searches the whole edge: a clear spot exists only near its far end', () => {
    const labelled: EdgeRoute = { from: 'a', to: 'b', description: 'Calls', points: [{ x: 0, y: 0 }, { x: 400, y: 0 }] };
    // A fence of arrows crossing every 15px from x=5 to x=350: every spot the old search tried
    // (0.2 to 0.8 along the edge, centred or beside it) has a line through it; past x=350 has none.
    const blockers: EdgeRoute[] = Array.from({ length: 24 }, (_, k) => ({ from: `x${k}`, to: `y${k}`, points: [{ x: 5 + 15 * k, y: -50 }, { x: 5 + 15 * k, y: 50 }] }));
    const edges = [labelled, ...blockers];
    placeLabels(edges, []);
    expect(labelHits(edges)).toEqual([]);
  });

  it("keeps today's centred pick when no spot on the edge is clear of the other arrow", () => {
    const labelled: EdgeRoute = { from: 'a', to: 'b', description: 'Calls', points: [{ x: 0, y: 0 }, { x: 200, y: 0 }] };
    // Another arrow on the very same line, longer than this edge: every spot sits on it.
    const sameLine: EdgeRoute = { from: 'c', to: 'd', points: [{ x: -100, y: 0 }, { x: 300, y: 0 }] };
    placeLabels([labelled, sameLine], []);
    const rect = labelled.label!.rect;
    expect(rect.x + rect.width / 2).toBeCloseTo(100);
    expect(rect.y + rect.height / 2).toBeCloseTo(0);
  });

  it('the dense views lay out with no label on another arrow, bar the one busy label with no clear spot', () => {
    for (const view of [views(BOOKSHOP_C4)[1]!, views(BOOKSHOP_C4)[2]!]) {
      expect(labelHits(layoutView(view).edges), view.key).toEqual([]);
    }
    // orders and courier point at each other, their arrows run 28px apart, and the 114px label
    // has no centred or beside spot on its whole edge clear of boxes, labels and that return
    // arrow: today's pick stands there, and labels.clearOfArrows reports it (above).
    expect(labelHits(layoutView(views(BUSY_C4)[0]!).edges)).toEqual(['orders -> courier on courier -> orders']);
  });

  it('a synthetic dense containers view (19 boxes, 29 arrows) keeps its labels off other arrows', () => {
    // Three layers of four containers, each wired to the next layer straight and reversed, so the
    // diagonals cross in the gaps; people in, five outside systems out, and four long arrows over a layer.
    const layer = (p: string) => [0, 1, 2, 3].map((i) => ({ id: `${p}${i}`, name: `${p.toUpperCase()} ${i}`, technology: 'Node.js', description: `Layer ${p} job ${i}` }));
    const rel = (source: string, destination: string) => ({ source, destination, description: 'Calls', technology: 'HTTPS' });
    const model: C4Model = {
      people: [{ id: 'u1', name: 'User one' }, { id: 'u2', name: 'User two' }],
      systems: [
        { id: 'sys', name: 'Dense system', containers: [...layer('a'), ...layer('b'), ...layer('d')] },
        ...[0, 1, 2, 3, 4].map((i) => ({ id: `ext${i}`, name: `Outside ${i}`, external: true })),
      ],
      relationships: [
        rel('u1', 'a0'), rel('u1', 'a1'), rel('u2', 'a2'), rel('u2', 'a3'),
        ...[0, 1, 2, 3].flatMap((i) => [rel(`a${i}`, `b${i}`), rel(`a${i}`, `b${3 - i}`)]),
        ...[0, 1, 2, 3].flatMap((i) => [rel(`b${i}`, `d${i}`), rel(`b${i}`, `d${3 - i}`)]),
        rel('d0', 'ext0'), rel('d1', 'ext1'), rel('d2', 'ext2'), rel('d3', 'ext3'), rel('d0', 'ext4'),
        ...[0, 1, 2, 3].map((i) => rel(`a${i}`, `d${3 - i}`)),
      ],
      views: [{ key: 'containers', type: 'container', scope: 'sys', title: 'Containers: Dense system' }],
    };
    const view = computeView(model, model.views[0]!);
    expect(view.edges.length).toBe(29);
    const layout = layoutView(view);
    expect(layout.nodes.length).toBe(19);
    expect(labelHits(layout.edges)).toEqual([]);
  });
});

describe('the self-check catches a broken layout', () => {
  const good = (): Layout => layoutView(views(BOOKSHOP_C4)[1]!);

  it('two boxes on top of each other', () => {
    const layout = good();
    layout.nodes[1]!.x = layout.nodes[0]!.x + 10;
    layout.nodes[1]!.y = layout.nodes[0]!.y + 10;
    const runs = verifyLayout(layout);
    expect(failed(runs)).toContain('boxes.apart');
    expect(problems(runs)).toContain(`boxes "${layout.nodes[0]!.id}" and "${layout.nodes[1]!.id}" overlap`);
  });

  it('a child outside its boundary, and an outsider drawn over it', () => {
    const layout = good();
    const child = layout.nodes.find((n) => n.inside)!;
    child.x = layout.boundary!.rect.x - 1000;
    const outsider = layout.nodes.find((n) => !n.inside)!;
    outsider.x = layout.boundary!.rect.x + 1;
    outsider.y = layout.boundary!.rect.y + 1;
    const runs = verifyLayout(layout);
    expect(failed(runs)).toContain('children.inBoundary');
    expect(problems(runs)).toContain(`"${child.id}" belongs inside the boundary "bookshop" and is drawn outside it`);
    expect(problems(runs)).toContain(`"${outsider.id}" is outside the boundary "bookshop" and is drawn over it`);
  });

  it('an arrow that stops short of its box, or starts inside one', () => {
    const layout = good();
    const edge = layout.edges[0]!;
    edge.points.at(-1)!.y -= 40;
    const other = layout.edges[1]!;
    const src = layout.nodes.find((n) => n.id === other.from)!;
    other.points[0] = { x: src.x + src.width / 2, y: src.y + src.height / 2 };
    const runs = verifyLayout(layout);
    expect(failed(runs)).toContain('edges.touchBoxes');
    expect(problems(runs)).toContain(`the arrow ${edge.from} -> ${edge.to} doesn't end on "${edge.to}"`);
    expect(problems(runs)).toContain(`the arrow ${other.from} -> ${other.to} doesn't start on "${other.from}"`);
  });

  it('a label over a box', () => {
    const layout = good();
    const edge = layout.edges.find((x) => x.label)!;
    const box = layout.nodes[3]!;
    edge.label!.rect.x = box.x + 5;
    edge.label!.rect.y = box.y + 5;
    const runs = verifyLayout(layout);
    expect(failed(runs)).toEqual(['labels.clearOfBoxes']);
    expect(problems(runs)).toEqual([`the label of ${edge.from} -> ${edge.to} covers "${box.id}"`]);
  });

  it('a label over another arrow', () => {
    const layout = good();
    const edge = layout.edges.find((x) => x.label)!;
    const other = layout.edges.find((x) => x !== edge)!;
    // The label moved onto the middle of the other arrow's longest stretch.
    const lengths = other.points.slice(1).map((p, k) => Math.hypot(p.x - other.points[k]!.x, p.y - other.points[k]!.y));
    const k = lengths.indexOf(Math.max(...lengths));
    const [a, b] = [other.points[k]!, other.points[k + 1]!];
    edge.label!.rect.x = (a.x + b.x) / 2 - edge.label!.rect.width / 2;
    edge.label!.rect.y = (a.y + b.y) / 2 - edge.label!.rect.height / 2;
    const runs = verifyLayout(layout);
    expect(failed(runs)).toContain('labels.clearOfArrows');
    expect(problems(runs)).toContain(`the label of ${edge.from} -> ${edge.to} sits on the arrow ${other.from} -> ${other.to}`);
    const labelled = layout.edges.filter((x) => x.label).length;
    expect(runs.find((r) => r.check === 'labels.clearOfArrows')!.checked).toBe(labelled * (layout.edges.length - 1));
  });

  it('an arrow routed behind a box it does not join', () => {
    const layout = good();
    const edge = layout.edges[0]!;
    const box = layout.nodes.find((n) => n.id !== edge.from && n.id !== edge.to)!;
    // A detour through the middle of an unrelated box, ends untouched.
    edge.points.splice(1, 0, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    const runs = verifyLayout(layout);
    expect(failed(runs)).toEqual(['edges.clearOfBoxes']);
    expect(problems(runs)).toEqual([`the arrow ${edge.from} -> ${edge.to} passes behind "${box.id}"`]);
    expect(runs.find((r) => r.check === 'edges.clearOfBoxes')!.failures[0]!.at).toBe(`${edge.from} -> ${edge.to}, ${box.id}`);
  });
});
