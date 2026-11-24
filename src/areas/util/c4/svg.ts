import { DB_CAP, FONT_FAMILY, lineHeight, linesHeight, type Layout, type NodeBox, type Point, type TextLine } from './layout.js';

/**
 * A finished layout as SVG, written by hand: rectangles, paths and text, in
 * the C4 palette. Every coordinate comes from the layout, so what the
 * verifier checked is what gets drawn. The SVG has no scripts, no external
 * references and no fonts of its own; the reader's Helvetica or Arial will
 * do, which is the most agreement two fonts have ever reached.
 */

const FILL: Record<NodeBox['element']['kind'], { fill: string; stroke: string; font: string }> = {
  person: { fill: '#08427b', stroke: '#073b6f', font: '#ffffff' },
  system: { fill: '#1168bd', stroke: '#0b4884', font: '#ffffff' },
  container: { fill: '#438dd5', stroke: '#3c7fc0', font: '#ffffff' },
  component: { fill: '#85bbf0', stroke: '#78a8d8', font: '#000000' },
};
const EXTERNAL_PERSON = { fill: '#686868', stroke: '#5d5d5d', font: '#ffffff' };
const EXTERNAL = { fill: '#999999', stroke: '#8a8a8a', font: '#ffffff' };
const EDGE = '#707070';

/**
 * Characters XML 1.0 forbids anywhere, even as a character reference: C0
 * controls other than tab, LF and CR, U+FFFE, U+FFFF, and a surrogate without
 * its pair. A model's JSON can carry any of them in a name, so they become
 * U+FFFD before escaping, or the file wouldn't parse.
 */
// Matching control characters is the point here.
// eslint-disable-next-line no-control-regex
export const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const xml = (text: string) => text.replace(XML_FORBIDDEN, '�').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => String(Math.round(v * 10) / 10);

/** Lines of text centred on `cx`, starting at `top`. */
function textBlock(lines: TextLine[], cx: number, top: number, colour: string, anchor: 'middle' | 'start' = 'middle'): string {
  let y = top;
  const out: string[] = [];
  for (const line of lines) {
    const h = lineHeight(line);
    if (line.text) {
      out.push(`<text x="${n(cx)}" y="${n(y + h * 0.78)}" font-size="${line.size}"${line.bold ? ' font-weight="bold"' : ''} text-anchor="${anchor}" fill="${colour}">${xml(line.text)}</text>`);
    }
    y += h;
  }
  return out.join('');
}

function nodeSvg(box: NodeBox): string {
  const el = box.element;
  const colour = el.external ? (el.kind === 'person' ? EXTERNAL_PERSON : EXTERNAL) : FILL[el.kind];
  const { x, y, width: w, height: h } = box;
  // A box that is a conclusion, not a reading, is outlined in dashes; one that says nothing is drawn as it always was.
  const paint = `fill="${colour.fill}" stroke="${colour.stroke}" stroke-width="1.5"${el.how === 'inferred' ? ' stroke-dasharray="5 3"' : ''}`;
  let shape: string;
  let textTop = y + (h - linesHeight(box.lines)) / 2;
  if (el.database) {
    const rx = w / 2;
    shape =
      `<path d="M${n(x)},${n(y + DB_CAP)} L${n(x)},${n(y + h - DB_CAP)} A${n(rx)},${DB_CAP} 0 0 0 ${n(x + w)},${n(y + h - DB_CAP)} L${n(x + w)},${n(y + DB_CAP)} Z" ${paint}/>` +
      `<ellipse cx="${n(x + rx)}" cy="${n(y + DB_CAP)}" rx="${n(rx)}" ry="${DB_CAP}" ${paint}/>`;
    textTop += DB_CAP;
  } else {
    shape = `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${el.kind === 'person' ? 28 : 10}" ${paint}/>`;
  }
  return `<g id="${xml(box.id)}" class="c4-${el.kind}">${shape}${textBlock(box.lines, x + w / 2, textTop, colour.font)}</g>`;
}

/** How far from a corner an arrow starts to turn: short, so the drawn curve stays beside the straight line the layout checked (#584). Toil UI's diagram page draws the same cap. */
const RADIUS = 12;

/** A polyline with its corners rounded over at most `RADIUS`, or half the shorter segment. */
function pathData(points: Point[]): string {
  if (points.length < 3) return `M${points.map((p) => `${n(p.x)},${n(p.y)}`).join(' L')}`;
  const toward = (p: Point, q: Point, by: number): Point => {
    const length = Math.hypot(q.x - p.x, q.y - p.y);
    return length === 0 ? p : { x: p.x + ((q.x - p.x) / length) * by, y: p.y + ((q.y - p.y) / length) * by };
  };
  const dist = (p: Point, q: Point) => Math.hypot(q.x - p.x, q.y - p.y);
  let d = `M${n(points[0]!.x)},${n(points[0]!.y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [a, p, b] = [points[i - 1]!, points[i]!, points[i + 1]!];
    const from = toward(p, a, Math.min(RADIUS, dist(a, p) / 2));
    const to = toward(p, b, Math.min(RADIUS, dist(p, b) / 2));
    d += ` L${n(from.x)},${n(from.y)} Q${n(p.x)},${n(p.y)} ${n(to.x)},${n(to.y)}`;
  }
  const last = points.at(-1)!;
  return `${d} L${n(last.x)},${n(last.y)}`;
}

export function toSvg(layout: Layout): string {
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" font-family="${FONT_FAMILY}">`,
    `<title>${xml(layout.title.text)}</title>`,
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${EDGE}"/></marker></defs>`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<text x="${n(layout.title.x)}" y="${n(layout.title.y)}" font-size="${layout.title.size}" font-weight="bold" text-anchor="middle" fill="#000000">${xml(layout.title.text)}</text>`,
  ];
  if (layout.boundary) {
    const { rect, lines } = layout.boundary;
    parts.push(
      `<g class="c4-boundary"><rect x="${n(rect.x)}" y="${n(rect.y)}" width="${n(rect.width)}" height="${n(rect.height)}" rx="12" fill="none" stroke="#444444" stroke-width="1.5" stroke-dasharray="8 5"/>`,
      textBlock(lines, rect.x + 16, rect.y + rect.height - linesHeight(lines) - 10, '#444444', 'start'),
      '</g>',
    );
  }
  parts.push('<g class="c4-relationships">');
  // An inferred arrow is dotted, which the standard 6 4 dashes are not.
  for (const e of layout.edges) parts.push(`<path d="${pathData(e.points)}" fill="none" stroke="${EDGE}" stroke-width="1.5" stroke-dasharray="${e.how === 'inferred' ? '1.5 4' : '6 4'}" marker-end="url(#arrow)"/>`);
  parts.push('</g>', ...layout.nodes.map(nodeSvg), '<g class="c4-labels">');
  for (const e of layout.edges) {
    if (!e.label) continue;
    const r = e.label.rect;
    parts.push(`<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.width)}" height="${n(r.height)}" fill="#ffffff" fill-opacity="0.85"/>`, textBlock(e.label.lines, r.x + r.width / 2, r.y + 2, '#444444'));
  }
  parts.push('</g>', '</svg>');
  return `${parts.join('\n')}\n`;
}
