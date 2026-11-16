import { describe, expect, it } from 'vitest';
import { memoryFiles } from '../../../test/harness/files.js';
import { ToilError } from '../errors.js';
import { planFor, readPlanFrom, skippedWarning, NOTHING_TO_CATEGORIZE } from './plan.js';
import type { ClassifyPlan, PlanGroup } from './types.js';

const group = (extra: Partial<PlanGroup> = {}): PlanGroup => ({
  area: 'jira',
  connection: 'corp-jira',
  labels: { ktlo: 'ktlo', feature: 'feature' },
  items: [{ id: 'corp-jira:PAY-1', key: 'PAY-1', category: 'ktlo', labels: { add: ['ktlo'], remove: ['Feature'] } }],
  ...extra,
});
const plan = (...groups: PlanGroup[]): ClassifyPlan => ({
  scheme: { name: 'ktlo-feature', revision: 2 },
  categories: [
    { id: 'ktlo', short: 'KTLO', name: 'Keep the lights on', label: 'ktlo', definition: 'd' },
    { id: 'feature', short: 'Feature', name: 'Feature', label: 'feature', definition: 'd' },
  ],
  plan: groups,
});
const read = (text: string, from: string | undefined = 'plan.json', files = memoryFiles({ 'plan.json': text }, { stdin: text })) => readPlanFrom({ files }, from);
const refusal = async (fn: () => unknown): Promise<ToilError> => {
  try {
    await fn();
  } catch (err) {
    return err as ToilError;
  }
  throw new Error('expected a refusal');
};

describe('readPlanFrom', () => {
  it('reads bare data', async () => {
    expect((await read(JSON.stringify(plan(group()))))).toEqual(plan(group()));
  });

  it('reads the envelope, taking the plan from data and ignoring the rest of the result', async () => {
    const envelope = { ok: true, data: { ...plan(group()), toilProject: 'p', verdicts: [], summary: {} }, error: null, meta: { command: 'classify run' } };
    expect((await read(JSON.stringify(envelope))).plan).toEqual([group()]);
  });

  it('reads stdin when from is omitted or "-"', async () => {
    const text = JSON.stringify(plan(group()));
    expect((await read(text, undefined)).plan).toHaveLength(1);
    expect((await read(text, '-')).plan).toHaveLength(1);
  });

  it('says there is no stdin over MCP', async () => {
    const err = (await refusal(() => readPlanFrom({ files: memoryFiles({}) }, undefined)));
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toContain('Over MCP');
  });

  it('refuses a failed envelope, naming its message', async () => {
    const err = (await refusal(() => read(JSON.stringify({ ok: false, data: null, error: { code: 'X', message: 'no scheme' }, meta: {} }))));
    expect(err.message).toContain('failed result: no scheme');
  });

  it('refuses non-JSON, and JSON with no plan list', async () => {
    expect((await refusal(() => read('nope'))).message).toContain("isn't JSON");
    expect((await refusal(() => read('{"items":[]}'))).message).toContain('no plan list');
    expect((await refusal(() => read('[]'))).message).toContain('no plan list');
  });

  it("refuses an addition or removal the entry's own labels map does not name", async () => {
    for (const labels of [{ add: ['bug'], remove: [] }, { add: ['ktlo'], remove: ['urgent'] }]) {
      const bad = group({ items: [{ id: 'a', key: 'A-1', category: 'ktlo', labels }] });
      const err = (await refusal(() => read(JSON.stringify(plan(bad)))));
      expect(err.code).toBe('INVALID_INPUT');
      expect(err.message).toContain("is not one of the labels this entry's labels map names");
    }
  });

  it('compares labels without regard to case', async () => {
    const ok = group({ items: [{ id: 'a', key: 'A-1', category: 'ktlo', labels: { add: ['KTLO'], remove: ['FEATURE'] } }] });
    expect((await read(JSON.stringify(plan(ok)))).plan).toHaveLength(1);
  });

  it('refuses a second entry for one connection, a category with no label, and a field value with no field', async () => {
    expect((await refusal(() => read(JSON.stringify(plan(group(), group()))))).message).toContain('a second entry for jira connection "corp-jira"');
    const unlabelled = group({ items: [{ id: 'a', key: 'A-1', category: 'chore', labels: { add: [], remove: [] } }] });
    expect((await refusal(() => read(JSON.stringify(plan(unlabelled))))).message).toContain('has no label');
    const orphanField = group({ items: [{ id: 'a', key: 'A-1', category: 'ktlo', labels: { add: [], remove: [] }, field: { value: 'KTLO' } }] });
    expect((await refusal(() => read(JSON.stringify(plan(orphanField))))).message).toContain('no field named');
  });

  it('refuses a key repeated in one entry, and names the entry and the key', async () => {
    const item = (id: string, category: string) => ({ id, key: 'A-1', category, labels: { add: [], remove: [] } });
    const err = (await refusal(() => read(JSON.stringify(plan(group({ items: [item('a', 'ktlo'), item('b', 'feature')] }))))));
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toContain('"A-1" appears more than once in the jira entry for connection "corp-jira"');
    // Jira keys are one key whatever the case; Azure DevOps ids are numbers.
    const cased = group({ items: [item('a', 'ktlo'), { ...item('b', 'feature'), key: 'a-1' }] });
    expect((await refusal(() => read(JSON.stringify(plan(cased))))).message).toContain('appears more than once');
    const ids = group({ area: 'ado', connection: 'corp-ado', items: [{ ...item('a', 'ktlo'), key: '7' }, { ...item('b', 'feature'), key: '007' }] });
    expect((await refusal(() => read(JSON.stringify(plan(ids))))).message).toContain('appears more than once in the ado entry');
    // The same key in two different connections' entries is two items.
    const twoConnections = [group({ items: [item('a', 'ktlo')] }), group({ connection: 'other-jira', items: [item('a', 'ktlo')] })];
    expect((await read(JSON.stringify(plan(...twoConnections)))).plan).toHaveLength(2);
  });

  it('accepts a field with its name and project', async () => {
    const withField = group({ area: 'github', connection: 'github', field: { name: 'Work', project: 'imagile/3' }, items: [{ id: 'a', key: 'x#1', category: 'ktlo', labels: { add: [], remove: [] }, field: { value: 'KTLO' } }] });
    expect((await read(JSON.stringify(plan(withField)))).plan[0]!.field).toEqual({ name: 'Work', project: 'imagile/3' });
  });
});

describe('planFor', () => {
  const jira = group();
  const ado = group({ area: 'ado', connection: 'corp-ado' });
  const other = group({ connection: 'other-jira', items: [] });

  it("returns the connection's group and names the rest as skipped", async () => {
    expect(planFor(plan(jira, ado, other), 'jira', 'corp-jira')).toEqual({
      group: jira,
      skipped: [{ area: 'ado', connection: 'corp-ado', items: 1 }, { area: 'jira', connection: 'other-jira', items: 0 }],
    });
  });

  it('returns no group, and nothing skipped, for an empty plan', async () => {
    expect(planFor(plan(), 'jira', 'corp-jira')).toEqual({ group: undefined, skipped: [] });
  });

  it('refuses a plan with nothing for the connection, suggesting the connection of that area', async () => {
    const err = (await refusal(() => planFor(plan(jira, other), 'jira', 'wrong')));
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toContain('jira "corp-jira", jira "other-jira"');
    expect(err.fix).toContain('<one of corp-jira, other-jira>');
    expect((await refusal(() => planFor(plan(jira), 'jira', 'wrong'))).fix).toContain('--connection corp-jira');
    expect((await refusal(() => planFor(plan(jira), 'github', 'gh'))).fix).toContain('no github items');
  });
});

describe('skippedWarning', () => {
  it('is undefined with nothing skipped', async () => {
    expect(skippedWarning([])).toBeUndefined();
  });

  it('names each entry with its count, singular or plural', async () => {
    const w = skippedWarning([{ area: 'ado', connection: 'corp-ado', items: 1 }, { area: 'jira', connection: 'j2', items: 4 }]);
    expect(w?.code).toBe('CATEGORIZE_SKIPPED');
    expect(w?.message).toContain('ado "corp-ado" (1 item), jira "j2" (4 items)');
  });

  it('has a fixed warning for a plan with nothing to do', async () => {
    expect(NOTHING_TO_CATEGORIZE.code).toBe('CATEGORIZE_NOTHING');
  });
});
