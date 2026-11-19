// @vitest-environment jsdom
// The worklog is rebuilt from the cache on request, a convenience timesheets have never offered.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_NOW } from '../src/fixtures/execute.ts';
import { fixtureWorklog } from '../src/fixtures/worklog.ts';
import { parseRoute } from '../src/App.tsx';
import { setHomes } from '../src/home-path.ts';
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
    expect(within(tabs('card-payments')).getByRole('link', { name: 'Team' }).getAttribute('aria-current')).toBe('page');
    expect(document.querySelector('[data-team-page="worklog"]')!.getAttribute('aria-current')).toBe('page');
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
    // The sample's one sentence is said once on the page, not under Notes and again under Export.
    expect(within(day).getAllByText(/^This is sample data, so it keeps no notes and writes no files/)).toHaveLength(1);
    expect(within(day).queryByRole('heading', { name: 'Export and publish' })).toBeNull();
    expect(within(day).getByRole('region', { name: 'The page as Markdown' }).textContent).toMatch(/^# Worklog: card-payments, Monday 12 October 2026/);
    expect(await violations(container)).toEqual([]);
  }, AXE_TIMEOUT);

  it('names the sections with nothing in them in one muted line, as the stand-up does, instead of a heading and a sentence each', async () => {
    await open('#/project/checkout-web/worklog/2026-10-12');
    const day = await screen.findByRole('region', { name: 'Monday 12 October 2026' });
    for (const sentence of ['No pull requests opened, reviewed, merged or declined.', 'No builds or deployments failed or recovered.', 'No agent runs.', 'No notes.', 'No status changes, sprint changes or new blockers recorded.']) expect(day.textContent).not.toContain(sentence);
    const none = day.querySelector('[data-empties="none"]');
    const named = (none?.textContent ?? '').replace(/^Nothing recorded: /, '').split('·').map((t) => t.trim());
    for (const title of ['Work items', 'Pull requests', 'Builds and deployments', 'Agent runs', 'Notes']) {
      const heading = within(day).queryByRole('heading', { name: title }) !== null;
      expect(heading !== named.includes(title), title).toBe(true);
    }
    // A dash means "not read yet" (principle 12): a section read and empty is said in words.
    if (none) {
      expect(none.textContent).toMatch(/^Nothing recorded: /);
      expect(none.querySelector('[data-dash]')).toBeNull();
    }
  });

  it("keeps the calendar's footnote and the export's explanation behind an (i)", async () => {
    await open('#/project/checkout-web/worklog/2026-10-12');
    const day = await screen.findByRole('region', { name: 'Monday 12 October 2026' });
    expect(document.body.textContent).not.toContain('A number under a day is how many lines');
    expect(document.body.textContent).not.toContain('Export writes the Markdown');
    await userEvent.click(screen.getByRole('button', { name: 'About the calendar' }));
    expect((await screen.findByRole('dialog', { name: 'About the calendar' })).textContent).toMatch(/A number under a day is how many lines its page has.*The cache keeps \d+ days after each sync, and so do the pages\./);
    expect(day).toBeTruthy();
  });

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
  it('is a tab of its own, since the last working day or for a range of days', () => {
    expect(parseRoute('#/project/card-payments/worklog/standup/2026-10-09')).toEqual({ view: 'standup', toilProject: 'card-payments', from: '2026-10-09', to: '2026-10-09' }); // the old address redirects
    expect(parseRoute('#/project/card-payments/standup')).toEqual({ view: 'standup', toilProject: 'card-payments', from: null, to: null });
    expect(parseRoute('#/project/card-payments/standup/2026-10-09/2026-10-13')).toEqual({ view: 'standup', toilProject: 'card-payments', from: '2026-10-09', to: '2026-10-13' });
    // One day is a one-day stand-up; anything that isn't a day is named on the page, never dropped quietly.
    expect(parseRoute('#/project/card-payments/standup/2026-10-09')).toEqual({ view: 'standup', toilProject: 'card-payments', from: '2026-10-09', to: '2026-10-09' });
    expect(parseRoute('#/project/card-payments/standup/2026-10-09/monday')).toEqual({ view: 'standup', toilProject: 'card-payments', from: null, to: null, ignored: 'monday' });
  });
});

describe("the worklog page's own path (#653)", () => {
  afterEach(() => setHomes(null));

  it('is shown from ~, tooltip included, so the account name stays off screen, and copies whole', async () => {
    setHomes(['/Users/someone']);
    const file = '/Users/someone/toil-demo-home/.toil-ui/cache/worklog/card-payments/2026-10/2026-10-13.md';
    const base = fixtureWorklog();
    const worklog: WorklogApi = { ...base, day: async (toilProject, day) => ({ ...(await base.day(toilProject, day)), file }) };
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => void writes.push(t) }, configurable: true });
    const { container } = await open('#/project/card-payments/worklog', { worklog });
    // Where the page is kept sits with the Markdown, one press in (#657).
    await screen.findByText(/^Kept at/);
    const path = container.querySelector<HTMLElement>('.worklog-page .l-path__text')!;
    expect(path.textContent).toBe('~/toil-demo-home/.toil-ui/cache/worklog/card-payments/2026-10/2026-10-13.md');
    expect(path.title).toBe(path.textContent);
    expect(container.textContent).not.toContain('someone');
    await userEvent.click(screen.getByRole('button', { name: "Copy page's path" }));
    await waitFor(() => expect(writes).toEqual([file]));
  });
});
