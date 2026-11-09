import { describe, expect, it } from 'vitest';
import type { UsageGroup } from '../../src/audit/stats.ts';
import { sampleEntries, usageCanned } from '../src/fixtures/usage.ts';
import { doorLabel, failingMost, fillDays, ownGroups, ownTotals } from '../src/usage.ts';

const group = (over: Partial<UsageGroup>): UsageGroup => ({ calls: 1, ok: 1, failed: 0, errors: [], durationMs: { median: 1, p95: 1 }, writes: 0, writeShare: 0, firstSeen: '', lastSeen: '', ...over });

describe('the Usage page model', () => {
  it('fills the days nobody called toil with zero, from the first day to the last', () => {
    expect(fillDays([group({ day: '2026-10-02', calls: 4, failed: 1 })], '2026-10-01T00:00:00.000Z', '2026-10-03')).toEqual([
      { day: '2026-10-01', calls: 0, failed: 0 },
      { day: '2026-10-02', calls: 4, failed: 1 },
      { day: '2026-10-03', calls: 0, failed: 0 },
    ]);
  });

  it('names each front door in plain words, Toil UI by its caller label', () => {
    expect([doorLabel('api', 'toil-ui'), doorLabel('api', 'nightly'), doorLabel('api', null), doorLabel('mcp', null), doorLabel('cli', null)]).toEqual(['Toil UI itself (not counted above)', 'Another program, nightly', 'Another program', 'An AI assistant', 'A terminal']);
  });

  it("leaves Toil UI's own calls out and adds the rest of a command up across callers", () => {
    const groups = [
      group({ command: 'a', caller: 'toil-ui', calls: 10, failed: 10, ok: 0 }),
      group({ command: 'a', caller: null, calls: 3, ok: 2, failed: 1, errors: [{ code: 'AUTH', count: 1, fix: 'x' }] }),
      group({ command: 'a', caller: 'nightly', calls: 2, ok: 1, failed: 1, errors: [{ code: 'AUTH', count: 1, fix: 'x' }] }),
    ];
    const [a] = ownGroups(groups, 'command');
    expect([a!.calls, a!.failed, a!.errors]).toEqual([5, 2, [{ code: 'AUTH', count: 2, fix: 'x' }]]);
    expect(ownTotals([group({ via: 'api', caller: 'toil-ui', calls: 9, failed: 9 }), group({ via: 'cli', calls: 4, failed: 1, writes: 2 })])).toEqual({ calls: 4, failed: 1, writes: 2 });
  });

  it('puts the most failures first and leaves out commands that never failed', () => {
    const rows = failingMost([group({ command: 'a', calls: 9, failed: 1 }), group({ command: 'b' }), group({ command: 'c', calls: 3, failed: 3 })]);
    expect(rows.map((g) => g.command)).toEqual(['c', 'a']);
  });

  it("answers the sample with toil's own sums, the same month on every build", () => {
    expect(sampleEntries()).toEqual(sampleEntries());
    const [days, commands] = usageCanned() as Array<{ data: { totals: { calls: number }; groups: Array<{ calls: number }> } }>;
    const total = sampleEntries().length;
    expect(days!.data.totals.calls).toBe(total);
    expect(days!.data.groups.reduce((n, g) => n + g.calls, 0)).toBe(total);
    expect(commands!.data.groups.reduce((n, g) => n + g.calls, 0)).toBe(total);
  });
});
