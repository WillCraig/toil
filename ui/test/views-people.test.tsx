// @vitest-environment jsdom
// People appear here as names on a card, a courtesy their calendars have rarely extended to this page.
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ConfigApi } from '../src/config.ts';
import { fixtureConfig } from '../src/fixtures/config.ts';
import { open, panel, tabs, resetBrowserState } from './views-kit.tsx';

beforeEach(resetBrowserState);

describe('the people view (#292)', () => {
  /** The preview's config with changes on, recording what each change sent. */
  function recording() {
    const base = fixtureConfig();
    const sent: Array<{ command: string; input: Record<string, unknown> }> = [];
    const config: ConfigApi = {
      ...base,
      disabled: null,
      run: async (command, input) => {
        sent.push({ command, input });
        return { ok: true, data: {}, error: null, meta: { command, durationMs: 0, version: 'x', contractVersion: 1 } };
      },
    };
    return { config, sent };
  }
  const cards = (section: string) => within(screen.getByRole('heading', { level: 2, name: section }).closest('section') as HTMLElement).getAllByRole('article');

  it('has a card per person in name order, agents included and tagged, and a team strip, and is in the navigation', async () => {
    await open('#/project/checkout-web/people');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('People');
    expect(within(tabs('checkout-web')).getByRole('link', { name: 'People' }).getAttribute('aria-current')).toBe('page');
    expect(cards('People and agents').map((c) => within(c).getByRole('heading', { level: 3 }).textContent)).toEqual(['Ada D.', 'Bo W.', 'Claude']);
    const claude = screen.getByRole('article', { name: 'Claude' });
    expect(within(claude).getByRole('list', { name: 'About Claude' }).textContent).toBe('Agent');
    expect(claude.textContent).toContain('payments-web #51 Retry the address lookup once');
    const ada = screen.getByRole('article', { name: 'Ada D.' });
    expect(ada.textContent).toContain('GitHub ada-dev · Bitbucket 557058:abc12345-0000-0000-0000-000000000020 (Ada D.)');
    expect(ada.textContent).toContain('written with Claude');
    expect(within(ada).getByRole('heading', { name: 'Reviews waiting on them' }).nextElementSibling!.textContent).toContain('checkout-sdk #12');
    const team = panel('Team');
    expect(team.textContent).toContain('Limit 2 per person. Nobody is over it.');
    expect(team.textContent).toContain('Longest: Bitbucket checkout-sdk #12, 1.3 working days.');
    expect(within(team).getByRole('list', { name: 'Unassigned in Sprint 42' }).textContent).toContain('payments-web#45');
    expect(cards("Not in the Toil project's people").map((c) => within(c).getByRole('heading', { level: 3 }).textContent)).toEqual(['Bo W.']);
    expect(document.body.textContent).toContain('1 pull request was written with an agent the Toil project\'s people don\'t name (branch copilot/receipt-currency).');
    // Load, never a score.
    expect(document.querySelector('main')!.textContent).not.toMatch(/\b(score|rank(ed|ing)?|leaderboard|productivity)\b/i);
  });

  it('suggests a match by email with the command that applies it, turned off in the preview', async () => {
    await open('#/project/card-payments/people');
    const matches = panel('Possible matches');
    expect(matches.textContent).toContain("Bitbucket achen (A. Chen) has A. Chen's email (you@example.com): probably A. Chen.");
    expect(matches.textContent).not.toContain('Applies ');
    expect(matches.textContent).not.toContain('toil projects person');
    const button = within(matches).getByRole('button', { name: 'Map to A. Chen' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(matches.textContent).toContain('Turned off: This is the preview');
    expect(document.body.textContent).toContain('1 bot account (svc-renovate) only wrote bots\' pull requests and is left out.');
  });

  it('applies a match only when a person presses it, through toil projects person', async () => {
    const { config, sent } = recording();
    await open('#/project/card-payments/people', { config });
    expect(sent).toEqual([]);
    await userEvent.click(within(panel('Possible matches')).getByRole('button', { name: 'Map to A. Chen' }));
    expect(await within(panel('Possible matches')).findByText("Mapped in card-payments's people. Reload the Toil project to see the cards change.")).toBeTruthy();
    expect(sent).toEqual([{ command: 'projects person', input: { toilProject: 'card-payments', name: 'A. Chen', id: ['bitbucket=achen'] } }]);
  });

  it('maps an unmapped account from its card: a form for the sources the Toil project uses, turned off in the preview', async () => {
    await open('#/project/checkout-web/people');
    const bo = cards("Not in the Toil project's people")[0]!;
    expect(within(bo).queryByRole('group', { name: 'Identities in each system' })).toBeNull();
    await userEvent.click(within(bo).getByRole('button', { name: /^Map/ }));
    const ids = within(bo).getByRole('group', { name: 'Identities in each system' });
    // Only the systems this Toil project reads or names people in get a field.
    expect(within(ids).getAllByRole('textbox').length).toBeGreaterThan(0);
    expect(ids.textContent).not.toContain('Azure DevOps');
    expect(within(bo).getByRole('button', { name: /^(Add them|Map to )/ }).hasAttribute('disabled')).toBe(true);
    expect(bo.textContent).toContain('Turned off: This is the preview');
    expect(bo.textContent).not.toMatch(/Runs |toil projects person/);
  });

  it('maps through toil projects person when pressed, then saves the people to the repository with toil projects people save', async () => {
    const { config, sent } = recording();
    await open('#/project/checkout-web/people', { config });
    const bo = cards("Not in the Toil project's people")[0]!;
    await userEvent.click(within(bo).getByRole('button', { name: /^Map/ }));
    expect(sent).toEqual([]);
    await userEvent.selectOptions(within(bo).getByLabelText('This account is'), 'A new person or AI agent');
    await userEvent.click(within(bo).getByRole('button', { name: 'Add them' }));
    expect(await within(bo).findByText(/is mapped to Bo W\. in checkout-web's people\./)).toBeTruthy();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ command: 'projects person', input: { toilProject: 'checkout-web', name: 'Bo W.', id: [expect.stringMatching(/^(github|bitbucket|jira|ado)=/)] } });
    await userEvent.click(within(bo).getByRole('button', { name: 'Save to this repository' }));
    expect(await within(bo).findByText(/Nothing was committed/)).toBeTruthy();
    expect(sent[1]).toEqual({ command: 'projects people save', input: { toilProject: 'checkout-web' } });
  });

  it('offers Save to this repository beside the people, behind a disclosure that says which file changes', async () => {
    await open('#/project/checkout-web/people');
    const section = screen.getByRole('heading', { level: 2, name: 'People and agents' }).closest('section') as HTMLElement;
    expect((within(section).getByRole('button', { name: 'Save to this repository' }) as HTMLButtonElement).disabled).toBe(true);
    expect(section.textContent).not.toContain('.toil/projects');
    expect(section.textContent).toContain('Nothing is committed for you.');
  });

  it('gives every account its own card when the Toil project lists nobody, and says how to map them', async () => {
    await open('#/project/settlement/people');
    expect(screen.queryByRole('heading', { level: 2, name: 'People and agents' })).toBeNull();
    expect(cards("Accounts in this Toil project's data").map((c) => within(c).getByRole('heading', { level: 3 }).textContent)).toEqual(['D. Okafor', 'J. Park', 'K. Nakamura', 'M. Lind']);
    expect(document.body.textContent).toContain('in Settings, Toil projects.');
    expect(document.body.textContent).not.toContain('toil projects person');
    expect(panel('Team').textContent).toContain('No limit is set in the Toil project.');
  });

  it("opens a person's items on the board, filtered to them, with the way back", async () => {
    await open('#/project/card-payments/people');
    const link = within(screen.getByRole('article', { name: 'J. Smith' })).getByRole('link', { name: "J. Smith's items on the board" });
    expect(link.getAttribute('href')).toBe('#/project/card-payments/board/person%3AJ.%20Smith');
    cleanup();
    await open('#/project/card-payments/board/person%3AJ.%20Smith');
    const filter = document.getElementById('board-filter')!;
    expect(filter.textContent).toMatch(/^Showing J\. Smith's items: \d+ items? on this board/);
    const board = panel('Sprint 42 board');
    const shown = within(board).getAllByRole('listitem').filter((li) => li.classList.contains('card'));
    expect(shown.length).toBeGreaterThan(0);
    for (const card of shown) expect(card.textContent).toContain('J. Smith');
    expect(within(filter).getByRole('link', { name: "Show everyone's" }).getAttribute('href')).toBe('#/project/card-payments/board');
  });

  it('says so when a board link names nobody', async () => {
    await open('#/project/card-payments/board/person%3ANobody');
    expect(document.getElementById('board-filter')!.textContent).toContain("The People view's link named nobody this Toil project's data shows");
  });

  it('shows the people and the limit on the settings page, with forms to add a person and set the limit', async () => {
    await open('#/settings/projects');
    const card = await screen.findByRole('article', { name: 'card-payments' });
    await userEvent.click(within(card).getByRole('button', { name: /^Menu for / }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Show details' }));
    await waitFor(() => expect(card.textContent).toContain('J. Smith jira jsmith, bitbucket jsmith'));
    expect(card.textContent).toContain('Work-in-progress limit: 2 per person.');
    window.location.hash = '#/settings/projects/card-payments/people';
    await screen.findByRole('heading', { level: 2, name: 'Edit card-payments' });
    const person = screen.getByRole('form', { name: /Add a person to/ });
    expect(person.textContent).not.toContain('--remove');
    expect(person.textContent).not.toContain('toil projects');
    await userEvent.click(screen.getByText('Work in progress limit'));
    expect((await screen.findByRole('form', { name: /work-in-progress limit/ })).textContent).not.toContain('toil projects wip-limit');
  });
});
