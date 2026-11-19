import { Validator } from '@cfworker/json-schema';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execute, mapOwi as apiMapOwi, registry } from '../../src/api.ts';
import { VIEW_LIMITS, computeView, pickView } from '../../src/areas/util/c4/model.ts';
import { countsOf as toilCountsOf, createDiagramCatalog, loadStorable, viewsOf } from '../../src/core/diagrams.ts';
import { SAMPLE_DIAGRAMS, countsOf, diagramShow } from '../src/fixtures/diagrams.ts';
import { SAMPLE_VIEWS } from '../src/fixtures/diagram-views.ts';
import { DRAW_LIMITS } from '../src/model/diagram.ts';
import { CANNED, callKey, fixtureExecute } from '../src/fixtures/execute.ts';
import { loadToilProject, loadToilProjects } from '../src/load.ts';
import { workflowRead } from '../src/model/readiness.ts';
import { WORKFLOW_READS } from '../server/store.ts';
import { mapOwi } from '../src/owi.ts';
import type { Execute, WorkItem } from '../src/toil.ts';
import { NAMES } from './harness.ts';

/**
 * The fixture `execute()` against toil's real registry, imported from source
 * (src/api.ts), so renaming a command or a flag the preview uses fails here.
 * Every canned call must name a command `execute()` serves, one that only
 * reads, with input that validates against that command's own strict JSON
 * Schema. This file is type-checked with tsconfig.registry.json, which can
 * load the CLI's Node-only sources; the main tsconfig leaves it out.
 */

// The fixture's signature is the API's, both ways: either can stand in for the other.
const asApi: typeof execute = fixtureExecute().execute;
const asUi: Execute = execute;
void asApi;
void asUi;

const byName = new Map(registry.commands.map((c) => [c.name, c]));

describe.each(CANNED.map((c) => [`${c.command} ${JSON.stringify(c.input)}`, c] as const))('%s', (_label, call) => {
  const def = byName.get(call.command);

  it('is a command execute() serves', () => {
    expect(def, `toil has no API command "${call.command}"`).toBeDefined();
  });

  it('only reads, whatever its input', () => {
    expect(def!.writes).toBe(false);
    expect(def!.writesLocal).toBe(false);
    expect(def!.writesDependOnInput).toBe(false);
  });

  it("validates against the command's input schema", () => {
    const result = new Validator(def!.inputSchema as object, '2020-12', false).validate(call.input);
    expect(result.errors.map((e) => `${e.instanceLocation} ${e.error}`)).toEqual([]);
  });
});

describe('the dashboards', () => {
  it('ask only for calls the fixture answers, all read-only, and ask for every one', async () => {
    const fixture = fixtureExecute();
    const options = new Set<string>();
    const watched: Execute = (command, input, opts) => {
      options.add(JSON.stringify(opts));
      return fixture.execute(command, input, opts);
    };
    await loadToilProjects(watched);
    for (const name of NAMES) await loadToilProject(watched, name);
    expect(fixture.calls.filter((c) => !c.ok)).toEqual([]);
    expect([...options]).toEqual([JSON.stringify({ readOnly: true, caller: 'toil-ui' })]);
    const asked = new Set(fixture.calls.map((c) => callKey(c.command, c.input)));
    // The readiness gate's workflow reads (#307) are made on a person's press, never by a load.
    // The stored diagram (#582) is read by its own page, not by a load.
    const onPress = (command: string) => (WORKFLOW_READS as readonly string[]).includes(command) || command === 'projects diagram show';
    for (const c of CANNED.filter((x) => !onPress(x.command))) expect(asked.has(callKey(c.command, c.input)), `${c.command} ${JSON.stringify(c.input)} is never asked for`).toBe(true);
    expect(fixture.calls.filter((c) => onPress(c.command))).toEqual([]);
  });

  it("answer the readiness gate's workflow read for every open item it applies to, and hold no other", async () => {
    const reads = new Set<string>();
    for (const name of NAMES) {
      const d = await loadToilProject(fixtureExecute().execute, name);
      for (const item of d.items.filter((i) => i.statusCategory !== 'DONE')) {
        const read = workflowRead(item);
        if (read) reads.add(callKey(read.command, { toilProject: name, ...read.input }));
      }
    }
    const canned = CANNED.filter((c) => (WORKFLOW_READS as readonly string[]).includes(c.command)).map((c) => callKey(c.command, c.input));
    for (const r of reads) expect(canned, r).toContain(r);
    // ADO's states are per type, so one answer covers every item of it; Jira's transitions are per issue.
    expect(canned.filter((k) => !reads.has(k))).toEqual([]);
  });
});

describe("the browser's mapOwi", () => {
  it.each(NAMES)("maps %s's work exactly as the API's mapOwi does", async (name) => {
    const browser = await loadToilProject(fixtureExecute().execute, name, { mapOwi });
    const api = await loadToilProject(fixtureExecute().execute, name, { mapOwi: (input, options) => apiMapOwi(input, options) });
    expect(browser.items.length).toBeGreaterThan(0);
    expect(browser.items).toEqual(api.items);
  });
});

describe('every proposal the board, the scripted agent and the pull request view can make', async () => {
  const { COLUMNS, proposeMove } = await import('../src/model/board.ts');
  const { SCRIPTS } = await import('../src/fixtures/agent.ts');
  const { reviewProposal } = await import('../src/model/prs.ts');
  const proposals = [];
  for (const name of NAMES) {
    const { items, pullRequests } = await loadToilProject(fixtureExecute().execute, name);
    for (const item of items) for (const to of COLUMNS) proposals.push(proposeMove(item, to, items, name));
    // A review request on every pull request, as a team and as a person, whatever the suggestions are today.
    for (const c of pullRequests) for (const id of ['bo-web', 'imagile/writers']) proposals.push(reviewProposal(c, { id, why: ['reviewed it before'], score: 1 }, name));
  }
  for (const scripts of Object.values(SCRIPTS)) for (const s of Object.values(scripts)) proposals.push(...(s.proposals ?? []));
  // The comment a scripted review ends on (#532).
  const { scriptedJob } = await import('../src/fixtures/agent.ts');
  proposals.push(...scriptedJob('job:review:github:imagile/payments-web#43')!.proposals);
  // Publishing a worklog (#308), to every place a toil project can name.
  const { publishProposals } = await import('../src/worklog.ts');
  const everywhere = { confluence: { connection: null, inputs: { space: 'PAY' } }, github: { connection: null, inputs: { owner: 'imagile', repo: 'payments-web' } } };
  proposals.push(...publishProposals('card-payments', { day: '2026-10-12' }, 'C:/Users/you/Documents/worklog-card-payments-2026-10-12.md', everywhere));
  const withCommand = proposals.filter((p) => p?.command);

  it('includes some of each kind', () => {
    expect(new Set(withCommand.map((p) => p!.command))).toEqual(new Set(['jira issue transition', 'ado work-item transition', 'jira issue update', 'ado work-item update', 'github pr add-reviewers', 'github pr comment', 'github project status', 'bitbucket pr add-reviewer', 'bitbucket pr update', 'confluence page create', 'github issue create']));
  });

  it.each(withCommand.map((p) => [p!.id, p!] as const))('%s names a write command, with input its schema accepts', (_id, p) => {
    const def = byName.get(p.command!);
    expect(def, `toil has no API command "${p.command}"`).toBeDefined();
    expect(def!.writes).toBe(true);
    const result = new Validator(def!.inputSchema as object, '2020-12', false).validate(p.input);
    expect(result.errors.map((e) => `${e.instanceLocation} ${e.error}`)).toEqual([]);
  });
  it.each(withCommand.map((p) => [p!.id, p!] as const))("%s has a command line toil's own CLI accepts, every flag and argument where it reads them", async (_id, p) => {
    const { commandLine } = await import('../src/proposal.ts');
    const { checkInvocation, words } = await import('../../test/harness/cli-lines.ts');
    const { line } = commandLine(p, 'posix');
    expect(line, p.command!).not.toBeNull();
    expect(checkInvocation(words(line!).slice(1))).toBeUndefined();
  });

  it('lists exactly the commands whose input takes inputFile, so the advice never offers one that is not there', async () => {
    const { INPUT_FILE_COMMANDS } = await import('../src/proposal.ts');
    const takes = registry.commands.filter((c) => Object.keys((c.inputSchema as { properties?: object }).properties ?? {}).includes('inputFile')).map((c) => c.name);
    expect([...INPUT_FILE_COMMANDS].sort()).toEqual(takes.sort());
  });

  it("lists exactly every area command's positional arguments, so a command line puts each id where the CLI reads it", async () => {
    const { POSITIONAL_FIELDS } = await import('../src/proposal.ts');
    const { commands } = await import('../../src/registry.ts');
    const want = commands
      .filter((c) => c.area && c.args?.length)
      .map((c) => [c.path.join(' '), c.args!.map((a) => a.field)] as const);
    expect([...POSITIONAL_FIELDS.entries()].sort()).toEqual(want.sort());
  });

  it('refers a PowerShell refusal to an MCP tool that exists, with input its schema accepts', async () => {
    const { commandLine, toolName } = await import('../src/proposal.ts');
    const byTool = new Map(registry.commands.map((c) => [toolName(c.name), c]));
    const hostile = withCommand.map((p) => ({ ...p, input: { ...p!.input, ...(p!.command === 'jira issue transition' ? { transition: 'Code Review & QA' } : p!.command === 'ado work-item transition' ? { state: 'Code Review & QA' } : { toilProject: 'a&b' }) } }));
    for (const p of hostile) {
      const out = commandLine({ command: p!.command ?? null, input: p!.input }, 'powershell');
      expect(out.line, p!.command!).toBeNull();
      const def = byTool.get(out.mcp!.tool);
      expect(def, out.mcp!.tool).toBeDefined();
      const result = new Validator(def!.inputSchema as object, '2020-12', false).validate(out.mcp!.input);
      expect(result.errors.map((e) => `${e.instanceLocation} ${e.error}`)).toEqual([]);
      expect((out.reason ?? '').includes('--input-file')).toBe(Object.keys((def!.inputSchema as { properties?: object }).properties ?? {}).includes('inputFile'));
    }
  });

  const hints = proposals.flatMap((p) => (p?.hint ? [[`${p.id} hint`, p.hint] as const] : []));
  it('includes read-only hints', () => expect(hints.length).toBeGreaterThan(0));

  it.each(hints)('%s names a read command, with input its schema accepts', (_id, h) => {
    const def = byName.get(h.command);
    expect(def, `toil has no API command "${h.command}"`).toBeDefined();
    expect(def!.writes).toBe(false);
    const result = new Validator(def!.inputSchema as object, '2020-12', false).validate(h.input);
    expect(result.errors.map((e) => `${e.instanceLocation} ${e.error}`)).toEqual([]);
  });
});

describe("the worklog's two calls to toil beyond the reads (#308)", () => {
  it('reads the audit log with a read-only command and input it accepts', () => {
    const def = byName.get('audit list')!;
    expect(def.writes || def.writesLocal).toBe(false);
    expect(new Validator(def.inputSchema as object, '2020-12', false).validate({ since: '2026-10-12T07:01:00.000Z', writesOnly: true, limit: 1000 }).errors).toEqual([]);
  });

  it('exports through util encode, which writes only a local file, and only because of out', () => {
    const def = byName.get('util encode')!;
    expect(def.writes).toBe(false);
    expect(def.writesLocal).toBe(false);
    expect(def.writesDependOnInput).toBe(true);
    expect(new Validator(def.inputSchema as object, '2020-12', false).validate({ scheme: 'base64', decode: true, text: 'IyBXb3JrbG9n', out: 'worklog-card-payments-2026-10-12.md' }).errors).toEqual([]);
  });
});

describe("the Board's drop (ui/server/board.ts) against the real registry", () => {
  const valid = (command: string, input: Record<string, unknown>) => new Validator(byName.get(command)!.inputSchema as object, '2020-12', false).validate(input).errors;

  it('reads the item and connections with read-only commands, and writes with one transition command per tracker', () => {
    for (const read of ['projects list', 'connections list', 'projects show', 'jira issue get', 'ado work-item get', 'github issue get', 'github project items', 'github project fields', 'github project list']) {
      const def = byName.get(read);
      expect(def, read).toBeDefined();
      expect(def!.writes || def!.writesLocal, read).toBe(false);
    }
    for (const write of ['jira issue transition', 'ado work-item transition']) expect(byName.get(write)!.writes, write).toBe(true);
  });

  it('sends input those commands accept, the column as the intent toil resolves', () => {
    for (const to of ['reopen', 'start', 'done']) {
      expect(valid('jira issue transition', { toilProject: 'card-payments', key: 'PAY-102', to, allowWrite: true })).toEqual([]);
      expect(valid('ado work-item transition', { toilProject: 'card-payments', id: 2304, to, allowWrite: true })).toEqual([]);
    }
    expect(valid('jira issue get', { toilProject: 'card-payments', key: 'PAY-102' })).toEqual([]);
    expect(valid('ado work-item get', { toilProject: 'card-payments', id: 2304 })).toEqual([]);
  });

  it("writes a GitHub move with one of three commands, with the input the server sends (owner, repository and number from the item's id)", () => {
    for (const write of ['github project status', 'github project add', 'github issue close', 'github issue reopen']) expect(byName.get(write)!.writes, write).toBe(true);
    expect(valid('github issue get', { toilProject: 'card-payments', owner: 'acme', repo: 'shop', number: [7] })).toEqual([]);
    expect(valid('github project items', { toilProject: 'card-payments', owner: 'acme', project: 3 })).toEqual([]);
    expect(valid('github project fields', { toilProject: 'card-payments', owner: 'acme', project: 3 })).toEqual([]);
    expect(valid('github project status', { toilProject: 'card-payments', item: 'PVTI_abc12345', to: 'In Progress', allowWrite: true })).toEqual([]);
    expect(valid('github project add', { toilProject: 'card-payments', owner: 'acme', repo: 'shop', project: 3, number: 7, allowWrite: true })).toEqual([]);
    expect(valid('github project list', { toilProject: 'card-payments', owner: 'acme' })).toEqual([]);
    expect(valid('github issue close', { toilProject: 'card-payments', owner: 'acme', repo: 'shop', number: 7, allowWrite: true })).toEqual([]);
    expect(valid('github issue reopen', { toilProject: 'card-payments', owner: 'acme', repo: 'shop', number: 7, allowWrite: true })).toEqual([]);
  });

  it('makes the proposal for a plain GitHub issue the command the server would run', async () => {
    const { proposeMove } = await import('../src/model/board.ts');
    const issue = { id: 'github:acme/shop#7', source: { area: 'github', connection: 'github', key: 'acme/shop#7' }, native: {}, status: 'open', statusCategory: 'TODO', typeName: null, url: null } as unknown as WorkItem;
    const done = proposeMove(issue, 'DONE', [issue], 'card-payments')!;
    expect(done).toMatchObject({ command: 'github issue close', input: { toilProject: 'card-payments', owner: 'acme', repo: 'shop', number: 7 } });
    const reopened = proposeMove({ ...issue, status: 'closed', statusCategory: 'DONE' } as WorkItem, 'TODO', [issue], 'card-payments')!;
    expect(reopened).toMatchObject({ command: 'github issue reopen', input: { owner: 'acme', repo: 'shop', number: 7 } });
    expect(proposeMove(issue, 'IN_PROGRESS', [issue], 'card-payments')).toMatchObject({ command: null, input: null });
    for (const p of [done, reopened]) expect(valid(p.command!, { ...p.input!, allowWrite: true })).toEqual([]);
  });

  it('makes the proposal for a card off its named board two real commands: github project add, then github project status by number', async () => {
    const { proposeMove } = await import('../src/model/board.ts');
    const issue = { id: 'github:acme/shop#7', source: { area: 'github', connection: 'github', key: 'acme/shop#7' }, native: {}, status: 'open', statusCategory: 'TODO', typeName: null, url: null } as unknown as WorkItem;
    const p = proposeMove(issue, 'IN_PROGRESS', [issue], 'card-payments', { projects: [3], unread: [] }, { project: 3, number: 7, status: 'In Progress', canApply: true })!;
    expect(p.command).toBe('github project add');
    expect(p.then?.command).toBe('github project status');
    expect(valid(p.command!, { ...p.input!, allowWrite: true })).toEqual([]);
    expect(valid(p.then!.command, { ...p.then!.input, allowWrite: true })).toEqual([]);
  });
});

describe('the sample architecture diagrams (#582)', () => {
  const homes: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });
  /** A temp home holding the sample diagram as toil would have stored it, so the real `projects diagram show` reads it. */
  const keep = (name: string) => {
    const home = mkdtempSync(join(tmpdir(), 'toil-ui-diagram-'));
    homes.push(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    const d = SAMPLE_DIAGRAMS[name]!;
    const model = loadStorable(JSON.stringify(d.model), name, d.notMapped);
    createDiagramCatalog({ home, protect: [] }).save(name, { model, notMapped: d.notMapped, toilVersion: 'test', mode: 'create' });
    return model;
  };

  it.each(Object.keys(SAMPLE_DIAGRAMS))('%s passes the stored-diagram checks, and its counts and views are what toil counts', (name) => {
    const model = keep(name);
    expect(countsOf(SAMPLE_DIAGRAMS[name]!.model)).toEqual(toilCountsOf(model));
    expect(diagramShow(name).views).toEqual(viewsOf(model));
  });

  it("holds every computed view to what toil's own projects diagram show prints, view by view", async () => {
    const computed: Record<string, Record<string, unknown>> = {};
    for (const name of Object.keys(SAMPLE_DIAGRAMS)) {
      const model = keep(name);
      computed[name] = {};
      for (const v of model.views) {
        const real = await execute('projects diagram show', { toilProject: name, view: v.key }, { readOnly: true, caller: 'toil-ui-test' });
        expect(real.ok, JSON.stringify(real.error)).toBe(true);
        const data = real.data as { model: unknown; views: unknown; counts: unknown; view: unknown; notMapped: unknown };
        const shown = diagramShow(name, v.key);
        expect(data.model, name).toEqual(JSON.parse(JSON.stringify(shown.model)));
        expect(data.notMapped).toEqual(shown.notMapped);
        expect(data.views).toEqual(shown.views);
        expect(data.counts).toEqual(shown.counts);
        computed[name]![v.key] = data.view;
        // And toil's own function, with no warning: a relationship the view cannot draw would be a hole in the picture.
        const warnings: unknown[] = [];
        expect(computeView(model, pickView(model, v.key), (w) => warnings.push(w))).toEqual(data.view);
        expect(warnings).toEqual([]);
      }
    }
    // A model changed without its views refreshed fails here: UPDATE_DIAGRAM_VIEWS=1 rewrites the file from what toil printed.
    if (process.env.UPDATE_DIAGRAM_VIEWS === '1') {
      const file = join(import.meta.dirname, '..', 'src', 'fixtures', 'diagram-views.ts');
      const { readFileSync } = await import('node:fs');
      const text = readFileSync(file, 'utf8');
      writeFileSync(file, text.slice(0, text.indexOf('= {') + 2) + JSON.stringify(computed) + ';\n');
    }
    expect(JSON.parse(JSON.stringify(SAMPLE_VIEWS))).toEqual(JSON.parse(JSON.stringify(computed)));
  });

  it("draws no more than toil's own drawer does: the page's limits are VIEW_LIMITS", () => {
    expect(DRAW_LIMITS).toEqual(VIEW_LIMITS);
  });
});

describe("the ticket rules' read (#657)", () => {
  it("is toil's standards check, read-only whatever its input, with the input the server sends", () => {
    const def = byName.get('standards check');
    expect(def, 'toil has no API command "standards check"').toBeDefined();
    expect([def!.writes, def!.writesLocal, def!.writesDependOnInput]).toEqual([false, false, false]);
    // What ui/server/standards.ts sends: the Toil project, the synced items as text, and the folder toil looks from.
    const result = new Validator(def!.inputSchema as object, '2020-12', false).validate({ toilProject: 'card-payments', text: '[]', cwd: '/home/you/src' });
    expect(result.errors.map((e) => `${e.instanceLocation} ${e.error}`)).toEqual([]);
  });
});

describe('the sync\'s own reads', () => {
  // The sync asks Azure DevOps' link feed with the search's input, less its WIQL, from the watermark (server/sync.ts, #664).
  it.each(CANNED.filter((c) => c.command === 'ado work-item search').map((c) => [JSON.stringify(c.input), c] as const))('ado work-item link-feed takes the search input %s', (_label, call) => {
    const def = byName.get('ado work-item link-feed');
    expect(def, 'toil has no API command "ado work-item link-feed"').toBeDefined();
    expect(def!.writes).toBe(false);
    const input = Object.fromEntries(Object.entries(call.input).filter(([k]) => k !== 'wiql'));
    const result = new Validator(def!.inputSchema as object, '2020-12', false).validate({ ...input, updatedSince: '2026-10-01T09:00:00.000Z' });
    expect(result.errors.map((e) => `${e.instanceLocation} ${e.error}`)).toEqual([]);
  });
});
