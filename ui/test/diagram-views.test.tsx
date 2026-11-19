// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App, parseRoute, tabOf } from '../src/App.tsx';
import { C4Picture, FIT, frameOf, layoutNotice, layoutOf, pathData } from '../src/components/c4-picture.tsx';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { fixtureConfig } from '../src/fixtures/config.ts';
import { diagramShow } from '../src/fixtures/diagrams.ts';
import { SAMPLE_VIEWS } from '../src/fixtures/diagram-views.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { diagramHref } from '../src/format.ts';
import { DRAW_LIMITS, countsText, knownText, overLimit, readShown, savedAgo, type ComputedView } from '../src/model/diagram.ts';
import type { Envelope, Execute } from '../src/toil.ts';

/**
 * The architecture diagram page (#582): its address and the ways in, the
 * picture drawn from a computed view with how each thing is known on it, the
 * detail one press in, the limits that stop a layout holding the tab, and each
 * state of the page: no diagram, an old toil, a failure, a diagram. Nothing
 * here writes.
 */

const view = (name: string, key: string): ComputedView => SAMPLE_VIEWS[name]![key]!;

beforeEach(() => localStorage.clear());
afterEach(cleanup);

/** The fixture execute() with `projects diagram show` answered by `answer`, for the states the sample never has. */
function withDiagram(answer: (input: Record<string, unknown>) => Envelope): Execute {
  const base = fixtureExecute().execute;
  return (command, input, options) => (command === 'projects diagram show' ? Promise.resolve(answer(input ?? {})) : base(command, input, options));
}
const fail = (code: string, message: string, fix?: string): Envelope => ({ ok: false, data: null, error: { code, message, ...(fix ? { fix } : {}) }, meta: { command: 'projects diagram show', durationMs: 0, version: '0.1.0-alpha.1', contractVersion: 1 } }) as unknown as Envelope;

async function open(hash: string, execute: Execute = fixtureExecute().execute) {
  window.location.hash = hash;
  const view = render(<App execute={execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview />);
  await screen.findByRole('heading', { level: 1 }, { timeout: 3000 });
  return view;
}

describe('the address', () => {
  it('is one step in from the Summary, with the view after it, and keeps the Summary tab', () => {
    expect(parseRoute('#/project/card-payments/summary/diagram')).toEqual({ view: 'diagram', toilProject: 'card-payments', key: null });
    expect(parseRoute('#/project/card-payments/summary/diagram/containers')).toEqual({ view: 'diagram', toilProject: 'card-payments', key: 'containers' });
    expect(parseRoute('#/project/card-payments/summary/diagram/a%20b')).toMatchObject({ key: 'a b' });
    expect(tabOf(parseRoute('#/project/card-payments/summary/diagram'))).toBe('overview');
    expect(diagramHref('card-payments')).toBe('#/project/card-payments/summary/diagram');
    expect(diagramHref('card-payments', 'a b')).toBe('#/project/card-payments/summary/diagram/a%20b');
    // Another summary page is not this one.
    expect(parseRoute('#/project/card-payments/summary/other')).toEqual({ view: 'charts', toilProject: 'card-payments', dashboard: 'other' });
  });
});

describe('the picture', () => {
  it('draws every box and arrow of a view as SVG elements, with the inferred ones dashed and dotted', () => {
    const v = view('card-payments', 'containers');
    const { container } = render(<C4Picture view={v} picked={null} onPick={() => undefined} />);
    const boxes = [...v.inside, ...v.outside];
    expect(container.querySelectorAll('[data-c4-box]')).toHaveLength(boxes.length);
    expect(container.querySelectorAll('[data-c4-edge]')).toHaveLength(v.edges.length);
    for (const el of boxes) {
      const press = container.querySelector(`[data-c4-box="${el.id}"]`)!;
      const g = press.closest('g')!;
      expect(press.getAttribute('data-how')).toBe(el.how ?? 'unmarked');
      const shapes = [...g.querySelectorAll('rect, path, ellipse')].filter((s) => s.getAttribute('stroke'));
      expect(shapes.length).toBeGreaterThan(0);
      for (const s of shapes) expect(s.getAttribute('stroke-dasharray')).toBe(el.how === 'inferred' ? '5 3' : null);
    }
    v.edges.forEach((e, i) => {
      const line = container.querySelector(`[data-c4-edge="${i}"]`)!.closest('g')!.querySelector('.c4-line')!;
      expect(line.getAttribute('stroke-dasharray')).toBe(e.how === 'inferred' ? '1.5 4' : '6 4');
    });
    // The database is a cylinder: a path and an ellipse, not a rectangle.
    expect(container.querySelector('[data-c4-box="db"]')!.closest('g')!.querySelector('ellipse')).not.toBeNull();
    // Drawn with React, not injected: no script, no foreign object, no markup in a title.
    expect(container.querySelector('script, foreignObject')).toBeNull();
  });

  it('presses a box or an arrow, with the mouse or Enter and Space, to pick it', async () => {
    const v = view('card-payments', 'containers');
    const picks: unknown[] = [];
    const { container } = render(<C4Picture view={v} picked={null} onPick={(p) => picks.push(p)} />);
    await userEvent.click(container.querySelector('[data-c4-box="api"]')!);
    (container.querySelector('[data-c4-edge="1"]') as SVGElement).focus();
    await userEvent.keyboard('{Enter}');
    (container.querySelector('[data-c4-box="db"]') as SVGElement).focus();
    await userEvent.keyboard(' ');
    expect(picks).toEqual([{ kind: 'element', id: 'api' }, { kind: 'edge', index: 1 }, { kind: 'element', id: 'db' }]);
    for (const g of container.querySelectorAll('[data-c4-box], [data-c4-edge]')) {
      expect(g.getAttribute('role')).toBe('button');
      expect(g.getAttribute('tabindex')).toBe('0');
      expect(g.getAttribute('aria-label')).toMatch(/Observed|Inferred|Not said/);
    }
  });

  it('marks the picked one', () => {
    const v = view('card-payments', 'containers');
    const { container } = render(<C4Picture view={v} picked={{ kind: 'element', id: 'worker' }} onPick={() => undefined} />);
    expect(container.querySelector('[data-c4-box="worker"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-c4-box="api"]')!.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('the picture, fitted', () => {
  it("does not draw the view's title, which the page's heading says, and keeps it as the accessible name", () => {
    const v = view('card-payments', 'containers');
    const { container } = render(<C4Picture view={v} picked={null} onPick={() => undefined} />);
    const svg = container.querySelector('svg.c4-picture')!;
    expect(svg.querySelector('text.c4-title')).toBeNull();
    expect([...svg.querySelectorAll('text')].some((t) => t.textContent === v.title)).toBe(false);
    expect(svg.getAttribute('aria-label')).toContain(v.title);
    expect(svg.querySelector('title')!.textContent).toBe(v.title);
  });

  it("crops the title's band away, from where the layout says the drawing starts", () => {
    const v = view('card-payments', 'containers');
    const layout = layoutOf(v);
    const frame = frameOf(layout);
    const first = Math.min(...layout.nodes.map((b) => b.y), layout.boundary?.rect.y ?? Infinity);
    expect(frame.top).toBeGreaterThan(0);
    expect(frame.top).toBeLessThan(first);
    expect(first - frame.top).toBeLessThan(40);
    expect(frame.height).toBe(layout.height - frame.top);
    const { container } = render(<C4Picture view={v} picked={null} onPick={() => undefined} />);
    expect(container.querySelector('svg.c4-picture')!.getAttribute('viewBox')).toBe(`0 ${frame.top} ${frame.width} ${frame.height}`);
  });

  it('scales to its frame, up to 1.5 times and no smaller than 0.7 (then it scrolls inside its own region), and centres', () => {
    const v = view('settlement', 'containers');
    const layout = layoutOf(v);
    const { container } = render(<C4Picture view={v} picked={null} onPick={() => undefined} />);
    const svg = container.querySelector<SVGElement>('svg.c4-picture')!;
    expect(svg.style.maxWidth).toBe(`${Math.round(layout.width * FIT.maxScale)}px`);
    expect(svg.style.minWidth).toBe(`${Math.round(layout.width * FIT.minScale)}px`);
    expect(FIT.maxScale).toBeGreaterThan(1);
    expect(FIT.minScale).toBeLessThan(1);
    const css = readFileSync('src/components/c4-picture.css', 'utf8');
    expect(css).toMatch(/\.c4-picture \{[^}]*width: 100%[^}]*margin-inline: auto/);
  });

  it('rounds corners over a short run, so the drawn curve stays beside the checked line and never enters a box', () => {
    expect(pathData([{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }])).toBe('M0,0 L0,88 Q0,100 12,100 L100,100');
    // A short segment is rounded over half its length at most.
    expect(pathData([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 50, y: 10 }])).toBe('M0,0 L0,5 Q0,10 12,10 L50,10');
    for (const [project, key] of [['card-payments', 'containers'], ['settlement', 'containers'], ['checkout-web', 'containers']] as const) {
      const layout = layoutOf(view(project, key));
      for (const e of layout.edges) {
        const nums = pathData(e.points).match(/-?\d+(\.\d+)?/g)!.map(Number);
        // Every drawn point (the curve's ends and its control) is clear of every box but the two the arrow joins.
        for (const b of layout.nodes) {
          if (b.id === e.from || b.id === e.to) continue;
          for (let i = 0; i < nums.length; i += 2) {
            const [x, y] = [nums[i]!, nums[i + 1]!];
            expect(x > b.x + 1 && x < b.x + b.width - 1 && y > b.y + 1 && y < b.y + b.height - 1, `${project} ${e.from}->${e.to} point in ${b.id}`).toBe(false);
          }
        }
      }
    }
  });

  it("says so, in one short line, when toil's own layout check fails, and says nothing when it passes", async () => {
    const v = view('card-payments', 'containers');
    const layout = layoutOf(v);
    expect(layoutNotice(layout)).toBeNull();
    // The same layout with an arrow dragged through the middle of a box it doesn't join.
    const victim = layout.nodes.find((b) => b.id === 'tokeniser')!;
    const first = layout.edges[0]!;
    expect(first.to).not.toBe('tokeniser');
    const broken = { ...layout, edges: layout.edges.map((e, i) => (i === 0 ? { ...e, points: [{ x: victim.x - 50, y: victim.y + victim.height / 2 }, { x: victim.x + victim.width + 50, y: victim.y + victim.height / 2 }] } : e)) };
    const notice = layoutNotice(broken)!;
    expect(notice).toMatch(/passes behind a box.*couldn't draw this view cleanly\.$/);
    expect(notice.length).toBeLessThan(160);
    await open('#/project/card-payments/summary/diagram/containers');
    await waitFor(() => expect(document.querySelector('[data-diagram-legend]')).not.toBeNull());
    expect(document.querySelector('[data-diagram-notice]')).toBeNull();
  });
});

describe('the limits', () => {
  const big = (boxes: number, arrows: number): ComputedView => {
    const el = (i: number) => ({ id: `e${i}`, kind: 'container' as const, name: `E${i}`, external: false, database: false, path: `x[${i}]` });
    return { key: 'k', type: 'container', title: 'Big', inside: [], outside: Array.from({ length: boxes }, (_, i) => el(i)), edges: Array.from({ length: arrows }, (_, i) => ({ from: `e${i % boxes}`, to: `e${(i + 1) % boxes}` })) };
  };
  it('allow what toil draws and refuse past it, naming the way out', () => {
    expect(overLimit(big(DRAW_LIMITS.boxes, DRAW_LIMITS.arrows))).toBeNull();
    expect(overLimit(big(DRAW_LIMITS.boxes + 1, 3))).toMatch(/101 boxes.*at most 100 boxes and 250 arrows.*toil util c4 mermaid/);
    expect(overLimit(big(5, DRAW_LIMITS.arrows + 1))).toMatch(/251 arrows/);
  });

  it('replace the picture with a plain message, and lay nothing out', async () => {
    const shown = diagramShow('card-payments', 'containers');
    const tooMany = { ...shown, view: big(DRAW_LIMITS.boxes + 1, 3) };
    await open('#/project/card-payments/summary/diagram', withDiagram(() => ({ ok: true, data: tooMany, error: null, meta: {} }) as unknown as Envelope));
    await waitFor(() => expect(document.querySelector('[data-diagram-limit]')).not.toBeNull());
    expect(document.querySelector('[data-diagram-limit]')!.textContent).toContain('101 boxes');
    expect(document.querySelector('[data-c4-picture]')).toBeNull();
  });
});

describe('the words', () => {
  it('say how each thing is known, and that a diagram which says nothing says nothing', () => {
    expect(knownText({ how: 'observed', source: 'pom.xml:14' })).toBe('Read from pom.xml:14.');
    expect(knownText({ how: 'inferred', reason: 'the worker reads a topic' })).toBe('Why: the worker reads a topic.');
    expect(knownText({ how: 'observed' })).toContain('does not say where');
    expect(knownText({})).toBe('The diagram does not say how this is known.');
    expect(countsText({ elements: 5, relationships: 4, observed: 6, inferred: 2, unmarked: 1 })).toBe('9 things: 6 observed, 2 inferred, 1 not said');
  });

  it('give the age from the moment the page is read at, never the wall clock it was never given', () => {
    const at = Date.parse('2026-10-12T17:30:00.000Z');
    expect(savedAgo('2026-10-12T15:30:00.000Z', at)).toBe('Saved 2 hours ago');
    expect(savedAgo('2026-10-12T17:29:40.000Z', at)).toBe('Saved just now');
    expect(savedAgo('2026-10-08T17:30:00.000Z', at)).toBe('Saved 4 days ago');
    expect(savedAgo('nonsense', at)).toBe('Saved at an unknown time');
  });

  it('read only a diagram, never anything else toil said', () => {
    expect(readShown({ nothing: true })).toBeNull();
    expect(readShown(diagramShow('settlement'))?.view).toBeNull();
    expect(readShown(diagramShow('settlement', 'containers'))?.view?.key).toBe('containers');
  });
});

describe('the page', () => {
  it('draws the first view with no view named, and its first view in the switch', async () => {
    await open('#/project/card-payments/summary/diagram');
    await waitFor(() => expect(document.querySelector('[data-c4-picture="context"]')).not.toBeNull());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Card payments in context');
    const nav = screen.getByRole('navigation', { name: 'Views of the diagram' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Card payments in context', 'Card payments, containers']);
    expect(links[0]!.getAttribute('aria-current')).toBe('page');
    expect(links[1]!.getAttribute('href')).toBe('#/project/card-payments/summary/diagram/containers');
    // The way back is one quiet button (#657).
    const crumbs = document.querySelector<HTMLElement>('[data-breadcrumb]')!;
    expect(within(crumbs).getByRole('link', { name: /Back to Summary/ }).getAttribute('href')).toBe('#/project/card-payments');
  });

  it('draws the view in the address', async () => {
    await open('#/project/card-payments/summary/diagram/containers');
    await waitFor(() => expect(document.querySelector('[data-c4-picture="containers"]')).not.toBeNull());
    expect(document.querySelectorAll('[data-c4-box]')).toHaveLength(view('card-payments', 'containers').inside.length + view('card-payments', 'containers').outside.length);
  });

  it('says plainly when the address names a view the diagram does not have, and shows its first', async () => {
    await open('#/project/card-payments/summary/diagram/nope');
    await waitFor(() => expect(document.querySelector('[data-diagram-missing]')).not.toBeNull());
    expect(document.querySelector('[data-diagram-missing]')!.textContent).toContain('nope');
    expect(document.querySelector('[data-c4-picture="context"]')).not.toBeNull();
  });

  it('puts the explanation of the key in the (i), and shows Not said only when something is', async () => {
    await open('#/project/card-payments/summary/diagram/containers');
    await waitFor(() => expect(document.querySelector('[data-diagram-legend]')).not.toBeNull());
    const c = diagramShow('card-payments').counts;
    await userEvent.click(document.querySelector('[data-diagram-legend] [data-help="diagram"]')!);
    const dialog = await screen.findByRole('dialog', { name: /About the architecture diagram/ });
    expect(dialog.textContent).toContain(countsText(c));
    expect(dialog.textContent).toContain('A dashed outline or a dotted arrow is a conclusion');
    expect(dialog.textContent).toContain('open a box to see which');
    cleanup();
    const shown = diagramShow('card-payments', 'containers');
    await open('#/project/card-payments/summary/diagram/containers', withDiagram(() => ({ ok: true, data: { ...shown, counts: { ...shown.counts, unmarked: 0 } }, error: null, meta: {} }) as unknown as Envelope));
    await waitFor(() => expect(document.querySelector('[data-diagram-legend]')).not.toBeNull());
    expect(document.querySelector('[data-diagram-legend]')!.textContent).not.toContain('Not said');
  });

  it('keeps how sure it is on screen: the legend with its counts, and when it was saved, with no file path on the face', async () => {
    await open('#/project/card-payments/summary/diagram/containers');
    await waitFor(() => expect(document.querySelector('[data-diagram-legend]')).not.toBeNull());
    const c = diagramShow('card-payments').counts;
    const legend = document.querySelector('[data-diagram-legend]')!;
    expect(legend.textContent).toContain(`Observed: ${c.observed}`);
    expect(legend.textContent).toContain(`Inferred: ${c.inferred}`);
    if (c.unmarked > 0) expect(legend.textContent).toContain(`Not said: ${c.unmarked}`);
    // Only the counts: the sentence that explains them is in the (i), not under the picture.
    expect(legend.textContent).not.toMatch(/things:|dashed outline|drawn alike/);
    expect(legend.querySelector('[data-help="diagram"]')).not.toBeNull();
    const prov = document.querySelector('[data-diagram-provenance]')!.textContent!;
    expect(prov).toContain('Saved 2 hours ago');
    expect(prov).toContain('revision 2');
    expect(prov).not.toMatch(/card-payments\.json|\.toil|from /);
    // Where it is kept, in plain words with the path and its Copy, is one step in, and only there.
    const kept = document.querySelector<HTMLDetailsElement>('[data-diagram-kept]')!;
    expect(kept.open).toBe(false);
    expect(kept.querySelector('summary')!.textContent).toBe('Where is this kept?');
    expect(kept.textContent).toContain('In your own toil folder on this computer, not in any repository.');
    expect(kept.textContent).toContain('card-payments.json');
    const page = document.querySelector('.diagram-page')!;
    expect(page.textContent!.split('card-payments.json')).toHaveLength(2);
    expect(within(document.querySelector('[data-diagram-provenance]') as HTMLElement).getByRole('link', { name: 'Draw it again' }).getAttribute('href')).toBe('#/project/card-payments/job/diagram');
    // What was left out on purpose is behind a disclosure.
    const left = screen.getByText(/^Left out on purpose/).closest('details')!;
    expect(left.open).toBe(false);
    expect(left.textContent).toContain('node_modules/');
  });

  it('opens a box one press in, with where it was read from as plain text, and an arrow with why it is believed', async () => {
    await open('#/project/card-payments/summary/diagram/containers');
    await waitFor(() => expect(document.querySelector('[data-c4-box="db"]')).not.toBeNull());
    expect(document.querySelector('[data-diagram-detail]')).toBeNull();
    await userEvent.click(document.querySelector('[data-c4-box="db"]')!);
    const detail = await screen.findByRole('complementary', { name: 'Detail' });
    expect(detail.textContent).toContain('Payments database');
    expect(detail.textContent).toContain('Read from payments-core/src/main/resources/application.yml:22.');
    expect(detail.querySelector('a')).toBeNull();
    await userEvent.click(document.querySelector('[data-c4-box="worker"]')!);
    expect((await screen.findByRole('complementary', { name: 'Detail' })).textContent).toContain('Why: its main class reads the settlements topic');
    const inferred = view('card-payments', 'containers').edges.findIndex((e) => e.how === 'inferred');
    await userEvent.click(document.querySelector(`[data-c4-edge="${inferred}"]`)!);
    expect((await screen.findByRole('complementary', { name: 'Detail' })).textContent).toMatch(/Why: /);
    await userEvent.click(screen.getByRole('button', { name: 'Close detail' }));
    expect(document.querySelector('[data-diagram-detail]')).toBeNull();
  });

  it('lists every box and arrow with how each is known, for a screen reader, behind one disclosure', async () => {
    await open('#/project/settlement/summary/diagram/containers');
    await waitFor(() => expect(document.querySelector('[data-diagram-list]')).not.toBeNull());
    const list = document.querySelector<HTMLDetailsElement>('[data-diagram-list]')!;
    expect(list.open).toBe(false);
    const v = view('settlement', 'containers');
    expect(within(list).getByRole('list', { name: 'Boxes' }).querySelectorAll('li')).toHaveLength(v.inside.length + v.outside.length);
    expect(within(list).getByRole('list', { name: 'Arrows' }).querySelectorAll('li')).toHaveLength(v.edges.length);
    expect(list.textContent).toContain('Read from settlement/Settlement.Batch/DayWriter.cs:40.');
  });

  it('offers the job that draws one, as its action, when there is no diagram', async () => {
    await open('#/project/card-payments/summary/diagram', withDiagram(() => fail('NOT_FOUND', 'Toil project "card-payments" has no stored diagram.', 'Map it.')));
    await waitFor(() => expect(document.querySelector('[data-diagram="none"]')).not.toBeNull());
    expect(document.querySelector('[data-diagram="none"]')!.textContent).toContain('no architecture diagram yet');
    expect(within(document.querySelector('[data-diagram="none"]') as HTMLElement).getByRole('link', { name: 'Draw its architecture' }).getAttribute('href')).toBe('#/project/card-payments/job/diagram');
    expect(document.querySelector('[data-c4-picture]')).toBeNull();
  });

  it("keeps a failure on screen with toil's message and fix", async () => {
    await open('#/project/card-payments/summary/diagram', withDiagram(() => fail('INVALID_INPUT', 'The diagram file is not valid JSON.', 'Remove it and save again.')));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The diagram file is not valid JSON.');
    expect(alert.textContent).toContain('Remove it and save again.');
  });

  it('says it needs a newer toil when the installed one has no such command', async () => {
    await open('#/project/card-payments/summary/diagram', withDiagram(() => fail('INVALID_INPUT', 'toil has no command "projects diagram show".')));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/needs a newer toil/);
  });
});

describe('the ways in', () => {
  it("lead to the picture from the project's More menu, and the palette", async () => {
    await open('#/project/card-payments');
    await userEvent.click(await screen.findByRole('button', { name: 'More for card-payments' }));
    const item = await waitFor(() => {
      const el = document.querySelector<HTMLAnchorElement>('[data-diagram-link]');
      if (!el) throw new Error('no diagram item yet');
      return el;
    });
    expect(item.getAttribute('href')).toBe('#/project/card-payments/summary/diagram');
    expect(document.querySelector('[data-job-link="map-codebase"]')).toBeNull();
  });

  it('keeps the More menu on the job while no diagram is kept', async () => {
    await open('#/project/card-payments', withDiagram(() => fail('NOT_FOUND', 'none')));
    await new Promise((r) => setTimeout(r, 50));
    await userEvent.click(await screen.findByRole('button', { name: 'More for card-payments' }));
    await waitFor(() => expect(document.querySelector('[data-job-link="map-codebase"]')!.getAttribute('href')).toBe('#/project/card-payments/job/diagram'));
    expect(document.querySelector('[data-diagram-link]')).toBeNull();
  });
});

describe('the palette', () => {
  it('offers the saved picture beside the job that draws one', async () => {
    await open('#/project/card-payments');
    await act(async () => {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    });
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    await waitFor(() => expect(palette.querySelector('[data-palette-item]')).not.toBeNull());
    const entries = [...palette.querySelectorAll('[data-palette-item]')];
    const picture = entries.find((e) => /Architecture diagram of card-payments|architecture of card-payments/i.test(e.textContent ?? ''));
    const job = entries.find((e) => /Draw the architecture of card-payments/.test(e.textContent ?? ''));
    expect(picture, entries.map((e) => e.textContent).join(' | ')).toBeTruthy();
    expect(job).toBeTruthy();
  });
});
