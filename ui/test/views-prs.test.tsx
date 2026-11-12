// @vitest-environment jsdom
// Code reviews are counted and aged here; the ones awaiting a second approver are marked, with some sympathy.
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { open, panel, tabs, resetBrowserState } from './views-kit.tsx';

beforeEach(resetBrowserState);

describe('the pull requests view', () => {
  it('ranks the open pull requests by wait, with what each waits on, its author kind, items and flags', async () => {
    await open('#/project/checkout-web/prs');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Code reviews');
    const rows = within(panel('Waiting now')).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual([
      expect.stringContaining('payments-web #51 Retry the address lookup once'),
      expect.stringContaining('checkout-sdk #12 Format receipt totals'),
      expect.stringContaining('payments-web #52 Saved-card picker'),
      expect.stringContaining('payments-web #53 Keep focus'),
    ]);
    expect(rows[0]!.textContent).toContain('Checks');
    // The age is a compact figure; the sentence, and what said an agent wrote it, are one step in.
    const cell = (r: HTMLElement, n: number) => within(r).getAllByRole('cell')[n]!;
    expect(cell(rows[0]!, 0).textContent).toMatch(/Checks\s*2 working days/);
    expect(within(cell(rows[0]!, 0)).getByText(/for 2 working days: its checks are failing/)).toBeTruthy();
    expect((cell(rows[0]!, 1).querySelector('details') as HTMLDetailsElement).open).toBe(false);
    expect(within(cell(rows[0]!, 1)).getByText('Agent')).toBeTruthy();
    expect(cell(rows[0]!, 1).textContent).toContain('trailer: Co-Authored-By: Claude');
    expect(rows[0]!.textContent).toContain('No work item');
    expect(cell(rows[1]!, 1).textContent).toContain('branch: branch copilot/receipt-currency');
    expect(within(cell(rows[2]!, 3)).getByRole('img').getAttribute('aria-label')).toMatch(/^325 lines changed, \d+ added and \d+ deleted, 3 files$/);
    expect(cell(rows[2]!, 3).textContent).toContain('L');
    expect(cell(rows[3]!, 0).textContent).toContain('Draft (its author)');
  });

  it('gives each row a quiet icon Actions button in its own narrow column, named for the pull request', async () => {
    await open('#/project/checkout-web/prs');
    const table = within(panel('Waiting now')).getByRole('table');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers.at(-1)).toBe('Actions');
    const buttons = within(table).getAllByRole('button', { name: /^Actions for / });
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b.closest('td')!.className).toContain('l-table__actions');
      expect(b.textContent).toBe('');
      expect(b.getAttribute('aria-label')).toMatch(/^Actions for .+ #\d+$/);
    }
  });

  it('lists the flags with their evidence, and every flow figure with its sample size, split by author kind', async () => {
    await open('#/project/checkout-web/prs');
    const flags = panel('Flags');
    // Grouped by kind, and only the first three flags show until asked for the rest.
    const groups = () => Array.from(flags.querySelectorAll('[data-flag-group] h3')).map((h) => h.textContent);
    const flagged = () => flags.querySelectorAll('[data-flag-group] li');
    expect(flagged()).toHaveLength(3);
    await userEvent.click(within(flags).getByRole('button', { name: 'Show 2 more' }));
    expect(flagged()).toHaveLength(5);
    expect(groups().map((g) => g!.replace(/\s*\d+$/, ''))).toEqual([
      'Work item done, pull request still open',
      'Merged, work item not done',
      'No first review in 2 working days',
      'Checks failing for over a day',
      'No linked work item',
    ]);
    const flow = panel('Flow');
    const pickup = within(flow).getAllByRole('row').find((r) => r.textContent!.includes('Pickup'))!;
    expect(within(pickup).getAllByRole('cell').map((c) => c.textContent)).toEqual([
      expect.stringContaining('(n=4'),
      expect.stringContaining('(n=3'),
      'AgentsNo data (n=0)',
      expect.stringContaining('(n=1)'),
    ]);
    expect(flow.textContent).toContain('1 merged pull request has no merge time on record');
  });

  it('suggests reviewers from CODEOWNERS as proposals, never applying them', async () => {
    await open('#/project/checkout-web/prs');
    const reviewers = panel('Suggested reviewers');
    expect(reviewers.textContent).toContain('imagile/payments-web: CODEOWNERS read from .github/CODEOWNERS.');
    expect(reviewers.textContent).toContain('Ask bo-web to review payments-web #51');
    expect(reviewers.textContent).toContain("toil github pr add-reviewers '51'");
  });

  it("is a tab of the Toil project's, current on its own page", async () => {
    await open('#/project/settlement/prs');
    const tab = within(tabs('settlement')).getByRole('link', { name: 'Code reviews' });
    expect(tab.getAttribute('href')).toBe('#/project/settlement/prs');
    expect(tab.getAttribute('aria-current')).toBe('page');
  });
});
