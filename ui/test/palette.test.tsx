import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { FirstRun, firstRunShows, SAMPLE_COMMAND, TRACKER_AREAS } from '../src/components/first-run.tsx';
import { ageText, paletteEntries, paletteResults, staleNote, STALE_AFTER_MS, type EntriesInput } from '../src/components/palette.tsx';
import type { ConfigApi } from '../src/config.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { fixtureAnalyses } from '../src/fixtures/analyses.ts';
import { fixtureConfig } from '../src/fixtures/config.ts';
import { CANNED, FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { shortKey } from '../src/format.ts';
import { fuzzyRank, fuzzyScore } from '../src/fuzzy.ts';
import { ariaKeys, keysText, matches, SHORTCUTS, typingIn } from '../src/shortcuts.ts';
import type { Envelope } from '../src/toil.ts';
import { loaded } from './harness.ts';
import { standardWords } from './words.ts';

/**
 * The first run, the command palette and the shortcuts sheet (#416): the
 * matching, the shortcut table and the one rule that keeps it whole (no key
 * checked anywhere else), the palette's entries and results, and each of the
 * three in the App against the fixture execute().
 */

beforeEach(standardWords);

const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(window, { key, ...init });
const openPalette = async () => {
  await act(async () => {
    press('k', { ctrlKey: true });
  });
  return screen.findByRole('dialog', { name: 'Command palette' });
};
const envelope = (data: unknown): Envelope => ({ ok: true, data, error: null, meta: {} }) as unknown as Envelope;

describe('fuzzy matching', () => {
  it('finds each word in order, letters perhaps spread out, ignoring case', () => {
    expect(fuzzyScore('pay12', 'PAY-12 Store tokens')).not.toBeNull();
    expect(fuzzyScore('store vault', 'PAY-102 Store tokens in the vault')).not.toBeNull();
    expect(fuzzyScore('vault store', 'PAY-102 Store tokens in the vault')).not.toBeNull();
    expect(fuzzyScore('xyz', 'PAY-102 Store tokens')).toBeNull();
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('ranks a whole word over a spread one, and a start over a middle', () => {
    const ranked = fuzzyRank(['Settings: Usage', 'Board', 'Dashboard'], 'board', (s) => s).map((r) => r.entry);
    expect(ranked).toEqual(['Board', 'Dashboard']);
    expect(fuzzyRank(['b-o-a-r-d', 'board'], 'board', (s) => s)[0]!.entry).toBe('board');
  });
});

describe('the shortcut table', () => {
  it('matches a press by its keys, with Ctrl as Mod off a Mac, and no stray modifiers', () => {
    const none = { ctrlKey: false, metaKey: false, altKey: false };
    expect(matches('palette', { key: 'k', ...none, ctrlKey: true })).toBe(true);
    expect(matches('palette', { key: 'K', ...none, ctrlKey: true })).toBe(true);
    expect(matches('palette', { key: 'k', ...none })).toBe(false);
    expect(matches('cardMenu', { key: 'M', ...none })).toBe(true);
    expect(matches('cardMenu', { key: 'm', ...none, ctrlKey: true })).toBe(false);
    expect(matches('shortcuts', { key: '?', ...none })).toBe(true);
    expect(matches('editCancel', { key: 'Escape', ...none })).toBe(true);
    expect(keysText(SHORTCUTS.palette.keys, false)).toBe('Ctrl+K');
    expect(keysText(SHORTCUTS.palette.keys, true)).toBe('⌘K');
    expect(ariaKeys('cardMenu')).toBe('M ContextMenu');
  });

  it('knows a text field from the page', () => {
    const input = document.createElement('input');
    expect(typingIn(input)).toBe(true);
    expect(typingIn(document.body)).toBe(false);
  });

  it('is the only place a key is checked, so the sheet lists every shortcut', () => {
    const src = join(import.meta.dirname, '..', 'src');
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.tsx?$/.test(f) ? [join(dir, f)] : []));
    const found = files(src)
      // The hidden arcade has its own controls, shown on its start screen;
      // these are not work-dashboard shortcuts in the public shortcut sheet.
      .filter((f) => !f.endsWith('shortcuts.ts') && !f.includes(`${join('src', 'fixtures')}`) && !f.includes(`${join('src', 'game')}`))
      .flatMap((f) => (/\b(?:e|ev|evt|event)\.(?:key|code)\s*[!=]==|aria-keyshortcuts="/.test(readFileSync(f, 'utf8')) ? [relative(src, f)] : []));
    expect(found).toEqual([]);
  });
});

describe('the palette entries', () => {
  const base = (over: Partial<EntriesInput> = {}): EntriesInput => ({
    route: { view: 'toilProjects' },
    toilProjects: [],
    loaded: {},
    analyses: {},
    synced: undefined,
    at: Date.parse(FIXTURE_NOW),
    themes: [{ name: 'plain', label: 'Plain' }],
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

  it('offers the three appearances in the themes group, and running one calls setScheme', () => {
    const setScheme = vi.fn();
    const themes = Array.from({ length: 8 }, (_, i) => ({ name: `t${i}`, label: `T${i}` }));
    const entries = paletteEntries(base({ themes, scheme: 'light', setScheme }));
    const shown = paletteResults(entries, '', null).find((g) => g.group === 'themes')!.entries;
    expect(shown.map((e) => e.label)).toEqual([...themes.map((t) => `${t.label} theme`), 'Appearance: System', 'Appearance: Light', 'Appearance: Dark']);
    expect(shown.find((e) => e.label === 'Appearance: Light')!.detail).toBe('The appearance now');
    const dark = paletteResults(entries, 'dark', null).flatMap((g) => g.entries).find((e) => e.label === 'Appearance: Dark')!;
    (dark.go as { run: () => void }).run();
    expect(setScheme).toHaveBeenCalledWith('dark');
  });

  it('says how old a stale cache is, and nothing for a fresh one', () => {
    const at = Date.parse('2026-10-13T08:00:00Z');
    expect(staleNote({ at: '2026-10-13T07:00:00Z', status: 'ok' }, at)).toBeNull();
    expect(staleNote({ at: '2026-10-10T08:00:00Z', status: 'ok' }, at)).toBe('cached 3 days ago');
    expect(staleNote({ at: '2026-10-13T07:30:00Z', status: 'failed' }, at)).toBe('last sync failed, cached 30 minutes ago');
    expect(staleNote(undefined, at)).toBeNull();
    expect(ageText(STALE_AFTER_MS)).toBe('24 hours');
    expect(ageText(30_000)).toBe('1 minute');
  });

  it("lists every Toil project's items with its Toil project and status, and shows them only for a query", async () => {
    const card = (await loaded('card-payments')).data;
    const settle = (await loaded('settlement')).data;
    const x = base({ toilProjects: ['card-payments', 'settlement'], loaded: { 'card-payments': { ok: true, value: card }, settlement: { ok: true, value: settle } }, synced: { settlement: { at: '2026-10-01T00:00:00Z', status: 'ok' } } });
    const entries = paletteEntries(x);
    const one = settle.items[0]!;
    const hit = entries.find((e) => e.id === `item:settlement:${one.id}`)!;
    expect(hit.label).toBe(`${shortKey(one)} ${one.title}`);
    expect(hit.detail).toMatch(new RegExp(`^settlement · ${one.status ?? ''}.* · cached \\d+ days ago$`));
    expect(paletteResults(entries, '', null).map((g) => g.group)).not.toContain('items');
    const found = paletteResults(entries, shortKey(one), null);
    expect(found[0]!.group).toBe('items');
    expect(found[0]!.entries[0]!.id).toBe(hit.id);
    // Tabs: every toil project's seven, the one on screen's alone with nothing typed.
    expect(entries.filter((e) => e.group === 'tabs')).toHaveLength(14);
    expect(paletteResults(entries, '', 'settlement').find((g) => g.group === 'tabs')!.entries.map((e) => e.label)).toEqual(['Overview', 'Board', 'Dependencies', 'Pull requests', 'People', 'Worklog', 'Analyses']);
  });

  it('offers Ask, Analyze, Assign and the agents only on a Toil project page, and Sync only where there is a cache', async () => {
    const card = (await loaded('card-payments')).data;
    const item = card.items[0]!;
    const off = paletteEntries(base({ toilProjects: ['card-payments'], loaded: { 'card-payments': { ok: true, value: card } } })).filter((e) => e.group === 'commands').map((e) => e.id);
    expect(off).toEqual(['cmd:plain-words', 'cmd:shortcuts']);
    const on = paletteEntries(
      base({
        route: { view: 'dashboard', toilProject: 'card-payments', tab: 'board' },
        toilProjects: ['card-payments'],
        loaded: { 'card-payments': { ok: true, value: card } },
        onSync: () => {},
        focused: item.id,
        canAssign: true,
        agentSettings: true,
        adapters: { chosen: 'codex', options: [{ name: 'codex', label: 'Codex', model: null, ready: true, problem: null, fix: null, action: null }, { name: 'claude', label: 'Claude', model: 'haiku', ready: false, problem: 'Not installed', fix: null, action: 'install' }] },
      }),
    ).filter((e) => e.group === 'commands');
    expect(on.map((e) => e.label)).toEqual(['Sync now', 'Ask about card-payments', 'Analyze card-payments', 'Open the Agents panel', 'Review a pull request', 'Ship: answer a review', 'Diagram card-payments', `Assign ${shortKey(item)} to an agent`, 'Answer with Codex', 'Choose the default agent', 'Use plain words', 'Keyboard shortcuts']);
    expect(on.find((e) => e.id === 'cmd:job:diagram')!.go).toEqual({ href: '#/project/card-payments/job/diagram' });
    expect(on.find((e) => e.id === 'cmd:agent:codex')!.go).toEqual({ command: { kind: 'agent', name: 'codex', label: 'Codex' } });
  });
});

describe('the palette in the App', () => {
  it('opens on Ctrl+K, searches items across Toil projects from what was read, and opens one', async () => {
    window.location.hash = '#/';
    const { calls, execute } = fixtureExecute();
    render(<App execute={execute} agent={scriptedAgent()} config={fixtureConfig()} analyses={fixtureAnalyses()} now={FIXTURE_NOW} preview />);
    await screen.findByRole('heading', { level: 1, name: 'Toil projects' });
    const dialog = await openPalette();
    const settle = (await loaded('settlement')).data.items[0]!;
    const input = within(dialog).getByRole('searchbox');
    expect(document.activeElement).toBe(input);
    await userEvent.type(input, shortKey(settle));
    const option = await within(dialog).findByRole('menuitem', { name: new RegExp(`^${shortKey(settle)} `) }, { timeout: 3000 });
    expect(option.textContent).toContain('settlement');
    // Only reads: the item search makes no call but the ones a dashboard makes.
    expect(calls.every((c) => !/transitions|create|update|comment/.test(c.command))).toBe(true);
    const result = await axe.run(dialog, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(result.violations.map((v) => v.id)).toEqual([]);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(window.location.hash).toBe(`#/project/settlement/item/${encodeURIComponent(settle.id)}`));
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
  }, 20_000);

  it('jumps to a tab and runs Analyze on a Toil project page, and closes on Escape', async () => {
    window.location.hash = '#/project/card-payments';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} analyses={fixtureAnalyses()} now={FIXTURE_NOW} preview />);
    await screen.findByRole('heading', { level: 1, name: /card-payments/ });
    let dialog = await openPalette();
    await userEvent.type(within(dialog).getByRole('searchbox'), 'people card');
    await userEvent.click(await within(dialog).findByRole('menuitem', { name: /^People/ }));
    await waitFor(() => expect(window.location.hash).toBe('#/project/card-payments/people'));
    await openPalette();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull());
    dialog = await openPalette();
    await userEvent.click(within(dialog).getByRole('menuitem', { name: /^Analyze card-payments/ }));
    expect(await screen.findByRole('dialog', { name: /card-payments/ }, { timeout: 3000 })).toBeTruthy();
  }, 20_000);

  it('focuses the Ask bar on Ask', async () => {
    window.location.hash = '#/project/card-payments';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} analyses={fixtureAnalyses()} now={FIXTURE_NOW} preview />);
    await screen.findByRole('heading', { level: 1, name: /card-payments/ });
    const dialog = await openPalette();
    await userEvent.click(within(dialog).getByRole('menuitem', { name: /^Ask about card-payments/ }));
    await waitFor(() => expect(document.activeElement?.hasAttribute('data-ask-bar')).toBe(true));
  });

  it('opens the shortcuts sheet on ?, listing every shortcut, but not while typing', async () => {
    window.location.hash = '#/';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview />);
    await screen.findByRole('heading', { level: 1, name: 'Toil projects' });
    const field = document.createElement('input');
    document.body.append(field);
    fireEvent.keyDown(field, { key: '?' });
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
    field.remove();
    await act(async () => {
      press('?');
    });
    const sheet = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    for (const s of Object.values(SHORTCUTS)) expect(within(sheet).getAllByText(s.what).length).toBeGreaterThan(0);
    expect(within(sheet).getByText("Open the card's menu: open it, move it or assign it to an agent")).toBeTruthy();
    const result = await axe.run(sheet, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });
});

describe('the first run', () => {
  const noToilProjects = () => fixtureExecute(CANNED.map((c) => (c.command === 'projects list' ? { ...c, data: { folder: null, places: { user: '/home/you/.toil/projects', listed: [], repo: null }, toilProjects: [], broken: [] } } : c))).execute;
  const config = (connections: Array<{ name: string; area: string; definedIn: 'env' | 'file' }>): ConfigApi => ({
    disabled: null,
    areas: async () => [],
    settings: async () => ({ timeout: { variable: 'TOIL_TIMEOUT_MS', value: null, effectiveMs: 120_000, defaultMs: 120_000 } }),
    run: async (command) => (command === 'connections list' ? envelope({ configFile: '/home/you/.toil/config.json', connections: connections.map((c) => ({ ...c, isDefault: true, host: null, writes: false, values: {} })) }) : envelope({})),
  });

  it('shows when there are no Toil projects, or where Toil UI syncs none has synced yet', () => {
    expect(firstRunShows(0, null, false)).toBe(true);
    expect(firstRunShows(2, {}, true)).toBe(true);
    expect(firstRunShows(2, { a: {} }, true)).toBe(false);
    expect(firstRunShows(2, null, false)).toBe(false);
    expect(firstRunShows(2, {}, false)).toBe(false);
    expect([...TRACKER_AREAS].sort()).toEqual(['ado', 'github', 'jira']);
  });

  it('replaces the empty Toil projects view with three steps, ticking off a tracker made by env vars', async () => {
    window.location.hash = '#/';
    const synced = {};
    let asked = 0;
    const { container } = render(<App execute={noToilProjects()} agent={scriptedAgent()} config={config([{ name: 'ci-jira', area: 'jira', definedIn: 'env' }, { name: 'builds', area: 'jenkins', definedIn: 'file' }])} now={FIXTURE_NOW} preview={false} synced={synced} onSync={() => asked++} />);
    const region = await screen.findByRole('region', { name: 'Get started' });
    const steps = within(region).getAllByRole('listitem');
    expect(steps).toHaveLength(3);
    await waitFor(() => expect(steps[0]!.textContent).toContain('Done'));
    expect(steps[0]!.textContent).toContain('ci-jira');
    expect(steps[0]!.textContent).not.toContain('builds');
    expect(steps[1]!.textContent).toContain('Not done yet');
    expect(within(steps[1]!).getByRole('link', { name: 'Create a Toil project' }).getAttribute('href')).toBe('#/settings/projects/+new');
    expect(within(steps[2]!).getByRole('button', { name: 'Sync now' })).toHaveProperty('disabled', true);
    expect(within(region).getByText(SAMPLE_COMMAND)).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Copy sample data command' })).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'About the sample data' })).toBeTruthy();
    expect(asked).toBe(0);
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });

  it('offers Add a connection until a tracker is connected, and Sync once a Toil project is made', async () => {
    let asked = 0;
    render(<FirstRun toilProjects={1} synced={{}} config={config([])} onSync={() => asked++} />);
    const region = screen.getByRole('region', { name: 'Get started' });
    expect(within(region).getByRole('link', { name: 'Add a connection' }).getAttribute('href')).toBe('#/settings/connections/+add');
    await userEvent.click(within(region).getByRole('button', { name: 'Sync now' }));
    expect(asked).toBe(1);
  });

  it('is gone once the first sync has finished', async () => {
    window.location.hash = '#/';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview={false} synced={{ 'card-payments': { at: FIXTURE_NOW, status: 'ok' } }} onSync={() => {}} />);
    await screen.findByRole('heading', { level: 1, name: 'Toil projects' });
    expect(screen.queryByRole('region', { name: 'Get started' })).toBeNull();
  });

  it('lands the add link on the add form, and the create link on Create a Toil project', async () => {
    window.location.hash = '#/settings/connections/+add';
    const view = render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview />);
    await waitFor(() => expect(document.activeElement?.id).toBe('conn-add'), { timeout: 3000 });
    expect(screen.queryByText(/toil has no connection named/)).toBeNull();
    view.unmount();
    window.location.hash = '#/settings/projects/+new';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview />);
    await waitFor(() => expect(document.activeElement?.id).toBe('toil-project-change'), { timeout: 3000 });
    expect(screen.queryByText(/toil sees no Toil project named/)).toBeNull();
  });
});
