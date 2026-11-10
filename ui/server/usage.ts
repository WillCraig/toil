/**
 * The model usage ledger and its settings, server side (#295). The ledger is
 * where the agent's usage records go: the cache's `usage` table for a real
 * Toil UI (server/cache.ts), kept apart from what a sync writes, or one in
 * memory for the tests. The settings are the Codex rates, in
 * Toil UI's own data folder (`~/.toil-ui/usage.json`) beside agent.json,
 * never toil's config and never the cache, so a wipe deletes the figures but
 * not the rates. A file that doesn't parse names the setting at fault; Settings
 * shows it, and a Codex answer says its dollar figure is missing for that
 * reason. The adding-up is src/model-usage.ts's alone.
 * A ledger, kept in pencil, audited in pen.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { checkUsageSettings, DEFAULT_USAGE_SETTINGS, UsageSettingsError, type UsageRecord, type UsageSettings, type UsageView } from '../src/model-usage.ts';

export type { UsageView } from '../src/model-usage.ts';
import type { Cache } from './cache.ts';

export interface UsageLedger {
  add(records: readonly UsageRecord[]): void;
  /** Reports at or after an instant. */
  since(iso: string): UsageRecord[];
  chat(chatId: string): UsageRecord[];
}

/** The ledger in the cache. The cache may be reopened after a wipe, so it's read through a getter. */
export function cacheLedger(cache: () => Cache): UsageLedger {
  return {
    add: (records) => cache().addUsage(records),
    since: (iso) => cache().usageSince(iso),
    chat: (id) => cache().usageOfChat(id),
  };
}

/** A ledger in memory: the tests', and the shape the cache's must keep. */
export function memoryLedger(seed: readonly UsageRecord[] = []): UsageLedger & { rows: UsageRecord[] } {
  const rows: UsageRecord[] = [...seed];
  return {
    rows,
    add: (records) => void rows.push(...records),
    since: (iso) => rows.filter((r) => r.at >= iso),
    chat: (id) => rows.filter((r) => r.chatId === id),
  };
}

export const usageSettingsFile = (dataDir: string, path: Pick<typeof nodePath, 'join'> = nodePath) => path.join(dataDir, 'usage.json');

/** The saved usage settings, or the defaults (no rates) when there is no file. A broken file throws, naming the setting, in words with no file path (Plain copy, ui/README.md). */
export function loadUsageSettings(dataDir: string): UsageSettings {
  const file = usageSettingsFile(dataDir);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_USAGE_SETTINGS };
    throw new UsageSettingsError(`Toil UI couldn't open its saved Codex rates (${(e as NodeJS.ErrnoException).code ?? 'unknown error'}).`, 'Check that this computer lets Toil UI read its own data folder, or save the rates again under Settings, Usage.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageSettingsError("Toil UI's saved Codex rates can't be read: the file is damaged.", 'Save the rates again under Settings, Usage, which rewrites them.');
  }
  // Files saved before usage caps were removed carry a `caps` key; it is ignored here, and the next save rewrites the file without it.
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    delete (parsed as Record<string, unknown>).caps;
  }
  try {
    return checkUsageSettings(parsed);
  } catch (e) {
    if (e instanceof UsageSettingsError) throw new UsageSettingsError(`Toil UI's saved Codex rates: ${e.message}`, `${e.fix} Or save the rates again under Settings, Usage.`);
    throw e;
  }
}

/** Writes the settings, owner-only, through a temporary file so a crash never leaves half of one. */
export function saveUsageSettings(dataDir: string, settings: UsageSettings) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = usageSettingsFile(dataDir);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

/** How many days Settings, Usage reads back. */
export const USAGE_WINDOW_DAYS = 30;

/** What the server reads and changes about usage (#295). */
export interface UsageControl {
  view(): UsageView;
  /** Checks and saves the settings; throws a UsageSettingsError naming the setting. */
  save(input: unknown): UsageView;
}

export interface UsageControlOptions {
  dataDir: string;
  ledger: UsageLedger;
  retentionDays: number | null;
  now?: () => Date;
  /** Sample data: these settings, shown and never saved. */
  sample?: UsageSettings;
}

export function usageControl(o: UsageControlOptions): UsageControl {
  const now = o.now ?? (() => new Date());
  const view = (): UsageView => {
    const at = now();
    const since = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) - (USAGE_WINDOW_DAYS - 1) * 86_400_000).toISOString();
    let settings: UsageSettings = o.sample ?? { ...DEFAULT_USAGE_SETTINGS };
    let problem: string | null = null;
    if (!o.sample) {
      try {
        settings = loadUsageSettings(o.dataDir);
      } catch (e) {
        problem = e instanceof UsageSettingsError ? `${e.message} ${e.fix}` : String(e);
      }
    }
    return { since, now: at.toISOString(), records: o.ledger.since(since), retentionDays: o.retentionDays, settings, problem, sample: o.sample !== undefined };
  };
  return {
    view,
    save(input) {
      if (o.sample) throw new UsageSettingsError("This preview shows sample data, so its rates can't be saved.", 'Set your rates in your own Toil UI, not the preview.');
      saveUsageSettings(o.dataDir, checkUsageSettings(input));
      return view();
    },
  };
}
