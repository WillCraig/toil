// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute as toil } from '@imagile-dev/toil/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classify } from '../../src/core/classify/engine.ts';
import { defaultScheme } from '../../src/core/classify/builtin.ts';
import { ClassifyRefusal, ClassifyService, STAGED_LIFETIME_MS, jsonIn, type ClassifyAgents } from '../server/classify.ts';
import { itemsInPrompt, scriptedVerdict } from '../src/fixtures/classify.ts';
import { SAMPLE_TEAM } from '../src/fixtures/sample-team.ts';
import type { Envelope, Execute, WorkItem } from '../src/toil.ts';

/**
 * The Classify view's server (#566) on toil's own commands, in a throwaway home: what it asks toil for, the plan file it
 * hands `categorize`, and the three things that would quietly corrupt a person's ledger if they were wrong (the label
 * outranking a person's say, a confirmation with no verdict to confirm, and the record after Apply reversing the say).
 * The tracker's `categorize` is the one command faked, because it is the one that would reach a service.
 */

const execute = toil as unknown as Execute;
const fwd = (p: string): string => p.split('\\').join('/');
let home = '';
let data = '';

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'toil-ui-classify-')));
  data = join(home, '.toil-ui');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  mkdirSync(join(home, '.toil', 'projects'), { recursive: true });
  writeFileSync(join(home, '.toil', 'projects', 'team.json'), JSON.stringify({ name: 'team', description: 'A team' }));
  // One that names its scheme, so a copy saved in the person's own folder is the one it reads from then on.
  writeFileSync(join(home, '.toil', 'projects', 'pinned.json'), JSON.stringify({ name: 'pinned', classify: { scheme: 'ktlo-feature' } }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

/** Items from the sample team that no parent decides, so each is classified on its own. */
const standalone = (): WorkItem[] => {
  const items = SAMPLE_TEAM.owi.items as WorkItem[];
  const verdicts = new Map(classify({ scheme: defaultScheme(), items }).result.verdicts.map((v) => [v.id, v]));
  return items.filter((i) => !i.parent && verdicts.get(i.id)!.category !== null && !(SAMPLE_TEAM.owi.items as WorkItem[]).some((o) => o.parent === i.id));
};

const ok = (command: string, data: unknown): Envelope => ({ ok: true, data, error: null, meta: { command, durationMs: 0, version: 't', contractVersion: 1 } }) as Envelope;

/** toil for everything, except what would reach a tracker: connections are listed as the test says, and categorize is only recorded. */
function wrapped(writes: boolean) {
  const calls: Array<{ command: string; input: Record<string, unknown>; options: Record<string, unknown>; plan: string }> = [];
  const run: Execute = async (command, input = {}, options = {}) => {
    if (command === 'connections list') return ok(command, { configFile: 'x', connections: [{ name: 'sample-jira', area: 'jira', isDefault: true, host: null, writes, values: {} }] });
    if (command.endsWith('categorize')) {
      // The plan file is read as `categorize` would: Apply removes it once the flow ends.
      calls.push({ command, input, options: options as Record<string, unknown>, plan: readFileSync(String(input.inputFile), 'utf8') });
      return ok(command, { connection: 'sample-jira', changed: [{ id: 'x', key: 'SHOP-1', category: 'feature', labels: { added: ['feature'], removed: ['ktlo'] }, field: null }], unchanged: [], failed: [], skipped: [], counts: { planned: 1, changed: 1, unchanged: 0, failed: 0 } });
    }
    return execute(command, input, options);
  };
  return { run, calls };
}

const answers = (text: (prompt: string) => string): ClassifyAgents => ({
  list: async () => [{ name: 'scripted', label: 'Scripted', ready: true, problem: null }],
  run: async ({ prompt }) => ({ text: text(prompt), by: 'Scripted' }),
});
const signal = new AbortController().signal;
const service = (run: Execute, agents: ClassifyAgents | null = null) => new ClassifyService({ execute: run, dataDir: data, agents, uid: (() => { let n = 0; return () => `u${++n}`; })() });

describe('the ledger the page reads', () => {
  it('is an empty ledger with nothing checked, the built-in scheme, and no figure turned into 0', async () => {
    const view = await service(execute).ledger('team');
    expect(view.scheme.name).toBe('ktlo-feature');
    expect(view.kept).toBe('built-in');
    expect(view.standing).toEqual({});
    expect(view.stats?.agreement.overall).toBeNull();
    expect(view.stats?.ledger.lines).toBe(0);
  });

  it("records a person's word, with the verdict recorded first so a confirmation counts as agreement", async () => {
    const [item] = standalone();
    const verdict = classify({ scheme: defaultScheme(), items: [item!] }).result.verdicts[0]!;
    const s = service(execute);
    await s.correct('team', { item: item!, context: [], to: verdict.category, reason: 'Yes, that is right.' });
    const view = await s.ledger('team');
    expect(view.standing[item!.id]).toMatchObject({ category: verdict.category, reason: 'Yes, that is right.', via: 'api' });
    expect(view.stats?.ledger).toMatchObject({ verdicts: 1, confirmations: 1, corrections: 0 });
    expect(view.stats?.agreement).toMatchObject({ overall: 1, checked: 1 });
  });

  it('keeps a taking-back as a null say, so an item answered "unsure" is not shown as waiting', async () => {
    const [item] = standalone();
    const s = service(execute);
    await s.correct('team', { item: item!, context: [], to: null, reason: '' });
    expect((await s.ledger('team')).standing[item!.id]).toMatchObject({ category: null, reason: null });
  });
});

describe('the plan and Apply', () => {
  /** A ktlo-labelled item that a person says is Feature: the label would win without `recheck`. */
  const labelled = (): WorkItem => ({ ...standalone().find((i) => i.source.area === 'jira')!, labels: ['ktlo'] });

  it("plans what a person decided over a label already on the item: the label comes off and theirs goes on", async () => {
    const item = labelled();
    const { run } = wrapped(true);
    const s = service(run);
    await s.correct('team', { item, context: [], to: 'feature', reason: 'It adds a feature.' });
    const plan = await s.plan('team', { items: [item] });
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]).toMatchObject({ area: 'jira', connection: 'sample-jira', writes: true, command: { name: 'jira issue categorize' } });
    expect(plan.groups[0]!.changes).toEqual([expect.objectContaining({ id: item.id, category: 'feature', labelsFrom: ['ktlo'], labelsAdd: ['feature'], labelsRemove: ['ktlo'], field: null })]);
  });

  it('applies through the tracker\'s own categorize, on a plan file in its own folder, with allowWrite, then leaves the person\'s say standing', async () => {
    const item = labelled();
    const { run, calls } = wrapped(true);
    const s = service(run);
    await s.correct('team', { item, context: [], to: 'feature', reason: 'It adds a feature.' });
    const { id } = await s.plan('team', { items: [item] });
    const result = await s.apply('team', id, signal);
    expect(result.outcomes[0]).toMatchObject({ connection: 'sample-jira', refused: null, changed: [{ key: 'SHOP-1' }] });
    expect(result.recorded).toEqual({ ok: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: 'jira issue categorize', input: { connection: 'sample-jira', allowWrite: true }, options: { readOnly: false, caller: 'toil-ui' } });
    const file = String(calls[0]!.input.inputFile);
    expect(fwd(file).startsWith(fwd(join(data, 'classify')))).toBe(true);
    expect(existsSync(file)).toBe(false);
    const written = JSON.parse(calls[0]!.plan) as { plan: Array<{ connection: string; items: Array<{ id: string; category: string; labels: { add: string[]; remove: string[] } }> }> };
    expect(written.plan).toHaveLength(1);
    expect(written.plan[0]!.items).toEqual([expect.objectContaining({ id: item.id, category: 'feature', labels: { add: ['feature'], remove: ['ktlo'] } })]);

    // The record after Apply ran on an item that still holds the old label, and must not have read that as someone changing it back.
    const view = await s.ledger('team');
    expect(view.standing[item.id]?.category).toBe('feature');
    const lines = readFileSync(join(home, '.toil', 'classify', 'ktlo-feature.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; item: string; via?: string; to?: string });
    expect(lines.filter((l) => l.via === 'tracker')).toEqual([]);
    expect(lines.filter((l) => l.kind === 'correction' && l.item === item.id).map((l) => l.to)).toEqual(['feature']);
  });

  it("reports that writes are off for the connection, from toil's own list, without writing anything", async () => {
    const item = labelled();
    const { run, calls } = wrapped(false);
    const s = service(run);
    await s.correct('team', { item, context: [], to: 'feature', reason: '' });
    const plan = await s.plan('team', { items: [item] });
    expect(plan.groups[0]!.writes).toBe(false);
    expect(calls).toEqual([]);
  });

  it('does a second Apply with nothing to run twice at once', async () => {
    const item = labelled();
    const { run } = wrapped(true);
    const s = service(run);
    await s.correct('team', { item, context: [], to: 'feature', reason: '' });
    const { id } = await s.plan('team', { items: [item] });
    const first = s.apply('team', id, signal);
    await expect(s.apply('team', id, signal)).rejects.toMatchObject({ status: 409 });
    await first;
  });

});

/** The files this service keeps while a flow is open: every working file it writes is in this folder. */
const working = (): string[] => (existsSync(join(data, 'classify')) ? readdirSync(join(data, 'classify')).sort() : []);
const ledgerLines = (scheme = 'ktlo-feature') => readFileSync(join(home, '.toil', 'classify', `${scheme}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; item: string; via?: string; to?: string });

describe("a person's say survives the next record", () => {
  it('keeps a corrected parent when a correction on its child records the parent again with the label the tracker still holds', async () => {
    const jira = standalone().filter((i) => i.source.area === 'jira');
    const parent: WorkItem = { ...jira[0]!, labels: ['ktlo'] };
    const child: WorkItem = { ...jira[1]!, parent: parent.id, labels: [] };
    const s = service(execute);
    await s.correct('team', { item: parent, context: [], to: 'feature', reason: 'It adds a feature.' });
    // The review's exact trigger: the child's correction sends the parent along as context, with its old label.
    await s.correct('team', { item: child, context: [parent], to: 'ktlo', reason: 'Housekeeping.' });
    const view = await s.ledger('team');
    expect(view.standing[parent.id]).toMatchObject({ category: 'feature', via: 'api', from: 'ktlo' });
    expect(view.standing[child.id]?.category).toBe('ktlo');
    expect(ledgerLines().filter((l) => l.via === 'tracker')).toEqual([]);
    expect(ledgerLines().filter((l) => l.kind === 'correction' && l.item === parent.id).map((l) => l.to)).toEqual(['feature']);
  });
});

describe("the scheme a toil project's own file holds", () => {
  const BESIDE = { name: 'ktlo-feature', revision: 1, categories: defaultScheme().categories, guidance: ['Beside the project.'], examples: [], rules: [], signals: true, labels: {} };
  const mine = () => {
    mkdirSync(join(home, '.toil', 'projects', 'schemes'), { recursive: true });
    writeFileSync(join(home, '.toil', 'projects', 'mine.json'), JSON.stringify({ name: 'mine', classify: { scheme: './schemes/mine-scheme.json' } }));
    writeFileSync(join(home, '.toil', 'projects', 'schemes', 'mine-scheme.json'), JSON.stringify({ ...BESIDE, name: 'mine-scheme' }));
  };

  it('is the scheme the page shows, says it is beside the Toil project, and is saved in place', async () => {
    mine();
    const s = service(execute);
    const view = await s.ledger('mine');
    expect(view.scheme.name).toBe('mine-scheme');
    expect(view.scheme.guidance).toEqual(['Beside the project.']);
    expect(view.kept).toBe('beside');
    const saved = await s.saveScheme('mine', { ...view.scheme, guidance: ['Changed.'] });
    expect(saved).toMatchObject({ revision: 2, kept: 'beside' });
    expect(saved.pointProject).toBeUndefined();
    const file = join(home, '.toil', 'projects', 'schemes', 'mine-scheme.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ revision: 2, guidance: ['Changed.'] });
    // No stray copy in the person's own folder, and the Toil project reads what was saved.
    expect(existsSync(join(home, '.toil', 'classify', 'mine-scheme.json'))).toBe(false);
    expect((await s.ledger('mine')).scheme.revision).toBe(2);
  });

  it("applies an AI agent's revision to that same file", async () => {
    mine();
    const [item] = standalone();
    const s0 = service(execute);
    await s0.correct('mine', { item: item!, context: [], to: 'feature', reason: '' });
    const agent = answers((prompt) => (prompt.startsWith('Sharpen the classification scheme') ? JSON.stringify({ ...BESIDE, guidance: ['Sharper.'] }) : '[]'));
    const s = service(execute, agent);
    const tuned = await s.tune('mine', [item!], undefined, signal);
    expect(tuned.before.guidance).toEqual(['Beside the project.']);
    expect(await s.applyRevision(tuned.id)).toMatchObject({ revision: 2, kept: 'beside' });
    expect(JSON.parse(readFileSync(join(home, '.toil', 'projects', 'schemes', 'mine-scheme.json'), 'utf8')).guidance).toEqual(['Sharper.']);
  });

  it("says plainly when a saved copy is one the Toil project doesn't read: it names no scheme, so it uses the built-in one", async () => {
    const s = service(execute);
    const saved = await s.saveScheme('team', { ...defaultScheme(), guidance: ['Mine.'] });
    expect(saved).toMatchObject({ revision: 2, kept: 'yours', pointProject: 'ktlo-feature' });
  });
});

describe("an AI agent's revision may not change what trackers are written", () => {
  const correctedItems = async () => {
    const items = standalone().slice(0, 16);
    const s0 = service(execute);
    for (const item of items) {
      const v = classify({ scheme: defaultScheme(), items: [item] }).result.verdicts[0]!;
      await s0.correct('team', { item, context: [], to: v.category === 'ktlo' ? 'feature' : 'ktlo', reason: 'People disagree.' });
    }
    return items;
  };
  const tuning = (revised: unknown) =>
    answers((prompt) => (prompt.startsWith('Sharpen the classification scheme') ? JSON.stringify(revised) : JSON.stringify(itemsInPrompt(prompt).map((i) => ({ id: i.id, category: 'feature', reason: 'x' })))));

  it("puts a rewritten label back and lists it as ignored, and shows the label of a category it adds", async () => {
    const items = await correctedItems();
    const base = defaultScheme();
    const revised = {
      ...base,
      categories: [{ ...base.categories[0]!, label: 'keep-lights' }, base.categories[1]!, { id: 'chore', short: 'Chore', name: 'Chore', label: 'chore', definition: 'Housekeeping.' }],
      labels: { jira: { ktlo: 'KEEP' } },
    };
    const tuned = await service(execute, tuning(revised)).tune('team', items, undefined, signal);
    expect(tuned.after.categories.map((c) => c.label)).toEqual(['ktlo', 'feature', 'chore']);
    expect(tuned.after.labels).toEqual({});
    expect(tuned.changes).toContain('Adds the category "Chore", written to trackers as the label `chore`: Housekeeping.');
    expect(tuned.changes.filter((c) => c.startsWith("Ignored: an AI agent can't change a label"))).toHaveLength(2);
    expect(tuned.changes.join('\n')).toContain('`ktlo`, not `keep-lights`');
  });

  it('refuses a revision that removes or renames a category id, proposing nothing', async () => {
    const items = await correctedItems();
    const base = defaultScheme();
    const renamed = { ...base, categories: [{ ...base.categories[0]!, id: 'keep-lights' }, base.categories[1]!] };
    await expect(service(execute, tuning(renamed)).tune('team', items, undefined, signal)).rejects.toThrow(/Category ids are what the ledger records/);
    const dropped = { ...base, categories: [base.categories[0]!, { id: 'chore', short: 'Chore', name: 'Chore', label: 'chore', definition: 'Housekeeping.' }] };
    await expect(service(execute, tuning(dropped)).tune('team', items, undefined, signal)).rejects.toThrow(/removes or renames the category "feature"/);
  });
});

describe('Apply runs the plan the card showed', () => {
  const labelled = (): WorkItem => ({ ...standalone().find((i) => i.source.area === 'jira')!, labels: ['ktlo'] });

  it('writes what was planned even when the ledger changed between the plan and the press', async () => {
    const item = labelled();
    const { run, calls } = wrapped(true);
    const s = service(run);
    await s.correct('team', { item, context: [], to: 'feature', reason: '' });
    const plan = await s.plan('team', { items: [item] });
    expect(plan.groups[0]!.changes[0]).toMatchObject({ category: 'feature', labelsAdd: ['feature'] });
    // Someone else (another tab, the CLI) says the opposite after the card was read.
    await service(execute).correct('team', { item, context: [], to: 'ktlo', reason: 'Changed my mind.' });
    await s.apply('team', plan.id, signal);
    const written = JSON.parse(calls[0]!.plan) as { plan: Array<{ items: Array<{ category: string }> }> };
    expect(written.plan[0]!.items[0]!.category).toBe('feature');
  });

  it('refuses an id it does not keep, one for another Toil project, one it already applied, and one that has expired', async () => {
    const item = labelled();
    let now = 1_000_000;
    const { run } = wrapped(true);
    const s = new ClassifyService({ execute: run, dataDir: data, agents: null, now: () => now, uid: (() => { let n = 0; return () => `u${++n}`; })() });
    await s.correct('team', { item, context: [], to: 'feature', reason: '' });
    await expect(s.apply('team', 'nope', signal)).rejects.toMatchObject({ status: 404 });
    const first = await s.plan('team', { items: [item] });
    await expect(s.apply('other', first.id, signal)).rejects.toMatchObject({ status: 404 });
    await s.apply('team', first.id, signal);
    await expect(s.apply('team', first.id, signal)).rejects.toMatchObject({ status: 404 });
    const second = await s.plan('team', { items: [item] });
    now += STAGED_LIFETIME_MS + 1;
    await expect(s.apply('team', second.id, signal)).rejects.toThrow(/no longer kept/);
  });
});

describe('a revision is applied only to the scheme it was made from', () => {
  it('refuses "Use this version" once the scheme has changed since, and leaves the newer edit alone', async () => {
    const items = standalone().slice(0, 16);
    const s0 = service(execute);
    for (const item of items) await s0.correct('pinned', { item, context: [], to: 'feature', reason: '' });
    const agent = answers((prompt) => (prompt.startsWith('Sharpen the classification scheme') ? JSON.stringify({ ...defaultScheme(), guidance: ['The agent says so.'] }) : '[]'));
    const s = service(execute, agent);
    const tuned = await s.tune('pinned', items, undefined, signal);
    // A newer edit lands first, from the editor.
    await s.saveScheme('pinned', { ...defaultScheme(), guidance: ['A person got there first.'] });
    await expect(s.applyRevision(tuned.id)).rejects.toMatchObject({ status: 409, message: 'The scheme changed since this revision was proposed. Ask for a new one.' });
    expect(JSON.parse(readFileSync(join(home, '.toil', 'classify', 'ktlo-feature.json'), 'utf8'))).toMatchObject({ revision: 2, guidance: ['A person got there first.'] });
  });

  it('refuses an editor draft made from an older revision', async () => {
    const s = service(execute);
    await s.saveScheme('pinned', { ...defaultScheme(), guidance: ['First.'] });
    await expect(s.saveScheme('pinned', { ...defaultScheme(), guidance: ['Second, from a stale page.'] })).rejects.toMatchObject({ status: 409 });
  });
});

describe('working files', () => {
  it('are removed when the flow ends: a plan applied, a tune answered, a revision used, a scheme saved', async () => {
    const item: WorkItem = { ...standalone().find((i) => i.source.area === 'jira')!, labels: ['ktlo'] };
    const { run } = wrapped(true);
    const agent = answers((prompt) => (prompt.startsWith('Sharpen the classification scheme') ? JSON.stringify({ ...defaultScheme(), guidance: ['Sharper.'] }) : JSON.stringify(itemsInPrompt(prompt).map((i) => ({ id: i.id, category: 'feature', reason: 'x' })))));
    const s = service(run, agent);
    await s.correct('pinned', { item, context: [], to: 'feature', reason: '' });

    const plan = await s.plan('pinned', { items: [item] });
    // While the card is open, its plan is kept; an accepted suggestion is in the ledger and needs no file of its own.
    expect(working().filter((f) => /^(plan|verdicts)-/.test(f))).toHaveLength(1);
    await s.apply('pinned', plan.id, signal);
    expect(working()).toEqual([]);

    const abandoned = await s.plan('pinned', { items: [item] });
    expect(working()).toHaveLength(1);
    void abandoned;

    const items = standalone().slice(0, 16);
    for (const i of items) await s.correct('pinned', { item: i, context: [], to: 'ktlo', reason: '' });
    const tuned = await s.tune('pinned', items, undefined, signal);
    // Only the revision itself waits for a press; the answers it was scored with are gone.
    expect(working().filter((f) => /^(answers|revised)-/.test(f))).toEqual([expect.stringMatching(/^revised-/)]);
    await s.applyRevision(tuned.id);
    await s.saveScheme('pinned', { ...defaultScheme(), guidance: ['Saved.'], revision: 2 });
    expect(working().filter((f) => !f.startsWith('plan-'))).toEqual([]);
  });

  it('are swept on start when a day old, and only the names this module writes', () => {
    const dir = join(data, 'classify');
    mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const files = ['plan-abc12345.json', 'verdicts-u1.json', 'notes.json', 'plan-fresh.json'];
    for (const f of files) writeFileSync(join(dir, f), '{}');
    for (const f of files.filter((f) => f !== 'plan-fresh.json')) utimesSync(join(dir, f), old, old);
    service(execute);
    expect(working()).toEqual(['notes.json', 'plan-fresh.json']);
  });
});

describe('asking the AI agent', () => {
  const unsure = (): WorkItem[] => {
    const items = SAMPLE_TEAM.owi.items as WorkItem[];
    const verdicts = new Map(classify({ scheme: defaultScheme(), items }).result.verdicts.map((v) => [v.id, v]));
    return items.filter((i) => verdicts.get(i.id)!.category === null);
  };
  const fenced = (list: unknown) => `Here is my answer.\n\n\`\`\`json\n${JSON.stringify(list)}\n\`\`\`\nHope that helps.`;

  it("gives toil's own question, with no tool, and returns the answers it checked", async () => {
    const seen: string[] = [];
    const agent = answers((prompt) => {
      seen.push(prompt);
      return fenced(itemsInPrompt(prompt).map((i) => scriptedVerdict(i.id, i.title)));
    });
    const got = await service(execute, agent).ask('team', unsure().slice(0, 4), undefined, signal);
    expect(seen[0]).toContain('Classify each work item below into one category of the scheme "ktlo-feature"');
    expect(got.by).toBe('Scripted');
    expect(got.answers).toHaveLength(4);
    expect(got.answers.every((a) => ['ktlo', 'feature', 'unsure'].includes(a.category))).toBe(true);
  });

  it('refuses an answer with an id that was not asked about, and one with a category the scheme lacks, proposing nothing', async () => {
    const items = unsure().slice(0, 2);
    await expect(service(execute, answers(() => fenced([{ id: 'sample-jira:NOPE-9', category: 'feature', reason: 'x' }]))).ask('team', items, undefined, signal)).rejects.toThrow(/not one of the items/);
    await expect(service(execute, answers(() => fenced([{ id: items[0]!.id, category: 'chore', reason: 'x' }]))).ask('team', items, undefined, signal)).rejects.toThrow(/not a category/);
    await expect(service(execute, answers(() => 'I could not decide.')).ask('team', items, undefined, signal)).rejects.toThrow(/no list/);
  });

  it('says so, plainly, when no agent is set up', async () => {
    await expect(service(execute, null).ask('team', unsure().slice(0, 2), undefined, signal)).rejects.toMatchObject({ status: 404 });
  });

  it('finds a JSON list or object in prose, fenced or bare', () => {
    expect(jsonIn('Sure: [{"id":"a"}] done', '[')).toBe('[{"id":"a"}]');
    expect(jsonIn('```json\n{"a":[1,2]}\n```\n[1]', '{')).toBe('{"a":[1,2]}');
    expect(jsonIn('no json here', '[')).toBeNull();
  });
});

describe('improving the categories', () => {
  it("runs the agent's revision through toil's reader, scores it on held-back corrections, and applies it only as a person's command", async () => {
    const s0 = service(execute);
    const items = standalone().slice(0, 16);
    // Sixteen people's words, each the opposite of what the scheme said, so some are held back and the tune has something to learn from.
    for (const item of items) {
      const v = classify({ scheme: defaultScheme(), items: [item] }).result.verdicts[0]!;
      await s0.correct('team', { item, context: [], to: v.category === 'ktlo' ? 'feature' : 'ktlo', reason: 'People disagree.' });
    }
    const agent = answers((prompt) => {
      if (prompt.startsWith('Sharpen the classification scheme')) {
        const scheme = defaultScheme();
        return JSON.stringify({ ...scheme, guidance: [...scheme.guidance, 'A fix that adds a capability is Feature.'] });
      }
      return JSON.stringify(itemsInPrompt(prompt).map((i) => ({ id: i.id, category: 'feature', reason: 'It adds something.' })));
    });
    const s = service(execute, agent);
    const tuned = await s.tune('team', items, undefined, signal);
    expect(tuned.changes).toEqual(['Adds the guidance: A fix that adds a capability is Feature.']);
    expect(tuned.backtest).toMatchObject({ worse: expect.any(Boolean) });
    expect(tuned.backtest!.heldBack).toBeGreaterThan(0);
    // Nothing was written by asking: the scheme is still the built-in one.
    expect(existsSync(join(home, '.toil', 'classify', 'ktlo-feature.json'))).toBe(false);

    const saved = await s.applyRevision(tuned.id);
    expect(saved).toMatchObject({ revision: 2, kept: 'yours' });
    expect(JSON.parse(readFileSync(join(home, '.toil', 'classify', 'ktlo-feature.json'), 'utf8')).revision).toBe(2);
  });

  it('shows a revision that scores worse as worse', async () => {
    const s0 = service(execute);
    const items = standalone().slice(0, 16);
    const was = new Map(items.map((i) => [i.id, classify({ scheme: defaultScheme(), items: [i] }).result.verdicts[0]!.category!]));
    // People confirm every verdict but one, so the scheme as it is agrees with them; a revision that answers the opposite scores worse.
    for (const [n, item] of items.entries()) await s0.correct('team', { item, context: [], to: n === 0 ? (was.get(item.id) === 'ktlo' ? 'feature' : 'ktlo') : was.get(item.id)!, reason: '' });
    const agent = answers((prompt) => {
      if (prompt.startsWith('Sharpen the classification scheme')) return JSON.stringify({ ...defaultScheme(), guidance: ['Everything is the other thing.'] });
      return JSON.stringify(itemsInPrompt(prompt).map((i) => ({ id: i.id, category: was.get(i.id) === 'ktlo' ? 'feature' : 'ktlo', reason: 'The other one.' })));
    });
    const tuned = await service(execute, agent).tune('team', items, undefined, signal);
    expect(tuned.backtest!.heldBack).toBeGreaterThan(0);
    expect(tuned.backtest!.after.agreement!).toBeLessThan(tuned.backtest!.before.agreement!);
    expect(tuned.backtest!.worse).toBe(true);
  });

  it('refuses a revised scheme toil would not read, proposing nothing', async () => {
    const s0 = service(execute);
    const [item] = standalone();
    await s0.correct('team', { item: item!, context: [], to: 'feature', reason: '' });
    const bad = answers(() => '{"categories": []}');
    await expect(service(execute, bad).tune('team', [item!], undefined, signal)).rejects.toThrow(/can't be used/);
  });
});

describe("saving the editor's scheme", () => {
  it('writes it as the first revision of your own copy, through the file service and the person\'s command', async () => {
    const scheme = { ...defaultScheme(), rules: [{ id: 'epics', when: { title: ['epic'] }, then: 'feature' }] };
    const saved = await service(execute).saveScheme('team', scheme);
    expect(saved).toMatchObject({ revision: 2, kept: 'yours' });
    const kept = JSON.parse(readFileSync(join(home, '.toil', 'classify', 'ktlo-feature.json'), 'utf8'));
    expect(kept.rules).toEqual([{ id: 'epics', when: { title: ['epic'] }, then: 'feature' }]);
  });

  it('refuses a scheme toil would refuse, and one named for another scheme', async () => {
    await expect(service(execute).saveScheme('team', { name: 'ktlo-feature', categories: [] })).rejects.toBeInstanceOf(ClassifyRefusal);
    await expect(service(execute).saveScheme('team', { ...defaultScheme(), name: 'other' })).rejects.toThrow(/uses the scheme ktlo-feature/);
  });
});
