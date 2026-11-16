import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { sizeSamples } from '../../../test/fixtures/util.fixture.js';
import { runCli } from '../../../test/harness/cli.js';
import { testContext } from '../../../test/harness/context.js';
import { connectMcp } from '../../../test/harness/mcp.js';
import type { Warning } from '../../core/envelope.js';
import { execute } from '../../core/run.js';
import { commands } from './index.js';
import { Verifier } from './kit/verify.js';
import { sizeCommand } from './size.js';
import { outlineCode } from './size/code.js';
import { outlineMarkdown, scanJsonKeys, scanYamlKeys } from './size/data.js';
import { lex, OutlineError } from './size/lexer.js';
import { buildTree, checkKeys, OUTLINE_MAX_BYTES, verifyOutline, verifyTree, type FileEntry, type FileSize, type FolderSize, type OutlineSymbol } from './size/measure.js';

/**
 * `util size` on real files, one per language it outlines (sources in
 * test/fixtures/util.fixture.ts), and its self-checks fed results broken on
 * purpose. TypeScript and JavaScript outlines are held against the
 * TypeScript compiler's own syntax tree, which the tests may load and the
 * shipped command never does; the other languages against outlines checked
 * by hand, line by line. A second opinion is only as good as the first one
 * being written down.
 */

type Data = FileSize | FolderSize;
const sizeOf = async (input: Record<string, unknown>, options: { files?: Record<string, string | Uint8Array>; stdin?: string } = {}) => {
  const envelope = await execute(sizeCommand, input, testContext({ files: options.files ?? sizeSamples, ...(options.stdin === undefined ? {} : { stdin: options.stdin }) }).context);
  return { envelope, data: envelope.data as Data };
};
const fileOf = async (input: Record<string, unknown>, options: { files?: Record<string, string | Uint8Array>; stdin?: string } = {}) => {
  const { envelope, data } = await sizeOf(input, options);
  expect(envelope.error).toBeNull();
  return { envelope, data: data as FileSize };
};
const short = (symbols: readonly OutlineSymbol[]) => symbols.map((s) => `${s.kind} ${s.container ? `${s.container}.` : ''}${s.name} ${s.startLine}-${s.endLine}`);
const sample = (name: string) => sizeSamples[`samples/size/${name}`] as string;
const checks = (data: Data) => Object.fromEntries(data.verified.checks.map((c) => [c.check, c.status]));

/** What the TypeScript compiler says the outline is, by the same rules the scan follows. */
function compilerOutline(text: string, js: boolean): string[] {
  const sf = ts.createSourceFile(js ? 'x.js' : 'x.ts', text, ts.ScriptTarget.Latest, true, js ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const line = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const out: string[] = [];
  const add = (name: string, kind: string, at: ts.Node, node: ts.Node, container: string | null) => out.push(`${kind} ${container ? `${container}.` : ''}${name} ${line(at.getStart(sf))}-${line(node.end)}`);
  const fn = (e?: ts.Expression) => !!e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e));
  const members = (node: ts.ClassLikeDeclaration | ts.InterfaceDeclaration, container: string) => {
    for (const m of node.members) {
      if (ts.isConstructorDeclaration(m)) add('constructor', 'constructor', m.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.ConstructorKeyword)!, m, container);
      else if ((ts.isMethodDeclaration(m) || ts.isMethodSignature(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) && !ts.isComputedPropertyName(m.name)) add(m.name.getText(sf), 'method', m.name, m, container);
      else if (ts.isPropertyDeclaration(m) && fn(m.initializer)) add(m.name.getText(sf), 'method', m.name, m, container);
    }
  };
  for (const s of sf.statements) {
    const exported = !!(ts.getCombinedModifierFlags(s as unknown as ts.Declaration) & ts.ModifierFlags.Export);
    if (ts.isFunctionDeclaration(s)) add(s.name?.text ?? 'default', 'function', s.name ?? s, s, null);
    else if (ts.isClassDeclaration(s)) {
      add(s.name!.text, 'class', s.name!, s, null);
      members(s, s.name!.text);
    } else if (ts.isInterfaceDeclaration(s)) {
      add(s.name.text, 'interface', s.name, s, null);
      members(s, s.name.text);
    } else if (ts.isTypeAliasDeclaration(s)) add(s.name.text, 'type', s.name, s, null);
    else if (ts.isEnumDeclaration(s)) add(s.name.text, 'enum', s.name, s, null);
    else if (ts.isVariableStatement(s)) {
      const d = s.declarationList.declarations[0]!;
      if (!ts.isIdentifier(d.name)) continue;
      if (fn(d.initializer)) add(d.name.text, 'function', d.name, s, null);
      else if (exported) add(d.name.text, 'variable', d.name, s, null);
    }
  }
  return out;
}

describe('util size: outlines of real files', () => {
  it.each([
    ['verify.ts', false],
    ['flatted.js', true],
  ])('outlines %s exactly as the TypeScript compiler reads it', async (name, js) => {
    const { data } = await fileOf({ inputFile: `samples/size/${name}` });
    expect(data.outline!.precision).toBe('syntactic');
    expect(short(data.outline!.symbols)).toEqual(compilerOutline(sample(name), js));
    expect(data.outline!.symbols.length).toBeGreaterThan(8);
    expect(data.verified.passed).toBe(true);
  });

  it("agrees with the TypeScript compiler on this command's own source", () => {
    const dir = join(import.meta.dirname, 'size');
    for (const file of ['code.ts', 'data.ts', 'lexer.ts', 'measure.ts']) {
      const text = readFileSync(join(dir, file), 'utf8');
      expect(short(outlineCode(text, 'typescript')), file).toEqual(compilerOutline(text, false));
    }
  });

  it('outlines Python: classes, their methods, and top-level functions, not the functions inside them', async () => {
    const { data } = await fileOf({ inputFile: 'samples/size/flatted.py' });
    expect(data.language).toBe('python');
    expect(short(data.outline!.symbols)).toEqual([
      'class _Known 19-22', 'method _Known.__init__ 20-22', 'class _String 24-26', 'method _String.__init__ 25-26',
      'function _array_keys 28-30', 'function _object_keys 32-34', 'function _is_array 36-37', 'function _is_object 39-40', 'function _is_string 42-43',
      'function _index 45-50', 'function _relate 52-59', 'function _resolver 61-75', 'function _transform 77-90', 'function _wrap 92-106',
      'function parse 108-133', 'function stringify 136-144',
    ]);
  });

  it('outlines Go: types and functions, each to its closing brace', async () => {
    const { data } = await fileOf({ inputFile: 'samples/size/flatted.go' });
    expect(short(data.outline!.symbols)).toEqual([
      'type flattedIndex 30-30', 'function Stringify 33-160', 'function Parse 163-223', 'function revive 225-242',
      'function loop 244-264', 'function ref 266-276', 'function ToJSON 279-287', 'function FromJSON 290-296',
    ]);
  });

  it('outlines Java: the class, its constructor and methods, past annotations with arguments', async () => {
    const { data } = await fileOf({ inputFile: 'samples/size/CategoryService.java' });
    expect(short(data.outline!.symbols)).toEqual([
      'class CategoryService 39-217', 'constructor CategoryService.CategoryService 46-48', 'method CategoryService.resolveGuildId 50-55',
      'method CategoryService.createCategory 65-81', 'method CategoryService.deleteCategory 91-111', 'method CategoryService.editCategory 121-150',
      'method CategoryService.findCategory 153-180', 'method CategoryService.listChannelsInCategory 190-216',
    ]);
  });

  it('outlines C#: a file-scoped namespace, the class, constructor and overloads, past XML doc comments', async () => {
    const { data } = await fileOf({ inputFile: 'samples/size/FrameworkConfigurationBuilder.cs' });
    const ns = 'Imagile.Framework.Configuration';
    const cls = `${ns}.FrameworkConfigurationBuilder`;
    expect(short(data.outline!.symbols)).toEqual([
      `namespace ${ns} 31-216`, `class ${cls} 54-216`, `constructor ${cls}.FrameworkConfigurationBuilder 65-70`,
      `method ${cls}.WithKeyVault 111-120`, `method ${cls}.WithKeyVault 141-146`, `method ${cls}.WithValidation 179-183`, `method ${cls}.Build 192-215`,
    ]);
  });

  it('outlines Markdown headings with their levels and nesting', async () => {
    const { data } = await fileOf({ inputFile: 'samples/size/docs/util.md' });
    expect(data.outline!.symbols.map((s) => `${s.level} ${s.name} ${s.startLine}-${s.endLine}`)).toEqual([
      '1 Building a `util` command 1-132', '2 The rules 8-22', '2 Reading input: `kit/input.ts` 24-61', '2 Self-verification: `kit/verify.ts` 63-95',
      '2 Shared parsers 97-113', '2 Lazy loading 115-132',
    ]);
  });

  it('outlines JSON and YAML top-level keys, held against the parser', async () => {
    const json = (await fileOf({ inputFile: 'samples/size/data/sample.json' })).data;
    expect(json.outline!.precision).toBe('parsed');
    expect(short(json.outline!.symbols).slice(0, 8)).toEqual(['key name 2-2', 'key version 3-3', 'key description 4-4', 'key license 5-5', 'key author 6-6', 'key homepage 7-7', 'key repository 8-11', 'key bugs 12-12']);
    expect(json.outline!.symbols.map((s) => s.name)).toEqual(Object.keys(JSON.parse(sample('data/sample.json'))));
    expect(checks(json)['outline.keys']).toBe('passed');
    const yaml = (await fileOf({ inputFile: 'samples/size/data/pages.yml' })).data;
    expect(short(yaml.outline!.symbols)).toEqual(['key name 1-1', 'key on 3-9', 'key permissions 11-12', 'key concurrency 14-16', 'key jobs 18-49']);
    expect(checks(yaml)['outline.keys']).toBe('passed');
  });

  it('re-reads every start line, and says the outline and the tokens are approximations', async () => {
    const { envelope, data } = await fileOf({ inputFile: 'samples/size/verify.ts' });
    const start = data.verified.checks.find((c) => c.check === 'outline.start')!;
    expect(start).toMatchObject({ status: 'passed', failed: 0, checked: data.outline!.symbols.length });
    expect(checks(data)).toMatchObject({ 'input.complete': 'passed', 'counts.reread': 'passed', 'outline.range': 'passed', 'outline.nesting': 'passed', 'outline.symbols': 'approximated', tokens: 'approximated' });
    expect(envelope.meta.warnings?.map((w) => w.code)).toEqual(['APPROXIMATED', 'APPROXIMATED']);
    expect(data.tokenMethod).toContain('ceil(characters / 4)');
  });
});

describe('util size: the self-checks catch a broken result', () => {
  const v = () => {
    const warnings: Warning[] = [];
    return { verifier: new Verifier((w) => warnings.push(w)), warnings };
  };
  const text = 'export class A {\n  run() {\n    return 1;\n  }\n}\n';
  const reader = { linesAt: async (numbers: Iterable<number>) => new Map([...numbers].map((n) => [n, text.split('\n')[n - 1]!])) };

  it('passes the outline as scanned', async () => {
    const { verifier } = v();
    await verifyOutline(outlineCode(text, 'typescript'), reader, 5, verifier);
    expect(verifier.done().passed).toBe(true);
  });

  it('catches a start line moved off its symbol', async () => {
    const { verifier, warnings } = v();
    const symbols = outlineCode(text, 'typescript');
    symbols[1]!.startLine = 3;
    await verifyOutline(symbols, reader, 5, verifier);
    const result = verifier.done();
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.check === 'outline.start')).toMatchObject({ status: 'failed', failed: 1, failures: [{ at: 'line 3', expected: 'method A.run', actual: 'return 1;' }] });
    expect(warnings).toEqual([{ code: 'SIZE_OUTLINE_MISMATCH', message: expect.stringContaining('outline.start at line 3') }]);
  });

  it('catches a range past the end of the file, and a member outside its class', async () => {
    const { verifier } = v();
    const symbols = outlineCode(text, 'typescript');
    symbols[0]!.endLine = 9;
    symbols[1]!.endLine = 10;
    await verifyOutline(symbols, reader, 5, verifier);
    const result = verifier.done();
    expect(result.checks.find((c) => c.check === 'outline.range')).toMatchObject({ status: 'failed', failed: 2 });
    expect(result.checks.find((c) => c.check === 'outline.nesting')).toMatchObject({ status: 'failed', failed: 1 });
  });

  it('redacts a secret-shaped line it quotes in a failure', async () => {
    const { verifier } = v();
    const secretLine = 'const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";';
    await verifyOutline([{ name: 'missing', kind: 'variable', startLine: 1, endLine: 1, container: null }], { linesAt: async () => new Map([[1, secretLine]]) }, 1, verifier);
    expect(JSON.stringify(verifier.done())).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('catches scanned keys that disagree with the parser', () => {
    const { verifier, warnings } = v();
    checkKeys({ a: 1, b: 2 }, ['a', 'c'], verifier);
    expect(verifier.done().checks).toEqual([expect.objectContaining({ check: 'outline.keys', status: 'failed', failures: [{ at: 'the top-level keys', expected: ['a', 'b'], actual: ['a', 'c'] }] })]);
    expect(warnings[0]!.code).toBe('SIZE_OUTLINE_MISMATCH');
  });

  const entries: FileEntry[] = [
    { path: 'a.ts', folder: '.', bytes: 10, lines: 2, tokens: 3, binary: false, language: 'typescript' },
    { path: 'src/b.ts', folder: 'src', bytes: 20, lines: 4, tokens: 5, binary: false, language: 'typescript' },
    { path: 'src/lib/c.png', folder: 'src/lib', bytes: 30, lines: null, tokens: null, binary: true, language: null },
  ];

  it('passes the tree as built', () => {
    const { verifier } = v();
    const tree = buildTree('.', entries);
    verifyTree(tree, entries, verifier);
    expect(verifier.done()).toEqual({ passed: true, checks: [expect.objectContaining({ check: 'totals.sum', checked: 1 }), expect.objectContaining({ check: 'tree.sum', checked: 3, failed: 0 })] });
    expect(tree).toMatchObject({ files: 3, bytes: 60, lines: 6, tokens: 8, binaryFiles: 1, folders: [{ path: 'src', files: 2, bytes: 50, folders: [{ path: 'src/lib', bytes: 30 }] }] });
  });

  it('catches a folder whose totals disagree with its files', () => {
    const { verifier, warnings } = v();
    const tree = buildTree('.', entries);
    tree.folders[0]!.folders[0]!.bytes = 31;
    verifyTree(tree, entries, verifier);
    const result = verifier.done();
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.check === 'tree.sum')).toMatchObject({ status: 'failed', failed: 2 });
    expect(warnings).toEqual([{ code: 'SIZE_TOTALS_MISMATCH', message: expect.stringContaining('tree.sum at the folder src/lib') }]);
  });

  it('catches root totals that disagree with the files, and a file whose folder is missing', () => {
    const { verifier } = v();
    const tree = buildTree('.', entries);
    tree.tokens = 9;
    tree.folders = [];
    verifyTree(tree, entries, verifier);
    const result = verifier.done();
    expect(result.checks.find((c) => c.check === 'totals.sum')).toMatchObject({ status: 'failed' });
    expect(result.checks.find((c) => c.check === 'tree.sum')!.failures).toEqual(expect.arrayContaining([{ at: 'the folder src', expected: 'a folder in the tree', actual: 'missing' }]));
  });
});

describe('util size: folders', () => {
  it('totals the folder, skipping what .gitignore ignores, with the binary file in bytes only', async () => {
    const { envelope, data } = await sizeOf({ inputFile: 'samples/size' });
    const folder = data as FolderSize;
    expect(envelope.ok).toBe(true);
    const all = Object.entries(sizeSamples).filter(([p]) => !p.includes('/build/'));
    expect(folder.totals).toEqual({
      files: all.length,
      bytes: all.reduce((n, [, c]) => n + (typeof c === 'string' ? Buffer.byteLength(c) : c.length), 0),
      lines: expect.any(Number),
      tokens: expect.any(Number),
      binaryFiles: 1,
    });
    expect(folder.largest.map((f) => f.path)).not.toContain('samples/size/build/bundle.js');
    expect(folder.largest[0]).toMatchObject({ path: 'samples/size/CategoryService.java', language: 'java' });
    expect(folder.tree.folders.map((f) => f.path)).toEqual(['samples/size/docs', 'samples/size/data']);
    expect(checks(folder)).toEqual({ 'input.complete': 'passed', 'totals.sum': 'passed', 'tree.sum': 'passed', tokens: 'approximated' });
    expect(folder.skipped).toEqual([]);
  });

  it('lists a binary file with null lines and tokens', async () => {
    const { data } = await sizeOf({ inputFile: 'samples/size/data', top: 5 });
    expect((data as FolderSize).largest.find((f) => f.binary)).toEqual({ path: 'samples/size/data/logo.png', bytes: 16, lines: null, tokens: null, binary: true, language: null });
  });

  it('hides folders below depth, counting them, and lists only the top files', async () => {
    const { data } = await sizeOf({ inputFile: 'samples/size', depth: 0, top: 2 });
    const folder = data as FolderSize;
    expect(folder.tree).toMatchObject({ folders: [], foldersHidden: 2 });
    expect(folder.largest).toHaveLength(2);
  });

  it('sizes the whole workspace as .', async () => {
    const { data } = await sizeOf({ inputFile: '.' }, { files: { 'a.md': '# A\n', 'src/b.go': 'package b\n' } });
    expect(data).toMatchObject({ kind: 'folder', path: '.', totals: { files: 2, bytes: 14, lines: 2 }, tree: { path: '.', folders: [{ path: 'src', files: 1 }] } });
  });

  it('refuses language for a folder, and top or depth for a file', async () => {
    expect((await sizeOf({ inputFile: 'samples/size', language: 'go' })).envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'language applies to one file, and this is a folder.' });
    expect((await sizeOf({ inputFile: 'samples/size/flatted.go', top: 1 })).envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'top applies to a folder, and this is one file.' });
  });
});

describe('util size: what it cannot outline, it says', () => {
  it('counts a binary file in bytes, with no lines, tokens or outline', async () => {
    const { data } = await fileOf({ inputFile: 'samples/size/data/logo.png' });
    expect(data).toMatchObject({ bytes: 16, lines: null, tokens: null, outline: null, notOutlined: { reason: 'binary' } });
  });

  it('counts a file of an unsupported type, and says why there is no outline', async () => {
    const { data } = await fileOf({ inputFile: 'samples/size/notes.txt' });
    expect(data).toMatchObject({ language: null, lines: 1, tokens: 6, outline: null, notOutlined: { reason: 'unsupported-language', detail: expect.stringContaining('typescript, javascript, python, csharp, java, go, markdown, json, yaml') } });
  });

  it('asks for a language when stdin or text has no file name', async () => {
    const { data } = await fileOf({ text: 'def f():\n    pass\n' });
    expect(data.notOutlined).toMatchObject({ reason: 'unsupported-language', detail: expect.stringContaining('pass language') });
    const piped = (await fileOf({ language: 'python' }, { stdin: 'def f():\n    pass\n' })).data;
    expect(short(piped.outline!.symbols)).toEqual(['function f 1-2']);
    expect(checks(piped)['input.complete']).toBe('unchecked');
  });

  it('reports a parse error with its line, keeps the counts, and warns', async () => {
    const { envelope, data } = await fileOf({ text: 'export function f() {\n  return 1;\n', language: 'typescript' });
    expect(data).toMatchObject({ lines: 2, outline: null, notOutlined: { reason: 'parse-error', detail: 'a { opened on line 1 is never closed' } });
    expect(envelope.meta.warnings?.map((w) => w.code)).toContain('SIZE_PARSE_ERROR');
  });

  it('gives invalid JSON a line and column, never the text', async () => {
    const { data } = await fileOf({ text: '{\n  "token": "abc12345-secret",\n  oops\n}\n', language: 'json' });
    expect(data.notOutlined).toEqual({ reason: 'parse-error', detail: "it isn't valid JSON at line 3, column 3" });
    expect(JSON.stringify(data)).not.toContain('abc12345-secret');
  });

  it('gives invalid YAML the parser kit message', async () => {
    const { data } = await fileOf({ text: 'a: 1\na: 2\n', language: 'yaml' });
    expect(data.notOutlined).toMatchObject({ reason: 'parse-error', detail: expect.stringContaining('line 2') });
  });

  it('counts a file too large to outline', async () => {
    const big = `// ${'x'.repeat(OUTLINE_MAX_BYTES)}\n`;
    const { data } = await fileOf({ inputFile: 'big.ts' }, { files: { 'big.ts': big } });
    expect(data).toMatchObject({ bytes: big.length, lines: 1, outline: null, notOutlined: { reason: 'too-large' } });
  });
});

describe('util size: counts', () => {
  it.each([
    ['', 0, 0, 0],
    ['a', 1, 1, 1],
    ['a\n', 2, 1, 1],
    ['a\r\nb', 4, 2, 1],
    ['\n\n', 2, 2, 1],
    ['😀😀😀😀😀', 20, 1, 2],
  ])('%j is %i bytes and %i lines, ~%i tokens', async (text, bytes, lines, tokens) => {
    const { data } = await fileOf({ text });
    expect(data).toMatchObject({ bytes, lines, tokens });
  });
});

describe('util size: the lexer', () => {
  it.each([
    ['a template literal with a brace in its hole', 'const s = `${ { a: "}" }.a }`;\nexport function f() {}\n', 'typescript', ['function f 2-2']],
    ['a regex with a slash and braces', 'const r = /[/{]+\\/}/g;\nexport function f() {}\n', 'typescript', ['function f 2-2']],
    ['C# verbatim, raw and interpolated strings', 'class A {\n  string a = @"x""}";\n  string b = """\n  }\n  """;\n  string c = $"{(true ? "}" : "")}";\n  void M() {}\n}\n', 'csharp', ['class A 1-8', 'method A.M 7-7']],
    ['a Java text block', 'class A {\n  String s = """\n    }\n    """;\n  void m() {}\n}\n', 'java', ['class A 1-6', 'method A.m 5-5']],
    ['a Go raw string', 'package a\nvar s = `\n}\n`\nfunc F() {}\n', 'go', ['function F 5-5']],
    ['Python triple quotes and a continued signature', 'def f(\n    a,\n):\n    """\ndef g():\n    """\n    return a\n\ndef h(): pass\n', 'python', ['function f 1-7', 'function h 9-9']],
  ])('reads %s', (_name, text, lang, expected) => {
    expect(short(outlineCode(text, lang as never))).toEqual(expected);
  });

  it.each([
    ['an unclosed block comment', '/* never\n', 'a block comment opened on line 1 is never closed'],
    ['a string broken by a line end', 'const s = "a\nb";\n', "a string opened on line 1 isn't closed by the end of that line"],
    ['an unmatched brace', 'function f() {}\n}\n', 'a } on line 2 closes nothing'],
  ])('refuses %s with the line', (_name, text, message) => {
    expect(() => outlineCode(text, 'javascript')).toThrow(new OutlineError(message));
  });

  it.each([
    ['JavaScript', "const a = 'abc\\\r\ndef';\r\nfunction f() {\r\n  return 1;\r\n}\r\n", 'javascript', ['function f 3-5']],
    ['Python', "a = 'abc\\\r\ndef'\r\ndef f():\r\n    return 1\r\n", 'python', ['function f 3-4']],
  ])('reads a %s string continued with a backslash before CRLF as it does before LF', (_name, crlf, lang, expected) => {
    expect(short(outlineCode(crlf, lang as never))).toEqual(expected);
    expect(short(outlineCode(crlf.replace(/\r\n/g, '\n'), lang as never))).toEqual(expected);
  });

  it('keeps the text of string tokens, so a quoted method name is named', () => {
    expect(lex("x = 'a'", 'javascript').map((t) => t.v)).toEqual(['x', '=', "'a'"]);
    expect(short(outlineCode("class A {\n  'odd name'() {}\n}\n", 'typescript'))).toEqual(['class A 1-3', 'method A.odd name 2-2']);
  });
});

describe('util size: data outlines', () => {
  it('skips headings in fences and front matter, and reads setext headings', () => {
    const md = '---\ntitle: x\n---\n# One\n\n```\n# not a heading\n```\n\nTwo\n---\n\ntext\n';
    expect(outlineMarkdown(md).map((s) => `${s.level} ${s.name} ${s.startLine}-${s.endLine}`)).toEqual(['1 One 4-13', '2 Two 10-13']);
  });

  it('finds JSON keys at depth one only, with duplicates as written', () => {
    expect(scanJsonKeys('{"a": {"b": 1},\n "c": [1,\n 2], "a": "x"}')).toEqual([
      { name: 'a', startLine: 1, endLine: 1 },
      { name: 'c', startLine: 2, endLine: 3 },
      { name: 'a', startLine: 3, endLine: 3 },
    ]);
    expect(scanJsonKeys('[1, 2]')).toEqual([]);
  });

  it('reads # inside a plain YAML key as part of it, and # after a space as a comment', async () => {
    expect(scanYamlKeys('a#b: 1\nc: 2 # note\nd #e: 3\n').map((k) => k.name)).toEqual(['a#b', 'c']);
    const { data } = await fileOf({ text: 'a#b: 1\nc: 2\n', language: 'yaml' });
    expect(short(data.outline!.symbols)).toEqual(['key a#b 1-1', 'key c 2-2']);
    expect(data.verified.passed).toBe(true);
  });

  it('finds YAML keys at column 0, quoted or plain, and trims trailing comments', () => {
    expect(scanYamlKeys('# head\n"a b": 1\nc:\n  - d: 2\n\n# about e\ne: |\n  f: 3\n')).toEqual([
      { name: 'a b', startLine: 2, endLine: 2 },
      { name: 'c', startLine: 3, endLine: 4 },
      { name: 'e', startLine: 7, endLine: 8 },
    ]);
  });
});

describe('util size: the front doors', () => {
  it('runs on the CLI with a file argument, and over MCP with the same envelope', async () => {
    const cli = await runCli(['util', 'size', 'samples/size/flatted.go'], { commands, context: testContext({ files: sizeSamples }).context });
    expect(cli.exitCode).toBe(0);
    expect(cli.envelope?.data).toMatchObject({ kind: 'file', language: 'go', outline: { symbols: expect.any(Array) } });
    const session = await connectMcp({ commands, context: testContext({ files: sizeSamples }).context });
    try {
      const mcp = await session.call('util_size', { inputFile: 'samples/size/flatted.go' });
      expect(mcp.envelope.data).toEqual(cli.envelope?.data);
    } finally {
      await session.close();
    }
  });

  it('reads stdin with - on the CLI, and refuses an empty call over MCP', async () => {
    const cli = await runCli(['util', 'size', '-', '--language', 'markdown'], { commands, context: testContext({ stdin: '# Hi\n' }).context });
    expect(cli.envelope?.data).toMatchObject({ path: null, language: 'markdown', outline: { symbols: [{ name: 'Hi', kind: 'heading', level: 1 }] } });
    const session = await connectMcp({ commands, context: testContext().context });
    try {
      expect((await session.call('util_size', {})).envelope.error?.code).toBe('INVALID_INPUT');
    } finally {
      await session.close();
    }
  });
});
