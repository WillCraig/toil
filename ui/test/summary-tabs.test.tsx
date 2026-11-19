// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App, parseRoute, tabOf, upgradeHash } from '../src/App.tsx';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { DataContext } from '../src/data.ts';
import { TOIL_PROJECT_TABS } from '../src/views/ToilProjectShell.tsx';
import { SummaryCharts } from '../src/views/summary-charts.tsx';
import { loaded } from './harness.ts';

/**
 * The Summary carries the charts and the briefing (#567): the tab list and its order, the old addresses that still land, the
 * three chart items with their headlines (and dashes where nothing was read), breadcrumbs on the full pages, the dashboards
 * that are no longer offered still reachable, Get a briefing landing in the Summary, no page title that repeats its tab,
 * and the items drawer's columns.
 */

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
});

async function open(hash: string) {
  window.location.hash = hash;
  return render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview />);
}
const go = async (hash: string) => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
};
const until = <T extends Element>(selector: string) =>
  waitFor(() => {
    const el = document.querySelector<T>(selector);
    if (!el) throw new Error(`no ${selector} yet`);
    return el;
  });
const TEAM = '#/project/sample-team';
const tabLinks = (project: string) => [...document.querySelectorAll<HTMLAnchorElement>(`nav[aria-label="${project} views"] a`)];

describe('the tabs', () => {
  it('are Summary, Tickets and Team (#657): no Board, no Charts, no Past briefings, and no (i) on the row', async () => {
    await open(TEAM);
    await until('nav[aria-label="sample-team views"]');
    expect(tabLinks('sample-team').map((a) => (a.textContent ?? '').replace(/\d+.*$/, '').trim())).toEqual(['Summary', 'Tickets', 'Team']);
    expect(TOIL_PROJECT_TABS.map((t) => t.id)).toEqual(['overview', 'tickets', 'team']);
    expect(tabLinks('sample-team').some((a) => /Charts|briefings|Analyses|Board/i.test(a.textContent ?? ''))).toBe(false);
    expect(document.querySelector('[data-tabs-row] .info-trigger, [data-tab-help]')).toBeNull();
    // The items that need attention are counted on Tickets.
    expect(document.querySelector('[data-tab="tickets"] .tab-count')).toBeTruthy();
  });

  it('keep the Summary selected on its drill-ins, Tickets on readiness and items, and Team on its three pages', () => {
    for (const page of ['summary/mix', 'summary/briefings', 'board', 'dependencies', 'prs', 'board/classify']) expect(tabOf(parseRoute(`${TEAM}/${page}`)), page).toBe('overview');
    expect(tabOf(parseRoute(`${TEAM}/command-center`))).toBe('tickets');
    for (const page of ['people', 'standup', 'worklog']) expect(tabOf(parseRoute(`${TEAM}/${page}`)), page).toBe('team');
  });

  it('give Team one segmented control for People, Stand-up and What happened, and every drill-in a Back to Summary', async () => {
    await open(`${TEAM}/standup`);
    const group = await until<HTMLElement>('[data-team-pages]');
    expect([...group.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('aria-current')])).toEqual([
      ['People', null],
      ['Stand-up', 'page'],
      ['What happened', null],
    ]);
    await go(`${TEAM}/dependencies`);
    const back = await until<HTMLAnchorElement>('[data-back]');
    expect(back.textContent).toMatch(/Back to Summary/);
    expect(back.getAttribute('href')).toBe(TEAM);
    expect(back.className).toMatch(/btn--quiet/);
  });
});

describe('old addresses', () => {
  it('land on the Summary and its steps in', () => {
    expect(upgradeHash(`${TEAM}/charts`)).toBe(`${TEAM}/summary`);
    expect(upgradeHash(`${TEAM}/charts/mix?release=2.4`)).toBe(`${TEAM}/summary/mix?release=2.4`);
    expect(upgradeHash(`${TEAM}/worklog/standup/2026-10-09/2026-10-13`)).toBe(`${TEAM}/standup/2026-10-09/2026-10-13`);
    expect(upgradeHash(`${TEAM}/analyses`)).toBe(`${TEAM}/summary/briefings`);
    expect(upgradeHash(`${TEAM}/analyses/abc`)).toBe(`${TEAM}/summary/briefings/abc`);
    expect(parseRoute(`${TEAM}/charts`)).toMatchObject({ view: 'dashboard' });
    expect(parseRoute(`${TEAM}/charts/flow`)).toMatchObject({ view: 'charts', dashboard: 'flow' });
    expect(parseRoute(`${TEAM}/analyses/abc`)).toMatchObject({ view: 'briefings', id: 'abc' });
  });

  it('are rewritten in the address bar, so a shared link is the new one', async () => {
    await open(`${TEAM}/charts/mix?split=team`);
    await until('[data-dashboard="mix"]');
    expect(window.location.hash).toBe(`${TEAM}/summary/mix?split=team`);
  });
});

describe('the Summary', () => {
  it('holds three chart items, each its dashboard\'s own headline and a link to its full page, and no Work mix tile', async () => {
    await open(TEAM);
    await until('[data-summary-chart="flow"]');
    expect([...document.querySelectorAll('[data-summary-chart]')].map((e) => e.getAttribute('data-summary-chart'))).toEqual(['mix', 'where', 'flow']);
    const text = (id: string) => document.querySelector(`[data-summary-chart="${id}"]`)!.textContent!;
    expect(text('mix')).toMatch(/Feature \d+% · Keep the lights on \d+% · Not sorted yet \d+%/);
    // The headline says the shares; the legend under the bar is the key to the marks and says only the names.
    expect(document.querySelector('[data-summary-chart="mix"] .ck-mix__key')!.textContent).not.toMatch(/\d%/);
    expect(text('where')).toMatch(/Work this week is spread across \d+ epics?; \d+ of \d+ items[^.]* have no epic above them/);
    expect(text('flow')).toMatch(/finished a week/);
    for (const id of ['mix', 'where', 'flow']) {
      expect(document.querySelector(`[data-summary-chart="${id}"] h3 a.btn`)!.getAttribute('href')).toBe(`${TEAM}/summary/${id}`);
      expect(document.querySelector(`[data-summary-chart="${id}"] svg`)).toBeTruthy();
    }
    expect(document.querySelector('[data-metric="mix"]')).toBeNull();
    expect(document.querySelector('[data-work-lines]')).toBeNull();
    // Nothing on the Summary splits or filters: that is the full page's.
    expect(document.querySelector('[data-summary-charts] [data-picker], [data-summary-charts] select, [data-summary-charts] [data-filter-chip]')).toBeNull();
  });

  it('shows a dash with its reason, never an empty chart or a zero, for an item nothing was read for', async () => {
    const { data } = await loaded('sample-team');
    const empty = { ...data, items: [], changes: [], pullRequests: [] };
    render(
      <DataContext.Provider value={{ toilProject: empty, byId: new Map(), agent: scriptedAgent(), now: FIXTURE_NOW }}>
        <SummaryCharts />
      </DataContext.Provider>,
    );
    for (const id of ['mix', 'where', 'flow']) {
      const item = document.querySelector(`[data-summary-chart="${id}"]`)!;
      expect(item.querySelector('[aria-label="not read yet"]'), id).toBeTruthy();
      // No chart: the only drawing left is the chevron on the title's button.
      expect(item.querySelector('h3 ~ * svg'), id).toBeNull();
      expect(item.textContent, id).toMatch(/no items were read/);
      expect(item.textContent, id).not.toMatch(/\b0%|\b0 epics/);
    }
  });

  it('has no Go to row: the board is one Open the board button, and sorting into categories is on Work mix (#657)', async () => {
    await open(TEAM);
    const board = await until<HTMLAnchorElement>('[data-open-board]');
    expect(board.getAttribute('href')).toBe(`${TEAM}/board`);
    // A secondary button in the row under the cards (#657): a step in, framed in every theme, not the page's focus.
    expect(board.className).toMatch(/btn--secondary/);
    expect(document.querySelector('.briefing__links')).toBeNull();
    expect(document.querySelector('[data-summary-chart="mix"] [data-open-classify]')!.getAttribute('href')).toBe(`${TEAM}/board/classify`);
  });
});

describe('the full pages', () => {
  it.each([
    ['mix', 'Work mix'],
    ['where', "Where we're working"],
    ['flow', 'Flow'],
    ['releases', 'Releases'],
    ['sprints', 'Sprints'],
    ['explore', 'Explore'],
  ])('%s opens under the Summary, with a Back to Summary button', async (id, title) => {
    await open(`${TEAM}/summary/${id}`);
    await until(`[data-dashboard="${id}"]`);
    const crumb = document.querySelector('[data-breadcrumb]')!;
    expect(within(crumb as HTMLElement).getByRole('link', { name: /Back to Summary/ }).getAttribute('href')).toBe(TEAM);
    expect(title).toBeTruthy();
    expect(screen.queryByText('All charts')).toBeNull();
    expect(tabLinks('sample-team').find((a) => a.getAttribute('aria-current') === 'page')!.textContent).toMatch(/^Summary/);
  });

  it('say so when there is no such chart, and name the ones there are', async () => {
    await open(`${TEAM}/summary/nope`);
    await until('[data-charts-missing]');
    expect(screen.getByRole('link', { name: 'Flow' })).toBeTruthy();
  });

  it('keep a chart reachable from the command palette by typing its name', async () => {
    const { paletteEntries } = await import('../src/components/palette.tsx');
    const entries = paletteEntries({ route: parseRoute(TEAM), toilProjects: ['sample-team'], loaded: {}, analyses: {}, synced: undefined, at: 0, themes: [], currentTheme: 'plain', setTheme: () => undefined, scheme: 'system', setScheme: () => undefined, onSync: undefined, focused: null, canAssign: false, adapters: null, agentSettings: false, openShortcuts: () => undefined });
    expect(entries.filter((e) => e.typed && e.id.startsWith('chart:')).map((e) => [e.label, 'href' in e.go ? e.go.href : ''])).toEqual([
      ['Work mix', `${TEAM}/summary/mix`],
      ['Releases', `${TEAM}/summary/releases`],
      ['Sprints', `${TEAM}/summary/sprints`],
      ["Where we're working", `${TEAM}/summary/where`],
      ['Flow', `${TEAM}/summary/flow`],
      ['Explore', `${TEAM}/summary/explore`],
    ]);
  });
});

describe('Get a briefing', () => {
  it('is on the Summary, and the new briefing lands there: open, with its time and who wrote it', async () => {
    await open(TEAM);
    const button = await until<HTMLButtonElement>('[data-get-briefing]');
    expect(document.querySelector('[data-rec-source]')!.getAttribute('data-rec-source')).toBe('code');
    await act(async () => button.click());
    const said = await waitFor(() => until<HTMLElement>('[data-briefing-said]'), { timeout: 8000 });
    // One short confirmation, announced; the authorship is the hero's line alone.
    expect(said.textContent).toBe('Briefing updated');
    expect(said.getAttribute('role')).toBe('status');
    await waitFor(() => expect(document.querySelector('[data-rec-source]')!.getAttribute('data-rec-source')).toBe('analysis'));
    expect((document.querySelector('#full-briefing-body') as HTMLElement).hidden).toBe(false);
    expect(document.querySelector('[data-full-toggle]')!.textContent).toBe('Hide the full briefing');
    expect(document.body.textContent).not.toContain('New briefing written');
    expect(document.querySelector('[data-briefing-by]')!.textContent).toMatch(/^Written by an AI agent, /);
    expect(document.querySelector('.briefing__warning')).toBeNull();
    expect(document.querySelector('.briefing__head')!.textContent).not.toMatch(/Nothing needs anyone/);
  });

  it('keeps no tab for the briefings: the earlier ones are a link under the briefing, after there is one', async () => {
    await open(TEAM);
    const button = await until<HTMLButtonElement>('[data-get-briefing]');
    expect(document.querySelector('[data-earlier-briefings]')).toBeNull();
    await act(async () => button.click());
    await until('[data-briefing-said]');
    await waitFor(() => expect((document.querySelector('[data-get-briefing]') as HTMLButtonElement).disabled).toBe(false));
    await act(async () => (document.querySelector('[data-get-briefing]') as HTMLButtonElement).click());
    await waitFor(() => {
      const link = document.querySelector<HTMLAnchorElement>('[data-earlier-briefings]');
      if (!link) throw new Error('no link yet');
      expect(link.textContent).toBe('Earlier briefings (1)');
      expect(link.getAttribute('href')).toBe(`${TEAM}/summary/briefings`);
    });
    await go(`${TEAM}/summary/briefings`);
    const crumb = await until<HTMLElement>('[data-breadcrumb]');
    expect(crumb.textContent).toBe('‹ Back to Summary');
  });
});

describe('one tab, one page, no repeated title', () => {
  const pages: Array<[string, string[]]> = [
    [TEAM, ['Summary', 'Overview']],
    [`${TEAM}/standup`, ['Team']],
    [`${TEAM}/worklog`, ['Team']],
  ];
  it.each(pages)('%s has no heading that repeats its tab', async (hash, names) => {
    await open(hash);
    await until('.toil-project-main [data-tab-panel], [data-tab-panel]');
    await new Promise((r) => setTimeout(r, 300));
    const headings = [...document.querySelectorAll('[data-tab-panel] h1, [data-tab-panel] h2, [data-tab-panel] h3')].map((h) => (h.textContent ?? '').replace(/\s*i$/, '').trim().toLowerCase());
    for (const n of names) expect(headings, `${hash} repeats "${n}"`).not.toContain(n.toLowerCase());
    // The page is named by its tab instead.
    const panel = document.querySelector('[data-tab-panel]')!;
    expect(document.getElementById(panel.getAttribute('aria-labelledby')!)!.textContent).toMatch(new RegExp(`^${names[0]}`));
  });
});

describe('the items drawer', () => {
  it('lists Category first, then Item and Title, with quiet sort headers and aria-sort, and no column that says nothing', async () => {
    await open(`${TEAM}/summary/mix`);
    const door = await until<HTMLAnchorElement>('[data-door]');
    await go(door.getAttribute('href')!);
    const drawer = await until<HTMLElement>('[data-drill]');
    const heads = [...drawer.querySelectorAll('thead th')];
    expect(heads.slice(0, 3).map((h) => h.textContent!.replace(/[↑↓]/g, '').trim())).toEqual(['Category', 'Item', 'Title']);
    expect(heads.every((h) => h.getAttribute('aria-sort'))).toBe(true);
    expect(heads.filter((h) => h.getAttribute('aria-sort') === 'ascending').map((h) => h.textContent!.trim())).toEqual(['Item']);
    expect(drawer.querySelector('.drill-sort[aria-pressed]')).toBeNull();
    // A column that repeats the one cell's own value (here the month it was resolved in) is left out.
    expect(heads.map((h) => h.textContent).join(' ')).not.toMatch(/Resolved/);
    // Sorting by another header moves the arrow and aria-sort.
    await act(async () => (drawer.querySelector('[data-sort="title"]') as HTMLButtonElement).click());
    expect(drawer.querySelector('thead th[aria-sort="ascending"]')!.textContent).toContain('Title');
    expect(drawer.querySelector('thead th[aria-sort="ascending"] .drill-sort__arrow [data-icon="arrow-up"]')).not.toBeNull();
  });
});
