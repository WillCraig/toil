import { Validator } from '@cfworker/json-schema';
import { describe, expect, it } from 'vitest';
import { execute, mapOwi as apiMapOwi, registry } from '../../src/api.ts';
import { CANNED, callKey, fixtureExecute } from '../src/fixtures/execute.ts';
import { loadToilProject, loadToilProjects } from '../src/load.ts';
import { workflowRead } from '../src/model/readiness.ts';
import { WORKFLOW_READS } from '../server/store.ts';
import { mapOwi } from '../src/owi.ts';
import type { Execute } from '../src/toil.ts';
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
    const onPress = (command: string) => (WORKFLOW_READS as readonly string[]).includes(command);
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
    const api = await loadToilProject(fixtureExecute().execute, name, { mapOwi: (input) => apiMapOwi(input) });
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
  // Ticketing a chat's work (#304): a sub-task under every open item, and a new ticket, on every tracker toil creates on.
  const { newTicketProposal, subTaskProposal } = await import('../src/model/ticketing.ts');
  for (const name of NAMES) {
    const { items } = await loadToilProject(fixtureExecute().execute, name);
    const open = items.filter((i) => i.statusCategory !== 'DONE');
    // Azure DevOps on a Services connection is still area ado: the item's source says the deployment.
    const onServices = open.filter((i) => i.source.area === 'ado').map((i) => ({ ...i, id: `services-ado:${i.source.key}`, source: { ...i.source, connection: 'services-ado', deployment: 'cloud' } }));
    // Jira on a Cloud connection is still area jira: the item's source says the deployment.
    const onCloud = open.filter((i) => i.source.area === 'jira').map((i) => ({ ...i, id: `cloud-jira:${i.source.key}`, source: { ...i.source, connection: 'cloud-jira', deployment: 'cloud' } }));
    for (const item of [...open, ...onCloud, ...onServices]) proposals.push(subTaskProposal('Tokenise card numbers at the edge', item, name));
    proposals.push(newTicketProposal('Tokenise card numbers at the edge', items, name, null));
    for (const list of [onCloud, onServices]) proposals.push(newTicketProposal('Tokenise card numbers at the edge', list, name, null));
  }
  const withCommand = proposals.filter((p) => p?.command);

  it('includes some of each kind', () => {
    expect(new Set(withCommand.map((p) => p!.command))).toEqual(new Set(['jira issue transition', 'ado work-item transition', 'jira issue update', 'ado work-item update', 'github pr add-reviewers', 'github pr comment', 'bitbucket pr add-reviewer', 'bitbucket pr update', 'confluence page create', 'github issue create', 'jira issue create', 'ado work-item create']));
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
