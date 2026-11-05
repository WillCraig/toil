import { afterEach, describe, expect, it } from 'vitest';
import { commandName, type AnyCommand } from '../src/core/command.js';
import type { Envelope } from '../src/core/envelope.js';
import { execute } from '../src/core/run.js';
import { adoMoves, resolveTransition, type TransitionCandidate } from '../src/core/transition-intent.js';
import { areas, commands } from '../src/registry.js';
import { config as adoConfig, ADO } from './fixtures/ado.fixture.js';
import { config as adoCloudConfig, ORG_URL } from './fixtures/ado-cloud-data.js';
import { config as jiraCloudConfig, SITE } from './fixtures/jira-cloud-data.js';
import { config as jiraConfig, JIRA } from './fixtures/jira.fixture.js';
import { testContext } from './harness/context.js';
import { toilProjectDisk, type ToilProjectDisk } from './harness/toil-projects.js';
import type { RecordedRequest, Route } from './harness/fake-fetch.js';

/**
 * Transitions by intent (#302) on all four work-item areas, against payloads
 * shaped like each service's own: a Jira Story whose workflow has a review
 * step beside a Task whose workflow hasn't, and Azure DevOps' Agile and Scrum
 * processes, whose state categories disagree about whether review exists at
 * all. Every case checks the requests sent, so a resolution that reads more
 * than it should, or writes before it has decided, fails here. None of these
 * payloads has met a live server; they are invented from the vendors' docs.
 */

const cmd = (name: string): AnyCommand => commands.find((d) => commandName(d) === name)!;
const write = { allowWrite: true };
const disks: ToilProjectDisk[] = [];
afterEach(() => disks.splice(0).forEach((d) => d.cleanup()));
const toilProjectAreas = areas.map((a) => ({ name: a.name, context: Object.keys(a.context) }));

async function run(name: string, input: Record<string, unknown>, routes: Route[], config: Record<string, Record<string, unknown>>, toilProject?: Record<string, unknown>) {
  const d = toilProject ? toilProjectDisk({ [`home/.toil/projects/${String(toilProject.name)}.json`]: toilProject }) : undefined;
  if (d) disks.push(d);
  const t = testContext({ config, routes, ...(d ? { toilProjects: (c) => d.catalog(c, { areas: toilProjectAreas }) } : {}) });
  const envelope = await execute(cmd(name), d ? { ...input, toilProject: String(toilProject!.name) } : input, t.context);
  return { envelope, calls: t.http.calls };
}

const sent = (calls: RecordedRequest[]) => calls.map((c) => `${c.method} ${decodeURIComponent(c.url)}${c.body ? ` ${c.body}` : ''}`);

// ---- Jira: Data Center and Cloud share the issue shape; only the API path differs.

const cat = { new: { id: 2, key: 'new', name: 'To Do' }, indeterminate: { id: 4, key: 'indeterminate', name: 'In Progress' }, done: { id: 3, key: 'done', name: 'Done' } };
const status = (name: string, category: keyof typeof cat) => ({ name, id: String(name.length), statusCategory: cat[category] });
const move = (id: string, name: string, to: string, category: keyof typeof cat) => ({ id, name, to: status(to, category) });

/** GET issue/{key}?fields=issuetype,status&expand=transitions, as Jira answers it. */
const issueWith = (key: string, type: string, now: ReturnType<typeof status>, transitions: ReturnType<typeof move>[]) => ({ expand: 'transitions', id: '10123', key, fields: { issuetype: { id: '10001', name: type }, status: now }, transitions });

/** A Story: In Progress, then In Review, then Done. */
const STORY = issueWith('PROJ-1', 'Story', status('In Progress', 'indeterminate'), [
  move('41', 'Submit for Review', 'In Review', 'indeterminate'),
  move('31', 'Done', 'Done', 'done'),
  move('11', 'Stop Progress', 'To Do', 'new'),
]);
/** A Task: In Progress, then straight to Done. */
const TASK = issueWith('PROJ-2', 'Task', status('In Progress', 'indeterminate'), [move('31', 'Done', 'Done', 'done'), move('11', 'Stop Progress', 'To Do', 'new')]);

for (const variant of [
  { label: 'jira', area: 'jira', base: `${JIRA}/rest/api/2`, config: jiraConfig },
  { label: 'jira on Cloud', area: 'jira', base: `${SITE}/rest/api/3`, config: jiraCloudConfig },
] as const) {
  const routesFor = (issue: ReturnType<typeof issueWith>): Route[] => [
    { path: new URL(`${variant.base}/issue/${issue.key}`).pathname, query: { fields: 'issuetype,status', expand: 'transitions' }, respond: { json: issue } },
    { method: 'POST', path: new URL(`${variant.base}/issue/${issue.key}/transitions`).pathname, respond: { status: 204 } },
  ];
  const transition = (input: Record<string, unknown>, issue: ReturnType<typeof issueWith>, toilProject?: Record<string, unknown>) =>
    run(`${variant.area} issue transition`, { key: issue.key, ...write, ...input }, routesFor(issue), variant.config, toilProject);
  const read = (key: string) => `GET ${variant.base}/issue/${key}?fields=issuetype,status&expand=transitions`;

  describe(`${variant.label} issue transition --to`, () => {
    it('review moves a Story into its review status, by the transition named for it', async () => {
      const { envelope, calls } = await transition({ to: 'review' }, STORY);
      expect(sent(calls)).toEqual([read('PROJ-1'), `POST ${variant.base}/issue/PROJ-1/transitions {"transition":{"id":"41"}}`]);
      expect(envelope.data).toEqual({ transitioned: 'PROJ-1', transition: 'Submit for Review' });
      // Jira files In Review under In Progress; its name says review, so it serves review.
      expect(envelope.meta.transition).toEqual({ intent: 'review', transition: 'Submit for Review', toStatus: 'In Review', resolvedBy: 'category' });
    });

    it('start sends an issue in review back to work, and review from In Review is already there', async () => {
      const reviewed = issueWith('PROJ-9', 'Story', status('In Review', 'indeterminate'), [move('51', 'Back to In Progress', 'In Progress', 'indeterminate'), move('31', 'Done', 'Done', 'done')]);
      const back = await transition({ to: 'start' }, reviewed);
      expect(back.calls.at(-1)!.body).toBe('{"transition":{"id":"51"}}');
      expect(back.envelope.meta.transition).toEqual({ intent: 'start', transition: 'Back to In Progress', toStatus: 'In Progress', resolvedBy: 'category' });
      const again = await transition({ to: 'review' }, reviewed);
      expect(again.envelope.error?.message).toBe('PROJ-9 (Story, now In Review) is already In Review, a status in the category "review" leads to.');
    });

    it('review is refused on a Task with no review state, the fix listing what the Task can do, and nothing is written', async () => {
      const { envelope, calls } = await transition({ to: 'review' }, TASK);
      expect(sent(calls)).toEqual([read('PROJ-2')]);
      expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'PROJ-2 (Task, now In Progress) has no transition for "review".' });
      expect(envelope.error!.fix).toBe(
        `PROJ-2 (Task, now In Progress) offers: Done [Done] id 31; Stop Progress (to To Do) [To Do] id 11. Pass one of them with --to <status>, or --transition <name-or-id>, or pin it for Task in the toil project as ${variant.area}.transitions."Task".review.`,
      );
      expect(envelope.meta.transition).toBeUndefined();
    });

    it('done resolves by status category on both, the same word landing on each workflow', async () => {
      for (const issue of [STORY, TASK]) {
        const { envelope, calls } = await transition({ to: 'done' }, issue);
        expect(calls.at(-1)!.body).toBe('{"transition":{"id":"31"}}');
        // "Done" is also a status name, so the exact name answers first.
        expect(envelope.meta.transition).toMatchObject({ toStatus: 'Done', resolvedBy: 'status' });
      }
      const closed = issueWith('PROJ-3', 'Bug', status('In Progress', 'indeterminate'), [move('51', 'Resolve', 'Resolved', 'done'), move('11', 'Stop Progress', 'To Do', 'new')]);
      const { envelope } = await transition({ to: 'done' }, closed);
      expect(envelope.meta.transition).toEqual({ intent: 'done', transition: 'Resolve', toStatus: 'Resolved', resolvedBy: 'category' });
    });

    it('start resolves by category from To Do, and is refused, without a write, on an issue already in progress', async () => {
      const todo = issueWith('PROJ-4', 'Story', status('To Do', 'new'), [move('21', 'Start Progress', 'In Progress', 'indeterminate')]);
      expect((await transition({ to: 'start' }, todo)).envelope.meta.transition).toMatchObject({ transition: 'Start Progress', resolvedBy: 'category' });
      const { envelope, calls } = await transition({ to: 'start' }, STORY);
      expect(calls).toHaveLength(1);
      expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'PROJ-1 (Story, now In Progress) is already In Progress, a status in the category "start" leads to.' });
    });

    it('two moves into the done category are narrowed by name, and refused when the name does not settle it', async () => {
      const wontDo = issueWith('PROJ-5', 'Story', status('In Review', 'indeterminate'), [move('31', 'Mark Done', 'Closed', 'done'), move('61', "Won't Do", 'Rejected', 'done')]);
      expect((await transition({ to: 'done' }, wontDo)).envelope.meta.transition).toEqual({ intent: 'done', transition: 'Mark Done', toStatus: 'Closed', resolvedBy: 'name' });
      const twoWays = issueWith('PROJ-6', 'Bug', status('In Progress', 'indeterminate'), [move('51', 'Resolve', 'Resolved', 'done'), move('71', 'Close', 'Closed', 'done')]);
      const { envelope, calls } = await transition({ to: 'done' }, twoWays);
      expect(calls).toHaveLength(1);
      expect(envelope.error).toMatchObject({
        code: 'INVALID_INPUT',
        message: '"done" is ambiguous for PROJ-6 (Bug, now In Progress): more than one move leads into its status category: Resolve, Close.',
        fix: expect.stringContaining('Resolve (to Resolved) [Done] id 51; Close (to Closed) [Done] id 71'),
      });
    });

    it('a status name resolves exactly, case-insensitively; one the issue has no move into is refused', async () => {
      expect((await transition({ to: 'in review' }, STORY)).envelope.meta.transition).toEqual({ intent: 'in review', transition: 'Submit for Review', toStatus: 'In Review', resolvedBy: 'status' });
      const { envelope } = await transition({ to: 'Shipped' }, STORY);
      expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'PROJ-1 (Story, now In Progress) has no transition for "Shipped".' });
      // A status name isn't an intent, so there's nothing to pin for it.
      expect(envelope.error!.fix).not.toContain('pin it');
    });

    it("the toil project's pin for the issue type wins over every other rule, and a pin naming nothing the issue offers is refused", async () => {
      const peer = issueWith('PROJ-7', 'Story', status('In Progress', 'indeterminate'), [move('41', 'Submit for Review', 'In Review', 'indeterminate'), move('81', 'Peer Review', 'Peer Review', 'indeterminate')]);
      const toilProject = { name: 'payments', [variant.area]: { transitions: { story: { review: 'Peer Review' } } } };
      const pinned = await transition({ to: 'review' }, peer, toilProject);
      expect(pinned.calls.at(-1)!.body).toBe('{"transition":{"id":"81"}}');
      expect(pinned.envelope.meta.transition).toEqual({ intent: 'review', transition: 'Peer Review', toStatus: 'Peer Review', resolvedBy: 'toil-project' });
      // Without the pin, two moves are named for review, and that's refused.
      expect((await transition({ to: 'review' }, peer)).envelope.error?.message).toBe('"review" is ambiguous for PROJ-7 (Story, now In Progress): more than one move leads into its status category: Submit for Review, Peer Review.');
      const stale = await transition({ to: 'review' }, STORY, toilProject);
      expect(stale.calls).toHaveLength(1);
      expect(stale.envelope.error).toMatchObject({
        code: 'INVALID_INPUT',
        message: 'The toil project pins review for Story to "Peer Review", but PROJ-1 (Story, now In Progress) offers no transition or status by that name.',
        fix: expect.stringContaining(`Correct ${variant.area}.transitions."Story".review in the toil project`),
      });
    });

    it("an environment's pins land over the area's own, type by type", async () => {
      const peer = issueWith('PROJ-8', 'Story', status('In Progress', 'indeterminate'), [move('41', 'Submit for Review', 'In Review', 'indeterminate'), move('81', 'Peer Review', 'Peer Review', 'indeterminate')]);
      const toilProject = {
        name: 'payments',
        env: 'prod',
        // Spelled differently from the environment's, since types compare ignoring case.
        [variant.area]: { transitions: { story: { review: 'Submit for Review' } } },
        environments: { prod: { [variant.area]: { transitions: { Story: { review: 'Peer Review' } } } } },
      };
      expect((await transition({ to: 'review' }, peer, toilProject)).envelope.meta.transition).toMatchObject({ transition: 'Peer Review', resolvedBy: 'toil-project' });
    });

    it('--transition keeps working as it did, and giving both or neither is refused before anything is sent', async () => {
      const byId = await transition({ transition: '31' }, STORY);
      expect(sent(byId.calls)).toEqual([`POST ${variant.base}/issue/PROJ-1/transitions {"transition":{"id":"31"}}`]);
      expect(byId.envelope.data).toEqual({ transitioned: 'PROJ-1', transition: '31' });
      expect(byId.envelope.meta.transition).toBeUndefined();
      for (const input of [{}, { transition: '31', to: 'done' }]) {
        const { envelope, calls } = await transition(input, STORY);
        expect(calls).toEqual([]);
        expect(envelope.error?.code).toBe('INVALID_INPUT');
      }
    });

    it('the write gate holds before the resolving read: writes off sends nothing', async () => {
      const off = Object.fromEntries(Object.entries(variant.config as Record<string, Record<string, unknown>>).map(([name, settings]) => [name, { ...settings, writes: false }]));
      const { envelope, calls } = await run(`${variant.area} issue transition`, { key: 'PROJ-1', to: 'review', ...write }, routesFor(STORY), off);
      expect(envelope.error?.code).toBe('WRITE_DISABLED');
      expect(calls).toEqual([]);
    });
  });
}

// ---- Azure DevOps: Server and Services read the same states; only the paths differ.

const AGILE_STORY = [
  { name: 'New', color: 'b2b2b2', category: 'Proposed' },
  { name: 'Active', color: '007acc', category: 'InProgress' },
  { name: 'Resolved', color: 'ff9d00', category: 'Resolved' },
  { name: 'Closed', color: '339933', category: 'Completed' },
  { name: 'Removed', color: 'ffffff', category: 'Removed' },
];
const SCRUM_PBI = [
  { name: 'New', color: 'b2b2b2', category: 'Proposed' },
  { name: 'Approved', color: '5688e0', category: 'Proposed' },
  { name: 'Committed', color: '007acc', category: 'InProgress' },
  { name: 'Done', color: '339933', category: 'Completed' },
  { name: 'Removed', color: 'ffffff', category: 'Removed' },
];

const workItem = (id: number, type: string, state: string, project = 'Imagile') => ({ id, rev: 3, fields: { 'System.WorkItemType': type, 'System.State': state, 'System.TeamProject': project }, url: `${ADO}/_apis/wit/workItems/${id}` });

for (const variant of [
  { label: 'ado', area: 'ado', items: `${ADO}/DefaultCollection/_apis/wit/workitems`, types: (p: string) => `${ADO}/DefaultCollection/${p}/_apis/wit/workitemtypes`, version: '7.1', input: { collection: 'DefaultCollection', project: 'Imagile' }, config: adoConfig },
  { label: 'ado on Services', area: 'ado', cloud: true, items: `${ORG_URL}/_apis/wit/workitems`, types: (p: string) => `${ORG_URL}/${p}/_apis/wit/workitemtypes`, version: '7.1', input: {}, config: adoCloudConfig },
] as const) {
  const routesFor = (item: ReturnType<typeof workItem>, states: typeof AGILE_STORY): Route[] => [
    { path: new URL(`${variant.items}/${item.id}`).pathname, query: { 'api-version': variant.version, fields: 'System.WorkItemType,System.State,System.TeamProject' }, respond: { json: item } },
    { path: new URL(`${variant.types(String(item.fields['System.TeamProject']))}/${encodeURIComponent(item.fields['System.WorkItemType'])}/states`).pathname, query: { 'api-version': variant.version }, respond: { json: { count: states.length, value: states } } },
    { method: 'PATCH', path: new URL(`${variant.items}/${item.id}`).pathname, respond: (r) => ({ json: { ...item, rev: 4, fields: { ...item.fields, 'System.State': (JSON.parse(r.body!) as Array<{ value: string }>)[0]!.value } } }) },
  ];
  const transition = (input: Record<string, unknown>, item: ReturnType<typeof workItem>, states: typeof AGILE_STORY, toilProject?: Record<string, unknown>) =>
    run(`${variant.area} work-item transition`, { ...variant.input, id: 'cloud' in variant ? item.id : String(item.id), ...write, ...input }, routesFor(item, states), variant.config, toilProject);

  describe(`${variant.label} work-item transition --to`, () => {
    it('review on an Agile User Story lands in Resolved, by state category, reading the type in its own project', async () => {
      const story = workItem(42, 'User Story', 'Active', 'Payments');
      const { envelope, calls } = await transition({ to: 'review' }, story, AGILE_STORY);
      expect(sent(calls)).toEqual([
        `GET ${variant.items}/42?api-version=7.1&fields=System.WorkItemType,System.State,System.TeamProject`,
        `GET ${variant.types('Payments')}/User Story/states?api-version=7.1`,
        `PATCH ${variant.items}/42?api-version=7.1 [{"op":"add","path":"/fields/System.State","value":"Resolved"}]`,
      ]);
      expect((envelope.data as { fields: Record<string, unknown> }).fields['System.State']).toBe('Resolved');
      expect(envelope.meta.transition).toEqual({ intent: 'review', transition: 'Resolved', toStatus: 'Resolved', resolvedBy: 'category' });
    });

    it('review on a Scrum Product Backlog Item, which has no Resolved state, is refused with the states it has', async () => {
      const pbi = workItem(43, 'Product Backlog Item', 'Committed');
      const { envelope, calls } = await transition({ to: 'review' }, pbi, SCRUM_PBI);
      expect(calls.map((c) => c.method)).toEqual(['GET', 'GET']);
      expect(envelope.error).toMatchObject({
        code: 'INVALID_INPUT',
        message: 'work item 43 (Product Backlog Item, now Committed) has no transition for "review".',
        fix: 'work item 43 (Product Backlog Item, now Committed) offers: New [Proposed]; Approved [Proposed]; Done [Completed]; Removed [Removed]. Pass one of them with --to <status>, or --state <state>, or pin it for Product Backlog Item in the toil project as ' + `${variant.area}.transitions."Product Backlog Item".review.`,
      });
    });

    it('done finds Closed on Agile and Done on Scrum', async () => {
      expect((await transition({ to: 'done' }, workItem(42, 'User Story', 'Resolved'), AGILE_STORY)).envelope.meta.transition).toMatchObject({ toStatus: 'Closed', resolvedBy: 'category' });
      expect((await transition({ to: 'done' }, workItem(43, 'Product Backlog Item', 'Committed'), SCRUM_PBI)).envelope.meta.transition).toMatchObject({ toStatus: 'Done', resolvedBy: 'status' });
    });

    it("reopen on Scrum is ambiguous between New and Approved, and the toil project's pin settles it", async () => {
      const pbi = workItem(43, 'Product Backlog Item', 'Done');
      const { envelope, calls } = await transition({ to: 'reopen' }, pbi, SCRUM_PBI);
      expect(calls.map((c) => c.method)).toEqual(['GET', 'GET']);
      expect(envelope.error?.message).toBe('"reopen" is ambiguous for work item 43 (Product Backlog Item, now Done): more than one move leads into its status category: New, Approved.');
      const pinned = await transition({ to: 'reopen' }, pbi, SCRUM_PBI, { name: 'payments', [variant.area]: { transitions: { 'Product Backlog Item': { reopen: 'New' } } } });
      expect(pinned.calls.at(-1)!.body).toBe('[{"op":"add","path":"/fields/System.State","value":"New"}]');
      expect(pinned.envelope.meta.transition).toEqual({ intent: 'reopen', transition: 'New', toStatus: 'New', resolvedBy: 'toil-project' });
    });

    it('an item already in the intent\'s category is refused, and --state still sets a state with no read', async () => {
      const resolved = await transition({ to: 'review' }, workItem(42, 'User Story', 'Resolved'), AGILE_STORY);
      expect(resolved.envelope.error?.message).toBe('work item 42 (User Story, now Resolved) is already Resolved, a status in the category "review" leads to.');
      const exact = await transition({ state: 'Closed' }, workItem(42, 'User Story', 'Resolved'), AGILE_STORY);
      expect(exact.calls.map((c) => c.method)).toEqual(['PATCH']);
      expect(exact.envelope.meta.transition).toBeUndefined();
      const neither = await transition({}, workItem(42, 'User Story', 'Resolved'), AGILE_STORY);
      expect(neither.calls).toEqual([]);
      expect(neither.envelope.error?.code).toBe('INVALID_INPUT');
    });
  });
}

// ---- The resolver itself.

describe('resolveTransition', () => {
  const help = { explicit: '--transition <name-or-id>', pinKey: 'jira.transitions' };
  const item = { label: 'PROJ-1', type: 'Story', status: 'In Progress', statusIntent: 'start' as const };
  const c = (name: string, toStatus: string, intent?: TransitionCandidate['intent']): TransitionCandidate => ({ id: name, name, toStatus, intent });

  it('is deterministic: the same moves in any order give the same answer or the same refusal', () => {
    const moves = [c('Submit for Review', 'In Review', 'start'), c('Done', 'Done', 'done'), c('Back', 'To Do', 'reopen')];
    const forward = resolveTransition('review', item, moves, {}, help);
    const backward = resolveTransition('review', item, [...moves].reverse(), {}, help);
    expect(backward.report).toEqual(forward.report);
  });

  it("reads a category only as one of the service's own: a category named constructor serves no intent", () => {
    const { candidates } = adoMoves(1, { 'System.WorkItemType': 'Bug', 'System.State': 'New' }, [
      { name: 'New', category: 'Proposed' },
      { name: 'Odd', category: 'constructor' },
    ]);
    expect(candidates).toEqual([{ id: 'Odd', name: 'Odd', toStatus: 'Odd', category: 'constructor', intent: undefined }]);
  });

  it('matches a word at its start only, so Undone is not done', () => {
    expect(() => resolveTransition('done', { ...item, statusIntent: undefined }, [c('Mark Undone', 'Undone')], {}, help)).toThrow('has no transition for "done"');
  });

  it('a category narrowed by name to two is still ambiguous, never the first of them', () => {
    const moves = [c('Mark Done', 'Closed', 'done'), c("Done, Won't Fix", 'Rejected', 'done')];
    expect(() => resolveTransition('done', item, moves, {}, help)).toThrow("more than one move leads into its status category: Mark Done, Done, Won't Fix");
  });

  it('two transitions into one status by an exact name are ambiguous, not a pick', () => {
    expect(() => resolveTransition('Done', item, [c('Done', 'Done', 'done'), c('Close', 'Done', 'done')], {}, help)).toThrow('more than one move goes by that name: Done, Close');
  });
});

describe('toil project transitions', () => {
  it('a pin of the wrong shape, or for a word that is not an intent, is TOIL_PROJECT_INVALID with its key path', async () => {
    const d = toilProjectDisk({ 'home/.toil/projects/p.json': { name: 'p', jira: { transitions: { Story: { review: '', ship: 'Done' }, Task: 'Done' } } } });
    disks.push(d);
    const t = testContext({ config: jiraConfig, routes: [], toilProjects: (c) => d.catalog(c, { areas: toilProjectAreas }) });
    const envelope: Envelope = await execute(cmd('projects check'), { toilProject: 'p' }, t.context);
    const problems = (envelope.data as { problems: Array<{ path: string; message: string }> }).problems;
    expect(problems.map((p) => p.path)).toEqual(['jira.transitions.Story.review', 'jira.transitions.Story.ship', 'jira.transitions.Task']);
    expect(problems[1]!.message).toBe('"ship" isn\'t an intent: pin one of start, review, done, reopen.');
  });
});
