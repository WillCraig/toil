import { describe, expect, it } from 'vitest';
import { FIXTURE_NOW } from '../src/fixtures/execute.ts';
import {
  allFlags, daysText, flagsOf, openQueue, ownersOf, parseCodeowners, pathsOf, prMetrics, sizeOf, diffSquares, daysShort, suggestReviewers, waitOf, workingDays,
} from '../src/model/prs.ts';
import type { Change } from '../src/toil.ts';
import { loaded } from './harness.ts';

/**
 * The pull request model (src/model/prs.ts) on the sample toil projects as the
 * dashboard loads them, and on the edges it promises: working days, the order
 * of what a pull request waits on, sizes, flags with their evidence, metrics
 * with their sample sizes, and reviewers from CODEOWNERS and earlier reviews.
 */

const data = async (name: string) => {
  const { data: d } = await loaded(name);
  return { d, byId: new Map(d.items.map((i) => [i.id, i])) };
};
const ids = (rows: Array<{ change: Change }>) => rows.map((r) => r.change.id);

describe('working days', () => {
  it('count Monday to Friday UTC to the fraction, and skip the weekend', () => {
    expect(workingDays('2026-10-09T12:00:00Z', '2026-10-12T12:00:00Z')).toBe(1); // Friday noon to Monday noon
    expect(workingDays('2026-10-10T09:00:00Z', '2026-10-11T18:00:00Z')).toBe(0); // all weekend
    expect(workingDays('2026-10-12T00:00:00Z', '2026-10-12T06:00:00Z')).toBe(0.25);
    expect(workingDays('2026-10-13T00:00:00Z', '2026-10-12T00:00:00Z')).toBe(0);
    expect(daysText(1)).toBe('1 working day');
  });
});

describe('the open queue', () => {
  it('ranks by wait, longest first, with drafts last, and says what each waits on and why', async () => {
    const { d, byId } = await data('checkout-web');
    const queue = openQueue(d.pullRequests, byId, FIXTURE_NOW);
    expect(ids(queue)).toEqual(['github:imagile/payments-web#51', 'bitbucket-cloud:imagile/checkout-sdk#12', 'github:imagile/payments-web#52', 'github:imagile/payments-web#53']);
    expect(queue.map((r) => r.wait.on)).toEqual(['checks', 'review', 'review', 'draft']);
    expect(queue[0]!.wait).toMatchObject({ since: '2026-10-09T08:10:00.000Z', why: 'its checks are failing' });
    expect(queue[2]!.wait.why).toBe('no approval yet from ada-dev');
    expect(queue[2]!.items).toEqual(['github:imagile/payments-web#42', 'github:imagile/payments-web#41']);
  });

  it('puts changes asked for ahead of failing checks, and waits on merge once approved and green', async () => {
    const { d } = await data('card-payments');
    const c = d.pullRequests.find((p) => p.id.endsWith('#311'))!;
    expect(waitOf(c, FIXTURE_NOW)).toMatchObject({ on: 'changes', since: '2026-10-12T17:00:00.000Z', why: 'A. Chen asked for changes' });
    const approved: Change = { ...c, reviewers: [{ person: c.reviewers[0]!.person, state: 'APPROVED' }], checks: 'PASSING', approvedAt: '2026-10-12T18:00:00.000Z', mergeable: false };
    expect(waitOf(approved, FIXTURE_NOW)).toMatchObject({ on: 'merge', why: 'approved, but it has a merge conflict' });
    expect(waitOf({ ...approved, checks: 'PENDING' }, FIXTURE_NOW).on).toBe('checks');
  });

  it('sizes by changed lines, and says when a host counts files only', async () => {
    const { d } = await data('checkout-web');
    const by = (n: number) => d.pullRequests.find((p) => p.id.endsWith(`#${n}`))!;
    expect(sizeOf(by(50))).toMatchObject({ bucket: 'S', lines: 13, files: 1 });
    expect(sizeOf(by(52))).toMatchObject({ bucket: 'L', lines: 325, files: 3 });
    const { d: card } = await data('card-payments');
    expect(sizeOf(card.pullRequests[0]!)).toEqual({ bucket: null, lines: null, files: 6, additions: null, deletions: null });
  });
});

describe('the flags', () => {
  it('raise each of the six with what it rests on', async () => {
    const card = await data('card-payments');
    const web = await data('checkout-web');
    const all = [...allFlags(card.d.pullRequests, card.byId, FIXTURE_NOW), ...allFlags(web.d.pullRequests, web.byId, FIXTURE_NOW)].map((f) => [f.change.id, f.hit.flag]);
    expect(all).toEqual([
      ['corp-bitbucket:PAY/payments-core#305', 'slow-pickup'],
      ['corp-bitbucket:PAY/payments-core#305', 'conflict'],
      ['bitbucket-cloud:imagile/checkout-sdk#12', 'item-done'],
      ['bitbucket-cloud:imagile/checkout-sdk#9', 'merged-item-open'],
      ['github:imagile/payments-web#51', 'slow-pickup'],
      ['github:imagile/payments-web#51', 'failing-checks'],
      ['github:imagile/payments-web#51', 'no-work-item'],
    ]);
    const sdk = web.d.pullRequests.find((p) => p.id.endsWith('checkout-sdk#12'))!;
    expect(flagsOf(sdk, web.byId, FIXTURE_NOW)[0]!.text).toContain('[[github:imagile/payments-web#44]]');
  });

  it("doesn't flag a draft as slow to be picked up, nor checks failing for less than a day", async () => {
    const { d, byId } = await data('checkout-web');
    const draft = d.pullRequests.find((p) => p.id.endsWith('#53'))!;
    expect(flagsOf(draft, byId, FIXTURE_NOW).map((f) => f.flag)).toEqual([]);
  });
});

describe('the flow metrics', () => {
  it('split every figure by author kind, each with its sample size and its unknowns', async () => {
    const { d } = await data('checkout-web');
    const m = prMetrics(d.pullRequests, FIXTURE_NOW);
    expect(m.counts).toEqual({ ALL: 8, HUMAN: 5, AGENT: 2, BOT: 1 });
    expect([m.pickup.ALL.n, m.pickup.HUMAN.n, m.pickup.AGENT.n, m.pickup.BOT.n]).toEqual([4, 3, 0, 1]);
    expect(m.pickup.AGENT.median).toBeNull();
    // Bitbucket Cloud keeps no merge time: its merged change is unknown to merge time, and in no week.
    expect([m.merge.ALL.n, m.merge.ALL.unknown, m.unplacedMerges]).toEqual([3, 1, 1]);
    expect(m.rounds.HUMAN).toMatchObject({ n: 3, median: 1, p85: 2 });
    expect(m.throughput.ALL.map((w) => w.items.length)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(m.sizes.ALL).toEqual({ XS: 0, S: 4, M: 3, L: 1, XL: 0, unknown: 0 });
  });

  it('leaves a merge nobody approved out of review and merge time, counted apart, with no rounds', async () => {
    const { d } = await data('checkout-web');
    const merged = d.pullRequests.find((p) => p.id.endsWith('#50'))!;
    const unreviewed: Change = { ...merged, id: 'github:imagile/payments-web#99', reviews: [], reviewers: [], firstReviewAt: null, approvedAt: null };
    const m = prMetrics([merged, unreviewed], FIXTURE_NOW);
    expect([m.review.ALL.n, m.review.ALL.unknown, m.merge.ALL.n, m.mergedUnreviewed.ALL]).toEqual([1, 0, 1, 1]);
    expect(m.rounds.ALL).toMatchObject({ n: 2, median: 0 });
  });
});

describe('suggested reviewers', () => {
  const rules = parseCodeowners('# Who reviews what\n* @ada-dev\nsrc/checkout/ @bo-web\n/docs/*.md @imagile/writers\n*.lock @release-bot\nno-owners-here\n');

  it('read CODEOWNERS by gitignore rules, the last match winning', () => {
    expect(rules.map((r) => r.pattern)).toEqual(['*', 'src/checkout/', '/docs/*.md', '*.lock']);
    expect(ownersOf('src/checkout/card-form.tsx', rules)).toEqual(['bo-web']);
    expect(ownersOf('src/address/lookup.ts', rules)).toEqual(['ada-dev']);
    expect(ownersOf('docs/guide.md', rules)).toEqual(['imagile/writers']);
    expect(ownersOf('docs/deep/guide.md', rules)).toEqual(['ada-dev']);
    expect(ownersOf('web/yarn.lock', rules)).toEqual(['release-bot']);
  });

  it('suggest CODEOWNERS first, then earlier reviewers of the same paths, never the author', async () => {
    const { d } = await data('checkout-web');
    const agentPr = d.pullRequests.find((p) => p.id.endsWith('#51'))!;
    expect(pathsOf(agentPr)).toEqual(['src/address/lookup.ts', 'src/address/lookup.test.ts']);
    const owners = parseCodeowners(d.codeowners['imagile/payments-web']!.text);
    // ada-dev wrote it, so only bo-web is suggested, from CODEOWNERS.
    expect(suggestReviewers(agentPr, d.pullRequests, owners).map((s) => [s.id, s.why])).toEqual([['bo-web', ['owns src/address/lookup.ts in CODEOWNERS', 'owns src/address/lookup.test.ts in CODEOWNERS']]]);
    // Without CODEOWNERS, a change to the card form is suggested to whoever reviewed earlier card-form changes.
    const form = d.pullRequests.find((p) => p.id.endsWith('#53'))!;
    expect(suggestReviewers({ ...form, author: { id: 'ada-dev', name: null, email: null } }, d.pullRequests, null).map((s) => s.id)).toEqual(['bo-web']);
  });
});

describe('the size bar and compact figures (#561)', () => {
  it('draws five squares by the share of additions and deletions, never more, never a present side lost', () => {
    expect(diffSquares(100, 0)).toEqual({ add: 5, del: 0, none: 0 });
    expect(diffSquares(0, 100)).toEqual({ add: 0, del: 5, none: 0 });
    expect(diffSquares(50, 50)).toEqual({ add: 3, del: 2, none: 0 });
    expect(diffSquares(1000, 1)).toEqual({ add: 4, del: 1, none: 0 });
    expect(diffSquares(0, 0)).toEqual({ add: 0, del: 0, none: 5 });
  });
  it('says a wait as a short figure', () => {
    expect(daysShort(32.64)).toBe('32.6 d');
    expect(daysShort(2)).toBe('2 d');
  });
});
