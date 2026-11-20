// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { specFromQuery } from '../../src/core/insights/index.ts';
import { App } from '../src/App.tsx';
import { CategoryChip, categoryTip } from '../src/components/category-chip.tsx';
import { ChatScope } from '../src/components/ask.tsx';
import { memoryAnalyses } from '../src/analyses.ts';
import { DataContext, type Data } from '../src/data.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { HELP, helpHref } from '../src/help.ts';
import type { ToilProjectData } from '../src/load.ts';
import { SPLIT_DIMENSIONS, splitSpec, type SplitMeasure } from '../src/model/lanes.ts';
import { buildInsights } from '../src/model/work-insights.ts';
import { SkinProvider, skinsFor } from '../src/skins.tsx';
import { loaded } from './harness.ts';

/** The Summary's numbers, split, and the category chip's tooltip (#567), on the sample team. */

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
});

const TEAM = '#/project/sample-team';
const until = <T extends Element>(selector: string) =>
  waitFor(
    () => {
      const el = document.querySelector<T>(selector);
      if (!el) throw new Error(`no ${selector} yet`);
      return el;
    },
    { timeout: 8000 },
  );
const specOf = (href: string) => specFromQuery(Object.fromEntries(new URLSearchParams(href.slice(href.indexOf('?') + 1))));

function shell(toilProject: ToilProjectData, children: React.ReactNode) {
  const data: Data = { toilProject, byId: new Map(toilProject.items.map((i) => [i.id, i])), prById: new Map(), agent: scriptedAgent(), now: FIXTURE_NOW, analyses: memoryAnalyses() };
  return render(
    <SkinProvider value={skinsFor('plain')}>
      <DataContext value={data}>
        <ChatScope>{children}</ChatScope>
      </DataContext>
    </SkinProvider>,
  );
}

async function openMetric(id: string) {
  window.location.hash = TEAM;
  render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview />);
  const tile = await until<HTMLElement>(`[data-metric="${id}"]`);
  await userEvent.click(tile);
  return await screen.findByRole('dialog');
}

async function pick(dialog: HTMLElement, label: string) {
  await userEvent.click(dialog.querySelector('[data-picker="Split by"] button')!);
  await userEvent.click(await screen.findByRole('option', { name: label }));
}

const CASES: Array<{ id: string; measure: SplitMeasure; split: string; label: string; title: RegExp }> = [
  { id: 'throughput', measure: 'throughput', split: 'category', label: 'Category', title: /Finished by category/ },
  { id: 'cycle', measure: 'cycleTime', split: 'component', label: 'Component', title: /Time to finish by component/ },
  { id: 'aging', measure: 'aging', split: 'team', label: 'Team', title: /Work getting old by team/ },
];

describe.each(CASES)('the $id modal', ({ id, measure, split, label, title }) => {
  it('is today\'s chart until split, and its Open in Charts link names the unsplit question', async () => {
    const dialog = await openMetric(id);
    expect(dialog.querySelector(`[data-split="${measure}"]`)).toBeTruthy();
    expect(dialog.querySelector('figure.ck-chart')).toBeNull();
    const link = dialog.querySelector<HTMLAnchorElement>('[data-open-in-charts]')!;
    expect(link.getAttribute('href')).toContain('/summary/explore?measure=');
    expect(specOf(link.getAttribute('href')!)).toEqual(splitSpec(measure, null, '2026-10-13'));
  });

  it(`splits by ${label}, keeps the figures table, and carries the split to Explore`, async () => {
    const dialog = await openMetric(id);
    await pick(dialog, label);
    const frame = await waitFor(() => {
      const f = dialog.querySelector<HTMLElement>('figure.ck-chart');
      if (!f) throw new Error('no chart yet');
      return f;
    });
    expect(within(frame).getByRole('heading', { name: title })).toBeTruthy();
    expect(frame.querySelector('.ck-source')!.textContent).toMatch(/From Jira/);
    // The figures are one press away, as a table.
    expect(frame.querySelector('table')).toBeTruthy();
    const link = dialog.querySelector<HTMLAnchorElement>('[data-open-in-charts]')!;
    const spec = specOf(link.getAttribute('href')!);
    expect(spec).toEqual(splitSpec(measure, split, '2026-10-13'));
    expect(spec.split).toBe(split);
    // A split is never a person.
    expect(SPLIT_DIMENSIONS).not.toContain('assignee');
  });
});

describe('a segment', () => {
  it('opens the items behind it, and closes the modal first', async () => {
    const dialog = await openMetric('throughput');
    await pick(dialog, 'Category');
    const mark = await waitFor(() => {
      const m = dialog.querySelector<SVGElement>('figure.ck-chart svg [tabindex]');
      if (!m) throw new Error('no mark yet');
      return m;
    });
    await act(async () => {
      mark.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => expect(window.location.hash).toContain('items=cell%7C'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(Number((await until<HTMLElement>('[data-drill]')).getAttribute('data-drill'))).toBeGreaterThan(0);
  });
});

describe('the category chip', () => {
  it('gives KTLO, the definition and a Read more link in the app\'s own tooltip', async () => {
    const { data } = await loaded('sample-team');
    const ins = buildInsights(data, FIXTURE_NOW);
    const id = data.items.find((i) => ins.categories[i.id] === 'ktlo')!.id;
    const tip = categoryTip(ins, 'ktlo', ins.verdicts.get(id));
    expect(tip.title).toBe('KTLO (Keep the lights on)');
    expect(tip.definition).toBe(ins.definitions.ktlo!.definition);
    expect(tip.definition.length).toBeGreaterThan(20);
    expect(tip.decided).toMatch(/^Decided by (rules|label|AI agent|person)/);
    expect(categoryTip(ins, null).title).toBe('Not sorted yet');

    shell(data, <CategoryChip ins={ins} itemId={id} />);
    const chip = document.querySelector<HTMLElement>('[data-category="ktlo"]')!;
    expect(chip.textContent).toContain('Keep the lights on');
    expect(chip.hasAttribute('title')).toBe(false);
    expect(chip.tagName).toBe('SPAN');
    // Focus by keyboard shows it, as it does for the (i): the same Tooltip.
    await userEvent.tab();
    expect(document.activeElement).toBe(chip);
    const tooltip = await screen.findByRole('tooltip', undefined, { timeout: 3000 });
    expect(tooltip.textContent).toContain('KTLO (Keep the lights on)');
    expect(tooltip.textContent).toContain(ins.definitions.ktlo!.definition);
    expect(within(tooltip).getByRole('link', { name: /Read more/ }).getAttribute('href')).toBe(helpHref(HELP['work-mix']));
  });

  it('is display-only until given a handler, which makes it a button', async () => {
    const { data } = await loaded('sample-team');
    const ins = buildInsights(data, FIXTURE_NOW);
    const id = data.items.find((i) => ins.categories[i.id] === 'feature')!.id;
    let pressed = 0;
    shell(data, <CategoryChip ins={ins} itemId={id} />);
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    shell(data, <CategoryChip ins={ins} itemId={id} onPress={() => pressed++} />);
    await userEvent.click(screen.getByRole('button'));
    expect(pressed).toBe(1);
  });

  it('is in the item header beside the status, and in the item drawer', async () => {
    const { data } = await loaded('sample-team');
    const ins = buildInsights(data, FIXTURE_NOW);
    const item = data.items.find((i) => ins.categories[i.id] === 'ktlo')!;
    window.location.hash = `${TEAM}/item/${encodeURIComponent(item.id)}`;
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview />);
    const meta = await until<HTMLElement>('.item-meta');
    expect(meta.querySelector('[data-category="ktlo"]')).toBeTruthy();
    cleanup();
    window.location.hash = `${TEAM}/board?item=${encodeURIComponent(item.id)}`;
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview />);
    const drawer = await until<HTMLElement>('[data-drawer]');
    expect(drawer.querySelector('[data-category="ktlo"]')).toBeTruthy();
  });
});
