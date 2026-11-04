import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { openChat } from './chat.ts';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { standardWords } from './words.ts';
import type { Agent, Answer } from '../src/agent.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { fixtureConfig } from '../src/fixtures/config.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { fixtureModelUsage, SAMPLE_USAGE_SETTINGS, sampleUsageRecords } from '../src/fixtures/model-usage.ts';
import { addUp, compact, type ChatTurn, type ModelUsageApi, type UsageSettings, type UsageView } from '../src/model-usage.ts';

/**
 * The agent's model usage on screen (#295): the footer under each answer and
 * the chat's running total, against a stubbed Agent whose answers carry
 * usage as each adapter would report it, and Settings, Agent usage on the
 * preview's sample month. The figures shown are recomputed here from the
 * same records, so the page can't show a total the meter wouldn't.
 */

const AXE = 20_000;

async function open(hash: string, { agent = scriptedAgent(), modelUsage = fixtureModelUsage() }: { agent?: Agent; modelUsage?: ModelUsageApi } = {}) {
  window.location.hash = hash;
  const view = render(<App execute={fixtureExecute().execute} agent={agent} config={fixtureConfig()} modelUsage={modelUsage} now={FIXTURE_NOW} preview />);
  await screen.findByRole('heading', { level: 1 }, { timeout: 3000 });
  return view;
}

beforeEach(() => {
  localStorage.clear();
  standardWords();
});
afterEach(cleanup);

/** An Agent whose every answer carries a Codex and then a Copilot report, with the chat it was asked in. */
function reportingAgent(asked: ChatTurn[]): Agent {
  const base = scriptedAgent();
  return {
    ...base,
    stream: undefined,
    ask: async (dossier, prompt, style, chat) => {
      asked.push(chat!);
      const answer = (await base.ask(dossier, prompt, style)) as Answer;
      const turn = chat!.turn;
      const at = FIXTURE_NOW;
      if (turn === 1) {
        return { ...answer, usage: { adapter: 'codex', records: [{ id: `codex:t${turn}:1`, chatId: chat!.id, turn, dossier, adapter: 'codex', model: null, inputTokens: 21000, cachedInputTokens: 14000, outputTokens: 380, costSource: 'none', inputIncludesCached: true, at }], notices: [] } };
      }
      return {
        ...answer,
        usage: { adapter: 'copilot', records: [{ id: `copilot:e${turn}`, chatId: chat!.id, turn, dossier, adapter: 'copilot', model: 'gpt-5-mini', inputTokens: 3000, cachedInputTokens: 1000, outputTokens: 200, premiumRequests: 1, costSource: 'none', at }], context: { used: 7400, window: 128000 }, notices: ["This chat has used 41,000 tokens of Codex's per-chat cap (codex.chat) of 50,000 tokens (82%)."] },
      };
    },
  };
}

describe('the chat', () => {
  it('shows what each answer used under it, labelled by adapter and model, and the chat total in its header', async () => {
    const asked: ChatTurn[] = [];
    await open('#/dossier/card-payments', { agent: reportingAgent(asked) });
    await openChat('card-payments');
    await userEvent.click(within(screen.getByRole('group', { name: 'Starter questions' })).getAllByRole('button')[0]!);
    const first = await screen.findByRole('group', { name: 'What this answer used' });
    // The answer's one folded line carries the summary; the breakdown is the fold's contents.
    expect(first.closest('details')!.querySelector('summary')!.textContent).toMatch(/ · no dollar figure reported$/);
    expect(first.closest('details')!.open).toBe(false);
    expect(first.textContent).toContain("Codex, the CLI's default model (not named by the SDK): 21k in · 380 out · 14k cached · cache write not reported · no dollar figure (add your rates under Settings, Agent usage)");
    // After the first question the starters are a Suggestions menu (#343).
    await userEvent.click(screen.getByRole('button', { name: 'Suggestions' }));
    await userEvent.click((await screen.findAllByRole('menuitem'))[1]!);
    await waitFor(() => expect(screen.getAllByRole('group', { name: 'What this answer used' })).toHaveLength(2));
    const second = screen.getAllByRole('group', { name: 'What this answer used' })[1]!;
    expect(second.textContent).toContain('GitHub Copilot, gpt-5-mini: 3k in · 200 out · 1k cached · cache write not reported · 1 premium request');
    expect(second.textContent).not.toContain('$');
    // A cap notice is out in the open, beside the answer's fold rather than inside it.
    expect(screen.getAllByRole('status').some((n) => n.textContent!.includes('(82%)'))).toBe(true);

    // One chat id for the pane, the turns numbered in order.
    expect(asked.map((c) => c.turn)).toEqual([1, 2]);
    expect(new Set(asked.map((c) => c.id)).size).toBe(1);

    const header = screen.getByLabelText('What this chat used');
    const total = addUp([{ id: 'a', chatId: 'c', turn: 1, dossier: 'd', adapter: 'codex', model: null, inputTokens: 21000, cachedInputTokens: 14000, outputTokens: 380, costSource: 'none', inputIncludesCached: true, at: FIXTURE_NOW }, { id: 'b', chatId: 'c', turn: 2, dossier: 'd', adapter: 'copilot', model: 'gpt-5-mini', inputTokens: 3000, cachedInputTokens: 1000, outputTokens: 200, premiumRequests: 1, costSource: 'none', at: FIXTURE_NOW }]);
    expect(header.textContent).toContain(`${compact(total.tokens!)} tokens, on 2 models.`);
    expect(header.textContent).toContain('Context of the last answer: 7.4k of 128k tokens (6%)');
    expect(within(header).getByRole('meter')).toBeTruthy();
  });

  it('counts what a stopped run used, under its error and in the chat total, as the server does', async () => {
    const usage = { adapter: 'claude' as const, records: [{ id: 'claude:msg_1', chatId: 'c', turn: 1, dossier: 'card-payments', adapter: 'claude' as const, model: 'claude-sonnet-4-6', inputTokens: 600, outputTokens: 50, cachedInputTokens: 1000, costSource: 'none' as const, at: FIXTURE_NOW }], notices: [] };
    const agent: Agent = { ...scriptedAgent(), stream: undefined, ask: async () => Promise.reject(Object.assign(new Error("Claude's per-chat cap (claude.chat) stopped this question: this chat has used 1,650 tokens, and the cap is 1,000 tokens."), { usage })) };
    await open('#/dossier/card-payments', { agent });
    await openChat('card-payments');
    await userEvent.click(within(screen.getByRole('group', { name: 'Starter questions' })).getAllByRole('button')[0]!);
    expect((await screen.findByRole('alert')).textContent).toContain('stopped this question');
    expect(screen.getByRole('group', { name: 'What this answer used' }).textContent).toContain('600 in · 50 out · 1k cached');
    // The chat's total waits for a second answer: one answer's usage is the chat's.
    expect(screen.queryByLabelText('What this chat used')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Suggestions' }));
    await userEvent.click((await screen.findAllByRole('menuitem'))[1]!);
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
    expect(screen.getByLabelText('What this chat used').textContent).toMatch(/[0-9.]+k tokens/);
  });

  it('marks the preview\'s figures as sample, never as a model\'s', async () => {
    await open('#/dossier/card-payments');
    await openChat('card-payments');
    await userEvent.click(within(screen.getByRole('group', { name: 'Starter questions' })).getAllByRole('button')[0]!);
    const footer = await screen.findByRole('group', { name: 'What this answer used' }, { timeout: 5000 });
    expect(footer.textContent).toMatch(/Sample figures, not from a model\. Claude, claude-sonnet-4-6: .* · ~\$0\.\d+ \(SDK estimate, API-equivalent/);
  });
});

describe('Settings, Agent usage', () => {
  it('sits beside Usage, and totals the sample month by day, adapter, model and dossier with the meter\'s figures', async () => {
    const { container } = await open('#/settings/agent-usage');
    const nav = screen.getByRole('navigation', { name: 'Settings pages' });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Connections', 'Dossiers', 'General', 'Usage', 'Agent usage', 'Agent']);
    await screen.findByRole('heading', { name: "Usage of the agent's models" });
    const all = addUp(sampleUsageRecords());
    expect(screen.getByText('These are sample figures, made up for the preview. No model reported them.')).toBeTruthy();
    const totals = container.querySelector('.usage-totals')!;
    expect(totals.textContent).toContain(compact(all.tokens!));
    for (const name of ['By adapter', 'By model', 'By dossier', 'Chats that used the most', 'Caps']) expect(screen.getByRole('heading', { name })).toBeTruthy();
    const adapters = screen.getByRole('table', { name: 'Usage by adapter' });
    expect(within(adapters).getAllByRole('rowheader').map((c) => c.querySelector('.l-table__value')!.textContent).sort()).toEqual(['Claude', 'Codex', 'GitHub Copilot']);
    // Copilot's row is premium requests, never dollars.
    const copilot = within(adapters).getAllByRole('row').find((r) => r.textContent?.includes('GitHub Copilot'))!;
    expect(copilot.textContent).toContain('premium request');
    expect(copilot.textContent).not.toContain('$');
    expect(screen.getByRole('img', { name: /^Tokens per day:/ })).toBeTruthy();
    expect(await violations(container)).toEqual([]);
  }, AXE);

  it('shows the sample caps with saving off in the preview', async () => {
    await open('#/settings/agent-usage');
    await screen.findByRole('heading', { name: 'Caps' });
    expect(screen.getByText("This preview shows sample caps, so they can't be saved.")).toBeTruthy();
    const codexChat = document.querySelector('[data-cap="codex.chat"]')!;
    expect((within(codexChat as HTMLElement).getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect((within(codexChat as HTMLElement).getByRole('textbox') as HTMLInputElement).value).toBe(String((SAMPLE_USAGE_SETTINGS.caps['codex.chat'] as { limit: number }).limit));
    expect((screen.getByRole('button', { name: 'Save caps and rates' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends a cap as typed, and shows the refusal naming the setting rather than saving 0 or off', async () => {
    const sent: UsageSettings[] = [];
    const view: UsageView = { since: '2026-09-14T00:00:00.000Z', now: FIXTURE_NOW, records: [], retentionDays: 30, settings: { caps: {}, codexRates: null }, problem: null, sample: false };
    const api: ModelUsageApi = {
      view: async () => view,
      save: async (s) => {
        sent.push(s);
        throw new Error('codex.chat: the limit "fifty" isn\'t a number above 0. Give a number above 0, or set codex.chat to "off" to turn the cap off.');
      },
    };
    await open('#/settings/agent-usage', { modelUsage: api });
    await screen.findByRole('heading', { name: 'Caps' });
    expect(screen.getByText(/No chat has used a model in this window yet/)).toBeTruthy();
    const row = document.querySelector('[data-cap="codex.chat"]') as HTMLElement;
    await userEvent.click(within(row).getByRole('checkbox'));
    await userEvent.type(within(row).getByRole('textbox'), 'fifty');
    await userEvent.click(screen.getByRole('button', { name: 'Save caps and rates' }));
    expect((await screen.findByRole('alert')).textContent).toContain('codex.chat: the limit "fifty"');
    expect(sent[0]!.caps['codex.chat']).toEqual({ unit: 'tokens', limit: 'fifty' });
    expect(sent[0]!.caps['claude.chat']).toBe('off');
  });
});

async function violations(container: HTMLElement) {
  const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}
