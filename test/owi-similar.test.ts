import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { owiMapCommand, owiSimilarCommand } from '../src/areas/util/owi.js';
import type { Envelope, Warning } from '../src/core/envelope.js';
import { ToilError } from '../src/core/errors.js';
import { bodyText, findSimilar, parseOwiRecords, SimilarityIndex, SIMILAR_METHOD, type SimilarItem, type WorkItem } from '../src/core/owi/index.js';
import { execute } from '../src/core/run.js';
import { commands as registry } from '../src/registry.js';
import { runCli } from './harness/cli.js';
import { testContext } from './harness/context.js';
import { triageEnvelopes, triageJsonl } from './fixtures/owi/triage.js';

/**
 * `util owi similar` and the scorer under it (src/core/owi/similar.ts), on the
 * triage fixture: Sprint 42 plus a week of new work with four duplicates
 * planted in it (test/fixtures/owi/triage.ts). The planted pairs must come
 * out on top, the near-miss must stay under the threshold, a typo must be
 * caught by the trigrams, every result must say why, and two runs, or one run
 * on the input reversed, must give the same bytes. Then the edges: a set too
 * large to compare pairwise by brute force, run in the worker, and a
 * self-check that fails when handed a score that doesn't add up. A duplicate
 * found in review is a duplicate that could have been found at intake.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = Record<string, any>;
const run = async (input: Record<string, unknown>, files: Record<string, string> = {}) => {
  const envelope = (await execute(owiSimilarCommand as never, input, testContext({ files }).context)) as Envelope;
  return { envelope, data: envelope.data as Data, warnings: (envelope.meta.warnings ?? []) as Warning[] };
};
const json = (value: unknown) => JSON.stringify(value);

const mapped = (await execute(owiMapCommand as never, { text: triageJsonl }, testContext().context)) as Envelope;
const items = (mapped.data as { items: WorkItem[] }).items;
const text = json({ owi: '0.1', count: items.length, items });
const ids = (list: Array<{ id: string }>) => list.map((m) => m.id);
const pairIds = (list: Array<{ a: { id: string }; b: { id: string } }>) => list.map((p) => `${p.a.id} ~ ${p.b.id}`);

describe('the triage fixture', () => {
  it('maps cleanly and is the committed file the examples read', async () => {
    expect(mapped.ok).toBe(true);
    expect((mapped.data as Data).verified.passed).toBe(true);
    expect(items).toHaveLength(39);
    await expect(`${JSON.stringify({ owi: '0.1', count: items.length, items }, null, 2)}\n`).toMatchFileSnapshot('./fixtures/owi/triage.owi.json');
  });
});

describe('util owi similar --query', () => {
  it('finds the planted cross-source duplicate first, and leaves the near-miss under the threshold', async () => {
    const { envelope, data } = await run({ text, query: 'Card payments time out at checkout' });
    expect(envelope.ok).toBe(true);
    expect(data).toMatchObject({ mode: 'query', query: 'Card payments time out at checkout', item: null, items: 39, threshold: 0.35, limit: 10, method: SIMILAR_METHOD, pairs: [], search: null });
    expect(ids(data.matches).slice(0, 2)).toEqual(['corp-jira:PAY-210', 'github:imagile/payments-web#51']);
    expect(ids(data.matches)).not.toContain('corp-jira:PAY-211');
    const gh51 = data.matches[1];
    expect(gh51).toMatchObject({ title: 'Checkout times out when paying by card', source: { area: 'github', connection: 'github', key: 'imagile/payments-web#51', command: 'github issue list' }, url: 'https://ghe.imagile.dev/imagile/payments-web/issues/51' });
    expect(gh51.score).toBeGreaterThan(0.6);
    expect(gh51.why.titleTerms).toEqual(expect.arrayContaining(['card', 'checkout', 'time']));
    expect(data.count).toBe(data.matches.length);
  });

  it('scores the near-miss, when asked for everything, below the default threshold, and says what it shares', async () => {
    const { data } = await run({ text, query: 'Card payments time out at checkout', threshold: 0, limit: 1000 });
    const near = data.matches.find((m: Data) => m.id === 'corp-jira:PAY-211');
    expect(near.score).toBeLessThan(0.35);
    expect(near.why.titleTerms).toEqual(['time']);
    expect(data.count).toBe(39);
  });

  it('catches a typo with the title trigrams, where the misspelt words share no term', async () => {
    const { data } = await run({ text, item: 'github:imagile/payments-web#53', limit: 1 });
    const [top] = data.matches;
    expect(top.id).toBe('github:imagile/payments-web#44');
    expect(top.why.titleTerms).not.toContain('receipt');
    expect(top.why.titleTerms).not.toContain('currency');
    expect(top.why.trigram).toBeGreaterThan(0.8);
    expect(top.why.parts.trigram).toBeGreaterThan(0.25);
    expect(top.score).toBeGreaterThan(0.6);
  });

  it('says there is no likely ticket when nothing reaches the threshold, and never forces a match (#304)', async () => {
    const { envelope, data, warnings } = await run({ text, query: 'Rotate the kubernetes ingress certificates' });
    expect(envelope.ok).toBe(true);
    expect(data.matches).toEqual([]);
    expect(warnings).toContainEqual({ code: 'OWI_SIMILAR_NO_MATCH', message: "No item scores 0.35 or more against the query, so there is no likely ticket for it among these 39. Suggest creating one; don't lower --threshold to force a match." });
    const found = await run({ text, query: 'Card payments time out at checkout' });
    expect(found.warnings.map((w) => w.code)).not.toContain('OWI_SIMILAR_NO_MATCH');
    const pairs = await run({ text, pairs: true, threshold: 0.99 });
    expect(pairs.warnings.map((w) => w.code)).not.toContain('OWI_SIMILAR_NO_MATCH');
  });

  it('refuses a query with nothing to compare', async () => {
    const { envelope } = await run({ text, query: 'the a of' });
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('util owi similar --item', () => {
  it('ranks the set against one item, with the terms, labels and trigrams that drove each score', async () => {
    const { data } = await run({ text, item: 'corp-jira:PAY-210', limit: 3 });
    expect(data.item).toMatchObject({ id: 'corp-jira:PAY-210', title: 'Card payments time out at checkout' });
    expect(data.matches).toHaveLength(3);
    const [top] = data.matches;
    expect(top.id).toBe('github:imagile/payments-web#51');
    expect(top.why).toMatchObject({ labels: ['checkout'], parent: null, link: null, titleOnly: false });
    expect(top.why.titleTerms).toEqual(expect.arrayContaining(['card', 'checkout', 'time']));
    expect(top.why.bodyTerms).toEqual(expect.arrayContaining(['504', 'gateway', 'spinner']));
    expect(top.why.summary).toMatch(/^title terms .*; body terms .*; titles \d+% alike by trigram; shared label checkout\.$/);
    const p = top.why.parts;
    expect(p.terms + p.trigram + p.labels + p.parent + p.link).toBeCloseTo(top.score, 3);
  });

  it('finds the Data Center item a Cloud issue repeats, comparing on titles alone, and says so', async () => {
    const { data, warnings } = await run({ text, item: 'cloud-jira:WEB-31' });
    expect(data.matches[0]).toMatchObject({ id: 'corp-jira:PAY-97', why: { titleOnly: true } });
    expect(data.matches[0].why.summary).toMatch(/compared on titles alone\.$/);
    expect(data.titleOnly).toBe(19);
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'OWI_SIMILAR_TITLE_ONLY', message: expect.stringMatching(/^19 of 39 items have no body, so they were scored on their titles alone: corp-ado:2290, /) }));
  });

  it('counts a direct link and a shared parent', async () => {
    const { data } = await run({ text, item: 'corp-jira:PAY-102', threshold: 0.3 });
    const pay103 = data.matches.find((m: Data) => m.id === 'corp-jira:PAY-103');
    expect(pay103.why).toMatchObject({ parent: 'corp-jira:PAY-100', link: { type: 'blocks', direction: 'outward', name: 'blocks' } });
    expect(pay103.why.parts).toMatchObject({ parent: 0.05, link: 0.1 });
  });

  it('refuses an id the set doesn\'t hold, and suggests the one whose key it is', async () => {
    const { envelope } = await run({ text, item: 'jira:PAY-210' });
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'The input holds no item with the id "jira:PAY-210".', fix: 'OWI ids are <connection>:<key>. Did you mean corp-jira:PAY-210?' });
  });
});

describe('util owi similar --pairs', () => {
  it('lists the four planted duplicates first, across trackers and within one', async () => {
    const { data } = await run({ text, pairs: true, threshold: 0.6 });
    expect(pairIds(data.pairs).slice(0, 4)).toEqual([
      'cloud-jira:WEB-31 ~ corp-jira:PAY-97',
      'corp-ado:2302 ~ corp-ado:2312',
      'corp-jira:PAY-210 ~ github:imagile/payments-web#51',
      'github:imagile/payments-web#44 ~ github:imagile/payments-web#53',
    ]);
    expect(data.search).toEqual({ compared: expect.any(Number), skippedFeatures: 0, maxItemsPerFeature: null });
    expect(data.matches).toEqual([]);
    expect(data.verified.passed).toBe(true);
    expect(data.verified.checks.map((c: Data) => [c.check, c.status])).toEqual([
      ['score.parts', 'passed'],
      ['pairs.postings', 'passed'],
      ['score.meaning', 'approximated'],
      ['input.complete', 'passed'],
    ]);
  });

  it('gives each pair the score compare() gives it from either side', async () => {
    const { data } = await run({ text, pairs: true, threshold: 0.3, limit: 50 });
    const index = new SimilarityIndex(items);
    for (const p of data.pairs) {
      expect(index.compare(p.a.id, p.b.id)!.score).toBe(p.score);
      expect(index.compare(p.b.id, p.a.id)!.score).toBe(p.score);
    }
    expect(data.count).toBe(data.pairs.length);
  });

  it('compares only the fields asked for', async () => {
    const titles = await run({ text, pairs: true, fields: 'title' });
    expect(titles.data.fields).toEqual(['title']);
    for (const p of titles.data.pairs) expect(p.why).toMatchObject({ bodyTerms: [], labels: [], parent: null, link: null, parts: { labels: 0, parent: 0, link: 0 } });
    const bodies = await run({ text, pairs: true, fields: 'body' });
    for (const p of bodies.data.pairs) expect(p.why).toMatchObject({ titleTerms: [], trigram: 0 });
  });
});

describe('determinism', () => {
  it('gives byte-identical data on two runs, and on the input reversed', async () => {
    for (const input of [{ query: 'Card payments time out at checkout' }, { item: 'corp-ado:2302' }, { pairs: true, threshold: 0.3, limit: 100 }]) {
      const first = await run({ text, ...input });
      const second = await run({ text, ...input });
      const reversed = await run({ text: json([...items].reverse()), ...input });
      expect(json(second.data)).toBe(json(first.data));
      expect(json({ ...reversed.data, verified: null })).toBe(json({ ...first.data, verified: null }));
    }
  });

  it('gives the same envelope over the CLI as through execute()', async () => {
    const files = { 'triage.owi.json': text };
    const cli = await runCli(['util', 'owi', 'similar', '--input-file', 'triage.owi.json', '--item', 'corp-jira:PAY-210'], { commands: registry, context: testContext({ files }).context });
    const positional = await runCli(['util', 'owi', 'similar', 'triage.owi.json', '--item', 'corp-jira:PAY-210'], { commands: registry, context: testContext({ files }).context });
    const direct = await run({ file: 'triage.owi.json', item: 'corp-jira:PAY-210' }, files);
    expect(cli.envelope!.data).toEqual(direct.data);
    expect(positional.envelope!.data).toEqual(direct.data);
  });
});

describe('reading OWI records', () => {
  it('reads the map envelope, its data, an array of records and one record a line, all alike', async () => {
    const envelope = json(mapped);
    const forms = [envelope, text, json(items), items.map((i) => json(i)).join('\n'), `${json(mapped)}\n`];
    const results = await Promise.all(forms.map((t) => run({ text: t, item: 'corp-jira:PAY-210' })));
    for (const r of results) expect(r.data.matches).toEqual(results[0]!.data.matches);
  });

  it('skips a record with no id or title, and says so', async () => {
    const { data, warnings } = await run({ text: json([...items, { title: 'No id' }, { id: 'x:1' }]), item: 'corp-jira:PAY-210' });
    expect(data.skipped).toEqual([
      { at: 'the input, [39]', reason: 'it has no id' },
      { at: 'the input, [40]', reason: 'x:1 has no title' },
    ]);
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'OWI_SIMILAR_SKIPPED' }));
  });

  it('reads a duplicated id once, and warns', async () => {
    const { data, warnings } = await run({ text: json([...items, items[0]]), item: 'corp-jira:PAY-210' });
    expect(data.items).toBe(39);
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'OWI_SIMILAR_DUPLICATE_ID' }));
  });

  it('refuses output that isn\'t mapped yet, naming the command to run', async () => {
    const { envelope } = await run({ text: json(triageEnvelopes[0]), query: 'checkout' });
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'The input is the output of "jira issue search", not OWI records.', fix: 'Map it first: pipe it through toil util owi map, then into toil util owi similar.' });
  });

  it('refuses no question, two questions, unknown fields and fields with nothing to compare', async () => {
    for (const [input, message] of [
      [{}, 'Nothing to rank by: pass a query, an item or pairs.'],
      [{ query: 'x y', pairs: true }, 'Ask one question at a time: query and pairs were both given.'],
      [{ pairs: true, fields: 'title,summary' }, '"summary" isn\'t a field the scorer compares.'],
      [{ pairs: true, fields: 'labels' }, 'Labels, parents and links only add small boosts, so they need a title or a body to compare as well.'],
    ] as const) {
      const { envelope } = await run({ text, ...input });
      expect(envelope.error, JSON.stringify(input)).toMatchObject({ code: 'INVALID_INPUT', message });
    }
  });

  it('refuses input with no records', async () => {
    const { envelope } = await run({ text: json({ owi: '0.1', count: 0, items: [] }), pairs: true });
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'The text holds no OWI records to compare.' });
  });

  it('warns when the threshold lets boosts alone count as a match', async () => {
    const { warnings } = await run({ text, pairs: true, threshold: 0.2 });
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'OWI_SIMILAR_LOW_THRESHOLD' }));
  });
});

describe('body text', () => {
  it('reads Markdown, wiki markup, HTML and ADF as plain text, keeping a link\'s words and dropping its URL', () => {
    expect(bodyText({ format: 'markdown', content: 'See **the** [trace](https://ghe.imagile.dev/x) and <b>this</b>' }).replace(/\s+/g, ' ').trim()).toBe('See **the** trace and this');
    expect(bodyText({ format: 'wiki', content: 'h3. Steps\n{code:java}x(){code} [dashboard|https://dynatrace.imagile.dev/g]' }).replace(/\s+/g, ' ').trim()).toBe('Steps x() dashboard');
    expect(bodyText({ format: 'html', content: '<div>One &amp; two</div>' }).trim()).toBe('One & two');
    expect(bodyText({ format: 'adf', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }, { type: 'mention', attrs: { text: '@ada' } }] }] } })).toBe('Hello @ada');
    expect(bodyText(null)).toBe('');
  });

  it('stays linear on a hostile body: 400 KB of each opening character reads in linear time, not quadratic', () => {
    for (const [format, unit] of [['html', '<'], ['wiki', '['], ['wiki', '{a:'], ['markdown', '['], ['markdown', '<'], ['markdown', 'a.'], ['markdown', '![x]('], ['wiki', '[a|']] as const) {
      const content = unit.repeat(Math.ceil(400_000 / unit.length));
      const started = performance.now();
      bodyText({ format, content });
      expect(performance.now() - started, `${format} ${unit}`).toBeLessThan(3000); // Linear is milliseconds; quadratic was several seconds. A busy runner is neither.
    }
  });

  it('walks a deeply nested ADF document without running out of stack', () => {
    let node: Record<string, unknown> = { type: 'text', text: 'deep' };
    for (let i = 0; i < 100_000; i++) node = { type: 'blockquote', content: [node] };
    expect(bodyText({ format: 'adf', content: node })).toBe('deep');
  });
});

describe('the scorer as a function', () => {
  it('is exported from core for programs and Toil UI, and agrees with the command', async () => {
    const { data } = await run({ text, item: 'corp-ado:2302' });
    const result = findSimilar(items, { item: 'corp-ado:2302' });
    expect(result.matches).toEqual(data.matches);
    expect(parseOwiRecords(text).items).toHaveLength(39);
  });

  it('is findSimilar in @imagile-dev/toil/api, taking records or the text util owi map printed', async () => {
    const api = await import('../src/api.js');
    const fromItems = api.findSimilar(items, { pairs: true }, { threshold: 0.6 });
    expect(api.findSimilar(json(mapped), { pairs: true }, { threshold: 0.6 })).toEqual(fromItems);
    expect(fromItems.pairs.map((p) => p.score)).toEqual((await run({ text, pairs: true, threshold: 0.6 })).data.pairs.map((p: Data) => p.score));
  });

  it('throws a ToilError for an unknown item', () => {
    expect(() => findSimilar(items, { item: 'nope:1' })).toThrow(ToilError);
  });
});

describe('a large set', () => {
  // A backlog of 6,000 items: 400 topics, each filed fifteen ways, so there are thousands of real pairs to find.
  const words = Array.from({ length: 3000 }, (_, i) => `w${i.toString(36)}`);
  let seed = 7;
  const pick = () => words[(seed = (seed * 48271) % 2147483647) % words.length]!;
  const large: SimilarItem[] = Array.from({ length: 6000 }, (_, i) => {
    const topic = i % 400;
    const t = (k: number) => words[topic * 5 + k]!;
    return { id: `big:K-${i}`, title: `${t(0)} ${t(1)} ${t(2)} ${pick()}`, body: { format: 'markdown', content: `${t(3)} ${t(4)} ${Array.from({ length: 40 }, pick).join(' ')}` }, labels: [`team-${i % 12}`] };
  });

  it('runs in the bounded worker, and every check passes', async () => {
    const { envelope, data } = await run({ text: json(large), pairs: true, threshold: 0.4, limit: 20 });
    expect(envelope.ok, json(envelope.error)).toBe(true);
    expect(data.items).toBe(6000);
    expect(data.pairs).toHaveLength(20);
    expect(data.count).toBeGreaterThan(1000);
    expect(data.verified.passed).toBe(true);
    for (const p of data.pairs) expect(Number(p.a.id.split('-')[1]) % 400).toBe(Number(p.b.id.split('-')[1]) % 400);
  }, 60_000);
});

describe('the self-check', () => {
  it('fails a score that doesn\'t add up to its parts, or comes out differently a second time', async () => {
    vi.resetModules();
    vi.doMock('../src/areas/util/kit/bounded.js', async (original) => {
      const real = await original<typeof import('../src/areas/util/kit/bounded.js')>();
      return {
        ...real,
        runBounded: async (...args: Parameters<typeof real.runBounded>) => {
          const outcome = await real.runBounded<Data>(...args);
          if (!outcome.ok) return outcome;
          const broken = structuredClone(outcome.value);
          broken.result.pairs[0].score = 0.99;
          broken.postings.failed.push({ at: 'cloud-jira:WEB-31 and corp-jira:PAY-97', expected: 0.9241, actual: 0.8 });
          return { ok: true, value: broken };
        },
      };
    });
    try {
      const { similarOwi } = await import('../src/areas/util/owi/similar-run.js');
      const warnings: Warning[] = [];
      const source = { source: { kind: 'text' }, label: 'the text', expectedBytes: text.length, bytesRead: text.length, truncated: false } as never;
      const data = await similarOwi({ warn: (w) => void warnings.push(w), signal: new AbortController().signal }, { bytes: new TextEncoder().encode(text), source, pairs: true, threshold: 0.6 });
      expect(data.verified.passed).toBe(false);
      expect(data.verified.checks.find((c) => c.check === 'score.parts')).toMatchObject({ status: 'failed', failed: 1 });
      expect(data.verified.checks.find((c) => c.check === 'pairs.postings')).toMatchObject({ status: 'failed', failed: 1 });
      expect(warnings.filter((w) => w.code === 'OWI_SIMILAR_MISMATCH').length).toBeGreaterThan(0);
    } finally {
      vi.doUnmock('../src/areas/util/kit/bounded.js');
      vi.resetModules();
    }
  });
});

describe('the committed fixture', () => {
  it('is what the util examples read', () => {
    const file = readFileSync(new URL('./fixtures/owi/triage.owi.json', import.meta.url), 'utf8');
    expect(JSON.parse(file).count).toBe(39);
  });
});
