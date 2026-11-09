import { describe, expect, it } from 'vitest';
import { testContext } from '../../../test/harness/context.js';
import { config as fixtureConfig } from '../../../test/fixtures/jira-cloud-data.js';
import { execute } from '../../core/run.js';
import { discoverCommand, type Reader, type SampledIssue } from './discover.js';

/**
 * `jira field discover` with a Reader of canned answers, so the grouping, the
 * guesses, the budget and the difference between "nothing found" and "no
 * fields" are held without a Jira. The two deployments' own reads are proven
 * by the parity suite's fixtures.
 */

const SPRINT = { id: 'customfield_10020', name: 'Sprint', custom: true, schema: { type: 'array', custom: 'com.pyxis.greenhopper.jira:gh-sprint' } };
const POINTS = { id: 'customfield_10016', name: 'Story point estimate', custom: true, schema: { type: 'number', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' } };
const CREW = { id: 'customfield_10200', name: 'Crew', custom: true, schema: { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' } };
const NOTES = { id: 'customfield_10300', name: 'Story Notes', custom: true, schema: { type: 'string' } };
const NOTES2 = { id: 'customfield_10301', name: 'story notes', custom: true, schema: { type: 'string' } };

const issue = (key: string, type: string, fields: Record<string, unknown> = {}): SampledIssue => ({ key, fields: { issuetype: { name: type }, summary: 'x', ...fields } });

function reader(over: Partial<Reader> = {}) {
  const calls: string[] = [];
  const r: Reader = {
    deployment: 'cloud',
    fields: async () => (calls.push('fields'), [SPRINT, POINTS, CREW, NOTES, NOTES2]),
    project: async () => (calls.push('project'), [{ id: '1', name: 'Story' }, { id: '2', name: 'Bug' }, { id: '3', name: 'Epic' }]),
    sample: async (jql) => {
      calls.push(`sample ${jql}`);
      if (jql.includes('"1"')) return [issue('P-1', 'Story', { customfield_10020: [{ id: 7, name: 'Sprint 7', state: 'active' }], customfield_10016: 3, customfield_10200: { value: 'Platform' }, customfield_10300: '' })];
      if (jql.includes('"2"')) return [issue('P-2', 'Bug', { customfield_10016: null, customfield_10200: { value: 'Payments' } })];
      return [];
    },
    issue: async (key) => (calls.push(`issue ${key}`), issue(key, key.startsWith('P') ? 'Story' : 'Task', { customfield_10016: 8 })),
    ...over,
  };
  return { r, calls };
}

async function run(r: Reader, input: Record<string, unknown>) {
  const t = testContext({ config: fixtureConfig, routes: [], files: {} });
  return execute(discoverCommand(() => r), input, t.context);
}

type Data = {
  issueTypes: Array<{ name: string; status: string; sampled: string[] | null; fields: string[] | null }>;
  fields: Array<{ id: string; alias: string; example: string; issueTypes: string[]; owi: { field: string; confidence: string } | null }>;
  commands: string[];
  mode: string;
};

describe('jira field discover', () => {
  it('samples one issue of each type and groups the custom fields that hold a value by type', async () => {
    const { r, calls } = reader();
    const d = (await run(r, { project: 'PROJ', perType: 1 })).data as Data;
    expect(d.mode).toBe('sample');
    expect(d.issueTypes.map((t) => [t.name, t.status])).toEqual([['Story', 'sampled'], ['Bug', 'sampled'], ['Epic', 'no-sample']]);
    // A null field list is unknown (nothing of the type to read); [] would be a real none.
    expect(d.issueTypes[2]).toMatchObject({ sampled: null, fields: null });
    expect(d.issueTypes[0]!.fields).toEqual(['customfield_10016', 'customfield_10020', 'customfield_10200']);
    // An empty string and a null are fields with no value.
    expect(d.issueTypes[1]!.fields).toEqual(['customfield_10200']);
    expect(calls.filter((c) => c.startsWith('sample'))).toHaveLength(3);
    expect(calls[calls.length - 1]).toContain('ORDER BY updated DESC');
  });

  it('suggests an alias and the OWI field, high only where the schema or name is exact', async () => {
    const d = (await run(reader().r, { project: 'PROJ' })).data as Data;
    const by = Object.fromEntries(d.fields.map((f) => [f.id, f]));
    expect(by.customfield_10020).toMatchObject({ alias: 'sprint', example: 'Sprint 7 (active)', owi: { field: 'iteration', confidence: 'high' } });
    expect(by.customfield_10016).toMatchObject({ alias: 'storyPointEstimate', example: '3', owi: { field: 'estimate', confidence: 'high' } });
    expect(by.customfield_10200).toMatchObject({ alias: 'crew', owi: null });
    expect(by.customfield_10200!.issueTypes).toEqual(['Story', 'Bug']);
    expect(d.commands).toEqual([
      'toil projects field <toil-project> jira storyPointEstimate customfield_10016',
      'toil projects field <toil-project> jira estimate customfield_10016 --replace',
      'toil projects field <toil-project> jira sprint customfield_10020',
      'toil projects field <toil-project> jira iteration customfield_10020 --replace',
    ]);
  });

  it('keeps aliases apart when two names flatten to one', async () => {
    const { r } = reader({ sample: async () => [issue('P-1', 'Story', { customfield_10300: 'a', customfield_10301: 'b' })] });
    const d = (await run(r, { project: 'PROJ', limit: 1 })).data as Data;
    expect(d.fields.map((f) => f.alias)).toEqual(['storyNotes', 'storyNotes10301']);
  });

  it('honours --limit and says which types it did not read', async () => {
    const { r, calls } = reader();
    const e = await run(r, { project: 'PROJ', limit: 2 });
    expect((e.data as Data).issueTypes.map((t) => t.name)).toEqual(['Story', 'Bug']);
    expect(calls.filter((c) => c.startsWith('sample'))).toHaveLength(2);
    expect(e.meta.warnings?.[0]).toMatchObject({ code: 'JIRA_DISCOVER_TRUNCATED' });
    expect(e.meta.warnings?.[0]?.message).toContain('Epic');
  });

  it('reads named issues, grouped by their own type', async () => {
    const { r, calls } = reader();
    const d = (await run(r, { issue: ['P-1', 'Q-2', 'P-3'] })).data as Data;
    expect(d.mode).toBe('issues');
    expect(d.issueTypes.map((t) => [t.name, t.sampled])).toEqual([['Story', ['P-1', 'P-3']], ['Task', ['Q-2']]]);
    expect(calls).toEqual(['fields', 'issue P-1', 'issue Q-2', 'issue P-3']);
  });

  it('refuses a call with both or neither, a bad key, and too many issues, before any read', async () => {
    for (const input of [{}, { issue: ['P-1'], project: 'PROJ' }, { issue: ['nope'] }, { project: 'PR OJ' }, { issue: Array.from({ length: 21 }, (_, i) => `P-${i + 1}`) }]) {
      const { r, calls } = reader();
      const e = await run(r, input);
      expect(e.error?.code, JSON.stringify(input)).toBe('INVALID_INPUT');
      expect(calls).toEqual([]);
    }
  });

  it('a sampled type with no custom values has fields [], not null', async () => {
    const { r } = reader({ sample: async () => [issue('P-1', 'Story')] });
    const d = (await run(r, { project: 'PROJ', limit: 1 })).data as Data;
    expect(d.issueTypes[0]).toMatchObject({ status: 'sampled', fields: [] });
  });
});
