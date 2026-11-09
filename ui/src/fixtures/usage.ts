/**
 * The Usage page's sample data (#309), for the site preview and `toil-ui
 * --sample`: a month of made-up audit lines, summarized by toil's own
 * arithmetic (src/audit/stats.ts), so the sample has exactly the shape and
 * the sums `toil audit stats` would give for them. The lines are generated
 * from a fixed seed, so every build shows the same month; the commands are
 * real ones, and the connections the preview's own.
 *
 * Thirty days of activity, none of it billable.
 */

import { matchesFilter, summarize, type AuditLine } from '../../../src/audit/stats.ts';
import { failuresInput, USAGE_CALLS, type UsageStats } from '../usage.ts';

/** The sample month: the 30 days before 19 October 2026, UTC. */
const SINCE = '2026-09-19T00:00:00.000Z';
const UNTIL = '2026-10-19T00:00:00.000Z';

/** What the sample calls: command, connection, how often, how it fails, and how long it takes. */
const MIX: Array<{ command: string; area: string | null; connection: string | null; weight: number; fails?: Array<[string, number]>; ms: number; writes?: boolean }> = [
  { command: 'jira issue get', area: 'jira', connection: 'corp-jira', weight: 30, fails: [['NOT_FOUND', 0.06]], ms: 180 },
  { command: 'jira issue search', area: 'jira', connection: 'corp-jira', weight: 18, fails: [['INVALID_INPUT', 0.08], ['TIMEOUT', 0.02]], ms: 420 },
  { command: 'github pr list', area: 'github', connection: 'github', weight: 14, ms: 260 },
  { command: 'github pr get', area: 'github', connection: 'github', weight: 10, fails: [['AUTH', 0.12]], ms: 230 },
  { command: 'ado work-item get', area: 'ado', connection: 'corp-ado', weight: 9, fails: [['NETWORK', 0.1], ['AUTH', 0.04]], ms: 340 },
  { command: 'jira issue comment', area: 'jira', connection: 'corp-jira', weight: 3, fails: [['WRITE_DISABLED', 0.3]], ms: 210, writes: true },
  { command: 'projects list', area: null, connection: null, weight: 6, ms: 12 },
  { command: 'connections list', area: null, connection: null, weight: 4, ms: 9 },
];

/** Which door a sample call came through, by weight. */
const DOORS: Array<{ via: 'cli' | 'mcp' | 'api'; caller?: string; weight: number }> = [
  { via: 'api', caller: 'toil-ui', weight: 5 },
  { via: 'mcp', weight: 4 },
  { via: 'cli', weight: 2 },
];

/** A small deterministic generator (mulberry32), so the sample never changes between builds. */
function random(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T extends { weight: number }>(list: T[], r: number): T {
  const total = list.reduce((n, x) => n + x.weight, 0);
  let at = r * total;
  for (const x of list) if ((at -= x.weight) < 0) return x;
  return list[list.length - 1]!;
}

/** A line as `toil audit list` returns it. */
type ListedLine = AuditLine & { allowWrite: boolean; input: unknown; requests: unknown[] };

export function sampleEntries(): ListedLine[] {
  const rnd = random(309);
  const out: ListedLine[] = [];
  const start = Date.parse(SINCE);
  for (let d = 0; d < 30; d++) {
    const weekend = new Date(start + d * 86_400_000).getUTCDay() % 6 === 0;
    const calls = Math.round((weekend ? 3 : 14) + rnd() * (weekend ? 4 : 22));
    for (let i = 0; i < calls; i++) {
      const c = pick(MIX, rnd());
      const door = pick(DOORS, rnd());
      let outcome = 'ok';
      const roll = rnd();
      let acc = 0;
      for (const [code, p] of c.fails ?? []) if (outcome === 'ok' && roll < (acc += p)) outcome = code;
      const time = new Date(start + d * 86_400_000 + Math.floor(rnd() * 86_400_000)).toISOString();
      out.push({
        time,
        via: door.via,
        ...(door.caller ? { caller: door.caller } : {}),
        command: c.command,
        area: c.area,
        connection: c.connection,
        writes: c.writes === true,
        allowWrite: c.writes === true && outcome === 'ok',
        outcome,
        durationMs: Math.round(c.ms * (0.5 + rnd() * 1.5) * (rnd() < 0.05 ? 6 : 1)),
        input: null,
        requests: [],
      });
    }
  }
  return out.sort((a, b) => (a.time < b.time ? -1 : 1));
}

const stats = (entries: ListedLine[], by: UsageStats['by']): UsageStats => ({
  window: { since: SINCE, until: UNTIL },
  by,
  ...summarize(entries, by as Parameters<typeof summarize>[1]),
});

/** The calls the Usage page makes, answered from the sample month. */
export function usageCanned(): Array<{ command: string; input: Record<string, unknown>; data: unknown }> {
  const entries = sampleEntries();
  const byCommand = stats(entries, ['command', 'caller']);
  return [
    { command: 'audit stats', input: { ...USAGE_CALLS.days, by: [...USAGE_CALLS.days.by] }, data: stats(entries, ['day', 'caller']) },
    { command: 'audit stats', input: { ...USAGE_CALLS.commands, by: [...USAGE_CALLS.commands.by] }, data: byCommand },
    { command: 'audit stats', input: { ...USAGE_CALLS.doors, by: [...USAGE_CALLS.doors.by] }, data: stats(entries, ['via', 'caller']) },
    ...[...new Set(byCommand.groups.filter((g) => g.failed > 0).map((g) => g.command ?? ''))]
      .map((command) => {
        const input = failuresInput(command);
        return { command: 'audit list', input, data: entries.filter((e) => matchesFilter(e, input)).reverse().slice(0, input.limit) };
      }),
  ];
}
