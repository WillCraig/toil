import { describe, expect, it } from 'vitest';
import { NONE_KEY, specFromQuery } from '../../src/core/insights/index.ts';
import { FIXTURE_NOW } from '../src/fixtures/execute.ts';
import { SAMPLE_TEAM } from '../src/fixtures/sample-team.ts';
import { decodeDrill, encodeDrill, resolveDrill } from '../src/model/drill.ts';
import { dimensionChoices, exploreHref, exploreQuery, exploreSpec, formFor, labelFamilies, oneBarEach, parentLevels, saveViewInput, viewNameFrom } from '../src/model/explore.ts';
import { cfdOf, cfdSet, flowFigures, flowSentence } from '../src/model/flow-history.ts';
import { sprintResult, sprintStories, sprintLine, velocityOf, velocitySentence } from '../src/model/sprints-history.ts';
import { stitchColumns } from '../src/model/stitch.ts';
import { noEpicOf, streamsOf, whereResult, whereSentence } from '../src/model/where.ts';
import { buildInsights, resolveScheme } from '../src/model/work-insights.ts';
import { parseFilters } from '../src/filters.ts';
import { csvName, figuresCsv, isoWeekStart, plainDates, plainResult } from '../src/views/charts/format.ts';
import { loaded } from './harness.ts';

/** The four new dashboards' models on sample-team, whose figures toil's own sample facts hold (src/core/sample/facts.ts). */
const sample = async () => buildInsights((await loaded('sample-team')).data, FIXTURE_NOW, 'ktlo-feature');
const facts = SAMPLE_TEAM.facts;

describe('sprint history', () => {
  it('counts done, committed and added per sprint as the sample facts do', async () => {
    const ins = await sample();
    const stories = sprintStories(ins.items, ins.asOf);
    expect(stories.map((s) => s.name)).toEqual(facts.sprints.map((s) => s.name));
    expect(stories.map((s) => s.done.length)).toEqual(facts.sprints.map((s) => s.done));
    expect(stories.slice(0, 5).map((s) => s.done.length)).toEqual([18, 20, 18, 24, 25]);
    expect(stories.map((s) => s.committed!.length)).toEqual(facts.sprints.map((s) => s.committed));
    expect(stories.map((s) => s.added!.length)).toEqual(facts.sprints.map((s) => s.added));
    expect(stories.map((s) => s.donePoints)).toEqual(facts.sprints.map((s) => s.donePoints));
  });

  it('holds carried-over to its own definition (not done, in a later sprint) and says how it differs from the facts', async () => {
    const ins = await sample();
    const stories = sprintStories(ins.items, ins.asOf);
    const closed = stories.filter((s) => s.closed);
    expect(closed).toHaveLength(5);
    // The facts count anything in the next sprint too, done or not; the model only what was left undone. So never more.
    for (const [i, s] of closed.entries()) expect(s.carried.length, s.name).toBeLessThanOrEqual(facts.sprints[i]!.carriedOut);
    expect(stories.at(-1)!.carried).toEqual([]);
    expect(stories.at(-1)!.closed).toBe(false);
  });

  it('partitions each sprint into the four series the chart stacks, and the rows add up to the column', async () => {
    const ins = await sample();
    const stories = sprintStories(ins.items, ins.asOf);
    const byId = new Map(ins.items.map((i) => [i.id, i]));
    const r = sprintResult(stories, byId, 'items', ins.asOf);
    r.columns.forEach((_, ci) => {
      const sum = r.cells.reduce((n, row) => n + (row[ci]!.value ?? 0), 0);
      expect(sum, r.columns[ci]!.label).toBe(stories[ci]!.all.length);
      expect(r.columnTotals[ci]!.value).toBe(stories[ci]!.all.length);
    });
    const points = sprintResult(stories, byId, 'points', ins.asOf);
    expect(points.measure.unit).toBe('points');
  });

  it('leads with the velocity of the last five sprints that ended, and points', async () => {
    const ins = await sample();
    const v = velocityOf(sprintStories(ins.items, ins.asOf))!;
    expect([v.min, v.max, v.median]).toEqual([18, 25, 20]);
    expect(velocitySentence(v)).toBe('Done per sprint: 18 to 25 items over the last 5 sprints (median 20), 52 to 82 points');
    expect(sprintLine(sprintStories(ins.items, ins.asOf)[4]!)).toMatch(/^Sprint 25: 25 done, 2 added after it started, \d+ carried over$/);
  });

  it('has no committed or added figures where no sprint history was read, and says so with null, never 0', async () => {
    const data = (await loaded('sample-team')).data;
    const ins = buildInsights({ ...data, items: data.items.map((i) => ({ ...i, history: null })) }, FIXTURE_NOW, 'ktlo-feature');
    const stories = sprintStories(ins.items, ins.asOf);
    expect(stories.every((s) => s.committed === null && s.added === null)).toBe(true);
    expect(stories.map((s) => s.done.length)).toEqual(facts.sprints.map((s) => s.done));
    const r = sprintResult(stories, new Map(ins.items.map((i) => [i.id, i])), 'items', ins.asOf);
    expect(r.cells[0]!.every((c) => c.value === null)).toBe(true);
    expect(r.cells[0]![0]!.reason).toMatch(/history wasn't read/);
  });
});

describe('stitching columns', () => {
  it('joins one pivot per column, folds the smallest into Other, and keeps a row one column lacks as a computed zero', async () => {
    const ins = await sample();
    const stories = sprintStories(ins.items, ins.asOf).slice(-3);
    const parts = stories.map((s) => ({ key: `v:${s.name}`, label: s.name, result: ins.runOver(s.done, { measure: 'items', split: 'category', top: 0 }) }));
    const r = stitchColumns(parts, { spec: { measure: 'items', split: 'category', across: 'sprint' }, top: 0 });
    expect(r.columns.map((c) => c.label)).toEqual(stories.map((s) => s.name));
    r.columns.forEach((_, ci) => expect(r.cells.reduce((n, row) => n + (row[ci]!.value ?? 0), 0)).toBe(stories[ci]!.done.length));
    const folded = stitchColumns(parts, { spec: { measure: 'items', split: 'category', across: 'sprint' }, top: 1 });
    expect(folded.rows.some((x) => x.kind === 'other')).toBe(true);
    expect(folded.cells.reduce((n, row) => n + (row[0]!.value ?? 0), 0)).toBe(stories[0]!.done.length);
  });

  it('is unread, with no rows, where the split was never read', async () => {
    const ins = await sample();
    const nothing = buildInsights({ ...(await loaded('sample-team')).data, items: [] }, FIXTURE_NOW);
    expect(stitchColumns([], { spec: { measure: 'items' } }).rows).toEqual([]);
    const part = { key: 'v:a', label: 'a', result: ins.run({ measure: 'items', split: 'category', top: 0 }) };
    expect(stitchColumns([part], { spec: { measure: 'items' } }).rows.length).toBeGreaterThan(0);
    expect(nothing.items).toHaveLength(0);
  });
});

describe('where we are working', () => {
  it('counts the items with no epic above them as the sample facts do, as a share of the items that can have one', async () => {
    const ins = await sample();
    const none = noEpicOf(ins)!;
    expect(none.none).toBe(facts.withNoEpic);
    expect(none.of).toBe(facts.items - 10);
    expect(Math.round(none.share * 100)).toBe(14);
    const r = ins.run(none.spec);
    const at = r.rows.findIndex((x) => x.key === NONE_KEY);
    expect(r.rowTotals[at]!.items).toHaveLength(facts.withNoEpic);
  });

  it('draws days in progress by week for each epic, and counts the epics with work each week', async () => {
    const ins = await sample();
    const r = whereResult(ins, 'parent:Epic')!;
    expect(r.columns.length).toBeGreaterThanOrEqual(12);
    expect(r.measure.id).toBe('days');
    expect(r.rows.some((x) => x.kind === 'value')).toBe(true);
    const s = streamsOf(ins)!;
    expect(s.weeks.length).toBe(r.columns.length);
    expect(s.current).toBeGreaterThan(0);
    expect(s.current).toBeLessThanOrEqual(5);
    expect(s.names).toHaveLength(s.current);
    expect(whereSentence(s, noEpicOf(ins))).toMatch(/^Work this week is spread across \d epics; 19 of 136 items \(14%\) have no epic above them\.$/);
  });

  it('is unread, not zeros, where no status history was read', async () => {
    const data = (await loaded('sample-team')).data;
    const ins = buildInsights({ ...data, items: data.items.map((i) => ({ ...i, history: null })) }, FIXTURE_NOW, 'ktlo-feature');
    expect(whereResult(ins, 'parent:Epic')).toBeNull();
    expect(streamsOf(ins)).toBeNull();
    expect(noEpicOf(ins)).not.toBeNull();
  });

  it('carries a filter in the pivot, so the days of the items that stay do not change', async () => {
    const ins = await sample();
    const where = [{ dimension: 'category', op: '=' as const, values: ['ktlo'] }];
    const filtered = whereResult(ins, 'parent:Epic', { where })!;
    expect(filtered.spec.where).toEqual(where);
    expect(filtered.total.items.length).toBeLessThan(whereResult(ins, 'parent:Epic')!.total.items.length);
  });
});

describe('flow', () => {
  it('says how many finish a week and the median cycle time the sample facts hold', async () => {
    const ins = await sample();
    const f = flowFigures(ins);
    expect(f.cycleDays).toBeCloseTo(facts.medianCycleDays, 1);
    expect(f.perWeek).toBeGreaterThan(0);
    expect(flowSentence(f)).toMatch(new RegExp(`^About \\d+ finished a week, typically in ${facts.medianCycleDays} days$`));
  });

  it('draws a cumulative flow diagram whose last week is today, whose Done only grows, and whose doors list what it counts', async () => {
    const ins = await sample();
    const cfd = cfdOf(ins)!;
    const done = cfd.result.cells[0]!.map((c) => c.value!);
    expect(done).toEqual([...done].sort((a, b) => a - b));
    const last = cfd.result.cells.map((row) => row.at(-1)!.value!);
    expect(last).toEqual([ins.items.filter((i) => i.statusCategory === 'DONE').length, ins.items.filter((i) => i.statusCategory === 'IN_PROGRESS').length, ins.items.filter((i) => i.statusCategory === 'TODO').length]);
    const week = cfd.result.columns.at(-1)!.key.slice(2);
    expect(cfdSet(ins, 'DONE', week).ids).toHaveLength(last[0]!);
    expect(cfd.unknown).toBe(0);
  });

  it('is unread, never a flat diagram, where no history was read', async () => {
    const data = (await loaded('sample-team')).data;
    const ins = buildInsights({ ...data, items: data.items.map((i) => ({ ...i, history: null })) }, FIXTURE_NOW, 'ktlo-feature');
    expect(cfdOf(ins)).toBeNull();
    const f = flowFigures(ins);
    expect(f.cycleDays).toBeNull();
    expect(flowSentence(f)).toMatch(/^About \d+ finished a week$/);
  });
});

describe('drills for the new dashboards', () => {
  it('round-trips through the address and resolves to as many items as the figure says', async () => {
    const ins = await sample();
    const stories = sprintStories(ins.items, ins.asOf);
    const s25 = stories[4]!;
    const sprint = decodeDrill(encodeDrill({ kind: 'sprint', set: 'added', sprint: 'Sprint 25' }))!;
    expect(sprint).toEqual({ kind: 'sprint', set: 'added', sprint: 'Sprint 25' });
    expect(resolveDrill(ins, sprint)!.ids).toHaveLength(s25.added!.length);
    const split = decodeDrill(encodeDrill({ kind: 'sprint', set: 'done', sprint: 'Sprint 25', split: 'category', row: 'v:feature' }))!;
    expect(resolveDrill(ins, split)!.ids.length).toBeGreaterThan(0);
    expect(resolveDrill(ins, split)!.ids.length).toBeLessThan(s25.done.length);
    const cfd = decodeDrill(encodeDrill({ kind: 'cfd', category: 'DONE', week: '2026-10-12' }))!;
    expect(resolveDrill(ins, cfd)!.ids.length).toBeGreaterThan(0);
    const spec = { measure: 'days' as const, split: 'parent:Epic', top: 0 };
    const where = decodeDrill(encodeDrill({ kind: 'where', spec, row: '*', column: `v:2026-10-12` }))!;
    expect(resolveDrill(ins, where)!.ids.length).toBeGreaterThan(0);
    expect(decodeDrill('sprint|nonsense|x')).toBeNull();
    expect(resolveDrill(ins, { kind: 'sprint', set: 'done', sprint: 'Sprint 99' })).toBeNull();
  });

  it('carries a filter through each new kind, so the list matches the filtered figure', async () => {
    const ins = await sample();
    const where = [{ dimension: 'category', op: '=' as const, values: ['feature'] }];
    const all = resolveDrill(ins, { kind: 'sprint', set: 'done', sprint: 'Sprint 25' })!.ids;
    const drill = decodeDrill(encodeDrill({ kind: 'sprint', set: 'done', sprint: 'Sprint 25', where }))!;
    const some = resolveDrill(ins, drill)!.ids;
    expect(some.length).toBeGreaterThan(0);
    expect(some.length).toBeLessThan(all.length);
    const cfd = decodeDrill(encodeDrill({ kind: 'cfd', category: 'DONE', week: '2026-10-12', where }))!;
    expect(cfd).toMatchObject({ where });
  });
});

describe('explore', () => {
  it('round-trips a view through the address, filters as the filter bar keys and the rest as the spec', async () => {
    const spec = { measure: 'cycleTime' as const, split: 'type', across: 'resolved:month', where: [{ dimension: 'release', op: '=' as const, values: ['2.4'] }, { dimension: 'status', op: '!=' as const, values: ['Cancelled'] }], from: '2026-07-01', to: '2026-09-30', share: true, top: 6, pin: ['Bug'] };
    const q = exploreQuery(spec, 'heatmap');
    expect(q.get('release')).toBe('2.4');
    expect(q.get('where')).toBe('status != Cancelled');
    expect(q.get('chart')).toBe('heatmap');
    const read = exploreSpec(q, parseFilters(q));
    expect('spec' in read && read.spec).toEqual({ ...spec, where: [{ dimension: 'status', op: '!=', values: ['Cancelled'] }, { dimension: 'release', op: '=', values: ['2.4'] }] });
    expect(exploreHref('#/project/p/charts/explore', spec)).toContain('measure=cycleTime');
    expect(exploreSpec(new URLSearchParams('measure=nonsense'), { where: [] })).toMatchObject({ error: expect.stringContaining('Unknown measure') });
  });

  it('offers the dimensions the data holds, greyed where nothing was read', async () => {
    const ins = await sample();
    const choices = dimensionChoices(ins, ['customer']);
    const by = Object.fromEntries(choices.map((c) => [c.spec, c]));
    expect(by['parent:Initiative']).toMatchObject({ label: 'Parent › Initiative', read: true });
    expect(by['dim:customer']).toMatchObject({ label: 'customer', read: true });
    expect(by['parent:top']!.label).toBe('Parent › Top');
    expect(parentLevels(ins)).toContain('Initiative');
    expect(labelFamilies(ins)).toEqual([]);
    const bare = buildInsights({ ...(await loaded('sample-team')).data, items: (await loaded('sample-team')).data.items.map((i) => ({ ...i, releases: undefined })) }, FIXTURE_NOW);
    expect(dimensionChoices(bare).find((c) => c.spec === 'release')!.read).toBe(false);
  });

  it('finds a label family only where three labels share a prefix', async () => {
    const data = (await loaded('sample-team')).data;
    const items = data.items.map((i, n) => (n < 3 ? { ...i, labels: [`team/${['a', 'b', 'c'][n]}`] } : i));
    expect(labelFamilies(buildInsights({ ...data, items }, FIXTURE_NOW))).toEqual(['team']);
  });

  it('chooses the form that follows the data', async () => {
    const ins = await sample();
    expect(formFor(ins.run({ measure: 'throughput', split: 'category', across: 'resolved:month' }))).toBe('columns');
    expect(formFor(ins.run({ measure: 'items', split: 'team' }))).toBe('bars');
    expect(formFor(ins.run({ measure: 'items', split: 'label', across: 'component', top: 0 }))).toBe('heatmap');
    expect(formFor(ins.run({ measure: 'items', split: 'type', across: 'statusCategory' }))).toBe('bars');
    expect(formFor(ins.run({ measure: 'items', split: 'type', across: 'statusCategory' }), 'heatmap')).toBe('heatmap');
    const bars = oneBarEach(ins.run({ measure: 'items', split: 'type' }));
    expect(bars.rows).toHaveLength(1);
    expect(bars.columns.length).toBeGreaterThan(1);
    expect(bars.cells[0]![0]!.items.length).toBeGreaterThan(0);
  });

  it("builds the exact input Save to Charts hands toil's own command", () => {
    const spec = { measure: 'items' as const, split: 'release', across: 'statusCategory', where: [{ dimension: 'category', op: '=' as const, values: ['ktlo', 'feature'] }], share: true, top: 4 };
    expect(saveViewInput('sample-team', 'release-mix', ' Release mix ', spec, 'bars')).toEqual({ toilProject: 'sample-team', name: 'release-mix', measure: 'items', split: 'release', across: 'statusCategory', where: ['category = ktlo, feature'], share: true, top: 4, title: 'Release mix', chart: 'bars' });
    expect(saveViewInput('p', 'v', '', { measure: 'wip' }, undefined, true)).toEqual({ toilProject: 'p', name: 'v', measure: 'wip', replace: true });
    expect(viewNameFrom('Release mix, by team!')).toBe('release-mix-by-team');
    expect(viewNameFrom('2026 plan')).toBe('view-2026-plan');
    expect(viewNameFrom('!!!')).toBe('');
    // What toil's own reader makes of the address a saved view opens.
    expect(specFromQuery(Object.fromEntries(exploreQuery(spec)))).toMatchObject({ measure: 'items', split: 'release', across: 'statusCategory', share: true, top: 4 });
  });
});

describe('words and figures', () => {
  it('rewrites ISO days, ISO weeks and "of Aug 2026" in core sentences, and nothing else', () => {
    expect(plainDates('37 items have no resolved date between 2026-07-16 and 2026-10-13, so they are not in the table.')).toBe('37 items have no resolved date between 16 Jul and 13 Oct, so they are not in the table.');
    expect(plainDates('KTLO went from 40% of Aug 2026 to 55% of Sep 2026, up 15 points.')).toBe('KTLO went from 40% in Aug 2026 to 55% in Sep 2026, up 15 points.');
    expect(plainDates('Grew fastest between 2026-W31 and 2026-W32.')).toBe('Grew fastest between the week of 27 Jul and the week of 3 Aug.');
    expect(plainDates('SHOP-1234 and 2026-13-45 stay.')).toBe('SHOP-1234 and 2026-13-45 stay.');
    expect(isoWeekStart(2026, 31)).toBe('2026-07-27');
  });

  it('names week columns by the day they begin and leaves keys alone', async () => {
    const ins = await sample();
    const r = ins.run({ measure: 'throughput', across: 'resolved:week' });
    const plain = plainResult(r);
    expect(plain.columns[0]!.label).toMatch(/^\d{1,2} [A-Z][a-z]{2}$/);
    expect(plain.columns.map((c) => c.key)).toEqual(r.columns.map((c) => c.key));
    expect(plain.coverage.notes.join(' ')).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('exports figures as CSV with a dash-free empty cell for a figure nobody read, never 0', async () => {
    const ins = await sample();
    const csv = figuresCsv(ins.run({ measure: 'items', split: 'category', across: 'type' }));
    expect(csv.split('\r\n')[0]).toMatch(/^Category,/);
    expect(csv.endsWith('\r\n')).toBe(true);
    const bare = buildInsights({ ...(await loaded('sample-team')).data, items: (await loaded('sample-team')).data.items.map((i) => ({ ...i, history: null })) }, FIXTURE_NOW);
    const days = figuresCsv(bare.run({ measure: 'days', split: 'type' }));
    expect(days).toMatch(/Total/);
    expect(days.split('\r\n')[1]).toMatch(/^[^,]+,$/);
    expect(csvName('Burn-up: 2.4')).toBe('burn-up-2-4.csv');
    expect(figuresCsv(ins.run({ measure: 'items', split: 'assignee' }))).not.toMatch(/\r\n=/);
  });

  it('reads the scheme a toil project names, balance and flow included, and falls back with the note for one it cannot', () => {
    expect(resolveScheme('ktlo-feature').scheme.name).toBe('ktlo-feature');
    expect(resolveScheme('balance')).toMatchObject({ note: null });
    expect(resolveScheme('balance').scheme.name).toBe('balance');
    expect(resolveScheme('flow')).toMatchObject({ note: null, scheme: { name: 'flow' } });
    const fallback = resolveScheme('made-up');
    expect(fallback.scheme.name).toBe('ktlo-feature');
    expect(fallback.note).toMatch(/names a classification, made-up,/);
  });
});
