// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { JIRA_OWI_FIELDS, loadToilProject, withFieldIds } from '../src/load.ts';
import { readiness } from '../src/model/readiness.ts';
import type { Envelope, Execute } from '../src/toil.ts';

/**
 * #573 follow-up: sync copies each registered field's value back under its id
 * before `mapOwi`, instead of renaming the overrides. And a `jira issue fields`
 * that failed is an unknown list, so the search is not given any `fields`.
 */

const ok = (command: string, data: unknown): Envelope => ({ ok: true, data, error: null, meta: { command, durationMs: 0, version: 't', contractVersion: 1, context: { connection: { value: 'corp-jira', source: 'toil-project' } } } }) as unknown as Envelope;
const refuse = (command: string): Envelope => ({ ok: false, data: null, error: { code: 'INVALID_INPUT', message: `no ${command}`, fix: 'none' }, meta: { command, durationMs: 0, version: 't', contractVersion: 1 } }) as unknown as Envelope;

const REGISTERED = [
  { id: 'customfield_10016', name: 'Story Points' },
  { id: 'customfield_10020', name: 'Iteration' },
  { id: 'customfield_10500', name: 'Definition' },
  { id: 'customfield_10900', name: 'Priority' },
];

interface Run {
  calls: Array<{ command: string; input: Record<string, unknown> }>;
  data: Awaited<ReturnType<typeof loadToilProject>>;
}

async function load(jira: Record<string, unknown>, issueFields: Record<string, unknown>, options: { fieldsFail?: boolean; history?: unknown[] } = {}): Promise<Run> {
  const calls: Run['calls'] = [];
  const execute: Execute = async (command, input) => {
    calls.push({ command, input: input ?? {} });
    if (command === 'projects show') return ok(command, { name: 'p', areas: { jira: { connection: { value: 'corp-jira' }, inputs: { project: 'PAY' } } }, toilProject: { jira: { project: 'PAY', ...jira }, repos: [] } });
    if (command === 'jira issue fields') return options.fieldsFail ? refuse(command) : ok(command, REGISTERED);
    if (command === 'jira issue history') return ok(command, options.history ?? []);
    if (command === 'jira issue search') {
      const issue = { key: 'PAY-1', self: 'https://jira.imagile.dev/rest/api/2/issue/1', fields: { summary: 'Pay', status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, issuetype: { name: 'Story' }, ...issueFields } };
      return ok(command, { issues: [issue], maxResults: 1, isLast: true });
    }
    return refuse(command);
  };
  return { calls, data: await loadToilProject(execute, 'p') };
}

const search = (r: Run) => r.calls.find((c) => c.command === 'jira issue search')!;

describe('registered fields copied back under their ids', () => {
  it('keeps sprint history when the sprint field is registered as "Iteration"', async () => {
    // The Fields step writes the id; search returns the value under the registered name; the changelog names Jira's own label.
    const history = [{ created: '2026-11-02T10:00:00.000+0000', items: [{ field: 'Sprint', fieldId: 'customfield_10020', fromString: '', toString: 'Sprint 41' }] }];
    const r = await load({ fields: { iteration: 'customfield_10020' } }, { Iteration: [{ id: 7, name: 'Sprint 42', state: 'active' }] }, { history });
    const item = r.data.items[0]!;
    expect(item.iteration?.name).toBe('Sprint 42');
    expect(JSON.stringify(item)).toContain('Sprint 41');
  });

  it('still reads the standard field for a `priority: priority` override, not a custom field named "Priority"', async () => {
    const r = await load({ fields: { priority: 'priority' } }, { priority: { name: 'High' }, Priority: { name: 'Custom' } });
    const priority = JSON.stringify(r.data.items[0]!.priority);
    expect(priority).toContain('High');
    expect(priority).not.toContain('Custom');
  });

  it('finds acceptance criteria named by id once the field is registered', async () => {
    const r = await load({ fields: { acceptanceCriteria: 'customfield_10500' } }, { Definition: 'The payment is captured once. A retry never charges twice. The receipt names the card used.' });
    const item = r.data.items[0]!;
    const rows = readiness({ item, settings: r.data.readiness, byId: new Map([[item.id, item]]) }).rows;
    const row = rows.find((x) => JSON.stringify(x).includes('acceptance'))!;
    expect(row.state).toBe('pass');
    expect(JSON.stringify(row)).toContain('customfield_10500');
  });

  it('never replaces a value already under the id, and leaves a field the search lacked alone', () => {
    const env = ok('jira issue search', { issues: [{ key: 'A-1', fields: { customfield_10016: 8, 'Story Points': 5 } }, { key: 'A-2', fields: {} }] });
    const out = withFieldIds(env, REGISTERED).data as { issues: Array<{ fields: Record<string, unknown> }> };
    expect(out.issues[0]!.fields.customfield_10016).toBe(8);
    expect(Object.keys(out.issues[1]!.fields)).toEqual([]);
    // The answer it was given is not changed.
    expect((env.data as { issues: Array<{ fields: Record<string, unknown> }> }).issues[0]!.fields.customfield_10016).toBe(8);
  });
});

describe('fields asked of the search', () => {
  it('asks for fields once the connection has listed its own', async () => {
    const r = await load({}, {});
    const asked = String(search(r).input.fields).split(',');
    expect(asked).toEqual(expect.arrayContaining(['customfield_10016', 'timeoriginalestimate']));
  });

  it('leaves `fields` out when `jira issue fields` failed: an unknown list is not an empty one', async () => {
    const r = await load({}, {}, { fieldsFail: true });
    expect(search(r).input).not.toHaveProperty('fields');
    expect(r.data.items).toHaveLength(1);
  });

  it('asks for the original estimate, the hours fallback mapOwi reads, and not for an epic link', () => {
    expect(JIRA_OWI_FIELDS).toContain('timeoriginalestimate');
    expect(JIRA_OWI_FIELDS).not.toContain('Epic Link');
  });
});
