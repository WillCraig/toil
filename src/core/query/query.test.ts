import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileQuery, pointAt, QueryError, search } from './index.js';

/**
 * The JMESPath compliance suite, vendored unchanged under
 * test/fixtures/jmespath/ (MIT; see the LICENSE beside it and NOTICE). Every
 * case runs: a result is compared exactly, an error by its kind.
 */
const dir = join(import.meta.dirname, '..', '..', '..', 'test', 'fixtures', 'jmespath');

interface Case {
  expression: string;
  result?: unknown;
  error?: string;
  bench?: string;
  comment?: string;
}

const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

describe('JMESPath compliance suite', () => {
  it('is all there', () => {
    expect(files).toHaveLength(16);
  });

  for (const file of files) {
    const groups = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Array<{ given: unknown; cases: Case[] }>;
    describe(file, () => {
      groups.forEach((group, g) => {
        group.cases.forEach((c, i) => {
          it(`${g + 1}.${i + 1}: ${c.expression}${c.comment ? ` (${c.comment})` : ''}`, () => {
            if (c.error !== undefined) {
              let thrown: unknown;
              try {
                search(group.given, c.expression);
              } catch (err) {
                thrown = err;
              }
              expect(thrown, 'should fail').toBeInstanceOf(QueryError);
              expect((thrown as QueryError).kind).toBe(c.error);
            } else if ('result' in c) {
              expect(search(group.given, c.expression)).toEqual(c.result);
            } else {
              // A parse-only benchmark: it has to compile and run, whatever it gives.
              expect(() => search(group.given, c.expression)).not.toThrow();
            }
          });
        });
      });
    });
  }
});

describe('compileQuery', () => {
  it('refuses a bad expression before any data, with where it went wrong', () => {
    const err = (() => {
      try {
        compileQuery('items[?state == `open`].{key: key, owner: owner.name');
      } catch (e) {
        return e as QueryError;
      }
    })();
    expect(err?.kind).toBe('syntax');
    expect(err?.position).toBe(52);
    expect(pointAt('items[?state == `open`].{key: key, owner: owner.name', err!)).toContain('owner.name>>>');
  });

  it('knows an unknown function and a wrong argument count at compile time', () => {
    expect(() => compileQuery('nope(@)')).toThrow(expect.objectContaining({ kind: 'unknown-function', position: 0 }));
    expect(() => compileQuery('a | length(@, @)')).toThrow(expect.objectContaining({ kind: 'invalid-arity', position: 4 }));
    expect(() => compileQuery('toString(@)')).toThrow(expect.objectContaining({ kind: 'unknown-function' }));
  });

  it('reads only data: prototype names are missing fields, and __proto__ is an ordinary key', () => {
    expect(search({}, 'constructor')).toBeNull();
    expect(search({ a: 1 }, '__proto__')).toBeNull();
    const built = search({ a: 1 }, '{"__proto__": a}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(built)).toBe(Object.prototype);
    expect(Object.keys(built)).toEqual(['__proto__']);
    const merged = search({ x: JSON.parse('{"__proto__": {"polluted": true}}') }, 'merge(x)') as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(merged)).toEqual(['__proto__']);
  });

  it('refuses an expression nested more than 500 levels deep, however it nests, before any data', () => {
    const deep = [
      '('.repeat(10_000) + 'a' + ')'.repeat(10_000),
      'a' + '.b'.repeat(10_000),
      '['.repeat(600) + 'a' + ']'.repeat(600),
      '!'.repeat(600) + 'a',
      '('.repeat(300) + 'a' + '.b'.repeat(300) + ')'.repeat(300),
    ];
    for (const expression of deep) {
      expect(() => compileQuery(expression), expression.slice(0, 20)).toThrow(expect.objectContaining({ kind: 'syntax', message: expect.stringContaining('more than 500 levels') }));
    }
  });

  it('still takes deep and wide expressions inside the limit', () => {
    expect(search({ a: 1 }, '('.repeat(400) + 'a' + ')'.repeat(400))).toBe(1);
    expect(search({ a: { a: 2 } }, 'a' + '.a'.repeat(400))).toBeNull();
    const keys = Array.from({ length: 2000 }, (_, i) => `k${i}: a`).join(', ');
    expect(Object.keys(search({ a: 1 }, `{${keys}}`) as object)).toHaveLength(2000);
  });

  it('never hands back an expression reference, only data', () => {
    expect(search({ a: 1 }, '&a')).toBeNull();
    expect(JSON.stringify(search({ a: 1 }, '[&a]'))).toBe('[null]');
  });

  it('treats a field set to undefined as missing, as JSON would', () => {
    expect(search({ a: undefined, b: 1 }, '[a, b]')).toEqual([null, 1]);
  });
});

/**
 * Wildcard and object projections the vendored suite never reaches: it has no
 * object projection followed by more than one field, which is where `a.*.b.c`
 * gave null (#279). Written in the suite's own shape (`given`, then each
 * expression and its result). The specification says that once a projection
 * is made, "all subsequent expressions are projected onto the resulting list",
 * so `a.*.<rest>` means the same as `values(a)[*].<rest>` whenever `a` is an
 * object. Each result here was checked against that rewrite in the Python
 * reference implementation (jmespath 1.0.1), which projects arrays correctly
 * and is the only reason this paragraph has a footnote's worth of provenance.
 * Both reference implementations (that one and jmespath.js 0.16.0) return null
 * for the unrewritten expressions; toil follows the specification.
 */
const projections: Array<{ given: unknown; cases: Array<{ expression: string; result: unknown }> }> = [
  {
    given: { a: { x: { b: { c: 1 } }, y: { b: { c: 2 } } } },
    cases: [
      { expression: 'a.*.b.c', result: [1, 2] },
      { expression: 'a.*.b', result: [{ c: 1 }, { c: 2 }] },
      { expression: 'values(a)[].b.c', result: [1, 2] },
      { expression: 'a.*.b.c.d', result: [] },
      { expression: 'a.*.b.missing', result: [] },
      { expression: 'a.*.missing.c', result: [] },
      { expression: 'a.*.b.c[0]', result: [] },
      { expression: 'a.*.b.[c]', result: [[1], [2]] },
      { expression: 'a.*.b.{v: c}', result: [{ v: 1 }, { v: 2 }] },
      // A pipe ends the projection, so what follows it sees the whole list.
      { expression: 'a.*.b.c | [0]', result: 1 },
      { expression: 'a.*.b.c | length(@)', result: 2 },
    ],
  },
  {
    given: { a: { x: { b: { c: { d: { e: 1 } } } }, y: { b: { c: { d: { e: 2 } } } }, z: { b: { c: null } } } },
    cases: [
      { expression: 'a.*.b.c.d.e', result: [1, 2] },
      { expression: 'a.*.b.c.d', result: [{ e: 1 }, { e: 2 }] },
      // Nested projections: each wildcard projects inside the one before it.
      { expression: 'a.*.b.c.*.e', result: [[1], [2]] },
      { expression: 'a.*.b.*.d.e', result: [[1], [2], []] },
      { expression: 'a.*.*.c.d.e', result: [[1], [2], []] },
      { expression: 'a.*.b.*.d.e[]', result: [1, 2] },
    ],
  },
  {
    given: { a: { x: { b: [{ c: 1 }, { c: 2 }] }, y: { b: [{ c: 3 }] } } },
    cases: [
      { expression: 'a.*.b[*].c', result: [[1, 2], [3]] },
      { expression: 'a.*.b[].c', result: [1, 2, 3] },
      { expression: 'a.*.b[0].c', result: [1, 3] },
      { expression: 'a.*.b[-1].c', result: [2, 3] },
      { expression: 'a.*.b[?c > `1`].c', result: [[2], [3]] },
      { expression: 'a.*.b[*].c | []', result: [1, 2, 3] },
    ],
  },
  {
    given: { a: [{ b: { x: { c: 1 }, y: { c: 2 } } }, { b: { z: { c: 3 } } }] },
    cases: [
      { expression: 'a[*].b.*.c', result: [[1, 2], [3]] },
      { expression: 'a[].b.*.c', result: [[1, 2], [3]] },
      { expression: 'a[*].b.*.c[]', result: [1, 2, 3] },
      { expression: 'a[0].b.*.c', result: [1, 2] },
    ],
  },
  {
    // Projections over null and over anything that isn't an object or array.
    given: { a: null, s: 'str', n: 1, l: [1, 2], o: { p: null, q: { r: null } } },
    cases: [
      { expression: 'a.*.b.c', result: null },
      { expression: 's.*.b.c', result: null },
      { expression: 'n.*.b.c', result: null },
      { expression: 'l.*.b.c', result: null },
      { expression: 'missing.*.b.c', result: null },
      { expression: 'a[*].b.c', result: null },
      { expression: 's[*].b.c', result: null },
      { expression: 'o.p.*.x.y', result: null },
      { expression: 'o.*.r', result: [] },
      { expression: 'o.*.r.t', result: [] },
    ],
  },
  {
    // A null part way down drops that value; a falsy one that isn't null stays.
    given: { a: { x: null, y: { b: null }, z: { b: { c: null } }, w: { b: { c: 0 } } } },
    cases: [
      { expression: 'a.*.b.c', result: [0] },
      { expression: 'a.*.b', result: [{ c: null }, { c: 0 }] },
      { expression: 'a.*', result: [{ b: null }, { b: { c: null } }, { b: { c: 0 } }] },
    ],
  },
];

describe('wildcard and object projections (#279)', () => {
  projections.forEach((group, g) => {
    group.cases.forEach((c, i) => {
      it(`${g + 1}.${i + 1}: ${c.expression}`, () => {
        expect(search(group.given, c.expression)).toEqual(c.result);
      });
    });
  });

  it('projects an object exactly as values() projects the same object as a list, however many fields follow', () => {
    const given = { a: { x: { b: { c: { d: [1, { e: 2 }] } } }, y: { b: { c: { d: [3] } } }, z: {} } };
    for (const rest of ['b', 'b.c', 'b.c.d', 'b.c.d[0]', 'b.c.d[1].e', 'b.c.d[*].e', 'b.c.d[]', 'b.[c]', 'b.c.{d: d}', 'b.*.d', 'b.c.d | [0]']) {
      expect(search(given, `a.*.${rest}`), rest).toEqual(search(given, `values(a)[*].${rest}`));
    }
  });
});

describe('the size of what an expression builds (query.size)', () => {
  // Each step doubles what came before: `[@,@]` makes two of it, and `[]` copies
  // both halves into one new list, so the copy really is twice as long.
  const doubling = (levels: number) => '[@,@][]'.repeat(levels);
  const timed = (run: () => unknown): { ms: number; error?: unknown } => {
    const started = performance.now();
    try {
      run();
      return { ms: performance.now() - started };
    } catch (error) {
      return { ms: performance.now() - started, error };
    }
  };
  const rows = Array.from({ length: 100_000 }, (_, i) => ({ id: i, name: `row-${i}`, tags: ['a', 'b'] }));

  it('stops an expression that doubles its input at each step, early and with an error, against a deadline set by a normal select', () => {
    // The baseline is a select that builds about as much as the bound allows,
    // so the deadline scales with the machine running the test.
    const baseline = timed(() => search({ rows }, 'rows[*].{id: id, name: name, tags: tags}'));
    expect(baseline.error).toBeUndefined();
    for (const levels of [30, 64, 200]) {
      const run = timed(() => search({ a: 1 }, doubling(levels)));
      expect(run.error, `${levels} levels`).toBeInstanceOf(QueryError);
      expect((run.error as QueryError).kind).toBe('invalid-value');
      expect((run.error as QueryError).message).toMatch(/builds more than 16 MiB of JSON/);
      expect(run.ms, `${levels} levels took ${Math.round(run.ms)} ms; the baseline took ${Math.round(baseline.ms)} ms`).toBeLessThan(Math.max(20 * baseline.ms, 2000));
    }
  });

  it('stops a doubling made only of shared references, which builds almost nothing but would print as gigabytes', () => {
    const piped = Array(64).fill('[@,@]').join(' | ');
    const run = timed(() => search({ a: 1 }, piped));
    expect((run.error as QueryError).message).toMatch(/builds more than 16 MiB/);
    expect(run.ms).toBeLessThan(5000);
    // A function that serializes or copies its argument is held to the same bound.
    expect(() => search({ a: 1 }, `to_string(${piped})`)).toThrow(/builds more than/);
    expect(() => search({ a: 1 }, `length(${Array(40).fill('[@,@]').join(' | ')}[])`)).toThrow(/builds more than/);
  });

  it('still answers a select over large data, including one that rebuilds all of it', () => {
    const data = { rows };
    expect(search(data, 'rows[*].id')).toHaveLength(100_000);
    expect(search(data, 'rows[].tags[]')).toHaveLength(200_000);
    expect(search(data, 'rows[*].{key: name}')).toHaveLength(100_000);
    // Up to four times the data's own size may be built from it, so even a copy of a copy works.
    expect(search(data, '[rows, rows][]')).toHaveLength(200_000);
    expect(search(data, 'length(sort_by(rows, &name))')).toBe(100_000);
    // Passing data along builds nothing, however large it is.
    expect(search(data, 'rows')).toBe(rows);
  });

  it('measures data nested far deeper than the stack goes, and refuses data that refers to itself', () => {
    let deep: unknown = 0;
    for (let i = 0; i < 200_000; i++) deep = [deep];
    expect(search({ deep }, '[deep]')).toEqual([deep]);
    const loop: Record<string, unknown> = { name: 'x' };
    loop.self = loop;
    expect(() => search(loop, '[@]')).toThrow(/refers to itself/);
    expect(search(loop, 'name')).toBe('x');
  });
});
