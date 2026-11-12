// @vitest-environment jsdom
// The dashboard is rendered once per fixture, since a figure only counts as reported after it has been reported twice.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { askBar, openChat } from './chat.ts';
import { item, open, panel, metric, resetBrowserState } from './views-kit.tsx';

beforeEach(resetBrowserState);

describe('a dashboard', () => {
  it.each([
    ['card-payments', ['Jira'], ['Bitbucket'], ['Jenkins'], ['OpenShift']],
    ['settlement', ['Azure DevOps'], ['Azure DevOps'], ['Azure DevOps'], ['Azure DevOps']],
    ['checkout-web', ['GitHub'], ['GitHub', 'Bitbucket'], ['GitHub'], ['OpenShift']],
  ])('%s names the tools that fed each panel', async (name, work, prs, builds, deployments) => {
    await open(`#/project/${name}/board`);
    const fed = (region: HTMLElement) => region.querySelector('.fed-by')!.textContent!;
    for (const t of work) expect(fed(panel('Sprint 42 board'))).toContain(t);
    for (const t of prs) expect(fed(panel('Stories, code reviews, builds and deployments'))).toContain(t);
    for (const t of builds) expect(fed(panel('Builds'))).toContain(t);
    for (const t of deployments) expect(fed(panel('Deployments'))).toContain(t);
    expect(document.body.textContent).not.toMatch(/The exact toil commands/);
  });

  it('shows a story with its pull request, its build and where it runs, in one row', async () => {
    await open('#/project/card-payments/board');
    const row = (name: RegExp) => screen.getAllByRole('rowheader', { name }).find((r) => r.closest('.trace'))!.closest('tr')!;
    expect(row(/PAY-105/).textContent).toContain('#298 PAY-105 Show the last four digits on receipts');
    expect(row(/PAY-105/).textContent).toContain('SUCCESS');
    expect(row(/PAY-105/).textContent).toContain('dev');
    expect(row(/PAY-101/).textContent).toContain('FAILURE');
    expect(row(/PAY-101/).textContent).toContain('Latest build failed');
    expect(row(/PAY-101/).textContent).toContain('Not deployed');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Only items with something to check' }));
    const trace = document.querySelector('.trace table') as HTMLElement;
    expect(within(trace).getAllByRole('rowheader').map((r) => r.textContent)).toEqual([expect.stringContaining('PAY-101')]);
  });

  it('lists what each environment runs and what that includes', async () => {
    await open('#/project/checkout-web/board');
    const deployments = panel('Deployments');
    const envs = within(deployments).getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(envs).toEqual(['staging', 'prod']);
    expect(deployments.textContent).toContain('2026.10.12, commit 5a7e3f1');
    expect(deployments.textContent).toContain('Includes 3 merged pull requests, for GitHub payments-web#44');
    expect(deployments.textContent).toContain('Includes 1 merged pull request, none for this sprint');
  });

  it("shows the sprint's figures and each risk's reasons", async () => {
    await open('#/project/settlement');
    const sprint = await metric(/^Points done /);
    expect(sprint.querySelector('h2')!.textContent).toBe('Sprint 42: day 7 of 9');
    expect(within(sprint).getByRole('list', { name: 'Sprint figures' }).textContent).toContain('Done1 of 16points, 2 items');
    expect(sprint.textContent).toContain('Blocked by Azure DevOps 2302');
    expect(sprint.textContent).toContain('Points totals leave out items estimated in other units: Azure DevOps 2305');
  });

  it('answers a starter question about the Toil project, streaming, with links to every item it cites', async () => {
    await open('#/project/settlement');
    const chat = await openChat('settlement');
    await userEvent.click(within(chat).getByRole('button', { name: /^Are we going to finish the sprint\?/ }));
    const answer = await within(chat).findByRole('heading', { level: 3, name: 'Are we going to finish the sprint?' });
    const pane = answer.parentElement!;
    // Who answered is the header's to say; the answer's own line is how sure it is, then one folded line with the time (#552).
    await waitFor(() => expect(pane.querySelector('details[data-answer-more] summary')!.textContent).toMatch(/^What it looked at · \d+ s/));
    expect(pane.textContent).not.toContain('Answered by');
    expect(within(pane).getAllByRole('link').map((a) => a.getAttribute('href'))).toContain(item('settlement', 'corp-ado:2305'));
    // What it rests on is under the answer, with how sure it is, and says nothing was changed (#552).
    expect(pane.textContent).toContain('How sure is this?');
    expect(pane.textContent).toContain('Suggestions only. Nothing was changed.');
    expect(within(chat).getByRole('log').getAttribute('aria-busy')).toBe('false');
    expect(within(chat).getByText('You asked:', { exact: false }).closest('.bubble')!.textContent).toBe('You asked: Are we going to finish the sprint?');
  });

  it("shows the agent's proposals as cards to review, with the command and no way to apply them", async () => {
    await open('#/project/settlement');
    const chat = await openChat('settlement');
    await userEvent.click(within(chat).getByRole('button', { name: /^Are we going to finish the sprint\?/ }));
    const card = await within(chat).findByRole('article', { name: 'Proposal: Move 2303 to Sprint 43' });
    expect(card.textContent).toContain('Proposed change, not applied');
    // jsdom has no platform, so the viewer's shell is POSIX; the toggle switches it, for every card.
    expect(within(card).getByText(/^toil ado work-item update/).textContent).toBe("toil ado work-item update '2303' --toil-project 'settlement' --field 'System.IterationPath=Payments\\Sprint 43' --allow-write");
    expect(within(card).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['About the write gate', 'Copy command', 'Dismiss']);
    await userEvent.click(within(card).getByRole('radio', { name: 'PowerShell' }));
    expect(within(card).getByRole('radio', { name: 'PowerShell' })).toHaveProperty('checked', true);
    expect(within(card).getByText(/^toil ado work-item update/).textContent).not.toContain('"');
    expect(localStorage.getItem('toil-ui.shell')).toBe('powershell');
    await userEvent.click(within(card).getByRole('button', { name: 'Dismiss' }));
    expect(within(chat).queryByRole('article', { name: /^Proposal:/ })).toBeNull();
  });

  it('answers a typed question, and says plainly when the preview has no answer for it', async () => {
    await open('#/project/checkout-web');
    // Typed into the bar and sent with Enter: the focused view opens with the question in it.
    await userEvent.type(within(askBar('checkout-web')).getByRole('textbox', { name: 'Your question' }), 'Should we cut scope?{Enter}');
    const chat = await screen.findByRole('dialog', { name: 'Ask about checkout-web' });
    await waitFor(() => expect(chat.textContent).toMatch(/answers only its starter questions/));
    expect(within(chat).getByRole('textbox', { name: 'Your question' })).toHaveProperty('value', '');
  });
});
