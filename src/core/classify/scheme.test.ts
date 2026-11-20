import { describe, expect, it } from 'vitest';
import { ToilError } from '../errors.js';
import { BUILTIN_SCHEMES, builtinScheme, defaultScheme } from './builtin.js';
import { diffSchemes, readScheme, schemeContent } from './scheme.js';
import { DEFAULT_SCHEME, type Scheme } from './types.js';

const ktlo = { id: 'ktlo', short: 'KTLO', name: 'Keep the lights on', label: 'ktlo', definition: 'Fixes and upgrades.' };
const feature = { id: 'feature', short: 'Feature', name: 'Feature', label: 'feature', definition: 'New capability.' };
const base = () => ({ name: 'team', categories: [ktlo, feature] });

/** The error a read throws, so a test can name its code and the key path in its message. */
function refused(raw: unknown): ToilError {
  try {
    readScheme(raw, 'team.json');
  } catch (err) {
    return err as ToilError;
  }
  throw new Error('expected the scheme to be refused');
}

describe('the built-in schemes', () => {
  it('each passes the reader unchanged', () => {
    for (const scheme of BUILTIN_SCHEMES) {
      const read = readScheme(JSON.parse(schemeContent(scheme)), scheme.name);
      expect(read.scheme).toEqual(scheme);
      expect(read.warnings).toEqual([]);
    }
  });

  it('are ktlo-feature, the default, balance and flow, each at revision 1', () => {
    expect(BUILTIN_SCHEMES.map((s) => [s.name, s.revision])).toEqual([['ktlo-feature', 1], ['balance', 1], ['flow', 1]]);
    expect(defaultScheme().name).toBe(DEFAULT_SCHEME);
    expect(builtinScheme('balance')!.categories.map((c) => c.id)).toEqual(['new', 'improve', 'ktlo', 'productivity']);
  });

  it('has flow sort by rules alone, risk before defect, with no signals', () => {
    const flow = builtinScheme('flow')!;
    expect(flow.categories.map((c) => c.id)).toEqual(['feature', 'defect', 'risk', 'debt']);
    expect(flow.rules.map((r) => [r.id, r.then])).toEqual([['risk', 'risk'], ['defect', 'defect'], ['defect-label', 'defect'], ['debt-title', 'debt'], ['tech-debt', 'debt'], ['story', 'feature']]);
    expect(flow.signals).toBe(false);
    expect(readScheme(JSON.parse(schemeContent(flow)), 'flow.json').scheme).toEqual(flow);
  });

  it('are handed out as copies, so a caller cannot change what the next call sees', () => {
    builtinScheme('balance')!.categories.pop();
    expect(builtinScheme('balance')!.categories).toHaveLength(4);
  });
});

describe('readScheme', () => {
  it('fills in the defaults for what a scheme leaves out', () => {
    const { scheme, warnings } = readScheme(base(), 'team.json');
    expect(scheme).toEqual({ name: 'team', revision: 1, categories: [ktlo, feature], guidance: [], examples: [], rules: [], signals: true, labels: {} });
    expect(warnings).toEqual([]);
  });

  it('ignores an unknown top-level key with a warning, and $schema silently', () => {
    const { warnings } = readScheme({ ...base(), $schema: 'https://example.com/s.json', colour: 'blue' }, 'team.json');
    expect(warnings).toEqual([{ code: 'SCHEME_UNKNOWN_KEY', message: expect.stringContaining('"colour" isn\'t a scheme key') }]);
    expect(warnings[0]!.message).toContain('It was ignored.');
  });

  it('refuses with CONFIG_INVALID naming the file and the key path, with up to five problems in details', () => {
    const err = refused({ name: 'Bad Name', revision: 0, categories: [], guidance: 'x', rules: 'x', signals: 'x', labels: [] });
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.message).toBe('Scheme team.json can\'t be used: name: "name" must be lowercase letters, digits and single hyphens, starting with a letter, e.g. "ktlo-feature". (and 6 more problems)');
    expect((err.details as unknown[]).length).toBe(5);
    expect(err.fix).toContain('team.json');
  });

  it('holds a name and a revision to their shapes', () => {
    expect(refused({ ...base(), name: 'A' }).message).toContain('name:');
    expect(refused({ ...base(), revision: 1.5 }).message).toContain('revision:');
    expect(readScheme({ ...base(), revision: 7 }, 'x').scheme.revision).toBe(7);
  });

  describe('categories', () => {
    it('are two to twelve', () => {
      expect(refused({ name: 'team', categories: [ktlo] }).message).toContain('holds 1; a scheme has 2 to 12');
      const many = Array.from({ length: 13 }, (_, i) => ({ ...ktlo, id: `c${i}`, label: `l${i}` }));
      expect(refused({ name: 'team', categories: many }).message).toContain('holds 13');
    });

    it('have unique ids, and never unsure', () => {
      expect(refused({ name: 'team', categories: [ktlo, { ...feature, id: 'ktlo' }] }).message).toContain('"ktlo" is used by two categories');
      expect(refused({ name: 'team', categories: [ktlo, { ...feature, id: 'unsure' }] }).message).toContain('"unsure" is what a verdict says');
    });

    it('hold short, name and definition to their lengths', () => {
      expect(refused({ name: 'team', categories: [{ ...ktlo, short: 'x'.repeat(25) }, feature] }).message).toContain('categories[0].short: "short" is 25 characters; the most is 24.');
      expect(refused({ name: 'team', categories: [ktlo, { ...feature, name: '' }] }).message).toContain('categories[1].name');
      expect(refused({ name: 'team', categories: [ktlo, { ...feature, definition: 'x'.repeat(601) }] }).message).toContain('categories[1].definition');
    });

    it('have labels with no space, comma or semicolon, unique without regard to case', () => {
      for (const label of ['has space', 'a,b', 'a;b', '-lead', '']) expect(refused({ name: 'team', categories: [ktlo, { ...feature, label }] }).message).toContain('categories[1].label');
      expect(refused({ name: 'team', categories: [ktlo, { ...feature, label: 'KTLO' }] }).message).toContain('"KTLO" is also the label of categories[0]');
    });
  });

  it('holds guidance to 20 one-line sentences of at most 300 characters', () => {
    expect(refused({ ...base(), guidance: Array.from({ length: 21 }, () => 'x') }).message).toContain('holds 21 sentences');
    expect(refused({ ...base(), guidance: ['x'.repeat(301)] }).message).toContain('guidance[0]');
    expect(refused({ ...base(), guidance: ['a\nb'] }).message).toContain('one line');
    expect(readScheme({ ...base(), guidance: ['  keep it short  '] }, 'x').scheme.guidance).toEqual(['keep it short']);
  });

  it('refuses text shaped like a credential, in any field, and a control character', () => {
    const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    expect(refused({ ...base(), guidance: [`use ${token}`] }).message).toContain('shaped like a credential');
    expect(refused({ name: 'team', categories: [{ ...ktlo, definition: `see ${token}` }, feature] }).message).toContain('categories[0].definition');
    expect(refused({ ...base(), examples: [{ item: 'a:B-1', title: token, category: 'ktlo' }] }).message).toContain('examples[0].title');
    expect(refused({ ...base(), rules: [{ id: 'r', when: { title: [token] }, then: 'ktlo' }] }).message).toContain('rules[0].when.title[0]');
    expect(refused({ name: 'team', categories: [{ ...ktlo, name: 'a\u0007b' }, feature] }).message).toContain('control characters');
  });

  describe('examples', () => {
    it('name a category of the scheme, and keep why optional', () => {
      const ok = readScheme({ ...base(), examples: [{ item: 'corp-jira:PAY-1', title: 'Add Pay', category: 'feature' }, { item: 'corp-jira:PAY-2', title: 'Fix', category: 'ktlo', why: 'a fix' }] }, 'x');
      expect(ok.scheme.examples).toHaveLength(2);
      expect(ok.scheme.examples[0]).not.toHaveProperty('why');
      expect(refused({ ...base(), examples: [{ item: 'a', title: 'b', category: 'other' }] }).message).toContain('examples[0].category');
      expect(refused({ ...base(), examples: [{ item: 'a', title: 'x'.repeat(201), category: 'ktlo' }] }).message).toContain('examples[0].title');
      expect(refused({ ...base(), examples: Array.from({ length: 41 }, () => ({ item: 'a', title: 'b', category: 'ktlo' })) }).message).toContain('holds 41');
    });
  });

  describe('rules', () => {
    const rule = { id: 'roadmap', when: { parent: ['PAY-100'] }, then: 'feature' };

    it('need a unique id, a when with a known key and a category to go to', () => {
      expect(readScheme({ ...base(), rules: [rule, { id: 'esc', when: { label: ['a'], type: ['BUG'], title: ['x'] }, then: 'ktlo' }] }, 'x').scheme.rules).toHaveLength(2);
      expect(refused({ ...base(), rules: [rule, rule] }).message).toContain('"roadmap" is used by two rules');
      expect(refused({ ...base(), rules: [{ ...rule, id: 'Bad_Id' }] }).message).toContain('rules[0].id');
      expect(refused({ ...base(), rules: [{ ...rule, then: 'nope' }] }).message).toContain('rules[0].then');
    });

    it('name the four keys a when allows, and need at least one', () => {
      const err = refused({ ...base(), rules: [{ id: 'r', when: { assignee: ['pat'] }, then: 'ktlo' }] });
      expect(err.message).toContain('rules[0].when.assignee');
      expect(err.message).toContain('parent, label, type, title');
      expect(refused({ ...base(), rules: [{ id: 'r', when: {}, then: 'ktlo' }] }).message).toContain('rules[0].when');
      expect(refused({ ...base(), rules: [{ id: 'r', when: { label: [] }, then: 'ktlo' }] }).message).toContain('rules[0].when.label');
      expect(refused({ ...base(), rules: [{ id: 'r', when: { label: [''] }, then: 'ktlo' }] }).message).toContain('rules[0].when.label[0]');
      expect(refused({ ...base(), rules: [{ id: 'r', when: { label: Array.from({ length: 51 }, () => 'x') }, then: 'ktlo' }] }).message).toContain('1 to 50');
    });

    it('are at most 100', () => {
      const rules = Array.from({ length: 101 }, (_, i) => ({ id: `r${i}`, when: { label: ['x'] }, then: 'ktlo' }));
      expect(refused({ ...base(), rules }).message).toContain('holds 101');
    });
  });

  it('takes signals as a boolean', () => {
    expect(readScheme({ ...base(), signals: false }, 'x').scheme.signals).toBe(false);
    expect(refused({ ...base(), signals: 'no' }).message).toContain('signals:');
  });

  describe('labels', () => {
    it('are keyed by tracker and category id, and hold the label form', () => {
      expect(readScheme({ ...base(), labels: { ado: { ktlo: 'KTLO', feature: 'Feature' }, jira: {} } }, 'x').scheme.labels).toEqual({ ado: { ktlo: 'KTLO', feature: 'Feature' } });
      expect(refused({ ...base(), labels: { gitlab: { ktlo: 'x' } } }).message).toContain('labels.gitlab');
      expect(refused({ ...base(), labels: { ado: { other: 'x' } } }).message).toContain('labels.ado.other');
      expect(refused({ ...base(), labels: { ado: { ktlo: 'has space' } } }).message).toContain('labels.ado.ktlo');
    });

    it('still tell the categories apart within one tracker, with the category\'s own label where there is no override', () => {
      const err = refused({ ...base(), labels: { ado: { ktlo: 'Feature' } } });
      expect(err.message).toContain('"feature" is also the label of ktlo in ado');
      // The same override in another tracker is fine: each tracker is judged by itself.
      expect(readScheme({ ...base(), labels: { ado: { ktlo: 'Keep' }, jira: { feature: 'new-thing' } } }, 'x').scheme.labels.jira).toEqual({ feature: 'new-thing' });
    });
  });

  it('refuses what is not an object', () => {
    for (const raw of [null, [], 'x', 3]) expect(refused(raw).message).toContain('must be a JSON object');
  });
});

describe('schemeContent', () => {
  it('writes a stable key order, two-space JSON and one trailing line feed', () => {
    const text = schemeContent(defaultScheme());
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(Object.keys(JSON.parse(text))).toEqual(['name', 'revision', 'categories', 'guidance', 'examples', 'rules', 'signals', 'labels']);
    expect(text.split('\n')[1]).toBe('  "name": "ktlo-feature",');
    expect(text).not.toContain('\r');
  });

  it('puts a category\'s keys and an example\'s why in a fixed order, whatever order the file had', () => {
    const { scheme } = readScheme({ labels: {}, categories: [{ definition: 'd', label: 'a', name: 'A', short: 'A', id: 'a' }, { id: 'b', short: 'B', name: 'B', label: 'b', definition: 'd' }], examples: [{ why: 'w', category: 'a', title: 't', item: 'i' }], name: 'team' }, 'x');
    const text = JSON.parse(schemeContent(scheme));
    expect(Object.keys(text.categories[0])).toEqual(['id', 'short', 'name', 'label', 'definition']);
    expect(Object.keys(text.examples[0])).toEqual(['item', 'title', 'category', 'why']);
  });

  it('round-trips through the reader', () => {
    const scheme: Scheme = { ...builtinScheme('balance')!, revision: 4, rules: [{ id: 'esc', when: { label: ['customer-escalation'] }, then: 'ktlo' }], labels: { ado: { ktlo: 'KTLO' } } };
    expect(readScheme(JSON.parse(schemeContent(scheme)), 'x').scheme).toEqual(scheme);
  });
});

describe('diffSchemes', () => {
  const before = (): Scheme => readScheme({ ...base(), guidance: ['one'], rules: [{ id: 'r1', when: { label: ['x'] }, then: 'ktlo' }] }, 'x').scheme;

  it('says nothing changed when nothing did, whatever the revision', () => {
    const after = { ...before(), revision: 9 };
    expect(diffSchemes(before(), after)).toEqual({
      categories: { added: [], removed: [], changed: [] },
      rules: { added: [], removed: [], changed: [] },
      guidance: false,
      examples: false,
      signals: false,
      labels: false,
      any: false,
    });
  });

  it('lists categories and rules added, removed and changed by id', () => {
    const after = before();
    after.categories = [{ ...ktlo, definition: 'Changed.' }, { id: 'new', short: 'New', name: 'New', label: 'new', definition: 'd' }];
    after.rules = [{ id: 'r2', when: { type: ['BUG'] }, then: 'ktlo' }];
    const d = diffSchemes(before(), after);
    expect(d.categories).toEqual({ added: ['new'], removed: ['feature'], changed: ['ktlo'] });
    expect(d.rules).toEqual({ added: ['r2'], removed: ['r1'], changed: [] });
    expect(d.any).toBe(true);
  });

  it('flags a changed rule, guidance, examples, signals and labels', () => {
    const after = before();
    after.rules[0]!.then = 'feature';
    after.guidance = ['two'];
    after.examples = [{ item: 'a', title: 'b', category: 'ktlo' }];
    after.signals = false;
    after.labels = { ado: { ktlo: 'KTLO' } };
    expect(diffSchemes(before(), after)).toMatchObject({ rules: { changed: ['r1'] }, guidance: true, examples: true, signals: true, labels: true, any: true });
  });

  it('counts a reordering of categories as a change', () => {
    const after = before();
    after.categories.reverse();
    const d = diffSchemes(before(), after);
    expect(d.categories).toEqual({ added: [], removed: [], changed: [] });
    expect(d.any).toBe(true);
  });
});
