/**
 * CI splits the layout check across parallel jobs (`npm run smoke -w ui -- --include-tests layout:k/N`, #640). A shard that drops a
 * unit would pass a view nobody looked at, so this holds the split to the one rule that matters: every theme scheme on
 * every view is checked by exactly one shard, for any number of shards, and no shard at all means the whole check.
 * Splitting an inspection eight ways is efficient right up until a floor turns up that no inspector was assigned.
 */
import { describe, expect, it } from 'vitest';
import { MOTION_ROUTES, ROUTES, parseIncludeTests, shardRuns, themeRuns } from '../scripts/layout-check.mjs';

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
    expect(parseIncludeTests([])).toEqual({ layout: true, shard: null });
    expect(parseIncludeTests(['--include-tests', 'layout'])).toEqual({ layout: true, shard: null });
  });

  it('reads layout:k/N and none, and refuses anything else', () => {
    expect(parseIncludeTests(['--include-tests', 'layout:3/8'])).toEqual({ layout: true, shard: { index: 3, count: 8 } });
    expect(parseIncludeTests(['--include-tests', 'none'])).toEqual({ layout: false, shard: null });
    for (const bad of ['', 'layout:0/8', 'layout:9/8', 'layout:3', 'layout:a/b', 'layout:3/0', '3/8', 'all', 'Layout']) {
      expect(() => parseIncludeTests(['--include-tests', bad]), bad).toThrow(/--include-tests layout, layout:k\/N/);
    }
    for (const bad of [['--include-tests'], ['--shard', '3/8'], ['--no-layout'], ['--include-tests', 'none', '--include-tests', 'layout'], ['none']]) {
      expect(() => parseIncludeTests(bad), bad.join(' ')).toThrow(/--include-tests layout, layout:k\/N/);
    }
  });
});
