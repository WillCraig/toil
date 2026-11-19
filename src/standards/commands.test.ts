/* eslint-disable @typescript-eslint/no-explicit-any -- the tests read envelopes' untyped JSON */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResolvedConfig } from '../core/config.js';
import type { Envelope } from '../core/envelope.js';
import { standardsProjectCommands } from '../projects/standards-set.js';
import { areas } from '../registry.js';
import { runCli } from '../../test/harness/cli.js';
import { testContext } from '../../test/harness/context.js';
import { connectMcp, type McpSession } from '../../test/harness/mcp.js';
import { toilProjectDisk, type ToilProjectDisk } from '../../test/harness/toil-projects.js';
import { EXAMPLE_STANDARDS_RECORDS, standardsCommands } from './commands.js';

const commands = [...standardsCommands(), ...standardsProjectCommands()];
const toilProjectAreas = areas.map((a) => ({ name: a.name, context: Object.keys(a.context) }));
const config: ResolvedConfig = { connections: {}, defaults: {}, sources: {}, files: { global: '/home/test/.toil/config.json' }, warnings: [] };

const RISK_RULES = { name: 'risk', rules: [{ id: 'risk', name: 'Risk filled in', text: 'Fill in the Risk field.', fail: 'fail', check: { kind: 'field', in: ['field:risk'] } }] };

const disks: ToilProjectDisk[] = [];
const sessions: McpSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  disks.splice(0).forEach((d) => d.cleanup());
});

function disk(extra: Record<string, unknown> = {}): ToilProjectDisk {
  const d = toilProjectDisk({
    'home/.toil/projects/payments.json': { name: 'payments', jira: { fields: { risk: 'customfield_10777' } }, standards: { use: ['gherkin', './rules/risk.json'] } },
    // In a folder below, so the toil project scan doesn't read it as a toil project.
    'home/.toil/projects/rules/risk.json': RISK_RULES,
    'home/.toil/projects/bare.json': { name: 'bare' },
    'work/.git/HEAD': 'ref: refs/heads/main\n',
    'work/.toil/standards/team.json': { name: 'team', description: 'Checked in.', rules: [{ id: 'title', name: 'Title', text: 'Three words.', check: { kind: 'words', in: ['title'], min: 3 } }] },
    ...extra,
  });
  disks.push(d);
  return d;
}

function contextFor(d: ToilProjectDisk, files: Record<string, string>, mcp = false) {
  const { context } = testContext({ files });
  return { ...context, config, standards: d.standards(config, mcp ? { mcp: true } : {}), toilProjects: d.catalog(config, { areas: toilProjectAreas, ...(mcp ? { mcp: true } : {}) }) };
}
async function cli(d: ToilProjectDisk, argv: string[], files: Record<string, string> = { 'items.json': EXAMPLE_STANDARDS_RECORDS }): Promise<Envelope> {
  return (await runCli(argv, { commands, context: contextFor(d, files) })).envelope!;
}
async function mcp(d: ToilProjectDisk, files: Record<string, string> = { 'items.json': EXAMPLE_STANDARDS_RECORDS }): Promise<McpSession> {
  const session = await connectMcp({ commands, context: contextFor(d, files, true), areas: ['standards', 'projects'] });
  sessions.push(session);
  return session;
}
const data = (e: Envelope) => {
  expect(e.ok, JSON.stringify(e.error)).toBe(true);
  return e.data as Record<string, any>;
};
const codes = (e: Envelope) => (e.meta.warnings ?? []).map((w) => w.code);

describe('standards list', () => {
  it("lists the repository's standards and the built-ins, each with its rules", async () => {
    const d = disk();
    const out = data(await cli(d, ['standards', 'list']));
    expect(out.standards.map((s: any) => [s.name, s.source])).toEqual([['team', 'repo'], ['gherkin', 'built-in'], ['user-story', 'built-in'], ['bug-repro', 'built-in']]);
    expect(out.standards[0]).toMatchObject({ description: 'Checked in.', file: expect.stringMatching(/work\/\.toil\/standards\/team\.json$/), rules: [{ id: 'title', when: null, fail: 'thin', kind: 'words' }] });
    expect(out.standards[1]).toMatchObject({ name: 'gherkin', rules: [{ id: 'scenarios', when: { type: ['STORY'] }, kind: 'pattern' }] });
  });
});

describe('standards check', () => {
  it("checks against the toil project's standards, a path beside it and its field alias included", async () => {
    const items = JSON.stringify({ items: [{ ...JSON.parse(EXAMPLE_STANDARDS_RECORDS).items[0], native: { 'jira issue search': { fields: { customfield_10777: 'Low' } } } }] });
    const out = data(await cli(disk(), ['standards', 'check', '--toil-project', 'payments', '--input-file', 'items.json'], { 'items.json': items }));
    expect(out.toilProject).toBe('payments');
    expect(out.standards.map((s: any) => [s.name, s.source])).toEqual([['gherkin', 'built-in'], ['risk', 'toil-project']]);
    expect(out.items[0]).toMatchObject({ key: 'PAY-201', verdict: 'pass', results: [{ standard: 'gherkin', state: 'pass' }, { standard: 'risk', state: 'pass', source: 'risk (field customfield_10777)' }] });
  });

  it('takes --standard instead of the toil project\'s list, by name or file', async () => {
    const out = data(await cli(disk(), ['standards', 'check', '--toil-project', 'payments', '--standard', 'team', '--standard', 'bug-repro', '--input-file', 'items.json']));
    expect(out.standards.map((s: any) => s.name)).toEqual(['team', 'bug-repro']);
    expect(out.summary.byRule.map((r: any) => [r.rule, r.applies])).toEqual([['title', 3], ['steps', 1], ['expected', 1], ['actual', 1]]);
  });

  it('checks nothing, with a warning, when no toil project and no --standard name any', async () => {
    const none = await cli(disk(), ['standards', 'check', '--input-file', 'items.json']);
    expect(data(none)).toMatchObject({ toilProject: null, standards: [], summary: { items: 3, checked: 0, byRule: [] } });
    expect(codes(none)).toEqual(['STANDARDS_NONE']);
    const bare = await cli(disk(), ['standards', 'check', '--toil-project', 'bare', '--input-file', 'items.json']);
    expect(codes(bare)).toEqual(['STANDARDS_NONE']);
    expect(bare.meta.warnings![0]!.message).toContain('toil projects standards set bare');
  });

  it('refuses an unknown standard, and input with no work items', async () => {
    const unknown = await cli(disk(), ['standards', 'check', '--standard', 'nope', '--input-file', 'items.json']);
    expect(unknown.error).toMatchObject({ code: 'NOT_FOUND' });
    const empty = await cli(disk(), ['standards', 'check', '--standard', 'gherkin', '--text', '{"items":[]}']);
    expect(empty.error).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('is served over MCP with the same result', async () => {
    const session = await mcp(disk());
    const over = (await session.call('standards_check', { standard: ['gherkin', 'user-story', 'bug-repro'], inputFile: 'items.json' })).envelope;
    const local = await cli(disk(), ['standards', 'check', '--standard', 'gherkin', '--standard', 'user-story', '--standard', 'bug-repro', '--input-file', 'items.json']);
    expect(over.data).toEqual(local.data);
    expect((over.data as any).items.map((i: any) => i.verdict)).toEqual(['pass', 'pass', 'thin']);
  });
});

describe('projects standards set', () => {
  const fileOf = (d: ToilProjectDisk, name: string) => JSON.parse(readFileSync(join(d.home, '.toil', 'projects', `${name}.json`), 'utf8')) as Record<string, any>;

  it('sets the list, and refuses to change one without --replace', async () => {
    const d = disk();
    const out = data(await cli(d, ['projects', 'standards', 'set', 'bare', '--use', 'gherkin', '--use', 'bug-repro']));
    expect(out).toMatchObject({ name: 'bare', changed: true, standards: { use: ['gherkin', 'bug-repro'] } });
    expect(fileOf(d, 'bare').standards).toEqual({ use: ['gherkin', 'bug-repro'] });
    const again = await cli(d, ['projects', 'standards', 'set', 'bare', '--use', 'user-story']);
    expect(again.error).toMatchObject({ code: 'INVALID_INPUT', fix: 'Pass --replace to replace the list.' });
    expect(data(await cli(d, ['projects', 'standards', 'set', 'bare', '--use', 'user-story', '--replace'])).standards).toEqual({ use: ['user-story'] });
    // The same list again changes nothing.
    expect(data(await cli(d, ['projects', 'standards', 'set', 'bare', '--use', 'user-story'])).changed).toBe(false);
  });

  it('warns about a standard it cannot read yet, and refuses a ref that is neither a name nor a relative file', async () => {
    const d = disk();
    const later = await cli(d, ['projects', 'standards', 'set', 'bare', '--use', './later.json']);
    expect(data(later).standards).toEqual({ use: ['./later.json'] });
    expect(codes(later)).toEqual(['STANDARD_UNRESOLVED']);
    expect((await cli(d, ['projects', 'standards', 'set', 'bare', '--use', '/abs/rules.json', '--replace'])).error).toMatchObject({ code: 'INVALID_INPUT' });
    expect((await cli(d, ['projects', 'standards', 'set', 'bare', '--use', 'Team Rules', '--replace'])).error).toMatchObject({ code: 'INVALID_INPUT' });
    expect((await cli(d, ['projects', 'standards', 'set', 'bare'])).error).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('clears the key on the CLI, and refuses --clear over MCP', async () => {
    const d = disk();
    expect(data(await cli(d, ['projects', 'standards', 'set', 'payments', '--clear'])).standards).toBeNull();
    expect(fileOf(d, 'payments')).not.toHaveProperty('standards');
    const session = await mcp(disk());
    const refused = (await session.call('projects_standards_set', { toilProject: 'payments', clear: true })).envelope;
    expect(refused.error).toMatchObject({ code: 'INVALID_INPUT' });
    expect(refused.error!.message).toContain('CLI');
  });
});
