import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { ArchivedDisclosure } from '../src/components/archive.tsx';
import { paletteEntries, paletteResults, type EntriesInput } from '../src/components/palette.tsx';
import type { ConfigApi } from '../src/config.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { fixtureAnalyses } from '../src/fixtures/analyses.ts';
import { fixtureConfig } from '../src/fixtures/config.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { fixtureWorklog } from '../src/fixtures/worklog.ts';
import { loadToilProjects } from '../src/load.ts';
import type { Envelope, Execute } from '../src/toil.ts';

/**
 * Archiving a Toil project from the page (#561): the card's quiet menu, the
 * undo line, the "Archived (n)" disclosure, the palette's two entries and the
 * Settings page, all through toil's own `projects archive` and `unarchive`,
 * with the list read again each time. The fixture execute answers the list
 * from a set this file keeps, which is what toil's own list does with the flag.
 */

beforeEach(() => {
  localStorage.clear();
  window.location.hash = '#/';
});
afterEach(cleanup);

const meta = { command: 'projects list', durationMs: 1, version: '0.0.0', contractVersion: 1 };
const ok = (data: unknown) => ({ ok: true, data, error: null, meta }) as unknown as Envelope;
const refused = (message: string, fix: string) => ({ ok: false, data: null, error: { code: 'INVALID_INPUT', message, fix }, meta }) as unknown as Envelope;

/** The sample's list, with the names in `away` moved from the plain list to the archived one, as toil does. */
function archiving(away = new Set<string>(), options: { archivedUnreadable?: boolean } = {}) {
  const base = fixtureExecute().execute;
  const execute: Execute = async (command, input = {}, opts) => {
    if (command !== 'projects list') return base(command, input, opts);
    const plain = (await base(command, {}, opts)) as Envelope & { data: { toilProjects: Array<{ name: string }> } };
    const all = plain.data.toilProjects;
    if (input.archived === true) {
      if (options.archivedUnreadable) return refused('Unknown field archived.', 'Update toil.');
      const sample = ((await base(command, { archived: true }, opts)) as Envelope & { data: { toilProjects: Array<Record<string, unknown>> } }).data.toilProjects;
      const gone = all.filter((d) => away.has(d.name)).map((d) => ({ ...d, archived: true }));
      return ok({ ...plain.data, toilProjects: [...sample, ...gone] });
    }
    return ok({ ...plain.data, toilProjects: all.filter((d) => !away.has(d.name)) });
  };
  return { execute, away };
}

type Run = { command: string; input: Record<string, unknown> };
/** A config path that may change things: archive and unarchive move names in and out of `away`. */
function editable(away: Set<string>, answer?: (command: string, input: Record<string, unknown>) => Envelope | undefined): ConfigApi & { runs: Run[] } {
  const runs: Run[] = [];
  return {
    runs,
    disabled: null,
    areas: async () => [],
    settings: async () => ({ timeout: { variable: 'TOIL_TIMEOUT_MS', value: null, effectiveMs: 120_000, defaultMs: 120_000 } }),
    run: async (command, input) => {
      runs.push({ command, input });
      const custom = answer?.(command, input);
      if (custom) return custom;
      if (command !== 'projects archive' && command !== 'projects unarchive') return fixtureConfig().run(command, input);
      const name = String(input.toilProject);
      if (command === 'projects archive') away.add(name);
      if (command === 'projects unarchive') away.delete(name);
      return ok({ name, archived: command === 'projects archive', changed: true });
    },
  };
}

async function open(hash: string, execute: Execute, config: ConfigApi, preview = false) {
  window.location.hash = hash;
  render(<App execute={execute} agent={scriptedAgent()} config={config} now={FIXTURE_NOW} preview={preview} worklog={fixtureWorklog()} analyses={fixtureAnalyses()} />);
  await screen.findByRole('heading', { level: 1 }, { timeout: 3000 });
}

/** The line under the header that says what an archive did. */
const notice = () => document.querySelector('.archive-notice')?.textContent ?? '';
const cardNames = () => screen.queryAllByRole('article').map((c) => (within(c).getByRole('heading').textContent ?? '').replace('✎', ''));

describe('the archive on the Toil projects page', () => {
  it('offers nothing to change in the preview, and still says what is archived, without an Unarchive', async () => {
    await open('#/', fixtureExecute().execute, fixtureConfig(), true);
    const disclosure = await screen.findByText('Archived (1)');
    // A card's menu still has Move earlier and later in the preview, which only reorder this page; nothing that changes toil is in it.
    await userEvent.click((await screen.findAllByRole('button', { name: /^Menu for / }))[0]!);
    expect(await screen.findByRole('menuitem', { name: 'Move later' })).toBeTruthy();
    for (const name of ['Archive', 'Edit', 'Edit sources']) expect(screen.queryByRole('menuitem', { name })).toBeNull();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(disclosure);
    expect(screen.getByText('pilot-rollout')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Unarchive / })).toBeNull();
  });

  it('archives from the card menu through toil projects archive, drops the card, and says how to undo it', async () => {
    const user = userEvent.setup();
    const { execute, away } = archiving();
    const config = editable(away);
    await open('#/', execute, config);
    await waitFor(() => expect(cardNames()).toHaveLength(3));
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Menu for settlement' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => expect(config.runs).toEqual([{ command: 'projects archive', input: { toilProject: 'settlement' } }]));
    await waitFor(() => expect(cardNames()).not.toContain('settlement'));
    expect(notice()).toContain('Archived settlement. It is hidden, not deleted.');
    // It moved under Archived, which grew by one, and is closed until opened.
    const disclosure = await screen.findByText('Archived (2)');
    await user.click(disclosure);
    expect(within(disclosure.closest('details')!).getByText('settlement')).toBeTruthy();
  });

  it('undoes an archive with one press, and unarchives from the disclosure', async () => {
    const user = userEvent.setup();
    const { execute, away } = archiving();
    const config = editable(away);
    await open('#/', execute, config);
    await waitFor(() => expect(cardNames()).toHaveLength(3));
    await user.click(screen.getByRole('button', { name: 'Menu for checkout-web' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => expect(cardNames()).not.toContain('checkout-web'));
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(config.runs.at(-1)).toEqual({ command: 'projects unarchive', input: { toilProject: 'checkout-web' } }));
    await waitFor(() => expect(cardNames()).toContain('checkout-web'));
    expect(notice()).toContain('checkout-web is back in the list.');

    await user.click(await screen.findByText('Archived (1)'));
    await user.click(screen.getByRole('button', { name: 'Unarchive pilot-rollout' }));
    await waitFor(() => expect(config.runs.at(-1)).toEqual({ command: 'projects unarchive', input: { toilProject: 'pilot-rollout' } }));
  });

  it("shows toil's message and fix when it refuses, and keeps the card", async () => {
    const user = userEvent.setup();
    const { execute, away } = archiving();
    const config = editable(away, (command) => (command === 'projects archive' ? refused('Toil project settlement is checked into a repository.', 'Copy it into your own folder with toil projects import first.') : undefined));
    await open('#/', execute, config);
    await waitFor(() => expect(cardNames()).toHaveLength(3));
    await user.click(screen.getByRole('button', { name: 'Menu for settlement' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Toil project settlement is checked into a repository. Copy it into your own folder with toil projects import first.');
    expect(cardNames()).toContain('settlement');
  });

  it('draws no Archived disclosure when the archive could not be read, which is not the same as none', async () => {
    const { execute, away } = archiving(new Set(), { archivedUnreadable: true });
    await open('#/', execute, editable(away));
    await waitFor(() => expect(cardNames()).toHaveLength(3));
    expect(screen.queryByText(/^Archived \(/)).toBeNull();
    const read = await loadToilProjects(execute);
    expect(read.archived).toBeNull();
    expect(read.calls.some((c) => c.input.archived === true)).toBe(false);
  });

  it('draws nothing for a real zero either: there is nothing to open', () => {
    const { container } = render(<ArchivedDisclosure archived={[]} onUnarchive={null} />);
    expect(container.textContent).toBe('');
  });

  it('has no accessibility violations with the menu closed and the disclosure open', async () => {
    const { execute, away } = archiving();
    await open('#/', execute, editable(away));
    await waitFor(() => expect(cardNames()).toHaveLength(3));
    await userEvent.click(await screen.findByText('Archived (1)'));
    const result = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  }, 20_000);
});

describe('the palette entries for archiving', () => {
  const base = (over: Partial<EntriesInput> = {}): EntriesInput => ({
    route: { view: 'toilProjects' },
    toilProjects: ['card-payments', 'settlement'],
    loaded: {},
    analyses: {},
    synced: undefined,
    at: Date.parse(FIXTURE_NOW),
    themes: [],
    currentTheme: 'plain',
    setTheme: () => {},
    scheme: 'system',
    setScheme: () => {},
    onSync: undefined,
    focused: null,
    canAssign: false,
    adapters: null,
    agentSettings: false,
    openShortcuts: () => {},
    ...over,
  });

  it('has none where changes are off', () => {
    expect(paletteEntries(base()).some((e) => e.id.startsWith('cmd:archive:') || e.id.startsWith('cmd:unarchive:'))).toBe(false);
  });

  it('keeps them out of the empty palette, and finds them by typing archive or a name', () => {
    const calls: Array<[string, boolean]> = [];
    const entries = paletteEntries(base({ onArchive: (n, a) => calls.push([n, a]), archivedNames: ['pilot-rollout'] }));
    expect(paletteResults(entries, '', null).flatMap((g) => g.entries).some((e) => e.id.startsWith('cmd:archive:'))).toBe(false);
    const found = paletteResults(entries, 'archive settlement', null).flatMap((g) => g.entries);
    const archive = found.find((e) => e.id === 'cmd:archive:settlement')!;
    expect(archive.label).toBe('Archive settlement');
    if ('run' in archive.go) archive.go.run();
    const back = paletteResults(entries, 'unarchive pilot', null).flatMap((g) => g.entries).find((e) => e.id === 'cmd:unarchive:pilot-rollout')!;
    if ('run' in back.go) back.go.run();
    expect(calls).toEqual([['settlement', true], ['pilot-rollout', false]]);
  });

  it('runs from the palette in the App, and drops the Toil project from the list', async () => {
    const { execute, away } = archiving();
    const config = editable(away);
    await open('#/', execute, config);
    await waitFor(() => expect(cardNames()).toHaveLength(3));
    await act(async () => {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    });
    const dialog = await screen.findByRole('dialog', { name: 'Command palette' });
    await userEvent.type(within(dialog).getByRole('searchbox'), 'archive checkout');
    await userEvent.click(await within(dialog).findByText('Archive checkout-web'));
    await waitFor(() => expect(config.runs).toEqual([{ command: 'projects archive', input: { toilProject: 'checkout-web' } }]));
    await waitFor(() => expect(cardNames()).not.toContain('checkout-web'));
  });
});

describe('the archive in Settings, Toil projects', () => {
  it('archives a Toil project of yours and unarchives it, from the list there', async () => {
    const user = userEvent.setup();
    const { execute, away } = archiving();
    const config = editable(away);
    // Settings reads its lists through the config path, so that answers them from the same set.
    const lists = archiving(away);
    const settings: ConfigApi & { runs: Run[] } = {
      ...config,
      run: async (command, input) => {
        if (command === 'projects list') return lists.execute(command, input, { readOnly: true });
        return config.run(command, input);
      },
    };
    await open('#/settings/projects', execute, settings);
    const card = await screen.findByRole('article', { name: 'settlement' });
    await user.click(within(card).getByRole('button', { name: 'Menu for settlement' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => expect(config.runs).toContainEqual({ command: 'projects archive', input: { toilProject: 'settlement' } }));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'settlement' })).toBeNull());
    expect(notice()).toContain('Archived settlement.');
    await user.click(await screen.findByText('Archived (2)'));
    await user.click(screen.getByRole('button', { name: 'Unarchive settlement' }));
    await waitFor(() => expect(config.runs.at(-1)).toEqual({ command: 'projects unarchive', input: { toilProject: 'settlement' } }));
    await screen.findByRole('article', { name: 'settlement' });
  });
});
