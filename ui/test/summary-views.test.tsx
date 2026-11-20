// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
const full = (r: HTMLElement) => r.querySelector('[data-full-briefing]') as HTMLElement;
const toggle = (r: HTMLElement) => full(r).querySelector('[data-full-toggle]') as HTMLButtonElement;
const bodyOf = (r: HTMLElement) => full(r).querySelector('#full-briefing-body') as HTMLElement;
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
    // The cards read their Toil projects one after another, so the figure arrives after the link does.
    await waitFor(() => expect(card.textContent).toContain('2 working days left of 9'));
    cleanup();
    const region = await open('settlement', false);
    expect(region.querySelector('[data-answer]')!.textContent).toContain('15 of 16 points are left, and 2 working days remain.');
  });

  it('folds the full briefing, keeps it whole inside, and leaves its source, the sprint and Go to in view', async () => {
    const region = await open('card-payments');
    const fold = full(region);
    expect(bodyOf(region).hidden).toBe(true);
    expect(toggle(region).getAttribute('aria-expanded')).toBe('false');
    expect(toggle(region).textContent).toBe('Show the full briefing');
    expect(toggle(region).querySelector('[data-icon="chevron-right"]')).toBeTruthy();
    // What used to open the tab is all still there, one step in.
    expect(fold.querySelector('.briefing__head')!.textContent).toContain('Fix');
    expect(fold.querySelector('details[data-reason="failing"]')).toBeTruthy();
    expect(fold.querySelector('details.briefing__numbers')).toBeTruthy();
    // Customize sits in the header row of "Why", not alone above the headline.
    expect(fold.querySelector('.briefing__labelrow details.customize')).toBeTruthy();
    // And what principle 4 keeps on screen is outside the fold.
    const meta = region.querySelector('.briefing__meta')!;
    expect(fold.contains(meta)).toBe(false);
    expect(meta.textContent).not.toContain('day 7 of 10');
    expect(meta.textContent).toContain('Written by an AI agent');
    expect(fold.contains(region.querySelector('nav.briefing__links'))).toBe(false);
  });

  it('is a real toggle: closed on every visit, opened and closed by its button, with a chevron that follows', async () => {
    const region = await open('card-payments');
    await userEvent.click(toggle(region));
    expect(bodyOf(region).hidden).toBe(false);
    expect(toggle(region).getAttribute('aria-expanded')).toBe('true');
    expect(toggle(region).textContent).toBe('Hide the full briefing');
    expect(toggle(region).querySelector('[data-icon="chevron-down"]')).toBeTruthy();
    await userEvent.click(toggle(region));
    expect(bodyOf(region).hidden).toBe(true);
    await userEvent.click(toggle(region));
    cleanup();
    // Not remembered: the Summary's focus is the status sentence and what needs attention.
    const again = await open('card-payments');
    expect(bodyOf(again).hidden).toBe(true);
  });

  it("keeps the hero's (i) beside its link, and says the authorship once", async () => {
    const region = await open('card-payments');
    const row = region.querySelector('.sum-howrow')!;
    expect(row.children[0]!.matches('details.sum-how')).toBe(true);
    expect(row.children[1]!.querySelector('button, [aria-label^="About"]') ?? row.children[1]).toBeTruthy();
    expect(region.textContent!.match(/Written by an AI agent/g)).toHaveLength(1);
  });

  it("says who wrote the briefing when it is the code's, outside the fold too", async () => {
    const region = await open('card-payments', false);
    // A badge on the headline (#657): two words to the eye, the whole sentence in its tooltip and to a screen reader.
    const by = region.querySelector('[data-briefing-by]')!;
    expect(by.getAttribute('title')).toBe("Worked out by the app's own rules, no AI");
    expect(by.textContent).toBe("Rules, no AIWorked out by the app's own rules, no AI");
    expect(full(region).contains(by)).toBe(false);
  });
});

describe('what needs attention', () => {
  it('shows at most three cards, each one button, the ticket key small after the title', async () => {
    const region = await open('card-payments');
    expect(cardIds(region)).toEqual(['risk', 'blocked', 'review']);
    for (const c of region.querySelectorAll('.sum-card')) expect(c.querySelectorAll('a')).toHaveLength(1);
    const risk = region.querySelector('.sum-card')!;
    expect(risk.querySelector('.sum-card__title')!.firstChild!.textContent).toBe('Tokenise card numbers at the edge');
    expect(risk.querySelector('.sum-card__title .sum-key')!.textContent!.trim()).toBe('Jira PAY-101');
    // Stories that can't start open what blocks what.
    expect(region.querySelector('.sum-card[data-card="blocked"] a')!.getAttribute('href')).toBe('#/project/card-payments/dependencies');
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

  it('shows the default range as the same compact rows, a handful of them, with the way in to the page', async () => {
    const region = await withLog(fixtureWorklog());
    const card = await waitFor(() => {
      const c = region.querySelector('[data-standup-card]') as HTMLElement;
      expect(c.querySelectorAll('[data-standup-counts]').length).toBeGreaterThan(0);
      return c;
    });
    expect(within(card).getByRole('heading', { name: 'Stand-up' })).toBeTruthy();
    expect(card.querySelector('[data-standup-range]')!.textContent).toBe('Yesterday');
    // A team line, then at most five person rows, each one bucket: no F1 to F5 list, no Show more.
    expect(card.querySelector('[data-standup-team]')!.textContent).toMatch(/^Sprint 42: day \d+ of \d+, \d+ of \d+ done$/);
    expect(card.querySelectorAll('.sum-standup__row').length).toBeLessThanOrEqual(5);
    // Each person is one line of counts; the items themselves are on the full stand-up (#657).
    for (const c of card.querySelectorAll('[data-standup-counts]')) expect(c.textContent).toMatch(/^\d+ (done|in progress|blocked|questions? waiting)( · \d+ (done|in progress|blocked|questions? waiting))*$/);
    expect(card.querySelector('.standup-chip')).toBeNull();
    // A name stays on one line; an account after it is a muted suffix with the whole text on hover, never part of the name.
    for (const n of card.querySelectorAll('.sum-person__name')) expect(n.textContent).not.toContain('(');
    for (const a of card.querySelectorAll('.sum-person__account')) expect(a.closest('.sum-person')!.getAttribute('title')).toContain(a.textContent!);
    expect(card.querySelector('[data-standup-more]')).toBeNull();
    expect(within(card).getByRole('link', { name: 'Open the full stand-up' }).getAttribute('href')).toBe('#/project/card-payments/standup');
    // Right under the answer and the needs-attention cards, before the fold.
    const order = [...region.children].map((c) => c.getAttribute('data-standup-card') !== null ? 'card' : c.matches('[data-full-briefing]') ? 'full' : '');
    expect(order.indexOf('card')).toBeGreaterThan(-1);
    expect(order.indexOf('card')).toBeLessThan(order.indexOf('full'));
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
