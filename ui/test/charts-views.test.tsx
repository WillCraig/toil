// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { SAMPLE_TEAM } from '../src/fixtures/sample-team.ts';

/**
 * The Charts tab, the Work mix and Releases dashboards, the drill drawer, the
 * filter bar in the address and the Summary's Work mix tile (#567), on the
 * sample team, whose figures docs/sample-team.md and toil's own sample facts hold.
 */

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
});

async function open(hash: string) {
  window.location.hash = hash;
  const view = render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview />);
  return view;
}
const go = async (hash: string) => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
};
/** Waits for an element to exist: a bare querySelector in waitFor returns null without failing, so this throws until it is there. */
const until = <T extends Element>(selector: string) =>
  waitFor(() => {
    const el = document.querySelector<T>(selector);
    if (!el) throw new Error(`no ${selector} yet`);
    return el;
  });
const TEAM = '#/project/sample-team';

describe('Work mix', () => {
  it('draws the trend, says how it was decided beside it, and splits by any dimension', async () => {
    await open(`${TEAM}/summary/mix`);
    const decided = await until<HTMLElement>('[data-decided]');
    expect(decided.textContent).toMatch(/Rules \d+%Labels on the items \d+%Your AI agent 0%People 0%Not sorted yet \d+%/);
    expect(decided.querySelector('a[data-unsure-link]')!.getAttribute('href')).toBe('#/project/sample-team/board/classify');
    expect(screen.getAllByText(/Work mix by month/).length).toBeGreaterThan(0);
    expect(document.querySelector('[data-mix-lead]')!.textContent).toMatch(/Feature \d+% · Keep the lights on \d+% · Not sorted yet \d+%, last 90 days/);
    await go(`${TEAM}/summary/mix?split=team`);
    await waitFor(() => expect(screen.getAllByText(/Work mix by team/).length).toBeGreaterThan(0));
  });

  it('keeps the filters when an item opens, and lists the right count from a notable change', async () => {
    await open(`${TEAM}/summary/mix`);
    const door = await until<HTMLAnchorElement>('[data-door]');
    await go(door.getAttribute('href')!);
    const drawer = await until<HTMLElement>('[data-drill]');
    const n = Number(drawer.getAttribute('data-drill'));
    expect(n).toBeGreaterThan(0);
    expect(drawer.querySelectorAll('tbody tr')).toHaveLength(n);
    expect(drawer.querySelector('[data-drill-count]')!.textContent).toMatch(new RegExp(`^${n} items?`));
    const first = within(drawer).getAllByRole('link', { name: /Jira SHOP/ })[0] as HTMLAnchorElement;
    expect(first.getAttribute('href')).toContain('items=');
    await go(first.getAttribute('href')!);
    const one = await until<HTMLElement>('[data-drawer]');
    const back = within(one).getByRole('link', { name: 'Close the drawer' }).getAttribute('href')!;
    expect(back).toContain('items=');
    expect(back).not.toContain('item=sample');
  });

  it('shows a filter chip from the address and removes it', async () => {
    await open(`${TEAM}/summary/mix?release=2.4`);
    const chip = await until<HTMLElement>('[data-filter-chip="release=2.4"]');
    expect(chip.textContent).toContain('Fix version: 2.4');
    await act(async () => within(chip).getByRole('button', { name: 'Remove Fix version: 2.4' }).click());
    expect(window.location.hash).toBe(`${TEAM}/summary/mix`);
  });
});

describe('Releases', () => {
  it('shows 2.4 with the sample facts, and a dash where a release has no start date', async () => {
    await open(`${TEAM}/summary/releases`);
    const section = await until<HTMLElement>('[data-release="2.4"]');
    const f = SAMPLE_TEAM.facts.releases.find((r) => r.name === '2.4')!;
    const text = section.querySelector('.release__figures')!.textContent!;
    expect(text).toContain(`${f.items} in it`);
    expect(text).toContain(`${f.done} done`);
    expect(text).toContain(`${f.open} left`);
    expect(text).toContain(`${f.scopeAdded} added since it started`);
    expect((section as HTMLDetailsElement).open).toBe(true);
    expect(document.querySelector('[data-release="2.5"]')).toBeTruthy();
    expect(within(section).getAllByText(/Burn-up: 2.4/).length).toBeGreaterThan(0);
  });

  it('says fix versions were not read, with the sentence, where they were not', async () => {
    await open('#/project/card-payments/summary/releases');
    await waitFor(() => expect(screen.getByText(/Fix versions weren't read/)).toBeTruthy());
  });
});

