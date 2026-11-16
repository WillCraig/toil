/**
 * The sample's classification ledger and the agent that answers for it
 * (#566): what `classify stats --standing`, `classify prompt` and `classify
 * tune` would say about the sample team, so the Classify view, its Apply card,
 * "How it's doing" and the tune flow can all be looked at with no tracker and no
 * ledger on disk. Nothing is typed twice: the ledger's lines are made from the
 * sample's own items and the pure engine; the statistics are the ledger's, held
 * equal to toil's own `ledgerStats` by a Node test (the page cannot load that
 * file, which reads the disk), and the agent's answers are worked out from the
 * unsure items it is handed. Every write is refused in plain words: the sample
 * has nothing of yours to change. A rehearsal, with the minutes already taken.
 */

import type { LedgerLine } from '../../../src/core/classify/ledger-types.ts';
import { defaultScheme } from '../../../src/core/classify/builtin.ts';
import { classify } from '../../../src/core/classify/engine.ts';
import type { AgentVerdict, ClassifyArea, ResolvedTarget, Scheme } from '../../../src/core/classify/types.ts';
import { UNSURE } from '../../../src/core/classify/types.ts';
import { SAMPLE_SCHEME_STATS } from './classify-stats.ts';
import { SAMPLE_AS_OF, SAMPLE_TEAM } from './sample-team.ts';
import { SAMPLE_MOVE } from '../board-api.ts';
import { SAMPLE_CANNOT_WRITE, type AgentAnswers, type AgentChoice, type ApplyPlan, type ApplyWork, type ClassifyApi, type LedgerView, type PlanGroupView, type SaveResult, type TuneResult } from '../classify-api.ts';
import { personOf, type Say } from '../model/classify.ts';
import { schemeChangeLines } from '../model/scheme-edit.ts';
import type { WorkItem } from '../toil.ts';

/** The sample team's own words for the reasons people gave. */
const REASONS = ['Fixes a bug, but it adds a new export format, so it is new work.', 'A security patch that also unlocks a new payment method.', 'It is a build upgrade, and customers see nothing new.', 'The epic is new functionality, so its tasks are too.'];

/**
 * The ledger's lines for the sample: a verdict for every item, as `classify run --record` would keep them, then ten
 * corrections people made (four of them to what the bug-type signal said, which is the figure "How it's doing" opens
 * with) and twelve confirmations. Every one is on the scheme's first revision, so all ten count as since the last tune.
 */
export function sampleLedgerLines(items: readonly WorkItem[] = SAMPLE_TEAM.owi.items, scheme: Scheme = defaultScheme()): LedgerLine[] {
  const run = classify({ scheme, items: [...items] }).result;
  const at = (n: number) => new Date(Date.parse(SAMPLE_AS_OF) - (20 - n) * 3_600_000).toISOString();
  const stamp = { toilProject: 'sample-team', scheme: scheme.name, revision: scheme.revision };
  const lines: LedgerLine[] = run.verdicts.map((v, i) => ({ kind: 'verdict', at: at(0 + (i % 2)), item: v.id, title: v.title, category: v.category, source: v.source, ...stamp }));
  // Only items nothing sits under are corrected, so a correction is one item's and not a whole epic's.
  const parents = new Set(items.map((i) => i.parent));
  const by = (source: (s: string) => boolean) => run.verdicts.filter((v) => v.category !== null && !parents.has(v.id) && source(v.source));
  const flip = (c: string | null) => (c === 'ktlo' ? 'feature' : 'ktlo');
  const corrected = [...by((s) => s === 'signal:type').slice(0, 4), ...by((s) => s === 'signal:bot-author').slice(0, 1), ...by((s) => s === 'parent').slice(0, 2), ...by((s) => s === 'signal:title').slice(0, 1), ...by((s) => s === 'label').slice(0, 2)];
  corrected.forEach((v, n) => {
    lines.push({ kind: 'correction', at: at(2 + n), item: v.id, title: v.title, from: v.category, fromSource: v.source, to: flip(v.category), confirmed: false, via: 'cli', by: null, reason: REASONS[n % REASONS.length]!, ...stamp });
  });
  const kept = new Set(corrected.map((v) => v.id));
  by((s) => s === 'signal:type' || s === 'parent' || s === 'label' || s === 'signal:security-id')
    .filter((v) => !kept.has(v.id))
    .slice(0, 12)
    .forEach((v, n) => lines.push({ kind: 'correction', at: at(14 + (n % 5)), item: v.id, title: v.title, from: v.category, fromSource: v.source, to: v.category!, confirmed: true, via: 'cli', by: null, reason: null, ...stamp }));
  return lines;
}

/** Each item's last say, as `classify stats --standing` returns it. */
export function standingOf(lines: readonly LedgerLine[]): Record<string, Say> {
  const out: Record<string, Say> = {};
  for (const l of lines) if (l.kind === 'correction') out[l.item] = { category: l.to === UNSURE ? null : l.to, reason: l.reason };
  return out;
}

const wait = (ms = 12) => new Promise((r) => setTimeout(r, ms));

/** The scripted agent's answer for one unsure item, from its title: not a model, and named as not one. */
export function scriptedVerdict(id: string, title: string): AgentVerdict {
  if (/upgrade|patch|bump|outage|security|incident|certificate|rotate/i.test(title)) return { id, category: 'ktlo', reason: `"${title}" keeps something running or safe rather than adding anything.` };
  if (/print|label|warehouse/i.test(title)) return { id, category: UNSURE, reason: 'It could be tooling for the warehouse or something customers use; nothing in the title says which.' };
  return { id, category: 'feature', reason: `"${title}" adds something customers can use.` };
}

/** The items a classify prompt holds, from the "id:" and "title:" lines of its fenced block. */
export function itemsInPrompt(prompt: string): Array<{ id: string; title: string }> {
  const out: Array<{ id: string; title: string }> = [];
  let id: string | null = null;
  for (const line of prompt.split('\n')) {
    if (line.startsWith('id: ')) id = line.slice(4).trim();
    else if (line.startsWith('title: ') && id) {
      out.push({ id, title: line.slice(7).trim() });
      id = null;
    }
  }
  return out;
}

/** The sample's revision of the scheme: one guidance line, one example and a rule, the way an agent would answer the corrections. */
export function sampleRevision(before: Scheme): Scheme {
  return {
    ...before,
    guidance: [...before.guidance, 'A bug fix that adds a new capability for customers is Feature; one that restores what already worked is KTLO.'],
    examples: [...before.examples, { item: 'sample-jira:SHOP-40', title: 'Fix the export, and add CSV', category: 'feature', why: 'It adds a format.' }],
    rules: [...before.rules, { id: 'new-exports', when: { title: ['export'] }, then: 'feature' }],
  };
}

const TARGETS: Partial<Record<ClassifyArea, ResolvedTarget>> = {};

/** The sample's ClassifyApi: scripted, in memory, and honest that it writes nothing. */
export function fixtureClassify(): ClassifyApi {
  const scheme = defaultScheme();
  const lines = sampleLedgerLines();
  const view = (): LedgerView => ({ scheme, kept: 'built-in', stats: SAMPLE_SCHEME_STATS, standing: standingOf(lines), notes: [] });
  const plan = (work: ApplyWork): ApplyPlan => {
    const run = classify({ scheme, items: work.items, targets: TARGETS, recheck: true, person: personOf(standingOf(lines)) }).result;
    const byId = new Map(work.items.map((i) => [i.id, i]));
    const groups: PlanGroupView[] = run.plan.map((g) => ({
      area: g.area,
      connection: g.connection,
      writes: false,
      command: { name: g.area === 'ado' ? 'ado work-item categorize' : `${g.area} issue categorize`, input: { connection: g.connection, inputFile: 'plan.json' } },
      changes: g.items.map((p) => {
        const item = byId.get(p.id)!;
        const own = new Set(Object.values(g.labels).map((l) => l.toLowerCase()));
        return { id: p.id, key: p.key, title: item.title, category: p.category, labelsFrom: item.labels.filter((l) => own.has(l.toLowerCase())), labelsAdd: p.labels.add, labelsRemove: p.labels.remove, field: null };
      }),
    }));
    return { id: 'sample-plan', groups, notes: [] };
  };
  const agents = async (): Promise<AgentChoice[]> => [{ name: 'scripted', label: 'The sample agent (a script, not a model)', ready: true, problem: null }];
  return {
    disabled: SAMPLE_CANNOT_WRITE,
    // A move in the sample is a proposal, and the Board never even asks: nothing here is written.
    movesDisabled: SAMPLE_CANNOT_WRITE,
    moveItem: async () => SAMPLE_MOVE,
    ledger: async () => (await wait(), view()),
    // The sample keeps a person's word in memory only, so reclassifying can be tried; it writes no ledger.
    correct: async (_p, { item, to, reason }) => {
      await wait();
      lines.push({ kind: 'correction', at: new Date(Date.parse(SAMPLE_AS_OF) + lines.length * 1000).toISOString(), item: item.id, title: item.title, from: null, fromSource: null, to: to ?? UNSURE, confirmed: false, via: 'cli', by: null, reason: reason || null, toilProject: 'sample-team', scheme: scheme.name, revision: scheme.revision });
    },
    agents,
    ask: async (_p, items): Promise<AgentAnswers> => {
      await wait(400);
      return { by: 'a scripted sample, not a model', answers: items.map((i) => scriptedVerdict(i.id, i.title)), omitted: 0, warnings: [] };
    },
    plan: async (_p, work) => (await wait(), plan(work)),
    apply: async () => {
      throw new Error(SAMPLE_CANNOT_WRITE);
    },
    tune: async (): Promise<TuneResult> => {
      await wait(600);
      const after = sampleRevision(scheme);
      return {
        id: 'sample-revision',
        by: 'a scripted sample, not a model',
        before: scheme,
        after: { ...after, revision: scheme.revision },
        changes: schemeChangeLines(scheme, after),
        backtest: { heldBack: 4, before: { agreed: 1, agreement: 0.25 }, after: { agreed: 3, agreement: 0.75 }, worse: false },
        warnings: [],
      };
    },
    applyRevision: async () => {
      throw new Error(SAMPLE_CANNOT_WRITE);
    },
    saveScheme: async (): Promise<SaveResult> => {
      throw new Error(SAMPLE_CANNOT_WRITE);
    },
  };
}
