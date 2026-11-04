import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { standardWords } from './words.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { fixtureAssignments } from '../src/fixtures/assignments.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import type { AssignmentsApi } from '../src/assign/model.ts';

/**
 * Assignments in the views (#293), on the sample's queue: the Agents sidebar
 * and its inbox, the Assign dialog, the assignment page with its proposals
 * and Apply, and each agent's assignments on the People view.
 */

async function open(hash: string, assignments: AssignmentsApi = fixtureAssignments({ delay: 1 })) {
  window.location.hash = hash;
  const view = render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview assignments={assignments} />);
  await screen.findByRole('heading', { level: 1 }, { timeout: 3000 });
  return view;
}

async function violations(container: HTMLElement) {
  const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

beforeEach(() => {
  localStorage.clear();
  standardWords();
});
afterEach(cleanup);

/** The Agents sidebar (#394): a drawer below 1200px, which jsdom always is, behind the tab row's Agents button. */
async function agents() {
  await userEvent.click(screen.getByRole('button', { name: /^Agents/ }));
  return screen.findByRole('region', { name: 'Agents' });
}

describe('the Agents sidebar', () => {
  it('shows the inbox, waiting for Start, and every assignment by what it waits on, with its state, mode and adapter', async () => {
    await open('#/dossier/card-payments');
    // The count arrives with the assignments, a tick after the heading; on a loaded runner, later still.
    // The inbox row, one proposal, one question and the failed assignment: a failure counts, since the panel starts closed.
    expect(await screen.findByRole('button', { name: 'Agents, 4 waiting on you' })).toBeTruthy();
    const lane = await agents();
    const inbox = await within(lane).findByRole('region', { name: 'Agent inbox' });
    // The raw label is the item's detail (the Start dialog), not the inbox row.
    expect(inbox.textContent).not.toContain('agent:refine');
    expect(within(inbox).getByRole('button', { name: /^Start/ })).toBeTruthy();
    expect(within(lane).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Agent inbox', 'Needs you 1', 'Working 1', 'Stale 1', 'Recent analyses']);
    expect([...lane.querySelectorAll('.agent-card .assign-state')].map((c) => c.textContent)).toEqual(['Needs you', 'Working', 'Failed', 'Done']);
    expect(lane.querySelector('details.agents-group--earlier summary')!.textContent).toBe('Earlier (1)');
    // The limits sentence is in the (i) beside the heading.
    await userEvent.click(within(lane).getAllByRole('button', { name: /^About assigning work/ })[0]!);
    expect((await screen.findAllByText(/2 run at a time, for up to 20 minutes each/)).length).toBeGreaterThan(0);
  }, 20_000);

  it('assigns from a board card, through the dialog, onto the assignment page', async () => {
    await open('#/dossier/card-payments/board');
    const user = userEvent.setup();
    fireEvent.contextMenu(screen.getByRole('group', { name: 'PAY-103 Charge a stored token' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Assign to an agent…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Assign to an agent' });
    await within(dialog).findByRole('radiogroup', { name: 'Adapter' });
    await user.click(within(dialog).getByRole('radio', { name: /Investigate/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/dossier\/card-payments\/assignment\/sample-new-/));
  }, 20_000);
});

describe('the assignment page', () => {
  it('shows the report, the question and each proposal with its diff and Apply, with no axe violations', async () => {
    const { container } = await open('#/dossier/card-payments/assignment/sample-needsyou-0002');
    await screen.findByRole('heading', { name: 'Proposals' });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Refine: Store tokens in the vault');
    expect(screen.getByText(/Which vault holds the tokens in staging/)).toBeTruthy();
    const card = screen.getByRole('article', { name: /Add acceptance criteria to PAY-102/ });
    expect(within(card).getByRole('region', { name: /What Add acceptance criteria to PAY-102 changes/ })).toBeTruthy();
    expect(await violations(container)).toEqual([]);
    const user = userEvent.setup();
    await user.click(within(card).getByRole('button', { name: /^Apply/ }));
    // The sample has no tracker, and says so on the card.
    await within(screen.getByRole('article', { name: /Add acceptance criteria to PAY-102/ })).findByText(/This is sample data/);
  }, 20_000);

  it('says why a failed run stopped, and keeps its transcript', async () => {
    await open('#/dossier/card-payments/assignment/sample-failed-0000004');
    await screen.findByText(/Stopped at the time limit of 20 minutes/, { selector: 'p[role="note"]' });
    expect(screen.getByText(/Transcript \(4 lines\)/)).toBeTruthy();
  }, 20_000);
});

describe('the People view', () => {
  it("lists each agent's assignments as a teammate's", async () => {
    await open('#/dossier/card-payments/people');
    const section = await screen.findByRole('region', { name: "Agents' assignments" });
    await within(section).findByRole('heading', { name: 'Codex' });
    expect(within(section).getByRole('heading', { name: 'Claude' })).toBeTruthy();
  }, 20_000);
});

describe("the Command Center's start (#307)", () => {
  it('queues an implement assignment for each ready item, and says so', async () => {
    const api = fixtureAssignments({ delay: 1 });
    await open('#/dossier/card-payments/command-center', api);
    const slate = screen.getByRole('region', { name: 'Start every ready item' });
    await userEvent.setup().click(within(slate).getByRole('button', { name: /^Start 1 ready item/ }));
    await within(slate).findByText(/^Queued one implement assignment on Codex\. They run 2 at a time/);
    const list = await api.list('card-payments');
    expect(list.assignments.filter((a) => a.mode === 'implement' && a.item === 'corp-jira:PAY-101' && a.state !== 'failed')).toHaveLength(1);
  }, 20_000);

  it('starts nothing, and says why, where no repository has a local path', async () => {
    const api = fixtureAssignments({ delay: 1 });
    const { startReadyWith } = await import('../src/assign/start.ts');
    await expect(startReadyWith(api, 'checkout-web')({ id: 'x', items: ['github:imagile/payments-web#41'] })).rejects.toThrow(/lists no repository with a local path.*Nothing was started/);
    expect((await api.list('checkout-web')).assignments).toEqual([]);
  });

  it('names the items it queued beside one it could not', async () => {
    const api = fixtureAssignments({ delay: 1 });
    const { startReadyWith } = await import('../src/assign/start.ts');
    const flaky = { ...api, assign: async (r: Parameters<typeof api.assign>[0]) => (r.item === 'corp-jira:PAY-103' ? Promise.reject(new Error('That item left the cache.')) : api.assign(r)) };
    await expect(startReadyWith(flaky, 'card-payments')({ id: 'x', items: ['corp-jira:PAY-102', 'corp-jira:PAY-103'] })).rejects.toThrow("Queued one implement assignment on Codex. One item couldn't be queued: corp-jira:PAY-103: That item left the cache.");
    expect((await api.list('card-payments')).assignments.filter((a) => a.item === 'corp-jira:PAY-102' && a.mode === 'implement')).toHaveLength(1);
  });
});

describe('stale sessions (#305)', () => {
  it('badges the stale assignments, and Renew all stale lists them first, renewing only the idle ones', async () => {
    const { container } = await open('#/dossier/card-payments');
    const lane = await agents();
    const cards = [...lane.querySelectorAll<HTMLElement>('.agent-card')];
    expect(cards.map((c) => (c.querySelector('[data-stale]') ? c.querySelector('.assign-state')!.textContent : null)).filter(Boolean)).toEqual(['Needs you', 'Failed']);
    expect(lane.textContent).toContain('started on toil 0.1.0-alpha.3 · now alpha.4 · skills changed: jira.');
    const user = userEvent.setup();
    await user.click(within(lane).getByRole('button', { name: 'Renew all stale…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Renew stale sessions' });
    const rows = within(dialog).getAllByRole('listitem').map((li) => li.textContent);
    expect(rows).toEqual([expect.stringMatching(/^Skipped: Refine corp-jira:PAY-102 on Codex, needs you: .* It is waiting on you/), expect.stringMatching(/^Renews: Implement corp-jira:PAY-101 on Codex, failed: started on toil/)]);
    expect(await violations(container.ownerDocument.body)).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Renew 1' }));
    const said = await within(dialog).findByRole('status', { name: 'What was renewed' });
    expect(said.textContent).toMatch(/^Renewed: Implement corp-jira:PAY-101/);
    await waitFor(() => expect(within(lane).getAllByText(/Renewed as/).length).toBe(1));
  }, 20_000);

  it("offers Renew on a stale failed assignment's page, and says why a needs-you one waits", async () => {
    await open('#/dossier/card-payments/assignment/sample-needsyou-0002');
    await screen.findByText(/It is waiting on you: review its proposals/);
    expect(screen.queryByRole('button', { name: 'Renew' })).toBeNull();
    cleanup();
    await open('#/dossier/card-payments/assignment/sample-failed-0000004');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Renew' }));
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/dossier\/card-payments\/assignment\/sample-new-/));
  }, 20_000);

  it("says on an agent's card how many of its assignments are stale", async () => {
    await open('#/dossier/card-payments/people');
    const section = await screen.findByRole('region', { name: "Agents' assignments" });
    await within(section).findByText(/2 started on instructions that have changed since/);
  }, 20_000);
});

describe("a stale chat (#305)", () => {
  it('says so in the focused view with the reason, renews from the strip, and logs where it happened', async () => {
    const scripted = scriptedAgent();
    const stale = { startedAt: FIXTURE_NOW, stale: { reasons: ['prompts changed'], text: 'prompts changed since it started' }, renewals: 0 };
    const renewed: string[] = [];
    const agent = {
      ...scripted,
      stream: undefined,
      ask: async (...args: Parameters<typeof scripted.ask>) => ({ ...(await scripted.ask(...args)), session: stale }),
      session: async () => stale,
      renew: async (chat: string) => (renewed.push(chat), { startedAt: FIXTURE_NOW, stale: null, renewals: 1 }),
    };
    window.location.hash = '#/dossier/card-payments';
    render(<App execute={fixtureExecute().execute} agent={agent} now={FIXTURE_NOW} preview />);
    await screen.findByRole('heading', { level: 1 }, { timeout: 3000 });
    const user = userEvent.setup();
    await user.click(screen.getByRole('textbox', { name: 'Your question' }));
    const chat = await screen.findByRole('dialog', { name: 'Ask about card-payments' });
    await user.click(within(chat).getByRole('button', { name: /^Give me the full briefing/ }));
    await within(chat).findByText('prompts changed since it started.');
    await user.click(within(chat).getByRole('button', { name: 'Renew' }));
    await within(chat).findByText(/^Renewed on today's instructions\./);
    expect(renewed).toHaveLength(1);
    expect(within(chat).queryByText('prompts changed since it started.')).toBeNull();
    expect(within(chat).queryByRole('button', { name: 'Renew' })).toBeNull();
  }, 20_000);
});
