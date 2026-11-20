// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App, parseRoute } from '../src/App.tsx';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { CONFIG_CANNED, FIXTURE_CONNECTIONS, fixtureConfig } from '../src/fixtures/config.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { FACE } from '../src/model/jobs.ts';

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
  await waitFor(() => expect(document.querySelector('h1, [data-tab-panel]')).toBeTruthy(), { timeout: 3000 });
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
    // One short line on the face; the rest is in the (i).
    const lede = document.querySelector('.job-page .lede')!;
    expect(lede.textContent).toContain(FACE['map-codebase'].short);
    expect(lede.textContent).not.toContain(FACE['map-codebase'].gist);
    expect(document.querySelector('.job-page')!.textContent).not.toContain('reported as unchecked');
    await userEvent.click(lede.querySelector('[data-help="jobs"]')!);
    const info = await screen.findByRole('dialog', { name: /About jobs/ });
    expect(info.textContent).toContain(FACE['map-codebase'].gist);
    await userEvent.keyboard('{Escape}');
    const details = document.querySelector('.job-page__more') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getAllByText(/^toil /).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: /^Draw / }));
    const dialog = await screen.findByRole('dialog', { name: /Ask about card-payments/ }, { timeout: 3000 });
    // The answer ends in a card to Save, not in Mermaid (#582); in the sample, which changes nothing, it says so.
    await waitFor(() => expect(dialog.querySelector('[data-diagram-card]')).not.toBeNull(), { timeout: 3000 });
    expect(dialog.textContent).not.toMatch(/C4Container|```/);
    expect(dialog.querySelector('[data-diagram-off]')!.textContent).toContain('on sample data');
    expect(dialog.querySelector('[data-diagram-save]')).toBeNull();
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
    expect(document.querySelector('[data-job-missing]')!.textContent).toMatch(/^Needs a .* connection\. Add one in Settings, Connections$/);
    expect(document.querySelector<HTMLButtonElement>('[data-job-run]')!.disabled).toBe(true);
  });

  it('shows Diagram in the project’s one More menu, beside Edit: the picture when one is kept', async () => {
    await open('#/project/card-payments');
    await userEvent.click(await screen.findByRole('button', { name: 'More for card-payments' }));
    const menu = await screen.findByRole('menu');
    await waitFor(() => expect(menu.querySelector('[data-diagram-link]')).not.toBeNull());
    expect(menu.querySelector('[data-diagram-link]')!.getAttribute('href')).toBe('#/project/card-payments/summary/diagram');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['See its architecture', 'Edit card-payments']);
  });
});
