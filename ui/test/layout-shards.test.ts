/**
 * CI splits the layout check across parallel jobs (`npm run smoke -w ui -- --shard k/N`, #640). A shard that drops a
 * unit would pass a view nobody looked at, so this holds the split to the one rule that matters: every theme scheme on
 * every view is checked by exactly one shard, for any number of shards, and no shard at all means the whole check.
 * Splitting an inspection eight ways is efficient right up until a floor turns up that no inspector was assigned.
 */
import { describe, expect, it } from 'vitest';
import { MOTION_ROUTES, ROUTES, parseShard, shardRuns, themeRuns } from '../scripts/layout-check.mjs';

type Run = { theme: string; scheme: string; routes?: string[] };
const units = (runs: Run[], routes: string[]) => runs.flatMap((r) => (r.routes ?? routes).map((route) => `${r.theme}-${r.scheme} ${route}`));

describe('the layout check split into shards', () => {
  for (const routes of [ROUTES, MOTION_ROUTES]) {
    const all = units(themeRuns(), routes).sort();
    it(`checks every unit exactly once across the shards, for ${routes === ROUTES ? 'every view' : 'the motion views'}`, () => {
      for (const count of [1, 2, 3, 4, 8, 16, all.length + 3]) {
        const claimed = Array.from({ length: count }, (_, i) => units(shardRuns(themeRuns(), routes, { index: i + 1, count }), routes)).flat();
        expect(claimed.sort(), `${count} shards`).toEqual(all);
      }
    });
  }

  it('keeps the eight CI shards within one unit of each other', () => {
    const sizes = Array.from({ length: 8 }, (_, i) => units(shardRuns(themeRuns(), ROUTES, { index: i + 1, count: 8 }), ROUTES).length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it('runs the whole check with no shard', () => {
    expect(shardRuns(themeRuns(), ROUTES, null)).toEqual(themeRuns());
    expect(parseShard(undefined)).toBeNull();
  });

  it('reads k/N and refuses anything else', () => {
    expect(parseShard('3/8')).toEqual({ index: 3, count: 8 });
    for (const bad of ['', '0/8', '9/8', '3', 'a/b', '3/0', '-1/8']) expect(() => parseShard(bad), bad).toThrow(/--shard takes k\/N/);
  });
});
