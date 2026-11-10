import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { Bell } from '../src/components/bell.tsx';
import { NotifyProvider, useNotify } from '../src/components/notify.tsx';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { HISTORY_KEY, MAX_HISTORY, added, allRead, browserHistory, history, parseHistory, unread, type HistoryEntry } from '../src/history.ts';
import { syncEntry } from '../src/sync-panel.tsx';
import type { SyncStatus } from '../src/server-client.ts';

/** The notification history behind the header's bell (#417). */

const entry = (n: number): Omit<HistoryEntry, 'seq'> => ({ id: `assignment:a${n}:done`, at: `2026-10-13T08:${String(n % 60).padStart(2, '0')}:00.000Z`, kind: 'done', title: `Codex finished ${n}`, line: `PAY-${n}: finished`, href: `#/project/card-payments/assignment/a${n}` });

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

describe('the history', () => {
  it('keeps the last 50, newest first, and counts what is unread', () => {
    let h = parseHistory(null);
    for (let i = 1; i <= 60; i++) h = added(h, [entry(i)]);
    expect(h.entries).toHaveLength(MAX_HISTORY);
    expect(h.entries[0]!.title).toBe('Codex finished 60');
    expect(h.entries.at(-1)!.title).toBe('Codex finished 11');
    expect(unread(h)).toBe(50);
    const read = allRead(h);
    expect(unread(read)).toBe(0);
    expect(unread(added(read, [entry(61), entry(62)]))).toBe(2);
    // Two added at once keep their order, the later one first.
    expect(added(read, [entry(61), entry(62)]).entries.slice(0, 2).map((e) => e.title)).toEqual(['Codex finished 62', 'Codex finished 61']);
  });

  it('drops an entry that does not parse, or that links off the app', () => {
    const good = { ...entry(1), seq: 1 };
    const text = JSON.stringify({ entries: [good, { ...good, seq: 2, href: 'https://example.com' }, { ...good, seq: 3, kind: 'nope' }, null], read: 0 });
    expect(parseHistory(text).entries).toEqual([good]);
    expect(parseHistory('{').entries).toEqual([]);
  });

  it('reads a bell entry saved with the old usage-cap kind as a failure', () => {
    const good = { ...entry(1), seq: 1 };
    const text = JSON.stringify({ entries: [{ ...good, kind: 'cap' }], read: 0 });
    expect(parseHistory(text).entries).toEqual([{ ...good, kind: 'failed' }]);
  });

  it('keeps one entry when two tabs add the same one', () => {
    const one = browserHistory('test.tabs');
    const two = browserHistory('test.tabs');
    one.add([entry(1)]);
    two.add([entry(1), entry(2)]);
    expect(two.get().entries.map((e) => e.id)).toEqual(['assignment:a2:done', 'assignment:a1:done']);
    expect(unread(one.get())).toBe(2);
  });

  it('is kept in this browser, and read again when another tab changes it', () => {
    const store = browserHistory('test.history');
    let heard = 0;
    store.subscribe(() => heard++);
    store.add([entry(1)]);
    expect(JSON.parse(localStorage.getItem('test.history')!).entries[0].title).toBe('Codex finished 1');
    localStorage.setItem('test.history', JSON.stringify({ entries: [], read: 0 }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'test.history' }));
    expect(heard).toBe(2);
    expect(store.get().entries).toEqual([]);
  });

  it("words a sync's result, linking to the Toil project that failed", () => {
    const status = (over: Partial<SyncStatus['job']>, toilProjects: SyncStatus['toilProjects']) => ({ job: { running: false, finishedAt: '2026-10-13T08:00:00.000Z', ...over }, toilProjects }) as unknown as SyncStatus;
    const ok = { name: 'card-payments', status: 'ok', sources: [{ area: 'jira', status: 'ok' }] };
    const bad = { name: 'settlement', status: 'ok', sources: [{ area: 'ado', status: 'failed' }] };
    expect(syncEntry(status({}, [ok] as never))).toMatchObject({ id: 'sync:2026-10-13T08:00:00.000Z', kind: 'sync', title: 'Sync finished', line: '1 Toil project up to date', href: '#/' });
    expect(syncEntry(status({}, [ok, bad] as never))).toMatchObject({ kind: 'sync-failed', title: 'Sync finished; 1 source failed', line: 'settlement: Azure DevOps', href: '#/project/settlement' });
    expect(syncEntry(status({ error: 'toil could not start' }, [] as never))).toMatchObject({ kind: 'sync-failed', title: 'The sync stopped', line: 'toil could not start' });
  });
});

describe('the bell', () => {
  it('counts the unread, lists each with its link, and Mark all read clears the count', async () => {
    history.add([entry(1), entry(2)]);
    render(<Bell />);
    const bell = screen.getByRole('button', { name: 'Notifications, 2 unread' });
    await userEvent.click(bell);
    const list = await screen.findByRole('dialog', { name: /^Notifications/ });
    const links = within(list).getAllByRole('link', { name: /Codex finished/ });
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['#/project/card-payments/assignment/a2', '#/project/card-payments/assignment/a1']);
    expect(links[0]!.textContent).toMatch(/^Unread: /);
    await userEvent.click(within(list).getByRole('button', { name: 'Mark all read' }));
    expect(screen.getByRole('button', { name: 'Notifications', hidden: true })).toBeTruthy();
    expect(within(list).getAllByRole('link', { name: /Codex finished/ })[0]!.textContent).not.toMatch(/^Unread/);
    expect(JSON.parse(localStorage.getItem(HISTORY_KEY)!).entries).toHaveLength(2);
  });

  it('offers what fills it when it is empty', async () => {
    render(<Bell />);
    await userEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    const list = await screen.findByRole('dialog', { name: /^Notifications/ });
    expect(within(list).getByRole('link', { name: 'Choose what notifies' }).getAttribute('href')).toBe('#/settings/general');
  });

  it("keeps each notice's changes, quiet hours included, without a toast it didn't make", async () => {
    // Quiet all day: the notice is held, and the bell still has it. Midday is pinned, because 00:00 to 23:59 leaves out the last minute of the day.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 13, 12));
    localStorage.setItem('toil-ui.notify', JSON.stringify({ quiet: { from: '00:00', to: '23:59' } }));
    let notify: ReturnType<typeof useNotify> = null;
    const Grab = () => {
      notify = useNotify();
      return null;
    };
    render(
      <NotifyProvider assignments={undefined} toilProject={null} mine={() => new Set()}>
        <Grab />
        <Bell />
      </NotifyProvider>,
    );
    act(() => notify!.report({ key: 'chat:1:0', state: 'stale', notable: 'stale', agent: 'The chat', item: null, itemTitle: null, why: 'toil changed', toilProject: 'card-payments', href: '#/project/card-payments', mine: true }, 'fresh'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Notifications, 1 unread' })).toBeTruthy(), { timeout: 6000 });
    expect(history.get().entries[0]).toMatchObject({ id: 'chat:1:0:stale', kind: 'stale', title: 'The chat went stale', line: 'card-payments: toil changed', href: '#/project/card-payments' });
    expect(notify!.notices).toEqual([]);
  }, 10_000);

  it('sits in the header', async () => {
    window.location.hash = '#/';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview />);
    await screen.findByRole('heading', { level: 1 }, { timeout: 3000 });
    const bell = screen.getByRole('button', { name: 'Notifications' });
    expect(bell.closest('header')).toBeTruthy();
  });
});
