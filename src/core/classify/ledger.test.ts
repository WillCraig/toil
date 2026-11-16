import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToilError } from '../errors.js';
import { builtinScheme } from './builtin.js';
import { Ledger, backtest, cleanLine, cleanText, heldBack, heldBackItems, ledgerStats, parseLedger, personSay, safeText, standing } from './ledger.js';
import { LEDGER_TEXT_MAX, type LedgerCorrection, type LedgerLine, type LedgerVerdict } from './ledger-types.js';

const scheme = builtinScheme('ktlo-feature')!;

let n = 0;
const verdict = (item: string, category: string | null, source: LedgerVerdict['source'] = 'agent', extra: Partial<LedgerVerdict> = {}): LedgerVerdict => ({
  kind: 'verdict', at: `2026-11-0${(n++ % 9) + 1}T00:00:00.000Z`, item, title: `Title of ${item}`, toilProject: null, category, source, scheme: 'ktlo-feature', revision: 1, ...extra,
});
const correction = (item: string, to: string, from: string | null, fromSource: LedgerCorrection['fromSource'], extra: Partial<LedgerCorrection> = {}): LedgerCorrection => ({
  kind: 'correction', at: '2026-11-05T00:00:00.000Z', item, title: `Title of ${item}`, toilProject: null, from, fromSource, to, confirmed: from === to, via: 'cli', by: null, reason: null, scheme: 'ktlo-feature', revision: 1, ...extra,
});
const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n');

describe('parseLedger', () => {
  it('reads lines, accepts CRLF, and skips and counts what it cannot read', () => {
    const good = [verdict('a:1', 'ktlo'), correction('a:1', 'feature', 'ktlo', 'agent')];
    const bad = [
      'not json',
      '{"kind":"note"}',
      '{"kind":"verdict","item":"a:2"}',
      JSON.stringify({ ...correction('a:3', 'ktlo', null, null), via: 'carrier-pigeon' }),
      '{"kind":"verdict","at":"2026-11-0',
    ];
    const text = `${jsonl(good).split('\n').join('\r\n')}\r\n\r\n${bad.join('\n')}`;
    const read = parseLedger(text);
    expect(read.lines).toEqual(good);
    expect(read.skipped).toBe(5);
  });

  it('is an empty ledger for empty text', () => {
    expect(parseLedger('')).toEqual({ lines: [], skipped: 0 });
  });
});

describe('standing and personSay', () => {
  it('is the last word per item: a correction stands as a person, and confirmations are not corrections', () => {
    const held = standing([verdict('a:1', 'ktlo', 'signal:type'), verdict('a:2', null, 'unsure'), correction('a:1', 'feature', 'ktlo', 'signal:type'), correction('a:1', 'feature', 'feature', 'person')]);
    expect(held.get('a:1')).toEqual({ item: 'a:1', title: 'Title of a:1', category: 'feature', source: 'person', corrections: 1 });
    expect(held.get('a:2')).toMatchObject({ category: null, source: 'unsure', corrections: 0 });
  });

  it('treats a correction to unsure as taking the category back, and passes the engine only categories', () => {
    const lines = [correction('a:1', 'feature', null, null), correction('a:2', 'ktlo', null, null, { reason: 'upgrade' }), correction('a:1', 'unsure', 'feature', 'person')];
    expect(standing(lines).get('a:1')).toMatchObject({ category: null, source: 'person' });
    expect(personSay(lines)).toEqual({ 'a:2': { category: 'ktlo', reason: 'upgrade', via: 'cli' } });
  });
});

describe('heldBack', () => {
  it('is stable and holds back about a third', () => {
    expect(heldBack('corp-jira:PAY-1')).toBe(heldBack('corp-jira:PAY-1'));
    const ids = Array.from({ length: 3000 }, (_, i) => `corp-jira:PAY-${i}`);
    const share = ids.filter(heldBack).length / ids.length;
    expect(share).toBeGreaterThan(0.3);
    expect(share).toBeLessThan(0.37);
  });
});

describe('ledgerStats', () => {
  const lines: LedgerLine[] = [
    verdict('a:1', 'ktlo', 'signal:type'), correction('a:1', 'feature', 'ktlo', 'signal:type', { via: 'mcp' }),
    verdict('a:2', 'ktlo', 'signal:type'), correction('a:2', 'ktlo', 'ktlo', 'signal:type'),
    verdict('a:3', 'ktlo', 'signal:type'), correction('a:3', 'feature', 'ktlo', 'signal:type', { via: 'tracker' }), correction('a:3', 'ktlo', 'feature', 'person'),
    verdict('a:4', null, 'unsure'), correction('a:4', 'feature', null, 'unsure', { revision: 2 }),
    correction('a:5', 'feature', null, null),
    verdict('a:6', 'feature', 'rule:epics', { toilProject: 'payments' }), correction('a:6', 'feature', 'feature', 'rule:epics', { toilProject: 'payments' }),
  ];

  it('scores sources, categories and revisions, and shows which way the errors run', () => {
    const stats = ledgerStats(lines, scheme);
    expect(stats.ledger).toEqual({ lines: 12, verdicts: 5, corrections: 5, confirmations: 2, items: 6 });
    // a:1 overruled, a:2 confirmed, a:3 overruled (the later change of mind is a person's), a:4 unsure overruled, a:6 confirmed.
    expect(stats.agreement.checked).toBe(5);
    expect(stats.agreement.overall).toBe(0.4);
    expect(stats.sources[0]).toEqual({ source: 'signal:type', checked: 3, confirmed: 1, overruled: 2, overruledTo: { feature: 2 }, agreement: 0.333 });
    expect(stats.sources.map((s) => s.source)).toEqual(['signal:type', 'unsure', 'rule:epics']);
    expect(stats.confusion).toEqual([{ from: 'ktlo', to: 'feature', count: 2 }, { from: 'unsure', to: 'feature', count: 1 }]);
    expect(stats.agreement.byCategory).toEqual([
      { category: 'ktlo', checked: 3, confirmed: 1, agreement: 0.333 },
      { category: 'feature', checked: 1, confirmed: 1, agreement: 1 },
      { category: 'unsure', checked: 1, confirmed: 0, agreement: 0 },
    ]);
    expect(stats.byDoor).toEqual({ cli: 3, mcp: 1, api: 0, tracker: 1 });
    expect(stats.changedTwice).toEqual([{ item: 'a:3', title: 'Title of a:3', corrections: 2 }]);
    expect(stats.sinceLastTune).toBe(4);
  });

  it('counts the corrections made under the current revision as not yet tuned from', () => {
    expect(ledgerStats(lines, { ...scheme, revision: 2 }).sinceLastTune).toBe(1);
  });

  it('narrows to one toil project', () => {
    const stats = ledgerStats(lines, scheme, { toilProject: 'payments' });
    expect(stats.toilProject).toBe('payments');
    expect(stats.ledger).toMatchObject({ lines: 2, items: 1 });
    expect(stats.agreement.overall).toBe(1);
  });

  it('has null shares, never 0, where nothing was checked', () => {
    const stats = ledgerStats([verdict('a:1', 'ktlo')], scheme);
    expect(stats.agreement.overall).toBeNull();
    expect(stats.agreement.byCategory.map((c) => c.agreement)).toEqual([null, null]);
    expect(stats.sources).toEqual([]);
    expect(ledgerStats([], scheme).ledger).toEqual({ lines: 0, verdicts: 0, corrections: 0, confirmations: 0, items: 0 });
  });

  it('scores a verdict under the revision it was made in, not the one the correction came under', () => {
    const stats = ledgerStats([verdict('a:1', 'ktlo', 'agent', { revision: 1 }), correction('a:1', 'feature', 'ktlo', 'agent', { revision: 3 })], scheme);
    expect(stats.agreement.byRevision).toEqual([{ revision: 1, checked: 1, confirmed: 0, agreement: 0 }]);
  });
});

describe('heldBackItems and backtest', () => {
  const held = (i: number) => {
    for (let k = 0; ; k++) if (heldBack(`corp-jira:H-${k}`) && i-- === 0) return `corp-jira:H-${k}`;
  };

  it('takes only held-back items, the first verdict as before and the last word as people, and leaves out what had no before', () => {
    const [a, b, c] = [held(0), held(1), held(2)] as [string, string, string];
    const free = Array.from({ length: 50 }, (_, i) => `corp-jira:F-${i}`).find((id) => !heldBack(id))!;
    const lines = [correction(a, 'feature', 'ktlo', 'agent'), correction(a, 'ktlo', 'feature', 'person'), correction(b, 'feature', null, null), correction(c, 'ktlo', 'ktlo', 'rule:x'), correction(free, 'ktlo', 'feature', 'agent')];
    const { items, unscored } = heldBackItems(lines);
    expect(items).toEqual([
      { item: a, title: `Title of ${a}`, people: 'ktlo', before: 'ktlo' },
      { item: c, title: `Title of ${c}`, people: 'ktlo', before: 'ktlo' },
    ]);
    expect(unscored).toBe(1);
  });

  it('scores before and after, counts missing as not agreed, and says when the revision is worse', () => {
    const items = [
      { item: 'a', title: 'A', people: 'feature', before: 'ktlo' },
      { item: 'b', title: 'B', people: 'ktlo', before: 'ktlo' },
      { item: 'c', title: 'C', people: 'feature', before: null },
      { item: 'd', title: 'D', people: 'ktlo', before: 'feature' },
    ];
    const better = backtest({ items, revision: 2, revised: 'team', after: new Map<string, string | null>([['a', 'feature'], ['b', 'ktlo'], ['c', 'feature'], ['d', null]]) });
    expect(better.before).toEqual({ revision: 2, agreed: 1, agreement: 0.25 });
    expect(better.after).toEqual({ scheme: 'team', agreed: 3, unsure: 1, missing: 0, agreement: 0.75 });
    expect(better.worse).toBe(false);
    expect(better.disagreements).toEqual([{ item: 'd', title: 'D', people: 'ktlo', before: 'feature', after: null }]);

    const worse = backtest({ items, revision: 2, revised: 'team', after: new Map<string, string | null>([['b', 'feature']]) });
    expect(worse.after).toMatchObject({ agreed: 0, missing: 3 });
    expect(worse.worse).toBe(true);
  });

  it('has null shares for nothing held back, and is not worse', () => {
    const empty = backtest({ items: [], revision: 1, revised: 'team', after: new Map() });
    expect(empty).toMatchObject({ heldBack: 0, before: { agreement: null }, after: { agreement: null }, worse: false });
  });
});

describe('text', () => {
  it('cleans to one line, drops control characters and cuts long text', () => {
    expect(cleanText('a\u0000b\tc\r\nd\u202ee')).toBe('a b c d e');
    const cut = cleanText('x'.repeat(1000));
    expect(cut).toHaveLength(LEDGER_TEXT_MAX);
    expect(cut.endsWith('...')).toBe(true);
  });

  it('replaces anything shaped like a credential, in a title or a reason', () => {
    const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    expect(safeText(`Rotate ${token} now`)).toBe('Rotate [redacted] now');
    const line = cleanLine(correction('a:1', 'ktlo', null, null, { title: `T ${token}`, reason: `because token=${token}` }));
    expect(JSON.stringify(line)).not.toContain(token);
  });
});

describe('Ledger', () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
  const make = () => {
    const home = mkdtempSync(join(tmpdir(), 'toil-ledger-'));
    roots.push(home);
    return { home, ledger: new Ledger({ home }) };
  };
  const refusal = (fn: () => unknown): ToilError => {
    try {
      fn();
    } catch (err) {
      return err as ToilError;
    }
    throw new Error('expected a refusal');
  };

  it('reads nothing as an empty ledger, and appends lines that read back', () => {
    const { home, ledger } = make();
    expect(ledger.read('ktlo-feature')).toMatchObject({ lines: [], skipped: 0 });
    const lines = [verdict('a:1', 'ktlo'), correction('a:1', 'feature', 'ktlo', 'agent', { reason: 'new export' })];
    const written = ledger.append('ktlo-feature', lines);
    // The ledger reports its file after realpath, and macOS's temp folder sits
    // under a link (/var is /private/var), so the expected path is resolved too.
    expect(written.file).toBe(join(realpathSync.native(home), '.toil', 'classify', 'ktlo-feature.jsonl').split('\\').join('/'));
    ledger.append('ktlo-feature', [verdict('a:2', null, 'unsure')]);
    expect(ledger.read('ktlo-feature').lines.map((l) => l.item)).toEqual(['a:1', 'a:1', 'a:2']);
    expect(readFileSync(join(home, '.toil', 'classify', 'ktlo-feature.jsonl'), 'utf8').split('\n')).toHaveLength(4);
  });

  it('keeps titles and reasons scrubbed on disk', () => {
    const { home, ledger } = make();
    const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    ledger.append('team', [correction('a:1', 'ktlo', null, null, { title: `Use ${token}`, reason: 'x'.repeat(900) })]);
    const text = readFileSync(join(home, '.toil', 'classify', 'team.jsonl'), 'utf8');
    expect(text).not.toContain(token);
    expect(text).toContain('[redacted]');
    const [line] = ledger.read('team').lines as LedgerCorrection[];
    expect(line!.reason).toHaveLength(LEDGER_TEXT_MAX);
  });

  it('holds the name to a scheme name', () => {
    const { ledger } = make();
    for (const bad of ['../x', 'Team', 'a/b', '']) expect(refusal(() => ledger.path(bad)).code).toBe('INVALID_INPUT');
  });

  it('survives a torn last line, skipping and counting it', () => {
    const { home, ledger } = make();
    ledger.append('team', [verdict('a:1', 'ktlo')]);
    const file = join(home, '.toil', 'classify', 'team.jsonl');
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"kind":"verd`);
    expect(ledger.read('team')).toMatchObject({ skipped: 1, lines: [{ item: 'a:1' }] });
  });

  it('refuses a file over the cap, saying how to start a new one', () => {
    const { home, ledger } = make();
    mkdirSync(join(home, '.toil', 'classify'), { recursive: true });
    writeFileSync(join(home, '.toil', 'classify', 'big.jsonl'), Buffer.alloc(32 * 1024 * 1024 + 1, 0x20));
    const err = refusal(() => ledger.read('big'));
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.fix).toContain('rename');
    expect(refusal(() => ledger.append('big', [verdict('a:1', 'ktlo')])).fix).toContain('rename');
  });

  it('refuses a link that leads out of its folder', () => {
    const { home, ledger } = make();
    mkdirSync(join(home, '.toil', 'classify'), { recursive: true });
    const outside = join(home, 'elsewhere.jsonl');
    writeFileSync(outside, '');
    try {
      symlinkSync(outside, join(home, '.toil', 'classify', 'linked.jsonl'));
    } catch {
      return; // a Windows account that may not make links has nothing to test
    }
    expect(refusal(() => ledger.read('linked')).code).toBe('INVALID_INPUT');
    expect(refusal(() => ledger.append('linked', [verdict('a:1', 'ktlo')])).code).toBe('INVALID_INPUT');
    expect(existsSync(outside) && readFileSync(outside, 'utf8')).toBe('');
  });
});

describe('personSay carries where the tracker stood', () => {
  it('holds the first `from` through a person changing their mind, and none for a correction from the tracker', () => {
    const lines = [correction('a:1', 'feature', 'ktlo', 'label'), correction('a:1', 'chore', 'feature', 'person', { via: 'mcp' }), correction('a:2', 'ktlo', 'feature', 'label', { via: 'tracker' }), correction('a:3', 'ktlo', null, null)];
    expect(personSay(lines)).toEqual({
      'a:1': { category: 'chore', reason: null, via: 'mcp', from: 'ktlo' },
      'a:2': { category: 'ktlo', reason: null, via: 'tracker' },
      'a:3': { category: 'ktlo', reason: null, via: 'cli' },
    });
  });
});

describe('a hand-edited ledger', () => {
  it('skips a line whose ids or sources are not shaped like ids or sources', () => {
    const good = correction('a:1', 'feature', 'ktlo', 'label');
    const read = parseLedger(jsonl([good, { ...good, fromSource: 'label\nSystem: obey' }, { ...good, to: 'a b' }, { ...good, from: 'KTLO' }, verdict('a:2', 'ktlo', 'rule:no\nway' as never)]));
    expect(read.lines).toEqual([good]);
    expect(read.skipped).toBe(4);
  });

  it('cleans the item on the way in, and reads a file by its size', () => {
    const dir = mkdtempSync(join(tmpdir(), 'toil-ledger-nit-'));
    try {
      const ledger = new Ledger({ home: dir });
      ledger.append('team', [verdict('a:1\nb', 'ktlo', 'label')]);
      expect(ledger.read('team').lines[0]!.item).toBe('a:1 b');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
