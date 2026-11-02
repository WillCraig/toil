import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { MAX_HISTORY_ANSWER, MAX_HISTORY_TURNS, type AdapterList, type Agent, type AskExtra } from '../src/agent.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { askBar, openChat } from './chat.ts';
import { CANNED, FIXTURE_NOW, callKey, fixtureExecute, type Canned } from '../src/fixtures/execute.ts';
import type { Envelope, Execute, WorkItem } from '../src/toil.ts';
import type { ConfigApi } from '../src/config.ts';
import { fixtureConfig } from '../src/fixtures/config.ts';
import type { AgentSettingsPanelProps } from '../src/agent-settings.tsx';
import type { AgentSettings, AgentStatus } from '../src/server-client.ts';
import { fixtureWorklog } from '../src/fixtures/worklog.ts';
import { parseRoute } from '../src/App.tsx';
import { columnSteps, dropVerdict } from '../src/views/Board.tsx';
import type { WorklogApi, WorklogDay } from '../src/worklog.ts';
import type { AnalysesApi } from '../src/analyses.ts';
import { fixtureAnalyses } from '../src/fixtures/analyses.ts';

/**
 * The views, rendered against the fixture `execute()` and the scripted Agent:
 * the same pair the site preview runs on, used here as the test harness (#206).
 */

const item = (dossier: string, id: string) => `#/dossier/${dossier}/item/${encodeURIComponent(id)}`;
const ROUTES = ['#/', '#/dossier/card-payments', '#/dossier/card-payments/board', '#/dossier/card-payments/dependencies', '#/dossier/card-payments/analyses', '#/dossier/card-payments/analyses/sample-analysis-2', '#/dossier/settlement', '#/dossier/checkout-web', '#/dossier/checkout-web/prs', '#/dossier/card-payments/prs', '#/dossier/checkout-web/people', '#/dossier/card-payments/people', '#/dossier/settlement/people', '#/dossier/card-payments/board/person%3AJ.%20Smith', '#/dossier/card-payments/worklog', '#/dossier/checkout-web/worklog/2026-10-12', item('card-payments', 'corp-jira:PAY-101'), '#/dossier/card-payments/command-center', '#/dossier/settlement/command-center', '#/settings', '#/settings/dossiers', '#/settings/toil', '#/settings/usage', '#/settings/agent'];

async function open(hash: string, { preview = true, execute = fixtureExecute().execute, agent = scriptedAgent(), config = fixtureConfig(), agentSettings, worklog = fixtureWorklog(), analyses = fixtureAnalyses() }: { preview?: boolean; execute?: Execute; agent?: Agent; config?: ConfigApi; agentSettings?: AgentSettingsPanelProps; worklog?: WorklogApi | null; analyses?: AnalysesApi | null } = {}) {
  window.location.hash = hash;
  const view = render(<App execute={execute} agent={agent} config={config} now={FIXTURE_NOW} preview={preview} {...(agentSettings ? { agentSettings } : {})} {...(worklog ? { worklog } : {})} {...(analyses ? { analyses } : {})} />);
  await screen.findByRole('heading', { level: 1 }, { timeout: 3000 });
  return view;
}

/**
 * For a case that renders a whole view and runs axe over it (a dashboard is
 * about 1,600 elements in jsdom): about a second on a laptop, two to five on
 * a Windows runner (#328), so it gets more than Vitest's 5 s default.
 */
const AXE_TIMEOUT = 20_000;

/**
 * axe's rules, less colour contrast, which jsdom can't compute (themes.test.ts checks the tokens).
 * Only violations are read, so axe skips building the passes (#328).
 */
async function violations(container: HTMLElement) {
  const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

const panel = (name: string | RegExp) => screen.getByRole('region', { name });
/** A dossier's tab bar (#394). */
const tabs = (dossier: string) => screen.getByRole('navigation', { name: `${dossier} views` });
/** Opens a metric's full chart from the Overview's strip (#394), and returns its dialog. */
async function metric(name: RegExp) {
  await userEvent.click(screen.getByRole('button', { name }));
  return screen.findByRole('dialog');
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('every view', () => {
  it.each(ROUTES)('%s carries the preview banner, the views and when the data was read', async (hash) => {
    await open(hash);
    expect(screen.getByRole('note')?.textContent).toContain('Toil UI beta, on sample data.');
    const nav = screen.getByRole('navigation', { name: 'Views' });
    expect(within(nav).getAllByRole('link')[0]!.textContent).toBe('Dossiers');
    expect(screen.getByText(/Sample data read 13 Oct 2026, 08:00 UTC through toil, read-only/)).toBeTruthy();
  });

  it.each(ROUTES.flatMap((r) => [[r, 'plain'], [r, 'crate']]))('%s in %s has no axe violations', async (hash, theme) => {
    localStorage.setItem('toil-ui.theme', JSON.stringify({ theme }));
    const { container } = await open(hash);
    expect(document.documentElement.dataset.theme).toBe(theme);
    expect(await violations(container)).toEqual([]);
  }, AXE_TIMEOUT);

  it('names the app "toil UI" in the header, by its own words: the wordmark, then the sticker, read as one link home (#272, #277)', async () => {
    await open('#/dossier/settlement');
    const home = screen.getByRole('link', { name: 'toil UI' });
    expect(home.getAttribute('href')).toBe('#/');
    expect(home.querySelector('.wordmark')?.textContent).toBe('toil');
    expect(home.querySelector('.sticker')?.textContent).toBe('UI');
  });

  it('has no banner outside the preview', async () => {
    await open('#/', { preview: false });
    expect(screen.queryByRole('note')).toBeNull();
  });

  it("marks the current view in the navigation, and the current tab in the dossier's tabs (#394)", async () => {
    await open('#/dossier/settlement');
    expect(within(tabs('settlement')).getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Dossiers' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('settlement');
  });
});

describe('the dossier list', () => {
  /** The cards once every one has read its dossier. */
  const cards = async () => {
    await waitFor(() => expect(document.querySelectorAll('.count-strip')).toHaveLength(3), { timeout: 8000 });
    return screen.getAllByRole('article');
  };
  const badges = (card: HTMLElement) => within(within(card).getByRole('list', { name: 'Sources' })).getAllByRole('listitem').map((li) => li.firstChild?.textContent);

  it('lists three dossiers, each mixing its own sources as badges, with a link to its dashboard; the one with most in motion leads', async () => {
    await open('#/');
    const all = await cards();
    expect(all.map((c) => within(c).getByRole('heading').textContent)).toEqual(['card-payments', 'settlement', 'checkout-web']);
    expect(all[0]!.className).toContain('dossier-card--lead');
    expect(badges(all[0]!)).toEqual(['Bitbucket', 'Jenkins', 'Jira', 'OpenShift']);
    expect(badges(all[1]!)).toEqual(['Azure DevOps']);
    expect(badges(all[2]!)).toEqual(['Bitbucket', 'GitHub', 'OpenShift']);
    expect(within(all[2]!).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual(['#/dossier/checkout-web', '#/settings/dossiers/checkout-web/sources']);
    expect(within(all[2]!).getByRole('link', { name: "Edit checkout-web's sources" })).toBeTruthy();
  });

  it("previews each dossier's sprint, counts and people from the data its dashboard reads", async () => {
    await open('#/');
    const [pay, settle, web] = await cards();
    expect(pay!.textContent).toContain('Sprint 42 3 working days left of 10, 3 of 21 points done');
    expect(within(pay!).getByRole('img', { name: 'Burn-up: 3 of 21 points done' })).toBeTruthy();
    expect(within(pay!).getByRole('list', { name: 'Counts' }).textContent).toBe('3 in progress2 blocked1 PR waits on review');
    expect(within(settle!).getByRole('list', { name: 'Counts' }).textContent).toBe('3 in progress1 blocked0 PRs wait on review');
    expect(within(web!).getByRole('list', { name: 'Counts' }).textContent).toBe('2 in progress0 blocked2 PRs wait on review');
    expect(within(pay!).getByRole('list', { name: /^People: / }).getAttribute('aria-label')).toContain('J. Smith');
    expect(within(pay!).getByRole('img', { name: 'J. Smith' })).toBeTruthy();
    // The preview syncs nothing, and this browser has never opened a dashboard.
    expect(pay!.textContent).toContain('Sample data.');
    expect(pay!.textContent).not.toContain('since you last looked');
  });

  it('leads with the dossier opened most recently, and counts what changed since', async () => {
    localStorage.setItem('toil-ui:looked', JSON.stringify({ 'checkout-web': '2026-10-12T00:00:00Z', settlement: '2026-10-01T00:00:00Z' }));
    await open('#/');
    const all = await cards();
    expect(within(all[0]!).getByRole('heading').textContent).toBe('checkout-web');
    expect(all[0]!.className).toContain('dossier-card--lead');
    expect(all[0]!.textContent).toContain('3 changes since you last looked.');
  });

  it('remembers when a dashboard was opened, for its card', async () => {
    await open('#/dossier/settlement');
    await waitFor(() => expect(JSON.parse(localStorage.getItem('toil-ui:looked') ?? '{}')).toHaveProperty('settlement'));
  });

  it('says when each dossier was synced, where the server syncs', async () => {
    window.location.hash = '#/';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview={false} synced={{ settlement: { at: '2026-10-13T07:00:00Z', status: 'partial' } }} />);
    const all = await cards();
    expect(all.find((c) => c.textContent?.startsWith('settlement'))!.textContent).toContain('Synced 13 Oct 2026, 07:00 UTC, some sources failed.');
    expect(all.find((c) => c.textContent?.startsWith('checkout-web'))!.textContent).toContain('Not synced yet.');
  });

  it('says which commands fed it', async () => {
    await open('#/');
    expect(screen.getByText(/Fed by/).textContent).toContain('toil dossiers list');
    expect(screen.getByText(/Fed by/).textContent).toContain('toil dossiers show ×3');
  });
});

describe("editing a dossier's name and description in place (#342)", () => {
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
  const meta = { command: 'dossiers describe', durationMs: 1, version: '0.0.0', contractVersion: 1 };
  const okEnvelope = (data: Record<string, unknown>) => ({ ok: true, data, error: null, meta }) as unknown as Envelope;

  it('has no pencil where changes are off (the preview)', async () => {
    await open('#/');
    expect(screen.queryByRole('button', { name: /^Rename / })).toBeNull();
  });

  it('saves a description with Enter through toil dossiers describe, and Escape cancels', async () => {
    const user = userEvent.setup();
    const config = editable((input) => okEnvelope({ name: input.dossier, description: input.description, renamed: null, changed: true }));
    await open('#/dossier/settlement', { config });
    await user.click(screen.getByRole('button', { name: "Edit settlement's description" }));
    const field = screen.getByRole('textbox', { name: 'Description of settlement' });
    await user.clear(field);
    await user.type(field, 'Nightly settlement{Escape}');
    expect(config.runs).toEqual([]);
    expect(screen.queryByRole('textbox', { name: 'Description of settlement' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: "Edit settlement's description" }));
    await user.click(screen.getByRole('button', { name: "Edit settlement's description" }));
    await user.clear(screen.getByRole('textbox', { name: 'Description of settlement' }));
    await user.type(screen.getByRole('textbox', { name: 'Description of settlement' }), 'Nightly settlement{Enter}');
    await waitFor(() => expect(config.runs).toEqual([{ command: 'dossiers describe', input: { dossier: 'settlement', description: 'Nightly settlement' } }]));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Description of settlement' })).toBeNull());
    // Written into what's loaded: the dashboard isn't read again for a new description.
    expect(document.querySelector('.dossier-bar__desc')!.textContent).toBe('Nightly settlement✎');
  });

  it("shows toil's message and fix when it refuses, and keeps the field open", async () => {
    const user = userEvent.setup();
    const config = editable(() => ({ ok: false, data: null, error: { code: 'INVALID_INPUT', message: 'You already have a dossier named "settlement".', fix: 'Choose another name.' }, meta }) as unknown as Envelope);
    await open('#/dossier/card-payments', { config });
    await user.click(screen.getByRole('button', { name: 'Rename card-payments' }));
    const field = screen.getByRole('textbox', { name: 'New name for card-payments' });
    await user.clear(field);
    await user.type(field, 'settlement{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('You already have a dossier named "settlement". Fix: Choose another name.');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('textbox', { name: 'New name for card-payments' })).toBeTruthy();
  });

  it('follows a rename to the dossier under its new name, keeping what this browser remembers', async () => {
    const user = userEvent.setup();
    localStorage.setItem('toil-ui:looked', JSON.stringify({ 'card-payments': '2026-10-12T00:00:00Z' }));
    const config = editable((input) => okEnvelope({ name: input.name, description: null, renamed: { from: input.dossier, to: input.name }, changed: true }));
    await open('#/dossier/card-payments/people', { config });
    window.location.hash = '#/dossier/card-payments';
    await screen.findByRole('button', { name: 'Rename card-payments' });
    await user.click(screen.getByRole('button', { name: 'Rename card-payments' }));
    const field = screen.getByRole('textbox', { name: 'New name for card-payments' });
    await user.clear(field);
    await user.type(field, 'payments-v2{Enter}');
    await waitFor(() => expect(window.location.hash).toBe('#/dossier/payments-v2'));
    expect(config.runs[0]).toEqual({ command: 'dossiers describe', input: { dossier: 'card-payments', name: 'payments-v2' } });
    expect(JSON.parse(localStorage.getItem('toil-ui:looked')!)).toHaveProperty('payments-v2');
  });

  it("puts the dossier's name, description, sources and sprint day in its top row (#394)", async () => {
    await open('#/dossier/card-payments');
    const bar = document.querySelector('.dossier-bar') as HTMLElement;
    expect(bar.textContent).toContain('Card payments v2');
    expect(bar.textContent).toContain('Sprint 42: day 7 of 10');
    expect(within(bar).getByRole('list', { name: 'Sources' })).toBeTruthy();
    expect(within(bar).getByRole('region', { name: 'Ask about card-payments' })).toBeTruthy();
  });
});

describe('the pull requests view', () => {
  it('ranks the open pull requests by wait, with what each waits on, its author kind, items and flags', async () => {
    await open('#/dossier/checkout-web/prs');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Pull requests');
    const rows = within(panel('Waiting now')).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual([
      expect.stringContaining('payments-web #51 Retry the address lookup once'),
      expect.stringContaining('checkout-sdk #12 Format receipt totals'),
      expect.stringContaining('payments-web #52 Saved-card picker'),
      expect.stringContaining('payments-web #53 Keep focus'),
    ]);
    expect(rows[0]!.textContent).toContain('Checks');
    expect(rows[0]!.textContent).toContain('for 2 working days: its checks are failing');
    expect(rows[0]!.textContent).toContain('· Agent (trailer: Co-Authored-By: Claude');
    expect(rows[0]!.textContent).toContain('No linked work item');
    expect(rows[1]!.textContent).toContain('· Agent (branch: branch copilot/receipt-currency)');
    expect(rows[2]!.textContent).toContain('L (325 lines, 3 files)');
    expect(rows[3]!.textContent).toContain('Draft (its author)');
  });

  it('lists the flags with their evidence, and every flow figure with its sample size, split by author kind', async () => {
    await open('#/dossier/checkout-web/prs');
    const flags = panel('Flags');
    expect(within(flags.querySelector('ul.rows') as HTMLElement).getAllByRole('listitem').map((li) => li.textContent!.split(':')[0])).toEqual([
      'Work item done, pull request still open',
      'Merged, work item not done',
      'No first review in 2 working days',
      'Checks failing for over a day',
      'No linked work item',
    ]);
    const flow = panel('Flow');
    const pickup = within(flow).getAllByRole('row').find((r) => r.textContent!.includes('Pickup'))!;
    expect(within(pickup).getAllByRole('cell').map((c) => c.textContent)).toEqual([
      expect.stringContaining('(n=4'),
      expect.stringContaining('(n=3'),
      'AgentsNo data (n=0)',
      expect.stringContaining('(n=1)'),
    ]);
    expect(flow.textContent).toContain('1 merged pull request has no merge time on record');
  });

  it('suggests reviewers from CODEOWNERS as proposals, never applying them', async () => {
    await open('#/dossier/checkout-web/prs');
    const reviewers = panel('Suggested reviewers');
    expect(reviewers.textContent).toContain('imagile/payments-web: CODEOWNERS read from .github/CODEOWNERS.');
    expect(reviewers.textContent).toContain('Ask bo-web to review payments-web #51');
    expect(reviewers.textContent).toContain("toil github pr add-reviewers '51'");
  });

  it("is a tab of the dossier's, current on its own page", async () => {
    await open('#/dossier/settlement/prs');
    const tab = within(tabs('settlement')).getByRole('link', { name: 'Pull requests' });
    expect(tab.getAttribute('href')).toBe('#/dossier/settlement/prs');
    expect(tab.getAttribute('aria-current')).toBe('page');
  });
});

describe('a dashboard', () => {
  it.each([
    ['card-payments', ['jira issue search', 'jira issue history'], ['bitbucket pr list', 'bitbucket pr get'], ['jenkins pipeline runs'], ['openshift deployment list']],
    ['settlement', ['ado work-item iterations', 'ado work-item search', 'ado work-item get-many', 'ado work-item history'], ['ado pr list', 'ado pr get'], ['ado run list'], ['ado run list']],
    ['checkout-web', ['github project items', 'github issue get', 'github issue history'], ['github pr list', 'github pr get', 'bitbucket pr list', 'bitbucket pr get'], ['github pr get'], ['openshift deployment list']],
  ])('%s names the commands that fed each panel', async (name, work, prs, builds, deployments) => {
    await open(`#/dossier/${name}/board`);
    const fed = (region: HTMLElement) => within(region).getByText(/Fed by/).textContent;
    for (const c of work) expect(fed(panel('Sprint 42 board'))).toContain(`toil ${c}`);
    for (const c of prs) expect(fed(panel('Stories, pull requests, builds and deployments'))).toContain(`toil ${c}`);
    for (const c of builds) expect(fed(panel('Builds'))).toContain(`toil ${c}`);
    for (const c of deployments) expect(fed(panel('Deployments'))).toContain(`toil ${c}`);
  });

  it('shows a story with its pull request, its build and where it runs, in one row', async () => {
    await open('#/dossier/card-payments/board');
    const row = (name: RegExp) => screen.getAllByRole('rowheader', { name }).find((r) => r.closest('.trace'))!.closest('tr')!;
    expect(row(/PAY-105/).textContent).toContain('#298 PAY-105 Show the last four digits on receipts');
    expect(row(/PAY-105/).textContent).toContain('SUCCESS');
    expect(row(/PAY-105/).textContent).toContain('dev');
    expect(row(/PAY-101/).textContent).toContain('FAILURE');
    expect(row(/PAY-101/).textContent).toContain('Latest build failed');
    expect(row(/PAY-101/).textContent).toContain('Not deployed');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Only items with something to check' }));
    const trace = document.querySelector('.trace table') as HTMLElement;
    expect(within(trace).getAllByRole('rowheader').map((r) => r.textContent)).toEqual([expect.stringContaining('PAY-101')]);
  });

  it('lists what each environment runs and what that includes', async () => {
    await open('#/dossier/checkout-web/board');
    const deployments = panel('Deployments');
    const envs = within(deployments).getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(envs).toEqual(['staging', 'prod']);
    expect(deployments.textContent).toContain('2026.10.12, commit 5a7e3f1');
    expect(deployments.textContent).toContain('Includes 3 merged pull requests, for GitHub payments-web#44');
    expect(deployments.textContent).toContain('Includes 1 merged pull request, none for this sprint');
  });

  it("shows the sprint's figures and each risk's reasons", async () => {
    await open('#/dossier/settlement');
    const sprint = await metric(/^Burn-up /);
    expect(sprint.querySelector('h2')!.textContent).toBe('Sprint 42: day 7 of 9');
    expect(within(sprint).getByRole('list', { name: 'Sprint figures' }).textContent).toContain('Done1 of 16points, 2 items');
    expect(sprint.textContent).toContain('Blocked by Azure DevOps 2302');
    expect(sprint.textContent).toContain('Points totals leave out items estimated in other units: Azure DevOps 2305');
  });

  it('answers a starter question about the dossier, streaming, with links to every item it cites', async () => {
    await open('#/dossier/settlement');
    const chat = await openChat('settlement');
    await userEvent.click(within(chat).getByRole('button', { name: 'Where is this work deployed?' }));
    const answer = await within(chat).findByRole('heading', { level: 3, name: 'Where is this work deployed?' });
    const pane = answer.parentElement!;
    await waitFor(() => expect(pane.textContent).toMatch(/Answered by: a scripted preview, not a model, in \d+ s\./));
    expect(within(pane).getAllByRole('link').map((a) => a.getAttribute('href'))).toContain(item('settlement', 'corp-ado:2305'));
    // One citation is one item, not "1 items" (#319).
    expect(pane.textContent).toMatch(/Cites (1 item\.|([02-9]|\d\d+) items\.)/);
    expect(within(chat).getByRole('log').getAttribute('aria-busy')).toBe('false');
    expect(within(chat).getByText('You asked:', { exact: false }).closest('.bubble')!.textContent).toBe('You asked: Where is this work deployed?');
  });

  it("shows the agent's proposals as cards to review, with the command and no way to apply them", async () => {
    await open('#/dossier/settlement');
    const chat = await openChat('settlement');
    await userEvent.click(within(chat).getByRole('button', { name: "What's at risk in this dossier?" }));
    const card = await within(chat).findByRole('article', { name: 'Proposal: Move 2303 to Sprint 43' });
    expect(card.textContent).toContain('Proposed change, not applied');
    // jsdom has no platform, so the viewer's shell is POSIX; the toggle switches it, for every card.
    expect(within(card).getByText(/^toil ado work-item update/).textContent).toBe("toil ado work-item update '2303' --dossier 'settlement' --field 'System.IterationPath=Payments\\Sprint 43' --allow-write");
    expect(within(card).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['About the write gate', 'Copy command', 'Dismiss']);
    await userEvent.click(within(card).getByRole('radio', { name: 'PowerShell' }));
    expect(within(card).getByRole('radio', { name: 'PowerShell' })).toHaveProperty('checked', true);
    expect(within(card).getByText(/^toil ado work-item update/).textContent).not.toContain('"');
    expect(localStorage.getItem('toil-ui.shell')).toBe('powershell');
    await userEvent.click(within(card).getByRole('button', { name: 'Dismiss' }));
    expect(within(chat).queryByRole('article', { name: /^Proposal:/ })).toBeNull();
  });

  it('answers a typed question, and says plainly when the preview has no answer for it', async () => {
    await open('#/dossier/checkout-web');
    // Typed into the bar and sent with Enter: the focused view opens with the question in it.
    await userEvent.type(within(askBar('checkout-web')).getByRole('textbox', { name: 'Your question' }), 'Should we cut scope?{Enter}');
    const chat = await screen.findByRole('dialog', { name: 'Ask about checkout-web' });
    await waitFor(() => expect(chat.textContent).toMatch(/answers only its starter questions/));
    expect(within(chat).getByRole('textbox', { name: 'Your question' })).toHaveProperty('value', '');
  });
});

describe('the views on a dashboard (#252, #253)', () => {
  it('flags each card that needs attention on the board, counts them on its tab, and filters to them (#394)', async () => {
    await open('#/dossier/card-payments/board');
    const board = panel('Sprint 42 board');
    const cards = () => within(board).getAllByRole('listitem').filter((li) => li.classList.contains('card'));
    const flagged = () => cards().filter((li) => li.classList.contains('card--attention'));
    const keys = () => flagged().map((li) => within(li).getAllByRole('link')[0]!.textContent).sort();
    expect(keys()).toEqual(['PAY-101', 'PAY-102', 'PAY-103', 'PAY-104']);
    expect(flagged()[0]!.querySelector('.card-flag')!.textContent).toBe('Needs attention');
    expect(within(tabs('card-payments')).getByRole('link', { name: 'Board, 4 items need attention' })).toBeTruthy();
    expect(cards().length).toBeGreaterThan(4);
    await userEvent.click(within(board).getByRole('checkbox', { name: 'Needs attention only (4)' }));
    expect(cards()).toHaveLength(4);
    expect(keys()).toEqual(['PAY-101', 'PAY-102', 'PAY-103', 'PAY-104']);
  });

  it('puts each sprint item on the board under its status category, with its own status word and insights', async () => {
    await open('#/dossier/settlement/board');
    const board = panel('Sprint 42 board');
    const col = (name: string) => within(board).getByRole('region', { name: new RegExp(`^${name}`) });
    const cards = (region: HTMLElement) => within(region).getAllByRole('listitem').filter((li) => li.classList.contains('card'));
    expect(cards(col('To do')).map((c) => within(c).getAllByRole('link')[0]!.textContent)).toEqual(['2303', '2306']);
    const card = cards(col('In progress')).find((li) => li.textContent?.includes('2304'))!;
    expect(card.textContent).toContain('Active · In progress');
    expect(card.textContent).toContain('M. Lind');
    // The source and the estimate share a line; each insight is an icon with its word kept as text and tooltip.
    expect(card.querySelector('.card-meta .field')!.textContent).toMatch(/^Azure DevOps · /);
    const aging = within(card).getByText('Aging').closest('li')!;
    expect(aging.getAttribute('title')).toBe('Aging');
    expect(aging.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('carries no buttons on its cards: the whole card is the handle, named by its key and title', async () => {
    await open('#/dossier/card-payments/board');
    const board = panel('Sprint 42 board');
    const cards = within(board).getAllByRole('listitem').filter((li) => li.classList.contains('card'));
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) expect(within(c).queryAllByRole('button')).toEqual([]);
    const grip = within(board).getByRole('group', { name: 'PAY-102 Store tokens in the vault' });
    expect(grip.tabIndex).toBe(0);
    expect(grip.getAttribute('aria-roledescription')).toBe('draggable card');
    expect(grip.getAttribute('aria-keyshortcuts')).toBe('M ContextMenu');
    expect(document.getElementById(grip.getAttribute('aria-describedby')!)!.textContent).toMatch(/press Space or Enter.*arrow keys.*Escape to cancel.*Press M or the Menu key/);
  });

  it('opens the item on a click anywhere on the card', async () => {
    await open('#/dossier/card-payments/board');
    const grip = within(panel('Sprint 42 board')).getByRole('group', { name: 'PAY-102 Store tokens in the vault' });
    await userEvent.click(within(grip).getByText('Store tokens in the vault'));
    await waitFor(() => expect(window.location.hash).toBe(item('card-payments', 'corp-jira:PAY-102')));
  });

  it("turns a move from the card's context menu into a proposal card naming the toil command, and changes nothing", async () => {
    const fixture = fixtureExecute();
    await open('#/dossier/card-payments/board', { execute: fixture.execute });
    const before = fixture.calls.length;
    const board = panel('Sprint 42 board');
    const grip = within(board).getByRole('group', { name: 'PAY-102 Store tokens in the vault' });
    fireEvent.contextMenu(grip);
    const menu = await screen.findByRole('menu', { name: 'PAY-102 Store tokens in the vault' });
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Open', 'In progress', 'Done']);
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'In progress' }));
    expect(screen.queryByRole('menu')).toBeNull();
    const card = within(board).getByRole('article', { name: 'Proposal: Move PAY-102 to In progress' });
    expect(card.textContent).toContain("toil jira issue transition 'PAY-102' --dossier 'card-payments' --transition 'In Progress' --allow-write");
    expect(screen.getByText(/Proposed: Move PAY-102 to In progress. Nothing has changed/)).toBeTruthy();
    // The card is still where Jira says it is, and nothing was asked of toil.
    expect(within(within(board).getByRole('region', { name: /^To do/ })).getByText('Store tokens in the vault')).toBeTruthy();
    expect(fixture.calls.length).toBe(before);
  });

  it('opens the same menu with M on the focused card, and only on the card itself', async () => {
    await open('#/dossier/card-payments/board');
    const board = panel('Sprint 42 board');
    const grip = within(board).getByRole('group', { name: 'PAY-102 Store tokens in the vault' });
    within(grip).getByRole('link', { name: 'PAY-102' }).focus();
    await userEvent.keyboard('m');
    expect(screen.queryByRole('menu')).toBeNull();
    grip.focus();
    await userEvent.keyboard('m');
    const menu = await screen.findByRole('menu', { name: 'PAY-102 Store tokens in the vault' });
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Done' }));
    expect(await within(board).findByRole('article', { name: 'Proposal: Move PAY-102 to Done' })).toBeTruthy();
    // The menu hands focus back to the card it came from.
    await waitFor(() => expect(document.activeElement).toBe(grip));
  });

  it('steps a lifted card a whole column per arrow key, in board order, whichever way the columns lie', () => {
    const order = ['TODO', 'IN_PROGRESS', 'DONE'] as const;
    // Side by side, as on a wide screen.
    const rects = new Map(order.map((c, i) => [c, { left: i * 300, top: 100, width: 280, height: 600, right: i * 300 + 280, bottom: 700 }]));
    const step = columnSteps([...order], () => 'TODO');
    const press = (code: string, over: string | null) => {
      const event = new KeyboardEvent('keydown', { code, cancelable: true });
      const at = step(event, { active: 'x', currentCoordinates: { x: 0, y: 0 }, context: { collisionRect: { width: 240, height: 120 }, droppableRects: rects, over: over ? { id: over } : null } } as never);
      return { at, prevented: event.defaultPrevented };
    };
    expect(press('ArrowRight', null)).toEqual({ at: { x: 320, y: 148 }, prevented: true });
    expect(press('ArrowDown', 'IN_PROGRESS').at).toEqual({ x: 620, y: 148 });
    expect(press('ArrowRight', 'DONE').at).toEqual({ x: 620, y: 148 });
    expect(press('ArrowLeft', 'IN_PROGRESS').at).toEqual({ x: 20, y: 148 });
    expect(press('ArrowUp', 'TODO').at).toEqual({ x: 20, y: 148 });
    // Any other key is left to dnd-kit: Space and Enter drop, Escape cancels.
    expect(press('Space', 'TODO')).toEqual({ at: undefined, prevented: false });
  });

  // #393: the drop worked, but nothing on screen moved during a drag and the proposal landed out of view.
  it('shows a lifted card as a copy that says what a drop would do, leaving a placeholder in its column', async () => {
    await open('#/dossier/card-payments/board');
    const board = panel('Sprint 42 board');
    const grip = within(board).getByRole('group', { name: 'PAY-102 Store tokens in the vault' });
    expect(document.querySelector('[data-drag-overlay]')).toBeNull();
    grip.focus();
    await userEvent.keyboard('[Space]');
    const overlay = await waitFor(() => document.querySelector<HTMLElement>('[data-drag-overlay]')!);
    expect(overlay.textContent).toContain('Store tokens in the vault');
    // Only for the eye: the announcements speak for it, and it holds no second link to the item.
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(overlay.querySelector('a')).toBeNull();
    expect(grip.closest('li')!.classList).toContain('card--dragging');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.querySelector('[data-drag-overlay]')).toBeNull());
    expect(grip.closest('li')!.classList).not.toContain('card--dragging');
  });

  it('says on the dragged copy whether a column would take the card, and why not', () => {
    const card = { statusCategory: 'TODO' } as WorkItem;
    expect(dropVerdict(card, 'IN_PROGRESS')).toEqual({ ok: true, text: 'Drop to propose: In progress' });
    expect(dropVerdict(card, 'TODO')).toEqual({ ok: false, text: 'Already in To do: nothing to propose' });
    expect(dropVerdict(card, 'UNKNOWN')).toEqual({ ok: false, text: 'Unknown is no status to move to' });
    expect(dropVerdict(card, null)).toEqual({ ok: false, text: 'Not over a column' });
  });

  it('puts a proposed move where it was made: a ghost in the target column, with Undo and the way to apply it', async () => {
    await open('#/dossier/card-payments/board');
    const board = panel('Sprint 42 board');
    const col = (name: string) => within(board).getByRole('region', { name: new RegExp(`^${name}`) });
    const grip = within(board).getByRole('group', { name: 'PAY-102 Store tokens in the vault' });
    fireEvent.contextMenu(grip);
    await userEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'In progress' }));
    const ghost = within(col('In progress')).getByRole('listitem', { name: 'Proposed move, not applied: PAY-102 Store tokens in the vault' });
    expect(ghost.textContent).toContain('From To do.');
    // The ghost is not the card: the card stays in To do, and In progress still counts its own two.
    expect(within(col('To do')).getByRole('group', { name: 'PAY-102 Store tokens in the vault' })).toBe(grip);
    expect(col('In progress').querySelector('h3 .count')!.textContent).toBe('2');
    // How to apply goes to the proposal under the board, which has the command.
    await userEvent.click(within(ghost).getByRole('button', { name: 'How to apply the move of PAY-102 to In progress' }));
    expect(document.activeElement!.querySelector('[aria-label="Proposal: Move PAY-102 to In progress"]')).not.toBeNull();
    await userEvent.click(within(ghost).getByRole('button', { name: 'Undo the proposed move of PAY-102' }));
    expect(within(col('In progress')).queryByRole('listitem', { name: /^Proposed move/ })).toBeNull();
    expect(within(board).queryByRole('article', { name: 'Proposal: Move PAY-102 to In progress' })).toBeNull();
    expect(screen.getByText('Took back the proposed move of PAY-102. Nothing proposed.')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(grip));
  });

  it('draws the metrics as sparklines, each opening its full chart, which lists what it could not compute (#394)', async () => {
    await open('#/dossier/checkout-web');
    const strip = screen.getByRole('region', { name: 'Metrics' });
    expect(within(strip).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Burn-up 1 of 11 points, show the full chart',
      'Throughput 0.4 a week, show the full chart',
      'Cycle time 0 items timed, show the full chart',
      'Aging WIP 0 in progress, show the full chart',
      'PR wait 2 working days, 3 open, show the full chart',
    ]);
    let dialog = await metric(/^Throughput /);
    expect(within(dialog).getAllByRole('img').length).toBeGreaterThan(0);
    expect(dialog.textContent).toContain('3 finished in 6 weeks');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    dialog = await metric(/^Cycle time /);
    expect(dialog.textContent).toContain('No finished item here has a cycle time the data can show.');
    expect(dialog.textContent).toContain('Unknown: Never recorded as In progress before Done.');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    dialog = await metric(/^Aging WIP /);
    expect(dialog.textContent).toContain('Unknown: No move into In progress recorded.');
  });

  it('draws the dependency graph, and lists every link in words', async () => {
    await open('#/dossier/card-payments/dependencies');
    const graph = panel('Dependencies');
    await waitFor(() => expect(graph.querySelector('.react-flow')).not.toBeNull());
    expect([...graph.querySelectorAll(':scope > ul.rows > li')].map((li) => li.textContent)).toEqual([
      'Jira PAY-101 Tokenise card numbers at the edge blocks Jira PAY-102 Store tokens in the vault (blocks)',
      'Jira PAY-102 Store tokens in the vault blocks Jira PAY-103 Charge a stored token (blocks)',
      'Jira PAY-103 Charge a stored token relates to Jira PAY-107 Retry declined charges once (relates to)',
    ]);
  });

  it('draws the blocker Gantt, with its key and every bar and arrow in a table (#396)', async () => {
    await open('#/dossier/card-payments/dependencies');
    const gantt = panel('Blocker timeline');
    const svg = gantt.querySelector('svg.gantt')!;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Blocker timeline for Sprint 42: 3 items and 2 waits-on arrows. Critical chain: PAY-101 blocks PAY-102 blocks PAY-103, 16 points. The table lists every bar and arrow.');
    expect(svg.querySelectorAll('.gantt-seg--blocked')).toHaveLength(2);
    expect(svg.querySelectorAll('.gantt-seg--checks')).toHaveLength(1);
    expect(svg.querySelectorAll('.gantt-arrow--chain')).toHaveLength(2);
    expect(svg.querySelector('.gantt-today')).not.toBeNull();
    expect(within(gantt).getByRole('list', { name: 'Key' }).textContent).toMatch(/In progress.*Blocked.*Checks failing.*Waits on.*Critical chain.*Today/);
    const table = within(gantt).getByRole('table', { name: 'Every bar and waits-on arrow in the blocker timeline' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getByRole('rowheader').querySelector('.l-table__value')!.textContent)).toEqual(['Jira PAY-101 Tokenise card numbers at the edge', 'Jira PAY-102 Store tokens in the vault', 'Jira PAY-103 Charge a stored token']);
    expect(rows[1]!.textContent).toContain('(estimated)');
    expect(rows[2]!.textContent).toContain('PAY-102, critical chain');
    expect(gantt.textContent).toContain('Blocked time is estimated');
  });

  it('says so when a dossier has no links to draw', async () => {
    localStorage.setItem('toil-ui.theme', JSON.stringify({ theme: 'plain' }));
    await open('#/dossier/checkout-web/dependencies');
    await waitFor(() => expect(panel('Dependencies').textContent).toContain("No links between this dossier's items."));
  });

  it("charts the sprint's burn-up with its figures in a table", async () => {
    await open('#/dossier/settlement');
    const sprint = await metric(/^Burn-up /);
    expect(sprint.querySelector('svg.chart title')!.textContent).toBe('Sprint 42 burn-up: 1 of 16 points done after 9 days, with 3 days to go. Scope grew from 11 to 16 points.');
    expect(within(sprint).getByRole('table', { name: 'Sprint 42 burn-up by day' })).toBeTruthy();
  });
});

describe('the chat up front (#343)', () => {
  const setTheme = (theme: string) => localStorage.setItem('toil-ui.theme', JSON.stringify({ theme }));
  beforeEach(() => setTheme('plain'));

  it('is a bar on every dossier page, with its placeholder in the theme\'s words and Analyze beside it', async () => {
    for (const route of ['#/dossier/card-payments', '#/dossier/card-payments/prs', '#/dossier/card-payments/people', '#/dossier/card-payments/worklog', item('card-payments', 'corp-jira:PAY-102')]) {
      await open(route);
      const bar = askBar('card-payments');
      expect(within(bar).getByRole('textbox', { name: 'Your question' }).getAttribute('placeholder')).toBe('Ask about card-payments');
      expect(within(bar).getByRole('button', { name: 'Analyze' })).toBeTruthy();
      cleanupView();
    }
    setTheme('crate');
    await open('#/dossier/card-payments');
    expect(within(askBar('card-payments')).getByRole('textbox', { name: 'Your question' }).getAttribute('placeholder')).toBe('Ask the dock about card-payments');
  });

  it('opens a focused view with the context strip, starters as chips, the welcome in the theme\'s voice, and Escape to leave', async () => {
    setTheme('realm');
    const { container } = await open('#/dossier/card-payments');
    const chat = await openChat('card-payments');
    expect(chat.textContent).toContain('Dossier card-payments');
    expect(chat.textContent).toContain('Sprint 42, day 7 of 10');
    expect(chat.textContent).toContain('Ask the dungeon master about card-payments');
    expect(within(chat).getByRole('group', { name: 'Starter questions' }).querySelectorAll('button').length).toBe(5);
    expect(await violations(container)).toEqual([]);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ask about card-payments' })).toBeNull());
  }, AXE_TIMEOUT);

  it('folds the starters into Suggestions once a conversation starts, keeps it when closed, and shows how long the answer took', async () => {
    await open('#/dossier/settlement');
    let chat = await openChat('settlement');
    await userEvent.click(within(chat).getByRole('button', { name: 'Where is this work deployed?' }));
    await waitFor(() => expect(chat.querySelector('[data-ask-status]')!.textContent).toMatch(/^Done in \d+ s$/));
    expect(within(chat).queryByRole('group', { name: 'Starter questions' })).toBeNull();
    await userEvent.click(within(chat).getByRole('button', { name: 'Suggestions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: "Who's overloaded or blocked?" }));
    await within(chat).findByRole('heading', { level: 3, name: "Who's overloaded or blocked?" });
    await userEvent.click(within(chat).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ask about settlement' })).toBeNull());
    expect(askBar('settlement').textContent).toContain('2 questions in this chat');
    await userEvent.click(within(askBar('settlement')).getByRole('button', { name: 'Open the conversation' }));
    chat = await screen.findByRole('dialog', { name: 'Ask about settlement' });
    expect(within(chat).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Where is this work deployed?', "Who's overloaded or blocked?"]);
  });

  it('keeps sending a long chat inside what the server takes: the last turns, each answer cut short (#344)', async () => {
    const sent: AskExtra[] = [];
    const agent: Agent = {
      starters: () => [],
      // The first answer is longer than the server takes in one turn of history (20,000 characters).
      ask: async (_d, prompt, _s, _c, extra) => (sent.push(extra ?? {}), { prompt, parts: [{ text: sent.length === 1 ? 'x'.repeat(25_000) : `Answer ${sent.length}.` }], citations: [], by: 'Codex', proposals: [] }),
    };
    await open('#/dossier/card-payments', { agent, preview: false });
    const chat = await openChat('card-payments');
    const box = within(chat).getByRole('textbox', { name: 'Your question' });
    for (let i = 1; i <= MAX_HISTORY_TURNS + 3; i++) {
      await userEvent.type(box, `Question ${i}{Enter}`);
      await waitFor(() => expect(chat.querySelectorAll('.turn h3')).toHaveLength(i));
    }
    const last = sent.at(-1)!.history!;
    expect(last).toHaveLength(MAX_HISTORY_TURNS);
    expect(last.at(-1)!.prompt).toBe(`Question ${MAX_HISTORY_TURNS + 2}`);
    expect(sent[1]!.history![0]!.answer).toHaveLength(MAX_HISTORY_ANSWER + 1);
    expect(sent.every((e) => (e.history ?? []).length <= 20 && (e.history ?? []).every((t) => t.answer.length <= 20_000))).toBe(true);
  });

  it('runs Analyze in one press, into the focused view, citing its items', async () => {
    await open('#/dossier/card-payments');
    await userEvent.click(within(askBar('card-payments')).getByRole('button', { name: 'Analyze' }));
    const chat = await screen.findByRole('dialog', { name: 'Ask about card-payments' });
    const answer = await within(chat).findByRole('heading', { level: 3, name: 'Analyze' });
    await waitFor(() => expect(answer.parentElement!.textContent).toContain('Answered by'));
    expect(within(answer.parentElement!).getAllByRole('link').length).toBeGreaterThan(5);
  });

  describe('the agent Analyze starts on (#494)', () => {
    const ready = (name: string, label: string, ok = true) => ({ name, label, model: null, ready: ok, problem: ok ? null : 'Not signed in', fix: null, action: ok ? null : ('fix' as const) });
    /** An agent whose server remembers per dossier what an Analyze was asked of, as the real one does. */
    function remembering(memory: Record<string, string>) {
      const sent: AskExtra[] = [];
      const agent: Agent = {
        starters: () => [],
        adapters: async (dossier) => ({ chosen: 'claude', remembered: (dossier && memory[dossier]) || null, options: [ready('claude', 'Claude'), ready('codex', 'Codex'), ready('copilot', 'GitHub Copilot', false)] }),
        ask: async (dossier, prompt, _s, _c, extra) => {
          sent.push(extra ?? {});
          if (prompt === 'analyze' && extra?.adapter) memory[dossier] = extra.adapter;
          return { prompt: 'Analyze', parts: [{ text: 'Fine.' }], citations: [], by: 'Claude', proposals: [] };
        },
      };
      return { agent, sent };
    }
    const analyze = async () => {
      await userEvent.click(within(askBar('card-payments')).getByRole('button', { name: 'Analyze' }));
      const chat = await screen.findByRole('dialog', { name: 'Ask about card-payments' });
      await within(chat).findByRole('heading', { level: 3, name: 'Analyze' });
      return chat;
    };
    const hint = (chat: HTMLElement) => chat.querySelector('[data-agent-source]')?.textContent?.trim();

    it("starts on the dossier's remembered agent and says so", async () => {
      const { agent, sent } = remembering({ 'card-payments': 'codex' });
      await open('#/dossier/card-payments', { agent, preview: false });
      const chat = await analyze();
      expect(sent).toEqual([{ adapter: 'codex' }]);
      expect(within(chat).getByRole('button', { name: /^Codex/ })).toBeTruthy();
      await waitFor(() => expect(hint(chat)).toBe('(last used on this dossier)'));
    });

    it('falls back to the default from Settings with nothing remembered, or when the remembered agent is not ready', async () => {
      for (const memory of [{}, { 'card-payments': 'copilot' }] as Array<Record<string, string>>) {
        const { agent, sent } = remembering({ ...memory });
        const { unmount } = await open('#/dossier/card-payments', { agent, preview: false });
        const chat = await analyze();
        expect(sent).toEqual([{}]);
        expect(within(chat).getByRole('button', { name: /^Claude/ })).toBeTruthy();
        expect(hint(chat)).toBe('(your default)');
        unmount();
        cleanup();
      }
    });

    it("starts on the first ready agent when the default from Settings can't run, and sends it", async () => {
      const sent: AskExtra[] = [];
      const agent: Agent = {
        starters: () => [],
        adapters: async () => ({ chosen: 'copilot', remembered: null, options: [ready('copilot', 'GitHub Copilot', false), ready('claude', 'Claude'), ready('codex', 'Codex')] }),
        ask: async (_d, _p, _s, _c, extra) => {
          sent.push(extra ?? {});
          return { prompt: 'Analyze', parts: [{ text: 'Fine.' }], citations: [], by: 'Claude', proposals: [] };
        },
      };
      await open('#/dossier/card-payments', { agent, preview: false });
      const chat = await analyze();
      expect(sent).toEqual([{ adapter: 'claude', fallback: true }]);
      expect(within(chat).getByRole('button', { name: /^Claude/ })).toBeTruthy();
      expect(hint(chat)).toBe("(your default can't run)");
    });

    it('starts one run for two presses while the agent list loads, and Stop cancels it', async () => {
      let release!: (l: AdapterList) => void;
      const listing = new Promise<AdapterList>((r) => (release = r));
      const signals: Array<AbortSignal | undefined> = [];
      const agent: Agent = {
        starters: () => [],
        adapters: () => listing,
        ask: async () => ({ prompt: 'Analyze', parts: [], citations: [], by: 'Claude', proposals: [] }),
        async *stream(_d, _p, signal) {
          signals.push(signal);
          yield { prompt: 'Analyze', parts: [{ text: 'Working.' }], citations: [], by: 'Claude', proposals: [] };
          await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()));
        },
      };
      await open('#/dossier/card-payments', { agent, preview: false });
      await userEvent.click(within(askBar('card-payments')).getByRole('button', { name: 'Analyze' }));
      const chat = await screen.findByRole('dialog', { name: 'Ask about card-payments' });
      await userEvent.click(within(chat).getByRole('button', { name: 'Analyze' }));
      release({ chosen: 'claude', remembered: null, options: [ready('claude', 'Claude')] });
      await within(chat).findByRole('heading', { level: 3, name: 'Analyze' });
      expect(signals).toHaveLength(1);
      await userEvent.click(await within(chat).findByRole('button', { name: 'Stop' }));
      expect(signals[0]!.aborted).toBe(true);
      expect(signals).toHaveLength(1);
    });

    it("remembers a picked agent: the next Analyze, even in a fresh page, starts on it", async () => {
      const memory: Record<string, string> = {};
      const first = remembering(memory);
      const { unmount } = await open('#/dossier/card-payments', { agent: first.agent, preview: false });
      await userEvent.click(await within(askBar('card-payments')).findByRole('textbox', { name: 'Your question' }));
      const chat = await screen.findByRole('dialog', { name: 'Ask about card-payments' });
      await userEvent.click(await within(chat).findByRole('button', { name: /change the agent for this chat/ }));
      await userEvent.click(await screen.findByRole('button', { name: /Codex/ }));
      await userEvent.click(within(chat).getByRole('button', { name: 'Analyze' }));
      await within(chat).findByRole('heading', { level: 3, name: 'Analyze' });
      expect(first.sent).toEqual([{ adapter: 'codex' }]);
      expect(memory).toEqual({ 'card-payments': 'codex' });
      unmount();
      cleanup();
      const second = remembering(memory);
      await open('#/dossier/card-payments', { agent: second.agent, preview: false });
      await analyze();
      expect(second.sent).toEqual([{ adapter: 'codex' }]);
    });
  });
});

describe('settings', () => {
  it('is in the navigation, and says the preview changes nothing', async () => {
    await open('#/settings');
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe("toil's configuration");
    expect(document.body.textContent).toContain('Changes are turned off.');
    expect(document.body.textContent).toContain('it has no configuration of yours to change');
  });

  /** The preview's config with changes on, recording what each change sent, and answering it ok. */
  function recording() {
    const base = fixtureConfig();
    const sent: Array<{ command: string; input: Record<string, unknown>; answers: unknown }> = [];
    const config: ConfigApi = {
      ...base,
      disabled: null,
      run: async (command, input, answers) => {
        if (['connections list', 'connections test', 'dossiers list', 'dossiers show', 'dossiers check'].includes(command)) return base.run(command, input);
        sent.push({ command, input, answers: answers ?? null });
        return { ok: true, data: {}, error: null, meta: { command, durationMs: 0, version: 'x', contractVersion: 1 } };
      },
    };
    return { config, sent };
  }

  it('in the preview, shows the connections with every change turned off, and still tests one', async () => {
    await open('#/settings/connections');
    const card = await screen.findByRole('article', { name: 'corp-jira' });
    await userEvent.click(within(card).getByRole('button', { name: 'Turn writes off' }));
    const form = within(card).getByRole('form', { name: 'Turn writes off for corp-jira' });
    expect((within(form).getByRole('button', { name: 'Turn writes off' }) as HTMLButtonElement).disabled).toBe(true);
    expect(form.textContent).toContain('Turned off: This is the preview');
    expect(form.textContent).toContain('Runs toil connections writes corp-jira off');
    await userEvent.click(within(card).getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(card.textContent).toContain('corp-jira answered GET /rest/api/2/myself, so its credential works.'));
  });

  it('shows a connection made by env vars read-only, with where it came from', async () => {
    await open('#/settings/connections');
    const card = await screen.findByRole('article', { name: 'github' });
    expect(within(card).queryByRole('button', { name: /Remove|Make default|Turn writes|Replace secret/ })).toBeNull();
    expect(within(card).getByRole('button', { name: 'Test' })).toBeTruthy();
    expect(card.textContent).toContain('TOIL_CONN_GITHUB_*');
    expect(card.textContent).toContain('token: CI variable');
  });

  it("turns writes on only with the name typed, and sends what was typed as the command's own confirmation", async () => {
    const { config, sent } = recording();
    await open('#/settings/connections', { config });
    const card = await screen.findByRole('article', { name: 'corp-ado' });
    await userEvent.click(within(card).getByRole('button', { name: 'Turn writes on' }));
    const form = within(card).getByRole('form', { name: 'Turn writes on for corp-ado' });
    await userEvent.type(within(form).getByRole('textbox', { name: /Type corp-ado to turn them on/ }), 'corp-ado');
    await userEvent.click(within(form).getByRole('button', { name: 'Turn writes on' }));
    expect(await within(form).findByRole('status')).toBeTruthy();
    expect(sent).toEqual([{ command: 'connections writes', input: { name: 'corp-ado', state: 'on' }, answers: { answers: { 'confirm-name': 'corp-ado' } } }]);
  });

  it("adds a connection: every setting answered, the secret sent once and cleared from the page", async () => {
    const { config, sent } = recording();
    await open('#/settings/connections', { config });
    const form = await screen.findByRole('form', { name: 'A new connection' });
    await userEvent.type(within(form).getByRole('textbox', { name: /^Name/ }), 'corp-jira-2');
    await userEvent.selectOptions(within(form).getByRole('combobox', { name: 'Area' }), 'jira');
    await userEvent.type(within(form).getByRole('textbox', { name: /^baseUrl/ }), 'https://jira.imagile.dev');
    const secret = within(form).getByLabelText(/^apiToken/) as HTMLInputElement;
    expect(secret.type).toBe('password');
    await userEvent.type(secret, 'fake-pat-abc12345');
    expect(form.textContent).toContain('Saves: area jira, baseUrl https://jira.imagile.dev, apiToken to the OS credential store.');
    await userEvent.click(within(form).getByRole('button', { name: 'Save connection' }));
    expect(await within(form).findByRole('status')).toBeTruthy();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ command: 'connections add', input: { name: 'corp-jira-2', area: 'jira' }, answers: { secrets: { apiToken: 'fake-pat-abc12345' } } });
    const answers = (sent[0]!.answers as { answers: Record<string, string> }).answers;
    expect(answers).toMatchObject({ confirm: 'y', 'setting:baseUrl': 'https://jira.imagile.dev', 'setting:project': '' });
    expect((within(form).getByLabelText(/^apiToken/) as HTMLInputElement).value).toBe('');
    expect(document.body.textContent).not.toContain('fake-pat-abc12345');
  });

  it("answers an optional secret left blank with '', so toil skips it as the CLI does", async () => {
    const { config, sent } = recording();
    await open('#/settings/connections', { config });
    const form = await screen.findByRole('form', { name: 'A new connection' });
    await userEvent.type(within(form).getByRole('textbox', { name: /^Name/ }), 'ocp-lab');
    await userEvent.selectOptions(within(form).getByRole('combobox', { name: 'Area' }), 'openshift');
    expect((within(form).getByLabelText(/^token/) as HTMLInputElement).required).toBe(false);
    await userEvent.click(within(form).getByRole('button', { name: 'Save connection' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ command: 'connections add', input: { name: 'ocp-lab', area: 'openshift' }, answers: { secrets: { token: '' } } });
  });

  it("replaces a secret with every field answered, an empty one as ''", async () => {
    const { config, sent } = recording();
    await open('#/settings/connections', { config });
    const card = await screen.findByRole('article', { name: 'corp-jenkins' });
    await userEvent.click(within(card).getByRole('button', { name: 'Replace secret' }));
    const form = within(card).getByRole('form', { name: "Replace corp-jenkins's secret" });
    await userEvent.click(within(form).getByRole('button', { name: 'Save to the credential store' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ command: 'connections login', input: { name: 'corp-jenkins' }, answers: { secrets: { apiToken: '' } } });
  });

  describe('the paste checks on a secret field (#358)', () => {
    async function addForm() {
      const { config, sent } = recording();
      await open('#/settings/connections', { config });
      const form = await screen.findByRole('form', { name: 'A new connection' });
      await userEvent.type(within(form).getByRole('textbox', { name: /^Name/ }), 'corp-jira-2');
      await userEvent.selectOptions(within(form).getByRole('combobox', { name: 'Area' }), 'jira');
      await userEvent.type(within(form).getByRole('textbox', { name: /^baseUrl/ }), 'https://jira.imagile.dev');
      const secret = within(form).getByLabelText(/^apiToken/) as HTMLInputElement;
      const note = () => document.getElementById(secret.getAttribute('aria-describedby')!.split(' ')[0]!)!.textContent;
      const save = () => userEvent.click(within(form).getByRole('button', { name: 'Save connection' }));
      return { form, secret, note, save, sent };
    }

    it('shows the length live, never the value, and says an empty required one is required', async () => {
      const { secret, note, save, sent, form } = await addForm();
      expect(note()).toBe('Empty: this one is required');
      await save();
      expect(within(form).getByRole('alert').textContent).toContain('apiToken: Nothing was entered, and this one is required.');
      expect(sent).toHaveLength(0);
      await userEvent.type(secret, 'fake-pat-abc12345');
      expect(note()).toBe('17 characters');
      expect(within(form).queryByRole('button', { name: /Show/ })).toBeNull();
    });

    it('trims a pasted trailing newline, saying so, and sends the value', async () => {
      const { secret, note, save, sent } = await addForm();
      await userEvent.click(secret);
      await userEvent.paste('fake-pat-abc12345\n');
      expect(note()).toBe('17 characters (removed a trailing newline)');
      await save();
      await waitFor(() => expect(sent).toHaveLength(1));
      expect((sent[0]!.answers as { secrets: Record<string, string> }).secrets.apiToken?.trim()).toBe('fake-pat-abc12345');
    });

    it('refuses a paste with a line break in the middle, which a browser would silently join', async () => {
      const { secret, note, save, sent, form } = await addForm();
      await userEvent.click(secret);
      await userEvent.paste('fake-pat-abc12345\nfake-pat-abc12345');
      expect(note()).toContain('This has a line break in the middle, so the paste most likely took two lines.');
      await save();
      expect(within(form).getByRole('alert').textContent).toContain('Copy just the token, on its own, and paste it again.');
      expect(sent).toHaveLength(0);
    });

    it('asks about a Bearer prefix on submit, with a one-click Remove it', async () => {
      const { secret, note, save, sent, form } = await addForm();
      await userEvent.click(secret);
      await userEvent.paste('Bearer fake-pat-abc12345');
      expect(note()).toBe('24 characters');
      await save();
      expect(sent).toHaveLength(0);
      expect(within(form).getByRole('group', { name: /This starts with "Bearer "\. Store it without that\?/ })).toBeTruthy();
      await userEvent.click(within(form).getByRole('button', { name: 'Remove it' }));
      expect(secret.value).toBe('fake-pat-abc12345');
      expect(note()).toBe('17 characters');
      await save();
      await waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0]).toMatchObject({ answers: { secrets: { apiToken: 'fake-pat-abc12345' } } });
      expect(document.body.textContent).not.toContain('abc12345');
    });

    it('keeps quotes when the person says so, and tells toil with unwrap:<key>', async () => {
      const { secret, save, sent, form } = await addForm();
      await userEvent.type(secret, '"fake-pat-abc12345"');
      await save();
      await userEvent.click(within(form).getByRole('button', { name: 'Keep it' }));
      await save();
      await waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0]).toMatchObject({ answers: { secrets: { apiToken: '"fake-pat-abc12345"' }, answers: { 'unwrap:apiToken': 'n' } } });
    });

    it('says an empty field keeps the current secret when replacing one', async () => {
      await open('#/settings/connections');
      const card = await screen.findByRole('article', { name: 'corp-jenkins' });
      await userEvent.click(within(card).getByRole('button', { name: 'Replace secret' }));
      const form = within(card).getByRole('form', { name: "Replace corp-jenkins's secret" });
      expect(form.textContent).toContain('Empty: the current secret is kept');
    });
  });

  it('builds a dossier through toil dossiers, and shows and checks one', async () => {
    const { config, sent } = recording();
    await open('#/settings/dossiers', { config });
    const card = await screen.findByRole('article', { name: 'settlement' });
    await userEvent.click(within(card).getByRole('button', { name: 'Check' }));
    expect(await within(card).findByText('settlement checks out: no problems.')).toBeTruthy();
    expect(within(card).getByText('settlement checks out: no problems.').closest('[role="status"]')).toBeTruthy();
    await userEvent.click(within(card).getByRole('button', { name: 'Show' }));
    expect(within(card).getByRole('table').textContent).toContain('corp-ado (dossier)');

    const init = screen.getByRole('form', { name: 'Create a dossier' });
    await userEvent.type(within(init).getByRole('textbox', { name: /^Name/ }), 'payments');
    await userEvent.click(within(init).getByRole('button', { name: 'Create dossier' }));
    const field = screen.getByRole('form', { name: 'Name a field in card-payments' });
    await userEvent.type(within(field).getByRole('textbox', { name: /^Alias/ }), 'storyPoints');
    await userEvent.type(within(field).getByRole('textbox', { name: /^Field id/ }), 'customfield_10002');
    await userEvent.click(within(field).getByRole('button', { name: 'Name field' }));
    const link = screen.getByRole('form', { name: 'Link an area to card-payments' });
    await userEvent.type(within(link).getByRole('textbox', { name: /^Keys to set/ }), 'project=PAY');
    await userEvent.click(within(link).getByRole('button', { name: 'Link area' }));
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent.map((s) => [s.command, s.input])).toEqual([
      ['dossiers init', { name: 'payments' }],
      ['dossiers field', { dossier: 'card-payments', area: 'jira', alias: 'storyPoints', id: 'customfield_10002' }],
      ['dossiers link', { dossier: 'card-payments', area: 'jira', set: ['project=PAY'] }],
    ]);
  });

  it("sets up a repo: checks it with dossiers onboard --plan, offers the missing connection on the dossier's host, and checks again after adding it", async () => {
    const base = fixtureConfig();
    const sent: Array<{ command: string; input: Record<string, unknown>; answers: unknown }> = [];
    const config: ConfigApi = {
      ...base,
      disabled: null,
      run: async (command, input, answers) => {
        sent.push({ command, input, answers: answers ?? null });
        if (command === 'connections add') return { ok: true, data: {}, error: null, meta: { command, durationMs: 0, version: 'x', contractVersion: 1 } };
        return base.run(command, input);
      },
    };
    await open('#/settings/dossiers', { config });
    const panelEl = await screen.findByRole('region', { name: 'Set up this repo' });
    await userEvent.click(within(panelEl).getByRole('button', { name: 'Check this repo' }));
    const table = await within(panelEl).findByRole('table');
    expect(table.textContent).toContain('host bitbucket-sdk.imagile.dev');
    expect(table.textContent).toContain('No connection yet');
    expect(table.textContent).toContain('GET /api/v1');
    expect(panelEl.textContent).toContain('checkout-web: 3 of 4 areas ready.');
    expect(panelEl.textContent).toContain('error: bitbucket.host');
    const add = within(panelEl).getByRole('form', { name: 'Add a bitbucket connection on bitbucket-sdk.imagile.dev' });
    expect((within(add).getByRole('textbox', { name: /^Name/ }) as HTMLInputElement).value).toBe('bitbucket');
    expect((within(add).getByRole('textbox', { name: /^baseUrl/ }) as HTMLInputElement).value).toBe('https://bitbucket-sdk.imagile.dev');
    // A required secret left empty is refused before anything is sent (#358), so one is typed.
    await userEvent.type(add.querySelector('input[type=password]')!, 'fake-pat-abc12345');
    await userEvent.click(within(add).getByRole('button', { name: 'Save connection' }));
    await waitFor(() => expect(sent.filter((s) => s.command === 'dossiers onboard')).toHaveLength(2));
    const steps = sent.filter((s) => s.command === 'dossiers onboard' || s.command === 'connections add');
    expect(steps.map((s) => s.command)).toEqual(['dossiers onboard', 'connections add', 'dossiers onboard']);
    expect(steps[0]!.input).toEqual({ plan: true });
    expect(steps[1]).toMatchObject({ input: { name: 'bitbucket', area: 'bitbucket' }, answers: { answers: { 'setting:baseUrl': 'https://bitbucket-sdk.imagile.dev', confirm: 'y' } } });
  });

  it('shows the bounds and the time limit read-only, with where each is set', async () => {
    await open('#/settings/toil');
    await screen.findByRole('heading', { name: 'Bounds' });
    expect(document.body.textContent).toContain('Held: commands read and write files only inside the workspace.');
    expect(document.body.textContent).toContain('/home/you/.toil/config.json');
    expect(document.body.textContent).toContain("120 s, toil's default");
    expect(screen.queryByRole('button', { name: /Save|Change/ })).toBeNull();
  });

  it("has a Usage page with toil audit stats' figures, and opens a failing command's recent lines through toil audit list", async () => {
    const config = fixtureConfig();
    await open('#/settings/usage', { config });
    await screen.findByRole('heading', { name: 'Usage of toil' });
    expect(screen.getByRole('link', { name: 'Usage' }).getAttribute('aria-current')).toBe('page');
    expect(document.body.textContent).not.toContain('Changes are turned off.');
    const until = config.calls[0]!.input.until;
    expect(until).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(config.calls.map((c) => [c.command, c.input])).toEqual([
      ['audit stats', { by: ['day'], until }],
      ['audit stats', { by: ['command'], unused: true, until }],
      ['audit stats', { by: ['via', 'caller'], until }],
    ]);
    expect(screen.getByRole('img', { name: /^Calls per day: \d+ calls in 30 days/ })).toBeTruthy();
    const doors = panel('How toil was called');
    for (const door of ['Toil UI', 'MCP', 'The CLI']) expect(doors.textContent).toContain(door);
    const top = within(panel('Used most')).getAllByRole('rowheader').map((h) => h.textContent);
    expect(top[0]).toBe('Commandjira issue get');
    const failing = panel('Failed most');
    expect(failing.textContent).toContain('Usual fix:');
    const show = within(failing).getAllByRole('button', { name: 'Show recent failures' })[0]!;
    await userEvent.click(show);
    await within(failing).findByRole('region', { name: /^Recent failures of / });
    const last = config.calls.at(-1)!;
    expect(last.command).toBe('audit list');
    expect(last.input).toMatchObject({ outcome: 'failed', limit: 10 });
    expect(show.getAttribute('aria-expanded')).toBe('true');
    const unused = panel('Not used');
    expect(unused.textContent).toContain('6 commands had no call in this window');
    expect(unused.textContent).toContain('(CLI only)');
  });

  it("has an Agent page, which says what the local app offers and changes nothing in the preview", async () => {
    await open('#/settings/agent');
    expect(screen.getByRole('link', { name: 'Agent' }).getAttribute('aria-current')).toBe('page');
    const agentPanel = panel('Agent');
    for (const name of ['Claude', 'GitHub Copilot', 'Codex']) expect(agentPanel.textContent).toContain(name);
    expect(within(agentPanel).queryByRole('button')).toBeNull();
    expect(document.body.textContent).not.toContain('Changes are turned off.');
  });

  it('installs a missing SDK in one press, after showing the exact command, streaming npm into the dialog (#344)', async () => {
    const ran: string[] = [];
    const client = {
      status: async () => STATUS({ adapter: 'none', model: null, cliPath: null, endpoint: null, instructions: null, voice: null, models: {}, cliPaths: {} }, ran.length > 0),
      save: async (s: AgentSettings) => STATUS(s),
      prompt: async () => '',
      installPlan: NO_INSTALL.installPlan,
      install: async (adapter: string, command: string, onLine: (l: string) => void) => {
        ran.push(`${adapter}: ${command}`);
        onLine('added 105 packages in 8s');
        return STATUS({ adapter: 'none', model: null, cliPath: null, endpoint: null, instructions: null, voice: null, models: {}, cliPaths: {} }, true).adapters[0]!;
      },
    };
    const { container } = await open('#/settings/agent', { preview: false, agentSettings: { client } });
    const card = await screen.findByRole('region', { name: 'Adapters on this machine' });
    await userEvent.click(within(card).getByRole('button', { name: 'Install GitHub Copilot' }));
    const dialog = await screen.findByRole('dialog', { name: "Install GitHub Copilot's SDK" });
    expect(within(dialog).getByRole('region', { name: 'The command' }).textContent).toBe('npm install --global --prefix /usr/local --ignore-scripts @x/y@1');
    expect(ran).toEqual([]);
    expect(within(dialog).getByRole('button', { name: 'Copy command' })).toBeTruthy();
    expect(await violations(container)).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(within(dialog).getByRole('log', { name: "npm's output" }).textContent).toBe('added 105 packages in 8s'));
    await waitFor(() => expect(dialog.textContent).toContain('Installed @github/copilot-sdk'));
    expect(ran).toEqual(['copilot: npm install --global --prefix /usr/local --ignore-scripts @x/y@1']);
  }, AXE_TIMEOUT);

  const STATUS = (settings: AgentSettings, installed = false): AgentStatus => ({
    settings,
    problem: null,
    kind: settings.adapter,
    adapters: [
      {
        name: 'claude',
        label: 'Claude',
        package: '@anthropic-ai/claude-agent-sdk',
        installed,
        cli: installed ? { path: '/usr/local/bin/claude', problem: null, fix: null } : { path: null, problem: "Toil UI found no claude on PATH, so it can't start Claude Code. It never downloads one.", fix: 'Install it.' },
        endpoints: ['anthropic', 'bedrock', 'foundry', 'vertex'],
        version: installed ? '0.3.289' : null, tested: '0.3.289', model: null, notes: [], install: { adapter: 'claude', kind: 'global', folder: '/usr/local', command: 'npm install --global --prefix /usr/local --ignore-scripts @x/y@1', argv: ['node', 'npm-cli.js'], problem: null, fix: null },
      },
      { name: 'copilot', label: 'GitHub Copilot', package: '@github/copilot-sdk', installed: false, cli: { path: null, problem: 'Toil UI found no copilot on PATH.', fix: null }, endpoints: [], version: null, tested: '0.3.289', model: null, notes: [], install: { adapter: 'copilot', kind: 'global', folder: '/usr/local', command: 'npm install --global --prefix /usr/local --ignore-scripts @x/y@1', argv: ['node', 'npm-cli.js'], problem: null, fix: null } },
      { name: 'codex', label: 'Codex', package: '@openai/codex-sdk', installed: false, cli: { path: null, problem: 'Toil UI found no codex on PATH.', fix: null }, endpoints: [], version: null, tested: '0.3.289', model: null, notes: [], install: { adapter: 'codex', kind: 'global', folder: '/usr/local', command: 'npm install --global --prefix /usr/local --ignore-scripts @x/y@1', argv: ['node', 'npm-cli.js'], problem: null, fix: null } },
    ],
  });

  it('in the local app, says plainly when no SDK is installed and names the three', async () => {
    const client = { status: async () => STATUS({ adapter: 'none', model: null, cliPath: null, endpoint: null, instructions: null, voice: null, models: {}, cliPaths: {} }), save: async (s: AgentSettings) => STATUS(s), prompt: async () => '', ...NO_INSTALL };
    const { container } = await open('#/settings/agent', { preview: false, agentSettings: { client } });
    const agentPanel = panel('Agent');
    await within(agentPanel).findByRole('radiogroup', { name: 'Adapter' });
    expect(agentPanel.textContent).toContain('None of the three agent SDKs is installed beside Toil UI: Claude (@anthropic-ai/claude-agent-sdk), GitHub Copilot (@github/copilot-sdk), Codex (@openai/codex-sdk).');
    expect(agentPanel.textContent).toContain('Toil UI found no claude on PATH');
    expect(within(agentPanel).queryByLabelText(/key|token/i)).toBeNull();
    expect(await violations(container)).toEqual([]);
  }, AXE_TIMEOUT);

  it('saves the adapter, model, CLI path and Claude endpoint, and says so', async () => {
    const saves: AgentSettings[] = [];
    const changed: AgentStatus[] = [];
    const client = { status: async () => STATUS({ adapter: 'none', model: null, cliPath: null, endpoint: null, instructions: null, voice: null, models: {}, cliPaths: {} }, true), save: async (s: AgentSettings) => (saves.push(s), STATUS(s, true)), prompt: async () => '', ...NO_INSTALL };
    const { container } = await open('#/settings/agent', { preview: false, agentSettings: { client, onChange: (s) => changed.push(s) } });
    const agentPanel = panel('Agent');
    await userEvent.click(await within(agentPanel).findByRole('radio', { name: /^Claude/ }));
    await userEvent.type(within(agentPanel).getByRole('textbox', { name: "Claude's model" }), 'sonnet');
    await userEvent.click(within(agentPanel).getByRole('radio', { name: 'Amazon Bedrock' }));
    expect(await violations(container)).toEqual([]);
    await userEvent.click(within(agentPanel).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(agentPanel).getByRole('status').textContent).toBe('Saved: Claude answers from the next question.'));
    expect(saves).toEqual([{ adapter: 'claude', model: 'sonnet', cliPath: null, endpoint: 'bedrock', instructions: null, voice: null, models: { claude: 'sonnet' }, cliPaths: {} }]);
    expect(changed).toHaveLength(1);
  }, AXE_TIMEOUT);
});

describe('the agent pane, with a real adapter', () => {
  it('says plainly when no agent is set up', async () => {
    const agent: Agent = { notice: 'No agent is set up in this Toil UI. Claude, GitHub Copilot or Codex.', starters: () => [], ask: () => Promise.reject(new Error('none')) };
    await open('#/dossier/card-payments', { agent, preview: false });
    await openChat('card-payments');
    expect(screen.getByText(/No agent is set up in this Toil UI/).textContent).toContain('GitHub Copilot');
  });

  it("shows the server's checks above an answer: ids its tools never returned", async () => {
    const agent: Agent = {
      starters: () => [{ id: 'risk', label: 'Why is this sprint at risk?' }],
      ask: async () => ({
        prompt: 'Why is this sprint at risk?',
        parts: [{ text: '[[corp-jira:PAY-101]] and [[corp-jira:PAY-999]].' }],
        citations: ['corp-jira:PAY-101', 'corp-jira:PAY-999'],
        by: 'Claude',
        proposals: [],
        unverified: ['corp-jira:PAY-999'],
        warnings: ['This answer names an item its tools never returned: corp-jira:PAY-999. Treat it as unverified.'],
      }),
    };
    const { container } = await open('#/dossier/card-payments', { agent, preview: false });
    await openChat('card-payments');
    await userEvent.click(await screen.findByRole('button', { name: 'Why is this sprint at risk?' }));
    const checks = await screen.findByLabelText('Checks on this answer');
    expect(checks.textContent).toContain('corp-jira:PAY-999');
    expect(screen.getByText(/Names 1 its tools never returned/)).toBeTruthy();
    expect(await violations(container)).toEqual([]);
  }, AXE_TIMEOUT);
});

describe('failures', () => {
  it("shows a failed call on its own panel with toil's message and fix, and the rest still loads", async () => {
    const without = (c: Canned) => !(c.command === 'bitbucket pr list');
    await open('#/dossier/card-payments/prs', { execute: fixtureExecute(CANNED.filter(without)).execute });
    expect(screen.getAllByRole('alert').map((a) => a.textContent).join(' ')).toMatch(/toil bitbucket pr list failed: The preview has no sample answer .* Add the call to CANNED/);
    window.location.hash = '#/dossier/card-payments/board';
    expect((await screen.findByRole('region', { name: 'Sprint 42 board' })).textContent).toContain('PAY-102');
  });

  it('says the data did not load when dossiers show fails', async () => {
    const execute = fixtureExecute(CANNED.filter((c) => callKey(c.command, c.input) !== callKey('dossiers show', { dossier: 'settlement' }))).execute;
    await open('#/dossier/settlement', { execute });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain("The data didn't load");
    expect(alert.textContent).toContain('dossiers show');
  });

  it('says the agent failed, in the answer pane, when ask() rejects', async () => {
    const agent: Agent = { starters: scriptedAgent().starters, ask: () => Promise.reject(new Error('model endpoint unreachable')) };
    await open('#/dossier/checkout-web', { agent });
    await openChat('checkout-web');
    await userEvent.click(await screen.findByRole('button', { name: "What's at risk in this dossier?" }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe("The agent couldn't answer: model endpoint unreachable");
    expect(screen.getByRole('button', { name: 'Suggestions' }).hasAttribute('disabled')).toBe(false);
  });
});

describe('an item', () => {
  it('shows each mapped field with where it came from, its pull requests and where it runs', async () => {
    await open(item('settlement', 'corp-ado:2305'));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Schedule the export job');
    expect(screen.getByText('Microsoft.VSTS.Scheduling.OriginalEstimate')).toBeTruthy();
    expect(screen.getByText(/read with/).textContent).toContain('toil ado work-item get-many');
    expect(screen.getByRole('link', { name: 'Schedule the settlement export job' }).getAttribute('href')).toBe('https://ado.imagile.dev/DefaultCollection/Payments/_git/settlement/pullrequest/84');
    expect(screen.getByText(/settlement-deploy 20261008.1/).textContent).toContain('test');
  });

  it('shows its insights, each with its source, and its time in progress', async () => {
    await open(item('settlement', 'corp-ado:2304'));
    const box = screen.getByRole('region', { name: 'Insights' });
    expect(box.textContent).toContain('Aging');
    expect(box.textContent).toContain('Carried over from Payments\\Sprint 41');
    expect(box.textContent).toContain('Source: history.iterations');
    expect(box.textContent).toMatch(/In progress for 15 days, since 28 Sept? 2026, 09:00 UTC/);
  });

  it('says so when the item is not in the dossier, with a way back', async () => {
    await open('#/dossier/card-payments/item/corp-jira%3ANOPE-1');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('No such item');
    expect(screen.getByRole('link', { name: 'Back to card-payments' }).getAttribute('href')).toBe('#/dossier/card-payments');
  });
});

describe('keyboard and focus', () => {
  it('starts with a skip link, and a new view moves focus to its heading', async () => {
    await open('#/');
    (document.activeElement as HTMLElement | null)?.blur(); // Start from the top of the page.
    await userEvent.tab();
    expect(document.activeElement?.textContent).toContain('Skip to content');
    await userEvent.keyboard('{Enter}');
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Dossiers' }));
    await act(async () => {
      window.location.hash = '#/dossier/checkout-web';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'checkout-web' })));
  });
});

describe('themes', () => {
  it('opens in Crate, switches to Plain without changing the layout, and remembers the choice (#277)', async () => {
    await open('#/dossier/card-payments');
    const before = screen.getAllByRole('button').map((b) => b.textContent);
    expect(document.documentElement.dataset.theme).toBe('crate');
    // Appearance lives in Settings and the palette, never the header (#507).
    expect(screen.queryByRole('button', { name: /Appearance/ })).toBeNull();
    await openChat('card-payments');
    expect(document.querySelector('.ask img')?.getAttribute('alt')).toBe('');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: /Theme/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Plain' }));
    expect(document.documentElement.dataset.theme).toBe('plain');
    expect(screen.queryByRole('button', { name: /Appearance/ })).toBeNull();
    await openChat('card-payments');
    expect(document.querySelector('.ask img')).toBeNull();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getAllByRole('button').map((b) => b.textContent).filter((t) => !/Plain|Crate|System/.test(t ?? ''))).toEqual(before.filter((t) => !/Plain|Crate|System/.test(t ?? '')));
    expect(JSON.parse(localStorage.getItem('toil-ui.theme')!)).toEqual({ theme: 'plain', scheme: 'system', wording: true, voice: true });
  });

  it('picks Appearance in Settings, not the header', async () => {
    await open('#/settings/toil');
    await userEvent.click(await screen.findByRole('button', { name: /Appearance/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Dark' }));
    expect(document.documentElement.dataset.scheme).toBe('dark');
  });

  it('takes the theme and scheme from the address first', async () => {
    window.history.replaceState(null, '', '/?theme=plain&scheme=dark');
    localStorage.setItem('toil-ui.theme', JSON.stringify({ theme: 'crate' }));
    await open('#/');
    expect(document.documentElement.dataset.theme).toBe('plain');
    expect(document.documentElement.dataset.scheme).toBe('dark');
    window.history.replaceState(null, '', '/');
  });
});

describe('how deep the theme goes (#283)', () => {
  const setTheme = (theme: string, more: Record<string, unknown> = {}) => localStorage.setItem('toil-ui.theme', JSON.stringify({ theme, ...more }));

  it('says the empty states, loading lines and notes in the theme\'s words, and the standard ones with wording off', async () => {
    setTheme('crate');
    await open('#/dossier/checkout-web/dependencies');
    await waitFor(() => expect(panel('Dependencies').textContent).toContain("No links between this dossier's items: every crate stands on its own."));
    cleanupView();
    setTheme('crate', { wording: false });
    await open('#/dossier/checkout-web/dependencies');
    await waitFor(() => expect(panel('Dependencies').textContent).toContain("No links between this dossier's items."));
    expect(panel('Dependencies').textContent).not.toContain('every crate');
  });

  it('never changes a control, a heading or a figure: the same buttons, links and headings with wording on and off', async () => {
    const names = () => ['button', 'link', 'heading', 'checkbox', 'textbox'].flatMap((role) => screen.queryAllByRole(role).map((el) => `${role}: ${el.textContent}`));
    setTheme('realm', { wording: false });
    await open('#/dossier/card-payments');
    const off = names();
    cleanupView();
    setTheme('realm');
    await open('#/dossier/card-payments');
    expect(names()).toEqual(off.map((n) => n.replace(/^heading: Sprint 42(?=:)/, 'heading: Ledger (Sprint 42').replace(/^(heading: Ledger \(Sprint 42: day \d+ of \d+)$/, '$1)').replace(/^heading: Dependencies$/, 'heading: War table (Dependencies)')));
  });

  it('has both boxes on by default under the theme picker, and turns both off, with a note, for Plain', async () => {
    await open('#/settings/toil');
    const card = screen.getByRole('region', { name: 'Theme' });
    const wording = within(card).getByRole('checkbox', { name: 'Themed wording' }) as HTMLInputElement;
    const voice = within(card).getByRole('checkbox', { name: 'Themed agent voice' }) as HTMLInputElement;
    expect([wording.checked, voice.checked]).toEqual([true, true]);
    await userEvent.click(wording);
    expect(JSON.parse(localStorage.getItem('toil-ui.theme')!)).toMatchObject({ theme: 'crate', wording: false, voice: true });
    expect(within(card).getByRole('button', { name: 'About themed wording' })).toBeTruthy();
    cleanupView();
    setTheme('plain');
    const { container } = await open('#/settings/toil');
    const plain = screen.getByRole('region', { name: 'Theme' });
    for (const name of ['Themed wording', 'Themed agent voice']) {
      const box = within(plain).getByRole('checkbox', { name }) as HTMLInputElement;
      expect(box.checked).toBe(false);
      expect(box.disabled).toBe(true);
    }
    expect(plain.textContent).toContain('Plain has no wording or voice of its own, so both are off');
    expect(await violations(container)).toEqual([]);
  }, AXE_TIMEOUT);

  it('answers in the theme\'s voice with the voice on, and in the standard words with it off', async () => {
    setTheme('crate');
    await open('#/dossier/card-payments');
    await openChat('card-payments');
    await userEvent.click(within(screen.getByRole('group', { name: 'Starter questions' })).getAllByRole('button')[0]!);
    expect(await screen.findByText(/3 of 21 points are on the truck/, {}, { timeout: 4000 })).toBeTruthy();
    cleanupView();
    setTheme('crate', { voice: false });
    await open('#/dossier/card-payments');
    await openChat('card-payments');
    await userEvent.click(within(screen.getByRole('group', { name: 'Starter questions' })).getAllByRole('button')[0]!);
    expect(await screen.findByText(/3 of 21 points are done and 18 remain/, {}, { timeout: 4000 })).toBeTruthy();
  });

  it('explains the answers from an (i) beside the questions, by keyboard, and closes on Escape', async () => {
    setTheme('harvest');
    const { container } = await open('#/dossier/settlement');
    await openChat('settlement');
    const info = screen.getByRole('button', { name: 'About these answers' });
    info.focus();
    await userEvent.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'About these answers' });
    expect(dialog.textContent).toContain("Answers are written in Harvest's voice, or in your own custom voice if you saved one. A voice changes their phrasing only");
    expect(dialog.textContent).toContain('Answered by a scripted preview, not a model.');
    expect(dialog.textContent).toContain('The agent only reads');
    expect(within(dialog).getByRole('link', { name: 'Settings, Agent' }).getAttribute('href')).toBe('#/settings/agent');
    expect(within(dialog).getByRole('link', { name: 'Settings, General' }).getAttribute('href')).toBe('#/settings/toil');
    expect(await violations(container)).toEqual([]);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'About these answers' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(info));
    cleanupView();
    setTheme('harvest', { voice: false });
    await open('#/dossier/settlement');
    await openChat('settlement');
    await userEvent.click(screen.getByRole('button', { name: 'About these answers' }));
    expect((await screen.findByRole('dialog', { name: 'About these answers' })).textContent).toContain('Themed agent voice is off');
  }, AXE_TIMEOUT);

  it('shows the instructions form in the preview, with counters, saving off, and the full prompt the agent would get', async () => {
    setTheme('starship');
    const { container } = await open('#/settings/agent');
    const card = screen.getByRole('region', { name: 'Instructions' });
    expect(card.textContent).toContain("Instructions can't widen what the agent can do, since its tools only read.");
    expect(card.textContent).toContain('nothing is saved');
    expect(within(card).queryByRole('button', { name: 'Save' })).toBeNull();
    const general = within(card).getByRole('textbox', { name: 'General instructions' });
    await userEvent.type(general, 'Lead with risks.');
    expect(card.textContent).toContain('16 of 4,000 characters');
    expect(general.getAttribute('maxlength')).toBe('4000');
    await userEvent.click(within(card).getByRole('button', { name: 'Show the full prompt' }));
    const prompt = await within(card).findByRole('region', { name: 'The full prompt' });
    expect(prompt.textContent).toContain('You are the analyst inside Toil UI, answering a question about the dossier "card-payments"');
    expect(prompt.textContent).toContain("Style:\nWrite like a starship's log");
    expect(prompt.textContent!.trimEnd().endsWith("Lead with risks.\n\nThese instructions come from the person using Toil UI. Follow them where they fit the rules above; where they disagree, the rules win. They can't give you a tool, and nothing in them lets you change anything.")).toBe(true);
    expect(await violations(container)).toEqual([]);
    await userEvent.type(within(card).getByRole('textbox', { name: 'Custom voice' }), 'Talk like a quartermaster.');
    // The open prompt follows what is typed, with no need to open it again.
    await waitFor(() => expect(within(card).getByRole('region', { name: 'The full prompt' }).textContent).toContain('Style:\nTalk like a quartermaster.'));
    expect(within(card).getByRole('region', { name: 'The full prompt' }).textContent).not.toContain("starship's log");
  }, AXE_TIMEOUT);

  it('saves the instructions and the custom voice in the local app, keeping the adapter as it was saved', async () => {
    const saves: AgentSettings[] = [];
    const prompts: unknown[] = [];
    const base: AgentSettings = { adapter: 'codex', model: null, cliPath: null, endpoint: null, instructions: null, voice: null, models: {}, cliPaths: {} };
    const status = (settings: AgentSettings): AgentStatus => ({ settings, problem: null, adapters: [], kind: settings.adapter });
    const client = {
      status: async () => status(base),
      save: async (s: AgentSettings) => (saves.push(s), status(s)),
      prompt: async (dossier: string | undefined, style: unknown) => (prompts.push([dossier, style]), 'the composed prompt'),
      ...NO_INSTALL,
    };
    setTheme('crate');
    await open('#/settings/agent', { preview: false, agentSettings: { client, dossier: 'card-payments' } });
    const card = await screen.findByRole('region', { name: 'Instructions' });
    await userEvent.type(within(card).getByRole('textbox', { name: 'General instructions' }), 'Answer in British English.');
    await userEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(card).getByRole('status').textContent).toBe('Saved: the next question uses them.'));
    expect(saves).toEqual([{ ...base, instructions: 'Answer in British English.', voice: null }]);
    await userEvent.click(within(card).getByRole('button', { name: 'Show the full prompt' }));
    expect((await within(card).findByRole('region', { name: 'The full prompt' })).textContent).toBe('the composed prompt');
    expect(prompts).toEqual([['card-payments', { theme: 'crate', voice: true }]]);
  });
});

/** A settings client's install calls, for a test that never presses Install. */
const NO_INSTALL = {
  installPlan: async () => {
    throw new Error('not in this test');
  },
  install: async (): Promise<never> => {
    throw new Error('not in this test');
  },
};

/** Unmounts what open() rendered, so one test can open a view twice. */
function cleanupView() {
  cleanup();
  window.location.hash = '';
}

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
    await open('#/dossier/checkout-web/people');
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
    expect(cards("Not in the dossier's people").map((c) => within(c).getByRole('heading', { level: 3 }).textContent)).toEqual(['Bo W.']);
    expect(document.body.textContent).toContain('1 pull request was written with an agent the dossier\'s people don\'t name (branch copilot/receipt-currency).');
    // Load, never a score.
    expect(document.querySelector('main')!.textContent).not.toMatch(/\b(score|rank(ed|ing)?|leaderboard|productivity)\b/i);
  });

  it('suggests a match by email with the command that applies it, turned off in the preview', async () => {
    await open('#/dossier/card-payments/people');
    const matches = panel('Possible matches');
    expect(matches.textContent).toContain("Bitbucket achen (A. Chen) has A. Chen's email (you@example.com): probably A. Chen.");
    expect(matches.textContent).toContain('Applies toil dossiers person card-payments "A. Chen" --id bitbucket=achen');
    const button = within(matches).getByRole('button', { name: 'Map to A. Chen' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(matches.textContent).toContain('Turned off: This is the preview');
    expect(document.body.textContent).toContain('1 bot account (svc-renovate) only wrote bots\' pull requests and is left out.');
  });

  it('applies a match only when a person presses it, through toil dossiers person', async () => {
    const { config, sent } = recording();
    await open('#/dossier/card-payments/people', { config });
    expect(sent).toEqual([]);
    await userEvent.click(within(panel('Possible matches')).getByRole('button', { name: 'Map to A. Chen' }));
    expect(await within(panel('Possible matches')).findByText("Mapped in card-payments's people. Reload the dossier to see the cards change.")).toBeTruthy();
    expect(sent).toEqual([{ command: 'dossiers person', input: { dossier: 'card-payments', name: 'A. Chen', id: ['bitbucket=achen'] } }]);
  });

  it('gives every account its own card when the dossier lists nobody, and says how to map them', async () => {
    await open('#/dossier/settlement/people');
    expect(screen.queryByRole('heading', { level: 2, name: 'People and agents' })).toBeNull();
    expect(cards("Accounts in this dossier's data").map((c) => within(c).getByRole('heading', { level: 3 }).textContent)).toEqual(['D. Okafor', 'J. Park', 'K. Nakamura', 'M. Lind']);
    expect(document.body.textContent).toContain('toil dossiers person settlement "Pat Example" --id jira=pat --id github=pat-ex');
    expect(panel('Team').textContent).toContain('No limit is set in the dossier.');
  });

  it("opens a person's items on the board, filtered to them, with the way back", async () => {
    await open('#/dossier/card-payments/people');
    const link = within(screen.getByRole('article', { name: 'J. Smith' })).getByRole('link', { name: "J. Smith's items on the board" });
    expect(link.getAttribute('href')).toBe('#/dossier/card-payments/board/person%3AJ.%20Smith');
    cleanup();
    await open('#/dossier/card-payments/board/person%3AJ.%20Smith');
    const filter = document.getElementById('board-filter')!;
    expect(filter.textContent).toMatch(/^Showing J\. Smith's items: \d+ items? on this board/);
    const board = panel('Sprint 42 board');
    const shown = within(board).getAllByRole('listitem').filter((li) => li.classList.contains('card'));
    expect(shown.length).toBeGreaterThan(0);
    for (const card of shown) expect(card.textContent).toContain('J. Smith');
    expect(within(filter).getByRole('link', { name: "Show everyone's" }).getAttribute('href')).toBe('#/dossier/card-payments/board');
  });

  it('says so when a board link names nobody', async () => {
    await open('#/dossier/card-payments/board/person%3ANobody');
    expect(document.getElementById('board-filter')!.textContent).toContain("The People view's link named nobody this dossier's data shows");
  });

  it('shows the people and the limit on the settings page, with forms to add a person and set the limit', async () => {
    await open('#/settings/dossiers');
    const card = await screen.findByRole('article', { name: 'card-payments' });
    await userEvent.click(within(card).getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(card.textContent).toContain('J. Smith jira jsmith, bitbucket jsmith'));
    expect(card.textContent).toContain('Work-in-progress limit: 2 per person.');
    const person = screen.getByRole('form', { name: /Add a person to/ });
    expect(person.textContent).toContain('--remove');
    expect(screen.getByRole('form', { name: /work-in-progress limit/ }).textContent).toContain('toil dossiers wip-limit');
  });
});

describe('the readiness gate (#307)', () => {
  const rows = () => within(panel('Ready for an agent?')).getAllByRole('listitem').map((li) => li.textContent ?? '');

  it('shows the verdict and its five rows on an item, with no live read until a person asks for one', async () => {
    const fixture = fixtureExecute();
    await open(item('card-payments', 'corp-jira:PAY-102'), { execute: fixture.execute });
    const box = panel('Ready for an agent?');
    expect(box.querySelector('.verdict')!.textContent).toBe('✕ Blocked');
    expect(rows().map((r) => /^.(Acceptance criteria|Description|Done state|Blockers|Scope) (Passes|Thin|Fails)/.exec(r)?.slice(1).join(' '))).toEqual([
      'Acceptance criteria Passes',
      'Description Thin',
      'Done state Passes',
      'Blockers Fails',
      'Scope Passes',
    ]);
    expect(box.textContent).toContain('Blocked by Jira PAY-101 (In Progress).');
    expect(within(box).getByRole('link', { name: /PAY-101/ }).getAttribute('href')).toBe('#/dossier/card-payments/item/corp-jira%3APAY-101');
    expect(fixture.calls.filter((c) => c.command === 'jira issue transitions')).toEqual([]);
  });

  it('settles the done state with one read-only live read when pressed', async () => {
    const fixture = fixtureExecute();
    await open(item('card-payments', 'corp-jira:PAY-100'), { execute: fixture.execute });
    expect(rows()[2]).toContain('no Epic in this dossier has reached Done');
    await userEvent.click(screen.getByRole('button', { name: 'Check the workflow live' }));
    await waitFor(() => expect(rows()[2]).toContain('It can move to Done now: Done.'));
    expect(rows()[2]).toContain('Source: toil jira issue transitions');
    expect(fixture.calls.filter((c) => c.command === 'jira issue transitions')).toEqual([{ command: 'jira issue transitions', input: { dossier: 'card-payments', key: 'PAY-100' }, ok: true, error: null }]);
    expect(screen.getByRole('button', { name: 'Read the workflow again' })).toBeTruthy();
    // The read belongs to that item: the next item's page starts without it.
    await act(async () => {
      window.location.hash = item('card-payments', 'corp-jira:PAY-104');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await screen.findByRole('heading', { level: 1, name: /Refund total/ });
    expect(screen.getByRole('button', { name: 'Check the workflow live' })).toBeTruthy();
    expect(rows()[2]).not.toContain('toil jira issue transitions');
  });

  it("reads an Azure DevOps type's states, and says so when the read fails", async () => {
    await open(item('settlement', 'corp-ado:2301'));
    await userEvent.click(screen.getByRole('button', { name: 'Check the workflow live' }));
    await waitFor(() => expect(rows()[2]).toContain('The Feature workflow has a Done state: Closed.'));
    cleanup();
    const failing: Execute = async (command, input, options) =>
      command === 'ado work-item states'
        ? { ok: false, data: null, error: { code: 'AUTH', message: 'The token was refused.', fix: 'Renew it.' }, meta: { command, durationMs: 0, version: 'x', contractVersion: 1 } }
        : fixtureExecute().execute(command, input, options);
    await open(item('settlement', 'corp-ado:2301'), { execute: failing });
    await userEvent.click(screen.getByRole('button', { name: 'Check the workflow live' }));
    await waitFor(() => expect(rows()[2]).toContain('The live read failed: The token was refused. Renew it.'));
  });

  it('lists every open item with its verdict and why, slates only the ready ones, and keeps the start for #293', async () => {
    const fixture = fixtureExecute();
    await open('#/dossier/card-payments/command-center', { execute: fixture.execute });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Command Center');
    // The Command Center is the Board tab's readiness view (#394).
    expect(within(tabs('card-payments')).getByRole('link', { name: /^Board/ }).getAttribute('aria-current')).toBe('page');
    expect(within(screen.getByRole('navigation', { name: 'Board views' })).getByRole('link', { name: 'Readiness (Command Center)' }).getAttribute('aria-current')).toBe('page');
    const tally = screen.getByRole('list', { name: 'Open items by verdict' });
    expect([...tally.querySelectorAll('.team-figure')].map((f) => f.textContent)).toEqual(['1', '3', '2']);
    const slate = panel('Start every ready item');
    expect(within(slate).getByRole('list', { name: 'Slated items' }).textContent).toContain('PAY-101');
    expect(slate.textContent).toMatch(/1 item is ready and would be slated, in the dossier's order \(plan [0-9a-f]{8}\)\./);
    const start = within(slate).getByRole('button', { name: 'Start 1 ready item' });
    expect(start.hasAttribute('disabled')).toBe(true);
    expect(slate.textContent).toContain('This view has no agent assignments, so it shows the plan it would start.');
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(7);
    expect(table.textContent).toContain('Blocked by Jira PAY-102 (To Do).');
    expect(screen.getByText('Showing 6 items of 12.')).toBeTruthy();
    // No live read, and nothing beyond what the dashboard already loaded.
    expect(fixture.calls.filter((c) => c.command === 'jira issue transitions')).toEqual([]);
  });

  it('filters by verdict, status and assignee', async () => {
    await open('#/dossier/card-payments/command-center');
    const pick = async (label: RegExp, option: string) => {
      await userEvent.click(screen.getByRole('button', { name: label }));
      await userEvent.click(screen.getByRole('option', { name: option }));
    };
    await pick(/Verdict/, 'Blocked');
    expect(screen.getByText('Showing 2 items of 12.')).toBeTruthy();
    await pick(/Status/, 'All');
    expect(screen.getByText('Showing 8 items of 12.')).toBeTruthy();
    await pick(/Verdict/, 'Ready');
    await pick(/Assignee/, 'Unassigned');
    expect(screen.getByText('No item matches these filters.')).toBeTruthy();
  });

  it('says plainly when nothing is ready, and starts the plan it showed once #293 provides a start', async () => {
    await open('#/dossier/settlement/command-center');
    expect(panel('Start every ready item').textContent).toContain('No open item is ready, so nothing would be slated.');
    cleanup();
    const started: Array<{ id: string; items: string[] }> = [];
    window.location.hash = '#/dossier/checkout-web/command-center';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview startReady={async (plan) => (started.push(plan), "Queued.")} />);
    await screen.findByRole('heading', { level: 1, name: 'Command Center' });
    const slate = panel('Start every ready item');
    const shownId = /\(plan ([0-9a-f]{8})\)/.exec(slate.textContent ?? '')![1];
    expect(slate.textContent).toContain('Assigns each item above to an agent in implement mode, as listed');
    await userEvent.click(within(slate).getByRole('button', { name: 'Start 1 ready item' }));
    expect(started).toEqual([{ id: shownId, items: ['github:imagile/payments-web#41'] }]);
    expect(await within(slate).findByText('Queued.')).toBeTruthy();
  });
});

describe('the worklog (#308)', () => {
  it('is a route per dossier, and per UTC day', () => {
    expect(parseRoute('#/dossier/card-payments/worklog')).toEqual({ view: 'worklog', dossier: 'card-payments', day: null });
    expect(parseRoute('#/dossier/card-payments/worklog/2026-10-12')).toEqual({ view: 'worklog', dossier: 'card-payments', day: '2026-10-12' });
    expect(parseRoute('#/dossier/card-payments/worklog/2026-02-30')).toEqual({ view: 'worklog', dossier: 'card-payments', day: null });
  });

  it("opens on today's page, linked from the header, with the calendar of days that have one", async () => {
    await open('#/dossier/card-payments/worklog');
    expect(within(tabs('card-payments')).getByRole('link', { name: 'Worklog' }).getAttribute('aria-current')).toBe('page');
    await screen.findByRole('heading', { name: 'Tuesday 13 October 2026' });
    const today = screen.getByRole('link', { name: /Tuesday 13 October 2026, today/ });
    expect(today.getAttribute('aria-current')).toBe('date');
    expect(today.getAttribute('href')).toBe('#/dossier/card-payments/worklog/2026-10-13');
    // The line is built from the syncs, which can land after the heading on a loaded runner.
    expect(await screen.findByText(/^Today so far: built from the syncs up to 07:55 UTC/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next month' }).getAttribute('data-disabled')).not.toBeNull();
  });

  it('marks today as today on the calendar before it has a page, so no theme reads it as a past day (#415)', async () => {
    const base = fixtureWorklog();
    const worklog: WorklogApi = { ...base, month: async (dossier, month) => {
      const m = await base.month(dossier, month);
      return { ...m, days: m.days.filter((d) => d.day !== m.today) };
    } };
    const { container } = await open('#/dossier/card-payments/worklog', { worklog });
    await screen.findByRole('heading', { name: 'Tuesday 13 October 2026' });
    await waitFor(() => expect(container.querySelector('td.calendar__empty[data-today]')).not.toBeNull());
    expect(container.querySelector('td.calendar__empty[data-today]')!.textContent).toContain('today: no page');
  });

  it("shows a day's facts, each linked to its source, the agent's run with whether its proposal was applied, and the note", async () => {
    const { container } = await open('#/dossier/card-payments/worklog/2026-10-12');
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
    await open('#/dossier/checkout-web/worklog/2026-10-12');
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
      addNote: async (dossier, text) => {
        added.push(text);
        const d: WorklogDay = await sample.day(dossier, '2026-10-13');
        return { ...d, page: { ...d.page, notes: [{ id: 'n', at: FIXTURE_NOW, by: 'You', text }] } };
      },
      exportTo: async (dossier, what, folder) => (exported.push({ dossier, what, folder }), { path: 'C:/Users/you/Documents/worklog-card-payments-2026-10-13.md', bytes: 1234, proposals: [] }),
    };
    await open('#/dossier/card-payments/worklog', { worklog: api });
    await userEvent.type(await screen.findByRole('textbox', { name: "Add a note to today's page" }), 'Paired on PAY-101');
    await userEvent.click(screen.getByRole('button', { name: 'Add the note' }));
    expect(await screen.findByText('Paired on PAY-101')).toBeTruthy();
    expect(added).toEqual(['Paired on PAY-101']);
    await userEvent.type(screen.getByRole('textbox', { name: 'Folder, as a full path' }), 'C:/Users/you/Documents');
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect((await screen.findByText(/^toil wrote 1234 bytes to/)).textContent).toContain('worklog-card-payments-2026-10-13.md');
    expect(screen.getByText(/names no Confluence space and no GitHub repository/)).toBeTruthy();
    expect(exported).toEqual([{ dossier: 'card-payments', what: { day: '2026-10-13' }, folder: 'C:/Users/you/Documents' }]);
  });

  it('says plainly when there is no worklog to show', async () => {
    await open('#/dossier/card-payments/worklog', { worklog: null });
    expect(screen.getByRole('alert').textContent).toBe('This Toil UI keeps no worklog: it has no cache to fold one from.');
  });
});

describe('the stand-up (#345)', () => {
  it('is a route under the worklog, since the last working day or for a range of days', () => {
    expect(parseRoute('#/dossier/card-payments/worklog/standup')).toEqual({ view: 'standup', dossier: 'card-payments', from: null, to: null });
    expect(parseRoute('#/dossier/card-payments/worklog/standup/2026-10-09/2026-10-13')).toEqual({ view: 'standup', dossier: 'card-payments', from: '2026-10-09', to: '2026-10-13' });
    // One day is a one-day stand-up; anything that isn't a day is named on the page, never dropped quietly.
    expect(parseRoute('#/dossier/card-payments/worklog/standup/2026-10-09')).toEqual({ view: 'standup', dossier: 'card-payments', from: '2026-10-09', to: '2026-10-09' });
    expect(parseRoute('#/dossier/card-payments/worklog/standup/2026-10-09/monday')).toEqual({ view: 'standup', dossier: 'card-payments', from: null, to: null, ignored: 'monday' });
  });

  it('is linked from the worklog, and folds since the last working day into team lines and a card per person', async () => {
    await open('#/dossier/card-payments/worklog');
    expect(screen.getByRole('link', { name: 'Stand-up since the last working day' }).getAttribute('href')).toBe('#/dossier/card-payments/worklog/standup');
    cleanup();
    const view = await open('#/dossier/card-payments/worklog/standup');
    expect(within(tabs('card-payments')).getByRole('link', { name: 'Worklog' }).getAttribute('aria-current')).toBe('page');
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
    await open('#/dossier/card-payments/worklog/standup/2026-10-12/2026-10-12');
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
    await open('#/dossier/card-payments/worklog/standup/2026-10-12/2026-10-13', { agent: { ...agent, ask: (d, p, style, chat) => (asked.push(p), agent.ask(d, p, style, chat)) } });
    await screen.findByRole('heading', { name: /^Stand-up: card-payments/ });
    await userEvent.click(screen.getByRole('button', { name: 'Write it up' }));
    expect(await screen.findByRole('heading', { name: 'Written by the agent (a scripted preview, not a model), not by Toil UI' })).toBeTruthy();
    expect(asked).toEqual(['Write up the stand-up for 2026-10-12 to 2026-10-13']);
    expect(screen.getByText(/^Rests on 2 fact lines of the report/)).toBeTruthy();
    expect(document.getElementById('fact-F1')!.getAttribute('data-cited')).toBe('true');
    expect(document.getElementById('fact-F3')!.getAttribute('data-cited')).toBeNull();
  });

  it('says what it ignored in the URL, and shows since the last working day', async () => {
    await open('#/dossier/card-payments/worklog/standup/yesterday');
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
    await open('#/dossier/card-payments/worklog/standup/2026-10-12/2026-10-13', { worklog: api });
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
    const api: WorklogApi = { ...sample, disabled: null, standup: (d, f, t) => sample.standup(d, f, t), exportTo: async (dossier, what, folder) => (exported.push({ dossier, what, folder }), { path: 'C:/Users/you/Documents/standup-card-payments-2026-10-12-to-2026-10-13.md', bytes: 99, proposals: [] }) };
    await open('#/dossier/card-payments/worklog/standup/2026-10-12/2026-10-13', { worklog: api });
    await screen.findByRole('heading', { name: /^Stand-up: card-payments/ });
    await userEvent.type(screen.getByRole('textbox', { name: 'Folder, as a full path' }), 'C:/Users/you/Documents');
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect((await screen.findByText(/^toil wrote 99 bytes to/)).textContent).toContain('standup-card-payments-2026-10-12-to-2026-10-13.md');
    expect(exported).toEqual([{ dossier: 'card-payments', what: { from: '2026-10-12', to: '2026-10-13' }, folder: 'C:/Users/you/Documents' }]);
  });

  it('says what was wrong with a range, and when there is no worklog', async () => {
    await open('#/dossier/card-payments/worklog/standup/2026-10-13/2026-10-12');
    expect((await screen.findByText(/^The range starts/)).textContent).toBe('The range starts (2026-10-13) after it ends (2026-10-12).');
    cleanup();
    await open('#/dossier/card-payments/worklog/standup', { worklog: null });
    expect(screen.getByRole('alert').textContent).toBe('This Toil UI keeps no worklog, so it has no stand-up to fold from one.');
  });
});
