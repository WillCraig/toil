import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { owiMapCommand } from '../src/areas/util/owi.js';
import { checkAgainstSchema } from '../src/areas/util/owi/run.js';
import { Verifier } from '../src/areas/util/kit/verify.js';
import { areaOf, commandName } from '../src/core/command.js';
import type { Envelope, Warning } from '../src/core/envelope.js';
import { ToilError } from '../src/core/errors.js';
import { documentsFrom, fieldOverrides, mapOwi, OVERRIDABLE, OWI_COMMANDS, OWI_SOURCES, OWI_VERSION, parseOwiInput, type Change, type WorkItem } from '../src/core/owi/index.js';
import { bodyLinks } from '../src/core/owi/github.js';
import { sprintOf } from '../src/core/owi/jira.js';
import { execute } from '../src/core/run.js';
import { argvFor } from '../src/program.js';
import { commands as registry } from '../src/registry.js';
import { runCli } from './harness/cli.js';
import { testContext } from './harness/context.js';
import { examplesOf, loadFixtures, setUp } from './harness/fixtures.js';
import { boardlessIssues, boardlessTimelines } from './fixtures/owi/github-boardless.js';
import { sprintEnvelopes, sprintJsonl } from './fixtures/owi/sprint.js';

/**
 * The Open Work Item spec (docs/owi/) held to the mappers, and the mappers to
 * every area's fixtures: each item- or history-shaped command's examples run
 * through the real CLI against its area's fixture, and what they print is
 * mapped and validated against docs/owi/schema.json. Then the sprint fixture
 * the Toil UI preview reads, mapped and pinned as a file, and the edges the
 * spec promises: unknown states, overrides, skipped and refused input, and a
 * self-check that fails a broken item. A standard with no conformance suite
 * is a suggestion with a version number.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = Record<string, any>;
const map = async (input: Record<string, unknown>, files: Record<string, string> = {}) => {
  const envelope = (await execute(owiMapCommand as never, input, testContext({ files }).context)) as Envelope;
  return { envelope, data: envelope.data as Data, warnings: (envelope.meta.warnings ?? []) as Warning[] };
};
const json = (value: unknown) => JSON.stringify(value);
const env = (command: string, data: unknown, connection = command.split(' ')[0]!, inputs: Record<string, string> = {}) => ({
  ok: true,
  data,
  error: null,
  meta: { command, durationMs: 1, version: '0.0.0-test', context: { connection: { value: connection, source: 'default' }, inputs: Object.fromEntries(Object.entries(inputs).map(([k, value]) => [k, { value, source: 'input' }])) } },
});
const byId = (items: WorkItem[], id: string) => items.find((i) => i.id === id)!;

const schema = JSON.parse(readFileSync(new URL('../docs/owi/schema.json', import.meta.url), 'utf8')) as Data;
const spec = readFileSync(new URL('../docs/owi/spec.md', import.meta.url), 'utf8');

describe('the OWI spec and schema', () => {
  it('declare the same version as the mappers', () => {
    expect(schema.$defs.WorkItem.properties.owi.enum).toEqual(['0.1', OWI_VERSION]);
    expect(schema.$defs.Change.properties.owi.const).toBe(OWI_VERSION);
    expect(spec).toContain(`version ${OWI_VERSION}`);
  });

  it('documents every WorkItem and Change field, every overridable field and every mapped command', () => {
    for (const field of Object.keys(schema.$defs.WorkItem.properties)) expect(spec, field).toContain(`\`${field}\``);
    for (const field of Object.keys(schema.$defs.Change.properties)) expect(spec, field).toContain(`\`${field}\``);
    for (const field of OVERRIDABLE) expect(spec, field).toContain(`\`${field}\``);
    for (const commands of Object.values(OWI_COMMANDS)) for (const c of [...commands.items, ...commands.history, ...commands.context, ...commands.changes]) expect(spec, c).toContain(`\`${c}\``);
  });

  it('maps every WorkItem field to OSLC CM, or says why not', () => {
    const oslc = spec.slice(spec.indexOf('## OSLC'));
    for (const field of Object.keys(schema.$defs.WorkItem.properties)) expect(oslc, field).toContain(`\`${field}\``);
    for (const flag of ['oslc_cm:closed', 'oslc_cm:inProgress', 'oslc_cm:fixed', 'oslc_cm:approved', 'oslc_cm:reviewed', 'oslc_cm:verified']) expect(oslc).toContain(flag);
  });
});

describe("every area's fixtures map to valid OWI", async () => {
  const fixtures = await loadFixtures();
  await setUp(fixtures);
  // A history command's output names no item; these keys are the ones its examples read.
  const KEYS: Record<string, string> = { 'jira issue history': 'PROJ-123', 'github issue history': '9' };
  const families = new Set<string>();
  for (const fixture of fixtures.filter((f) => OWI_SOURCES[f.area])) {
    const known = OWI_COMMANDS[fixture.area]!;
    const all = [...known.items, ...known.history, ...known.context, ...known.changes];
    const mapped = fixture.commands.filter((def) => all.includes(commandName(def)));
    it(`${fixture.area}: every mapped command has examples`, () => {
      expect(mapped.map(commandName).sort()).toEqual([...all].sort());
    });
    for (const def of mapped) {
      families.add(fixture.area);
      it.each(examplesOf(def, fixture).map((example, i) => [i, example] as const))(`${commandName(def)} example %i`, async (_i, example) => {
        const cli = testContext({ config: fixture.config, routes: fixture.routes, files: fixture.files });
        const run = await runCli(argvFor(def, example, def.path, fixture.commands), { commands: fixture.commands, context: cli.context });
        expect(run.envelope?.ok, run.stdout).toBe(true);
        const name = commandName(def);
        const input = KEYS[name] ? { key: KEYS[name], history: run.envelope } : run.envelope;
        const { data, envelope } = await map({ text: json(input) });
        expect(envelope.ok, json(envelope.error)).toBe(true);
        expect(data.verified.passed, json(data.verified)).toBe(true);
        expect(data.skipped).toEqual([]);
        if (known.items.includes(name)) expect(data.count).toBeGreaterThan(0);
        if (known.changes.includes(name) && (!Array.isArray(run.envelope!.data) || run.envelope!.data.length > 0)) expect(data.changes.length).toBeGreaterThan(0);
        for (const change of data.changes as Change[]) {
          expect(change.id.startsWith(`${example.connection ?? fixture.area}:`)).toBe(true);
          expect(change.source.command).toBe(name);
        }
        if (known.history.includes(name) && Array.isArray(run.envelope!.data) && run.envelope!.data.length > 0) expect(data.histories.length + data.items.length).toBeGreaterThan(0);
        for (const item of data.items as WorkItem[]) {
          expect(item.id.startsWith(`${example.connection ?? fixture.area}:`)).toBe(true);
          expect(item.source.command).toBe(name);
        }
      });
    }
  }

  it('every area OWI maps has a fixture, so its output is mapped above', () => {
    const withFixture = new Set(fixtures.map((f) => f.area));
    for (const area of Object.keys(OWI_SOURCES)) expect(withFixture.has(area), `${area} is in OWI_SOURCES but has no test/fixtures/${area}.fixture.ts`).toBe(true);
  });
});

/**
 * Work-item areas are marked in one place, OWI_SOURCES (src/core/owi/types.ts),
 * and this keeps the mark honest: an area with issue- or work-item-shaped
 * commands that OWI doesn't map fails here, so a new tracker can't ship without
 * its mapper (the `integrations` skill, **Open Work Items**).
 */
describe('work-item areas are all mapped to OWI', () => {
  /** Command paths that read or write issues, work items or tickets: `issue get`, `issue search`, `work-item get`, `ticket create`. */
  const WORK_ITEM = /(^| )(issue|work-item|ticket) (get|get-many|history|search|create|update|transition|link)( |$)/;
  /** Areas known to be on their way, by the issue that builds them. Each switches on once the area is registered. */
  const PENDING: Record<string, string> = {};
  const registered = new Set(registry.map((def) => areaOf(def)));
  const workItemAreas = [...new Set(registry.filter((def) => def.area && WORK_ITEM.test(commandName(def))).map((def) => areaOf(def)))].sort();

  it('marks every area that has work-item commands in OWI_SOURCES', () => {
    expect(workItemAreas.filter((area) => !PENDING[area] && !OWI_SOURCES[area])).toEqual([]);
    expect(workItemAreas).toEqual(expect.arrayContaining(['ado', 'github', 'jira']));
  });

  it("marks only areas that exist, and lists each one's mapped commands among its registered ones", () => {
    for (const [area, known] of Object.entries(OWI_COMMANDS)) {
      expect(registered.has(area), `${area} is in OWI_SOURCES but isn't a registered area`).toBe(true);
      const names = new Set(registry.filter((def) => areaOf(def) === area).map(commandName));
      for (const c of [...known.items, ...known.history, ...known.context]) expect(names.has(c), `${c} is mapped but isn't registered`).toBe(true);
    }
  });

  for (const [area, issue] of Object.entries(PENDING)) {
    it.skipIf(!registered.has(area))(`${area} (${issue}) is mapped once it is registered: one line in OWI_SOURCES`, () => {
      expect(OWI_SOURCES[area], `${area} is registered; add it to OWI_SOURCES in src/core/owi/types.ts and drop it from PENDING`).toBeDefined();
    });
  }
});

describe('the sprint fixture (test/fixtures/owi/)', async () => {
  const { envelope, data, warnings } = await map({ file: 'owi/sprint-42.jsonl' }, { 'owi/sprint-42.jsonl': sprintJsonl });
  // A refusal fails here, not at collection, so the rest of the file still reports.
  const items = (data?.items ?? []) as WorkItem[];
  it('maps without an error', () => expect(envelope.error).toBeNull());

  it('maps all twenty-nine items (twenty in Sprint 42), every one valid, with nothing skipped', () => {
    expect(data.count).toBe(29);
    expect(data.verified.passed).toBe(true);
    expect(data.verified.checks.find((c: Data) => c.check === 'items.schema')).toMatchObject({ status: 'passed', checked: 29, failed: 0 });
    expect(data.skipped).toEqual([]);
    expect(data.histories).toEqual([]);
    expect(items.filter((i) => i.source.area === 'jira')).toHaveLength(12);
    expect(items.filter((i) => i.source.area === 'ado')).toHaveLength(10);
    expect(items.filter((i) => i.source.area === 'github')).toHaveLength(7);
    expect(items.every((i) => i.statusCategory !== 'UNKNOWN')).toBe(true);
    expect(warnings.map((w) => w.code)).toEqual(['OWI_UNMAPPED', 'INPUT_INCOMPLETE'].filter((c) => warnings.some((w) => w.code === c)));
  });

  it('holds a blocked chain in Jira and in Azure DevOps', () => {
    expect(byId(items, 'corp-jira:PAY-101').links).toContainEqual({ type: 'blocks', direction: 'outward', target: 'corp-jira:PAY-102', name: 'blocks' });
    expect(byId(items, 'corp-jira:PAY-102').links).toContainEqual({ type: 'blocks', direction: 'outward', target: 'corp-jira:PAY-103', name: 'blocks' });
    expect(byId(items, 'corp-jira:PAY-103').links).toContainEqual({ type: 'blocks', direction: 'inward', target: 'corp-jira:PAY-102', name: 'is blocked by' });
    expect(byId(items, 'corp-ado:2302').links).toContainEqual({ type: 'blocks', direction: 'outward', target: 'corp-ado:2303', name: 'Successor' });
    expect(byId(items, 'corp-ado:2303').links).toContainEqual({ type: 'blocks', direction: 'inward', target: 'corp-ado:2302', name: 'Predecessor' });
  });

  it('shows scope added mid-sprint and work carried over, from the histories', () => {
    const start = Date.parse('2026-10-05T09:00:00.000Z');
    const added = (id: string) => byId(items, id).history!.iterations.find((c) => c.to.some((n) => n.endsWith('Sprint 42')) && !c.from.some((n) => n.endsWith('Sprint 42')));
    expect(Date.parse(added('corp-jira:PAY-107')!.at)).toBeGreaterThan(start);
    expect(Date.parse(added('corp-ado:2306')!.at)).toBeGreaterThan(start);
    expect(added('corp-jira:PAY-104')!.from).toEqual(['Sprint 41']);
    expect(added('corp-ado:2304')!.from).toEqual(['Payments\\Sprint 41']);
    expect(byId(items, 'github:imagile/payments-web#43').native['github project items']).toMatchObject({ createdAt: '2026-10-07T09:00:00Z' });
  });

  it('maps people, estimates, iterations, hierarchy and transitions from each source', () => {
    const pay101 = byId(items, 'corp-jira:PAY-101');
    expect(pay101).toMatchObject({ type: 'STORY', status: 'In Progress', statusCategory: 'IN_PROGRESS', parent: 'corp-jira:PAY-100', children: ['corp-jira:PAY-106'], estimate: { value: 5, unit: 'points', field: 'Story Points' } });
    expect(pay101.iteration).toEqual({ id: '42', name: 'Sprint 42', path: null, start: '2026-10-05T09:00:00.000Z', end: '2026-10-16T17:00:00.000Z', state: 'current' });
    expect(pay101.url).toBe('https://jira.imagile.dev/browse/PAY-101');
    expect(byId(items, 'corp-jira:PAY-105').history!.transitions.map((t) => [t.toCategory, t.to])).toEqual([['IN_PROGRESS', 'In Progress'], ['IN_PROGRESS', 'In Review'], ['DONE', 'Done']]);
    expect(byId(items, 'corp-jira:PAY-107').estimate).toBeNull();
    expect(byId(items, 'corp-ado:2305')).toMatchObject({ type: 'TASK', statusCategory: 'DONE', parent: 'corp-ado:2302', estimate: { value: 4, unit: 'hours', field: 'Microsoft.VSTS.Scheduling.OriginalEstimate' } });
    expect(byId(items, 'corp-ado:2307')).toMatchObject({ statusCategory: 'DONE', resolution: 'Removed from the backlog' });
    expect(byId(items, 'corp-ado:2302').iteration).toMatchObject({ name: 'Sprint 42', path: 'Payments\\Sprint 42', start: '2026-10-05T00:00:00.000Z', end: '2026-10-16T00:00:00.000Z' });
    expect(byId(items, 'corp-ado:2301')).toMatchObject({ type: 'OTHER', typeName: 'Feature', children: ['corp-ado:2302', 'corp-ado:2303'] });
    const gh41 = byId(items, 'github:imagile/payments-web#41');
    expect(gh41).toMatchObject({ status: 'In Progress', statusCategory: 'IN_PROGRESS', children: ['github:imagile/payments-web#42'], estimate: { value: 5, unit: 'points', field: 'Estimate' }, iteration: { name: 'Sprint 42', start: '2026-10-05T00:00:00.000Z', end: '2026-10-17T00:00:00.000Z' } });
    expect(byId(items, 'github:imagile/payments-web#42').parent).toBe('github:imagile/payments-web#41');
    expect(byId(items, 'github:imagile/payments-web#44')).toMatchObject({ statusCategory: 'DONE', resolution: 'completed', history: { transitions: [{ from: 'open', to: 'closed', toCategory: 'DONE' }] } });
    expect(byId(items, 'github:imagile/payments-web#45').unmapped.map((u) => u.field)).toEqual(['estimate']);
  });

  it('is the committed fixture the preview reads', async () => {
    await expect(`${JSON.stringify({ owi: data.owi, count: data.count, items: data.items }, null, 2)}\n`).toMatchFileSnapshot('./fixtures/owi/sprint-42.owi.json');
  });

  it('reads the same input as one JSON array', async () => {
    const again = await map({ text: json(sprintEnvelopes) });
    expect(again.data.items).toEqual(data.items);
  });
});

describe('mapping rules', () => {
  const jiraIssue = (fields: Record<string, unknown>, key = 'PAY-1') => ({ key, id: '1', self: 'https://jira.imagile.dev/rest/api/2/issue/1', fields: { summary: 'S', issuetype: { name: 'Story' }, ...fields } });

  it('maps a status with no category to UNKNOWN, warns once, and lists it', async () => {
    const text = json(env('jira issue search', { issues: [jiraIssue({ status: { name: 'Waiting on Legal' } }), jiraIssue({ status: { name: 'Waiting on Legal' } }, 'PAY-2')] }));
    const { data, warnings } = await map({ text });
    expect(data.items.map((i: WorkItem) => i.statusCategory)).toEqual(['UNKNOWN', 'UNKNOWN']);
    expect(warnings.filter((w) => w.code === 'OWI_UNKNOWN_STATE')).toHaveLength(1);
    expect(data.items[0].unmapped).toContainEqual({ field: 'statusCategory', reason: '"Waiting on Legal" has no category: the status came without its statusCategory' });
    expect(data.verified.passed).toBe(true);
  });

  it('maps an Azure DevOps custom state to UNKNOWN, naming the command that shows its category', async () => {
    const { data } = await map({ text: json(env('ado work-item get', { id: 5, fields: { 'System.Title': 'T', 'System.State': 'Ready for QA', 'System.WorkItemType': 'Bug' } })) });
    expect(data.items[0]).toMatchObject({ statusCategory: 'UNKNOWN', type: 'BUG' });
    expect(data.items[0].unmapped.find((u: Data) => u.field === 'statusCategory').reason).toContain('ado work-item states');
  });

  it("maps Scrum's In Progress (Epic, Feature, Task) to IN_PROGRESS, in the item and its history, as a live Scrum organization reports it (#319)", async () => {
    const rev = (rev: number, state: string, at: string) => ({ id: 9, rev, fields: { 'System.State': state, 'System.ChangedDate': at } });
    const input = [
      env('ado work-item get', { id: 9, fields: { 'System.Title': 'T', 'System.State': 'In Progress', 'System.WorkItemType': 'Task' } }),
      env('ado work-item history', [rev(1, 'To Do', '2026-10-05T09:00:00Z'), rev(2, 'In Progress', '2026-10-06T09:00:00Z')]),
    ];
    const { data, warnings } = await map({ text: json(input) });
    const item = data.items[0] as WorkItem;
    expect(item).toMatchObject({ status: 'In Progress', statusCategory: 'IN_PROGRESS', type: 'TASK' });
    expect(item.history!.transitions.map((t) => [t.from, t.to, t.toCategory])).toEqual([[null, 'To Do', 'TODO'], ['To Do', 'In Progress', 'IN_PROGRESS']]);
    expect(warnings.filter((w) => w.code === 'OWI_UNKNOWN_STATE')).toEqual([]);
  });

  it('points estimate at a team field with fields, keeping the field it came from', async () => {
    const issue = jiraIssue({ customfield_10234: 13, 'Story Points': 2 });
    const { data } = await map({ text: json(env('jira issue get', issue)), field: ['estimate=customfield_10234', 'estimateUnit=days'] });
    expect(data.items[0].estimate).toEqual({ value: 13, unit: 'days', field: 'customfield_10234' });
    const ado = await map({ file: 'b.json', field: ['estimate=Custom.TeamPoints'] }, { 'b.json': json(env('ado work-item get-many', { value: [{ id: 7, fields: { 'System.Title': 'T', 'System.State': 'New', 'Custom.TeamPoints': 8 } }] })) });
    expect(ado.data.items[0].estimate).toEqual({ value: 8, unit: 'points', field: 'Custom.TeamPoints' });
  });

  it("reads Jira's original estimate in seconds as hours, and finds Story Points by an expanded name", async () => {
    const hours = await map({ text: json(env('jira issue get', jiraIssue({ timeoriginalestimate: 27000 }))) });
    expect(hours.data.items[0].estimate).toEqual({ value: 7.5, unit: 'hours', field: 'timeoriginalestimate' });
    const named = await map({ text: json(env('jira issue get', { ...jiraIssue({ customfield_10002: 3 }), names: { customfield_10002: 'Story Points' } })) });
    expect(named.data.items[0].estimate).toEqual({ value: 3, unit: 'points', field: 'customfield_10002' });
    const none = await map({ text: json(env('jira issue get', jiraIssue({}))) });
    expect(none.data.items[0].estimate).toBeNull();
    expect(none.data.items[0].unmapped.map((u: Data) => u.field)).toContain('estimate');
  });

  it("reads Data Center's sprint strings and Cloud's sprint objects alike", () => {
    expect(sprintOf('com.atlassian.greenhopper.service.sprint.Sprint@1a[id=7,rapidViewId=2,state=FUTURE,name=Sprint 7, the long one,startDate=<null>,endDate=<null>,completeDate=<null>,sequence=7]')).toEqual({ id: '7', name: 'Sprint 7, the long one', path: null, start: null, end: null, state: 'future' });
    expect(sprintOf({ id: 8, name: 'Sprint 8', state: 'active', startDate: '2026-10-05T09:00:00.000Z', endDate: '2026-10-16T17:00:00.000Z' })).toMatchObject({ id: '8', state: 'current', start: '2026-10-05T09:00:00.000Z' });
    expect(sprintOf('not a sprint')).toBeUndefined();
  });

  it('refuses an override OWI has no field for, or a unit it has no word for', () => {
    expect(() => fieldOverrides(['storyPoints=customfield_1'])).toThrow(ToilError);
    expect(() => fieldOverrides(['estimateUnit=weeks'])).toThrow(/points, hours or days/);
    expect(() => fieldOverrides(['estimate'])).toThrow(/isn't a field override/);
    expect(fieldOverrides({ estimate: 'customfield_10234', estimateUnit: 'points' })).toEqual({ estimate: 'customfield_10234', estimateUnit: 'points' });
  });

  it('refuses output OWI has no mapping for, and data with no command', async () => {
    const other = await map({ text: json(env('bitbucket pr diff', 'diff --git a/x b/x')) });
    expect(other.envelope.error).toMatchObject({ code: 'INVALID_INPUT' });
    expect(other.envelope.error!.fix).toContain('jira issue search');
    expect(other.envelope.error!.fix).toContain('bitbucket pr get');
    const bare = await map({ text: json([{ number: 1 }]) });
    expect(bare.envelope.error).toMatchObject({ code: 'INVALID_INPUT' });
    expect(bare.envelope.error!.fix).toContain('--command');
  });

  it('skips, with a reason and a warning, a failed call and a WIQL result of ids alone', async () => {
    const failed = { ok: false, data: null, error: { code: 'AUTH', message: 'no' }, meta: { command: 'jira issue search', durationMs: 1, version: 'x' } };
    const ids = env('ado work-item search', { workItems: [{ id: 1 }] });
    const { data, warnings } = await map({ text: [json(failed), json(ids)].join('\n') });
    expect(data.count).toBe(0);
    expect(data.skipped).toEqual([
      { at: 'document 1', command: 'jira issue search', reason: 'the call failed (AUTH), so there is nothing to map' },
      { at: 'document 2', command: 'ado work-item search', reason: 'it returns work item ids only: fetch their fields with ado work-item get-many and map that' },
    ]);
    expect(warnings.filter((w) => w.code === 'OWI_SKIPPED')).toHaveLength(2);
    expect(data.verified.checks.find((c: Data) => c.check === 'items.schema').status).toBe('unchecked');
  });

  it('maps bare data with --command, and keeps a keyless history whose item is elsewhere', async () => {
    const { data } = await map({ text: json([jiraIssue({ status: { name: 'Done', statusCategory: { key: 'done' } } })]), command: 'jira issue search' });
    expect(data.items).toHaveLength(0);
    const issue = await map({ text: json({ issues: [jiraIssue({ status: { name: 'Done', statusCategory: { key: 'done' } } })] }), command: 'jira issue search' });
    expect(issue.data.items[0]).toMatchObject({ id: 'jira:PAY-1', statusCategory: 'DONE' });
    const history = await map({ text: json(env('jira issue history', [{ id: '1', created: '2026-10-06T09:00:00.000+0000', items: [{ field: 'status', fromString: 'To Do', toString: 'Done' }] }])), key: 'PAY-9' });
    expect(history.data.histories).toEqual([{ id: 'jira:PAY-9', history: { transitions: [{ from: 'To Do', to: 'Done', fromCategory: 'UNKNOWN', toCategory: 'UNKNOWN', at: '2026-10-06T09:00:00.000Z', by: null }], iterations: [] } }]);
    expect(history.data.verified.passed).toBe(true);
    const keyless = await map({ text: json(env('github issue history', [])) });
    expect(keyless.data.skipped[0].reason).toContain('--key');
  });

  it('leaves pull requests out, with a warning', async () => {
    const { data, warnings } = await map({ text: json(env('github issue list', [{ number: 1, title: 'PR', html_url: 'https://ghe.imagile.dev/imagile/x/pull/1', pull_request: {} }])) });
    expect(data.count).toBe(0);
    expect(warnings.map((w) => w.code)).toContain('OWI_PULL_REQUESTS_SKIPPED');
  });

  it('parses one envelope, an array of envelopes, and JSON Lines', () => {
    const a = env('jira issue search', { issues: [] });
    expect(parseOwiInput(json(a))).toHaveLength(1);
    expect(parseOwiInput(json([a, a]))).toHaveLength(2);
    expect(parseOwiInput(`${json(a)}\n\n${json(a)}\n`)).toHaveLength(2);
    expect(() => parseOwiInput('{"ok":')).toThrow(/isn't JSON/);
    expect(() => parseOwiInput('  ')).toThrow(/empty/);
    expect(documentsFrom([a]).documents[0]).toMatchObject({ area: 'jira', connection: 'jira' });
  });
});

describe('a jira connection\'s deployment', () => {
  it("is carried from meta.context into the item's source, and left out when the input doesn't say", async () => {
    const issue = { key: 'PAY-1', self: 'https://jira-cloud.imagile.dev/rest/api/3/issue/1', fields: { summary: 'S' } };
    const cloud = env('jira issue get', issue, 'imagile-cloud');
    (cloud.meta.context.connection as Record<string, unknown>).deployment = 'cloud';
    const { data } = await map({ text: json(cloud) });
    expect(data.items[0].source).toEqual({ area: 'jira', connection: 'imagile-cloud', key: 'PAY-1', command: 'jira issue get', deployment: 'cloud' });
    expect(data.verified.passed, json(data.verified)).toBe(true);
    const plain = await map({ text: json(env('jira issue get', issue, 'corp-jira')) });
    expect(plain.data.items[0].source).toEqual({ area: 'jira', connection: 'corp-jira', key: 'PAY-1', command: 'jira issue get' });
  });
});

describe('an ado connection\'s deployment', () => {
  it("is carried from meta.context into the item's source, so a Services item says it came from Services", async () => {
    const item = { id: 5, fields: { 'System.Title': 'T', 'System.State': 'New', 'System.WorkItemType': 'Bug' } };
    const cloud = env('ado work-item get', item, 'imagile-services');
    (cloud.meta.context.connection as Record<string, unknown>).deployment = 'cloud';
    const { data } = await map({ text: json(cloud) });
    expect(data.items[0].source).toEqual({ area: 'ado', connection: 'imagile-services', key: '5', command: 'ado work-item get', deployment: 'cloud' });
    expect(data.verified.passed, json(data.verified)).toBe(true);
  });
});

describe('the self-check', () => {
  it('fails an item that breaks the schema, by pointer, under OWI_SCHEMA_INVALID', async () => {
    const { data } = await map({ text: json(env('jira issue get', { key: 'PAY-1', self: 'https://jira.imagile.dev/rest/api/2/issue/1', fields: { summary: 'S' } })) });
    const broken = { ...data.items[0], statusCategory: 'SOMEDAY', created: '2026-10-06' } as WorkItem;
    const warnings: Warning[] = [];
    const v = new Verifier((w) => warnings.push(w));
    await checkAgainstSchema(v, [data.items[0], broken], []);
    const verified = v.done();
    expect(verified.passed).toBe(false);
    expect(verified.checks[0]).toMatchObject({ check: 'items.schema', status: 'failed', checked: 2, failed: 1 });
    expect(verified.checks[0]!.failures![0]!.at).toBe('items[1] (jira:PAY-1)');
    expect(warnings.map((w) => w.code)).toEqual(['OWI_SCHEMA_INVALID']);
  });

  it('the mapper itself never produces a key the schema refuses', () => {
    const result = mapOwi(documentsFrom([env('github issue get', { number: 3, title: 'T', state: 'open', html_url: 'https://ghe.imagile.dev/imagile/x/issues/3' }, 'my-ghe')]).documents);
    expect(result.items[0]!.id).toMatch(new RegExp(schema.$defs.OwiId.pattern));
  });

  it('names a command toil has when it says what to add for a missing field', () => {
    const result = mapOwi(documentsFrom([env('github issue get', { number: 3, title: 'T', state: 'open', html_url: 'https://ghe.imagile.dev/imagile/x/issues/3' }, 'my-ghe')]).documents);
    const estimate = result.items[0]!.unmapped.find((u) => u.field === 'estimate');
    expect(estimate?.reason).toContain('add github project items output');
  });
});

describe('@imagile-dev/toil/api', () => {
  it('exports mapOwi, owiVersion and owiSchema, mapping envelopes with a toil-project-style fields object', async () => {
    const api = await import('../src/api.js');
    expect(api.owiVersion).toBe(OWI_VERSION);
    expect(api.owiSchema).toEqual(schema);
    const result = api.mapOwi(sprintEnvelopes, { fields: { estimateUnit: 'points' } });
    expect(result.items).toHaveLength(29);
    expect(api.mapOwi(sprintJsonl).items).toHaveLength(29);
    expect(api.mapOwi({ issues: [] }, { command: 'jira issue search' }).items).toEqual([]);
    expect(() => api.mapOwi(sprintEnvelopes, { fields: { storyPoints: 'x' } })).toThrow(ToilError);
  });
});

describe('review round 1', () => {
  const MISSING = { estimate: 'Nope.Estimate', priority: 'Nope.Priority', type: 'Nope.Type', team: 'Nope.Team', dueDate: 'Nope.Due', iteration: 'Nope.Iteration' };
  const OVERRIDDEN = ['estimate', 'priority', 'type', 'team', 'dueDate', 'iteration'];
  const field = Object.entries(MISSING).map(([k, v]) => `${k}=${v}`);
  const board = (number: number) => ({ id: `PVTI_${number}`, type: 'ISSUE', content: { number, title: 'T', state: 'OPEN', url: `https://ghe.imagile.dev/imagile/x/issues/${number}`, repository: { nameWithOwner: 'imagile/x' } }, fieldValues: [{ __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'Todo', field: { name: 'Status' } }] });
  const issue = (number: number) => ({ number, title: 'T', state: 'open', html_url: `https://ghe.imagile.dev/imagile/x/issues/${number}`, type: { name: 'Task' } });

  it.each([
    ['jira', [env('jira issue get', { key: 'PAY-1', self: 'https://jira.imagile.dev/rest/api/2/issue/1', fields: { summary: 'S', status: { name: 'Done', statusCategory: { key: 'done' } } } })]],
    ['jira on Cloud', [env('jira issue get', { key: 'PAY-1', self: 'https://jira-cloud.imagile.dev/rest/api/3/issue/1', fields: { summary: 'S' } }, 'imagile-cloud')]],
    ['ado', [env('ado work-item get', { id: 5, fields: { 'System.Title': 'T', 'System.State': 'New', 'System.WorkItemType': 'Bug', 'System.IterationPath': 'P\\S1' } })]],
    ['github, on a board', [env('github issue get', issue(3), 'github'), env('github project items', [board(3)], 'github', { owner: 'imagile' })]],
    ['github, a board item alone', [env('github project items', [board(4)], 'github', { owner: 'imagile' })]],
    ['github, with no board', [env('github issue get', issue(5), 'github')]],
  ])('%s: every override pointed at a missing field is listed in unmapped', async (_name, input) => {
    const { data } = await map({ text: json(input), field });
    expect(data.count).toBe(1);
    const listed = (data.items[0] as WorkItem).unmapped.map((u) => u.field);
    for (const name of OVERRIDDEN) expect(listed, `${name} in ${json(data.items[0].unmapped)}`).toContain(name);
    expect(data.verified.passed).toBe(true);
  });

  it.each([
    ['a Projects date field', { __typename: 'ProjectV2ItemFieldDateValue', date: '2026-10-20', field: { name: 'Due' } }, '2026-10-20', null],
    ['text that is not a date', { __typename: 'ProjectV2ItemFieldTextValue', text: 'next sprint', field: { name: 'Due' } }, null, 'Due holds "next sprint", which isn\'t a date'],
  ])('github: a board dueDate from %s', async (_name, value, dueDate, reason) => {
    const item = { ...board(6), fieldValues: [...board(6).fieldValues, value] };
    const { data } = await map({ text: json(env('github project items', [item], 'github', { owner: 'imagile' })), field: ['dueDate=Due'] });
    expect(data.items[0].dueDate).toBe(dueDate);
    expect((data.items[0] as WorkItem).unmapped.find((u) => u.field === 'dueDate')?.reason ?? null).toBe(reason);
  });

  it("says an Azure DevOps history state is a custom one, not Jira's changelog", async () => {
    const rev = (rev: number, state: string, at: string) => ({ id: 9, rev, fields: { 'System.State': state, 'System.ChangedDate': at } });
    const input = [env('ado work-item get', { id: 9, fields: { 'System.Title': 'T', 'System.State': 'Blocked', 'System.WorkItemType': 'Task' } }), env('ado work-item history', [rev(1, 'New', '2026-10-05T09:00:00Z'), rev(2, 'Blocked', '2026-10-06T09:00:00Z')])];
    const { data } = await map({ text: json(input) });
    const item = data.items[0] as WorkItem;
    expect(item.history!.transitions.map((t) => [t.from, t.to, t.toCategory])).toEqual([[null, 'New', 'TODO'], ['New', 'Blocked', 'UNKNOWN']]);
    const reason = item.unmapped.find((u) => u.field === 'history.transitions')!.reason;
    expect(reason).toContain('ado work-item states');
    expect(reason).not.toContain('Jira');
  });

  it('splits API input with the same predicate as the CLI', async () => {
    const { inputValues } = await import('../src/core/owi/index.js');
    const api = await import('../src/api.js');
    const wrapped = [{ key: 'PAY-104', history: env('jira issue history', []) }, env('jira issue search', { issues: [] })];
    expect(inputValues(wrapped)).toHaveLength(2);
    expect(parseOwiInput(json(wrapped))).toHaveLength(2);
    expect(api.mapOwi(wrapped).histories).toEqual([{ id: 'jira:PAY-104', history: { transitions: [], iterations: [] } }]);
    expect(inputValues([{ number: 1 }])).toEqual([[{ number: 1 }]]);
  });
});

describe('GitHub without a board (#298): milestones, estimate labels and body links', () => {
  const REPO = 'imagile/payments-sandbox';
  const id = (n: number) => `github:${REPO}#${n}`;
  const inputs = { owner: 'imagile', repo: 'payments-sandbox' };
  const list = env('github issue list', boardlessIssues, 'github', inputs);
  const histories = Object.entries(boardlessTimelines).map(([n, events]) => ({ key: n, history: env('github issue history', events, 'github', inputs) }));
  const ghIssue = (number: number, extra: Record<string, unknown> = {}) => ({ number, title: `Issue ${number}`, state: 'open', html_url: `https://github.com/${REPO}/issues/${number}`, labels: [], body: '', ...extra });
  const milestone = (number: number, title: string, due: string | null, state = 'open') => ({ number, title, state, due_on: due });
  const one = (issue: Record<string, unknown>) => env('github issue get', issue, 'github');

  it('maps the captured repository: every item valid, nothing skipped', async () => {
    const { data } = await map({ text: json([list, ...histories]) });
    expect(data.count).toBe(12);
    expect(data.skipped).toEqual([]);
    expect(data.verified.passed).toBe(true);
  });

  it("takes each issue's milestone as its iteration, starting where the previous one ended", async () => {
    const { data } = await map({ text: json([list]) });
    const items = data.items as WorkItem[];
    expect(byId(items, id(7)).iteration).toEqual({ id: '2', name: 'Sprint 42', path: null, start: '2026-10-12T00:00:00.000Z', end: '2026-10-26T00:00:00.000Z', state: null });
    expect(byId(items, id(1)).iteration).toEqual({ id: '1', name: 'Sprint 41', path: null, start: '2026-09-28T00:00:00.000Z', end: '2026-10-12T00:00:00.000Z', state: 'past' });
    expect(byId(items, id(17)).iteration).toMatchObject({ name: 'Sprint 43', start: '2026-10-26T00:00:00.000Z', end: '2026-11-09T00:00:00.000Z' });
    const backlog = byId(items, id(23));
    expect(backlog.iteration).toBeNull();
    expect(backlog.unmapped.find((u) => u.field === 'iteration')!.reason).toContain('no milestone');
  });

  it('runs every milestone iterationDays to its due date when the toil project says how long sprints are', async () => {
    const { data } = await map({ text: json([list]), field: ['iterationDays=10'] });
    expect(byId(data.items, id(7)).iteration).toMatchObject({ start: '2026-10-16T00:00:00.000Z', end: '2026-10-26T00:00:00.000Z' });
  });

  it('reads a milestone with no due date as an iteration with no dates, and keeps repositories apart', async () => {
    const other = env('github issue list', [{ ...ghIssue(3, { milestone: milestone(1, 'Sprint 42', '2026-11-30T00:00:00Z') }), html_url: 'https://github.com/imagile/other/issues/3' }], 'github');
    const { data } = await map({ text: json([list, other, one(ghIssue(90, { milestone: milestone(9, 'Someday', null) }))]) });
    expect(byId(data.items, id(90)).iteration).toEqual({ id: '9', name: 'Someday', path: null, start: null, end: null, state: null });
    // The other repository's only milestone starts 14 days before its end, not at this one's Sprint 41.
    expect(byId(data.items, 'github:imagile/other#3').iteration).toMatchObject({ start: '2026-11-16T00:00:00.000Z', end: '2026-11-30T00:00:00.000Z' });
  });

  it('reads a points label as the estimate, and says why an issue has none', async () => {
    const { data } = await map({ text: json([list]) });
    expect(byId(data.items, id(7)).estimate).toEqual({ value: 8, unit: 'points', field: 'label:points: 8' });
    const none = byId(data.items, id(15));
    expect(none.estimate).toBeNull();
    expect(none.unmapped.find((u) => u.field === 'estimate')!.reason).toContain('no label holds an estimate ("points: N"');
  });

  it.each([
    ['Story Points: 5', 5],
    ['SP=2', 2],
    ['estimate/0.5', 0.5],
    ['pts 13', 13],
    ['size: M', null],
    ['points: many', null],
    ['blocked', null],
  ])('reads the label %s as %s points by default', async (label, value) => {
    const { data } = await map({ text: json(one(ghIssue(1, { labels: [{ name: label }] }))) });
    expect(data.items[0].estimate?.value ?? null).toBe(value);
  });

  it("reads the toil project's own estimateLabel, literally, and lists two estimate labels rather than pick one", async () => {
    const own = await map({ text: json(one(ghIssue(1, { labels: [{ name: 'Size/3' }, { name: 'points: 8' }] }))), field: ['estimateLabel=size/{n}', 'estimateUnit=days'] });
    expect(own.data.items[0].estimate).toEqual({ value: 3, unit: 'days', field: 'label:Size/3' });
    const literal = await map({ text: json(one(ghIssue(1, { labels: [{ name: 'sizeX3' }] }))), field: ['estimateLabel=size.{n}'] });
    expect(literal.data.items[0].estimate).toBeNull();
    const two = await map({ text: json(one(ghIssue(1, { labels: [{ name: 'points: 3' }, { name: 'sp: 5' }] }))) });
    expect(two.data.items[0].estimate).toBeNull();
    expect((two.data.items[0] as WorkItem).unmapped.find((u) => u.field === 'estimate')!.reason).toBe('2 labels hold an estimate ("points: 3", "sp: 5"), so none was picked: keep one');
  });

  it('refuses an estimateLabel without exactly one {n}, and an iterationDays that is not a number of days', () => {
    expect(() => fieldOverrides(['estimateLabel=points'])).toThrow(/exactly once/);
    expect(() => fieldOverrides(['estimateLabel={n}/{n}'])).toThrow(/exactly once/);
    for (const days of ['0', '2.5', 'two weeks', '400']) expect(() => fieldOverrides([`iterationDays=${days}`]), days).toThrow(/whole number of days/);
    expect(fieldOverrides({ estimateLabel: 'size/{n}', iterationDays: '10' })).toEqual({ estimateLabel: 'size/{n}', iterationDays: '10' });
  });

  it('links "Blocked by #n" both ways, and the four blocked chains are there', async () => {
    const { data } = await map({ text: json([list]) });
    const items = data.items as WorkItem[];
    expect(byId(items, id(8)).links).toEqual([{ type: 'blocks', direction: 'inward', target: id(7), name: 'blocked by' }]);
    expect(byId(items, id(7)).links).toEqual([{ type: 'blocks', direction: 'outward', target: id(8), name: 'blocks' }]);
    const pairs = items.flatMap((i) => i.links.filter((l) => l.direction === 'outward').map((l) => `${i.source.key} -> ${l.target.slice(l.target.indexOf('#'))}`)).sort();
    expect(pairs).toEqual([`${REPO}#1 -> #20`, `${REPO}#11 -> #12`, `${REPO}#17 -> #18`, `${REPO}#7 -> #8`]);
  });

  it('reads lists, other repositories, Depends on and Blocks, and skips code, itself and repeats', async () => {
    const body = 'Blocked by #2, #3 and imagile/api#4.\nDepends on: #5\nThis blocks #6 & #7.\n\n`Blocked by #8` and\n```\nBlocked by #9\n```\nBlocked by #1, and again #2.';
    const { data } = await map({ text: json(one(ghIssue(1, { body }))) });
    expect((data.items[0] as WorkItem).links.map((l) => [l.direction, l.target, l.name])).toEqual([
      ['inward', id(2), 'blocked by'],
      ['inward', id(3), 'blocked by'],
      ['inward', 'github:imagile/api#4', 'blocked by'],
      ['inward', id(5), 'depends on'],
      ['outward', id(6), 'blocks'],
      ['outward', id(7), 'blocks'],
    ]);
  });

  it('reads a body of 64k spaces after "blocks" in linear time (review round 1)', () => {
    const body = `blocks${' '.repeat(65_000)}x blocked by${' '.repeat(65_000)}: ${' '.repeat(65_000)}#3`;
    const started = performance.now();
    expect(bodyLinks('github', `${REPO}#1`, body)).toEqual([{ type: 'blocks', direction: 'inward', target: id(3), name: 'blocked by' }]);
    // Quadratic, this took about 6 s for one run of spaces; linear, it is a few milliseconds.
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("says when GitHub's own issue dependencies hold links no command reads yet", async () => {
    const { data } = await map({ text: json(one(ghIssue(1, { issue_dependencies_summary: { blocked_by: 1, total_blocked_by: 1, blocking: 0, total_blocking: 2 } }))) });
    expect((data.items[0] as WorkItem).unmapped.find((u) => u.field === 'links')!.reason).toContain('1 blocked-by and 2 blocking issue dependencies');
  });

  it('reads milestoned and demilestoned as iteration changes, a move between milestones as one', async () => {
    const { data } = await map({ text: json([list, ...histories]) });
    expect(byId(data.items, id(5)).history!.iterations).toEqual([{ from: [], to: ['Sprint 41'], at: '2026-10-19T22:02:31.000Z', by: { id: 'octo-dev', name: null, email: null } }]);
    const moved = [
      { event: 'demilestoned', created_at: '2026-10-13T09:00:00Z', milestone: { title: 'Sprint 41' } },
      { event: 'milestoned', created_at: '2026-10-13T09:00:00Z', milestone: { title: 'Sprint 42' } },
      { event: 'demilestoned', created_at: '2026-10-14T09:00:00Z', milestone: { title: 'Sprint 42' } },
    ];
    const carried = await map({ text: json([one(ghIssue(5)), { key: `${REPO}#5`, history: env('github issue history', moved, 'github') }]) });
    expect(carried.data.items[0].history.iterations.map((c: Data) => [c.from, c.to])).toEqual([[['Sprint 41'], ['Sprint 42']], [['Sprint 42'], []]]);
  });

  it("lets a board's values win, and keeps the issue's own where the board has none", async () => {
    const issue = ghIssue(4, { milestone: milestone(2, 'Sprint 42', '2026-10-26T00:00:00Z'), labels: [{ name: 'points: 3' }] });
    const item = (fieldValues: unknown[]) => ({ id: 'PVTI_4', type: 'ISSUE', content: { number: 4, title: 'Issue 4', state: 'OPEN', url: issue.html_url, repository: { nameWithOwner: REPO } }, fieldValues });
    const valued = item([
      { __typename: 'ProjectV2ItemFieldNumberValue', number: 5, field: { name: 'Estimate' } },
      { __typename: 'ProjectV2ItemFieldIterationValue', title: 'Iteration 7', iterationId: 'abc12345', startDate: '2026-10-05', duration: 14, field: { name: 'Iteration' } },
    ]);
    const board = await map({ text: json([one(issue), env('github project items', [valued], 'github', { owner: 'imagile' })]) });
    expect(board.data.items[0]).toMatchObject({ estimate: { value: 5, field: 'Estimate' }, iteration: { name: 'Iteration 7' } });
    expect((board.data.items[0] as WorkItem).unmapped.map((u) => u.field)).toEqual(['type']);
    const empty = await map({ text: json([one(issue), env('github project items', [item([])], 'github', { owner: 'imagile' })]) });
    expect(empty.data.items[0]).toMatchObject({ estimate: { value: 3, field: 'label:points: 3' }, iteration: { name: 'Sprint 42' } });
    expect((empty.data.items[0] as WorkItem).unmapped.map((u) => u.field)).toEqual(['type']);
  });
});
