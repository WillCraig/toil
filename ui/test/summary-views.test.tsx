import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { fixtureAnalyses } from '../src/fixtures/analyses.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { fixtureWorklog } from '../src/fixtures/worklog.ts';
import type { WorklogApi } from '../src/worklog.ts';
import { setPrefs } from '../src/briefing-prefs.ts';

/**
 * The Summary tab leads with the answer (#552): the status sentence as the
 * first heading, one line on why, at most three cards, and the full briefing
 * one step in, folded until a person opens it.
 */

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
});

// A Jira key (PAY-101) or an Azure DevOps id (2303): what a headline must not carry.
const KEY = /\b[A-Z][A-Z0-9]+-\d+\b|\b\d{4}\b/;

async function open(toilProject: string, analyses = true) {
  window.location.hash = `#/project/${toilProject}`;
  render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} analyses={analyses ? fixtureAnalyses() : undefined} now={FIXTURE_NOW} preview />);
  const region = await screen.findByRole('region', { name: 'Briefing' });
  await waitFor(() => expect(region.querySelector('[data-answer]')).toBeTruthy());
  if (analyses) await waitFor(() => expect(region.dataset.recSource).toBe('analysis'));
  return region;
}
const full = (r: HTMLElement) => r.querySelector('details[data-full-briefing]') as HTMLDetailsElement;
const cardIds = (r: HTMLElement) => [...r.querySelectorAll('.sum-card')].map((c) => (c as HTMLElement).dataset.card);

describe('the answer first', () => {
  it('opens on the status sentence, with no ticket key in it or in the line on why', async () => {
    const region = await open('card-payments');
    const first = within(region).getAllByRole('heading')[0]!;
    expect(first.textContent).toMatch(/^Behind: \. ?18 of 21 points are left, and 3 working days remain\.$/);
    expect(first.querySelector('svg')).toBeTruthy();
    // The estimate caveat is the first line of the fold; the basis line is for too early a pace.
    expect(region.querySelector('.sum-basis')).toBeNull();
    expect(region.querySelector('.sum-how li')!.textContent).toBe('The status word is an estimate from the pace so far.');
    const why = region.querySelector('[data-why]')!.textContent!;
    expect(why).toBe('Mostly because the tests for “Tokenise card numbers at the edge” are failing, and 2 stories (11 points) wait behind it.');
    expect(first.textContent! + why).not.toMatch(KEY);
  });

  it('says the same working days left as the Toil projects card', async () => {
    window.location.hash = '#/';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview />);
    const card = (await screen.findByRole('link', { name: 'settlement' })).closest('li')!;
    expect(card.textContent).toContain('2 working days left of 9');
    cleanup();
    const region = await open('settlement', false);
    expect(region.querySelector('[data-answer]')!.textContent).toContain('15 of 16 points are left, and 2 working days remain.');
  });

  it('folds the full briefing, keeps it whole inside, and leaves its source, the sprint and Go to in view', async () => {
    const region = await open('card-payments');
    const fold = full(region);
    expect(fold.open).toBe(false);
    expect(within(fold).getByText('Show the full briefing')).toBeTruthy();
    // What used to open the tab is all still there, one step in.
    expect(fold.querySelector('.briefing__head')!.textContent).toContain('Fix');
    expect(fold.querySelector('details[data-reason="failing"]')).toBeTruthy();
    expect(fold.querySelector('details.briefing__numbers')).toBeTruthy();
    expect(fold.querySelector('details.customize')).toBeTruthy();
    // And what principle 4 keeps on screen is outside the fold.
    const meta = region.querySelector('.briefing__meta')!;
    expect(fold.contains(meta)).toBe(false);
    expect(meta.textContent).not.toContain('day 7 of 10');
    expect(meta.textContent).toContain('Written by an AI agent');
    expect(fold.contains(region.querySelector('nav.briefing__links'))).toBe(false);
  });

  it('remembers whether the full briefing is open, in this browser', async () => {
    const region = await open('card-payments');
    await userEvent.click(within(full(region)).getByText('Show the full briefing'));
    expect(full(region).open).toBe(true);
    expect(JSON.parse(localStorage.getItem('toil-ui.briefing')!)).toMatchObject({ fullOpen: true });
    cleanup();
    const again = await open('card-payments');
    expect(full(again).open).toBe(true);
    act(() => setPrefs({ fullOpen: false }));
    expect(full(again).open).toBe(false);
  });

  it("says who wrote the briefing when it is the code's, outside the fold too", async () => {
    const region = await open('card-payments', false);
    const by = region.querySelector('[data-briefing-by]')!;
    expect(by.textContent).toBe("Worked out by the app's own rules, no AI");
    expect(full(region).contains(by)).toBe(false);
  });
});

describe('what needs attention', () => {
  it('shows at most three cards, each with one link, the ticket key small after the title', async () => {
    const region = await open('card-payments');
    expect(cardIds(region)).toEqual(['risk', 'blocked', 'review']);
    for (const c of region.querySelectorAll('.sum-card')) expect(c.querySelectorAll('a')).toHaveLength(1);
    const risk = region.querySelector('.sum-card')!;
    expect(risk.querySelector('h3')!.firstChild!.textContent).toBe('Tokenise card numbers at the edge');
    expect(risk.querySelector('h3 .sum-key')!.textContent!.trim()).toBe('Jira PAY-101');
    expect(risk.querySelector('a')!.getAttribute('href')).toBe('#/project/card-payments?item=corp-jira%3APAY-101');
  });

  it('never gives one story two cards, and falls back to stories not ready to start', async () => {
    const region = await open('settlement', false);
    expect(cardIds(region)).toEqual(['risk', 'ready']);
  });

  it('shows the fallback alone when nothing else is there', async () => {
    const region = await open('checkout-web', false);
    expect(cardIds(region)).toEqual(['ready']);
  });

  it('opens an item on its own page when the person chose that', async () => {
    setPrefs({ opensIn: 'page' });
    const region = await open('card-payments');
    expect(region.querySelector('.sum-card[data-card="risk"] a')!.getAttribute('href')).toBe('#/project/card-payments/item/corp-jira%3APAY-101');
  });
});

describe('plain words', () => {
  it('says code review, with the same facts as the data', async () => {
    const region = await open('card-payments');
    expect(region.querySelector('.sum-card[data-card="review"]')!.textContent!).toContain('The code review for');
  });
});

describe('the stand-up on the Summary', () => {
  async function withLog(api: WorklogApi | undefined, sync?: () => void) {
    window.location.hash = '#/project/card-payments';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview worklog={api} {...(sync ? { onSync: sync } : {})} />);
    return screen.findByRole('region', { name: 'Briefing' });
  }

  it('shows the default range, five lines, and Show more expands in place', async () => {
    const region = await withLog(fixtureWorklog());
    const card = await waitFor(() => {
      const c = region.querySelector('[data-standup-card]') as HTMLElement;
      expect(c.querySelectorAll('li').length).toBeGreaterThan(0);
      return c;
    });
    expect(within(card).getByRole('heading', { name: 'Stand-up' })).toBeTruthy();
    expect(card.querySelector('[data-standup-range]')!.textContent).toBe('Yesterday');
    expect(card.querySelectorAll('li').length).toBe(5);
    expect(within(card).getByRole('link', { name: 'Open the full stand-up' }).getAttribute('href')).toBe('#/project/card-payments/worklog/standup');
    // Right under the answer and the needs-attention cards, before the fold.
    const order = [...region.children].map((c) => c.getAttribute('data-standup-card') !== null ? 'card' : c.matches('details[data-full-briefing]') ? 'full' : '');
    expect(order.indexOf('card')).toBeGreaterThan(-1);
    expect(order.indexOf('card')).toBeLessThan(order.indexOf('full'));
    await userEvent.click(within(card).getByRole('button', { name: /^Show more/ }));
    expect(card.querySelectorAll('li').length).toBeGreaterThan(5);
    expect(within(card).getByRole('button', { name: 'Show less' })).toBeTruthy();
    expect(within(region).getByRole('navigation', { name: /^More on/ }).textContent).toContain('Stand-up');
    expect(within(region).getByRole('link', { name: 'Stand-up' }).getAttribute('href')).toBe('#/project/card-payments/worklog/standup');
  });

  it('says not read yet, with Sync now, when no sync has read the days, and never nothing happened', async () => {
    const sample = fixtureWorklog();
    const api: WorklogApi = { ...sample, standup: async (d, f, t) => {
      const r = await sample.standup(d, f, t);
      return { ...r, report: { ...r.report, asOf: null, team: [], people: [], facts: 0 } };
    } };
    const synced: string[] = [];
    const region = await withLog(api, () => synced.push('sync'));
    const card = await waitFor(() => {
      const c = region.querySelector('[data-standup-card]') as HTMLElement;
      expect(c.querySelector('[data-not-read]')).toBeTruthy();
      return c;
    });
    expect(card.querySelector('[data-not-read]')!.textContent).toContain('–');
    expect(card.textContent).not.toMatch(/nothing (happened|recorded)/i);
    await userEvent.click(within(card).getByRole('button', { name: 'Sync now' }));
    expect(synced).toEqual(['sync']);
  });

  it('is absent where no worklog is kept', async () => {
    const region = await withLog(undefined);
    await waitFor(() => expect(region.querySelector('[data-answer]')).toBeTruthy());
    expect(region.querySelector('[data-standup-card]')).toBeNull();
  });
});
