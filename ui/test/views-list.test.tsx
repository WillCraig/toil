// @vitest-environment jsdom
// The list views are checked row by row, since a spreadsheet of record is only as good as its last unreviewed row.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { CANNED, FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import type { Envelope } from '../src/toil.ts';
import type { ConfigApi } from '../src/config.ts';
import { open, resetBrowserState } from './views-kit.tsx';

beforeEach(resetBrowserState);

describe('the Toil project list', () => {
  /** The cards once every one has read its toil project. */
  const cards = async () => {
    await waitFor(() => expect(document.querySelectorAll('.count-strip')).toHaveLength(3), { timeout: 8000 });
    return screen.getAllByRole('article');
  };
  const badges = (card: HTMLElement) => within(within(card).getByRole('list', { name: 'Sources' })).getAllByRole('listitem').map((li) => li.firstChild?.textContent);

  it('lists three Toil projects, each mixing its own sources as badges, with a link to its dashboard; the one with most in motion leads', async () => {
    await open('#/');
    const all = await cards();
    expect(all.map((c) => within(c).getByRole('heading').textContent)).toEqual(['card-payments', 'settlement', 'checkout-web']);
    expect(all[0]!.className).toContain('toil-project-card--lead');
    expect(badges(all[0]!)).toEqual(['Bitbucket', 'Jenkins', 'Jira', 'OpenShift']);
    expect(badges(all[1]!)).toEqual(['Azure DevOps']);
    expect(badges(all[2]!)).toEqual(['Bitbucket', 'GitHub', 'OpenShift']);
    expect(within(all[2]!).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual(['#/project/checkout-web']);
  });

  it("previews each Toil project's sprint, counts and people from the data its dashboard reads", async () => {
    await open('#/');
    const [pay, settle, web] = await cards();
    expect(pay!.textContent).toContain('Sprint 42 3 working days left of 10, 3 of 21 points done');
    expect(within(pay!).getByRole('img', { name: 'Burn-up: 3 of 21 points done' })).toBeTruthy();
    expect(within(pay!).getByRole('list', { name: 'Counts' }).textContent).toBe('3 in progress2 blocked1 code review waiting');
    expect(within(settle!).getByRole('list', { name: 'Counts' }).textContent).toBe('3 in progress1 blocked0 code reviews waiting');
    expect(within(web!).getByRole('list', { name: 'Counts' }).textContent).toBe('2 in progress0 blocked2 code reviews waiting');
    expect(within(pay!).getByRole('list', { name: /^People: / }).getAttribute('aria-label')).toContain('J. Smith');
    expect(within(pay!).getByRole('img', { name: 'J. Smith' })).toBeTruthy();
    // The preview syncs nothing, and this browser has never opened a dashboard.
    expect(pay!.textContent).toContain('Sample data.');
    expect(pay!.textContent).not.toContain('since you last looked');
  });

  it('leads with the Toil project opened most recently, and counts what changed since', async () => {
    localStorage.setItem('toil-ui:looked', JSON.stringify({ 'checkout-web': '2026-10-12T00:00:00Z', settlement: '2026-10-01T00:00:00Z' }));
    await open('#/');
    const all = await cards();
    expect(within(all[0]!).getByRole('heading').textContent).toBe('checkout-web');
    expect(all[0]!.className).toContain('toil-project-card--lead');
    expect(all[0]!.textContent).toContain('3 changes since you last looked.');
  });

  it('remembers when a dashboard was opened, for its card', async () => {
    await open('#/project/settlement');
    await waitFor(() => expect(JSON.parse(localStorage.getItem('toil-ui:looked') ?? '{}')).toHaveProperty('settlement'));
  });

  it('says when each Toil project was synced, where the server syncs', async () => {
    window.location.hash = '#/';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview={false} synced={{ settlement: { at: '2026-10-13T07:00:00Z', status: 'partial' } }} />);
    const all = await cards();
    expect(all.find((c) => within(c).getByRole('heading').textContent?.startsWith('settlement'))!.textContent).toContain('Updated 13 Oct 2026, 07:00 UTC, some sources failed.');
    expect(all.find((c) => within(c).getByRole('heading').textContent?.startsWith('checkout-web'))!.textContent).toContain('Not updated yet.');
  });

  it('shows a dash, not 0, for a Toil project that has never synced, and real zeros once it has (principle 12)', async () => {
    window.location.hash = '#/';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview={false} synced={{ settlement: { at: '2026-10-13T07:00:00Z', status: 'ok' } }} />);
    const all = await cards();
    const never = all.find((c) => within(c).getByRole('heading').textContent?.startsWith('checkout-web'))!;
    expect(within(never).getAllByText('–')).toHaveLength(3);
    expect(never.textContent).not.toContain('No sprint running.');
    expect(never.textContent).not.toMatch(/since you last looked/);
    const done = all.find((c) => within(c).getByRole('heading').textContent?.startsWith('settlement'))!;
    expect(within(done).queryByText('–')).toBeNull();
  });

  it('says which tools fed it, in plain words and with no command names', async () => {
    await open('#/project/card-payments/board');
    await waitFor(() => expect(document.querySelector('.fed-by')).not.toBeNull(), { timeout: 3000 });
    const fed = document.querySelector('.fed-by')!;
    expect(fed.querySelector('summary')!.textContent).toMatch(/^From /);
    expect(fed.textContent).not.toMatch(/toil projects|execute[(]/);
  });
});

describe("editing a Toil project's name and description in place (#342)", () => {
  type Run = { command: string; input: Record<string, unknown> };
  /** A config path that may change things, answering each describe with `answer`. */
  function editable(answer: (input: Record<string, unknown>) => Envelope): ConfigApi & { runs: Run[] } {
    const runs: Run[] = [];
    return {
      runs,
      disabled: null,
      areas: async () => [],
      settings: async () => ({ timeout: { variable: 'TOIL_TIMEOUT_MS', value: null, effectiveMs: 120_000, defaultMs: 120_000 } }),
      run: async (command, input) => {
        runs.push({ command, input });
        return answer(input);
      },
    };
  }
  const meta = { command: 'projects describe', durationMs: 1, version: '0.0.0', contractVersion: 1 };
  const okEnvelope = (data: Record<string, unknown>) => ({ ok: true, data, error: null, meta }) as unknown as Envelope;

  it('has no pencil where changes are off (the preview)', async () => {
    await open('#/');
    expect(screen.queryByRole('button', { name: /^Rename / })).toBeNull();
  });

  // The project page's header has one Edit link to the edit page; renaming and describing live in each card's menu on the home page.
  async function fromCard(name: string, item: string, config: ConfigApi) {
    const user = userEvent.setup();
    await open('#/', { config });
    await user.click(await screen.findByRole('button', { name: `Menu for ${name}` }));
    await user.click(await screen.findByRole('menuitem', { name: item }));
    return user;
  }

  it('saves the name and description together with one Save, and Cancel leaves it alone', async () => {
    const config = editable((input) => okEnvelope({ name: (input.name as string | undefined) ?? input.toilProject, description: input.description, renamed: null, changed: true }));
    const user = await fromCard('settlement', 'Edit', config);
    const form = screen.getByRole('form', { name: 'Edit settlement' });
    await user.clear(within(form).getByRole('textbox', { name: 'Description' }));
    await user.type(within(form).getByRole('textbox', { name: 'Description' }), 'Nightly settlement');
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(config.runs).toEqual([]);
    expect(screen.queryByRole('form', { name: 'Edit settlement' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Menu for settlement' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const again = screen.getByRole('form', { name: 'Edit settlement' });
    await user.clear(within(again).getByRole('textbox', { name: 'Description' }));
    await user.type(within(again).getByRole('textbox', { name: 'Description' }), 'Nightly settlement');
    await user.click(within(again).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(config.runs).toEqual([{ command: 'projects describe', input: { toilProject: 'settlement', description: 'Nightly settlement' } }]));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit settlement' })).toBeNull());
  });

  it("shows toil's message and fix when it refuses, and keeps the form open", async () => {
    const config = editable(() => ({ ok: false, data: null, error: { code: 'INVALID_INPUT', message: 'You already have a Toil project named "settlement".', fix: 'Choose another name.' }, meta }) as unknown as Envelope);
    const user = await fromCard('card-payments', 'Edit', config);
    const form = screen.getByRole('form', { name: 'Edit card-payments' });
    const field = within(form).getByRole('textbox', { name: 'Name' });
    await user.clear(field);
    await user.type(field, 'settlement');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('You already have a Toil project named "settlement". Fix: Choose another name.');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('form', { name: 'Edit card-payments' })).toBeTruthy();
  });

  it('keeps what this browser remembers under the new name after a rename', async () => {
    localStorage.setItem('toil-ui:looked', JSON.stringify({ 'card-payments': '2026-10-12T00:00:00Z' }));
    const config = editable((input) => okEnvelope({ name: input.name, description: null, renamed: { from: input.toilProject, to: input.name }, changed: true }));
    const user = await fromCard('card-payments', 'Edit', config);
    const form = screen.getByRole('form', { name: 'Edit card-payments' });
    const field = within(form).getByRole('textbox', { name: 'Name' });
    await user.clear(field);
    await user.type(field, 'payments-v2{Enter}');
    await waitFor(() => expect(config.runs[0]).toEqual({ command: 'projects describe', input: { toilProject: 'card-payments', name: 'payments-v2' } }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem('toil-ui:looked')!)).toHaveProperty('payments-v2'));
  });

  it("puts the Toil project's name, description, sources and sprint day in its top row (#394)", async () => {
    await open('#/project/card-payments');
    const bar = document.querySelector('.toil-project-bar') as HTMLElement;
    expect(bar.textContent).toContain('Card payments v2');
    expect(bar.textContent).toContain('Sprint 42: day 7 of 10');
    expect(within(bar).getByRole('list', { name: 'Sources' })).toBeTruthy();
    expect(within(bar).getByRole('region', { name: 'Ask about card-payments' })).toBeTruthy();
  });
});

describe('a place the sync could not read (#542)', () => {
  const without = (toilProject: string, command: string) => fixtureExecute(CANNED.filter((c) => !(c.command === command && c.input.toilProject === toilProject))).execute;

  it('is one quiet line on the Pull requests view when its pull requests failed, and none on the board', async () => {
    await open('#/project/card-payments/prs', { execute: without('card-payments', 'bitbucket pr list') });
    const note = screen.getByText(/^bitbucket:/);
    expect(note.className).toBe('note');
    expect(within(note).getByRole('link', { name: 'pull requests not read' }).getAttribute('href')).toBe('#queue');
    cleanup();
    await open('#/project/card-payments/board', { execute: without('card-payments', 'bitbucket pr list') });
    expect(document.body.textContent).not.toContain('bitbucket: pull requests not read');
  });

  it('is one quiet line on the board when its work items failed, and none on the Pull requests view', async () => {
    await open('#/project/card-payments/board', { execute: without('card-payments', 'jira issue search') });
    const note = screen.getByText(/^jira:/);
    expect(note.className).toBe('note');
    expect(note.textContent).toBe('jira: work items not read');
    expect(within(note).queryByRole('link')).toBeNull();
    cleanup();
    await open('#/project/card-payments/prs', { execute: without('card-payments', 'jira issue search') });
    expect(document.body.textContent).not.toContain('jira: work items not read');
  });
});
