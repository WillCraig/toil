// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { openChat } from './chat.ts';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import type { SyncClient, SyncStatus } from '../src/server-client.ts';
import { SyncPanel } from '../src/sync-panel.tsx';
import { WipeCache } from '../src/views/settings/General.tsx';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { BUILT_IN_SKINS, SLOTS, skinsFor, themed } from '../src/skins.tsx';
import { HEART, LOOT } from '../src/skins/overworld.tsx';
import { THEMES, themeNamed } from '../src/themes.ts';

/**
 * The bar every theme is held to (#206, #277), run the same way for each: the
 * same click targets as Plain on every view, so a theme changes how a view
 * looks and never what can be done on it, and axe at WCAG 2.2 AA. Plain and
 * Crate are strict, with no violations; the decorative themes may deviate for
 * style, so axe can never fail them (the maintainer's bar, AGENT_DECISIONS.md,
 * #267) and is not run on them here (#579). The click-target comparison, which
 * enforces principle 11, still runs on every theme. Contrast is checked on the
 * tokens (themes.test.ts) and in a real browser (scripts/layout-check.mjs),
 * since jsdom can't compute it.
 */

const item = (toilProject: string, id: string) => `#/project/${toilProject}/item/${encodeURIComponent(id)}`;
const ROUTES = ['#/', '#/project/card-payments', '#/project/settlement', '#/project/checkout-web', item('card-payments', 'corp-jira:PAY-100'), item('settlement', 'corp-ado:2304'), '#/settings'];
const SCHEMES = THEMES.flatMap((t) => Object.keys(t.schemes).map((scheme) => [t.name, scheme] as const));
const STRICT = new Set(['plain', 'crate']);
/** Each case renders a whole view and, in Plain and Crate, runs axe over it, which takes a few seconds on a slow CI runner (macOS on Node 24.14). */
const SLOW = 30_000;

async function open(hash: string, theme: string, scheme: string) {
  localStorage.setItem('toil-ui.theme', JSON.stringify({ theme, scheme, wording: true, voice: true }));
  window.location.hash = hash;
  const view = render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview />);
  await screen.findByRole('heading', { level: 1 }, { timeout: 3000 });
  // The dashboard's graph loads on its own; wait for it, so every target is on the page.
  if (hash.startsWith('#/project/') && !hash.includes('/item/')) await waitFor(() => expect(screen.queryByText('Drawing the graph…')).toBeNull(), { timeout: 3000 });
  return view;
}

/** Only violations are read, so axe skips building the passes (#328). */
async function violations(container: HTMLElement) {
  const result = await axe.run(container, {
    resultTypes: ['violations'],
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    // Experimental in this axe, so named: WCAG 2.5.3, a control's name holding its visible words (the header's name was the case, #277).
    rules: { 'color-contrast': { enabled: false }, 'label-content-name-mismatch': { enabled: true } },
  });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

/** Every control on the page, by role and name, less the theme controls themselves (a one-scheme theme has no Appearance). */
function targets(): string[] {
  const roles = ['link', 'button', 'checkbox', 'textbox', 'combobox', 'menuitem', 'option', 'tab'] as const;
  return roles
    .flatMap((role) => screen.queryAllByRole(role).map((el) => `${role}: ${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim()}`))
    .filter((t) => !/^button: (Theme|Appearance)|^button: .*(Plain|Crate|Harvest|Starship|Realm|Sprawl|Frontier|Overworld|System|Light|Dark)/.test(t));
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('every theme', { timeout: SLOW }, () => {
  const plainTargets = new Map<string, string[]>();

  it.each(ROUTES.flatMap((r) => SCHEMES.map(([t, s]) => [r, t, s] as const)))('%s in %s (%s) has the same click targets as Plain, and meets the axe bar where it is strict', async (hash, theme, scheme) => {
    if (!plainTargets.has(hash)) {
      const { unmount } = await open(hash, 'plain', 'light');
      plainTargets.set(hash, targets());
      unmount();
    }
    const { container } = await open(hash, theme, scheme);
    expect(document.documentElement.dataset.theme).toBe(theme);
    if (STRICT.has(theme)) expect(await violations(container)).toEqual([]);
    expect(targets()).toEqual(plainTargets.get(hash));
  });

  it('is listed in the theme picker, every theme once', async () => {
    await open('#/', 'plain', 'light');
    screen.getByRole('button', { name: /Theme/ }).click();
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Plain', 'Crate', 'Harvest', 'Starship', 'Realm', 'Sprawl', 'Frontier', 'Overworld']);
  });

  it('ships skins for the named slots only, and only as a built-in theme', () => {
    for (const [name, skins] of Object.entries(BUILT_IN_SKINS)) {
      expect(THEMES.map((t) => t.name)).toContain(name);
      for (const slot of Object.keys(skins)) expect(SLOTS).toContain(slot);
    }
    expect(SLOTS).toEqual(['Card', 'Panel', 'Avatar', 'ChatMessage', 'EmptyState', 'Loading', 'Header']);
  });
});

describe('controls and headings read the real word alone, in every theme (principle 11)', { timeout: SLOW }, () => {
  it('reads "Epic" in Realm and in Plain: a theme\'s term never reaches a control', () => {
    expect(themed(themeNamed('realm'), 'epic', 'Epic')).toBe('Epic');
    expect(themed(themeNamed('plain'), 'epic', 'Epic')).toBe('Epic');
  });

  it('shows the source\'s own word on the item page in Realm, with no theme word beside it', async () => {
    await open(item('card-payments', 'corp-jira:PAY-100'), 'realm', 'light');
    expect(screen.queryAllByText('Epic').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Campaign/)).toBeNull();
  });

  it.each(['plain', 'realm', 'starship', 'sprawl', 'frontier', 'overworld'])('%s names the graph "What blocks what" and its blockers Blocked', async (theme) => {
    const scheme = Object.keys(themeNamed(theme).schemes)[0]!;
    await open('#/project/card-payments/dependencies', theme, scheme);
    const graph = screen.getByRole('region', { name: 'What blocks what' });
    // The graph loads on its own, after the rest of the tab.
    await waitFor(() => expect(within(graph).getAllByText('Blocked').length).toBeGreaterThan(0), { timeout: 3000 });
  });

  it.each([
    ['harvest', 'light'],
    ['overworld', 'dark'],
    ['frontier', 'light'],
    ['sprawl', 'dark'],
    ['realm', 'light'],
  ])('names the board and the sprint in %s (%s) with the real words alone', async (theme, scheme) => {
    await open('#/project/card-payments/board', theme, scheme);
    expect(screen.getByRole('region', { name: /^Sprint 42 board$/ })).toBeTruthy();
    expect(document.querySelector('.sprint-chip')!.textContent).toMatch(/^Sprint 42: day \d+ of \d+$/);
  });

  it('keeps the card\'s epic as the real word in Realm', async () => {
    await open('#/project/card-payments/board', 'realm', 'light');
    const board = screen.getByRole('region', { name: /board/ });
    expect(within(board).queryAllByText(/^Campaign/)).toHaveLength(0);
    expect(within(board).getAllByText(/^Epic: /).length).toBeGreaterThan(0);
  });

  it('names the builds, people, analyses and an item\'s fields by the real words in Realm (#415)', async () => {
    await open('#/project/card-payments/board', 'realm', 'light');
    const builds = screen.getByRole('region', { name: 'Builds' });
    // A build's outcome is the source's state alone: the dice words live in the moments, never beside it.
    expect(builds.querySelectorAll('.outcome').length).toBeGreaterThan(0);
    expect(builds.querySelectorAll('.outcome__roll')).toHaveLength(0);
    expect(builds.textContent).not.toMatch(/Natural 20|Critical fail/);
    cleanup();
    await open('#/project/card-payments/people', 'realm', 'light');
    expect(screen.getByRole('heading', { level: 1, name: 'People' })).toBeTruthy();
    cleanup();
    await open('#/project/card-payments/analyses', 'realm', 'light');
    expect(screen.getByRole('heading', { name: 'Past briefings' })).toBeTruthy();
    cleanup();
    await open(item('card-payments', 'corp-jira:PAY-100'), 'realm', 'light');
    expect(screen.getByText('Priority', { selector: 'dt' })).toBeTruthy();
  });

  it('keeps the real words alone in Realm with themed wording off', async () => {
    localStorage.setItem('toil-ui.theme', JSON.stringify({ theme: 'realm', scheme: 'light', wording: false }));
    window.location.hash = '#/project/card-payments/people';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview />);
    expect(await screen.findByRole('heading', { level: 1, name: 'People' })).toBeTruthy();
    expect(document.querySelector('.person-tag--roll')).toBeNull();
  });
});

describe('the skins', { timeout: SLOW }, () => {
  it.each([
    ['harvest', 'light'],
    ['starship', 'dark'],
    ['realm', 'light'],
    ['sprawl', 'dark'],
    ['frontier', 'light'],
    ['overworld', 'dark'],
  ])('answer in %s (%s) under the real word Agent, with no theme name beside it', async (theme, scheme) => {
    await open('#/project/settlement', theme, scheme);
    await openChat('settlement');
    const starters = screen.getByRole('group', { name: 'Starter questions' });
    await userEvent.click(within(starters).getAllByRole('button')[0]!);
    expect((await screen.findAllByText('Agent', {}, { timeout: 4000 })).length).toBeGreaterThan(0);
  });

  it('grow a crop on each Harvest card by its column, and hide the art from screen readers', async () => {
    await open('#/project/card-payments/board', 'harvest', 'light');
    const crops = [...document.querySelectorAll<HTMLImageElement>('.card .harvest-crop')];
    expect(crops.length).toBe(document.querySelectorAll('.card').length);
    for (const c of crops) expect(c.getAttribute('alt')).toBe('');
    const stages = new Set(crops.map((c) => c.className.match(/harvest-crop--(\w+)/)![1]));
    expect([...stages].sort()).toEqual(['done', 'in_progress', 'todo']);
    // The calendar hangs on the sprint, which the Overview's burn-up opens (#394).
    cleanup();
    await open('#/project/card-payments', 'harvest', 'light');
    await userEvent.click(screen.getByRole('button', { name: /^Points done / }));
    await screen.findByRole('dialog');
    expect(document.querySelector('.harvest-calendar')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('carry loot on each Overworld card by its column, and a heart meter and gem counter on the board and the sprint, all hidden from screen readers', async () => {
    await open('#/project/card-payments/board', 'overworld', 'dark');
    const loot = [...document.querySelectorAll<HTMLImageElement>('.card .ow-loot')];
    expect(loot.length).toBe(document.querySelectorAll('.card').length);
    for (const l of loot) expect(l.getAttribute('alt')).toBe('');
    const kinds = new Set(loot.map((l) => l.className.match(/ow-loot--(\w+)/)![1]));
    expect([...kinds].sort()).toEqual(['done', 'in_progress', 'todo']);
    expect(loot.find((l) => l.classList.contains('ow-loot--done'))!.getAttribute('src')).toBe(LOOT.DONE.src);
    // Day 7 of 10: 10 hearts, 3 still full; 3 of 21 points carried home.
    const hud = document.querySelector('.ow-hud')!;
    expect(hud.getAttribute('aria-hidden')).toBe('true');
    const hearts = [...hud.querySelectorAll('.ow-hearts img')].map((h) => h.getAttribute('src')!);
    expect(hearts).toHaveLength(10);
    expect(hearts.filter((h) => h === HEART.full)).toHaveLength(3);
    expect(hearts.filter((h) => h === HEART.empty)).toHaveLength(7);
    expect(hud.querySelector('.ow-gems')!.textContent).toBe('3/21');
    cleanup();
    await open('#/project/card-payments', 'overworld', 'dark');
    await userEvent.click(screen.getByRole('button', { name: /^Points done / }));
    expect((await screen.findByRole('dialog')).querySelector('.ow-hud')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('follow the sprint with the sky: --sprint-progress on the dashboard, gone off it', async () => {
    const { unmount } = await open('#/project/card-payments', 'harvest', 'light');
    const p = Number(document.documentElement.style.getPropertyValue('--sprint-progress'));
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
    unmount();
    expect(document.documentElement.style.getPropertyValue('--sprint-progress')).toBe('');
  });

  it.each([
    ['crate', 'Loading', 'crate-loading'],
    ['starship', 'EmptyState', 'empty-sector'],
    ['sprawl', 'Loading', 'jack-in'],
    ['sprawl', 'EmptyState', 'dead-drop'],
    ['frontier', 'Loading', 'locomotive'],
    ['frontier', 'EmptyState', 'wanted-poster'],
    ['overworld', 'Loading', 'sage-cave'],
    ['overworld', 'EmptyState', 'empty-room'],
  ] as const)("show %s's own art in its %s slot, decorative, beside the words", (theme, slot, file) => {
    const Slot = skinsFor(theme)[slot];
    const { container } = render(<Slot message="Nothing to file." />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toContain(file);
    expect(img.getAttribute('alt')).toBe('');
    expect(screen.getByText('Nothing to file.')).toBeTruthy();
  });

  it("roll a d20 in Realm's Loading slot, decorative, beside the words", () => {
    const Slot = skinsFor('realm').Loading;
    const { container } = render(<Slot message="Rolling for the ledgers…" />);
    const img = container.querySelector('img.realm-d20')!;
    expect(img.getAttribute('alt')).toBe('');
    expect(screen.getByRole('status').textContent).toBe('Rolling for the ledgers…');
  });

  it("roll an alignment for every Realm People card, the same each time, from the name only, and say what it is (#415)", async () => {
    await open('#/project/card-payments/people', 'realm', 'light');
    const cards = [...document.querySelectorAll('.person-card')];
    const tags = [...document.querySelectorAll('.person-tag--roll')].map((t) => t.textContent);
    expect(tags.length).toBe(cards.length);
    const values = themeNamed('realm').alignments!.values;
    for (const t of tags) expect(values).toContain(t!.replace(/^Rolled alignment: /, ''));
    expect(screen.getByRole('button', { name: 'About rolled alignments' })).toBeTruthy();
    const first = tags;
    cleanup();
    await open('#/project/card-payments/people', 'realm', 'light');
    expect([...document.querySelectorAll('.person-tag--roll')].map((t) => t.textContent)).toEqual(first);
  });

  it("count the sprint's hit points in place of its meter in Realm, from the sprint's own figures", async () => {
    await open('#/project/card-payments', 'realm', 'light');
    await userEvent.click(screen.getByRole('button', { name: /^Points done / }));
    const dialog = await screen.findByRole('dialog');
    const vitals = dialog.querySelector('.realm-vitals')!;
    expect(vitals.textContent).toBe('Points left 18 of 21');
    // The meter it stands in for is still in the page (theme.css hides it), and the Done tally reads as experience.
    expect(vitals.nextElementSibling?.matches('.meter') || dialog.querySelector('.realm-vitals ~ .meter')).toBeTruthy();
    expect(within(dialog).getByText('Done')).toBeTruthy();
    expect(vitals.querySelector('.realm-hp')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('mark the rest days on the worklog calendar in Realm, and say what the marks mean', () => {
    // The worklog needs the server's cache, which the preview has none of, so the panel's skin is rendered on its own.
    const Panel = skinsFor('realm').Panel;
    render(<Panel id="worklog-calendar"><table className="calendar" /></Panel>);
    expect(screen.getByText(/Camp fires mark rest days/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'About rest days' })).toBeTruthy();
    expect(document.querySelector('.realm-rest-key + .calendar')).toBeTruthy();
  });

  it('put a notched corner on Sprawl panels and the header, out of the accessibility tree, and the netrunner in a terminal window', async () => {
    await open('#/project/settlement/board', 'sprawl', 'dark');
    const notches = [...document.querySelectorAll('.sprawl-notch')];
    expect(notches.length).toBeGreaterThanOrEqual(5);
    for (const n of notches) expect(n.getAttribute('aria-hidden')).toBe('true');
    expect(document.querySelector('.top .sprawl-notch')).toBeTruthy();
    expect(screen.getByRole('region', { name: /^Sprint 42 board$/ })).toBeTruthy();
  });

  it('put HUD corners on Starship panels and the header, out of the accessibility tree', async () => {
    await open('#/project/settlement/board', 'starship', 'dark');
    const corners = [...document.querySelectorAll('.hud-corners')];
    expect(corners.length).toBeGreaterThanOrEqual(5);
    for (const c of corners) expect(c.getAttribute('aria-hidden')).toBe('true');
    expect(document.querySelector('.top .hud-corners')).toBeTruthy();
  });
});

describe('the local app\'s sync panel', { timeout: SLOW }, () => {
  const AT = '2026-10-13T08:00:00.000Z';
  const idle = { running: false, by: null, startedAt: AT, finishedAt: AT, toilProject: null, toilProjectsDone: 1, toilProjectsTotal: 1, fetched: 0, reused: 0, requests: 0, pages: 0, retries: 0, messages: [], error: null };
  const status: SyncStatus = {
    retentionDays: 30,
    job: idle,
    toilProjects: [
      {
        name: 'card-payments',
        lastSyncAt: AT,
        lastSavedAt: AT,
        status: 'partial',
        error: 'jira: failed',
        sources: [
          { area: 'bitbucket', status: 'ok', lastAttemptAt: AT, lastSuccessAt: AT, watermark: AT, error: null, fix: null, calls: 1, stale: false },
          { area: 'jira', status: 'failed', lastAttemptAt: AT, lastSuccessAt: AT, watermark: AT, error: 'jira issue search: jira.imagile.dev answered 503.', fix: 'Try again when the server is back.', calls: 1, stale: true },
        ],
      },
    ],
  };
  const client: SyncClient = { status: async () => status, start: async () => status, wipe: async () => status };

  it.each(SCHEMES)('in %s (%s) shows a stale source and the wipe confirmation, with no axe violations where the theme is strict', async (theme, scheme) => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.scheme = scheme;
    // The wipe is under Settings, General, Advanced now, so its confirmation is checked beside the bar.
    const { container } = render(
      <>
        <SyncPanel client={client} onChange={() => {}} />
        <WipeCache cache={{ wipe: async () => undefined, wipedAt: null }} />
      </>,
    );
    expect(await screen.findByText(/Showing the last good copy/)).toBeTruthy();
    const strict = STRICT.has(theme);
    if (strict) expect(await violations(container)).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: /Wipe/ }));
    if (strict) expect(await violations(container)).toEqual([]);
  });
});

describe('the header (#277)', { timeout: SLOW }, () => {
  it('names the wordmark by its own words, "toil UI", with no aria-label to disagree with them', async () => {
    await open('#/', 'crate', 'dark');
    const brand = screen.getByRole('link', { name: 'toil UI' });
    expect(brand.getAttribute('aria-label')).toBeNull();
    expect(brand.textContent).toBe('toil UI');
  });

  it('folds the views, Feedback and the theme into a Menu below 1024px, marks the current page, and closes on Escape', async () => {
    const real = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query.includes('max-width'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    try {
      await open('#/settings', 'crate', 'dark');
      expect(screen.queryByRole('navigation', { name: 'Views' })).toBeNull();
      const menu = screen.getByRole('button', { name: 'Menu' });
      await userEvent.click(menu);
      const dialog = await screen.findByRole('dialog', { name: 'Menu, on Settings' });
      expect(within(dialog).getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBe('page');
      // The overview is in the project list at the top of the Menu, not among the views.
      expect(within(within(dialog).getByRole('navigation', { name: 'Views' })).queryByRole('link', { name: 'Toil projects' })).toBeNull();
      expect(await within(dialog).findByRole('link', { name: 'All Toil projects' })).toBeTruthy();
      expect(within(dialog).getByRole('button', { name: /Theme/ })).toBeTruthy();
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      // React Aria hands focus back to the trigger a tick after the popover unmounts.
      await waitFor(() => expect(document.activeElement).toBe(menu));
    } finally {
      window.matchMedia = real;
    }
  });

  it('folds into the Menu at any width when its one row would wrap, as its links can in a wider font', async () => {
    // jsdom lays nothing out, so the header's parts report a row each: the views, after the brand, are a second one.
    const real = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const inRow = this.closest('.top') !== null;
      const below = this.tagName === 'NAV' && inRow;
      const top = below ? 40 : 0;
      const height = this.tagName === 'NAV' || this.classList.contains('brand') ? 20 : 0;
      return { top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    };
    try {
      await open('#/project/settlement', 'plain', 'light');
      expect(screen.queryByRole('navigation', { name: 'Views' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Menu' })).toBeTruthy();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = real;
    }
    cleanup();
    // One row that fits keeps the views in the header.
    await open('#/project/settlement', 'plain', 'light');
    expect(screen.getByRole('navigation', { name: 'Views' })).toBeTruthy();
  });
});
