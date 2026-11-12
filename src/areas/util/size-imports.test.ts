import { describe, expect, it } from 'vitest';
import { testContext } from '../../../test/harness/context.js';
import type { Warning } from '../../core/envelope.js';
import { execute } from '../../core/run.js';
import { Verifier } from './kit/verify.js';
import { sizeCommand } from './size.js';
import { extractImports, IMPORTS_MAX, type ImportEntry } from './size/imports.js';
import { lex, type CodeLanguage } from './size/lexer.js';
import { verifyImports, type FileSize } from './size/measure.js';

/**
 * `util size`'s imports, per language and per form, with the false positives
 * that a regular expression over the text would have counted: an import in a
 * comment, in a string, C#'s `using (…)` statement. The specifiers are as
 * written; nothing is resolved. A module is only as findable as the person
 * who wrote down where it lives.
 */

const importsOf = (text: string, lang: CodeLanguage) => extractImports(lex(text, lang), lang).imports;
const brief = (imports: ImportEntry[]) =>
  imports.map((i) => `${i.kind} ${i.specifier}@${i.line}${i.names ? ` {${i.names.join(',')}}` : ''}${i.alias ? ` as ${i.alias}` : ''}${i.modifiers ? ` [${i.modifiers.join(',')}]` : ''}`);

describe('util size imports: TypeScript and JavaScript', () => {
  it('reads every form of ESM, with the names each takes', () => {
    const src = [
      "import def from './def';",
      "import * as ns from 'node:fs';",
      "import { a, b as c, type D } from '../lib/x';",
      "import type { T } from './types';",
      "import type Def2 from './t2';",
      "import def3, { e } from 'pkg';",
      "import './side-effect.css';",
      'import {',
      '  multi,',
      "} from 'multi';",
      "export * from './all';",
      "export * as ns2 from './ns2';",
      "export { f, g as h } from './fg';",
      "export type { U } from './u';",
      '',
    ].join('\n');
    expect(brief(importsOf(src, 'typescript'))).toEqual([
      'import ./def@1 {default}',
      'import node:fs@2 {*}',
      'import ../lib/x@3 {a,b,D}',
      'import ./types@4 {T}',
      'import ./t2@5 {default}',
      'import pkg@6 {default,e}',
      'import ./side-effect.css@7',
      'import multi@10 {multi}',
      'from ./all@11 {*}',
      'from ./ns2@12 {*}',
      'from ./fg@13 {f,g}',
      'from ./u@14 {U}',
    ]);
  });

  it('reads require() and import() with a literal, and import x = require()', () => {
    const src = ["const a = require('a');", "const lazy = () => import('./lazy');", "import fs = require('node:fs');", 'const n = require(name);', 'const t = await import(`./${x}`);', "x.require('no');", "obj?.require('no');", "this.#require('no');", ''].join('\n');
    expect(brief(importsOf(src, 'typescript'))).toEqual(['require a@1', 'dynamic ./lazy@2', 'require node:fs@3']);
  });

  it('ignores imports in comments, strings, templates and regexes', () => {
    const src = ["// import x from 'a';", "/* require('b') */", 'const s = "import y from \'c\'";', "const t = `import('d')`;", "const r = /import z from 'e'/;", "export const meta = { import: 'f' };", 'import.meta.url;', ''].join('\n');
    expect(importsOf(src, 'javascript')).toEqual([]);
  });
});

describe('util size imports: Python', () => {
  it('reads import, aliases, comma lists, and relative from-imports across lines', () => {
    const src = [
      'import os',
      'import a.b as c, d',
      'from . import x',
      'from ..pkg import (',
      '    a,',
      '    b as bee,',
      ')',
      'from .rel.mod import y, z',
      'from ... import w',
      'from m import *',
      'try: import fast',
      'except ImportError: pass',
      '',
    ].join('\n');
    expect(brief(importsOf(src, 'python'))).toEqual([
      'import os@1',
      'import a.b@2 as c',
      'import d@2',
      'from .@3 {x}',
      'from ..pkg@4 {a,b}',
      'from .rel.mod@8 {y,z}',
      'from ...@9 {w}',
      'from m@10 {*}',
      'import fast@11',
    ]);
  });

  it('ignores an import in a comment, a string or a docstring, and raise … from', () => {
    const src = ['# import nope', 'x = "import nope2"', '"""', 'import nope3', 'from nope4 import y', '"""', 'def f():', '    raise ValueError() from err', '    yield from gen', 'import real', ''].join('\n');
    expect(brief(importsOf(src, 'python'))).toEqual(['import real@10']);
  });
});

describe('util size imports: Java', () => {
  it('reads plain, static and wildcard imports', () => {
    const src = ['package a.b;', '', 'import java.util.List;', 'import static org.junit.Assert.assertEquals;', 'import java.io.*;', '// import java.nope.X;', 'public class A { String s = "import java.nope.Y;"; }', ''].join('\n');
    expect(brief(importsOf(src, 'java'))).toEqual(['import java.util.List@3 {List}', 'import org.junit.Assert.assertEquals@4 {assertEquals} [static]', 'import java.io.*@5 {*}']);
  });
});

describe('util size imports: C#', () => {
  it('reads using, static, global and alias directives, not using statements', () => {
    const src = [
      'global using System.Linq;',
      'using System;',
      'using System.Text;',
      'using static System.Math;',
      'using Json = System.Text.Json.JsonSerializer;',
      'using Map = System.Collections.Generic.Dictionary<string, int>;',
      'namespace N {',
      '  using Inner.Ns;',
      '  class C {',
      '    void M() {',
      '      using (var r = new Reader()) { }',
      '      using var s = new Stream();',
      '      using Foo f = new Foo();',
      '      await using var a = Make();',
      '      var t = "using Nope.String;"; // using Nope.Comment;',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
    expect(brief(importsOf(src, 'csharp'))).toEqual([
      'using System.Linq@1 [global]',
      'using System@2',
      'using System.Text@3',
      'using System.Math@4 [static]',
      'using System.Text.Json.JsonSerializer@5 as Json',
      'using System.Collections.Generic.Dictionary<string,int>@6 as Map',
      'using Inner.Ns@8',
    ]);
  });
});

describe('util size imports: Go', () => {
  it('reads single and grouped imports with aliases, dot and blank', () => {
    const src = ['package main', '', 'import "fmt"', 'import str "strings"', '', 'import (', '\t"os"', '\tlog "log/slog"', '\t_ "embed"', '\t. "math"', '\t// "nope/comment"', '\t"net/http"', ')', '', 'var s = `import "nope/raw"`', ''].join('\n');
    expect(brief(importsOf(src, 'go'))).toEqual(['import fmt@3', 'import strings@4 as str', 'import os@7', 'import log/slog@8 as log', 'import embed@9 as _', 'import math@10 as .', 'import net/http@12']);
  });
});

describe('util size imports: through the command', () => {
  const run = async (text: string, language: string) => {
    const envelope = await execute(sizeCommand, { text, language }, testContext({}).context);
    return { envelope, data: envelope.data as FileSize, warnings: (envelope.meta.warnings ?? []) as Warning[] };
  };

  it('puts imports in the outline with their method, and re-reads every line', async () => {
    const { envelope, data } = await run("import a from './a';\nexport const x = 1;\n", 'typescript');
    expect(envelope.error).toBeNull();
    expect(data.outline!.precision).toBe('syntactic');
    expect(data.outline!.imports).toEqual([{ specifier: './a', kind: 'import', line: 1, names: ['default'] }]);
    expect(data.outline!.importsMethod).toContain('nothing is resolved');
    const checks = Object.fromEntries(data.verified.checks.map((c) => [c.check, c]));
    expect(checks['imports.line']).toMatchObject({ status: 'passed', checked: 1, failed: 0 });
    expect(checks['imports.range']).toMatchObject({ status: 'passed' });
  });

  it('has no imports field for Markdown, JSON or YAML, and an empty list for code without any', async () => {
    expect((await run('# T\n', 'markdown')).data.outline!.imports).toBeUndefined();
    expect((await run('{"a":1}', 'json')).data.outline!.imports).toBeUndefined();
    expect((await run('const x = 1;\n', 'javascript')).data.outline!.imports).toEqual([]);
  });

  it('caps the list, counts what it cut, and warns', async () => {
    const total = IMPORTS_MAX + 5;
    const text = Array.from({ length: total }, (_, k) => `import 'm${k}';`).join('\n') + '\n';
    const { data, warnings } = await run(text, 'javascript');
    expect(data.outline!.imports).toHaveLength(IMPORTS_MAX);
    const warning = warnings.find((w) => w.code === 'SIZE_IMPORTS_TRUNCATED');
    expect(warning?.message).toContain(`${total} imports`);
    expect(data.verified.passed).toBe(true);
  });
});

describe('util size imports: the self-check catches a wrong line', () => {
  const lines = ["import a from './a';", 'const x = 1;'];
  const input = { linesAt: async (wanted: number[]) => new Map(wanted.filter((n) => n >= 1 && n <= lines.length).map((n) => [n, lines[n - 1]!])) };
  const check = async (imports: ImportEntry[]) => {
    const v = new Verifier(() => undefined);
    await verifyImports(imports, input, lines.length, v);
    return v.done();
  };

  it('passes the import as found', async () => {
    expect((await check([{ specifier: './a', kind: 'import', line: 1 }])).passed).toBe(true);
  });

  it('fails a specifier the line does not hold, and a line past the end', async () => {
    const done = await check([
      { specifier: './a', kind: 'import', line: 2 },
      { specifier: './b', kind: 'import', line: 9 },
    ]);
    expect(done.passed).toBe(false);
    expect(done.checks.find((c) => c.check === 'imports.line')).toMatchObject({ status: 'failed', failed: 2 });
    expect(done.checks.find((c) => c.check === 'imports.range')).toMatchObject({ status: 'failed', failed: 1 });
  });

  it('does not pass a short specifier on any line that has the letter in it', async () => {
    expect((await check([{ specifier: 'a', kind: 'import', line: 2 }])).passed).toBe(false);
    expect((await check([{ specifier: 'cons', kind: 'import', line: 2 }])).passed).toBe(false);
    expect((await check([{ specifier: 'const', kind: 'import', line: 2 }])).passed).toBe(true);
  });

  it('keeps the letter s: whitespace is what is ignored', async () => {
    const wrapped = ['using System . Text;', 'using D = System.Collections.Generic.Dictionary<string, int>;', 'import os . path'];
    const reader = { linesAt: async (wanted: number[]) => new Map(wanted.map((n) => [n, wrapped[n - 1]!])) };
    const v = new Verifier(() => undefined);
    await verifyImports(
      [
        { specifier: 'System.Text', kind: 'using', line: 1 },
        { specifier: 'System.Collections.Generic.Dictionary<string,int>', kind: 'using', line: 2, alias: 'D' },
        { specifier: 'os.path', kind: 'import', line: 3 },
      ],
      reader,
      3,
      v,
    );
    expect(v.done().passed).toBe(true);
    const bad = new Verifier(() => undefined);
    await verifyImports([{ specifier: 'Sytem.Text', kind: 'using', line: 1 }], reader, 3, bad);
    expect(bad.done().passed).toBe(false);
  });

  it('passes the spaced forms end to end', async () => {
    const run = async (text: string, language: string) => {
      const envelope = await execute(sizeCommand, { text, language }, testContext({}).context);
      return envelope.data as FileSize;
    };
    for (const [text, language] of [
      ['using D = System.Collections.Generic.Dictionary<string, int>;\nusing System . Text;\n', 'csharp'],
      ['import os . path\n', 'python'],
      ['from . import x\nfrom \\\n  pkg import thing\n', 'python'],
    ] as const) {
      const data = await run(text, language);
      expect(data.outline!.imports!.length).toBeGreaterThan(0);
      expect(data.verified.passed).toBe(true);
    }
  });
});

describe('util size imports: more forms', () => {
  it('reads a Python from-import continued with a backslash, at the module’s own line', () => {
    expect(brief(importsOf('from \\\n  pkg import thing\nimport \\\n  os\n', 'python'))).toEqual(['from pkg@2 {thing}', 'import os@4']);
  });

  it('reads os . path with spaces as written by its tokens', () => {
    expect(brief(importsOf('import os . path\n', 'python'))).toEqual(['import os.path@1']);
  });

  it('reads a template literal with no interpolation as a literal specifier, and not one with', () => {
    const src = ['const a = await import(`./mod.js`);', 'const b = require(`./other`);', 'const c = require(`./${x}`);', ''].join('\n');
    expect(brief(importsOf(src, 'typescript'))).toEqual(['dynamic ./mod.js@1', 'require ./other@2']);
  });

  it('reads using unsafe aliases', () => {
    expect(brief(importsOf('using unsafe P = int*;\nusing static unsafe System.Math;\n', 'csharp'))).toEqual(['using int*@1 as P [unsafe]', 'using System.Math@2 [static,unsafe]']);
  });
});

describe('util size imports: hostile input stays linear', () => {
  const cases: Array<[string, CodeLanguage, (n: number) => string]> = [
    ['C# aliases in braces', 'csharp', (n) => '{ } using a = '.repeat(n)],
    ['unclosed import braces', 'typescript', (n) => 'import { '.repeat(n) + '} '.repeat(n)],
    ['nested export braces', 'typescript', (n) => 'x = { export { '.repeat(n / 2) + '} } '.repeat(n / 2)],
    ['unclosed Python import parentheses', 'python', (n) => 'from a import (\n'.repeat(n)],
    ['unclosed Python from lists', 'python', (n) => 'from a import b, \\\n'.repeat(n)],
  ];
  const time = (lang: CodeLanguage, text: string) => {
    const tokens = lex(text, lang);
    const start = performance.now();
    extractImports(tokens, lang);
    return performance.now() - start;
  };
  it.each(cases)('%s: 20,000 repeats in a few seconds at most', (_name, lang, make) => {
    // Linear is milliseconds; the ratio test below is what catches a quadratic slope, this one a blowup, so it leaves a loaded runner room.
    expect(time(lang, make(20_000))).toBeLessThan(5000);
  });
  it.each(cases)('%s: four times the input is not sixteen times the work', (_name, lang, make) => {
    time(lang, make(5_000));
    // Floored at 5 ms so timer noise on a fast run can't make the ratio large.
    // Each side is its best of three, so one garbage collection on a busy runner can't decide the ratio.
    const best = (text: string) => Math.min(time(lang, text), time(lang, text), time(lang, text));
    const small = Math.max(best(make(10_000)), 5);
    const large = best(make(40_000));
    expect(large / small).toBeLessThan(12);
  });
});
