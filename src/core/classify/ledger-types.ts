/**
 * The classification ledger's shapes (#566, docs/work-classification-proposal.md,
 * Step 4). The ledger is `~/.toil/classify/<scheme>.jsonl`: one line per
 * verdict `classify run --record` kept, and one per correction a person made,
 * through any door. It stays on the person's machine; what a team shares is
 * the sharper scheme file the corrections lead to. A line holds ids, titles
 * and reasons and never an item's body, a host or a credential. People will
 * disagree with a classifier, and this is the one form where the disagreement
 * is filed instead of minuted.
 */

import type { VerdictSource } from './types.js';

/** The door a correction came through. `tracker` is a label someone changed in Jira, GitHub or Azure DevOps (or a field, where the item has no scheme label), noticed on the next run. */
export const LEDGER_DOORS = ['cli', 'mcp', 'api', 'tracker'] as const;
export type LedgerDoor = (typeof LEDGER_DOORS)[number];

/** A verdict `classify run --record` kept. `category` is a category id, or null for unsure. */
export interface LedgerVerdict {
  kind: 'verdict';
  at: string;
  /** The item's OWI id, `<connection>:<key>`. */
  item: string;
  title: string;
  toilProject: string | null;
  category: string | null;
  source: VerdictSource;
  scheme: string;
  revision: number;
}

/**
 * A person's say on an item. `from` is what the ledger last held for the item
 * (null when it held nothing, or held unsure) and `fromSource` what had decided
 * that; `to` is the category the person chose. `confirmed` is true when the
 * two are the same category: agreement is recorded, so it can be measured.
 */
export interface LedgerCorrection {
  kind: 'correction';
  at: string;
  item: string;
  title: string;
  toilProject: string | null;
  from: string | null;
  fromSource: VerdictSource | null;
  to: string;
  confirmed: boolean;
  via: LedgerDoor;
  /** Who made it, where the door knows: the tracker's own account name for `tracker`, else null. Never an email. */
  by: string | null;
  reason: string | null;
  scheme: string;
  revision: number;
}

export type LedgerLine = LedgerVerdict | LedgerCorrection;

/** The longest text a line keeps for a title or a reason; longer is cut, and control characters are dropped. */
export const LEDGER_TEXT_MAX = 300;
/** A ledger past this size is refused rather than read into memory; `classify stats` says how to start a new one. */
export const MAX_LEDGER_BYTES = 32 * 1024 * 1024;

/** What an item's history in the ledger comes to: the last word on it. */
export interface LedgerStanding {
  item: string;
  title: string;
  /** The category that stands now: the last correction's `to`, else the last verdict's category. */
  category: string | null;
  source: VerdictSource;
  /** How many corrections (not confirmations) the item has had. */
  corrections: number;
}

/** How often one source was right, by the people who checked it. */
export interface SourceScore {
  source: string;
  /** Verdicts from this source that a person confirmed or corrected. */
  checked: number;
  confirmed: number;
  overruled: number;
  /** Where the overruled ones went: `{ feature: 9 }`. */
  overruledTo: Record<string, number>;
  /** confirmed / checked, 0 to 1; null when nobody checked any. */
  agreement: number | null;
}

/** `classify stats`'s data. Every share is null, never 0, where nothing was checked (principle 12). */
export interface ClassifyStats {
  scheme: { name: string; revision: number };
  toilProject: string | null;
  ledger: { lines: number; verdicts: number; corrections: number; confirmations: number; items: number };
  agreement: {
    overall: number | null;
    checked: number;
    byCategory: Array<{ category: string; checked: number; confirmed: number; agreement: number | null }>;
    byRevision: Array<{ revision: number; checked: number; confirmed: number; agreement: number | null }>;
  };
  /** Every source a person checked, most overruled first. */
  sources: SourceScore[];
  /** Which way the errors run: from one category (or `unsure`) to another, with a count. */
  confusion: Array<{ from: string; to: string; count: number }>;
  /** Corrections recorded under the scheme's current revision: the ones no tune has seen yet. */
  sinceLastTune: number;
  /** Items corrected more than once. */
  changedTwice: Array<{ item: string; title: string; corrections: number }>;
  /** Corrections by door; `mcp` is the count an AI agent recorded for a person. */
  byDoor: Record<LedgerDoor, number>;
  /** Present with `--backtest-file`: the same held-back corrections scored under the scheme as it was and as revised. */
  backtest?: Backtest;
}

/**
 * A third of the corrections is held back from the tune prompt, so a revised
 * scheme is scored on items it never saw. Which third is fixed by the item's
 * id (`heldBack()` in ledger.ts), so `classify tune` and `classify stats
 * --backtest-file` agree without passing a list.
 */
export interface Backtest {
  heldBack: number;
  /** What the scheme said before, from the ledger's own record of each held-back item. */
  before: { revision: number; agreed: number; agreement: number | null };
  /** What the revised scheme says: its rules rerun by code where the items were passed, then the AI agent's verdicts. */
  after: { scheme: string; agreed: number; unsure: number; missing: number; agreement: number | null };
  /** Held-back items the revised scheme still gets wrong, or newly gets wrong. */
  disagreements: Array<{ item: string; title: string; people: string; before: string | null; after: string | null }>;
  /** True when the revised scheme scores lower. toil says so and changes nothing: a person decides. */
  worse: boolean;
}

/** A rule change in a tuned scheme needs this many corrections behind it, so one odd item can't reshape the scheme. */
export const MIN_CORRECTIONS_FOR_RULE = 3;
/** The most worked examples a tune may add per pair of categories people confuse. */
export const MAX_EXAMPLES_PER_PAIR = 4;
