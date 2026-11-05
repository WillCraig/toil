import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpSync, type Session, type SyncClient, type SyncStatus } from '../src/server-client.ts';
import { SyncPanel, lastSynced } from '../src/sync-panel.tsx';

/**
 * The sync panel against a scripted SyncClient: the last sync of every
 * toil project and source, a running sync's progress, a failed source with toil's
 * message and its stale copy, and the wipe behind a confirmation.
 */

const idle = { running: false, by: null, startedAt: null, finishedAt: null, toilProject: null, toilProjectsDone: 0, toilProjectsTotal: 0, fetched: 0, reused: 0, requests: 0, pages: 0, retries: 0, messages: [], error: null };
const AT = '2026-10-13T08:00:00.000Z';
const LATER = '2026-10-13T09:00:00.000Z';

const synced: SyncStatus = {
  retentionDays: 30,
  job: { ...idle, startedAt: AT, finishedAt: LATER, toilProjectsDone: 2, toilProjectsTotal: 2 },
  toilProjects: [
    {
      name: 'card-payments',
      lastSyncAt: LATER,
      lastSavedAt: LATER,
      status: 'partial',
      error: 'jira: failed',
      sources: [
        { area: 'bitbucket', status: 'ok', lastAttemptAt: LATER, lastSuccessAt: LATER, watermark: LATER, error: null, fix: null, calls: 1, stale: false },
        { area: 'jira', status: 'failed', lastAttemptAt: LATER, lastSuccessAt: AT, watermark: AT, error: 'jira issue search: jira.imagile.dev answered 503.', fix: 'Try again when the server is back.', calls: 1, stale: true },
      ],
    },
    { name: 'settlement', lastSyncAt: AT, lastSavedAt: AT, status: 'ok', error: null, sources: [{ area: 'ado', status: 'ok', lastAttemptAt: AT, lastSuccessAt: AT, watermark: AT, error: null, fix: null, calls: 9, stale: false }] },
  ],
};
const empty: SyncStatus = { ...synced, job: idle, toilProjects: [] };

function client(states: SyncStatus[]): SyncClient & { starts: number; wipes: number } {
  let i = 0;
  const next = () => states[Math.min(i++, states.length - 1)]!;
  const c = {
    starts: 0,
    wipes: 0,
    status: async () => next(),
    start: async () => {
      c.starts++;
      return next();
    },
    wipe: async () => {
      c.wipes++;
      return empty;
    },
  };
  return c;
}

afterEach(() => vi.unstubAllGlobals());

describe('the sync panel', () => {
  it('shows each Toil project and source, and a failed one with its message, fix and stale copy', async () => {
    const { container } = render(<SyncPanel client={client([synced])} onChange={() => {}} />);
    expect(await screen.findByText(/Last synced 13 Oct 2026, 09:00 UTC\. Kept 30 days\./)).toBeTruthy();
    const card = screen.getByRole('list', { name: 'card-payments sources' });
    const jira = within(card).getByText(/jira\.imagile\.dev answered 503/);
    expect(jira.textContent).toContain('Try again when the server is back.');
    expect(jira.textContent).toContain('Showing the last good copy, from 13 Oct 2026, 08:00 UTC.');
    expect(within(card).getByText(/Bitbucket/).textContent).toContain('up to date');
    expect(screen.getByRole('list', { name: 'settlement sources' })).toBeTruthy();
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });

  it('says nothing is synced yet on a new cache', async () => {
    render(<SyncPanel client={client([empty])} onChange={() => {}} />);
    expect(await screen.findByText(/Nothing synced yet/)).toBeTruthy();
  });

  it('starts a sync, polls its progress, and tells the App when it ends', async () => {
    const running: SyncStatus = { ...synced, job: { ...idle, running: true, toilProject: 'settlement', toilProjectsDone: 1, toilProjectsTotal: 2, requests: 12, pages: 3, messages: ['Read page 3 of Jira issues'] } };
    const c = client([empty, running, running, synced]);
    const onChange = vi.fn();
    render(<SyncPanel client={c} onChange={onChange} pollMs={5} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
    expect(c.starts).toBe(1);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Syncing settlement: 1 of 2 Toil projects, 12 requests, 3 pages. Read page 3 of Jira issues'));
    expect(screen.getByRole('progressbar', { name: 'Toil projects synced' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Syncing…' })).toHaveProperty('disabled', true);
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('status').textContent).toBe('Sync finished; 1 source failed.');
  });

  it('starts a sync asked for from the page (#416), once per request, and not again while one runs', async () => {
    const running: SyncStatus = { ...synced, job: { ...idle, running: true, toilProjectsTotal: 2 } };
    const c = client([empty, running, running, running]);
    const view = render(<SyncPanel client={c} onChange={() => {}} pollMs={1000} request={0} />);
    await screen.findByText(/Nothing synced yet/);
    expect(c.starts).toBe(0);
    view.rerender(<SyncPanel client={c} onChange={() => {}} pollMs={1000} request={1} />);
    await waitFor(() => expect(c.starts).toBe(1));
    await screen.findByRole('button', { name: 'Syncing…' });
    view.rerender(<SyncPanel client={c} onChange={() => {}} pollMs={1000} request={2} />);
    await act(async () => {});
    expect(c.starts).toBe(1);
  });

  it('wipes only after the confirmation, with Cancel focused first and Escape to back out', async () => {
    const c = client([synced]);
    const onChange = vi.fn();
    render(<SyncPanel client={c} onChange={onChange} />);
    const wipe = await screen.findByRole('button', { name: 'Wipe the cache…' });
    await userEvent.click(wipe);
    const group = screen.getByRole('group', { name: /Delete everything Toil UI synced/ });
    expect(document.activeElement).toBe(within(group).getByRole('button', { name: 'Cancel' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('group')).toBeNull();
    expect(document.activeElement).toBe(wipe);
    expect(c.wipes).toBe(0);

    await userEvent.click(wipe);
    await userEvent.click(within(screen.getByRole('group')).getByRole('button', { name: 'Wipe it' }));
    expect(c.wipes).toBe(1);
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(screen.getByRole('status').textContent).toContain('The cache is wiped');
    expect(await screen.findByText(/Nothing synced yet/)).toBeTruthy();
  });

  it("shows the server's refusal as an alert", async () => {
    const c = client([synced]);
    c.start = async () => {
      throw new Error('A sync is already running. Wait for it to finish; the page shows its progress.');
    };
    render(<SyncPanel client={c} onChange={() => {}} />);
    const button = await screen.findByRole('button', { name: 'Sync now' });
    await act(async () => userEvent.click(button));
    expect((await screen.findByRole('alert')).textContent).toContain('already running');
  });

  it('takes the newest Toil project sync as the time the views were read', () => {
    expect(lastSynced(synced)).toBe(LATER);
    expect(lastSynced(null)).toBeNull();
  });
});

describe('httpSync', () => {
  const SESSION: Session = { session: 'sid-1', csrf: 'csrf-1', version: '0.0.0', toil: { version: '0.1.0-alpha.2', contractVersion: 1 }, viewer: { id: 'local', name: 'you' }, store: 'sqlite', sync: true, agent: 'none', sample: false, now: AT };

  it('reads with the session header, and posts the start and the confirmed wipe with the CSRF token', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(synced), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const sync = httpSync(SESSION);
    await sync.status();
    await sync.start('settlement');
    await sync.wipe();
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([url, init]) => [url, init.method, init.body ?? null])).toEqual([
      ['./api/sync', 'GET', null],
      ['./api/sync', 'POST', JSON.stringify({ toilProject: 'settlement' })],
      ['./api/cache/wipe', 'POST', JSON.stringify({ confirm: 'wipe' })],
    ]);
    expect(calls[2]![1].headers).toEqual({ 'X-Toil-UI-Session': 'sid-1', 'Content-Type': 'application/json', 'X-Toil-UI-CSRF': 'csrf-1' });
  });

  it("throws the server's message and fix", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'A sync is already running.', fix: 'Wait for it to finish.' } }), { status: 409 })));
    await expect(httpSync(SESSION).start()).rejects.toThrow('A sync is already running. Wait for it to finish.');
  });
});
