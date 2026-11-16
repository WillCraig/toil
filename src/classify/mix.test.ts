/* eslint-disable @typescript-eslint/no-explicit-any -- the tests read envelopes' untyped JSON */
import { afterEach, describe, expect, it } from 'vitest';
import { AS_OF, cleanup, cli, codes, data, disk, done, item, mcp, records } from '../projects/pivot-testkit.js';

afterEach(cleanup);

const mixArgs = ['classify', 'mix', '--input-file', 'work.json', '--as-of', AS_OF];
const share = (line: any, category: string) => line.shares.find((s: any) => s.category === category);

describe('classify mix', () => {
  it('shows each category share of the finished work per month, with unsure as its own line', async () => {
    const out = data(await cli(disk(), mixArgs));
    expect(out).toMatchObject({ unit: 'count', by: 'month', group: null, scheme: { name: 'ktlo-feature', revision: 1 }, toilProject: null });
    expect(out.periods.map((p: any) => [p.label, p.total])).toEqual([['Aug 2026', 0], ['Sep 2026', 0], ['Oct 2026', 4], ['Nov 2026', 2]]);
    const oct = out.periods.find((p: any) => p.label === 'Oct 2026');
    expect(oct.shares.map((s: any) => s.category)).toEqual(['ktlo', 'feature', 'unsure']);
    expect(share(oct, 'ktlo')).toMatchObject({ name: 'Keep the lights on', short: 'KTLO', value: 1, share: 0.25, items: 1 });
    expect(share(oct, 'feature')).toMatchObject({ value: 2, share: 0.5 });
    expect(share(oct, 'unsure')).toMatchObject({ name: 'Unsure', short: null, value: 1, share: 0.25 });
    expect(out.overall.map((s: any) => [s.category, s.value, s.share])).toEqual([['ktlo', 2, 0.3333], ['feature', 3, 0.5], ['unsure', 1, 0.1667]]);
  });

  it('counts how every item was decided, adding up to the items read', async () => {
    const out = data(await cli(disk(), mixArgs));
    const total = Object.values(out.sources as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(total).toBe(8);
    expect(out.sources).toMatchObject({ labels: 4, signals: 2, unsure: 2, parent: 0, agent: 0, person: 0 });
  });

  it('says an empty period is empty, and never calls its shares 0', async () => {
    const e = await cli(disk(), mixArgs);
    const sep = data(e).periods[0];  // August
    expect(sep.shares.every((s: any) => s.share === null && s.value === 0)).toBe(true);
    expect(codes(e)).toContain('MIX_EMPTY');
    expect(codes(e)).not.toContain('MIX_UNREAD');
  });

  it('groups by team instead of by period, and by epic through the parent', async () => {
    const out = data(await cli(disk(), [...mixArgs, '--toil-project', 'payments', '--group', 'team', '--unit', 'count']));
    expect(out.group).toBe('team');
    expect(out.by).toBeNull();
    expect(out.groups.map((g: any) => g.label)).toEqual(['Checkout', 'Ledger', 'No team']);
    expect(out.groups[0].total).toBe(2);
    expect(out.periods).toBeUndefined();
    const epic = data(await cli(disk(), [...mixArgs, '--group', 'epic']));
    expect(epic.groups.map((g: any) => g.label)).toEqual(['No Epic']);
  });

  it('sums estimates, and a share it cannot compute is null with MIX_UNREAD, never 0', async () => {
    const files = { 'work.json': records(done('PAY-1', '2026-10-06T10:00:00Z', { type: 'BUG', estimate: { value: 3, unit: 'points', field: 'sp' } }), done('PAY-2', '2026-11-04T10:00:00Z', { labels: ['feature'] })) };
    const e = await cli(disk(), [...mixArgs, '--unit', 'estimate', '--by', 'month'], files);
    const out = data(e);
    expect(out.unit).toBe('estimate');
    expect(out.measure).toMatchObject({ id: 'estimate', unit: 'points' });
    const nov = out.periods.find((p: any) => p.label === 'Nov 2026');
    expect(nov.total).toBeNull();
    expect(share(nov, 'feature')).toMatchObject({ value: null, share: null });
    expect(nov.shares.every((s: any) => s.share === null)).toBe(true);
    expect(codes(e)).toContain('MIX_UNREAD');
  });

  it('reads by week or quarter and the period flags, and refuses a bad one with the fix', async () => {
    const week = data(await cli(disk(), [...mixArgs, '--by', 'week', '--from', '2026-10-05', '--to', '2026-10-18']));
    expect(week.periods.map((p: any) => p.label)).toEqual(['2026-W41', '2026-W42']);
    expect(data(await cli(disk(), [...mixArgs, '--by', 'quarter'])).by).toBe('quarter');
    const e = (await cli(disk(), [...mixArgs, '--from', 'soon'])).error!;
    expect(e).toMatchObject({ code: 'INVALID_INPUT' });
    expect(e.fix).toContain('YYYY-MM-DD');
    expect((await cli(disk(), [...mixArgs, '--group', 'colour'])).error).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('is served over MCP with the same figures', async () => {
    const d = disk();
    const out = data(await cli(d, mixArgs));
    const s = await mcp(d);
    const viaMcp = data((await s.call('classify_mix', { inputFile: 'work.json', asOf: AS_OF })).envelope);
    expect(viaMcp.overall).toEqual(out.overall);
    expect(viaMcp.periods).toEqual(out.periods);
  });

  it('keeps the item count when no item has finished at all', async () => {
    const out = data(await cli(disk(), mixArgs, { 'work.json': records(item('PAY-1')) }));
    expect(out.overall.every((s: any) => s.share === null)).toBe(true);
  });
});

describe('a ledger toil cannot read', () => {
  it('does not stop a mix or a pivot: they carry on without the corrections, and say so', async () => {
    const d = disk();
    d.write('home/.toil/classify/ktlo-feature.jsonl', 'x'.repeat(33 * 1024 * 1024));
    const mix = await cli(d, mixArgs);
    expect(data(mix).overall).toHaveLength(3);
    expect(codes(mix)).toContain('LEDGER_UNREADABLE');
    const pivot = await cli(d, ['projects', 'pivot', 'payments', '--input-file', 'work.json', '--as-of', AS_OF, '--split', 'category']);
    expect(data(pivot).total).toBeDefined();
    expect(codes(pivot)).toContain('LEDGER_UNREADABLE');
  });
});
