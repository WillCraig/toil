// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { ChatScope } from '../src/components/ask.tsx';
import { memoryAnalyses } from '../src/analyses.ts';
import { DataContext, type Data } from '../src/data.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { SAMPLE_TEAM } from '../src/fixtures/sample-team.ts';
import type { ToilProjectData } from '../src/load.ts';
import { flows } from '../src/model/flow.ts';
import { boardLanes, GROUP_MENU, LANE_LIMIT } from '../src/model/lanes.ts';
import { buildInsights } from '../src/model/work-insights.ts';
import { SkinProvider, skinsFor } from '../src/skins.tsx';
import { Board, dropVerdict } from '../src/views/Board.tsx';
import { loaded } from './harness.ts';

/**
 * The shared filter bar on the Board, Group by and its swimlanes, and the category chip on a card (#567), on the sample
 * team, whose facts toil's own sample generator works out.
 */

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
});

const TEAM = '#/project/sample-team';
const open = (hash: string) => {
  window.location.hash = hash;
  return render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview />);
};
const go = async (hash: string) => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
};
const until = <T extends Element>(selector: string) =>
  waitFor(
    () => {
      const el = document.querySelector<T>(selector);
      if (!el) throw new Error(`no ${selector} yet`);
      return el;
    },
    { timeout: 8000 },
  );
const cardIds = () => [...document.querySelectorAll<HTMLElement>('.board .card-grip[data-item]')].map((c) => c.dataset.item!);
const sample = async () => buildInsights((await loaded('sample-team')).data, FIXTURE_NOW);

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

describe('the filter bar on the Board', () => {
  it('narrows the cards, the column counts and the tables under the board', async () => {
    const ins = await sample();
    open(`${TEAM}/board`);
    await until('.board .card-grip');
    const all = cardIds();
    const tableRows = () => document.querySelectorAll('.trace [role="rowheader"]').length;
    const allRows = tableRows();
    expect(allRows).toBeGreaterThan(0);
    await go(`${TEAM}/board?release=2.4`);
    await waitFor(() => expect(cardIds().length).toBeLessThan(all.length));
    const kept = new Set(ins.narrow([{ dimension: 'release', op: '=', values: ['2.4'] }]).items.map((i) => i.id));
    const shown = cardIds();
    expect(shown.length).toBeGreaterThan(0);
    for (const id of shown) expect(kept.has(id), id).toBe(true);
    expect(document.querySelector('[data-filter-chip="release=2.4"]')).toBeTruthy();
    // Each column's heading counts what is shown, and the sentence under the bar says how many of how many.
    const counts = [...document.querySelectorAll('.board .column h3 .count')].reduce((n, c) => n + Number(c.textContent), 0);
    expect(counts).toBe(shown.length);
    expect(document.querySelector('[data-board-narrowed]')!.textContent).toBe(`Showing ${shown.length} of ${all.length} items on the board.`);
    // The delivery table beneath lists the same items, no more.
    expect(tableRows()).toBeGreaterThan(0);
    expect(tableRows()).toBeLessThan(allRows);
    expect(tableRows()).toBeLessThanOrEqual(shown.length);
  });

  it('shows only the unsure items for ?category=none, the link Work mix gives', async () => {
    const ins = await sample();
    open(`${TEAM}/board`);
    await until('.board .card-grip');
    const unsure = cardIds().filter((id) => ins.categories[id] === null);
    expect(unsure.length).toBeGreaterThan(0);
    await go(`${TEAM}/board?category=none`);
    await waitFor(() => expect(cardIds().length).toBe(unsure.length));
    expect(new Set(cardIds())).toEqual(new Set(unsure));
    expect(document.querySelectorAll('.board .cat-chip')).toHaveLength(0);
  });

  it('works alongside Needs attention only, and is on Ready to start? too', async () => {
    const ins = await sample();
    open(`${TEAM}/command-center`);
    await until('[data-filter-bar]');
    const total = Number(/of (\d+)/.exec(document.querySelector('[aria-live]')!.textContent!)![1]);
    await go(`${TEAM}/command-center?release=2.4`);
    await waitFor(() => expect(Number(/of (\d+)/.exec(document.querySelector('[aria-live]')!.textContent!)![1])).toBeLessThan(total));
    expect(Number(/of (\d+)/.exec(document.querySelector('[aria-live]')!.textContent!)![1])).toBe(ins.narrow([{ dimension: 'release', op: '=', values: ['2.4'] }]).items.length);
  });
});

describe('Group by and swimlanes', () => {
  it('draws a lane per epic with No epic last, biggest first, each counted and with a mix', async () => {
    open(`${TEAM}/board?group=parent:Epic`);
    await until('[data-lanes]');
    const lanes = [...document.querySelectorAll<HTMLElement>('[data-lane]')];
    const names = lanes.map((l) => l.querySelector('.lane__name')!.textContent!);
    expect(names.at(-1)).toMatch(/^No epic$/i);
    expect(names.slice(0, -1).every((n) => /^SHOP-\d+ /.test(n))).toBe(true);
    const counts = lanes.map((l) => Number(l.querySelector('[data-lane-count]')!.textContent));
    expect(counts.slice(0, -1)).toEqual([...counts.slice(0, -1)].sort((a, b) => b - a));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(cardIds().length);
    // Each lane keeps the status columns, and its mix of categories is one bar (a group, not a chart of its own).
    for (const l of lanes) {
      expect(l.querySelectorAll('.column')).toHaveLength(3);
      expect(l.querySelector('.lane__head [aria-label$="mix by category"]')).toBeTruthy();
    }
    expect(document.querySelector('[data-picker="Group by"]')!.textContent).toContain('Parent › Epic');
  });

  it('puts 19 items in No epic across the whole project, as the sample facts say', async () => {
    const ins = await sample();
    const set = boardLanes(ins, ins.items.filter(flows), 'parent:Epic', false)!;
    const last = set.lanes.at(-1)!;
    expect(last.kind).toBe('none');
    expect(last.label).toMatch(/^No epic$/i);
    expect(last.items).toHaveLength(SAMPLE_TEAM.facts.withNoEpic);
  });

  it('folds the smaller lanes into Other and opens them with Show all lanes; people are never folded', async () => {
    const ins = await sample();
    const everything = ins.items.filter(flows);
    const wide = GROUP_MENU.find((s) => !['assignee', 'team'].includes(s) && (ins.valuesIn(s)?.length ?? 0) > LANE_LIMIT + 2)!;
    expect(wide).toBeTruthy();
    const folded = boardLanes(ins, everything, wide, false)!;
    expect(folded.lanes.filter((l) => l.kind === 'value')).toHaveLength(LANE_LIMIT);
    expect(folded.lanes.some((l) => l.kind === 'other')).toBe(true);
    expect(folded.foldable).toBeGreaterThan(0);
    const all = boardLanes(ins, everything, wide, true)!;
    expect(all.lanes.some((l) => l.kind === 'other')).toBe(false);
    expect(all.lanes.filter((l) => l.kind === 'value').length).toBe(LANE_LIMIT + folded.foldable);
    const people = boardLanes(ins, everything, 'assignee', false)!;
    expect(people.lanes.some((l) => l.kind === 'other')).toBe(false);
    const names = people.lanes.filter((l) => l.kind === 'value').map((l) => l.label);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('keeps the column limits in each lane', async () => {
    const { data } = await loaded('sample-team');
    const done = data.items.filter((i) => i.statusCategory === 'DONE' && flows(i));
    shell({ ...data, items: data.items }, <Board items={done} group="parent:Epic" />);
    const lanes = [...document.querySelectorAll<HTMLElement>('[data-lane]')];
    const big = lanes.find((l) => Number(l.querySelector('[data-lane-count]')!.textContent) > 10)!;
    expect(big).toBeTruthy();
    const col = within(big).getByRole('region', { name: /^Done/ });
    expect(col.querySelectorAll('li.card')).toHaveLength(10);
    const hidden = Number(col.querySelector('h3 .count')!.textContent) - 10;
    await userEvent.click(within(col).getByRole('button', { name: new RegExp(`Show ${hidden} more`) }));
    expect(col.querySelectorAll('li.card')).toHaveLength(10 + hidden);
    // Opening one lane's column opens no other lane's.
    for (const other of lanes.filter((l) => l !== big)) {
      const column = within(other).getByRole('region', { name: /^Done/ });
      expect(column.querySelectorAll('li.card')).toHaveLength(Math.min(10, Number(column.querySelector('h3 .count')!.textContent)));
    }
  });

  it('folds a lane away and back', async () => {
    open(`${TEAM}/board?group=parent:Epic`);
    await until('[data-lanes]');
    const lane = document.querySelector<HTMLElement>('[data-lane]')!;
    const toggle = within(lane).getByRole('button', { name: /./, expanded: true });
    expect(lane.querySelectorAll('.column')).toHaveLength(3);
    await userEvent.click(toggle);
    expect(lane.querySelectorAll('.column')).toHaveLength(0);
    expect(within(lane).getByRole('button', { expanded: false })).toBeTruthy();
    expect(lane.querySelector('[data-lane-count]')).toBeTruthy();
  });

  it('says a lane is for looking when a card is dropped in another one', () => {
    const item = SAMPLE_TEAM.owi.items.find((i) => i.statusCategory === 'TODO')!;
    const same = dropVerdict(item, 'IN_PROGRESS');
    expect(same.ok).toBe(true);
    const other = dropVerdict(item, 'IN_PROGRESS', false);
    expect(other.ok).toBe(false);
    expect(other.text).toMatch(/another lane/i);
  });

  it('keeps the choice in the address, and greys a dimension the read never fetched', async () => {
    open('#/project/card-payments/board');
    await until('[data-picker="Group by"] button');
    await userEvent.click(document.querySelector('[data-picker="Group by"] button')!);
    const options = await screen.findAllByRole('option');
    const release = options.find((o) => o.textContent!.startsWith('Fix version'))!;
    expect(release.getAttribute('aria-disabled')).toBe('true');
    expect(release.textContent).toContain('not read yet');
    await userEvent.click(options.find((o) => o.textContent === 'Team' || o.textContent!.startsWith('Parent › Epic'))!);
    await waitFor(() => expect(window.location.hash).toContain('group='));
    await go('#/project/card-payments/board?group=release');
    await until('[data-lanes-unread]');
    expect(document.querySelectorAll('.board .card-grip').length).toBeGreaterThan(0);
  });
});

describe('the category on a card', () => {
  it('is a small display-only chip on a categorised card, with no button or new link on any card', async () => {
    const ins = await sample();
    open(`${TEAM}/board`);
    await until('.board .card-grip');
    const ids = cardIds();
    const chips = document.querySelectorAll('.board li.card .cat-chip--compact');
    expect(chips).toHaveLength(ids.filter((id) => ins.categories[id] !== null).length);
    for (const chip of chips) {
      expect(chip.tagName).toBe('SPAN');
      expect(chip.closest('button, a')).toBeNull();
    }
    for (const card of document.querySelectorAll('.board li.card')) {
      expect(card.querySelectorAll('button')).toHaveLength(0);
      // The key's link was always there; nothing else on a card is a link.
      expect([...card.querySelectorAll('a')].every((a) => a.classList.contains('card-key'))).toBe(true);
    }
  });
});
