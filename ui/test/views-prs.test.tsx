// @vitest-environment jsdom
// Code reviews are counted and aged here; the ones awaiting a second approver are marked, with some sympathy.
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { open, panel, tabs, resetBrowserState } from './views-kit.tsx';
import { Flow } from '../src/views/PullRequests.tsx';
import { prMetrics } from '../src/model/prs.ts';

beforeEach(resetBrowserState);

describe('the pull requests view', () => {
  it("keeps each panel's explanation behind its (i), and what qualifies a figure on the page", async () => {
    await open('#/project/checkout-web/prs');
    const text = document.body.textContent!;
    for (const sentence of ['Drafts come last', 'A first review waiting over', 'For open pull requests with nobody asked', "unknown counts those whose record can't say"]) expect(text).not.toContain(sentence);
    expect(panel('Flow').textContent).toMatch(/\d+ weeks from .*\. n is how many pull requests a figure rests on\./);
    await userEvent.click(within(panel('Waiting now')).getByRole('button', { name: 'About the waiting list' }));
    expect((await screen.findByRole('dialog', { name: 'About the waiting list' })).textContent).toContain('working days, Monday to Friday UTC');
  });

  it('ranks the open pull requests by wait, with what each waits on, its author kind, items and flags', async () => {
    await open('#/project/checkout-web/prs');
    expect(document.querySelector('[data-tab-panel] h1')).toBeNull();
    expect(screen.getByText(/open across/)).toBeTruthy();
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

  it('keeps the flags in the queue, the merged ones one press in, and every flow figure with its sample size, split by author kind', async () => {
    await open('#/project/checkout-web/prs');
    // No Flags panel (#657): an open one's flags are its row's Flags column, and only merged or closed ones' are listed apart, one press in.
    expect(screen.queryByRole('region', { name: 'Flags' })).toBeNull();
    const queue = panel('Waiting now');
    expect(queue.querySelector('.flags')).not.toBeNull();
    const closed = queue.querySelector<HTMLDetailsElement>('[data-closed-flags]')!;
    expect(closed.open).toBe(false);
    expect(closed.textContent).toMatch(/Merged, work item not done/);
    const flow = panel('Flow');
    const pickup = within(flow).getAllByRole('row').find((r) => r.textContent!.includes('Pickup'))!;
    expect(within(pickup).getAllByRole('cell').map((c) => c.textContent)).toEqual([
      expect.stringContaining('n=4'),
      expect.stringContaining('n=3'),
      'AgentsNo datan=0',
      expect.stringContaining('n=1'),
    ]);
    expect(flow.textContent).toContain('1 merged pull request has no merge time on record');
  });

  it('suggests reviewers from CODEOWNERS as proposals, never applying them', async () => {
    await open('#/project/checkout-web/prs');
    const reviewers = panel('Suggested reviewers');
    // No file path on the page (#657).
    expect(reviewers.textContent).not.toContain('.github/CODEOWNERS');
    expect(reviewers.textContent).toContain('Ask Bo W. (bo-web) to review payments-web #51');
    expect(reviewers.textContent).toContain("toil github pr add-reviewers '51'");
  });

  it('names an author kind with nothing in the period once, never as a column of "No data" (#657)', async () => {
    await open('#/project/settlement/prs');
    const flow = panel('Flow');
    expect(flow.textContent).toContain('None by bots in this period.');
    const metrics = flow.querySelector('.pr-metrics')!;
    expect(within(metrics as HTMLElement).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Median', 'All', 'People', 'Agents']);
    expect(flow.querySelector('.pr-spark svg')).not.toBeNull();
  });

  it('collapses an empty Flow to one line that says whether nothing was read or nothing happened (#657, principle 12)', () => {
    const m = prMetrics([], '2026-10-19T12:00:00Z');
    const unread = render(<Flow m={m} read={false} />);
    expect(unread.container.textContent).toBe('– No pull requests read yet, so there is no flow to measure.');
    expect(unread.container.querySelector('table, svg')).toBeNull();
    unread.unmount();
    const zero = render(<Flow m={m} read />);
    expect(zero.container.textContent).toMatch(/^No pull requests opened or merged in the \d+ weeks from .*, so there is no flow to measure\.$/);
  });

  it('gathers the pull requests with no one to suggest into one line', async () => {
    await open('#/project/checkout-web/prs');
    const lines = panel('Suggested reviewers').querySelectorAll('[data-no-suggestion]');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.textContent).toBe('No one to suggest for GitHub payments-web #53 (opens in a new tab): no CODEOWNERS rule and no earlier review covers its paths.');
    expect(panel('Suggested reviewers').textContent!.match(/No one to suggest/g)).toHaveLength(1);
  });

  it('is a drill-in from the Summary, with its own address and a Back to Summary (#657)', async () => {
    await open('#/project/settlement/prs');
    expect(within(tabs('settlement')).getByRole('link', { name: 'Summary' }).getAttribute('aria-current')).toBe('page');
    expect(document.querySelector('[data-back]')!.getAttribute('href')).toBe('#/project/settlement');
  });
});
