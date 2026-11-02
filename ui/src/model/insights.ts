/**
 * Insights on tickets (#253): what deserves a look about each work item, from
 * its OWI fields, its transitions, its links and the pull requests, builds and
 * deployments that name it. Pure, so the cards, the item page, the "needs
 * attention" list and the agent all say the same thing, and the tests check
 * it. Every insight says what it rests on (principle 4): the OWI field, the
 * history, or the toil command whose output showed it. One that the data
 * can't support (aging with fewer than three cycle times to compare against,
 * "built but not deployed" for a dossier that names no environment) isn't
 * raised at all, rather than raised on a guess.
 * The standup's "any blockers?", answered before anyone unmutes.
 */

import { lensDef } from '../../../src/core/brief/brief.ts';
import type { ChangeRef, Deployment, WorkItem } from '../toil.ts';
import { aging, cycleTimes, flows, percentile } from './flow.ts';
import { latestBuild, needsEstimate, type Health } from './sprint.ts';

export type InsightCode =
  | 'blocked'
  | 'failing-build'
  | 'aging'
  | 'deployed-not-closed'
  | 'carried'
  | 'pr-no-build'
  | 'stale'
  | 'blocking'
  | 'built-not-deployed'
  | 'unestimated'
  | 'added';

export interface Insight {
  code: InsightCode;
  /** 3 needs action now, 2 needs a look, 1 is worth knowing. */
  weight: 1 | 2 | 3;
  /** Plain words, citing items as `[[<owi id>]]`. */
  text: string;
  /** What it rests on: an OWI field, the history, or a toil command. */
  evidence: string;
}

export const INSIGHT_LABEL: Record<InsightCode, string> = {
  blocked: 'Blocked',
  'failing-build': 'Build failing',
  aging: 'Aging',
  'deployed-not-closed': 'Deployed, still open',
  carried: 'Carried over',
  'pr-no-build': 'PR with no build',
  stale: 'Stale',
  blocking: 'Blocking',
  'built-not-deployed': 'Merged, not deployed',
  unestimated: 'No estimate',
  added: 'Added mid-sprint',
};

/** No update for longer than this many days is stale. */
export const STALE_DAYS = lensDef('stale').threshold!;
/** Aging compares against this percentile of the dossier's cycle times, once there are enough of them. */
export const AGING_PERCENTILE = 85;
export const MIN_CYCLES = 3;

const DAY = 86_400_000;
const days = (n: number) => `${Math.round(n * 10) / 10} ${Math.round(n * 10) / 10 === 1 ? 'day' : 'days'}`;

export interface Context {
  items: WorkItem[];
  changes: ChangeRef[];
  deployments: Deployment[];
  health: Health | null;
  now: string;
}

export interface Prepared extends Context {
  byId: Map<string, WorkItem>;
  /** The aging threshold in days, with how many cycle times it came from; null with too few. */
  p85: { days: number; from: number } | null;
  ages: Map<string, number>;
}

export function prepare(ctx: Context): Prepared {
  const cycles = cycleTimes(ctx.items).known.map((c) => c.days);
  const p = cycles.length >= MIN_CYCLES ? percentile(cycles, AGING_PERCENTILE) : null;
  return {
    ...ctx,
    byId: new Map(ctx.items.map((i) => [i.id, i])),
    p85: p === null ? null : { days: p, from: cycles.length },
    ages: new Map(aging(ctx.items, ctx.now).known.map((a) => [a.id, a.days])),
  };
}

/** Every insight on one item, weightiest first. Done items and containers get none: nothing to act on. */
export function insights(item: WorkItem, p: Prepared): Insight[] {
  if (item.statusCategory === 'DONE' || !flows(item)) return [];
  const out: Insight[] = [];
  const open = (id: string) => p.byId.has(id) && p.byId.get(id)!.statusCategory !== 'DONE';

  for (const link of item.links) {
    if (link.type !== 'blocks' || !open(link.target)) continue;
    if (link.direction === 'inward') out.push({ code: 'blocked', weight: 3, text: `Blocked by [[${link.target}]], which isn't done`, evidence: `links (${link.name})` });
    else out.push({ code: 'blocking', weight: 2, text: `Blocks [[${link.target}]]`, evidence: `links (${link.name})` });
  }

  const build = latestBuild(item.id, p.changes);
  if (build?.outcome === 'failed') out.push({ code: 'failing-build', weight: 3, text: `Its latest build, ${build.title}, failed`, evidence: `toil ${build.command}` });

  const age = p.ages.get(item.id);
  if (age !== undefined && p.p85 && age > p.p85.days) {
    out.push({ code: 'aging', weight: 3, text: `In progress for ${days(age)}, longer than ${AGING_PERCENTILE}% of this dossier's finished items took (${days(p.p85.days)})`, evidence: `history.transitions, against ${p.p85.from} cycle times` });
  }

  const deployed = p.deployments.filter((d) => d.items.includes(item.id));
  if (deployed.length) out.push({ code: 'deployed-not-closed', weight: 2, text: `Running in ${deployed.map((d) => d.environment).join(' and ')}, but still ${item.status ?? 'open'}`, evidence: `toil ${deployed[0]!.command}` });

  const entry = p.health?.entries.get(item.id);
  if (entry?.kind === 'carried') out.push({ code: 'carried', weight: 2, text: `Carried over from ${entry.from}`, evidence: entry.evidence });

  const prs = p.changes.filter((c) => c.kind === 'pull-request' && c.items.includes(item.id));
  for (const pr of prs.filter((c) => c.outcome === 'open')) {
    if (!p.changes.some((c) => c.kind === 'build' && c.builds === pr.id)) out.push({ code: 'pr-no-build', weight: 2, text: `Pull request ${pr.title} is open with no build`, evidence: `toil ${pr.command}` });
  }

  if (item.updated) {
    const quiet = (Date.parse(p.now) - Date.parse(item.updated)) / DAY;
    if (quiet > STALE_DAYS) out.push({ code: 'stale', weight: 2, text: `No update for ${days(quiet)}`, evidence: 'updated' });
  }

  const merged = prs.filter((c) => c.outcome === 'merged');
  if (merged.length && !deployed.length && p.deployments.length) {
    out.push({ code: 'built-not-deployed', weight: 1, text: `${merged.length === 1 ? 'Its pull request is' : 'Its pull requests are'} merged, but no environment runs ${merged.length === 1 ? 'it' : 'them'} yet`, evidence: `toil ${merged[0]!.command}, toil ${p.deployments[0]!.command}` });
  }

  if (needsEstimate(item, p.byId)) out.push({ code: 'unestimated', weight: 1, text: 'No estimate', evidence: 'estimate' });
  if (entry?.kind === 'added') out.push({ code: 'added', weight: 1, text: `Added after the sprint started`, evidence: entry.evidence });

  return out.sort((a, b) => b.weight - a.weight);
}

/** One insight code on one item, with every insight that raised it. */
export interface InsightGroup {
  code: InsightCode;
  weight: Insight['weight'];
  insights: Insight[];
}

/**
 * The insights collapsed to one group per code, in the order they arrive: an
 * item that blocks two others raises `blocking` twice, and a card has room
 * for one chip saying so (#541). The full list stays on the item, which
 * reads `insights()` itself.
 */
export function groupInsights(list: Insight[]): InsightGroup[] {
  const groups = new Map<InsightCode, InsightGroup>();
  for (const i of list) {
    const g = groups.get(i.code);
    if (g) g.insights.push(i);
    else groups.set(i.code, { code: i.code, weight: i.weight, insights: [i] });
  }
  return [...groups.values()];
}

export interface Attention {
  id: string;
  score: number;
  insights: Insight[];
}

/** The dossier's items that need attention, most first: by total weight, then the dossier's own order. */
export function needsAttention(p: Prepared): Attention[] {
  return p.items
    .map((item) => ({ id: item.id, insights: insights(item, p) }))
    .filter((a) => a.insights.length)
    .map((a) => ({ ...a, score: a.insights.reduce((n, i) => n + i.weight, 0) }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Whether an item's insights call for attention (#394): anything that needs
 * action now or needs a look. "Worth knowing" alone (no estimate, added
 * mid-sprint, merged and not deployed) is shown on the card but doesn't flag it.
 */
export const flagsAttention = (list: Insight[]) => list.some((i) => i.weight >= 2);

/** Which of these items (the board's: the sprint's, or every item without one) need attention: the Board tab's count and its filter. */
export function needingAttention(items: WorkItem[], p: Prepared): WorkItem[] {
  return items.filter((item) => flagsAttention(insights(item, p)));
}
