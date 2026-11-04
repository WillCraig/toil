import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { standardWords } from './words.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { fixtureConfig } from '../src/fixtures/config.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { openChat } from './chat.ts';

/**
 * The chat's "Not ticketed yet" banner (#304), on the preview's own data and
 * scripted agent: work that names no ticket gets the open items likeliest to
 * cover it, with why, and "Ticket this" offers proposals that only a person
 * applies; a question, or work that names its ticket, gets no banner.
 */

async function chat(dossier: string) {
  const fixture = fixtureExecute();
  window.location.hash = `#/dossier/${dossier}`;
  render(<App execute={fixture.execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview />);
  await screen.findByRole('heading', { level: 1 }, { timeout: 3000 });
  // The focused view the Ask bar opens (#343).
  const pane = await openChat(dossier);
  const say = async (text: string) => {
    await userEvent.type(within(pane).getByRole('textbox', { name: 'Your question' }), text);
    await userEvent.click(within(pane).getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(within(pane).getByRole('textbox', { name: 'Your question' })).not.toHaveProperty('disabled', true));
  };
  return { pane, say, calls: fixture.calls };
}

beforeEach(() => {
  localStorage.clear();
  standardWords();
});
afterEach(cleanup);

describe('the "Not ticketed yet" banner', () => {
  it('ranks the open items that cover the work, says why, and offers proposals that nothing applies', async () => {
    const { pane, say, calls } = await chat('card-payments');
    const before = calls.length;
    await say('Tokenise the card numbers at the edge of the gateway');
    const banner = await within(pane).findByRole('region', { name: 'Not ticketed yet' });
    const rows = within(banner).getAllByRole('listitem');
    expect(within(rows[0]!).getByRole('link').textContent).toBe('Jira PAY-101 Tokenise card numbers at the edge');
    expect(rows[0]!.textContent).toMatch(/\d+% alike \(title terms .*card.*\)/);
    expect(banner.textContent).toContain('(PAY-101): nothing is written');
    expect(within(banner).queryByRole('article')).toBeNull();

    await userEvent.click(within(banner).getByRole('button', { name: 'Ticket this' }));
    const cards = within(banner).getAllByRole('article', { name: /^Proposal: / });
    expect(cards[0]!.getAttribute('aria-label')).toBe('Proposal: Create a sub-task under PAY-101');
    expect(cards.at(-1)!.getAttribute('aria-label')).toBe('Proposal: Create a new ticket: Tokenise the card numbers at the edge of the gateway');
    expect(within(cards[0]!).getByText(/^toil jira issue create/).textContent).toContain("--parent 'PAY-101'");
    expect(within(cards[0]!).queryByRole('button', { name: /apply/i })).toBeNull();
    // Nothing was asked of toil to make them: the cards are the whole of it.
    expect(calls.length).toBe(before);
    const result = await axe.run(banner, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(result.violations.map((v) => v.id)).toEqual([]);

    await userEvent.click(within(banner).getByRole('button', { name: 'Hide' }));
    await userEvent.click(within(banner).getByRole('button', { name: 'Not now' }));
    expect(within(pane).queryByRole('region', { name: 'Not ticketed yet' })).toBeNull();
  }, 20_000);

  it('says there is no likely ticket when nothing matches, and offers only a new one', async () => {
    const { pane, say } = await chat('settlement');
    await say('Rotate the kubernetes ingress certificates');
    const banner = await within(pane).findByRole('region', { name: 'Not ticketed yet' });
    expect(within(banner).queryByRole('list')).toBeNull();
    expect(banner.textContent).toContain('there is no likely ticket');
    await userEvent.click(within(banner).getByRole('button', { name: 'Ticket this' }));
    const cards = within(banner).getAllByRole('article', { name: /^Proposal: / });
    expect(cards).toHaveLength(1);
    expect(within(cards[0]!).getByText(/^toil ado work-item create/).textContent).toContain("--type 'User Story'");
  }, 20_000);

  it('stays away from Analyze, which is a question about the dossier, and still catches work asked after it (#343)', async () => {
    const { pane, say } = await chat('settlement');
    await userEvent.click(within(pane).getByRole('button', { name: /^Give me the full briefing/ }));
    await within(pane).findByRole('heading', { level: 3, name: 'Analyze' });
    await waitFor(() => expect(within(pane).getByRole('textbox', { name: 'Your question' })).not.toHaveProperty('disabled', true), { timeout: 8000 });
    expect(within(pane).queryByRole('region', { name: 'Not ticketed yet' })).toBeNull();
    await say('Rotate the kubernetes ingress certificates');
    const banner = await within(pane).findByRole('region', { name: 'Not ticketed yet' });
    expect(banner.textContent).toContain('there is no likely ticket');
  }, 20_000);

  it('stays away from a question, and from work that names its ticket', async () => {
    const { pane, say } = await chat('checkout-web');
    await say('What is blocking the saved cards feature?');
    await say('Finish payments-web#42 today');
    expect(within(pane).queryByRole('region', { name: 'Not ticketed yet' })).toBeNull();
  }, 20_000);
});
