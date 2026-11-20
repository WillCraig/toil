// @vitest-environment jsdom
// A ticket rule is a checklist item written down once and read aloud by code, which is the only kind nobody asks to re-attest.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { settledState, type AssignmentRecord, type AssignmentsApi } from '../src/assign/model.ts';
import { resetApplied } from '../src/applied.ts';
import { fixtureAssignments } from '../src/fixtures/assignments.ts';
import { fixtureStandards } from '../src/fixtures/standards.ts';
import { item, open, panel, resetBrowserState } from './views-kit.tsx';

/**
 * Ticket rules on screen (#657): the rule rows on an item's page and Fix with
 * AI agent on a row that misses, the dialog with and without an AI agent, the
 * Command Center's Ticket rules card and the list it drills to, the
 * assignment page a fix opens (the proposal first, the command one press in),
 * and the Work mix's Categories, which views another built-in scheme without
 * saving anything.
 */

beforeEach(() => {
  resetBrowserState();
  resetApplied();
});

const go = async (hash: string) => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
};
const ruleRows = () => within(document.querySelector<HTMLElement>('[data-rule-rows]')!).getAllByRole('listitem').map((li) => li.textContent ?? '');

describe('the rule rows on an item (#657)', () => {
  it('lists each rule that applies under its own heading, and offers Fix with AI agent only where the item misses one', async () => {
    await open(item('card-payments', 'corp-jira:PAY-103'), { rules: fixtureStandards(), assignments: fixtureAssignments({ delay: 0 }) });
    await waitFor(() => expect(document.querySelector('[data-rule-rows]')).not.toBeNull());
    const box = panel('Ready for an agent?');
    expect(within(box).getByRole('heading', { name: /Ticket rules/ })).toBeTruthy();
    // The reason is toil's own words (src/core/standards), so it is matched loosely here.
    expect(ruleRows()).toEqual([expect.stringMatching(/^Acceptance criteria as Given\/When\/Then Missing: \S/)]);
    // The row's source is one press in: in the page, folded under the row's own disclosure.
    expect(document.querySelector('[data-rule-rows] details:not([open]) .field')!.textContent).toMatch(/^Source: /);
    expect(within(box).getByRole('button', { name: 'Fix with AI agent: Acceptance criteria as Given/When/Then' })).toBeTruthy();
  });

  it('shows no Fix on a rule the item meets', async () => {
    await open(item('card-payments', 'corp-jira:PAY-101'), { rules: fixtureStandards(), assignments: fixtureAssignments({ delay: 0 }) });
    await waitFor(() => expect(document.querySelector('[data-rule-rows]')).not.toBeNull());
    expect(ruleRows()[0]).toMatch(/^Acceptance criteria as Given\/When\/Then Passes/);
    expect(screen.queryByRole('button', { name: /Fix with AI agent/ })).toBeNull();
  });

  it('asks the AI agent, then opens the assignment with its one proposal and its questions', async () => {
    await open(item('card-payments', 'corp-jira:PAY-103'), { rules: fixtureStandards(), assignments: fixtureAssignments({ delay: 0 }) });
    await userEvent.click(await screen.findByRole('button', { name: /Fix with AI agent/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Fix with AI agent' });
    // The rule's own words are its (i) beside its name (#657), not a sentence in the dialog.
    expect(dialog.textContent).not.toContain('State the acceptance criteria as scenarios');
    expect(within(dialog).getByRole('button', { name: 'About Acceptance criteria as Given/When/Then' }).hasAttribute('data-rule-text')).toBe(true);
    expect(dialog.textContent).toContain("What's missing");
    expect(dialog.textContent).toContain('Nothing changes in Jira until you apply it.');
    expect(dialog.textContent).not.toMatch(/approve/i);
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Codex' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ask for a rewrite' }));
    await waitFor(() => expect(window.location.hash).toMatch(/#\/project\/card-payments\/assignment\//));
    await go(window.location.hash);
    await waitFor(() => expect(document.body.textContent).toContain('Rewrite the acceptance criteria of PAY-103 to meet "Acceptance criteria as Given/When/Then"'), { timeout: 4000 });
  });

  it('offers one Fix all on a standard with several misses, which asks for one rewrite that meets them all', async () => {
    const rules = fixtureStandards();
    const bug = (await rules.check('card-payments')).result!.items.find((i) => i.results.filter((r) => r.standard === 'bug-repro' && r.state !== 'pass').length === 3)!;
    await open(item('card-payments', bug.id), { rules, assignments: fixtureAssignments({ delay: 0 }) });
    await waitFor(() => expect(document.querySelector('[data-rule-group="bug-repro"]')).not.toBeNull());
    const group = document.querySelector<HTMLElement>('[data-rule-group="bug-repro"]')!;
    expect(within(group).getAllByRole('button', { name: /Fix/ }).map((b) => b.textContent)).toEqual([expect.stringMatching(/^Fix all 3 with AI agent/)]);
    await userEvent.click(within(group).getByRole('button', { name: /Fix all 3/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Fix with AI agent' });
    for (const name of ['Steps to reproduce', 'Expected result', 'Actual result']) expect(dialog.textContent).toContain(name);
    expect(dialog.textContent).toContain('Ticket rules');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Codex' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ask for a rewrite' }));
    await waitFor(() => expect(window.location.hash).toMatch(/#\/project\/card-payments\/assignment\//));
    await go(window.location.hash);
    await waitFor(() => expect(document.querySelector('[data-assignment-rule]')?.textContent).toBe('To meet the ticket rules Steps to reproduce, Expected result and Actual result.'));
    await waitFor(() => expect(document.body.textContent).toContain('to meet 3 ticket rules'), { timeout: 4000 });
  });

  it("leads a fix's page with what to do, and puts the change and Apply before the command", async () => {
    await open(item('card-payments', 'corp-jira:PAY-103'), { rules: fixtureStandards(), assignments: fixtureAssignments({ delay: 0 }) });
    await userEvent.click(await screen.findByRole('button', { name: /Fix with AI agent/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Fix with AI agent' });
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Codex' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ask for a rewrite' }));
    await waitFor(() => expect(window.location.hash).toMatch(/assignment\//));
    await go(window.location.hash);
    const card = await waitFor(() => screen.getByRole('article', { name: /Proposal: Rewrite the acceptance criteria of PAY-103/ }), { timeout: 4000 });
    expect(document.querySelector('[data-assignment-rule]')!.textContent).toBe('To meet the ticket rule Acceptance criteria as Given/When/Then.');
    expect(document.querySelector('[data-assignment-lead]')!.textContent).toBe('Nothing has changed yet. Review the proposal below and apply it.');
    // The run's times and figures are one press in.
    expect(document.querySelector('[data-assignment-run]:not([open])')!.textContent).toMatch(/Created .*sample figures/);
    // Under the title: the field table, by its plain name, then Apply; the command and its advice are in a closed disclosure, never in red.
    const order = [...card.querySelectorAll('h3, table, .proposal-actions, details')].map((e) => e.tagName.toLowerCase() + (e.classList.contains('proposal-actions') ? '.actions' : ''));
    expect(order).toEqual(['h3', 'table', 'div.actions', 'details']);
    expect(within(card).getByRole('rowheader').textContent).toMatch(/Acceptance criteria$/);
    expect(card.textContent).toContain('Replaces the acceptance criteria.');
    expect(within(card).getByRole('cell', { name: /Given a customer with a saved card token/ })).toBeTruthy();
    const command = card.querySelector<HTMLDetailsElement>('details[data-proposal-command]')!;
    expect(command.open).toBe(false);
    expect(command.querySelector('summary')!.textContent).toBe('Show the command');
    expect(card.querySelector('.failure')).toBeNull();
    expect(command.querySelector('[data-command-advice]')?.className ?? 'note').toBe('note');
    expect(within(card).getByRole('button', { name: /^Apply/ })).toBeTruthy();
    // The proposals lead, above the questions and what the agent said, and name the item's own tracker; the agent's paragraph isn't repeated under Apply.
    const sections = [...document.querySelectorAll('#assign-proposals, #assign-questions, #assign-report')].map((h) => h.id);
    expect(sections).toEqual(['assign-proposals', 'assign-questions', 'assign-report']);
    // The head already says nothing has changed, so the lede doesn't say it again.
    expect(document.querySelector('[data-assignment-lead]')!.textContent).toBe('Nothing has changed yet. Review the proposal below and apply it.');
    expect(document.querySelector('section.proposals > p.note')!.textContent).toMatch(/^Each change the agent proposes\. $/);
    expect(document.body.textContent).not.toContain('Nothing changes in Jira');
    expect(card.querySelector('.proposal-reason')).toBeNull();
    expect(document.querySelector('section[aria-labelledby="assign-report"]')!.textContent).toContain('so that is asked as a question.');
    // The criteria field was read and holds nothing: empty, not unknown.
    expect(within(card).getAllByRole('cell')[0]!.textContent).toMatch(/empty$/);
  });

  it('says a writes-off refusal in plain words with toil\'s own error one press in, puts Mark reviewed under the proposals, and reads Before and After once applied', async () => {
    const real = fixtureAssignments({ delay: 0 });
    // Each Apply answers as toil would: first the write gate's refusal, then a success.
    const off = 'jira issue update changes data in jira, and writes are off for connection corp-jira. To allow writes, set "writes": true on connection "corp-jira" in your toil config (or TOIL_JIRA_WRITES=true), then pass --allow-write.';
    let tries = 0;
    const patched = new Map<string, AssignmentRecord>();
    const api: AssignmentsApi = {
      ...real,
      get: async (id) => patched.get(id) ?? real.get(id),
      apply: async (id, pid) => {
        const r = structuredClone(await real.get(id));
        const p = r.proposals.find((x) => x.id === pid)!;
        Object.assign(p, tries++ === 0 ? { status: 'failed', outcome: { at: '2026-01-01T00:00:00Z', ok: false, code: 'WRITE_DISABLED', message: off } } : { status: 'applied', outcome: { at: '2026-10-13T09:15:00Z', ok: true, message: 'Applied with toil jira issue update.' } });
        // Settled as the queue settles it: every proposal applied, so the questions no longer hold it on needs you.
        if (r.state === 'needs-you') r.state = settledState(r);
        patched.set(id, r);
        return r;
      },
    };
    await open(item('card-payments', 'corp-jira:PAY-103'), { rules: fixtureStandards(), assignments: api });
    await userEvent.click(await screen.findByRole('button', { name: /Fix with AI agent/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Fix with AI agent' });
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Codex' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ask for a rewrite' }));
    await waitFor(() => expect(window.location.hash).toMatch(/assignment\//));
    await go(window.location.hash);
    const card = await waitFor(() => screen.getByRole('article', { name: /Proposal: Rewrite the acceptance criteria of PAY-103/ }), { timeout: 4000 });
    // Mark reviewed sits below the proposals, never beside the page's first step.
    const mark = screen.getByRole('button', { name: 'Mark reviewed' });
    expect(card.compareDocumentPosition(mark) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector('section[aria-labelledby="assign-questions"] p.note')?.textContent ?? 'Answer these in Jira, then ask for a new rewrite.').toBe('Answer these in Jira, then ask for a new rewrite.');

    await userEvent.click(within(card).getByRole('button', { name: /^Apply/ }));
    const said = await waitFor(() => {
      const p = card.querySelector('[data-writes-off]');
      if (!p) throw new Error('not yet');
      return p;
    });
    expect(said.textContent).toBe('Not applied. Writes to Jira are off on this computer, so nothing changed. Turn writes on for the corp-jira connection, then press Apply again.');
    const details = card.querySelector<HTMLDetailsElement>('details[data-outcome-details]')!;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')!.textContent).toBe('Details');
    expect(details.querySelector('code')!.textContent).toBe(off);
    expect(within(card).getByRole('columnheader', { name: 'Now' })).toBeTruthy();

    await userEvent.click(within(card).getByRole('button', { name: /^Apply/ }));
    await waitFor(() => expect(within(card).getByRole('columnheader', { name: 'Before' })).toBeTruthy());
    expect(within(card).getByRole('columnheader', { name: 'After' })).toBeTruthy();
    expect(card.querySelector('.assign-before, [data-diff="del"].diff-line--del')).toBeNull();
    // Round 4: the page reads as done. The chip says Applied, the card is a record with a solid border and no pre-apply note,
    // the lede says where the change went, and the outcome names the item and the time, with the way to it.
    await waitFor(() => expect(document.querySelector('.item-meta .assign-state')!.textContent).toBe('Applied'));
    expect(card.classList.contains('proposal--applied')).toBe(true);
    expect(document.querySelector('[data-proposals-lede]')!.textContent).toMatch(/^The applied change is in Jira\. $/);
    expect(document.body.textContent).not.toContain('Nothing changes in Jira');
    expect(document.querySelector('[data-assignment-lead]')).toBeNull();
    const line = card.querySelector('[data-applied-line]')!;
    expect(line.textContent).toMatch(/^Applied to Jira PAY-103 (at|on) .*09:15 UTC\./);
    const link = line.querySelector('a');
    if (link) expect(link.textContent).toMatch(/^Open in Jira/);
    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).toBeNull();
    // The header no longer says the data was read without changing anything.
    expect(document.querySelector('header .sync')!.textContent).toMatch(/1 change applied since\./);
  });

  it('says no AI agent is set up, and links to setting one up, rather than offering a button that can only fail', async () => {
    const real = fixtureAssignments({ delay: 0 });
    const none: AssignmentsApi = { ...real, list: async (p, o) => ({ ...(await real.list(p, o)), adapters: (await real.list(p, o)).adapters.map((a) => ({ ...a, problem: `${a.label} isn't signed in.` })) }) };
    await open(item('card-payments', 'corp-jira:PAY-103'), { rules: fixtureStandards(), assignments: none });
    await userEvent.click(await screen.findByRole('button', { name: /Fix with AI agent/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Fix with AI agent' });
    await waitFor(() => expect(dialog.querySelector('[data-no-agent]')).not.toBeNull());
    expect(within(dialog).getByRole('link', { name: 'Set up an AI agent' }).getAttribute('href')).toBe('#/settings/agent');
    expect(within(dialog).queryByRole('button', { name: 'Ask for a rewrite' })).toBeNull();
    // The details for whoever sets it up are a disclosure with a visible chevron.
    expect(dialog.querySelector('[data-no-agent] details > summary .disclosure-chevron')).not.toBeNull();
  });
});

describe("the Command Center's Ticket rules card (#657)", () => {
  it('says how many open items miss each rule, and each line filters the list to them', async () => {
    await open('#/project/card-payments/command-center', { rules: fixtureStandards() });
    const card = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-ticket-rules] ul');
      if (!el) throw new Error('not yet');
      return el.closest<HTMLElement>('[data-ticket-rules]')!;
    });
    const line = within(card).getByRole('link', { name: '2 of 4 stories: no Given/When/Then criteria' });
    expect(line.querySelector('strong')!.textContent).toBe('2 of 4');
    // A standard with several rules is one line, and drills to items that miss any of them.
    const repro = within(card).getByRole('link', { name: '1 of 1 bug: no steps to reproduce, expected result or actual result' });
    expect(repro.getAttribute('href')).toContain('rule=bug-repro');
    expect(repro.getAttribute('href')).not.toContain('rule=bug-repro%2F');
    await go(line.getAttribute('href')!);
    await waitFor(() => expect(document.querySelector('[data-rule-filter]')).not.toBeNull());
    expect(document.querySelector('[data-rule-filter]')!.textContent).toContain('Missing: Acceptance criteria as Given/When/Then');
    const table = screen.getByRole('table', { name: /items and their readiness/ });
    const keys = within(table).getAllByRole('rowheader').map((h) => /PAY-\d+/.exec(h.textContent ?? '')![0]);
    expect(keys.sort()).toEqual(['PAY-103', 'PAY-107']);
    // The filtered rule's line leads each item's Why not ready, and Clear takes the filter off.
    for (const row of within(table).getAllByRole('row').slice(1)) expect(row.querySelector('.why-not li')!.textContent).toMatch(/^Acceptance criteria as Given\/When\/Then:/);
    expect(within(document.querySelector<HTMLElement>('[data-rule-filter]')!).getByRole('link', { name: /^Clear/ }).getAttribute('href')).not.toContain('rule=');
  });

  it('is a dash, not read yet, until the check comes back', async () => {
    await open('#/project/card-payments/command-center');
    const card = await waitFor(() => document.querySelector<HTMLElement>('[data-ticket-rules]')!);
    expect(card.textContent).toContain('– not read yet');
  });

  it('is not there for a Toil project that names no rules', async () => {
    await open('#/project/settlement/command-center', { rules: fixtureStandards() });
    await screen.findByRole('heading', { level: 1 });
    expect(document.querySelector('[data-ticket-rules]')).toBeNull();
  });
});

describe("the Work mix's Categories (#657)", () => {
  it('views the mix by flow, in the address, says the saved categories are unchanged, and goes back to them', async () => {
    await open('#/project/sample-team/summary/mix');
    const select = await screen.findByRole('button', { name: /Categories/ });
    expect(select.textContent).toContain("Keep the lights on / Feature (your team's)");
    // It comes first, apart from the menus that cut the chart.
    expect(document.querySelector('.chart-menus > :first-child')!.classList.contains('chart-menus__lens')).toBe(true);
    await go('#/project/sample-team/summary/mix?lens=flow');
    await waitFor(() => expect(document.querySelector('[data-mix-lens="flow"]')).not.toBeNull());
    const note = document.querySelector<HTMLElement>('[data-mix-lens]')!;
    expect(note.textContent).toContain("Viewing as Feature / Defect / Risk / Debt. Your team's saved categories haven't changed.");
    expect(within(note).getByRole('link', { name: 'Back to saved' }).getAttribute('href')).not.toContain('lens=');
    expect(screen.getByRole('button', { name: /Categories/ }).textContent).toContain('Flow: Feature / Defect / Risk / Debt');
    expect(document.querySelector('[data-mix-lead]')!.textContent).toMatch(/Defect \d+%/);
  });
});
