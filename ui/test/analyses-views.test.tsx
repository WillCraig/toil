// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import type { AnalysesApi } from '../src/analyses.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { fixtureAnalyses, sampleAnalysisRecords } from '../src/fixtures/analyses.ts';
import { memoryAnalyses } from '../src/analyses.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { askBar } from './chat.ts';

/**
 * The history of analyses in the views (#395), on the sample's: the Analyses
 * tab and what changed, one analysis opened again, the Overview's
 * recommendation from the latest one, the sidebar's Recent analyses, an
 * Analyze in the chat laid out top-down and joining the history, and the
 * citation chips with their detail.
 */

async function open(hash: string, analyses: AnalysesApi | undefined = fixtureAnalyses()) {
  window.location.hash = hash;
  const view = render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview {...(analyses ? { analyses } : {})} />);
  await screen.findByRole('heading', { level: 1 }, { timeout: 3000 });
  return view;
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

const list = () => screen.findByRole('list', { name: 'Analyses, newest first' });

describe('the Analyses tab', () => {
  it('lists every analysis newest first, with its time, who wrote it, its recommendation, and what changed since the one before', async () => {
    await open('#/project/card-payments/analyses');
    const entries = within(await list()).getAllByRole('listitem').filter((li) => li.classList.contains('analysis'));
    expect(entries).toHaveLength(2);
    const [latest, first] = entries as [HTMLElement, HTMLElement];
    expect(latest.textContent).toContain('13 Oct 2026, 07:30 UTC, by the scripted preview, not a model.');
    expect(latest.querySelector('.analysis__rec')!.textContent).toContain("Fix");
    // The recommendation's citations are chips: key, title and status.
    const chip = within(latest.querySelector('.analysis__rec') as HTMLElement).getAllByRole('link')[0]!;
    // Its name is its visible words, key, title and status, so voice control finds it by what it shows (WCAG 2.5.3).
    expect(chip.getAttribute('aria-label')).toBeNull();
    expect(chip.textContent).toMatch(/^Jira PAY-101 .+, In Progress$/);
    expect(latest.textContent).toContain('Since the one before: 1 newly blocked, 1 cleared, points moved on 1 item, sprint points moved');
    expect(first.textContent).toContain('The first analysis kept, so there is nothing to compare it with.');

    // What changed, opened: the newly blocked item with what blocks it, the cleared one, the points and the sprint.
    await userEvent.click(within(latest).getByText(/^Since the one before/));
    const changes = latest.querySelector('.analysis-changes') as HTMLElement;
    expect(within(changes).getByText('Newly blocked')).toBeTruthy();
    expect(changes.textContent).toMatch(/PAY-103.*by.*PAY-102/s);
    expect(within(changes).getByText('Cleared').nextElementSibling!.textContent).toContain('PAY-104');
    expect(within(changes).getByText('Points moved').nextElementSibling!.textContent).toMatch(/PAY-102.*\d+ points? to \d+ points?/s);
    expect(within(changes).getByText('The sprint').nextElementSibling!.textContent).toBe('Sprint 42: 0 done, 21 left, then Sprint 42: 3 done, 18 left.');
    expect(latest.querySelector('.analysis__open a')!.textContent).toBe('Open the analysis of 13 Oct 2026, 07:30 UTC');
    expect(latest.querySelector('.analysis__open a')!.getAttribute('href')).toBe('#/project/card-payments/analyses/sample-analysis-2');
  });

  it('says so when a Toil project has none yet', async () => {
    await open('#/project/settlement/analyses');
    expect(await screen.findByText(/No briefing (kept|in the filing cabinet) for this Toil project yet/)).toBeTruthy();
  });

  it('opens one again, top-down, with its evidence folded and what changed', async () => {
    await open('#/project/card-payments/analyses/sample-analysis-2');
    const panel = await screen.findByRole('region', { name: /^Analysis of 13 Oct 2026/ });
    expect(within(panel).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Recommendation', 'Reasons', 'What changed since the one before']);
    const reasons = within(panel).getByRole('region', { name: 'Reasons' }).querySelectorAll('ol > li');
    expect([...reasons].map((li) => li.querySelector('strong')?.textContent)).toEqual(['Failing checks: ', 'Blocked: ', 'Waiting on review: ']);
    expect(panel.querySelector('.analysis-next')?.textContent).toContain('Next:');
    const evidence = panel.querySelector('details.analysis-evidence') as HTMLDetailsElement;
    expect(evidence.open).toBe(false);
    expect(evidence.querySelector('summary')!.textContent).toMatch(/^Evidence \(\d+ paragraphs\)$/);
    expect(within(panel).getByRole('link', { name: 'All analyses' }).getAttribute('href')).toBe('#/project/card-payments/analyses');
    expect(panel.textContent).toContain('Newly blocked');
  });

  it('says plainly when the history no longer has one', async () => {
    await open('#/project/card-payments/analyses/gone');
    expect(await screen.findByRole('heading', { level: 2, name: 'Analysis not found' })).toBeTruthy();
    expect(document.body.textContent).toContain('card-payments has no analysis by that id');
  });
});

describe("the Toil project's briefing (#494)", () => {
  it("is the latest Analyze's when it is current, says who wrote it, and links to it", async () => {
    await open('#/project/card-payments');
    const b = await screen.findByRole('region', { name: 'Briefing' });
    await waitFor(() => expect(b.dataset.recSource).toBe('analysis'));
    expect(b.textContent).toContain('Written by an AI agent, the scripted preview, not a model, 13 Oct 2026, 07:30 UTC');
    expect(within(b).getByRole('link', { name: 'Open that briefing' }).getAttribute('href')).toBe('#/project/card-payments/analyses/sample-analysis-2');
    expect(b.querySelector('.briefing__head')!.textContent).toContain('Fix');
    // The first reason is open, the rest folded.
    const reasons = [...b.querySelectorAll<HTMLDetailsElement>('details[data-reason]')];
    expect(reasons.map((r) => [r.dataset.reason, r.open])).toEqual([['failing', true], ['blocked', false], ['waiting', false]]);
  });

  it("opens an item's drawer from its row, with why it's here, the next step and the way to its page", async () => {
    await open('#/project/card-payments');
    const b = await screen.findByRole('region', { name: 'Briefing' });
    await waitFor(() => expect(b.dataset.recSource).toBe('analysis'));
    const row = b.querySelector<HTMLAnchorElement>('a[data-row="corp-jira:PAY-101"]')!;
    expect(row.getAttribute('href')).toBe('#/project/card-payments?item=corp-jira%3APAY-101');
    window.location.hash = row.getAttribute('href')!;
    const drawer = await screen.findByRole('complementary', { name: 'Tokenise card numbers at the edge' });
    expect(within(drawer).getByRole('region', { name: "Why it's here" }).textContent).toContain('Failing checks');
    expect(within(drawer).getByRole('region', { name: 'Next step' }).textContent).toContain('Fix the failing test in the tokeniser');
    expect(within(drawer).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('#/project/card-payments/item/corp-jira%3APAY-101');
    expect(within(drawer).getByRole('link', { name: 'Close the drawer' }).getAttribute('href')).toBe('#/project/card-payments');
    // The view behind it stays where it was.
    expect(screen.getByRole('region', { name: 'Briefing' })).toBeTruthy();
  });

  it("falls back to the code's briefing when the latest Analyze is older than the data, and says so", async () => {
    const old = (await sampleAnalysisRecords()).map((r, i) => ({ ...r, at: `2026-10-0${8 + i}T09:00:00.000Z` }));
    await open('#/project/card-payments', memoryAnalyses(old));
    const b = await screen.findByRole('region', { name: 'Briefing' });
    await waitFor(() => expect(b.textContent).toContain('The latest Analyze is older than the data.'));
    expect(b.dataset.recSource).toBe('code');
    expect(b.textContent).toContain("Worked out by the app's own rules, no AI");
    expect(within(b).getByRole('link', { name: 'Open that briefing' }).getAttribute('href')).toBe('#/project/card-payments/analyses/sample-analysis-2');
  });

  it("is the code's, and says so, where there is no analysis", async () => {
    await open('#/project/settlement');
    const b = await screen.findByRole('region', { name: 'Briefing' });
    expect(b.dataset.recSource).toBe('code');
    expect(b.textContent).toContain("Worked out by the app's own rules, no AI");
    expect(b.querySelectorAll('details[data-reason]').length).toBeGreaterThan(0);
  });

  it('opens the same drawer from a Board card and a pull request, over the view', async () => {
    await open('#/project/card-payments/board');
    const key = await waitFor(() => document.querySelector<HTMLAnchorElement>('a.card-key[href*="PAY-101"]')!);
    expect(key.getAttribute('href')).toBe('#/project/card-payments/board?item=corp-jira%3APAY-101');
    window.location.hash = '#/project/card-payments/prs';
    const link = await waitFor(() => {
      const found = document.querySelector<HTMLAnchorElement>('a.item-link[href*="/prs?item="]');
      expect(found).toBeTruthy();
      return found!;
    });
    expect(link.getAttribute('href')).toMatch(/^#\/project\/card-payments\/prs\?item=/);
    window.location.hash = link.getAttribute('href')!;
    expect(await screen.findByRole('complementary', { name: /./ })).toBeTruthy();
  });

  it('says plainly when a drawer names an item the Toil project does not hold', async () => {
    await open('#/project/card-payments?item=corp-jira%3APAY-999');
    const drawer = await screen.findByRole('complementary', { name: 'Not in this Toil project' });
    expect(drawer.textContent).toContain("corp-jira:PAY-999 isn't one of card-payments's items");
  });
});

describe('Analyze in the chat', () => {
  it('lays the answer out top-down with its evidence folded, keeps it, and the tab, sidebar and Overview follow', async () => {
    // No history given: the App keeps this page's own, which starts empty.
    await open('#/project/checkout-web', undefined);
    const card = await screen.findByRole('region', { name: 'Briefing' });
    expect(card.dataset.recSource).toBe('code');
    await userEvent.click(within(askBar('checkout-web')).getByRole('textbox', { name: 'Your question' }));
    const chat = await screen.findByRole('dialog', { name: 'Ask about checkout-web' });
    await userEvent.click(within(chat).getByRole('button', { name: /^Give me the full briefing/ }));
    const kept = await within(chat).findByRole('link', { name: 'Kept in Analyses' }, { timeout: 5000 });
    expect(within(chat).getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(['Recommendation', 'Reasons']);
    expect((chat.querySelector('details.analysis-evidence') as HTMLDetailsElement).open).toBe(false);
    // Every citation in the answer is a plain link: a short source name, its key and a cut title, with the status in the name a screen reader reads.
    const chips = chat.querySelectorAll('.cite-link');
    expect(chips.length).toBeGreaterThan(5);
    expect([...chips].every((c) => c.getAttribute('data-cite') && c.querySelector('.sr-only')!.textContent!.startsWith(', ') && !c.classList.contains('ticket-chip'))).toBe(true);

    await userEvent.click(kept);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ask about checkout-web' })).toBeNull());
    expect(await screen.findByRole('region', { name: /^Analysis of / })).toBeTruthy();
    window.location.hash = '#/project/checkout-web';
    await waitFor(() => expect(screen.getByRole('region', { name: 'Briefing' }).dataset.recSource).toBe('analysis'));
  });
});

describe('a citation chip', () => {
  it('shows its detail on focus: type and status, assignee, estimate, sprint', async () => {
    await open('#/project/card-payments/analyses');
    const chip = within((await list()).querySelector('.analysis__rec') as HTMLElement).getAllByRole('link')[0]!;
    await userEvent.tab();
    chip.focus();
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    await userEvent.tab();
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toContain('PAY-101');
    expect(tip.textContent).toMatch(/Assignee: /);
    expect(tip.textContent).toMatch(/Estimate: /);
    expect(tip.textContent).toContain('Sprint: Sprint 42');
  });
});

describe('the sidebar', () => {
  it("lists the Toil project's three newest analyses, each linking to it", async () => {
    await open('#/project/card-payments');
    await userEvent.click(screen.getByRole('button', { name: /^AI agents/ }));
    const side = await screen.findByRole('region', { name: 'AI agents' });
    const recent = within(side).getByRole('region', { name: 'Recent briefings' });
    await waitFor(() => expect(within(recent).getAllByRole('listitem')).toHaveLength(2));
    const links = within(recent).getAllByRole('link');
    expect(links[0]!.getAttribute('href')).toBe('#/project/card-payments/analyses/sample-analysis-2');
    expect(links[0]!.textContent).toContain('Fix PAY-101');
    expect(links.at(-1)!.textContent).toBe('All past briefings');
  });
});
