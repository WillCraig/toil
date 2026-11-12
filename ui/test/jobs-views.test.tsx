// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App, parseRoute } from '../src/App.tsx';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { CONFIG_CANNED, FIXTURE_CONNECTIONS, fixtureConfig } from '../src/fixtures/config.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';

/**
 * The workflow jobs where they apply (#532): Review and Ship in a pull
 * request's one Actions menu, Diagram on a Toil project's overview, each at its
 * own address and in the palette, a missing connection named instead of the
 * action vanishing, and a run that lands in the Ask pane with every write a
 * card. Nothing here writes.
 */

const jira = FIXTURE_CONNECTIONS.connections.find((c) => c.area === 'jira')!;
const onlyJira = CONFIG_CANNED.map((a) => (a.command === 'connections list' ? { ...a, data: { ...FIXTURE_CONNECTIONS, connections: [jira] } } : a));

async function open(hash: string, canned = CONFIG_CANNED) {
  window.location.hash = hash;
  const view = render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={fixtureConfig(canned)} now={FIXTURE_NOW} preview />);
  await screen.findByRole('heading', { level: 1 }, { timeout: 3000 });
  return view;
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

describe('the addresses', () => {
  it('give each job its own page, with the target after ?target=', () => {
    expect(parseRoute('#/project/card-payments/job/review?target=github%3Aimagile%2Fpayments-web%2343')).toEqual({ view: 'job', toilProject: 'card-payments', job: 'review', target: 'github:imagile/payments-web#43' });
    expect(parseRoute('#/project/card-payments/job/diagram')).toEqual({ view: 'job', toilProject: 'card-payments', job: 'map-codebase', target: null });
    expect(parseRoute('#/project/card-payments/job/ship')).toMatchObject({ job: 'ship' });
    expect(parseRoute('#/project/card-payments/job/unknown')).toEqual({ view: 'dashboard', toilProject: 'card-payments' });
  });
});

describe('Pull Requests', () => {
  it('has one Actions menu a pull request, not a button for every job on every row', async () => {
    await open('#/project/card-payments/prs');
    const triggers = await screen.findAllByRole('button', { name: /^Actions for / });
    expect(triggers.length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^Check this code change/ })).toBeNull();
    await userEvent.click(triggers[0]!);
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem').map((i) => i.textContent);
    expect(items[0]).toBe('Check this code change');
    expect(items.length).toBeLessThanOrEqual(2);
  });

  it('names the connection that would enable a job, in the menu, instead of dropping it', async () => {
    await open('#/project/card-payments/prs', onlyJira);
    const triggers = await screen.findAllByRole('button', { name: /^Actions for / });
    await userEvent.click(triggers[0]!);
    const review = await screen.findByRole('menuitem', { name: /Check this code change/ });
    expect(review.className).toContain('jobs-item--off');
    expect(review.textContent).toContain('Needs a');
    expect(review.textContent).toContain('connection. Add one in Settings, Connections.');
  });

  it('runs Review in the Ask pane on a press, with every write left as a card to review', async () => {
    await open('#/project/card-payments/prs');
    const triggers = await screen.findAllByRole('button', { name: /^Actions for / });
    // The first row whose pull request is on GitHub, which the preview's scripted review comments on.
    let found = false;
    for (const t of triggers) {
      await userEvent.click(t);
      const review = await screen.findByRole('menuitem', { name: /Check this code change/ });
      await userEvent.click(review);
      const dialog = await screen.findByRole('dialog', { name: /Ask about card-payments/ }, { timeout: 3000 });
      await waitFor(() => expect(dialog.textContent).toMatch(/Review .+#\d+/));
      await waitFor(() => expect(dialog.textContent).toContain('unchecked'), { timeout: 3000 });
      found = true;
      break;
    }
    expect(found).toBe(true);
  });
});

describe('a job page', () => {
  it('says what Diagram does, runs it from one press, and keeps the writes a step further in', async () => {
    await open('#/project/card-payments/job/diagram');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Diagram');
    expect(document.querySelector('[data-job-missing]')).toBeNull();
    const details = document.querySelector('.job-page__more') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getAllByText(/^toil /).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: /^Draw / }));
    const dialog = await screen.findByRole('dialog', { name: /Ask about card-payments/ }, { timeout: 3000 });
    await waitFor(() => expect(dialog.textContent).toContain('C4Container'), { timeout: 3000 });
  });

  it('asks which pull request when Review is opened without one, and shows Ship’s round limit', async () => {
    await open('#/project/card-payments/job/ship');
    expect(screen.getByText('Choose the pull request.')).toBeTruthy();
    expect(document.querySelector('[data-job-loop]')!.textContent).toContain('at most 3');
    expect(document.querySelector('[data-job-loop]')!.textContent).toContain('needs-human');
  });

  it('says which connection is missing, and disables Run, instead of failing at the run', async () => {
    await open('#/project/card-payments/job/review?target=github%3Aimagile%2Fpayments-web%2343', onlyJira);
    await waitFor(() => expect(document.querySelector('[data-job-missing]')).not.toBeNull());
    expect(document.querySelector('[data-job-missing]')!.textContent).toMatch(/^Needs a .* connection\. Add one in Settings, Connections\.$/);
    expect(document.querySelector<HTMLButtonElement>('[data-job-run]')!.disabled).toBe(true);
  });

  it('shows Diagram on a Toil project’s overview, as a link and not another button', async () => {
    await open('#/project/card-payments');
    const link = document.querySelector<HTMLAnchorElement>('[data-job-link="map-codebase"]')!;
    expect(link.getAttribute('href')).toBe('#/project/card-payments/job/diagram');
  });
});
