import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { openChat } from './chat.ts';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import type { Agent, Answer } from '../src/agent.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { fixtureConfig } from '../src/fixtures/config.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { fixtureModelUsage, sampleUsageRecords } from '../src/fixtures/model-usage.ts';
import { addUp, compact, type ChatTurn, type ModelUsageApi, type UsageSettings, type UsageView } from '../src/model-usage.ts';

/**
 * The agent's model usage on screen (#295): the footer under each answer and
 * the chat's running total, against a stubbed Agent whose answers carry
 * usage as each adapter would report it, and Settings, Usage on the
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
});
afterEach(cleanup);

/** An Agent whose every answer carries a Codex and then a Copilot report, with the chat it was asked in. */
function reportingAgent(asked: ChatTurn[]): Agent {
  const base = scriptedAgent();
  return {
    ...base,
    stream: undefined,
    ask: async (toilProject, prompt, style, chat) => {
      asked.push(chat!);
      const answer = (await base.ask(toilProject, prompt, style)) as Answer;
      const turn = chat!.turn;
      const at = FIXTURE_NOW;
      if (turn === 1) {
        return { ...answer, usage: { adapter: 'codex', records: [{ id: `codex:t${turn}:1`, chatId: chat!.id, turn, toilProject, adapter: 'codex', model: null, inputTokens: 21000, cachedInputTokens: 14000, outputTokens: 380, costSource: 'none', inputIncludesCached: true, at }], notices: [] } };
      }
      return {
        ...answer,
        usage: { adapter: 'copilot', records: [{ id: `copilot:e${turn}`, chatId: chat!.id, turn, toilProject, adapter: 'copilot', model: 'gpt-5-mini', inputTokens: 3000, cachedInputTokens: 1000, outputTokens: 200, premiumRequests: 1, costSource: 'none', at }], context: { used: 7400, window: 128000 }, notices: ["Toil UI's saved Codex rates can't be read: the file isn't JSON. Save the rates again under Settings, Usage, which rewrites them."] },
      };
    },
  };
}

describe('the chat', () => {
  it('shows what each answer used under it, labelled by adapter and model, and the chat total in its header', async () => {
    const asked: ChatTurn[] = [];
    await open('#/project/card-payments', { agent: reportingAgent(asked) });
    await openChat('card-payments');
    await userEvent.click(within(screen.getByRole('group', { name: 'Starter questions' })).getAllByRole('button')[0]!);
    const first = await screen.findByRole('group', { name: 'What this answer used' });
    // The answer's one folded line carries the summary; the breakdown is the fold's contents.
    expect(first.closest('details')!.querySelector('summary')!.textContent).toMatch(/ · no dollar figure reported$/);
    expect(first.closest('details')!.open).toBe(false);
    expect(first.textContent).toContain("Codex, the CLI's default model (not named by the SDK): 21k in · 380 out · 14k cached · cache write not reported · no dollar figure (add your rates under Settings, Usage)");
    // After the first question the starters are a Suggestions menu (#343).
    await userEvent.click(screen.getByRole('button', { name: 'Suggestions' }));
    await userEvent.click((await screen.findAllByRole('menuitem'))[1]!);
    await waitFor(() => expect(screen.getAllByRole('group', { name: 'What this answer used' })).toHaveLength(2));
    const second = screen.getAllByRole('group', { name: 'What this answer used' })[1]!;
    expect(second.textContent).toContain('GitHub Copilot, gpt-5-mini: 3k in · 200 out · 1k cached · cache write not reported · 1 premium request');
    expect(second.textContent).not.toContain('$');
    // The rates notice is out in the open, beside the answer's fold rather than inside it, and its link goes to the rates.
    expect(screen.getAllByRole('status').some((n) => n.textContent!.includes("saved Codex rates can't be read"))).toBe(true);
    expect(screen.getByRole('link', { name: 'Edit the Codex rates' }).getAttribute('href')).toBe('#/settings/usage/rates');

    // One chat id for the pane, the turns numbered in order.
    expect(asked.map((c) => c.turn)).toEqual([1, 2]);
    expect(new Set(asked.map((c) => c.id)).size).toBe(1);

    const header = screen.getByLabelText('What this chat used');
    const total = addUp([{ id: 'a', chatId: 'c', turn: 1, toilProject: 'd', adapter: 'codex', model: null, inputTokens: 21000, cachedInputTokens: 14000, outputTokens: 380, costSource: 'none', inputIncludesCached: true, at: FIXTURE_NOW }, { id: 'b', chatId: 'c', turn: 2, toilProject: 'd', adapter: 'copilot', model: 'gpt-5-mini', inputTokens: 3000, cachedInputTokens: 1000, outputTokens: 200, premiumRequests: 1, costSource: 'none', at: FIXTURE_NOW }]);
    expect(header.textContent).toContain(`${compact(total.tokens!)} tokens, on 2 models.`);
    expect(header.textContent).toContain('Context of the last answer: 7.4k of 128k tokens (6%)');
    expect(within(header).getByRole('meter')).toBeTruthy();
  });

  it('counts what a stopped run used, under its error and in the chat total, as the server does', async () => {
    const usage = { adapter: 'claude' as const, records: [{ id: 'claude:msg_1', chatId: 'c', turn: 1, toilProject: 'card-payments', adapter: 'claude' as const, model: 'claude-sonnet-4-6', inputTokens: 600, outputTokens: 50, cachedInputTokens: 1000, costSource: 'none' as const, at: FIXTURE_NOW }], notices: [] };
    const agent: Agent = { ...scriptedAgent(), stream: undefined, ask: async () => Promise.reject(Object.assign(new Error('Claude stopped this question partway.'), { usage })) };
    await open('#/project/card-payments', { agent });
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
    await open('#/project/card-payments');
    await openChat('card-payments');
    await userEvent.click(within(screen.getByRole('group', { name: 'Starter questions' })).getAllByRole('button')[0]!);
    const footer = await screen.findByRole('group', { name: 'What this answer used' }, { timeout: 5000 });
    expect(footer.textContent).toMatch(/Sample figures, not from a model\. Claude, claude-sonnet-4-6: .* · ~\$0\.\d+ \(SDK estimate, API-equivalent/);
  });
});

describe('Settings, Usage, the AI agent half', () => {
  it('sits on the Usage page, under the audit summary, and totals the sample month by day, AI agent, model and Toil project with the meter\'s figures', async () => {
    const { container } = await open('#/settings/usage');
    const nav = screen.getByRole('navigation', { name: 'Settings pages' });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['General', 'Connections', 'Toil projects', 'Appearance', 'Usage', 'AI agent']);
    await screen.findByRole('heading', { name: 'What your AI agent used' });
    // The AI agent's tables and the Codex rates are behind the page's one More detail.
    expect(container.querySelector('[data-usage-more]')!.querySelectorAll('summary')[0]!.textContent).toBe('More detail');
    const all = addUp(sampleUsageRecords());
    expect(screen.getByText('These are sample figures, made up for the preview. No model reported them.')).toBeTruthy();
    const totals = container.querySelector('.usage-totals')!;
    expect(totals.textContent).toContain(compact(all.tokens!));
    for (const name of ['By AI agent', 'By model', 'By Toil project', 'Chats that used the most', /^Codex rates/]) expect(screen.getByRole('heading', { name })).toBeTruthy();
    // The rates are one heading inside the disclosure, not a panel of their own beside the totals.
    const rates = screen.getByRole('heading', { name: /^Codex rates/ });
    expect(rates.tagName).toBe('H3');
    expect(rates.closest('details[data-usage-more]')).not.toBeNull();
    expect(within(rates).getByRole('button', { name: 'About the Codex rates' })).toBeTruthy();
    const adapters = screen.getByRole('table', { name: 'Usage by AI agent' });
    expect(within(adapters).getAllByRole('rowheader').map((c) => c.querySelector('.l-table__value')!.textContent).sort()).toEqual(['Claude', 'Codex', 'GitHub Copilot']);
    // Copilot's row is premium requests, never dollars.
    const copilot = within(adapters).getAllByRole('row').find((r) => r.textContent?.includes('GitHub Copilot'))!;
    expect(copilot.textContent).toContain('premium request');
    expect(copilot.textContent).not.toContain('$');
    expect(screen.getByRole('img', { name: /^Tokens per day:/ })).toBeTruthy();
    expect(await violations(container)).toEqual([]);
  }, AXE);

  it('shows the Codex rates with saving off in the preview', async () => {
    await open('#/settings/usage');
    await screen.findByRole('heading', { name: /^Codex rates/ });
    expect(screen.getByText("This preview can't save rates.")).toBeTruthy();
    expect(screen.getByText('Codex reports tokens, not dollars. Enter your rates to see a cost.')).toBeTruthy();
    expect(screen.getByText('Dollars per million tokens')).toBeTruthy();
    expect(screen.getByText('Leave all three empty for none.')).toBeTruthy();
    expect(document.querySelector('[data-cap]')).toBeNull();
    expect((screen.getByRole('button', { name: 'Save rates' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends a rate as typed, and shows the refusal naming the setting rather than saving 0', async () => {
    const sent: UsageSettings[] = [];
    const view: UsageView = { since: '2026-09-14T00:00:00.000Z', now: FIXTURE_NOW, records: [], retentionDays: 30, settings: { codexRates: null }, problem: null, sample: false };
    const api: ModelUsageApi = {
      view: async () => view,
      save: async (s) => {
        sent.push(s);
        throw new Error("codexRates.inputPerMillion must be a number of dollars per million tokens, 0 or more, not \"cheap\". Enter the rate from your OpenAI price list, or clear all three rates.");
      },
    };
    await open('#/settings/usage', { modelUsage: api });
    await screen.findByRole('heading', { name: /^Codex rates/ });
    const empty = screen.getByText('No chat has used an AI agent in this window yet.');
    expect(empty.closest('[data-empty-action]') ?? empty.parentElement!.querySelector('[data-empty-action]')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Open a Toil project to ask' }).getAttribute('href')).toBe('#/');
    expect(document.body.textContent).not.toMatch(/SDK reported|SDK didn't/);
    await userEvent.type(screen.getByLabelText('Input'), 'cheap');
    await userEvent.type(screen.getByLabelText('Cached input'), '0.1');
    await userEvent.type(screen.getByLabelText('Output'), '5');
    await userEvent.click(screen.getByRole('button', { name: 'Save rates' }));
    expect((await screen.findByRole('alert')).textContent).toContain('codexRates.inputPerMillion');
    expect(sent[0]).toEqual({ codexRates: { inputPerMillion: 'cheap', cachedInputPerMillion: 0.1, outputPerMillion: 5 } });
  });
});

async function violations(container: HTMLElement) {
  const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

describe('the Codex rates, inside More detail', () => {
  const view = (rates: UsageView['settings']['codexRates']): UsageView => ({ since: '2026-09-14T00:00:00.000Z', now: FIXTURE_NOW, records: [], retentionDays: 30, settings: { codexRates: rates }, problem: null, sample: false });

  it('shows a problem reading the saved rates without opening More detail', async () => {
    const broken: UsageView = { ...view(null), problem: "Toil UI's saved Codex rates can't be read: the file is damaged." };
    await open('#/settings/usage', { modelUsage: { view: async () => broken, save: async () => broken } });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('the file is damaged');
    expect(alert.closest('details')).toBeNull();
    expect((document.querySelector('[data-usage-more]') as HTMLDetailsElement).open).toBe(false);
  });

  it.each(['#/settings/usage/rates', '#/settings/usage/caps'])('%s opens More detail and puts focus on the rates heading', async (hash) => {
    const api: ModelUsageApi = { view: async () => view(null), save: async () => view(null) };
    await open(hash, { modelUsage: api });
    const heading = await screen.findByRole('heading', { name: /^Codex rates/ });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect((heading.closest('details') as HTMLDetailsElement).open).toBe(true);
  });

  it('stays closed on the plain Usage page', async () => {
    const api: ModelUsageApi = { view: async () => view(null), save: async () => view(null) };
    const { container } = await open('#/settings/usage', { modelUsage: api });
    await screen.findByRole('heading', { name: /^Codex rates/ });
    expect((container.querySelector('details[data-usage-more]') as HTMLDetailsElement).open).toBe(false);
  });

  it('says what saving does: a dollar figure with rates, none without', async () => {
    const saved: UsageView[] = [view({ inputPerMillion: 1, cachedInputPerMillion: 0.1, outputPerMillion: 5 }), view(null)];
    const api: ModelUsageApi = { view: async () => view(null), save: async () => saved.shift()! };
    await open('#/settings/usage/rates', { modelUsage: api });
    await screen.findByRole('heading', { name: /^Codex rates/ });
    await userEvent.type(screen.getByLabelText('Input'), '1');
    await userEvent.type(screen.getByLabelText('Cached input'), '0.1');
    await userEvent.type(screen.getByLabelText('Output'), '5');
    await userEvent.click(screen.getByRole('button', { name: 'Save rates' }));
    await screen.findByText('Saved. Codex answers from now on carry a dollar figure from these rates.');
    for (const label of ['Input', 'Cached input', 'Output']) await userEvent.clear(screen.getByLabelText(label));
    await userEvent.click(screen.getByRole('button', { name: 'Save rates' }));
    await screen.findByText("Saved. Codex answers won't show a dollar figure.");
  });
});
