// @vitest-environment jsdom
// Every theme speaks for the agent in its own voice, and each voice was approved by a committee that has since been dissolved.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { NO_AGENT_NOTICE, type Agent } from '../src/agent.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { openChat } from './chat.ts';
import { CANNED, callKey, fixtureExecute, type Canned } from '../src/fixtures/execute.ts';
import type { AgentSettings, AgentStatus } from '../src/server-client.ts';
import { item, open, AXE_TIMEOUT, violations, panel, cleanupView, NO_INSTALL, resetBrowserState } from './views-kit.tsx';

beforeEach(resetBrowserState);

describe('the agent pane, with a real adapter', () => {
  it('says plainly when no agent is set up', async () => {
    const agent: Agent = { notice: NO_AGENT_NOTICE, noticeDetails: 'Toil UI uses Claude, GitHub Copilot or Codex.', starters: () => [], ask: () => Promise.reject(new Error('none')) };
    await open('#/project/card-payments', { agent, preview: false });
    const chat = await openChat('card-payments');
    // In everyday words first (#552; these tests read toil's own terms, and the plain wording is in guided-ask.test.tsx): none yet, and where an engineer sets one up. The packages are one step in, behind a fold.
    const notice = within(chat).getByText(/No AI agent is set up yet/).closest('[data-no-agent]')!;
    expect(within(notice as HTMLElement).getByRole('link', { name: 'Set up an AI agent' }).getAttribute('href')).toBe('#/settings/agent');
    const fold = notice.querySelector('details')!;
    expect(fold.open).toBe(false);
    expect(fold.textContent).toContain('GitHub Copilot');
    expect(notice.querySelector('p')!.textContent).not.toContain('GitHub Copilot');
  });

  it("shows the server's checks above an answer: ids its tools never returned", async () => {
    const agent: Agent = {
      starters: () => [],
      ask: async () => ({
        prompt: 'Are we going to finish the sprint?',
        parts: [{ text: '[[corp-jira:PAY-101]] and [[corp-jira:PAY-999]].' }],
        citations: ['corp-jira:PAY-101', 'corp-jira:PAY-999'],
        by: 'Claude',
        proposals: [],
        unverified: ['corp-jira:PAY-999'],
        warnings: ['This answer names an item its tools never returned: corp-jira:PAY-999. Treat it as unverified.'],
      }),
    };
    const { container } = await open('#/project/card-payments', { agent, preview: false });
    await openChat('card-payments');
    await userEvent.click(await screen.findByRole('button', { name: /^Are we going to finish the sprint\?/ }));
    const checks = await screen.findByLabelText('Checks on this answer');
    expect(checks.textContent).toContain('corp-jira:PAY-999');
    expect(screen.getByText(/Names 1 its tools never returned/)).toBeTruthy();
    expect(await violations(container)).toEqual([]);
  }, AXE_TIMEOUT);
});

describe('failures', () => {
  it("shows a failed call on its own panel with toil's message and fix, and the rest still loads", async () => {
    const without = (c: Canned) => !(c.command === 'bitbucket pr list');
    await open('#/project/card-payments/prs', { execute: fixtureExecute(CANNED.filter(without)).execute });
    expect(screen.getAllByRole('alert').map((a) => a.textContent).join(' ')).toMatch(/Reading Bitbucket failed: The preview has no sample answer .* Add the call to CANNED/);
    window.location.hash = '#/project/card-payments/board';
    expect((await screen.findByRole('region', { name: 'Sprint 42 board' })).textContent).toContain('PAY-102');
  });

  it('says the data did not load when projects show fails', async () => {
    const execute = fixtureExecute(CANNED.filter((c) => callKey(c.command, c.input) !== callKey('projects show', { toilProject: 'settlement' }))).execute;
    await open('#/project/settlement', { execute });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain("The data didn't load");
    expect(alert.textContent).toContain('projects show');
  });

  it('says the agent failed, in the answer pane, when ask() rejects', async () => {
    const agent: Agent = { starters: scriptedAgent().starters, ask: () => Promise.reject(new Error('model endpoint unreachable')) };
    await open('#/project/checkout-web', { agent });
    await openChat('checkout-web');
    await userEvent.click(await screen.findByRole('button', { name: /^Are we going to finish the sprint\?/ }));
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
    expect(document.body.textContent).not.toContain('toil ado work-item get-many');
    expect(screen.getByRole('link', { name: 'Schedule the settlement export job' }).getAttribute('href')).toBe('https://ado.imagile.dev/DefaultCollection/Payments/_git/settlement/pullrequest/84');
    expect(screen.getByText(/settlement-deploy 20261008.1/).textContent).toContain('test');
  });

  it('shows its insights, each with its source, and its time in progress', async () => {
    await open(item('settlement', 'corp-ado:2304'));
    const box = screen.getByRole('region', { name: 'Worth a look' });
    expect(box.textContent).toContain('Open a long time');
    expect(box.textContent).toContain('Carried over from Payments\\Sprint 41');
    expect(box.textContent).toContain('Source: history.iterations');
    expect(box.textContent).toMatch(/In progress for 15 days, since 28 Sept? 2026, 09:00 UTC/);
  });

  it('says so when the item is not in the Toil project, with a way back', async () => {
    await open('#/project/card-payments/item/corp-jira%3ANOPE-1');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('No such item');
    expect(screen.getByRole('link', { name: 'Back to card-payments' }).getAttribute('href')).toBe('#/project/card-payments');
  });
});

describe('keyboard and focus', () => {
  it('starts with a skip link, and a new view moves focus to its heading', async () => {
    await open('#/');
    (document.activeElement as HTMLElement | null)?.blur(); // Start from the top of the page.
    await userEvent.tab();
    expect(document.activeElement?.textContent).toContain('Skip to content');
    await userEvent.keyboard('{Enter}');
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Toil projects' }));
    await act(async () => {
      window.location.hash = '#/project/checkout-web';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'checkout-web' })));
  });
});

describe('themes', () => {
  it('opens in Crate, switches to Plain without changing the layout, and remembers the choice (#277)', async () => {
    await open('#/project/card-payments');
    const before = screen.getAllByRole('button').map((b) => b.textContent);
    expect(document.documentElement.dataset.theme).toBe('crate');
    // Appearance lives in Settings and the palette, never the header (#507).
    expect(screen.queryByRole('button', { name: /Appearance/ })).toBeNull();
    await openChat('card-payments');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // A Toil project's own header carries no theme picker; the home page's does, and Settings has it too.
    expect(screen.queryByRole('button', { name: /Theme/ })).toBeNull();
    window.location.hash = '#/';
    await userEvent.click(await screen.findByRole('button', { name: /Theme/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Plain' }));
    expect(document.documentElement.dataset.theme).toBe('plain');
    expect(screen.queryByRole('button', { name: /Appearance/ })).toBeNull();
    window.location.hash = '#/project/card-payments';
    await screen.findByRole('region', { name: 'Briefing' });
    await openChat('card-payments');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getAllByRole('button').map((b) => b.textContent).filter((t) => !/Plain|Crate|System|Show more/.test(t ?? ''))).toEqual(before.filter((t) => !/Plain|Crate|System|Show more/.test(t ?? '')));
    expect(JSON.parse(localStorage.getItem('toil-ui.theme')!)).toEqual({ theme: 'plain', scheme: 'system', wording: true, voice: false });
  });

  it('picks Appearance in Settings, not the header', async () => {
    await open('#/settings/appearance');
    await userEvent.click(await screen.findByRole('button', { name: /Light or dark/ }));
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
  // Themed wording and voice start off (#552), so a test about a theme's words opts in, as a saved choice.
  const setTheme = (theme: string, more: Record<string, unknown> = {}) => localStorage.setItem('toil-ui.theme', JSON.stringify({ theme, wording: true, voice: true, ...more }));

  it('says the empty states, loading lines and notes in the theme\'s words, and the standard ones with wording off', async () => {
    setTheme('crate');
    await open('#/project/checkout-web/dependencies');
    await waitFor(() => expect(panel('What blocks what').textContent).toContain("No links between this Toil project's items: every crate stands on its own."));
    cleanupView();
    setTheme('crate', { wording: false });
    await open('#/project/checkout-web/dependencies');
    await waitFor(() => expect(panel('What blocks what').textContent).toContain("No links between this Toil project's items."));
    expect(panel('What blocks what').textContent).not.toContain('every crate');
  });

  it('never changes a control, a heading or a figure: the same buttons, links and headings with wording on and off', async () => {
    const names = () => ['button', 'link', 'heading', 'checkbox', 'textbox'].flatMap((role) => screen.queryAllByRole(role).map((el) => `${role}: ${el.textContent}`));
    setTheme('realm', { wording: false });
    await open('#/project/card-payments');
    const off = names();
    cleanupView();
    setTheme('realm');
    await open('#/project/card-payments');
    expect(names()).toEqual(off.map((n) => n.replace(/^heading: Sprint 42(?=:)/, 'heading: Ledger (Sprint 42').replace(/^(heading: Ledger \(Sprint 42: day \d+ of \d+)$/, '$1)').replace(/^heading: Dependencies$/, 'heading: War table (Dependencies)')));
  });

  it('has wording on and the voice off by default under the theme picker (#552, #561), switches each, and disables both, with a note, for Plain', async () => {
    await open('#/settings/appearance');
    const card = screen.getByRole('region', { name: 'Theme' });
    const wording = within(card).getByRole('checkbox', { name: 'Themed wording' }) as HTMLInputElement;
    const voice = within(card).getByRole('checkbox', { name: 'Themed agent voice' }) as HTMLInputElement;
    expect([wording.checked, voice.checked]).toEqual([true, false]);
    await userEvent.click(wording);
    expect(JSON.parse(localStorage.getItem('toil-ui.theme')!)).toMatchObject({ theme: 'crate', wording: false, voice: false });
    await userEvent.click(voice);
    expect(JSON.parse(localStorage.getItem('toil-ui.theme')!)).toMatchObject({ theme: 'crate', wording: false, voice: true });
    expect(within(card).getByRole('button', { name: 'About themed wording' })).toBeTruthy();
    cleanupView();
    setTheme('plain');
    const { container } = await open('#/settings/appearance');
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
    await open('#/project/card-payments');
    await openChat('card-payments');
    await userEvent.click(screen.getByRole('button', { name: /^Are we going to finish the sprint\?/ }));
    expect(await screen.findByText(/3 of 21 points are on the truck/, {}, { timeout: 4000 })).toBeTruthy();
    cleanupView();
    setTheme('crate', { voice: false });
    await open('#/project/card-payments');
    await openChat('card-payments');
    await userEvent.click(screen.getByRole('button', { name: /^Are we going to finish the sprint\?/ }));
    expect(await screen.findByText(/3 of 21 points are done and 18 remain/, {}, { timeout: 4000 })).toBeTruthy();
  });

  it('explains the answers from an (i) beside the questions, by keyboard, and closes on Escape', async () => {
    setTheme('harvest');
    const { container } = await open('#/project/settlement');
    await openChat('settlement');
    const info = screen.getByRole('button', { name: 'About these answers' });
    info.focus();
    await userEvent.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'About these answers' });
    expect(dialog.textContent).toContain("Answers are written in Harvest's voice, or in your own custom voice if you saved one. A voice changes their phrasing only");
    expect(dialog.textContent).toContain('Answered by a scripted preview, not a model.');
    expect(dialog.textContent).toContain('The AI agent only reads');
    expect(within(dialog).getByRole('link', { name: 'Settings, AI agent' }).getAttribute('href')).toBe('#/settings/agent');
    expect(within(dialog).getByRole('link', { name: 'Settings, Appearance' }).getAttribute('href')).toBe('#/settings/appearance');
    expect(await violations(container)).toEqual([]);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'About these answers' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(info));
    cleanupView();
    setTheme('harvest', { voice: false });
    await open('#/project/settlement');
    await openChat('settlement');
    await userEvent.click(screen.getByRole('button', { name: 'About these answers' }));
    expect((await screen.findByRole('dialog', { name: 'About these answers' })).textContent).toContain('Themed agent voice is off');
  }, AXE_TIMEOUT);

  it('shows the instructions form in the preview, with counters, saving off, and the full prompt the agent would get', async () => {
    setTheme('starship');
    const { container } = await open('#/settings/agent');
    const card = screen.getByRole('region', { name: 'Instructions' });
    expect(card.textContent).toContain("Instructions can't widen what the AI agent can do, since it can only read.");
    expect(card.textContent).toContain('nothing is saved');
    expect(within(card).queryByRole('button', { name: 'Save' })).toBeNull();
    const general = within(card).getByRole('textbox', { name: 'General instructions' });
    await userEvent.type(general, 'Lead with risks.');
    expect(card.textContent).toContain('16 of 4,000 characters');
    expect(general.getAttribute('maxlength')).toBe('4000');
    await userEvent.click(within(card).getByRole('button', { name: 'Show the full prompt' }));
    const prompt = await within(card).findByRole('region', { name: 'The full prompt' });
    expect(prompt.textContent).toContain('You are the analyst inside Toil UI, answering a question about the Toil project "card-payments"');
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
      prompt: async (toilProject: string | undefined, style: unknown) => (prompts.push([toilProject, style]), 'the composed prompt'),
      ...NO_INSTALL,
    };
    setTheme('crate');
    await open('#/settings/agent', { preview: false, agentSettings: { client, toilProject: 'card-payments' } });
    const card = await screen.findByRole('region', { name: 'Instructions' });
    await userEvent.type(within(card).getByRole('textbox', { name: 'General instructions' }), 'Answer in British English.');
    // No Save of their own: the page's one Save sends the AI agent and the instructions together.
    expect(within(card).queryByRole('button', { name: 'Save' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getAllByRole('status').map((s) => s.textContent).join(' ')).toContain('with your instructions'));
    expect(saves).toEqual([{ ...base, instructions: 'Answer in British English.', voice: null }]);
    await userEvent.click(within(card).getByRole('button', { name: 'Show the full prompt' }));
    expect((await within(card).findByRole('region', { name: 'The full prompt' })).textContent).toBe('the composed prompt');
    expect(prompts).toEqual([['card-payments', { theme: 'crate', voice: true }]]);
  });
});
