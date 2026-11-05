import { describe, expect, it } from 'vitest';
import { citationsOf, segments } from '../src/agent.ts';
import { SCRIPTS, VOICED, scriptedAgent } from '../src/fixtures/agent.ts';
import { FIXTURE_NOW } from '../src/fixtures/execute.ts';
import { THEMES } from '../src/themes.ts';
import { needsAttention, prepare } from '../src/model/insights.ts';
import { people } from '../src/model/people.ts';
import { openQueue } from '../src/model/prs.ts';
import { NAMES, healthOf } from './harness.ts';

/**
 * The scripted Agent against what each dashboard loads: every figure and
 * citation in its answers is recomputed from the toil project's data, so the
 * script can't drift from the fixture `execute()`.
 */

const agent = scriptedAgent();
const sorted = (a: string[]) => [...new Set(a)].sort();
const cites = (text: string) => segments(text).flatMap((s) => ('cite' in s ? [s.cite] : []));
const text = async (toilProject: string, id: string) => (await agent.ask(toilProject, id)).parts.map((p) => p.text).join(' ');

describe('the scripted agent', () => {
  it.each(NAMES)('offers the same five starters for %s', (name) => {
    expect(agent.starters(name).map((s) => s.label)).toEqual(["What's at risk in this Toil project?", 'What needs attention first?', 'Where is this work deployed?', "Who's overloaded or blocked?", "What's stuck in review, and why?"]);
  });

  it('streams each answer as it grows, never splitting a citation, and ends on the whole answer', async () => {
    const seen: string[] = [];
    let last;
    for await (const partial of agent.stream!('card-payments', 'risk')) {
      seen.push(partial.parts.map((p) => p.text).join(' '));
      for (const p of partial.parts) expect(p.text.match(/\[\[/g)?.length ?? 0).toBe(p.text.match(/\]\]/g)?.length ?? 0);
      last = partial;
    }
    expect(seen.length).toBeGreaterThan(10);
    expect(seen.every((s, i) => i === 0 || s.length >= seen[i - 1]!.length)).toBe(true);
    expect(last).toEqual(await agent.ask('card-payments', 'risk'));
  });

  it('stops streaming when the signal aborts', async () => {
    const controller = new AbortController();
    let n = 0;
    for await (const partial of agent.stream!('settlement', 'risk', controller.signal)) {
      expect(partial.prompt).toBe("What's at risk in this Toil project?");
      if (++n === 3) controller.abort();
    }
    expect(n).toBe(3);
  });

  it.each(NAMES)("cites only %s's own items and pull requests, and every answer cites some", async (name) => {
    const { byId: items, data } = await healthOf(name);
    const byId = new Set([...items.keys(), ...data.pullRequests.map((c) => c.id)]);
    for (const { id } of agent.starters(name)) {
      const answer = await agent.ask(name, id);
      expect(answer.by).toBe('scripted');
      expect(answer.citations).toEqual(citationsOf(answer.parts));
      expect(answer.citations.length).toBeGreaterThan(0);
      for (const cite of answer.citations) expect(byId.has(cite), cite).toBe(true);
    }
  });

  it('answers by label as well as by id, and only for the Toil project asked about', async () => {
    expect((await agent.ask('settlement', 'Where is this work deployed?')).parts).toEqual((await agent.ask('settlement', 'deployed')).parts);
    expect((await agent.ask('settlement', 'risk')).parts).not.toEqual((await agent.ask('checkout-web', 'risk')).parts);
  });

  it('says plainly when a question is outside the script', async () => {
    const answer = await agent.ask('card-payments', 'What should we cut?');
    expect(answer.citations).toEqual([]);
    expect(answer.parts[0]!.text).toMatch(/only its starter questions/);
    expect(agent.starters('no-such-toil-project')).toEqual([]);
  });
});

describe.each(NAMES)('the %s script agrees with the model', (name) => {
  it('quotes the sprint figures health() computes', async () => {
    const { h } = await healthOf(name);
    const risk = await text(name, 'risk');
    const total = h.done.points + h.remaining.points;
    expect(risk).toContain(`day ${h.days.gone} of ${h.days.total}`);
    expect(risk).toMatch(new RegExp(`${h.done.points} of ${total} points (is|are) done and ${h.remaining.points} remain`));
    for (const id of h.otherUnits) expect(cites(risk)).toContain(id);
  });

  it('cites every risky item, blocker, item added and carry-over', async () => {
    const { h, byId } = await healthOf(name);
    const cited = (await agent.ask(name, 'risk')).citations;
    const blockers = h.risks.flatMap((r) => r.reasons.flatMap((x) => (x.code === 'blocked' ? [x.by] : [])));
    const kind = (k: string) => h.items.filter((i) => h.entries.get(i.id)!.kind === k).map((i) => i.id);
    expect(cited).toEqual(expect.arrayContaining(sorted([...h.risks.map((r) => r.id), ...blockers, ...kind('added'), ...kind('carried')])));
    const blocked = h.risks.filter((r) => r.reasons.some((x) => x.code === 'blocked')).map((r) => byId.get(r.id)!.estimate?.value ?? 0);
    if (blocked.length > 1) expect(await text(name, 'risk')).toContain(`holding ${blocked.reduce((a, b) => a + b, 0)} points back`);
  });

  it('names every environment, its commit, and exactly the items running there', async () => {
    const { data } = await healthOf(name);
    const answer = await agent.ask(name, 'deployed');
    for (const d of data.deployments) {
      const part = answer.parts.find((p) => p.text.includes(`The ${d.environment} environment runs`))!;
      expect(part, d.environment).toBeDefined();
      expect(part.text).toContain(`(${d.commit})`);
      if (d.items.length) expect(sorted(cites(part.text))).toEqual(sorted(d.items.filter((id) => data.items.find((i) => i.id === id)?.type !== 'EPIC')));
    }
    // And the items with a pull request still open are named as not deployed.
    const open = data.changes.filter((c) => c.kind === 'pull-request' && c.outcome === 'open').flatMap((c) => c.items);
    const sprintOpen = open.filter((id) => data.items.find((i) => i.id === id)?.type !== 'EPIC' && data.items.find((i) => i.id === id)?.type !== 'OTHER');
    expect(sorted(cites(answer.parts.at(-1)!.text))).toEqual(sorted(sprintOpen));
  });
});

describe.each(NAMES)('the %s review answer agrees with the open queue', (name) => {
  it('takes the open pull requests in queue order, each with its wait and the items it carries', async () => {
    const { data, byId } = await healthOf(name);
    const queue = openQueue(data.pullRequests, byId, FIXTURE_NOW);
    const answer = await agent.ask(name, 'review');
    const prs = new Set(data.pullRequests.map((c) => c.id));
    const cited = answer.parts.map((p) => cites(p.text).find((id) => prs.has(id))).filter((id): id is string => id !== undefined);
    expect(cited).toEqual(queue.map((r) => r.change.id));
    queue.forEach((row, i) => {
      const part = answer.parts[i]!.text;
      if (row.wait.on !== 'draft' && row.wait.days !== null) expect(part, row.change.id).toContain(`${Math.round(row.wait.days * 10) / 10} working days`);
      for (const item of row.items.filter((id) => byId.get(id)?.type !== 'EPIC' && byId.get(id)?.type !== 'OTHER')) expect(cites(part), row.change.id).toContain(item);
    });
  });
});

describe.each(NAMES)('the %s people answer agrees with the People view (#292)', (name) => {
  it("cites everyone's work in progress, every blocked item and its blocker, and every review waiting on someone, and names anyone over the limit", async () => {
    const { data } = await healthOf(name);
    const view = people({ toilProject: name, entries: data.people, wipLimit: data.wipLimit, items: data.items, changes: data.pullRequests, now: FIXTURE_NOW });
    const answer = await agent.ask(name, 'people');
    const all = answer.parts.map((p) => p.text).join(' ');
    const cards = [...view.people, ...view.unmapped];
    const wanted = cards.flatMap((c) => [...c.wip.flatMap((g) => g.items.map((w) => w.item.id)), ...c.blocked.flatMap((b) => [b.item.id, ...b.by.map((x) => x.id)]), ...c.reviews.map((r) => r.change.id)]);
    expect(sorted(wanted).filter((id) => !answer.citations.includes(id))).toEqual([]);
    for (const c of cards) for (const g of c.wip) for (const w of g.items) if (w.days !== null) expect(all, w.item.id).toContain(`${w.days} days`);
    for (const o of view.team.wip.over) expect(all).toContain(o.name);
    if (view.wipLimit !== null) expect(all).toContain(`limit of ${view.wipLimit}`);
    // Load, never a score: the answer ranks nobody.
    expect(all).not.toMatch(/\b(most|least|best|worst|top|ranked|score)\b/i);
  });
});

describe.each(NAMES)('the %s attention answer agrees with the insights', (name) => {
  it('takes the top items in rank order, one paragraph each, with their figures', async () => {
    const { data, h } = await healthOf(name);
    const ranked = needsAttention(prepare({ items: data.items, changes: data.changes, deployments: data.deployments, health: h, now: FIXTURE_NOW }));
    const answer = await agent.ask(name, 'attention');
    expect(answer.parts.length).toBe(Math.min(3, ranked.length));
    answer.parts.forEach((part, i) => {
      expect(cites(part.text)[0], part.text).toBe(ranked[i]!.id);
      for (const insight of ranked[i]!.insights) for (const n of insight.text.match(/\d+(\.\d+)? days?/g) ?? []) expect(part.text, insight.text).toContain(n.replace(/ days?$/, ''));
    });
  });

  it('offers proposals only on items it cites', async () => {
    for (const { id } of agent.starters(name)) {
      const answer = await agent.ask(name, id);
      for (const p of answer.proposals) {
        expect(answer.citations).toContain(p.item);
        expect(p.from).toBe('agent');
      }
    }
  });
});

describe('the scripts', () => {
  it('cover every Toil project the fixture serves', () => {
    expect(Object.keys(SCRIPTS).sort()).toEqual([...NAMES].sort());
  });
});

describe('the scripted answers in each theme\'s voice (#283)', () => {
  /** Every figure in a text, outside its citations: what a voice may never change. */
  const figures = (text: string) => (text.replace(/\[\[[^\]]+\]\]/g, ' ').match(/\d+(\.\d+)?/g) ?? []).sort();

  /** Every theme with a voice of its own, so a new game theme needs its voiced answers before it ships. */
  const VOICED_THEMES = THEMES.filter((t) => t.voice).map((t) => t.name);

  it.each(NAMES.flatMap((name) => VOICED_THEMES.map((theme) => [name, theme] as const)))('%s in %s cites the same items, keeps every figure and the same proposals', async (name, theme) => {
    const standard = await agent.ask(name, 'risk');
    const voiced = await agent.ask(name, 'risk', { theme, voice: true });
    expect(VOICED[name]?.[theme]).toBeDefined();
    expect(voiced.parts.map((p) => p.text)).toEqual(VOICED[name]![theme]);
    expect(voiced.parts).not.toEqual(standard.parts);
    expect(voiced.citations).toEqual(standard.citations);
    expect(voiced.parts.map((p) => p.text).join(' ')).not.toMatch(/\*\*|^#|```/m);
    expect(figures(voiced.parts.map((p) => p.text).join(' '))).toEqual(figures(standard.parts.map((p) => p.text).join(' ')));
    expect(voiced.proposals).toEqual(standard.proposals);
    expect(voiced.proposals.length).toBeGreaterThan(0);
    expect(voiced.prompt).toBe(standard.prompt);
  });

  it('answers in the standard words with the voice off, in Plain, and for the questions with no voiced script', async () => {
    const standard = await agent.ask('card-payments', 'risk');
    expect((await agent.ask('card-payments', 'risk', { theme: 'crate', voice: false })).parts).toEqual(standard.parts);
    expect((await agent.ask('card-payments', 'risk', { theme: 'plain', voice: true })).parts).toEqual(standard.parts);
    expect((await agent.ask('card-payments', 'deployed', { theme: 'crate', voice: true })).parts).toEqual((await agent.ask('card-payments', 'deployed')).parts);
    // By label too, as the pane sends a typed question.
    expect((await agent.ask('settlement', "What's at risk in this Toil project?", { theme: 'realm', voice: true })).parts[0]!.text).toMatch(/points is won; 15 remain as hit points\./);
  });

  it('streams the voiced answer and ends on the whole of it', async () => {
    let last;
    for await (const partial of agent.stream!('checkout-web', 'risk', undefined, { theme: 'starship', voice: true })) last = partial;
    expect(last).toEqual(await agent.ask('checkout-web', 'risk', { theme: 'starship', voice: true }));
  });
});
