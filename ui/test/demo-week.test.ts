// @vitest-environment node
/**
 * The demo data (.claude/skills/sandboxes/demo-reset.md) offline: the demo code demo-week.mjs pushes
 * to the sandboxes runs its own tests, each agent-ready item names files that
 * exist and a starting state the code really has, and the Confluence knowledge
 * base's manifest is a tree whose every page file exists. The live runs are in
 * the PR; this is the rehearsal that needs no sandbox, and no rehearsal space.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { WorkItem } from '../../src/core/owi/types.ts';
import { BUILTIN_STANDARDS } from '../../src/core/standards/builtin.ts';
import { checkStandards } from '../../src/core/standards/check.ts';
import { blockerGantt } from '../src/model/gantt.ts';
import { prepare } from '../src/model/insights.ts';
import { readReadiness } from '../src/model/readiness.ts';
import { ADO_DUE_DAYS, ADO_DUPLICATE_BLOCKS, adoRepro, adoStory, AGENT_ITEMS, BUGS, GITHUB_POINTS, JIRA_BLOCKS, JIRA_DUE_DAYS, jiraStory, PRESET_RULES, RULE_GAPS, RULES, ruleMisses, SANDBOX, SKELETON, sprintDay, STORIES } from '../scripts/demo-week-data.mjs';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function writeSkeleton(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'demo-week-'));
  dirs.push(dir);
  for (const [path, text] of Object.entries({ ...SKELETON, ...extra })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
const nodeTest = (dir: string) => spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: dir, encoding: 'utf8' });

describe('the demo code', () => {
  it("passes its own tests, as the agent will find it", () => {
    const run = nodeTest(writeSkeleton());
    expect(run.stdout + run.stderr).toMatch(/# fail 0/);
    expect(run.status).toBe(0);
  });

  it('starts in the state each agent-ready item describes', async () => {
    const dir = writeSkeleton();
    const money = await import(join(dir, 'src', 'money.js'));
    expect(money.formatAmount(-123450)).toBe('-1234.50 USD'); // #38 asks for -$1,234.50
    const logger = await import(join(dir, 'src', 'logger.js'));
    expect(logger.describePaymentMethod({ number: '4242424242424242' })).toContain('4242424242424242'); // the maskPan story
    const refunds = await import(join(dir, 'src', 'refunds.js'));
    expect(() => refunds.createRefund({ paymentId: 'pay_1', amount: 5, reason: 'other' })).not.toThrow(); // the reason-code item
    expect(refunds.REASON_CODES).toHaveLength(4);
  });

  it('pins the two releases osv reports on, and installs nothing for its tests', () => {
    const pkg = JSON.parse(SKELETON['package.json'] ?? '{}');
    expect(pkg.dependencies).toEqual({ express: '4.19.2', jsonwebtoken: '8.5.1' });
    for (const [path, text] of Object.entries(SKELETON)) if (path.endsWith('.js')) expect(text).not.toMatch(/from '(express|jsonwebtoken)'/);
  });
});

describe('the agent-ready items', () => {
  it('name only files the demo code has, or the one each asks for', () => {
    const named = (text: string) => [...text.matchAll(/(?:src|test)\/[a-z-]+\.js/g)].map((m) => m[0]);
    const asked = new Set(['src/mask.js', 'test/mask.test.js']);
    for (const text of [AGENT_ITEMS.github.body, AGENT_ITEMS.jira.description, AGENT_ITEMS.ado.description, AGENT_ITEMS.ado.criteria]) {
      for (const path of named(text)) expect(Object.keys(SKELETON).includes(path) || asked.has(path), path).toBe(true);
    }
  });

  it('write only to the test projects', () => {
    expect(SANDBOX).toEqual({ owner: 'imagile-dev', repo: 'toil-sandbox', jiraProject: 'SCRUM', adoProject: 'Toil Sandbox' });
  });
});

// The data is held to toil's own ticket-rule checks (checkStandards with the built-in
// presets), and the scripts' small copy of them (ruleMisses, which the seeds use to look
// before they write) is held to agree with those checks on every item.
const PRESETS = BUILTIN_STANDARDS.filter((s) => ['gherkin', 'user-story', 'bug-repro'].includes(s.name)).map((standard) => ({ standard, source: 'built-in' as const }));
type Seeded = { area: 'github' | 'jira' | 'ado'; key: string; type: 'STORY' | 'BUG'; body: string; format: string; fields?: Record<string, string> };
const asItem = (s: Seeded) =>
  ({
    id: `${s.area}:${s.key}`,
    source: { area: s.area, connection: s.area, key: s.key, command: 'demo-week' },
    url: null, type: s.type, typeName: null, title: s.key, body: { format: s.format, content: s.body },
    status: null, statusCategory: 'TODO', labels: [], parent: null, children: [], links: [], unmapped: [],
    native: { 'demo-week': { fields: s.fields ?? {} } },
  }) as unknown as WorkItem;
/** What toil's checks find missing in each item, as `standard/rule`, in rule order. */
function missed(items: Seeded[]): Record<string, string[]> {
  const { result } = checkStandards({ standards: PRESETS, items: items.map(asItem) });
  return Object.fromEntries(result.items.map((i) => [i.key, i.results.filter((r) => r.state !== 'pass').map((r) => `${r.standard}/${r.rule}`)]));
}
const ado = (key: string, type: 'STORY' | 'BUG', description: string, fields: Record<string, string>): Seeded => ({ area: 'ado', key, type, body: description, format: 'html', fields });

describe('the ticket-rule demo', () => {
  const jiraStories = Object.keys(STORIES).map((key): Seeded => ({ area: 'jira', key, type: 'STORY', body: jiraStory(key), format: 'text' }));
  const adoStories = Object.keys(STORIES).map((key) => ado(key, 'STORY', adoStory(key).description, { 'Microsoft.VSTS.Common.AcceptanceCriteria': adoStory(key).criteria }));
  const adoBugs = Object.keys(BUGS).map((key) => ado(key, 'BUG', '<p>Seen in the test environment.</p>', { 'Microsoft.VSTS.TCM.ReproSteps': adoRepro(key) }));

  it('keeps the agent-ready items Ready under every rule, whatever type they are read as', () => {
    const agents: Seeded[] = [
      { area: 'github', key: '#38 as a bug', type: 'BUG', body: AGENT_ITEMS.github.body, format: 'markdown' },
      { area: 'github', key: '#38 as a story', type: 'STORY', body: AGENT_ITEMS.github.body, format: 'markdown' },
      { area: 'jira', key: 'SCRUM-55', type: 'STORY', body: AGENT_ITEMS.jira.description, format: 'text' },
      ado('#194', 'STORY', AGENT_ITEMS.ado.description, { 'Microsoft.VSTS.Common.AcceptanceCriteria': AGENT_ITEMS.ado.criteria }),
    ];
    const found = missed(agents);
    for (const a of agents) expect(found[a.key], a.key).toEqual([]);
    const { result } = checkStandards({ standards: PRESETS, items: agents.map(asItem) });
    for (const i of result.items) expect(i.verdict, i.key).toBe('pass');
  });

  it('leaves exactly the named stories thin in Jira, and passes every ADO story', () => {
    const jira = missed(jiraStories);
    for (const key of Object.keys(STORIES)) expect(jira[key], `Jira ${key}`).toEqual(RULE_GAPS.jira[key] ?? []);
    const adoFound = missed(adoStories);
    for (const key of Object.keys(STORIES)) expect(adoFound[key], `ADO ${key}`).toEqual([]);
    expect(Object.values(RULE_GAPS.jira).filter((g) => g.includes(RULES.gherkin))).toHaveLength(3);
    expect(Object.values(RULE_GAPS.jira).filter((g) => g.includes(RULES.userStory))).toHaveLength(2);
  });

  it('leaves exactly one bug without repro steps', () => {
    const found = missed(adoBugs);
    for (const key of Object.keys(BUGS)) expect(found[key], key).toEqual(RULE_GAPS.ado[key] ?? []);
    expect(Object.keys(RULE_GAPS.ado)).toEqual(['cw-bug-4']);
  });

  it("has the seeds' small copy of the checks agree with toil's on every item", () => {
    const all = [...jiraStories, ...adoStories, ...adoBugs];
    const found = { jira: missed(jiraStories), ado: missed([...adoStories, ...adoBugs]) };
    for (const s of all) {
      const copy = ruleMisses({ type: s.type, description: s.body, criteria: s.fields?.['Microsoft.VSTS.Common.AcceptanceCriteria'], reproSteps: s.fields?.['Microsoft.VSTS.TCM.ReproSteps'] });
      expect(copy, `${s.area} ${s.key}`).toEqual(found[s.area as 'jira' | 'ado'][s.key]);
    }
    // And on the shapes the trackers hand back that the seeds never write.
    expect(ruleMisses({ type: 'BUG', description: '<p>Broken.</p>', reproSteps: '<h3>Steps to reproduce</h3><ol><li>Pay</li></ol>' })).toEqual([RULES.expected, RULES.actual]);
    expect(ruleMisses({ type: 'TASK', description: '' })).toEqual([]);
  });

  it("copies the presets' patterns and headings exactly", () => {
    const presets = PRESETS.flatMap(({ standard: s }) =>
      s.rules.map((r) => {
        const c = r.check as { kind: string; in: string[]; match?: string[]; flags?: string; heading?: string[] };
        return { rule: `${s.name}/${r.id}`, type: r.when?.type?.[0], in: c.in, ...(c.kind === 'pattern' ? { match: c.match, flags: c.flags } : { heading: c.heading }) };
      }),
    );
    expect(PRESET_RULES).toEqual(presets);
  });
});

describe('the sprint plan', () => {
  const seed = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'scripts', 'ado-seed', 'items.owi.json'), 'utf8')) as { items: WorkItem[] };
  const blocks = seed.items.flatMap((i) => i.links.filter((l) => l.type === 'blocks' && l.direction === 'outward').map((l) => [i.source.key, l.target.split(':')[1]]));

  it("counts the sprint's working days from its first Monday", () => {
    expect([0, 4, 5, 9].map((n) => sprintDay('2026-11-27', n))).toEqual(['2026-11-16', '2026-11-20', '2026-11-23', '2026-11-27']);
  });

  it('dates every item inside the sprint, and leaves the hero story undated', () => {
    for (const n of [...Object.values(JIRA_DUE_DAYS), ...Object.values(ADO_DUE_DAYS)]) expect(n >= 0 && n <= 9).toBe(true);
    expect(JIRA_DUE_DAYS).not.toHaveProperty('SCRUM-32');
  });

  it("makes the Jira vault chain the critical chain by the timeline's own rule", () => {
    // The open blockers' links and points as the sandboxes hold them after a reseed (points read on 18 Nov 2026, GitHub's from its points labels).
    const points: Record<string, number> = { 'SCRUM-14': 5, 'SCRUM-15': 8, 'SCRUM-17': 3, 'SCRUM-18': 3, 'SCRUM-21': 2, 'SCRUM-24': 3, 'SCRUM-30': 5, 'SCRUM-23': 5, 'SCRUM-25': 5, 'SCRUM-43': 2, 'gh-11': 3, 'gh-12': 5, 'gh-17': 5, 'gh-18': GITHUB_POINTS['Rolling reserve']!, 'gh-7': 8, 'gh-8': 5, 'ado-152': 13, 'ado-169': 1 };
    const links = [['SCRUM-14', 'SCRUM-17'], ['SCRUM-14', 'SCRUM-24'], ['SCRUM-17', 'SCRUM-18'], ['SCRUM-17', 'SCRUM-21'], ['SCRUM-17', 'SCRUM-30'], ['SCRUM-43', 'SCRUM-25'], ['SCRUM-23', 'SCRUM-25'], ['gh-11', 'gh-12'], ['gh-12', 'gh-17'], ['gh-17', 'gh-18'], ['gh-7', 'gh-8'], ['ado-152', 'ado-169'], ...JIRA_BLOCKS];
    const started = new Set(['SCRUM-14', 'SCRUM-15', 'SCRUM-24', 'SCRUM-43', 'ado-152', 'ado-169']);
    const items = Object.keys(points).map((key) => ({
      owi: '0.2', id: `demo:${key}`, source: { area: 'jira', connection: 'demo', key, command: 'jira issue search' }, url: null, type: 'STORY', typeName: 'Story', title: key, body: null, status: null,
      statusCategory: started.has(key) ? 'IN_PROGRESS' : 'TODO', resolution: null, assignee: null, reporter: null, priority: null, estimate: { value: points[key], unit: 'points', field: 'points' }, labels: [], team: null, iteration: null, parent: null, children: [],
      links: links.flatMap(([a, b]): WorkItem['links'] => (a === key ? [{ type: 'blocks', direction: 'outward', target: `demo:${b}`, name: 'blocks' }] : b === key ? [{ type: 'blocks', direction: 'inward', target: `demo:${a}`, name: 'is blocked by' }] : [])),
      created: '2026-11-02T09:00:00.000Z', updated: null, resolved: null, dueDate: null, history: { transitions: [], iterations: [] }, unmapped: [], native: {},
    })) as WorkItem[];
    const now = '2026-11-18T09:00:00.000Z';
    const g = blockerGantt({ prepared: prepare({ items, changes: [], deployments: [], health: null, now }), health: null, readiness: readReadiness({}), now });
    expect(g.chain).toMatchObject({ ids: ['SCRUM-14', 'SCRUM-17', 'SCRUM-18', 'SCRUM-21', 'SCRUM-30'].map((k) => `demo:${k}`), points: 18 });
  });

  it('takes off only links the ado-seed made, keeps #152 -> #169, and leaves no other ADO chain', () => {
    for (const pair of ADO_DUPLICATE_BLOCKS) expect(blocks).toContainEqual(pair);
    const kept = blocks.filter(([a, b]) => !ADO_DUPLICATE_BLOCKS.some(([x, y]) => x === a && y === b));
    expect(kept).toEqual([['cp-pbi-1', 'st-pbi-3']]);
    expect(Object.keys(ADO_DUE_DAYS).sort()).toEqual(['cp-pbi-1', 'st-pbi-3']);
  });
});

describe('the Confluence knowledge base', () => {
  const base = join(import.meta.dirname, '..', 'scripts', 'demo-confluence');
  const manifest = JSON.parse(readFileSync(join(base, 'manifest.json'), 'utf8')) as {
    space: { key: string; name: string };
    pages: { title: string; parent: string | null; file: string; labels: string[] }[];
  };

  it('is the space the docs name, with the pages they count', () => {
    expect(manifest.space.key).toBe('OD');
    expect(manifest.pages).toHaveLength(23);
    expect(readFileSync(join(import.meta.dirname, '..', '..', '.claude', 'skills', 'sandboxes', 'demo-reset.md'), 'utf8')).toContain(`${manifest.pages.length} pages`);
  });

  it('lists every page after its parent, each with its file and the kb label', () => {
    const seen = new Set<string | null>([null]);
    for (const page of manifest.pages) {
      expect(seen.has(page.parent), `${page.title} comes before its parent ${page.parent}`).toBe(true);
      expect(existsSync(join(base, page.file)), page.file).toBe(true);
      expect(page.labels).toContain('kb');
      seen.add(page.title);
    }
  });
});
