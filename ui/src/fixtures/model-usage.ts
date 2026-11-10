/**
 * The agent's model usage, made up for the preview and `toil-ui --sample`
 * (#295): a month of chats across the three sample toil projects on all three
 * adapters, shaped like what each SDK reports (Claude with an SDK estimate,
 * Codex in tokens with no dollar figure, Copilot in premium requests), and
 * no Codex rates. Generated from a fixed seed, so every build
 * shows the same month. None of it came from a model, and every page that
 * shows it says so. A budget for a budget that was never spent.
 */

import type { AnswerUsage, ModelUsageApi, UsageAdapter, UsageRecord, UsageSettings } from '../model-usage.ts';
import { FIXTURE_NOW } from './execute.ts';

const TOIL_PROJECTS = ['card-payments', 'settlement', 'checkout-web'];
const MODELS: Record<UsageAdapter, string[]> = { claude: ['claude-sonnet-4-6', 'claude-haiku-4-5'], codex: ['gpt-5.5'], copilot: ['gpt-5-mini', 'claude-sonnet-4.6'] };
const DAY = 86_400_000;

/** A small, fixed pseudo-random sequence (mulberry32), so the sample never changes between builds. */
function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One call's sample figures, as the adapter's SDK would report it. */
function call(adapter: UsageAdapter, model: string, rand: () => number, base: Omit<UsageRecord, 'adapter' | 'model' | 'costSource'>): UsageRecord {
  const input = Math.round(1500 + rand() * 6000);
  const output = Math.round(200 + rand() * 900);
  const cached = Math.round(rand() * 18000);
  if (adapter === 'claude') {
    const write = Math.round(rand() * 3000);
    const cost = (input * 3 + output * 15 + cached * 0.3 + write * 3.75) / 1_000_000;
    return { ...base, adapter, model, inputTokens: input, outputTokens: output, cachedInputTokens: cached, cacheWriteTokens: write, costUsd: Math.round(cost * 10000) / 10000, costSource: 'sdk-estimate', plan: true };
  }
  if (adapter === 'codex') return { ...base, adapter, model, inputTokens: input + cached, cachedInputTokens: cached, outputTokens: output, costSource: 'none', inputIncludesCached: true };
  return { ...base, adapter, model, inputTokens: input, outputTokens: output, cachedInputTokens: cached, premiumRequests: model.startsWith('claude') ? 1 : 0, costSource: 'none' };
}

/** The sample month of records, ending at the preview's clock. */
export function sampleUsageRecords(now = FIXTURE_NOW): UsageRecord[] {
  const rand = seeded(295);
  const end = Date.parse(now);
  const out: UsageRecord[] = [];
  const adapters: UsageAdapter[] = ['claude', 'codex', 'copilot'];
  for (let d = 29; d >= 0; d--) {
    // Weekends are quiet; the rest of the month asks a few questions a day.
    const date = new Date(end - d * DAY);
    const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
    const chats = weekend ? (rand() < 0.3 ? 1 : 0) : 1 + Math.floor(rand() * 3);
    for (let c = 0; c < chats; c++) {
      const adapter = adapters[Math.floor(rand() * adapters.length)]!;
      const models = MODELS[adapter];
      const model = models[Math.floor(rand() * models.length)]!;
      const toilProject = TOIL_PROJECTS[Math.floor(rand() * TOIL_PROJECTS.length)]!;
      const chatId = `sample-${date.toISOString().slice(0, 10)}-${c}`;
      const turns = 1 + Math.floor(rand() * 3);
      for (let turn = 1; turn <= turns; turn++) {
        const calls = adapter === 'codex' ? 1 : 1 + Math.floor(rand() * 3);
        for (let k = 0; k < calls; k++) {
          const at = new Date(Math.min(end, Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 9 + c * 2, turn * 7 + k))).toISOString();
          out.push(call(adapter, model, rand, { id: `${chatId}:${turn}:${k}`, chatId, turn, toilProject, at }));
        }
      }
    }
  }
  return out;
}

/** The sample's settings: no Codex rates, so the sample's Codex answers carry no dollar figure. */
export const SAMPLE_USAGE_SETTINGS: UsageSettings = { codexRates: null };

/** What a scripted answer carries in the preview: one Claude call's sample figures, marked as made up. */
export function sampleAnswerUsage(chatId: string, turn: number, toilProject: string, at = FIXTURE_NOW): AnswerUsage {
  const rand = seeded(turn * 7919 + toilProject.length);
  return { adapter: 'claude', records: [call('claude', 'claude-sonnet-4-6', rand, { id: `${chatId}:${turn}`, chatId, turn, toilProject, at })], context: { used: 24_800, window: 200_000 }, notices: [], sample: true };
}

/** The preview's usage page: the sample month, with saving off. */
export function fixtureModelUsage(): ModelUsageApi {
  const records = sampleUsageRecords();
  const since = new Date(Date.parse(`${FIXTURE_NOW.slice(0, 10)}T00:00:00.000Z`) - 29 * DAY).toISOString();
  return {
    view: async () => ({ since, now: FIXTURE_NOW, records, retentionDays: null, settings: SAMPLE_USAGE_SETTINGS, problem: null, sample: true }),
    save: async () => {
      throw new Error("This preview shows sample figures, so its rates can't be saved. Toil UI on your own machine saves them in its data folder.");
    },
  };
}
