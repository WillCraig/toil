/**
 * The toil project's briefing (#494): what its home page reads, one layer at a
 * time. Analyze writes it when the latest Analyze is current and answered with
 * a briefing block; otherwise toil's briefing by code does (src/core/brief/),
 * with the same reasons and no why-and-next-step, and the page says which
 * (principle 4). Two checks keep an agent's briefing honest: every item it
 * names must be one of the toil project's, and every item the code flagged that it
 * didn't mention, or left out because of the toil project's focus, is listed one
 * step in, so nothing drops off the page unsaid (the maintainer's decision on
 * #494). Pure, so the page, the drawer and the tests agree. An executive
 * summary that admits to an appendix.
 */

import { brief as briefByCode, lensDef, type Brief, type BriefItem, type LensId, type Severity } from '../../../src/core/brief/brief.ts';
import type { Briefing } from '../../../src/core/brief/answer.ts';
import type { BriefSettings } from '../../../src/core/brief/brief.ts';
import type { AnalysisSummary } from './analysis.ts';
import type { Change, WorkItem } from '../toil.ts';

export interface BriefingItem {
  id: string;
  /** Why it's here: the agent's sentence, or the code's. */
  why: string;
  /** One step a person could take today; only Analyze writes one. */
  next: string | null;
}

export interface BriefingReason {
  lens: string;
  label: string;
  severity: Severity;
  line: string;
  text: string | null;
  items: BriefingItem[];
}

export interface BriefingView {
  /** Who wrote it: `analyze` (with the record) or `code`. */
  by: 'analyze' | 'code';
  analysis: AnalysisSummary | null;
  /** Set when an Analyze is kept but isn't what the page shows, saying why. */
  stale: string | null;
  recommendation: string | null;
  reasons: BriefingReason[];
  onTrack: string;
  changed: string[];
  /** Items the toil project's "leave out" hid, by Analyze's account. */
  leftOut: Array<{ id: string; why: string }>;
  /** Items the code flagged that Analyze put under no reason and didn't leave out. */
  notMentioned: BriefItem[];
  /** Ids Analyze named that aren't the toil project's: shown as named, flagged. */
  unknown: string[];
  /** What the page must say about the briefing itself: a block that didn't fit, ids its tools never returned. Shown, never folded. */
  problems: string[];
  /** Lenses that did not run at all, and why (no limit set, a source missing): one step in. */
  unchecked: Array<{ lens: string; label: string; note: string }>;
  /** Lenses that ran but couldn't test some items, and which (three items with no assignee): one step in. Said apart from `unchecked`, since the rest of the lens was read. */
  partlyChecked: Array<{ lens: string; label: string; note: string }>;
  /** The code's briefing, always: the drawer's facts and the lens notes come from it. */
  code: Brief;
}

export interface BriefingInput {
  items: readonly WorkItem[];
  pullRequests: readonly Change[];
  now: string;
  settings: BriefSettings;
  /** The toil project's analyses, newest first. */
  analyses: readonly AnalysisSummary[];
}

/** The code's lens labels, said the way a manager would: WIP is a developer's abbreviation. */
const plainLabel = (label: string) => label.replace(/\bWIP\b/g, 'work-in-progress');
/** A command the core's note points at, in parentheses ("(toil projects wip-limit)", "(map pr get --include checks)"): not for a screen. */
const COMMAND_IN_PARENS = /\s*\((?:toil )?[a-z][a-z-]*(?: [a-z][a-z-]*)+\)|\s*\([^)]*--[^)]*\)/g;

/**
 * What a lens's note says on a screen. The core's text (`brief.ts`) names
 * commands for the CLI's readers, so each note it writes is put in plain words
 * here, by lens and by what the lens could not test; a note not recognised
 * keeps the core's words with any parenthesised command taken out.
 */
export function plainNote(lens: Brief['lenses'][number]): string {
  const n = lens.untested;
  const inProgress = (many: string, one: string) => `${n} ${n === 1 ? `item in progress ${one}` : `items in progress ${many}`}.`;
  if (!lens.checked) {
    if (lens.id === 'ready') return "Readiness isn't worked out in this summary.";
    if (lens.id === 'load') return 'No work-in-progress limit is set.';
    if (lens.id === 'sprint' && lens.note && /points estimate/.test(lens.note)) return 'No item in the sprint has a points estimate.';
    if (lens.id === 'sprint') return 'No item is in a sprint running now.';
  } else if (n > 0) {
    if (lens.id === 'failing') return 'Some code reviews have no checks read.';
    if (lens.id === 'waiting') return 'Some code reviews have no reviews read.';
    if (lens.id === 'load') return inProgress('have nobody assigned', 'has nobody assigned');
    if (lens.id === 'stale') return inProgress('have no last-updated time', 'has no last-updated time');
  }
  return (lens.note ?? '').replace(COMMAND_IN_PARENS, '');
}

const severityOf =(lens: string): Severity => (lens === 'failing' || lens === 'blocked' ? 'danger' : 'warn');
const knownLens = (lens: string): lens is LensId => ['failing', 'blocked', 'waiting', 'sprint', 'stale', 'load', 'drift', 'ready'].includes(lens);

/** Whether an analysis is current enough to lead the page: made since the data was read, or the same UTC day. */
export const isCurrent = (record: { at: string }, now: string) => record.at >= now || record.at.slice(0, 10) === now.slice(0, 10);

/** The briefing the page shows. */
export function briefingOf(input: BriefingInput): BriefingView {
  const code = briefByCode({ items: input.items, changes: input.pullRequests, asOf: input.now, settings: input.settings });
  const latest = input.analyses[0] ?? null;
  const usable = latest?.briefing && isCurrent(latest, input.now) ? latest : null;
  const onTrackByCode = `${code.onTrack.open} open and ${code.onTrack.done} done are on track.`;
  const noted = (ran: boolean) => code.lenses.filter((l) => l.on && l.note && l.checked === ran).map((l) => ({ lens: l.id, label: plainLabel(l.label), note: plainNote(l) }));
  const unchecked = noted(false);
  const partlyChecked = noted(true);
  if (!usable) {
    const stale = !latest ? null : !isCurrent(latest, input.now) ? 'The latest Analyze is older than the data.' : 'The latest Analyze has no briefing block, so it is shown as it came on its own page.';
    return {
      by: 'code',
      analysis: latest,
      stale,
      recommendation: code.recommendation?.text ?? null,
      reasons: code.reasons.map((r) => ({ lens: r.lens, label: plainLabel(r.label), severity: r.severity, line: r.line, text: r.text, items: r.items.map((i) => ({ id: i.id, why: i.why, next: null })) })),
      onTrack: onTrackByCode,
      changed: [],
      leftOut: [],
      notMentioned: [],
      unknown: [],
      problems: [],
      unchecked,
      partlyChecked,
      code,
    };
  }
  const b: Briefing = usable.briefing!;
  const ids = new Set(input.items.map((i) => i.id));
  const named = new Set(b.reasons.flatMap((r) => r.items.map((i) => i.id)));
  const left = new Set(b.leftOut.map((l) => l.id));
  return {
    by: 'analyze',
    analysis: usable,
    stale: null,
    recommendation: b.recommendation,
    reasons: b.reasons.map((r) => ({ lens: r.lens, label: plainLabel(r.label || (knownLens(r.lens) ? lensDef(r.lens).label : r.lens)), severity: severityOf(r.lens), line: r.line, text: r.text, items: r.items })),
    onTrack: b.onTrack ?? onTrackByCode,
    changed: b.changed,
    leftOut: b.leftOut,
    notMentioned: code.reasons.flatMap((r) => r.items).filter((i) => !named.has(i.id) && !left.has(i.id)),
    unknown: [...named, ...left].filter((id) => !ids.has(id)),
    problems: [...usable.briefingProblems, ...(usable.unverified ? [`Analyze named ${usable.unverified === 1 ? 'an item' : `${usable.unverified} items`} its tools never returned; the analysis marks ${usable.unverified === 1 ? 'it' : 'them'}.`] : [])],
    unchecked,
    partlyChecked,
    code,
  };
}

/** Everything the page knows about one item: its reason, why, the next step, and the code's finding. */
export function itemBriefing(view: BriefingView, id: string): { reason: BriefingReason | null; item: BriefingItem | null; code: BriefItem | null } {
  const reason = view.reasons.find((r) => r.items.some((i) => i.id === id)) ?? null;
  const code = view.code.reasons.flatMap((r) => r.items).find((i) => i.id === id) ?? null;
  return { reason, item: reason?.items.find((i) => i.id === id) ?? null, code };
}
