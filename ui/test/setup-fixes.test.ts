// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { analyzeSettings } from '../../src/core/brief/settings.ts';
import { jiraSearchFields, loadToilProject, registeredFields } from '../src/load.ts';
import { briefingOf } from '../src/model/briefing.ts';
import { FIXTURE_NOW } from '../src/fixtures/execute.ts';
import { TOKEN_WORD } from '../src/setup.ts';
import { namedJiraProject, withJiraKey } from '../src/views/project-create.ts';
import type { Envelope, Execute } from '../src/toil.ts';
import { loaded } from './harness.ts';

/**
 * #573: what the setup wizard keeps of Jira, which fields sync asks Jira for,
 * what the summary says it could not check, and when a connection has no
 * password to miss. The wizard's own screens are held in setup-wizard.test.tsx,
 * and what needs toil's registry in config.test.ts.
 * Four findings, one file: a gap between the form and the paperwork it files is
 * still a gap when it is a small one.
 */

describe('the Jira project key', () => {
  it('is saved on the Jira link as one set of project=KEY, and on no other link', () => {
    const links = [
      { area: 'jira', connection: 'corp-jira' },
      { area: 'github', connection: 'github' },
    ];
    expect(withJiraKey(links, ' PAY ')).toEqual([{ area: 'jira', connection: 'corp-jira', set: ['project=PAY'] }, links[1]]);
    // No key typed: the link is as it was.
    expect(withJiraKey(links, '  ')).toEqual(links);
  });

  it('reads what a Toil project names from the raw section: a key, a per-repository map, or nothing', () => {
    expect(namedJiraProject({ toilProject: { jira: { project: 'PAY' } } })).toEqual({ kind: 'key', key: 'PAY' });
    expect(namedJiraProject({ toilProject: { jira: { project: { 'C:/Code/pay': 'PAY' } } } })).toEqual({ kind: 'map' });
    expect(namedJiraProject({ toilProject: { jira: { connection: 'corp-jira' } } })).toEqual({ kind: 'none' });
    expect(namedJiraProject({ toilProject: {} })).toEqual({ kind: 'none' });
    expect(namedJiraProject(null)).toEqual({ kind: 'none' });
  });
});

describe('the fields sync asks Jira search for', () => {
  const registered = [
    { id: 'customfield_10016', name: 'Story Points' },
    { id: 'customfield_10020', name: 'Sprint' },
  ];

  it('adds what mapOwi reads, every registered field and the ids the Toil project names, once each', () => {
    const list = jiraSearchFields(registered, { estimate: 'customfield_10016', iteration: 'Sprint', team: 'customfield_10700', acceptanceCriteria: 'customfield_10500' }).split(',');
    expect(list).toEqual(expect.arrayContaining(['summary', 'status', 'description', 'parent', 'subtasks', 'issuelinks', 'customfield_10016', 'customfield_10020', 'customfield_10700', 'customfield_10500']));
    expect(new Set(list).size).toBe(list.length);
  });

  it('leaves out a name search would refuse, so one bad field does not cost the whole read', () => {
    const list = jiraSearchFields([], { estimate: 'Story Points', iteration: 'customfield_10020' }).split(',');
    expect(list).not.toContain('Story Points');
    expect(list).toContain('customfield_10020');
  });

  it('reads the registered fields out of `jira issue fields`, and nothing else', () => {
    expect(registeredFields([{ id: 'customfield_1', name: 'A', type: 'number' }, { id: 5 }, 'x', null])).toEqual([{ id: 'customfield_1', name: 'A' }]);
    expect(registeredFields(undefined)).toEqual([]);
  });

  it('is asked of the search, and points and sprint come back through an override by id', async () => {
    const calls: Array<{ command: string; input: Record<string, unknown> }> = [];
    const ok = (command: string, data: unknown): Envelope => ({ ok: true, data, error: null, meta: { command, durationMs: 0, version: 't', contractVersion: 1, context: { connection: { value: 'corp-jira', source: 'toil-project' } } } }) as unknown as Envelope;
    const refuse = (command: string): Envelope => ({ ok: false, data: null, error: { code: 'INVALID_INPUT', message: `no ${command}`, fix: 'none' }, meta: { command, durationMs: 0, version: 't', contractVersion: 1 } }) as unknown as Envelope;
    const execute: Execute = async (command, input) => {
      calls.push({ command, input: input ?? {} });
      if (command === 'projects show') return ok(command, { name: 'p', areas: { jira: { connection: { value: 'corp-jira' }, inputs: { project: 'PAY' } } }, toilProject: { jira: { project: 'PAY', fields: { estimate: 'customfield_10016', iteration: 'customfield_10020' } }, repos: [] } });
      if (command === 'jira issue fields') return ok(command, registered);
      if (command === 'jira issue history') return ok(command, []);
      if (command === 'jira issue search') {
        // As Jira Cloud sends it: a registered field under the name the connection gives it.
        const issue = { key: 'PAY-1', self: 'https://jira.imagile.dev/rest/api/2/issue/1', fields: { summary: 'Pay', status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, issuetype: { name: 'Story' }, 'Story Points': 5, Sprint: [{ id: 7, name: 'Sprint 42', state: 'active' }] } };
        return ok(command, { issues: [issue], maxResults: 1, isLast: true });
      }
      return refuse(command);
    };
    const data = await loadToilProject(execute, 'p');
    const search = calls.find((c) => c.command === 'jira issue search')!;
    expect(String(search.input.fields).split(',')).toEqual(expect.arrayContaining(['customfield_10016', 'customfield_10020', 'issuelinks', 'parent', 'description']));
    const order = calls.map((c) => c.command);
    expect(order.indexOf('jira issue fields')).toBeLessThan(order.indexOf('jira issue search'));
    const item = data.items[0]!;
    expect(item.estimate?.value).toBe(5);
    expect(item.iteration?.name).toBe('Sprint 42');
  });
});

describe('what the summary could not check', () => {
  it('names a lens that did not run apart from one that ran with items it could not test', async () => {
    const { data } = await loaded('card-payments');
    const inProgress = data.items.map((i) => (i.statusCategory === 'IN_PROGRESS' ? { ...i, assignee: null } : i));
    const view = (wipLimit: number | null) => briefingOf({ items: inProgress, pullRequests: data.pullRequests, now: FIXTURE_NOW, settings: analyzeSettings(undefined, wipLimit).settings, analyses: [] });
    const wip = (list: Array<{ label: string }>) => list.some((u) => /work-in-progress/.test(u.label));
    const ran = view(3);
    expect(wip(ran.partlyChecked)).toBe(true);
    expect(wip(ran.unchecked)).toBe(false);
    const skipped = view(null);
    expect(wip(skipped.unchecked)).toBe(true);
    expect(wip(skipped.partlyChecked)).toBe(false);
  });
});

describe('a connection with no secret to miss', () => {
  it('has a word of its own, which is not the word for a secret that went missing', () => {
    expect(TOKEN_WORD.none).toBe('not needed');
    expect(TOKEN_WORD.none).not.toBe(TOKEN_WORD.missing);
  });
});
