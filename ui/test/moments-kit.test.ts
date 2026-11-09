// The arithmetic behind `npm run moments:measure` and `npm run screens:sheet` (#464): which themes
// they cover, how frames are counted, and the table #451 wrote by hand. The browser runs themselves
// are by hand only (ui/README.md, Measuring theme moments).
import { describe, expect, it } from 'vitest';
import { busyShare, cell, chromeFrames, frameStats, intervals, momentThemes, pool, problems, slowFrames, table, themed, themesOnDisk, type Result } from '../scripts/moments-kit.mjs';

const phase = (median: number, worst: number, over: number, frames: number, dropped = 0, reported = frames) => ({ median, worst, over, frames, chrome: { dropped, reported, notComposited: 0 } });
const row = (theme: string, pass: 'cold' | 'warm', run: number, worst = 19.4, over = 0): Result => ({
  run,
  pass,
  theme,
  splash: phase(18.1, worst, over, 110),
  loader: phase(18.2, 19.3, 0, 167, 1, 168),
  recap: phase(18.1, 19.5, 0, 313),
});

describe('momentThemes', () => {
  it('keeps only the themes with moments, in #451 order, with the events each declares', () => {
    const themes = momentThemes([
      { name: 'realm', moments: { splash: {}, events: { 'sprint-ended': {}, 'item-done': {} } } },
      { name: 'plain' },
      { name: 'zeta', moments: { events: {} } },
      { name: 'crate', moments: { splash: {}, events: { 'build-failed': {} } } },
    ]);
    expect(themes).toEqual([
      { name: 'crate', splash: true, events: ['build-failed'] },
      { name: 'realm', splash: true, events: ['item-done', 'sprint-ended'] },
      { name: 'zeta', splash: false, events: [] },
    ]);
  });

  it('reads every shipped theme but Plain, and refuses a name with no moments, listing the ones there are', () => {
    expect(themesOnDisk().map((t) => t.name)).toEqual(['crate', 'harvest', 'starship', 'sprawl', 'frontier', 'overworld', 'realm']);
    expect(themesOnDisk(['realm']).map((t) => t.name)).toEqual(['realm']);
    expect(() => themesOnDisk(['plain'])).toThrow(/No theme with moments is named plain\. Themes with moments: crate, harvest/);
  });
});

describe('frames', () => {
  it('measures rAF intervals inside a window, and finds the slow ones', () => {
    const frames = [0, 16.7, 33.4, 70, 86.7, 103.4];
    expect(intervals(frames, 16.7, 86.7).map((x) => Math.round(x * 10) / 10)).toEqual([16.7, 36.6, 16.7]);
    expect(frameStats([16.7, 36.6, 16.7, 18])).toEqual({ frames: 4, median: 18, worst: 36.6, over: 1 });
    expect(frameStats([])).toEqual({ frames: 0, median: 0, worst: 0, over: 0 });
    expect(slowFrames(frames, 0, 200)).toEqual([{ at: 33, ms: 36.6 }]);
  });

  it("counts the renderer's dropped frames and uncomposited animations between two marks", () => {
    const events = [
      { ph: 'M', name: 'thread_name', pid: 1, args: { name: 'CrRendererMain' } },
      { ph: 'M', name: 'thread_name', pid: 2, args: { name: 'CrBrowserMain' } },
      { name: 'TimeStamp', ts: 100, args: { data: { message: 'a' } } },
      { name: 'PipelineReporter', ph: 'b', pid: 1, ts: 150, args: { frame_reporter: { state: 'STATE_PRESENTED_ALL' } } },
      { name: 'PipelineReporter', ph: 'b', pid: 1, ts: 160, args: { chrome_frame_reporter: { state: 'STATE_DROPPED' } } },
      { name: 'PipelineReporter', ph: 'b', pid: 2, ts: 170, args: { frame_reporter: { state: 'STATE_DROPPED' } } },
      { name: 'PipelineReporter', ph: 'b', pid: 1, ts: 400, args: { frame_reporter: { state: 'STATE_DROPPED' } } },
      { name: 'Animation', ts: 180, id2: { local: 'x' }, args: { data: { compositeFailed: 64 } } },
      { name: 'Animation', ts: 190, id2: { local: 'x' }, args: { data: { compositeFailed: 64 } } },
      { name: 'TimeStamp', ts: 300, args: { data: { message: 'b' } } },
    ];
    expect(chromeFrames(events, 'a', 'b')).toEqual({ reported: 2, dropped: 1, notComposited: 1 });
    expect(chromeFrames(events, 'a', 'missing')).toBeNull();
  });

  it('reads how busy the CPU was between two snapshots', () => {
    const t = (busy: number, idle: number) => ({ user: busy, nice: 0, sys: 0, irq: 0, idle });
    expect(busyShare([t(0, 0), t(0, 0)], [t(25, 75), t(75, 25)])).toBe(0.5);
    expect(busyShare([], [])).toBe(0);
  });
});

describe('the table', () => {
  const results = [row('crate', 'cold', 1, 235.1, 2), row('crate', 'warm', 1), row('crate', 'warm', 2, 19.6), row('realm', 'warm', 1)];

  it("pools a theme's warm passes as #451 did: median of medians, the worst of any, counts summed", () => {
    const p = pool(results.filter((r) => r.theme === 'crate' && r.pass === 'warm'));
    expect(p.splash).toEqual({ median: 18.1, worst: 19.6, over: 0, frames: 220, dropped: 0, reported: 220, notComposited: 0, failed: 0 });
    expect(cell(p.loader)).toBe('18.2 / 19.3 / 0 of 334 / 2 of 336');
  });

  it("writes #451's columns, with the cold pass's worst frames only when asked", () => {
    expect(table(results)).toBe(
      [
        '| Theme | Splash | Loader | Recap |',
        '|---|---|---|---|',
        '| Crate | 18.1 / 19.6 / 0 of 220 / 0 of 220 | 18.2 / 19.3 / 0 of 334 / 2 of 336 | 18.1 / 19.5 / 0 of 626 / 0 of 626 |',
        '| Realm | 18.1 / 19.4 / 0 of 110 / 0 of 110 | 18.2 / 19.3 / 0 of 167 / 1 of 168 | 18.1 / 19.5 / 0 of 313 / 0 of 313 |',
      ].join('\n'),
    );
    expect(table(results, { cold: true }).split('\n')[2]).toMatch(/\| 235\.1, 19\.3, 19\.5 ms \|$/);
  });

  it('fails a warm frame over 20 ms, or a phase that did not play, and never a cold one', () => {
    expect(problems(results)).toEqual([]);
    const broken: Result[] = [row('crate', 'warm', 1, 36.9, 1), { ...row('realm', 'warm', 1), recap: { error: 'the sprint-ended preview did not play' } }];
    expect(problems(broken)).toEqual(['crate splash: 1 frame over 20 ms, the worst 36.9 ms', 'realm recap: did not play in 1 pass']);
    expect(cell(pool(broken.slice(1)).recap)).toBe('did not play (1)');
  });

  it("leaves a phase the theme doesn't have out of the figures", () => {
    const p = pool([{ ...row('zeta', 'warm', 1), splash: null }]);
    expect(cell(p.splash)).toBe('none');
    expect(problems([{ ...row('zeta', 'warm', 1), splash: null }])).toEqual([]);
  });
});

it('points the sample at a theme and a route', () => {
  expect(themed('http://127.0.0.1:4000/', 'realm', '#/settings/toil')).toBe('http://127.0.0.1:4000/?theme=realm#/settings/toil');
});
