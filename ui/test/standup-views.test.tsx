// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { fixtureWorklog } from '../src/fixtures/worklog.ts';
import { standupHref } from '../src/format.ts';
import type { WorklogApi } from '../src/worklog.ts';

/**
 * The stand-up page, tight (#345): no title of its own, one Copy text button,
 * a small person beside each name, a dash for an empty row, and the Comments row
 * leading with the questions nobody has answered. Rendered on the sample team,
 * whose Jira issues carry comments, and on a sample project whose don't.
 */

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});
afterEach(() => cleanup());

const TODAY = FIXTURE_NOW.slice(0, 10);

async function open(toilProject = 'sample-team', { worklog = fixtureWorklog(), range }: { worklog?: WorklogApi | null; range?: { from: string; to: string } } = {}) {
  window.location.hash = standupHref(toilProject, range);
  render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview {...(worklog ? { worklog } : {})} />);
  // The report has loaded when its source line is there, or the page has said why not.
  return waitFor(
    () => {
      const page = document.querySelector('.standup') ?? document.querySelector('[role="alert"].failure');
      if (!page) throw new Error('the stand-up has not rendered');
      if (page.classList.contains('standup')) expect(page.querySelector('[data-standup-source]') ?? page.querySelector('[role="alert"]')).toBeTruthy();
      return page as HTMLElement;
    },
    { timeout: 5000 },
  );
}
const person = (page: HTMLElement, name: string) => [...page.querySelectorAll<HTMLElement>('.standup-person')].find((li) => li.querySelector('.standup-name__text')?.textContent === name)!;
const row = (li: HTMLElement, bucket: string) => li.querySelector<HTMLElement>(`.standup-row[data-bucket="${bucket}"]`)!;

describe('the page', () => {
  it('has no title of its own, no lede, and one source line that stays on screen', async () => {
    const page = await open();
    expect(screen.queryAllByRole('heading', { name: /stand-up/i })).toEqual([]);
    expect(page.textContent).not.toMatch(/Built by Toil UI from the worklog/);
    expect(page.textContent).not.toMatch(/grouped by person into done/);
    const source = page.querySelector('[data-standup-source]')!;
    expect(source.textContent).toMatch(/^From the worklog, as of the sync at \d+ \w+ \d\d:\d\d UTC · Comments read for Jira, not for pull requests/);
    expect(within(source as HTMLElement).getByRole('button', { name: 'About the stand-up' })).toBeTruthy();
    expect(page.querySelector('[data-standup-team]')!.textContent).toMatch(/^Sprint 26: day \d+ of \d+, \d+ of \d+ done/);
  });

  it('has one Copy text button, and no Markdown or plain text blocks or per-format buttons', async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => void writes.push(t) }, configurable: true });
    const page = await open();
    expect(screen.getAllByRole('button', { name: /^copy/i }).map((b) => b.textContent)).toEqual(['Copy text']);
    expect(screen.queryByRole('region', { name: /The stand-up as/ })).toBeNull();
    expect(page.textContent).not.toMatch(/Copy as|The stand-up as (Markdown|plain text)|as plain text/);
    await userEvent.click(screen.getByRole('button', { name: 'Copy text' }));
    const sample = await fixtureWorklog().standup('sample-team', '2026-10-12', '2026-10-13');
    expect(writes).toEqual([sample.text]);
    expect(writes[0]!.split('\n')[0]).toMatch(/^Sprint 26: day \d+ of \d+, \d+ of \d+ done · 12 Oct 2026 to 13 Oct 2026/);
    expect(await screen.findByText('Copied the stand-up as text.')).toBeTruthy();
  });

  it('puts a small person beside each name, and an agent gets its own shape', async () => {
    const page = await open();
    const people = [...page.querySelectorAll('.standup-person')];
    expect(people.length).toBeGreaterThanOrEqual(9);
    expect(people.every((li) => li.querySelector('svg.person-glyph'))).toBe(true);
    const copilot = person(page, 'Copilot');
    expect(copilot.querySelector('svg.person-glyph')!.getAttribute('data-glyph')).toBe('agent');
    expect(copilot.textContent).toContain('(agent)');
    expect(person(page, 'A. Chen').querySelector('svg.person-glyph')!.getAttribute('data-glyph')).toBe('person');
  });

  it('shows a dash for an empty row, saying none to a screen reader, and one line for a person with nothing', async () => {
    const page = await open();
    const empty = page.querySelectorAll('.standup-person--empty');
    expect(page.textContent).not.toMatch(/Nothing (done|in progress|blocked)\./);
    for (const dash of page.querySelectorAll('[data-dash="none"]')) {
      expect(dash.textContent).toBe('–none');
      expect(dash.querySelector('[aria-hidden="true"]')!.textContent).toBe('–');
    }
    for (const li of empty) expect(li.children).toHaveLength(2);
    // A person with something still has all five rows, in a fixed order.
    const busy = [...page.querySelectorAll<HTMLElement>('.standup-person:not(.standup-person--empty)')][0]!;
    expect([...busy.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['Done', 'In progress', 'Blocked', 'Next', 'Comments']);
  });

  it('leads the Comments row with the questions nobody has answered, marked and with how long they have waited', async () => {
    const page = await open();
    const okafor = row(person(page, 'D. Okafor'), 'comments');
    const first = okafor.querySelector<HTMLElement>('.standup-chip')!;
    expect(first.dataset.outstanding).toBe('true');
    expect(first.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe('Unanswered question');
    expect(first.querySelector('.standup-excerpt')!.textContent).toContain('rollback plan');
    expect(first.querySelector('.standup-wait')!.textContent).toMatch(/^no reply, [2-9] d$/);
    // One asked yesterday.
    const chen = row(person(page, 'A. Chen'), 'comments').querySelector<HTMLElement>('.standup-chip')!;
    expect(chen.dataset.outstanding).toBe('true');
    expect(chen.querySelector('.standup-wait')!.textContent).toBe('no reply, 1 d');
    // One that was answered is a comment like any other, with no mark.
    const patel = row(person(page, 'R. Patel'), 'comments').querySelector<HTMLElement>('.standup-chip')!;
    expect(patel.querySelector('.standup-excerpt')!.textContent).toContain('trailing space also stripped');
    expect(patel.dataset.outstanding).toBeUndefined();
    expect(patel.querySelector('[role="img"]')).toBeNull();
    // The excerpt links to the comment, the key to the item here.
    expect(first.querySelector('a.standup-excerpt')!.getAttribute('href')).toMatch(/\/browse\/SHOP-\d+\?focusedCommentId=\d+$/);
    expect(first.querySelector('a.standup-key')!.getAttribute('href')).toMatch(/^#\/project\/sample-team\/item\//);
    // Comment text is text: nothing in it became an element.
    expect(okafor.querySelector('.standup-excerpt *')).toBeNull();
  });

  it('folds a long row after three with +N, and the AI agent has a comment too', async () => {
    const page = await open();
    const kn = row(person(page, 'K. Nakamura'), 'comments');
    expect(kn.querySelectorAll('.standup-chip')).toHaveLength(3);
    const more = within(kn).getByRole('button', { name: /^\+\d/ });
    await userEvent.click(more);
    expect(kn.querySelectorAll('.standup-chip').length).toBeGreaterThan(3);
    expect(within(kn).getByRole('button', { name: /^Fewer/ })).toBeTruthy();
    expect(row(person(page, 'Copilot'), 'comments').querySelector('.standup-excerpt')!.textContent).toContain('Opened a pull request');
  });

  it('is short: five rows to a person and the whole team in a few dozen rows, not a card each', async () => {
    const page = await open();
    expect(page.querySelectorAll('h1,h2').length).toBeLessThanOrEqual(10);
    expect(page.querySelectorAll('.standup-row').length).toBeLessThanOrEqual(5 * page.querySelectorAll('.standup-person').length);
    expect(page.querySelectorAll('.panel, .card').length).toBe(0);
  });

  it('says comments were not read where a sample project came with none, and never shows that as none', async () => {
    const page = await open('card-payments');
    expect(page.querySelector('[data-standup-source]')!.textContent).toContain('Comments not read for Jira and pull requests');
    const rows = [...page.querySelectorAll<HTMLElement>('.standup-row[data-bucket="comments"]')];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.querySelector('.standup-chip')).toBeNull();
      expect(r.querySelector('[data-dash="not-read"]')!.textContent).toBe('–not read yet');
    }
  });

  it('has no accessibility violations', async () => {
    const page = await open();
    const result = await axe.run(page, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  }, 20_000);
});

describe('the days', () => {
  it('are a menu of presets that apply at once, with dates only for Custom and no Show these days button', async () => {
    const page = await open();
    const menu = screen.getByRole('combobox', { name: 'Days' }) as HTMLSelectElement;
    expect([...menu.options].map((o) => o.textContent)).toEqual(['Since the last working day', 'Today', 'Last 7 days', 'This sprint', 'Custom…']);
    expect(menu.value).toBe('default');
    expect(screen.queryByRole('button', { name: 'Show these days' })).toBeNull();
    expect(page.querySelectorAll('input[type="date"]')).toHaveLength(0);
    await userEvent.selectOptions(menu, 'today');
    expect(window.location.hash).toBe(standupHref('sample-team', { from: TODAY, to: TODAY }));
    cleanup();
    await open('sample-team', { range: { from: TODAY, to: TODAY } });
    expect((screen.getByRole('combobox', { name: 'Days' }) as HTMLSelectElement).value).toBe('today');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Days' }), 'custom');
    expect(screen.getByLabelText('From')).toBeTruthy();
    expect(screen.getByLabelText('To')).toBeTruthy();
  });

  it('say what was wrong with a range, and what was ignored in the address', async () => {
    await open('sample-team', { range: { from: '2026-10-13', to: '2026-10-12' } });
    expect((await screen.findByText(/^The range starts/)).textContent).toBe('The range starts (2026-10-13) after it ends (2026-10-12).');
    cleanup();
    window.location.hash = `${standupHref('sample-team')}/yesterday`;
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview worklog={fixtureWorklog()} />);
    expect((await screen.findByText(/isn't a day as yyyy-mm-dd/)).textContent).toBe("“yesterday” isn't a day as yyyy-mm-dd, so this is since the last working day instead.");
  });

  it('say so when there is no worklog', async () => {
    await open('sample-team', { worklog: null });
    expect(screen.getByRole('alert').textContent).toBe('This Toil UI keeps no worklog, so it has no stand-up to fold from one.');
  });
});

describe('write it up and export, folded below', () => {
  it("asks the agent to write it up, labelled as the agent's, marking the fact lines it names", async () => {
    const asked: string[] = [];
    const agent = scriptedAgent();
    window.location.hash = standupHref('card-payments', { from: '2026-10-12', to: '2026-10-13' });
    render(<App execute={fixtureExecute().execute} agent={{ ...agent, ask: (d, p, style, chat) => (asked.push(p), agent.ask(d, p, style, chat)) }} now={FIXTURE_NOW} preview worklog={fixtureWorklog()} />);
    await waitFor(() => expect(document.querySelector('[data-standup-source]')).toBeTruthy());
    expect(document.querySelector<HTMLDetailsElement>('[data-standup-writeup-section]')!.open).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Write it up' }));
    expect(await screen.findByRole('heading', { name: 'Written by the agent (a scripted preview, not a model), not by Toil UI' })).toBeTruthy();
    expect(asked).toEqual(['Write up the stand-up for 2026-10-12 to 2026-10-13']);
    expect(screen.getByText(/^Rests on 2 fact lines of the report/)).toBeTruthy();
    expect(document.querySelectorAll('[data-cited]').length).toBeGreaterThan(0);
  });

  it('builds the report again after a write-up when a sync moved it, so the fact numbers are the ones the agent read', async () => {
    const sample = fixtureWorklog();
    let calls = 0;
    const api: WorklogApi = {
      ...sample,
      standup: async (d, f, t) => {
        const r = await sample.standup(d, f, t);
        calls++;
        return calls === 1 ? r : { ...r, markdown: `${r.markdown}\nmoved`, report: { ...r.report, sprintLine: 'Sprint 42: moved by a sync' } };
      },
    };
    window.location.hash = standupHref('card-payments', { from: '2026-10-12', to: '2026-10-13' });
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview worklog={api} />);
    await waitFor(() => expect(document.querySelector('[data-standup-source]')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Write it up' }));
    expect(await screen.findByText(/^A sync landed while the agent wrote/)).toBeTruthy();
    expect(calls).toBe(2);
    expect(document.querySelector('[data-standup-team]')!.textContent).toContain('Sprint 42: moved by a sync');
  });

  it("cuts the team line's chips inside their box, never in the text, and keeps the whole fact on hover (#644)", async () => {
    window.location.hash = standupHref('settlement', { from: '2026-10-05', to: '2026-10-05' });
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview worklog={fixtureWorklog()} />);
    await waitFor(() => expect(document.querySelector('[data-standup-team] .standup-chip')).toBeTruthy());
    const chips = [...document.querySelectorAll<HTMLElement>('[data-standup-team] .standup-chip')];
    const long = chips.find((c) => c.querySelector('.standup-title')!.textContent === 'moved from Payments\\Sprint 41 to Payments\\Sprint 42, by K. Nakamura')!;
    expect(long).toBeTruthy();
    expect(long.hasAttribute('data-truncate')).toBe(true);
    expect(long.title).toContain('moved from Payments\\Sprint 41 to Payments\\Sprint 42, by K. Nakamura');
  });

  it('exports the range as a Markdown file through the API', async () => {
    const sample = fixtureWorklog();
    const exported: unknown[] = [];
    const api: WorklogApi = { ...sample, disabled: null, standup: (d, f, t) => sample.standup(d, f, t), exportTo: async (toilProject, what, folder) => (exported.push({ toilProject, what, folder }), { path: 'C:/Users/you/Documents/standup-card-payments-2026-10-12-to-2026-10-13.md', bytes: 99, proposals: [] }) };
    window.location.hash = standupHref('card-payments', { from: '2026-10-12', to: '2026-10-13' });
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview worklog={api} />);
    await waitFor(() => expect(document.querySelector('[data-standup-source]')).toBeTruthy());
    expect(document.querySelector<HTMLDetailsElement>('[data-standup-export-section]')!.open).toBe(false);
    await userEvent.type(screen.getByRole('textbox', { name: 'Folder, as a full path' }), 'C:/Users/you/Documents');
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect((await screen.findByText(/^toil wrote 99 bytes to/)).textContent).toContain('standup-card-payments-2026-10-12-to-2026-10-13.md');
    expect(exported).toEqual([{ toilProject: 'card-payments', what: { from: '2026-10-12', to: '2026-10-13' }, folder: 'C:/Users/you/Documents' }]);
  });
});
