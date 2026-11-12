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

beforeEach(resetBrowserState);

describe('the readiness gate (#307)', () => {
  const rows = () => within(panel('Ready for an agent?')).getAllByRole('listitem').map((li) => li.textContent ?? '');

  it('shows the verdict and its five rows on an item, with no live read until a person asks for one', async () => {
    const fixture = fixtureExecute();
    await open(item('card-payments', 'corp-jira:PAY-102'), { execute: fixture.execute });
    const box = panel('Ready for an agent?');
    expect(box.querySelector('.verdict')!.textContent).toBe('✕ Blocked');
    expect(rows().map((r) => /^.(Acceptance criteria|Description|Done state|Blockers|Scope) (Passes|Thin|Fails)/.exec(r)?.slice(1).join(' '))).toEqual([
      'Acceptance criteria Passes',
      'Description Thin',
      'Done state Passes',
      'Blockers Fails',
      'Scope Passes',
    ]);
    expect(box.textContent).toContain('Blocked by Jira PAY-101 (In Progress).');
    expect(within(box).getByRole('link', { name: /PAY-101/ }).getAttribute('href')).toBe('#/project/card-payments/item/corp-jira%3APAY-101');
    expect(fixture.calls.filter((c) => c.command === 'jira issue transitions')).toEqual([]);
  });

  it('settles the done state with one read-only live read when pressed', async () => {
    const fixture = fixtureExecute();
    await open(item('card-payments', 'corp-jira:PAY-100'), { execute: fixture.execute });
    expect(rows()[2]).toContain('no Epic in this Toil project has reached Done');
    await userEvent.click(screen.getByRole('button', { name: 'Check the workflow live' }));
    await waitFor(() => expect(rows()[2]).toContain('It can move to Done now: Done.'));
    expect(rows()[2]).toContain('Source: toil jira issue transitions');
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
    await open('#/project/card-payments/command-center', { execute: fixture.execute });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Ready to start?');
    // The Command Center is the Board tab's readiness view (#394).
    expect(within(tabs('card-payments')).getByRole('link', { name: /^Board/ }).getAttribute('aria-current')).toBe('page');
    expect(within(screen.getByRole('navigation', { name: 'Board views' })).getByRole('link', { name: 'Ready to start?' }).getAttribute('aria-current')).toBe('page');
    const tally = screen.getByRole('list', { name: 'Open items by verdict' });
    expect([...tally.querySelectorAll('.team-figure')].map((f) => f.textContent)).toEqual(['1', '3', '2']);
    const slate = panel('Start every ready item');
    expect(within(slate).getByRole('list', { name: 'Slated items' }).textContent).toContain('PAY-101');
    expect(slate.textContent).toMatch(/1 item is ready and would be slated, in the Toil project's order \(plan [0-9a-f]{8}\)\./);
    const start = within(slate).getByRole('button', { name: 'Start 1 ready item' });
    expect(start.hasAttribute('disabled')).toBe(true);
    expect(slate.textContent).toContain('This view has no AI agent assignments, so it shows the plan it would start.');
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(7);
    expect(table.textContent).toContain('Blocked by Jira PAY-102 (To Do).');
    expect(screen.getByText('Showing 6 items of 12.')).toBeTruthy();
    // No live read, and nothing beyond what the dashboard already loaded.
    expect(fixture.calls.filter((c) => c.command === 'jira issue transitions')).toEqual([]);
  });

  it('filters by verdict, status and assignee', async () => {
    await open('#/project/card-payments/command-center');
    const pick = async (label: RegExp, option: string) => {
      await userEvent.click(screen.getByRole('button', { name: label }));
      await userEvent.click(screen.getByRole('option', { name: option }));
    };
    await pick(/Verdict/, 'Blocked');
    expect(screen.getByText('Showing 2 items of 12.')).toBeTruthy();
    await pick(/Status/, 'All');
    expect(screen.getByText('Showing 8 items of 12.')).toBeTruthy();
    await pick(/Verdict/, 'Ready');
    await pick(/Assignee/, 'Unassigned');
    expect(screen.getByText('No item matches these filters.')).toBeTruthy();
  });

  it('says plainly when nothing is ready, and starts the plan it showed once #293 provides a start', async () => {
    await open('#/project/settlement/command-center');
    expect(panel('Start every ready item').textContent).toContain('No open item is ready, so nothing would be slated.');
    cleanup();
    const started: Array<{ id: string; items: string[] }> = [];
    window.location.hash = '#/project/checkout-web/command-center';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview startReady={async (plan) => (started.push(plan), "Queued.")} />);
    await screen.findByRole('heading', { level: 1, name: 'Ready to start?' });
    const slate = panel('Start every ready item');
    const shownId = /\(plan ([0-9a-f]{8})\)/.exec(slate.textContent ?? '')![1];
    expect(slate.textContent).toContain('Asks an AI agent to try a fix for each item above, as listed');
    await userEvent.click(within(slate).getByRole('button', { name: 'Start 1 ready item' }));
    expect(started).toEqual([{ id: shownId, items: ['github:imagile/payments-web#41'] }]);
    expect(await within(slate).findByText('Queued.')).toBeTruthy();
  });
});
