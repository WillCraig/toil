/**
 * The meter for the agent's model usage (#295): what each SDK reported a
 * chat used, one normalized record per model call or running total, and the
 * one rule for adding records up. The server's ledger and caps, the chat's
 * footer and header, and Settings, Agent usage all read `addUp` here, so no
 * two places can disagree about a total.
 *
 * The rule: records with the same `id` are one report, seen more than once
 * (a running total the SDK repeats as it grows, or one call streamed in
 * pieces), so they merge to the highest value of each figure, never a sum.
 * Records with different ids are different calls, and are summed. A figure no
 * record reported stays absent, and the page says "not reported", never 0.
 *
 * Caps come from an enumerated list of settings (`CAP_SETTINGS`): a value that
 * doesn't parse is refused with a message naming the setting, and "off" is
 * its own explicit value, so a typo can't turn a cap off. The figures are the
 * SDKs' own reports; the vendor's bill is the authority. Counting what the
 * meter says the meter said, to the satisfaction of the meter.
 */

export type UsageAdapter = 'claude' | 'codex' | 'copilot';
export type CostSource = 'sdk-estimate' | 'your-rates' | 'none';

export const ADAPTER_LABEL: Record<UsageAdapter, string> = { claude: 'Claude', codex: 'Codex', copilot: 'GitHub Copilot' };
const VENDOR: Record<UsageAdapter, string> = { claude: "Anthropic's (or your cloud provider's)", codex: "OpenAI's", copilot: "GitHub's" };

/** One report from an SDK about one model call, or one running total. */
export interface UsageRecord {
  /** The report's identity: two records with one id are the same report, merged and never added twice. */
  id: string;
  chatId: string;
  /** Which question in the chat, from 1. */
  turn: number;
  toilProject: string;
  adapter: UsageAdapter;
  /** The model the SDK named, or null when it named none (Codex on the CLI's default model). */
  model: string | null;
  inputTokens?: number;
  /** Input read from the prompt cache. */
  cachedInputTokens?: number;
  /** Input written to the prompt cache. */
  cacheWriteTokens?: number;
  outputTokens?: number;
  /** Copilot only: premium requests, as the SDK's multiplier reports them. */
  premiumRequests?: number;
  costUsd?: number;
  costSource: CostSource;
  /** Claude on a Claude plan: the SDK's dollar figure is what the tokens would cost on the API, not a bill. */
  plan?: boolean;
  /** The SDK's input count already includes the cached tokens (Codex, as OpenAI counts), so a token total counts them once. */
  inputIncludesCached?: boolean;
  /** When it was reported, ISO 8601. */
  at: string;
}

/** The figures a record may carry, each added up the same way. */
export const FIGURES = ['inputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens', 'premiumRequests'] as const;
export type Figure = (typeof FIGURES)[number];

export interface UsageTotals {
  /** How many distinct reports went in. */
  reports: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  premiumRequests?: number;
  /** Every token once: input, output and cache writes, and cache reads where the SDK counts them apart from input. Absent when no record reported a token. */
  tokens?: number;
  /** Dollars by where the figure came from; a source with no figure is absent. Never added across sources. */
  costUsd: Partial<Record<Exclude<CostSource, 'none'>, number>>;
  /** Some of the SDK's dollar figure is API-equivalent (a Claude plan). */
  plan: boolean;
}

/** The tokens one record counts: its input, output, cache writes, and cache reads unless its input already holds them. */
export function tokensOf(r: Pick<UsageRecord, Figure | 'inputIncludesCached'>): number | undefined {
  const parts = [r.inputTokens, r.outputTokens, r.cacheWriteTokens, r.inputIncludesCached ? undefined : r.cachedInputTokens];
  if (parts.every((p) => p === undefined) && r.cachedInputTokens === undefined) return undefined;
  return parts.reduce<number>((n, p) => n + (p ?? 0), 0);
}

const higher = (a: number | undefined, b: number | undefined) => (a === undefined ? b : b === undefined ? a : Math.max(a, b));

/** Two sightings of one report's figures: the highest of each, so a repeated or growing total never shrinks or doubles. */
export function higherFigures<T extends Partial<Record<Figure | 'costUsd', number>>>(a: T, b: T): T {
  const out = { ...a, ...b };
  for (const f of [...FIGURES, 'costUsd'] as const) {
    const v = higher(a[f], b[f]);
    if (v === undefined) delete out[f];
    else (out as Record<string, number>)[f] = v;
  }
  return out;
}

/** Two sightings of one report: the highest of each figure, and the later of the two otherwise. */
export function sameReport(a: UsageRecord, b: UsageRecord): UsageRecord {
  return b.at >= a.at ? higherFigures(a, b) : higherFigures(b, a);
}

/** The distinct reports in a set of records, each merged from every sighting of its id. */
export function reports(records: readonly UsageRecord[]): UsageRecord[] {
  const byId = new Map<string, UsageRecord>();
  for (const r of records) {
    const seen = byId.get(r.id);
    byId.set(r.id, seen ? sameReport(seen, r) : r);
  }
  return [...byId.values()];
}

/** The one adding-up rule (see the header): merge each id's sightings, then sum across ids. */
export function addUp(records: readonly UsageRecord[]): UsageTotals {
  const out: UsageTotals = { reports: 0, costUsd: {}, plan: false };
  for (const r of reports(records)) {
    out.reports++;
    for (const f of FIGURES) if (typeof r[f] === 'number') out[f] = (out[f] ?? 0) + r[f]!;
    const t = tokensOf(r);
    if (t !== undefined) out.tokens = (out.tokens ?? 0) + t;
    if (typeof r.costUsd === 'number' && r.costSource !== 'none') out.costUsd[r.costSource] = (out.costUsd[r.costSource] ?? 0) + r.costUsd;
    if (r.plan && typeof r.costUsd === 'number') out.plan = true;
  }
  return out;
}

/** Totals per key, in descending order of tokens: by model, chat, day, adapter or toil project. */
export function totalsBy<K extends string>(records: readonly UsageRecord[], key: (r: UsageRecord) => K): Array<{ key: K; sample: UsageRecord; totals: UsageTotals }> {
  const groups = new Map<K, UsageRecord[]>();
  for (const r of reports(records)) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  return [...groups].map(([k, rs]) => ({ key: k, sample: rs[0]!, totals: addUp(rs) })).sort((a, b) => (b.totals.tokens ?? 0) - (a.totals.tokens ?? 0) || (a.key < b.key ? -1 : 1));
}

/** The UTC day a record falls on: `2026-10-20`. */
export const dayOf = (r: Pick<UsageRecord, 'at'>) => r.at.slice(0, 10);
/** A model and the adapter it ran on, as one key. */
export const modelKey = (r: Pick<UsageRecord, 'adapter' | 'model'>) => `${r.adapter}:${r.model ?? ''}`;
/** The model in words, saying so when the SDK didn't name it. */
export const modelLabel = (r: Pick<UsageRecord, 'model'>) => r.model ?? "the CLI's default model (not named by the SDK)";

// ---------------------------------------------------------------- what a footer says

/** 2100 → "2.1k", 14000 → "14k", 1250000 → "1.3M". */
export function compact(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${n < 10_000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') : Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** A dollar figure at a precision a small number survives: $0.0042, $0.012, $1.25. */
export function dollars(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

const tokenPart = (n: number | undefined, what: string) => (n === undefined ? `${what} not reported` : `${compact(n)} ${what}`);

/**
 * The figures as one line's parts, each labelled by where it came from:
 * `2.1k in · 380 out · 14k cached · cache write not reported · ~$0.012 (SDK estimate)`.
 * Copilot gets premium requests and never a dollar figure.
 */
export function usageParts(t: UsageTotals, adapter: UsageAdapter): string[] {
  const parts = [tokenPart(t.inputTokens, 'in'), tokenPart(t.outputTokens, 'out'), tokenPart(t.cachedInputTokens, 'cached'), tokenPart(t.cacheWriteTokens, 'cache write')];
  if (adapter === 'copilot') {
    parts.push(t.premiumRequests === undefined ? 'premium requests not reported' : `${round(t.premiumRequests)} premium ${t.premiumRequests === 1 ? 'request' : 'requests'}`);
    return parts;
  }
  parts.push(...costParts(t, adapter));
  return parts;
}

/** The dollar figure, or why there is none: never shown for Copilot. */
export function costParts(t: UsageTotals, adapter: UsageAdapter): string[] {
  if (adapter === 'copilot') return [];
  const out: string[] = [];
  if (t.costUsd['sdk-estimate'] !== undefined) out.push(`~${dollars(t.costUsd['sdk-estimate'])} (SDK estimate${t.plan ? ', API-equivalent: your plan is not billed per token' : ''})`);
  if (t.costUsd['your-rates'] !== undefined) out.push(`~${dollars(t.costUsd['your-rates'])} (computed from your rates)`);
  if (!out.length) out.push(adapter === 'codex' ? 'no dollar figure (add your rates under Settings, Agent usage)' : 'cost not reported');
  return out;
}

const round = (n: number) => String(Math.round(n * 100) / 100);

// ---------------------------------------------------------------- Codex rates

/** Dollars per million tokens, as the person entered them for Codex. */
export interface CodexRates {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
}

/** A Codex record's dollar figure from the person's rates; undefined when it reported no tokens. */
export function codexCost(r: Pick<UsageRecord, Figure>, rates: CodexRates): number | undefined {
  if (r.inputTokens === undefined && r.outputTokens === undefined) return undefined;
  const cached = r.cachedInputTokens ?? 0;
  // Codex counts cached input inside its input, as OpenAI does, so the uncached part is the difference.
  const uncached = Math.max(0, (r.inputTokens ?? 0) - cached);
  return (uncached * rates.inputPerMillion + cached * rates.cachedInputPerMillion + (r.outputTokens ?? 0) * rates.outputPerMillion) / 1_000_000;
}

// ---------------------------------------------------------------- caps

export type CapUnit = 'tokens' | 'usd' | 'premium-requests';
export type CapScope = 'chat' | 'day';
export interface Cap {
  unit: CapUnit;
  limit: number;
}

/** Every cap setting there is: per chat and per day, for each adapter, in the units its SDK reports. */
export const CAP_SETTINGS = [
  { key: 'claude.chat', adapter: 'claude', scope: 'chat', units: ['tokens', 'usd'] },
  { key: 'claude.day', adapter: 'claude', scope: 'day', units: ['tokens', 'usd'] },
  { key: 'codex.chat', adapter: 'codex', scope: 'chat', units: ['tokens', 'usd'] },
  { key: 'codex.day', adapter: 'codex', scope: 'day', units: ['tokens', 'usd'] },
  { key: 'copilot.chat', adapter: 'copilot', scope: 'chat', units: ['tokens', 'premium-requests'] },
  { key: 'copilot.day', adapter: 'copilot', scope: 'day', units: ['tokens', 'premium-requests'] },
] as const satisfies ReadonlyArray<{ key: string; adapter: UsageAdapter; scope: CapScope; units: readonly CapUnit[] }>;
export type CapKey = (typeof CAP_SETTINGS)[number]['key'];

export const UNIT_LABEL: Record<CapUnit, string> = { tokens: 'tokens', usd: 'US dollars', 'premium-requests': 'premium requests' };

/** Toil UI's usage settings (`~/.toil-ui/usage.json`): the caps, and the rates Codex's dollar figure is computed from. */
export interface UsageSettings {
  /** A cap that is absent is off, as is one set to "off". */
  caps: Partial<Record<CapKey, Cap | 'off'>>;
  codexRates: CodexRates | null;
}

export const DEFAULT_USAGE_SETTINGS: UsageSettings = { caps: {}, codexRates: null };

export class UsageSettingsError extends Error {
  constructor(
    message: string,
    readonly fix: string,
  ) {
    super(message);
  }
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const CAP_SHAPE = 'Give { "unit": "tokens", "limit": 50000 } (a unit the setting lists and a number above 0), or "off" to turn the cap off.';

/** Checks usage settings from the page or the file. Anything that doesn't parse is refused, naming the setting; nothing is read as 0 or off. */
export function checkUsageSettings(input: unknown): UsageSettings {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new UsageSettingsError('The usage settings must be an object.', 'Send { "caps": { … }, "codexRates": null }.');
  const o = input as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== 'caps' && k !== 'codexRates');
  if (extra.length) throw new UsageSettingsError(`The usage settings have no ${extra.map((k) => JSON.stringify(k)).join(', ')}.`, 'They hold caps and codexRates only.');

  let codexRates: CodexRates | null = null;
  if (o.codexRates !== undefined && o.codexRates !== null) {
    const r = o.codexRates as Record<string, unknown>;
    if (typeof r !== 'object' || Array.isArray(r)) throw new UsageSettingsError(`codexRates must be an object of three rates, not ${JSON.stringify(o.codexRates)}.`, 'Give inputPerMillion, cachedInputPerMillion and outputPerMillion in dollars, or null for no rates.');
    const names = ['inputPerMillion', 'cachedInputPerMillion', 'outputPerMillion'] as const;
    const unknown = Object.keys(r).filter((k) => !(names as readonly string[]).includes(k));
    if (unknown.length) throw new UsageSettingsError(`codexRates has no ${unknown.map((k) => JSON.stringify(k)).join(', ')}.`, `It holds ${names.join(', ')}.`);
    for (const n of names) {
      if (!isNumber(r[n]) || r[n] < 0) throw new UsageSettingsError(`codexRates.${n} must be a number of dollars per million tokens, 0 or more, not ${JSON.stringify(r[n] ?? null)}.`, 'Enter the rate from your OpenAI price list, or clear all three rates.');
    }
    codexRates = { inputPerMillion: r.inputPerMillion as number, cachedInputPerMillion: r.cachedInputPerMillion as number, outputPerMillion: r.outputPerMillion as number };
  }

  const caps: UsageSettings['caps'] = {};
  if (o.caps !== undefined) {
    if (typeof o.caps !== 'object' || o.caps === null || Array.isArray(o.caps)) throw new UsageSettingsError('caps must be an object of cap settings.', `Name each cap by its setting: ${CAP_SETTINGS.map((s) => s.key).join(', ')}.`);
    for (const [key, value] of Object.entries(o.caps)) {
      const setting = CAP_SETTINGS.find((s) => s.key === key);
      if (!setting) throw new UsageSettingsError(`There is no cap setting ${JSON.stringify(key)}.`, `The cap settings are ${CAP_SETTINGS.map((s) => s.key).join(', ')}.`);
      if (value === 'off') {
        caps[setting.key] = 'off';
        continue;
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new UsageSettingsError(`${key}: ${JSON.stringify(value)} isn't a cap.`, CAP_SHAPE);
      const v = value as Record<string, unknown>;
      const unknownKeys = Object.keys(v).filter((k) => k !== 'unit' && k !== 'limit');
      if (unknownKeys.length) throw new UsageSettingsError(`${key}: a cap has no ${unknownKeys.map((k) => JSON.stringify(k)).join(', ')}.`, CAP_SHAPE);
      if (!(setting.units as readonly string[]).includes(v.unit as string)) throw new UsageSettingsError(`${key}: ${JSON.stringify(v.unit ?? null)} isn't a unit this cap takes.`, `${ADAPTER_LABEL[setting.adapter]} reports ${setting.units.map((u) => UNIT_LABEL[u]).join(' and ')}, so use ${setting.units.map((u) => JSON.stringify(u)).join(' or ')}.`);
      if (!isNumber(v.limit) || v.limit <= 0) throw new UsageSettingsError(`${key}: the limit ${JSON.stringify(v.limit ?? null)} isn't a number above 0.`, `Give a number above 0, or set ${key} to "off" to turn the cap off.`);
      if (setting.adapter === 'codex' && v.unit === 'usd' && !codexRates) throw new UsageSettingsError(`${key}: a dollar cap for Codex needs your Codex rates, since the Codex SDK reports no dollar figure.`, 'Enter your rates under Codex rates, or cap Codex in tokens.');
      caps[setting.key] = { unit: v.unit as CapUnit, limit: v.limit };
    }
  }
  return { caps, codexRates };
}

/** How one cap stands. */
export interface CapStanding {
  key: CapKey;
  adapter: UsageAdapter;
  scope: CapScope;
  cap: Cap;
  used: number;
  /** The SDK reported nothing this cap counts yet, so `used` is 0 for want of a figure. */
  reported: boolean;
  /** used / limit. */
  share: number;
}

/** What a cap in this unit counts in these totals, for this adapter. */
export function counted(t: UsageTotals, unit: CapUnit, adapter: UsageAdapter): number | undefined {
  if (unit === 'tokens') return t.tokens;
  if (unit === 'premium-requests') return t.premiumRequests;
  return adapter === 'codex' ? t.costUsd['your-rates'] : t.costUsd['sdk-estimate'];
}

/** The caps that are on for an adapter, against a chat's records and the day's records for that adapter. */
export function capStandings(settings: UsageSettings, adapter: UsageAdapter, chat: readonly UsageRecord[], day: readonly UsageRecord[]): CapStanding[] {
  const out: CapStanding[] = [];
  for (const s of CAP_SETTINGS) {
    if (s.adapter !== adapter) continue;
    const cap = settings.caps[s.key];
    if (!cap || cap === 'off') continue;
    // Both scopes count this adapter's records only: a chat that switched adapters holds the other's too.
    const value = counted(addUp((s.scope === 'chat' ? chat : day).filter((r) => r.adapter === adapter)), cap.unit, adapter);
    const used = value ?? 0;
    out.push({ key: s.key, adapter, scope: s.scope, cap, used, reported: value !== undefined, share: used / cap.limit });
  }
  return out;
}

/** An amount in a cap's unit: "52,310 tokens", "$1.25", "3 premium requests". */
export function amount(n: number, unit: CapUnit): string {
  if (unit === 'usd') return dollars(n);
  const whole = unit === 'tokens' ? Math.round(n).toLocaleString('en-US') : round(n);
  return `${whole} ${unit === 'tokens' ? 'tokens' : n === 1 ? 'premium request' : 'premium requests'}`;
}

const whose = (c: CapStanding) => (c.scope === 'chat' ? 'This chat' : `${ADAPTER_LABEL[c.adapter]} today (UTC)`);
const capName = (c: CapStanding) => `${ADAPTER_LABEL[c.adapter]}'s ${c.scope === 'chat' ? 'per-chat' : 'per-day'} cap (${c.key})`;

/** The warning at 80%, or past the cap once a run that couldn't be stopped ended over it. */
export function capWarning(c: CapStanding): string {
  if (c.share >= 1) return `${whose(c)} has used ${amount(c.used, c.cap.unit)}, past ${capName(c)} of ${amount(c.cap.limit, c.cap.unit)}, so the next question will be refused.`;
  return `${whose(c)} has used ${amount(c.used, c.cap.unit)} of ${capName(c)} of ${amount(c.cap.limit, c.cap.unit)} (${Math.floor(c.share * 100)}%).`;
}

/** Why a question was stopped or refused at a cap, and how to raise it. */
export function capStop(c: CapStanding): { message: string; fix: string } {
  return {
    message: `${capName(c)} stopped this question: ${c.scope === 'chat' ? 'this chat' : whose(c)} has used ${amount(c.used, c.cap.unit)}, and the cap is ${amount(c.cap.limit, c.cap.unit)}.`,
    fix: `${c.scope === 'chat' ? 'Start a new chat, or raise' : 'Wait for the next day (UTC), or raise'} the cap or turn it off under Settings, Agent usage. The cap counts only what the SDK reports; ${VENDOR[c.adapter]} own bill is the authority.`,
  };
}

/** The share of a cap at which the chat says so. */
export const WARN_AT = 0.8;

// ---------------------------------------------------------------- export

const CSV_COLUMNS = ['at', 'day', 'adapter', 'model', 'toilProject', 'chatId', 'turn', 'inputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens', 'premiumRequests', 'costUsd', 'costSource', 'id'] as const;

const cell = (v: unknown) => {
  if (v === undefined || v === null) return '';
  const s = String(v);
  // A leading = + - @ would be a formula to a spreadsheet; quoting and a leading apostrophe keep it text.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) || safe !== s ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The reports as CSV, one row per report; a figure the SDK didn't report is an empty cell, never 0. */
export function usageCsv(records: readonly UsageRecord[]): string {
  const rows = reports(records).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) lines.push(CSV_COLUMNS.map((c) => cell(c === 'day' ? dayOf(r) : r[c as keyof UsageRecord])).join(','));
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- what an answer carries

/** How full the model's context got, where the SDK says. */
export interface ContextUse {
  used: number;
  window: number;
}

/** Copilot's premium requests left this period, from the SDK's experimental `account.getQuota`. */
export interface PremiumQuota {
  remaining: number | null;
  entitlement: number | null;
  unlimited: boolean;
  resetDate: string | null;
}

/** Which chat a question belongs to, and which question in it: the page makes the id when its chat opens. */
export interface ChatTurn {
  id: string;
  turn: number;
}

/** A chat id the server takes: letters, digits and hyphens, as a UUID is. */
export const CHAT_ID = /^[A-Za-z0-9-]{8,64}$/;

/** What one answer carries about its usage (src/agent.ts, Answer.usage). */
export interface AnswerUsage {
  adapter: UsageAdapter;
  /** This question's records, every one the SDK reported. */
  records: UsageRecord[];
  context?: ContextUse;
  quota?: PremiumQuota;
  /** Caps at 80% or more, in words. */
  notices: string[];
  /** Figures made up for the preview, not reported by any SDK. */
  sample?: boolean;
}

// ---------------------------------------------------------------- the page's calls

/** What `api/usage` answers: the window's records for the page to add up, and the settings. */
export interface UsageView {
  since: string;
  now: string;
  records: UsageRecord[];
  /** Days the cache keeps a record; the page says so when it's shorter than the window. Null for sample data, which keeps nothing. */
  retentionDays: number | null;
  settings: UsageSettings;
  /** Why the saved settings can't be read, if they can't; every question is refused meanwhile. */
  problem: string | null;
  /** Sample figures, not reported by any SDK; nothing can be saved. */
  sample: boolean;
}

/** What Settings, Agent usage reads and saves: the server's `api/usage`, or the preview's sample. */
export interface ModelUsageApi {
  view(): Promise<UsageView>;
  save(settings: UsageSettings): Promise<UsageView>;
}
