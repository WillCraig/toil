/**
 * Analyze's answers, kept and compared (#395). An Analyze answer is written
 * top-down, in the Minto order the prompt asks for (server/agents/prompts.ts):
 * a Recommendation line, then at most three Issues, then the Evidence. This
 * module reads that shape back out of the text (`structureOf`), so the page
 * can lay it out and the history can keep the recommendation and issues on
 * their own. It also takes a small snapshot of the toil project at the moment of
 * each analysis (what is blocked and by what, each item's points, the
 * sprint's points done and left), so the history can say what changed from
 * one analysis to the next by code, never by asking the agent. Pure, so the
 * server, the sample and the page all use the same rules.
 *
 * An answer that doesn't follow the shape is kept and shown as it came, and
 * the page says it didn't follow it (principle 4): a model's slip is never
 * reshaped into something it didn't write. Minutes with an agenda, at last.
 */

import { readBriefing, type Briefing } from '../../../src/core/brief/answer.ts';
import { citationsOf, type Answer, type AnswerPart } from '../agent.ts';
import type { AnswerUsage } from '../model-usage.ts';
import type { Proposal } from '../proposal.ts';
import type { WorkItem } from '../toil.ts';
import { health } from './sprint.ts';

/** The most issues an analysis shows: the prompt asks for three at most, and any more go to the evidence. */
export const MAX_ISSUES = 3;
/** How many analyses a toil project keeps; the oldest go first. */
export const MAX_ANALYSES = 100;

export interface AnalysisIssue {
  /** Its short name, when the agent wrote one before a colon. */
  title: string | null;
  /** The sentence, citing items as `[[id]]`. */
  text: string;
}

/** An answer, top-down. */
export interface Structure {
  /** The one thing to do first, citing items as `[[id]]`. */
  recommendation: string;
  issues: AnalysisIssue[];
  /** The rest, a paragraph each: the evidence, then any issue past the third. */
  evidence: string[];
  /** How many issues the agent wrote past MAX_ISSUES, moved to the end of the evidence. */
  extraIssues: number;
}

/** A label at the start of a line: alone, or followed by a colon or dash and its text; Markdown the model adds anyway (a #, bold) is let through. "Evidence shows" is prose, not a label. */
const LABEL = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?(recommendation|issues|evidence)(?:(?:\*\*|__)?[ \t]*[:\-–—](?:\*\*|__)?[ \t]*(.*)|(?:\*\*|__)?[ \t]*)$/gim;
const BULLET = /^[ \t]*(?:\d{1,2}[.)]|[-*•])[ \t]+/;
const NONE = /^(?:none|nothing(?: stands out)?|no issues?)\.?$/i;

/** "Build failing: [[id]] fails its build" → its short name and the sentence; a sentence with no short name keeps its whole text. */
function issueOf(line: string): AnalysisIssue {
  const text = line.replace(BULLET, '').trim();
  const m = /^([^:[\]]{1,60}):\s+(.+)$/s.exec(text);
  return m ? { title: m[1]!.trim(), text: m[2]!.trim() } : { title: null, text };
}

const paragraphs = (text: string) =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

/**
 * Reads the Recommendation, Issues and Evidence back out of an answer's
 * text. Null when it has no Recommendation label: that answer is shown as
 * it came. Text before the first label goes to the end of the evidence, so
 * nothing the agent wrote is lost.
 */
export function structureOf(text: string): Structure | null {
  const marks = [...text.matchAll(LABEL)].map((m) => ({ label: m[1]!.toLowerCase(), start: m.index, rest: m[2] ?? '', end: m.index + m[0].length }));
  const first = marks.find((m) => m.label === 'recommendation');
  if (!first) return null;
  // One section per label, the first of each kind after the recommendation; a repeated label is text.
  const used = marks.filter((m, i) => m.start >= first.start && marks.findIndex((n) => n.label === m.label && n.start >= first.start) === i);
  const section = (label: string) => {
    const at = used.findIndex((m) => m.label === label);
    if (at < 0) return null;
    const m = used[at]!;
    const next = used[at + 1]?.start ?? text.length;
    return `${m.rest}\n${text.slice(m.end, next)}`.trim();
  };
  const recommendation = (section('recommendation') ?? '').replace(/\s*\n\s*/g, ' ').trim();
  if (!recommendation) return null;
  const issueText = section('issues') ?? '';
  const lines = issueText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  // Numbered or bulleted lines are one issue each; a line that doesn't start one continues the last.
  const bulleted = lines.some((l) => BULLET.test(l));
  const raw: string[] = [];
  for (const line of lines) {
    if (!bulleted || BULLET.test(line) || !raw.length) raw.push(line);
    else raw[raw.length - 1] += ` ${line}`;
  }
  const issues = raw.filter((l) => !NONE.test(l.replace(BULLET, '').trim())).map(issueOf);
  const before = text.slice(0, first.start).trim();
  const evidence = [...paragraphs(section('evidence') ?? ''), ...issues.slice(MAX_ISSUES).map((i) => (i.title ? `${i.title}: ${i.text}` : i.text)), ...paragraphs(before)];
  return { recommendation, issues: issues.slice(0, MAX_ISSUES), evidence, extraIssues: Math.max(0, issues.length - MAX_ISSUES) };
}

/** The answer's text, its paragraphs joined back, for `structureOf`. */
export const textOfParts = (parts: readonly AnswerPart[]) => parts.map((p) => p.text).join('\n\n');

/** What the toil project looked like when an analysis was made: enough to say what changed by the next one. */
export interface AnalysisSnapshot {
  /** Each open item held up by an open item, with what holds it. */
  blocked: Array<{ id: string; by: string[] }>;
  /** Every item estimated in points, by id. */
  points: Record<string, number>;
  /** The current sprint's points done and left, or null with no sprint running. */
  sprint: { name: string; done: number; remaining: number } | null;
}

const open = (i: WorkItem) => i.statusCategory !== 'DONE';

/** The snapshot of a toil project's items at a moment, by the same blocks rule the sprint panel uses. */
export function snapshotOf(items: readonly WorkItem[], now: string): AnalysisSnapshot {
  const byId = new Map(items.map((i) => [i.id, i]));
  const blocked: AnalysisSnapshot['blocked'] = [];
  for (const item of items) {
    if (!open(item)) continue;
    const by = item.links.filter((l) => l.type === 'blocks' && l.direction === 'inward' && byId.has(l.target) && open(byId.get(l.target)!)).map((l) => l.target);
    if (by.length) blocked.push({ id: item.id, by: [...new Set(by)].sort() });
  }
  const points: Record<string, number> = {};
  for (const item of items) if (item.estimate?.unit === 'points') points[item.id] = item.estimate.value;
  const h = health([...items], [], now);
  return { blocked: blocked.sort((a, b) => a.id.localeCompare(b.id)), points, sprint: h ? { name: h.sprint.name, done: h.done.points, remaining: h.remaining.points } : null };
}

/** One analysis, as the history keeps it. */
export interface AnalysisRecord {
  id: string;
  toilProject: string;
  /** When it was asked, and when its answer was whole. */
  startedAt: string;
  at: string;
  /** Who answered: the adapter's name and the model it was given (null: its CLI's default), and the label the chat showed. */
  adapter: string | null;
  model: string | null;
  by: string;
  usage: AnswerUsage | null;
  /** The recommendation and issues: from the briefing block (#494), or as structureOf read an older answer; null and none when it followed neither shape. */
  recommendation: string | null;
  issues: AnalysisIssue[];
  /** The briefing the answer's ```briefing block held (#494), checked for its shape; null for an answer without one, and for analyses kept before it. */
  briefing?: Briefing | null;
  /** What in the block didn't fit, in words: shown on the page, never fixed up. */
  briefingProblems?: string[];
  /** The whole answer, to read again. */
  parts: AnswerPart[];
  citations: string[];
  unverified: string[];
  warnings: string[];
  proposals: Proposal[];
  snapshot: AnalysisSnapshot;
}

/** An Analyze answer, finished, as a record for the history. */
export function recordOf(answer: Answer, o: { id: string; toilProject: string; startedAt: string; at: string; snapshot: AnalysisSnapshot }): AnalysisRecord {
  const text = textOfParts(answer.parts);
  // The server lifts the block out into answer.briefing; the sample, and an answer kept before that, still carry it in the text.
  const read = answer.briefing !== undefined ? { briefing: answer.briefing, problems: answer.briefingProblems ?? [] } : text.includes('```briefing') ? readBriefing(text) : null;
  const b = read?.briefing ?? null;
  const s = b ? null : structureOf(text);
  return {
    id: o.id,
    toilProject: o.toilProject,
    startedAt: o.startedAt,
    at: o.at,
    adapter: answer.adapter ?? null,
    model: answer.model ?? null,
    by: answer.by,
    usage: answer.usage ?? null,
    recommendation: b?.recommendation ?? s?.recommendation ?? null,
    issues: b ? b.reasons.slice(0, MAX_ISSUES).map((r) => ({ title: r.label, text: r.text ?? r.line })) : (s?.issues ?? []),
    briefing: b,
    briefingProblems: read?.problems ?? [],
    parts: answer.parts,
    citations: answer.citations.length ? answer.citations : citationsOf(answer.parts),
    unverified: answer.unverified ?? [],
    warnings: answer.warnings ?? [],
    proposals: answer.proposals,
    snapshot: o.snapshot,
  };
}

/** What changed between one analysis and the one before it, by code. */
export interface AnalysisChanges {
  /** The analysis before it; null for the first one the history holds. */
  previous: { id: string; at: string } | null;
  /** Items blocked now that weren't, or blocked by something new. */
  newlyBlocked: Array<{ id: string; by: string[] }>;
  /** Items blocked then and not now. */
  cleared: string[];
  /** Items whose points changed, or that gained or lost an estimate. */
  points: Array<{ id: string; from: number | null; to: number | null }>;
  /** The sprint's points done and left, then and now, when either moved or the sprint changed. */
  sprint: { from: AnalysisSnapshot['sprint']; to: AnalysisSnapshot['sprint'] } | null;
  /** Items this analysis cites that the one before didn't, and the other way round. */
  cited: string[];
  dropped: string[];
  /** The recommendation line differs from the one before. */
  recommendationChanged: boolean;
}

/** True when nothing at all changed: the history says so in words. */
export const unchanged = (c: AnalysisChanges) =>
  !c.newlyBlocked.length && !c.cleared.length && !c.points.length && !c.sprint && !c.cited.length && !c.dropped.length && !c.recommendationChanged;

/** What changed from `before` to `after`; `before` null is the first analysis, which has nothing to compare with. */
export function changesBetween(before: AnalysisRecord | null, after: AnalysisRecord): AnalysisChanges {
  if (!before) return { previous: null, newlyBlocked: [], cleared: [], points: [], sprint: null, cited: [], dropped: [], recommendationChanged: false };
  const was = new Map(before.snapshot.blocked.map((b) => [b.id, new Set(b.by)]));
  const now = new Set(after.snapshot.blocked.map((b) => b.id));
  const newlyBlocked = after.snapshot.blocked.filter((b) => !was.has(b.id) || b.by.some((by) => !was.get(b.id)!.has(by)));
  const cleared = before.snapshot.blocked.filter((b) => !now.has(b.id)).map((b) => b.id);
  const ids = [...new Set([...Object.keys(before.snapshot.points), ...Object.keys(after.snapshot.points)])].sort();
  const points = ids.flatMap((id) => {
    const from = before.snapshot.points[id] ?? null;
    const to = after.snapshot.points[id] ?? null;
    return from === to ? [] : [{ id, from, to }];
  });
  const a = before.snapshot.sprint;
  const b = after.snapshot.sprint;
  const sprintMoved = a?.name !== b?.name || a?.done !== b?.done || a?.remaining !== b?.remaining;
  const cited = after.citations.filter((id) => !before.citations.includes(id));
  const dropped = before.citations.filter((id) => !after.citations.includes(id));
  const recommendationChanged = (before.recommendation ?? '') !== (after.recommendation ?? '');
  return { previous: { id: before.id, at: before.at }, newlyBlocked, cleared, points, sprint: sprintMoved ? { from: a, to: b } : null, cited, dropped, recommendationChanged };
}

/** One entry of the history, as the list shows it: the record less its full answer, with what changed since the one before. */
export interface AnalysisSummary {
  id: string;
  at: string;
  adapter: string | null;
  model: string | null;
  by: string;
  recommendation: string | null;
  issues: AnalysisIssue[];
  citations: string[];
  unverified: number;
  changes: AnalysisChanges;
  /** Its briefing (#494) and proposals, for the toil project's home page and the item drawer. */
  briefing: Briefing | null;
  /** What in the briefing block didn't fit, in words. */
  briefingProblems: string[];
  proposals: Proposal[];
}

/** A record and what changed since the one before it, for one analysis opened. */
export interface AnalysisView {
  record: AnalysisRecord;
  changes: AnalysisChanges;
}

/** The history, newest first, each with what changed since the one before. `records` may come in any order. */
export function historyOf(records: readonly AnalysisRecord[]): AnalysisSummary[] {
  const oldest = [...records].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return oldest
    .map((r, i) => ({
      id: r.id,
      at: r.at,
      adapter: r.adapter,
      model: r.model,
      by: r.by,
      recommendation: r.recommendation,
      issues: r.issues,
      citations: r.citations,
      unverified: r.unverified.length,
      changes: changesBetween(oldest[i - 1] ?? null, r),
      briefing: r.briefing ?? null,
      briefingProblems: r.briefingProblems ?? [],
      proposals: r.proposals,
    }))
    .reverse();
}

/** One record opened, with what changed since the one before it. */
export function viewOf(records: readonly AnalysisRecord[], id: string): AnalysisView | null {
  const oldest = [...records].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const i = oldest.findIndex((r) => r.id === id);
  return i < 0 ? null : { record: oldest[i]!, changes: changesBetween(oldest[i - 1] ?? null, oldest[i]!) };
}
