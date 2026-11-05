// @vitest-environment node
/**
 * The Azure DevOps seed (ui/scripts/ado-seed/) end to end, offline: the
 * generated OWI file, apply.mjs and cleanup.mjs against an organization in
 * memory (test/ado-board.ts), and then toil's own ado commands and
 * `mapOwi` reading that board back, compared with the file the board was
 * seeded from. Then Toil UI's loader on a Services toil project. The live run
 * this rehearses is in the PR (#319); this is the version that runs on a
 * plane.
 */

import { execute, mapOwi } from '@imagile-dev/toil/api';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { client, createPatch, findSeeded, missingLinks, seedKey, TITLE_PREFIX } from '../scripts/ado-seed/ado.mjs';
import { apply, inOrder } from '../scripts/ado-seed/apply.mjs';
import { cleanup, confirmationCode } from '../scripts/ado-seed/cleanup.mjs';
import { compare } from '../scripts/ado-seed/compare.mjs';
import { ANCHOR, check, DEFAULT_OUT, DEFAULT_SEED, generate, render, type SeedRecord } from '../scripts/ado-seed/generate.mjs';
import { READ_COMMANDS } from '../server/store.ts';
import { loadToilProject } from '../src/load.ts';
import { proposeMove } from '../src/model/board.ts';
import type { Execute, WorkItem } from '../src/toil.ts';
import { adoBoard, ORG, PROJECT, type Board } from './ado-board.ts';

const items = generate();
const after = () => Date.parse(ANCHOR) + 86_400_000;
const seed = async (board: Board, options: Partial<Parameters<typeof apply>[0]> = {}) =>
  apply({ items, api: client({ baseUrl: ORG, pat: 'test-pat', project: PROJECT, fetch: board.fetch }), now: after, ...options });

describe('items.owi.json', () => {
  it('is what the committed seed generates, and every record validates against the OWI schema', () => {
    expect(readFileSync(DEFAULT_OUT, 'utf8').replace(/\r\n/g, '\n')).toBe(render(generate(DEFAULT_SEED), DEFAULT_SEED));
    expect(check(items)).toEqual([]);
  });

  it('holds about 45 items across the three sample products, of every Scrum type, in a mix of states and sprints', () => {
    const count = (f: (r: SeedRecord) => string) => items.reduce<Record<string, number>>((m, r) => ({ ...m, [f(r)]: (m[f(r)] ?? 0) + 1 }), {});
    expect(items).toHaveLength(45);
    expect(count((r) => r.native['ado-seed generate'].product)).toEqual({ 'card-payments': 15, settlement: 15, 'checkout-web': 15 });
    expect(Object.keys(count((r) => r.typeName)).sort()).toEqual(['Bug', 'Epic', 'Feature', 'Product Backlog Item', 'Task']);
    expect(Object.keys(count((r) => r.status))).toEqual(expect.arrayContaining(['New', 'Approved', 'Committed', 'Done', 'Removed']));
    expect(Object.keys(count((r) => r.iteration.name)).sort()).toEqual(['@project', 'Sprint 1', 'Sprint 2', 'Sprint 3']);
    // The readiness gate needs both: approved work without effort or acceptance criteria, and work with them.
    const pbis = items.filter((r) => r.typeName === 'Product Backlog Item');
    expect(pbis.some((r) => r.estimate === null)).toBe(true);
    expect(pbis.some((r) => 'Microsoft.VSTS.Common.AcceptanceCriteria' in r.native['ado-seed generate'].fields)).toBe(true);
    expect(pbis.some((r) => !('Microsoft.VSTS.Common.AcceptanceCriteria' in r.native['ado-seed generate'].fields))).toBe(true);
    expect(items.filter((r) => r.native['ado-seed generate'].stale)).toHaveLength(2);
    expect(items.some((r) => r.links.some((l) => l.type === 'blocks')) && items.some((r) => r.links.some((l) => l.type === 'relates'))).toBe(true);
    expect(items.some((r) => r.title.length > 120)).toBe(true);
    // Every one carries the seed tag and its own key, and no one but the token is ever assigned.
    expect(items.every((r) => r.labels.includes('toil-seed') && r.labels.includes(`seed:${r.source.key}`))).toBe(true);
    expect(new Set(items.flatMap((r) => (r.assignee ? [r.assignee.id] : [])))).toEqual(new Set(['@Me']));
  });

  it('never names an organization, a project or a person', () => {
    const text = readFileSync(DEFAULT_OUT, 'utf8');
    expect(text).not.toMatch(/dev\.azure\.com|visualstudio\.com|@[a-z0-9-]+\.[a-z]{2,}/i);
  });

  it('draws every timeline in order and on or before the anchor', () => {
    for (const r of items) {
      const at = r.native['ado-seed generate'].timeline.map((e) => Date.parse(e.at));
      expect(at).toEqual([...at].sort((a, b) => a - b));
      expect(Math.max(...at)).toBeLessThanOrEqual(Date.parse(ANCHOR));
    }
  });
});

describe('apply.mjs', () => {
  it('creates every item backdated, with its revisions, links and tags, and a second run changes nothing', async () => {
    const board = adoBoard();
    const first = await seed(board);
    expect(first).toMatchObject({ backdated: true });
    expect(first.created).toHaveLength(45);
    const made = [...board.items.values()];
    expect(made.every((i) => seedKey(i, 'tags', PROJECT) !== null)).toBe(true);
    // Only work items, only in the project, and only ones it made.
    expect(board.writes.every((w) => new RegExp(`^(POST /${PROJECT}/_apis/wit/workitems/\\$|PATCH /_apis/wit/workitems/\\d+$)`).test(w))).toBe(true);
    const done = made.find((i) => i.fields['System.State'] === 'Done' && i.fields['System.WorkItemType'] === 'Product Backlog Item')!;
    expect(done.fields).toMatchObject({ 'System.Reason': 'Work finished', 'Microsoft.VSTS.Common.ClosedDate': expect.any(String) });
    expect(done.fields['System.AssignedTo'] ?? 'you@example.com').toBe('you@example.com');

    board.writes.length = 0;
    const second = await seed(board);
    expect([second.created, second.repaired, second.linked]).toEqual([[], [], []]);
    expect(board.writes).toEqual([]);
  });

  it('walks on an item an earlier run left part-way, and adds the links it is missing', async () => {
    const board = adoBoard();
    const { ids } = await seed(board);
    const id = ids.get('st-pbi-1')!;
    const item = board.items.get(id)!;
    item.fields['System.State'] = 'Approved';
    const linkTarget = ids.get('cp-pbi-1')!;
    board.items.get(linkTarget)!.relations = board.items.get(linkTarget)!.relations.filter((r) => r.rel !== 'System.LinkTypes.Dependency-Forward');
    const out = await seed(board);
    expect(out.repaired).toEqual(['st-pbi-1']);
    expect(item.fields['System.State']).toBe('Done');
    expect(out.linked).toContain('cp-pbi-1');
  });

  it("leaves alone a work item the query matches that isn't the seed's, and never writes to it", async () => {
    const board = adoBoard();
    const theirs = board.others({ 'System.Title': 'Someone else', 'System.Tags': 'not-toil-seed', 'System.State': 'New', 'System.WorkItemType': 'Bug' });
    const lines: string[] = [];
    await seed(board, { log: (l) => lines.push(l) });
    expect(lines.some((l) => l.includes(`Left alone: 1`) && l.includes(String(theirs)))).toBe(true);
    expect(board.writes.some((w) => w.endsWith(`/${theirs}`))).toBe(false);
    expect(board.items.get(theirs)!.rev).toBe(1);
  });

  it('seeds with ordinary transitions, dated now, and says so, when the server refuses bypassRules', async () => {
    const board = adoBoard();
    board.refuseBypass = true;
    const lines: string[] = [];
    const out = await seed(board, { log: (l) => lines.push(l) });
    expect(out.backdated).toBe(false);
    expect(out.created).toHaveLength(45);
    expect(lines.some((l) => l.includes('refused bypassRules'))).toBe(true);
    expect([...board.items.values()].every((i) => i.fields['System.CreatedDate'] === '2026-10-20T01:00:00.000Z')).toBe(true);
  });

  it('stops before writing anything when a sprint the file names is missing', async () => {
    const board = adoBoard();
    const moved = structuredClone(items);
    moved[3]!.native['ado-seed generate'].timeline.at(-1)!.iteration = '@project\\Sprint 9';
    await expect(apply({ items: moved, api: client({ baseUrl: ORG, pat: 'p', project: PROJECT, fetch: board.fetch }), now: after })).rejects.toThrow(/no Imagile\\Sprint 9/);
    expect(board.writes).toEqual([]);
  });

  it('creates parents before children, and adds each link from one end only', () => {
    const order = inOrder(items).map((r) => r.id);
    for (const r of items) if (r.parent) expect(order.indexOf(r.parent)).toBeLessThan(order.indexOf(r.id));
    const ids = new Map(items.map((r, i) => [r.source.key, i + 100]));
    const ops = items.flatMap((r) => missingLinks(r, { relations: [] }, (k) => ids.get(k), (id) => `${ORG}/_apis/wit/workItems/${id}`));
    const links = items.flatMap((r) => r.links);
    const parents = items.filter((r) => r.parent).length;
    // A dependency from its predecessor's end; a related pair (outward on both ends) once.
    expect(ops).toHaveLength(parents + links.filter((l) => l.type === 'blocks' && l.direction === 'outward').length + links.filter((l) => l.type === 'relates').length / 2);
  });
});

describe('the marker identity, for a token that may not create tags', () => {
  it('prefixes the title, marks the description, and applies only tags that exist', () => {
    const { ops, skippedTags } = createPatch(items[0]!, { project: PROJECT, identity: 'marker', me: null, existingTags: new Set(['card-payments']) });
    const field = (name: string) => ops.find((o) => o.path === `/fields/${name}`)?.value;
    expect(field('System.Title')).toBe(`${TITLE_PREFIX}${items[0]!.title}`);
    expect(field('System.Description')).toMatch(/<p>\[seed:cp-epic-1\]<\/p>$/);
    expect(field('System.Tags')).toBe('card-payments');
    expect(skippedTags).toContain('toil-seed');
  });

  it('recognises only an item with both the prefix and the marker', () => {
    const item = (title: string, description: string) => ({ id: 1, fields: { 'System.TeamProject': PROJECT, 'System.Title': title, 'System.Description': description } });
    expect(seedKey(item(`${TITLE_PREFIX}T`, '<p>x</p><p>[seed:cp-bug-1]</p>'), 'marker', PROJECT)).toBe('cp-bug-1');
    expect(seedKey(item('T', '<p>[seed:cp-bug-1]</p>'), 'marker', PROJECT)).toBeNull();
    expect(seedKey(item(`${TITLE_PREFIX}T`, '<p>no marker</p>'), 'marker', PROJECT)).toBeNull();
    expect(seedKey({ id: 1, fields: { 'System.TeamProject': 'Other', 'System.Tags': 'toil-seed; seed:a' } }, 'tags', PROJECT)).toBeNull();
    expect(seedKey({ id: 1, fields: { 'System.TeamProject': PROJECT, 'System.Tags': 'toil-seed; seed:a; seed:b' } }, 'tags', PROJECT)).toBeNull();
  });
});

describe('cleanup.mjs', () => {
  it('lists without deleting, refuses a code for another list, and then sends only seeded items to the recycle bin', async () => {
    const board = adoBoard();
    await seed(board);
    const theirs = board.others({ 'System.Title': 'Someone else', 'System.Tags': 'toil-seedling', 'System.State': 'New' });
    const api = client({ baseUrl: ORG, pat: 'p', project: PROJECT, fetch: board.fetch });
    board.writes.length = 0;
    const listed = await cleanup({ api });
    expect(listed).toMatchObject({ listed: 45, deleted: [] });
    expect(board.writes).toEqual([]);
    await expect(cleanup({ api, confirm: confirmationCode([1, 2]) })).rejects.toThrow(/aren't the ones that code was for/);
    expect(board.writes).toEqual([]);
    const done = await cleanup({ api, confirm: listed.code });
    expect(done.deleted).toHaveLength(45);
    // A delete without destroy: to the recycle bin, never gone for good.
    expect(board.writes.every((w) => /^DELETE \/Imagile\/_apis\/wit\/workitems\/\d+$/.test(w))).toBe(true);
    expect(board.items.get(theirs)!.deleted).toBe(false);
    expect((await findSeeded(api, 'tags')).seeded.size).toBe(0);
  });
});

// toil reads the board back ----------------------------------------------------------

const saved: Record<string, string | undefined> = {};
const folders: string[] = [];
const ENV = ['HOME', 'USERPROFILE', 'TOIL_ADO_PAT', 'TOIL_ADO_BASE_URL', 'TOIL_ADO_DEPLOYMENT', 'TOIL_TOIL_PROJECT', 'TOIL_TOIL_PROJECT_PATHS', 'SYSTEM_ACCESSTOKEN'];
beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'toil-ui-ado-seed-'));
  folders.push(home);
  mkdirSync(join(home, '.toil', 'projects'), { recursive: true });
  writeFileSync(join(home, '.toil', 'config.json'), JSON.stringify({ version: 3, connections: { 'imagile-ado': { area: 'ado', deployment: 'cloud', baseUrl: ORG } }, audit: { enabled: false } }));
  writeFileSync(join(home, '.toil', 'projects', 'ado-board.json'), JSON.stringify({ name: 'ado-board', description: 'The seeded board', repos: [], ado: { connection: 'imagile-ado', project: PROJECT } }));
  for (const key of ENV) saved[key] = process.env[key];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.TOIL_ADO_PAT = 'test-pat';
  process.env.TOIL_ADO_DEPLOYMENT = 'cloud';
  for (const key of ['TOIL_ADO_BASE_URL', 'TOIL_TOIL_PROJECT', 'TOIL_TOIL_PROJECT_PATHS', 'SYSTEM_ACCESSTOKEN']) delete process.env[key];
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (folders.length) rmSync(folders.pop()!, { recursive: true, force: true, maxRetries: 3 });
});

describe("toil's ado commands on a Services connection, on the seeded board", () => {
  it('read back, through util owi map, exactly what the OWI file seeded, dates and history included', async () => {
    const board = adoBoard();
    await seed(board);
    vi.stubGlobal('fetch', board.fetch);
    board.writes.length = 0;
    const data = await loadToilProject(execute as unknown as Execute, 'ado-board', { mapOwi });
    expect(data.calls.work.filter((c) => !c.ok)).toEqual([]);
    expect(data.calls.work.map((c) => c.command)).toEqual(expect.arrayContaining(['ado work-item iterations', 'ado work-item search', 'ado work-item get-many', 'ado work-item history']));
    // One feed call (read in several batches) stood in for most histories; the items it doesn't hold whole were read one by one, and the result is the same board.
    const commands = data.calls.work.map((c) => c.command);
    expect(commands.filter((c) => c === 'ado work-item feed')).toHaveLength(1);
    expect(board.feedRequests).toBeGreaterThan(1);
    expect(commands.filter((c) => c === 'ado work-item history').length).toBeGreaterThan(0);
    expect(commands.filter((c) => c === 'ado work-item history').length).toBeLessThan(data.items.length);
    expect(compare(items, data.items, { project: PROJECT, backdated: true })).toEqual([]);
    // Scrum's In Progress is in progress, not a custom state.
    expect(data.items.filter((i) => i.status === 'In Progress').every((i) => i.statusCategory === 'IN_PROGRESS')).toBe(true);
    // Reading never wrote; the toil project names no repository, so no pull requests were asked for.
    expect(board.writes).toEqual([]);
    expect(data.calls.prs).toEqual([]);
    // Toil UI's server lets the page make every one of these reads.
    expect(data.calls.work.filter((c) => !READ_COMMANDS.has(c.command))).toEqual([]);
  });

  it("reads the pull requests of the Toil project's repository, and ties each to the work items it names", async () => {
    const board = adoBoard();
    const { ids } = await seed(board);
    const id = ids.get('cp-pbi-1')!;
    board.pullRequests.push({
      pullRequestId: 7,
      title: `Store tokens in the vault (#${id})`,
      description: `Fixes AB#${id}.`,
      status: 'completed',
      creationDate: '2026-10-15T09:00:00Z',
      closedDate: '2026-10-16T09:00:00Z',
      lastMergeCommit: { commitId: 'abc1234' },
      repository: { name: 'payments-core', webUrl: `${ORG}/${PROJECT}/_git/payments-core`, project: { name: PROJECT } },
    });
    const file = join(process.env.HOME!, '.toil', 'projects', 'ado-board.json');
    writeFileSync(file, JSON.stringify({ name: 'ado-board', repos: [], ado: { connection: 'imagile-ado', project: PROJECT, repo: 'payments-core' } }));
    vi.stubGlobal('fetch', board.fetch);
    const data = await loadToilProject(execute as unknown as Execute, 'ado-board', { mapOwi });
    expect(data.calls.prs.map((c) => [c.command, c.ok])).toEqual([['ado pr list', true], ['ado pr get', true]]);
    expect(data.pullRequests.map((c) => [c.id, c.state, c.workItems, c.checks])).toEqual([[`imagile-ado:${PROJECT}/payments-core#7`, 'MERGED', [`imagile-ado:${id}`], 'NONE']]);
    expect(READ_COMMANDS.has('ado pr list')).toBe(true);
    expect(data.changes.filter((c) => c.kind === 'pull-request').map((c) => [c.id, c.command, c.outcome, c.items])).toEqual([[`imagile-ado:${PROJECT}/payments-core#7`, 'ado pr get', 'merged', [`imagile-ado:${id}`]]]);
  });

  it('reads no pull requests and no runs for a Services Toil project with no items and no repository', async () => {
    const board = adoBoard();
    const file = join(process.env.HOME!, '.toil', 'projects', 'ado-board.json');
    writeFileSync(file, JSON.stringify({ name: 'ado-board', repos: [], ado: { connection: 'imagile-ado', project: PROJECT, builds: ['ci'], deployments: ['deploy'] } }));
    vi.stubGlobal('fetch', board.fetch);
    const data = await loadToilProject(execute as unknown as Execute, 'ado-board', { mapOwi });
    expect(data.items).toEqual([]);
    const commands = Object.values(data.calls).flat().map((c) => c.command);
    expect(commands).not.toContain('ado pr list');
    expect(commands).not.toContain('ado run list');
  });

  it('proposes a board move on a Services item as ado work-item transition', async () => {
    const board = adoBoard();
    await seed(board);
    vi.stubGlobal('fetch', board.fetch);
    const data = await loadToilProject(execute as unknown as Execute, 'ado-board', { mapOwi });
    const item = data.items.find((i) => i.status === 'New' && i.type === 'STORY') as WorkItem;
    expect(proposeMove(item, 'IN_PROGRESS', data.items, 'ado-board')).toMatchObject({ command: 'ado work-item transition', input: { toilProject: 'ado-board', id: Number(item.source.key), state: 'Committed' } });
  });
});
