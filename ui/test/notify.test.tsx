// @vitest-environment jsdom
/**
 * Notifications on agent state changes (#306): which changes notify and in
 * what words, the window that coalesces them and drops a change undone
 * inside it, the settings and their defaults, quiet hours, and in the page:
 * one notice for a run that ends needing you, the title count while hidden,
 * and the browser asked for permission only once a person turns it on.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import type { AssignmentEvent } from '../src/assign/model.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { fixtureAssignments } from '../src/fixtures/assignments.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { Coalescer, DEFAULT_NOTIFY, inQuiet, parseNotify, summaryOf, transitionOf, WINDOW_MS, type NotifySettings, type Transition } from '../src/notify.ts';

const event = (over: Partial<AssignmentEvent>): AssignmentEvent => ({ seq: 1, at: FIXTURE_NOW, id: 'a1', toilProject: 'card-payments', item: 'corp-jira:PAY-102', kind: 'state', state: 'needs-you', previous: 'working', message: '', itemTitle: 'Store tokens in the vault', adapter: 'codex', origin: 'person', stop: null, pending: 0, questions: 0, ...over });
const t = (e: Partial<AssignmentEvent>, mine = false) => transitionOf(event(e), { mine, href: '#/x' });

describe('which changes notify', () => {
  it('turns an end state into one line on why, in plain words', () => {
    expect(t({ questions: 1 })).toMatchObject({ notable: 'needs-you', why: 'asked a question', agent: 'Codex' });
    expect(t({ questions: 2, pending: 3 })!.why).toBe('asked 2 questions, 3 proposals to review');
    expect(t({ stop: 'injection' })!.why).toMatch(/looked like an instruction/);
    expect(t({ state: 'done' })).toMatchObject({ notable: 'done', why: 'finished' });
    // A usage-cap stop on an assignment recorded before caps were removed reads as any other failure.
    expect(t({ state: 'failed', stop: 'usage', message: 'Stopped at a cap.' })).toMatchObject({ notable: 'failed', why: 'Stopped at a cap.' });
    expect(t({ state: 'failed', stop: 'time' })).toMatchObject({ notable: 'failed', why: 'stopped at its time limit' });
    expect(t({ state: 'failed', stop: 'error', message: 'Codex failed: not signed in.' })!.why).toBe('Codex failed: not signed in.');
    expect(t({ state: 'failed', stop: 'error', message: '' })!.why).toBe('failed');
  });

  it('never for a repeated state, a start, a proposal, or a person stopping it themselves', () => {
    expect(t({ state: 'working', previous: 'working' })).toBeNull();
    expect(t({ kind: 'proposal', state: 'needs-you', previous: 'needs-you' })).toBeNull();
    expect(t({ kind: 'renewed', state: 'failed', previous: 'failed' })).toBeNull();
    expect(t({ state: 'working', previous: 'queued' })!.notable).toBeNull();
    expect(t({ state: 'failed', stop: 'cancelled' })!.notable).toBeNull();
  });

  it('says one change, or how many of a kind, or how many updates', () => {
    const a = t({ questions: 1 })!;
    expect(summaryOf([a])).toEqual({ title: 'Codex needs you', lines: ['Codex needs you on corp-jira:PAY-102 Store tokens in the vault: asked a question'] });
    expect(summaryOf([a, { ...a, key: 'assignment:a2', agent: 'Claude' }]).title).toBe('2 agents need you');
    expect(summaryOf([a, t({ id: 'a2', state: 'failed', stop: 'error' })!]).title).toBe('2 agent updates');
    expect(summaryOf([{ ...a, notable: 'stale' }, { ...a, key: 'chat:x', notable: 'stale' }]).title).toBe('2 sessions went stale');
  });

  it('keeps needs you and failed on and done off by default, and reads a broken setting as the default', () => {
    expect(DEFAULT_NOTIFY.states).toMatchObject({ 'needs-you': true, failed: true, done: false });
    expect(DEFAULT_NOTIFY.browser).toBe(false);
    expect(parseNotify('{not json')).toEqual(DEFAULT_NOTIFY);
    expect(parseNotify(JSON.stringify({ states: { done: true, failed: 'yes' }, quiet: { from: '7pm', to: '07:00' }, mine: true }))).toEqual({ ...DEFAULT_NOTIFY, states: { ...DEFAULT_NOTIFY.states, done: true }, mine: true });
  });

  it('has quiet hours that wrap past midnight', () => {
    const at = (h: number, m = 0) => new Date(2026, 9, 13, h, m);
    expect(inQuiet({ from: '22:00', to: '07:00' }, at(23))).toBe(true);
    expect(inQuiet({ from: '22:00', to: '07:00' }, at(6, 59))).toBe(true);
    expect(inQuiet({ from: '22:00', to: '07:00' }, at(7))).toBe(false);
    expect(inQuiet({ from: '12:00', to: '13:00' }, at(12, 30))).toBe(true);
    expect(inQuiet(null, at(3))).toBe(false);
    // A time that isn't one never makes quiet hours, and a broken one isn't kept.
    expect(inQuiet({ from: '25:99', to: '07:00' }, at(3))).toBe(false);
    expect(parseNotify(JSON.stringify({ quiet: { from: '24:00', to: '07:00' } })).quiet).toBeNull();
    expect(parseNotify(JSON.stringify({ quiet: { from: '7:30', to: '23:59' } })).quiet).toEqual({ from: '7:30', to: '23:59' });
  });
});

describe("the server's event stream, as the page reads it", () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads NDJSON split across chunks, with no header, to a last line with no newline', async () => {
    const { httpAssignments } = await import('../src/assign/client.ts');
    const a = JSON.stringify(event({ seq: 1, id: 'a1' }));
    const b = JSON.stringify(event({ seq: 2, id: 'a2', state: 'done' }));
    const chunks = [a.slice(0, 20), `${a.slice(20)}
${b.slice(0, 7)}`, b.slice(7)];
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, headers: init.headers });
      const enc = new TextEncoder();
      return new Response(new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(enc.encode(x)); c.close(); } }), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    });
    const api = httpAssignments({ assignments: true } as never, '/');
    const got: AssignmentEvent[] = [];
    await api.events!('latest', (e) => got.push(e), new AbortController().signal);
    expect(got.map((e) => [e.seq, e.id, e.state])).toEqual([[1, 'a1', 'needs-you'], [2, 'a2', 'done']]);
    expect(seen[0]!.url).toBe('/api/assignments/events?since=latest');
    expect(seen[0]!.headers).toBeUndefined();
  });
});

describe('the window', () => {
  function window(settings: NotifySettings = DEFAULT_NOTIFY) {
    const out: Transition[][] = [];
    let fire: (() => void) | null = null;
    const c = new Coalescer((x) => out.push(x), () => settings, { set: (fn) => ((fire = fn), 1), clear: () => (fire = null) });
    return { c, out, fire: () => fire?.() };
  }

  it('makes several changes inside it one notice', () => {
    const w = window();
    w.c.push(t({ id: 'a1', questions: 1 })!, 'working');
    w.c.push(t({ id: 'a2', state: 'failed', stop: 'time' })!, 'working');
    expect(w.out).toEqual([]);
    w.fire();
    expect(w.out).toHaveLength(1);
    expect(w.out[0]!.map((x) => x.key)).toEqual(['assignment:a1', 'assignment:a2']);
  });

  it('sends nothing for a change undone inside it, or one switched off, or not mine when only mine', () => {
    const w = window();
    w.c.push(t({ questions: 1 })!, 'working');
    w.c.push(t({ state: 'working', previous: 'needs-you' })!, 'needs-you');
    w.c.push(t({ id: 'a2', state: 'needs-you', previous: 'working', questions: 1 })!, 'working');
    w.c.push(t({ id: 'a2', state: 'done', previous: 'needs-you' })!, 'needs-you');
    w.fire();
    expect(w.out).toEqual([]);
    const mine = window({ ...DEFAULT_NOTIFY, mine: true });
    mine.c.push(t({ questions: 1 }, false)!, 'working');
    mine.c.push(t({ id: 'a3', questions: 1 }, true)!, 'working');
    mine.fire();
    expect(mine.out[0]!.map((x) => x.key)).toEqual(['assignment:a3']);
  });
});

describe('in the page', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function open(hash: string) {
    window.location.hash = hash;
    const api = fixtureAssignments({ delay: 1 });
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview assignments={api} />);
    await screen.findByRole('heading', { level: 1 }, { timeout: 3000 });
    return api;
  }

  it('raises exactly one notice when a run it watched ends needing you, counting it in the title while the tab is hidden', async () => {
    const api = await open('#/project/card-payments');
    const notices = screen.getByRole('status', { name: 'Notifications' });
    // Let the event stream connect before the run starts, so it hears what happens next.
    await new Promise((r) => setTimeout(r, 50));
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.title = 'Toil UI';
    await api.assign({ toilProject: 'card-payments', item: 'corp-jira:PAY-103', mode: 'refine', adapter: 'codex' });
    await within(notices).findByText('Codex needs you', { selector: 'strong' }, { timeout: WINDOW_MS + 5000 });
    expect(within(notices).getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringMatching(/^corp-jira:PAY-103 Charge a stored token: asked a question, 1 proposal to review$/)]);
    expect(document.title).toBe('(1) Toil UI');
    hidden.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(document.title).toBe('Toil UI');
    // The working step before it notified nothing.
    expect(notices.querySelectorAll('.notice')).toHaveLength(1);
    await userEvent.setup().click(within(notices).getByRole('button', { name: /^Dismiss/ }));
    expect(notices.querySelectorAll('.notice')).toHaveLength(0);
  }, 20_000);

  it('asks the browser for permission only once a person turns browser notifications on', async () => {
    const requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
    vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: 'default', requestPermission }));
    await open('#/settings/general');
    const panel = screen.getByRole('region', { name: 'Notifications' });
    expect(within(panel).getByRole('checkbox', { name: 'Needs you' })).toHaveProperty('checked', true);
    expect(within(panel).getByRole('checkbox', { name: 'Done' })).toHaveProperty('checked', false);
    expect(requestPermission).not.toHaveBeenCalled();
    await userEvent.setup().click(within(panel).getByRole('checkbox', { name: /Browser notifications/ }));
    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(JSON.parse(localStorage.getItem('toil-ui.notify')!).browser).toBe(true));
  }, 20_000);

  it('keeps quiet hours as they were while a time is typed that is not one, saying so', async () => {
    await open('#/settings/general');
    const panel = screen.getByRole('region', { name: 'Notifications' });
    const user = userEvent.setup();
    await user.click(within(panel).getByRole('checkbox', { name: 'Quiet hours' }));
    const from = within(panel).getByRole('textbox', { name: /^From/ });
    await user.clear(from);
    await user.type(from, '7pm');
    await within(panel).findByText('Use HH:MM, like 22:00. Until then the quiet hours keep 22:00.');
    expect(JSON.parse(localStorage.getItem('toil-ui.notify')!).quiet).toEqual({ from: '22:00', to: '07:00' });
    await user.clear(from);
    await user.type(from, '21:30');
    await waitFor(() => expect(JSON.parse(localStorage.getItem('toil-ui.notify')!).quiet).toEqual({ from: '21:30', to: '07:00' }));
  }, 20_000);

  it("says plainly when the browser refuses, and leaves it off", async () => {
    vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: 'default', requestPermission: async () => 'denied' as NotificationPermission }));
    await open('#/settings/general');
    const panel = screen.getByRole('region', { name: 'Notifications' });
    await userEvent.setup().click(within(panel).getByRole('checkbox', { name: /Browser notifications/ }));
    await within(panel).findByText(/didn't allow notifications for this page/);
    expect(within(panel).getByRole('checkbox', { name: /Browser notifications/ })).toHaveProperty('checked', false);
  }, 20_000);
});
