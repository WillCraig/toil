// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { simulate, type Counts } from './scale-sim.ts';

/**
 * A large project, simulated (#493, test/scale-sim.ts): 3000 issues of which
 * 200 are open or touched within the week, and the rest closed 60 days to four
 * years ago. The first sync reads the window, not the project; a second one that
 * finds nothing sends only its delta queries and rewrites next to nothing.
 *
 * The sync used to read four years of closed tickets on request, in the
 * spirit of an archive retrieval, and with the turnaround to match.
 */

const TOTAL = 3000;
const LIVE = 200;
/** Open live items created over a year ago (one live item in four, scale-sim.ts): the feed that starts with the window holds part of their history. */
const OLD_OPEN = 50;
const report = (label: string, c: Counts) => console.info(`[scale] ${label}: ${c.toilCalls} toil calls, ${c.requests} requests, ${c.rowsWritten} rows written, ${c.responseBytesWritten} response bytes written, ${c.items} items, ${c.seconds.toFixed(1)}s, tracker ${JSON.stringify(c.tracker)}`);

describe('a large Jira project', () => {
  it('syncs its window, then nothing, then the day after a deletion', async () => {
    const sim = await simulate('jira', TOTAL, LIVE);
    try {
      const first = await sim.sync(0);
      report('jira first sync', first);
      // The window: the 200 live issues, listed in two pages that carry their histories (--changelog), so no call per issue.
      expect(first.items).toBe(LIVE);
      expect(first.tracker['jira issue history'] ?? 0).toBe(0);
      expect(first.toilCalls).toBeLessThan(40);
      expect(first.tracker['jira issue search']).toBe(Math.ceil(LIVE / 100));

      const second = await sim.sync(3_600_000);
      report('jira second sync, nothing changed', second);
      expect(second.tracker['jira issue history'] ?? 0).toBe(0);
      expect(second.tracker['jira issue search']).toBe(1);
      expect(second.items).toBe(LIVE);
      // The toil project's row, the sources' rows, the sync runs, and the sample toil project's few pull requests: nothing proportional to the 200 issues.
      expect(second.rowsWritten).toBeLessThan(40);

      sim.touch(TOTAL);
      sim.remove(TOTAL - 1);
      const third = await sim.sync(3_600_000);
      report('jira third sync, one changed', third);
      // The changed issue's fresh history came with the delta search.
      expect(third.tracker['jira issue history'] ?? 0).toBe(0);
      expect(third.tracker['jira issue search']).toBe(1);
      expect(third.items).toBe(LIVE);
      expect(third.rowsWritten).toBeLessThan(80);

      const fourth = await sim.sync(25 * 3_600_000);
      report('jira fourth sync, a day on, reconciling', fourth);
      expect(fourth.items).toBe(LIVE - 1);
      expect(fourth.tracker['jira issue history'] ?? 0).toBe(0);
    } finally {
      sim.close();
    }
  }, 120_000);
});

describe('a large Jira project whose longest histories come back cut short', () => {
  it('reads only those issues with a call of their own', async () => {
    const sim = await simulate('jira', TOTAL, LIVE);
    try {
      for (const n of [TOTAL, TOTAL - 1, TOTAL - 2]) sim.cutShort(n);
      const first = await sim.sync(0);
      report('jira first sync, three histories cut short', first);
      expect(first.items).toBe(LIVE);
      expect(first.tracker['jira issue history']).toBe(3);
      const second = await sim.sync(3_600_000);
      report('jira second sync, nothing changed, three cut short', second);
      expect(second.tracker['jira issue history'] ?? 0).toBe(0);
    } finally {
      sim.close();
    }
  }, 120_000);
});

// Jira Cloud's search sends at most 20 entries per issue, newest first, with total counting the page
// (RFC-61, PageOfChangelogs): a history cut at 20 looks whole by total alone, so the page being full is
// what sends such an issue to `issue history`. One issue in ten here has 30 entries.
describe('a large Jira Cloud project, where one issue in ten has a history longer than the search sends', () => {
  it('reads exactly those issues with a call of their own, once', async () => {
    const sim = await simulate('jira', TOTAL, LIVE, 30, 10);
    try {
      const first = await sim.sync(0);
      report('jira cloud first sync, one issue in ten has 30 entries', first);
      expect(first.items).toBe(LIVE);
      expect(first.tracker['jira issue history']).toBe(LIVE / 10);
      const second = await sim.sync(3_600_000);
      report('jira cloud second sync, nothing changed', second);
      expect(second.tracker['jira issue history'] ?? 0).toBe(0);
      expect(second.responseBytesWritten).toBeLessThan(first.responseBytesWritten / 10);
    } finally {
      sim.close();
    }
  }, 120_000);
});

describe('a large Azure DevOps project', () => {
  it('syncs its window from one feed of revisions, reads one by one only the items the feed holds part of, then syncs nothing', async () => {
    const sim = await simulate('ado', TOTAL, LIVE);
    try {
      const first = await sim.sync(0);
      report('ado first sync', first);
      expect(first.items).toBe(LIVE);
      // Of the 200 live items, 150 are open and 50 of those were created over a year ago: the feed, which starts with the window, holds only their last two revisions.
      expect(first.tracker['ado work-item feed']).toBe(1);
      expect(first.tracker['ado work-item history']).toBe(OLD_OPEN);
      // Whichever way a history arrived, it is whole: every item starts at its first revision.
      expect(sim.wholeHistories()).toEqual({ whole: LIVE, items: LIVE });

      const second = await sim.sync(3_600_000);
      report('ado second sync, nothing changed', second);
      expect(second.tracker['ado work-item history'] ?? 0).toBe(0);
      expect(second.tracker['ado work-item get-many'] ?? 0).toBe(0);
      expect(second.rowsWritten).toBeLessThan(40);

      // A change to a recent item adds one revision to the feed; to an old open item, which the feed never held whole, it changes nothing about how that history is read.
      sim.touch(TOTAL - 1);
      sim.touch(TOTAL - 3);
      const third = await sim.sync(3_600_000);
      report('ado third sync, two changed (one recent, one old and open)', third);
      expect(third.tracker['ado work-item feed']).toBe(1);
      // 2997 = 3000 - 3 is an old open item: its cached history is the one from the first sync, which the sync reads again because the item changed.
      expect(third.tracker['ado work-item history'] ?? 0).toBe(1);
      expect(third.items).toBe(LIVE);
      expect(sim.wholeHistories()).toEqual({ whole: LIVE, items: LIVE });
    } finally {
      sim.close();
    }
  }, 120_000);
});
