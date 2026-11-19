import { describe, expect, it } from 'vitest';
import { ToilError } from '../errors.js';
import { BUILTIN_STANDARDS, BUILTIN_STANDARD_NAMES, builtinStandard } from './builtin.js';
import { patternProblem, readStandard, standardContent } from './read.js';

const rule = (extra: Record<string, unknown> = {}) => ({ id: 'scenarios', name: 'Given/When/Then', text: 'Write the criteria as scenarios.', check: { kind: 'pattern', in: ['criteria'], match: ['^given\\b'], flags: 'im' }, ...extra });
const standard = (extra: Record<string, unknown> = {}) => ({ name: 'team', rules: [rule()], ...extra });

function refusal(raw: unknown): ToilError {
  try {
    readStandard(raw, 'team.json');
  } catch (err) {
    return err as ToilError;
  }
  throw new Error('expected a refusal');
}

describe('readStandard', () => {
  it('reads a standard with defaults filled in: revision 1, fail thin, no when', () => {
    const { standard: s, warnings } = readStandard(standard(), 'team.json');
    expect(warnings).toEqual([]);
    expect(s).toEqual({ name: 'team', revision: 1, rules: [{ id: 'scenarios', name: 'Given/When/Then', text: 'Write the criteria as scenarios.', fail: 'thin', check: { kind: 'pattern', in: ['criteria'], match: ['^given\\b'], flags: 'im' } }] });
  });

  it('reads every kind, a field place and a judge with its default place', () => {
    const { standard: s } = readStandard(
      standard({
        rules: [
          rule({ id: 'a', check: { kind: 'section', in: ['field:Microsoft.VSTS.TCM.ReproSteps', 'description'], heading: ['Steps'] } }),
          rule({ id: 'b', check: { kind: 'field', in: ['field:risk'] }, fail: 'fail' }),
          rule({ id: 'c', check: { kind: 'words', in: ['title', 'description'], min: 20 } }),
          rule({ id: 'd', check: { kind: 'judge' }, when: { type: ['STORY'] } }),
        ],
      }),
      'team.json',
    );
    expect(s.rules.map((r) => r.check)).toEqual([
      { kind: 'section', in: ['field:Microsoft.VSTS.TCM.ReproSteps', 'description'], heading: ['Steps'], minWords: 1 },
      { kind: 'field', in: ['field:risk'] },
      { kind: 'words', in: ['title', 'description'], min: 20 },
      { kind: 'judge', in: ['description'] },
    ]);
    expect(s.rules[1]!.fail).toBe('fail');
    expect(s.rules[3]!.when).toEqual({ type: ['STORY'] });
  });

  it('warns on an unknown key and keeps going', () => {
    const { warnings } = readStandard(standard({ colour: 'blue', rules: [rule({ shade: 1, check: { kind: 'field', in: ['title'], extra: 1 } })] }), 'team.json');
    expect(warnings.map((w) => w.code)).toEqual(['STANDARD_UNKNOWN_KEY', 'STANDARD_UNKNOWN_KEY', 'STANDARD_UNKNOWN_KEY']);
    expect(warnings[0]!.message).toContain('team.json (colour)');
  });

  it('refuses an empty when, which would quietly mean every item', () => {
    expect(refusal(standard({ rules: [rule({ when: {} })] })).message).toContain('rules[0].when: "when" must name at least one of');
  });

  it('refuses text that is multi-line, too long, or shaped like a credential, and says where', () => {
    expect(refusal(standard({ rules: [rule({ text: 'one\ntwo' })] })).message).toContain('rules[0].text: "text" must be one line');
    expect(refusal(standard({ rules: [rule({ text: 'x'.repeat(501) })] })).message).toContain('the most is 500');
    expect(refusal(standard({ rules: [rule({ text: 'Use ghp_abcdefghijklmnopqrstuvwxyz0123456789 to log in' })] })).message).toContain('shaped like a credential');
  });

  it('refuses a bad name, no rules, a repeated rule id, a bad fail and an unknown kind or place', () => {
    expect(refusal(standard({ name: 'Team Rules' })).message).toContain('name:');
    expect(refusal(standard({ rules: [] })).message).toContain('rules:');
    expect(refusal(standard({ rules: [rule(), rule()] })).message).toContain('"scenarios" is used by two rules');
    expect(refusal(standard({ rules: [rule({ fail: 'block' })] })).message).toContain('"fail" must be "thin"');
    expect(refusal(standard({ rules: [rule({ check: { kind: 'ai', in: ['title'] } })] })).message).toContain('"kind" must be one of pattern, section, field, words, judge');
    expect(refusal(standard({ rules: [rule({ check: { kind: 'field', in: ['body'] } })] })).message).toContain('"body" isn\'t a place');
    expect(refusal(standard({ rules: [rule({ check: { kind: 'field', in: ['title', 'title'] } })] })).message).toContain('listed twice');
    expect(refusal(standard({ rules: [rule({ check: { kind: 'words', in: ['title'] } })] })).message).toContain('"min" must be a whole number');
  });

  it('refuses flags beyond i, m and s, and a pattern that does not compile, is too long, or too many', () => {
    expect(refusal(standard({ rules: [rule({ check: { kind: 'pattern', in: ['title'], match: ['x'], flags: 'g' } })] })).message).toContain('"flags" may hold only i');
    expect(refusal(standard({ rules: [rule({ check: { kind: 'pattern', in: ['title'], match: ['('] } })] })).message).toContain("doesn't compile");
    expect(refusal(standard({ rules: [rule({ check: { kind: 'pattern', in: ['title'], match: ['a'.repeat(201)] } })] })).message).toContain('the most is 200');
    expect(refusal(standard({ rules: [rule({ check: { kind: 'pattern', in: ['title'], match: Array.from({ length: 11 }, () => 'a') } })] })).message).toContain('1 to 10 regular expressions');
  });

  it('reads plain labels for the patterns, one per pattern, and refuses a mismatched, multi-line, long or credential-shaped one', () => {
    const labelled = (labels: unknown) => standard({ rules: [rule({ check: { kind: 'pattern', in: ['criteria'], match: ['^given\\b', '^then\\b'], labels } })] });
    expect(readStandard(labelled([' a Given line ', 'a Then line']), 'team.json').standard.rules[0]!.check).toMatchObject({ labels: ['a Given line', 'a Then line'] });
    expect(refusal(labelled(['a Given line'])).message).toContain('rules[0].check.labels: "labels" must be a list with one plain name per pattern');
    expect(refusal(labelled('a Given line')).message).toContain('one plain name per pattern');
    expect(refusal(labelled(['a Given line', 'a\nThen line'])).message).toContain('rules[0].check.labels[1]: A label must be one line');
    expect(refusal(labelled(['a Given line', 'x'.repeat(101)])).message).toContain('the most is 100');
    expect(refusal(labelled(['a Given line', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'])).message).toContain('shaped like a credential');
  });

  it('refuses a pathological pattern before it can run', () => {
    for (const bad of ['(a+)+$', '(a|aa)*b', '(\\w+\\s?){2,}x', '(?:x*)*', '((ab)*)+']) {
      expect(refusal(standard({ rules: [rule({ check: { kind: 'pattern', in: ['title'], match: [bad] } })] })).message, bad).toContain('exponential time');
    }
    expect(refusal(standard({ rules: [rule({ check: { kind: 'pattern', in: ['title'], match: ['(a)\\1'] } })] })).message).toContain('backreference');
  });

  it('round-trips through its own content', () => {
    const { standard: s } = readStandard(standard({ revision: 4, description: 'Our rules.' }), 'team.json');
    expect(readStandard(JSON.parse(standardContent(s)), 'again').standard).toEqual(s);
  });
});

describe('patternProblem', () => {
  it('lets through the shapes the presets and ordinary rules use', () => {
    for (const ok of ['^\\W*given\\b', '\\bas an? [^,\\n]{1,80},? i want\\b[^\\n]{1,300}\\bso that\\b', '(?:foo|bar)', '(ab)?', '(abc){1}', '[(+*]+', 'a{2,5}?', '(?<year>\\d{4})-\\d\\d']) expect(patternProblem(ok), ok).toBeUndefined();
  });

  it('lets through repeats that cannot trade characters, and a fixed atom between two that can', () => {
    for (const ok of ['\\w+\\s+\\w+', '\\d+-\\d+', '[a-z]+[0-9]+', '\\s*\\S+', '^\\s*given\\b', 'x\\s*y\\s*z', '[^,]{1,80},?\\s', '\\x41*b*', 'a{3}a{3}', '(?=\\s*)\\s*', '[^,]*,.*b', '[^@\\s]+@\\S+', '[^,\\n]{1,80},? i want\\b[^\\n]{1,300}']) {
      expect(patternProblem(ok), ok).toBeUndefined();
    }
  });

  // Each of these, run, takes from seconds to minutes on a few hundred characters (\s*\s*\s*x: 12.7 s on 500
  // spaces); refused, it never runs, so the proof is that refusing takes no time at all.
  it('refuses two repeats side by side that can match the same characters, before anything runs', () => {
    const cases: [string, string][] = [
      ['\\s*\\s*\\s*x', '"\\\\s*" after "\\\\s*"'],
      ['\\d+\\d+', '"\\\\d+" after "\\\\d+"'],
      ['.*.*', '".*" after ".*"'],
      ['a*a*', '"a*" after "a*"'],
      // \s* can match nothing, so the two \w+ can trade letters through it; written \w+\s+\w+ it reads.
      ['\\w+\\s*\\w+', '"\\\\w+" after "\\\\w+"'],
      ['a*A+', '"A+" after "a*"'],
      ['\\s*(?:\\s+x)', 'after "\\\\s*"'],
      ['[ \\t]*\\s+', 'after "[ \\\\t]*"'],
      ['\\u00e9*\\S+', 'after "\\\\u00e9*"'],
      ['(?:[]|)a*a*', '"a*" after "a*"'],
      // A required character both can match doesn't keep two unbounded repeats apart: cubic on a text of a's.
      ['.*a.*b', '".*" after ".*"'],
      ['\\S+@\\S+', '"\\\\S+" after "\\\\S+"'],
      // Without the i flag [^a] still matches A, so the guard must not fold the case before it complements.
      ['[^a]*A*', 'after "[^a]*"'],
    ];
    for (const [bad, says] of cases) {
      const t0 = performance.now();
      const why = patternProblem(bad);
      expect(performance.now() - t0, bad).toBeLessThan(50);
      expect(why, bad).toContain(says);
      expect(why, bad).toContain('can take minutes on a long text');
      expect(refusal(standard({ rules: [rule({ check: { kind: 'pattern', in: ['title'], match: [bad] } })] })).message, bad).toContain('the two can trade the same characters');
    }
  });

  it('reads [] and [^] the way JavaScript does, so a class cannot hide a repeated group', () => {
    // In JavaScript `[]` closes at once; reading `[]|)(a+)+b` as one class would let the group past the guard.
    expect(patternProblem('(?:[]|)(a+)+b')).toContain('exponential time');
  });

  it('keeps every pattern it accepts at most quadratic, timed at 5,000 and 10,000 characters', () => {
    // A wall-clock bound fails on a busy runner; growth doesn't. Doubling the text roughly doubles a linear pattern's time,
    // quadruples a quadratic one's and multiplies a cubic one's by eight, so the ratio of the fastest of three runs tells them apart.
    const texts = (n: number) => [' '.repeat(n), 'a'.repeat(n), '1'.repeat(n), 'a '.repeat(n / 2)];
    const time = (re: RegExp, n: number) => {
      let best = Infinity;
      for (let run = 0; run < 3; run++) {
        const t0 = performance.now();
        for (const t of texts(n)) re.test(t);
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    for (const ok of ['[^,]*,.*b', '\\w+\\s+\\w+x', '^\\W*given\\b', '\\bas an? [^,\\n]{1,80},? i want\\b[^\\n]{1,300}\\bso that\\b', '\\s*\\S+x']) {
      expect(patternProblem(ok), ok).toBeUndefined();
      const re = new RegExp(ok, 'im');
      const small = time(re, 5_000);
      const large = time(re, 10_000);
      // 6 sits between quadratic (4) and cubic (8); the 20 ms floor keeps a pattern too fast to time from failing on noise.
      expect(large, ok).toBeLessThan(small * 6 + 20);
    }
  }, 30_000);
});

describe('the built-in standards', () => {
  it('are gherkin, user-story and bug-repro, and each reads through the reader unchanged', () => {
    expect(BUILTIN_STANDARD_NAMES).toEqual(['gherkin', 'user-story', 'bug-repro']);
    for (const s of BUILTIN_STANDARDS) expect(readStandard(JSON.parse(standardContent(s)), `the built-in ${s.name}`).standard).toEqual(s);
  });

  it('hands out copies', () => {
    builtinStandard('gherkin')!.rules.length = 0;
    expect(builtinStandard('gherkin')!.rules).toHaveLength(1);
    expect(builtinStandard('nope')).toBeUndefined();
  });
});

describe('a rule\'s missing phrase', () => {
  it('is kept when given and checked like a name', async () => {
    const { readStandard } = await import('./read.js');
    const base = { name: 'team', rules: [{ id: 'r1', name: 'Has a story', missing: 'no user story', text: 'Write a user story.', check: { kind: 'words', in: ['description'], min: 3 } }] };
    expect(readStandard(base, 'test').standard.rules[0]?.missing).toBe('no user story');
    expect(() => readStandard({ ...base, rules: [{ ...base.rules[0], missing: 'two\nlines' }] }, 'test')).toThrow();
  });
});
