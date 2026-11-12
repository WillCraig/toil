// @vitest-environment jsdom
// The chat is tested against a scripted agent, which unlike a real one never asks for a meeting to discuss the answer.
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_HISTORY_ANSWER, MAX_HISTORY_TURNS, type AdapterList, type Agent, type AskExtra } from '../src/agent.ts';
import { askBar, openChat } from './chat.ts';
import { item, open, AXE_TIMEOUT, violations, cleanupView, resetBrowserState } from './views-kit.tsx';

beforeEach(resetBrowserState);

describe('the chat up front (#343)', () => {
  // Themed wording and voice start off (#552); the tests here that read a theme's own words opt in, as a saved choice.
  const setTheme = (theme: string) => localStorage.setItem('toil-ui.theme', JSON.stringify({ theme, wording: true, voice: true }));
  beforeEach(() => setTheme('plain'));

  it('is a bar on every Toil project page, with its placeholder in the theme\'s words and no Analyze button of its own (#552)', async () => {
    for (const route of ['#/project/card-payments', '#/project/card-payments/prs', '#/project/card-payments/people', '#/project/card-payments/worklog', item('card-payments', 'corp-jira:PAY-102')]) {
      await open(route);
      const bar = askBar('card-payments');
      expect(within(bar).getByRole('textbox', { name: 'Your question' }).getAttribute('placeholder')).toBe('Ask a question about card-payments');
      expect(within(bar).queryByRole('button', { name: /Analyze|briefing/ })).toBeNull();
      cleanupView();
    }
    setTheme('crate');
    await open('#/project/card-payments');
    expect(within(askBar('card-payments')).getByRole('textbox', { name: 'Your question' }).getAttribute('placeholder')).toBe('Ask a question about card-payments');
  });

  it('opens a focused view with the context strip, the guided start with its questions, and Escape to leave', async () => {
    setTheme('realm');
    const { container } = await open('#/project/card-payments');
    const chat = await openChat('card-payments');
    expect(within(chat).getByRole('heading', { level: 2, name: 'Ask about card-payments' })).toBeTruthy();
    expect(chat.textContent).toContain('Sprint 42, day 7 of 10');
    expect(chat.textContent).toContain('What would you like to know about card-payments?');
    expect(within(chat).getByRole('group', { name: 'Starter questions' }).querySelectorAll('button').length).toBe(9);
    expect(await violations(container)).toEqual([]);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ask about card-payments' })).toBeNull());
  }, AXE_TIMEOUT);

  it('folds the starters into Suggestions once a conversation starts, keeps it when closed, and shows how long the answer took', async () => {
    await open('#/project/settlement');
    let chat = await openChat('settlement');
    await userEvent.click(within(chat).getByRole('button', { name: /^Are we going to finish the sprint\?/ }));
    await waitFor(() => expect(chat.querySelector('[data-ask-status]')!.textContent).toMatch(/^Done in \d+ s$/));
    expect(within(chat).queryByRole('group', { name: 'Starter questions' })).toBeNull();
    await userEvent.click(within(chat).getByRole('button', { name: 'Suggestions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Who might need help?' }));
    await within(chat).findByRole('heading', { level: 3, name: 'Who might need help?' });
    await userEvent.click(within(chat).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ask about settlement' })).toBeNull());
    expect(askBar('settlement').textContent).toContain('2 questions in this chat');
    await userEvent.click(within(askBar('settlement')).getByRole('button', { name: 'Open the conversation' }));
    chat = await screen.findByRole('dialog', { name: 'Ask about settlement' });
    expect([...chat.querySelectorAll('.turn h3')].filter((h) => !h.closest('article')).map((h) => h.textContent)).toEqual(['Are we going to finish the sprint?', 'Who might need help?']);
  });

  describe('the thinking indicator (#561)', () => {
    /** An agent whose answer arrives when `release` is called, so the wait can be looked at. */
    function slowAgent() {
      let release: () => void = () => undefined;
      const wait = new Promise<void>((resolve) => (release = resolve));
      const agent: Agent = { starters: () => [], ask: async (_d, prompt) => (await wait, { prompt, parts: [{ text: 'Done.' }], citations: [], by: 'Codex', proposals: [] }) };
      return { agent, release };
    }

    async function askAndClose(agent: Agent) {
      await open('#/project/card-payments', { agent, preview: false });
      const chat = await openChat('card-payments');
      await userEvent.type(within(chat).getByRole('textbox', { name: 'Your question' }), 'Who is blocked?{Enter}');
      await waitFor(() => expect(chat.querySelector('[data-ask-status]')).not.toBeNull());
      return chat;
    }

    it("shows the theme's phrase with an icon in the focused view and the Ask bar, and the standard one in Plain", async () => {
      setTheme('harvest');
      const { agent, release } = slowAgent();
      const chat = await askAndClose(agent);
      const line = chat.querySelector('[data-ask-status]')!;
      expect(line.getAttribute('role')).toBe('status');
      expect(line.getAttribute('aria-label')).toBe('Answer progress');
      expect(line.textContent).toMatch(/^Fertilizing digital soil…/);
      expect(line.querySelector('[data-thinking-icon]')!.getAttribute('aria-hidden')).toBe('true');
      expect(within(chat).getByRole('button', { name: 'Stop' })).toBeTruthy();
      await userEvent.click(within(chat).getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ask about card-payments' })).toBeNull());
      const bar = askBar('card-payments');
      const live = within(bar).getByRole('status', { name: 'Answer progress' });
      expect(live.getAttribute('aria-live')).toBe('polite');
      expect(live.textContent).toMatch(/^Fertilizing digital soil… · \d+ s$/);
      expect(bar.querySelector('[data-thinking-icon]')).not.toBeNull();
      expect(bar.textContent).toContain('1 question in this chat, Fertilizing digital soil…');
      release();
      await waitFor(() => expect(bar.querySelector('[data-thinking-icon]')).toBeNull());
      // The live region stays, empty, so the next wait is announced.
      expect(within(bar).getByRole('status', { name: 'Answer progress' }).textContent).toBe('');
    });

    it('reads the standard phrases in Plain and with themed wording off', async () => {
      setTheme('plain');
      const { agent, release } = slowAgent();
      const chat = await askAndClose(agent);
      expect(chat.querySelector('[data-ask-status]')!.textContent).toMatch(/^Reading your data…/);
      release();
      await waitFor(() => expect(chat.querySelector('[data-ask-status]')!.textContent).toMatch(/^Done in \d+ s$/));
      expect(chat.querySelector('[data-thinking-icon]')).toBeNull();
    });
  });

  it('keeps sending a long chat inside what the server takes: the last turns, each answer cut short (#344)', async () => {
    const sent: AskExtra[] = [];
    const agent: Agent = {
      starters: () => [],
      // The first answer is longer than the server takes in one turn of history (20,000 characters).
      ask: async (_d, prompt, _s, _c, extra) => (sent.push(extra ?? {}), { prompt, parts: [{ text: sent.length === 1 ? 'x'.repeat(25_000) : `Answer ${sent.length}.` }], citations: [], by: 'Codex', proposals: [] }),
    };
    await open('#/project/card-payments', { agent, preview: false });
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
    // Types a question per turn through userEvent, which the default 5 s does not cover on a Windows runner.
  }, 30_000);

  it('runs Analyze in one press, into the focused view, citing its items', async () => {
    await open('#/project/card-payments');
    await userEvent.click(within(askBar('card-payments')).getByRole('textbox', { name: 'Your question' }));
    const chat = await screen.findByRole('dialog', { name: 'Ask about card-payments' });
    await userEvent.click(within(chat).getByRole('button', { name: /^Give me the full briefing/ }));
    const answer = await within(chat).findByRole('heading', { level: 3, name: 'Analyze' });
    await waitFor(() => expect(answer.parentElement!.textContent).toContain('How sure is this?'));
    expect(within(answer.parentElement!).getAllByRole('link').length).toBeGreaterThan(5);
  });

  describe('the agent Analyze starts on (#494)', () => {
    const ready = (name: string, label: string, ok = true) => ({ name, label, model: null, ready: ok, problem: ok ? null : 'Not signed in', fix: null, action: ok ? null : ('fix' as const) });
    /** An agent whose server remembers per toil project what an Analyze was asked of, as the real one does. */
    function remembering(memory: Record<string, string>) {
      const sent: AskExtra[] = [];
      const agent: Agent = {
        starters: () => [],
        adapters: async (toilProject) => ({ chosen: 'claude', remembered: (toilProject && memory[toilProject]) || null, options: [ready('claude', 'Claude'), ready('codex', 'Codex'), ready('copilot', 'GitHub Copilot', false)] }),
        ask: async (toilProject, prompt, _s, _c, extra) => {
          sent.push(extra ?? {});
          if (prompt === 'analyze' && extra?.adapter) memory[toilProject] = extra.adapter;
          return { prompt: 'Analyze', parts: [{ text: 'Fine.' }], citations: [], by: 'Claude', proposals: [] };
        },
      };
      return { agent, sent };
    }
    const analyze = async () => {
      await userEvent.click(within(askBar('card-payments')).getByRole('textbox', { name: 'Your question' }));
      const chat = await screen.findByRole('dialog', { name: 'Ask about card-payments' });
      await userEvent.click(within(chat).getByRole('button', { name: /^Give me the full briefing/ }));
      await within(chat).findByRole('heading', { level: 3, name: 'Analyze' });
      return chat;
    };
    const hint = (chat: HTMLElement) => chat.querySelector('[data-agent-source]')?.textContent?.trim();

    it("starts on the Toil project's remembered agent and says so", async () => {
      const { agent, sent } = remembering({ 'card-payments': 'codex' });
      await open('#/project/card-payments', { agent, preview: false });
      const chat = await analyze();
      expect(sent).toEqual([{ adapter: 'codex' }]);
      expect(within(chat).getByRole('button', { name: /^Codex/ })).toBeTruthy();
      await waitFor(() => expect(hint(chat)).toBe('(last used on this Toil project)'));
    });

    it('falls back to the default from Settings with nothing remembered, or when the remembered agent is not ready', async () => {
      for (const memory of [{}, { 'card-payments': 'copilot' }] as Array<Record<string, string>>) {
        const { agent, sent } = remembering({ ...memory });
        const { unmount } = await open('#/project/card-payments', { agent, preview: false });
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
      await open('#/project/card-payments', { agent, preview: false });
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
      await open('#/project/card-payments', { agent, preview: false });
      await userEvent.click(within(askBar('card-payments')).getByRole('textbox', { name: 'Your question' }));
      const chat = await screen.findByRole('dialog', { name: 'Ask about card-payments' });
      await userEvent.click(within(chat).getByRole('button', { name: /^Give me the full briefing/ }));
      await userEvent.click(within(chat).getByRole('button', { name: /^Give me the full briefing/ }));
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
      const { unmount } = await open('#/project/card-payments', { agent: first.agent, preview: false });
      await userEvent.click(await within(askBar('card-payments')).findByRole('textbox', { name: 'Your question' }));
      const chat = await screen.findByRole('dialog', { name: 'Ask about card-payments' });
      await userEvent.click(await within(chat).findByRole('button', { name: /change the AI agent for this chat/ }));
      await userEvent.click(await screen.findByRole('button', { name: /Codex/ }));
      await userEvent.click(within(chat).getByRole('button', { name: /^Give me the full briefing/ }));
      await within(chat).findByRole('heading', { level: 3, name: 'Analyze' });
      expect(first.sent).toEqual([{ adapter: 'codex' }]);
      expect(memory).toEqual({ 'card-payments': 'codex' });
      unmount();
      cleanup();
      const second = remembering(memory);
      await open('#/project/card-payments', { agent: second.agent, preview: false });
      await analyze();
      expect(second.sent).toEqual([{ adapter: 'codex' }]);
    });
  });
});
