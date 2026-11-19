import { describe, expect, it } from 'vitest';
import { splitHash, withQuery } from '../src/address.ts';
import { peekHref, unpeekHref } from '../src/format.ts';
import { addValue, parseFilters, removeValue, toWhere, writeFilters } from '../src/filters.ts';
import { FIXTURE_NOW } from '../src/fixtures/execute.ts';
import { SAMPLE_TEAM } from '../src/fixtures/sample-team.ts';
import { parseRoute } from '../src/App.tsx';
import { decodeDrill, encodeDrill, resolveDrill } from '../src/model/drill.ts';
import { buildInsights, burnupOf, inNameOrder, mixDecided, mixLines, mixOverview, mixSources, nextRelease, releasesToShow, resolveScheme } from '../src/model/work-insights.ts';
import { loaded } from './harness.ts';

const sample = async () => buildInsights((await loaded('sample-team')).data, FIXTURE_NOW);

describe('the insights data layer on sample-team', () => {
  it('shares add to one, Not sorted yet is present, and the sources add up to the items', async () => {
    const ins = await sample();
    const { lines } = mixOverview(ins);
    expect(lines!.reduce((n, l) => n + l.share, 0)).toBeCloseTo(1, 9);
    expect(lines!.map((l) => l.name)).toContain('Not sorted yet');
    expect(lines!.at(-1)!.name).toBe('Not sorted yet');
    const s = mixSources(ins.verdicts.values());
    expect(s.rules + s.labels + s.agent + s.people + s.unsure).toBe(ins.items.length);
    expect(s.total).toBe(146);
    expect(s.unsure).toBe(SAMPLE_TEAM.facts.classification.unsure);
  });

  it("the headline's Unsure and the How it was decided panel's Unsure agree, under a lens too (#657)", async () => {
    const { data } = await loaded('sample-team');
    for (const scheme of [undefined, 'flow', 'balance']) {
      const ins = buildInsights(data, FIXTURE_NOW, scheme);
      const lead = mixOverview(ins);
      const unsure = lead.lines!.find((l) => l.id === null)!;
      const counted = lead.lines!.reduce((n, l) => n + l.value, 0);
      const d = mixDecided(ins, lead);
      expect([d.total, d.unsure]).toEqual([counted, unsure.value]);
      expect(Math.round((d.unsure / d.total) * 100)).toBe(Math.round(unsure.share * 100));
    }
  });

  it('counts every item by category as the sample facts do', async () => {
    const ins = await sample();
    const r = ins.run({ measure: 'items', split: 'category' });
    const by = Object.fromEntries(r.rows.map((row, i) => [row.kind === 'none' ? 'unsure' : row.key.replace('v:', ''), r.rowTotals[i]!.value]));
    expect(by).toEqual(SAMPLE_TEAM.facts.classification.byCategory);
  });

  it('agrees with the sample facts on release 2.4', async () => {
    const ins = await sample();
    const f = SAMPLE_TEAM.facts.releases.find((r) => r.name === '2.4')!;
    const s = ins.scope('2.4');
    expect([s.total, s.done, s.open, s.added]).toEqual([f.items, f.done, f.open, f.scopeAdded]);
    const next = nextRelease(ins)!;
    expect(next.release.name).toBe('2.4');
    expect(releasesToShow(ins).latest!.name).toBe('2.3');
  });

  it('builds a burn-up whose last known day is the release done count, and null for days to come', async () => {
    const ins = await sample();
    const b = burnupOf(ins, ins.releases.find((r) => r.name === '2.4')!)!;
    const known = b.result.cells[0]!.filter((c) => c.value !== null);
    expect(known.at(-1)!.value).toBe(ins.scope('2.4').done);
    expect(known.at(-1)!.items).toHaveLength(known.at(-1)!.value!);
    expect(b.result.cells[0]!.at(-1)!.value).toBeNull();
    expect(burnupOf(ins, ins.releases.find((r) => r.name === '2.5')!)).toBeNull();
  });

  it('leaves a done item with no resolved date off the burn-up line, counts it as unmeasured, and says so', async () => {
    const ins = await sample();
    const release = ins.releases.find((r) => r.name === '2.4')!;
    const victim = ins.items.find((i) => i.statusCategory === 'DONE' && (i.releases ?? []).some((r) => r.name === '2.4') && i.resolved)!;
    const edited = { ...ins, items: ins.items.map((i) => (i.id === victim.id ? { ...i, resolved: null } : i)) };
    const whole = burnupOf(ins, release)!;
    const b = burnupOf(edited, release)!;
    expect(b.result.cells[0]!.filter((c) => c.value !== null).at(-1)!.value).toBe(whole.result.cells[0]!.filter((c) => c.value !== null).at(-1)!.value! - 1);
    expect(b.result.coverage.measured).toBe(b.result.coverage.items - 1);
    expect(b.result.coverage.notes).toEqual(['1 done item has no resolved date, so it is not on the line.']);
    expect(whole.result.coverage.notes).toEqual([]);
  });

  it('puts people in name order, never by size', async () => {
    const ins = await sample();
    const r = inNameOrder(ins.run({ measure: 'items', split: 'category', across: 'assignee', top: 0 }));
    const names = r.columns.filter((c) => c.kind === 'value').map((c) => c.label);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(r.columns.at(-1)!.kind).toBe('none');
  });

  it('leaves fix versions unread, not zero, where the read never fetched them', async () => {
    const ins = buildInsights((await loaded('card-payments')).data, FIXTURE_NOW);
    expect(ins.releasesRead).toBe(false);
    expect(ins.valuesIn('release')).toBeNull();
  });

  it('falls back to the standard scheme and says so for one it cannot read', () => {
    expect(resolveScheme('ktlo-feature').note).toBeNull();
    expect(resolveScheme('mine').note).toContain('mine');
    expect(resolveScheme('mine').scheme.name).toBe('ktlo-feature');
  });

  it('opens exactly the items in the cell that was clicked', async () => {
    const ins = await sample();
    const spec = { measure: 'throughput' as const, split: 'category', across: 'resolved:month', from: '2026-07-16', to: '2026-10-13', where: toWhere({ where: [{ dimension: 'release', values: ['2.4'] }] }) };
    const r = ins.run(spec);
    const ri = r.rows.findIndex((x) => x.key === 'v:ktlo');
    const ci = r.columns.length - 2;
    const drill = decodeDrill(encodeDrill({ kind: 'cell', spec, row: 'v:ktlo', column: r.columns[ci]!.key }))!;
    expect(resolveDrill(ins, drill)!.ids).toEqual(r.cells[ri]![ci]!.items);
    const added = decodeDrill(encodeDrill({ kind: 'release', set: 'added', release: '2.4' }))!;
    expect(resolveDrill(ins, added)!.ids).toHaveLength(8);
    expect(decodeDrill('nonsense')).toBeNull();
    expect(mixLines(ins.run({ measure: 'items', split: 'category', where: [{ dimension: 'release', op: '=', values: ['9.9'] }] }))).toBeNull();
  });
});

describe('filters in the address', () => {
  it('round-trip, with commas in values and keys that are not dimensions left alone', () => {
    const q = new URLSearchParams('release=2.4&category=ktlo&from=2026-09-14&to=nope&split=team&component=A%5C%2CB');
    const f = parseFilters(q);
    expect(f.from).toBe('2026-09-14');
    expect(f.to).toBeUndefined();
    expect(f.where.map((w) => w.dimension)).toEqual(['release', 'category', 'component']);
    expect(f.where[2]!.values).toEqual(['A,B']);
    const out = new URLSearchParams('split=team');
    writeFilters(out, f);
    expect(parseFilters(out)).toEqual(f);
    expect(out.get('split')).toBe('team');
  });

  it('adds and removes values, dropping a dimension with its last', () => {
    let f = addValue({ where: [] }, 'release', '2.4');
    f = addValue(f, 'release', '2.5');
    expect(f.where[0]!.values).toEqual(['2.4', '2.5']);
    f = removeValue(removeValue(f, 'release', '2.4'), 'release', '2.5');
    expect(f.where).toEqual([]);
  });

  it('survive the item drawer opening and closing, and the route reads them', () => {
    const page = '#/project/sample-team/charts/mix?release=2.4&category=ktlo';
    const open = peekHref(page, 'sample-jira:SHOP-1');
    expect(open).toBe(`${page}&item=sample-jira%3ASHOP-1`);
    expect(unpeekHref(open)).toBe(page);
    expect(unpeekHref('#/project/x?item=a')).toBe('#/project/x');
    expect(splitHash(open).query.get('release')).toBe('2.4');
    const r = parseRoute(open);
    expect(r).toMatchObject({ view: 'charts', dashboard: 'mix', peek: 'sample-jira:SHOP-1' });
    expect(r.filters!.where.map((w) => w.dimension)).toEqual(['release', 'category']);
    expect(withQuery('#/a?x=1&item=2', (q) => q.set('y', '3'))).toBe('#/a?x=1&y=3&item=2');
    expect(parseRoute('#/project/x/charts/mix?items=cell%7Cq').items).toBe('cell|q');
  });
});
