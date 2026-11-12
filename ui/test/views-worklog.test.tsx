// @vitest-environment jsdom
// The worklog is rebuilt from the cache on request, a convenience timesheets have never offered.
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { FIXTURE_NOW } from '../src/fixtures/execute.ts';
import { fixtureWorklog } from '../src/fixtures/worklog.ts';
import { parseRoute } from '../src/App.tsx';
import type { WorklogApi, WorklogDay } from '../src/worklog.ts';
import { open, AXE_TIMEOUT, violations, tabs, resetBrowserState } from './views-kit.tsx';

beforeEach(resetBrowserState);

describe('the worklog (#308)', () => {
  it('is a route per Toil project, and per UTC day', () => {
    expect(parseRoute('#/project/card-payments/worklog')).toEqual({ view: 'worklog', toilProject: 'card-payments', day: null });
    expect(parseRoute('#/project/card-payments/worklog/2026-10-12')).toEqual({ view: 'worklog', toilProject: 'card-payments', day: '2026-10-12' });
    expect(parseRoute('#/project/card-payments/worklog/2026-02-30')).toEqual({ view: 'worklog', toilProject: 'card-payments', day: null });
  });

  it("opens on today's page, linked from the header, with the calendar of days that have one", async () => {
    await open('#/project/card-payments/worklog');
    expect(within(tabs('card-payments')).getByRole('link', { name: 'What happened' }).getAttribute('aria-current')).toBe('page');
    await screen.findByRole('heading', { name: 'Tuesday 13 October 2026' });
    const today = screen.getByRole('link', { name: /Tuesday 13 October 2026, today/ });
    expect(today.getAttribute('aria-current')).toBe('date');
    expect(today.getAttribute('href')).toBe('#/project/card-payments/worklog/2026-10-13');
    // The line is built from the syncs, which can land after the heading on a loaded runner.
    expect(await screen.findByText(/^Today so far: built from the syncs up to 07:55 UTC/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next month' }).getAttribute('data-disabled')).not.toBeNull();
  });

  it('marks today as today on the calendar before it has a page, so no theme reads it as a past day (#415)', async () => {
    const base = fixtureWorklog();
    const worklog: WorklogApi = { ...base, month: async (toilProject, month) => {
      const m = await base.month(toilProject, month);
      return { ...m, days: m.days.filter((d) => d.day !== m.today) };
    } };
    const { container } = await open('#/project/card-payments/worklog', { worklog });
    await screen.findByRole('heading', { name: 'Tuesday 13 October 2026' });
    await waitFor(() => expect(container.querySelector('td.calendar__empty[data-today]')).not.toBeNull());
    expect(container.querySelector('td.calendar__empty[data-today]')!.textContent).toContain('today: no page');
  });

  it("shows a day's facts, each linked to its source, the agent's run with whether its proposal was applied, and the note", async () => {
    const { container } = await open('#/project/card-payments/worklog/2026-10-12');
    const day = await screen.findByRole('region', { name: 'Monday 12 October 2026' });
    expect(within(day).getByRole('heading', { name: 'Work items' })).toBeTruthy();
    const run = within(day).getByText(/^Asked the scripted preview/).closest('li')!;
    expect(run.textContent).toMatch(/finished at 15:21/);
    expect(run.textContent).toMatch(/applied: toil's audit log has the write at 12 Oct 2026 16:02 UTC \(cli\)/);
    expect(within(run).getByText('Transcript, written by the agent')).toBeTruthy();
    expect(within(day).getByText(/Paired on the retry fix/, { selector: '.worklog-line span' })).toBeTruthy();
    expect(within(day).getAllByText(/^This is sample data, so it keeps no notes and writes no files/).length).toBeGreaterThan(0);
    expect(within(day).getByRole('region', { name: 'The page as Markdown' }).textContent).toMatch(/^# Worklog: card-payments, Monday 12 October 2026/);
    expect(await violations(container)).toEqual([]);
  }, AXE_TIMEOUT);

  it('rebuilds a day on request and says how it compared', async () => {
    await open('#/project/checkout-web/worklog/2026-10-12');
    await screen.findByRole('region', { name: 'Monday 12 October 2026' });
    await userEvent.click(screen.getByRole('button', { name: 'Rebuild this day' }));
    expect((await screen.findByText(/^Rebuilt from the cache/)).textContent).toBe('Rebuilt from the cache. There was no page kept to compare it with.');
  });

  it("adds a note to today's page, and exports, through the API it's given", async () => {
    const sample = fixtureWorklog();
    const added: string[] = [];
    const exported: unknown[] = [];
    const api: WorklogApi = {
      ...sample,
      disabled: null,
      month: (d, m) => sample.month(d, m),
      day: (d, x) => sample.day(d, x),
      rebuild: (d, x) => sample.rebuild(d, x),
      addNote: async (toilProject, text) => {
        added.push(text);
        const d: WorklogDay = await sample.day(toilProject, '2026-10-13');
        return { ...d, page: { ...d.page, notes: [{ id: 'n', at: FIXTURE_NOW, by: 'You', text }] } };
      },
      exportTo: async (toilProject, what, folder) => (exported.push({ toilProject, what, folder }), { path: 'C:/Users/you/Documents/worklog-card-payments-2026-10-13.md', bytes: 1234, proposals: [] }),
    };
    await open('#/project/card-payments/worklog', { worklog: api });
    await userEvent.type(await screen.findByRole('textbox', { name: "Add a note to today's page" }), 'Paired on PAY-101');
    await userEvent.click(screen.getByRole('button', { name: 'Add the note' }));
    expect(await screen.findByText('Paired on PAY-101')).toBeTruthy();
    expect(added).toEqual(['Paired on PAY-101']);
    await userEvent.type(screen.getByRole('textbox', { name: 'Folder, as a full path' }), 'C:/Users/you/Documents');
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect((await screen.findByText(/^toil wrote 1234 bytes to/)).textContent).toContain('worklog-card-payments-2026-10-13.md');
    expect(screen.getByText(/names no Confluence space and no GitHub repository/)).toBeTruthy();
    expect(exported).toEqual([{ toilProject: 'card-payments', what: { day: '2026-10-13' }, folder: 'C:/Users/you/Documents' }]);
  });

  it('says plainly when there is no worklog to show', async () => {
    await open('#/project/card-payments/worklog', { worklog: null });
    expect(screen.getByRole('alert').textContent).toBe('This Toil UI keeps no worklog: it has no cache to fold one from.');
  });
});

describe('the stand-up (#345)', () => {
  it('is a route under the worklog, since the last working day or for a range of days', () => {
    expect(parseRoute('#/project/card-payments/worklog/standup')).toEqual({ view: 'standup', toilProject: 'card-payments', from: null, to: null });
    expect(parseRoute('#/project/card-payments/worklog/standup/2026-10-09/2026-10-13')).toEqual({ view: 'standup', toilProject: 'card-payments', from: '2026-10-09', to: '2026-10-13' });
    // One day is a one-day stand-up; anything that isn't a day is named on the page, never dropped quietly.
    expect(parseRoute('#/project/card-payments/worklog/standup/2026-10-09')).toEqual({ view: 'standup', toilProject: 'card-payments', from: '2026-10-09', to: '2026-10-09' });
    expect(parseRoute('#/project/card-payments/worklog/standup/2026-10-09/monday')).toEqual({ view: 'standup', toilProject: 'card-payments', from: null, to: null, ignored: 'monday' });
  });

  it('is linked from the worklog, and folds since the last working day into team lines and a card per person', async () => {
    await open('#/project/card-payments/worklog');
    expect(screen.getByRole('link', { name: 'Stand-up since the last working day' }).getAttribute('href')).toBe('#/project/card-payments/worklog/standup');
    expect((await screen.findByRole('link', { name: 'Stand-up for this day' })).className).toContain('btn--accent');
    cleanup();
    const view = await open('#/project/card-payments/worklog/standup');
    expect(within(tabs('card-payments')).getByRole('link', { name: 'What happened' }).getAttribute('aria-current')).toBe('page');
    expect(await screen.findByRole('heading', { name: 'Stand-up: card-payments, 12 Oct 2026 to 13 Oct 2026' })).toBeTruthy();
    const team = screen.getByRole('region', { name: 'Team' });
    expect(within(team).getAllByRole('listitem')[0]!.textContent).toMatch(/^F1Sprint 42: \d+ working days? left/);
    for (const name of ['Done', 'In progress', 'Blocked', 'Next']) expect(screen.getAllByRole('heading', { name }).length).toBeGreaterThan(0);
    expect(screen.getByRole('region', { name: 'The stand-up as Markdown' }).textContent).toMatch(/^# Stand-up: card-payments, 12 Oct 2026 to 13 Oct 2026/);
    expect(await violations(view.container)).toEqual([]);
  }, AXE_TIMEOUT);

  it('copies as Markdown and as plain text, the same text the report shows', async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => void writes.push(t) }, configurable: true });
    await open('#/project/card-payments/worklog/standup/2026-10-12/2026-10-12');
    await screen.findByRole('heading', { name: 'Stand-up: card-payments, 12 Oct 2026' });
    await userEvent.click(screen.getByRole('button', { name: 'Copy as Markdown' }));
    await userEvent.click(screen.getByRole('button', { name: 'Copy as plain text' }));
    const sample = await fixtureWorklog().standup('card-payments', '2026-10-12', '2026-10-12');
    expect(writes).toEqual([sample.markdown, sample.text]);
    expect(await screen.findByText('Copied the stand-up as plain text.')).toBeTruthy();
  });

  it("asks the agent to write it up, labelled as the agent's, marking the fact lines it names", async () => {
    const asked: string[] = [];
    const agent = scriptedAgent();
    await open('#/project/card-payments/worklog/standup/2026-10-12/2026-10-13', { agent: { ...agent, ask: (d, p, style, chat) => (asked.push(p), agent.ask(d, p, style, chat)) } });
    await screen.findByRole('heading', { name: /^Stand-up: card-payments/ });
    await userEvent.click(screen.getByRole('button', { name: 'Write it up' }));
    expect(await screen.findByRole('heading', { name: 'Written by the agent (a scripted preview, not a model), not by Toil UI' })).toBeTruthy();
    expect(asked).toEqual(['Write up the stand-up for 2026-10-12 to 2026-10-13']);
    expect(screen.getByText(/^Rests on 2 fact lines of the report/)).toBeTruthy();
    expect(document.getElementById('fact-F1')!.getAttribute('data-cited')).toBe('true');
    expect(document.getElementById('fact-F3')!.getAttribute('data-cited')).toBeNull();
  });

  it('says what it ignored in the URL, and shows since the last working day', async () => {
    await open('#/project/card-payments/worklog/standup/yesterday');
    expect((await screen.findByText(/isn't a day as yyyy-mm-dd/)).textContent).toBe("“yesterday” isn't a day as yyyy-mm-dd, so this is since the last working day instead.");
    expect(await screen.findByRole('heading', { name: 'Stand-up: card-payments, 12 Oct 2026 to 13 Oct 2026' })).toBeTruthy();
  });

  it('builds the report again after a write-up when a sync moved it, so the fact numbers are the ones the agent read', async () => {
    const sample = fixtureWorklog();
    let calls = 0;
    const api: WorklogApi = {
      ...sample,
      standup: async (d, f, t) => {
        const r = await sample.standup(d, f, t);
        calls++;
        return calls === 1 ? r : { ...r, markdown: `${r.markdown}
moved`, report: { ...r.report, team: r.report.team.map((l) => ({ ...l, text: `${l.text} (after the sync)` })) } };
      },
    };
    await open('#/project/card-payments/worklog/standup/2026-10-12/2026-10-13', { worklog: api });
    await screen.findByRole('heading', { name: /^Stand-up: card-payments/ });
    await userEvent.click(screen.getByRole('button', { name: 'Write it up' }));
    expect(await screen.findByText(/^A sync landed while the agent wrote/)).toBeTruthy();
    expect(calls).toBe(2);
    expect(screen.getByRole('region', { name: 'Team' }).textContent).toContain('(after the sync)');
    expect(screen.getByRole('heading', { name: /^Written by the agent/ })).toBeTruthy();
  });

  it('exports the range through the API, with the stand-up as what to publish', async () => {
    const sample = fixtureWorklog();
    const exported: unknown[] = [];
    const api: WorklogApi = { ...sample, disabled: null, standup: (d, f, t) => sample.standup(d, f, t), exportTo: async (toilProject, what, folder) => (exported.push({ toilProject, what, folder }), { path: 'C:/Users/you/Documents/standup-card-payments-2026-10-12-to-2026-10-13.md', bytes: 99, proposals: [] }) };
    await open('#/project/card-payments/worklog/standup/2026-10-12/2026-10-13', { worklog: api });
    await screen.findByRole('heading', { name: /^Stand-up: card-payments/ });
    await userEvent.type(screen.getByRole('textbox', { name: 'Folder, as a full path' }), 'C:/Users/you/Documents');
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect((await screen.findByText(/^toil wrote 99 bytes to/)).textContent).toContain('standup-card-payments-2026-10-12-to-2026-10-13.md');
    expect(exported).toEqual([{ toilProject: 'card-payments', what: { from: '2026-10-12', to: '2026-10-13' }, folder: 'C:/Users/you/Documents' }]);
  });

  it('says what was wrong with a range, and when there is no worklog', async () => {
    await open('#/project/card-payments/worklog/standup/2026-10-13/2026-10-12');
    expect((await screen.findByText(/^The range starts/)).textContent).toBe('The range starts (2026-10-13) after it ends (2026-10-12).');
    cleanup();
    await open('#/project/card-payments/worklog/standup', { worklog: null });
    expect(screen.getByRole('alert').textContent).toBe('This Toil UI keeps no worklog, so it has no stand-up to fold from one.');
  });
});
