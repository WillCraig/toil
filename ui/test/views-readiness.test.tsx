// @vitest-environment jsdom
// Readiness is judged by rules written down once, which makes it the only checklist nobody has to re-attest quarterly.
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import type { Execute } from '../src/toil.ts';
import { item, open, panel, tabs, resetBrowserState } from './views-kit.tsx';
import { fixtureStandards } from '../src/fixtures/standards.ts';

beforeEach(resetBrowserState);

describe('the readiness gate (#307)', () => {
  const rows = () => within(panel('Ready for an agent?')).getAllByRole('listitem').map((li) => li.textContent ?? '');

  it('shows the verdict and its five rows on an item, with no live read until a person asks for one', async () => {
    const fixture = fixtureExecute();
    await open(item('card-payments', 'corp-jira:PAY-102'), { execute: fixture.execute });
    const box = panel('Ready for an agent?');
    expect(box.querySelector('.verdict')!.textContent!.trim()).toBe('Blocked');
    expect(box.querySelector('.verdict [data-icon="close"]')).not.toBeNull();
    expect(rows().map((r) => /^(Acceptance criteria|Description|Done state|Blockers|Scope) (Passes|Thin|Fails)/.exec(r)?.slice(1).join(' '))).toEqual([
      // What fails or is thin first; what passes folds under "3 checks pass" (#657).
      'Description Thin',
      'Blockers Fails',
      'Acceptance criteria Passes',
      'Done state Passes',
      'Scope Passes',
      // card-payments names ticket rules (#657), and this view was given no check of them: one row says so, with a dash.
      undefined,
    ]);
    expect(rows()[5]).toContain('Ticket rules Not checked: Not read yet.');
    const passing = box.querySelector<HTMLDetailsElement>('[data-passing]')!;
    expect(passing.open).toBe(false);
    expect(passing.querySelector('summary')!.textContent).toBe('3 checks pass');
    // What blocks it is said once, under the title (#657); the Blockers row points up to it.
    expect(rows()[1]).toContain('Blockers Fails: what blocks it, named at the top, isn’t done.');
    const above = document.querySelector<HTMLElement>('[data-blocked-by]')!;
    expect(above.textContent).toContain('Blocked by Jira PAY-101');
    expect(within(above).getByRole('link', { name: /PAY-101/ }).getAttribute('href')).toBe('#/project/card-payments/item/corp-jira%3APAY-101');
    // A Jira custom field's id reads as a custom field.
    expect(rows()[2]).toContain('24 words in a custom field.');
    expect(fixture.calls.filter((c) => c.command === 'jira issue transitions')).toEqual([]);
  });

  it('settles the done state with one read-only live read when pressed', async () => {
    const fixture = fixtureExecute();
    await open(item('card-payments', 'corp-jira:PAY-100'), { execute: fixture.execute });
    expect(rows()[2]).toContain('no Epic in this Toil project has reached Done');
    await userEvent.click(screen.getByRole('button', { name: 'Check the workflow live' }));
    await waitFor(() => expect(rows()[2]).toContain('It can move to Done now: Done.'));
    expect(document.querySelector('.readiness-panel [data-source="toil jira issue transitions"]')).not.toBeNull();
    expect(fixture.calls.filter((c) => c.command === 'jira issue transitions')).toEqual([{ command: 'jira issue transitions', input: { toilProject: 'card-payments', key: 'PAY-100' }, ok: true, error: null }]);
    expect(screen.getByRole('button', { name: 'Read the workflow again' })).toBeTruthy();
    // The read belongs to that item: the next item's page starts without it.
    await act(async () => {
      window.location.hash = item('card-payments', 'corp-jira:PAY-104');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await screen.findByRole('heading', { level: 1, name: /Refund total/ });
    expect(screen.getByRole('button', { name: 'Check the workflow live' })).toBeTruthy();
    expect(rows()[2]).not.toContain('toil jira issue transitions');
  });

  it("reads an Azure DevOps type's states, and says so when the read fails", async () => {
    await open(item('settlement', 'corp-ado:2301'));
    await userEvent.click(screen.getByRole('button', { name: 'Check the workflow live' }));
    await waitFor(() => expect(rows()[2]).toContain('The Feature workflow has a Done state: Closed.'));
    cleanup();
    const failing: Execute = async (command, input, options) =>
      command === 'ado work-item states'
        ? { ok: false, data: null, error: { code: 'AUTH', message: 'The token was refused.', fix: 'Renew it.' }, meta: { command, durationMs: 0, version: 'x', contractVersion: 1 } }
        : fixtureExecute().execute(command, input, options);
    await open(item('settlement', 'corp-ado:2301'), { execute: failing });
    await userEvent.click(screen.getByRole('button', { name: 'Check the workflow live' }));
    await waitFor(() => expect(rows()[2]).toContain('The live read failed: The token was refused. Renew it.'));
  });

  it('lists every open item with its verdict and why, slates only the ready ones, and keeps the start for #293', async () => {
    const fixture = fixtureExecute();
    await open('#/project/card-payments/command-center', { execute: fixture.execute, rules: fixtureStandards() });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Ready to start?');
    // The Command Center is the Tickets tab (#657), and the board a drill-in from it.
    expect(within(tabs('card-payments')).getByRole('link', { name: /^Tickets/ }).getAttribute('aria-current')).toBe('page');
    expect(document.querySelector('[data-open-board]')!.getAttribute('href')).toBe('#/project/card-payments/board');
    const tally = screen.getByRole('list', { name: 'Open items by verdict' });
    // Until the ticket rules are read an item that passes the rest is "rules not read yet", never ready (principle 12).
    await waitFor(() => expect([...tally.querySelectorAll('.team-figure')].map((f) => f.textContent)).toEqual(['1', '3', '2']));
    // A tile is the verdict filter, and the ready one claims every check only for the items that pass every one.
    expect(tally.querySelector('[data-verdict-tile="ready"]')!.getAttribute('href')).toContain('verdict=ready');
    // One line, the count and its Start button (#657); the items are one press in.
    const slate = panel('1 ready');
    expect(within(slate).getByRole('list', { name: 'Slated items', hidden: true }).textContent).toContain('PAY-101');
    expect(slate.querySelector('details > summary')!.textContent).toBe("Which one, in the Toil project's order");
    // The plan's id is a hover away, never in the sentence.
    expect(slate.querySelector('[title^="Plan "]')!.getAttribute('title')).toMatch(/^Plan [0-9a-f]{8}$/);
    const start = within(slate).getByRole('button', { name: 'Start 1 ready item' });
    expect(start.hasAttribute('disabled')).toBe(true);
    expect(slate.textContent).toContain('This view has no AI agent assignments, so it shows the plan it would start.');
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(7);
    expect(table.textContent).toContain('Blocked by Jira PAY-102 (To Do).');
    expect(screen.getByText('Showing 6 items of 12, not done.')).toBeTruthy();
    // Why not ready is a figure a cell, with the sentences one press in (#657).
    expect(table.querySelector('[data-why-cell] > summary')!.textContent).toMatch(/^\d+ checks? missed/);
    // The status once: the tracker's word, its category one hover away, never "In Review (In progress)".
    expect(table.textContent).not.toMatch(/\((To do|In progress|Done)\)/);
    // No live read, and nothing beyond what the dashboard already loaded.
    expect(fixture.calls.filter((c) => c.command === 'jira issue transitions')).toEqual([]);
  });

  it('filters by verdict from its tile and by status from the filter bar, all in the address (#657)', async () => {
    await open('#/project/card-payments/command-center', { rules: fixtureStandards() });
    // One way to filter: no row of selects beside the filter bar.
    expect(screen.queryByRole('button', { name: /^Verdict/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Assignee/ })).toBeNull();
    const tile = (v: string) => document.querySelector<HTMLAnchorElement>(`[data-verdict-tile="${v}"]`)!;
    const go = async (href: string) => {
      await act(async () => {
        window.location.hash = href;
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
    };
    await go(tile('blocked').getAttribute('href')!);
    await waitFor(() => expect(screen.getByText('Showing 2 items of 12, not done.')).toBeTruthy());
    expect(tile('blocked').getAttribute('aria-current')).toBe('true');
    // Pressed again, the tile takes its filter off.
    expect(tile('blocked').getAttribute('href')).not.toContain('verdict=');
    // A status category filter brings done items in.
    await go(`${tile('blocked').getAttribute('href')!.split('?')[0]}?verdict=ready&statusCategory=DONE,IN_PROGRESS,TODO`);
    await waitFor(() => expect(screen.getByText(/^Showing \d+ items? of 12\.$/)).toBeTruthy());
    await go('#/project/card-payments/command-center?verdict=ready&assignee=Unassigned');
    await waitFor(() => expect(screen.getByText('No item matches these filters.')).toBeTruthy());
    expect(screen.getByRole('link', { name: 'Show every item' }).getAttribute('href')).toBe('#/project/card-payments/command-center');
  });

  it('says plainly when nothing is ready, and starts the plan it showed once #293 provides a start', async () => {
    await open('#/project/settlement/command-center');
    // Why nothing is slated is the heading's (i), not a paragraph (#657).
    expect(panel('Nothing ready').textContent).not.toContain('No open item is ready');
    expect(panel('Nothing ready').querySelector('[data-nothing-ready]')).not.toBeNull();
    cleanup();
    const started: Array<{ id: string; items: string[] }> = [];
    window.location.hash = '#/project/checkout-web/command-center';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview startReady={async (plan) => (started.push(plan), "Queued.")} />);
    await screen.findByRole('heading', { level: 1, name: 'Ready to start?' });
    const slate = panel('1 ready');
    const shownId = /^Plan ([0-9a-f]{8})$/.exec(slate.querySelector('[title^="Plan "]')!.getAttribute('title') ?? '')![1];
    // What Start does is its (i), not a paragraph beside it, and Start carries the agent mark (#657).
    expect(slate.textContent).not.toContain('Asks an AI agent to try a fix for each ready item, in order');
    expect(slate.querySelector('[data-help="start-ready"]')).toBeTruthy();
    expect(within(slate).getByRole('button', { name: 'Start 1 ready item' }).querySelector('.agent-mark')).toBeTruthy();
    await userEvent.click(within(slate).getByRole('button', { name: 'Start 1 ready item' }));
    expect(started).toEqual([{ id: shownId, items: ['github:imagile/payments-web#41'] }]);
    expect(await within(slate).findByText('Queued.')).toBeTruthy();
  });
});
